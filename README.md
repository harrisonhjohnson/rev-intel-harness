# rev-intel-harness

An open-source **revenue-intelligence harness**: a lease-based enrichment queue
that treats coding agents (Claude Code, Codex — and you, pasting into a chat UI)
as **interchangeable enrichment workers** behind one ingest contract, with
per-source provenance and an honest cost ledger.

Extracted from a real GTM engagement where it enriched ~1,000 companies —
web-researched contact, firmographics, a specific outreach hook, and cited
sources per company — for **single-digit dollars of marginal cash**, by routing
the work to agent CLIs already paid for by flat-rate subscriptions instead of
metered API calls.

No database, no framework, no queue service. Three ~150-line modules, plain
Node, JSON files, curl.

## The idea

Contact enrichment is a research task, and research tasks are what agentic CLIs
are quietly excellent at. But vendors price enrichment per row, and raw API
calls with web search cost real money at volume. The harness inverts it:

```
targets.json ──▶ GET /api/queue (30-min leases, atomic claim)
                      │
        ┌─────────────┼──────────────┐
   claude -p      codex exec     you + any chat UI
   (headless)     (ephemeral)    (manual-worker.md)
        └─────────────┼──────────────┘
                      ▼
              POST /api/ingest  ── validates: sources[] required,
                      │            emailBasis ∈ published|pattern-guess|not-found
                      ▼
        enrichment.json (overlay, never mutates targets)
        usage-ledger.jsonl (every unit of work, priced — $0 lines included)
```

Every lane pulls from the same queue and posts to the same ingest endpoint. The
dispatcher lanes literally self-HTTP the same two endpoints a human uses — so a
person pasting the prompt into a chat assistant is a first-class worker, and
swapping agent runtimes is a config change, not a rewrite.

## Design decisions that earned their place

These all came from running it for real, most of them from getting burned:

- **No evidence, no ingest.** `sources[]` is required at the API layer, not the
  prompt layer. Models comply with prompts most of the time; validators comply
  always.
- **Email honesty is a type.** `emailBasis: published | pattern-guess |
  not-found` — a pattern guess must never masquerade as a verified address, so
  the distinction lives in the schema, where it can't be lost downstream.
- **Leases, and the claim happens inside the mutex.** The free-list is computed
  from a stale read; the check-and-set runs inside the store's serialized
  mutation, or two concurrent workers enrich the same company (this happened).
- **Enrichment is an overlay.** Results never mutate the target list. The input
  stays a clean, re-runnable source of truth; provenance (which lane, which
  model, when) rides on every record.
- **Every file two writers can touch goes through a serialized store.** An
  unprotected JSON read-modify-write survived weeks of light use, then ~70
  concurrent writers clobbered each other and records vanished. `store.mjs` is
  54 lines and structurally ends that class of bug.
- **The meter is a feature.** `usage-ledger.jsonl` logs every unit of work with
  expected vs. actual cost (expected = trailing median of the last 20 runs per
  call site, self-correcting from hand-set bootstraps). Subscription-lane work
  logs at $0 so cash spend and free spend sit side by side — that's how you know
  the routing is actually saving money.
- **Pin models in unattended runs.** A scheduled worker never inherits an
  interactive session's model choice; `--model` is explicit everywhere.
- **Generous timeouts, honest failures.** Deep-research targets take time; 6-min
  timeouts killed ~16% of jobs, 9 works. A failed job just lets its lease
  expire — no retry logic, no dead-letter queue, the next worker picks it up.

## Quickstart

Bring your own agents: a [Claude Code](https://claude.com/claude-code) and/or
[Codex](https://github.com/openai/codex) CLI, logged in on whatever plan or API
key you have. The harness itself calls no APIs and holds no keys.

```bash
# 1. Your target list
cp data/targets.sample.json data/targets.json   # then edit: your companies

# 2. Your ICP — edit the Context section so hooks aim at something real
$EDITOR workers/enrich-prompt.md

# 3. Run
node server.mjs                                  # http://localhost:4400

# 4. Enrich, three ways (mix freely):
curl -s -X POST localhost:4400/api/workers/run -d '{"n":4}'   # dispatcher: both lanes
./workers/enrich-worker.sh 10                                 # standalone Claude Code lane
open workers/manual-worker.md                                 # you + any chat assistant

# 5. Watch
curl -s localhost:4400/api/workers/status | jq
curl -s localhost:4400/api/queue | jq
curl -s localhost:4400/api/results | jq '.rows[] | select(.enrichment)'
curl -s localhost:4400/api/usage | jq .total
```

`data/` is gitignored — your targets and results stay local.

## What this is not

- Not a CRM, and not a Clay competitor — it's the thin orchestration layer
  those tools don't give you when you want to bring your own agents.
- Not an outreach tool. It stops at researched, cited, provenance-stamped
  records. What you send, and whether a `pattern-guess` email ever gets used
  unverified, is deliberately outside its scope.
- Not multi-tenant, not productized. It's a harness: small enough to read in
  one sitting, honest enough to run unattended.

Please use it to research companies, not people at scale, and respect robots,
rate limits, and applicable law (CAN-SPAM/GDPR) in whatever you do downstream.

## Provenance

Built by [Harrison Johnson](https://harrison.build) with Claude (Anthropic's
Claude Code did most of the legwork; the design calls and the scar tissue are
mine). Extracted and genericized from a private prospecting desk; no client
data, prompts, or ICP ships here.

MIT licensed.
