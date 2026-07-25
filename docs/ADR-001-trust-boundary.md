# ADR-001: ContextHub v4 信任邊界與資料治理

- 狀態:Accepted(2026-07-25,owner: Tim)
- 範圍:ContextHub 作為跨 AI 記憶權威平台(system of record)的安全邊界、work 資料治理、保留與 DR 承諾。

## 定位

> 單節點、隱私優先、具 namespace 隔離、信任升格與可追溯生命週期的跨 AI 記憶權威平台,部署於私人 NAS。

- SQLite 是**唯一權威儲存**;FTS 索引只是可完全重建的 projection。
- 單一 active instance、單一 writer(啟動時以 exclusive lock 強制)。
- namespace 是 **server-side security boundary**:一把 API key 綁定一個 namespace,由 server 裁決、caller 不可偽造。
- REST 與 MCP 是同一 domain model 的兩個介面,共用同一套授權與稽核。
- Agent 產生的內容**不因寫入成功而自動成為共享事實**(trust_state=candidate,升格需審核或明確政策)。
- 衝突模型:單一 winner 的 successor/supersession;不宣稱支援通用衝突型態。
- 未經 owner 明確同意:不建立替代權威儲存、不遷移、不切換;持久化/索引/處理**不依賴公有雲**。

## 威脅模型

**防護對象(in scope)**:
1. 被 prompt injection 污染的 agent(memory poisoning、越權讀取、冒充可信 producer)
2. 拿錯或外洩的 client API key(namespace 與 capability 限縮爆炸半徑)
3. Policy 誤設(fail-closed:缺 policy、未知 schema、驗證失敗一律拒絕)
4. 程式 bug(單點強制:所有讀取過 `applyFilters`、所有 mutation 過 domain commands)

**非目標(out of scope,誠實聲明)**:
- NAS host 已遭完整入侵
- NAS/DB administrator 惡意直接修改 SQLite(audit/versions 是 application-level append-only,非 tamper-proof)
- HA、多副本一致性、administrator-proof audit

## Work 資料治理(Trend Micro)

- **只允許抽取後的摘要級記憶**:task、行動項目、決議摘要、個人工作偏好。
- **禁止存入**:email/Teams/會議逐字稿**原文**、客戶資料、個資(PII)、未公開財務數字、機密專案技術細節、任何標示 Confidential 以上的內容。
- work namespace 中 agent 寫入**一律 candidate**,無 policy-accepted producer;升格僅限 human review(work 專屬 reviewer 憑證)。
- work policy 不可引用 personal client(驗證層強制),personal 亦然。
- 稽核:work namespace 所有讀寫(含讀取摘要列)獨立可查。

## 保留與刪除語意

| 資料 | 保留 |
|---|---|
| context_items(soft delete) | 永久;錯誤資料 soft delete 後從一切查詢消失 |
| item_versions / item_reviews / audit_log | **永久 append-only**(個人規模可行;程式無更新/刪除路徑) |
| idempotency_records | 90 天 TTL(`idempotency-gc`,NAS 排程) |
| 真正刪除(purge) | admin 專用指令:硬刪 item+versions+FTS,audit 留 metadata 列;既有備份依快照輪替自然到期 |

## 備份、DR 與一致性承諾

- **RPO ≤ 24h**(每日 `backup` = `VACUUM INTO` 一致性快照);單機 crash 依 WAL + `synchronous=FULL` 保到最後一筆已 ack commit。
- **RTO 分鐘級**:`scripts/restore.sh`(stop → 還原快照 → start → **必跑 reindex** → health)。
- **每月 restore drill**:拿最新快照實際還原到隔離目錄,驗證 health + 查詢 + 版本歷史。
- 離地備份:Hyper Backup 指向快照目錄並啟用其**內建 client-side 加密**(金鑰由 owner 持有);本地快照不另行 DIY 加密(NAS admin 在信任邊界內)。
- 一致性承諾(驗收標準):單 active writer 之下,任一介面收到寫入成功後,其他具權限工具其後開始的讀取(REST 或 MCP)必得該版本或更新的已提交版本。不承諾 HA 或跨副本語意。
- Migration 前自動產生 pre-migration 快照;restore 是 rollback 手段(不假設 schema 可 downgrade)。

## 稽核

- 每次讀取與 mutation 都留稽核列(namespace、client、action、筆數/deny 原因),**不記**原始 query 全文、item 內容、snippet。
- **Fail-closed**:稽核寫入失敗 → 讀取回 503、mutation 隨 transaction 回滾;health 顯示 degraded 與磁碟剩餘空間 → 需搭配 NAS 磁碟監控。

## Secret 管理

- `ADMIN_TOKEN` 只存在 NAS `.env`;曾出現於 repo/訊息即視同外洩、立即輪替(2026-07-25 事件:token 曾寫入未 commit 的 README,已移除;未進 git history/remote;**owner 應於 NAS 輪替一次**)。
- 日常審核不用 ADMIN_TOKEN:各 namespace 發 human principal 的 reviewer key(memory.review capability)。
- client key 只存 sha256;rotate-key 保留 client 身分與稽核連續性。
