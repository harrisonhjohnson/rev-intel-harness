# Gramercy

**A CSV of companies in; the people out.** Gramercy points the AI subscriptions you
already pay for — Claude Code, Codex, or you pasting into a chat tab — at your list of
target companies and researches each one: a named decision-maker, title, email (honestly
labeled), LinkedIn, firmographics, a specific reason to reach out, and the sources for
every claim. Then it hands you a CSV back.

You have the list. You have the subscription. The enrichment vendors want to charge you
per row for what is, underneath, web research — and you already pay for a tireless web
researcher. Gramercy is the missing harness: local, open source, MIT, and it calls no
APIs and holds no keys of its own.

## Sixty seconds to running

```bash
git clone https://github.com/harrisonhjohnson/gramercy && cd gramercy && node setup.mjs
```

Setup asks two questions: where your CSV is, and your company's URL (or one line on who
you sell to). Your own Claude reads your site and writes your **kernel** — the standing
context every research run carries, so the researcher knows who it's working for, which
personas matter, and what a good hook sounds like. Edit `data/kernel.md` any time.

Then:

```bash
node server.mjs
curl -s -X POST localhost:4400/api/workers/run -H "content-type: application/json" -d '{"n":4}'
curl -s localhost:4400/api/results.csv > enriched.csv
```

## What it costs — and how you know

Every unit of work lands in an append-only ledger (`data/usage-ledger.jsonl`) with
expected-vs-actual cost. Work done by your flat-rate subscriptions logs at **$0**, so cash
spend and free spend sit side by side. This is a principle, not a dashboard feature: if
Gramercy quietly burned through your plan's limits, you'd have been better off paying the
enrichment vendor — so the meter is always on, and honest. In real use it enriched ~1,000
companies for single-digit dollars of marginal cash.

The model split follows the same economics: your expensive model writes the kernel once,
at setup; the per-company legwork runs on a cheaper pinned model, many times. Expensive
judgment once, cheap research at volume.

## How it works

```
your.csv ──▶ setup.mjs ──▶ data/targets.json + data/kernel.md
                                    │
                     GET /api/queue (30-min leases, atomic claim)
                                    │
                  ┌─────────────────┼──────────────────┐
             claude -p          codex exec        you + any chat UI
             (headless)         (ephemeral)       (workers/manual-worker.md)
                  └─────────────────┼──────────────────┘
                                    ▼
                          POST /api/ingest ── sources[] required,
                                    │          emailBasis ∈ published|pattern-guess|not-found
                                    ▼
                    data/enrichment.json (overlay — your CSV is never touched)
                    data/usage-ledger.jsonl (every job, priced; $0 lines included)
                                    ▼
                          GET /api/results.csv
```

Every lane pulls from the same queue and posts to the same ingest contract, so a person
pasting the brief into a chat assistant is a first-class worker and swapping agent
runtimes is a config change. A failed job just lets its 30-minute lease expire; the next
worker picks it up.

| Lane | Runtime | Marginal cost |
|---|---|---|
| claude-code | headless `claude -p`, web search only, model pinned | $0 on a flat-rate plan |
| codex | `codex exec`, ephemeral, schema-constrained output | $0 on a flat-rate plan |
| manual | you, pasting the brief into any capable assistant | whatever you already pay |

## What it will not pretend

Gramercy is honest to the point of bluntness, because the alternative is you getting
burned:

- **It does not verify emails.** It finds published addresses (`emailBasis: "published"`)
  or makes pattern guesses (`"pattern-guess"`), and the label travels with the row into
  your CSV. A guess is never dressed up as a verified address — verify before you send.
- **No evidence, no ingest.** A result without `sources[]` is rejected at the API layer,
  not asked nicely at the prompt layer. Models comply with prompts most of the time;
  validators comply always.
- **It is not a CRM, not a Clay competitor, and not an outreach tool.** It stops at
  researched, cited, provenance-stamped records. What you send — and whether an
  unverified guess ever gets used — is deliberately outside its scope. Respect robots,
  rate limits, and applicable law (CAN-SPAM/GDPR) downstream.

On security: everything runs locally. The server binds to loopback only, holds no
credentials, and the only network traffic is your own agents doing web research under
their own auth. The whole thing is ~600 lines of dependency-free Node — if you want to
have your Claude read it before you run it, Gramercy would genuinely like that. It has
nothing to hide and would happily help you reverse-engineer it.

## Design decisions with scar tissue

Each of these is a rule paired with the burn that taught it:

- **Every file two writers can touch goes through a serialized store.** An unprotected
  JSON read-modify-write survived weeks, then ~70 concurrent writers clobbered each other
  and records vanished. `store.mjs` is 54 lines and structurally ends that bug class.
- **The lease claim happens inside the mutex.** The free-list comes from a stale read;
  the check-and-set runs inside the serialized mutation, or two workers research the same
  company (this happened).
- **Enrichment is an overlay.** Results never mutate your target list; provenance —
  which lane, which model, when — rides on every record.
- **Pin models in unattended runs.** A scheduled worker never inherits an interactive
  session's model choice; `--model` is explicit everywhere.
- **Generous timeouts, honest failures.** Six-minute timeouts killed ~16% of jobs on
  deep-research targets; nine works. No retry logic, no dead-letter queue — an expired
  lease is the retry mechanism.
- **Expected-vs-actual on every call site.** Cost expectations bootstrap from hand-set
  estimates and self-correct to trailing medians. You cannot manage what you politely
  decline to measure.

## Where this is going (and honestly is not yet)

- **Discovery** — give Gramercy your URL and get a CSV of companies matching your ICP,
  not just people for a list you already have. Today it does zero discovery; you bring
  the list.
- **Column-headers-as-prompts** — name a column, get it researched. Held back
  deliberately: open-ended research is where costs stop being predictable, and the
  evidence gate has to survive user-defined shapes first.
- **Feedback surfaces** — the quality and cost numbers exist at `/api/usage`; a loop you
  can act on doesn't, yet.

## Provenance

Built by [Harrison Johnson](https://harrison.build) with Claude — the AI did the legwork,
the design calls and the scar tissue are human. Extracted and genericized from a private
prospecting desk; no client data, prompts, or ICP ships here.

*Gramercy: from "grant mercy" — an old way of saying thank you. Also the quiet park in
the middle of the city that you need your own key to enter.*

MIT licensed.
