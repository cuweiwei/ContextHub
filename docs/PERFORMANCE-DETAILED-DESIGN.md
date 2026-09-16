# ContextHub 效能改善詳細設計

- 日期：2026-09-16
- 狀態：**P1/P2 implementation candidate；提交前的本機驗證已完成，正式部署與 live benchmark 仍待本次 release。**
- 範圍：Hermes → ContextHub 查詢路徑、連線池、精確檢索、NAS 記憶體與儲存、RAM 快取與 SQL。
- 實作 repository：ContextHub 與 AiSecretaryChloe；兩者分別建置、測試、發布、回復。
- 基本約束：[信任邊界](ADR-001-trust-boundary.md)、[系統設計](DESIGN.md)、[Memory Federation](AGENT-MEMORY-FEDERATION.md)。

## 1. 決策摘要

本次 release 先落地能獨立驗證且可快速回復的路徑：Hermes
`memory_prefetch` 可切到單請求 REST compile，production client 使用 bounded
HTTPX connection pool，ContextHub 啟用有上限的 SQLite RAM page cache，並提供
受 feature flag 保護的 `fact`／`exact_claim` retrieval profiles。SSD 仍是 DSM
快取層，不被當成 swap 或 authoritative database；RAM／NVMe 實體升級需另行驗證。

本次改善以降低慢查詢與維持檢索品質為主，避免為了追求平均值而犧牲權限、稽核或記憶正確性。

| 項目 | 採用設計 | 不採用的捷徑 |
|---|---|---|
| 1. 減少請求 | Hermes 的 `memory_prefetch` 內部改用既有 `POST /v1/context/compile`，一個請求完成 | 跳過 MCP 初始化卻仍宣稱遵循其生命週期 |
| 2. 連線重用 | 每個 Hermes MCP process 保有一個同步 HTTPX Client；REST 與相同 origin 的 MCP 共用 transport | 僅加 `Connection: keep-alive` header |
| 3. 精確查詢 | 保留 standard；新增 opt-in fact、exact_claim profile；衝突檢查先於輸出裁切 | 用模型猜測 claim key、把相關車款當成擁有車款 |
| 4. RAM／SSD | 先建立資源基線；RAM 容量目標 16 GiB；合格 NVMe volume 才遷移資料庫 | 把目前快取 SSD 直接格式化、swapoff、把 authoritative DB 放 RAM disk |
| 5. 快取／SQL | 有上限的 SQLite page cache、prepared statement LRU、純查詢轉換快取；保留每次授權與稽核 | Hermes 完整記憶快取、依 TTL 回傳過期權限結果 |

第一個可獨立交付版本只包含量測、REST transport 與 connection pool。Profile 與 cache 各自有 flag 與品質 gate；硬體改善不作為軟體發布的前置條件。

## 2. 已知事實、證據與限制

### 2.1 本次對話的 live baseline

2026-09-16 18:25（Asia/Taipei），在正式 Hermes 容器內直接呼叫部署中的 `mcp_server.call_tool('memory_prefetch', ...)`。5 種問題各 6 次，30 次串行查詢、間隔 250 ms、token budget 4,000；全部取得符合結構的 context package。

| 指標 | 結果 |
|---|---:|
| 完整 provider 呼叫平均 | 296.669 ms |
| 中位數 | 67.255 ms |
| P95，nearest-rank | 1,852.727 ms |
| 最大值 | 3,589.532 ms |
| 初始化階段平均 | 128.990 ms |
| tools/call 階段平均 | 153.298 ms |
| 首輪之後 25 次平均 | 約 70.6 ms |
| 原始車款問題，6 次平均 | 368.880 ms |

解讀限制：

- 包含 Python adapter、MCP 初始化、容器間 HTTP、授權、稽核、檢索與結果組裝；不含聊天模型、外層工具排程與 Telegram／瀏覽器傳輸。
- tools/call 時間不是純 SQL 執行時間。兩個階段平均也不能直接當成 REST 改寫的保證收益。
- 沒有清除 OS page cache 或重啟 ContextHub；首輪只能稱為「測試首輪」，不能宣稱是經控制的 cold-cache benchmark。
- 車款查詢回傳 0 筆；隨機不存在詞句也曾回傳相關結果。這只驗證成功回應，不構成召回或無答案判斷的品質證明。
- 30 次重複問題不能代表一天流量、併發或長時間 idle 後的 P95。
- 數字取自本次工具輸出，沒有另外保存完整原始 benchmark artifact；正式實作驗收必須產生 metadata-only JSON artifact。

### 2.2 原始碼與正式版本必須分開

本文件盤點當下：

| 對象 | revision |
|---|---|
| ContextHub 本機 HEAD | `11f503d1bc1fa17f0743e5523930d05c58cdce2a` |
| AiSecretaryChloe 本機 HEAD | `971e6d3f8f45df438ddca83dda75f2de32c41f5c` |
| ContextHub 正式 container OCI revision label | `e46484761cf8132faacb08dc7b508498b4c016c3` |
| Hermes 正式 container OCI revision label | `4729f7544f039b53f7da79a62259ecfd954bb91c` |

這些是 point-in-time 座標；本次讀取 label 不等於重新驗證來源與 image digest 的完整供應鏈。實作前重新盤點，不覆寫既有未提交文件。下述程式碼形狀以本機 HEAD 為依據；其中 urllib 行為、provider 路徑曾在正式容器直接檢查。

目前本機程式已包含：只在真正 initialize 時更新 MCP 活動、中文展開與向量 query 分離、binary coarse vector selection、exact cosine rerank、既有 claim index。這些不得再次當成待新增優化。

### 2.3 NAS 儲存與記憶體

- DS723+，可見 RAM 約 1.9 GiB；DSM `7.4.1-90080`。
- NVMe：`INTEL SSDPEKKW256G8`，約 256 GB。device-mapper 關係確認它加入 `/volume1` 快取層；未驗證 DSM UI 顯示的快取模式及命中率。
- 硬碟 swap `/dev/md1` 由 `sata1p2`、`sata2p2` 組成；另有 `zram0`、`zram1`，zram 是壓縮 RAM，不是 SSD。
- 先前故障取樣 HDD busy 94–100%、I/O wait 72–81%；新版測試取樣仍有約 41–47% I/O wait，但工具延遲顯著下降。不能把差異全歸因於單一版本或硬體。
- `/volume1` 快取不在 `/dev/md1` swap 的裝置路徑上。資料庫改放 NVMe 不會自動遷移 DSM 系統或 swap。
- Intel SSD 在此 DSM／機型上的「儲存集區」相容性尚未驗證。不得由「已能做快取」推導「可正式建立 volume」。

## 3. 效能目標與不可退讓條件

### 3.1 設計目標

以下是驗收目標，不是目前已達成的承諾。REST、pool、profile、cache 每階段都需與同時段 baseline 比較。

| workload | 目標 | 衡量位置 |
|---|---|---|
| 單 client、standard、連續查詢 | mean ≤ 150 ms、P95 ≤ 500 ms | Hermes provider 完整呼叫 |
| 單 client、間隔 10 秒的查詢 | P95 ≤ 1,000 ms | 同上，含重新建立 TCP 的樣本 |
| exact_claim、有／無資料／衝突 | P95 ≤ 200 ms | 同上；需先通過品質與衝突 gate |
| 合計 4 個 client、每秒 2 次 | P95 ≤ 1,000 ms、非注入錯誤率 < 1% | 混合 workload |
| NAS 下的記憶體 overhead | transport／計時 ≤ 10 MiB；小快取方案整體 RSS 增幅 ≤ 16 MiB | 相同 workload 的 RSS 與 cgroup 差值 |

若 I/O 壓力使絕對目標未達成，報告實際數字與歸因，不調寬 threshold 後宣稱通過。可獨立發布有證據改善且無回歸的 transport，但把整體 SLO 標成未通過。

### 3.2 安全與品質

1. SQLite 仍是唯一記憶權威；維持 WAL + `synchronous=FULL`、單一 active writer。
2. 每個 logical read 都重新認證、解決 policy，並在回應前完成 fail-closed 稽核；快取命中也不例外。
3. namespace、authority、source identity 由 server 決定；personal/work client、連線設定與快取範圍分離。
4. candidate、revoked、superseded、過期、未生效與不可讀資料不得進正常結果。
5. 不用 relevance、最近更新或較小 token budget 隱藏同 claim 的可讀衝突。
6. API 成功不等於回答正確；測試必須包含 ground truth、正確拒答及研究／購買／擁有的區分。
7. 不透過 `NORMAL`、非同步 audit、延後授權、直接 SQLite 旁路或 ANN 後置 ACL 換取速度。

## 4. 整體資料流與共用量測

```mermaid
sequenceDiagram
  participant H as Hermes chat
  participant A as memory_prefetch adapter
  participant P as HTTPX connection pool
  participant R as ContextHub REST
  participant C as core commands
  participant D as SQLite
  H->>A: intent + optional profile/filters
  A->>A: read credential file; create trace id
  A->>P: single POST /v1/context/compile
  P->>R: Bearer key + request id
  R->>C: authenticated namespace-bound client
  C->>D: policy + fail-closed audit commit
  C->>D: ACL-filtered exact or hybrid retrieval
  C->>D: readable claim conflict expansion
  C->>C: dedup + validity + token budget
  C-->>R: new ephemeral ContextPackage
  R-->>A: JSON + request id
  A-->>H: package or explicit provider error
```

### 4.1 計時契約

- Python 用 `time.perf_counter()`、Node 用 `performance.now()`；UTC timestamp 僅供跨服務關聯。不要用跨機 wall clock 相減估算網路延遲。
- adapter 每次呼叫先清空 timing，避免失敗時輸出前一次成功的數字。
- adapter 層記錄 `total_ms`、`credential_ms`、`initialize_ms`（REST 為 null）、`request_ms`、`decode_ms`、transport、profile、HTTP status、穩定 error code。
- server 層記錄 `auth_ms`、`activity_ms`、`authz_ms`、`audit_ms`（含 commit）、`retrieval_ms`、`claim_check_ms`、`compile_ms`、`handler_total_ms`。各階段不重複計入 subtotal。
- 保留 `retrieval.elapsed_ms` 既有意義；新增的詳細時間先只放 server structured log，不新增每筆 SQL 的 production log。
- `X-Request-ID` 只接受 UUID；缺少／格式不合時 server 產生 UUID 並回傳。request id 只關聯診斷，不當 mutation idempotency key。
- timing observer 隨單次 command 傳入，禁止用 global mutable「current request」保存耗時。
- REST onResponse 與 MCP raw response `finish` 必須各自有完成 hook；不能假設 hijacked MCP 回應走完整 Fastify lifecycle。

### 4.2 可觀測資料與成本

- 禁止記錄 raw query、memory title/content、token、Authorization、runtime inputs、完整 upstream response、query hash。
- 允許欄位：request id、時間、route/profile enum、transport、phase duration、結果與候選數、response bytes、stable error code、process RSS。
- production 成功請求抽樣 10%；≥ 500 ms 或失敗請求全記，但每 process 每分鐘最多 120 筆診斷事件，超額只累加 dropped counter。audit 完全不抽樣、不丟棄。
- 基準測試由 benchmark process 收集每次 measurement，勿以 production debug logging 代替。
- 本次不新增 Prometheus／Redis 等常駐服務。透過現有日誌系統匯整；不得為量測引入更大的 NAS 記憶體負擔。
- `auth_ms` 包含認證查找；鑑權快取與 audit chain 驗證簡化均不在本案。

## 5. 項目一：單次 REST 查詢

### 5.1 對外保持相容

Hermes 工具仍叫 `memory_prefetch`，回傳仍為 `ContextPackage`；只改 Hermes 到 ContextHub 的內部 transport。ContextHub REST 與 MCP 均呼叫 `commands.compileContext()`。

現有輸入保留：`intent`、`queries`、`token_budget`；新增欄位見第 7 節。寫入工具、memory_search、memory_sync 的 protocol 本階段維持 MCP，不用一次改完所有工具。

新增 Hermes 設定：

| 變數 | 值與預設 | 行為 |
|---|---|---|
| `CONTEXTHUB_PREFETCH_TRANSPORT` | `mcp` 或 `rest`，程式預設 `mcp` | 完成 A/B 後 production Compose 明確設為 `rest` |
| `CONTEXTHUB_MCP_URL` | 保留既有設定 | 提供 MCP endpoint，REST 使用相同 scheme/host/port |
| `CONTEXTHUB_MCP_TOKEN_FILE` | 保留既有 secret-file 路徑 | 不把 key 寫到 Compose／模型輸入 |

REST URL 由已驗證的 MCP URL origin 加 `/v1/context/compile` 得出，不另增容易漂移的 REST host 設定。origin 僅接受 HTTP/HTTPS，拒絕 userinfo、query、fragment；路徑僅接受 `/mcp` 或 `/mcp/<namespace>`。本版不支援 reverse-proxy path prefix，遇到其他 path 明確拒絕設定，不猜測改寫。

REST namespace 一律來自 credential；即使 MCP URL 帶 namespace，不能把它作為 REST payload 的 namespace。REST rollout preflight 必須確認原 MCP path 與該 credential 配對正確；不得藉改 REST 跳過原本 path/credential mismatch 的錯誤。

### 5.2 認證與錯誤

- 本次 REST 切換只適用既有 namespace-bound legacy API key。現有 REST 沒有等同 MCP 的 OAuth audience/scope resolution；OAuth-only client 保持 MCP，另案設計 OAuth REST parity。
- `include_private`、filters、token budget 依同一 command 契約解讀；測試 REST/MCP 回傳內容一致，不能只測 HTTP 200。
- 每次 logical read 讀取 token file，讓既有 key rotation 契約繼續有效。token 不放在 client default headers；於單次 request 注入。
- `Content-Type: application/json`、`Accept: application/json`；不需要 `tools/list` 或 initialize。
- validate 成功 response 的 `package_id`、`sections`、`constraints`、`rendered_context` 結構。HTTP 200 但 body 為 error 或缺欄位視為 `MEMORY_INVALID_RESPONSE`。
- HTTPX 使用 bounded streaming reader 累計解壓後 response bytes，超過 8 MiB 就關閉 response；不得先 `.read()` 無界載入再檢查大小。
- MCP 仍保留 JSON-RPC error 及 `result.isError` 檢查，不能把 tool error 當 context package。

| 狀況 | adapter 對 Hermes 的回應 | 自動重試／切換 |
|---|---|---|
| 401/403 | `MEMORY_AUTH_UNAVAILABLE`，不可重試 | 無，不退回另一 credential 或 MCP |
| 400/422 | `MEMORY_REQUEST_REJECTED`，不可重試 | 無 |
| 404/405 REST endpoint 缺失 | `MEMORY_PROTOCOL_UNAVAILABLE` | 無；部署者明確切回 MCP |
| 429/503/5xx | provider unavailable；保留安全的 domain code | 本次不自動重試 |
| connect/read/pool timeout | 分類的 provider timeout | 本次不自動重試；不可表示「沒有記憶」 |
| response schema 不合／超過 8 MiB | invalid response | 中止讀取，不回傳部分 context |

基準測試期間不允許隱性 fallback。否則一個慢 REST 再接 MCP 會放大尾端延遲、重複稽核，也掩蓋失敗。相容回復是設定／release 回復，不是每次 request 猜路徑。

### 5.3 非權威活動紀錄

REST 不會觸發 `mcpInitialize`；dashboard 不能因而把正在查詢的 client 顯示為 inactive。重用既有 onRequest 的 `authenticated(clientId)` 活動更新，只更新既有 `last_authenticated_at`／`updated_at`，以該欄位自己的 30 秒間隔抑制重複寫入，不偽造 MCP initialize，也不為 REST 另寫第二筆相同活動。

既有 `authenticated()` 的節流改以 `last_authenticated_at` 判斷，而非其他活動共同更新的 `updated_at`。dashboard freshness 取適當活動欄位最大值。MCP lifecycle 欄位只表示真正 MCP 事件。

不把這些 activity timestamp 當安全稽核；activity 優化不能刪除每次 `read.compile_context` 的 audit。

## 6. 項目二：真正的 HTTP 連線池

### 6.1 實作選擇與生命週期

採用同步 `httpx.Client`，配合現有同步 stdio dispatch，不把工具路徑全面改成 async。正式 Hermes 已安裝 `httpx 0.28.1`、`httpcore 1.0.9`；實作時在 runtime requirements 明確宣告經 CI／弱點檢查通過的這組 pin，不能隱性依賴 upstream image 偶然存在。若掃描不通過，升版後重跑本節測試再發布。

- 每個 MCP process、每組 `(origin, token_file_path)` 一個 client；personal/work 不共用 global Authorization 或 response cache。
- HTTP/1.1，`http2=False`、`trust_env=False`、`follow_redirects=False`、TLS verification 保持啟用。
- pool：`max_connections=4`、`max_keepalive_connections=2`、`keepalive_expiry=30s`。
- timeout：connect 2s、pool 250ms、write 2s、read 15s；HTTP transport retries=0。
- 以上 timeout 是各 phase／read inactivity 上限，不是 15 秒的 hard total deadline。此版不宣稱可以中斷 server 同步 SQLite 工作。
- server 主動關閉 idle connection 時，下一次可建立新連線；不能靠 header 測試推定已重用。
- `context_hub_client()` 重用物件；設定改變時先在無 in-flight request 時 close 舊 client。stdio EOF／正常退出在 `finally` close；SIGTERM 的 process 結束會釋放 OS socket，不新增會阻擋退出的 callback。
- token file 每次重讀；同 origin 的 TCP 可以重用，但每個 HTTP request 都重新驗證 Bearer。刪 key 或 revoke 不得因 pool 存在而繼續讀取。

### 6.2 最小介面

```python
class ContextHubClient:
    def prefetch(self, intent, *, queries=None, token_budget=None,
                 retrieval_profile="standard", claim_keys=None,
                 information_classes=None, memory_kinds=None,
                 entity_filters=None, include_private=False): ...
    def call_tool(self, name, arguments): ...  # 其他 MCP 工具相容
    def close(self): ...
```

production 使用 HTTPX；unit test 注入 transport/mock client。原本的 `Opener` fake 測試遷移成 request/response contract 測試，移除「header 等於 keep-alive 即成功」的斷言。

### 6.3 池的驗收

local HTTP/1.1 fixture 使用完整 Content-Length，記錄 connection accept 數。相同 client 連續 20 次，server 未關線情況下應只建立 1 個 TCP connection；換 credential 不得改變 namespace。再測 server close、30 秒 idle expiry、key rotation、兩個 namespace、多 process、正常退出 FD 回收。

正式驗收若 server 的 keep-alive timeout 較短，報告實際重用率；不為湊重用率擅自延長全站 timeout。短 burst 可以重用，長 idle 後重新連線是正常行為。

## 7. 項目三：精確與小範圍檢索

### 7.1 API 契約

REST compile、MCP compile_context 與 Hermes memory_prefetch 同步新增以下欄位，仍由 domain commands 執行：

| 欄位 | 規則 |
|---|---|
| `retrieval_profile` | `standard`（預設）、`fact`、`exact_claim` |
| `claim_keys` | ContextHub 已有；Hermes 新增 passthrough。exact_claim 要求 1–8 個 canonical key |
| `information_classes`、`memory_kinds`、`entity_filters` | ContextHub 已有；Hermes 新增 passthrough，限制沿用上游 |
| `include_private` | Hermes 新增，預設 false；仍受 credential ceiling 約束 |
| `token_budget` | 顯式值沿用 256–32,000；缺省 standard=4,000，fact/exact_claim=768 |

不新增 namespace/source identity 輸入。claim_keys 是搜尋條件，不是權限。Hermes 只能使用當前 context／受權限保護的工具結果已提供的 key，不猜測 canonical identity，也不將 key 擴充成新的 durable local-memory 欄位。

既有呼叫未提供 profile 時，輸入、輸出與 4,000 token default 保持相容。schema 不可先無條件補 4,000 再判 profile；profile-dependent default 在共用 normalize function 統一決定。

新增 optional response metadata：

```json
{
  "retrieval_plan": {
    "profile": "fact",
    "path": "bounded_hybrid",
    "fallback_used": false
  }
}
```

`path` enum 為 `hybrid`、`bounded_hybrid`、`exact_claim`；保持既有 sections、constraints、conflicts、package_id、rendered_context。exact_claim 不跑搜尋時 `retrieval=null`（現有型別已允許），不把它假標成 vector／lexical。精確候選的 `retrieval_sources=[]`、score=1；權威與衝突仍由 compiler 決定。

### 7.2 三條路徑

**standard：**既有搜尋流程與候選 budget 不變，作為相容基線與 fact fallback。保留既有中文 lexical expansion、vectorQueries 去重與限制、ACL-first coarse/exact vector、entity index。

**fact：**用於單一個人事實／偏好問題。

1. caller 未指定時，使用 soft default `information_classes=['memory']`、`memory_kinds=['fact','preference']`；caller 明確條件原樣保留。
2. lexical query 去重後上限 8；vector 使用原始 intent 與 explicit queries 去重後最多 6，不為每個生成 bigram 做 vector scan。
3. 內部候選 budget：每 query FTS 64、LIKE 32、vector coarse 128、vector final 32、entity 32；RRF 最後留 32 筆 seed。這些是 server profile 常數，caller 不能任意放大。
4. 排序與衝突擴張後，如果沒有可輸出的項目且沒有 conflict，於同一 logical read 執行一次 standard fallback。移除本 profile 自動補上的 soft filters，但保留所有 caller 明確 filters 與全部安全限制。
5. fallback 不增加第二個 HTTP 請求，也不重做已完成的前置 read audit；同次診斷記錄 fallback_used。遇到 conflict 直接交回衝突，不用廣搜掩蓋。
6. 有候選不代表答案相關。先由第 10 節品質 gate 驗證此 budget；未通過則 production 不啟用 fact，不能只為了達標縮小 top-k。

**exact_claim：**已知 canonical claim key 時直接查索引，不經 FTS/vector。

1. 無有效 key、超過 8 個 key 或附帶 state_keys，回 400；不偷偷轉成 full search。
2. 透過既有 `idx_items_claim_current` 與 `applyFilters()` 讀取 accepted、active、有效且 caller 可讀的候選。沒有資料就是空 package；不拿附近的其他事實補答案。
3. 執行以下完整 peer 檢查後才組裝。只有一個可讀 winner 時才可能輸出，仍受 token budget 約束。
4. 多 key 依 key 字典序處理，使結果在同一資料狀態下可重現；所有 claimant 都衝突時輸出 conflicts，不挑最新一筆。

### 7.3 衝突完整性與上限

目前 `claimPeers()` 最多 1,000 筆；新 fast path 不可把「截斷後只有一筆」當成唯一 winner。

- `readAudited()` 完成前置 audit commit 後，以同一個同步 deferred read transaction 執行 seed retrieval、hydration、peer check 與 compile，確保單次 package 使用一致 snapshot；不在此 transaction 內 await、打網路或寫 activity。SQL begin/read 失敗明確回錯誤，不返回部分 package。
- 對 seed claim keys 另做完整的可讀 peer 查詢。安全 filters（namespace、credential readSources、sensitivity、accepted、active、有效期）永遠保留。
- 這個 peer check 不套用 relevance、caller tags、entity/type/kind 等可能藏掉 competing claimant 的縮小條件。caller 的內容選擇仍用於最後輸出；同 key 的其他可讀 claimant 用於排除衝突。
- peer check 不跨越 caller 的安全可讀範圍，也不揭露不可讀 claimant。保證界線是「目前可讀的 claim 衝突」。
- 以最多 1,001 筆偵測 1,000 上限溢位；溢位回新增 `CONTEXT_CANDIDATE_OVERFLOW` domain error（HTTP 422、MCP tool error），不回傳不完整的 task facts，也不自動 retry。
- standard/fact/exact_claim 共用此完整性檢查；這是保守的衝突處理強化，須納入 release notes 與 REST/MCP parity tests。

### 7.4 工具選擇與 rollout

新增 `CONTEXTHUB_ENABLE_QUERY_PROFILES=false` server flag；false 時 standard 照常，非 standard 明確回 `CONTEXT_PROFILE_DISABLED`（400），不靜默忽略。舊 server 未支援的 profile 不可依賴 Zod stripping 當成功。

先部署支援 profiles 的 ContextHub，再部署 Hermes schema／tool instructions。Hermes 初期仍預設 standard，只有單事實且不需 operational state 時使用 fact；已知 key 才 exact_claim。不新增另一個 LLM 做 query classification，以免優化反而增加模型延遲。

Hermes profile 發送需 deployment flag `CONTEXTHUB_QUERY_PROFILES_ENABLED=false`；完成相容測試後設 true。回復順序先關 Hermes flag，再關 ContextHub flag／回復舊 image。

## 8. 項目四：NAS RAM 與 NVMe 儲存

### 8.1 選定策略與執行邊界

容量目標為相容的 **16 GiB RAM**，足夠容量由實際 workload 再驗證；不是本文件授權購買。32 GiB 僅在 16 GiB 後仍有持續換頁或預定 workload 明顯成長時再評估。

儲存目標為 **兩條官方相容 NVMe 建立 RAID 1 專用 volume**，保存 ContextHub 的完整 `/data`；HDD 保存備份與大量檔案。RAID 不取代備份。現有 256 GB Intel SSD 不假定可重用作 volume，也不先移除其快取。若只有單條相容 SSD，維持現況，單碟無冗餘部署須另由 owner 明確選擇。

這是硬體方案設計；軟體開發可先完成。真正執行需要實機相容性、硬體到位、maintenance window、target volume 與 gateway mount allowance 都成立。任一條件不成立就不遷移，保留 HDD 部署並持續量測；不使用第三方 patch 繞過 DSM compatibility。

### 8.2 先量測，再改容量

在一般使用與每日批次工作時段各收集至少 30 分鐘，每 5 秒取樣：

- `MemAvailable`、process RSS、容器 memory limit/usage、OOM/fail counters。
- `/proc/vmstat` 的 pswpin/pswpout 差值；依系統 page size 換算 bytes，不把累積 swap 使用量當流量。
- `/proc/swaps` 分辨 zram 與 HDD；iostat 分裝置觀察 md1、SATA、NVMe。
- iostat 第一次是開機以來平均，從第二次起才是 interval sample；同時記錄 await、queue 與利用率，不只看吞吐 MB/s。
- ContextHub logical query 的 P50/P95、timeout、phase durations，以及當時 background jobs 類型。

先找出佔用最大的服務與可排程工作。只調整被確認的 task／服務；不以關閉所有容器作為優化結果。批次 reindex、backup、restore drill 不與查詢 benchmark 混跑，另做背景工作壓力情境。

RAM 升級後的資源目標：一般 workload 無持續 HDD swap churn；MemAvailable ≥ 實體 RAM 的 20%；無 OOM。既有 swap 中仍有冷頁不算失敗，不執行 swapoff 來美化數字。低於目標時分析 process growth／cache，不立即再加更大快取。

### 8.3 NVMe layout 與容量

| 資料 | 位置 | 原則 |
|---|---|---|
| `contexthub.db`、WAL、SHM、instance lock | `<verified-ssd-volume>/docker/contexthub/data/` | 同一 filesystem、容器內仍 `/data` |
| maintenance metadata、必要 alias 等非 secret 資料 | 同一 `/data` | 保留既有相對位置，不只搬 DB 主檔 |
| production `.env`／secret files | 保持既有 root-owned secret 契約 | 不複製到 repo 或 benchmark artifact |
| snapshot + manifest | 本機既有 backups 及 HDD verified copy | snapshot 與 manifest 一起保存並驗 hash |
| off-device backup | 沿用 owner 管理的加密備份流程 | 不把同 NAS 的另一 volume 當離地備份 |

不得假設新空間一定叫 `/volume2`；從 DSM 的 mount 與磁碟拓樸確認實際 target，再產生 staging Compose。target 可用空間至少為目前 `/data` 用量的 2 倍加兩份 DB snapshot，且搬完保留 ≥ 20% free space；不得刪除既有備份來通過容量檢查。

備份若暫存於 SSD，完成後複製 checksum-valid snapshot+manifest 到 HDD 獨立目錄；不把 live `.db` 的 rsync 當 online backup。現有 `backup --out` 可指定已核准的 backup mount，未核准前用既有一致性 snapshot 路徑再複製 artifact。

### 8.4 為資料搬遷新增明確 maintenance mode

由於一般 gateway 未必提供 stop action，本設計不假設它支援未驗證的命令。ContextHub 新增預設 false 的 `CONTEXTHUB_MAINTENANCE_MODE`，作為使用 gateway 進入維護狀態的應用程式功能：

1. 程式在 openDatabase／migration／worker startup **之前**判斷 flag；maintenance mode 不開 authoritative DB，不執行 audit、notification、connector 或其他背景寫入。
2. 只啟動輕量 HTTP server。`GET /health` HTTP 200，但 payload 必須是 `status: maintenance`、`ready: false`、`audit_writable: false`；`/health/ops` 同樣誠實回報。這是 liveness，不可當作正式服務可用。
3. 所有其他路徑（含 REST、MCP、Control Center）回 503 `MAINTENANCE_MODE`、`Retry-After: 60`；不認證、不讀取 memory，也不產生被服務的讀取。
4. 一般 mode 的 SIGTERM 正常關閉 HTTP 與 DB；維護部署完成後確認原 process 已退出。舊 process 沒停就禁止開始複製。
5. gateway 的 health validation 必須在事前 dry run／非正式環境證實允許此「活著但維護中」契約；若它要求 application status=ok，先停在 gate，另以明確 system-admin task 設計支援方式，不能假報健康或繞過 gateway。
6. 暫停盤點到的外部寫入型 maintenance jobs；只有使用讀取／一致性 snapshot 模式的備份命令可在凍結期間執行。沒有足夠證據排除額外 writer 時，不搬資料。

本功能本身是一項 HTTP／deployment change，需 `npm test && npm run e2e`。維護狀態不是正常 deployment 完成；migration 流程直到解除 maintenance、health/audit/query 全部驗證後才算完成。

### 8.5 資料搬遷順序

遷移使用**同一個已驗證 image 與 schema**，不得同時升 schema、改 retrieval profile 或改 RAM cache；一次只改 storage location。

1. 記錄 source/target mount、image digest、schema、uid/gid、目錄與檔案清單、資料數量、audit chain head；確認 backup/restore drill 通過。清單與 checksum 僅存 owner 限制存取的 NAS evidence，不送到公開報告。
2. 驗證 target 已建立、健康、非 source 的 alias，gateway 註冊允許此 bind root。若 mount root 不被核准，不自行改 `/etc/codex-deploy` 解鎖。
3. 經 staging → validate → deploy 開啟 maintenance mode；確認原 DB writer 與外部 maintenance writer 都已停。
4. 產生 final consistency snapshot 與 manifest；複製完整停寫 `/data` 到 target。保留數值 uid/gid、mode 與必要 ACL；NAS 上檢查 copy tool 是否支援所需旗標。不要把 lock file 是否存在當作仍有 writer 的證據。
5. 搬運包含存在的 DB/WAL/SHM；不可只拷貝主 DB。instance lock sidecar 可重新產生，但 source 留原樣以便診斷。
6. 在 target 的隔離副本執行 quick_check、audit chain、schema、count/hash、restore drill；有任何差異就維持 maintenance，修正或回復來源，不開服務。
7. 修改 repo Compose 的 `/data` bind source 為確認過的 SSD 路徑，先維持 maintenance=true，upload + validate + deploy；確認 runtime mount 正確。
8. 以同一 image 解除 maintenance，經 gateway deploy；依專案規則驗證 version/commit、audit、reindex、projection、restore drill、doctor，再做受權限保護的 compile/search smoke。
9. 恢復已暫停的 maintenance jobs，重跑相同效能 suite。備份來源／排程若仍指向舊路徑必須一起修正並驗證。
10. 舊 data 目錄保留並標示為 inactive，禁止舊 Compose 意外啟動成第二個 authority；不得自動刪除。至少保留至新的 off-device backup 與 restore drill 驗證成功且滿 7 天，再另行決定清理。

禁止兩個不同 `/data` 目錄同時啟動 active instance；既有 instance lock 僅保護同一 dataDir，無法防止兩份拷貝各自成為 writer。這項限制由遷移 orchestration 與同一 service identity 保證。

### 8.6 資料回復不能倒退

- **target 從未接受任何寫入前**：維持 maintenance，改回原 bind、同 image，再解除 maintenance。
- **target 已有任何 commit 後**（包含 audit、session、maintenance metadata）：不能直接啟用已落後的 source。先重新進 maintenance、確認 target 完整性，將最新 target 的完整一致狀態離線複製回來源，再驗證後切回。
- **target 損壞或遺失**：不可宣稱可無損切回；使用 verified snapshot 的正式 restore 必須取得專案要求的獨立 owner 授權，列出 RPO 與可能遺失的時間範圍。
- 只回復 image 不等於資料儲存遷移已回復；rollback report 必須同時列 image、schema、active mount 與最新 audit head。

### 8.7 不做的系統調整

本案不改 SSD swap、swappiness、zram 大小、不清 Linux page cache、不關 sync、不把 WAL 放 tmpfs。這些會改變全機行為；目前先用減少常駐記憶體、增加 RAM、資料庫 NVMe 與量測驗證解決已觀察到的問題。

## 9. 項目五：有上限的快取與 SQL

### 9.1 快取層選擇

| 層 | 本案決定 | 保存內容與一致性 |
|---|---|---|
| OS page cache | 讓作業系統管理 | 不手動 pin 全 DB，不 drop_caches |
| SQLite page cache | 可設定，逐級 A/B | SQLite 自行管理 page 與 transaction 一致性 |
| prepared statement cache | 最多 64 statements／DB connection | 只存 SQL plan，不存查詢結果或授權 |
| query transformation cache | opt-in，最多 128 entries／1 MiB／60 秒 | 只存規範化 query 的純計算結果；不存 memory rows |
| semantic result／ContextPackage cache | **本案不實作** | 每次仍從 SQLite 讀 current authority，避免 TTL 隱藏 revoke／validity／conflict |
| Hermes local memory | 維持 metadata-only pointer | 不新增 full content cache |

這已完整涵蓋本次「RAM 快取」的實作範圍；完整結果快取不是隱藏待辦。若未來 workload 證明仍需要，另開 ADR，設計 transactionally updated visibility epoch、policy version 與 expiry boundary，不能直接加 60 秒 TTL。

### 9.2 SQLite page cache 設定

新增 `SQLITE_CACHE_KIB`：整數 0–65,536，程式預設 0（不覆寫 SQLite 現有設定）；>0 時在 openDatabase 設 `PRAGMA cache_size = -<KiB>`，所有生產 server connection 都一致套用。此值是 page cache 建議上限，不是整個 process 的記憶體硬限制。

- 目前 2 GiB NAS：先維持 0；在 isolated fixture 測 2,048／8,192 KiB。production 只有 RSS、swap 與 latency 全部無回歸才選 8,192。
- 升到 16 GiB RAM：預定配置 32,768 KiB；對照 8,192 與 32,768，只有在 P95 改善 ≥ 10% 且記憶體符合預算時採用較大值，否則留較小值。
- 此版不調 `mmap_size`、`busy_timeout=5000`、WAL checkpoint、journal mode 或 synchronous。不同 cache 設定要重啟才生效，回復配置同樣需走 gateway。
- PRAGMA 行為、實際 page_size/cache_size 與 RSS 都記入 benchmark metadata。不能把配置 32 MiB 當成精確使用 32 MiB。

### 9.3 Prepared statement LRU

新增 connection-scoped `StatementCache`，以完整的 parameterized SQL 字串為 key，最多 64 entries、最多 256 KiB SQL 字串；命中移到 MRU，超額移除最舊 reference，DB close 時 clear。

- 只套用 retrieval 與固定 audit metadata SQL，不改 transaction 邊界。bind 值每次重新傳入，所有 query 結果立即讀完。
- 動態 IN list 的 placeholder 數目屬於 SQL shape；caller 值永遠用 bind，不插值進 SQL。
- schema migration／reindex schema 操作前 clear；關閉／重開 DB 產生新 cache。schema epoch 變更後不重用舊 statement。
- statement 正在執行時不交給另一個 concurrent operation；目前同步單執行緒使用，未來 worker_threads 要各有獨立 DB connection/cache。
- 移除 JS reference 不保證 native memory 當下歸零；驗收需以千種 query shape 的 RSS plateau 證明沒有無界成長。
- feature flag `CONTEXTHUB_STATEMENT_CACHE_ENABLED=false`，獨立 A/B 後才開啟；不能只因 microbenchmark 更快就忽略 full query 無收益。

### 9.4 純查詢轉換快取

可快取 `contextRetrievalQueries()` 的 lexical expansion 與 deterministic query embedding；不快取 items、scores、conflict 結果、package_id 或權限結論。

key 包含 `client.id`、`credentialVersion`、server-derived namespace、normalizer version、alias-file digest、embedding model/dimensions 與精確輸入 digest。digest 只留 process RAM，不輸出到 log；對外不暴露 hit/miss，以免變成跨 client 探測訊號。

- 值與 key 的 retained bytes 一併計算，最多 128 entries／1 MiB；每 entry 60 秒 TTL，monotonic clock 判斷。
- 每次呼叫已通過當次認證、policy、audit 後才使用。模型／alias／normalizer 換版與 credential rotation 產生不同 key；restart 全清。
- item revoke／supersede／到期不需要失效 query vector，因為 cache 不含 item；後續 SQL 與 compiler 永遠重新套用當下狀態。
- 使用 immutable value 或 copy-on-read，避免某次查詢改動共享 vector／array。
- 預設 `CONTEXTHUB_QUERY_TRANSFORM_CACHE_ENABLED=false`；只有 transform phase 佔 full query ≥ 10%，且 A/B 改善 P95 ≥ 10% 才啟用。否則保留關閉，避免低收益的 RAM 成本。

### 9.5 SQL 與索引

1. **exact_claim 使用既有索引**：`idx_items_claim_current(namespace, claim_key, trust_state, status) WHERE claim_key IS NOT NULL AND deleted=0`。先驗證 query plan，不重複建立等價 index。
2. **減少中途全文 materialization**：lexical、vector、entity 候選源盡可能先回 item id／必要 rank metadata；RRF 去重後以有界批次讀 full rows。完整 row hydration 仍呼叫 `applyFilters()` 並使用同一次 query 的 now 值，避免被誤改成全域 id 旁路。
3. lifecycle ranking 需要的 authority/status/time 欄位不能延到排名後才取得；先明確列出 scoring projection，驗證與原版 score、tie order 一致。回傳 full rows 的集合與原版相同，才啟用 ID-first 路徑。
4. binary coarse → exact rerank 與 Chinese vectorQueries 優化本機已有，不重寫。profile budget 之外不改數學 scoring／embedding model。
5. `%LIKE%` fallback 不因一般 B-tree index 就能加速；保留功能，記錄 fallback 發生率與耗時。要換 tokenizer／FTS 策略須另做中文 recall 實驗，本案不直接刪除 fallback。
6. 使用 synthetic 2k／20k／100k fixtures 跑 `EXPLAIN QUERY PLAN` 與時間；不要匯出 production memory 到本機。真實 corpus 的 SQL 診斷在 NAS 內執行，只輸出匿名計數、plan 與耗時。

新增 `CONTEXTHUB_ID_FIRST_RETRIEVAL_ENABLED=false` 作相容回復開關。索引 v1 不新增，故不要求 schema migration；若 plan 證實需要新增 index，列為獨立 migration PR，不能把臨時 production CREATE INDEX 當優化發布。

## 10. 測試與驗收設計

### 10.1 分層量測

| 層級 | 測量內容 | 不可宣稱的範圍 |
|---|---|---|
| L0 | repo.search 與 compiler，synthetic DB | NAS／網路／稽核的使用者體感 |
| L1 | ContextHub REST/MCP endpoint，真實認證與稽核 | Hermes tool dispatch 或 LLM |
| L2 | Hermes memory_prefetch，包括 pool/transport | 完整 chat 回答時間 |
| L3 | 實際 Hermes chat tool trace 與最終回答 | 不拆階段就把整段算成 ContextHub SQL |

每份報告明確列 sample count、warmup／idle 情境、成功率、空結果率、平均、中位數、P95、最大值、phase times、image digest、來源 revision、資料集版本／筆數、profile/cache config、RSS 與 swap/I/O interval。

### 10.2 Benchmark suite

新增 `scripts/context-performance-benchmark.py`（Hermes repo）作 L2 runner，新增 ContextHub fixture／L1 runner。live runner 預設只讀取既有 accepted surface，會產生正常 read audits；不得自動建立／接受測試記憶。synthetic fixtures 只用 temporary DATA_DIR。

| 情境 | 樣本與方式 |
|---|---|
| 可重現 burst | 20 個預定 intent，固定 seed 隨機排列，5 rounds=100；不移除前幾次，另報各 round |
| 稀疏查詢 | 30 次、每次間隔 10 秒；另 10 次每次間隔 60 秒，觀察 idle connection 與資料頁效果 |
| 並行 | 4 個獨立 client，共 200 次，以全體 2 requests/s pacing，client 與 namespace 分離 |
| restart／cold process | 僅 staging，重啟 app 後記前 10 次；明示未清 OS cache，不能稱 cold disk |
| background load | staging 同時跑一致性備份；live 只觀察既有排程，不刻意製造 HDD 壓力 |
| storage/RAM A/B | 同 image、dataset、profile；分開測 RAM 與 volume 變更 |

A/B 至少交錯三個 block，避免先測 A 再測 B 時把 page warming 當成 B 的改進。profile quality suite 與 transport suite 分開；比較 standard transport 時不得同時調 token budget、cache 或 top-k。測試超時／失敗留在報告分母，不能只平均成功樣本；另外列 successful latency distribution 與 failure elapsed times。

live guard：連續 3 次錯誤，或連續 3 次 > 5 秒就停止加壓，保留部分結果並標記 incomplete。benchmark 不自動 retry、reset cache、重啟服務或改 fail-closed policy。報告格式 `contexthub-performance/v1`，只保存 metadata；私有問題清單在 NAS 暫存 RAM，不寫 artifact。

### 10.3 必要功能與安全測試

| 類別 | 必測情境／通過條件 |
|---|---|
| REST/MCP parity | 同 credential、filters、時鐘與資料；忽略 package_id/time/timing 後，sections、conflicts、constraints 等價 |
| request 數 | REST prefetch 一次 POST；MCP 保留 initialize + tools/call；無隱性 fallback |
| 真正連線重用 | fixture 計數 TCP accept，不只比 header；close/idle/rotation 不漏 credential |
| 認證／policy | personal/work、key revoke/rotation、readSources、sensitivity、policy 更新下一次讀取立即生效 |
| audit | 磁碟／稽核注入失敗回 error；cache hit 仍 audit；不能返回 partial package |
| 不存在與無法存取 | 缺 memory、candidate-only、expired、future、deleted、revoked 不回舊值，也不洩露存在性 |
| claim | 一個 winner、兩個 conflict、低分 claimant、被 tag filter 隱藏的可讀 claimant、1,001 筆溢位 |
| fact fallback | bounded 無結果只擴展一次；不移除 caller filters；conflict 不轉廣搜 |
| token budget | 256／768／4,000／32,000；少 budget 不隱藏 conflict；不夠放事實時保留 honest omission |
| cache | hit/miss 回傳等價、換 schema/model/alias/revision、LRU 滿載、ttl 到期、restart、DB close |
| SQL hydration | exact score/tie order 一致、所有 hydration 有 ACL、candidate 不因 ID-first 洩露 |
| transport failure | pool timeout、斷線、HTTP 401/403/429/503、invalid JSON、tool isError、超大 response、redirect |
| hardware maintenance | mode 不開 DB、不跑 worker、503 明確；切換前後 count/hash/audit；target 有新 commit 不回舊副本 |

### 10.4 品質資料集

至少 40 個 sanitized fixtures，覆蓋精確事實、中文改寫、同義／錯字、跨語言、無答案、資料已撤銷、資料衝突。包含「研究某車款」與「目前擁有某車款」兩筆不同語意，不允許藉擴大 recall 把它們互換。

- profile 開啟前必須在同一 ground truth 上比較 Recall@5、Success@1、MRR；三者相對 standard 不下降超過 1 個百分點。
- exact_claim 的已標記 identity fixtures 要求正確 winner／正確 conflict／正確 empty **100%**；任何 ACL 洩漏或 false ownership 即失敗。
- fact 的無答案與衝突 fixtures 必須維持標記預期；若標準檢索本來就會回 related evidence，另測 Hermes 是否正確拒絕推斷，不把「有 package」當答案成功。
- 保留現有 `benchmark:retrieval` gate；不得把舊 synthetic 數字當新增 live 改善證據。

### 10.5 實作時應執行的檢查

ContextHub 使用 Node 22.19.0：`npm ci`、`npm test && npm run e2e`；執行既有 2k/20k 與 scheduled 100k retrieval suite。HTTP/profile/maintenance 都屬需要 e2e 的變更。

Hermes：沿用 CI 的 `python3 -m unittest discover -s tests -v`；加真 HTTP connection-count fixture、secret hygiene、Compose contract 與 dependency vulnerability scan。新增／更新 Python dependency 需驗證完整 image 可重現且沒有未解決的 high/critical runtime findings；ContextHub dependency 若變更再跑 `npm audit --omit=dev`。

文件本身只需 link／格式／內容一致性檢查，不需為寫設計而部署、變動資料庫或重跑應用程式全套測試。

## 11. 設定、實作拆分與發布

### 11.1 設定總表

| 位置 | 變數 | 程式預設 | 首次發布 |
|---|---|---|---|
| Hermes | `CONTEXTHUB_PREFETCH_TRANSPORT` | `mcp` | A/B 通過後 Compose 設 `rest` |
| Hermes | `CONTEXTHUB_QUERY_PROFILES_ENABLED` | `false` | profile quality gate 後才 true |
| ContextHub | `CONTEXTHUB_ENABLE_QUERY_PROFILES` | `false` | 先開 server，再開 Hermes |
| ContextHub | `SQLITE_CACHE_KIB` | `0` | 不自動因發布增加 |
| ContextHub | `CONTEXTHUB_STATEMENT_CACHE_ENABLED` | `false` | 獨立 A/B 決定 |
| ContextHub | `CONTEXTHUB_QUERY_TRANSFORM_CACHE_ENABLED` | `false` | 第 9.4 節收益 gate 通過才開 |
| ContextHub | `CONTEXTHUB_ID_FIRST_RETRIEVAL_ENABLED` | `false` | 行為等價＋效能 gate 後開 |
| ContextHub | `CONTEXTHUB_MAINTENANCE_MODE` | `false` | 正常服務永遠 false |

未知 enum、非法數值與不支援 URL 在啟動／輸入驗證時明確失敗。flags 是 deployment config，不接受模型在單次 tool payload 改寫。

### 11.2 可獨立交付的工作包

| 包 | 工作 | 主要改動位置 | 完成證據 |
|---|---|---|---|
| P0 | 分段 timing、redaction、L1/L2 benchmark | ContextHub core/http；Hermes clients/mcp_server/scripts | baseline artifacts、失敗分類正確 |
| P1 | REST prefetch、HTTPX pool、activity 相容 | Hermes clients/runtime requirements；ContextHub activity | 一次 HTTP、TCP reuse、REST/MCP parity、A/B |
| P2 | standard/fact/exact_claim 與完整 claim check | ContextHub commands/items-repo/context schemas；Hermes tool schema | 40-case quality、ACL/conflict/overflow、latency |
| P3 | page cache、statement LRU、純計算 cache、ID-first | ContextHub config/db/items-repo | hit/miss equivalence、RSS plateau、query plan |
| P4 | maintenance mode、RAM/SSD runbook 演練 | ContextHub startup/health/compose；NAS 操作 | maintenance tests、隔離搬遷／回復演練 |
| P5 | 硬體到位後正式遷移 | 核准 target mount 與 gateway | 同版本前後對照、backup/restore/doctor/query |

P1 不依賴 P2–P5；P3 不依賴 P5。P4 必須先通過實驗環境再執行 P5。所有項目在各 repo 分別 commit，選擇性 stage，不把既有 onboarding／README 修改混入。

### 11.3 上線與回復

1. 記錄現行 image **registry digest**、revision、Compose checksum、schema、flags 與 benchmark。`docker inspect .Image` 是本機 image ID，不能拿它當 registry manifest digest。
2. 測試 → commit/push → CI publish immutable image；先部署 ContextHub 向後相容的 server changes，再部署 Hermes adapter。
3. ContextHub 僅在 gateway 回傳 exact `contexthub` registration 時部署；Hermes 重新確認其 allowlist ID，不用 checkout 名稱猜。
4. repository Compose → staging SCP → `sudo -n /usr/local/bin/deployment <id> validate` → deploy → status。驗證失敗修 repo 後重試，不直接改 active Compose。
5. live health version/commit、實際 registry digest、audit/retrieval、reindex、restore drill、doctor 均依專案驗收；另外執行 L2 benchmark 與 L3 實際 chat。只收到 HTTP 200 不算完成。
6. 每一軟體階段只開一組優化旗標；觀察 24 小時的日常 error/slow metadata，再開下一組。不由本文件建立排程或自動監控工作。
7. 無資料搬遷時可按依賴先回 Hermes flag/image，再回 ContextHub；任何 schema migration 必須先驗證舊 image 相容性。
8. 有資料搬遷時只能用第 8.6 節的回復規則；不要把 gateway Compose rollback 當成安全的資料回復。

回復觸發：任何資料洩漏／錯誤授權／audit fail-open 立即停用新路徑；相同 workload 的 P95 比 baseline 惡化 >20% 且連續兩個 100-sample block 重現、錯誤率 ≥1%、RSS 超預算或有 OOM，回復該階段設定。單一異常保留 evidence，不能自行丟棄樣本。

## 12. 取捨與後續再評估條件

- **REST vs 長期 MCP session：**選既有 REST 減少一次 request 與 protocol setup，不新增 session state；通用 MCP client 繼續可用。OAuth REST 不在本次範圍。
- **同步 vs async adapter：**現有 stdio 為同步串行；同步 HTTPX 改動較小。若工具 dispatcher 未來允許真正並行，再設計 per-request timing 與 cancellation，不預先增加 event loop bridge。
- **cache vs correctness：**page／statement／pure transform cache 沒有新的 authority，成本與失效簡單。完整答案 cache 留待更大流量與明確一致性設計。
- **多 instance／read replica：**現在每次 read 仍有 audit write，不可用增加 server replicas 迴避單 writer；只有量測顯示 throughput 不足時另做架構案。
- **ANN／外部 vector database：**既有 synthetic 100k gate 並非目前 1–3 秒等待的根因證據。只有 server retrieval 明確佔 P95 的主要部分、且 exact retrieval 無法達標時才再評估。
- **預熱：**不做每分鐘查詢保活；那會增加 audit/HDD 負擔。若有證據需要，可另設啟動後一次性、受權限約束的預熱，不能清 page cache 後刻意製造測試差距。
- **硬體價格／型號：**本文件給容量與相容性 gate，不提供未驗證價格或承諾現有 Intel SSD 可轉 volume。購買與破壞性儲存變更不包含在本次設計交付。

## 13. 實作入口與參考資料

以下 source links 以本文件位置為基準；future implementation 必須先核對 HEAD／live revision。

- [REST compile](../src/http/routes/context.ts)、[MCP compile](../src/mcp/server.ts)、[MCP transport](../src/mcp/http.ts)：入口與相容性。
- [Commands](../src/core/commands.ts)、[Items repository](../src/core/items-repo.ts)、[Context compiler](../src/core/context-compiler.ts)：共同授權、稽核、檢索與編譯。
- [Config](../src/config.ts)、[DB connection](../src/db/connection.ts)、[Audit repository](../src/core/audit-repo.ts)、[Client activity](../src/core/client-activity-repo.ts)：設定、持久性與活動。
- [NAS runbook](NAS-DEPLOY-RUNBOOK.md)、[Retrieval ADR](ADR-003-hybrid-memory-retrieval.md)：正式發布與搜尋品質限制。
- Hermes repo：`services/hermes_runtime/clients.py`、`services/hermes_runtime/mcp_server.py`、`tests/test_hermes_runtime.py`、`requirements-runtime.txt`。
- [Python urllib.request](https://docs.python.org/3/library/urllib.request.html)：目前預設 Connection: close；已另以正式容器 source 查驗。
- [HTTPX Client](https://www.python-httpx.org/advanced/clients/) 與 [timeouts](https://www.python-httpx.org/advanced/timeouts/)：connection pooling 與分階段 timeout 語意。
- [SQLite cache_size](https://www.sqlite.org/pragma.html#pragma_cache_size)、[WAL](https://www.sqlite.org/wal.html)、[backup](https://www.sqlite.org/backup.html)：快取、commit 與一致性備份。
- [Synology M.2 storage pool support](https://kb.synology.com/en-sg/DSM/tutorial/Which_models_support_M_2_SSD_storage_pool)、[DS723+ compatibility](https://www.synology.com/zh-tw/compatibility?category=m2_ssd_internal&model=DS723%2B&search_by=products)：執行前再次驗證機型、DSM 與 SSD 相容性。
