# ADR-003：v6 Hybrid Memory Retrieval

- 狀態：Accepted（2026-08-13，owner: Tim）
- 範圍：ContextHub 的 lexical／vector／entity／state 候選源、融合排序、索引權威邊界、效能驗收與升級操作。
- 延續：[ADR-001](ADR-001-trust-boundary.md) 的 trust boundary 與 [ADR-002](ADR-002-context-memory-separation.md) 的 Source／Memory／Context 分層均不變。

## 背景

v5 已能以 FTS5、多查詢 RRF、lifecycle/authority/freshness 與 Context Compiler 找出持久資訊，但仍有三個缺口：拼字或字形變體會漏掉；`entities` 只是被保存而未成為正式候選源；搜尋品質與 latency 沒有可重跑的 eval/benchmark。直接新增外部 vector database 會建立第二個權威、增加 NAS 運維面，也容易讓 ACL 退化成「先搜完再過濾」。

## 決策

### 1. 單一 hybrid retrieval contract

所有一般搜尋與 compiler retrieval 共用 `items-repo.search()`：

```text
query + optional entity hints
  → applyFilters(namespace/trust/source ACL/sensitivity/validity/lifecycle/facets)
  → lexical candidates (FTS5/BM25, bounded LIKE fallback)
  → local vector candidates (sqlite-vec cosine)
  → structured entity candidates
  → weighted RRF
  → lifecycle/decay/confidence
  → compact results + retrieval diagnostics
```

Operational state 不進上述索引；只在 caller 明確列出 `state_keys` 且通過 exact state rule 時加入 compiler。

### 2. SQLite domain rows仍是唯一權威

`context_items`、versions、reviews 與 policies 才是 domain truth。`items_fts`、`item_embeddings`、`item_tag_index` 與 `item_entity_index` 都是可丟棄 projection；它們只保存索引鍵或 item id、model、dimensions、content hash、BLOB vector 與更新時間，不複製 item content 或 trust metadata。Migration v9 建立 normalized tag/entity projections。

Projection 在 create/update/delete transaction 中同步更新。Migration v7/v9 不把 embedding 計算塞進 schema migration；升級、restore 或 model 變更後執行 `reindex`，再以 `retrieval-status` 驗證 `ready=true`。索引缺失時 lexical 路徑仍可用，不得把 partial coverage 宣稱成完整部署。

### 3. 本地 embedding 與誠實能力邊界

預設 `local-feature-hash-v1` 是 384 維、同步、deterministic、完全 on-device 的 provider，對 title、content、tags、entities 分別加權，支援 Latin character trigram 與 CJK unigram/bigram。它改善 typo／形近與跨欄位相似，不宣稱具備 neural embedding 的同義詞語意。

`LocalEmbeddingProvider` 可被注入替換。替換條件是同步 on-device、model/dimensions 可識別、資料不離開 owner hardware，且必須先以真實但不含敏感內容的 eval set 證明 recall 改善；換 model 後必須全量 reindex。

### 4. ACL-first 優先於 ANN

Vector query 以 `item_embeddings JOIN context_items` 執行 exact cosine top-k，並在同一 SQL 的 distance/order 前套完整 `applyFilters()`。這保留 ACL 正確性，代價是向量成本隨授權後 corpus 線性成長。

sqlite-vec 目前仍為 pre-v1；v6 不把 experimental ANN 當必要權威元件。只有當真實 corpus benchmark 顯示 p95 超出目標，才評估 vec0 partition/ANN；不得為了速度把 namespace、candidate trust、source/evidence ACL 或 sensitivity 改成 application-side post-filter。

### 5. 可量測的完成標準

- `search_context` 每筆回傳 `retrieval_sources`，整次查詢回傳 mode/model/candidate counts/elapsed time。
- Context Package 帶同一份 retrieval diagnostics；audit 仍只記 mode/count，不記 query text。
- 明確 filter 支援 `information_class`、`memory_kind` 與 exact canonical entity；query-time entity inference 只作 boost。
- `npm run benchmark:retrieval -- --items=N` 讀取 60-case sanitized eval，輸出 lexical/hybrid Success@1、Recall@5、MRR、p50/p95，並在 hybrid regression 時非零退出。
- 測試必覆蓋 typo vector recall、entity candidate、namespace/source/sensitivity/trust/validity filter、projection rebuild、backup/restore/reindex。
- reviewer 可讀取 duplicate/conflict/stale/expired `working_state` 的只讀整理建議；建議不能自動改寫 accepted item。

## 後果

正面：

- 對 typo、structured entity 與多路 query 的 recall 提升，compiler 不需自己拼搜尋策略。
- 不新增外部服務或雲端資料路徑；Docker/NAS 仍是單節點 SQLite 運維模型。
- 每一個結果可解釋來自 lexical/vector/entity 哪一路，能建立後續 eval loop。
- 向量 extension、model 或 index 可被移除重建，不影響記憶權威與版本史。

代價與限制：

- Exact cosine 是 O(authorized corpus × dimensions)；需以實測決定何時導入 ANN。
- 預設 feature hash 不是 deep semantic model；同義詞/跨語言 recall 仍有限。
- sqlite-vec 是 pre-v1 dependency，升版需跑完整 test、audit、E2E、benchmark 與 restore/reindex drill。
- Migration 後需一次明確 reindex；只啟動新版程式不代表 v6 projection 已完成。

## 參考

- [sqlite-vec Node.js / better-sqlite3 integration](https://alexgarcia.xyz/sqlite-vec/js.html)
- [sqlite-vec repository and pre-v1 compatibility notice](https://github.com/asg017/sqlite-vec)
