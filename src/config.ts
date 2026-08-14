import path from 'node:path';
import { z } from 'zod';

const envBoolean = (defaultValue: boolean) => z.preprocess(
  (value) => typeof value === 'string' ? value.toLowerCase() === 'true' : value,
  z.boolean(),
).default(defaultValue);

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
  CONTROL_CENTER_ENABLED: envBoolean(false),
  CONTROL_CENTER_TAILSCALE_AUTH_ENABLED: envBoolean(false),
  CONTROL_CENTER_TRUSTED_PROXY: envBoolean(false),
  CONTROL_CENTER_CANONICAL_ORIGIN: z.string().url().optional(),
  CONTROL_CENTER_SESSION_IDLE_MINUTES: z.coerce.number().int().positive().default(480),
  CONTROL_CENTER_SESSION_MAX_DAYS: z.coerce.number().int().positive().default(14),
  CONTROL_CENTER_FRESH_SESSION_MINUTES: z.coerce.number().int().positive().default(5),
  AGENT_ENROLLMENT_ENABLED: envBoolean(false),
  MCP_OAUTH_ENABLED: envBoolean(false),
  LEGACY_API_KEYS_ENABLED: envBoolean(true),
  OAUTH_ISSUER: z.string().url().optional(),
  OAUTH_AUDIENCE_BASE: z.string().url().optional(),
  OAUTH_JWKS_URI: z.string().url().optional(),
});

export interface Config {
  port: number;
  host: string;
  dataDir: string;
  dbFile: string;
  adminToken: string | undefined;
  logLevel: string;
  sqliteSynchronous: 'FULL' | 'NORMAL';
  controlCenterEnabled: boolean;
  controlCenterTailscaleAuthEnabled: boolean;
  controlCenterTrustedProxy: boolean;
  controlCenterCanonicalOrigin: string | undefined;
  controlCenterSessionIdleMinutes: number;
  controlCenterSessionMaxDays: number;
  controlCenterFreshSessionMinutes: number;
  agentEnrollmentEnabled: boolean;
  mcpOauthEnabled: boolean;
  legacyApiKeysEnabled: boolean;
  oauthIssuer: string | undefined;
  oauthAudienceBase: string | undefined;
  oauthJwksUri: string | undefined;
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
    controlCenterEnabled: parsed.CONTROL_CENTER_ENABLED,
    controlCenterTailscaleAuthEnabled: parsed.CONTROL_CENTER_TAILSCALE_AUTH_ENABLED,
    controlCenterTrustedProxy: parsed.CONTROL_CENTER_TRUSTED_PROXY,
    controlCenterCanonicalOrigin: parsed.CONTROL_CENTER_CANONICAL_ORIGIN,
    controlCenterSessionIdleMinutes: parsed.CONTROL_CENTER_SESSION_IDLE_MINUTES,
    controlCenterSessionMaxDays: parsed.CONTROL_CENTER_SESSION_MAX_DAYS,
    controlCenterFreshSessionMinutes: parsed.CONTROL_CENTER_FRESH_SESSION_MINUTES,
    agentEnrollmentEnabled: parsed.AGENT_ENROLLMENT_ENABLED,
    mcpOauthEnabled: parsed.MCP_OAUTH_ENABLED,
    legacyApiKeysEnabled: parsed.LEGACY_API_KEYS_ENABLED,
    oauthIssuer: parsed.OAUTH_ISSUER,
    oauthAudienceBase: parsed.OAUTH_AUDIENCE_BASE,
    oauthJwksUri: parsed.OAUTH_JWKS_URI,
  };
}
