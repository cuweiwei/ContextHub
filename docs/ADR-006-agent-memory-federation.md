# ADR-006: Agent Memory Federation Protocol v1

- Status: Accepted
- Date: 2026-08-20
- Scope: agent local memory、ContextHub shared memory、single-winner claim 與 conflict-safe compilation

## Context

Codex、Claude、Hermes 各自可能保存 local memory。如果 agent local store 與 ContextHub 同時複製完整長期記憶，就會形成無法確認 revision、無法套用 revocation、無法共用 review history 的多重權威。既有 successor 模型可以修正已接受記憶，但缺少跨 agent cache contract，也無法讓 compiler 精確辨認「同一事實的兩個 active winner」。

## Decision

採用 `contexthub-agent-memory-federation/v1`：

1. Agent local memory 只能分類為 `local_only`、`cache_pointer` 或 `shared_candidate`。
2. `cache_pointer` 只包含 `hub_item_id`、`revision`、`change_cursor`、`cached_at`，不複製 Memory 內容。
3. Schema v15 增加 nullable、canonical `claim_key`，供適合單一 current winner 的 claim 使用；不建立 unique constraint，因為系統必須能表達、揭露並裁決既有衝突。
4. Compiler 找到同一 `claim_key` 的多筆 active accepted items 時，擴張取得所有 ACL-readable peers、排除全部 claimant，並回傳 `conflicts[]`，不得以 score 或 authority 靜默選擇。
5. MCP instructions 規定 agent 查 history/source、遵從目前使用者對本次任務的明確指令、以 successor 提出長期修正，而且不得 self-accept。
6. `get_changes` 回傳 protocol metadata 與 cache pointers；一般 accepted reader 的 feed 會隱藏其他 agent 尚未接受的 candidate，且 cursor 仍跨過不可見事件。
7. OpenAI、Anthropic、Hermes target adapters 共用同一 domain contract 與 compatibility matrix；本機 contract、真實 provider client、NAS production 分開記錄 evidence level。

完整 normative contract 見 [Agent Memory Federation Protocol v1](AGENT-MEMORY-FEDERATION.md)。

## Consequences

正面結果：

- ContextHub 維持 AI shared memory 的唯一權威，agent 可保留本地便利性而不形成第二份真相。
- Revocation、successor、ACL 與 namespace 改變會在重新讀取時生效。
- 未裁決 conflict 對模型可見但不會被當作事實輸入。
- 三種 target adapter 可以用相同測試語意驗證。

成本與限制：

- 只有有 `claim_key` 的 single-winner claim 能得到強制 conflict exclusion；舊資料需逐步整理，不做不可靠的自動回填。
- Pointer cache 需要額外的 hub read，不能在離線狀態宣稱內容仍是最新。
- Conflict 需要 owner/reviewer 裁決；v1 不加入自動 winner policy。
- 真實 Codex、Claude、Hermes client smoke 與 production deployment 仍是獨立工作，不能由本機 Vitest 取代。

## Alternatives considered

- **完整複製 Memory 到每個 agent store**：拒絕；會產生多重權威與失效資料。
- **以 unique index 禁止衝突**：拒絕；無法導入已存在的矛盾，也把治理問題變成不透明的 write failure。
- **Compiler 自動選最新／最高 authority**：拒絕；accepted 不是客觀真理，且 score 不等於裁決。
- **停用所有 agent local memory**：拒絕；local workspace rules 與短期 runtime state 有合理用途，問題是權威範圍而非功能本身。

## Migration and rollback

Migration v15 在升級前沿用既有一致性 snapshot gate，新增 `context_items.claim_key` 與 current-claim index；舊列保持 `NULL`。Rollback 以 pre-migration snapshot 還原，之後依 runbook reindex；不得直接對 production database 手動 `DROP COLUMN`。本次變更不自動修改任何既有 Memory、client credential 或 namespace policy。
