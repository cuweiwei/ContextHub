# ContextHub Control Center UX

> 2026-08-20 功能重新盤點與管理介面資訊架構。此文件描述管理者如何操作既有能力，不改變 SQLite authority、namespace、trust、audit 或 credential 邊界。

## 設計目標

Control Center 不再依 REST route 或資料表切頁，而是依管理者要完成的工作組織：

1. 先知道「現在有什麼需要我處理」。
2. 再完成搜尋、審核、Agent 管理、政策治理與維運。
3. 高風險操作永遠帶著 namespace、影響範圍、確認與不可變語意。
4. 進階資料仍可查看，但預設畫面先顯示結論與下一步，不直接傾倒 JSON。

## 功能盤點與 UI 對應

| Domain 能力 | 管理者需要回答的問題 | Control Center 畫面 |
|---|---|---|
| Source / Memory / Task State | 目前有哪些資訊？來自哪裡？是否有效？ | 記憶庫：hybrid search、facets、有效期、敏感度、詳細工作區 |
| Candidate / review / batch review | 哪些 AI 提案值得成為正式記憶？ | 審核佇列：一般、衝突／successor、重複、過期分組；單筆與 1–20 筆批次裁決 |
| Immutable accepted Memory / successor | 正式記憶錯了或過時時如何修正？ | 記憶詳細工作區：版本、裁決、前後繼與 successor 提案 |
| Provenance / ACL / sensitivity | 這筆資料誰說的、誰能讀？ | 每筆記憶的治理與來源區；列表保留 trust、source、sensitivity |
| Agent / service principals | 哪些 Agent、App 或 Connector 已連線？ | 連線：狀態、最近活動、認證方式、credential version、敏感度與來源上限 |
| Enrollment lifecycle | 新 Agent 如何安全取得 credential？ | 建立連線與詳細工作區：single-use enrollment、到期倒數、re-enroll、停用／啟用 |
| Namespace separation | personal / work 是否真的分開？ | 全域 namespace selector 與命名空間頁；說明 linked human clients 與 work 資料規則 |
| Policy versions / validate / simulate / rollback | 政策改動會允許或拒絕什麼？ | 治理政策：摘要、進階 JSON、草稿驗證、單案例模擬、optimistic apply、版本回復 |
| Audit fail-closed | 誰何時讀寫、哪些操作被拒絕？ | 稽核軌跡：namespace、client、action、outcome filters；只顯示 metadata |
| Context outcome feedback | 記憶是否真的改善 Agent 行動？ | 記憶效益：helpful、action changed、來源／item 使用與 low-value signal |
| Health / projections / backup / restore / audit chain | NAS 與資料保護現在可信嗎？ | 安全與維運：Doctor checks、runtime/schema/model、功能旗標 |
| Web sessions | 哪些裝置仍有管理 session？ | 安全與維運：idle/absolute expiry、其他 session 撤銷、目前裝置登出 |
| MCP tools / compiler / changes / graph / connector / migration APIs | Agent 與 worker 有哪些資料平面能力？ | 不把 21 個 MCP tool 做成人類按鈕；管理 UI 顯示它們產生的記憶、活動、政策、稽核與效益結果 |

## 資訊架構

### 工作台

- **總覽**：待審數、Source／Memory 分布、Agent 活動、Doctor 與低價值訊號。
- **記憶庫**：受 ACL 保護的完整瀏覽、搜尋、詳情與 successor 工作流。
- **審核佇列**：把 candidate 裁決從資料表操作提升成每日 inbox。

### 管理

- **連線**：Agent、service、connector principal 與 credential lifecycle。
- **命名空間**：顯示 server-side boundary 與 Web principal 的 linked human clients。
- **治理政策**：policy grants、create rules、state rules 與版本生命週期。
- **稽核軌跡**：操作證據，不顯示原始 query 或 item 內容。
- **記憶效益**：outcome feedback 與 reviewer-facing quality signal。

### 系統

- **安全與維運**：Doctor、feature flags、sessions 與三個認證平面說明。

## 主要工作流

### 每日審核

`總覽待辦 → 審核佇列分類 → 閱讀內容／來源／敏感度 → 單筆或批次 accept/reject → 回到總覽`

私密提案的 batch review 必須額外確認私密筆數；revision conflict 由 server 拒絕，使用者重新載入後再裁決。

### 修正正式記憶

`記憶庫搜尋 → 詳細工作區確認歷史與 provenance → 提出 successor → 審核佇列接受 → 舊項原子 superseded`

UI 不提供直接覆寫 accepted Memory 的捷徑。

### 建立 Agent 或來源連線

`連線 → 選 namespace / principal kind / profile / sensitivity ceiling → 建立 → 一次性顯示 enrollment code → 查看首次活動與有效權限`

Raw key、`ADMIN_TOKEN` 與 OAuth secret 不在 UI 顯示或保存；相同 Agent 跨 personal / work 必須建立兩個 client。

### 修改政策

`閱讀摘要 → 編輯 JSON 草稿 → validate → simulate 具體案例 → apply 新版本 → 稽核與版本歷史`

Apply 使用 `base_version` 防止覆蓋其他管理者的更新；rollback 也是建立新版本，不改寫歷史。

## 互動與視覺原則

- 桌面使用固定側欄；小於 900px 改為可關閉的 overlay navigation。
- 顏色只作第二訊號；狀態同時以文字、badge 與 icon 表達。
- 表格保留給可比較的 metadata；需要判斷內容時使用 review card 或右側詳細工作區。
- 所有資料字串使用 DOM `textContent` 建構，不插入 server 回傳 HTML。
- 互動元件有 label、keyboard focus、dialog title、live status 與 reduced-motion 支援。
- CSP 維持 `default-src 'none'`，只載入 same-origin CSS／ES modules。

## 刻意不放進 UI 的能力

- `ADMIN_TOKEN`、raw `chk_` key、OAuth secret、signing secret。
- 直接 SQL、purge、production restore、audit-chain extend／anchor 等 break-glass 操作。
- 把 21 個 MCP tools 做成任意呼叫 playground；這些是 Agent data plane，不是管理者工作流。
- 自動合併、刪除、接受或改寫 Memory。Quality 與 curation 只提供建議。
- 尚未 provider/live verified 的 Connector、OAuth 與 production deployment 狀態，不以綠色 UI 冒充已完成。

這些操作繼續留在 CLI、runbook 或未來經 ADR 審核的專用流程中。
