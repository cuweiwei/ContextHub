import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { DB } from '../db/connection.js';

export function hashWebSecret(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function createWebSessionsRepo(db: DB) {
  const byHash = db.prepare(
    `SELECT s.*, p.provider, p.subject, p.display_name, p.control_admin, p.disabled AS principal_disabled
     FROM web_sessions s JOIN web_principals p ON p.id = s.principal_id
     WHERE s.token_hash = ?`,
  );
  const byId = db.prepare('SELECT * FROM web_sessions WHERE id = ?');

  function create(principalId: string, idleMinutes: number, maxDays: number) {
    const rawToken = randomBytes(32).toString('base64url');
    const rawCsrf = randomBytes(32).toString('base64url');
    const now = new Date();
    const idle = new Date(now.getTime() + idleMinutes * 60_000).toISOString();
    const absolute = new Date(now.getTime() + maxDays * 86_400_000).toISOString();
    const id = `ws_${randomUUID()}`;
    db.prepare(
      `INSERT INTO web_sessions
        (id, token_hash, principal_id, csrf_hash, created_at, last_seen_at, idle_expires_at, absolute_expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, hashWebSecret(rawToken), principalId, hashWebSecret(rawCsrf), now.toISOString(), now.toISOString(), idle, absolute);
    return { id, rawToken, rawCsrf, idleExpiresAt: idle, absoluteExpiresAt: absolute };
  }

  function getValid(rawToken: string): {
    id: string; principalId: string; csrfHash: string; createdAt: string;
    idleExpiresAt: string; absoluteExpiresAt: string; principal: {
      id: string; provider: string; subject: string; displayName: string; controlAdmin: boolean; disabled: boolean;
    };
  } | null {
    const row = byHash.get(hashWebSecret(rawToken)) as any;
    if (!row || row.revoked_at || row.principal_disabled) return null;
    const now = Date.now();
    if (Date.parse(row.idle_expires_at) <= now || Date.parse(row.absolute_expires_at) <= now) return null;
    return {
      id: row.id,
      principalId: row.principal_id,
      csrfHash: row.csrf_hash,
      createdAt: row.created_at,
      idleExpiresAt: row.idle_expires_at,
      absoluteExpiresAt: row.absolute_expires_at,
      principal: {
        id: row.principal_id,
        provider: row.provider,
        subject: row.subject,
        displayName: row.display_name,
        controlAdmin: row.control_admin === 1,
        disabled: row.principal_disabled === 1,
      },
    };
  }

  function touch(id: string, idleMinutes: number): void {
    const row = byId.get(id) as { absolute_expires_at: string; revoked_at: string | null } | undefined;
    if (!row || row.revoked_at) return;
    const idle = new Date(Math.min(Date.now() + idleMinutes * 60_000, Date.parse(row.absolute_expires_at))).toISOString();
    db.prepare('UPDATE web_sessions SET last_seen_at = ?, idle_expires_at = ? WHERE id = ?').run(new Date().toISOString(), idle, id);
  }

  function revoke(id: string, revokedBy: string): boolean {
    const res = db.prepare('UPDATE web_sessions SET revoked_at = ?, revoked_by = ? WHERE id = ? AND revoked_at IS NULL')
      .run(new Date().toISOString(), revokedBy, id);
    return res.changes > 0;
  }

  function revokeAllForPrincipal(principalId: string, revokedBy: string): number {
    return (db.prepare('UPDATE web_sessions SET revoked_at = ?, revoked_by = ? WHERE principal_id = ? AND revoked_at IS NULL')
      .run(new Date().toISOString(), revokedBy, principalId)).changes;
  }

  function list(principalId: string) {
    return db.prepare(
      `SELECT id, created_at, last_seen_at, idle_expires_at, absolute_expires_at, revoked_at
       FROM web_sessions WHERE principal_id = ? ORDER BY created_at DESC`,
    ).all(principalId);
  }

  function csrfMatches(session: { csrfHash: string }, rawCsrf: string): boolean {
    return hashWebSecret(rawCsrf) === session.csrfHash;
  }

  function rotateCsrf(id: string): string {
    const raw = randomBytes(32).toString('base64url');
    db.prepare('UPDATE web_sessions SET csrf_hash = ? WHERE id = ? AND revoked_at IS NULL').run(hashWebSecret(raw), id);
    return raw;
  }

  return { create, getValid, touch, revoke, revokeAllForPrincipal, list, csrfMatches, rotateCsrf };
}

export type WebSessionsRepo = ReturnType<typeof createWebSessionsRepo>;
