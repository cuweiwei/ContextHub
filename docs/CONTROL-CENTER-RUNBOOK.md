# Control Center Runbook

## 開啟前提

1. 確認 Docker host publication 仍是 `127.0.0.1:8788:8787`。
2. 在 NAS 以 Tailscale Serve HTTPS reverse proxy 指向 `http://127.0.0.1:8788`，保持 Funnel 關閉。
3. OAuth provider 的 issuer、audience、JWKS 與實際 client compatibility 尚未驗證前不可開啟 `MCP_OAUTH_ENABLED`。
4. 使用 CLI 建立 web principal，再 link namespace-scoped human client：

```bash
docker compose exec contexthub node dist/cli.js web-principal-add --provider tailscale --subject <login> --name "Owner" --control-admin
docker compose exec contexthub node dist/cli.js web-principal-link --subject <login> --client <human-reviewer-client>
```

## Staged enable

先部署 code，確認 `/health`、legacy REST、MCP、`/explore`、`/review`；再開啟 Control Center flags，通過 `/auth/login`、`/v1/control/me`、personal/work separation、CSRF 與 session revoke 測試後，才開 `AGENT_ENROLLMENT_ENABLED`。Enrollment code 不進 shell history、log 或 Git。

## Rollback

先把 `CONTROL_CENTER_ENABLED=false`、`AGENT_ENROLLMENT_ENABLED=false`、`MCP_OAUTH_ENABLED=false`，重啟 container；legacy MCP/REST 保持可用。優先回復上一個 image，不還原 DB，以免丟失部署後的 Memory writes。只有 schema 不相容或 DB 損壞才用 migration v8 前的 pre-migration snapshot，且還原後必跑 `reindex`。
