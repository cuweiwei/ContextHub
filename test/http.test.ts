import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestEnv, TEST_ADMIN_TOKEN } from './helpers.js';

const admin = { authorization: `Bearer ${TEST_ADMIN_TOKEN}` };

describe('REST API', () => {
  let env: ReturnType<typeof buildTestEnv>;
  let app: FastifyInstance;
  beforeEach(() => {
    env = buildTestEnv();
    app = env.app;
  });
  afterEach(async () => {
    await app.close();
  });

  async function createClient(
    id: string,
    kind: 'app' | 'agent',
    scopes: string[],
    extra: Record<string, unknown> = {},
  ): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/clients',
      headers: admin,
      payload: { id, name: id, kind, scopes, ...extra },
    });
    expect(res.statusCode).toBe(201);
    return res.json().api_key as string;
  }

  it('serves /health without auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ok');
  });

  it('rejects unauthenticated and unknown-key requests', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/items' })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: 'GET', url: '/v1/items', headers: { authorization: 'Bearer chk_nope' } }))
        .statusCode,
    ).toBe(401);
  });

  it('write → search → fetch flow works, including Chinese q and idempotency', async () => {
    const key = await createClient('finance-app', 'app', ['read', 'write']);
    const auth = { authorization: `Bearer ${key}` };

    const post = await app.inject({
      method: 'POST',
      url: '/v1/items',
      headers: auth,
      payload: {
        type: 'task',
        title: '財務規劃：Q3 再平衡',
        content: '股債比 85/15 要調回 75/25',
        tags: ['財務規劃'],
        idempotency_key: 'q3-rebalance',
      },
    });
    expect(post.statusCode).toBe(201);
    const itemId = post.json().item.id as string;

    const replay = await app.inject({
      method: 'POST',
      url: '/v1/items',
      headers: auth,
      payload: { type: 'task', title: '財務規劃：Q3 再平衡', idempotency_key: 'q3-rebalance' },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().item.id).toBe(itemId);

    const search = await app.inject({ method: 'GET', url: '/v1/items?q=財務', headers: auth });
    expect(search.statusCode).toBe(200);
    expect(search.json().total_matched).toBe(1);
    expect(search.json().items[0].id).toBe(itemId);

    const byId = await app.inject({ method: 'GET', url: `/v1/items/${itemId}`, headers: auth });
    expect(byId.statusCode).toBe(200);
    expect(byId.json().item.title).toContain('財務規劃');
  });

  it('enforces scopes and ownership', async () => {
    const writerKey = await createClient('writer', 'app', ['read', 'write']);
    const readerKey = await createClient('reader', 'agent', ['read']);

    const denied = await app.inject({
      method: 'POST',
      url: '/v1/items',
      headers: { authorization: `Bearer ${readerKey}` },
      payload: { type: 'note', title: 'nope' },
    });
    expect(denied.statusCode).toBe(403);

    const spoof = await app.inject({
      method: 'POST',
      url: '/v1/items',
      headers: { authorization: `Bearer ${writerKey}` },
      payload: { type: 'note', title: 'spoofed', source: 'somebody-else' },
    });
    expect(spoof.statusCode).toBe(403);

    const created = await app.inject({
      method: 'POST',
      url: '/v1/items',
      headers: { authorization: `Bearer ${writerKey}` },
      payload: { type: 'note', title: 'mine' },
    });
    const id = created.json().item.id as string;
    const otherKey = await createClient('other-writer', 'app', ['read', 'write']);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/v1/items/${id}`,
          headers: { authorization: `Bearer ${otherKey}` },
          payload: { title: 'hijacked' },
        })
      ).statusCode,
    ).toBe(403);
    const patchOk = await app.inject({
      method: 'PATCH',
      url: `/v1/items/${id}`,
      headers: { authorization: `Bearer ${writerKey}` },
      payload: { title: 'renamed' },
    });
    expect(patchOk.statusCode).toBe(200);
    expect(patchOk.json().item.title).toBe('renamed');

    expect(
      (await app.inject({ method: 'GET', url: '/v1/clients', headers: { authorization: `Bearer ${writerKey}` } }))
        .statusCode,
    ).toBe(403);
  });

  it('authority is decided by the server, never by the request body', async () => {
    const appKey = await createClient('finance-app', 'app', ['read', 'write']);
    const forged = await app.inject({
      method: 'POST',
      url: '/v1/items',
      headers: { authorization: `Bearer ${appKey}` },
      payload: { type: 'insight', title: '假裝使用者說的', authority: 'user' },
    });
    expect(forged.statusCode).toBe(201);
    expect(forged.json().item.authority).toBe('app'); // ignored, not honored
    expect(forged.json().item.acceptance).toBe('proposed'); // app inferences need review too

    // the admin human-entry path is the only way to create authority=user
    const adminEntry = await app.inject({
      method: 'POST',
      url: '/v1/items',
      headers: admin,
      payload: { type: 'insight', title: '使用者親述的偏好', authority: 'user' },
    });
    expect(adminEntry.json().item.authority).toBe('user');
    expect(adminEntry.json().item.acceptance).toBe('accepted');
  });

  it('blocks agents from writing facts and enforces insight append-only', async () => {
    const agentKey = await createClient('hermes', 'agent', ['read', 'write']);
    const auth = { authorization: `Bearer ${agentKey}` };

    expect(
      (await app.inject({ method: 'POST', url: '/v1/items', headers: auth, payload: { type: 'fact', title: '假事實' } }))
        .statusCode,
    ).toBe(403);

    const legit = await app.inject({
      method: 'POST',
      url: '/v1/items',
      headers: auth,
      payload: { type: 'insight', title: '正常洞察', confidence: 0.8 },
    });
    expect(legit.statusCode).toBe(201);
    const id = legit.json().item.id as string;
    expect(legit.json().item.authority).toBe('agent');

    // insights are append-only — even the owner cannot edit content
    const edit = await app.inject({
      method: 'PATCH',
      url: `/v1/items/${id}`,
      headers: auth,
      payload: { title: '改寫' },
    });
    expect(edit.statusCode).toBe(403);
  });

  describe('insight review over REST', () => {
    async function proposeInsight(agentAuth: Record<string, string>): Promise<{ id: string; revision: number }> {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/items',
        headers: agentAuth,
        payload: { type: 'insight', title: '待審洞察', confidence: 0.6 },
      });
      expect(res.statusCode).toBe(201);
      return { id: res.json().item.id, revision: res.json().item.revision };
    }

    it('requires the review_insight capability — being an app is not enough', async () => {
      const agentKey = await createClient('hermes', 'agent', ['read', 'write']);
      const { id } = await proposeInsight({ authorization: `Bearer ${agentKey}` });

      const plainApp = await createClient('random-app', 'app', ['read', 'write']);
      const denied = await app.inject({
        method: 'PATCH',
        url: `/v1/items/${id}`,
        headers: { authorization: `Bearer ${plainApp}` },
        payload: { acceptance: 'accepted', expected_revision: 1 },
      });
      expect(denied.statusCode).toBe(403);

      const reviewerKey = await createClient('review-ui', 'app', ['read', 'write', 'review_insight']);
      const ok = await app.inject({
        method: 'PATCH',
        url: `/v1/items/${id}`,
        headers: { authorization: `Bearer ${reviewerKey}` },
        payload: { acceptance: 'accepted', expected_revision: 1, review_note: '合理' },
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().item.acceptance).toBe('accepted');
      expect(ok.json().item.authority).toBe('agent'); // review never rewrites provenance
      expect(ok.json().item.reviewed_by).toBe('review-ui');
    });

    it('rejects self-review, stale revisions, and reopening rejected insights', async () => {
      const agentKey = await createClient('hermes', 'agent', ['read', 'write', 'review_insight']);
      const agentAuth = { authorization: `Bearer ${agentKey}` };
      const { id } = await proposeInsight(agentAuth);

      // even with the scope, a client cannot review its own proposal
      const selfReview = await app.inject({
        method: 'PATCH',
        url: `/v1/items/${id}`,
        headers: agentAuth,
        payload: { acceptance: 'accepted', expected_revision: 1 },
      });
      expect(selfReview.statusCode).toBe(403);

      const staleRevision = await app.inject({
        method: 'PATCH',
        url: `/v1/items/${id}`,
        headers: admin,
        payload: { acceptance: 'rejected', expected_revision: 42 },
      });
      expect(staleRevision.statusCode).toBe(409);
      expect(staleRevision.json().error.code).toBe('revision_conflict');

      const reject = await app.inject({
        method: 'PATCH',
        url: `/v1/items/${id}`,
        headers: admin,
        payload: { acceptance: 'rejected', expected_revision: 1, review_note: '證據不足' },
      });
      expect(reject.statusCode).toBe(200);

      const reopen = await app.inject({
        method: 'PATCH',
        url: `/v1/items/${id}`,
        headers: admin,
        payload: { acceptance: 'accepted', expected_revision: 2 },
      });
      expect(reopen.statusCode).toBe(409);

      // owner still sees the verdict by exact id
      const own = await app.inject({ method: 'GET', url: `/v1/items/${id}`, headers: agentAuth });
      expect(own.statusCode).toBe(200);
      expect(own.json().item.review_note).toBe('證據不足');
    });
  });

  it('returns 409 for conflicting transaction payloads and 200 for exact replays', async () => {
    const key = await createClient('finance-app', 'app', ['read', 'write']);
    const auth = { authorization: `Bearer ${key}` };
    const txn = { type: 'transaction', title: '機票', data: { amount: 18400 }, source_item_id: 'txn-001' };
    expect((await app.inject({ method: 'POST', url: '/v1/items', headers: auth, payload: txn })).statusCode).toBe(201);
    expect((await app.inject({ method: 'POST', url: '/v1/items', headers: auth, payload: txn })).statusCode).toBe(200);
    const conflict = await app.inject({
      method: 'POST',
      url: '/v1/items',
      headers: auth,
      payload: { ...txn, data: { amount: 14800 } },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe('source_item_conflict');
  });

  it('clamps sensitivity and read_sources server-side; unauthorized ids read as 404', async () => {
    const appKey = await createClient('finance-app', 'app', ['read', 'write']);
    const secret = await app.inject({
      method: 'POST',
      url: '/v1/items',
      headers: { authorization: `Bearer ${appKey}` },
      payload: { type: 'note', title: '私密資料', sensitivity: 'private' },
    });
    const secretId = secret.json().item.id as string;
    await app.inject({
      method: 'POST',
      url: '/v1/items',
      headers: { authorization: `Bearer ${appKey}` },
      payload: { type: 'note', title: '一般資料' },
    });

    // normal-ceiling agent: sensitivity=all is clamped
    const limitedKey = await createClient('limited-agent', 'agent', ['read']);
    const denied = await app.inject({
      method: 'GET',
      url: '/v1/items?sensitivity=all',
      headers: { authorization: `Bearer ${limitedKey}` },
    });
    expect(denied.json().items.map((i: any) => i.title)).toEqual(['一般資料']);
    // …and the private item is 404 by id, indistinguishable from nonexistent
    expect(
      (await app.inject({ method: 'GET', url: `/v1/items/${secretId}`, headers: { authorization: `Bearer ${limitedKey}` } }))
        .statusCode,
    ).toBe(404);

    // whitelisted agent sees only its sources — /v1/sources leaks nothing else
    const scopedKey = await createClient('crm-agent', 'agent', ['read'], { read_sources: ['crm-app'] });
    const sources = await app.inject({
      method: 'GET',
      url: '/v1/sources',
      headers: { authorization: `Bearer ${scopedKey}` },
    });
    expect(sources.json().sources.map((s: any) => s.source)).not.toContain('finance-app');
    const items = await app.inject({
      method: 'GET',
      url: '/v1/items',
      headers: { authorization: `Bearer ${scopedKey}` },
    });
    expect(items.json().items).toHaveLength(0);
  });

  it('deletes softly and lists sources', async () => {
    const key = await createClient('finance-app', 'app', ['read', 'write']);
    const auth = { authorization: `Bearer ${key}` };
    const created = await app.inject({
      method: 'POST',
      url: '/v1/items',
      headers: auth,
      payload: { type: 'note', title: 'to delete' },
    });
    const id = created.json().item.id as string;
    expect((await app.inject({ method: 'DELETE', url: `/v1/items/${id}`, headers: auth })).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: `/v1/items/${id}`, headers: auth })).statusCode).toBe(404);

    await app.inject({
      method: 'POST',
      url: '/v1/items',
      headers: auth,
      payload: { type: 'transaction', title: 'txn' },
    });
    const sources = await app.inject({ method: 'GET', url: '/v1/sources', headers: auth });
    const entry = sources.json().sources.find((s: any) => s.source === 'finance-app');
    expect(entry.total_items).toBe(1);
    expect(entry.types.transaction).toBe(1);
  });

  it('admin can write on behalf of a source', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/items',
      headers: admin,
      payload: { type: 'note', title: 'seeded', source: 'some-app' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().item.source).toBe('some-app');
  });
});
