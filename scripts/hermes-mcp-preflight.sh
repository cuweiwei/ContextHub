#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/hermes-mcp-preflight.sh [options]

Options:
  --url <url>             ContextHub MCP URL (default: http://127.0.0.1:8788/mcp/personal)
  --token-file <path>     Personal credential file (default: /opt/secrets/contexthub-personal-key)
  --container <name>      Run the read-only check inside this container
  --timeout <seconds>     HTTP timeout (default: 15)
  -h, --help              Show this help

The check reads the credential without printing it, verifies ContextHub health,
performs MCP initialize/tools/list, and compiles a 256-token Hermes-targeted
context package. It never writes a memory, changes a client, or edits a file.
Use --container hermes-agent when the credential file exists only inside the
running Hermes container.
EOF
}

MCP_URL="http://127.0.0.1:8788/mcp/personal"
TOKEN_FILE="/opt/secrets/contexthub-personal-key"
CONTAINER=""
TIMEOUT_SECONDS="15"
URL_SET=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --url) MCP_URL=${2:?--url requires a value}; URL_SET=1; shift 2 ;;
    --token-file) TOKEN_FILE=${2:?--token-file requires a value}; shift 2 ;;
    --container) CONTAINER=${2:?--container requires a value}; shift 2 ;;
    --timeout) TIMEOUT_SECONDS=${2:?--timeout requires a value}; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

[[ "$TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]] || { echo "timeout must be a positive integer" >&2; exit 2; }

if [[ -n "$CONTAINER" && "$URL_SET" -eq 0 ]]; then
  MCP_URL="http://contexthub:8787/mcp/personal"
fi

if [[ -n "$CONTAINER" ]]; then
  command -v docker >/dev/null 2>&1 || { echo "docker is required for --container" >&2; exit 2; }
  RUNNER=(docker exec -i "$CONTAINER" env)
else
  RUNNER=(env)
fi

"${RUNNER[@]}" \
  "CONTEXTHUB_PREFLIGHT_URL=$MCP_URL" \
  "CONTEXTHUB_PREFLIGHT_TOKEN_FILE=$TOKEN_FILE" \
  "CONTEXTHUB_PREFLIGHT_TIMEOUT_SECONDS=$TIMEOUT_SECONDS" \
  node --input-type=module - <<'NODE'
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

const mcpUrl = process.env.CONTEXTHUB_PREFLIGHT_URL ?? '';
const tokenPath = process.env.CONTEXTHUB_PREFLIGHT_TOKEN_FILE ?? '';
const timeoutSeconds = Number(process.env.CONTEXTHUB_PREFLIGHT_TIMEOUT_SECONDS ?? '15');

function fail(message) {
  console.error(`HERMES MCP PREFLIGHT FAIL: ${message}`);
  process.exit(2);
}

function pass(message) {
  console.log(`PASS ${message}`);
}

let endpoint;
try {
  endpoint = new URL(mcpUrl);
} catch {
  fail('CONTEXTHUB_MCP_URL is not a valid URL');
}
if (!['http:', 'https:'].includes(endpoint.protocol)) fail('MCP URL must use http or https');
if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) fail('MCP URL must not contain credentials, query, or fragment');
if (endpoint.pathname !== '/mcp/personal') fail('CONTEXTHUB_MCP_URL must end with /mcp/personal');

let token;
try {
  const stat = fs.statSync(tokenPath);
  if (!stat.isFile()) fail('credential file is not a regular file');
  if ((stat.mode & 0o077) !== 0) fail('credential file must be owner-readable only');
  token = fs.readFileSync(tokenPath, 'utf8').trim();
} catch {
  fail('ContextHub credential file is unavailable');
}
if (!/^chk_[A-Za-z0-9_-]{20,}$/.test(token)) fail('credential file does not contain a valid ContextHub key');
pass('personal credential file is present (value redacted)');

const timeout = Math.max(1, Math.min(120, timeoutSeconds)) * 1000;
async function request(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { ...init, redirect: 'error', signal: controller.signal });
    const text = await response.text();
    return { ok: response.ok, status: response.status, text };
  } catch {
    fail('ContextHub endpoint is unreachable');
  } finally {
    clearTimeout(timer);
  }
}

const health = await request(new URL('/health', endpoint.origin));
if (!health.ok) fail(`ContextHub health returned HTTP ${health.status}`);
let healthBody;
try { healthBody = JSON.parse(health.text); } catch { fail('ContextHub health returned invalid JSON'); }
if (healthBody?.status !== 'ok' || healthBody?.audit_writable !== true) fail('ContextHub health is not ready');
pass('ContextHub health is ready');

async function rpc(method, params) {
  const response = await request(endpoint, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }),
  });
  if (!response.ok) fail(`MCP ${method} returned HTTP ${response.status}`);
  let body;
  try {
    body = JSON.parse(response.text);
  } catch {
    fail(`MCP ${method} returned invalid JSON`);
  }
  if (!body || typeof body !== 'object' || body.error) fail(`MCP ${method} was rejected`);
  return body.result;
}

const initialized = await rpc('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'hermes-mcp-preflight', version: '1' },
});
if (initialized?.serverInfo?.name !== 'contexthub') fail('MCP server identity is not ContextHub');
pass('MCP initialize authenticated');

const listed = await rpc('tools/list', {});
const toolNames = new Set(Array.isArray(listed?.tools) ? listed.tools.map((tool) => tool?.name) : []);
for (const name of ['compile_context', 'search_context', 'save_memory', 'propose_successor', 'get_changes']) {
  if (!toolNames.has(name)) fail(`required MCP tool is missing: ${name}`);
}
pass('MCP tool contract includes Hermes memory operations');

const compiled = await rpc('tools/call', {
  name: 'compile_context',
  arguments: { intent: 'Hermes ContextHub onboarding preflight', target_agent: 'hermes', token_budget: 256 },
});
if (compiled?.isError) fail('compile_context returned a tool error');
let packageBody = compiled?.structuredContent;
if (!packageBody && Array.isArray(compiled?.content)) {
  const textContent = compiled.content.find((entry) => entry?.type === 'text' && typeof entry.text === 'string');
  if (textContent) {
    try { packageBody = JSON.parse(textContent.text); } catch { fail('compile_context returned invalid tool content'); }
  }
}
if (packageBody?.target_agent !== 'hermes') fail('compile_context did not return target_agent=hermes');
if (packageBody?.constraints?.accepted_only !== true) fail('compile_context did not enforce accepted-only reads');
if (packageBody?.constraints?.namespace !== 'personal') fail('compile_context returned the wrong namespace');
if (packageBody?.constraints?.active_only !== true || packageBody?.constraints?.unresolved_claims_excluded !== true) fail('compile_context did not enforce lifecycle and conflict filtering');
pass('compile_context returned accepted-only Hermes context (read-only)');
console.log('HERMES MCP PREFLIGHT PASS');
NODE
