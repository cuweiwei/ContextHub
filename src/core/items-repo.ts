import type { DB } from '../db/connection.js';
import { ulid } from './ids.js';
import { buildFtsQuery, makeSnippet, segmentCjk } from './cjk.js';
import { canonicalizeSourcePayload } from './canonical.js';
import { RevisionConflictError, SourceItemConflictError, ValidationError } from './errors.js';
import {
  clampSensitivity,
  type Acceptance,
  type Authority,
  type CompactItem,
  type ContextItem,
  type ListFilters,
  type NewItem,
  type PatchItem,
  type ReadAccess,
  type Sensitivity,
} from './types.js';

const FTS_CANDIDATES = 500;
const LIKE_CANDIDATES = 200;
/** Reciprocal Rank Fusion constant (standard value from the RRF paper). */
const RRF_K = 60;
/** Types whose relevance should NOT decay with age (durable knowledge). */
const NO_DECAY_TYPES = new Set(['fact', 'state', 'contact', 'preference']);
const DEFAULT_INSIGHT_CONFIDENCE = 0.7;

export interface ListOptions {
  filters?: ListFilters;
  limit: number;
  cursor?: string;
  sort: 'created' | 'occurred';
}

export interface SearchOptions {
  queries: string[];
  filters?: ListFilters;
  limit: number;
  offset?: number;
}

export interface SearchResultItem extends CompactItem {
  score: number;
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
  proposed_insights: number;
  sources: BriefSource[];
  focus_results?: SearchResultItem[];
}

export interface CurrentContext {
  generated_at: string;
  active_tasks: CompactItem[];
  upcoming_events: CompactItem[];
  current_states: CompactItem[];
  accepted_insights: CompactItem[];
  proposed_insights: number;
}

interface ItemRow {
  rowid?: number;
  id: string;
  source: string;
  type: string;
  title: string;
  content: string;
  data: string | null;
  tags: string;
  entities: string;
  sensitivity: Sensitivity;
  authority: Authority;
  status: ContextItem['status'];
  acceptance: Acceptance | null;
  confidence: number | null;
  occurred_at: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  source_item_id: string | null;
  source_uri: string | null;
  revision: number;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  deleted: number;
}

function rowToItem(row: ItemRow): ContextItem {
  return {
    id: row.id,
    source: row.source,
    type: row.type,
    title: row.title,
    content: row.content,
    data: row.data == null ? null : JSON.parse(row.data),
    tags: JSON.parse(row.tags),
    entities: JSON.parse(row.entities),
    sensitivity: row.sensitivity,
    authority: row.authority,
    status: row.status,
    acceptance: row.acceptance,
    confidence: row.confidence,
    occurred_at: row.occurred_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    expires_at: row.expires_at,
    source_item_id: row.source_item_id,
    source_uri: row.source_uri,
    revision: row.revision,
    derived_from: [], // populated on single-item get()
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
    acceptance: item.acceptance,
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
 * non-active down-weighted; insights scaled by confidence (and halved again
 * while merely proposed); events/notes decay (30d), insights slower (90d),
 * active tasks and durable knowledge (fact/state/contact/preference) never.
 */
function lifecycleFactor(item: ContextItem, now: number): number {
  let factor = 1;
  if (item.status !== 'active') factor *= 0.4;
  if (item.type === 'insight') {
    factor *= item.confidence ?? DEFAULT_INSIGHT_CONFIDENCE;
    if (item.acceptance === 'proposed') factor *= 0.5;
  }

  let halfLifeDays: number | null;
  if (NO_DECAY_TYPES.has(item.type)) halfLifeDays = null;
  else if (item.type === 'task') halfLifeDays = item.status === 'active' ? null : 30;
  else if (item.type === 'insight') halfLifeDays = 90;
  else halfLifeDays = 30;

  if (halfLifeDays !== null) {
    const ts = Date.parse(item.occurred_at ?? item.created_at);
    const ageDays = Math.max(0, (now - ts) / 86_400_000);
    factor *= Math.pow(0.5, ageDays / halfLifeDays);
  }
  return factor;
}

export type ItemsRepo = ReturnType<typeof createItemsRepo>;

export function createItemsRepo(db: DB) {
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
      id, source, type, title, content, data, tags, entities, sensitivity,
      authority, status, acceptance, confidence, occurred_at, created_at,
      updated_at, expires_at, source_item_id, source_uri, revision,
      idempotency_key
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const contentUpdateStmt = db.prepare(`
    UPDATE context_items SET type = ?, title = ?, content = ?, data = ?, tags = ?,
      entities = ?, sensitivity = ?, status = ?, acceptance = ?, confidence = ?,
      occurred_at = ?, expires_at = ?, source_uri = ?, revision = ?, updated_at = ?
    WHERE id = ?
  `);
  const ftsInsert = db.prepare('INSERT INTO items_fts (rowid, title, content, tags) VALUES (?, ?, ?, ?)');
  const ftsDelete = db.prepare('DELETE FROM items_fts WHERE rowid = ?');
  const evidenceInsert = db.prepare('INSERT OR IGNORE INTO insight_evidence (insight_id, evidence_id) VALUES (?, ?)');
  const evidenceClear = db.prepare('DELETE FROM insight_evidence WHERE insight_id = ?');
  const evidenceSelect = db.prepare('SELECT evidence_id FROM insight_evidence WHERE insight_id = ? ORDER BY evidence_id');

  function indexItem(rowid: number | bigint, item: Pick<ContextItem, 'title' | 'content' | 'tags'>): void {
    ftsInsert.run(rowid, segmentCjk(item.title), segmentCjk(item.content), segmentCjk(item.tags.join(' ')));
  }

  function reindexItem(id: string, item: Pick<ContextItem, 'title' | 'content' | 'tags'>): void {
    const rid = (selectRowid.get(id) as { rowid: number }).rowid;
    ftsDelete.run(rid);
    indexItem(rid, item);
  }

  function derivedFrom(id: string): string[] {
    return (evidenceSelect.all(id) as { evidence_id: string }[]).map((r) => r.evidence_id);
  }

  /**
   * Validates evidence references for an insight write. Nonexistent and
   * unreadable evidence produce the SAME error message so existence is not
   * leaked. Returns the highest sensitivity among the evidence — the insight
   * must inherit it (agents cannot summarize private data into normal items).
   */
  function validateEvidence(ids: string[], writer: ReadAccess, selfId?: string): Sensitivity {
    let maxSensitivity: Sensitivity = 'normal';
    for (const id of new Set(ids)) {
      if (selfId && id === selfId) {
        throw new ValidationError('an insight cannot cite itself as evidence');
      }
      const row = selectById.get(id) as ItemRow | undefined;
      const readable =
        row &&
        (writer.readSources === null || writer.readSources.includes(row.source)) &&
        (row.sensitivity !== 'private' || writer.maxSensitivity === 'private');
      if (!readable) {
        throw new ValidationError(`evidence item "${id}" does not exist or is not readable by this client`);
      }
      if (row!.type === 'insight') {
        throw new ValidationError(
          'insights cannot be used as evidence (MVP rule: evidence must reference non-insight context items)',
        );
      }
      if (row!.sensitivity === 'private') maxSensitivity = 'private';
    }
    return maxSensitivity;
  }

  function initialAcceptance(type: string, authority: Authority): Acceptance | null {
    if (type !== 'insight') return null;
    return authority === 'user' ? 'accepted' : 'proposed';
  }

  /** Full replace of an existing row from a NewItem (source_item_id upsert). */
  function replaceRow(
    existing: ItemRow,
    input: NewItem,
    authority: Authority,
    sensitivity: Sensitivity,
  ): ContextItem {
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
      acceptance: input.type === 'insight' ? current.acceptance ?? initialAcceptance(input.type, authority) : null,
      confidence: input.confidence ?? null,
      occurred_at: input.occurred_at ?? null,
      expires_at: input.expires_at ?? null,
      source_uri: input.source_uri ?? null,
      revision: current.revision + 1,
      updated_at: new Date().toISOString(),
    };
    contentUpdateStmt.run(
      next.type, next.title, next.content,
      next.data === null ? null : JSON.stringify(next.data),
      JSON.stringify(next.tags), JSON.stringify(next.entities),
      next.sensitivity, next.status, next.acceptance, next.confidence,
      next.occurred_at, next.expires_at, next.source_uri,
      next.revision, next.updated_at, next.id,
    );
    reindexItem(next.id, next);
    return next;
  }

  /**
   * Per-type update policy when a write hits an existing (source,
   * source_item_id) — see DESIGN.md §4:
   *  - transaction: dedup-only. Same canonical source payload → return the
   *    existing record; different → 409 (corrections are new items).
   *  - insight: append-only once reviewed. Still-proposed own proposals may be
   *    refreshed in place (guarded by acceptance='proposed'); accepted or
   *    rejected → 409, propose again under a new source_item_id.
   *  - everything else (state/contact/preference/task/note/event/…): replace
   *    in place, revision+1. The hub keeps only the current projection; the
   *    source app owns history.
   */
  function handleUpsert(
    existing: ItemRow,
    input: NewItem,
    authority: Authority,
    sensitivity: Sensitivity,
    writer: ReadAccess,
  ): { item: ContextItem; created: boolean } {
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

    if (existing.type === 'insight') {
      if (existing.acceptance !== 'proposed') {
        throw new SourceItemConflictError(
          `insight "${existing.source_item_id}" has been reviewed (${existing.acceptance}) and is immutable; propose a new insight with a new source_item_id`,
        );
      }
      const evidenceSensitivity = validateEvidence(input.derived_from, writer, existing.id);
      const nextSensitivity = evidenceSensitivity === 'private' ? 'private' : input.sensitivity;
      const now = new Date().toISOString();
      const res = db
        .prepare(
          `UPDATE context_items SET title = ?, content = ?, data = ?, tags = ?, entities = ?,
             sensitivity = ?, confidence = ?, occurred_at = ?, expires_at = ?, source_uri = ?,
             revision = revision + 1, updated_at = ?
           WHERE id = ? AND acceptance = 'proposed'`,
        )
        .run(
          input.title, input.content,
          input.data === undefined ? null : JSON.stringify(input.data),
          JSON.stringify(input.tags), JSON.stringify(input.entities),
          nextSensitivity, input.confidence ?? null,
          input.occurred_at ?? null, input.expires_at ?? null, input.source_uri ?? null,
          now, existing.id,
        );
      if (res.changes === 0) {
        throw new RevisionConflictError('the insight was reviewed concurrently; refresh aborted');
      }
      evidenceClear.run(existing.id);
      for (const ev of new Set(input.derived_from)) evidenceInsert.run(existing.id, ev);
      const fresh = rowToItem(selectById.get(existing.id) as ItemRow);
      reindexItem(fresh.id, fresh);
      fresh.derived_from = derivedFrom(fresh.id);
      return { item: fresh, created: false };
    }

    return { item: replaceRow(existing, input, authority, sensitivity), created: false };
  }

  const insertTx = db.transaction(
    (source: string, input: NewItem, authority: Authority, writer: ReadAccess): { item: ContextItem; created: boolean } => {
      if (input.derived_from.length > 0 && input.type !== 'insight') {
        throw new ValidationError('derived_from is only allowed on insight items');
      }
      let sensitivity = input.sensitivity;
      if (input.type === 'insight' && input.derived_from.length > 0) {
        if (validateEvidence(input.derived_from, writer) === 'private') sensitivity = 'private';
      }

      if (input.idempotency_key) {
        const existing = selectByIdem.get(source, input.idempotency_key) as ItemRow | undefined;
        if (existing) {
          const item = rowToItem(existing);
          if (item.type === 'insight') item.derived_from = derivedFrom(item.id);
          return { item, created: false };
        }
      }
      if (input.source_item_id) {
        const existing = selectBySourceItem.get(source, input.source_item_id) as ItemRow | undefined;
        if (existing) return handleUpsert(existing, input, authority, sensitivity, writer);
      }

      const now = new Date().toISOString();
      const item: ContextItem = {
        id: ulid(),
        source,
        type: input.type,
        title: input.title,
        content: input.content,
        data: input.data === undefined ? null : input.data,
        tags: input.tags,
        entities: input.entities,
        sensitivity,
        authority,
        status: input.status,
        acceptance: initialAcceptance(input.type, authority),
        confidence: input.confidence ?? null,
        occurred_at: input.occurred_at ?? null,
        created_at: now,
        updated_at: now,
        expires_at: input.expires_at ?? null,
        source_item_id: input.source_item_id ?? null,
        source_uri: input.source_uri ?? null,
        revision: 1,
        derived_from: [...new Set(input.derived_from)],
        reviewed_by: null,
        reviewed_at: null,
        review_note: null,
      };
      const res = insertStmt.run(
        item.id, item.source, item.type, item.title, item.content,
        item.data === null ? null : JSON.stringify(item.data),
        JSON.stringify(item.tags), JSON.stringify(item.entities),
        item.sensitivity, item.authority, item.status, item.acceptance,
        item.confidence, item.occurred_at, item.created_at, item.updated_at,
        item.expires_at, item.source_item_id, item.source_uri, item.revision,
        input.idempotency_key ?? null,
      );
      indexItem(res.lastInsertRowid, item);
      for (const ev of item.derived_from) evidenceInsert.run(item.id, ev);
      return { item, created: true };
    },
  );

  function insert(
    source: string,
    input: NewItem,
    authority: Authority,
    writer: ReadAccess,
  ): { item: ContextItem; created: boolean } {
    return insertTx(source, input, authority, writer);
  }

  function insertBatch(
    source: string,
    inputs: NewItem[],
    authority: Authority,
    writer: ReadAccess,
  ): { item: ContextItem; created: boolean }[] {
    return db.transaction(() => inputs.map((input) => insertTx(source, input, authority, writer)))();
  }

  /**
   * Single-item fetch under ACL. Unauthorized and nonexistent both return
   * null (routes answer 404 either way — existence is not leaked). Rejected
   * insights remain fetchable by exact id for their proposer and admin only,
   * including the review verdict, so agents can learn why.
   */
  function get(access: ReadAccess, id: string): ContextItem | null {
    const row = selectById.get(id) as ItemRow | undefined;
    if (!row) return null;
    if (row.acceptance === 'rejected' && !access.isAdmin && row.source !== access.clientId) return null;
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

  /** Content update primitive — authorization matrix lives in the routes. */
  function update(id: string, patch: PatchItem): ContextItem | null {
    return db.transaction((): ContextItem | null => {
      const row = selectById.get(id) as ItemRow | undefined;
      if (!row) return null;
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
        ...('source_uri' in patch ? { source_uri: patch.source_uri ?? null } : {}),
        revision: current.revision + 1,
        updated_at: new Date().toISOString(),
      };
      contentUpdateStmt.run(
        next.type, next.title, next.content,
        next.data === null ? null : JSON.stringify(next.data),
        JSON.stringify(next.tags), JSON.stringify(next.entities),
        next.sensitivity, next.status, next.acceptance, next.confidence,
        next.occurred_at, next.expires_at, next.source_uri,
        next.revision, next.updated_at, next.id,
      );
      reindexItem(id, next);
      return next;
    })();
  }

  /**
   * Review an insight: proposed → accepted | rejected, exactly once, guarded
   * by optimistic concurrency (expected_revision) so a reviewer never
   * confirms content they did not read. Rejected can never be reopened.
   */
  function review(
    id: string,
    opts: { acceptance: 'accepted' | 'rejected'; reviewedBy: string; expectedRevision: number; note?: string },
  ): ContextItem | null {
    return db.transaction((): ContextItem | null => {
      const row = selectById.get(id) as ItemRow | undefined;
      if (!row) return null;
      if (row.type !== 'insight') {
        throw new ValidationError('acceptance applies only to insight items');
      }
      if (row.acceptance !== 'proposed') {
        throw new SourceItemConflictError(
          row.acceptance === 'rejected'
            ? 'rejected insights cannot be reopened; the agent must submit a new proposal'
            : 'this insight has already been reviewed',
        );
      }
      const res = db
        .prepare(
          `UPDATE context_items SET acceptance = ?, reviewed_by = ?, reviewed_at = ?, review_note = ?,
             revision = revision + 1, updated_at = ?
           WHERE id = ? AND acceptance = 'proposed' AND revision = ?`,
        )
        .run(
          opts.acceptance, opts.reviewedBy, new Date().toISOString(), opts.note ?? null,
          new Date().toISOString(), id, opts.expectedRevision,
        );
      if (res.changes === 0) {
        throw new RevisionConflictError(
          `revision mismatch: expected ${opts.expectedRevision}, current ${row.revision} — re-read the insight before reviewing`,
        );
      }
      const fresh = rowToItem(selectById.get(id) as ItemRow);
      fresh.derived_from = derivedFrom(id);
      return fresh;
    })();
  }

  function softDelete(id: string): boolean {
    return db.transaction((): boolean => {
      const row = selectById.get(id) as ItemRow | undefined;
      if (!row) return false;
      db.prepare('UPDATE context_items SET deleted = 1, updated_at = ? WHERE id = ?').run(
        new Date().toISOString(),
        id,
      );
      const rid = (selectRowid.get(id) as { rowid: number }).rowid;
      ftsDelete.run(rid);
      return true;
    })();
  }

  /**
   * Appends every ACL and visibility condition. ALL list-shaped reads flow
   * through here, so a new route cannot forget source whitelists, the
   * sensitivity ceiling, rejected exclusion, or proposed-by-default hiding.
   */
  function applyFilters(
    where: string[],
    params: unknown[],
    filters: ListFilters | undefined,
    now: string,
    access: ReadAccess,
    alias = 'i',
  ): void {
    where.push(`${alias}.deleted = 0`);
    where.push(`(${alias}.expires_at IS NULL OR ${alias}.expires_at > ?)`);
    params.push(now);
    where.push(`(${alias}.acceptance IS NULL OR ${alias}.acceptance != 'rejected')`);
    if (!filters?.includeProposed) {
      where.push(`(${alias}.acceptance IS NULL OR ${alias}.acceptance != 'proposed')`);
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
      // evidence comes from a source outside the whitelist (no laundering
      // finance data through an agent's own source).
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
    applyFilters(where, params, opts.filters, now, access);

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
   * Hybrid-ranked full-text search. Per query, FTS5 orders candidates by bm25
   * (title:3 / content:1 / tags:2). Multiple queries merge with Reciprocal
   * Rank Fusion (bm25 scores across queries are not comparable; ranks are),
   * then the fused score is weighted by lifecycleFactor. LIKE substring scan
   * as fallback when FTS finds nothing.
   */
  function search(
    access: ReadAccess,
    opts: SearchOptions,
  ): { items: SearchResultItem[]; fullItems: ContextItem[]; totalMatched: number } {
    const nowIso = new Date().toISOString();
    const nowMs = Date.now();
    const fused = new Map<string, { item: ContextItem; rrf: number }>();

    function accumulate(rows: ItemRow[]): void {
      rows.forEach((row, i) => {
        const entry = fused.get(row.id);
        const contribution = 1 / (RRF_K + i + 1);
        if (entry) entry.rrf += contribution;
        else fused.set(row.id, { item: rowToItem(row), rrf: contribution });
      });
    }

    for (const q of opts.queries) {
      const ftsQ = buildFtsQuery(q);
      if (!ftsQ) continue;
      const where: string[] = ['items_fts MATCH ?'];
      const params: unknown[] = [ftsQ];
      applyFilters(where, params, opts.filters, nowIso, access);
      try {
        accumulate(
          db
            .prepare(
              `SELECT i.* FROM items_fts JOIN context_items i ON i.rowid = items_fts.rowid
               WHERE ${where.join(' AND ')}
               ORDER BY bm25(items_fts, 3.0, 1.0, 2.0) LIMIT ?`,
            )
            .all(...params, FTS_CANDIDATES) as ItemRow[],
        );
      } catch {
        continue; // malformed FTS syntax after sanitization — skip this query
      }
    }

    if (fused.size === 0) {
      for (const q of opts.queries) {
        const trimmed = q.trim();
        if (!trimmed) continue;
        const pat = '%' + trimmed.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
        const where: string[] = [
          "(i.title LIKE ? ESCAPE '\\' OR i.content LIKE ? ESCAPE '\\' OR i.tags LIKE ? ESCAPE '\\')",
        ];
        const params: unknown[] = [pat, pat, pat];
        applyFilters(where, params, opts.filters, nowIso, access);
        accumulate(
          db
            .prepare(`SELECT i.* FROM context_items i WHERE ${where.join(' AND ')} ORDER BY i.id DESC LIMIT ?`)
            .all(...params, LIKE_CANDIDATES) as ItemRow[],
        );
      }
    }

    const tokens = opts.queries.flatMap((q) => q.trim().split(/\s+/)).filter(Boolean);
    const scored = [...fused.values()]
      .map(({ item, rrf }) => ({ item, score: rrf * lifecycleFactor(item, nowMs) }))
      .sort((a, b) => b.score - a.score);
    const offset = opts.offset ?? 0;
    const top = scored.slice(offset, offset + opts.limit);
    return {
      items: top.map(({ item, score }) => ({ ...toCompact(item, tokens), score: Number(score.toFixed(6)) })),
      fullItems: top.map(({ item }) => item),
      totalMatched: fused.size,
    };
  }

  function sourcesOverview(access: ReadAccess): SourceOverview[] {
    // Counts reflect what this caller could actually read: no proposed/
    // rejected insights, no items beyond the sensitivity ceiling.
    const rows = db
      .prepare(
        `SELECT i.source AS source, c.name AS name, c.kind AS kind, i.type AS type,
                COUNT(*) AS n, MAX(i.created_at) AS last_write
         FROM context_items i LEFT JOIN clients c ON c.id = i.source
         WHERE i.deleted = 0
           AND (i.acceptance IS NULL OR i.acceptance = 'accepted')
           AND (? = 'private' OR i.sensitivity = 'normal')
         GROUP BY i.source, i.type`,
      )
      .all(access.maxSensitivity) as { source: string; name: string | null; kind: string | null; type: string; n: number; last_write: string }[];
    const bySource = new Map<string, SourceOverview>();
    for (const row of rows) {
      // Sources outside the whitelist are entirely invisible — no names, no
      // counts, no last-activity metadata.
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

  /** Count of proposed insights VISIBLE TO THIS CALLER (full ACL applied). */
  function countProposed(access: ReadAccess): number {
    const now = new Date().toISOString();
    const where: string[] = [];
    const params: unknown[] = [];
    applyFilters(where, params, { includeProposed: true, types: ['insight'] }, now, access);
    where.push("i.acceptance = 'proposed'");
    const row = db
      .prepare(`SELECT COUNT(*) AS n FROM context_items i WHERE ${where.join(' AND ')}`)
      .get(...params) as { n: number };
    return row.n;
  }

  /**
   * One-call situational digest: per-source recent highlights plus optional
   * focus-keyword results. Deterministic SQL aggregation — no LLM involved.
   * Proposed insights are excluded; only their (ACL-filtered) count shows.
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
      });
      const where: string[] = [];
      const params: unknown[] = [];
      applyFilters(where, params, { sources: [src.source], since, sensitivity }, new Date().toISOString(), access);
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
      proposed_insights: countProposed(access),
      sources,
    };
    if (opts.focus?.trim()) {
      result.focus_results = search(access, {
        queries: [opts.focus],
        filters: { sensitivity },
        limit: 10,
      }).items;
    }
    return result;
  }

  /**
   * "What is true right now": current ≡ status=active ∧ not deleted ∧ not
   * expired, per-type — active tasks by nearest deadline, future events,
   * latest durable states, ACCEPTED insights only. Transactions are history,
   * not current context. Proposed insights appear only as a count.
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
      applyFilters(where, params, { sensitivity }, nowIso, access);
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
        "i.type IN ('state','fact','contact','preference') AND i.status = 'active'",
        [],
        'i.updated_at DESC',
      ),
      accepted_insights: section(
        "i.type = 'insight' AND i.status = 'active' AND i.acceptance = 'accepted'",
        [],
        'i.id DESC',
      ),
      proposed_insights: countProposed(access),
    };
  }

  return {
    insert,
    insertBatch,
    get,
    update,
    review,
    softDelete,
    list,
    search,
    sourcesOverview,
    countProposed,
    brief,
    currentContext,
  };
}
