# ContextHub

自架的個人 Context Hub：**各 app 透過 REST API 寫入 context，AI agents 透過 MCP 讀取跨 app context**，並內建信任模型——每筆資料帶有「誰說的」（authority）與「審核狀態」（acceptance），agent 的推論經人審核才成為可用知識，來源 ACL 無法被洗白。

完整設計見 [docs/DESIGN.md](docs/DESIGN.md)。

```
Apps（財務/人際/工作…） ──REST──▶  ContextHub（NAS, Docker）  ◀──MCP── AI agents（hermes…）
                                   SQLite + FTS5（中文全文搜尋）
                                   authority / acceptance / read_sources ACL
```

## 本機開發

```bash
npm install
npm test          # tsc typecheck + vitest（core / REST / MCP / 信任模型邊界）
npm run dev       # http://localhost:8787
npm run e2e       # 真實 HTTP 端對端（build → seed → REST → MCP → 收工）
```

發 API key（CLI 直接操作 DB，不需 ADMIN_TOKEN）：

```bash
npm run cli -- create-client --id finance-app --name "財經管理App" --kind app --scopes read,write
npm run cli -- create-client --id hermes --name "Hermes 秘書" --kind agent --scopes read,write --max-sensitivity private
npm run cli -- create-client --id ball-agent --name "棒球社群" --kind agent --scopes read --read-sources crm-app
npm run cli -- seed-demo     # 塞入財務/人際/工作三個來源的示範資料
npm run cli -- list-clients
```

Client 政策（server 端裁決，agent 傳參數沒用）：`--max-sensitivity`（private 資料天花板，app 預設 private、agent 預設 normal）、`--read-sources`（來源白名單，預設 all）。

## NAS 部署

```bash
git clone <this repo> && cd ContextHub
echo "ADMIN_TOKEN=$(openssl rand -base64 32)" > .env
docker compose up -d --build
curl http://localhost:8787/health   # {"status":"ok"}

docker compose exec contexthub node dist/cli.js create-client \
  --id hermes --name "Hermes 秘書" --kind agent --scopes read,write
```

**備份**：WAL 模式下直接複製 `.db` 不是一致備份。用內建快照指令，NAS 排程每日跑、Hyper Backup 指向快照目錄：

```bash
docker compose exec contexthub node dist/cli.js backup   # → /data/backups/contexthub-<ts>.db
```

外出存取建議 Tailscale（不開公網 port）。

## App 端：寫入 context（REST）

```bash
curl -X POST http://<nas>:8787/v1/items \
  -H "Authorization: Bearer chk_xxx" -H "Content-Type: application/json" \
  -d '{
    "type": "state",
    "title": "本月餐飲預算已用 82%",
    "content": "剩 NT$2,160，距月底 9 天",
    "data": {"budget": 12000, "spent": 9840},
    "source_item_id": "monthly-food-budget",
    "source_uri": "myfinance://budget/2026-07"
  }'
```

寫入原則：**放 AI 決策有用的投影，不是全量原始資料**（歷史留在你的 app；`source_item_id` 讓同一個業務物件就地更新、`transaction` 只 dedup 不覆寫、更正回 409）。查詢：`GET /v1/items?q=財務&type=task`。完整 API 與 per-type 政策見 [docs/DESIGN.md §7](docs/DESIGN.md)。

## Agent 端：接上 MCP

```bash
claude mcp add --transport http contexthub http://<nas>:8787/mcp \
  --header "Authorization: Bearer chk_<agent的key>"
```

7 個工具：

| Tool | 用途 |
|---|---|
| `get_context_brief` | 規劃前先呼叫：一次拿跨來源近況摘要 |
| `get_current_context` | 「現在成立的事」：active 任務、未來事件、有效狀態、**已審核**的洞察 |
| `search_context` | 全文搜尋（中文 OK、多查詢一次合併、結果帶 authority/acceptance 標籤） |
| `get_recent_context` | 最近 N 天時間軸 |
| `get_context_item` | 單筆全文＋evidence＋審核紀錄 |
| `propose_insight` | agent 提案推論（附 confidence 與 evidence；**審核前對所有讀取隱形**） |
| `list_context_sources` | 看有哪些來源（只列你有權讀的） |

## 審核 agent 的提案

```bash
npm run cli -- review-insight --id 01K... --action accept --revision 1 --note "確認屬實"
npm run cli -- review-insight --id 01K... --action reject --revision 1 --note "單次行為，非長期偏好"
```

或給你的審核 UI app 一把含 `review_insight` scope 的 key 走 `PATCH /v1/items/:id`。被拒的提案 agent 可用 id 讀到 `review_note`，知道為什麼。

## 專案結構

```
src/
  core/    # 所有 SQL、ACL（ReadAccess）與信任規則（items-repo, clients-repo, canonical, cjk, errors）
  http/    # Fastify：auth + /v1 routes（審核權限矩陣在 items route）
  mcp/     # MCP server（7 tools）+ Streamable HTTP 掛載
  db/      # SQLite 連線 + 內嵌 migrations
  cli.ts   # create-client / review-insight / seed-demo / backup
test/      # 57+ tests：core 單元、REST/MCP 整合、信任模型安全邊界
```
