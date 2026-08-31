import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import type { DB } from '../db/connection.js';
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
import { registerContextRoutes } from './routes/context.js';
import { registerChangeRoutes } from './routes/changes.js';
import { registerConnectorRoutes } from './routes/connectors.js';
import { registerEntityRoutes } from './routes/entities.js';
import { registerMigrationRoutes } from './routes/migrations.js';
import { registerMcpRoutes } from '../mcp/http.js';
import { registerReviewUiRoutes } from './review-ui.js';
import { registerExploreUiRoutes } from './explore-ui.js';
import { registerControlRoutes } from './routes/control.js';
import { registerControlUiRoutes } from './control-ui.js';
import { personalAiControlSession, readCookie } from './control-auth.js';
import { createWebPrincipalsRepo } from '../core/web-principals-repo.js';
import { createWebSessionsRepo } from '../core/web-sessions-repo.js';
import { createEnrollmentsRepo } from '../core/enrollments-repo.js';
import { createClientActivityRepo } from '../core/client-activity-repo.js';
import { createControlCommands } from '../core/control-commands.js';

export interface AppDeps {
  db: DB;
  config: Config;
  itemsRepo: ItemsRepo;
  clientsRepo: ClientsRepo;
  policiesRepo: PoliciesRepo;
  auditRepo: AuditRepo;
  commands: Commands;
  webPrincipalsRepo: ReturnType<typeof createWebPrincipalsRepo>;
  webSessionsRepo: ReturnType<typeof createWebSessionsRepo>;
  enrollmentsRepo: ReturnType<typeof createEnrollmentsRepo>;
  clientActivityRepo: ReturnType<typeof createClientActivityRepo>;
  controlCommands: ReturnType<typeof createControlCommands>;
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({
    logger: { level: deps.config.logLevel },
  });

  app.decorateRequest('client', null);
  app.decorateRequest('controlSession', null);
  app.addHook('onRequest', async (req) => {
    req.client = resolveClient(req, deps.clientsRepo, deps.config.adminToken, deps.config.legacyApiKeysEnabled);
    const rawSession = readCookie(req, '__Host-contexthub_session');
    req.controlSession = rawSession
      ? deps.webSessionsRepo.getValid(rawSession)
      : personalAiControlSession(req, deps.config, deps.webPrincipalsRepo);
    if (req.client && !req.client.isAdmin) deps.clientActivityRepo.authenticated(req.client.id);
  });

  app.setErrorHandler((err: FastifyError, _req, reply) => {
    app.log.error(err);
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    reply.code(status).send({
      error: { code: status === 500 ? 'internal_error' : 'request_error', message: err.message },
    });
  });

  registerHealthRoutes(app, deps);
  registerReviewUiRoutes(app, deps.config);
  registerExploreUiRoutes(app, deps.config);
  registerItemRoutes(app, deps);
  registerSourceRoutes(app, deps);
  registerClientRoutes(app, deps);
  registerPolicyRoutes(app, deps);
  registerAuditRoutes(app, deps);
  registerStateRoutes(app, deps);
  registerContextRoutes(app, deps);
  registerChangeRoutes(app, deps);
  registerConnectorRoutes(app, deps);
  registerEntityRoutes(app, deps);
  registerMigrationRoutes(app, deps);
  registerMcpRoutes(app, deps);
  registerControlRoutes(app, deps);
  registerControlUiRoutes(app, deps);

  return app;
}
