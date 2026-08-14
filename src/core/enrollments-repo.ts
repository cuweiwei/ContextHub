import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { DB } from '../db/connection.js';
import { generateApiKey, hashApiKey } from './clients-repo.js';

export function hashEnrollmentCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

export function createEnrollmentsRepo(db: DB) {
  function create(clientId: string, principalId: string, ttlMinutes = 10) {
    const code = `enr_${randomBytes(24).toString('base64url')}`;
    const now = new Date();
    const id = `en_${randomUUID()}`;
    db.prepare(
      `INSERT INTO agent_enrollments
        (id, client_id, code_hash, created_by_principal_id, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, clientId, hashEnrollmentCode(code), principalId, now.toISOString(), new Date(now.getTime() + ttlMinutes * 60_000).toISOString());
    return { id, code, expiresAt: new Date(now.getTime() + ttlMinutes * 60_000).toISOString() };
  }

  function revoke(id: string): boolean {
    return (db.prepare('UPDATE agent_enrollments SET revoked_at = ? WHERE id = ? AND consumed_at IS NULL AND revoked_at IS NULL')
      .run(new Date().toISOString(), id)).changes > 0;
  }

  function listForClient(clientId: string) {
    return db.prepare(
      `SELECT id, client_id, created_at, expires_at, consumed_at, revoked_at, failed_attempts, locked_at
       FROM agent_enrollments WHERE client_id = ? ORDER BY created_at DESC`,
    ).all(clientId);
  }

  function exchange(code: string): { enrollmentId: string; clientId: string; apiKey: string } | null {
    const now = new Date().toISOString();
    return db.transaction(() => {
      const row = db.prepare('SELECT * FROM agent_enrollments WHERE code_hash = ?').get(hashEnrollmentCode(code)) as any;
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
    db.prepare(
      `UPDATE agent_enrollments
       SET failed_attempts = failed_attempts + 1,
           locked_at = CASE WHEN failed_attempts + 1 >= 5 THEN ? ELSE locked_at END
       WHERE code_hash = ? AND consumed_at IS NULL AND revoked_at IS NULL`,
    ).run(new Date().toISOString(), hashEnrollmentCode(code));
  }

  return { create, revoke, listForClient, exchange, recordFailed };
}

export type EnrollmentsRepo = ReturnType<typeof createEnrollmentsRepo>;
