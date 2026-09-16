# Hermes → ContextHub onboarding

這份文件是目前 Hermes runtime adapter 的 onboarding 契約。它只涵蓋
AiSecretaryChloe `services/hermes_runtime/clients.py`／`mcp_server.py` 已提供的
Memory Provider；不要求修改 Hermes `SOUL.md`，也不使用舊的 `mcp_servers` 設定
方法。

## 目前契約

Hermes 個人連線使用一把只屬於 `personal` namespace 的 ContextHub credential：

| 項目 | 值／規則 |
| --- | --- |
| MCP URL（Hermes container 內） | `http://contexthub:8787/mcp/personal` |
| MCP URL（NAS host 唯讀檢查） | `http://127.0.0.1:8788/mcp/personal` |
| Hermes token file | `/opt/secrets/contexthub-personal-key` |
| token file 的 NAS 來源 | Hermes root-owned secrets directory 的唯讀 mount；目前 compose 對應 `/volume1/docker/hermes/secrets` |
| namespace | 由 credential 與 `/mcp/personal` server-side 驗證共同決定；request payload 不能選 namespace |
| transport | `memory_prefetch` production 可使用單請求 REST compile；其他 Memory tools 維持 stateless MCP，設為 `mcp` 可立即回復 |

Hermes adapter 的名稱與 ContextHub canonical MCP tool 的對應如下：

| Hermes adapter tool | ContextHub MCP tool | 讀寫語意 |
| --- | --- | --- |
| `memory_prefetch` | `compile_context`，固定傳 `target_agent=hermes` | 只讀；只回傳目前 ACL 可見、active、accepted 的 ephemeral package |
| `memory_search` | `search_context` | 只讀；候選預設排除，`include_candidates=true` 只供 agent 自己追蹤 |
| `memory_store_candidate` | `save_memory` | 寫入必須得到 top-level `trust_state=candidate`；不會自動採納 |
| `memory_propose_successor` | `propose_successor` | accepted 記憶的候選修正；review 前 predecessor 仍是 current |
| `memory_sync` | `get_changes` | 只取得 metadata-only change pointers；不可把完整內容當 local cache |

這條連線沿用 ContextHub 的授權、audit、idempotency 與 canonical commands。
對這個 `principal_kind=agent`、`agent-default` client，`write` scope 不授予
review、accept 或 revoke 權限；工具列舉成功也不等於寫入授權已驗證。
Accepted Memory 只能由 owner/reviewer 裁決；agent local memory 僅能是
`local_only`、`cache_pointer` 或 `shared_candidate`。

## Credential provisioning

Credential provisioning 是 owner-controlled 操作。ContextHub 負責 client identity、
namespace、scope、policy 與一次性 credential 發行；Hermes secret directory 的檔案
安裝與權限則由 NAS owner／既有 secret provisioning 流程負責。不要要求 agent 或
使用者把 enrollment code、`chk_` key、`Authorization` header 或任何 secret 貼到
聊天、Git、文件、shell history、URL 或 log。

若既有環境已啟用 Agent enrollment，可使用以下流程（本次不變更 feature flag）：

1. owner 在 ContextHub Control Center 的 Agents 頁建立 `hermes-personal`，設定
   `namespace=personal`、`principal_kind=agent`、`scopes=read,write`、
   `profile=agent-default`；只有確實需要 private items 時才把 sensitivity ceiling
   設成 `private`。
2. 確認 `AGENT_ENROLLMENT_ENABLED=true` 已由 owner 在受保護的 production
   environment 啟用後，產生 single-use enrollment code。code 只顯示一次，且不應
   出現在 shell history 或聊天。
3. 由受支援的 agent-side exchange 將 code 送至
   `POST /v1/agent-enrollment/exchange`。ContextHub 只在這次 exchange 回傳 raw key；
   重播不會再次回傳 secret。
4. owner 將 raw key 交給既有 NAS secret provisioning 流程，建立
   `/volume1/docker/hermes/secrets/contexthub-personal-key`，檔案權限使用 `0600`，檔案擁有者須讓 Hermes runtime 的執行身分可讀，
   再以 Hermes compose 已有的唯讀 mount 提供給 container。ContextHub repository、
   ContextHub `.env` 與本文件都不保存 key。

目前 Hermes runtime adapter 會直接讀 token file，沒有在 `clients.py` 內實作
enrollment exchange 或 secret-store 寫入。因此 ContextHub 可以發出 enrollment，
但不能宣稱已替 Hermes 完成 NAS secret handoff。若 production enrollment flag 未開，
owner 可使用既有 CLI legacy path 建立同樣 namespace-bound agent client，取得一次性
raw key 後仍交給上述 NAS secret provisioning 流程；不要因此把 key 寫入 ContextHub
`.env` 或 repository。

## 唯讀 preflight 與驗收

本 repository 提供 `scripts/hermes-mcp-preflight.sh`。它不建立 client、不寫
Memory、不修改 policy，也不把 token 印出；檢查內容是：

- URL 是沒有 credentials/query/fragment 的 `/mcp/personal` endpoint；
- token file 存在、是 owner-readable-only regular file，且只符合 ContextHub key 形狀；
- `/health` 可達；
- authenticated MCP `initialize` 與 `tools/list` 成功；
- canonical `compile_context` 可回傳 `target_agent=hermes` 且
  `constraints.accepted_only=true`。

檢查需要 Node.js 22；container 模式也要求 container 內有 Node.js 22。
以下是具既有 Docker 讀取權限之 operator 的唯讀檢查，不是 deployment gateway 指令；
若權限不足就停止，不改 sudoers 或另取 unrestricted sudo。
在 NAS host 上，若 key 只存在 Hermes container 內，可使用：

```bash
npm run hermes:preflight -- --container hermes-agent
```

此模式會在 container 內使用預設的
`http://contexthub:8787/mcp/personal`；若另有 owner-approved private endpoint，
必須明確指定 `--url`。在 credential file 對目前執行環境可讀時，也可以直接指定：

```bash
npm run hermes:preflight -- \
  --url http://127.0.0.1:8788/mcp/personal \
  --token-file /path/from/owner-secret-store/contexthub-personal-key
```

`HERMES MCP PREFLIGHT PASS` 只證明當下 endpoint、credential、MCP contract 與
accepted-only prefetch 可用。它不證明 Hermes product client 已載入 runtime adapter，
也不證明 candidate、successor、review、Telegram delivery 或 provider acceptance。

完成真實 Hermes onboarding 後，owner／operator 仍需從 Hermes container 收集：

1. `/api/health` 的 `contexthub_memory_provider.configured=true` 與 status；
2. Hermes 對應的 MCP tool discovery／reload 證據；
3. 一次 harmless `memory_prefetch` 與 `memory_search`，確認 shared reads 沒有候選；
4. 一次明確授權的 `memory_store_candidate`，確認回應的 top-level
   `trust_state=candidate`，以及 review 前 shared search 仍排除它；
5. owner review 後重新讀取 accepted item；若修正 accepted item，確認
   `memory_propose_successor` 在 review 前不改 current，review 後才 supersede；
6. `memory_sync` 只保存 `hub_item_id`、`revision`、`change_cursor`、`cached_at` 等
   pointer metadata，並在下次讀取重新套用 ACL、validity、revocation 與 successor。

沒有上述 Hermes product-client 證據時，ContextHub 的本機測試或 `/health` 只能標為
`implemented_local`／`live_verified` 的相應層級，不得標成 `provider_verified`。

## 目前 live evidence

2026-09-16 本次最後一次非互動唯讀核對：Hermes `/api/health` 為 HTTP 200，
`runtime.durableRuntime.integrations.contexthub_memory_provider` 仍為
`configured=false`、`status=unavailable`。NAS 非特權檔案可讀性檢查顯示預期
secret 檔案 absent-or-inaccessible；這不能區分不存在與權限不足。
因此尚未完成 Hermes 的 authenticated Memory round-trip；需透過既有受控流程
提供 runtime 可讀的 token file，之後執行 preflight 與真實 Hermes session 驗收。
`configured=true` 也只表示檔案設定存在，不代表 key 有效或讀寫授權已驗證。

## 本次本機驗證（2026-09-16）

- Node.js 22.19.0：`npm test` 20 files / 164 tests 通過，含 build/typecheck。
- `npm run e2e`：34 passed / 0 failed。
- 隔離暫存 DATA_DIR 建立 personal agent-default client，啟動真實 ContextHub HTTP
  server，以新腳本完成 initialize、tools/list、compile_context。
- 錯誤憑證、缺少憑證、權限過寬的檔案均正確拒絕；輸出不含 key。
- 暫存 server、測試 credential 與資料已清理；未變更 production client、policy 或 secret。

這是 `implemented_local`，不是 Hermes product-client `provider_verified`。

## 憑證接通後交給 Hermes 的 prompt

> 請檢查實際載入的 memory_prefetch、memory_search、memory_store_candidate、
> memory_propose_successor、memory_sync 工具，先執行唯讀 prefetch/search 驗證。
> 之後涉及我的過往偏好、決策、研究或專案背景時主動查 ContextHub。
> 新知識一律 candidate，accepted 記憶修正一律 candidate successor，
> 待我在 ContextHub 審核後才能用於共享記憶。不要自行採納。
> 工具不可用或認證失敗時回報具體狀態，不要聲稱已查詢或記住。
> 將以上操作政策保存到你實際會載入的持久設定，回報修改位置與生效方式。
> 本次不建立測試記憶，不顯示或索取任何密鑰。

相關規範：

- [Agent Memory Federation Protocol v1](AGENT-MEMORY-FEDERATION.md)
- [Agent 操作與記憶遷移指南](AGENT-GUIDE.md)
- [Control Center Runbook](CONTROL-CENTER-RUNBOOK.md)
- [NAS Deployment Runbook](NAS-DEPLOY-RUNBOOK.md)
