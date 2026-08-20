import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { DB } from '../db/connection.js';
import type { Commands } from './commands.js';
import { newItemSchema } from './types.js';

export const NAMESPACE_ARCHIVE_FORMAT = 'contexthub-namespace-archive/v1';

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Export only the namespace-owned item/provenance surface; credentials,
 * sessions, notifications and raw audit rows are intentionally excluded. */
export function exportNamespace(db: DB, namespace: string, outFile: string): { file: string; count: number; sha256: string } {
  const rows = db.prepare('SELECT * FROM context_items WHERE namespace = ? AND deleted = 0 ORDER BY id').all(namespace) as Array<Record<string, unknown>>;
  const lines: string[] = [JSON.stringify({ format: NAMESPACE_ARCHIVE_FORMAT, kind: 'header', namespace, created_at: new Date().toISOString(), archive_id: `arc_${randomUUID()}` })];
  for (const row of rows) {
    const { idempotency_key: _idempotencyKey, deleted: _deleted, ...portableRow } = row;
    const evidence = db.prepare('SELECT evidence_id FROM insight_evidence WHERE insight_id = ? ORDER BY evidence_id').all(row.id).map((value) => (value as { evidence_id: string }).evidence_id);
    const versions = (db.prepare('SELECT revision, snapshot, change_kind, changed_by, changed_at FROM item_versions WHERE item_id = ? ORDER BY revision').all(row.id) as Array<Record<string, unknown>>).map((version) => { try { const snapshot = JSON.parse(String(version.snapshot)) as Record<string, unknown>; delete snapshot.idempotency_key; delete snapshot.deleted; return { ...version, snapshot: JSON.stringify(snapshot) }; } catch { return version; } });
    const reviews = db.prepare('SELECT item_revision, decision, decided_by, decided_at, note FROM item_reviews WHERE item_id = ? ORDER BY id').all(row.id);
    lines.push(JSON.stringify({ kind: 'item', item: portableRow, provenance: { source: row.source, authority: row.authority, source_item_id: row.source_item_id, source_uri: row.source_uri }, versions, reviews, evidence }));
  }
  const body = lines.join('\n') + '\n';
  lines.push(JSON.stringify({ format: NAMESPACE_ARCHIVE_FORMAT, kind: 'trailer', count: rows.length, sha256: sha256(body) }));
  fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
  fs.writeFileSync(outFile, lines.join('\n') + '\n', { mode: 0o600 });
  return { file: path.resolve(outFile), count: rows.length, sha256: sha256(fs.readFileSync(outFile)) };
}

export function readNamespaceArchive(file: string): { header: Record<string, unknown>; items: Array<Record<string, any>>; trailer: Record<string, unknown>; sha256: string } {
  const bytes = fs.readFileSync(file);
  const lines = bytes.toString('utf8').split('\n').filter(Boolean);
  if (lines.length < 2) throw new Error('namespace archive is empty');
  const parsed = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  const header = parsed[0]!;
  const trailer = parsed[parsed.length - 1]!;
  if (header.format !== NAMESPACE_ARCHIVE_FORMAT || header.kind !== 'header' || trailer.format !== NAMESPACE_ARCHIVE_FORMAT || trailer.kind !== 'trailer') throw new Error('invalid namespace archive format');
  const body = lines.slice(0, -1).join('\n') + '\n';
  if (trailer.sha256 !== sha256(body)) throw new Error('namespace archive checksum mismatch');
  const items = parsed.slice(1, -1).filter((entry) => entry.kind === 'item').map((entry) => entry as Record<string, any>);
  if (trailer.count !== items.length) throw new Error('namespace archive count mismatch');
  return { header, items, trailer, sha256: sha256(bytes) };
}

export function importNamespace(db: DB, commands: Commands, archiveFile: string, targetNamespace: string, options: { sourceMap?: Record<string, string>; mode: 'candidates' | 'trusted'; collision: 'fail' | 'skip' | 'remap'; dryRun?: boolean; snapshotPath?: string }): { runId: string; archiveSha256: string; status: 'dry_run' | 'applied'; imported: number; skipped: number; collisions: string[] } {
  const archive = readNamespaceArchive(archiveFile); const runId = `imp_${randomUUID()}`; const sourceMap = options.sourceMap ?? {};
  const collisions: string[] = []; let imported = 0; let skipped = 0;
  for (const entry of archive.items) {
    const row = entry.item as Record<string, any>; const source = sourceMap[String(row.source)] ?? String(row.source);
    const existing = row.source_item_id ? db.prepare('SELECT id FROM context_items WHERE namespace = ? AND source = ? AND source_item_id = ?').get(targetNamespace, source, row.source_item_id) as { id: string } | undefined : undefined;
    if (existing) { collisions.push(String(row.id)); if (options.collision === 'fail') throw new Error(`namespace import collision for ${row.id}`); if (options.collision === 'skip') { skipped += 1; continue; } }
    imported += 1;
  }
  if (options.dryRun) return { runId, archiveSha256: archive.sha256, status: 'dry_run', imported, skipped, collisions };
  db.prepare('INSERT INTO namespace_import_runs (id, namespace, mode, collision, archive_sha256, status, snapshot_path, created_by, created_at, imported_count, skipped_count) VALUES (?, ?, ?, ?, ?, \'applied\', ?, \'cli\', ?, ?, ?)').run(runId, targetNamespace, options.mode, options.collision, archive.sha256, options.snapshotPath ?? null, new Date().toISOString(), imported, skipped);
  const idMap = new Map<string, string>();
  for (const entry of archive.items) {
      const row = entry.item as Record<string, any>; const source = sourceMap[String(row.source)] ?? String(row.source);
      const existing = row.source_item_id ? db.prepare('SELECT id FROM context_items WHERE namespace = ? AND source = ? AND source_item_id = ?').get(targetNamespace, source, row.source_item_id) as { id: string } | undefined : undefined;
      if (existing && options.collision === 'skip') continue;
      const input = newItemSchema.parse({ type: row.type, title: row.title, content: row.content ?? '', data: row.data ? JSON.parse(String(row.data)) : undefined, tags: JSON.parse(String(row.tags ?? '[]')), entities: JSON.parse(String(row.entities ?? '[]')), sensitivity: row.sensitivity === 'private' ? 'private' : 'normal', status: row.status ?? 'active', confidence: row.confidence ?? undefined, occurred_at: row.occurred_at ?? undefined, expires_at: row.expires_at ?? undefined, valid_from: row.valid_from ?? undefined, valid_until: row.valid_until ?? undefined, last_verified_at: row.last_verified_at ?? undefined, decay_policy: row.decay_policy ?? undefined, memory_kind: row.memory_kind ?? undefined, claim_key: row.claim_key ?? undefined, source_item_id: existing && options.collision === 'remap' ? `${row.source_item_id}:import:${runId}` : row.source_item_id ?? undefined, source_uri: row.source_uri ?? undefined, derived_from: [], idempotency_key: `import:${runId}:${row.id}` });
      const authority = row.authority === 'user' || row.authority === 'agent' || row.authority === 'app' ? row.authority : undefined;
      const created = commands.createMemory(adminClient() as any, input, { namespace: targetNamespace, source, authority });
      const newId = created.item.id; idMap.set(String(row.id), newId);
      if (options.mode === 'candidates') { db.prepare("UPDATE context_items SET trust_state = 'candidate', acceptance_method = NULL, accepted_by = NULL, accepted_at = NULL, revision = revision + 1, updated_at = ? WHERE id = ?").run(new Date().toISOString(), newId); }
      const importedRow = db.prepare('SELECT * FROM context_items WHERE id = ?').get(newId) as Record<string, unknown>;
      db.prepare('INSERT INTO item_versions (item_id, revision, snapshot, change_kind, changed_by, changed_at) VALUES (?, ?, ?, ?, ?, ?)').run(newId, importedRow.revision, JSON.stringify(importedRow), 'import', 'namespace-import', new Date().toISOString());
      db.prepare('INSERT INTO import_provenance (run_id, item_id, source_namespace, source_item_id, source_revision, source_trust_state, source_version, imported_revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(runId, newId, String(archive.header.namespace ?? ''), String(row.id), Number(row.revision ?? 1), String(row.trust_state ?? 'accepted'), 'v1', Number((db.prepare('SELECT revision FROM context_items WHERE id = ?').get(newId) as { revision: number }).revision));
  }
  return { runId, archiveSha256: archive.sha256, status: 'applied', imported, skipped, collisions };

  function adminClient() { return { id: 'admin', name: 'Admin token', principalKind: 'human', namespace: '', scopes: ['read', 'write', 'review_insight', 'admin'], maxSensitivity: 'private', readSources: null, credentialVersion: 0, isAdmin: true } as const; }
}
