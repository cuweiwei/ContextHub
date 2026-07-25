import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import type { AuditRepo } from '../core/audit-repo.js';
import type { ClientsRepo } from '../core/clients-repo.js';
import type { Commands } from '../core/commands.js';
import type { ItemsRepo } from '../core/items-repo.js';
import type { PoliciesRepo } from '../core/policies-repo.js';
import { resolveClient } from './auth.js';
import { registerAuditRoutes } from './routes/audit.js';
import { registerClientRoutes } from './routes/clients.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerItemRoutes } from './routes/items.js';
import { registerPolicyRoutes } from './routes/policies.js';
import { registerSourceRoutes } from './routes/sources.js';
import { registerStateRoutes } from './routes/state.js';
import { registerMcpRoutes } from '../mcp/http.js';

export interface AppDeps {
  config: Config;
  itemsRepo: ItemsRepo;
  clientsRepo: ClientsRepo;
  policiesRepo: PoliciesRepo;
  auditRepo: AuditRepo;
  commands: Commands;
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({
    logger: { level: deps.config.logLevel },
  });

  app.decorateRequest('client', null);
  app.addHook('onRequest', async (req) => {
    req.client = resolveClient(req, deps.clientsRepo, deps.config.adminToken);
  });

  app.setErrorHandler((err: FastifyError, _req, reply) => {
    app.log.error(err);
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    reply.code(status).send({
      error: { code: status === 500 ? 'internal_error' : 'request_error', message: err.message },
    });
  });

  registerHealthRoutes(app, deps);
  registerItemRoutes(app, deps);
  registerSourceRoutes(app, deps);
  registerClientRoutes(app, deps);
  registerPolicyRoutes(app, deps);
  registerAuditRoutes(app, deps);
  registerStateRoutes(app, deps);
  registerMcpRoutes(app, deps);

  return app;
}
