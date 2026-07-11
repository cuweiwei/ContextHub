import type { Config } from '../src/config.js';
import { createClientsRepo } from '../src/core/clients-repo.js';
import { createItemsRepo } from '../src/core/items-repo.js';
import type { ReadAccess } from '../src/core/types.js';
import { openDatabase } from '../src/db/connection.js';
import { buildApp } from '../src/http/server.js';

export const TEST_ADMIN_TOKEN = 'test-admin-token';

/** Full access, as the admin token / CLI has. */
export const ADMIN_ACCESS: ReadAccess = {
  clientId: 'admin',
  isAdmin: true,
  readSources: null,
  maxSensitivity: 'private',
};

/** A normal-ceiling, unrestricted-source reader (typical default agent). */
export const AGENT_ACCESS: ReadAccess = {
  clientId: 'test-agent',
  isAdmin: false,
  readSources: null,
  maxSensitivity: 'normal',
};

export function buildTestEnv() {
  const db = openDatabase(':memory:');
  const itemsRepo = createItemsRepo(db);
  const clientsRepo = createClientsRepo(db);
  const config: Config = {
    port: 0,
    host: '127.0.0.1',
    dataDir: '.',
    dbFile: ':memory:',
    adminToken: TEST_ADMIN_TOKEN,
    logLevel: 'silent',
  };
  const app = buildApp({ config, itemsRepo, clientsRepo });
  return { db, itemsRepo, clientsRepo, app };
}
