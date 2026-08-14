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

## Staged enable

先部署 code，確認 `/health`、legacy REST、MCP、`/explore`、`/review`；再配置 8443 HTTPS
proxy、開啟 Control Center flags，通過 `/auth/login`、`/v1/control/me`、personal/work separation、
CSRF 與 session revoke 測試後，才開 `AGENT_ENROLLMENT_ENABLED`。Enrollment code 不進 shell history、log 或 Git。

## Rollback

先把 `CONTROL_CENTER_ENABLED=false`、`AGENT_ENROLLMENT_ENABLED=false`、`MCP_OAUTH_ENABLED=false`，重啟 container；legacy MCP/REST 保持可用。優先回復上一個 image，不還原 DB，以免丟失部署後的 Memory writes。只有 schema 不相容或 DB 損壞才用 migration v8 前的 pre-migration snapshot，且還原後必跑 `reindex`。
