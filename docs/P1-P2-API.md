# ContextHub 0.9.0 P1/P2 API notes

The following endpoints are implemented behind the existing namespace credential and policy boundaries:

- `POST /v1/items/reviews/batch` — 1–20 per-item decisions with revision/idempotency and namespace/count/private confirmations.
- `POST /v1/policies/:namespace/validate`, `/simulate`, `/rollback`; `PUT /v1/policies/:namespace` accepts `base_version` and `idempotency_key`.
- `GET /v1/audit` supports metadata filters; `/v1/audit/export`, `/verify`, and `/operations` are bounded/admin-gated as appropriate.
- `GET /v1/changes` is a namespace cursor feed. Federation v1 responses include protocol metadata and metadata-only `cache_pointer` objects (`hub_item_id`, `revision`, `change_cursor`, `cached_at`); accepted-memory readers do not see another agent's never-accepted candidate events. `POST /v1/changes/subscriptions` stores no signing secret.
- `POST /v1/migrations/campaigns`, `/sources`, `/ledger`, and `/:id/gates`, plus `GET /v1/migrations/campaigns/:id`, expose coverage-only campaign state.
- `POST /v1/entities/traverse` and `GET /v1/consolidation/suggestions` read rebuildable projections only.
- `POST /v1/connectors/runs` records metadata-only worker status; `/v1/connectors/tombstones` is service-owner-only.
- `POST /v1/context/compile` and MCP `compile_context` accept at most 20 runtime inputs, 10 KB per input and 50 KB total; inputs are untrusted and ephemeral. Both accept exact `claim_keys`; multiple active accepted items under one key are excluded and returned in `conflicts[]`.
- Schema v15 adds nullable `context_items.claim_key`. `GET /v1/items?claim_key=...`, MCP `search_context`, REST/MCP compile, candidate revision, successor inheritance, namespace archive export/import, and curation suggestions preserve this identity.
- MCP protected-resource metadata is available at root and `/mcp` path-specific well-known routes when OAuth is enabled.

CLI additions include `audit-verify`, `audit-anchor`, `audit-chain-extend`, `oauth-bind`, `namespace-export`, `namespace-import`, and `namespace-import-rollback`. `audit-anchor` requires an output path outside `DATA_DIR`. `oauth-bind --issuer <issuer> --subject <subject> --client <client-id>` is an owner-only NAS operation that maps one verified issuer/subject to one existing namespace-bound client; it does not create a cross-namespace identity or bypass policy.
