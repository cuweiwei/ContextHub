import { loadConfig } from './config.js';
import { openDatabase } from './db/connection.js';
import { createClientsRepo } from './core/clients-repo.js';
import { createItemsRepo } from './core/items-repo.js';
import { buildApp } from './http/server.js';

const config = loadConfig();
const db = openDatabase(config.dbFile);
const app = buildApp({
  config,
  itemsRepo: createItemsRepo(db),
  clientsRepo: createClientsRepo(db),
});

async function shutdown(signal: string): Promise<void> {
  app.log.info(`${signal} received, shutting down`);
  await app.close();
  db.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

app
  .listen({ port: config.port, host: config.host })
  .then((address) => {
    app.log.info(`ContextHub ready — REST at ${address}/v1, MCP at ${address}/mcp, DB at ${config.dbFile}`);
    if (!config.adminToken) {
      app.log.warn('ADMIN_TOKEN is not set: client management over REST is disabled (use `npm run cli`)');
    }
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
