import { createHash } from 'node:crypto';
import type { ContextItem } from './types.js';

/**
 * v6 ships a deterministic, synchronous embedding that never leaves the NAS.
 * It is deliberately small enough to run on every write and query. The model
 * id and dimensions are persisted with the rebuildable projection so a future
 * local neural model can replace it without changing domain records or ACLs.
 */
export const LOCAL_EMBEDDING_MODEL = 'local-feature-hash-v1';
export const LOCAL_EMBEDDING_DIMENSIONS = 384;

export interface LocalEmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  embedQuery(value: string): Float32Array;
  embedItem(item: Pick<ContextItem, 'title' | 'content' | 'tags' | 'entities'>): Float32Array;
  contentHash(item: Pick<ContextItem, 'title' | 'content' | 'tags' | 'entities'>): string;
}

function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function features(value: string): string[] {
  const normalized = value.normalize('NFKC').toLocaleLowerCase().trim();
  if (!normalized) return [];
  const out: string[] = [];
  const parts = normalized.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+|[\p{L}\p{N}_-]+/gu) ?? [];
  for (const part of parts) {
    if (/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+$/u.test(part)) {
      const chars = [...part];
      for (const char of chars) out.push(`c1:${char}`);
      for (let i = 0; i < chars.length - 1; i += 1) out.push(`c2:${chars[i]}${chars[i + 1]}`);
    } else {
      out.push(`w:${part}`);
      const padded = `^${part}$`;
      for (let i = 0; i < padded.length - 2; i += 1) out.push(`c3:${padded.slice(i, i + 3)}`);
    }
  }
  return out;
}

function addFeatures(vector: Float32Array, values: string[], weight: number): void {
  const counts = new Map<string, number>();
  for (const feature of values) counts.set(feature, (counts.get(feature) ?? 0) + 1);
  for (const [feature, count] of counts) {
    const hash = fnv1a(feature);
    const index = hash % vector.length;
    const sign = (hash & 0x80000000) === 0 ? 1 : -1;
    vector[index] = (vector[index] ?? 0) + sign * weight * (1 + Math.log(count));
  }
}

function normalize(vector: Float32Array): Float32Array {
  let norm = 0;
  for (const value of vector) norm += value * value;
  if (norm === 0) return vector;
  norm = Math.sqrt(norm);
  for (let i = 0; i < vector.length; i += 1) vector[i] = (vector[i] ?? 0) / norm;
  return vector;
}

export function embedQuery(value: string): Float32Array {
  const vector = new Float32Array(LOCAL_EMBEDDING_DIMENSIONS);
  addFeatures(vector, features(value), 1);
  return normalize(vector);
}

export function embedItem(
  item: Pick<ContextItem, 'title' | 'content' | 'tags' | 'entities'>,
): Float32Array {
  const vector = new Float32Array(LOCAL_EMBEDDING_DIMENSIONS);
  addFeatures(vector, features(item.title), 2.5);
  addFeatures(vector, features(item.content), 1);
  addFeatures(vector, item.tags.flatMap(features), 1.8);
  addFeatures(vector, item.entities.flatMap(features), 2.2);
  return normalize(vector);
}

export function embeddingContentHash(
  item: Pick<ContextItem, 'title' | 'content' | 'tags' | 'entities'>,
): string {
  return createHash('sha256')
    .update(JSON.stringify([item.title, item.content, item.tags, item.entities]))
    .digest('hex');
}

/** Default provider; callers may inject another synchronous on-device model. */
export const DEFAULT_LOCAL_EMBEDDING: LocalEmbeddingProvider = {
  model: LOCAL_EMBEDDING_MODEL,
  dimensions: LOCAL_EMBEDDING_DIMENSIONS,
  embedQuery,
  embedItem,
  contentHash: embeddingContentHash,
};
