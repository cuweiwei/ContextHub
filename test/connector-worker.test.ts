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

  it('normalizes operational state responses and omits null optimistic revisions', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const rest = new ConnectorRestClient('http://hub.test', 'chk_test', async (input, init) => {
      requests.push({ url: String(input), init });
      return new Response(JSON.stringify({ item: { data: { value: { cursor: 'next' } }, revision: 4 } }), { status: 200 });
    });
    await expect(rest.getOperationalState('connector.github:repo')).resolves.toMatchObject({ value: { cursor: 'next' }, revision: 4 });
    await rest.putOperationalState('connector.github:repo', { cursor: 'next' }, 'checkpoint/v1', null, 'idem-1');
    expect(JSON.parse(String(requests[1]?.init?.body))).not.toHaveProperty('expected_revision');
  });
});
