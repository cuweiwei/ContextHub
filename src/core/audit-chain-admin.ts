import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { DB } from '../db/connection.js';
import { appendAuditChainLink, verifyAuditChain } from './audit-chain.js';

export function auditChainExtend(db: DB): { extended: number; status: ReturnType<typeof verifyAuditChain> } {
  const extended = db.transaction(() => {
    let count = 0;
    const state = db.prepare('SELECT latest_audit_id FROM audit_chain_state WHERE id = 1').get() as { latest_audit_id: number } | undefined;
    const rows = db.prepare(`SELECT l.id, l.ts, l.namespace, l.client_id, l.action, l.item_id, l.outcome, l.details FROM audit_log l LEFT JOIN audit_chain c ON c.audit_id = l.id WHERE c.audit_id IS NULL ORDER BY l.id`).all() as any[];
    if (rows.some((row) => Number(row.id) <= (state?.latest_audit_id ?? 0))) throw new Error('audit chain has an interior gap; restore a verified snapshot instead of extending it');
    for (const row of rows) { appendAuditChainLink(db, row); count += 1; }
    return count;
  })();
  return { extended, status: verifyAuditChain(db) };
}

export function writeAuditAnchor(db: DB, file: string, buildId: string, schemaVersion: number, backupId?: string) {
  const status = verifyAuditChain(db);
  if (!status.verified) throw new Error('cannot anchor an invalid audit chain');
  const anchor = { format: 'contexthub-audit-anchor/v1', anchor_id: `anc_${randomUUID()}`, created_at: new Date().toISOString(), latest_id: status.latest_audit_id, row_count: status.row_count, root_hash: status.root_hash, build_id: buildId, schema_version: schemaVersion, backup_id: backupId ?? null };
  const resolved = path.resolve(file);
  const dataDir = path.resolve(String((db as any).name ? path.dirname((db as any).name) : ''));
  if (resolved === dataDir || resolved.startsWith(`${dataDir}${path.sep}`)) throw new Error('audit anchors must be stored outside DATA_DIR');
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, JSON.stringify(anchor, null, 2) + '\n', { mode: 0o600 });
  return anchor;
}

export function verifyAuditAnchor(db: DB, file: string): { valid: boolean; message: string } {
  const anchor = JSON.parse(fs.readFileSync(file, 'utf8')) as { latest_id?: number; row_count?: number; root_hash?: string };
  const chain = verifyAuditChain(db);
  const valid = chain.verified && chain.latest_audit_id === anchor.latest_id && chain.row_count === anchor.row_count && chain.root_hash === anchor.root_hash;
  return { valid, message: valid ? 'audit anchor matches current chain' : 'audit anchor does not match current chain' };
}

export function hashAnchor(file: string): string { return createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
