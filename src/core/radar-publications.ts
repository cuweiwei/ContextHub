import { createHash } from 'node:crypto';
import { canonicalEntities, canonicalTags, normalizeClaimKey } from './canonical.js';
import { ValidationError } from './errors.js';
import type { NewItem } from './types.js';

export const RADAR_PUBLICATION_PROTOCOL = 'contexthub-radar-publication/v1';
export const MAX_RADAR_ITEM_JSON_BYTES = 200_000;

export type RadarPublicationAction = 'publish' | 'withdraw';
export type RadarInsightItem = Omit<NewItem, 'idempotency_key' | 'source_item_id'>;

function normalize(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value.normalize('NFC');
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key.normalize('NFC')] = normalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function stableRadarJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

export function normalizeRadarHash(value: string): string {
  const hash = value.trim().toLowerCase().replace(/^sha256:/, '');
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    throw new ValidationError('content_hash must be a SHA-256 hex digest');
  }
  return hash;
}

/** Hash of the canonical item body that ContextHub stores for Radar. */
export function radarHubContentHash(item: RadarInsightItem): string {
  const payload = {
    type: 'insight',
    title: item.title,
    content: item.content,
    data: item.data ?? null,
    tags: canonicalTags(item.tags),
    entities: canonicalEntities(item.entities),
    sensitivity: item.sensitivity,
    status: item.status,
    confidence: item.confidence ?? null,
    occurred_at: item.occurred_at ?? null,
    expires_at: item.expires_at ?? null,
    valid_from: item.valid_from ?? null,
    valid_until: item.valid_until ?? null,
    last_verified_at: item.last_verified_at ?? null,
    decay_policy: item.decay_policy ?? null,
    claim_key: item.claim_key ? normalizeClaimKey(item.claim_key) : null,
    derived_from: [...new Set(item.derived_from)].sort(),
    source_uri: item.source_uri ?? null,
  };
  return createHash('sha256').update(stableRadarJson(payload)).digest('hex');
}

export function radarSourceItemId(insightId: string, revision: number): string {
  return `radar:${insightId}:r${revision}`;
}
