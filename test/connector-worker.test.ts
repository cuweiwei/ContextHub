import { describe, expect, it, vi } from 'vitest';
import { runConnectorWorker } from '../src/connectors/worker-runtime.js';
import { ConnectorRestClient } from '../src/connectors/sdk.js';

function client() {
  return { upsertBatch: vi.fn().mockResolvedValue({}), recordRun: vi.fn().mockResolvedValue({}) } as unknown as ConnectorRestClient;
}

describe('connector worker runtime', () => {
  it('pages, batches at 100, and records only metadata checkpoints', async () => {
    const rest = client(); let calls = 0;
    const result = await runConnectorWorker({
      connector: 'github', checkpointKey: 'github:repo:issues', client: rest,
      fetchPage: async (cursor) => { calls += 1; return calls === 1 ? { items: Array.from({ length: 101 }, (_, id) => ({ id })), nextCursor: 'next', complete: false } : { items: [{ id: 102 }], nextCursor: null, complete: true, checkpointValue: 'cursor-2' }; },
      map: (item) => ({ type: 'github_issue', title: String(item.id), source_item_id: String(item.id), idempotency_key: String(item.id) }),
      sleep: async () => undefined,
    });
    expect(result).toMatchObject({ status: 'ok', pages: 2, items: 102, checkpointValue: 'cursor-2' });
    expect(rest.upsertBatch).toHaveBeenCalledTimes(3);
    expect((rest.upsertBatch as ReturnType<typeof vi.fn>).mock.calls.every(([items]) => items.length <= 100)).toBe(true);
    expect(rest.recordRun).toHaveBeenCalledWith(expect.objectContaining({ status: 'ok', checkpoint_value: 'cursor-2' }), expect.any(String));
  });

  it('records a failed run and returns a redacted error code after retry exhaustion', async () => {
    const rest = client();
    const result = await runConnectorWorker({ connector: 'calendar', checkpointKey: 'calendar:primary', client: rest, fetchPage: async () => { throw new Error('token=secret provider unavailable'); }, map: () => { throw new Error('unreachable'); }, retryAttempts: 2, sleep: async () => undefined });
    expect(result.status).toBe('failed');
    expect(result.error_code).not.toContain('secret');
    expect(rest.recordRun).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }), expect.any(String));
  });

  it('uses content-derived batch keys so changed provider pages cannot replay stale idempotency results', async () => {
    const first = client();
    const second = client();
    const options = (rest: ConnectorRestClient, title: string) => ({
      connector: 'github', checkpointKey: 'github:repo:issues', client: rest,
      fetchPage: async () => ({ items: [{ id: 1, title }], nextCursor: null, complete: true, checkpointValue: 'done' }),
      map: (item: { id: number; title: string }) => ({ type: 'github_issue', title: item.title, source_item_id: String(item.id), idempotency_key: `${item.id}:${item.title}` }),
      sleep: async () => undefined,
    });
    await runConnectorWorker(options(first, 'old'));
    await runConnectorWorker(options(second, 'new'));
    const firstKey = (first.upsertBatch as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
    const secondKey = (second.upsertBatch as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
    expect(firstKey).not.toBe(secondKey);
  });

  it('normalizes operational state responses and omits null optimistic revisions', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const rest = new ConnectorRestClient('http://hub.test', 'chk_test', async (input, init) => {
      requests.push({ url: String(input), init });
      return new Response(JSON.stringify({ item: { data: { value: { cursor: 'next' } }, revision: 4 } }), { status: 200 });
    });
    await expect(rest.getOperationalState('connector.github:repo')).resolves.toMatchObject({ value: { cursor: 'next' }, revision: 4 });
    await rest.putOperationalState('connector.github:repo', { cursor: 'next' }, 'checkpoint/v1', null, 'idem-1');
    expect(JSON.parse(String(requests[1]?.init?.body))).not.toHaveProperty('expected_revision');
    expect(requests[0]?.init).toMatchObject({ redirect: 'manual' });
    expect(requests[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });
});
