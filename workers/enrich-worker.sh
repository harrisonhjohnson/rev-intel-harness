#!/bin/bash
# Rev-Intel Harness enrichment worker — Claude Code lane, standalone.
# Runs on a flat-rate subscription ($0 marginal cash); the model is PINNED so a
# scheduled run never silently inherits whatever the interactive session uses.
# Usage: ./workers/enrich-worker.sh [N]   # default 10 targets
set -euo pipefail
cd "$(dirname "$0")/.."

N="${1:-10}"
BASE="${HARNESS_BASE:-http://localhost:4400}"
MODEL="${HARNESS_WORKER_MODEL:-claude-sonnet-5}"
PROMPT_FILE="workers/enrich-prompt.md"
KERNEL=""
[ -f data/kernel.md ] && KERNEL=$(printf '\n\nCONTEXT — WHO YOU ARE RESEARCHING FOR (the user'\''s kernel):\n%s\n' "$(cat data/kernel.md)")

for ((i=1; i<=N; i++)); do
  ROW=$(curl -s -m 15 "$BASE/api/queue?limit=1&worker=claude-code" | node -e '
let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{
  const d=JSON.parse(s);
  process.stdout.write(d.rows&&d.rows.length?JSON.stringify(d.rows[0]):"");
})')
  if [ -z "$ROW" ]; then echo "queue empty — stopped after $((i-1)) targets"; break; fi
  KEY=$(node -e 'console.log(JSON.parse(process.argv[1]).key)' "$ROW")
  echo "[$i/$N] researching $KEY …"

  # Prompt goes via stdin: --allowed-tools is greedy and would swallow a
  # positional prompt argument as extra tool patterns.
  # Strict empty MCP config: without it every headless run connects to all the
  # user's MCP servers and can trigger auth prompts.
  OUT=$(printf '%s%s\n\nTARGET RECORD:\n%s\n' "$(cat "$PROMPT_FILE")" "$KERNEL" "$ROW" \
    | claude -p --model "$MODEL" --allowed-tools "WebSearch,WebFetch" \
        --strict-mcp-config --mcp-config '{"mcpServers":{}}' 2>/dev/null || true)

  JSON=$(node -e '
const s=process.argv[1]||"", m=process.argv[2];
const a=s.indexOf("{"), b=s.lastIndexOf("}");
if(a<0||b<=a) process.exit(1);
try {
  const o=JSON.parse(s.slice(a,b+1));
  o.source="claude-code"; o.model=o.model||m;
  process.stdout.write(JSON.stringify(o));
} catch(e){ process.exit(1); }' "$OUT" "$MODEL" || true)

  if [ -z "$JSON" ]; then
    echo "  no valid JSON for $KEY — skipped (its lease frees itself in 30 min)"
    continue
  fi
  RES=$(curl -s -m 15 -X POST "$BASE/api/ingest" -H "content-type: application/json" -d "$JSON")
  echo "  ingest → $RES"
done
echo "done — GET $BASE/api/queue for the tallies"
