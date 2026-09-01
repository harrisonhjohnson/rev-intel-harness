/* Cost accounting: every enrichment lands one line in data/usage-ledger.jsonl.
   "Expected" is the trailing median of the last 20 actuals per site, bootstrapped
   from STATIC_ESTIMATES — so cost predictions self-correct as real data arrives.

   Work done on subscription lanes (Claude Code, Codex CLIs on flat-rate plans) is
   logged at $0 so cash spend and free spend sit side by side in the same summary.
   The meter is a product feature, not plumbing: you cannot make build-vs-buy or
   model-routing calls without per-call-site cost truth. */
import { join } from "node:path";
import { appendJsonl, readJsonl } from "./store.mjs";

// USD per MTok. Update from your provider's current price sheet.
const PRICING = {
  "claude-opus-5": { in: 5, out: 25 },
  "claude-sonnet-5": { in: 3, out: 15 },
  "claude-haiku-4-5": { in: 1, out: 5 },
};
const DEFAULT_PRICE = { in: 5, out: 25 }; // unknown model: price at top tier, don't undercount
const WEB_SEARCH_USD = 0.01; // $10 per 1,000 searches
const CACHE_READ_X = 0.1;
const CACHE_WRITE_X = 1.25;

// Hand-set bootstrap expectations per call site; self-corrects to trailing medians.
const STATIC_ESTIMATES = {
  enrich: { in: 30000, out: 2500, searches: 6 },
  score:  { in: 8000, out: 2000, searches: 0 },
};

function priceFor(model) {
  const base = String(model || "").replace(/-\d{8}$/, ""); // strip any date suffix
  return PRICING[base] || DEFAULT_PRICE;
}

function usd(model, { input = 0, output = 0, cacheRead = 0, cacheWrite = 0, searches = 0 }) {
  const p = priceFor(model);
  return (input * p.in + output * p.out + cacheRead * p.in * CACHE_READ_X + cacheWrite * p.in * CACHE_WRITE_X) / 1e6
    + searches * WEB_SEARCH_USD;
}

export function createUsage({ DATA_DIR }) {
  const LEDGER = join(DATA_DIR, "usage-ledger.jsonl");
  let cache = { ts: 0, rows: null };

  async function rows() {
    if (cache.rows && Date.now() - cache.ts < 10_000) return cache.rows;
    cache = { ts: Date.now(), rows: await readJsonl(LEDGER) };
    return cache.rows;
  }

  function median(xs) {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  }

  async function estimate(site) {
    const recent = (await rows()).filter((r) => r.site === site && r.ok).slice(-20);
    const boot = STATIC_ESTIMATES[site] || { in: 5000, out: 2000, searches: 0 };
    if (recent.length < 3) {
      return { in: boot.in, out: boot.out, usd: usd(null, { input: boot.in, output: boot.out, searches: boot.searches }) };
    }
    return {
      in: median(recent.map((r) => r.actual.input_tokens + (r.actual.cache_read_input_tokens || 0))),
      out: median(recent.map((r) => r.actual.output_tokens)),
      usd: median(recent.map((r) => r.actual.usd)),
    };
  }

  async function record(site, meta, { usages, ms, ok, error }) {
    const actual = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, web_searches: 0, usd: 0 };
    let model = null;
    for (const { usage: u, model: m } of usages) {
      model = m || model;
      actual.input_tokens += u.input_tokens || 0;
      actual.output_tokens += u.output_tokens || 0;
      actual.cache_read_input_tokens += u.cache_read_input_tokens || 0;
      actual.cache_creation_input_tokens += u.cache_creation_input_tokens || 0;
      actual.web_searches += u.server_tool_use?.web_search_requests || 0;
    }
    actual.usd = Math.round(usd(model, {
      input: actual.input_tokens, output: actual.output_tokens,
      cacheRead: actual.cache_read_input_tokens, cacheWrite: actual.cache_creation_input_tokens,
      searches: actual.web_searches,
    }) * 1e4) / 1e4;
    const expected = await estimate(site);
    const line = { ts: Date.now(), site, ...meta, model, expected, actual, ms, ok, ...(error ? { error } : {}) };
    await appendJsonl(LEDGER, line);
    cache = { ts: 0, rows: null };
    return line;
  }

  // For direct-API lanes: fn receives track(res) — call it on every API response
  // inside; usage is summed across a multi-call logical run.
  async function wrap(site, meta, fn) {
    const t0 = Date.now();
    const usages = [];
    const track = (res) => { if (res?.usage) usages.push({ usage: res.usage, model: res.model }); return res; };
    try {
      const out = await fn(track);
      await record(site, meta, { usages, ms: Date.now() - t0, ok: true });
      return out;
    } catch (err) {
      await record(site, meta, { usages, ms: Date.now() - t0, ok: false, error: err.message });
      throw err;
    }
  }

  // Zero-cash line for work done on subscription lanes (Claude Code / Codex workers).
  async function log(site, meta, { model = null, ms = 0 } = {}) {
    const line = {
      ts: Date.now(), site, ...meta, model, expected: null,
      actual: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, web_searches: 0, usd: 0 },
      ms, ok: true,
    };
    await appendJsonl(LEDGER, line);
    cache = { ts: 0, rows: null };
    return line;
  }

  // LOCAL calendar day — toISOString() is UTC, which resets daily caps mid-evening
  // for anyone west of Greenwich. Days mean the operator's days.
  const dayKey = (ts) => {
    const d = new Date(ts);
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  };

  async function spentToday(sites) {
    const today = dayKey(Date.now());
    const hits = (await rows()).filter((r) => dayKey(r.ts) === today && (!sites || sites.includes(r.site)));
    const count = {};
    for (const r of hits) count[r.site] = (count[r.site] || 0) + 1;
    return { usd: hits.reduce((a, r) => a + (r.actual?.usd || 0), 0), count };
  }

  async function summary({ since } = {}) {
    let all = await rows();
    if (since) all = all.filter((r) => r.ts >= since);
    const bySite = {};
    for (const r of all) {
      const s = (bySite[r.site] = bySite[r.site] || { calls: 0, ok: 0, usd: 0, expectedUsd: 0, tokensIn: 0, tokensOut: 0, searches: 0, ms: 0 });
      s.calls++; if (r.ok) s.ok++;
      s.usd += r.actual?.usd || 0;
      s.expectedUsd += r.expected?.usd || 0;
      s.tokensIn += (r.actual?.input_tokens || 0) + (r.actual?.cache_read_input_tokens || 0);
      s.tokensOut += r.actual?.output_tokens || 0;
      s.searches += r.actual?.web_searches || 0;
      s.ms += r.ms || 0;
    }
    const byDay = {};
    for (const r of all) {
      const d = (byDay[dayKey(r.ts)] = byDay[dayKey(r.ts)] || { calls: 0, usd: 0 });
      d.calls++; d.usd += r.actual?.usd || 0;
    }
    const round = (n) => Math.round(n * 100) / 100;
    for (const s of Object.values(bySite)) { s.usd = round(s.usd); s.expectedUsd = round(s.expectedUsd); }
    for (const d of Object.values(byDay)) d.usd = round(d.usd);
    return {
      total: { calls: all.length, usd: round(all.reduce((a, r) => a + (r.actual?.usd || 0), 0)) },
      bySite, byDay,
      recent: all.slice(-25).reverse(),
    };
  }

  return { wrap, estimate, summary, spentToday, log };
}
