# ADR-004: Control Center Web Auth 與 Agent Enrollment

- 狀態：Accepted（2026-08-14）
- 範圍：Tailscale-only 人類管理平面、namespace-scoped Memory access、Agent 配對

## 決策

Control Center 只在明確 flags 開啟且位於 Tailscale Serve HTTPS reverse proxy 後運作。Server 以 `Tailscale-User-Login` 的正規化值查 `web_principals`，再建立短期可撤銷的 `__Host-contexthub_session`。SQLite 只保存 session token／CSRF／enrollment code 的 SHA-256 hash。Control admin 與 linked human client 分離；前者不能被轉成 `ADMIN_CLIENT`。

所有 Control API mutation 要求 same-origin `Origin`、JSON content type、CSRF token；高風險 Agent 操作要求 fresh session 與 client-id confirmation。Agents 的近期相容配對方式是 single-use、短效 enrollment；exchange 在單一 transaction consume code 並 rotate client key，raw key 只回傳一次。既有 legacy `chk_` key 保留為 fallback。

## 明確拒絕與限制

- 不把 reviewer key、ADMIN_TOKEN 或 session token 放入 browser storage、HTML、URL 或 audit。
- 不在 ContextHub 第一版自行實作完整 OAuth authorization server；OAuth 只保留 protected-resource/configuration 接縫，issuer、JWKS、audience 未完整設定時 fail closed。
- 不把 `/mcp/:namespace` 的 path 當作 authorization；credential namespace 必須由 server 驗證。
- Tailscale Funnel、公網 port 與 `0.0.0.0` container publication 維持關閉。

## Alternatives

Browser permanent token storage（拒絕）；短期 HttpOnly session（採用）；Tailscale identity headers（只信任 trusted HTTPS proxy）；passkey/local account（未來 fallback）；外部 OIDC/tsidp（未來 pilot）；static API keys（migration fallback）。
