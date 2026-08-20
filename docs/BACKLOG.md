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

- 目前無未完成項目；CHB-001～CHB-006 已完成，歷史證據移至下方 archived evidence。

### P1 — 完成 Owner 治理與資料品質

- 目前無未完成項目；CHB-007～CHB-016 已完成，歷史證據移至下方 archived evidence。

### P2 — 擴大 Agent 與 Memory 能力

- 目前無未完成項目；CHB-017、CHB-019、CHB-020、CHB-022～CHB-025 已完成，歷史證據移至下方 archived evidence。

### P3 — 只在量測 gate 通過後執行

1. **CHB-018｜MCP OAuth resource-server pilot｜L｜ready**：只做 protected resource、issuer/JWKS/audience/resource/scope 驗證，授權伺服器採外部 OIDC/OAuth provider；已完成 protected-resource metadata、`WWW-Authenticate` discovery 與 resource binding，待真實 Codex/Claude/Hermes smoke 後才改為 `done`；通過前保留 enrollment/legacy fallback。[MCP authorization specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)

2. **CHB-021｜本地 Neural Embedding｜L｜deferred**：private eval 的 synonym/cross-language Recall@5 至少提升 5 個百分點、整體不退步超過 1 點、100k p95 ≤250 ms，才導入 on-device model；切換前 snapshot、切換後 reindex、可退回 feature hash。

3. **CHB-026｜Gmail＋Drive Connector｜XL｜proposed / gated**：只送摘要、action/decision projection 與 `source_uri`；raw mail、attachment、document body、PII 不持久化。work 預設關閉，須先通過資料最小化與抽樣稽核。

4. **CHB-027｜Passkey／Local OIDC 備援登入｜L｜proposed / gated**：只有 Tailscale identity 不足以支撐實際可用性才導入；維持短 session、CSRF、revocation、namespace link，不允許 permanent browser token。

5. **CHB-028｜ANN／vec0 partition｜L｜proposed / gated**：只有真實 100k corpus exact vector p95 超過 250 ms 才啟動 ADR；需證明 Recall@5 損失低於 2 個百分點、ACL 仍在候選產生前套用、restore/reindex 可完全重建。`sqlite-vec` 目前仍是 pre-v1，ANN 版本亦屬 alpha/experimental，不能提前成為必要依賴。[sqlite-vec project](https://github.com/asg017/sqlite-vec) · [releases](https://github.com/asg017/sqlite-vec/releases)

### Archived implementation evidence (completed P0-P2, local/no provider deployment)

- P0 branch：`codex/p0-backlog`；ticket-scoped commits `c57ae75`、`83706cc`、`4e3d939`、`a746e69`、`ecbdba6`、`ef38482`；當時 local checks 為 115 tests、34 E2E、browser smoke pass、retrieval 2,000-item hybrid Recall@5/Success@1 `0.833`、p95 `5.49 ms`、audit 0 vulnerabilities、hygiene/diff pass。
- P1/P2 implementation commit：`7d697bd`；schema migrations v10–v14 為 additive，包含 migration-campaign、portability、connector/change-feed、OAuth binding、consolidation、graph 與 audit-chain projections；rollback 維持 image-first，trusted import rollback 使用 recorded snapshot。
- Latest local validation：118/118 unit tests、34/34 E2E checks、Playwright browser smoke pass、hygiene pass、`git diff --check`、`npm audit --omit=dev` 0 vulnerabilities。
- External OAuth、Google Calendar、GitHub、Telegram 與 NAS smoke tests intentionally not run；CHB-018 維持 `ready`，CHB-021 維持 `deferred`。

## Archived public interfaces (completed P0-P2)

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
