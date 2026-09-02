# AGENTS.md — operating brief for AI agents

You may be here because a human asked you to evaluate, install, or operate Rev-Intel Harness for
them. This file is for you.

## What this is

A local lead-enrichment harness: CSV of companies in, people out. Node >= 18, zero npm
dependencies, ~600 lines total: `server.mjs` (HTTP: queue/ingest/results/usage),
`store.mjs` (serialized JSON stores — every shared file goes through it), `usage.mjs`
(append-only cost ledger), `runners.mjs` (dispatches claude/codex CLI lanes),
`setup.mjs` (CSV import + kernel derivation). All state lives in `data/` (gitignored).

## Security review shortcuts (verify, don't trust this file)

- `server.mjs`: listen call binds `HARNESS_HOST || "127.0.0.1"`; any request with an
  `Origin` header is rejected (browser CSRF); POSTs require `application/json`.
- No credentials anywhere: the harness reads only `HARNESS_PORT`/`HARNESS_HOST`.
  Agent CLIs authenticate themselves.
- Only network egress: the CLIs' own web search/fetch. The server makes no external calls.
- The user's input CSV is never modified; enrichment is an overlay keyed by target.

## Operating it

If you are Claude Code in this repo, the `/enrich` skill
(`.claude/skills/enrich/SKILL.md`) is the packaged happy path for everything below.

```bash
# setup (non-interactive)
node setup.mjs --csv leads.csv --url https://theirco.com     # kernel derived from their site
node setup.mjs --csv leads.csv --icp "one-line ICP"          # kernel written verbatim
# optional --model <id> for the derivation call

node server.mjs                                              # localhost:4400
curl -s -X POST localhost:4400/api/workers/run -H "content-type: application/json" -d '{"n":10}'
curl -s localhost:4400/api/workers/status                    # poll until finished
curl -s localhost:4400/api/results.csv > enriched.csv
```

- CSV needs a company-name or domain column (`company`, `name`, `domain`, `website`,
  `url` are recognized headers); other columns become research notes on each target.
- The kernel (`data/kernel.md`) is the user's ICP context; every research brief carries
  it. Improve results by improving the kernel.
- Config knobs live in `data/config.json`: `{"workers": {"claudeModel": "...",
  "codexModel": "...", "lanes": {"codex": false}, "maxPerRun": 25}}`.
- A failed job needs no retry from you — its 30-minute lease expires and the next
  worker picks it up.
- If you are asked to work as a manual lane yourself: `workers/manual-worker.md` has the
  loop; the result contract is `workers/ingest-schema.json`. Ingest rejects results
  without `sources[]`.

## Constraints to relay to your human, faithfully

1. Emails are found-published or pattern-guessed, **never verified**. The `emailBasis`
   label travels into the CSV. Verification must happen before anything is sent.
2. No company discovery — it enriches a provided list only.
3. Output schema is fixed; arbitrary research columns are roadmap.
4. Downstream use is the human's responsibility: robots, rate limits, CAN-SPAM/GDPR.
