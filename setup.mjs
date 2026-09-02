/* Gramercy setup — the 60-second path.
   Imports your CSV of companies and writes your kernel (the ICP context every
   research run carries). Interactive by default; flags make it scriptable:
     node setup.mjs --csv leads.csv --url https://yourco.com
     node setup.mjs --csv leads.csv --icp "We sell bookkeeping to small DTC brands"
   The kernel is derived by YOUR default Claude model (the big one you talk to);
   per-company research later runs on a cheaper pinned model. That split is the
   design: expensive judgment once, cheap legwork many times. */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "data");

/* ---- args ---- */
const args = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--csv") args.csv = argv[++i];
  else if (a === "--url") args.url = argv[++i];
  else if (a === "--icp") args.icp = argv[++i];
  else if (a === "--model") args.model = argv[++i];
}

/* ---- tiny CSV parser (quotes, commas, CRLF) ---- */
function parseCsv(text) {
  const rows = [];
  let row = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); if (row.some((f) => f.trim() !== "")) rows.push(row); }
  return rows;
}

const NAME_HEADERS = ["company", "company name", "company_name", "name", "brand", "account", "organization"];
const DOMAIN_HEADERS = ["domain", "website", "url", "site", "company website", "company domain", "web site"];

function slug(s) {
  return String(s).toLowerCase().replace(/https?:\/\//, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}

function importCsv(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error("CSV needs a header row and at least one company row.");
  const headers = rows[0].map((h) => h.trim());
  const lower = headers.map((h) => h.toLowerCase());
  const nameIdx = lower.findIndex((h) => NAME_HEADERS.includes(h));
  const domainIdx = lower.findIndex((h) => DOMAIN_HEADERS.includes(h));
  if (nameIdx < 0 && domainIdx < 0) {
    throw new Error(
      "Couldn't find a company column. Name one of your headers: " +
      NAME_HEADERS.slice(0, 4).join(", ") + " (or " + DOMAIN_HEADERS.slice(0, 3).join(", ") + ")."
    );
  }
  const seen = new Set();
  const targets = [];
  for (const r of rows.slice(1)) {
    const name = nameIdx >= 0 ? r[nameIdx]?.trim() : "";
    const domain = domainIdx >= 0 ? (r[domainIdx] || "").trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "") : "";
    if (!name && !domain) continue;
    const key = slug(name || domain);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const notes = headers
      .map((h, i) => ({ h, v: (r[i] || "").trim() }))
      .filter(({ h, v }, i) => v && i !== nameIdx && i !== domainIdx)
      .map(({ h, v }) => `${h}: ${v}`)
      .join(" · ");
    targets.push({ key, name: name || domain, ...(domain ? { domain } : {}), ...(notes ? { notes } : {}) });
  }
  if (!targets.length) throw new Error("No usable company rows found.");
  return targets;
}

/* ---- kernel derivation ---- */
async function deriveKernelFromUrl(url, model) {
  const prompt =
    `Read ${url} with WebFetch. You are writing the "kernel" — the standing context a ` +
    `lead-enrichment researcher will carry while researching prospect companies FOR this ` +
    `business. Write, in plain prose:\n` +
    `1. Two or three sentences: what this business sells and to whom.\n` +
    `2. A line starting "Personas:" — the 2-5 job titles worth finding at a prospect.\n` +
    `3. A line starting "Hooks should speak to:" — the pain or timing the outreach angle ` +
    `should aim at, when evidence supports it.\n` +
    `Output ONLY the kernel text. No preamble, no markdown headers.`;
  const cliArgs = ["-p", "--allowed-tools", "WebFetch",
    "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}'];
  if (model) cliArgs.push("--model", model);
  // execFileSync, not execFile: only the sync variant supports `input` (stdin);
  // blocking is fine — this is an interactive CLI waiting on one derivation.
  const stdout = execFileSync("claude", cliArgs, { input: prompt, encoding: "utf8", maxBuffer: 1e6, timeout: 180_000 });
  const text = stdout.trim();
  if (!text) throw new Error("Kernel derivation returned nothing.");
  return text;
}

/* ---- main ---- */
const rl = createInterface({ input: process.stdin, output: process.stdout });
try {
  console.log("Gramercy setup — a CSV of companies in, your kernel written, ready to run.\n");

  let csvPath = args.csv;
  while (!csvPath) csvPath = (await rl.question("Path to your CSV of companies: ")).trim();
  const csvText = await readFile(csvPath, "utf8");
  const targets = importCsv(csvText);

  let kernel = "";
  if (args.icp) kernel = args.icp.trim();
  else if (args.url) {
    console.log(`Deriving your kernel from ${args.url} (your default Claude model reads the site)…`);
    kernel = await deriveKernelFromUrl(args.url, args.model);
  } else {
    const ans = (await rl.question("Your company's URL (I'll read it and write your kernel), or just describe who you sell to: ")).trim();
    if (/^https?:\/\//.test(ans)) {
      console.log("Deriving your kernel (your default Claude model reads the site)…");
      kernel = await deriveKernelFromUrl(ans, args.model);
    } else kernel = ans;
  }
  if (!kernel) throw new Error("Gramercy needs a kernel — the researcher has to know who it's working for.");

  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(join(DATA_DIR, "kernel.md"), kernel + "\n");
  await writeFile(join(DATA_DIR, "targets.json"), JSON.stringify({ targets }, null, 2));

  console.log(`\nDone.`);
  console.log(`  kernel  → data/kernel.md   (edit it any time — every research run carries it)`);
  console.log(`  targets → data/targets.json (${targets.length} companies)`);
  console.log(`\nRun it:`);
  console.log(`  node server.mjs`);
  console.log(`  curl -s -X POST localhost:4400/api/workers/run -H "content-type: application/json" -d '{"n":4}'`);
  console.log(`  curl -s localhost:4400/api/results.csv > enriched.csv`);
} catch (err) {
  console.error("\nsetup: " + (err?.message || err));
  process.exitCode = 1;
} finally {
  rl.close();
}
