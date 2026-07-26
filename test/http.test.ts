import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { GrantProfile } from '../src/core/policy.js';
import type { PrincipalKind, Scope } from '../src/core/types.js';
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
    principalKind: PrincipalKind,
    scopes: Scope[],
    extra: Record<string, unknown> = {},
    profile: GrantProfile = principalKind === 'service' ? 'app-producer' : 'agent-default',
    namespace = 'personal',
  ): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/clients',
      headers: admin,
      payload: { id, name: id, namespace, principal_kind: principalKind, scopes, profile, ...extra },
    });
    expect(res.statusCode).toBe(201);
    return res.json().api_key as string;
  }

  function payloadWithKey(payload: Record<string, unknown>): Record<string, unknown> {
    return { idempotency_key: randomUUID(), ...payload };
  }

  it('serves /health without auth, reporting audit writability', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ok');
    expect(res.json().audit_writable).toBe(true);
  });

  it('serves a no-store reviewer UI without embedding credentials', async () => {
    const res = await app.inject({ method: 'GET', url: '/review' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.body).toContain('ContextHub · Human review');
    expect(res.body).toContain('/v1/candidates?scope=inbox');
    expect(res.body).not.toContain('ADMIN_TOKEN=');
    expect(res.body).not.toMatch(/chk_[A-Za-z0-9_-]{20,}/);
  });

  it('rejects unauthenticated and unknown-key requests', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/items' })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: 'GET', url: '/v1/items', headers: { authorization: 'Bearer chk_nope' } }))
        .statusCode,
    ).toBe(401);
  });

  it('requires namespace + principal_kind when creating clients (fail-closed)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/clients',
      headers: admin,
      payload: { id: 'no-ns', name: 'no-ns', principal_kind: 'agent', scopes: ['read'] },
    });
    expect(res.statusCode).toBe(400);
    const unknownNs = await app.inject({
      method: 'POST',
      url: '/v1/clients',
      headers: admin,
      payload: { id: 'bad-ns', name: 'bad-ns', namespace: 'nope', principal_kind: 'agent', scopes: ['read'] },
    });
    expect([400, 409]).toContain(unknownNs.statusCode);
  });

  it('write → search → fetch flow works, including Chinese q and idempotent replay', async () => {
    const key = await createClient('finance-app', 'service', ['read', 'write']);
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
    expect(post.json().item.trust_state).toBe('accepted'); // app-producer rule
    expect(post.json().item.namespace).toBe('personal');

    // exact retry replays the stored result without re-executing
    const replay = await app.inject({
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
    expect(replay.statusCode).toBe(200);
    expect(replay.json().item.id).toBe(itemId);
    expect(replay.json().replayed).toBe(true);

    // same key + DIFFERENT payload is a conflict
    const mismatch = await app.inject({
      method: 'POST',
      url: '/v1/items',
      headers: auth,
      payload: { type: 'task', title: '不一樣的內容', idempotency_key: 'q3-rebalance' },
    });
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json().error.code).toBe('idempotency_conflict');

    const search = await app.inject({ method: 'GET', url: '/v1/items?q=財務', headers: auth });
    expect(search.statusCode).toBe(200);
    expect(search.json().total_matched).toBe(1);
    expect(search.json().items[0].id).toBe(itemId);

    const byId = await app.inject({ method: 'GET', url: `/v1/items/${itemId}`, headers: auth });
    expect(byId.statusCode).toBe(200);
    expect(byId.json().item.title).toContain('財務規劃');
  });

  it('rejects creates without an idempotency_key', async () => {
    const key = await createClient('finance-app', 'service', ['read', 'write']);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/items',
      headers: { authorization: `Bearer ${key}` },
      payload: { type: 'note', title: 'no key' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('enforces scopes, ownership, and namespace-bound source spoofing', async () => {
    const writerKey = await createClient('writer', 'service', ['read', 'write']);
    const readerKey = await createClient('reader', 'agent', ['read']);

    const denied = await app.inject({
      method: 'POST',
      url: '/v1/items',
      headers: { authorization: `Bearer ${readerKey}` },
      payload: payloadWithKey({ type: 'note', title: 'nope' }),
    });
    expect(denied.statusCode).toBe(403);

    const spoof = await app.inject({
      method: 'POST',
      url: '/v1/items',
      headers: { authorization: `Bearer ${writerKey}` },
      payload: payloadWithKey({ type: 'note', title: 'spoofed', source: 'somebody-else' }),
    });
    expect(spoof.statusCode).toBe(403);

    const created = await app.inject({
      method: 'POST',
      url: '/v1/items',
      headers: { authorization: `Bearer ${writerKey}` },
      payload: payloadWithKey({ type: 'note', title: 'mine' }),
    });
    const id = created.json().item.id as string;
    const otherKey = await createClient('other-writer', 'service', ['read', 'write']);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/v1/items/${id}`,
          headers: { authorization: `Bearer ${otherKey}`, 'idempotency-key': randomUUID() },
          payload: { title: 'hijacked', expected_revision: 1 },
        })
      ).statusCode,
    ).toBe(403);
    const patchOk = await app.inject({
      method: 'PATCH',
      url: `/v1/items/${id}`,
      headers: { authorization: `Bearer ${writerKey}`, 'idempotency-key': randomUUID() },
      payload: { title: 'renamed', expected_revision: 1 },
    });
    expect(patchOk.statusCode).toBe(200);
    expect(patchOk.json().item.title).toBe('renamed');
    expect(patchOk.json().item.revision).toBe(2);

    // stale expected_revision → 409
    const stale = await app.inject({
      method: 'PATCH',
      url: `/v1/items/${id}`,
      headers: { authorization: `Bearer ${writerKey}`, 'idempotency-key': randomUUID() },
      payload: { title: 'stale', expected_revision: 1 },
    });
    expect(stale.statusCode).toBe(409);

    expect(
      (await app.inject({ method: 'GET', url: '/v1/clients', headers: { authorization: `Bearer ${writerKey}` } }))
        .statusCode,
    ).toBe(403);
  });

  it('authority is decided by the server; non-human insights are ALWAYS candidates', async () => {
    const appKey = await createClient('finance-app', 'service', ['read', 'write']);
    const forged = await app.inject({
      method: 'POST',
      url: '/v1/items',
      headers: { authorization: `Bearer ${appKey}` },
      payload: payloadWithKey({ type: 'insight', title: '假裝使用者說的', authority: 'user' }),
    });
    expect(forged.statusCode).toBe(403); // non-admin may not pass authority at all

    const appInsight = await app.inject({
      method: 'POST',
      url: '/v1/items',
      headers: { authorization: `Bearer ${appKey}` },
      payload: payloadWithKey({ type: 'insight', title: 'app 自動推論' }),
    });
    expect(appInsight.statusCode).toBe(201);
    expect(appInsight.json().item.authority).toBe('app');
    expect(appInsight.json().item.trust_state).toBe('candidate'); // app inference ≠ verified

    // the admin human-entry path is the only way to create authority=user
    const adminEntry = await app.inject({
      method: 'POST',
      url: '/v1/items',
      headers: admin,
      payload: payloadWithKey({ type: 'insight', title: '使用者親述的偏好', authority: 'user', namespace: 'personal' }),
    });
    expect(adminEntry.json().item.authority).toBe('user');
    expect(adminEntry.json().item.trust_state).toBe('accepted');
    expect(adminEntry.json().item.acceptance_method).toBe('trusted_import');
  });

  it('agents may write memory types as CANDIDATES per policy; insights stay append-only', async () => {
    const agentKey = await createClient('hermes', 'agent', ['read', 'write']);
    const auth = { authorization: `Bearer ${agentKey}` };

    // fact is allowed by the agent-default profile — but starts as a candidate
    const fact = await app.inject({
      method: 'POST',
      url: '/v1/items',
      headers: auth,
      payload: payloadWithKey({ type: 'fact', title: '使用者偏好深色主題' }),
    });
    expect(fact.statusCode).toBe(201);
    expect(fact.json().item.trust_state).toBe('candidate');

    const legit = await app.inject({
      method: 'POST',
      url: '/v1/items',
      headers: auth,
      payload: payloadWithKey({ type: 'insight', title: '正常洞察', confidence: 0.8 }),
    });
    expect(legit.statusCode).toBe(201);
    const id = legit.json().item.id as string;
    expect(legit.json().item.authority).toBe('agent');

    // agents cannot PATCH anything — typed commands only
    const edit = await app.inject({
      method: 'PATCH',
      url: `/v1/items/${id}`,
      headers: { ...auth, 'idempotency-key': randomUUID() },
      payload: { title: '改寫', expected_revision: 1 },
    });
    expect(edit.statusCode).toBe(403);
  });

  it('work namespace is deny-by-default until the owner grants access', async () => {
    const workAgent = await createClient('hermes-work', 'agent', ['read', 'write'], {}, 'none', 'work');
    const auth = { authorization: `Bearer ${workAgent}` };

    expect((await app.inject({ method: 'GET', url: '/v1/items', headers: auth })).statusCode).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/items',
          headers: auth,
          payload: payloadWithKey({ type: 'task', title: '工作任務' }),
        })
      ).statusCode,
    ).toBe(403);

    // owner grants via a new policy version → allowed immediately
    const grant = await app.inject({
      method: 'PUT',
      url: '/v1/policies/work',
      headers: admin,
      payload: {
        rules: {
          schema_version: 1,
          namespace_mode: 'work',
          grants: [{ client_id: 'hermes-work', capabilities: ['memory.read_accepted', 'memory.read_own_candidates'] }],
          create_rules: [{ rule_id: 'w1', client_id: 'hermes-work', item_type: 'task', create_as: 'candidate' }],
          state_rules: [],
        },
      },
    });
    expect(grant.statusCode).toBe(200);
    expect(grant.json().version).toBe(2);

    expect((await app.inject({ method: 'GET', url: '/v1/items', headers: auth })).statusCode).toBe(200);
    const task = await app.inject({
      method: 'POST',
      url: '/v1/items',
      headers: auth,
      payload: payloadWithKey({ type: 'task', title: '工作任務' }),
    });
    expect(task.statusCode).toBe(201);
    expect(task.json().item.trust_state).toBe('candidate'); // work agents never auto-accept
    expect(task.json().item.namespace).toBe('work');

    // …but only the granted type
    const fact = await app.inject({
      method: 'POST',
      url: '/v1/items',
      headers: auth,
      payload: payloadWithKey({ type: 'fact', title: '不在 allowlist 的類型' }),
    });
    expect(fact.statusCode).toBe(403);
  });

  it('cross-namespace reads 404 even with the exact id', async () => {
    const personalApp = await createClient('finance-app', 'service', ['read', 'write']);
    const created = await app.inject({
      method: 'POST',
      url: '/v1/items',
      headers: { authorization: `Bearer ${personalApp}` },
      payload: payloadWithKey({ type: 'note', title: '個人資料' }),
    });
    const id = created.json().item.id as string;

    const workReader = await createClient('work-reader', 'agent', ['read'], {}, 'none', 'work');
    await app.inject({
      method: 'PUT',
      url: '/v1/policies/work',
      headers: admin,
      payload: {
        rules: {
          schema_version: 1,
          namespace_mode: 'work',
          grants: [{ client_id: 'work-reader', capabilities: ['memory.read_accepted'] }],
          create_rules: [],
          state_rules: [],
        },
      },
    });
    const probe = await app.inject({
      method: 'GET',
      url: `/v1/items/${id}`,
      headers: { authorization: `Bearer ${workReader}` },
    });
    expect(probe.statusCode).toBe(404); // indistinguishable from nonexistent
    const search = await app.inject({
      method: 'GET',
      url: '/v1/items?q=個人資料',
      headers: { authorization: `Bearer ${workReader}` },
    });
    expect(search.json().total_matched).toBe(0);
  });

  describe('candidate review over REST', () => {
    async function propose(agentAuth: Record<string, string>): Promise<{ id: string; revision: number }> {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/items',
        headers: agentAuth,
        payload: payloadWithKey({ type: 'insight', title: '待審洞察', confidence: 0.6 }),
      });
      expect(res.statusCode).toBe(201);
      return { id: res.json().item.id, revision: res.json().item.revision };
    }

    it('requires the memory.review capability — being an app is not enough', async () => {
      const agentKey = await createClient('hermes', 'agent', ['read', 'write']);
      const { id } = await propose({ authorization: `Bearer ${agentKey}` });

      const plainApp = await createClient('random-app', 'service', ['read', 'write']);
      const denied = await app.inject({
        method: 'POST',
        url: `/v1/items/${id}/review`,
        headers: { authorization: `Bearer ${plainApp}` },
        payload: { decision: 'accept', expected_revision: 1, idempotency_key: randomUUID() },
      });
      expect(denied.statusCode).toBe(403);

      const reviewerKey = await createClient('tim-reviewer', 'human', ['read', 'write'], {}, 'reviewer');
      const ok = await app.inject({
        method: 'POST',
        url: `/v1/items/${id}/review`,
        headers: { authorization: `Bearer ${reviewerKey}` },
        payload: { decision: 'accept', expected_revision: 1, note: '合理', idempotency_key: randomUUID() },
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().item.trust_state).toBe('accepted');
      expect(ok.json().item.authority).toBe('agent'); // review never rewrites provenance
      expect(ok.json().item.accepted_by).toBe('tim-reviewer');
      expect(ok.json().item.acceptance_method).toBe('human_review');
    });

    it('rejects self-review, stale revisions, and reopening rejected candidates', async () => {
      const agentKey = await createClient('hermes', 'agent', ['read', 'write'], {}, 'reviewer');
      const agentAuth = { authorization: `Bearer ${agentKey}` };
      const { id } = await propose(agentAuth);

      const selfReview = await app.inject({
        method: 'POST',
        url: `/v1/items/${id}/review`,
        headers: agentAuth,
        payload: { decision: 'accept', expected_revision: 1, idempotency_key: randomUUID() },
      });
      expect(selfReview.statusCode).toBe(403);

      const staleRevision = await app.inject({
        method: 'POST',
        url: `/v1/items/${id}/review`,
        headers: admin,
        payload: { decision: 'reject', expected_revision: 42, idempotency_key: randomUUID() },
      });
      expect(staleRevision.statusCode).toBe(409);
      expect(staleRevision.json().error.code).toBe('revision_conflict');

      const reject = await app.inject({
        method: 'POST',
        url: `/v1/items/${id}/review`,
        headers: admin,
        payload: { decision: 'reject', expected_revision: 1, note: '證據不足', idempotency_key: randomUUID() },
      });
      expect(reject.statusCode).toBe(200);

      const reopen = await app.inject({
        method: 'POST',
        url: `/v1/items/${id}/review`,
        headers: admin,
        payload: { decision: 'accept', expected_revision: 2, idempotency_key: randomUUID() },
      });
      expect(reopen.statusCode).toBe(409);

      // owner still sees the verdict by exact id
      const own = await app.inject({ method: 'GET', url: `/v1/items/${id}`, headers: agentAuth });
      expect(own.statusCode).toBe(200);
      expect(own.json().item.review_note).toBe('證據不足');
    });
  });

  it('successor flow over REST: propose → accept → predecessor superseded, history complete', async () => {
    const appKey = await createClient('finance-app', 'service', ['read', 'write']);
    const agentKey = await createClient('hermes', 'agent', ['read', 'write']);
    const pred = await app.inject({
      method: 'POST',
      url: '/v1/items',
      headers: { authorization: `Bearer ${appKey}` },
      payload: payloadWithKey({ type: 'fact', title: '舊住址在台北' }),
    });
    const predId = pred.json().item.id as string;

    const succ = await app.inject({
      method: 'POST',
      url: `/v1/items/${predId}/successor`,
      headers: { authorization: `Bearer ${agentKey}` },
      payload: payloadWithKey({ type: 'fact', title: '新住址在新竹' }),
    });
    expect(succ.statusCode).toBe(201);
    const succId = succ.json().item.id as string;
    expect(succ.json().item.trust_state).toBe('candidate');

    // predecessor still current pre-acceptance
    const before = await app.inject({ method: 'GET', url: `/v1/items/${predId}`, headers: { authorization: `Bearer ${appKey}` } });
    expect(before.json().item.status).toBe('active');

    const accept = await app.inject({
      method: 'POST',
      url: `/v1/items/${succId}/review`,
      headers: admin,
      payload: { decision: 'accept', expected_revision: 1, note: '搬家了', idempotency_key: randomUUID() },
    });
    expect(accept.statusCode).toBe(200);

    const after = await app.inject({ method: 'GET', url: `/v1/items/${predId}`, headers: { authorization: `Bearer ${appKey}` } });
    expect(after.json().item.status).toBe('superseded');
    expect(after.json().item.superseded_by).toBe(succId);

    const history = await app.inject({ method: 'GET', url: `/v1/items/${predId}/history`, headers: { authorization: `Bearer ${appKey}` } });
    expect(history.statusCode).toBe(200);
    expect(history.json().versions.map((v: any) => v.change_kind)).toEqual(['create', 'supersede']);
  });

  it('returns 409 for conflicting transaction payloads and replay for exact ones', async () => {
    const key = await createClient('finance-app', 'service', ['read', 'write']);
    const auth = { authorization: `Bearer ${key}` };
    const txn = { type: 'transaction', title: '機票', data: { amount: 18400 }, source_item_id: 'txn-001' };
    expect(
      (await app.inject({ method: 'POST', url: '/v1/items', headers: auth, payload: { ...txn, idempotency_key: 'ik-1' } })).statusCode,
    ).toBe(201);
    expect(
      (await app.inject({ method: 'POST', url: '/v1/items', headers: auth, payload: { ...txn, idempotency_key: 'ik-2' } })).statusCode,
    ).toBe(200);
    const conflict = await app.inject({
      method: 'POST',
      url: '/v1/items',
      headers: auth,
      payload: { ...txn, data: { amount: 14800 }, idempotency_key: 'ik-3' },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe('source_item_conflict');
  });

  it('clamps sensitivity and read_sources server-side; unauthorized ids read as 404', async () => {
    const appKey = await createClient('finance-app', 'service', ['read', 'write']);
    const secret = await app.inject({
      method: 'POST',
      url: '/v1/items',
      headers: { authorization: `Bearer ${appKey}` },
      payload: payloadWithKey({ type: 'note', title: '私密資料', sensitivity: 'private' }),
    });
    const secretId = secret.json().item.id as string;
    await app.inject({
      method: 'POST',
      url: '/v1/items',
      headers: { authorization: `Bearer ${appKey}` },
      payload: payloadWithKey({ type: 'note', title: '一般資料' }),
    });

    const limitedKey = await createClient('limited-agent', 'agent', ['read']);
    const denied = await app.inject({
      method: 'GET',
      url: '/v1/items?sensitivity=all',
      headers: { authorization: `Bearer ${limitedKey}` },
    });
    expect(denied.json().items.map((i: any) => i.title)).toEqual(['一般資料']);
    expect(
      (await app.inject({ method: 'GET', url: `/v1/items/${secretId}`, headers: { authorization: `Bearer ${limitedKey}` } }))
        .statusCode,
    ).toBe(404);

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

  it('deletes softly (idempotency required) and lists sources', async () => {
    const key = await createClient('finance-app', 'service', ['read', 'write']);
    const auth = { authorization: `Bearer ${key}` };
    const created = await app.inject({
      method: 'POST',
      url: '/v1/items',
      headers: auth,
      payload: payloadWithKey({ type: 'note', title: 'to delete' }),
    });
    const id = created.json().item.id as string;
    expect((await app.inject({ method: 'DELETE', url: `/v1/items/${id}`, headers: auth })).statusCode).toBe(400); // no key
    expect(
      (await app.inject({ method: 'DELETE', url: `/v1/items/${id}`, headers: { ...auth, 'idempotency-key': randomUUID() } })).statusCode,
    ).toBe(204);
    expect((await app.inject({ method: 'GET', url: `/v1/items/${id}`, headers: auth })).statusCode).toBe(404);

    await app.inject({
      method: 'POST',
      url: '/v1/items',
      headers: auth,
      payload: payloadWithKey({ type: 'transaction', title: 'txn' }),
    });
    const sources = await app.inject({ method: 'GET', url: '/v1/sources', headers: auth });
    const entry = sources.json().sources.find((s: any) => s.source === 'finance-app');
    expect(entry.total_items).toBe(1);
    expect(entry.types.transaction).toBe(1);
  });

  it('admin writes on behalf of a source resolve the namespace fail-closed', async () => {
    // unknown source without an explicit namespace → refused
    const noNs = await app.inject({
      method: 'POST',
      url: '/v1/items',
      headers: admin,
      payload: payloadWithKey({ type: 'note', title: 'seeded', source: 'some-app' }),
    });
    expect(noNs.statusCode).toBe(400);

    const ok = await app.inject({
      method: 'POST',
      url: '/v1/items',
      headers: admin,
      payload: payloadWithKey({ type: 'note', title: 'seeded', source: 'some-app', namespace: 'personal' }),
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().item.source).toBe('some-app');
    expect(ok.json().item.namespace).toBe('personal');
  });

  it('audit trail records reads, writes, and denials per namespace; audit endpoint is capability-gated', async () => {
    const agentKey = await createClient('hermes', 'agent', ['read', 'write']);
    const auth = { authorization: `Bearer ${agentKey}` };
    await app.inject({ method: 'GET', url: '/v1/items?q=任何', headers: auth });
    await app.inject({
      method: 'POST',
      url: '/v1/items',
      headers: auth,
      payload: payloadWithKey({ type: 'note', title: '一筆記憶' }),
    });
    // a denial (agent PATCH) is audited too
    const created = await app.inject({
      method: 'POST',
      url: '/v1/items',
      headers: auth,
      payload: payloadWithKey({ type: 'note', title: '再一筆' }),
    });
    await app.inject({
      method: 'PATCH',
      url: `/v1/items/${created.json().item.id}`,
      headers: { ...auth, 'idempotency-key': randomUUID() },
      payload: { title: 'x', expected_revision: 1 },
    });

    // the agent itself lacks audit.read
    expect((await app.inject({ method: 'GET', url: '/v1/audit', headers: auth })).statusCode).toBe(403);

    const entries = (await app.inject({ method: 'GET', url: '/v1/audit?namespace=personal', headers: admin })).json()
      .entries as any[];
    const actions = entries.map((e) => `${e.action}:${e.outcome}`);
    expect(actions).toContain('read.search:allow');
    expect(actions).toContain('write.create:allow');
    expect(actions).toContain('write.patch:deny');
    for (const e of entries) expect(e.namespace).toBe('personal');
    // details never contain the raw query text
    const searchRow = entries.find((e) => e.action === 'read.search')!;
    expect(JSON.stringify(searchRow.details)).not.toContain('任何');
  });

  it('key rotation invalidates the old key immediately and preserves identity', async () => {
    const agentKey = await createClient('hermes', 'agent', ['read', 'write']);
    expect((await app.inject({ method: 'GET', url: '/v1/items', headers: { authorization: `Bearer ${agentKey}` } })).statusCode).toBe(200);

    const rotated = await app.inject({ method: 'POST', url: '/v1/clients/hermes/rotate-key', headers: admin });
    expect(rotated.statusCode).toBe(200);
    const newKey = rotated.json().api_key as string;
    expect(rotated.json().client.credential_version).toBe(2);
    expect(rotated.json().client.id).toBe('hermes');

    expect((await app.inject({ method: 'GET', url: '/v1/items', headers: { authorization: `Bearer ${agentKey}` } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/v1/items', headers: { authorization: `Bearer ${newKey}` } })).statusCode).toBe(200);
  });

  it('operational state slots: exact-key rules, schema validation, dedicated surface', async () => {
    const appKey = await createClient('finance-app', 'service', ['read', 'write']);
    const otherKey = await createClient('other-app', 'service', ['read', 'write']);

    // register schema + state rule
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/v1/state-schemas/budget-v1',
          headers: admin,
          payload: { fields: { spent: { type: 'number', required: true }, budget: { type: 'number', required: true } } },
        })
      ).statusCode,
    ).toBe(200);
    const currentPolicy = (await app.inject({ method: 'GET', url: '/v1/policies/personal', headers: admin })).json();
    const rules = currentPolicy.rules;
    rules.grants = rules.grants.map((g: any) =>
      g.client_id === 'finance-app' ? { ...g, capabilities: [...g.capabilities, 'state.read', 'state.write'] } : g,
    );
    rules.state_rules = [
      {
        rule_id: 'st-budget',
        state_key: 'monthly-food-budget',
        schema_id: 'budget-v1',
        read_clients: ['finance-app'],
        write_clients: ['finance-app'],
        mutable_fields: ['value', 'observed_at'],
      },
    ];
    expect(
      (await app.inject({ method: 'PUT', url: '/v1/policies/personal', headers: admin, payload: { rules } })).statusCode,
    ).toBe(200);

    const put = await app.inject({
      method: 'PUT',
      url: '/v1/state/monthly-food-budget',
      headers: { authorization: `Bearer ${appKey}` },
      payload: { schema_id: 'budget-v1', value: { spent: 9840, budget: 12000 }, idempotency_key: randomUUID() },
    });
    expect(put.statusCode).toBe(201);

    // schema violation rejected
    const badValue = await app.inject({
      method: 'PUT',
      url: '/v1/state/monthly-food-budget',
      headers: { authorization: `Bearer ${appKey}` },
      payload: { schema_id: 'budget-v1', value: { spent: 'not-a-number' }, expected_revision: 1, idempotency_key: randomUUID() },
    });
    expect(badValue.statusCode).toBe(400);

    // wrong schema id rejected
    const badSchema = await app.inject({
      method: 'PUT',
      url: '/v1/state/monthly-food-budget',
      headers: { authorization: `Bearer ${appKey}` },
      payload: { schema_id: 'other', value: { spent: 1, budget: 2 }, expected_revision: 1, idempotency_key: randomUUID() },
    });
    expect(badSchema.statusCode).toBe(403);

    // key typo does NOT hit the rule
    const typo = await app.inject({
      method: 'PUT',
      url: '/v1/state/monthly-food-budgetx',
      headers: { authorization: `Bearer ${appKey}` },
      payload: { schema_id: 'budget-v1', value: { spent: 1, budget: 2 }, idempotency_key: randomUUID() },
    });
    expect(typo.statusCode).toBe(403);

    // non-listed client cannot read or write
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/v1/state/monthly-food-budget',
          headers: { authorization: `Bearer ${otherKey}` },
        })
      ).statusCode,
    ).toBe(403);

    // listed client reads it back; the slot is EXCLUDED from search/list
    const read = await app.inject({
      method: 'GET',
      url: '/v1/state/monthly-food-budget',
      headers: { authorization: `Bearer ${appKey}` },
    });
    expect(read.statusCode).toBe(200);
    expect(read.json().item.data.value.spent).toBe(9840);
    const search = await app.inject({
      method: 'GET',
      url: '/v1/items?q=monthly-food-budget',
      headers: { authorization: `Bearer ${appKey}` },
    });
    expect(search.json().total_matched).toBe(0);
  });
});
