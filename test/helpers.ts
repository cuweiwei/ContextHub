import { randomUUID } from 'node:crypto';
import type { Config } from '../src/config.js';
import { createAuditRepo } from '../src/core/audit-repo.js';
import { createClientsRepo } from '../src/core/clients-repo.js';
import { createCommands } from '../src/core/commands.js';
import { createItemsRepo, type TrustDecision, type WriteContext } from '../src/core/items-repo.js';
import { createPoliciesRepo } from '../src/core/policies-repo.js';
import type { GrantProfile } from '../src/core/policy.js';
import type {
  Authority,
  ClientAuth,
  PrincipalKind,
  ReadAccess,
  Scope,
  Sensitivity,
} from '../src/core/types.js';
import { openDatabase } from '../src/db/connection.js';
import { ADMIN_CLIENT } from '../src/http/auth.js';
import { buildApp } from '../src/http/server.js';
import { createWebPrincipalsRepo } from '../src/core/web-principals-repo.js';
import { createWebSessionsRepo } from '../src/core/web-sessions-repo.js';
import { createEnrollmentsRepo } from '../src/core/enrollments-repo.js';
import { createClientActivityRepo } from '../src/core/client-activity-repo.js';
import { createControlCommands } from '../src/core/control-commands.js';

export const TEST_ADMIN_TOKEN = 'test-admin-token';
export { ADMIN_CLIENT };

/** Full access, as the admin token / CLI has (namespace null = all). */
export const ADMIN_ACCESS: ReadAccess = {
  clientId: 'admin',
  isAdmin: true,
  namespace: null,
  readSources: null,
  maxSensitivity: 'private',
};

/** A normal-ceiling, unrestricted-source reader in the personal namespace. */
export const AGENT_ACCESS: ReadAccess = {
  clientId: 'test-agent',
  isAdmin: false,
  namespace: 'personal',
  readSources: null,
  maxSensitivity: 'normal',
};

export const ACCEPT_TRUST: TrustDecision = {
  trustState: 'accepted',
  acceptanceMethod: 'policy',
  policyVersion: 1,
  ruleId: 'test-rule',
};

export const CANDIDATE_TRUST: TrustDecision = {
  trustState: 'candidate',
  acceptanceMethod: null,
  policyVersion: 1,
  ruleId: 'test-rule',
};

export const IMPORT_TRUST: TrustDecision = {
  trustState: 'accepted',
  acceptanceMethod: 'trusted_import',
  policyVersion: null,
  ruleId: null,
};

export function idem(): string {
  return randomUUID();
}

/** Repo-level WriteContext for a source in a namespace (full-read access). */
export function writerFor(
  source: string,
  opts: {
    namespace?: string;
    principalKind?: PrincipalKind;
    maxSensitivity?: Sensitivity;
    readSources?: string[] | null;
    isAdmin?: boolean;
  } = {},
): WriteContext {
  const namespace = opts.namespace ?? 'personal';
  return {
    clientId: source,
    namespace,
    principalKind: opts.principalKind ?? 'service',
    isAdmin: opts.isAdmin ?? false,
    access: {
      clientId: source,
      isAdmin: opts.isAdmin ?? false,
      namespace: opts.isAdmin ? null : namespace,
      readSources: opts.readSources ?? null,
      maxSensitivity: opts.maxSensitivity ?? 'private',
    },
  };
}

export function buildTestEnv(overrides: Partial<Config> = {}) {
  const db = openDatabase(':memory:');
  const itemsRepo = createItemsRepo(db);
  const clientsRepo = createClientsRepo(db);
  const policiesRepo = createPoliciesRepo(db);
  const auditRepo = createAuditRepo(db);
  const commands = createCommands({ db, itemsRepo, clientsRepo, policiesRepo, auditRepo });
  const config: Config = {
    port: 0,
    host: '127.0.0.1',
    dataDir: '.',
    dbFile: ':memory:',
    adminToken: TEST_ADMIN_TOKEN,
    logLevel: 'silent',
    sqliteSynchronous: 'NORMAL',
    controlCenterEnabled: false,
    controlCenterTailscaleAuthEnabled: false,
    controlCenterTrustedProxy: false,
    controlCenterCanonicalOrigin: undefined,
    controlCenterSessionIdleMinutes: 480,
    controlCenterSessionMaxDays: 14,
    controlCenterFreshSessionMinutes: 5,
    agentEnrollmentEnabled: false,
    mcpOauthEnabled: false,
    legacyApiKeysEnabled: true,
    oauthIssuer: undefined,
    oauthAudienceBase: undefined,
    oauthJwksUri: undefined,
    ...overrides,
  };
  const webPrincipalsRepo = createWebPrincipalsRepo(db);
  const webSessionsRepo = createWebSessionsRepo(db);
  const enrollmentsRepo = createEnrollmentsRepo(db);
  const clientActivityRepo = createClientActivityRepo(db);
  const controlCommands = createControlCommands({ commands, clientsRepo, auditRepo, webPrincipalsRepo, enrollmentsRepo, policiesRepo });
  const app = buildApp({ db, config, itemsRepo, clientsRepo, policiesRepo, auditRepo, commands, webPrincipalsRepo, webSessionsRepo, enrollmentsRepo, clientActivityRepo, controlCommands });

  /** Registers a client (audited, policy profile applied) and returns its auth. */
  function newClient(opts: {
    id: string;
    namespace?: string;
    principalKind?: PrincipalKind;
    scopes?: Scope[];
    profile?: GrantProfile;
    maxSensitivity?: Sensitivity;
    readSources?: string[] | null;
  }): { apiKey: string; auth: ClientAuth } {
    const { apiKey } = commands.adminCreateClient(ADMIN_CLIENT, {
      id: opts.id,
      name: opts.id,
      namespace: opts.namespace ?? 'personal',
      principalKind: opts.principalKind ?? 'agent',
      scopes: opts.scopes ?? ['read', 'write'],
      maxSensitivity: opts.maxSensitivity,
      readSources: opts.readSources,
      profile: opts.profile ?? (opts.principalKind === 'service' ? 'app-producer' : 'agent-default'),
    });
    const auth = clientsRepo.verifyKey(apiKey);
    if (!auth) throw new Error('freshly created key failed to verify');
    return { apiKey, auth };
  }

  /** Repo-level seeding shortcut: accepted item from `source` in `namespace`. */
  function seed(
    source: string,
    item: Parameters<typeof itemsRepo.insert>[1],
    opts: {
      authority?: Authority;
      trust?: TrustDecision;
      namespace?: string;
      principalKind?: PrincipalKind;
    } = {},
  ) {
    return itemsRepo.insert(
      writerFor(source, {
        namespace: opts.namespace,
        principalKind: opts.principalKind ?? (opts.authority === 'agent' ? 'agent' : 'service'),
      }),
      item,
      opts.authority ?? 'app',
      opts.trust ?? ACCEPT_TRUST,
    );
  }

  return { db, itemsRepo, clientsRepo, policiesRepo, auditRepo, commands, app, newClient, seed, webPrincipalsRepo, webSessionsRepo, enrollmentsRepo, controlCommands };
}
