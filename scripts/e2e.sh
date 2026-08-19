#!/usr/bin/env bash
# End-to-end verification for ContextHub v6.
# Builds, seeds demo data, mints namespace-bound keys, boots the server,
# exercises REST + MCP over real HTTP (including cross-interface
# read-after-write and namespace isolation), then backs up, restores to a
# FRESH data dir, reindexes, and verifies the restored hub. Safe to re-run.
set -uo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-8790}"   # avoid clashing with a dev server on 8787
E2E_DATA="${E2E_DATA:-/tmp/contexthub-e2e-data}"
RESTORE_DATA="/tmp/contexthub-e2e-restore"
rm -rf "$E2E_DATA" "$RESTORE_DATA"
export PORT DATA_DIR="$E2E_DATA"
PASS=0; FAIL=0
step() { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }
check() { # check <name> <expected-substring> <actual>
  if [[ "$3" == *"$2"* ]]; then echo "PASS: $1"; PASS=$((PASS+1));
  else echo "FAIL: $1 — expected to contain [$2], got: $3"; FAIL=$((FAIL+1)); fi
}
check_not() { # check_not <name> <forbidden-substring> <actual>
  if [[ "$3" != *"$2"* ]]; then echo "PASS: $1"; PASS=$((PASS+1));
  else echo "FAIL: $1 — must NOT contain [$2], got: $3"; FAIL=$((FAIL+1)); fi
}
uuid() { node -e 'console.log(require("crypto").randomUUID())'; }

step "1/9 build"
npm run build || { echo "build failed"; exit 1; }

step "2/9 seed demo data + mint namespace-bound keys"
npm run cli -- seed-demo
AGENT_OUT=$(npm run cli -- create-client --id hermes-e2e --name "E2E Agent" --namespace personal --principal-kind agent --profile agent-default --scopes read,write 2>&1)
AGENT_KEY=$(echo "$AGENT_OUT" | grep -o 'chk_[A-Za-z0-9_-]*' | head -1)
[[ -n "$AGENT_KEY" ]] || { echo "could not mint agent key: $AGENT_OUT"; exit 1; }
WORK_OUT=$(npm run cli -- create-client --id work-e2e --name "E2E Work Agent" --namespace work --principal-kind agent --profile none --scopes read,write 2>&1)
WORK_KEY=$(echo "$WORK_OUT" | grep -o 'chk_[A-Za-z0-9_-]*' | head -1)
[[ -n "$WORK_KEY" ]] || { echo "could not mint work key: $WORK_OUT"; exit 1; }
echo "keys minted: personal ${AGENT_KEY:0:12}..., work ${WORK_KEY:0:12}..."

step "3/9 start server on :$PORT"
node dist/index.js >/tmp/contexthub-e2e.log 2>&1 &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null' EXIT
for i in $(seq 1 30); do
  sleep 0.3
  if curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then break; fi
  [[ $i == 30 ]] && { echo "server did not start"; cat /tmp/contexthub-e2e.log; exit 1; }
done
check "health + audit writable" '"audit_writable":true' "$(curl -s http://127.0.0.1:$PORT/health)"

AUTH="Authorization: Bearer $AGENT_KEY"
WAUTH="Authorization: Bearer $WORK_KEY"

step "4/9 REST: auth, Chinese search, namespace isolation, work deny-by-default"
check "401 without key" '"unauthorized"' "$(curl -s http://127.0.0.1:$PORT/v1/items)"
SEARCH=$(curl -s -H "$AUTH" "http://127.0.0.1:$PORT/v1/items?q=%E8%B2%A1%E5%8B%99")   # q=財務
check "search 財務 finds item" '財務規劃' "$SEARCH"
SOURCES=$(curl -s -H "$AUTH" "http://127.0.0.1:$PORT/v1/sources")
check "sources lists finance-demo" 'finance-demo' "$SOURCES"
WORK_DENIED=$(curl -s -H "$WAUTH" "http://127.0.0.1:$PORT/v1/items")
check "work namespace deny-by-default" 'policy' "$WORK_DENIED"

step "5/9 MCP: initialize + tools"
MCP_HDRS=(-H "$AUTH" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream")
INIT=$(curl -s "${MCP_HDRS[@]}" http://127.0.0.1:$PORT/mcp -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"e2e","version":"0"}}}')
check "MCP initialize" '"name":"contexthub"' "$INIT"
TOOLS=$(curl -s "${MCP_HDRS[@]}" http://127.0.0.1:$PORT/mcp -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}')
for t in compile_context search_context get_current_context get_recent_context get_context_item propose_insight list_context_sources get_context_brief save_memory my_candidates propose_successor operate_task get_memory_history record_context_outcome; do
  check "tool $t registered" "$t" "$TOOLS"
done

step "6/9 cross-interface read-after-write (REST write → MCP read)"
IK=$(uuid)
WRITE=$(curl -s -H "$AUTH" -H "Content-Type: application/json" http://127.0.0.1:$PORT/v1/items \
  -d "{\"type\":\"note\",\"title\":\"E2E 一致性驗證獨特詞\",\"idempotency_key\":\"$IK\"}")
check "REST write acked as candidate" '"trust_state":"candidate"' "$WRITE"
MINE=$(curl -s "${MCP_HDRS[@]}" http://127.0.0.1:$PORT/mcp -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"my_candidates","arguments":{}}}')
check "MCP sees the REST write immediately (same principal)" 'E2E' "$MINE"
# replay with the same idempotency key returns the SAME item
REPLAY=$(curl -s -H "$AUTH" -H "Content-Type: application/json" http://127.0.0.1:$PORT/v1/items \
  -d "{\"type\":\"note\",\"title\":\"E2E 一致性驗證獨特詞\",\"idempotency_key\":\"$IK\"}")
check "idempotent replay" '"replayed":true' "$REPLAY"

step "7/9 MCP lifecycle: save_memory / propose_insight"
SAVE=$(curl -s "${MCP_HDRS[@]}" http://127.0.0.1:$PORT/mcp -d "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"tools/call\",\"params\":{\"name\":\"save_memory\",\"arguments\":{\"type\":\"preference\",\"memory_kind\":\"preference\",\"title\":\"E2E 偏好記憶\",\"idempotency_key\":\"$(uuid)\"}}}")
check "save_memory candidate" '\"trust_state\":\"candidate\"' "$SAVE"
STORE=$(curl -s "${MCP_HDRS[@]}" http://127.0.0.1:$PORT/mcp -d "{\"jsonrpc\":\"2.0\",\"id\":5,\"method\":\"tools/call\",\"params\":{\"name\":\"propose_insight\",\"arguments\":{\"type\":\"insight\",\"memory_kind\":\"experience\",\"title\":\"E2E 洞察測試\",\"content\":\"使用者偏好早上專注工作\",\"tags\":[\"e2e\"],\"confidence\":0.8,\"idempotency_key\":\"$(uuid)\"}}}")
check "propose_insight writes" '\"created\":true' "$STORE"

COMPILED=$(curl -s -H "$AUTH" -H "Content-Type: application/json" http://127.0.0.1:$PORT/v1/context/compile \
  -d '{"intent":"規劃目前財務預算","target_agent":"openai","token_budget":1200}')
check "context compiler returns an ephemeral package" '"accepted_only":true' "$COMPILED"
check "compiled context includes an accepted source projection" '財務規劃' "$COMPILED"
PACKAGE_ID=$(node -e 'console.log(JSON.parse(process.argv[1]).package_id)' "$COMPILED")
CONTEXT_ITEM_ID=$(node -e 'const p=JSON.parse(process.argv[1]); console.log(p.sections.sources[0].id)' "$COMPILED")
OUTCOME=$(curl -s -H "$AUTH" -H "Content-Type: application/json" http://127.0.0.1:$PORT/v1/context/outcomes \
  -d "{\"package_id\":\"$PACKAGE_ID\",\"item_ids\":[\"$CONTEXT_ITEM_ID\"],\"outcome\":\"helpful\",\"action_changed\":true,\"idempotency_key\":\"$(uuid)\"}")
check "context outcome stores coarse feedback" '"package_id"' "$OUTCOME"
# work agent must not see any of it
WORK_PROBE=$(curl -s -H "$WAUTH" "http://127.0.0.1:$PORT/v1/items?q=E2E")
check_not "work agent cannot search personal data" 'E2E' "$WORK_PROBE"

step "8/9 backup → restore to a FRESH dir → reindex → verify"
kill $SERVER_PID 2>/dev/null; wait $SERVER_PID 2>/dev/null; trap - EXIT
npm run cli -- backup --out "$E2E_DATA/backups"
SNAPSHOT=$(ls -t "$E2E_DATA"/backups/contexthub-*.db | head -1)
[[ -n "$SNAPSHOT" ]] || { echo "no snapshot produced"; exit 1; }
mkdir -p "$RESTORE_DATA"
cp "$SNAPSHOT" "$RESTORE_DATA/contexthub.db"
export DATA_DIR="$RESTORE_DATA"
npm run cli -- reindex   # MANDATORY after restore (all retrieval projections are rebuildable)
RETRIEVAL_STATUS=$(npm run cli -- retrieval-status 2>&1)
check "restored retrieval projections are complete" '"ready": true' "$RETRIEVAL_STATUS"
RESTORED_OUTCOMES=$(node -e 'const Database=require("better-sqlite3"); const db=new Database(process.env.DATA_DIR+"/contexthub.db",{readonly:true}); console.log(db.prepare("SELECT COUNT(*) AS n FROM context_outcomes").get().n); db.close()')
check "restored hub keeps context outcome feedback" '1' "$RESTORED_OUTCOMES"
node dist/index.js >/tmp/contexthub-e2e-restore.log 2>&1 &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null' EXIT
for i in $(seq 1 30); do
  sleep 0.3
  if curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then break; fi
  [[ $i == 30 ]] && { echo "restored server did not start"; cat /tmp/contexthub-e2e-restore.log; exit 1; }
done
RSEARCH=$(curl -s -H "$AUTH" "http://127.0.0.1:$PORT/v1/items?q=%E8%B2%A1%E5%8B%99")
check "restored hub answers Chinese search" '財務規劃' "$RSEARCH"
RMINE=$(curl -s "${MCP_HDRS[@]}" http://127.0.0.1:$PORT/mcp -d '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"my_candidates","arguments":{}}}')
check "restored hub keeps candidates + keys" 'E2E' "$RMINE"
RAUDIT=$(npm run cli -- audit --namespace personal --limit 5 2>&1)
check "restored hub keeps audit trail" 'read.search' "$RAUDIT"

step "9/9 done"
kill $SERVER_PID 2>/dev/null; trap - EXIT
echo ""
echo "RESULT: $PASS passed, $FAIL failed"
[[ $FAIL == 0 ]] || exit 1
