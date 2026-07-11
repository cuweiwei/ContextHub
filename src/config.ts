import path from 'node:path';
import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8787),
  HOST: z.string().default('0.0.0.0'),
  DATA_DIR: z.string().default('./data'),
  ADMIN_TOKEN: z.string().optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export interface Config {
  port: number;
  host: string;
  dataDir: string;
  dbFile: string;
  adminToken: string | undefined;
  logLevel: string;
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
  };
}
