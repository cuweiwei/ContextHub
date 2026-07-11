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
  app.post('/mcp', async (req, reply) => {
    const client = req.client;
    if (!client) {
      return reply.code(401).send({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Unauthorized: provide Authorization: Bearer <api key>' },
        id: null,
      });
    }

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
  });

  const methodNotAllowed = {
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed: this MCP endpoint is stateless, use POST' },
    id: null,
  };
  app.get('/mcp', async (_req, reply) => reply.code(405).header('Allow', 'POST').send(methodNotAllowed));
  app.delete('/mcp', async (_req, reply) => reply.code(405).header('Allow', 'POST').send(methodNotAllowed));
}
