import { createHash, randomUUID } from 'node:crypto';
import type { DB } from '../db/connection.js';

/** Rebuilds reviewer-only suggestions. It never changes an accepted row. */
export function rebuildConsolidationQueue(db: DB): { created: number } {
  const rows = db.prepare("SELECT id, namespace, type, title, expires_at, last_verified_at, decay_policy FROM context_items WHERE deleted = 0 AND trust_state = 'accepted' AND state_kind IS NULL").all() as Array<{ id: string; namespace: string; type: string; title: string; expires_at: string | null; last_verified_at: string | null; decay_policy: string | null }>;
  const groups = new Map<string, string[]>();
  for (const row of rows) { const key = `${row.namespace}|${row.type}|${row.title.normalize('NFKC').trim().toLocaleLowerCase()}`; groups.set(key, [...(groups.get(key) ?? []), row.id]); }
  const insert = db.prepare('INSERT OR IGNORE INTO reviewer_suggestions (id, namespace, kind, item_ids, reason, status, created_at) VALUES (?, ?, ?, ?, ?, \'open\', ?)');
  const exists = db.prepare("SELECT 1 FROM reviewer_suggestions WHERE namespace = ? AND kind = ? AND item_ids = ? AND status = 'open' LIMIT 1");
  const now = new Date().toISOString();
  const add = (namespace: string, kind: string, itemIds: string[], reason: string) => { const encoded = JSON.stringify(itemIds); if (exists.get(namespace, kind, encoded)) return false; insert.run(`sug_${randomUUID()}`, namespace, kind, encoded, reason, now); return true; };
  let created = 0;
  for (const [key, ids] of groups) if (ids.length > 1) { const namespace = key.split('|', 1)[0]!; if (add(namespace, 'merge', ids, 'same normalized title and type (reviewer must confirm)')) created += 1; }
  for (const row of rows) {
    if ((row.expires_at && row.expires_at <= now) || (row.last_verified_at && row.decay_policy === 'rapid' && Date.parse(row.last_verified_at) < Date.now() - 14 * 86_400_000)) { if (add(row.namespace, 'reverify', [row.id], 'validity or freshness decay threshold reached')) created += 1; }
  }
  const broken = db.prepare("SELECT ie.insight_id, i.namespace FROM insight_evidence ie JOIN context_items i ON i.id = ie.insight_id JOIN context_items ev ON ev.id = ie.evidence_id WHERE i.trust_state = 'accepted' AND ev.trust_state IN ('revoked', 'rejected')").all() as Array<{ insight_id: string; namespace: string }>;
  for (const row of broken) if (add(row.namespace, 'reverify', [row.insight_id], 'upstream evidence was revoked or rejected')) created += 1;
  return { created };
}

export function suggestionDigest(db: DB, namespace?: string) {
  const rows = namespace ? db.prepare("SELECT id, namespace, kind, item_ids, reason, status, created_at FROM reviewer_suggestions WHERE namespace = ? AND status = 'open' ORDER BY created_at DESC").all(namespace) : db.prepare("SELECT id, namespace, kind, item_ids, reason, status, created_at FROM reviewer_suggestions WHERE status = 'open' ORDER BY created_at DESC").all();
  return rows.map((row: any) => ({ ...row, item_ids: JSON.parse(row.item_ids) }));
}

export function suggestionFingerprint(itemIds: string[]): string { return createHash('sha256').update([...itemIds].sort().join('\n')).digest('hex'); }
