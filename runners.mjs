/* Unified worker dispatcher — the one entry point for agent-runtime lanes.
   The harness is the orchestrator; the runners (Claude Code, Codex) are
   interchangeable backends behind one queue and one ingest contract. Both lanes
   self-HTTP the same /api/queue and /api/ingest endpoints that external/manual
   workers use, so a human pasting the prompt into a chat UI remains a
   first-class citizen.
   Runner commands are hardcoded here on purpose — config holds only
   enable/model knobs, never shell. */
import { execFileSync, spawn } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";

const JOB_TIMEOUT_MS = 9 * 60 * 1000; // 6 min timed out ~16% of jobs; deep-research targets need the headroom

// Scheduler environments (launchd, cron) ship a bare PATH — the CLIs live in
// user/homebrew dirs, and their launcher scripts need `node` on PATH too. One
// augmented PATH for both resolution and every spawned child.
const AUG_PATH = [
  join(homedir(), ".local", "bin"),
  join(homedir(), ".claude", "local"),
  "/opt/homebrew/bin", "/usr/local/bin",
  process.env.PATH || "/usr/bin:/bin",
].join(":");
const CHILD_ENV = { ...process.env, PATH: AUG_PATH };

function resolveBin(name) {
  try {
    const out = execFileSync("/usr/bin/which", [name], { encoding: "utf8", env: CHILD_ENV }).trim();
    if (out) return out.split("\n")[0];
  } catch { /* fall through */ }
  return "/opt/homebrew/bin/" + name;
}

function extractJson(text) {
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(text.slice(a, b + 1)); } catch { return null; }
}

function run(bin, args, stdin, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"], env: CHILD_ENV });
    let out = "", err = "", done = false;
    const finish = (result) => { if (!done) { done = true; resolve(result); } };
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish({ ok: false, out, err: "timeout after " + timeoutMs / 1000 + "s" }); }, timeoutMs);
    child.stdout.on("data", (c) => { out += c; });
    child.stderr.on("data", (c) => { err += c; });
    child.on("error", (e) => { clearTimeout(timer); finish({ ok: false, out, err: e.message }); });
    child.on("close", (code) => { clearTimeout(timer); finish({ ok: code === 0, out, err: err.slice(-500), code }); });
    child.stdin.write(stdin);
    child.stdin.end();
  });
}

export function createRunners({ __dirname, PORT, loadSettings }) {
  const BASE = "http://localhost:" + PORT;
  const BINS = { claude: resolveBin("claude"), codex: resolveBin("codex") };
  const SCHEMA_PATH = join(__dirname, "workers", "ingest-schema.json");
  const PROMPT_PATH = join(__dirname, "workers", "enrich-prompt.md");
  console.log(`  Runners: claude=${BINS.claude} codex=${BINS.codex}`);

  async function buildPrompt(row) {
    const brief = await readFile(PROMPT_PATH, "utf8");
    return brief + "\n\nTARGET RECORD:\n" + JSON.stringify(row) + "\n";
  }

  /* ---- lane adapters: prompt in, ingest-shaped JSON out ---- */
  const LANES = {
    "claude-code": {
      label: "Claude Code",
      model: (s) => s.workers?.claudeModel || "claude-sonnet-5",
      async exec(prompt, model) {
        // --strict-mcp-config + empty config: workers need only WebSearch/WebFetch,
        // and without this every headless run connects to ALL configured MCP servers
        // at startup — triggering auth prompts and slow starts.
        const r = await run(BINS.claude,
          ["-p", "--model", model, "--allowed-tools", "WebSearch,WebFetch",
           "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}'],
          prompt, JOB_TIMEOUT_MS);
        const json = extractJson(r.out || "");
        return { json, model, err: json ? null : (r.err || "no JSON in output") };
      },
    },
    codex: {
      label: "Codex",
      model: (s) => s.workers?.codexModel || null, // null → Codex config default
      async exec(prompt, model) {
        const outFile = join(tmpdir(), "harness-codex-" + Date.now().toString(36) + ".json");
        // --ignore-user-config: a user config.toml can define MCP servers whose
        // OAuth re-fires on every ephemeral exec. A `-c mcp_servers={}` override
        // MERGES tables (no-op), so skip the config file entirely — auth still
        // comes from CODEX_HOME; web search re-enabled via -c.
        const args = ["exec", "-s", "read-only", "--skip-git-repo-check", "--ephemeral",
          "--ignore-user-config", "-c", "tools.web_search=true",
          "--output-schema", SCHEMA_PATH, "-o", outFile];
        if (model) args.push("-m", model);
        args.push("-");
        const r = await run(BINS.codex, args, prompt, JOB_TIMEOUT_MS);
        let json = null;
        try { json = extractJson(await readFile(outFile, "utf8")); } catch { /* no output file */ }
        if (!json) json = extractJson(r.out || "");
        await unlink(outFile).catch(() => {});
        return { json, model: model || "codex-default", err: json ? null : (r.err || "no JSON in output") };
      },
    },
  };

  /* ---- dispatcher: shared countdown, one job at a time per lane ---- */
  let current = null; // in-memory run state; single-flight

  async function laneLoop(lane, state, budget) {
    const s = await loadSettings();
    const adapter = LANES[lane];
    const model = adapter.model(s);
    const tally = state.perLane[lane];
    tally.model = model || "runtime default";
    for (;;) {
      if (budget.left <= 0) break;
      budget.left--;
      let row;
      try {
        const q = await (await fetch(`${BASE}/api/queue?limit=1&worker=${lane}`)).json();
        row = q.rows && q.rows[0];
      } catch (e) { tally.lastError = "queue: " + e.message; break; }
      if (!row) { budget.left++; break; } // queue drained — hand the slot back
      tally.currentKey = row.key;
      tally.attempted++;
      const prompt = await buildPrompt(row);
      const { json, model: usedModel, err } = await adapter.exec(prompt, model);
      if (!json) {
        tally.failed++;
        tally.lastError = row.key + ": " + err;
        tally.currentKey = null;
        continue; // lease self-expires in 30 min
      }
      json.source = lane;
      json.model = json.model && typeof json.model === "string" && json.model !== "codex-default" ? json.model : usedModel;
      try {
        const res = await fetch(`${BASE}/api/ingest`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(json),
        });
        const body = await res.json();
        if (res.ok) tally.ingested++;
        else { tally.failed++; tally.lastError = row.key + ": " + (body.error || res.status); }
      } catch (e) { tally.failed++; tally.lastError = row.key + ": ingest " + e.message; }
      tally.currentKey = null;
    }
    tally.done = true;
  }

  async function runBatch({ n, lanes }) {
    if (current && !current.finishedAt) throw new Error("A worker run is already active (started " + new Date(current.startedAt).toLocaleTimeString() + ").");
    const s = await loadSettings();
    const enabled = lanes && lanes.length
      ? lanes.filter((l) => LANES[l])
      : Object.keys(LANES).filter((l) => (s.workers?.lanes || {})[l] !== false);
    if (!enabled.length) throw new Error("No worker lanes enabled.");
    const total = Math.min(Math.max(1, n || 4), s.workers?.maxPerRun ?? 25);
    const state = {
      runId: Date.now().toString(36), startedAt: Date.now(), finishedAt: null, total,
      perLane: Object.fromEntries(enabled.map((l) => [l, { attempted: 0, ingested: 0, failed: 0, currentKey: null, lastError: null, done: false, model: null }])),
    };
    current = state;
    const budget = { left: total };
    Promise.all(enabled.map((l) => laneLoop(l, state, budget).catch((e) => { state.perLane[l].lastError = e.message; state.perLane[l].done = true; })))
      .then(() => { state.finishedAt = Date.now(); });
    return { runId: state.runId, lanes: enabled, total };
  }

  function status() {
    if (!current) return { active: false, run: null };
    return { active: !current.finishedAt, run: current, lanes: Object.keys(LANES) };
  }

  return { runBatch, status, LANES };
}
