/* The harness server: a lease-based enrichment queue + an evidence-gated ingest,
   over a plain JSON target list. No database, no framework, no UI — curl and jq.

   Flow: GET /api/queue leases targets to a worker → the worker researches on the
   web → POST /api/ingest validates and writes the enrichment overlay. Results
   never mutate targets.json: enrichment is an overlay keyed by target key, so the
   input list stays a clean, re-runnable source of truth. */
import { createServer } from "node:http";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createStore } from "./store.mjs";
import { createUsage } from "./usage.mjs";
import { createRunners } from "./runners.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "data");
const PORT = Number(process.env.HARNESS_PORT || 4400);
const LEASE_MS = 30 * 60 * 1000;

const targetsStore = createStore(join(DATA_DIR, "targets.json"), { targets: [] });
const enrichment = createStore(join(DATA_DIR, "enrichment.json"), { companies: {} });
const configStore = createStore(join(DATA_DIR, "config.json"), { workers: {} });
const usage = createUsage({ DATA_DIR });
const runners = createRunners({ __dirname, PORT, loadSettings: () => configStore.read() });

const EMAIL_BASES = ["published", "pattern-guess", "not-found"];

function send(res, code, body, type = "application/json") {
  const out = type === "application/json" ? JSON.stringify(body, null, 2) : body;
  res.writeHead(code, { "content-type": type });
  res.end(out);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on("end", () => {
      try { resolve(JSON.parse(raw || "{}")); }
      catch { reject(new Error("bad json")); }
    });
    req.on("error", reject);
  });
}

async function getTarget(key) {
  const { targets } = await targetsStore.read();
  return targets.find((t) => t.key === key) || null;
}

const server = createServer(async (req, res) => {
  try {
    /* ---- queue: workers pull leases ---- */
    if (req.url.startsWith("/api/queue") && req.method === "GET") {
      const u = new URL(req.url, "http://x");
      const limit = Math.min(Number(u.searchParams.get("limit")) || 0, 25);
      const worker = (u.searchParams.get("worker") || "worker").slice(0, 40);
      const now = Date.now();
      const { targets } = await targetsStore.read();
      const state = await enrichment.read();
      const enriched = (k) => !!state.companies[k]?.last;
      const leased = (k) => {
        const l = state.companies[k]?.lease;
        return l && now - l.ts < LEASE_MS;
      };
      const free = targets.filter((t) => !enriched(t.key) && !leased(t.key));
      const bySource = {};
      for (const st of Object.values(state.companies)) {
        const s = st.provenance?.source;
        if (s) bySource[s] = (bySource[s] || 0) + 1;
      }
      const counts = {
        targets: targets.length,
        remaining: free.length,
        leasedNow: targets.filter((t) => leased(t.key)).length,
        ingestedBySource: bySource,
      };
      if (!limit) return send(res, 200, counts);
      // Check-and-set INSIDE the mutex: the free-list above came from a stale
      // read, and two concurrent workers must never lease the same target.
      const grab = [];
      await enrichment.mutate((db) => {
        const t = Date.now();
        for (const c of free) {
          if (grab.length >= limit) break;
          const st = db.companies[c.key];
          if (st?.lease && t - st.lease.ts < LEASE_MS) continue; // another worker beat us
          if (st?.last) continue; // enriched since our read
          const slot = db.companies[c.key] = db.companies[c.key] || {};
          slot.lease = { by: worker, ts: t };
          grab.push(c);
        }
      });
      return send(res, 200, { ...counts, rows: grab });
    }

    /* ---- ingest: evidence-gated write of one enrichment result ---- */
    if (req.url === "/api/ingest" && req.method === "POST") {
      const b = await readBody(req);
      const { key, contact, hook, timingSignal, sources, summary, model, source } = b;
      const rec = await getTarget(key || "");
      if (!rec) return send(res, 404, { error: "Unknown target key: " + (key || "(none)") });
      if (!Array.isArray(sources) || !sources.length) {
        return send(res, 400, { error: "sources[] is required — no evidence, no ingest." });
      }
      const basis = contact?.emailBasis || "not-found";
      if (!EMAIL_BASES.includes(basis)) {
        return send(res, 400, { error: "contact.emailBasis must be " + EMAIL_BASES.join(" | ") + "." });
      }
      await enrichment.mutate((db) => {
        const st = db.companies[key] = db.companies[key] || {};
        st.last = {
          contactName: contact?.name || null, contactTitle: contact?.title || null,
          contactEmail: contact?.email || null,
          contactEmailBasis: contact?.email ? basis : null,
          contactLinkedin: contact?.linkedin || null, contactPersona: contact?.persona || null,
          headcount: b.firmographics?.headcount || null,
          revenueBand: b.firmographics?.revenueBand || null,
          segment: b.firmographics?.segment || null,
          hook: hook || null, timingSignal: timingSignal || null, summary: summary || null,
        };
        st.sources = sources.slice(0, 12);
        st.provenance = { source: source || "unknown", model: model || null, ingestedAt: Date.now() };
        delete st.lease;
      });
      await usage.log("enrich", { key, source: source || "unknown" }, { model: model || null });
      return send(res, 200, { ok: true, key });
    }

    /* ---- dispatcher: run N enrichments across the enabled agent lanes ---- */
    if (req.url === "/api/workers/run" && req.method === "POST") {
      try {
        const { n, lanes } = await readBody(req);
        return send(res, 200, await runners.runBatch({ n: Number(n) || 4, lanes }));
      } catch (err) {
        if (err?.message === "bad json") return send(res, 400, { error: "Bad JSON in request." });
        return send(res, 409, { error: err.message });
      }
    }
    if (req.url === "/api/workers/status" && req.method === "GET") {
      return send(res, 200, runners.status());
    }

    /* ---- results + cost ---- */
    if (req.url === "/api/results" && req.method === "GET") {
      const { targets } = await targetsStore.read();
      const state = await enrichment.read();
      const rows = targets.map((t) => ({ ...t, enrichment: state.companies[t.key]?.last || null, sources: state.companies[t.key]?.sources || null, provenance: state.companies[t.key]?.provenance || null }));
      return send(res, 200, { rows });
    }
    if (req.url === "/api/usage" && req.method === "GET") {
      return send(res, 200, await usage.summary());
    }

    if (req.url === "/" && req.method === "GET") {
      return send(res, 200, "rev-intel-harness — see README. Endpoints: GET /api/queue · POST /api/ingest · POST /api/workers/run · GET /api/workers/status · GET /api/results · GET /api/usage\n", "text/plain");
    }
    return send(res, 404, { error: "Not found" });
  } catch (err) {
    if (err?.message === "bad json") return send(res, 400, { error: "Bad JSON in request." });
    console.error(err);
    return send(res, 500, { error: err?.message || "server error" });
  }
});

server.listen(PORT, () => {
  console.log(`rev-intel-harness on http://localhost:${PORT}`);
  console.log(`  targets: data/targets.json · results overlay: data/enrichment.json · ledger: data/usage-ledger.jsonl`);
});
