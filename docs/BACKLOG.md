# ContextHub Future Backlog

> Owner-first、私有 NAS、12–18 個月規劃。這份文件是未來功能、平台、安全與維運工作的唯一排序來源；每張卡實作前仍須補上對應的 ADR、migration/rollback plan 與驗收證據。

## Evidence model

截至 2026-08-20，`0.9.0@4c3a09a35348cc319316226a1c0691bf1d7cfad5` 是最新已驗證 release snapshot：[main CI run 32324323535](https://github.com/cuweiwei/ContextHub/actions/runs/32324323535) 已通過 core、E2E、retrieval、browser、dependency／image scan，並產出 SBOM、provenance 與 `ReleaseManifestV1`；GHCR digest `sha256:eb682cdd47e92c5569e0e9a58b4ea795c0687d4c6aeea1fc2a179163b2abd3af` 可讀取且 attestation 驗證通過。Production 的 8788／8443 `/health` 已回報相同 version／commit、schema 14、audit writable 與 projection ready；但 GitHub `production` environment、正式 deploy workflow run、digest-to-running-image 證據與完整 `DeploymentEvidenceV1` 仍缺，所以尚不符合完整 `live_verified`。

功能狀態與證據分開記錄：

- `implemented_local`：程式與本機測試完成。
- `provider_verified`：第三方 provider、OAuth 或 connector smoke 完成。
- `live_verified`：NAS production 版本、health、restore drill、doctor 與 smoke evidence 完成。
- `ready`、`in_progress`、`blocked`、`deferred`：工作流程狀態，不代表功能完成。

`done` 只允許用於已達到該項目所需的最高 evidence level。SQLite 仍是唯一權威；索引可重建；agent writes 先是 candidate；accepted Memory 以 successor 修正；REST/MCP 共用 commands；namespace/ACL/audit/idempotency fail-closed；repo 不得包含 secrets、generated DB 或 production memory。

## P0 — 發布、部署與資料恢復可信化（0–2 個月）

1. **CHB-029｜Backlog 與證據重新對帳｜S｜implemented_local**：本文件、release snapshot、CI／registry 證據與 production health 觀察已對帳；尚未完成的 provider／deployment 證據仍明確保持 pending，P3 保持不變。
2. **CHB-030｜保護 main 與重整 CI｜M｜implemented_local / provider_verified pending / live_verified pending**：repo 已有 PR/main CI、required `verify` 聚合、SHA pin、ShellCheck、Dependabot 與 image CVE gate；GitHub ruleset 尚未由本次本機變更套用。
3. **CHB-031｜不可變 Container Release｜M｜implemented_local / provider_verified / live_verified pending**：main CI 已實際產出公開 GHCR `linux/amd64` digest、SBOM、provenance attestation 與 `ReleaseManifestV1`；registry digest 與 GitHub attestation 均已驗證。尚未有正式 NAS deployment evidence。
4. **CHB-032｜Owner 核准後自動部署 NAS｜L｜implemented_local / provider_verified pending / live_verified pending**：workflow、Tailscale OIDC、受限 SSH wrapper、root dispatcher 與 digest `nas-deploy.sh` 已完成；GitHub environment、Tailscale ACL/identity、NAS key/wrapper 尚未套用。
5. **CHB-033｜0.9.0 首次正式部署與 live acceptance｜M｜blocked（health observed，formal acceptance pending）**：8788／8443 health 已觀察到 `0.9.0@4c3a09a`，但不能由 health 反推 running image digest、restore drill、doctor 或 rollback evidence。待 CHB-030／032 的 GitHub ruleset、production environment、Tailscale／SSH 邊界完成後，以精確 digest 執行正式 workflow，取得 REST／MCP、Control Center、reindex、restore drill、doctor 與 `DEPLOYMENT VERIFIED` 證據。
6. **CHB-034｜維運排程與失敗告警｜M｜implemented_local foundation / provider_verified pending / live_verified pending**：`scripts/nas-maintenance.sh`、維運 records、doctor、backup/restore/GC 與 metadata-only notification retry/dead-letter 測試已在本機；Synology tasks 與 Telegram 仍待唯讀盤點和 owner 啟用。

## P1 — Provider worker、Owner UX 與 production observability（2–6 個月）

7. **CHB-035｜GitHub Connector worker｜L｜implemented_local foundation / provider_verified pending / live_verified pending**：獨立 worker、repo/resource allowlist、pagination/checkpoint、retry、0600 token、metadata-only mapper 與 profile compose service 已完成；rename/archive/delete/visibility-loss reconciliation、fine-grained GitHub token 與 provider smoke 尚待補齊。
8. **CHB-036｜Google Calendar worker｜L｜implemented_local foundation / provider_verified pending / live_verified pending**：calendar allowlist、incremental token、410 full-reconcile fallback、cancel/recurrence/timezone projection、0600 access token 與 profile compose service 已完成；OAuth refresh/revoke 與 provider smoke 尚待補齊。
9. **CHB-037｜Control Center 真正 browser E2E｜M｜ready**：覆蓋 Tailscale identity、CSRF、session revoke、namespace switch、one-time enrollment、review conflict、policy simulation 與無權 404。
10. **CHB-038｜Production observability｜M｜implemented_local foundation / provider_verified pending / live_verified pending**：health/release/deployment contracts 與 `production:drift` metadata-only detector 已完成；Control Center/NAS 顯示 backup/restore age、connector lag、dead letters、audit anchor 與 drift 告警仍待 production wiring。

## P2 — 事件運行、Memory 品質與相容性（6–12 個月）

11. **CHB-039｜Change delivery operations｜M｜implemented_local foundation / provider_verified pending / live_verified pending**：HTTPS host allowlist、metadata-only payload、retry/dead-letter 與 safe error-code 已覆蓋；簽章輪替、pause/resume、inspect/replay API 與 NAS alert wiring 尚待完成。
12. **CHB-040｜Memory re-verification queue｜L｜proposed**：依 freshness、outcome、conflict、successor 產生 reviewer queue；永不自動改動 accepted Memory。
13. **CHB-041｜Portability recovery drill｜M｜proposed**：以合成資料定期驗證 namespace export/import/dry-run/rollback、checksum、版本與 audit；不建立第二權威。
14. **CHB-042｜Agent Memory Federation v1 與 compatibility matrix｜M｜implemented_local / provider_verified pending / live_verified pending**：schema v15 `claim_key`、pointer-only local cache contract、conflict-safe compiler、MCP instructions，以及 OpenAI／Anthropic／Hermes target 的 session、cache refresh、candidate、successor、conflict exclusion、namespace isolation 本機 contract tests 已完成。仍須用真實 Codex、Claude、Hermes clients 分別驗證 legacy/enrollment initialize、instructions 與完整流程；不得把本機 MCP SDK 測試當成 provider 或 NAS production 證據，也不提前啟用 P3 OAuth。

## P3 — 只在量測 gate 通過後執行

1. **CHB-018｜MCP OAuth resource-server pilot｜L｜ready**：只做 protected resource、issuer/JWKS/audience/resource/scope 驗證；待真實 Codex/Claude/Hermes smoke 後才完成，保留 enrollment/legacy fallback。
2. **CHB-021｜本地 Neural Embedding｜L｜deferred**：private eval 的 synonym/cross-language Recall@5 至少提升 5 個百分點、整體不退步超過 1 點、100k p95 ≤250 ms，才導入 on-device model。
3. **CHB-026｜Gmail＋Drive Connector｜XL｜proposed / gated**：只送摘要、action/decision projection 與 `source_uri`；raw mail、attachment、document body、PII 不持久化。
4. **CHB-027｜Passkey／Local OIDC 備援登入｜L｜proposed / gated**：只有 Tailscale identity 不足以支撐實際可用性才導入。
5. **CHB-028｜ANN／vec0 partition｜L｜proposed / gated**：只有真實 100k corpus exact vector p95 超過 250 ms 才啟動 ADR。

## Public contracts

- `ReleaseManifestV1`：version、full commit、image/digest、CI run、SBOM artifact、provenance subject、deploy contract version。
- `DeploymentEvidenceV1`：workflow URL、digest、backup manifest、schema/retrieval model、health、restore drill、doctor、rollback image；禁止資料內容與 secrets。
- `scripts/nas-deploy.sh --image <repo>@sha256:<digest> --expected-commit <sha> --expected-version <semver>`：immutable deployment path；`--ref` 僅為手動 recovery fallback。

## Definition of Done

- 一般變更：Node 22 `npm test`；HTTP、MCP、DB、migration、backup、policy、deployment 變更再執行 `npm run e2e`。
- CI/release：hygiene、ShellCheck、unit/E2E、retrieval/browser、image build、production dependency/image scan、SBOM、attestation、manifest validation。
- Deployment：preflight 不改 production；backup/gate 失敗不 restart；post-start failure 自動 rollback；live health version/commit、reindex、restore drill、doctor 與 smoke 均通過。
- Connector：fixture contract、pagination/incremental sync、retry、delete/tombstone、token revoke、資料最小化、personal/work isolation。
- 所有 evidence metadata-only；無 secret/generated DB；文件與 workflow 同步；P3 不因本輪實作提前啟用。

## Explicitly deferred

本規劃維持單 owner、單 NAS、單 active writer、Tailscale-private；HA、多副本、通用多租戶、公網 SaaS、跨 NAS replication、完整 conversation archive 與公網 hardening 不列入 12–18 個月承諾。
