# Codex integration

ContextHub is a remote MCP server used by Codex; Codex project guidance and ContextHub memory are separate:

- `AGENTS.md` tells Codex how to work in this repository.
- ContextHub MCP tools provide live, durable memory for a single namespace.

## Network endpoint

Use a Tailscale DNS name or Tailscale IP for the NAS. Do not use the public IP and do not add router port-forwarding rules.

The current Docker mapping is host port `8788` to container port `8787`, so the MCP URL is:

```text
http://<nas-tailscale-name-or-ip>:8788/mcp
```

ContextHub currently serves HTTP. Tailscale supplies the private encrypted network boundary; do not send its bearer tokens over untrusted public HTTP.

## Create one Codex identity per namespace

Run these on the NAS after the v4 container is deployed:

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

1. Confirm the server initializes and exposes 16 tools.
2. Call `list_context_sources`.
3. Call `get_context_brief`.
4. Save one harmless test memory with a fresh UUID and confirm it appears in `my_candidates`.
5. Retry the exact write with the same UUID and confirm it replays rather than duplicates.
6. Confirm a work connection cannot see a known personal item and vice versa.

Only `accepted` memories are shared facts. A candidate written during the smoke test should be rejected or removed through the normal review workflow when finished.
