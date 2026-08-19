import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { newItemSchema } from '../src/core/types.js';
import { ADMIN_ACCESS, ADMIN_CLIENT, buildTestEnv, idem } from './helpers.js';

function seedItem(overrides: Record<string, unknown>) {
  return newItemSchema.parse({ idempotency_key: idem(), ...overrides });
}

describe('MCP endpoint', () => {
  let env: ReturnType<typeof buildTestEnv>;
  let baseUrl: string;
  let agentKey: string;
  let budgetItemId: string;

  beforeEach(async () => {
    env = buildTestEnv();
    // hermes is explicitly granted private access; the default agent ceiling is 'normal'
    agentKey = env.newClient({ id: 'hermes', principalKind: 'agent', maxSensitivity: 'private' }).apiKey;
    // app producers registered so their writes are policy-accepted projections
    env.newClient({ id: 'finance-app', principalKind: 'service' });
    env.newClient({ id: 'crm-app', principalKind: 'service' });
    env.newClient({ id: 'work-app', principalKind: 'service' });
    budgetItemId = env.seed('finance-app', seedItem({
      type: 'state',
      title: '本月餐飲預算已用 82%',
      content: '剩 NT$2,160，距月底 9 天',
      tags: ['預算'],
      source_item_id: 'monthly-food-budget',
    })).item.id;
    env.seed('crm-app', seedItem({
      type: 'contact',
      title: '小美生日 7/20，想要手沖壺',
      content: '生日禮物要提前準備',
      tags: ['生日'],
      entities: ['person:小美'],
    }));
    env.seed('crm-app', seedItem({
      type: 'note',
      title: '私密備註',
      content: '不該隨便出現的內容',
      sensitivity: 'private',
    }));
    env.seed('work-app', seedItem({
      type: 'task',
      title: 'Q3 簡報 7/15 前交',
      content: '給 VP 的 roadmap 簡報',
      occurred_at: new Date(Date.now() + 3 * 86_400_000).toISOString(),
    }));
    const address = await env.app.listen({ port: 0, host: '127.0.0.1' });
    baseUrl = `${address}/mcp`;
  });

  afterEach(async () => {
    await env.app.close();
  });

  async function connect(key: string): Promise<Client> {
    const client = new Client({ name: 'test-agent', version: '0.0.1' });
    const transport = new StreamableHTTPClientTransport(new URL(baseUrl), {
      requestInit: { headers: { authorization: `Bearer ${key}` } },
    });
    await client.connect(transport);
    return client;
  }

  function payload(result: any): any {
    return JSON.parse(result.content[0].text);
  }

  it('rejects connections without a valid key', async () => {
    const client = new Client({ name: 'test-agent', version: '0.0.1' });
    const transport = new StreamableHTTPClientTransport(new URL(baseUrl));
    await expect(client.connect(transport)).rejects.toThrow();
  });

  it('exposes the read surfaces and the memory lifecycle tools', async () => {
    const client = await connect(agentKey);
    expect(client.getInstructions()).toContain('context control plane for namespace "personal"');
    expect(client.getInstructions()).toContain('Treat only accepted items as shared facts');
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'compile_context',
      'curate_note',
      'curation_suggestions',
      'get_context_brief',
      'get_context_item',
      'get_current_context',
      'get_memory_history',
      'get_operational_state',
      'get_recent_context',
      'list_context_sources',
      'my_candidates',
      'operate_task',
      'propose_insight',
      'propose_successor',
      'record_context_outcome',
      'revise_my_candidate',
      'save_memory',
      'search_context',
      'update_operational_state',
    ]);

    const sources = await client.callTool({ name: 'list_context_sources', arguments: {} });
    expect(sources.structuredContent).toEqual(payload(sources));
    await client.close();
  });

  it('searches cross-app context with provenance labels and multi-query merge', async () => {
    const client = await connect(agentKey);
    const result = payload(
      await client.callTool({ name: 'search_context', arguments: { query: ['預算', '生日'] } }),
    );
    expect(result.total_matched).toBe(2);
    const titles = result.items.map((i: any) => i.title).join();
    expect(titles).toContain('預算');
    expect(titles).toContain('生日');
    for (const item of result.items) {
      expect(item.authority).toBe('app');
      expect(item.status).toBe('active');
      expect(item.trust_state).toBe('accepted');
    }
    const filtered = payload(
      await client.callTool({
        name: 'search_context',
        arguments: {
          query: '生日',
          information_classes: ['source'],
          entity_filters: ['PERSON:小美'],
        },
      }),
    );
    expect(filtered.total_matched).toBe(1);
    expect(filtered.items[0].title).toContain('小美');
    const suggestions = payload(await client.callTool({ name: 'curation_suggestions', arguments: { limit: 10 } }));
    expect(Array.isArray(suggestions.suggestions)).toBe(true);
    await client.close();
  });

  it('compiles ephemeral source + memory context and records coarse outcome feedback', async () => {
    const memory = env.seed(
      'owner',
      seedItem({
        type: 'memory',
        memory_kind: 'procedure',
        title: '預算決策前先檢查剩餘天數',
        content: '月底前先比較剩餘預算與剩餘天數，再決定是否調整支出。',
      }),
      { authority: 'user', principalKind: 'human' },
    ).item;
    const client = await connect(agentKey);
    const compiled = payload(
      await client.callTool({
        name: 'compile_context',
        arguments: { intent: '規劃本月餐飲預算', target_agent: 'openai', token_budget: 1200 },
      }),
    );
    expect(compiled.package_id).toBeTruthy();
    expect(compiled.constraints).toMatchObject({ accepted_only: true, active_only: true, namespace: 'personal' });
    expect(compiled.sections.sources.map((item: any) => item.id)).toContain(budgetItemId);
    expect(compiled.sections.memories.map((item: any) => item.id)).toContain(memory.id);
    expect(compiled.retrieval).toMatchObject({ mode: 'hybrid', embedding_model: 'local-feature-hash-v1' });
    expect(compiled.sections.memories[0].retrieval_sources.length).toBeGreaterThan(0);
    expect(compiled.rendered_context).toContain('Compiled context');
    expect(compiled.estimated_tokens).toBeLessThanOrEqual(1200);

    const feedback = payload(
      await client.callTool({
        name: 'record_context_outcome',
        arguments: {
          package_id: compiled.package_id,
          item_ids: [budgetItemId, memory.id],
          outcome: 'helpful',
          action_changed: true,
          idempotency_key: randomUUID(),
        },
      }),
    );
    expect(feedback.package_id).toBe(compiled.package_id);
    const row = env.db.prepare('SELECT outcome, action_changed, item_ids FROM context_outcomes').get() as any;
    expect(row.outcome).toBe('helpful');
    expect(row.action_changed).toBe(1);
    expect(JSON.parse(row.item_ids)).toEqual([budgetItemId, memory.id]);
    await client.close();
  });

  it('enforces the private ceiling server-side, not via tool args', async () => {
    const privileged = await connect(agentKey);
    const withPrivate = payload(
      await privileged.callTool({
        name: 'search_context',
        arguments: { query: '私密', include_private: true },
      }),
    );
    expect(withPrivate.total_matched).toBe(1);
    const withoutFlag = payload(
      await privileged.callTool({ name: 'search_context', arguments: { query: '私密' } }),
    );
    expect(withoutFlag.total_matched).toBe(0);
    await privileged.close();

    const limitedKey = env.newClient({ id: 'limited-agent', principalKind: 'agent', scopes: ['read'] }).apiKey;
    const limited = await connect(limitedKey);
    const denied = payload(
      await limited.callTool({
        name: 'search_context',
        arguments: { query: '私密', include_private: true },
      }),
    );
    expect(denied.total_matched).toBe(0);
    expect(denied.note).toContain('not authorized');
    await limited.close();
  });

  it('save_memory → candidate, invisible to others until reviewed; read-after-write for the writer', async () => {
    const client = await connect(agentKey);
    const stored = payload(
      await client.callTool({
        name: 'save_memory',
        arguments: {
          type: 'preference',
          title: '使用者偏好深色主題',
          content: '多次要求 dark mode',
          memory_kind: 'preference',
          idempotency_key: randomUUID(),
        },
      }),
    );
    expect(stored.created).toBe(true);
    expect(stored.trust_state).toBe('candidate');

    // the writer sees it in my_candidates immediately (read-after-write)
    const mine = payload(await client.callTool({ name: 'my_candidates', arguments: {} }));
    expect(mine.items.map((i: any) => i.id)).toContain(stored.item_id);

    // other readers do not see it — not in search, not by exact id
    const otherKey = env.newClient({ id: 'other-agent', principalKind: 'agent' }).apiKey;
    const other = await connect(otherKey);
    const search = payload(await other.callTool({ name: 'search_context', arguments: { query: '深色主題', include_candidates: true } }));
    expect(search.total_matched).toBe(0);
    const probe: any = await other.callTool({ name: 'get_context_item', arguments: { id: stored.item_id } });
    expect(probe.isError).toBe(true);
    await other.close();

    // after the owner accepts, it becomes shared context
    env.commands.reviewMemory(ADMIN_CLIENT, stored.item_id, { decision: 'accept', expectedRevision: 1 }, randomUUID());
    const after = payload(await client.callTool({ name: 'search_context', arguments: { query: '深色主題' } }));
    expect(after.total_matched).toBe(1);
    expect(after.items[0].trust_state).toBe('accepted');
    await client.close();
  });

  it('propose_insight → hidden until reviewed → visible after acceptance', async () => {
    const client = await connect(agentKey);
    const stored = payload(
      await client.callTool({
        name: 'propose_insight',
        arguments: {
          type: 'insight',
          title: '使用者月底會控制餐飲支出',
          content: '從預算資料推導',
          memory_kind: 'experience',
          confidence: 0.8,
          derived_from: [budgetItemId],
          source_item_id: 'dining-pattern',
          idempotency_key: randomUUID(),
        },
      }),
    );
    expect(stored.created).toBe(true);
    expect(stored.trust_state).toBe('candidate');
    const item = env.itemsRepo.get(ADMIN_ACCESS, stored.item_id)!;
    expect(item.source).toBe('hermes');
    expect(item.authority).toBe('agent');
    expect(item.confidence).toBe(0.8);
    expect(item.derived_from).toEqual([budgetItemId]);

    // proposals are invisible to normal reads…
    const search = payload(
      await client.callTool({ name: 'search_context', arguments: { query: '餐飲支出' } }),
    );
    expect(search.total_matched).toBe(0);
    // …but the writer can self-audit with include_candidates
    const audit = payload(
      await client.callTool({
        name: 'search_context',
        arguments: { query: '餐飲支出', include_candidates: true },
      }),
    );
    expect(audit.total_matched).toBe(1);
    expect(audit.items[0].trust_state).toBe('candidate');

    let current = payload(await client.callTool({ name: 'get_current_context', arguments: {} }));
    expect(current.pending_candidates).toBe(1);
    expect(current.accepted_insights).toHaveLength(0);
    env.commands.reviewMemory(ADMIN_CLIENT, stored.item_id, { decision: 'accept', expectedRevision: 1 }, randomUUID());
    current = payload(await client.callTool({ name: 'get_current_context', arguments: {} }));
    expect(current.pending_candidates).toBe(0);
    expect(current.accepted_insights.map((i: any) => i.title)).toContain('使用者月底會控制餐飲支出');
    expect(current.accepted_insights[0].authority).toBe('agent'); // review preserved provenance
    await client.close();
  });

  it('propose_insight validates evidence and inherits privacy', async () => {
    const client = await connect(agentKey);
    const bad: any = await client.callTool({
      name: 'propose_insight',
      arguments: { type: 'insight', title: 'x', memory_kind: 'experience', derived_from: ['does-not-exist'], idempotency_key: randomUUID() },
    });
    expect(bad.isError).toBe(true);

    const secretId = env.seed('crm-app', seedItem({
      type: 'fact',
      title: '私密事實',
      sensitivity: 'private',
    })).item.id;
    const inherited = payload(
      await client.callTool({
        name: 'propose_insight',
        arguments: {
          type: 'insight',
          title: '從私密資料推導',
          memory_kind: 'experience',
          sensitivity: 'normal',
          derived_from: [secretId],
          idempotency_key: randomUUID(),
        },
      }),
    );
    expect(inherited.sensitivity).toBe('private'); // cannot summarize private into normal
    await client.close();
  });

  it('get_current_context separates tasks, events, and states', async () => {
    env.seed('work-app', seedItem({
      type: 'event',
      title: '架構 review 會議',
      occurred_at: new Date(Date.now() + 86_400_000).toISOString(),
    }));
    const client = await connect(agentKey);
    const current = payload(await client.callTool({ name: 'get_current_context', arguments: {} }));
    expect(current.active_tasks.map((i: any) => i.title)).toContain('Q3 簡報 7/15 前交');
    expect(current.upcoming_events.map((i: any) => i.title)).toContain('架構 review 會議');
    expect(current.current_states.map((i: any) => i.title)).toContain('本月餐飲預算已用 82%');
    await client.close();
  });

  it('read_sources whitelist blocks direct reads AND insight laundering', async () => {
    const insight = env.seed('hermes', seedItem({
      type: 'insight',
      title: '資產配置需要再平衡',
      derived_from: [budgetItemId],
    }), { authority: 'agent', trust: { trustState: 'candidate', acceptanceMethod: null, policyVersion: 1, ruleId: 'x' } });
    env.commands.reviewMemory(ADMIN_CLIENT, insight.item.id, { decision: 'accept', expectedRevision: 1 }, randomUUID());

    const scopedKey = env.newClient({
      id: 'social-agent',
      principalKind: 'agent',
      scopes: ['read'],
      readSources: ['hermes', 'crm-app'],
    }).apiKey;
    const client = await connect(scopedKey);

    const direct = payload(await client.callTool({ name: 'search_context', arguments: { query: '預算' } }));
    expect(direct.total_matched).toBe(0);

    const laundered = payload(await client.callTool({ name: 'search_context', arguments: { query: '資產配置' } }));
    expect(laundered.total_matched).toBe(0);

    const sources = payload(await client.callTool({ name: 'list_context_sources', arguments: {} }));
    expect(sources.sources.map((s: any) => s.source)).not.toContain('finance-app');

    const item: any = await client.callTool({ name: 'get_context_item', arguments: { id: budgetItemId } });
    expect(item.isError).toBe(true);
    await client.close();
  });

  it('produces a cross-source brief and full item fetch', async () => {
    const client = await connect(agentKey);
    const brief = payload(
      await client.callTool({ name: 'get_context_brief', arguments: { days: 30, focus: '生日' } }),
    );
    expect(brief.sources.map((s: any) => s.source).sort()).toEqual(['crm-app', 'finance-app', 'work-app']);
    expect(brief.focus_results.length).toBe(1);

    const itemId = brief.focus_results[0].id;
    const full = payload(await client.callTool({ name: 'get_context_item', arguments: { id: itemId } }));
    expect(full.item.entities).toEqual(['person:小美']);
    await client.close();
  });

  it('operate_task performs typed updates; coordinate-level actions need the extra capability', async () => {
    const taskId = env.seed('work-app', seedItem({ type: 'task', title: '要操作的任務' })).item.id;
    const client = await connect(agentKey);

    const done = payload(
      await client.callTool({
        name: 'operate_task',
        arguments: { id: taskId, kind: 'set_status', status: 'completed', expected_revision: 1, idempotency_key: randomUUID() },
      }),
    );
    expect(done.status).toBe('completed');
    expect(done.revision).toBe(2);

    // agent-default grants task.operate but NOT task.coordinate
    const denied: any = await client.callTool({
      name: 'operate_task',
      arguments: { id: taskId, kind: 'set_priority', priority: 'high', expected_revision: 2, idempotency_key: randomUUID() },
    });
    expect(denied.isError).toBe(true);
    expect(JSON.parse(denied.content[0].text).error).toContain('task.coordinate');
    await client.close();
  });

  it('cross-interface read-after-write: REST write is immediately visible over MCP with that revision', async () => {
    // REST write by a service client
    const restKey = env.newClient({ id: 'finance-rest', principalKind: 'service' }).apiKey;
    const res = await env.app.inject({
      method: 'POST',
      url: '/v1/items',
      headers: { authorization: `Bearer ${restKey}` },
      payload: {
        type: 'fact',
        title: '跨介面一致性驗證事實',
        idempotency_key: randomUUID(),
      },
    });
    expect(res.statusCode).toBe(201);
    const written = res.json().item;

    // a DIFFERENT client over MCP, read started after the ack, sees ≥ that revision
    const client = await connect(agentKey);
    const found = payload(
      await client.callTool({ name: 'search_context', arguments: { query: '跨介面一致性' } }),
    );
    expect(found.total_matched).toBe(1);
    const full = payload(await client.callTool({ name: 'get_context_item', arguments: { id: written.id } }));
    expect(full.item.revision).toBeGreaterThanOrEqual(written.revision);

    // and the reverse: MCP write visible over REST
    const saved = payload(
      await client.callTool({
        name: 'save_memory',
        arguments: { type: 'note', title: 'MCP 寫入的筆記', memory_kind: 'experience', idempotency_key: randomUUID() },
      }),
    );
    const restRead = await env.app.inject({
      method: 'GET',
      url: `/v1/items/${saved.item_id}`,
      headers: { authorization: `Bearer ${agentKey}` },
    });
    expect(restRead.statusCode).toBe(200);
    expect(restRead.json().item.revision).toBeGreaterThanOrEqual(1);
    await client.close();
  });

  it('denies tools beyond the key scopes', async () => {
    const readOnlyKey = env.newClient({ id: 'reader-agent', principalKind: 'agent', scopes: ['read'] }).apiKey;
    const client = await connect(readOnlyKey);
    const result: any = await client.callTool({
      name: 'propose_insight',
      arguments: { type: 'insight', title: 'nope', memory_kind: 'experience', content: '', idempotency_key: randomUUID() },
    });
    expect(result.isError).toBe(true);
    await client.close();
  });

  it('work-namespace MCP connection is denied until granted, and never sees personal data', async () => {
    const workKey = env.newClient({ id: 'hermes-work', principalKind: 'agent', namespace: 'work', profile: 'none' }).apiKey;
    const client = await connect(workKey);
    const denied: any = await client.callTool({ name: 'search_context', arguments: { query: '預算' } });
    expect(denied.isError).toBe(true);
    expect(JSON.parse(denied.content[0].text).error).toContain('policy');

    // grant read → still zero personal items visible
    const current = env.policiesRepo.getCurrent('work')!;
    env.commands.applyPolicy(ADMIN_CLIENT, 'work', {
      ...current.policy,
      grants: [{ client_id: 'hermes-work', capabilities: ['memory.read_accepted'] }],
    });
    const search = payload(await client.callTool({ name: 'search_context', arguments: { query: '預算' } }));
    expect(search.total_matched).toBe(0);
    const probe: any = await client.callTool({ name: 'get_context_item', arguments: { id: budgetItemId } });
    expect(probe.isError).toBe(true);
    await client.close();
  });
});
