import path from 'node:path';
import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8787),
  HOST: z.string().default('0.0.0.0'),
  DATA_DIR: z.string().default('./data'),
  ADMIN_TOKEN: z.string().optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  /**
   * FULL (default): an acknowledged commit survives power loss — the honest
   * durability level for a system of record. NORMAL is available for
   * dev/bench setups that accept losing the last commits on power failure.
   */
  SQLITE_SYNCHRONOUS: z.enum(['FULL', 'NORMAL']).default('FULL'),
});

export interface Config {
  port: number;
  host: string;
  dataDir: string;
  dbFile: string;
  adminToken: string | undefined;
  logLevel: string;
  sqliteSynchronous: 'FULL' | 'NORMAL';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.parse(env);
  const dataDir = path.resolve(parsed.DATA_DIR);
  return {
    port: parsed.PORT,
    host: parsed.HOST,
    dataDir,
    dbFile: path.join(dataDir, 'contexthub.db'),
    adminToken: parsed.ADMIN_TOKEN || undefined,
    logLevel: parsed.LOG_LEVEL,
    sqliteSynchronous: parsed.SQLITE_SYNCHRONOUS,
  };
}
