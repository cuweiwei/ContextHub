# ContextHub repository guidance

## Start here

- Read `README.md`, `docs/DESIGN.md`, and `docs/ADR-001-trust-boundary.md` before changing domain behavior.
- Use Node.js 22.19.0 (`nvm use`) to match the Docker runtime and the native `better-sqlite3` build.
- Install with `npm ci`. Use temporary `DATA_DIR` values for local or automated checks; never point development commands at the NAS production data directory.

## Non-negotiable invariants

- SQLite is the only authority for AI memory. FTS is a rebuildable projection, not a second source of truth.
- A credential is bound to exactly one server-derived namespace. Never accept namespace, source, authority, or creator identity from a caller payload.
- Agent-created semantic content starts as `candidate`; only accepted items enter shared reads.
- Accepted agent memories are immutable. Corrections use a candidate successor and atomic supersession.
- REST and MCP must share `core/commands.ts` for authorization, mutation, audit, and idempotency.
- All reads and mutations are audited fail-closed. Do not add a route or tool that bypasses `applyFilters()` or domain commands.
- Every mutation requires an idempotency key. Retry the same logical operation with the same key; use a new UUID for a new operation.
- Keep personal and work credentials separate. Work stores extracted summaries only; never raw messages, transcripts, PII, customer data, undisclosed financials, or confidential technical details.
- Never commit API keys, `ADMIN_TOKEN`, `.env`, database files, or raw production memory.
- Do not expose ports 8787/8788 directly to the public Internet. Remote access must use Tailscale or another owner-approved private tunnel.

## Validation

- Normal code change: `npm test`.
- HTTP, MCP, database, migration, backup, restore, policy, or deployment change: `npm test && npm run e2e`.
- Dependency change: also run `npm audit --omit=dev`; do not deploy with unresolved high or critical production findings.
- Migration change: verify the automatic pre-migration snapshot and the restore plus reindex path.

## NAS deployment

- Follow `docs/NAS-DEPLOY-RUNBOOK.md`; Codex production changes use the shared root-owned `/usr/local/bin/deployment` gateway, never direct Docker or direct writes to root-owned production Compose.
- Check `sudo -n /usr/local/bin/deployment list` first. Only an exact `contexthub` allowlist entry authorizes staging `compose.prod.yml`, validation, deploy, and status checks.
- Upload only repository `compose.prod.yml` to `/volume1/docker-deploy/staging/contexthub/compose.prod.yml`; validate before deploy. All privileged calls use `sudo -n` and must fail non-interactively.
- Never ask for a NAS password, sudo password, API key, or `.env` value. Production secrets and the active Compose remain root-controlled.
- `scripts/nas-deploy.sh` and the libexec engine document the historical owner-run recovery/evidence path; do not substitute them for the shared gateway in an agent-driven production deployment.
- A deployment is complete only after gateway status, live health version/commit, reindex, restore drill, and doctor evidence pass. Database restore always requires separate owner authorization.

## Done means

- Tests appropriate to the change pass on Node 22.
- Security boundaries above remain covered by tests.
- Documentation and MCP tool/server instructions match externally visible behavior.
- The worktree contains no secrets, generated databases, or unrelated edits.
