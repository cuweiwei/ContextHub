# ContextHub 0.9.0 P1/P2 API notes

The following endpoints are implemented behind the existing namespace credential and policy boundaries:

- `POST /v1/items/reviews/batch` — 1–20 per-item decisions with revision/idempotency and namespace/count/private confirmations.
- `POST /v1/policies/:namespace/validate`, `/simulate`, `/rollback`; `PUT /v1/policies/:namespace` accepts `base_version` and `idempotency_key`.
- `GET /v1/audit` supports metadata filters; `/v1/audit/export`, `/verify`, and `/operations` are bounded/admin-gated as appropriate.
- `GET /v1/changes` is a namespace cursor feed. `POST /v1/changes/subscriptions` stores no signing secret.
- `POST /v1/migrations/campaigns`, `/sources`, `/ledger`, and `/:id/gates`, plus `GET /v1/migrations/campaigns/:id`, expose coverage-only campaign state.
- `POST /v1/entities/traverse` and `GET /v1/consolidation/suggestions` read rebuildable projections only.
- `POST /v1/connectors/runs` records metadata-only worker status; `/v1/connectors/tombstones` is service-owner-only.
- `POST /v1/context/compile` and MCP `compile_context` accept at most 20 runtime inputs, 10 KB per input and 50 KB total; inputs are untrusted and ephemeral.
- MCP protected-resource metadata is available at root and `/mcp` path-specific well-known routes when OAuth is enabled.

CLI additions include `audit-verify`, `audit-anchor`, `audit-chain-extend`, `oauth-bind`, `namespace-export`, `namespace-import`, and `namespace-import-rollback`. `audit-anchor` requires an output path outside `DATA_DIR`. `oauth-bind --issuer <issuer> --subject <subject> --client <client-id>` is an owner-only NAS operation that maps one verified issuer/subject to one existing namespace-bound client; it does not create a cross-namespace identity or bypass policy.
