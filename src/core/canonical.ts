/**
 * Canonical serialization of the SOURCE-OWNED part of an item payload, used to
 * decide whether a re-sent transaction is the same record (→ dedup) or a
 * conflicting one (→ 409). This is the ONLY place the comparison rules live.
 *
 * Rules: stable key order, NFC unicode normalization for strings, missing ≡
 * null, entities treated as a sorted de-duplicated set, timestamps already
 * UTC-normalized by the input schema. Hub-owned metadata (tags, sensitivity,
 * expires_at) is deliberately excluded — differences there are ignored.
 */

function normalize(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value.normalize('NFC');
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key.normalize('NFC')] = normalize(v);
    }
    return out;
  }
  return value; // number | boolean — JSON representation is already canonical
}

export interface SourcePayload {
  type: string;
  title: string;
  content: string;
  data: unknown;
  occurred_at: string | null | undefined;
  entities: string[];
  source_uri: string | null | undefined;
}

/**
 * Canonical metadata used by retrieval filters and rebuildable projections.
 * The original display values remain in context_items; these values provide a
 * stable comparison key so equivalent labels do not create separate buckets.
 */
export function normalizeTag(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

export function normalizeEntity(value: string): string {
  const normalized = value.normalize('NFKC').trim().replace(/\s+/g, ' ');
  const separator = normalized.indexOf(':');
  if (separator <= 0) return normalized.toLowerCase();
  const kind = normalized.slice(0, separator).trim().toLowerCase();
  const identifier = normalized.slice(separator + 1).trim().toLowerCase();
  return identifier ? `${kind}:${identifier}` : kind;
}

export function canonicalTags(values: readonly string[]): string[] {
  return [...new Set(values.map(normalizeTag).filter(Boolean))].sort();
}

export function canonicalEntities(values: readonly string[]): string[] {
  return [...new Set(values.map(normalizeEntity).filter(Boolean))].sort();
}

export function canonicalizeSourcePayload(p: SourcePayload): string {
  return JSON.stringify(
    normalize({
      type: p.type,
      title: p.title,
      content: p.content,
      data: p.data ?? null,
      occurred_at: p.occurred_at ?? null,
      entities: canonicalEntities(p.entities),
      source_uri: p.source_uri ?? null,
    }),
  );
}
