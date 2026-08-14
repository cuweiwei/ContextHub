import { randomUUID } from 'node:crypto';
import type { DB } from '../db/connection.js';
import type { ClientInfo, ControlPrincipal } from './types.js';

interface PrincipalRow {
  id: string;
  provider: string;
  subject: string;
  display_name: string;
  profile_pic_url: string | null;
  control_admin: number;
  disabled: number;
  created_at: string;
  updated_at: string;
  last_seen_at: string | null;
}

function mapPrincipal(row: PrincipalRow): ControlPrincipal {
  return {
    id: row.id,
    provider: row.provider,
    subject: row.subject,
    displayName: row.display_name,
    controlAdmin: row.control_admin === 1,
    disabled: row.disabled === 1,
  };
}

export function createWebPrincipalsRepo(db: DB) {
  const byIdentity = db.prepare('SELECT * FROM web_principals WHERE provider = ? AND subject = ?');
  const byId = db.prepare('SELECT * FROM web_principals WHERE id = ?');

  function getByIdentity(provider: string, subject: string): ControlPrincipal | null {
    const row = byIdentity.get(provider, subject) as PrincipalRow | undefined;
    return row ? mapPrincipal(row) : null;
  }

  function get(id: string): ControlPrincipal | null {
    const row = byId.get(id) as PrincipalRow | undefined;
    return row ? mapPrincipal(row) : null;
  }

  function add(input: {
    provider: string;
    subject: string;
    displayName: string;
    profilePicUrl?: string | null;
    controlAdmin?: boolean;
  }): ControlPrincipal {
    const existing = getByIdentity(input.provider, input.subject);
    if (existing) throw new Error('web principal already exists');
    const now = new Date().toISOString();
    const id = `wp_${randomUUID()}`;
    db.prepare(
      `INSERT INTO web_principals
        (id, provider, subject, display_name, profile_pic_url, control_admin, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, input.provider, input.subject, input.displayName, input.profilePicUrl ?? null, input.controlAdmin ? 1 : 0, now, now);
    return get(id)!;
  }

  function setDisabled(id: string, disabled: boolean): boolean {
    const res = db.prepare('UPDATE web_principals SET disabled = ?, updated_at = ? WHERE id = ?')
      .run(disabled ? 1 : 0, new Date().toISOString(), id);
    return res.changes > 0;
  }

  function touch(id: string): void {
    const now = new Date().toISOString();
    db.prepare('UPDATE web_principals SET last_seen_at = ?, updated_at = ? WHERE id = ?').run(now, now, id);
  }

  function linkClient(principalId: string, client: ClientInfo, createdBy: string): void {
    if (client.principal_kind !== 'human') throw new Error('only human clients can be linked to web principals');
    db.prepare(
      `INSERT INTO web_principal_clients (principal_id, client_id, created_at, created_by)
       VALUES (?, ?, ?, ?)`,
    ).run(principalId, client.id, new Date().toISOString(), createdBy);
  }

  function unlinkClient(principalId: string, clientId: string): boolean {
    const res = db.prepare('DELETE FROM web_principal_clients WHERE principal_id = ? AND client_id = ?')
      .run(principalId, clientId);
    return res.changes > 0;
  }

  function linkedClients(principalId: string): ClientInfo[] {
    const rows = db.prepare(
      `SELECT c.* FROM clients c
       JOIN web_principal_clients pc ON pc.client_id = c.id
       WHERE pc.principal_id = ? ORDER BY c.namespace, c.id`,
    ).all(principalId) as PrincipalRow[];
    return rows.map((r: any) => ({
      id: r.id,
      name: r.name,
      principal_kind: r.principal_kind,
      namespace: r.namespace,
      scopes: JSON.parse(r.scopes),
      max_sensitivity: r.max_sensitivity,
      read_sources: r.read_sources === null ? null : JSON.parse(r.read_sources),
      credential_version: r.credential_version,
      created_at: r.created_at,
      disabled: r.disabled === 1,
      auth_method: r.auth_method ?? 'legacy_key',
    }));
  }

  return { getByIdentity, get, add, setDisabled, touch, linkClient, unlinkClient, linkedClients, mapPrincipal };
}

export type WebPrincipalsRepo = ReturnType<typeof createWebPrincipalsRepo>;
