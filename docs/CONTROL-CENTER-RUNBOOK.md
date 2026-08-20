# Control Center Runbook

## 開啟前提

1. 確認 Docker host publication 仍是 `127.0.0.1:8788:8787`。
2. 保留 data plane 的 Tailscale TCP forwarder（MCP／legacy key）：

```bash
/var/packages/Tailscale/target/bin/tailscale serve \
  --bg --yes --tcp=8788 tcp://127.0.0.1:8788
```

3. 另建立 Control Center 專用的 Tailscale HTTPS reverse proxy，保持 Funnel 關閉：

```bash
/var/packages/Tailscale/target/bin/tailscale serve \
  --bg --yes --https=8443 http://127.0.0.1:8788
```

如果 NAS 的 443 已由其他服務使用（例如 Hermes），不要修改 443；Control Center 使用
`https://<nas-tailscale-name>:8443/dashboard`。

4. 將下列 flags 設在 NAS 的 `.env` 或 Container Manager project environment：

```dotenv
CONTROL_CENTER_ENABLED=true
CONTROL_CENTER_TAILSCALE_AUTH_ENABLED=true
CONTROL_CENTER_TRUSTED_PROXY=true
CONTROL_CENTER_CANONICAL_ORIGIN=https://<nas-tailscale-name>:8443
```

5. OAuth provider 的 issuer、audience、JWKS 與實際 client compatibility 尚未驗證前不可開啟 `MCP_OAUTH_ENABLED`。
6. 使用 CLI 建立 web principal，再 link namespace-scoped human client：

```bash
docker exec contexthub node dist/cli.js web-principal-add --provider tailscale --subject <login> --name "Owner" --control-admin
docker exec contexthub node dist/cli.js web-principal-link --subject <login> --client <human-reviewer-client>
```

驗證順序：

```bash
/var/packages/Tailscale/target/bin/tailscale serve status
curl http://<nas-tailscale-ip>:8788/health
curl -k https://<nas-tailscale-name>:8443/health
```

使用同一個 cookie session 造訪 `/auth/login` 後，`/dashboard` 應回傳 200，
`/v1/control/me` 應回傳已註冊 principal 與 linked human client。

管理介面依工作流分為總覽、記憶庫、審核佇列、連線、命名空間、治理政策、稽核軌跡、
記憶效益與安全／維運；功能盤點、資訊架構與刻意保留在 CLI 的 break-glass 操作見
[CONTROL-CENTER-UX.md](CONTROL-CENTER-UX.md)。

## Staged enable

先部署 code，確認 `/health`、legacy REST、MCP、`/explore`、`/review`；再配置 8443 HTTPS
proxy、開啟 Control Center flags，通過 `/auth/login`、`/v1/control/me`、personal/work separation、
CSRF 與 session revoke 測試後，才開 `AGENT_ENROLLMENT_ENABLED`。Enrollment code 不進 shell history、log 或 Git。

## Rollback

先把 `CONTROL_CENTER_ENABLED=false`、`AGENT_ENROLLMENT_ENABLED=false`、`MCP_OAUTH_ENABLED=false`，重啟 container；legacy MCP/REST 保持可用。優先回復上一個 image，不還原 DB，以免丟失部署後的 Memory writes。只有 schema 不相容或 DB 損壞才用對應 migration 的 pre-migration snapshot，且還原後必跑 `reindex`；v10+ audit tail 只能經 owner-reviewed `audit-chain-extend` 接回。

P1/P2 outbound defaults remain off. Before enabling webhook/Telegram, mount provider files with mode `0600`, set `WEBHOOK_ALLOWED_HOSTS` and `WEBHOOK_SIGNING_MASTER_KEY`, and verify that the destination is owner-approved. OAuth requires issuer, JWKS URI and canonical audience; an incomplete configuration returns fail-closed errors. Calendar/GitHub workers must use separate personal/work credentials and only the minimized fixture fields documented in `docs/ADR-005-p1-p2-integrations.md`.
