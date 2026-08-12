import { beforeEach, describe, expect, it } from 'vitest';
import { RevisionConflictError, SourceItemConflictError, ValidationError } from '../src/core/errors.js';
import { newItemSchema, type ReadAccess } from '../src/core/types.js';
import {
  ACCEPT_TRUST,
  ADMIN_ACCESS,
  CANDIDATE_TRUST,
  IMPORT_TRUST,
  buildTestEnv,
  idem,
  writerFor,
} from './helpers.js';

type Env = ReturnType<typeof buildTestEnv>;

function makeItem(overrides: Record<string, unknown> = {}) {
  return newItemSchema.parse({
    type: 'note',
    title: 'a note',
    content: '',
    idempotency_key: idem(),
    ...overrides,
  });
}

describe('items-repo', () => {
  let env: Env;
  beforeEach(() => {
    env = buildTestEnv();
  });

  const insert = (source: string, item: ReturnType<typeof makeItem>, opts: Parameters<Env['seed']>[2] = {}) =>
    env.seed(source, item, opts);

  it('round-trips an item including JSON fields, namespace, and trust metadata', () => {
    const { item, created } = insert('finance', makeItem({
      type: 'transaction',
      title: '刷卡消費',
      content: '午餐 NT$180',
      data: { amount: -180 },
      tags: ['餐飲'],
      entities: ['person:小美'],
    }));
    expect(created).toBe(true);
    const fetched = env.itemsRepo.get(ADMIN_ACCESS, item.id)!;
    expect(fetched.data).toEqual({ amount: -180 });
    expect(fetched.tags).toEqual(['餐飲']);
    expect(fetched.entities).toEqual(['person:小美']);
    expect(fetched.source).toBe('finance');
    expect(fetched.namespace).toBe('personal');
    expect(fetched.authority).toBe('app');
    expect(fetched.trust_state).toBe('accepted');
    expect(fetched.acceptance_method).toBe('policy');
    expect(fetched.acceptance_policy_version).toBe(1);
    expect(fetched.acceptance_rule_id).toBe('test-rule');
    expect(fetched.information_class).toBe('source');
    expect(fetched.memory_kind).toBeNull();
  });

  it('separates source projections from typed memories with explicit lifecycle metadata', () => {
    const source = insert('finance', makeItem({ type: 'fact', title: 'app 投影的事實' })).item;
    expect(source.information_class).toBe('source');
    expect(source.memory_kind).toBeNull();

    const memory = insert(
      'hermes',
      makeItem({
        type: 'memory',
        title: '部署前先做相容性檢查',
        memory_kind: 'procedure',
        valid_from: '2026-01-01T00:00:00Z',
        last_verified_at: '2026-08-01T00:00:00Z',
      }),
      { authority: 'agent', principalKind: 'agent' },
    ).item;
    expect(memory.information_class).toBe('memory');
    expect(memory.memory_kind).toBe('procedure');
    expect(memory.decay_policy).toBe('none');
    expect(memory.valid_from).toBe('2026-01-01T00:00:00.000Z');
    expect(memory.last_verified_at).toBe('2026-08-01T00:00:00.000Z');

    const extracted = insert(
      'source-app',
      makeItem({ type: 'note', title: 'app 萃取的經驗', memory_kind: 'experience' }),
    ).item;
    expect(extracted.information_class).toBe('memory');
    expect(extracted.decay_policy).toBe('standard');
  });

  it('is idempotent per (source, idempotency_key)', () => {
    const input = makeItem({ title: 'once', idempotency_key: 'k1' });
    const first = insert('finance', input);
    const second = insert('finance', input);
    expect(second.created).toBe(false);
    expect(second.item.id).toBe(first.item.id);
    const other = insert('work-src', input);
    expect(other.created).toBe(true);
  });

  it('writes a version snapshot on every mutation', () => {
    const { item } = insert('finance', makeItem({ type: 'state', title: 'v1', source_item_id: 's1' }));
    insert('finance', makeItem({ type: 'state', title: 'v2', source_item_id: 's1' }));
    env.itemsRepo.softDelete(item.id, 'admin');
    const versions = env.db
      .prepare('SELECT revision, change_kind FROM item_versions WHERE item_id = ? ORDER BY revision')
      .all(item.id) as { revision: number; change_kind: string }[];
    expect(versions).toEqual([
      { revision: 1, change_kind: 'create' },
      { revision: 2, change_kind: 'update' },
      { revision: 3, change_kind: 'delete' },
    ]);
  });

  it('finds 2-character Chinese queries inside longer CJK text', () => {
    insert('finance', makeItem({ title: '財務規劃：Q3 投資組合再平衡', content: '股債比調整' }));
    insert('work-src', makeItem({ title: 'weekly report', content: 'nothing related' }));
    for (const q of ['財務', '規劃', '財務規劃', '投資']) {
      const { items, totalMatched } = env.itemsRepo.search(ADMIN_ACCESS, { queries: [q], limit: 10, surface: 'accepted' });
      expect(totalMatched, `query "${q}"`).toBe(1);
      expect(items[0]!.title).toContain('財務規劃');
    }
  });

  it('handles mixed CJK/latin and numeric queries', () => {
    insert('work-src', makeItem({ title: 'AI會議記錄', content: '討論 Model Y保險 與報價 18,400元' }));
    expect(env.itemsRepo.search(ADMIN_ACCESS, { queries: ['AI會議'], limit: 10, surface: 'accepted' }).totalMatched).toBe(1);
    expect(env.itemsRepo.search(ADMIN_ACCESS, { queries: ['保險'], limit: 10, surface: 'accepted' }).totalMatched).toBe(1);
    expect(env.itemsRepo.search(ADMIN_ACCESS, { queries: ['18,400'], limit: 10, surface: 'accepted' }).totalMatched).toBe(1);
  });

  it('ranks newer items above older ones for equal relevance (decaying type)', () => {
    const old = new Date(Date.now() - 90 * 86_400_000).toISOString();
    insert('a', makeItem({ title: '報稅提醒', content: '報稅資料', occurred_at: old }));
    insert('b', makeItem({ title: '報稅提醒', content: '報稅資料' }));
    const { items } = env.itemsRepo.search(ADMIN_ACCESS, { queries: ['報稅'], limit: 10, surface: 'accepted' });
    expect(items).toHaveLength(2);
    expect(items[0]!.source).toBe('b');
    expect(items[0]!.score).toBeGreaterThan(items[1]!.score);
  });

  it('does not decay durable knowledge, but decays notes', () => {
    const old = new Date(Date.now() - 120 * 86_400_000).toISOString();
    insert('a', makeItem({ type: 'fact', title: '身高紀錄 188cm', content: '身高 188', occurred_at: old }));
    insert('a', makeItem({ type: 'note', title: '身高隨手記', content: '身高 188', occurred_at: old }));
    const { items } = env.itemsRepo.search(ADMIN_ACCESS, { queries: ['身高'], limit: 10, surface: 'accepted' });
    expect(items).toHaveLength(2);
    expect(items[0]!.type).toBe('fact');
    expect(items[0]!.score).toBeGreaterThan(items[1]!.score);
  });

  it('merges and deduplicates multi-query searches (RRF)', () => {
    insert('a', makeItem({ title: '財務規劃筆記', content: '' }));
    insert('b', makeItem({ title: '旅遊計畫', content: '東京行程' }));
    const { items, totalMatched } = env.itemsRepo.search(ADMIN_ACCESS, {
      queries: ['財務', '規劃', '旅遊'],
      limit: 10,
      surface: 'accepted',
    });
    expect(totalMatched).toBe(2);
    expect(items[0]!.title).toBe('財務規劃筆記');
  });

  it('falls back to LIKE substring scan when FTS misses', () => {
    insert('a', makeItem({ title: 'ContextHub deployment', content: 'NAS docker compose' }));
    const { items, totalMatched } = env.itemsRepo.search(ADMIN_ACCESS, { queries: ['textH'], limit: 10, surface: 'accepted' });
    expect(totalMatched).toBe(1);
    expect(items[0]!.title).toBe('ContextHub deployment');
  });

  it('fuses local-vector and structured-entity candidates with retrieval diagnostics', () => {
    const target = insert(
      'projects',
      makeItem({
        title: 'ContextHub deployment checklist',
        content: 'NAS rollout validation and rollback procedure',
        entities: ['project:Orion'],
      }),
    ).item;

    const typo = env.itemsRepo.search(ADMIN_ACCESS, {
      queries: ['ContextHbu deploymnt cheklist'],
      limit: 10,
      surface: 'accepted',
      mode: 'hybrid',
    });
    expect(typo.items[0]?.id).toBe(target.id);
    expect(typo.items[0]?.retrieval_sources).toContain('vector');
    expect(typo.retrieval).toMatchObject({
      mode: 'hybrid',
      embedding_model: 'local-feature-hash-v1',
    });

    const entity = env.itemsRepo.search(ADMIN_ACCESS, {
      queries: ['目前專案進度'],
      entities: ['project:Orion'],
      limit: 10,
      surface: 'accepted',
      mode: 'hybrid',
    });
    expect(entity.items[0]?.id).toBe(target.id);
    expect(entity.items[0]?.retrieval_sources).toContain('entity');
  });

  it('applies ACL and validity filters inside vector/entity candidate SQL', () => {
    insert(
      'private-source',
      makeItem({
        title: 'Confidential Atlas deployment',
        content: 'restricted migration procedure',
        sensitivity: 'private',
        entities: ['project:Atlas'],
      }),
    );
    const normalReader: ReadAccess = {
      clientId: 'normal',
      isAdmin: false,
      namespace: 'personal',
      readSources: null,
      maxSensitivity: 'normal',
    };
    const result = env.itemsRepo.search(normalReader, {
      queries: ['Confidental Atlas deploymnt'],
      entities: ['project:Atlas'],
      limit: 10,
      surface: 'accepted',
      mode: 'hybrid',
    });
    expect(result.totalMatched).toBe(0);
    expect(result.retrieval.candidate_counts).toMatchObject({ vector: 0, entity: 0, fused: 0 });
  });

  it('filters by tags, types, sources, and statuses', () => {
    insert('a', makeItem({ title: 't1', tags: ['x', 'y'], type: 'note' }));
    insert('a', makeItem({ title: 't2', tags: ['x'], type: 'task' }));
    insert('b', makeItem({ title: 't3', tags: ['x', 'y'], type: 'note' }));
    insert('b', makeItem({ title: 't4', type: 'task', status: 'completed' }));
    const both = env.itemsRepo.list(ADMIN_ACCESS, { filters: { tags: ['x', 'y'] }, limit: 10, sort: 'created', surface: 'accepted' });
    expect(both.items.map((i) => i.title).sort()).toEqual(['t1', 't3']);
    const active = env.itemsRepo.list(ADMIN_ACCESS, {
      filters: { types: ['task'], statuses: ['active'] },
      limit: 10,
      sort: 'created',
      surface: 'accepted',
    });
    expect(active.items.map((i) => i.title)).toEqual(['t2']);
    const sourced = env.itemsRepo.list(ADMIN_ACCESS, { filters: { sources: ['b'] }, limit: 10, sort: 'created', surface: 'accepted' });
    expect(sourced.items.map((i) => i.title).sort()).toEqual(['t3', 't4']);
  });

  it('paginates with cursors without duplicates or gaps', () => {
    for (let i = 0; i < 5; i++) insert('a', makeItem({ title: `item ${i}` }));
    const seen: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = env.itemsRepo.list(ADMIN_ACCESS, { limit: 2, cursor, sort: 'created', surface: 'accepted' });
      seen.push(...page.items.map((i) => i.id));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
  });

  it('hides expired and soft-deleted items', () => {
    const expired = insert('a', makeItem({ title: '過期優惠', expires_at: new Date(Date.now() - 1000).toISOString() }));
    const deleted = insert('a', makeItem({ title: '要刪的' }));
    env.itemsRepo.softDelete(deleted.item.id, 'admin');
    expect(env.itemsRepo.list(ADMIN_ACCESS, { limit: 10, sort: 'created', surface: 'accepted' }).items).toHaveLength(0);
    expect(env.itemsRepo.search(ADMIN_ACCESS, { queries: ['過期'], limit: 10, surface: 'accepted' }).totalMatched).toBe(0);
    expect(env.itemsRepo.get(ADMIN_ACCESS, deleted.item.id)).toBeNull();
    expect(env.itemsRepo.get(ADMIN_ACCESS, expired.item.id)).not.toBeNull();
  });

  it('excludes not-yet-valid and no-longer-valid assertions from every list-shaped read', () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const past = new Date(Date.now() - 86_400_000).toISOString();
    insert('a', makeItem({ title: '尚未生效', valid_from: future }));
    insert('a', makeItem({ title: '已經失效', valid_until: past }));
    insert('a', makeItem({ title: '目前有效', valid_from: past, valid_until: future }));
    const listed = env.itemsRepo.list(ADMIN_ACCESS, { limit: 10, sort: 'created', surface: 'accepted' });
    expect(listed.items.map((item) => item.title)).toEqual(['目前有效']);
    expect(env.itemsRepo.search(ADMIN_ACCESS, { queries: ['生效'], limit: 10, surface: 'accepted' }).totalMatched).toBe(0);
    expect(() => insert('a', makeItem({ title: '反向區間', valid_from: future, valid_until: past }))).toThrow(
      ValidationError,
    );
  });

  it('re-indexes FTS on update and bumps revision', () => {
    const { item } = insert('a', makeItem({ title: '舊標題' }));
    const updated = env.itemsRepo.update(item.id, { title: '新方向' }, 'admin')!;
    expect(updated.revision).toBe(2);
    expect(env.itemsRepo.search(ADMIN_ACCESS, { queries: ['舊標'], limit: 10, surface: 'accepted' }).totalMatched).toBe(0);
    expect(env.itemsRepo.search(ADMIN_ACCESS, { queries: ['新方向'], limit: 10, surface: 'accepted' }).totalMatched).toBe(1);
  });

  it('reindex() rebuilds every retrieval projection from scratch (restore path)', () => {
    insert('a', makeItem({ title: '財務規劃筆記' }));
    insert('a', makeItem({ title: 'plain english note' }));
    env.db.exec('DELETE FROM items_fts'); // simulate a stale/invalid index after restore
    env.db.exec('DELETE FROM item_embeddings');
    expect(env.itemsRepo.retrievalProjectionStatus().ready).toBe(false);
    const { indexed, vectorIndexed } = env.itemsRepo.reindex();
    expect(indexed).toBe(2);
    expect(vectorIndexed).toBe(2);
    expect(env.itemsRepo.retrievalProjectionStatus().ready).toBe(true);
    expect(env.itemsRepo.search(ADMIN_ACCESS, { queries: ['財務'], limit: 10, surface: 'accepted' }).totalMatched).toBe(1);
  });

  describe('per-type upsert policy', () => {
    it('upserts state items in place (current projection)', () => {
      const first = insert('finance', makeItem({ type: 'state', title: '餐飲預算已用 60%', source_item_id: 'budget' }));
      const second = insert('finance', makeItem({ type: 'state', title: '餐飲預算已用 82%', source_item_id: 'budget' }));
      expect(second.created).toBe(false);
      expect(second.item.id).toBe(first.item.id);
      expect(second.item.revision).toBe(2);
      expect(env.itemsRepo.search(ADMIN_ACCESS, { queries: ['餐飲預算'], limit: 10, surface: 'accepted' }).totalMatched).toBe(1);
      expect(env.itemsRepo.get(ADMIN_ACCESS, first.item.id)!.title).toContain('82%');
    });

    it('transactions are dedup-only: same payload replays, different payload conflicts', () => {
      const txn = { type: 'transaction', title: '機票', content: '', data: { amount: 18400 }, source_item_id: 'txn-001' };
      const first = insert('finance', makeItem(txn));
      const replay = insert('finance', makeItem(txn));
      expect(replay.created).toBe(false);
      expect(replay.item.id).toBe(first.item.id);
      expect(replay.item.data).toEqual({ amount: 18400 });
      expect(() => insert('finance', makeItem({ ...txn, data: { amount: 14800 } }))).toThrow(SourceItemConflictError);
      const metaOnly = insert('finance', makeItem({ ...txn, tags: ['旅遊'] }));
      expect(metaOnly.created).toBe(false);
      expect(metaOnly.item.tags).toEqual([]);
    });

    it('accepted items are immutable for AGENT writers — successors only', () => {
      const first = insert('hermes', makeItem({ type: 'fact', title: '舊事實', source_item_id: 'f1' }), {
        authority: 'agent',
        trust: ACCEPT_TRUST,
      });
      expect(first.item.trust_state).toBe('accepted');
      expect(() =>
        insert('hermes', makeItem({ type: 'fact', title: '直接改寫', source_item_id: 'f1' }), { authority: 'agent' }),
      ).toThrow(SourceItemConflictError);
    });
  });

  describe('trust lifecycle (repo level)', () => {
    it('agent memories start as candidates; trusted import starts accepted', () => {
      const proposed = insert('hermes', makeItem({ type: 'insight', title: '推論' }), {
        authority: 'agent',
        trust: CANDIDATE_TRUST,
      });
      expect(proposed.item.trust_state).toBe('candidate');
      const accepted = insert('admin', makeItem({ type: 'insight', title: '使用者親述' }), {
        authority: 'user',
        trust: IMPORT_TRUST,
      });
      expect(accepted.item.trust_state).toBe('accepted');
      expect(accepted.item.acceptance_method).toBe('trusted_import');
    });

    it('review never changes authority; accepted insight shows in current context', () => {
      const { item } = insert('hermes', makeItem({ type: 'insight', title: '偏好早上工作' }), {
        authority: 'agent',
        trust: CANDIDATE_TRUST,
      });
      const reviewed = env.itemsRepo.review(item.id, {
        decision: 'accept',
        reviewedBy: 'admin',
        expectedRevision: 1,
        note: '確認',
      })!;
      expect(reviewed.authority).toBe('agent'); // provenance preserved
      expect(reviewed.trust_state).toBe('accepted');
      expect(reviewed.acceptance_method).toBe('human_review');
      expect(reviewed.reviewed_by).toBe('admin');
      const current = env.itemsRepo.currentContext(ADMIN_ACCESS, {});
      expect(current.accepted_insights.map((i) => i.title)).toContain('偏好早上工作');
      const reviews = env.db.prepare('SELECT decision FROM item_reviews WHERE item_id = ?').all(item.id);
      expect(reviews).toEqual([{ decision: 'accept' }]);
    });

    it('review enforces expected_revision and one-way transitions', () => {
      const { item } = insert('hermes', makeItem({ type: 'insight', title: 'x' }), {
        authority: 'agent',
        trust: CANDIDATE_TRUST,
      });
      expect(() =>
        env.itemsRepo.review(item.id, { decision: 'accept', reviewedBy: 'admin', expectedRevision: 99 }),
      ).toThrow(RevisionConflictError);
      env.itemsRepo.review(item.id, { decision: 'reject', reviewedBy: 'admin', expectedRevision: 1, note: '單次行為' });
      expect(() =>
        env.itemsRepo.review(item.id, { decision: 'accept', reviewedBy: 'admin', expectedRevision: 2 }),
      ).toThrow(SourceItemConflictError);
      // owner can still fetch it by id with the verdict; others cannot
      const own = env.itemsRepo.get({ ...AGENT_ACCESS_LIKE(), clientId: 'hermes' }, item.id)!;
      expect(own.review_note).toBe('單次行為');
      expect(env.itemsRepo.get({ ...AGENT_ACCESS_LIKE(), clientId: 'someone' }, item.id)).toBeNull();
    });

    it('candidates are hidden from the accepted surface, counted, and refreshable; reviewed ones are immutable', () => {
      const { item } = insert('hermes', makeItem({ type: 'insight', title: '獨特推論詞', source_item_id: 'ins-1' }), {
        authority: 'agent',
        trust: CANDIDATE_TRUST,
      });
      expect(env.itemsRepo.search(ADMIN_ACCESS, { queries: ['獨特推論詞'], limit: 10, surface: 'accepted' }).totalMatched).toBe(0);
      expect(env.itemsRepo.search(ADMIN_ACCESS, { queries: ['獨特推論詞'], limit: 10, surface: 'plus_all' }).totalMatched).toBe(1);
      expect(env.itemsRepo.countCandidates(ADMIN_ACCESS, 'inbox')).toBe(1);

      const refreshed = insert('hermes', makeItem({ type: 'insight', title: '獨特推論詞 v2', source_item_id: 'ins-1' }), {
        authority: 'agent',
        trust: CANDIDATE_TRUST,
      });
      expect(refreshed.item.id).toBe(item.id);
      expect(refreshed.item.revision).toBe(2);
      expect(refreshed.item.trust_state).toBe('candidate');

      env.itemsRepo.review(item.id, { decision: 'accept', reviewedBy: 'admin', expectedRevision: 2 });
      expect(() =>
        insert('hermes', makeItem({ type: 'insight', title: 'v3', source_item_id: 'ins-1' }), {
          authority: 'agent',
          trust: CANDIDATE_TRUST,
        }),
      ).toThrow(SourceItemConflictError);
      expect(env.itemsRepo.get(ADMIN_ACCESS, item.id)!.title).toBe('獨特推論詞 v2');
    });

    it('successor acceptance atomically supersedes the predecessor', () => {
      const pred = insert('finance', makeItem({ type: 'fact', title: '舊預算事實' }));
      const successor = env.itemsRepo.insert(
        writerFor('hermes', { principalKind: 'agent' }),
        makeItem({ type: 'fact', title: '新預算事實' }),
        'agent',
        CANDIDATE_TRUST,
        { successorOf: pred.item.id },
      );
      // predecessor stays current until acceptance
      expect(env.itemsRepo.get(ADMIN_ACCESS, pred.item.id)!.status).toBe('active');
      env.itemsRepo.review(successor.item.id, { decision: 'accept', reviewedBy: 'admin', expectedRevision: 1 });
      const oldItem = env.itemsRepo.get(ADMIN_ACCESS, pred.item.id)!;
      expect(oldItem.status).toBe('superseded');
      expect(oldItem.superseded_by).toBe(successor.item.id);
      const versions = env.db
        .prepare('SELECT change_kind FROM item_versions WHERE item_id = ? ORDER BY revision')
        .all(pred.item.id) as { change_kind: string }[];
      expect(versions.map((v) => v.change_kind)).toEqual(['create', 'supersede']);
    });

    it('rejecting a successor leaves the predecessor untouched; superseding twice is refused', () => {
      const pred = insert('finance', makeItem({ type: 'fact', title: '事實A' }));
      const s1 = env.itemsRepo.insert(
        writerFor('hermes', { principalKind: 'agent' }),
        makeItem({ type: 'fact', title: '替代B' }),
        'agent',
        CANDIDATE_TRUST,
        { successorOf: pred.item.id },
      );
      env.itemsRepo.review(s1.item.id, { decision: 'reject', reviewedBy: 'admin', expectedRevision: 1 });
      expect(env.itemsRepo.get(ADMIN_ACCESS, pred.item.id)!.status).toBe('active');

      const s2 = env.itemsRepo.insert(
        writerFor('hermes', { principalKind: 'agent' }),
        makeItem({ type: 'fact', title: '替代C' }),
        'agent',
        CANDIDATE_TRUST,
        { successorOf: pred.item.id },
      );
      env.itemsRepo.review(s2.item.id, { decision: 'accept', reviewedBy: 'admin', expectedRevision: 1 });
      // predecessor now superseded → cannot target it again
      expect(() =>
        env.itemsRepo.insert(
          writerFor('hermes', { principalKind: 'agent' }),
          makeItem({ type: 'fact', title: '替代D' }),
          'agent',
          CANDIDATE_TRUST,
          { successorOf: pred.item.id },
        ),
      ).toThrow(SourceItemConflictError);
    });

    it('revoke flips accepted → revoked and hides the item from lists', () => {
      const { item } = insert('finance', makeItem({ type: 'fact', title: '待撤銷' }));
      env.itemsRepo.review(item.id, { decision: 'revoke', reviewedBy: 'admin', expectedRevision: 1, note: '不再成立' });
      expect(env.itemsRepo.search(ADMIN_ACCESS, { queries: ['待撤銷'], limit: 10, surface: 'plus_all' }).totalMatched).toBe(0);
      // creator still sees the verdict by id
      const own = env.itemsRepo.get({ ...AGENT_ACCESS_LIKE(), clientId: 'finance' }, item.id)!;
      expect(own.trust_state).toBe('revoked');
    });
  });

  describe('evidence rules', () => {
    it('validates evidence: must exist, must not be an insight, inherits private sensitivity', () => {
      const fact = insert('finance', makeItem({ type: 'fact', title: '預算事實' }));
      const secret = insert('finance', makeItem({ type: 'fact', title: '私密事實', sensitivity: 'private' }));
      const otherInsight = insert('hermes', makeItem({ type: 'insight', title: '另一推論' }), {
        authority: 'agent',
        trust: CANDIDATE_TRUST,
      });

      expect(() =>
        insert('hermes', makeItem({ type: 'insight', title: 'x', derived_from: ['nope'] }), { authority: 'agent', trust: CANDIDATE_TRUST }),
      ).toThrow(ValidationError);
      expect(() =>
        insert('hermes', makeItem({ type: 'insight', title: 'x', derived_from: [otherInsight.item.id] }), {
          authority: 'agent',
          trust: CANDIDATE_TRUST,
        }),
      ).toThrow(ValidationError);
      expect(() => insert('a', makeItem({ type: 'note', title: 'x', derived_from: [fact.item.id] }))).toThrow(ValidationError);

      const ins = insert(
        'hermes',
        makeItem({ type: 'insight', title: '從私密資料推導', sensitivity: 'normal', derived_from: [fact.item.id, secret.item.id] }),
        { authority: 'agent', trust: CANDIDATE_TRUST },
      );
      expect(ins.item.sensitivity).toBe('private');
      expect(env.itemsRepo.get(ADMIN_ACCESS, ins.item.id)!.derived_from.sort()).toEqual([fact.item.id, secret.item.id].sort());
    });

    it('rejects evidence the writer cannot read (limited read_sources)', () => {
      const fact = insert('finance', makeItem({ type: 'fact', title: '財務事實' }));
      const limitedWriter = writerFor('ball-agent', { principalKind: 'agent', readSources: ['crm'], maxSensitivity: 'normal' });
      expect(() =>
        env.itemsRepo.insert(limitedWriter, makeItem({ type: 'insight', title: 'x', derived_from: [fact.item.id] }), 'agent', CANDIDATE_TRUST),
      ).toThrow(ValidationError);
    });

    it('rejects evidence from another namespace (same error as nonexistent)', () => {
      const workFact = insert('work-app', makeItem({ type: 'fact', title: '工作事實' }), { namespace: 'work' });
      expect(() =>
        env.itemsRepo.insert(
          writerFor('hermes', { principalKind: 'agent', namespace: 'personal' }),
          makeItem({ type: 'insight', title: 'x', derived_from: [workFact.item.id] }),
          'agent',
          CANDIDATE_TRUST,
        ),
      ).toThrow(ValidationError);
    });
  });

  describe('read ACL (ReadAccess)', () => {
    it('readSources=[] reads nothing; null reads all — never falsy-confused', () => {
      insert('a', makeItem({ title: 'visible' }));
      const none: ReadAccess = { clientId: 'x', isAdmin: false, namespace: 'personal', readSources: [], maxSensitivity: 'normal' };
      expect(env.itemsRepo.list(none, { limit: 10, sort: 'created', surface: 'accepted' }).items).toHaveLength(0);
      expect(env.itemsRepo.search(none, { queries: ['visible'], limit: 10, surface: 'accepted' }).totalMatched).toBe(0);
      const all: ReadAccess = { ...none, readSources: null };
      expect(env.itemsRepo.list(all, { limit: 10, sort: 'created', surface: 'accepted' }).items).toHaveLength(1);
    });

    it('blocks insight ACL laundering: evidence sources must be within the reader whitelist', () => {
      const fact = insert('finance', makeItem({ type: 'fact', title: '資產摘要' }));
      const { item } = insert('hermes', makeItem({ type: 'insight', title: '資產配置建議', derived_from: [fact.item.id] }), {
        authority: 'agent',
        trust: CANDIDATE_TRUST,
      });
      env.itemsRepo.review(item.id, { decision: 'accept', reviewedBy: 'admin', expectedRevision: 1 });

      const limited: ReadAccess = { clientId: 'ball-agent', isAdmin: false, namespace: 'personal', readSources: ['hermes'], maxSensitivity: 'normal' };
      expect(env.itemsRepo.search(limited, { queries: ['資產配置'], limit: 10, surface: 'accepted' }).totalMatched).toBe(0);
      expect(env.itemsRepo.get(limited, item.id)).toBeNull();
      expect(env.itemsRepo.countCandidates(limited, 'inbox')).toBe(0);

      const full: ReadAccess = { ...limited, readSources: ['hermes', 'finance'] };
      expect(env.itemsRepo.search(full, { queries: ['資產配置'], limit: 10, surface: 'accepted' }).totalMatched).toBe(1);
    });

    it('hides non-whitelisted sources from the overview entirely', () => {
      insert('finance', makeItem({ title: 'f' }));
      insert('crm', makeItem({ title: 'c' }));
      const limited: ReadAccess = { clientId: 'x', isAdmin: false, namespace: 'personal', readSources: ['crm'], maxSensitivity: 'normal' };
      const overview = env.itemsRepo.sourcesOverview(limited);
      expect(overview.map((s) => s.source)).toEqual(['crm']);
    });
  });

  describe('namespace isolation (repo level)', () => {
    it('a namespace reader cannot see, search, count, or fetch another namespace — even by exact id', () => {
      const personal = insert('finance', makeItem({ title: '個人獨特詞彙' }));
      const work = insert('work-app', makeItem({ title: '工作獨特詞彙' }), { namespace: 'work' });

      const workReader: ReadAccess = { clientId: 'w', isAdmin: false, namespace: 'work', readSources: null, maxSensitivity: 'private' };
      const personalReader: ReadAccess = { ...workReader, clientId: 'p', namespace: 'personal' };

      expect(env.itemsRepo.search(workReader, { queries: ['個人獨特詞彙'], limit: 10, surface: 'accepted' }).totalMatched).toBe(0);
      expect(env.itemsRepo.search(personalReader, { queries: ['工作獨特詞彙'], limit: 10, surface: 'accepted' }).totalMatched).toBe(0);
      expect(env.itemsRepo.get(workReader, personal.item.id)).toBeNull(); // exact-id probe
      expect(env.itemsRepo.get(personalReader, work.item.id)).toBeNull();
      expect(env.itemsRepo.list(workReader, { limit: 10, sort: 'created', surface: 'accepted' }).items.map((i) => i.title)).toEqual([
        '工作獨特詞彙',
      ]);
      expect(env.itemsRepo.sourcesOverview(personalReader).map((s) => s.source)).toEqual(['finance']);
      expect(env.itemsRepo.sourcesOverview(workReader).map((s) => s.source)).toEqual(['work-app']);
      // admin (namespace null) sees both
      expect(env.itemsRepo.list(ADMIN_ACCESS, { limit: 10, sort: 'created', surface: 'accepted' }).items).toHaveLength(2);
    });

    it('refuses to run a non-admin read without a namespace (defense in depth)', () => {
      const broken = { clientId: 'x', isAdmin: false, namespace: null, readSources: null, maxSensitivity: 'normal' } as ReadAccess;
      expect(() => env.itemsRepo.list(broken, { limit: 10, sort: 'created', surface: 'accepted' })).toThrow(/BUG/);
    });
  });

  it('builds a cross-source brief with focus results and pending count', () => {
    insert('finance', makeItem({ title: '本月預算 82%', type: 'fact' }));
    insert('crm', makeItem({ title: '小美生日 7/20', type: 'contact' }));
    insert('hermes', makeItem({ type: 'insight', title: '提案中' }), { authority: 'agent', trust: CANDIDATE_TRUST });
    const brief = env.itemsRepo.brief(ADMIN_ACCESS, { days: 14, focus: '生日' });
    expect(brief.sources.map((s) => s.source).sort()).toEqual(['crm', 'finance']); // candidate-only source hidden
    expect(brief.focus_results!.map((i) => i.title)).toEqual(['小美生日 7/20']);
    expect(brief.pending_candidates).toBe(1);
  });

  it('reports current context sections with precise semantics', () => {
    insert('work-src', makeItem({ type: 'task', title: '進行中任務' }));
    insert('work-src', makeItem({ type: 'task', title: '完成的任務', status: 'completed' }));
    insert('work-src', makeItem({ type: 'event', title: '明天的會議', occurred_at: new Date(Date.now() + 86_400_000).toISOString() }));
    insert('work-src', makeItem({ type: 'event', title: '上週的會議', occurred_at: new Date(Date.now() - 7 * 86_400_000).toISOString() }));
    insert('finance', makeItem({ type: 'state', title: '預算狀態' }));
    insert('finance', makeItem({ type: 'transaction', title: '一筆刷卡' }));
    insert('hermes', makeItem({ type: 'insight', title: '待審洞察' }), { authority: 'agent', trust: CANDIDATE_TRUST });
    const accepted = insert('hermes', makeItem({ type: 'insight', title: '已審洞察', source_item_id: 'ok' }), {
      authority: 'agent',
      trust: CANDIDATE_TRUST,
    });
    env.itemsRepo.review(accepted.item.id, { decision: 'accept', reviewedBy: 'admin', expectedRevision: 1 });

    const current = env.itemsRepo.currentContext(ADMIN_ACCESS, {});
    expect(current.active_tasks.map((i) => i.title)).toEqual(['進行中任務']);
    expect(current.upcoming_events.map((i) => i.title)).toEqual(['明天的會議']);
    expect(current.current_states.map((i) => i.title)).toEqual(['預算狀態']);
    expect(current.accepted_insights.map((i) => i.title)).toEqual(['已審洞察']);
    expect(current.pending_candidates).toBe(1);
  });
});

/** A private-ceiling personal-namespace reader shape used in ad-hoc probes. */
function AGENT_ACCESS_LIKE(): ReadAccess {
  return { clientId: 'x', isAdmin: false, namespace: 'personal', readSources: null, maxSensitivity: 'private' };
}
