# ADR-002: Context、Memory 與 Source 分層

- 狀態：Accepted（2026-08-12，owner: Tim）
- 範圍：ContextHub 的產品定位、持久資料角色、Memory lifecycle、Context Compiler 與 action-effectiveness feedback。
- 延續：[ADR-001](ADR-001-trust-boundary.md) 的 namespace、trust、ACL、audit、work governance 與 SQLite 單一權威邊界均不變。

## 背景

舊設計把所有「對 AI 有用的資訊」都稱為 context，同時又把 ContextHub 定位成跨 AI Memory system。這會混淆三個不同問題：

1. Source/RAG：這次任務應從哪些權威來源找資料？
2. Memory：哪些過去資訊值得跨 session 保留，並在未來改變行動？
3. Context engineering：這次 inference 在有限 budget、特定權限與模型格式下實際看到什麼？

Chat history 只是 archive；只有經 observe → extract → classify → propose/review → retrieve → affect action → update/supersede 的資訊，才構成有效 Memory lifecycle。

## 決策

ContextHub 定位為：

> A vendor-neutral Personal Context Control Plane that manages persistent memory, connects authoritative source projections, and dynamically compiles the right context for each AI agent.

### 1. Persistent information role

`context_items.information_class` 由 server 決定：

- `source`：來源 app 的決策用投影；原始資料仍由 app 擁有，`source_uri` 回連。
- `memory`：可跨 session 重用的使用者／agent／經明確標記的 app 萃取資訊。
- `task_state`：exact-key、schema-validated operational state；不進一般搜尋。

`information_class` 不取代 provenance、trust 或 lifecycle；四者正交。Caller 不能直接宣告 information class，但 app 可提供 `memory_kind`，表示它送入的是萃取後 Memory 而非一般 projection。

### 2. Memory semantics and lifecycle

`memory_kind` 固定為 `fact / preference / decision / experience / procedure / relationship / working_state`。另以 `valid_from / valid_until / last_verified_at / decay_policy` 表達有效區間與 ranking freshness。

`valid_from` 尚未到、`valid_until`／`expires_at` 已過的項目在 SQL list/search/compiler surface 排除。Decay 只降低排序權重；revoke、supersede、soft delete 與 purge 仍保有各自語意。

既有 candidate review、version snapshots、successor/supersession、evidence 與 conflict adjudication 共同構成 Memory lifecycle；不新增可繞過 `core/commands.ts` 的寫入路徑。

### 3. Ephemeral Context Compiler

`compile_context`／`POST /v1/context/compile` 依 intent 執行：

```text
accepted + active Source / Memory / explicitly-authorized Task State
  → intent expansion
  → ACL / sensitivity / validity filters
  → relevance + authority + freshness ranking
  → conflict/lifecycle handling
  → deduplication
  → token budget
  → target adapter
  → ephemeral Context Package
```

Package 不寫入 SQLite，也不成為 Memory。Audit 只記 query count、target、budget 與 state-key count，不記 intent。System/user instructions 和 live tool output 仍由 agent runtime 組裝，避免 ContextHub 保存完整 conversation 或 tool transcript。

### 4. Action-effectiveness feedback

Memory quality 的核心指標不是「存了多少」或單純 retrieval precision，而是是否讓未來 action 改變並改善結果。

`record_context_outcome` 寫入 application-level append-only operational ledger `context_outcomes`，內容只有 package id、已授權 accepted item ids、client/namespace、`action_changed` 與 coarse outcome。它不保存 prompt、action text、tool output 或 package content；不能作為另一個語意權威來源。

## 安全與相容性

- SQLite 仍是 AI Memory 唯一權威；FTS 仍可重建，Context Package 不建立第二個 store。
- REST/MCP 共用 commands、policy、ACL、validity filters 與 fail-closed audit。
- `candidate`、namespace、source allowlist、sensitivity ceiling、insight evidence inheritance 均在 compiler retrieval 前套用。
- Compiler adapter 將 Markdown 內容 JSON quote、XML 內容 escape，並標記為 untrusted data rather than instructions；這是 defense-in-depth，不能取代 agent runtime 的 instruction hierarchy。
- Work namespace 的「只存摘要、不存原文／PII／機密」規則不變；Context outcome 也禁止附帶文字內容。
- Migration v6 對 legacy rows 採保守 backfill：operational → task_state；user/agent 或 insight → memory；其餘 app rows → source。可明確推斷的舊 type 才回填 memory_kind。
- 新欄位 optional，既有 REST/MCP create payload 不需修改；既有 client 可逐步補 memory_kind/validity metadata。

## 後果

正面：

- 產品定位從「everything is context」收斂成可驗證的 Source／Memory／Context pipeline。
- 多 AI 共用同一 persistent domain，但每次可得到不同 budget/format 的 Context Package。
- 過期資訊、衝突、candidate poisoning 與敏感資料的控制點更明確。
- 可開始量測「記憶是否真的改變行動」。

代價與限制：

- Deterministic compiler 目前沒有 LLM compression；超出 budget 的整筆項目會省略。
- Model adapter 目前是 Markdown（generic/OpenAI/Hermes）與 XML（Anthropic），不是各 vendor 的完整 prompt runtime。
- Outcome feedback 由 agent 主動回報，可能不完整；目前不自動改變 trust、memory content 或 ranking，避免 feedback poisoning。
- Source connectors 本身仍由 app/integration 負責；ContextHub 接收 projection，不直接宣稱已連上 Gmail／Drive／GitHub。
