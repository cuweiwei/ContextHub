# ADR-005 — P1/P2 governance, portability and integration projections

## Status

Accepted for the 0.9.0 local implementation. No NAS or provider activation is implied.

## Decisions

1. SQLite remains the sole authority for Memory. Migrations v10–v14 add only append-only history, operational metadata, or rebuildable projections.
2. Every REST/MCP mutation continues through `core/commands.ts`; idempotency, authorization and audit are committed in the same transaction. Change events are metadata-only and never grant read access.
3. Audit-chain links are separate from the legacy `audit_log` table. A missing link blocks new writes until the owner explicitly runs `audit-chain-extend`. Anchors are written outside `DATA_DIR` and backup manifests carry the verified root.
4. Namespace archives contain item/provenance/version/review/evidence records plus a checksum trailer. Credentials, sessions, keys, raw audit and notification secrets are excluded. Imports default to candidates; trusted mode is CLI break-glass only.
5. Outbound connectors and notifications are REST/worker boundaries. Calendar/GitHub mappers enforce field allowlists; webhook endpoints require HTTPS and an explicit host allowlist. OAuth is a resource-server pilot and fails closed when issuer, JWKS or audience configuration is incomplete.
6. Graph, consolidation, embeddings and analytics are projections. Suggestions never mutate accepted items; graph traversal applies item ACL at every evidence step; the neural adapter is benchmark-only until all activation gates pass.

## Migration and rollback

- Upgrade is additive and keeps the existing automatic pre-migration snapshot. Rollback normally means returning to the previous image. Restore plus reindex is required only for a database/schema rollback.
- `audit-chain-extend` is the only supported way to attach an old-image audit tail. It must be reviewed before execution.
- Candidate import rollback purges only unchanged candidate rows from the import run. Trusted import rollback restores the run's snapshot.

## Evidence boundary

The repository has local unit, E2E, browser, hygiene and dependency-audit evidence. Provider OAuth/Calendar/GitHub/Telegram and NAS performance evidence are intentionally pending; fixtures and adapters are not live deployment proof.
