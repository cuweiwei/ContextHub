# ContextHub

部署在私人 NAS 的**跨 AI 記憶權威平台**(system of record):Codex、Claude Code、個人/工作 Hermes 的唯一記憶來源。**Apps 透過 REST 寫入投影,AI agents 透過 MCP 讀寫記憶**;個人與工作記憶以 namespace 嚴格隔離,agent 寫入經信任升格(candidate→accepted)才成為共享事實,所有讀寫留稽核、所有版本與衝突裁決可追溯。

完整設計見 [docs/DESIGN.md](docs/DESIGN.md);信任邊界與資料治理見 [docs/ADR-001](docs/ADR-001-trust-boundary.md)。

```
Apps/agents ──REST──▶  ContextHub(NAS, Docker)  ◀──MCP── Codex / Claude Code / Hermes
                       SQLite(唯一權威)+ FTS5(中文全文搜尋,可重建)
                       namespace 隔離 ‧ 政策 allowlist ‧ 稽核 fail-closed
                       authority × trust_state × lifecycle ‧ 版本/裁決 append-only
```

## 本機開發

```bash
nvm use
npm install
npm test          # tsc typecheck + vitest(隔離/信任/政策/稽核/一致性/還原邊界)
npm run dev       # http://localhost:8787
npm run e2e       # 真實 HTTP 端對端:REST↔MCP 一致性 → 備份 → 還原 → reindex → 驗證
```

## 開通 clients(一 key 一 namespace)

```bash
# AI 工具(agent):寫入一律 candidate,經你審核才成為共享事實
npm run cli -- create-client --id claude-code-personal --name "Claude Code(個人)" \
  --namespace personal --principal-kind agent --profile agent-default
npm run cli -- create-client --id hermes-personal --name "Hermes 秘書" \
  --namespace personal --principal-kind agent --profile agent-default --max-sensitivity private
npm run cli -- create-client --id codex-personal --name "Codex" \
  --namespace personal --principal-kind agent --profile agent-default

# 來源 app(service):自己投影的可信 producer(policy-accepted)
npm run cli -- create-client --id finance-app --name "財經管理App" \
  --namespace personal --principal-kind service --profile app-producer

# 你自己的審核憑證(human):日常審核不要用 ADMIN_TOKEN
npm run cli -- create-client --id tim-reviewer --name "Tim(審核)" \
  --namespace personal --principal-kind human --profile reviewer

# 工作 namespace:deny-by-default,建了 client 還要在政策裡明確 allowlist
npm run cli -- create-client --id hermes-work --name "Hermes(工作)" \
  --namespace work --principal-kind agent --profile none
npm run cli -- policy-show --namespace work > /tmp/work-policy.json   # 編輯 rules 後:
npm run cli -- policy-apply --namespace work --file /tmp/work-policy.json
```

要點:namespace 與 principal-kind **必填**(fail-closed);同一工具要碰個人+工作就發兩把 key、設兩個 MCP 連線;`--profile` 是顯式的政策升版(被稽核),`none` 表示零權限待手動授權;key 外洩用 `rotate-key --id <client>`(身分與稽核連續性保留)。work namespace 只放抽取後摘要/task,禁原文——見 ADR-001。

## NAS 部署

```bash
git clone <this repo> && cd ContextHub
cp .env.example .env
# ADMIN_TOKEN 設為新隨機值；CONTEXTHUB_BIND_ADDRESS 設 NAS 的 Tailscale IPv4。
# 絕對不要填 NAS 的固定公網 IPv4。
docker compose up -d --build
curl http://<nas-tailscale-ip>:8788/health   # {"status":"ok","audit_writable":true,...}
```

**備份**(每日 NAS 排程;WAL 下直接複製 `.db` 不是一致備份):

```bash
docker compose exec contexthub node dist/cli.js backup        # VACUUM INTO → /data/backups/
docker compose exec contexthub node dist/cli.js idempotency-gc # 90 天 TTL 清理(每週)
```

Hyper Backup 指向 `backups/` 並開啟 client-side 加密。**還原**(也是每月 drill 的腳本):

```bash
./scripts/restore.sh data/backups/contexthub-<ts>.db
# stop → 移開舊 db 與 -wal/-shm → 放快照 → start → 必跑 reindex → health 驗證
```

外出存取走 Tailscale,不開公網 port。ISP 固定公網 IP 不是必要條件；ContextHub
只綁 NAS 的 Tailscale IP，不能綁 `0.0.0.0` 或 NAS 的公網 IP。

## Agent 端:接上 MCP

```bash
claude mcp add --transport http contexthub-personal http://<nas-tailscale-ip>:8788/mcp \
  --header "Authorization: Bearer chk_<personal的key>"
claude mcp add --transport http contexthub-work http://<nas-tailscale-ip>:8788/mcp \
  --header "Authorization: Bearer chk_<work的key>"     # 連線即 namespace 邊界
```

Codex 的安全設定、personal/work credential 隔離與 smoke test 見
[docs/CODEX.md](docs/CODEX.md)。

16 個工具。讀取面:`search_context`(中文 OK、多查詢合併、結果帶 authority/trust_state)、`get_current_context`、`get_recent_context`、`get_context_item`、`get_context_brief`、`list_context_sources`、`get_memory_history`(版本+裁決史)、`my_candidates`(自己的待審)。

記憶生命週期:`save_memory`(存偏好/事實/專案脈絡;政策決定 candidate/accepted)、`propose_insight`(推論+evidence)、`revise_my_candidate`、`propose_successor`(取代過時的 accepted 記憶,裁決原子寫回)、`operate_task`(型別化任務操作,碰不到語意欄位)、`curate_note`、`update_operational_state`/`get_operational_state`(exact-key 狀態槽)。

所有 mutation 必帶 `idempotency_key`(UUID)——timeout 重試安全,同 key 回原結果。

## 審核 agent 的記憶提案

```bash
npm run cli -- candidates                          # 待審 inbox
npm run cli -- review --id 01K... --action accept --revision 1 --note "確認屬實"
npm run cli -- review --id 01K... --action reject --revision 1 --note "單次行為"
npm run cli -- review --id 01K... --action revoke --revision 3 --note "已不成立"
npm run cli -- audit --namespace work --limit 50   # 稽核軌(讀/寫/拒絕/管理)
```

Human reviewer 可從 Tailscale 私網開啟 `http://<NAS_TAILSCALE_IP>:8788/review`，
貼上該 namespace 的 reviewer key 進行 inbox、歷史、接受與拒絕操作；key 只留在當前頁面的記憶體，
不會寫入 localStorage。REST 介面仍是 `POST /v1/items/:id/review`。被拒的提案 agent 可用 id
讀到 `review_note`;接受 successor 會原子地把舊記憶標為 superseded(裁決寫回 hub)。

## ADMIN_TOKEN 管理

- token **只存在 NAS 上的 `.env`**(`.gitignore` 已排除),絕不寫進 repo、文件或訊息。
- 產生/輪替:NAS 上 `sed -i "s/^ADMIN_TOKEN=.*/ADMIN_TOKEN=$(openssl rand -base64 32)/" .env && docker compose up -d`,舊 token 立即失效。
- 曾出現在任何檔案、剪貼簿或對話中即視同外洩,立即輪替。日常審核用 human reviewer key,不用 admin token。

## 專案結構

```
src/
  core/    # 單點強制層:commands(mutation+稽核+idempotency)、items-repo(applyFilters:
           #   namespace+trust+ACL)、policy/policies-repo(PolicyV1 版本化)、audit-repo、
           #   clients-repo(immutable identity)、canonical、cjk、errors
  http/    # Fastify:auth + /v1 routes(items/candidates/review/task-op/curate/state/
           #   history/audit/policies/clients/namespaces)+ health(degraded 回報)
  mcp/     # MCP server(16 tools)+ Streamable HTTP 掛載(stateless,一 key 一 namespace)
  db/      # SQLite 連線(synchronous=FULL、instance lock)+ 內嵌 migrations(v1–v5)
  cli.ts   # create-client/rotate-key/policy-*/review/candidates/audit/reindex/backup/purge/...
scripts/   # e2e.sh(REST↔MCP 一致性+備份還原全流程)、restore.sh(NAS runbook)
test/      # 100+ tests:隔離/信任/政策/稽核 fail-closed/idempotency/一致性/還原邊界
docs/      # DESIGN.md(v4)、ADR-001(信任邊界與治理)
```
