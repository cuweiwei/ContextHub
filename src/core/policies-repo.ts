import type { DB } from '../db/connection.js';
import { validatePolicy, type PolicyV1, stateValueSchemaSchema, type StateValueSchema } from './policy.js';
import { RevisionConflictError } from './errors.js';

export interface CurrentPolicy {
  namespace: string;
  version: number;
  policy: PolicyV1;
}

export type PoliciesRepo = ReturnType<typeof createPoliciesRepo>;

/**
 * Versioned policy store. `getCurrent` re-validates on every cache miss and
 * returns null when the policy is missing OR invalid — callers treat null as
 * a denial (fail-closed), never as "no restrictions".
 */
export function createPoliciesRepo(db: DB) {
  const selectCurrent = db.prepare(
    `SELECT p.namespace, p.current_version AS version, v.rules
     FROM policies p JOIN policy_versions v
       ON v.namespace = p.namespace AND v.version = p.current_version
     WHERE p.namespace = ?`,
  );
  const selectCurrentVersion = db.prepare('SELECT current_version FROM policies WHERE namespace = ?');
  const cache = new Map<string, CurrentPolicy>();

  function clientIdsIn(namespace: string): Set<string> {
    const rows = db.prepare('SELECT id FROM clients WHERE namespace = ?').all(namespace) as {
      id: string;
    }[];
    return new Set(rows.map((r) => r.id));
  }

  function stateSchemaIds(): Set<string> {
    const rows = db.prepare('SELECT schema_id FROM state_schemas').all() as { schema_id: string }[];
    return new Set(rows.map((r) => r.schema_id));
  }

  function getCurrent(namespace: string): CurrentPolicy | null {
    const cached = cache.get(namespace);
    if (cached) {
      // The admin CLI runs in a separate process and may update the policy
      // without access to this repository's in-memory cache. Probe the
      // monotonic version so a long-lived API process observes those changes
      // without requiring a container restart.
      const currentVersion = selectCurrentVersion.get(namespace) as { current_version: number } | undefined;
      if (currentVersion?.current_version === cached.version) return cached;
      cache.delete(namespace);
    }
    const row = selectCurrent.get(namespace) as
      | { namespace: string; version: number; rules: string }
      | undefined;
    if (!row) return null;
    try {
      const policy = validatePolicy(JSON.parse(row.rules), {
        namespaceClientIds: clientIdsIn(namespace),
        stateSchemaIds: stateSchemaIds(),
      });
      const current = { namespace, version: row.version, policy };
      cache.set(namespace, current);
      return current;
    } catch {
      // Stored policy no longer validates (corruption, manual edit). Deny.
      return null;
    }
  }

  function validate(namespace: string, raw: unknown): PolicyV1 {
    return validatePolicy(raw, {
      namespaceClientIds: clientIdsIn(namespace),
      stateSchemaIds: stateSchemaIds(),
    });
  }

  /** Validates and installs a new policy version. Returns the new version number. */
  function apply(namespace: string, raw: unknown, actor: string, expectedVersion?: number): CurrentPolicy {
    const policy = validate(namespace, raw);
    const result = db.transaction((): CurrentPolicy => {
      const row = db
        .prepare('SELECT current_version FROM policies WHERE namespace = ?')
        .get(namespace) as { current_version: number } | undefined;
      if (expectedVersion !== undefined && (row?.current_version ?? 0) !== expectedVersion) {
        throw new RevisionConflictError(`policy base_version ${expectedVersion} is stale; current version is ${row?.current_version ?? 0}`);
      }
      const version = (row?.current_version ?? 0) + 1;
      db.prepare(
        'INSERT INTO policy_versions (namespace, version, rules, created_at, created_by) VALUES (?, ?, ?, ?, ?)',
      ).run(namespace, version, JSON.stringify(policy), new Date().toISOString(), actor);
      if (row) {
        db.prepare('UPDATE policies SET current_version = ? WHERE namespace = ?').run(version, namespace);
      } else {
        db.prepare('INSERT INTO policies (namespace, current_version) VALUES (?, ?)').run(namespace, version);
      }
      return { namespace, version, policy };
    })();
    cache.delete(namespace);
    return result;
  }

  function history(namespace: string): { version: number; created_at: string; created_by: string }[] {
    return db
      .prepare('SELECT version, created_at, created_by FROM policy_versions WHERE namespace = ? ORDER BY version DESC')
      .all(namespace) as { version: number; created_at: string; created_by: string }[];
  }

  function getVersion(namespace: string, version: number): { rules: unknown } | null {
    const row = db
      .prepare('SELECT rules FROM policy_versions WHERE namespace = ? AND version = ?')
      .get(namespace, version) as { rules: string } | undefined;
    return row ? { rules: JSON.parse(row.rules) } : null;
  }

  /** Client set changed (new/disabled clients) — force re-validation. */
  function invalidate(namespace?: string): void {
    if (namespace) cache.delete(namespace);
    else cache.clear();
  }

  // --- operational state schema registry ---

  function registerStateSchema(schemaId: string, raw: unknown): StateValueSchema {
    const schema = stateValueSchemaSchema.parse(raw);
    db.prepare(
      'INSERT INTO state_schemas (schema_id, json_schema, created_at) VALUES (?, ?, ?) ON CONFLICT(schema_id) DO UPDATE SET json_schema = excluded.json_schema',
    ).run(schemaId, JSON.stringify(schema), new Date().toISOString());
    invalidate(); // policies referencing schemas must re-validate
    return schema;
  }

  function getStateSchema(schemaId: string): StateValueSchema | null {
    const row = db.prepare('SELECT json_schema FROM state_schemas WHERE schema_id = ?').get(schemaId) as
      | { json_schema: string }
      | undefined;
    if (!row) return null;
    const parsed = stateValueSchemaSchema.safeParse(JSON.parse(row.json_schema));
    return parsed.success ? parsed.data : null;
  }

  function listStateSchemas(): { schema_id: string; created_at: string }[] {
    return db.prepare('SELECT schema_id, created_at FROM state_schemas ORDER BY schema_id').all() as {
      schema_id: string;
      created_at: string;
    }[];
  }

  return {
    getCurrent,
    validate,
    apply,
    history,
    getVersion,
    invalidate,
    registerStateSchema,
    getStateSchema,
    listStateSchemas,
  };
}
