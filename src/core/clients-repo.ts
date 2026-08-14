import { createHash, randomBytes } from 'node:crypto';
import type { DB } from '../db/connection.js';
import type { ClientAuth, ClientInfo, PrincipalKind, Scope, Sensitivity } from './types.js';
import { PRINCIPAL_KINDS, SCOPES } from './types.js';

const CLIENT_ID_RE = /^[a-z0-9][a-z0-9_-]{1,63}$/;

export function generateApiKey(): string {
  return 'chk_' + randomBytes(32).toString('base64url');
}

export function hashApiKey(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export function parseScopes(raw: string[]): Scope[] {
  const scopes = raw.filter((s): s is Scope => (SCOPES as readonly string[]).includes(s));
  if (scopes.length !== raw.length) {
    throw new Error(`invalid scopes: valid values are ${SCOPES.join(', ')}`);
  }
  return [...new Set(scopes)];
}

interface ClientRow {
  id: string;
  name: string;
  kind: 'app' | 'agent';
  principal_kind: PrincipalKind;
  namespace: string;
  scopes: string;
  max_sensitivity: Sensitivity;
  read_sources: string | null;
  credential_version: number;
  created_at: string;
  disabled: number;
  disabled_at: string | null;
  auth_method?: 'legacy_key' | 'enrollment_key' | 'oauth_user' | 'oauth_client_credentials';
}

function rowToInfo(r: ClientRow): ClientInfo {
  return {
    id: r.id,
    name: r.name,
    principal_kind: r.principal_kind,
    namespace: r.namespace,
    scopes: JSON.parse(r.scopes) as Scope[],
    max_sensitivity: r.max_sensitivity,
    read_sources: r.read_sources === null ? null : (JSON.parse(r.read_sources) as string[]),
    credential_version: r.credential_version,
    created_at: r.created_at,
    disabled: r.disabled === 1,
    auth_method: r.auth_method ?? 'legacy_key',
  };
}

export type ClientsRepo = ReturnType<typeof createClientsRepo>;

export function createClientsRepo(db: DB) {
  const selectByHash = db.prepare('SELECT * FROM clients WHERE api_key_hash = ? AND disabled = 0');
  const selectById = db.prepare('SELECT * FROM clients WHERE id = ?');
  const selectNamespace = db.prepare('SELECT id FROM namespaces WHERE id = ?');

  /**
   * The client id is the immutable principal identity: it must be unique
   * forever (rows are disabled, never deleted, so ids cannot be reused) and
   * survives key rotation — policies and audit history stay attached to it.
   * namespace and principal_kind are REQUIRED: there is no default namespace
   * for new principals (fail-closed; the v4 migration backfill was one-time).
   */
  function create(input: {
    id: string;
    name: string;
    principalKind: PrincipalKind;
    namespace: string;
    scopes: Scope[];
    /** Read ceiling. Defaults to 'private' for services (they own their data), 'normal' otherwise. */
    maxSensitivity?: Sensitivity;
    /** Source whitelist: null/undefined = all sources, [] = none. */
    readSources?: string[] | null;
  }): { client: ClientInfo; apiKey: string } {
    if (!CLIENT_ID_RE.test(input.id)) {
      throw new Error('client id must match ^[a-z0-9][a-z0-9_-]{1,63}$');
    }
    if (!(PRINCIPAL_KINDS as readonly string[]).includes(input.principalKind)) {
      throw new Error(`principal_kind must be one of ${PRINCIPAL_KINDS.join(', ')}`);
    }
    if (!selectNamespace.get(input.namespace)) {
      throw new Error(`namespace "${input.namespace}" does not exist — create it first (namespaces are explicit)`);
    }
    if (selectById.get(input.id)) {
      throw new Error(`client "${input.id}" already exists (ids are immutable and never reused)`);
    }
    const maxSensitivity =
      input.maxSensitivity ?? (input.principalKind === 'service' ? 'private' : 'normal');
    const readSources = input.readSources ?? null;
    const apiKey = generateApiKey();
    const created_at = new Date().toISOString();
    db.prepare(
      `INSERT INTO clients (id, name, kind, principal_kind, namespace, api_key_hash, scopes,
         max_sensitivity, read_sources, credential_version, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    ).run(
      input.id,
      input.name,
      input.principalKind === 'agent' ? 'agent' : 'app', // legacy column kept in sync
      input.principalKind,
      input.namespace,
      hashApiKey(apiKey),
      JSON.stringify(input.scopes),
      maxSensitivity,
      readSources === null ? null : JSON.stringify(readSources),
      created_at,
    );
    return { client: rowToInfo(selectById.get(input.id) as ClientRow), apiKey };
  }

  function verifyKey(rawKey: string): ClientAuth | null {
    const row = selectByHash.get(hashApiKey(rawKey)) as ClientRow | undefined;
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      principalKind: row.principal_kind,
      namespace: row.namespace,
      scopes: JSON.parse(row.scopes) as Scope[],
      maxSensitivity: row.max_sensitivity,
      readSources: row.read_sources === null ? null : (JSON.parse(row.read_sources) as string[]),
      credentialVersion: row.credential_version,
      isAdmin: false,
    };
  }

  function authForId(id: string): ClientAuth | null {
    const row = selectById.get(id) as ClientRow | undefined;
    if (!row || row.disabled === 1) return null;
    return {
      id: row.id,
      name: row.name,
      principalKind: row.principal_kind,
      namespace: row.namespace,
      scopes: JSON.parse(row.scopes) as Scope[],
      maxSensitivity: row.max_sensitivity,
      readSources: row.read_sources === null ? null : (JSON.parse(row.read_sources) as string[]),
      credentialVersion: row.credential_version,
      isAdmin: false,
    };
  }

  function get(id: string): ClientInfo | null {
    const row = selectById.get(id) as ClientRow | undefined;
    return row ? rowToInfo(row) : null;
  }

  function list(namespace?: string): ClientInfo[] {
    const rows = (
      namespace
        ? db.prepare('SELECT * FROM clients WHERE namespace = ? ORDER BY created_at').all(namespace)
        : db.prepare('SELECT * FROM clients ORDER BY created_at').all()
    ) as ClientRow[];
    return rows.map(rowToInfo);
  }

  /**
   * Issues a fresh key for an existing principal. The old key stops working
   * in the same transaction; identity, grants, and audit continuity are
   * untouched.
   */
  function rotateKey(id: string): { client: ClientInfo; apiKey: string } {
    const row = selectById.get(id) as ClientRow | undefined;
    if (!row) throw new Error(`no client with id "${id}"`);
    const apiKey = generateApiKey();
    db.prepare(
      'UPDATE clients SET api_key_hash = ?, credential_version = credential_version + 1 WHERE id = ?',
    ).run(hashApiKey(apiKey), id);
    return { client: rowToInfo(selectById.get(id) as ClientRow), apiKey };
  }

  /** Disable/enable takes effect on the next request (verifyKey checks it). */
  function setDisabled(id: string, disabled: boolean): boolean {
    const res = db
      .prepare('UPDATE clients SET disabled = ?, disabled_at = ? WHERE id = ?')
      .run(disabled ? 1 : 0, disabled ? new Date().toISOString() : null, id);
    return res.changes > 0;
  }

  // --- namespaces (first-class registry) ---

  function listNamespaces(): { id: string; description: string | null; created_at: string }[] {
    return db.prepare('SELECT id, description, created_at FROM namespaces ORDER BY id').all() as {
      id: string;
      description: string | null;
      created_at: string;
    }[];
  }

  function createNamespace(id: string, description?: string): void {
    if (!CLIENT_ID_RE.test(id)) {
      throw new Error('namespace id must match ^[a-z0-9][a-z0-9_-]{1,63}$');
    }
    if (selectNamespace.get(id)) throw new Error(`namespace "${id}" already exists`);
    db.prepare('INSERT INTO namespaces (id, description, created_at) VALUES (?, ?, ?)').run(
      id,
      description ?? null,
      new Date().toISOString(),
    );
  }

  function namespaceExists(id: string): boolean {
    return Boolean(selectNamespace.get(id));
  }

  return {
    create,
    verifyKey,
    get,
    list,
    rotateKey,
    setDisabled,
    listNamespaces,
    createNamespace,
    namespaceExists,
    authForId,
  };
}
