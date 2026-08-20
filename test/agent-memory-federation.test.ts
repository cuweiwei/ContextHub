import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newItemSchema } from '../src/core/types.js';
import { ADMIN_ACCESS, ADMIN_CLIENT, buildTestEnv } from './helpers.js';

const CLAIM_KEY = 'user:tim/preference:response_language/scope:contexthub';
const TARGETS = ['openai', 'anthropic', 'hermes'] as const;

function item(overrides: Record<string, unknown>) {
  return newItemSchema.parse({
    type: 'preference',
    memory_kind: 'preference',
    title: 'ContextHub 回覆語言偏好',
    content: '使用繁體中文',
    claim_key: CLAIM_KEY,
    idempotency_key: randomUUID(),
    ...overrides,
  });
}

function payload(result: any): any {
  return JSON.parse(result.content[0].text);
}

describe.each(TARGETS)('Agent Memory Federation v1 compatibility: %s', (target) => {
  let env: ReturnType<typeof buildTestEnv>;
  let baseUrl: string;
  let agentKey: string;
  let workAgentKey: string;
  let currentId: string;

  beforeEach(async () => {
    env = buildTestEnv();
    agentKey = env.newClient({ id: `${target}-agent`, principalKind: 'agent' }).apiKey;
    workAgentKey = env.newClient({ id: `${target}-work-agent`, namespace: 'work', principalKind: 'agent' }).apiKey;
    const source = env.newClient({ id: `${target}-profile-source`, principalKind: 'service' }).auth;
    const workSource = env.newClient({ id: `${target}-work-source`, namespace: 'work', principalKind: 'service' }).auth;
    currentId = env.commands.createMemory(source, item({})).item.id;
    env.commands.createMemory(
      workSource,
      item({
        title: '工作 namespace 的同名 claim',
        content: 'English',
      }),
    );
    const address = await env.app.listen({ port: 0, host: '127.0.0.1' });
    baseUrl = `${address}/mcp`;
  });

  afterEach(async () => {
    await env.app.close();
  });

  async function connect(key: string): Promise<Client> {
    const client = new Client({ name: `${target}-compatibility-client`, version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(baseUrl), {
        requestInit: { headers: { authorization: `Bearer ${key}` } },
      }),
    );
    return client;
  }

  it('covers session startup, cache refresh, candidate, successor, and namespace isolation', async () => {
    const client = await connect(agentKey);
    expect(client.getInstructions()).toContain('Agent Memory Federation v1');
    expect(client.getInstructions()).toContain('local_only, cache_pointer, or shared_candidate');
    expect(client.getInstructions()).toContain('never self-accept or silently choose');

    const startup = payload(
      await client.callTool({
        name: 'compile_context',
        arguments: {
          intent: 'Start a new agent session',
          target_agent: target,
          token_budget: 800,
          claim_keys: [' USER:tim / Preference:response_language / Scope:contexthub '],
        },
      }),
    );
    expect(startup.conflicts).toEqual([]);
    expect(startup.sections.memories.map((entry: any) => entry.id)).toContain(currentId);

    const changes = payload(await client.callTool({ name: 'get_changes', arguments: { after: 0, limit: 1000 } }));
    expect(changes.protocol).toMatchObject({
      protocol: 'contexthub-agent-memory-federation/v1',
      local_memory_modes: ['local_only', 'cache_pointer', 'shared_candidate'],
      rules: {
        local_memory_is_authority: false,
        cache_pointer_copies_content: false,
        shared_memory_requires_candidate_review: true,
        unresolved_claims_are_excluded: true,
      },
    });
    const changed = changes.events.find((event: any) => event.entity_id === currentId);
    expect(changed.cache_pointer).toEqual({
      hub_item_id: currentId,
      revision: 1,
      change_cursor: changed.cursor,
      cached_at: changes.generated_at,
    });
    expect(Object.keys(changed.cache_pointer).sort()).toEqual([
      'cached_at',
      'change_cursor',
      'hub_item_id',
      'revision',
    ]);

    const candidate = payload(
      await client.callTool({
        name: 'save_memory',
        arguments: {
          type: 'preference',
          memory_kind: 'preference',
          title: '可能的新語言偏好',
          content: '尚待使用者確認改成英文',
          claim_key: CLAIM_KEY,
          idempotency_key: randomUUID(),
        },
      }),
    );
    expect(candidate.trust_state).toBe('candidate');
    expect(env.itemsRepo.get(ADMIN_ACCESS, candidate.item_id)?.claim_key).toBe(CLAIM_KEY);

    const successor = payload(
      await client.callTool({
        name: 'propose_successor',
        arguments: {
          predecessor_id: currentId,
          type: 'preference',
          memory_kind: 'preference',
          title: 'ContextHub 回覆語言偏好（更新）',
          content: '優先使用繁體中文，程式碼維持英文識別字',
          idempotency_key: randomUUID(),
        },
      }),
    );
    expect(successor.trust_state).toBe('candidate');
    expect(env.itemsRepo.get(ADMIN_ACCESS, successor.item_id)?.claim_key).toBe(CLAIM_KEY);

    env.commands.reviewMemory(
      ADMIN_CLIENT,
      successor.item_id,
      { decision: 'accept', expectedRevision: 1 },
      randomUUID(),
    );
    expect(env.itemsRepo.get(ADMIN_ACCESS, currentId)?.status).toBe('superseded');
    const refreshed = payload(
      await client.callTool({
        name: 'compile_context',
        arguments: {
          intent: 'Refresh the current language preference',
          target_agent: target,
          token_budget: 800,
          claim_keys: [CLAIM_KEY],
        },
      }),
    );
    expect(refreshed.conflicts).toEqual([]);
    expect(refreshed.sections.memories.map((entry: any) => entry.id)).toContain(successor.item_id);
    expect(refreshed.sections.memories.map((entry: any) => entry.id)).not.toContain(currentId);

    const workClient = await connect(workAgentKey);
    const isolated = payload(
      await workClient.callTool({
        name: 'compile_context',
        arguments: {
          intent: 'Read the work namespace language preference',
          target_agent: target,
          token_budget: 800,
          claim_keys: [CLAIM_KEY],
        },
      }),
    );
    expect(isolated.constraints.namespace).toBe('work');
    expect(isolated.sections.memories.map((entry: any) => entry.id)).not.toContain(successor.item_id);
    expect(isolated.sections.memories).toHaveLength(1);

    await workClient.close();
    await client.close();
  });
});

describe('Agent Memory Federation v1 conflict contract', () => {
  let env: ReturnType<typeof buildTestEnv>;
  let baseUrl: string;
  let agentKey: string;

  beforeEach(async () => {
    env = buildTestEnv();
    agentKey = env.newClient({ id: 'conflict-agent', principalKind: 'agent' }).apiKey;
    const firstSource = env.newClient({ id: 'profile-source-a', principalKind: 'service' }).auth;
    const secondSource = env.newClient({ id: 'profile-source-b', principalKind: 'service' }).auth;
    env.commands.createMemory(firstSource, item({ title: '偏好 A', content: '使用繁體中文' }));
    env.commands.createMemory(secondSource, item({ title: 'Unrelated wording', content: 'Use English' }));
    const address = await env.app.listen({ port: 0, host: '127.0.0.1' });
    baseUrl = `${address}/mcp`;
  });

  afterEach(async () => {
    await env.app.close();
  });

  it.each(TARGETS)('returns conflicts[] and excludes every claimant for %s', async (target) => {
    const client = new Client({ name: 'conflict-compatibility-client', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(baseUrl), {
        requestInit: { headers: { authorization: `Bearer ${agentKey}` } },
      }),
    );
    const compiled = payload(
      await client.callTool({
        name: 'compile_context',
        arguments: {
          intent: '偏好 A',
          target_agent: target,
          token_budget: 256,
          claim_keys: [CLAIM_KEY],
        },
      }),
    );
    expect(compiled.conflicts).toHaveLength(1);
    expect(compiled.conflicts[0]).toMatchObject({
      claim_key: CLAIM_KEY,
      status: 'unresolved',
      reason: 'multiple_active_accepted_claims',
      required_action: 'inspect_history_and_adjudicate',
    });
    expect(compiled.conflicts[0].item_ids).toHaveLength(2);
    expect(compiled.sections.memories).toEqual([]);
    expect(compiled.omitted.conflict).toBe(2);
    expect(compiled.constraints.unresolved_claims_excluded).toBe(true);
    expect(compiled.estimated_tokens).toBeLessThanOrEqual(256);
    expect(compiled.rendered_context).toMatch(/unresolved.claim.conflict/i);
    await client.close();
  });

  it('normalizes valid claim keys and rejects malformed identities', () => {
    expect(item({ claim_key: ' USER:Tim / Preference:Response_Language / Scope:ContextHub ' }).claim_key).toBe(
      CLAIM_KEY,
    );
    expect(() => item({ claim_key: 'preference-only' })).toThrow(/claim_key/i);
  });

  it('hides another agent candidate from the cache feed, then emits it after acceptance', () => {
    const writer = env.newClient({ id: 'candidate-writer', principalKind: 'agent' }).auth;
    const reader = env.clientsRepo.verifyKey(agentKey)!;
    const before = env.commands.changes(reader, { after: 0, limit: 1000 });
    const candidate = env.commands.createMemory(
      writer,
      item({
        title: '候選偏好',
        content: '尚未裁決',
        claim_key: 'user:tim/preference:editor_theme/scope:contexthub',
      }),
    ).item;

    const hidden = env.commands.changes(reader, { after: before.next_cursor, limit: 1000 });
    expect(hidden.events.map((event) => event.entity_id)).not.toContain(candidate.id);
    expect(hidden.next_cursor).toBeGreaterThan(before.next_cursor);

    env.commands.reviewMemory(
      ADMIN_CLIENT,
      candidate.id,
      { decision: 'accept', expectedRevision: 1 },
      randomUUID(),
    );
    const accepted = env.commands.changes(reader, { after: hidden.next_cursor, limit: 1000 });
    expect(accepted.events.map((event) => event.entity_id)).toContain(candidate.id);
    expect(accepted.events.find((event) => event.entity_id === candidate.id)?.cache_pointer?.revision).toBe(2);
  });
});
