# Gramercy manual worker — paste this into any capable chat assistant

The human-paste lane. Any assistant that can search the web and return JSON is a
valid enrichment worker; the ingest contract doesn't care who did the research.

1. Lease a target:

   ```
   curl -s "http://localhost:4400/api/queue?limit=1&worker=manual"
   ```

2. Paste the contents of `enrich-prompt.md`, then `data/kernel.md`, then the leased
   row, into your
   assistant of choice. Ask it to return only the JSON object.

3. Post the result back (add your lane name as `source`):

   ```
   curl -s -X POST http://localhost:4400/api/ingest \
     -H "content-type: application/json" \
     -d '{ ...the JSON, "source": "manual", "model": "whatever-you-used" }'
   ```

If ingest rejects it, the error says why — usually a missing `sources[]` array
(no evidence, no ingest) or an invalid `emailBasis`. Fix and repost. An abandoned
lease frees itself in 30 minutes.
