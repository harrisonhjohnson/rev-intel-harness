---
name: enrich
description: Run the Rev-Intel Harness end to end — import a CSV of companies, derive or reuse the user's kernel, dispatch enrichment workers, and deliver an enriched CSV of contacts. Use when the user asks to enrich leads or companies, find contacts/people for a list, run the harness, or hands you a companies CSV.
---

# Enrich a company list

You are operating the Rev-Intel Harness in this repo. `AGENTS.md` is the full operating
brief; this skill is the happy path. Report costs and honesty labels faithfully — that is
the product's whole personality.

## 1. Setup (skip if `data/targets.json` and `data/kernel.md` both exist)

Ask the user for their CSV path if they haven't given one. Then either derive the kernel
from their site or take a description:

```bash
node setup.mjs --csv <their.csv> --url <https://theirco.com>
# or:
node setup.mjs --csv <their.csv> --icp "<one line on who they sell to>"
```

The CSV needs a company-name or domain column (`company`, `name`, `domain`, `website`,
`url` are recognized); other columns ride along as research notes. If the user wants
better hooks or different personas, edit `data/kernel.md` — every research run carries it.

## 2. Start the server (if not already listening)

```bash
curl -s -o /dev/null localhost:4400/ || (nohup node server.mjs > server.log 2>&1 &)
```

## 3. Dispatch and watch

```bash
curl -s -X POST localhost:4400/api/workers/run -H "content-type: application/json" -d '{"n":10}'
curl -s localhost:4400/api/workers/status   # poll every ~60s until run.finishedAt is set
```

Size `n` to the user's ask (max 25 per run; dispatch again for more). Failed jobs need
nothing from you — their 30-minute leases expire and the next run picks them up. If a
lane keeps failing, read its `lastError` from status and report it verbatim.

## 4. Deliver

```bash
curl -s localhost:4400/api/results.csv > enriched.csv
curl -s localhost:4400/api/usage
```

Hand the user `enriched.csv` and summarize honestly:
- how many companies enriched, out of how many
- the email honesty split (`published` vs `pattern-guess` vs none) — and say plainly
  that **no email is verified**; verification must happen before anything is sent
- what it cost, from the usage ledger (subscription-lane work is $0 cash)

## Constraints (do not soften these)

- No discovery: the harness enriches the provided list; it cannot build one.
- Never present a `pattern-guess` email as a found or verified address.
- Everything is local; do not expose the server beyond loopback or add credentials.
