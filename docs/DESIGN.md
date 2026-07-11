# ContextHub 設計文件

> 自架的個人 Context Hub：讓不同 app 寫入 context，讓 AI agents 讀取跨 app context——並且讓資料**可信**：誰說的、還有效嗎、agent 的推論被審核過嗎。

## 1. 問題與動機

我的 AI agents（例如秘書 agent「hermes」）對我的理解非常破碎：財務狀況在記帳 app、人際關係在人際管理 app、工作任務在工作 app，這些管道 agents 無法存取。當 hermes 要幫我規劃一天時，它看不到「餐飲預算快爆了」「答應老王週三打球」「7/15 有簡報要交」，規劃品質因此受限。

**ContextHub 是部署在自己 NAS 上的共享 context 中樞**：

- 各 app 透過 REST API 把 context 寫進來
- AI agents 透過 MCP 讀取跨 app context，也能把推論**提案**回來（經審核才成為可用知識）
- 資料留在自己的硬體上（隱私），家中所有裝置都能存取（NAS 私有雲）

### 定位原則（第一條）：projection，不是另一個資料庫

ContextHub **不是**各 app 的 system of record，也不保證保存歷史版本——**來源 app 才是歷史的 system of truth**。寫進 Hub 的是「AI 做決策時有用的投影（context projection）」：

- ✅ 「本月餐飲預算已用 82%」（`state`，用 `source_item_id` 持續更新同一筆）
- ✅ 「近期有一筆 NT$18,400 的旅遊支出」（值得注意的異常）
- ❌ 把每一筆刷卡明細全量灌進來

`source_uri` 讓每筆投影連回原 app 的原始資料，需要細節時回源頭查。

## 2. Goals / Non-goals

### Goals（MVP）

| # | 目標 |
|---|---|
| G1 | Apps 能以簡單的 HTTP API 寫入/查詢 context items |
| G2 | Agents 能以 MCP tools 搜尋、瀏覽、提案 context（網路可達，非 stdio） |
| G3 | 中文（繁體）全文搜尋可用，含 2 字詞（如「財務」） |
| G4 | Agent 查詢對 token 與 round-trip 友善（§6） |
| G5 | **信任模型**：provenance 不可偽造、agent 推論與事實隔離、審核有紀錄、ACL 由 server 裁決且無法洗白（§4、§9） |
| G6 | 單一 Docker 容器部署在 NAS，SQLite 單檔資料庫，一致性快照備份 |

### Non-goals（延後到 v2，見 §11）

語意搜尋（embeddings）、entity 正規化圖譜、推播/訂閱、自動 retention、多使用者、公網 hardening、namespace、supersedes 歷史鏈、insight-as-evidence（遞迴 provenance）。

## 3. 架構總覽

```
┌─────────────┐  REST /v1/items   ┌──────────────────────────────┐
│ 財經管理 App │ ────────────────▶ │        ContextHub (NAS)      │
├─────────────┤                   │  ┌────────────────────────┐  │
│ 人際管理 App │ ────────────────▶ │  │ Fastify HTTP server    │  │
├─────────────┤                   │  │  /v1/*  REST for apps  │  │
│  工作用 App  │ ────────────────▶ │  │  /mcp   MCP for agents │  │
└─────────────┘                   │  │  /health               │  │
                                  │  └───────────┬────────────┘  │
┌─────────────┐   MCP (HTTP)      │  ┌───────────▼────────────┐  │
│ hermes 秘書  │ ◀───────────────▶ │  │ core repos（所有 SQL、  │  │
├─────────────┤  search/brief/    │  │  所有 ACL：ReadAccess） │  │
│ 其他 agents  │  propose_insight  │  └───────────┬────────────┘  │
└─────────────┘                   │  ┌───────────▼────────────┐  │
                                  │  │ SQLite + FTS5 (/data)  │  │
                                  │  └────────────────────────┘  │
                                  └──────────────────────────────┘
```

| 入口 | 對象 | 協定 |
|---|---|---|
| `/v1/*` | Apps（寫入方為主）＋審核 UI | REST + Bearer API key |
| `/mcp` | AI agents | MCP Streamable HTTP（stateless）+ Bearer API key |
| `/health` | 監控 | 免認證 |

**為什麼 MCP 用 Streamable HTTP 而不是 stdio**：hub 在 NAS、agents 在 Mac/手機，必須走網路。Stateless mode（每 request 建新 server/transport）讓 NAS 端零 session 狀態。

> MCP spec 的 session 語意仍在演進，stateless 是實作選擇非規格保證。對策：SDK 版本由 lockfile 固定；整合測試用官方 SDK client 走真實 HTTP（`test/mcp.test.ts`），升版即驗證；新 agent 接入先跑 `npm run e2e`。

**為什麼 SQLite**：個人規模（十萬筆內）毫秒級、單檔備份、零維運；WAL 讓多 agent 讀不擋 app 寫。

## 4. 資料模型與信任模型

### `context_items`

| 欄位 | 說明 |
|---|---|
| `id` | ULID（依時間可排序，天然作 created-order cursor） |
| `source` | 寫入者 client id（由 API key 決定，**不可偽造**） |
| `type` | 慣例：`event/fact/state/transaction/note/task/contact/preference/insight`（附錄 A） |
| `title` / `content` / `data` | 一行摘要（搜尋權重最高）/ 全文 / 結構化 JSON |
| `tags` / `entities` | 標籤 / 輕量 entity 連結 `["person:小美"]` |
| `sensitivity` | `normal/private`；由 server 端 client 政策裁決（§9） |
| `authority` | **原始主張者**：`user/app/agent`——見下方信任模型 |
| `status` | `active/completed/cancelled/superseded`——「還算數嗎」 |
| `acceptance` | 僅 insight：`proposed/accepted/rejected`——「審核過了嗎」 |
| `confidence` | 0~1，agent 提案的自評信心（影響排序、給 reviewer 參考） |
| `reviewed_by/at` `review_note` | 審核紀錄；被拒的 agent 能讀到原因，避免重複犯錯 |
| `occurred_at` / `created_at` / `updated_at` | 事發時間（UTC 正規化）/ 寫入 / 更新 |
| `expires_at` | 選填 TTL，過期從查詢消失 |
| `source_item_id` | 原 app 業務物件穩定 ID；`UNIQUE(source, source_item_id)`，觸發 per-type 更新政策 |
| `source_uri` | 回源 app 的連結 |
| `revision` | 每次更新 +1；審核用 optimistic concurrency |
| `idempotency_key` | `UNIQUE(source, key)`；同一請求重送回既有 item（不更新） |
| `deleted` | soft delete |

### `insight_evidence`（junction table）

`(insight_id, evidence_id)`，FK 保證存在性、反向索引支援「哪些 insight 引用了這筆資料」。

### 信任模型核心（直接作為規格）

```text
Authority records who originally asserted the context.
Acceptance records whether an insight has been reviewed.

Reviewing an insight never changes its authority.
A reviewed agent insight remains authority=agent and becomes acceptance=accepted.

Only a trusted human-entry path (the admin token) may create authority=user.
The review_insight scope may change acceptance and review metadata,
but may not create or alter authority=user.

Insight evidence must reference non-insight context items.
Insights, including accepted insights, cannot be used as evidence in the MVP.
This prevents transitive provenance and ACL laundering.
```

具體規則（全部 **server 端強制**，request body 傳什麼都沒用）：

1. **authority 由身分決定**：agent 寫入→`agent`、app 寫入→`app`，body 的 authority 被忽略；只有 admin token（人工輸入/匯入路徑）能指定，包括 `user`
2. **insight 初始 acceptance**：`authority=user`（admin 建立）→`accepted`；agent/app 的推論一律→`proposed`——app 產生≠已驗證
3. **proposed 預設隱形**：search/timeline 候選集階段就排除（不是靠排序降權），`include_proposed` 只用於審核/debug；current/brief 只回 ACL 過濾後的計數
4. **審核**：需 `review_insight` scope 或 admin（**不是** kind=app 就可以）；不可自審；必附 `expected_revision`（`UPDATE … WHERE acceptance='proposed' AND revision=?`，0 rows→409）——reviewer 永遠不會接受到自己沒讀過的版本
5. **insight 對 agent append-only**：內容 PATCH 禁止（admin 例外；reviewer 可改 status 作 supersede）；已審核（accepted/rejected）的 insight 命中同 `source_item_id` →409，換新 key 重新提案；**仍是 proposed 的自己提案**可就地刷新（防提案洪水，尚無審核結果可破壞）
6. **rejected 不可 reopen**（admin 也不行）；從一切查詢消失，僅提案 owner/admin 可用精確 id 取得（含 review_note）
7. **evidence 規則**：只能引用**非 insight** items；必須存在（FK）、寫入者有權讀取（不存在與無權回同一種錯誤，不洩存在性）、≤20 筆
8. **sensitivity 繼承**：任一 evidence 為 private → insight 強制 private——agent 不能把私密資料摘要成 normal；解密是 admin 的明確操作

### Per-type 寫入政策（命中同 `source_item_id` 時）

| type | 政策 |
|---|---|
| `state` / `contact` / `preference` / `task` / `note` | **upsert**：就地更新 current projection（revision+1、FTS 重建） |
| `event` | upsert（允許更正，如會議改期） |
| `transaction` | **dedup-only**：source-owned payload 相同→200 回既有；不同→**409**（更正寫 reversal/correction 新紀錄） |
| `insight` | append-only（見上） |

payload 比較由單一函式 `canonicalizeSourcePayload()` 定義（`src/core/canonical.ts`）：key 排序、NFC 正規化、missing≡null、entities 去重排序；比較範圍 = `type/title/content/data/occurred_at/entities/source_uri`；`tags/sensitivity/expires_at` 是 hub metadata，差異忽略。

**lifecycle ≠ expiry ≠ delete**：任務完成用 `status=completed`（降權可查）、被取代用 `superseded`、限時用 `expires_at`、錯誤資料才 soft delete。

## 5. 中文全文搜尋設計

FTS5 內建 tokenizer 的中文硬傷：`unicode61` 把連續漢字當一個 token（搜「財務」找不到「財務規劃」）；`trigram` 不支援 2 字詞。

**解法：字級切分，索引與查詢兩側對稱。** `財務規劃app` 索引為 `財 務 規 劃 app`；查詢 `財務` → phrase query `"財 務"`（相鄰性由 phrase 保證）。英文與中英混合（`AI會議`）不受影響。Snippet 在 JS 端從原文擷取，無空格污染。FTS 零命中 fallback `LIKE` 子字串掃描。簡繁互轉（搜簡體命中繁體）為 v2。

## 6. Agent 查詢效率設計

瓶頸不在 DB，在 **(a) agent 的 context window token、(b) tool round-trip 次數、(c) 命中率**。

### 6.1 Token 效率 — 回傳分層

搜尋/時間軸/brief/current 回 **compact 格式**（`id, source, type, title, snippet(~160字), tags, authority, status, acceptance, confidence, occurred_at`），不含全文與 `data`；全文用 `get_context_item`。每個回應附 `total_matched`，agent 知道要縮小條件而不是翻頁燒 token。

### 6.2 Round-trip 效率

- `search_context` 的 `query` 收 `string | string[]`（≤10），server 端 rank fusion 合併
- `get_context_brief`（近期摘要）與 `get_current_context`（當前狀態）各一次呼叫取代多輪查詢
- `list_context_sources` 一次回 sources + type 分布 + 筆數

### 6.3 命中率 — RRF + type-aware lifecycle 排序

```
score = RRF(各 query 的 bm25 排名) × lifecycle_factor(type, status, acceptance, confidence, age)
```

**RRF 而非直接比分**：不同 query 的 bm25 分數分布不可比，排名才可比。每 query 取 bm25 序（欄位權重 title×3/tags×2/content×1）前 500 名，合併累加 `1/(60+rank)`。

**type-aware 衰減**：統一衰減會錯殺長期資訊（「身高 188cm」不該因一年沒更新而消失）。

| type | 衰減 | 額外權重 |
|---|---|---|
| `fact/state/contact/preference` | 不衰減 | — |
| `task` | active 不衰減；之後 30 天半衰期 | 非 active ×0.4 |
| `event/transaction/note`（含未知） | 30 天半衰期 | 非 active ×0.4 |
| `insight` | 90 天半衰期 | ×confidence（預設 0.7）；proposed 再 ×0.5（僅 include_proposed 時可見） |

不同工具不同排序：search 用上表、current 用截止日/開始時間、recent 純時間軸。

### 6.4 DB 基本盤

WAL、prepared statements、對應過濾路徑的索引、`limit ≤ 100`、tags 走 `json_each()`。

## 7. REST API 規格

認證：`Authorization: Bearer chk_<base64url 32B>`。錯誤格式 `{"error":{"code","message"}}`；衝突類為 `409 source_item_conflict / revision_conflict`。

| Method/Path | Scope | 說明 |
|---|---|---|
| `POST /v1/items` | write | `idempotency_key` 重複→200 既有；`source_item_id` 命中→per-type 政策（§4）；否則 201。agent 限 `insight/task/note`；authority 由 server 決定 |
| `POST /v1/items/batch` | write | ≤100 筆，整批 transaction |
| `GET /v1/items` | read | 過濾：`source,type,tags,status`（逗號分隔）、`q`、`since/until`、`sensitivity`（server 裁決）、`include_proposed`、`sort=created\|occurred`、`limit≤100`、`cursor`/`offset`。搜尋回 `{items,total_matched,offset}`；列表回 `{items,next_cursor}`（occurred 序 cursor 為 `(occurred_at,id)` composite，補寫歷史不漏不重） |
| `GET /v1/items/:id` | read | 無權與不存在同回 404（不洩存在性）；owner/admin 可取回 rejected 提案（含 review_note） |
| `PATCH /v1/items/:id` | write | 權限矩陣：acceptance 變更＝獨立操作，需 `review_insight`/admin＋`expected_revision`＋非自審；insight 內容 append-only（admin 例外，reviewer 可改 status）；其他 type 限 owner/admin |
| `DELETE /v1/items/:id` | write | soft delete（owner/admin） |
| `GET /v1/sources` | read | 只列 `read_sources` 白名單內的來源；計數不含 proposed/rejected 與 ceiling 外的 private |
| `POST/GET/PATCH /v1/clients` | admin | 發 key（明碼一次）、`scopes`（含 `review_insight`）、`max_sensitivity`、`read_sources` |
| `GET /health` | — | 監控 |

## 8. MCP tools（7 個）

Endpoint `POST /mcp`（Streamable HTTP stateless、JSON response）。工具描述為 LLM 使用時機最佳化。

| Tool | 何時用 | 關鍵行為 |
|---|---|---|
| `get_context_brief` | **開始規劃時先呼叫** | 跨來源近期摘要＋proposed 計數；確定性 SQL 聚合，無隱藏 LLM |
| `get_current_context` | 查「現在成立的事」 | current ≡ active ∧ 未刪 ∧ 未過期：active tasks（近截止優先）、未來 events、最新 states、**accepted insights only**；transaction 不屬於 current |
| `search_context` | 有明確問題/關鍵字 | multi-query RRF；預設排除 proposed；結果帶 authority/acceptance 標籤 |
| `get_recent_context` | 無關鍵字、看近況 | 純時間軸 |
| `get_context_item` | snippet 不夠 | 全文＋data＋evidence ids＋審核紀錄 |
| `propose_insight` | 學到持久推論 | 強制 `authority=agent, acceptance=proposed`；`confidence`＋`derived_from`（非 insight evidence）；private evidence→私密提案；審核前隱形 |
| `list_context_sources` | 首次接觸 hub | 只列白名單內來源 |

`include_private` / `include_proposed` 都是**意圖參數**：真正授權由 server 端 client 政策（`max_sensitivity`）與可見性規則裁決，被拒時回 note 說明。

審核路徑（agent 沒有審核工具，by design）：

```bash
# 本人在 NAS 上審核（或用有 review_insight scope 的 UI app 走 PATCH）
npm run cli -- review-insight --id 01K... --action accept --revision 1 --note "確認屬實"
```

## 9. 認證、授權與 ACL

- **Key**：`chk_` + 32B base64url，DB 只存 sha256；admin 用 `ADMIN_TOKEN` env（timing-safe 比對）
- **Scopes**：`read`、`write`、`review_insight`（審核 insight——**能力**，不由 kind 推導）、`admin`
- **Client 政策**（server 裁決，工具參數只是意圖）：
  - `max_sensitivity`：`normal/private` 讀取天花板（app 預設 private——自己的資料；agent 預設 normal）
  - `read_sources`：來源白名單，`null`=全部、`[]`=全不可讀（明確測試不被 falsy 誤判）
- **ACL 收在 repo 層**：所有讀取方法必收 `ReadAccess{clientId,isAdmin,readSources,maxSensitivity}`，新增 route 無法繞過；無權單筆一律 404
- **Insight ACL 繼承（防洗白）**：讀 insight 時，其**所有 evidence 的 source 都必須在讀者白名單內**——不能讓無權讀 finance 的 agent 透過 hermes 的推論間接取得財務資訊。MVP 禁止 insight-as-evidence，故一層檢查即完備
- **威脅模型（MVP）**：家用 LAN / Tailscale 私網，不曝公網；HTTPS/rate limit/audit log 為 v2

## 10. 部署與備份（NAS）

```bash
echo "ADMIN_TOKEN=$(openssl rand -base64 32)" > .env
docker compose up -d --build
docker compose exec contexthub node dist/cli.js create-client \
  --id hermes --name "Hermes 秘書" --kind agent --scopes read,write
```

**備份（WAL 注意事項）**：WAL 模式下已 commit 的資料可能還在 `-wal` 檔，直接複製活躍 `.db` 不是一致備份。做法：

```bash
docker compose exec contexthub node dist/cli.js backup   # VACUUM INTO 一致性快照 → /data/backups/
```

- NAS 排程每日執行；Hyper Backup 指向 `backups/` 快照目錄，不備份活躍 DB
- 每月做一次 restore test（拿快照開起來跑 `/health`＋一筆查詢）
- private 資料真正 purge（非 soft delete）為 v2 待辦

Tailscale 建議：NAS 裝 Tailscale 後外出裝置走私網，不開公網 port。

## 11. Roadmap（v2+）

| 項目 | 接縫 |
|---|---|
| 語意搜尋（sqlite-vec + 本地 embedding） | 搜尋已抽象在 repo，加一路 vector 候選源 |
| Entity 圖譜 | `entities` 欄位已存結構化字串 |
| insight-as-evidence | 需 recursive CTE 做 evidence closure 的 ACL/sensitivity 繼承＋環檢測 |
| supersedes 歷史鏈 | `status=superseded` 已在；缺 `supersedes_id` 圖 |
| 訂閱/推播 | 單一寫入路徑（repo.insert）易掛 hook |
| Retention/purge | `expires_at` 已生效；缺實體清除 |
| 多使用者 / namespace | client 模型可擴充 |
| 簡繁互轉搜尋 | query 側加轉換層 |
| 安全 hardening | HTTPS、rate limit、audit log、key rotation |

## 12. 附錄

### A. Item type 慣例

| type | 用途 | 更新政策 |
|---|---|---|
| `event` | 已/將發生的事 | upsert（更正） |
| `fact` | 長期為真 | upsert |
| `state` | 目前為真、會變 | upsert（`source_item_id` 必備） |
| `transaction` | 金流紀錄 | dedup-only |
| `note` | 自由筆記 | upsert |
| `task` | 待辦/承諾 | upsert＋status |
| `contact` | 人的資訊 | upsert |
| `preference` | 偏好 | upsert |
| `insight` | **agent 提案**，經審核 | append-only |

### B. Authority × Acceptance

| 情境 | authority | acceptance |
|---|---|---|
| Agent 提案 | `agent` | `proposed` |
| App 自動推論 | `app` | `proposed` |
| Reviewer 接受 agent 提案 | **仍是 `agent`** | `accepted` |
| 使用者透過 admin 路徑親自輸入 | `user` | `accepted` |

### C. 驗收問題集（hub 有價值的判準）

系統該能支撐 agent 穩定回答：

1. 我今天最該先處理什麼？（current_context：任務＋截止日）
2. 本週我對別人有哪些承諾？（task/event 跨 crm+work）
3. 小美生日禮物有什麼線索？（contact＋entities）
4. 最近有沒有大額支出影響旅遊計畫？（transaction＋state 跨 finance）
5. 這個資訊是我說的、app 記錄的、還是 agent 猜的？（authority/acceptance 標籤）
6. hermes 上次提了哪些還沒審的推論？（include_proposed / proposed 計數）
7. 為什麼上次的提案被拒？（rejected＋review_note by id）
8. 棒球社群 agent 看得到我的資產摘要嗎？（read_sources＋evidence 繼承 → 不能）
