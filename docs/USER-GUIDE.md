# ContextHub 使用者指南

> 這份文件是給 ContextHub 的使用者看的。你不需要理解 API、MCP、Docker
> 或資料庫；只要知道如何查看記憶、審核 AI 提案，以及安全地搬移舊記憶。

## 1. ContextHub 能幫你做什麼

ContextHub 把不同 AI 工具需要的來源摘要與長期記憶放在同一個、由你控制的地方。例如，你在 Codex 確認過的偏好，可以在 Claude Code 或其他已連線的 AI 工具中繼續使用；每個 AI 也可以依眼前任務取得一份短暫、限量且權限過濾過的 Context，不必把所有資料一次塞給模型。

長期 Memory 與短暫 Context 不一樣：Memory 是值得跨對話保留的資訊；Context 是某次任務實際提供給 AI 的組合，任務結束後不會被整包另存成記憶。

它不是完整對話備份，也不會自動相信 AI 寫入的每一句話：

- AI 新增的內容會先成為「待審核提案」。
- 只有你接受的內容，才會成為所有已授權 AI 可使用的正式記憶。
- 每筆記憶都保留來源、狀態與修改歷史。
- 個人與工作記憶分開管理，不會因為使用同一個平台就自動互通。

### AI 自己的記憶跟 ContextHub 有什麼關係？

Codex、Claude、Hermes 可能各自有內建記憶。這些 local memory 可以保存某個工具或 workspace 專用的操作習慣，也可以暫存「ContextHub 某筆記憶已讀到哪個版本」；但它不是另一套跨 AI 的正式事實庫。

可以把關係理解成：

- 來源 app 管原始事實，例如 Calendar 管行程、GitHub 管 repository 狀態。
- ContextHub 管經你接受、可以跨 AI 共用的長期記憶與裁決歷史。
- 每個 AI 的 local memory 只管局部使用方式、指向 ContextHub 的 cache pointer，或尚待送審的提案。

Local cache 不應複製整份長期記憶，只記 item id、revision、change cursor 與 cache 時間。這樣記憶被撤銷、取代或權限改變時，AI 重新讀取 ContextHub 就會取得目前狀態，不會繼續使用舊副本。

若 ContextHub 發現同一個「應該只有一個目前答案」的事實有兩筆已接受版本，會把兩筆都暫時排除並告訴 AI 有 conflict。AI 不可自己選較新的一筆；它應查來源與歷史，遵照你對眼前任務的明確指示，再提出 successor 讓你審核。完整技術規則見 [Agent Memory Federation Protocol v1](AGENT-MEMORY-FEDERATION.md)。

### AI 與 ContextHub 實際怎麼合作？

一次正常的合作循環是：

1. 你交代任務後，AI 先向 ContextHub 取得這次真正需要、且它有權讀取的 context。
2. ContextHub 只提供目前有效的 accepted Memory，並附來源與版本；有未裁決衝突就明確列出，不替你猜答案。
3. AI 依你的當前指示完成本次工作。你的這次指示不會被 AI 自動改成永久記憶。
4. AI 若發現值得跨對話保存的新資訊，只能建立待審核提案；若舊記憶已過時，則提出 successor。
5. 你在 review 流程接受、拒絕或撤銷後，ContextHub 保存裁決歷史；Codex、Claude、Hermes 下次讀取時看到同一結果。

簡單說：**AI 負責讀取、推理與提案；ContextHub 負責權限、版本、共享與裁決紀錄；你負責決定什麼能成為長期共用記憶。** Personal 與 work 仍是兩個獨立範圍，不會因為同一個 AI 同時使用兩者就自動混合。

## 2. 開始前要準備什麼

你需要：

1. 一台已加入相同 Tailscale 帳號（tailnet）的裝置。
2. NAS 上正在運行的 ContextHub。
3. 如果使用 legacy `/explore`、`/review`，需要屬於正確記憶空間的 **reviewer key**；
   使用 Control Center 則由 Tailscale identity 登入，不需貼 key。

ContextHub 的 data plane 網址格式是：

```text
http://<NAS_TAILSCALE_IP>:8788
```

如果已啟用 Control Center，管理頁使用獨立的 Tailscale HTTPS 入口：

```text
https://<NAS_TAILSCALE_NAME>:8443/dashboard
```

常用入口：

| 用途 | 網址 |
|---|---|
| 查看正式 Source／Memory | `http://<NAS_TAILSCALE_IP>:8788/explore` |
| 審核 AI 提案 | `http://<NAS_TAILSCALE_IP>:8788/review` |
| 確認服務正常 | `http://<NAS_TAILSCALE_IP>:8788/health` |
| Control Center 管理頁 | `https://<NAS_TAILSCALE_NAME>:8443/dashboard` |

Reviewer key 相當於密碼。請保存在密碼管理器或系統鑰匙圈，不要放進聊天、
文件、截圖、Git repository 或 AI 的設定說明中。日常使用不需要
`ADMIN_TOKEN`。

### Control Center 登入

若管理者已啟用 Control Center，請從 Tailscale DNS 名稱的 HTTPS 入口開啟
`https://<NAS_TAILSCALE_NAME>:8443/dashboard`。不要把 IP 直接放進 HTTPS 網址；登入身分由
Tailscale identity headers 辨識，不需要貼 reviewer key；session 是短期 HttpOnly cookie，可由管理者撤銷。
Control admin 只代表能管理 Agent／設定，不代表能讀取任何 namespace；要查看或審核 Memory，必須另外
link 對應 namespace 的 human reviewer client。

Agents 頁面可建立單次 enrollment。code 只在建立時顯示一次，交給受支援的 agent-side helper 交換；不要把 code 或交換後的 `chk_` key 貼進聊天、Git、截圖或網址。若 client 不支援 enrollment，暫時使用既有 legacy key，並在完成遷移前保持 `LEGACY_API_KEYS_ENABLED=true`。

## 3. 最常用的三個操作

### 查看目前有哪些 Source 與 Memory

1. 開啟 `/explore`。
2. 貼上你的 reviewer key，按下解鎖。
3. 使用搜尋、來源、類型或標籤篩選內容。
4. 點選一筆資料，查看它是 Source projection 或 Memory，以及完整內容、來源、類型、有效期與建立時間。

`/explore` 只顯示已接受的正式記憶。剛由 AI 提交、尚未審核的內容不會出現在這裡。

### 審核 AI 提出的新記憶

1. 開啟 `/review`。
2. 貼上 reviewer key，開啟待審核清單。
3. 點選一筆提案，閱讀內容、來源與歷史。
4. 選擇：
   - **接受（Accept）**：內容正確，而且值得跨對話、跨 AI 工具長期保存。
   - **拒絕（Reject）**：內容錯誤、過度暫時、重複，或不應成為長期記憶。
5. 寫下簡短原因，方便原 AI 了解你的決定。

審核時可以用三個問題判斷：

- 三個月後，這項資訊仍然有用嗎？
- 另一個 AI 工具知道它，會讓服務更一致嗎？
- 內容是否不含密碼、token、私人原文或不必要的敏感資料？

如果其中任何一項答案是否定的，就應拒絕或要求 AI 重新整理。

### 請 AI 記住一件事

直接用自然語言告訴已連上 ContextHub 的 AI，例如：

```text
請把「我偏好先看風險與回復方式，再執行系統變更」存成長期記憶。
```

AI 應先搜尋是否已有相同內容，再提交一筆 candidate。你仍需到 `/review`
接受它，才會成為正式記憶。

## 4. 第一次搬移既有 AI 記憶

不要把整個記憶資料夾直接上傳。舊記憶可能包含過期資訊、工具輸出、完整對話或
secret，應先由原本的 AI 盤點、整理，再分批提交。

### 建議流程

```text
請原 AI 唯讀盤點
→ AI 排除 secret、暫時資訊與重複內容
→ 每批提交不超過 20 筆
→ 你在 /review 逐筆接受或拒絕
→ 從 /explore 抽樣確認
→ 下一批
→ 舊記憶保留一段時間後再決定是否清理
```

### 可直接交給舊 AI 的指令

請把 [AGENT-GUIDE.md](AGENT-GUIDE.md) 交給原本的 AI agent，然後對它說：

```text
請依照 AGENT-GUIDE.md 的遷移規則，把你目前可讀取的長期記憶遷移到
ContextHub。先做唯讀盤點，不要修改或刪除舊記憶；每批最多提交 20 筆
candidate，完成一批後停下來，等我在 /review 審核。
```

每完成一批：

1. 確認 AI 回報的提案數量與主題合理。
2. 到 `/review` 逐筆審核。
3. 到 `/explore` 搜尋剛接受的幾個主題。
4. 開一個新的 AI 對話，測試它能否從 ContextHub 找到這些記憶。
5. 確認無誤後再進行下一批。

在所有批次完成並經過至少一輪實際使用與備份前，不要刪除舊 AI 的記憶。

## 5. 如何修正過時或錯誤的記憶

正式記憶不應直接被偷偷覆蓋。請告訴 AI 哪一項內容已改變，例如：

```text
ContextHub 裡關於 NAS 位址的記憶已過時，請先找出原記憶，再提出新的
successor，內容改為目前確認的設定。
```

新的內容仍會進入 `/review`。只有在你接受 successor 後，舊記憶才會被標示為
已取代，新內容才成為目前版本。

如果某筆內容包含不該保存的敏感資訊，請不要只建立修正版；應立即請管理者
撤銷該記憶，並輪替任何可能外洩的密碼或 token。

## 6. 個人與工作記憶

ContextHub 使用不同的 namespace 隔離資料：

- `personal`：個人偏好、生活脈絡、個人專案與一般待辦。
- `work`：只保存整理後的工作摘要、決議、行動項目與工作偏好。

工作空間不應保存：

- Email、會議或聊天逐字稿原文
- 客戶資料與不必要的個人資料
- 未公開財務資訊
- 機密技術細節
- 密碼、token 或其他 secret

同一個 AI 若同時需要個人與工作記憶，必須使用兩個分開的連線與 key。

## 7. 安全使用原則

- 只透過 Tailscale 存取 ContextHub，不需要開放公網連接埠。
- 不要把 reviewer key 或 `ADMIN_TOKEN` 貼給 AI。
- 不要把 key 寫進 `AGENTS.md`、`CLAUDE.md`、README 或 Git。
- 使用完 `/explore` 或 `/review` 後關閉頁面；key 不會寫入瀏覽器
  `localStorage`，重新開啟時需要再次輸入。
- 不要把完整聊天記錄、工具 log 或原始工作文件當作「記憶」保存。
- AI 的 candidate 不是事實；只有 accepted 內容才是正式共享記憶。

## 8. 常見問題

### 網頁打不開

依序確認：

1. 裝置已連上 Tailscale。
2. NAS 在 Tailscale 中顯示上線。
3. `/explore`、`/review` 或 MCP data plane 使用 NAS 的 Tailscale IP 與 `8788` 連接埠。
4. `/dashboard` 使用 NAS 的 Tailscale DNS 名稱與 HTTPS `8443` 連接埠。
5. `/health` 是否顯示 `"status":"ok"`。

不需要改用 NAS 公網 IP，也不要為此設定路由器 port forwarding 或 DMZ。

### `/explore` 是空的

可能原因：

- 目前只有 candidate，尚未在 `/review` 接受。
- 使用了錯誤 namespace 的 key。
- AI 還沒有成功提交記憶。
- 該 key 沒有權限讀取該敏感度的內容。

先查看 `/review`，再請 AI 使用 `list_context_sources` 與
`search_context` 檢查連線。

### Key 無法使用

不要嘗試使用 `ADMIN_TOKEN` 代替。請管理者確認 reviewer client 是否啟用、
是否屬於正確 namespace；若 key 可能外洩，應直接輪替。

### 接受後，另一個 AI 還是找不到

確認該 AI：

1. 已連到同一個 ContextHub。
2. 使用正確 namespace 的 credential。
3. 能呼叫 `list_context_sources`。
4. 搜尋的是 accepted 記憶，而不是只查自己的 candidates。

### AI 說 ContextHub 有記憶衝突

這代表同一個 single-winner claim 有不只一筆 active accepted 記憶；系統刻意沒有替你猜答案。請 AI 顯示 `conflicts[]` 的 claim key 與 item ids，查閱各自 history/source，再告訴 AI 本次任務該採用哪個資訊。若要永久修正，請讓 AI 提出 successor，最後仍由你在 review 流程接受或拒絕。

## 9. 備份與復原

ContextHub 應定期建立一致性資料庫快照，並由 NAS 備份系統保存。不要在服務運行時
只複製單一 SQLite `.db` 檔案，因為仍可能有資料留在 WAL 中。

一般使用者不需要自行操作資料庫。若需要復原，交由管理者按照 repository 的
備份與還原流程執行，復原後再確認：

- `/health` 正常。
- `/explore` 可以找到原有記憶。
- AI 可以透過 ContextHub 搜尋相同內容。

## 10. 文件怎麼分工

| 文件 | 適合誰 | 內容 |
|---|---|---|
| [USER-GUIDE.md](USER-GUIDE.md) | 一般使用者 | 查看、審核、遷移與日常安全使用 |
| [AGENT-GUIDE.md](AGENT-GUIDE.md) | AI agent | MCP 操作、信任規則與記憶遷移程序 |
| [CODEX.md](CODEX.md) | Codex 設定者 | Codex credential 隔離、設定與驗證 |
| [DESIGN.md](DESIGN.md) | 開發者／管理者 | 系統設計、資料模型與安全邊界 |
