# ContextHub AI agent 操作與記憶遷移指南

> 這份文件可以直接交給 Codex、Claude Code、Hermes 或其他支援 MCP 的 AI agent。
> 它說明 agent 應如何讀寫 ContextHub，以及如何把既有的長期記憶安全地遷移進來。

## 1. 你正在使用什麼

ContextHub 是使用者 AI 記憶的唯一權威來源（system of record）。你透過 MCP
連線，而且一條 MCP 連線只對應一個 server-side namespace：

- `personal`：個人偏好、長期事實、人物、專案脈絡、個人待辦。
- `work`：只允許抽取後的工作摘要、行動項目、決議與工作偏好。

NAS 的 Tailscale MCP endpoint：

```text
http://<NAS_TAILSCALE_IP>:8788/mcp
```

這是 Tailscale 私網位址，不是公網 endpoint。你的執行環境必須已加入同一個
tailnet，而且只能取得本次工作所需 namespace 的 credential。

不要要求使用者把 bearer token 貼進對話、repo、`AGENTS.md` 或設定檔。Credential
應由執行環境的 secret store／環境變數提供。

## 2. 必須遵守的信任規則

1. 只有 `trust_state=accepted` 的項目可當作共享事實。
2. `candidate` 是尚未由使用者審核的提案，不可在答案中當作已確認事實。
3. 不要保存暫時性的對話內容、一次性指令、工具輸出或可由原始資料重新取得的全文。
4. 每次新的 mutation 都產生新的 UUID `idempotency_key`；只有重試同一次操作時才重用原 key。
5. 寫入前先搜尋，避免重複；accepted 記憶過時時用 `propose_successor`，不可另寫一筆互相矛盾的「現況」。
6. 個人與工作 credential 不得放在同一個 always-on agent process。
7. Work namespace 禁止存入 email／Teams／會議逐字稿原文、PII、客戶資料、未公開財務資訊與機密技術細節。

## 3. 每次工作的標準流程

### 第一次接觸某個 ContextHub 連線

1. 呼叫 `list_context_sources`，了解這個 namespace 有哪些來源與資料類型。
2. 呼叫 `get_context_brief`，取得近期跨來源摘要。
3. 如果工作涉及特定人物、專案、偏好、決策或歷史，再呼叫 `search_context`。

不要在每一句話前重複讀取。一次工作先讀 brief，遇到需要精確證據的主題再搜尋即可。

### 回答或規劃前

- 「現在最重要的是什麼」：`get_current_context`
- 「最近發生什麼」：`get_recent_context`
- 「搜尋某個人物／專案／偏好」：`search_context`
- 「需要完整內容」：先從搜尋結果取得 id，再用 `get_context_item`
- 「為何這筆記憶成立、被誰接受或如何改過」：`get_memory_history`

引用記憶時要保留來源判讀：

- `authority=user`：人類直接輸入
- `authority=app`：來源 app 的投影
- `authority=agent`：AI agent 提案，即使已接受仍然是 agent provenance

### 寫入前的判斷

只保存跨 session 仍有價值的內容，例如：

- 穩定偏好：回覆語言、溝通方式、工具偏好
- 長期事實：固定環境、長期限制、重要人物關係
- 專案脈絡：已確定的架構、決策、約束與後續工作
- 可追蹤任務：有明確完成條件的後續事項

不要保存：

- 本次對話才有用的中間步驟
- 未驗證猜測（若確實值得保留，使用 `propose_insight` 並附 evidence）
- 完整 log、raw transcript、secret、token 或密碼
- 已存在且語意相同的記憶

### 寫入流程

1. 用 `search_context` 搜尋相同主題，並視需要開啟 `include_candidates`。
2. 若沒有等價項目，呼叫 `save_memory`。
3. 一個 item 只表達一個可獨立審核的事實、偏好、決策或任務。
4. 使用簡短 title、完整但精煉的 content，以及可搜尋的 tags／entities。
5. 使用 `my_candidates` 確認寫入結果與待審狀態。

建議欄位：

```json
{
  "type": "preference",
  "title": "網路變更前先做唯讀檢查",
  "content": "使用者偏好先區分公網 IP 與 NAS LAN IP，未經明確授權不得套用、重開機或拔線。",
  "tags": ["network", "nas", "change-safety"],
  "entities": ["device:GNest"],
  "sensitivity": "normal",
  "source_item_id": "migration:codex:network-change-safety",
  "idempotency_key": "<fresh UUID>"
}
```

`source_item_id` 是來源內的穩定識別，用來避免尚未審核的同一記憶重複建立；它不是
`idempotency_key`。後者代表一次邏輯 mutation。

### 修正記憶

- 自己尚未審核的 candidate：先讀取最新 revision，再用 `revise_my_candidate`。
- Accepted 記憶已過時：用 `propose_successor`。舊記憶會在 successor 被接受前保持 current。
- Candidate 被拒絕：讀取原 item 的 `review_note`；被拒項目不能重開，修正後要用新 UUID 建立新提案。

## 4. 把 agent 的既有記憶遷移進 ContextHub

### 遷移原則

遷移不是把整個記憶資料夾原封不動上傳。正確流程是：

```text
唯讀盤點舊記憶
→ 分類與去除暫時資訊／secret
→ 拆成原子記憶
→ 搜尋 ContextHub 去重
→ 以原 agent credential 寫成 candidate
→ 使用者在 /review 審核
→ 從 /explore 與 search_context 驗證
→ 舊記憶先改為唯讀，確認穩定後才清理
```

使用原 agent 的 MCP credential 寫入很重要：ContextHub 才能保留正確的
`source=<agent client id>`、`authority=agent` provenance。不要為了快速匯入而使用
`ADMIN_TOKEN` 偽裝成人類已確認資料，也不要跳過 candidate review。

### Step 1：唯讀盤點

請先找出目前 agent 的長期記憶來源，但不要修改或刪除：

- Codex：目前環境提供的 memory store，以及其指向的專案／rollout 摘要。
- Claude Code：使用者或專案層的 `CLAUDE.md`、rules、memory files。
- 其他 agent：其 profile、memory、instructions 或 exported memories。

`AGENTS.md`、`CLAUDE.md` 中的開發規則不一定都是「使用者記憶」。純 repository
操作規範應留在 repo；只有跨工具、跨 session 值得共享的使用者偏好與專案事實才搬進 ContextHub。

### Step 2：分類

把每段舊記憶標為下列其中一類：

| 類別 | 處理 |
|---|---|
| durable fact / preference / contact / project context | 遷移 |
| 有明確完成條件的 follow-up | 以 `task` 遷移 |
| 推論、模式或建議 | 用 `propose_insight`，必須附 ContextHub evidence id |
| 暫時性狀態、舊指令輸出、已完成一次性工作 | 不遷移 |
| secret、token、密碼、raw transcript | 禁止遷移 |
| 與 ContextHub accepted item 等價 | 跳過 |
| 與 accepted item 衝突且新資料較可信 | `propose_successor` |

工作資料還要先抽取成不含原文、PII 與機密細節的摘要。

### Step 3：正規化與穩定識別

- 一筆 item 只包含一個能單獨接受或拒絕的主張。
- `occurred_at` 表示原事件時間，不是匯入時間；不知道就省略。
- `source_item_id` 建議格式：

```text
migration:<origin-agent>:<stable-topic-or-original-key>
```

例如：

```text
migration:codex:nas-dhcp-reservation-preference
migration:claude-code:contexthub-trust-boundary
```

- 每筆記憶使用新的 UUID `idempotency_key`，並在 migration log 中暫存「舊記憶 key
  → item id → idempotency key」。不要把 token 寫進 log。

### Step 4：分批寫入

每批建議 20 筆以內：

1. 對該批每個主題呼叫 `search_context` 去重。
2. 對真正需要遷移的項目呼叫 `save_memory`。
3. 呼叫 `my_candidates`，確認數量、title 與 type。
4. 暫停，讓使用者從 `/review` 接受或拒絕。
5. Accepted 後從 `/explore` 與 `search_context` 抽樣驗證，再做下一批。

不要一次匯入數百筆後才審核；錯誤分類會讓 inbox 難以處理。

### Step 5：切換與回復策略

1. 遷移完成後，舊記憶來源先保留且改為唯讀。
2. 用以下問題做抽樣驗證：
   - 使用者有哪些穩定偏好？
   - 目前 ContextHub 專案的安全邊界是什麼？
   - NAS 與遠端存取的已確認設定是什麼？
   - 是否存在互相衝突的 current items？
3. 確認新的 agent session 能只靠 ContextHub 找到上述內容。
4. 經過至少一輪實際使用與備份後，再由使用者決定是否清理舊記憶。

遷移失敗時不需 rollback ContextHub schema：拒絕錯誤 candidates、對錯誤 accepted item
提出 successor／revoke，並繼續使用尚未刪除的舊記憶來源。

## 5. 可直接交給 agent 的 migration prompt

```text
請把你目前可讀取的既有長期記憶遷移到 ContextHub。

規則：
1. 先唯讀盤點，不要修改或刪除舊記憶。
2. 只遷移跨 session 有價值的偏好、事實、人物、專案決策與未完成任務。
3. 不遷移 secret、token、密碼、raw transcript、工具 log 或一次性對話細節。
4. Work namespace 只能存抽取後摘要；禁止原文、PII、客戶資料、未公開財務與機密技術細節。
5. 每筆只包含一個可獨立審核的主張。
6. 每筆寫入前先用 search_context 去重；相同就跳過，舊 accepted 記憶需要修正時用 propose_successor。
7. 使用 save_memory 寫入；source_item_id 使用 migration:<agent>:<stable-key>，
   每個新操作產生 fresh UUID idempotency_key。
8. 每批最多 20 筆，寫完用 my_candidates 回報 item id、title、type 與 trust_state，等待我審核後再繼續。
9. 不使用 ADMIN_TOKEN，不把 candidate 當成已確認事實。
10. 完成後從 search_context 抽樣驗證；舊記憶保持唯讀，不要刪除。
```

## 6. 人類如何查看與審核

在已加入同一 tailnet 的裝置開啟：

- 記憶總覽：`http://<NAS_TAILSCALE_IP>:8788/explore`
- Candidate 審核台：`http://<NAS_TAILSCALE_IP>:8788/review`

兩個頁面都使用 namespace 專屬的 human reviewer key；key 只保存在目前頁面的 JavaScript
記憶體，不寫入 localStorage。`/explore` 只顯示這把 key 經 policy 授權可讀的 accepted
items；`/review` 顯示同 namespace 的 candidate inbox。

如果畫面沒有資料，依序檢查：

1. 目前裝置是否連上 Tailscale。
2. 使用的 key 是否屬於正確 namespace。
3. Client 是否有 read scope 與 `memory.read_accepted` capability。
4. Private items 是否超過這把 key 的 sensitivity ceiling。
5. Candidate 是否還沒被接受。

## 7. 完成標準

Agent 的 ContextHub 整合只有在以下條件全部成立時才算完成：

- 能呼叫 `list_context_sources` 與 `get_context_brief`。
- 搜尋結果只包含 credential 所屬 namespace 可讀內容。
- 新記憶以 candidate 寫入，而且 exact retry 不會重複建立。
- 使用者能在 `/review` 審核。
- Accepted 後能在 `/explore` 與新的 agent session 搜尋到。
- 舊記憶尚未刪除，且 ContextHub 備份／還原流程已存在。
