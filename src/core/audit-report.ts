import type { DB } from '../db/connection.js';

export function operationalAuditReport(db: DB, now = new Date()): { window_hours: number; alerts: Array<Record<string, unknown>> } {
  const end = now.toISOString(); const start = new Date(now.getTime() - 86_400_000).toISOString(); const previous = new Date(now.getTime() - 2 * 86_400_000).toISOString();
  const alerts: Array<Record<string, unknown>> = [];
  for (const [action, label, threshold] of [['deny', 'deny', 5], ['read', 'read', 100]] as const) {
    const current = action === 'deny' ? (db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE outcome = 'deny' AND ts >= ? AND ts < ?").get(start, end) as any).count : (db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action LIKE 'read.%' AND outcome = 'allow' AND ts >= ? AND ts < ?").get(start, end) as any).count;
    const prior = action === 'deny' ? (db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE outcome = 'deny' AND ts >= ? AND ts < ?").get(previous, start) as any).count : (db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action LIKE 'read.%' AND outcome = 'allow' AND ts >= ? AND ts < ?").get(previous, start) as any).count;
    if (current >= threshold && current >= Math.max(1, prior * 3)) alerts.push({ kind: label, current, previous: prior, threshold, ratio: prior ? current / prior : null });
  }
  const inactive = db.prepare("SELECT c.id, c.namespace, c.created_at FROM clients c LEFT JOIN client_activity a ON a.client_id = c.id WHERE c.disabled = 0 AND (a.last_authenticated_at IS NULL OR a.last_authenticated_at < ?)").all(new Date(now.getTime() - 30 * 86_400_000).toISOString()) as any[];
  const neverUsed = db.prepare("SELECT c.id, c.namespace, c.created_at FROM clients c LEFT JOIN client_activity a ON a.client_id = c.id WHERE c.disabled = 0 AND a.last_authenticated_at IS NULL AND c.created_at <= ?").all(new Date(now.getTime() - 7 * 86_400_000).toISOString()) as any[];
  if (inactive.length) alerts.push({ kind: 'credential_inactive_30d', clients: inactive.map((row) => row.id) });
  if (neverUsed.length) alerts.push({ kind: 'credential_unused_7d', clients: neverUsed.map((row) => row.id) });
  return { window_hours: 24, alerts };
}
