import { loadConfig } from './config.js';
import { acquireInstanceLock, openDatabase } from './db/connection.js';
import { createAuditRepo } from './core/audit-repo.js';
import { createClientsRepo } from './core/clients-repo.js';
import { createCommands } from './core/commands.js';
import { createItemsRepo } from './core/items-repo.js';
import { createPoliciesRepo } from './core/policies-repo.js';
import { buildApp } from './http/server.js';

const config = loadConfig();
// Single-active-instance guard: a second server on the same data dir must
// fail fast, never double-write the database. Held for the process lifetime.
const instanceLock = acquireInstanceLock(config.dataDir);
const db = openDatabase(config.dbFile, { synchronous: config.sqliteSynchronous });

const itemsRepo = createItemsRepo(db);
const clientsRepo = createClientsRepo(db);
const policiesRepo = createPoliciesRepo(db);
const auditRepo = createAuditRepo(db);
const commands = createCommands({ db, itemsRepo, clientsRepo, policiesRepo, auditRepo });

const app = buildApp({ config, itemsRepo, clientsRepo, policiesRepo, auditRepo, commands });

async function shutdown(signal: string): Promise<void> {
  app.log.info(`${signal} received, shutting down`);
  await app.close();
  db.close();
  instanceLock.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

app
  .listen({ port: config.port, host: config.host })
  .then((address) => {
    app.log.info(
      `ContextHub ready — REST at ${address}/v1, MCP at ${address}/mcp, DB at ${config.dbFile} (synchronous=${config.sqliteSynchronous})`,
    );
    if (!config.adminToken) {
      app.log.warn('ADMIN_TOKEN is not set: administration over REST is disabled (use `npm run cli`)');
    }
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
