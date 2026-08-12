import type { DB } from '../db/connection.js';
import { ulid } from './ids.js';
import { buildFtsQuery, makeSnippet, segmentCjk } from './cjk.js';
import { canonicalizeSourcePayload } from './canonical.js';
import {
  DEFAULT_LOCAL_EMBEDDING,
  type LocalEmbeddingProvider,
} from './local-embedding.js';
import { RevisionConflictError, SourceItemConflictError, ValidationError } from './errors.js';
import {
  clampSensitivity,
  type AcceptanceMethod,
  type Authority,
  type CompactItem,
  type ContextItem,
  type DecayPolicy,
  type InformationClass,
  type ItemStatus,
  type ListFilters,
  type MemoryKind,
  type NewItem,
  type PatchItem,
  type PrincipalKind,
  type ReadAccess,
  type Sensitivity,
  type StateKind,
  type TrustState,
  type TrustSurface,
} from './types.js';

const FTS_CANDIDATES = 500;
const LIKE_CANDIDATES = 200;
const VECTOR_CANDIDATES = 250;
const ENTITY_CANDIDATES = 200;
const MAX_VECTOR_DISTANCE = 0.55;
/** Reciprocal Rank Fusion constant (standard value from the RRF paper). */
const RRF_K = 60;
/** Types whose relevance should NOT decay with age (durable knowledge). */
const NO_DECAY_TYPES = new Set(['fact', 'state', 'contact', 'preference', 'memory']);
const DEFAULT_INSIGHT_CONFIDENCE = 0.7;

const TYPE_MEMORY_KIND: Readonly<Record<string, MemoryKind | undefined>> = {
  fact: 'fact',
  preference: 'preference',
  decision: 'decision',
  experience: 'experience',
  procedure: 'procedure',
  contact: 'relationship',
  relationship: 'relationship',
  task: 'working_state',
  state: 'working_state',
  working_state: 'working_state',
};

function inferredMemoryKind(type: string, requested?: MemoryKind): MemoryKind | null {
  return requested ?? TYPE_MEMORY_KIND[type] ?? null;
}

function memoryKindForItem(authority: Authority, type: string, requested?: MemoryKind): MemoryKind | null {
  if (requested) return requested;
  if (authority === 'app' && type !== 'insight') return null;
  return inferredMemoryKind(type);
}

function inferredInformationClass(
  authority: Authority,
  type: string,
  memoryKind: MemoryKind | null,
): InformationClass {
  if (memoryKind || authority !== 'app' || type === 'insight') return 'memory';
  return 'source';
}

function inferredDecayPolicy(kind: MemoryKind | null, requested?: DecayPolicy): DecayPolicy | null {
  if (requested) return requested;
  if (kind === 'working_state') return 'rapid';
  if (kind === 'experience') return 'standard';
  if (kind) return 'none';
  return null;
}

function validateValidityWindow(validFrom: string | null | undefined, validUntil: string | null | undefined): void {
  if (validFrom && validUntil && validUntil <= validFrom) {
    throw new ValidationError('valid_until must be later than valid_from');
  }
}

/** Server-derived identity of the writer — never taken from request bodies. */
export interface WriteContext {
  clientId: string;
  namespace: string;
  principalKind: PrincipalKind;
  access: ReadAccess;
  isAdmin: boolean;
}

/** Trust verdict for a creation, decided by the policy layer (commands.ts). */
export interface TrustDecision {
  trustState: Extract<TrustState, 'candidate' | 'accepted'>;
  acceptanceMethod: AcceptanceMethod | null;
  policyVersion: number | null;
  ruleId: string | null;
}

export interface ListOptions {
  filters?: ListFilters;
  limit: number;
  cursor?: string;
  sort: 'created' | 'occurred';
  surface: TrustSurface;
}

export interface SearchOptions {
  queries: string[];
  filters?: ListFilters;
  limit: number;
  offset?: number;
  surface: TrustSurface;
  mode?: 'lexical' | 'hybrid';
  entities?: string[];
}

export interface SearchResultItem extends CompactItem {
  score: number;
  retrieval_sources: Array<'lexical' | 'vector' | 'entity'>;
}

export interface RetrievalDiagnostics {
  mode: 'lexical' | 'hybrid';
  embedding_model: string | null;
  candidate_counts: {
    lexical: number;
    vector: number;
    entity: number;
    fused: number;
  };
  elapsed_ms: number;
}

export interface RetrievalProjectionStatus {
  vector_extension_version: string;
  embedding_model: string;
  dimensions: number;
  authoritative_items: number;
  indexed_items: number;
  missing_items: number;
  ready: boolean;
}

export interface SourceOverview {
  source: string;
  name: string | null;
  kind: string | null;
  total: number;
  last_write: string;
  types: Record<string, number>;
}

export interface BriefSource {
  source: string;
  name: string | null;
  items_in_window: number;
  items: CompactItem[];
}

export interface Brief {
  generated_at: string;
  window_days: number;
  pending_candidates: number;
  sources: BriefSource[];
  focus_results?: SearchResultItem[];
}

export interface CurrentContext {
  generated_at: string;
  active_tasks: CompactItem[];
  upcoming_events: CompactItem[];
  current_states: CompactItem[];
  accepted_insights: CompactItem[];
  pending_candidates: number;
}

export interface ItemVersion {
  revision: number;
  snapshot: unknown;
  change_kind: string;
  changed_by: string;
  changed_at: string;
}

export interface ItemReview {
  item_revision: number;
  decision: string;
  decided_by: string;
  decided_at: string;
  note: string | null;
}

interface ItemRow {
  rowid?: number;
  id: string;
  source: string;
  namespace: string;
  type: string;
  title: string;
  content: string;
  data: string | null;
  tags: string;
  entities: string;
  sensitivity: Sensitivity;
  authority: Authority;
  status: ItemStatus;
  trust_state: TrustState;
  acceptance_method: AcceptanceMethod | null;
  accepted_by: string | null;
  accepted_at: string | null;
  acceptance_policy_version: number | null;
  acceptance_rule_id: string | null;
  information_class: InformationClass;
  memory_kind: MemoryKind | null;
  confidence: number | null;
  occurred_at: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  valid_from: string | null;
  valid_until: string | null;
  last_verified_at: string | null;
  decay_policy: DecayPolicy | null;
  source_item_id: string | null;
  source_uri: string | null;
  revision: number;
  successor_of: string | null;
  superseded_by: string | null;
  state_kind: StateKind | null;
  state_key: string | null;
  schema_id: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  deleted: number;
}

function rowToItem(row: ItemRow): ContextItem {
  return {
    id: row.id,
    source: row.source,
    namespace: row.namespace,
    type: row.type,
    title: row.title,
    content: row.content,
    data: row.data == null ? null : JSON.parse(row.data),
    tags: JSON.parse(row.tags),
    entities: JSON.parse(row.entities),
    sensitivity: row.sensitivity,
    authority: row.authority,
    status: row.status,
    trust_state: row.trust_state,
    acceptance_method: row.acceptance_method,
    accepted_by: row.accepted_by,
    accepted_at: row.accepted_at,
    acceptance_policy_version: row.acceptance_policy_version,
    acceptance_rule_id: row.acceptance_rule_id,
    information_class: row.information_class,
    memory_kind: row.memory_kind,
    confidence: row.confidence,
    occurred_at: row.occurred_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    expires_at: row.expires_at,
    valid_from: row.valid_from,
    valid_until: row.valid_until,
    last_verified_at: row.last_verified_at,
    decay_policy: row.decay_policy,
    source_item_id: row.source_item_id,
    source_uri: row.source_uri,
    revision: row.revision,
    derived_from: [], // populated on single-item get()
    successor_of: row.successor_of,
    superseded_by: row.superseded_by,
    state_kind: row.state_kind,
    state_key: row.state_key,
    schema_id: row.schema_id,
    reviewed_by: row.reviewed_by,
    reviewed_at: row.reviewed_at,
    review_note: row.review_note,
  };
}

export function toCompact(item: ContextItem, queryTokens: string[] = []): CompactItem {
  return {
    id: item.id,
    source: item.source,
    type: item.type,
    title: item.title,
    snippet: makeSnippet(item.content || item.title, queryTokens),
    tags: item.tags,
    authority: item.authority,
    status: item.status,
    trust_state: item.trust_state,
    information_class: item.information_class,
    memory_kind: item.memory_kind,
    confidence: item.confidence,
    occurred_at: item.occurred_at,
    created_at: item.created_at,
  };
}

function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function decodeCursor<T>(cursor: string): T | null {
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as T;
  } catch {
    return null;
  }
}

/**
 * Type-aware lifecycle weight (multiplies the RRF relevance score):
 * non-active down-weighted; insights scaled by confidence (candidates halved
 * again on the surfaces that show them); events/notes decay (30d), insights
 * slower (90d), active tasks and durable knowledge never.
 */
function lifecycleFactor(item: ContextItem, now: number): number {
  let factor = 1;
  if (item.status !== 'active') factor *= 0.4;
  if (item.type === 'insight') {
    factor *= item.confidence ?? DEFAULT_INSIGHT_CONFIDENCE;
  }
  if (item.trust_state === 'candidate') factor *= 0.5;

  let halfLifeDays: number | null;
  if (item.decay_policy === 'none') halfLifeDays = null;
  else if (item.decay_policy === 'rapid') halfLifeDays = 14;
  else if (item.decay_policy === 'standard') halfLifeDays = 90;
  else if (NO_DECAY_TYPES.has(item.type)) halfLifeDays = null;
  else if (item.type === 'task') halfLifeDays = item.status === 'active' ? null : 30;
  else if (item.type === 'insight') halfLifeDays = 90;
  else halfLifeDays = 30;

  if (halfLifeDays !== null) {
    const ts = Date.parse(item.last_verified_at ?? item.occurred_at ?? item.valid_from ?? item.created_at);
    const ageDays = Math.max(0, (now - ts) / 86_400_000);
    factor *= Math.pow(0.5, ageDays / halfLifeDays);
  }
  return factor;
}

export type ItemsRepo = ReturnType<typeof createItemsRepo>;

export function createItemsRepo(
  db: DB,
  embeddingProvider: LocalEmbeddingProvider = DEFAULT_LOCAL_EMBEDDING,
) {
  const selectByIdem = db.prepare(
    'SELECT * FROM context_items WHERE source = ? AND idempotency_key = ?',
  );
  const selectBySourceItem = db.prepare(
    'SELECT * FROM context_items WHERE source = ? AND source_item_id = ?',
  );
  const selectById = db.prepare('SELECT * FROM context_items WHERE id = ? AND deleted = 0');
  const selectRowid = db.prepare('SELECT rowid FROM context_items WHERE id = ?');
  const insertStmt = db.prepare(`
    INSERT INTO context_items (
      id, source, namespace, type, title, content, data, tags, entities, sensitivity,
      authority, status, trust_state, acceptance_method, accepted_by, accepted_at,
      acceptance_policy_version, acceptance_rule_id, information_class, memory_kind,
      confidence, occurred_at, created_at, updated_at, expires_at, valid_from, valid_until,
      last_verified_at, decay_policy, source_item_id, source_uri, revision, idempotency_key,
      successor_of, state_kind, state_key, schema_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const contentUpdateStmt = db.prepare(`
    UPDATE context_items SET type = ?, title = ?, content = ?, data = ?, tags = ?,
      entities = ?, sensitivity = ?, status = ?, confidence = ?,
      occurred_at = ?, expires_at = ?, valid_from = ?, valid_until = ?,
      last_verified_at = ?, decay_policy = ?, source_uri = ?, revision = ?, updated_at = ?
    WHERE id = ?
  `);
  const ftsInsert = db.prepare('INSERT INTO items_fts (rowid, title, content, tags) VALUES (?, ?, ?, ?)');
  const ftsDelete = db.prepare('DELETE FROM items_fts WHERE rowid = ?');
  const embeddingUpsert = db.prepare(`
    INSERT INTO item_embeddings (item_id, model, dimensions, content_hash, embedding, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(item_id) DO UPDATE SET
      model = excluded.model,
      dimensions = excluded.dimensions,
      content_hash = excluded.content_hash,
      embedding = excluded.embedding,
      updated_at = excluded.updated_at
  `);
  const embeddingDelete = db.prepare('DELETE FROM item_embeddings WHERE item_id = ?');
  const evidenceInsert = db.prepare('INSERT OR IGNORE INTO insight_evidence (insight_id, evidence_id) VALUES (?, ?)');
  const evidenceClear = db.prepare('DELETE FROM insight_evidence WHERE insight_id = ?');
  const evidenceSelect = db.prepare('SELECT evidence_id FROM insight_evidence WHERE insight_id = ? ORDER BY evidence_id');
  const versionInsert = db.prepare(
    'INSERT INTO item_versions (item_id, revision, snapshot, change_kind, changed_by, changed_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const reviewInsert = db.prepare(
    'INSERT INTO item_reviews (item_id, item_revision, decision, decided_by, decided_at, note) VALUES (?, ?, ?, ?, ?, ?)',
  );

  function indexItem(
    rowid: number | bigint,
    item: Pick<ContextItem, 'id' | 'title' | 'content' | 'tags' | 'entities' | 'state_kind'>,
  ): void {
    // Operational state slots never enter the general read surfaces, so they
    // are not indexed either.
    if (item.state_kind === 'operational') {
      embeddingDelete.run(item.id);
      return;
    }
    ftsInsert.run(rowid, segmentCjk(item.title), segmentCjk(item.content), segmentCjk(item.tags.join(' ')));
    const vector = embeddingProvider.embedItem(item);
    if (vector.length !== embeddingProvider.dimensions) {
      throw new Error(
        `embedding provider ${embeddingProvider.model} returned ${vector.length} dimensions; expected ${embeddingProvider.dimensions}`,
      );
    }
    embeddingUpsert.run(
      item.id,
      embeddingProvider.model,
      embeddingProvider.dimensions,
      embeddingProvider.contentHash(item),
      Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength),
      new Date().toISOString(),
    );
  }

  function reindexItem(
    id: string,
    item: Pick<ContextItem, 'id' | 'title' | 'content' | 'tags' | 'entities' | 'state_kind'>,
  ): void {
    const rid = (selectRowid.get(id) as { rowid: number }).rowid;
    ftsDelete.run(rid);
    indexItem(rid, item);
  }

  /**
   * Append-only version snapshot, written in the SAME transaction as every
   * mutation. `item` must be the post-mutation state.
   */
  function writeVersion(item: ContextItem, changeKind: string, changedBy: string): void {
    versionInsert.run(item.id, item.revision, JSON.stringify(item), changeKind, changedBy, new Date().toISOString());
  }

  function derivedFrom(id: string): string[] {
    return (evidenceSelect.all(id) as { evidence_id: string }[]).map((r) => r.evidence_id);
  }

  /**
   * Validates evidence references for an insight write. Nonexistent,
   * unreadable, and cross-namespace evidence all produce the SAME error so
   * existence is not leaked. Returns the highest sensitivity among the
   * evidence — the insight must inherit it.
   */
  function validateEvidence(ids: string[], writer: WriteContext, selfId?: string): Sensitivity {
    let maxSensitivity: Sensitivity = 'normal';
    for (const id of new Set(ids)) {
      if (selfId && id === selfId) {
        throw new ValidationError('an insight cannot cite itself as evidence');
      }
      const row = selectById.get(id) as ItemRow | undefined;
      const readable =
        row &&
        row.namespace === writer.namespace &&
        (writer.access.readSources === null || writer.access.readSources.includes(row.source)) &&
        (row.sensitivity !== 'private' || writer.access.maxSensitivity === 'private');
      if (!readable) {
        throw new ValidationError(`evidence item "${id}" does not exist or is not readable by this client`);
      }
      if (row!.type === 'insight') {
        throw new ValidationError(
          'insights cannot be used as evidence (evidence must reference non-insight context items)',
        );
      }
      if (row!.sensitivity === 'private') maxSensitivity = 'private';
    }
    return maxSensitivity;
  }

  /** Full replace of an existing row from a NewItem (projection upsert). */
  function replaceRow(existing: ItemRow, input: NewItem, sensitivity: Sensitivity, actor: string): ContextItem {
    validateValidityWindow(input.valid_from, input.valid_until);
    const current = rowToItem(existing);
    const next: ContextItem = {
      ...current,
      type: input.type,
      title: input.title,
      content: input.content,
      data: input.data === undefined ? null : input.data,
      tags: input.tags,
      entities: input.entities,
      sensitivity,
      status: input.status,
      confidence: input.confidence ?? null,
      occurred_at: input.occurred_at ?? null,
      expires_at: input.expires_at ?? null,
      valid_from: input.valid_from ?? null,
      valid_until: input.valid_until ?? null,
      last_verified_at: input.last_verified_at ?? null,
      decay_policy:
        current.information_class === 'memory'
          ? inferredDecayPolicy(current.memory_kind, input.decay_policy)
          : null,
      source_uri: input.source_uri ?? null,
      revision: current.revision + 1,
      updated_at: new Date().toISOString(),
    };
    contentUpdateStmt.run(
      next.type, next.title, next.content,
      next.data === null ? null : JSON.stringify(next.data),
      JSON.stringify(next.tags), JSON.stringify(next.entities),
      next.sensitivity, next.status, next.confidence,
      next.occurred_at, next.expires_at, next.valid_from, next.valid_until,
      next.last_verified_at, next.decay_policy, next.source_uri,
      next.revision, next.updated_at, next.id,
    );
    reindexItem(next.id, next);
    writeVersion(next, 'update', actor);
    return next;
  }

  /**
   * Per-type / per-trust update policy when a write hits an existing
   * (source, source_item_id):
   *  - transaction: dedup-only. Same canonical payload → return existing;
   *    different → 409 (corrections are new records).
   *  - still-candidate own item → refresh in place (any type; nothing
   *    reviewed yet, so nothing can be corrupted).
   *  - accepted + agent writer → 409: accepted memories are immutable for
   *    agents; propose a successor instead.
   *  - accepted + service/human/admin writer → projection upsert (the source
   *    app owns its own current projection; trust metadata is preserved).
   *  - rejected/revoked → 409, propose again under a new source_item_id.
   */
  function handleUpsert(
    existing: ItemRow,
    input: NewItem,
    sensitivity: Sensitivity,
    writer: WriteContext,
  ): { item: ContextItem; created: boolean } {
    if (existing.namespace !== writer.namespace) {
      throw new SourceItemConflictError(
        `source_item_id "${input.source_item_id}" already exists in another namespace`,
      );
    }
    if (existing.state_kind === 'operational') {
      throw new SourceItemConflictError(
        'this id belongs to an operational state slot; use the state update interface',
      );
    }

    if (existing.type === 'transaction' || input.type === 'transaction') {
      const current = rowToItem(existing);
      const same =
        canonicalizeSourcePayload(current) ===
        canonicalizeSourcePayload({
          type: input.type,
          title: input.title,
          content: input.content,
          data: input.data ?? null,
          occurred_at: input.occurred_at ?? null,
          entities: input.entities,
          source_uri: input.source_uri ?? null,
        });
      if (same) return { item: current, created: false };
      throw new SourceItemConflictError(
        `transaction "${existing.source_item_id}" already exists with a different payload; transactions are append-only — write a correction/reversal as a new item`,
      );
    }

    if (existing.trust_state === 'candidate') {
      // In-place refresh of the writer's own unreviewed candidate.
      validateValidityWindow(input.valid_from, input.valid_until);
      const evidenceSensitivity =
        input.type === 'insight' ? validateEvidence(input.derived_from, writer, existing.id) : 'normal';
      const nextSensitivity = evidenceSensitivity === 'private' ? 'private' : input.sensitivity;
      const nextMemoryKind = memoryKindForItem(existing.authority, existing.type, input.memory_kind);
      const nextInformationClass = inferredInformationClass(existing.authority, existing.type, nextMemoryKind);
      const now = new Date().toISOString();
      const res = db
        .prepare(
          `UPDATE context_items SET title = ?, content = ?, data = ?, tags = ?, entities = ?,
             sensitivity = ?, information_class = ?, memory_kind = ?, confidence = ?,
             occurred_at = ?, expires_at = ?, valid_from = ?, valid_until = ?,
             last_verified_at = ?, decay_policy = ?, source_uri = ?,
             revision = revision + 1, updated_at = ?
           WHERE id = ? AND trust_state = 'candidate'`,
        )
        .run(
          input.title, input.content,
          input.data === undefined ? null : JSON.stringify(input.data),
          JSON.stringify(input.tags), JSON.stringify(input.entities),
          nextSensitivity, nextInformationClass, nextMemoryKind, input.confidence ?? null,
          input.occurred_at ?? null, input.expires_at ?? null,
          input.valid_from ?? null, input.valid_until ?? null,
          input.last_verified_at ?? null, inferredDecayPolicy(nextMemoryKind, input.decay_policy),
          input.source_uri ?? null,
          now, existing.id,
        );
      if (res.changes === 0) {
        throw new RevisionConflictError('the item was reviewed concurrently; refresh aborted');
      }
      evidenceClear.run(existing.id);
      for (const ev of new Set(input.derived_from)) evidenceInsert.run(existing.id, ev);
      const fresh = rowToItem(selectById.get(existing.id) as ItemRow);
      reindexItem(fresh.id, fresh);
      writeVersion(fresh, 'revise', writer.clientId);
      fresh.derived_from = derivedFrom(fresh.id);
      return { item: fresh, created: false };
    }

    if (existing.trust_state !== 'accepted') {
      throw new SourceItemConflictError(
        `item "${existing.source_item_id}" was ${existing.trust_state} and is immutable; propose again with a new source_item_id`,
      );
    }
    if (writer.principalKind === 'agent' && !writer.isAdmin) {
      throw new SourceItemConflictError(
        `"${existing.source_item_id}" is an accepted memory and immutable for agents; propose a successor instead`,
      );
    }
    return { item: replaceRow(existing, input, sensitivity, writer.clientId), created: false };
  }

  const insertTx = db.transaction(
    (
      writer: WriteContext,
      input: NewItem,
      authority: Authority,
      trust: TrustDecision,
      extras: { successorOf?: string } = {},
    ): { item: ContextItem; created: boolean } => {
      validateValidityWindow(input.valid_from, input.valid_until);
      if (input.derived_from.length > 0 && input.type !== 'insight') {
        throw new ValidationError('derived_from is only allowed on insight items');
      }
      let sensitivity = input.sensitivity;
      if (input.type === 'insight' && input.derived_from.length > 0) {
        if (validateEvidence(input.derived_from, writer) === 'private') sensitivity = 'private';
      }

      if (extras.successorOf) {
        const pred = selectById.get(extras.successorOf) as ItemRow | undefined;
        const readable =
          pred &&
          pred.namespace === writer.namespace &&
          (writer.access.readSources === null || writer.access.readSources.includes(pred.source)) &&
          (pred.sensitivity !== 'private' || writer.access.maxSensitivity === 'private');
        if (!readable) {
          throw new ValidationError(`predecessor "${extras.successorOf}" does not exist or is not readable`);
        }
        if (pred!.trust_state !== 'accepted') {
          throw new ValidationError('only accepted items can be superseded');
        }
        if (pred!.superseded_by) {
          throw new SourceItemConflictError(`predecessor is already superseded by ${pred!.superseded_by}`);
        }
      }

      if (input.idempotency_key) {
        const existing = selectByIdem.get(writer.clientId, input.idempotency_key) as ItemRow | undefined;
        if (existing) {
          const item = rowToItem(existing);
          if (item.type === 'insight') item.derived_from = derivedFrom(item.id);
          return { item, created: false };
        }
      }
      if (input.source_item_id) {
        const existing = selectBySourceItem.get(writer.clientId, input.source_item_id) as ItemRow | undefined;
        if (existing) return handleUpsert(existing, input, sensitivity, writer);
      }

      const now = new Date().toISOString();
      const accepted = trust.trustState === 'accepted';
      const memoryKind = memoryKindForItem(authority, input.type, input.memory_kind);
      const informationClass = inferredInformationClass(authority, input.type, memoryKind);
      const item: ContextItem = {
        id: ulid(),
        source: writer.clientId,
        namespace: writer.namespace,
        type: input.type,
        title: input.title,
        content: input.content,
        data: input.data === undefined ? null : input.data,
        tags: input.tags,
        entities: input.entities,
        sensitivity,
        authority,
        status: input.status,
        trust_state: trust.trustState,
        acceptance_method: accepted ? trust.acceptanceMethod : null,
        accepted_by: accepted && trust.acceptanceMethod === 'trusted_import' ? writer.clientId : null,
        accepted_at: accepted ? now : null,
        acceptance_policy_version: accepted ? trust.policyVersion : null,
        acceptance_rule_id: accepted ? trust.ruleId : null,
        information_class: informationClass,
        memory_kind: informationClass === 'memory' ? memoryKind : null,
        confidence: input.confidence ?? null,
        occurred_at: input.occurred_at ?? null,
        created_at: now,
        updated_at: now,
        expires_at: input.expires_at ?? null,
        valid_from: input.valid_from ?? null,
        valid_until: input.valid_until ?? null,
        last_verified_at: input.last_verified_at ?? null,
        decay_policy:
          informationClass === 'memory' ? inferredDecayPolicy(memoryKind, input.decay_policy) : null,
        source_item_id: input.source_item_id ?? null,
        source_uri: input.source_uri ?? null,
        revision: 1,
        derived_from: [...new Set(input.derived_from)],
        successor_of: extras.successorOf ?? null,
        superseded_by: null,
        state_kind: input.type === 'state' ? 'semantic' : null,
        state_key: null,
        schema_id: null,
        reviewed_by: null,
        reviewed_at: null,
        review_note: null,
      };
      const res = insertStmt.run(
        item.id, item.source, item.namespace, item.type, item.title, item.content,
        item.data === null ? null : JSON.stringify(item.data),
        JSON.stringify(item.tags), JSON.stringify(item.entities),
        item.sensitivity, item.authority, item.status,
        item.trust_state, item.acceptance_method, item.accepted_by, item.accepted_at,
        item.acceptance_policy_version, item.acceptance_rule_id,
        item.information_class, item.memory_kind,
        item.confidence, item.occurred_at, item.created_at, item.updated_at,
        item.expires_at, item.valid_from, item.valid_until, item.last_verified_at,
        item.decay_policy, item.source_item_id, item.source_uri, item.revision,
        input.idempotency_key ?? null,
        item.successor_of, item.state_kind, item.state_key, item.schema_id,
      );
      indexItem(res.lastInsertRowid, item);
      for (const ev of item.derived_from) evidenceInsert.run(item.id, ev);
      writeVersion(item, 'create', writer.clientId);
      return { item, created: true };
    },
  );

  function insert(
    writer: WriteContext,
    input: NewItem,
    authority: Authority,
    trust: TrustDecision,
    extras?: { successorOf?: string },
  ): { item: ContextItem; created: boolean } {
    return insertTx(writer, input, authority, trust, extras ?? {});
  }

  function insertBatch(
    writer: WriteContext,
    entries: { input: NewItem; authority: Authority; trust: TrustDecision }[],
  ): { item: ContextItem; created: boolean }[] {
    return db.transaction(() => entries.map((e) => insertTx(writer, e.input, e.authority, e.trust, {})))();
  }

  /**
   * Single-item fetch under ACL. Unauthorized, cross-namespace, and
   * nonexistent all return null (routes answer 404 either way).
   * Candidates are visible to their creator (and reviewers/admin via
   * opts.allCandidates); rejected/revoked stay fetchable by exact id for
   * their creator and admin only, including the verdict, so agents can learn
   * why.
   */
  function get(
    access: ReadAccess,
    id: string,
    opts: { allCandidates?: boolean } = {},
  ): ContextItem | null {
    const row = selectById.get(id) as ItemRow | undefined;
    if (!row) return null;
    if (!access.isAdmin && row.namespace !== access.namespace) return null;
    if (
      (row.trust_state === 'rejected' || row.trust_state === 'revoked') &&
      !access.isAdmin &&
      row.source !== access.clientId
    ) {
      return null;
    }
    if (
      row.trust_state === 'candidate' &&
      !access.isAdmin &&
      !opts.allCandidates &&
      row.source !== access.clientId
    ) {
      return null;
    }
    if (row.sensitivity === 'private' && access.maxSensitivity !== 'private') return null;
    if (access.readSources !== null) {
      if (!access.readSources.includes(row.source)) return null;
      if (row.type === 'insight') {
        for (const ev of derivedFrom(row.id)) {
          const evRow = db.prepare('SELECT source FROM context_items WHERE id = ?').get(ev) as
            | { source: string }
            | undefined;
          if (evRow && !access.readSources.includes(evRow.source)) return null;
        }
      }
    }
    const item = rowToItem(row);
    if (item.type === 'insight') item.derived_from = derivedFrom(item.id);
    return item;
  }

  /** Content update primitive — the authorization matrix lives in commands/routes. */
  function update(id: string, patch: PatchItem, actor: string): ContextItem | null {
    return db.transaction((): ContextItem | null => {
      const row = selectById.get(id) as ItemRow | undefined;
      if (!row) return null;
      if (patch.expected_revision !== undefined && patch.expected_revision !== row.revision) {
        throw new RevisionConflictError(
          `revision mismatch: expected ${patch.expected_revision}, current ${row.revision}`,
        );
      }
      const current = rowToItem(row);
      const next: ContextItem = {
        ...current,
        ...('type' in patch && patch.type !== undefined ? { type: patch.type } : {}),
        ...('title' in patch && patch.title !== undefined ? { title: patch.title } : {}),
        ...('content' in patch && patch.content !== undefined ? { content: patch.content } : {}),
        ...('data' in patch ? { data: patch.data ?? null } : {}),
        ...('tags' in patch && patch.tags !== undefined ? { tags: patch.tags } : {}),
        ...('entities' in patch && patch.entities !== undefined ? { entities: patch.entities } : {}),
        ...('sensitivity' in patch && patch.sensitivity !== undefined ? { sensitivity: patch.sensitivity } : {}),
        ...('status' in patch && patch.status !== undefined ? { status: patch.status } : {}),
        ...('confidence' in patch ? { confidence: patch.confidence ?? null } : {}),
        ...('occurred_at' in patch ? { occurred_at: patch.occurred_at ?? null } : {}),
        ...('expires_at' in patch ? { expires_at: patch.expires_at ?? null } : {}),
        ...('valid_from' in patch ? { valid_from: patch.valid_from ?? null } : {}),
        ...('valid_until' in patch ? { valid_until: patch.valid_until ?? null } : {}),
        ...('last_verified_at' in patch ? { last_verified_at: patch.last_verified_at ?? null } : {}),
        ...('decay_policy' in patch ? { decay_policy: patch.decay_policy ?? null } : {}),
        ...('source_uri' in patch ? { source_uri: patch.source_uri ?? null } : {}),
        revision: current.revision + 1,
        updated_at: new Date().toISOString(),
      };
      validateValidityWindow(next.valid_from, next.valid_until);
      contentUpdateStmt.run(
        next.type, next.title, next.content,
        next.data === null ? null : JSON.stringify(next.data),
        JSON.stringify(next.tags), JSON.stringify(next.entities),
        next.sensitivity, next.status, next.confidence,
        next.occurred_at, next.expires_at, next.valid_from, next.valid_until,
        next.last_verified_at, next.decay_policy, next.source_uri,
        next.revision, next.updated_at, next.id,
      );
      reindexItem(id, next);
      writeVersion(next, 'update', actor);
      return next;
    })();
  }

  /**
   * Adjudicate a candidate (accept/reject) or revoke an accepted item.
   * Exactly-once, guarded by expected_revision. Accepting a successor
   * atomically supersedes its predecessor in the SAME transaction — review
   * event, both version snapshots, and the trust flip commit or roll back
   * together. Rejected/revoked are final.
   */
  function review(
    id: string,
    opts: {
      decision: 'accept' | 'reject' | 'revoke';
      reviewedBy: string;
      expectedRevision: number;
      note?: string;
    },
  ): ContextItem | null {
    return db.transaction((): ContextItem | null => {
      const row = selectById.get(id) as ItemRow | undefined;
      if (!row) return null;
      const now = new Date().toISOString();

      if (opts.decision === 'revoke') {
        if (row.trust_state !== 'accepted') {
          throw new SourceItemConflictError('only accepted items can be revoked');
        }
        const res = db
          .prepare(
            `UPDATE context_items SET trust_state = 'revoked', reviewed_by = ?, reviewed_at = ?, review_note = ?,
               revision = revision + 1, updated_at = ?
             WHERE id = ? AND trust_state = 'accepted' AND revision = ?`,
          )
          .run(opts.reviewedBy, now, opts.note ?? null, now, id, opts.expectedRevision);
        if (res.changes === 0) {
          throw new RevisionConflictError(
            `revision mismatch: expected ${opts.expectedRevision}, current ${row.revision} — re-read before revoking`,
          );
        }
      } else {
        if (row.trust_state !== 'candidate') {
          throw new SourceItemConflictError(
            row.trust_state === 'rejected' || row.trust_state === 'revoked'
              ? `${row.trust_state} items cannot be reopened; submit a new proposal`
              : 'this item has already been reviewed',
          );
        }
        const nextTrust = opts.decision === 'accept' ? 'accepted' : 'rejected';
        const res = db
          .prepare(
            `UPDATE context_items SET trust_state = ?, acceptance_method = ?, accepted_by = ?, accepted_at = ?,
               reviewed_by = ?, reviewed_at = ?, review_note = ?, revision = revision + 1, updated_at = ?
             WHERE id = ? AND trust_state = 'candidate' AND revision = ?`,
          )
          .run(
            nextTrust,
            nextTrust === 'accepted' ? 'human_review' : null,
            nextTrust === 'accepted' ? opts.reviewedBy : null,
            nextTrust === 'accepted' ? now : null,
            opts.reviewedBy, now, opts.note ?? null, now,
            id, opts.expectedRevision,
          );
        if (res.changes === 0) {
          throw new RevisionConflictError(
            `revision mismatch: expected ${opts.expectedRevision}, current ${row.revision} — re-read before reviewing`,
          );
        }
      }

      const fresh = rowToItem(selectById.get(id) as ItemRow);
      reviewInsert.run(id, fresh.revision, opts.decision, opts.reviewedBy, now, opts.note ?? null);
      writeVersion(fresh, opts.decision, opts.reviewedBy);

      // Atomic single-winner supersession.
      if (opts.decision === 'accept' && fresh.successor_of) {
        const pred = selectById.get(fresh.successor_of) as ItemRow | undefined;
        if (pred && !pred.superseded_by) {
          db.prepare(
            `UPDATE context_items SET status = 'superseded', superseded_by = ?, revision = revision + 1, updated_at = ?
             WHERE id = ?`,
          ).run(fresh.id, now, pred.id);
          const supersededItem = rowToItem(selectById.get(pred.id) as ItemRow);
          writeVersion(supersededItem, 'supersede', opts.reviewedBy);
        }
      }

      fresh.derived_from = derivedFrom(id);
      return fresh;
    })();
  }

  function softDelete(id: string, actor: string): boolean {
    return db.transaction((): boolean => {
      const row = selectById.get(id) as ItemRow | undefined;
      if (!row) return false;
      db.prepare('UPDATE context_items SET deleted = 1, revision = revision + 1, updated_at = ? WHERE id = ?').run(
        new Date().toISOString(),
        id,
      );
      const rid = (selectRowid.get(id) as { rowid: number }).rowid;
      ftsDelete.run(rid);
      embeddingDelete.run(id);
      const fresh = db.prepare('SELECT * FROM context_items WHERE id = ?').get(id) as ItemRow;
      writeVersion(rowToItem(fresh), 'delete', actor);
      return true;
    })();
  }

  /**
   * Hard removal for true deletion requests (admin only, via commands).
   * Removes the item, its versions, reviews, evidence edges, and FTS entry.
   * The caller writes an audit metadata row; backups age out on rotation.
   */
  function purge(id: string): boolean {
    return db.transaction((): boolean => {
      const row = db.prepare('SELECT * FROM context_items WHERE id = ?').get(id) as ItemRow | undefined;
      if (!row) return false;
      const rid = (selectRowid.get(id) as { rowid: number }).rowid;
      ftsDelete.run(rid);
      embeddingDelete.run(id);
      db.prepare('DELETE FROM insight_evidence WHERE insight_id = ? OR evidence_id = ?').run(id, id);
      db.prepare('DELETE FROM item_versions WHERE item_id = ?').run(id);
      db.prepare('DELETE FROM item_reviews WHERE item_id = ?').run(id);
      db.prepare('DELETE FROM context_items WHERE id = ?').run(id);
      return true;
    })();
  }

  /** Version history + review events for an item the caller may read. */
  function history(
    access: ReadAccess,
    id: string,
    opts: { allCandidates?: boolean } = {},
  ): { item_id: string; versions: ItemVersion[]; reviews: ItemReview[] } | null {
    const item = get(access, id, opts);
    if (!item) return null;
    const versions = (
      db
        .prepare('SELECT revision, snapshot, change_kind, changed_by, changed_at FROM item_versions WHERE item_id = ? ORDER BY revision')
        .all(id) as { revision: number; snapshot: string; change_kind: string; changed_by: string; changed_at: string }[]
    ).map((v) => ({ ...v, snapshot: JSON.parse(v.snapshot) as unknown }));
    const reviews = db
      .prepare('SELECT item_revision, decision, decided_by, decided_at, note FROM item_reviews WHERE item_id = ? ORDER BY id')
      .all(id) as ItemReview[];
    return { item_id: id, versions, reviews };
  }

  /**
   * Appends every namespace, trust, ACL, and visibility condition. ALL
   * list-shaped reads flow through here, so a new route cannot forget the
   * namespace boundary, the trust surface, source whitelists, the sensitivity
   * ceiling, or the operational-state exclusion.
   */
  function applyFilters(
    where: string[],
    params: unknown[],
    filters: ListFilters | undefined,
    now: string,
    access: ReadAccess,
    surface: TrustSurface,
    alias = 'i',
  ): void {
    // Namespace boundary FIRST. A non-admin access without a namespace is a
    // programming error — refuse loudly rather than leak.
    if (!access.isAdmin) {
      if (!access.namespace) throw new Error('BUG: non-admin ReadAccess without a namespace');
      where.push(`${alias}.namespace = ?`);
      params.push(access.namespace);
    }

    where.push(`${alias}.deleted = 0`);
    where.push(`(${alias}.expires_at IS NULL OR ${alias}.expires_at > ?)`);
    params.push(now);
    where.push(`(${alias}.valid_from IS NULL OR ${alias}.valid_from <= ?)`);
    params.push(now);
    where.push(`(${alias}.valid_until IS NULL OR ${alias}.valid_until > ?)`);
    params.push(now);
    // Operational state slots have their own read surface (state rules).
    where.push(`(${alias}.state_kind IS NULL OR ${alias}.state_kind != 'operational')`);

    // Trust surface — candidates are excluded in SQL, before FTS ranking,
    // counting, or snippeting. rejected/revoked never appear in any list.
    switch (surface) {
      case 'accepted':
        where.push(`${alias}.trust_state = 'accepted'`);
        break;
      case 'plus_own':
        where.push(`(${alias}.trust_state = 'accepted' OR (${alias}.trust_state = 'candidate' AND ${alias}.source = ?))`);
        params.push(access.clientId);
        break;
      case 'plus_all':
        where.push(`${alias}.trust_state IN ('accepted','candidate')`);
        break;
      case 'own_candidates':
        where.push(`${alias}.trust_state = 'candidate' AND ${alias}.source = ?`);
        params.push(access.clientId);
        break;
      case 'inbox':
        where.push(`${alias}.trust_state = 'candidate'`);
        break;
    }

    // Source ACL: intersect the requested filter with the client whitelist.
    // readSources [] means "no sources" — never treat it as falsy/all.
    let effectiveSources = filters?.sources;
    if (access.readSources !== null) {
      effectiveSources = effectiveSources
        ? effectiveSources.filter((s) => access.readSources!.includes(s))
        : access.readSources;
      if (effectiveSources.length === 0) {
        where.push('0 = 1');
        return;
      }
      // Insight ACL inheritance: an insight is invisible when ANY of its
      // evidence comes from a source outside the whitelist.
      where.push(`NOT EXISTS (
        SELECT 1 FROM insight_evidence ie
        JOIN context_items ev ON ev.id = ie.evidence_id
        WHERE ie.insight_id = ${alias}.id
          AND ev.source NOT IN (${access.readSources.map(() => '?').join(',')})
      )`);
      params.push(...access.readSources);
    }
    if (effectiveSources?.length) {
      where.push(`${alias}.source IN (${effectiveSources.map(() => '?').join(',')})`);
      params.push(...effectiveSources);
    }

    const sensitivity = clampSensitivity(filters?.sensitivity, access.maxSensitivity);
    if (sensitivity !== 'all') {
      where.push(`${alias}.sensitivity = ?`);
      params.push(sensitivity);
    }

    if (filters?.types?.length) {
      where.push(`${alias}.type IN (${filters.types.map(() => '?').join(',')})`);
      params.push(...filters.types);
    }
    if (filters?.statuses?.length) {
      where.push(`${alias}.status IN (${filters.statuses.map(() => '?').join(',')})`);
      params.push(...filters.statuses);
    }
    for (const tag of filters?.tags ?? []) {
      where.push(`EXISTS (SELECT 1 FROM json_each(${alias}.tags) WHERE json_each.value = ?)`);
      params.push(tag);
    }
    if (filters?.since) {
      where.push(`COALESCE(${alias}.occurred_at, ${alias}.created_at) >= ?`);
      params.push(filters.since);
    }
    if (filters?.until) {
      where.push(`COALESCE(${alias}.occurred_at, ${alias}.created_at) <= ?`);
      params.push(filters.until);
    }
  }

  function list(access: ReadAccess, opts: ListOptions): { items: ContextItem[]; nextCursor?: string } {
    const now = new Date().toISOString();
    const where: string[] = [];
    const params: unknown[] = [];
    applyFilters(where, params, opts.filters, now, access, opts.surface);

    const keyExpr = 'COALESCE(i.occurred_at, i.created_at)';
    let orderBy: string;
    if (opts.sort === 'occurred') {
      orderBy = `${keyExpr} DESC, i.id DESC`;
      if (opts.cursor) {
        const cur = decodeCursor<{ k: string; id: string }>(opts.cursor);
        if (cur) {
          where.push(`(${keyExpr} < ? OR (${keyExpr} = ? AND i.id < ?))`);
          params.push(cur.k, cur.k, cur.id);
        }
      }
    } else {
      orderBy = 'i.id DESC';
      if (opts.cursor) {
        const cur = decodeCursor<{ id: string }>(opts.cursor);
        if (cur) {
          where.push('i.id < ?');
          params.push(cur.id);
        }
      }
    }

    const rows = db
      .prepare(`SELECT i.* FROM context_items i WHERE ${where.join(' AND ')} ORDER BY ${orderBy} LIMIT ?`)
      .all(...params, opts.limit + 1) as ItemRow[];

    const items = rows.slice(0, opts.limit).map(rowToItem);
    let nextCursor: string | undefined;
    if (rows.length > opts.limit && items.length > 0) {
      const last = items[items.length - 1]!;
      nextCursor =
        opts.sort === 'occurred'
          ? encodeCursor({ k: last.occurred_at ?? last.created_at, id: last.id })
          : encodeCursor({ id: last.id });
    }
    return { items, nextCursor };
  }

  /**
   * v6 hybrid retrieval. Every candidate source embeds applyFilters() in its
   * SQL before ranking, then weighted RRF combines lexical, local-vector and
   * entity matches. The vector table is never queried as an authority.
   */
  function search(
    access: ReadAccess,
    opts: SearchOptions,
  ): {
    items: SearchResultItem[];
    fullItems: ContextItem[];
    totalMatched: number;
    retrieval: RetrievalDiagnostics;
  } {
    const started = performance.now();
    const nowIso = new Date().toISOString();
    const nowMs = Date.now();
    // Repository callers retain the v5 lexical default unless the domain
    // command/compiler explicitly opts into v6 hybrid retrieval.
    const mode = opts.mode ?? 'lexical';
    type CandidateSource = 'lexical' | 'vector' | 'entity';
    const fused = new Map<
      string,
      { item: ContextItem; rrf: number; sources: Set<CandidateSource> }
    >();
    const sourceIds: Record<CandidateSource, Set<string>> = {
      lexical: new Set(),
      vector: new Set(),
      entity: new Set(),
    };

    function accumulate(rows: ItemRow[], source: CandidateSource, weight: number): void {
      rows.forEach((row, i) => {
        sourceIds[source].add(row.id);
        const entry = fused.get(row.id);
        const contribution = weight / (RRF_K + i + 1);
        if (entry) {
          entry.rrf += contribution;
          entry.sources.add(source);
        } else {
          fused.set(row.id, { item: rowToItem(row), rrf: contribution, sources: new Set([source]) });
        }
      });
    }

    for (const q of opts.queries) {
      const ftsQ = buildFtsQuery(q);
      if (!ftsQ) continue;
      const where: string[] = ['items_fts MATCH ?'];
      const params: unknown[] = [ftsQ];
      applyFilters(where, params, opts.filters, nowIso, access, opts.surface);
      try {
        accumulate(
          db
            .prepare(
              `SELECT i.* FROM items_fts JOIN context_items i ON i.rowid = items_fts.rowid
               WHERE ${where.join(' AND ')}
               ORDER BY bm25(items_fts, 3.0, 1.0, 2.0) LIMIT ?`,
            )
            .all(...params, FTS_CANDIDATES) as ItemRow[],
          'lexical',
          1,
        );
      } catch {
        continue; // malformed FTS syntax after sanitization — skip this query
      }
    }

    if (sourceIds.lexical.size === 0) {
      for (const q of opts.queries) {
        const trimmed = q.trim();
        if (!trimmed) continue;
        const pat = '%' + trimmed.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
        const where: string[] = [
          "(i.title LIKE ? ESCAPE '\\' OR i.content LIKE ? ESCAPE '\\' OR i.tags LIKE ? ESCAPE '\\')",
        ];
        const params: unknown[] = [pat, pat, pat];
        applyFilters(where, params, opts.filters, nowIso, access, opts.surface);
        accumulate(
          db
            .prepare(`SELECT i.* FROM context_items i WHERE ${where.join(' AND ')} ORDER BY i.id DESC LIMIT ?`)
            .all(...params, LIKE_CANDIDATES) as ItemRow[],
          'lexical',
          0.9,
        );
      }
    }

    if (mode === 'hybrid') {
      for (const q of opts.queries) {
        if (!q.trim()) continue;
        const queryVector = embeddingProvider.embedQuery(q);
        if (queryVector.length !== embeddingProvider.dimensions) {
          throw new Error(
            `embedding provider ${embeddingProvider.model} returned ${queryVector.length} dimensions; expected ${embeddingProvider.dimensions}`,
          );
        }
        const hasSignal = queryVector.some((value) => value !== 0);
        if (!hasSignal) continue;
        const where: string[] = [
          'e.model = ?',
          'e.dimensions = ?',
        ];
        const vectorBlob = Buffer.from(queryVector.buffer, queryVector.byteOffset, queryVector.byteLength);
        const params: unknown[] = [vectorBlob, embeddingProvider.model, embeddingProvider.dimensions];
        applyFilters(where, params, opts.filters, nowIso, access, opts.surface);
        const rows = db
          .prepare(
            `SELECT ranked.* FROM (
               SELECT i.*, vec_distance_cosine(e.embedding, ?) AS vector_distance
               FROM item_embeddings e JOIN context_items i ON i.id = e.item_id
               WHERE ${where.join(' AND ')}
             ) ranked
             WHERE ranked.vector_distance <= ?
             ORDER BY ranked.vector_distance, ranked.id DESC
             LIMIT ?`,
          )
          .all(...params, MAX_VECTOR_DISTANCE, VECTOR_CANDIDATES) as ItemRow[];
        accumulate(rows, 'vector', 0.85);
      }

      const inferredTerms = opts.queries.flatMap(
        (q) => q.normalize('NFKC').toLocaleLowerCase().match(/[\p{L}\p{N}_:-]{2,}/gu) ?? [],
      );
      const entityTerms = [...new Set([...(opts.entities ?? []), ...inferredTerms])].slice(0, 20);
      for (const term of entityTerms) {
        const normalized = term.normalize('NFKC').toLocaleLowerCase().trim();
        if (!normalized) continue;
        const escaped = normalized.replace(/[\\%_]/g, (char) => `\\${char}`);
        const where: string[] = [
          `EXISTS (
             SELECT 1 FROM json_each(i.entities) entity
             WHERE lower(entity.value) = ? OR lower(entity.value) LIKE ? ESCAPE '\\'
           )`,
        ];
        const params: unknown[] = [normalized, `%${escaped}%`];
        applyFilters(where, params, opts.filters, nowIso, access, opts.surface);
        const rows = db
          .prepare(
            `SELECT i.* FROM context_items i
             WHERE ${where.join(' AND ')}
             ORDER BY COALESCE(i.last_verified_at, i.occurred_at, i.updated_at) DESC
             LIMIT ?`,
          )
          .all(...params, ENTITY_CANDIDATES) as ItemRow[];
        accumulate(rows, 'entity', 0.95);
      }
    }

    const tokens = opts.queries.flatMap((q) => q.trim().split(/\s+/)).filter(Boolean);
    const scored = [...fused.values()]
      .map(({ item, rrf, sources }) => ({
        item,
        sources,
        score: rrf * lifecycleFactor(item, nowMs),
      }))
      .sort((a, b) => b.score - a.score);
    const offset = opts.offset ?? 0;
    const top = scored.slice(offset, offset + opts.limit);
    return {
      items: top.map(({ item, score, sources }) => ({
        ...toCompact(item, tokens),
        score: Number(score.toFixed(6)),
        retrieval_sources: [...sources],
      })),
      fullItems: top.map(({ item }) => item),
      totalMatched: fused.size,
      retrieval: {
        mode,
        embedding_model: mode === 'hybrid' ? embeddingProvider.model : null,
        candidate_counts: {
          lexical: sourceIds.lexical.size,
          vector: sourceIds.vector.size,
          entity: sourceIds.entity.size,
          fused: fused.size,
        },
        elapsed_ms: Number((performance.now() - started).toFixed(3)),
      },
    };
  }

  function sourcesOverview(access: ReadAccess): SourceOverview[] {
    // Counts reflect what this caller could actually read on the default
    // surface: same namespace, accepted only, within the sensitivity ceiling,
    // no operational state slots.
    const rows = db
      .prepare(
        `SELECT i.source AS source, c.name AS name, c.kind AS kind, i.type AS type,
                COUNT(*) AS n, MAX(i.created_at) AS last_write
         FROM context_items i LEFT JOIN clients c ON c.id = i.source
         WHERE i.deleted = 0
           AND (? IS NULL OR i.namespace = ?)
           AND i.trust_state = 'accepted'
           AND (i.state_kind IS NULL OR i.state_kind != 'operational')
           AND (i.expires_at IS NULL OR i.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))
           AND (i.valid_from IS NULL OR i.valid_from <= strftime('%Y-%m-%dT%H:%M:%fZ','now'))
           AND (i.valid_until IS NULL OR i.valid_until > strftime('%Y-%m-%dT%H:%M:%fZ','now'))
           AND (? = 'private' OR i.sensitivity = 'normal')
         GROUP BY i.source, i.type`,
      )
      .all(
        access.isAdmin ? null : access.namespace,
        access.isAdmin ? null : access.namespace,
        access.maxSensitivity,
      ) as { source: string; name: string | null; kind: string | null; type: string; n: number; last_write: string }[];
    const bySource = new Map<string, SourceOverview>();
    for (const row of rows) {
      if (access.readSources !== null && !access.readSources.includes(row.source)) continue;
      let entry = bySource.get(row.source);
      if (!entry) {
        entry = { source: row.source, name: row.name, kind: row.kind, total: 0, last_write: row.last_write, types: {} };
        bySource.set(row.source, entry);
      }
      entry.total += row.n;
      entry.types[row.type] = row.n;
      if (row.last_write > entry.last_write) entry.last_write = row.last_write;
    }
    return [...bySource.values()].sort((a, b) => (a.last_write < b.last_write ? 1 : -1));
  }

  /** Count of candidates on the given surface, full ACL applied. */
  function countCandidates(access: ReadAccess, surface: 'own_candidates' | 'inbox'): number {
    const now = new Date().toISOString();
    const where: string[] = [];
    const params: unknown[] = [];
    applyFilters(where, params, {}, now, access, surface);
    const row = db
      .prepare(`SELECT COUNT(*) AS n FROM context_items i WHERE ${where.join(' AND ')}`)
      .get(...params) as { n: number };
    return row.n;
  }

  /** Candidate listing for the my_candidates / reviewer inbox surfaces. */
  function listCandidates(
    access: ReadAccess,
    surface: 'own_candidates' | 'inbox',
    limit: number,
  ): ContextItem[] {
    const { items } = list(access, { limit, sort: 'created', surface });
    return items;
  }

  /**
   * One-call situational digest over the ACCEPTED surface. Candidates appear
   * only as the caller's own pending count.
   */
  function brief(
    access: ReadAccess,
    opts: { days: number; focus?: string; perSource?: number; sensitivity?: ListFilters['sensitivity'] },
  ): Brief {
    const perSource = opts.perSource ?? 5;
    const since = new Date(Date.now() - opts.days * 86_400_000).toISOString();
    const sensitivity = opts.sensitivity ?? 'normal';
    const sources: BriefSource[] = [];
    for (const src of sourcesOverview(access)) {
      const windowed = list(access, {
        filters: { sources: [src.source], since, sensitivity },
        limit: perSource,
        sort: 'occurred',
        surface: 'accepted',
      });
      const where: string[] = [];
      const params: unknown[] = [];
      applyFilters(where, params, { sources: [src.source], since, sensitivity }, new Date().toISOString(), access, 'accepted');
      const countRow = db
        .prepare(`SELECT COUNT(*) AS n FROM context_items i WHERE ${where.join(' AND ')}`)
        .get(...params) as { n: number };
      sources.push({
        source: src.source,
        name: src.name,
        items_in_window: countRow.n,
        items: windowed.items.map((it) => toCompact(it)),
      });
    }
    const result: Brief = {
      generated_at: new Date().toISOString(),
      window_days: opts.days,
      pending_candidates: countCandidates(access, access.isAdmin ? 'inbox' : 'own_candidates'),
      sources,
    };
    if (opts.focus?.trim()) {
      result.focus_results = search(access, {
        queries: [opts.focus],
        filters: { sensitivity },
        limit: 10,
        surface: 'accepted',
      }).items;
    }
    return result;
  }

  /**
   * "What is true right now": accepted ∧ active ∧ not expired, per type.
   * Candidates appear only as the caller's own pending count.
   */
  function currentContext(
    access: ReadAccess,
    opts: { sensitivity?: ListFilters['sensitivity']; perSection?: number },
  ): CurrentContext {
    const n = opts.perSection ?? 10;
    const nowIso = new Date().toISOString();
    const sensitivity = opts.sensitivity ?? 'normal';

    function section(extraWhere: string, extraParams: unknown[], orderBy: string): CompactItem[] {
      const where: string[] = [];
      const params: unknown[] = [];
      applyFilters(where, params, { sensitivity }, nowIso, access, 'accepted');
      where.push(extraWhere);
      params.push(...extraParams);
      const rows = db
        .prepare(`SELECT i.* FROM context_items i WHERE ${where.join(' AND ')} ORDER BY ${orderBy} LIMIT ?`)
        .all(...params, n) as ItemRow[];
      return rows.map((r) => toCompact(rowToItem(r)));
    }

    return {
      generated_at: nowIso,
      active_tasks: section(
        "i.type = 'task' AND i.status = 'active'",
        [],
        'COALESCE(i.occurred_at, i.created_at) ASC', // nearest deadline first
      ),
      upcoming_events: section(
        "i.type = 'event' AND i.status = 'active' AND i.occurred_at >= ?",
        [nowIso],
        'i.occurred_at ASC',
      ),
      current_states: section(
        "i.type IN ('state','fact','contact','preference','memory') AND i.status = 'active'",
        [],
        'i.updated_at DESC',
      ),
      accepted_insights: section(
        "i.type = 'insight' AND i.status = 'active'",
        [],
        'i.id DESC',
      ),
      pending_candidates: countCandidates(access, access.isAdmin ? 'inbox' : 'own_candidates'),
    };
  }

  // --- operational state slots ---

  function getStateByKey(namespace: string, stateKey: string): ContextItem | null {
    const row = db
      .prepare('SELECT * FROM context_items WHERE namespace = ? AND state_key = ? AND deleted = 0')
      .get(namespace, stateKey) as ItemRow | undefined;
    return row ? rowToItem(row) : null;
  }

  /**
   * Create-or-update an operational state slot. Field-level authorization
   * (mutable_fields, schema validation, write_clients) happens in commands —
   * this is the storage mechanic with optimistic concurrency.
   */
  function upsertOperationalState(
    writer: WriteContext,
    input: {
      stateKey: string;
      schemaId: string;
      title?: string;
      value?: unknown;
      observedAt?: string | null;
      expiresAt?: string | null;
      status?: ItemStatus;
      expectedRevision?: number;
    },
    trust: TrustDecision,
  ): { item: ContextItem; created: boolean } {
    return db.transaction((): { item: ContextItem; created: boolean } => {
      const existing = db
        .prepare('SELECT * FROM context_items WHERE namespace = ? AND state_key = ? AND deleted = 0')
        .get(writer.namespace, input.stateKey) as ItemRow | undefined;
      const now = new Date().toISOString();

      if (!existing) {
        const item: ContextItem = {
          id: ulid(),
          source: writer.clientId,
          namespace: writer.namespace,
          type: 'state',
          title: input.title ?? `state:${input.stateKey}`,
          content: '',
          data: { value: input.value ?? null, observed_at: input.observedAt ?? now },
          tags: [],
          entities: [],
          sensitivity: 'normal',
          authority: 'app',
          status: input.status ?? 'active',
          trust_state: 'accepted',
          acceptance_method: 'policy',
          accepted_by: null,
          accepted_at: now,
          acceptance_policy_version: trust.policyVersion,
          acceptance_rule_id: trust.ruleId,
          information_class: 'task_state',
          memory_kind: null,
          confidence: null,
          occurred_at: null,
          created_at: now,
          updated_at: now,
          expires_at: input.expiresAt ?? null,
          valid_from: null,
          valid_until: null,
          last_verified_at: input.observedAt ?? now,
          decay_policy: null,
          source_item_id: null,
          source_uri: null,
          revision: 1,
          derived_from: [],
          successor_of: null,
          superseded_by: null,
          state_kind: 'operational',
          state_key: input.stateKey,
          schema_id: input.schemaId,
          reviewed_by: null,
          reviewed_at: null,
          review_note: null,
        };
        insertStmt.run(
          item.id, item.source, item.namespace, item.type, item.title, item.content,
          JSON.stringify(item.data),
          '[]', '[]', item.sensitivity, item.authority, item.status,
          item.trust_state, item.acceptance_method, item.accepted_by, item.accepted_at,
          item.acceptance_policy_version, item.acceptance_rule_id,
          item.information_class, item.memory_kind,
          null, null, item.created_at, item.updated_at,
          item.expires_at, null, null, item.last_verified_at, null,
          null, null, 1, null,
          null, item.state_kind, item.state_key, item.schema_id,
        );
        writeVersion(item, 'create', writer.clientId);
        return { item, created: true };
      }

      if (input.expectedRevision === undefined) {
        throw new RevisionConflictError('expected_revision is required when updating an existing state slot');
      }
      if (existing.revision !== input.expectedRevision) {
        throw new RevisionConflictError(
          `revision mismatch: expected ${input.expectedRevision}, current ${existing.revision}`,
        );
      }
      const current = rowToItem(existing);
      const data = (current.data ?? {}) as Record<string, unknown>;
      if (input.value !== undefined) data.value = input.value;
      if (input.observedAt !== undefined) data.observed_at = input.observedAt;
      const next: ContextItem = {
        ...current,
        data,
        status: input.status ?? current.status,
        expires_at: input.expiresAt !== undefined ? input.expiresAt : current.expires_at,
        last_verified_at: input.observedAt ?? current.last_verified_at,
        revision: current.revision + 1,
        updated_at: now,
      };
      db.prepare(
        'UPDATE context_items SET data = ?, status = ?, expires_at = ?, last_verified_at = ?, revision = ?, updated_at = ? WHERE id = ?',
      ).run(JSON.stringify(next.data), next.status, next.expires_at, next.last_verified_at, next.revision, next.updated_at, next.id);
      writeVersion(next, 'state_update', writer.clientId);
      return { item: next, created: false };
    })();
  }

  /** Rebuild every retrieval projection from authoritative context_items. */
  function reindex(): { indexed: number; vectorIndexed: number } {
    return db.transaction((): { indexed: number; vectorIndexed: number } => {
      db.exec('DELETE FROM items_fts');
      db.exec('DELETE FROM item_embeddings');
      const rows = db
        .prepare(
          `SELECT rowid, id, title, content, tags, entities, state_kind FROM context_items
           WHERE deleted = 0 AND (state_kind IS NULL OR state_kind != 'operational')`,
        )
        .all() as {
        rowid: number;
        id: string;
        title: string;
        content: string;
        tags: string;
        entities: string;
        state_kind: StateKind | null;
      }[];
      for (const r of rows) {
        indexItem(r.rowid, {
          ...r,
          tags: JSON.parse(r.tags) as string[],
          entities: JSON.parse(r.entities) as string[],
        });
      }
      return { indexed: rows.length, vectorIndexed: rows.length };
    })();
  }

  function retrievalProjectionStatus(): RetrievalProjectionStatus {
    const authoritative = db
      .prepare(
        `SELECT COUNT(*) AS n FROM context_items
         WHERE deleted = 0 AND (state_kind IS NULL OR state_kind != 'operational')`,
      )
      .get() as { n: number };
    const indexed = db
      .prepare(
        `SELECT COUNT(*) AS n
         FROM item_embeddings e JOIN context_items i ON i.id = e.item_id
         WHERE i.deleted = 0
           AND (i.state_kind IS NULL OR i.state_kind != 'operational')
           AND e.model = ? AND e.dimensions = ?`,
      )
      .get(embeddingProvider.model, embeddingProvider.dimensions) as { n: number };
    const version = db.prepare('SELECT vec_version() AS version').get() as { version: string };
    const missing = Math.max(0, authoritative.n - indexed.n);
    return {
      vector_extension_version: version.version,
      embedding_model: embeddingProvider.model,
      dimensions: embeddingProvider.dimensions,
      authoritative_items: authoritative.n,
      indexed_items: indexed.n,
      missing_items: missing,
      ready: missing === 0,
    };
  }

  return {
    insert,
    insertBatch,
    get,
    update,
    review,
    softDelete,
    purge,
    history,
    list,
    search,
    sourcesOverview,
    countCandidates,
    listCandidates,
    brief,
    currentContext,
    getStateByKey,
    upsertOperationalState,
    reindex,
    retrievalProjectionStatus,
  };
}
