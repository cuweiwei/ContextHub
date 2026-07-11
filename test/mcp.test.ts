import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { newItemSchema } from '../src/core/types.js';
import { ADMIN_ACCESS, buildTestEnv } from './helpers.js';

function seedItem(overrides: Record<string, unknown>) {
  return newItemSchema.parse(overrides);
}

describe('MCP endpoint', () => {
  let env: ReturnType<typeof buildTestEnv>;
  let baseUrl: string;
  let agentKey: string;
  let budgetItemId: string;

  beforeEach(async () => {
    env = buildTestEnv();
    // hermes is explicitly granted private access; the default agent ceiling is 'normal'
    agentKey = env.clientsRepo.create({
      id: 'hermes',
      name: 'Hermes 秘書',
      kind: 'agent',
      scopes: ['read', 'write'],
      maxSensitivity: 'private',
    }).apiKey;
    budgetItemId = env.itemsRepo.insert('finance-app', seedItem({
      type: 'state',
      title: '本月餐飲預算已用 82%',
      content: '剩 NT$2,160，距月底 9 天',
      tags: ['預算'],
      source_item_id: 'monthly-food-budget',
    }), 'app', ADMIN_ACCESS).item.id;
    env.itemsRepo.insert('crm-app', seedItem({
      type: 'contact',
      title: '小美生日 7/20，想要手沖壺',
      content: '生日禮物要提前準備',
      tags: ['生日'],
      entities: ['person:小美'],
    }), 'app', ADMIN_ACCESS);
    env.itemsRepo.insert('crm-app', seedItem({
      type: 'note',
      title: '私密備註',
      content: '不該隨便出現的內容',
      sensitivity: 'private',
    }), 'app', ADMIN_ACCESS);
    env.itemsRepo.insert('work-app', seedItem({
      type: 'task',
      title: 'Q3 簡報 7/15 前交',
      content: '給 VP 的 roadmap 簡報',
      occurred_at: new Date(Date.now() + 3 * 86_400_000).toISOString(),
    }), 'app', ADMIN_ACCESS);
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

  it('exposes the seven context tools', async () => {
    const client = await connect(agentKey);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'get_context_brief',
      'get_context_item',
      'get_current_context',
      'get_recent_context',
      'list_context_sources',
      'propose_insight',
      'search_context',
    ]);
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
    }
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

    const limitedKey = env.clientsRepo.create({
      id: 'limited-agent',
      name: 'limited',
      kind: 'agent',
      scopes: ['read'],
    }).apiKey;
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

  it('propose_insight → hidden until reviewed → visible after acceptance', async () => {
    const client = await connect(agentKey);
    const stored = payload(
      await client.callTool({
        name: 'propose_insight',
        arguments: {
          title: '使用者月底會控制餐飲支出',
          content: '從預算資料推導',
          confidence: 0.8,
          derived_from: [budgetItemId],
          source_item_id: 'dining-pattern',
        },
      }),
    );
    expect(stored.created).toBe(true);
    expect(stored.acceptance).toBe('proposed');
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
    // …but auditable with include_proposed
    const audit = payload(
      await client.callTool({
        name: 'search_context',
        arguments: { query: '餐飲支出', include_proposed: true },
      }),
    );
    expect(audit.total_matched).toBe(1);
    expect(audit.items[0].acceptance).toBe('proposed');

    // proposals count in current context; accepted insights appear after review
    let current = payload(await client.callTool({ name: 'get_current_context', arguments: {} }));
    expect(current.proposed_insights).toBe(1);
    expect(current.accepted_insights).toHaveLength(0);
    env.itemsRepo.review(stored.item_id, { acceptance: 'accepted', reviewedBy: 'admin', expectedRevision: 1 });
    current = payload(await client.callTool({ name: 'get_current_context', arguments: {} }));
    expect(current.proposed_insights).toBe(0);
    expect(current.accepted_insights.map((i: any) => i.title)).toContain('使用者月底會控制餐飲支出');
    expect(current.accepted_insights[0].authority).toBe('agent'); // review preserved provenance
    await client.close();
  });

  it('propose_insight validates evidence and inherits privacy', async () => {
    const client = await connect(agentKey);
    const bad: any = await client.callTool({
      name: 'propose_insight',
      arguments: { title: 'x', derived_from: ['does-not-exist'] },
    });
    expect(bad.isError).toBe(true);

    const secretId = env.itemsRepo.insert('crm-app', seedItem({
      type: 'fact',
      title: '私密事實',
      sensitivity: 'private',
    }), 'app', ADMIN_ACCESS).item.id;
    const inherited = payload(
      await client.callTool({
        name: 'propose_insight',
        arguments: { title: '從私密資料推導', sensitivity: 'normal', derived_from: [secretId] },
      }),
    );
    expect(inherited.sensitivity).toBe('private'); // cannot summarize private into normal
    await client.close();
  });

  it('get_current_context separates tasks, events, and states', async () => {
    env.itemsRepo.insert('work-app', seedItem({
      type: 'event',
      title: '架構 review 會議',
      occurred_at: new Date(Date.now() + 86_400_000).toISOString(),
    }), 'app', ADMIN_ACCESS);
    const client = await connect(agentKey);
    const current = payload(await client.callTool({ name: 'get_current_context', arguments: {} }));
    expect(current.active_tasks.map((i: any) => i.title)).toContain('Q3 簡報 7/15 前交');
    expect(current.upcoming_events.map((i: any) => i.title)).toContain('架構 review 會議');
    expect(current.current_states.map((i: any) => i.title)).toContain('本月餐飲預算已用 82%');
    await client.close();
  });

  it('read_sources whitelist blocks direct reads AND insight laundering', async () => {
    // hermes derives an accepted insight from finance data
    const insight = env.itemsRepo.insert('hermes', seedItem({
      type: 'insight',
      title: '資產配置需要再平衡',
      derived_from: [budgetItemId],
    }), 'agent', ADMIN_ACCESS);
    env.itemsRepo.review(insight.item.id, { acceptance: 'accepted', reviewedBy: 'admin', expectedRevision: 1 });

    // this agent may read hermes + crm-app, but NOT finance-app
    const scopedKey = env.clientsRepo.create({
      id: 'social-agent',
      name: 'social',
      kind: 'agent',
      scopes: ['read'],
      readSources: ['hermes', 'crm-app'],
    }).apiKey;
    const client = await connect(scopedKey);

    const direct = payload(await client.callTool({ name: 'search_context', arguments: { query: '預算' } }));
    expect(direct.total_matched).toBe(0); // finance-app items invisible

    const laundered = payload(await client.callTool({ name: 'search_context', arguments: { query: '資產配置' } }));
    expect(laundered.total_matched).toBe(0); // insight built on finance evidence also invisible

    const sources = payload(await client.callTool({ name: 'list_context_sources', arguments: {} }));
    expect(sources.sources.map((s: any) => s.source)).not.toContain('finance-app');

    const item: any = await client.callTool({ name: 'get_context_item', arguments: { id: budgetItemId } });
    expect(item.isError).toBe(true); // 404-equivalent, no existence leak
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

  it('denies tools beyond the key scopes', async () => {
    const readOnlyKey = env.clientsRepo.create({
      id: 'reader-agent',
      name: 'reader',
      kind: 'agent',
      scopes: ['read'],
    }).apiKey;
    const client = await connect(readOnlyKey);
    const result: any = await client.callTool({
      name: 'propose_insight',
      arguments: { title: 'nope', content: '' },
    });
    expect(result.isError).toBe(true);
    await client.close();
  });
});
