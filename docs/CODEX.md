# Codex integration

ContextHub is a remote MCP server used by Codex; Codex project guidance and ContextHub memory are separate:

- `AGENTS.md` tells Codex how to work in this repository.
- ContextHub MCP tools provide source projections, governed durable memory, and ephemeral task-specific context for a single namespace.

Codex local memory is not a second shared authority. Under [Agent Memory Federation Protocol v1](AGENT-MEMORY-FEDERATION.md), local state must be classified as `local_only`, `cache_pointer`, or `shared_candidate`. A cache pointer stores only `hub_item_id`, `revision`, `change_cursor`, and `cached_at`; Codex fetches current content from ContextHub so review, ACL, revocation, and successor state remain effective.

## Network endpoint

Use a Tailscale DNS name or Tailscale IP for the NAS. Do not use the public IP and do not add router port-forwarding rules.

The container publishes host loopback port `8788` to container port `8787`.
On Synology, Tailscale normally uses userspace networking, so do not bind
Docker directly to the NAS `100.x` address. Configure a private TCP forwarder
on the NAS:

```bash
sudo /var/packages/Tailscale/target/bin/tailscale serve \
  --bg --yes --tcp=8788 tcp://127.0.0.1:8788
```

若要啟用 Control Center，另建立 Tailscale HTTPS reverse proxy；不要佔用已由其他 NAS
服務使用的 443：

```bash
sudo /var/packages/Tailscale/target/bin/tailscale serve \
  --bg --yes --https=8443 http://127.0.0.1:8788
```

The MCP URL exposed to tailnet devices is:

```text
http://<nas-tailscale-name-or-ip>:8788/mcp
```

ContextHub data plane currently serves HTTP behind the private Tailscale boundary; do not send its
bearer tokens over untrusted public HTTP. The human Control Center uses the separate HTTPS endpoint
`https://<nas-tailscale-name>:8443/dashboard`; use the Tailscale DNS name rather than the IP for
certificate and identity-proxy compatibility.

當 Control Center 已配置 Tailscale Serve HTTPS 時，Web 管理入口使用 `/dashboard`，不再輸入 reviewer key。MCP data plane 仍可暫時使用 namespace-scoped legacy key；personal 與 work credential 必須保持在不同的 Codex project/profile。OAuth pilot 尚未完成 client 實測前不可預填 OAuth 設定，請保留 legacy fallback。

For general agent behavior and migrating Codex's existing durable memory into
ContextHub, follow [AGENT-GUIDE.md](AGENT-GUIDE.md). In particular, inventory
the old store read-only, deduplicate with `search_context`, write atomic
candidate memories with `save_memory`, review them, and keep the old store
read-only until post-migration verification succeeds.

## Create one Codex identity per namespace

Run these on the NAS after the v6 container is deployed and `reindex` plus
`retrieval-status` report complete projection coverage:

```bash
docker exec contexthub node dist/cli.js create-client \
  --id codex-personal --name "Codex (personal)" \
  --namespace personal --principal-kind agent --profile agent-default

docker exec contexthub node dist/cli.js create-client \
  --id codex-work --name "Codex (work)" \
  --namespace work --principal-kind agent --profile none
```

Each API key is printed once. Store it immediately; never paste it into this repository, chat, shell history, or `config.toml`.

The work client is deny-by-default. Before it can read or propose memories, apply a reviewed work policy that grants only the necessary capabilities and keeps all work writes as candidates.

## Configure Codex safely

Codex supports Streamable HTTP servers with bearer tokens read from environment variables:

```bash
codex mcp add contexthub-personal \
  --url http://<nas-tailscale-name-or-ip>:8788/mcp \
  --bearer-token-env-var CONTEXTHUB_PERSONAL_TOKEN
```

Do not configure personal and work credentials in the same always-on Codex environment. A process that holds both credentials is legitimately authorized for both namespaces, which weakens the intended separation.

Recommended isolation:

1. Personal repositories load only `contexthub-personal`.
2. Work repositories load only `contexthub-work`.
3. Use project-scoped `.codex/config.toml` or separate Codex profiles/hosts; do not commit tokens.

Equivalent project-scoped configuration:

```toml
[mcp_servers.contexthub-personal]
url = "http://<nas-tailscale-name-or-ip>:8788/mcp"
bearer_token_env_var = "CONTEXTHUB_PERSONAL_TOKEN"
required = true
```

On macOS, a GUI Codex process must inherit the environment variable. Load it from an approved secret store into the launch environment before starting Codex; do not place the token directly in `http_headers`.

## Smoke test

After restarting Codex:

1. Confirm the server initializes and exposes 21 tools.
2. Call `list_context_sources`.
3. Call `compile_context` with a harmless task and confirm the package is accepted-only, namespace-bound, and under budget.
4. Confirm `conflicts[]` is present; if non-empty, verify every claimant is excluded and do not choose a winner locally.
5. Call `get_changes`; confirm its protocol id and that each non-null `cache_pointer` has only `hub_item_id`, `revision`, `change_cursor`, and `cached_at`.
6. Call `get_context_brief`.
7. Save one harmless typed test memory with a fresh UUID and confirm it appears in `my_candidates`.
8. Retry the exact write with the same UUID and confirm it replays rather than duplicates.
9. Propose a successor for a reviewed test item and confirm the successor inherits its `claim_key` when omitted.
10. Confirm a work connection cannot see a known personal item and vice versa.

Only `accepted` memories are shared facts. A candidate written during the smoke test should be rejected or removed through the normal review workflow when finished.
