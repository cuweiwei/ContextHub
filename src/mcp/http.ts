import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../http/server.js';
import { buildMcpServer } from './server.js';

/**
 * Mounts the MCP endpoint at POST /mcp using the Streamable HTTP transport in
 * stateless mode: every request gets a fresh server+transport pair, so no
 * session bookkeeping survives between calls. That trades a little per-request
 * setup (cheap — tool registration only) for zero session state on the NAS,
 * and lets any number of agents connect concurrently.
 */
export function registerMcpRoutes(app: FastifyInstance, deps: AppDeps): void {
  async function handle(req: any, reply: any, namespace?: string) {
    if (deps.config.mcpOauthEnabled) {
      return reply.code(503).send({ error: { code: 'oauth_pilot_unavailable', message: 'MCP OAuth pilot is not enabled for requests until issuer, signature, audience, expiry and subject validation are implemented' } });
    }
    const client = req.client;
    if (!client) {
      return reply.code(401).send({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Unauthorized: provide Authorization: Bearer <api key>' },
        id: null,
      });
    }
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
  app.get('/mcp', async (_req, reply) => reply.code(405).header('Allow', 'POST').send(methodNotAllowed));
  app.delete('/mcp', async (_req, reply) => reply.code(405).header('Allow', 'POST').send(methodNotAllowed));
  app.get('/mcp/:namespace', async (req, reply) => {
    if (deps.config.mcpOauthEnabled) {
      return reply.code(401).header('WWW-Authenticate', `Bearer resource_metadata="${deps.config.oauthAudienceBase}/.well-known/oauth-protected-resource"`).send({ error: 'authorization_required' });
    }
    return reply.code(405).header('Allow', 'POST').send(methodNotAllowed);
  });
  app.get('/.well-known/oauth-protected-resource', async (_req, reply) => {
    if (!deps.config.mcpOauthEnabled) return reply.code(404).send();
    return reply.header('Cache-Control', 'no-store').send({ resource: deps.config.oauthAudienceBase, authorization_servers: deps.config.oauthIssuer ? [deps.config.oauthIssuer] : [] });
  });
}
