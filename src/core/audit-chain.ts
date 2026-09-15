import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';

export const AUDIT_CHAIN_FORMAT = 'contexthub-audit-chain/v1';
export const AUDIT_GENESIS_HASH = '0'.repeat(64);

export interface AuditChainRow {
  id: number;
  ts: string;
  namespace: string;
  client_id: string;
  action: string;
  item_id: string | null;
  outcome: string;
  details: string | null;
}

export interface AuditChainStatus {
  format: typeof AUDIT_CHAIN_FORMAT;
  row_count: number;
  latest_audit_id: number;
  root_hash: string;
  verified: boolean;
}

export interface AuditTailStatus {
  latest_audit_id: number;
  root_hash: string;
  verified: boolean;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`);
  return `{${entries.join(',')}}`;
}

export function auditRowHash(row: AuditChainRow, previousHash: string): string {
  const payload = canonical({
    format: AUDIT_CHAIN_FORMAT,
    previous_hash: previousHash,
    row: {
      id: row.id,
      ts: row.ts,
      namespace: row.namespace,
      client_id: row.client_id,
      action: row.action,
      item_id: row.item_id,
      outcome: row.outcome,
      details: row.details,
    },
  });
  return createHash('sha256').update(payload).digest('hex');
}

export function verifyAuditChain(db: Database.Database): AuditChainStatus {
  const rows = db.prepare('SELECT id, ts, namespace, client_id, action, item_id, outcome, details FROM audit_log ORDER BY id').all() as AuditChainRow[];
  const links = db.prepare('SELECT audit_id, prev_hash, row_hash FROM audit_chain ORDER BY audit_id').all() as Array<{ audit_id: number; prev_hash: string; row_hash: string }>;
  if (rows.length !== links.length) {
    return {
      format: AUDIT_CHAIN_FORMAT,
      row_count: rows.length,
      latest_audit_id: rows.at(-1)?.id ?? 0,
      root_hash: links.at(-1)?.row_hash ?? AUDIT_GENESIS_HASH,
      verified: false,
    };
  }
  let previous = AUDIT_GENESIS_HASH;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    const link = links[index]!;
    if (link.audit_id !== row.id || link.prev_hash !== previous) {
      return { format: AUDIT_CHAIN_FORMAT, row_count: rows.length, latest_audit_id: row.id, root_hash: link.row_hash, verified: false };
    }
    const expected = auditRowHash(row, previous);
    if (expected !== link.row_hash) {
      return { format: AUDIT_CHAIN_FORMAT, row_count: rows.length, latest_audit_id: row.id, root_hash: link.row_hash, verified: false };
    }
    previous = expected;
  }
  const state = db.prepare('SELECT latest_audit_id, root_hash FROM audit_chain_state WHERE id = 1').get() as { latest_audit_id: number; root_hash: string } | undefined;
  const latest = rows.at(-1);
  const root = latest ? previous : AUDIT_GENESIS_HASH;
  const stateMatches = state?.latest_audit_id === (latest?.id ?? 0) && state.root_hash === root;
  return {
    format: AUDIT_CHAIN_FORMAT,
    row_count: rows.length,
    latest_audit_id: latest?.id ?? 0,
    root_hash: root,
    verified: stateMatches,
  };
}

/**
 * Constant-time integrity check for the mutable end of a chain that has
 * already passed a full verification. This is intentionally not a substitute
 * for startup/doctor verification: it protects each append from a missing or
 * corrupted tail without re-reading the full immutable history.
 */
export function verifyAuditTail(db: Database.Database): AuditTailStatus {
  const state = db.prepare('SELECT latest_audit_id, root_hash FROM audit_chain_state WHERE id = 1').get() as
    | { latest_audit_id: number; root_hash: string }
    | undefined;
  const row = db.prepare(
    'SELECT id, ts, namespace, client_id, action, item_id, outcome, details FROM audit_log ORDER BY id DESC LIMIT 1',
  ).get() as AuditChainRow | undefined;
  const link = db.prepare(
    'SELECT audit_id, prev_hash, row_hash FROM audit_chain ORDER BY audit_id DESC LIMIT 1',
  ).get() as { audit_id: number; prev_hash: string; row_hash: string } | undefined;

  if (!row || !link) {
    const empty = !row && !link && state?.latest_audit_id === 0 && state.root_hash === AUDIT_GENESIS_HASH;
    return {
      latest_audit_id: state?.latest_audit_id ?? 0,
      root_hash: state?.root_hash ?? AUDIT_GENESIS_HASH,
      verified: empty,
    };
  }

  const previous = db.prepare(
    'SELECT row_hash FROM audit_chain WHERE audit_id < ? ORDER BY audit_id DESC LIMIT 1',
  ).get(link.audit_id) as { row_hash: string } | undefined;
  const expectedPrevious = previous?.row_hash ?? AUDIT_GENESIS_HASH;
  const expectedHash = auditRowHash(row, link.prev_hash);
  const verified =
    row.id === link.audit_id
    && state?.latest_audit_id === row.id
    && state.root_hash === link.row_hash
    && link.prev_hash === expectedPrevious
    && link.row_hash === expectedHash;

  return {
    latest_audit_id: row.id,
    root_hash: link.row_hash,
    verified,
  };
}

export function appendAuditChainLink(db: Database.Database, row: AuditChainRow): { rootHash: string; latestId: number } {
  const state = db.prepare('SELECT latest_audit_id, root_hash FROM audit_chain_state WHERE id = 1').get() as { latest_audit_id: number; root_hash: string } | undefined;
  const previousHash = state?.root_hash ?? AUDIT_GENESIS_HASH;
  const hash = auditRowHash(row, previousHash);
  db.prepare('INSERT INTO audit_chain (audit_id, prev_hash, row_hash, created_at) VALUES (?, ?, ?, ?)')
    .run(row.id, previousHash, hash, new Date().toISOString());
  db.prepare(`INSERT INTO audit_chain_state (id, latest_audit_id, root_hash, updated_at)
              VALUES (1, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET latest_audit_id = excluded.latest_audit_id, root_hash = excluded.root_hash, updated_at = excluded.updated_at`)
    .run(row.id, hash, new Date().toISOString());
  return { rootHash: hash, latestId: row.id };
}
