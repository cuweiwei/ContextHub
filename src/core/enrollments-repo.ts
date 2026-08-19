import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { DB } from '../db/connection.js';
import { generateApiKey, hashApiKey } from './clients-repo.js';
import type { EnrollmentStatus } from './types.js';

export function hashEnrollmentCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

function hashSecret(secret: string): string {
  return `v2:${hashEnrollmentCode(secret)}`;
}

function parseV2Code(code: string): { id: string; secret: string } | null {
  const match = /^enr_([^\.]+)\.([A-Za-z0-9_-]{32,})$/.exec(code);
  return match ? { id: match[1]!, secret: match[2]! } : null;
}

function constantTimeHexEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createEnrollmentsRepo(db: DB) {
  function create(clientId: string, principalId: string, ttlMinutes = 10) {
    const now = new Date();
    const id = `en_${randomUUID()}`;
    const secret = randomBytes(32).toString('base64url');
    const code = `enr_${id}.${secret}`;
    db.prepare(
      `INSERT INTO agent_enrollments
        (id, client_id, code_hash, created_by_principal_id, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, clientId, hashSecret(secret), principalId, now.toISOString(), new Date(now.getTime() + ttlMinutes * 60_000).toISOString());
    return { id, code, expiresAt: new Date(now.getTime() + ttlMinutes * 60_000).toISOString() };
  }

  function revoke(id: string): boolean {
    return (db.prepare('UPDATE agent_enrollments SET revoked_at = ? WHERE id = ? AND consumed_at IS NULL AND revoked_at IS NULL')
      .run(new Date().toISOString(), id)).changes > 0;
  }

  function listForClient(clientId: string) {
    const now = Date.now();
    return (db.prepare(
      `SELECT id, client_id, created_at, expires_at, consumed_at, revoked_at, failed_attempts, locked_at
       FROM agent_enrollments WHERE client_id = ? ORDER BY created_at DESC`,
    ).all(clientId) as Array<Record<string, unknown>>).map((row) => ({
      ...row,
      status: (row.revoked_at ? 'revoked' : row.consumed_at ? 'consumed' : row.locked_at ? 'locked' : Date.parse(String(row.expires_at)) <= now ? 'expired' : 'pending') as EnrollmentStatus,
    }));
  }

  function revokePendingForClient(clientId: string): number {
    return (db.prepare(
      `UPDATE agent_enrollments SET revoked_at = ?
       WHERE client_id = ? AND consumed_at IS NULL AND revoked_at IS NULL`,
    ).run(new Date().toISOString(), clientId)).changes;
  }

  function exchange(code: string): { enrollmentId: string; clientId: string; apiKey: string } | null {
    const now = new Date().toISOString();
    return db.transaction(() => {
      const parsed = parseV2Code(code);
      const row = parsed
        ? db.prepare('SELECT * FROM agent_enrollments WHERE id = ?').get(parsed.id) as any
        : db.prepare('SELECT * FROM agent_enrollments WHERE code_hash = ?').get(hashEnrollmentCode(code)) as any;
      if (parsed && row && !constantTimeHexEqual(String(row.code_hash).replace(/^v2:/, ''), hashEnrollmentCode(parsed.secret))) {
        return null;
      }
      if (!row || row.consumed_at || row.revoked_at || row.locked_at || row.expires_at <= now) return null;
      const apiKey = generateApiKey();
      const updated = db.prepare(
        `UPDATE agent_enrollments SET consumed_at = ?
         WHERE id = ? AND consumed_at IS NULL AND revoked_at IS NULL AND locked_at IS NULL`,
      ).run(now, row.id);
      if (updated.changes !== 1) return null;
      db.prepare('UPDATE clients SET api_key_hash = ?, credential_version = credential_version + 1, auth_method = ? WHERE id = ?')
        .run(hashApiKey(apiKey), 'enrollment_key', row.client_id);
      return { enrollmentId: row.id, clientId: row.client_id, apiKey };
    })();
  }

  function recordFailed(code: string): void {
    const parsed = parseV2Code(code);
    const statement = parsed
      ? db.prepare(
        `UPDATE agent_enrollments
         SET failed_attempts = failed_attempts + 1,
             locked_at = CASE WHEN failed_attempts + 1 >= 5 THEN ? ELSE locked_at END
         WHERE id = ? AND consumed_at IS NULL AND revoked_at IS NULL`,
      )
      : db.prepare(
      `UPDATE agent_enrollments
       SET failed_attempts = failed_attempts + 1,
           locked_at = CASE WHEN failed_attempts + 1 >= 5 THEN ? ELSE locked_at END
       WHERE code_hash = ? AND consumed_at IS NULL AND revoked_at IS NULL`,
      );
    statement.run(new Date().toISOString(), parsed ? parsed.id : hashEnrollmentCode(code));
  }

  return { create, revoke, revokePendingForClient, listForClient, exchange, recordFailed, parseV2Code };
}

export type EnrollmentsRepo = ReturnType<typeof createEnrollmentsRepo>;
