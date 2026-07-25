import type { DB } from '../db/connection.js';
import { AuditUnavailableError } from './errors.js';

/**
 * Append-only audit log. There is deliberately NO update or delete method —
 * the only write path is `log()`. Details must be summaries (action, filter
 * kinds, result counts, deny reason codes); callers must never pass item
 * content or raw query text.
 *
 * Fail-closed: if an audit row cannot be written, `log()` throws
 * AuditUnavailableError. Read paths call log() BEFORE executing the read and
 * translate the error to 503 — the system refuses to serve unaudited reads.
 * Mutations write their audit row inside the mutation transaction, so a
 * failed audit write rolls the mutation back.
 */
export interface AuditEntry {
  namespace: string;
  clientId: string;
  action: string;
  itemId?: string | null;
  outcome: 'allow' | 'deny';
  details?: Record<string, unknown>;
}

export type AuditRepo = ReturnType<typeof createAuditRepo>;

export function createAuditRepo(db: DB) {
  const insert = db.prepare(
    'INSERT INTO audit_log (ts, namespace, client_id, action, item_id, outcome, details) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  let lastWriteOk = true;

  function log(entry: AuditEntry): void {
    try {
      insert.run(
        new Date().toISOString(),
        entry.namespace,
        entry.clientId,
        entry.action,
        entry.itemId ?? null,
        entry.outcome,
        entry.details ? JSON.stringify(entry.details) : null,
      );
      lastWriteOk = true;
    } catch (err) {
      lastWriteOk = false;
      throw new AuditUnavailableError(
        `audit log write failed — refusing to proceed unaudited (${(err as Error).message})`,
      );
    }
  }

  /**
   * Best-effort audit for DENIALS that happen inside a rolled-back mutation:
   * the denial itself must survive the rollback, so it is written in its own
   * autocommit statement. If even this fails we still deny the operation (the
   * caller's error stands) — we never fail open.
   */
  function logDenySafe(entry: Omit<AuditEntry, 'outcome'>): void {
    try {
      log({ ...entry, outcome: 'deny' });
    } catch {
      /* the original denial still propagates; health reports degraded */
    }
  }

  function query(opts: {
    namespace?: string;
    limit?: number;
    beforeId?: number;
  }): {
    id: number;
    ts: string;
    namespace: string;
    client_id: string;
    action: string;
    item_id: string | null;
    outcome: string;
    details: unknown;
  }[] {
    const limit = Math.min(opts.limit ?? 100, 500);
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.namespace) {
      where.push('namespace = ?');
      params.push(opts.namespace);
    }
    if (opts.beforeId !== undefined) {
      where.push('id < ?');
      params.push(opts.beforeId);
    }
    const rows = db
      .prepare(
        `SELECT * FROM audit_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`,
      )
      .all(...params, limit) as any[];
    return rows.map((r) => ({ ...r, details: r.details ? JSON.parse(r.details) : null }));
  }

  /** Health surface: did the most recent audit write succeed? */
  function writable(): boolean {
    return lastWriteOk;
  }

  return { log, logDenySafe, query, writable };
}
