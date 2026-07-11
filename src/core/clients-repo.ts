import { createHash, randomBytes } from 'node:crypto';
import type { DB } from '../db/connection.js';
import type { ClientAuth, ClientInfo, Scope, Sensitivity } from './types.js';
import { SCOPES } from './types.js';

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
  scopes: string;
  max_sensitivity: Sensitivity;
  read_sources: string | null;
  created_at: string;
  disabled: number;
}

export type ClientsRepo = ReturnType<typeof createClientsRepo>;

export function createClientsRepo(db: DB) {
  const selectByHash = db.prepare('SELECT * FROM clients WHERE api_key_hash = ? AND disabled = 0');
  const selectById = db.prepare('SELECT * FROM clients WHERE id = ?');

  function create(input: {
    id: string;
    name: string;
    kind: 'app' | 'agent';
    scopes: Scope[];
    /** Read ceiling. Defaults to 'private' for apps (they own their data), 'normal' for agents. */
    maxSensitivity?: Sensitivity;
    /** Source whitelist: null/undefined = all sources, [] = none. */
    readSources?: string[] | null;
  }): { client: ClientInfo; apiKey: string } {
    if (!CLIENT_ID_RE.test(input.id)) {
      throw new Error('client id must match ^[a-z0-9][a-z0-9_-]{1,63}$');
    }
    if (selectById.get(input.id)) {
      throw new Error(`client "${input.id}" already exists`);
    }
    const maxSensitivity = input.maxSensitivity ?? (input.kind === 'app' ? 'private' : 'normal');
    const readSources = input.readSources ?? null;
    const apiKey = generateApiKey();
    const created_at = new Date().toISOString();
    db.prepare(
      'INSERT INTO clients (id, name, kind, api_key_hash, scopes, max_sensitivity, read_sources, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      input.id, input.name, input.kind, hashApiKey(apiKey), JSON.stringify(input.scopes),
      maxSensitivity, readSources === null ? null : JSON.stringify(readSources), created_at,
    );
    return {
      client: {
        id: input.id,
        name: input.name,
        kind: input.kind,
        scopes: input.scopes,
        max_sensitivity: maxSensitivity,
        read_sources: readSources,
        created_at,
        disabled: false,
      },
      apiKey,
    };
  }

  function verifyKey(rawKey: string): ClientAuth | null {
    const row = selectByHash.get(hashApiKey(rawKey)) as ClientRow | undefined;
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      scopes: JSON.parse(row.scopes) as Scope[],
      maxSensitivity: row.max_sensitivity,
      readSources: row.read_sources === null ? null : (JSON.parse(row.read_sources) as string[]),
      isAdmin: false,
    };
  }

  function list(): ClientInfo[] {
    const rows = db.prepare('SELECT * FROM clients ORDER BY created_at').all() as ClientRow[];
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      kind: r.kind,
      scopes: JSON.parse(r.scopes) as Scope[],
      max_sensitivity: r.max_sensitivity,
      read_sources: r.read_sources === null ? null : (JSON.parse(r.read_sources) as string[]),
      created_at: r.created_at,
      disabled: r.disabled === 1,
    }));
  }

  function setDisabled(id: string, disabled: boolean): boolean {
    const res = db.prepare('UPDATE clients SET disabled = ? WHERE id = ?').run(disabled ? 1 : 0, id);
    return res.changes > 0;
  }

  return { create, verifyKey, list, setDisabled };
}
