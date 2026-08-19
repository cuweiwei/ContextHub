import { randomUUID } from 'node:crypto';
import type { DB } from '../db/connection.js';

export function migrationCampaignStatus(db: DB, campaignId: string) {
  const campaign = db.prepare('SELECT * FROM migration_campaigns WHERE id = ?').get(campaignId) as any;
  if (!campaign) return null;
  const sources = db.prepare('SELECT * FROM migration_sources WHERE campaign_id = ? ORDER BY source_key').all(campaignId) as any[];
  const ledger = db.prepare('SELECT disposition, COUNT(*) AS count FROM migration_ledger WHERE campaign_id = ? GROUP BY disposition').all(campaignId) as Array<{ disposition: string; count: number }>;
  const counts = Object.fromEntries(ledger.map((row) => [row.disposition, row.count]));
  const inaccessible = sources.some((source) => source.status === 'inaccessible' || source.status === 'unknown');
  const pending = sources.some((source) => source.status === 'pending') || Number(counts.pending ?? 0) > 0 || Number(counts.submitted ?? 0) > 0;
  // A source without an expected count cannot be reconciled truthfully. Keep
  // the campaign partial until the owner records the source's authoritative
  // count rather than treating an unknown total as zero.
  const unaccounted = sources.some((source) => source.expected_count === null || source.expected_count !== source.imported_count + source.duplicate_count + source.excluded_count);
  // Imported candidates remain pending even when their ledger disposition is
  // `imported`; review state is authoritative for the completion gate.
  const candidateRows = db.prepare(`
    SELECT COUNT(*) AS count
    FROM migration_ledger l
    JOIN context_items i ON i.id = l.candidate_item_id
    WHERE l.campaign_id = ? AND i.trust_state = 'candidate'
  `).get(campaignId) as { count: number };
  const candidatesPending = Number(counts.submitted ?? 0) > 0 || sources.some((source) => source.candidate_pending_count > 0) || Number(candidateRows.count ?? 0) > 0;
  const maxImportAt = db.prepare('SELECT MAX(created_at) AS ts FROM migration_ledger WHERE campaign_id = ?').get(campaignId) as { ts: string | null };
  const gateComplete = Boolean(
    campaign.fresh_query_verified_at &&
    campaign.legacy_store_verified_at &&
    campaign.backup_restore_verified_at &&
    (!maxImportAt.ts || campaign.backup_restore_verified_at > maxImportAt.ts),
  );
  const overall = inaccessible || pending || unaccounted || candidatesPending || !gateComplete ? 'partial' : 'complete';
  return { campaign: { ...campaign, overall_migration_status: overall }, sources, counts, gates: { fresh_query: Boolean(campaign.fresh_query_verified_at), legacy_store: Boolean(campaign.legacy_store_verified_at), backup_restore: Boolean(campaign.backup_restore_verified_at) } };
}

export function createCampaign(db: DB, namespace: string, name: string, createdBy: string): string {
  const id = `mig_${randomUUID()}`; const now = new Date().toISOString();
  db.prepare("INSERT INTO migration_campaigns (id, namespace, name, status, created_by, created_at, updated_at, last_mutation_at) VALUES (?, ?, ?, 'draft', ?, ?, ?, ?)").run(id, namespace, name, createdBy, now, now, now); return id;
}

export function upsertCampaignSource(db: DB, campaignId: string, sourceKey: string, domain: string, status: string, expectedCount: number | null) {
  const id = `migs_${randomUUID()}`; db.prepare("INSERT INTO migration_sources (id, campaign_id, source_key, domain, status, expected_count, verified_at) VALUES (?, ?, ?, ?, ?, ?, ? ) ON CONFLICT(campaign_id, source_key) DO UPDATE SET domain = excluded.domain, status = excluded.status, expected_count = excluded.expected_count, verified_at = excluded.verified_at").run(id, campaignId, sourceKey, domain, status, expectedCount, new Date().toISOString());
  db.prepare('UPDATE migration_campaigns SET updated_at = ?, last_mutation_at = ? WHERE id = ?').run(new Date().toISOString(), new Date().toISOString(), campaignId);
}
