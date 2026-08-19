# ContextHub Future Backlog

> Owner-first、私有 NAS、12–18 個月規劃。這份文件是未來功能、平台、安全與維運工作的唯一排序來源；每張卡實作前仍須補上對應的 ADR、migration/rollback plan 與驗收證據。

## 基線與排序規則

截至 2026-08-19，本機 `main@e7c4c40` 已在 Node 22.19.0 通過 115 個測試與 34 個 E2E checks，`npm audit --omit=dev` 無漏洞。2,000 筆 retrieval benchmark 的 hybrid Recall@5/Success@1 為 0.833，p95 為 5.278 ms；ANN 不列為近期必要工作。NAS live 狀態必須另行驗證，不以本機測試代替。

- **P0（0–2 個月）**：資料安全、恢復能力、發布可信度與每日使用阻塞項。
- **P1（2–6 個月）**：Owner 治理、資料品質與第一波來源整合。
- **P2（6–12 個月）**：Agent protocol、事件、自動化與進階 Memory 能力。
- **P3（12–18 個月／條件式）**：高成本整合或只有在量測 gate 通過後才執行。
- Effort：S ≤3 天、M 1–2 週、L 3–6 週、XL 必須先拆分。
- Status：`proposed`、`ready`、`in_progress`、`blocked`、`done`、`deferred`。

所有完成項都必須維持：SQLite 是唯一權威、索引可重建、agent writes 先是 candidate、accepted Memory 以 successor 修正、REST/MCP 共用 commands、namespace/ACL/audit/idempotency fail-closed、無 secrets 或 production DB 進 repo。

## Ranked backlog

### P0 — 先讓每日使用與發布可信

1. **CHB-001｜CI、版本與發布證據單一化｜M｜ready**
   - 建立 Node 22 CI：`npm ci`、tests、E2E、production audit、benchmark regression、`git diff --check`、secret/generated DB 檢查。
   - 以 `package.json` 作為版本唯一來源，修正 MCP 仍回報舊版號的漂移；health/settings 顯示 build commit、schema 與 retrieval model，但不洩漏 secret。CI log 不得輸出完整 demo/enrollment/client key。

2. **CHB-002｜完整 Agent enrollment 與 credential lifecycle｜M｜ready**
   - Control Center 建立 Agent 後要單次顯示、複製、到期倒數與關閉即不可重取的 enrollment code；支援撤銷、重新配對與安全錯誤提示。
   - Agent 詳情顯示 namespace、有效權限、最近活動、credential version 與 enrollment 狀態；re-enroll、disable 需 fresh session 和 ID confirmation。測試 exchange、replay、expired、locked、CSRF、no-store、no-log。

3. **CHB-003｜維運 Doctor 與可信狀態面板｜M｜ready**
   - 新增唯讀 `cli doctor`，檢查 SQLite quick check、audit 可寫、migration、projection coverage、磁碟、最近備份、restore drill、idempotency GC 與版本一致性。
   - `/health` 只回傳無敏感資訊的 readiness；詳細狀態只在已認證 Control Center 顯示。每個失敗條件都要有非零 exit code 與修復提示。

4. **CHB-004｜可自動驗證的備份、還原與升級 gate｜M｜ready**
   - 備份附 schema/model/build/checksum manifest；每月在隔離目錄執行 restore → reindex → health → query → history 驗證。
   - migration 前自動 snapshot；失敗時優先回復 image，不誤還原舊 DB。演練不得碰 production DB，結果只留不含內容的維運紀錄。

5. **CHB-005｜Control Center 前端基礎、namespace 與 session 管理｜L｜proposed**
   - 維持 dependency-light、same-origin、無 CDN 的 vanilla ES modules；拆分目前內嵌 UI，建立共用元件與 Playwright browser tests。
   - 所有頁面提供 namespace selector；Settings 顯示 sessions、到期時間、撤銷其他 session 與 logout；修正 dashboard 樣本數誤當總數。覆蓋 keyboard/mobile/loading/error states。

6. **CHB-006｜Memory Explorer 與單筆 Review Workbench｜L｜proposed**
   - 加入 facets、日期、trust、source、sensitivity、entity、memory kind、validity、status 篩選及 cursor pagination。
   - 詳情顯示 provenance、版本、reviews、predecessor/successor、evidence、policy acceptance reason 與 curation suggestions；accepted Memory 只能以 successor 修正。

### P1 — 完成 Owner 治理與資料品質

7. **CHB-007｜安全批次審核與整理佇列｜M｜proposed**
   - 最多 20 筆；每筆保留 expected revision 與 idempotency key，回傳逐筆結果，不因一筆 stale 重做已成功項目。
   - 接受前顯示 namespace、sensitivity 與明確確認；依 duplicate/conflict/stale 分組；禁止自動接受。

8. **CHB-008｜Policy Editor、diff 與授權模擬器｜L｜proposed**
   - schema-driven 編輯 grants、create rules、state rules，顯示版本 diff、引用 client 與 allow/deny dry run。
   - Apply 需 control admin、linked `policy.manage` human client、fresh session；任何回復都建立新 append-only policy version。

9. **CHB-009｜Audit Explorer 與營運報告｜M｜proposed**
   - 提供 namespace、client、action、allow/deny、時間與 item metadata 篩選、分頁與受控匯出。
   - 顯示 denied spikes、inactive credentials、異常讀取量；不顯示 query、snippet 或 item content，並沿用 `audit.read` 邊界。

10. **CHB-010｜Context effectiveness analytics｜M｜proposed**
    - 將 outcome ledger 聚合為 helpful/harmful、action-changed、source/agent/item 使用率與低價值候選。
    - 不儲存 prompt、action、tool output 或 compiled package；analytics 只能提供整理建議，不能直接改 accepted Memory。

11. **CHB-011｜Owner-only retrieval eval 與簡繁查詢正規化｜M｜proposed**
    - 建立 Git-excluded private eval，涵蓋同義詞、人物、專案、successor、過期資料與 cross-namespace negative cases。
    - query-time 加簡繁轉換／別名 expansion，不複製 authoritative content；在 NAS 建立 100k items p95 gate，保留目前 2k regression baseline。

12. **CHB-012｜完整記憶遷移 Campaign Tracker｜L｜proposed**
    - 管理 source/domain coverage、accessible/inaccessible/unknown/pending/submitted/reviewed 狀態、每批最多 20 筆與 dedup/exclusion ledger。
    - 仍有 inaccessible、pending 或 submitted-for-review 時必須維持 `overall_migration_status=partial`；`complete` 需通過來源計數、review、新 session query、舊 store 保留期與可還原備份驗證。

13. **CHB-013｜Namespace 可攜式 Export/Import｜L｜proposed**
    - 提供帶 schema、checksum、provenance、版本資訊的 archive；它是匯出快照，不是第二個 system of record。
    - Import 預設建立 candidates；trusted import 僅限 NAS break-glass CLI，支援 dry run、collision report、mapping、rollback，不包含 credential/session/secret。

14. **CHB-014｜Connector SDK 與同步治理契約｜L｜proposed**
    - Connector 以獨立 worker/process 運行，使用 namespace-scoped service credential；OAuth/token 留在 worker secret store，不進 ContextHub DB。
    - 定義 minimized projection、`source_uri`、incremental cursor、delete/tombstone、retry/idempotency、rate-limit、freshness 與 sync-health；checkpoint 使用受 policy 控制的 operational state。

15. **CHB-015｜Google Calendar Connector｜L｜proposed**
    - 先同步 owner allowlist calendars 與決策所需欄位；description、attendees、會議內容預設不落地。personal/work 使用不同 worker、credential、policy。
    - 驗收增量更新、取消、時區、recurring event、token revoke、來源刪除可重跑且不重複。

16. **CHB-016｜GitHub Connector｜L｜proposed**
    - 只同步 allowlist repo 的 issue/PR/milestone/release/project summary 與 source URI；不保存 raw diff、secret、私密 comment 全文。
    - 驗收增量 checkpoint、rename/archive/delete、權限撤銷與 repository visibility 變更不會留下可讀舊資料。

### P2 — 擴大 Agent 與 Memory 能力

17. **CHB-017｜Metadata-only 通知｜M｜proposed**：待審、備份逾期、restore 失敗、projection degraded、credential 異常與 connector stale 可送 webhook／Telegram adapter；通知只含事件類別、count、severity 與 Control Center link。

18. **CHB-018｜MCP OAuth resource-server pilot｜L｜proposed**：只做 protected resource、issuer/JWKS/audience/resource/scope 驗證，授權伺服器採外部 OIDC/OAuth provider；完成 protected-resource metadata、`WWW-Authenticate` discovery、resource binding 與 Codex/Claude/Hermes compatibility matrix，通過前保留 enrollment/legacy fallback。[MCP authorization specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)

19. **CHB-019｜授權後 Change Feed／Webhook｜L｜proposed**：commands 成功提交後產生 metadata-only cursor feed；內容仍需原 credential 讀取，支援 retry、backpressure、dead-letter metadata 與 per-namespace subscription。

20. **CHB-020｜Outcome-aware consolidation 與 re-verification｜L｜proposed**：以 similarity、successor、validity、freshness、outcome 找 merge/reverify/supersede/archive 候選；結果只能進 reviewer queue。

21. **CHB-021｜本地 Neural Embedding｜L｜proposed / gated**：private eval 的 synonym/cross-language Recall@5 至少提升 5 個百分點、整體不退步超過 1 點、100k p95 ≤250 ms，才導入 on-device model；切換前 snapshot、切換後 reindex、可退回 feature hash。

22. **CHB-022｜Canonical Entity Graph 與 bounded traversal｜XL｜proposed**：canonical node/alias/edge 為可重建 projection；traversal 有深度、節點數、時間上限，且每一步先套 namespace/trust/source/evidence ACL/sensitivity/validity。

23. **CHB-023｜Insight-as-evidence closure｜L｜proposed**：支援 accepted insight 作 evidence，以 recursive closure 檢查可見性與 sensitivity；cycle、最大深度與上游撤銷需觸發重新審核。

24. **CHB-024｜Ephemeral Runtime-input Adapter｜M｜proposed**：可把 caller 的 system constraints/tool results 納入同一次 budget，但只存在記憶體並標示為 untrusted runtime data；不儲存 input、rendered context 或 tool output。

25. **CHB-025｜Tamper-evident Audit Chain｜L｜proposed**：audit row 加 hash chain，定期把 root hash 與 backup manifest 寫到 owner 控制的離地位置；只宣稱可偵測鏈斷裂，不宣稱能防止 NAS/DB admin 重建資料。

### P3 — 只在量測 gate 通過後執行

26. **CHB-026｜Gmail＋Drive Connector｜XL｜proposed / gated**：只送摘要、action/decision projection 與 `source_uri`；raw mail、attachment、document body、PII 不持久化。work 預設關閉，須先通過資料最小化與抽樣稽核。

27. **CHB-027｜Passkey／Local OIDC 備援登入｜L｜proposed / gated**：只有 Tailscale identity 不足以支撐實際可用性才導入；維持短 session、CSRF、revocation、namespace link，不允許 permanent browser token。

28. **CHB-028｜ANN／vec0 partition｜L｜proposed / gated**：只有真實 100k corpus exact vector p95 超過 250 ms 才啟動 ADR；需證明 Recall@5 損失低於 2 個百分點、ACL 仍在候選產生前套用、restore/reindex 可完全重建。`sqlite-vec` 目前仍是 pre-v1，ANN 版本亦屬 alpha/experimental，不能提前成為必要依賴。[sqlite-vec project](https://github.com/asg017/sqlite-vec) · [releases](https://github.com/asg017/sqlite-vec/releases)

## Public interfaces to add

- Control API：credential lifecycle、batch review、policy validation/simulation、maintenance、effectiveness、migration campaign、connector status。
- CLI：`doctor`、`restore-drill`、namespace `export/import`；所有 mutation 維持 idempotency 與 audit。
- Connector SDK、change feed、graph、analytics 都是投影或運行層；SQLite domain rows 仍是唯一 Memory 權威。
- OAuth 只增加標準 metadata/token validation；`ADMIN_TOKEN` 永遠不進瀏覽器，personal/work credential 永遠分開。

## Definition of Done

- 一般變更：Node 22 執行 `npm test`；HTTP、MCP、DB、migration、backup、policy、deployment 變更再執行 `npm run e2e`。
- UI：browser tests 覆蓋登入、CSRF、session revoke、namespace switch、one-time secret、review conflict 與無權 404。
- Connector：fixture contract、incremental sync、retry、delete、OAuth revoke、資料最小化、personal/work isolation。
- Retrieval：公開 eval、owner-only private eval、2k regression；scale/embedding 變更再跑 NAS 100k gate。
- Migration：pre-migration snapshot、fresh-dir restore、reindex、history/audit/idempotency 驗證。
- 完成項同步文件、無 secret/generated DB、可回復；部署型工作附 live health、版本、workflow 與 smoke-test 證據。

## Explicitly deferred

本規劃維持單 owner、單 NAS、單 active writer、Tailscale-private；HA、多副本、通用多租戶、公網 SaaS、跨 NAS replication、完整 conversation archive 與公網 hardening 不列入 12–18 個月承諾。排序只能因 production incident、資料完整性風險或前置依賴變更而調整，並須記錄原因與日期。
