import { beforeEach, describe, expect, it } from 'vitest';
import { RevisionConflictError, SourceItemConflictError, ValidationError } from '../src/core/errors.js';
import { newItemSchema, type Authority, type ReadAccess } from '../src/core/types.js';
import { ADMIN_ACCESS, buildTestEnv } from './helpers.js';

type Env = ReturnType<typeof buildTestEnv>;

function makeItem(overrides: Record<string, unknown> = {}) {
  return newItemSchema.parse({
    type: 'note',
    title: 'a note',
    content: '',
    ...overrides,
  });
}

describe('items-repo', () => {
  let env: Env;
  beforeEach(() => {
    env = buildTestEnv();
  });

  function insert(source: string, item: ReturnType<typeof makeItem>, authority: Authority = 'app', writer: ReadAccess = ADMIN_ACCESS) {
    return env.itemsRepo.insert(source, item, authority, writer);
  }

  it('round-trips an item including JSON fields', () => {
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
    expect(fetched.authority).toBe('app');
    expect(fetched.acceptance).toBeNull();
  });

  it('is idempotent per (source, idempotency_key)', () => {
    const input = makeItem({ title: 'once', idempotency_key: 'k1' });
    const first = insert('finance', input);
    const second = insert('finance', input);
    expect(second.created).toBe(false);
    expect(second.item.id).toBe(first.item.id);
    const other = insert('work', input);
    expect(other.created).toBe(true);
  });

  it('finds 2-character Chinese queries inside longer CJK text', () => {
    insert('finance', makeItem({ title: '財務規劃：Q3 投資組合再平衡', content: '股債比調整' }));
    insert('work', makeItem({ title: 'weekly report', content: 'nothing related' }));
    for (const q of ['財務', '規劃', '財務規劃', '投資']) {
      const { items, totalMatched } = env.itemsRepo.search(ADMIN_ACCESS, { queries: [q], limit: 10 });
      expect(totalMatched, `query "${q}"`).toBe(1);
      expect(items[0]!.title).toContain('財務規劃');
    }
  });

  it('handles mixed CJK/latin and numeric queries', () => {
    insert('work', makeItem({ title: 'AI會議記錄', content: '討論 Model Y保險 與報價 18,400元' }));
    expect(env.itemsRepo.search(ADMIN_ACCESS, { queries: ['AI會議'], limit: 10 }).totalMatched).toBe(1);
    expect(env.itemsRepo.search(ADMIN_ACCESS, { queries: ['保險'], limit: 10 }).totalMatched).toBe(1);
    expect(env.itemsRepo.search(ADMIN_ACCESS, { queries: ['18,400'], limit: 10 }).totalMatched).toBe(1);
  });

  it('ranks newer items above older ones for equal relevance (decaying type)', () => {
    const old = new Date(Date.now() - 90 * 86_400_000).toISOString();
    insert('a', makeItem({ title: '報稅提醒', content: '報稅資料', occurred_at: old }));
    insert('b', makeItem({ title: '報稅提醒', content: '報稅資料' }));
    const { items } = env.itemsRepo.search(ADMIN_ACCESS, { queries: ['報稅'], limit: 10 });
    expect(items).toHaveLength(2);
    expect(items[0]!.source).toBe('b');
    expect(items[0]!.score).toBeGreaterThan(items[1]!.score);
  });

  it('does not decay durable knowledge, but decays notes', () => {
    const old = new Date(Date.now() - 120 * 86_400_000).toISOString();
    insert('a', makeItem({ type: 'fact', title: '身高紀錄 188cm', content: '身高 188', occurred_at: old }));
    insert('a', makeItem({ type: 'note', title: '身高隨手記', content: '身高 188', occurred_at: old }));
    const { items } = env.itemsRepo.search(ADMIN_ACCESS, { queries: ['身高'], limit: 10 });
    expect(items).toHaveLength(2);
    expect(items[0]!.type).toBe('fact');
    expect(items[0]!.score).toBeGreaterThan(items[1]!.score);
  });

  it('merges and deduplicates multi-query searches (RRF)', () => {
    insert('a', makeItem({ title: '財務規劃筆記', content: '' }));
    insert('b', makeItem({ title: '旅遊計畫', content: '東京行程' }));
    const { items, totalMatched } = env.itemsRepo.search(ADMIN_ACCESS, { queries: ['財務', '規劃', '旅遊'], limit: 10 });
    expect(totalMatched).toBe(2);
    // 財務規劃筆記 matched two queries → fused rank above single-match 旅遊計畫
    expect(items[0]!.title).toBe('財務規劃筆記');
  });

  it('falls back to LIKE substring scan when FTS misses', () => {
    insert('a', makeItem({ title: 'ContextHub deployment', content: 'NAS docker compose' }));
    const { items, totalMatched } = env.itemsRepo.search(ADMIN_ACCESS, { queries: ['textH'], limit: 10 });
    expect(totalMatched).toBe(1);
    expect(items[0]!.title).toBe('ContextHub deployment');
  });

  it('filters by tags, types, sources, and statuses', () => {
    insert('a', makeItem({ title: 't1', tags: ['x', 'y'], type: 'note' }));
    insert('a', makeItem({ title: 't2', tags: ['x'], type: 'task' }));
    insert('b', makeItem({ title: 't3', tags: ['x', 'y'], type: 'note' }));
    insert('b', makeItem({ title: 't4', type: 'task', status: 'completed' }));
    const both = env.itemsRepo.list(ADMIN_ACCESS, { filters: { tags: ['x', 'y'] }, limit: 10, sort: 'created' });
    expect(both.items.map((i) => i.title).sort()).toEqual(['t1', 't3']);
    const active = env.itemsRepo.list(ADMIN_ACCESS, { filters: { types: ['task'], statuses: ['active'] }, limit: 10, sort: 'created' });
    expect(active.items.map((i) => i.title)).toEqual(['t2']);
    const sourced = env.itemsRepo.list(ADMIN_ACCESS, { filters: { sources: ['b'] }, limit: 10, sort: 'created' });
    expect(sourced.items.map((i) => i.title).sort()).toEqual(['t3', 't4']);
  });

  it('paginates with cursors without duplicates or gaps', () => {
    for (let i = 0; i < 5; i++) insert('a', makeItem({ title: `item ${i}` }));
    const seen: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = env.itemsRepo.list(ADMIN_ACCESS, { limit: 2, cursor, sort: 'created' });
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
    env.itemsRepo.softDelete(deleted.item.id);
    expect(env.itemsRepo.list(ADMIN_ACCESS, { limit: 10, sort: 'created' }).items).toHaveLength(0);
    expect(env.itemsRepo.search(ADMIN_ACCESS, { queries: ['過期'], limit: 10 }).totalMatched).toBe(0);
    expect(env.itemsRepo.get(ADMIN_ACCESS, deleted.item.id)).toBeNull();
    expect(env.itemsRepo.get(ADMIN_ACCESS, expired.item.id)).not.toBeNull();
  });

  it('re-indexes FTS on update and bumps revision', () => {
    const { item } = insert('a', makeItem({ title: '舊標題' }));
    const updated = env.itemsRepo.update(item.id, { title: '新方向' })!;
    expect(updated.revision).toBe(2);
    expect(env.itemsRepo.search(ADMIN_ACCESS, { queries: ['舊標'], limit: 10 }).totalMatched).toBe(0);
    expect(env.itemsRepo.search(ADMIN_ACCESS, { queries: ['新方向'], limit: 10 }).totalMatched).toBe(1);
  });

  describe('per-type upsert policy', () => {
    it('upserts state items in place (current projection)', () => {
      const first = insert('finance', makeItem({ type: 'state', title: '餐飲預算已用 60%', source_item_id: 'budget' }));
      const second = insert('finance', makeItem({ type: 'state', title: '餐飲預算已用 82%', source_item_id: 'budget' }));
      expect(second.created).toBe(false);
      expect(second.item.id).toBe(first.item.id);
      expect(second.item.revision).toBe(2);
      expect(env.itemsRepo.search(ADMIN_ACCESS, { queries: ['餐飲預算'], limit: 10 }).totalMatched).toBe(1);
      expect(env.itemsRepo.get(ADMIN_ACCESS, first.item.id)!.title).toContain('82%');
    });

    it('transactions are dedup-only: same payload 200, different payload conflicts', () => {
      const txn = { type: 'transaction', title: '機票', content: '', data: { amount: 18400 }, source_item_id: 'txn-001' };
      const first = insert('finance', makeItem(txn));
      const replay = insert('finance', makeItem(txn));
      expect(replay.created).toBe(false);
      expect(replay.item.id).toBe(first.item.id);
      expect(replay.item.data).toEqual({ amount: 18400 }); // untouched
      expect(() =>
        insert('finance', makeItem({ ...txn, data: { amount: 14800 } })),
      ).toThrow(SourceItemConflictError);
      // hub metadata differences are ignored, not conflicts
      const metaOnly = insert('finance', makeItem({ ...txn, tags: ['旅遊'] }));
      expect(metaOnly.created).toBe(false);
      expect(metaOnly.item.tags).toEqual([]); // existing record returned unchanged
    });
  });

  describe('insight lifecycle', () => {
    it('agent insights start proposed; user-authority (admin entry) start accepted', () => {
      const proposed = insert('hermes', makeItem({ type: 'insight', title: '推論' }), 'agent');
      expect(proposed.item.acceptance).toBe('proposed');
      const accepted = insert('admin', makeItem({ type: 'insight', title: '使用者親述' }), 'user');
      expect(accepted.item.acceptance).toBe('accepted');
    });

    it('review never changes authority; accepted insight shows in current context', () => {
      const { item } = insert('hermes', makeItem({ type: 'insight', title: '偏好早上工作' }), 'agent');
      const reviewed = env.itemsRepo.review(item.id, {
        acceptance: 'accepted',
        reviewedBy: 'admin',
        expectedRevision: 1,
        note: '確認',
      })!;
      expect(reviewed.authority).toBe('agent'); // provenance preserved
      expect(reviewed.acceptance).toBe('accepted');
      expect(reviewed.reviewed_by).toBe('admin');
      const current = env.itemsRepo.currentContext(ADMIN_ACCESS, {});
      expect(current.accepted_insights.map((i) => i.title)).toContain('偏好早上工作');
    });

    it('review enforces expected_revision and one-way transitions', () => {
      const { item } = insert('hermes', makeItem({ type: 'insight', title: 'x' }), 'agent');
      expect(() =>
        env.itemsRepo.review(item.id, { acceptance: 'accepted', reviewedBy: 'admin', expectedRevision: 99 }),
      ).toThrow(RevisionConflictError);
      env.itemsRepo.review(item.id, { acceptance: 'rejected', reviewedBy: 'admin', expectedRevision: 1, note: '單次行為' });
      // rejected cannot be reopened
      expect(() =>
        env.itemsRepo.review(item.id, { acceptance: 'accepted', reviewedBy: 'admin', expectedRevision: 2 }),
      ).toThrow(SourceItemConflictError);
      // owner can still fetch it by id with the verdict; others cannot
      const own = env.itemsRepo.get({ ...ADMIN_ACCESS, isAdmin: false, clientId: 'hermes' }, item.id)!;
      expect(own.review_note).toBe('單次行為');
      expect(env.itemsRepo.get({ ...ADMIN_ACCESS, isAdmin: false, clientId: 'someone' }, item.id)).toBeNull();
    });

    it('proposed insights are hidden from reads by default, counted, and refreshable; reviewed ones are immutable', () => {
      const { item } = insert('hermes', makeItem({ type: 'insight', title: '獨特推論詞', source_item_id: 'ins-1' }), 'agent');
      expect(env.itemsRepo.search(ADMIN_ACCESS, { queries: ['獨特推論詞'], limit: 10 }).totalMatched).toBe(0);
      expect(
        env.itemsRepo.search(ADMIN_ACCESS, { queries: ['獨特推論詞'], filters: { includeProposed: true }, limit: 10 }).totalMatched,
      ).toBe(1);
      expect(env.itemsRepo.countProposed(ADMIN_ACCESS)).toBe(1);

      // refresh while proposed: in place, revision+1, still proposed
      const refreshed = insert('hermes', makeItem({ type: 'insight', title: '獨特推論詞 v2', source_item_id: 'ins-1' }), 'agent');
      expect(refreshed.item.id).toBe(item.id);
      expect(refreshed.item.revision).toBe(2);
      expect(refreshed.item.acceptance).toBe('proposed');

      env.itemsRepo.review(item.id, { acceptance: 'accepted', reviewedBy: 'admin', expectedRevision: 2 });
      // once reviewed → immutable; a new proposal must use a new key
      expect(() =>
        insert('hermes', makeItem({ type: 'insight', title: 'v3', source_item_id: 'ins-1' }), 'agent'),
      ).toThrow(SourceItemConflictError);
      // and the accepted item is untouched
      expect(env.itemsRepo.get(ADMIN_ACCESS, item.id)!.title).toBe('獨特推論詞 v2');
    });
  });

  describe('evidence rules', () => {
    it('validates evidence: must exist, must not be an insight, inherits private sensitivity', () => {
      const fact = insert('finance', makeItem({ type: 'fact', title: '預算事實' }));
      const secret = insert('finance', makeItem({ type: 'fact', title: '私密事實', sensitivity: 'private' }));
      const otherInsight = insert('hermes', makeItem({ type: 'insight', title: '另一推論' }), 'agent');

      expect(() =>
        insert('hermes', makeItem({ type: 'insight', title: 'x', derived_from: ['nope'] }), 'agent'),
      ).toThrow(ValidationError);
      expect(() =>
        insert('hermes', makeItem({ type: 'insight', title: 'x', derived_from: [otherInsight.item.id] }), 'agent'),
      ).toThrow(ValidationError);
      expect(() =>
        insert('a', makeItem({ type: 'note', title: 'x', derived_from: [fact.item.id] })),
      ).toThrow(ValidationError); // derived_from only on insights

      const ins = insert('hermes', makeItem({
        type: 'insight',
        title: '從私密資料推導',
        sensitivity: 'normal', // requested normal…
        derived_from: [fact.item.id, secret.item.id],
      }), 'agent');
      expect(ins.item.sensitivity).toBe('private'); // …but inherits private
      expect(env.itemsRepo.get(ADMIN_ACCESS, ins.item.id)!.derived_from.sort()).toEqual(
        [fact.item.id, secret.item.id].sort(),
      );
    });

    it('rejects evidence the writer cannot read (limited read_sources)', () => {
      const fact = insert('finance', makeItem({ type: 'fact', title: '財務事實' }));
      const limitedWriter: ReadAccess = { clientId: 'ball-agent', isAdmin: false, readSources: ['crm'], maxSensitivity: 'normal' };
      expect(() =>
        env.itemsRepo.insert('ball-agent', makeItem({ type: 'insight', title: 'x', derived_from: [fact.item.id] }), 'agent', limitedWriter),
      ).toThrow(ValidationError);
    });
  });

  describe('read ACL (ReadAccess)', () => {
    it('readSources=[] reads nothing; null reads all — never falsy-confused', () => {
      insert('a', makeItem({ title: 'visible' }));
      const none: ReadAccess = { clientId: 'x', isAdmin: false, readSources: [], maxSensitivity: 'normal' };
      expect(env.itemsRepo.list(none, { limit: 10, sort: 'created' }).items).toHaveLength(0);
      expect(env.itemsRepo.search(none, { queries: ['visible'], limit: 10 }).totalMatched).toBe(0);
      const all: ReadAccess = { ...none, readSources: null };
      expect(env.itemsRepo.list(all, { limit: 10, sort: 'created' }).items).toHaveLength(1);
    });

    it('blocks insight ACL laundering: evidence sources must be within the reader whitelist', () => {
      const fact = insert('finance', makeItem({ type: 'fact', title: '資產摘要' }));
      const { item } = insert(
        'hermes',
        makeItem({ type: 'insight', title: '資產配置建議', derived_from: [fact.item.id] }),
        'agent',
        ADMIN_ACCESS,
      );
      env.itemsRepo.review(item.id, { acceptance: 'accepted', reviewedBy: 'admin', expectedRevision: 1 });

      // reader may read hermes but NOT finance → the insight stays invisible
      const limited: ReadAccess = { clientId: 'ball-agent', isAdmin: false, readSources: ['hermes'], maxSensitivity: 'normal' };
      expect(env.itemsRepo.search(limited, { queries: ['資產配置'], limit: 10 }).totalMatched).toBe(0);
      expect(env.itemsRepo.get(limited, item.id)).toBeNull();
      expect(env.itemsRepo.countProposed(limited)).toBe(0);

      // a reader allowed both sources sees it
      const full: ReadAccess = { ...limited, readSources: ['hermes', 'finance'] };
      expect(env.itemsRepo.search(full, { queries: ['資產配置'], limit: 10 }).totalMatched).toBe(1);
    });

    it('hides non-whitelisted sources from the overview entirely', () => {
      insert('finance', makeItem({ title: 'f' }));
      insert('crm', makeItem({ title: 'c' }));
      const limited: ReadAccess = { clientId: 'x', isAdmin: false, readSources: ['crm'], maxSensitivity: 'normal' };
      const overview = env.itemsRepo.sourcesOverview(limited);
      expect(overview.map((s) => s.source)).toEqual(['crm']);
    });
  });

  it('builds a cross-source brief with focus results and proposed count', () => {
    insert('finance', makeItem({ title: '本月預算 82%', type: 'fact' }));
    insert('crm', makeItem({ title: '小美生日 7/20', type: 'contact' }));
    insert('hermes', makeItem({ type: 'insight', title: '提案中' }), 'agent');
    const brief = env.itemsRepo.brief(ADMIN_ACCESS, { days: 14, focus: '生日' });
    expect(brief.sources.map((s) => s.source).sort()).toEqual(['crm', 'finance']); // proposed-only source hidden
    expect(brief.focus_results!.map((i) => i.title)).toEqual(['小美生日 7/20']);
    expect(brief.proposed_insights).toBe(1);
  });

  it('reports current context sections with precise semantics', () => {
    insert('work', makeItem({ type: 'task', title: '進行中任務' }));
    insert('work', makeItem({ type: 'task', title: '完成的任務', status: 'completed' }));
    insert('work', makeItem({ type: 'event', title: '明天的會議', occurred_at: new Date(Date.now() + 86_400_000).toISOString() }));
    insert('work', makeItem({ type: 'event', title: '上週的會議', occurred_at: new Date(Date.now() - 7 * 86_400_000).toISOString() }));
    insert('finance', makeItem({ type: 'state', title: '預算狀態' }));
    insert('finance', makeItem({ type: 'transaction', title: '一筆刷卡' }));
    const proposal = insert('hermes', makeItem({ type: 'insight', title: '待審洞察' }), 'agent');
    const accepted = insert('hermes', makeItem({ type: 'insight', title: '已審洞察', source_item_id: 'ok' }), 'agent');
    env.itemsRepo.review(accepted.item.id, { acceptance: 'accepted', reviewedBy: 'admin', expectedRevision: 1 });

    const current = env.itemsRepo.currentContext(ADMIN_ACCESS, {});
    expect(current.active_tasks.map((i) => i.title)).toEqual(['進行中任務']);
    expect(current.upcoming_events.map((i) => i.title)).toEqual(['明天的會議']);
    expect(current.current_states.map((i) => i.title)).toEqual(['預算狀態']); // transactions are not current context
    expect(current.accepted_insights.map((i) => i.title)).toEqual(['已審洞察']);
    expect(current.proposed_insights).toBe(1);
    void proposal;
  });
});
