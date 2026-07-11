#!/usr/bin/env bash
# End-to-end verification for ContextHub.
# Builds, seeds demo data, mints an agent key, boots the server, exercises
# REST + MCP over real HTTP, then shuts down. Safe to re-run (idempotent seed).
set -uo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-8790}"   # avoid clashing with a dev server on 8787
export PORT DATA_DIR="${DATA_DIR:-./data}"
PASS=0; FAIL=0
step() { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }
check() { # check <name> <expected-substring> <actual>
  if [[ "$3" == *"$2"* ]]; then echo "PASS: $1"; PASS=$((PASS+1));
  else echo "FAIL: $1 — expected to contain [$2], got: $3"; FAIL=$((FAIL+1)); fi
}

step "1/7 build"
npm run build || { echo "build failed"; exit 1; }

step "2/7 seed demo data + mint agent key"
npm run cli -- seed-demo
AGENT_OUT=$(npm run cli -- create-client --id hermes-e2e-$RANDOM --name "E2E Agent" --kind agent --scopes read,write 2>&1)
AGENT_KEY=$(echo "$AGENT_OUT" | grep -o 'chk_[A-Za-z0-9_-]*' | head -1)
[[ -n "$AGENT_KEY" ]] || { echo "could not mint agent key: $AGENT_OUT"; exit 1; }
echo "agent key minted: ${AGENT_KEY:0:12}..."

step "3/7 start server on :$PORT"
node dist/index.js >/tmp/contexthub-e2e.log 2>&1 &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null' EXIT
for i in $(seq 1 30); do
  sleep 0.3
  if curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then break; fi
  [[ $i == 30 ]] && { echo "server did not start"; cat /tmp/contexthub-e2e.log; exit 1; }
done
check "health" '"status":"ok"' "$(curl -s http://127.0.0.1:$PORT/health)"

AUTH="Authorization: Bearer $AGENT_KEY"

step "4/7 REST: unauthorized rejected / Chinese full-text search"
check "401 without key" '"unauthorized"' "$(curl -s http://127.0.0.1:$PORT/v1/items)"
SEARCH=$(curl -s -H "$AUTH" "http://127.0.0.1:$PORT/v1/items?q=%E8%B2%A1%E5%8B%99")   # q=財務
check "search 財務 finds item" '財務規劃' "$SEARCH"
SOURCES=$(curl -s -H "$AUTH" "http://127.0.0.1:$PORT/v1/sources")
check "sources lists finance-demo" 'finance-demo' "$SOURCES"

step "5/7 MCP: initialize"
MCP_HDRS=(-H "$AUTH" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream")
INIT=$(curl -s "${MCP_HDRS[@]}" http://127.0.0.1:$PORT/mcp -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"e2e","version":"0"}}}')
check "MCP initialize" '"name":"contexthub"' "$INIT"
NOAUTH=$(curl -s -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" http://127.0.0.1:$PORT/mcp -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"e2e","version":"0"}}}')
check "MCP rejects missing key" 'Unauthorized' "$NOAUTH"

step "6/7 MCP: tools/list + search_context + get_context_brief + store_context"
TOOLS=$(curl -s "${MCP_HDRS[@]}" http://127.0.0.1:$PORT/mcp -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}')
for t in search_context get_current_context get_recent_context get_context_item propose_insight list_context_sources get_context_brief; do
  check "tool $t registered" "$t" "$TOOLS"
done
SC=$(curl -s "${MCP_HDRS[@]}" http://127.0.0.1:$PORT/mcp -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"search_context","arguments":{"query":["財務規劃","生日"]}}}')
check "search_context multi-query hits 財務" '財務規劃' "$SC"
check "search_context multi-query hits 生日" '生日' "$SC"
BRIEF=$(curl -s "${MCP_HDRS[@]}" http://127.0.0.1:$PORT/mcp -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"get_context_brief","arguments":{"days":30,"focus":"預算"}}}')
check "brief covers finance-demo" 'finance-demo' "$BRIEF"
check "brief covers work-demo" 'work-demo' "$BRIEF"
CURRENT=$(curl -s "${MCP_HDRS[@]}" http://127.0.0.1:$PORT/mcp -d '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"get_current_context","arguments":{}}}')
check "current context has active tasks" 'active_tasks' "$CURRENT"
STORE=$(curl -s "${MCP_HDRS[@]}" http://127.0.0.1:$PORT/mcp -d '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"propose_insight","arguments":{"title":"E2E 洞察測試","content":"使用者偏好早上專注工作","tags":["e2e"],"confidence":0.8}}}')
# tool results are JSON nested inside a string, so quotes arrive escaped
check "propose_insight writes" '\"created\":true' "$STORE"

step "7/7 done"
kill $SERVER_PID 2>/dev/null; trap - EXIT
echo ""
echo "RESULT: $PASS passed, $FAIL failed"
[[ $FAIL == 0 ]] || exit 1
