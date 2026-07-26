# ContextHub 使用者指南

> 這份文件是給 ContextHub 的使用者看的。你不需要理解 API、MCP、Docker
> 或資料庫；只要知道如何查看記憶、審核 AI 提案，以及安全地搬移舊記憶。

## 1. ContextHub 能幫你做什麼

ContextHub 把不同 AI 工具的長期記憶集中在同一個地方。例如，你在 Codex
確認過的偏好，可以在 Claude Code 或其他已連線的 AI 工具中繼續使用。

它不是完整對話備份，也不會自動相信 AI 寫入的每一句話：

- AI 新增的內容會先成為「待審核提案」。
- 只有你接受的內容，才會成為所有已授權 AI 可使用的正式記憶。
- 每筆記憶都保留來源、狀態與修改歷史。
- 個人與工作記憶分開管理，不會因為使用同一個平台就自動互通。

## 2. 開始前要準備什麼

你需要：

1. 一台已加入相同 Tailscale 帳號（tailnet）的裝置。
2. NAS 上正在運行的 ContextHub。
3. 屬於正確記憶空間的 **reviewer key**。

ContextHub 的網址格式是：

```text
http://<NAS_TAILSCALE_IP>:8788
```

常用入口：

| 用途 | 網址 |
|---|---|
| 查看正式記憶 | `http://<NAS_TAILSCALE_IP>:8788/explore` |
| 審核 AI 提案 | `http://<NAS_TAILSCALE_IP>:8788/review` |
| 確認服務正常 | `http://<NAS_TAILSCALE_IP>:8788/health` |

Reviewer key 相當於密碼。請保存在密碼管理器或系統鑰匙圈，不要放進聊天、
文件、截圖、Git repository 或 AI 的設定說明中。日常使用不需要
`ADMIN_TOKEN`。

## 3. 最常用的三個操作

### 查看目前有哪些記憶

1. 開啟 `/explore`。
2. 貼上你的 reviewer key，按下解鎖。
3. 使用搜尋、來源、類型或標籤篩選內容。
4. 點選一筆記憶，查看完整內容、來源與建立時間。

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
3. 網址使用 NAS 的 Tailscale IP 與 `8788` 連接埠。
4. `/health` 是否顯示 `"status":"ok"`。

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
