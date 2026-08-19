import type { DB } from '../db/connection.js';
import { AuditUnavailableError } from './errors.js';
import { appendAuditChainLink, verifyAuditChain, type AuditChainStatus } from './audit-chain.js';

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
  let lastWriteOk = true;

  function assertChainReady(): void {
    const missing = db.prepare(`SELECT COUNT(*) AS n FROM audit_log l LEFT JOIN audit_chain c ON c.audit_id = l.id WHERE c.audit_id IS NULL`).get() as { n: number };
    if (missing.n > 0) throw new AuditUnavailableError('audit chain is incomplete — run audit-chain-extend before accepting new writes');
    if (!verifyAuditChain(db).verified) throw new AuditUnavailableError('audit chain verification failed — refusing new writes until the owner restores or repairs it');
  }

  function write(entry: AuditEntry): void {
    assertChainReady();
    const ts = new Date().toISOString();
    const result = db.prepare(
      'INSERT INTO audit_log (ts, namespace, client_id, action, item_id, outcome, details) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(ts, entry.namespace, entry.clientId, entry.action, entry.itemId ?? null, entry.outcome, entry.details ? JSON.stringify(entry.details) : null);
    const id = Number(result.lastInsertRowid);
    appendAuditChainLink(db, {
      id,
      ts,
      namespace: entry.namespace,
      client_id: entry.clientId,
      action: entry.action,
      item_id: entry.itemId ?? null,
      outcome: entry.outcome,
      details: entry.details ? JSON.stringify(entry.details) : null,
    });
  }

  function log(entry: AuditEntry): void {
    try {
      if (db.inTransaction) write(entry);
      else db.transaction(() => write(entry))();
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
    clientId?: string;
    action?: string;
    outcome?: 'allow' | 'deny' | string;
    itemId?: string;
    itemType?: string;
    itemSensitivity?: string;
    since?: string;
    until?: string;
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
    const limit = Math.min(opts.limit ?? 100, 10_000);
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.namespace) {
      where.push('a.namespace = ?');
      params.push(opts.namespace);
    }
    if (opts.clientId) { where.push('a.client_id = ?'); params.push(opts.clientId); }
    if (opts.action) { where.push('a.action = ?'); params.push(opts.action); }
    if (opts.outcome) { where.push('a.outcome = ?'); params.push(opts.outcome); }
    if (opts.itemId) { where.push('a.item_id = ?'); params.push(opts.itemId); }
    if (opts.since) { where.push('a.ts >= ?'); params.push(opts.since); }
    if (opts.until) { where.push('a.ts <= ?'); params.push(opts.until); }
    if (opts.itemType) { where.push('i.type = ?'); params.push(opts.itemType); }
    if (opts.itemSensitivity) { where.push('i.sensitivity = ?'); params.push(opts.itemSensitivity); }
    if (opts.beforeId !== undefined) {
      where.push('a.id < ?');
      params.push(opts.beforeId);
    }
    const rows = db
      .prepare(
        `SELECT a.* FROM audit_log a LEFT JOIN context_items i ON i.id = a.item_id
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY a.id DESC LIMIT ?`,
      )
      .all(...params, limit) as any[];
    return rows.map((r) => ({ ...r, details: r.details ? JSON.parse(r.details) : null }));
  }

  /** Health surface: did the most recent audit write succeed? */
  function writable(): boolean {
    return lastWriteOk;
  }

  function verifyChain(): AuditChainStatus {
    return verifyAuditChain(db);
  }

  return { log, logDenySafe, query, writable, verifyChain };
}
