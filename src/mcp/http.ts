import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../http/server.js';
import { buildMcpServer } from './server.js';
import { resolveOAuthClient, resourceMetadata } from './oauth-resource.js';

/**
 * Mounts the MCP endpoint at POST /mcp using the Streamable HTTP transport in
 * stateless mode: every request gets a fresh server+transport pair, so no
 * session bookkeeping survives between calls. That trades a little per-request
 * setup (cheap — tool registration only) for zero session state on the NAS,
 * and lets any number of agents connect concurrently.
 */
export function registerMcpRoutes(app: FastifyInstance, deps: AppDeps): void {
  async function handle(req: any, reply: any, namespace?: string) {
    const resource = `${deps.config.oauthAudienceBase ?? ''}/mcp${namespace ? `/${namespace}` : ''}`;
    let client = req.client;
    let oauthScopes: Set<string> | null = null;
    if (deps.config.mcpOauthEnabled) {
      if (!deps.config.oauthIssuer || !deps.config.oauthJwksUri || !deps.config.oauthAudienceBase) return reply.code(503).send({ error: { code: 'oauth_unavailable', message: 'OAuth resource-server configuration is incomplete' } });
      const oauth = await resolveOAuthClient(req, deps, resource);
      if (oauth) {
        oauthScopes = oauth.scopes;
        client = { ...oauth.client, scopes: oauth.client.scopes.filter((scope) => scope === 'read' ? oauthScopes!.has('contexthub.read') : scope === 'write' ? oauthScopes!.has('contexthub.write') : true) };
      }
    }
    if (!client) {
      return reply.code(401).header('WWW-Authenticate', deps.config.mcpOauthEnabled ? `Bearer resource_metadata="${resource}/.well-known/oauth-protected-resource", scope="contexthub.read"` : undefined).send({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Unauthorized: provide Authorization: Bearer <api key>' },
        id: null,
      });
    }
    if (deps.config.mcpOauthEnabled && oauthScopes && !oauthScopes.has('contexthub.read') && !oauthScopes.has('contexthub.write')) return reply.code(403).header('WWW-Authenticate', 'Bearer error="insufficient_scope", scope="contexthub.read"').send({ error: 'insufficient_scope' });
    if (namespace && client.namespace !== namespace) {
      return reply.code(403).send({ jsonrpc: '2.0', error: { code: -32003, message: 'Credential is bound to a different namespace' }, id: null });
    }
    deps.clientActivityRepo.mcpInitialize(client.id);

    const server = buildMcpServer(deps, client);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      enableJsonResponse: true, // plain JSON responses; no SSE stream to manage
    });

    // The MCP transport writes to the raw Node response, so take the reply
    // out of Fastify's hands first.
    reply.hijack();
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });

    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  }

  app.post('/mcp', async (req, reply) => handle(req, reply));
  app.post('/mcp/:namespace', async (req, reply) => handle(req, reply, (req.params as { namespace: string }).namespace));

  const methodNotAllowed = {
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed: this MCP endpoint is stateless, use POST' },
    id: null,
  };
  app.get('/mcp', async (_req, reply) => deps.config.mcpOauthEnabled
    ? reply.code(401).header('WWW-Authenticate', `Bearer resource_metadata="${deps.config.oauthAudienceBase ?? ''}/mcp/.well-known/oauth-protected-resource", scope="contexthub.read"`).send({ error: 'authorization_required' })
    : reply.code(405).header('Allow', 'POST').send(methodNotAllowed));
  app.delete('/mcp', async (_req, reply) => reply.code(405).header('Allow', 'POST').send(methodNotAllowed));
  app.get('/mcp/:namespace', async (req, reply) => {
    if (deps.config.mcpOauthEnabled) {
      const resource = `${deps.config.oauthAudienceBase ?? ''}/mcp/${(req.params as { namespace: string }).namespace}`;
      return reply.code(401).header('WWW-Authenticate', `Bearer resource_metadata="${resource}/.well-known/oauth-protected-resource", scope="contexthub.read"`).send({ error: 'authorization_required' });
    }
    return reply.code(405).header('Allow', 'POST').send(methodNotAllowed);
  });
  app.get('/.well-known/oauth-protected-resource', async (_req, reply) => {
    if (!deps.config.mcpOauthEnabled) return reply.code(404).send();
    return reply.header('Cache-Control', 'no-store').send(resourceMetadata(deps, deps.config.oauthAudienceBase ?? ''));
  });
  app.get('/mcp/.well-known/oauth-protected-resource', async (_req, reply) => {
    if (!deps.config.mcpOauthEnabled) return reply.code(404).send();
    return reply.header('Cache-Control', 'no-store').send(resourceMetadata(deps, `${deps.config.oauthAudienceBase}/mcp`));
  });
  app.get('/mcp/:namespace/.well-known/oauth-protected-resource', async (req, reply) => {
    if (!deps.config.mcpOauthEnabled) return reply.code(404).send();
    return reply.header('Cache-Control', 'no-store').send(resourceMetadata(deps, `${deps.config.oauthAudienceBase}/mcp/${(req.params as { namespace: string }).namespace}`));
  });
}
