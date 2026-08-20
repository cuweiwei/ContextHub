import { describe, expect, it, vi } from 'vitest';
import { syncGoogleCalendar } from '../src/connectors/google-calendar-worker.js';

describe('Google Calendar worker boundary', () => {
  it('uses incremental metadata checkpoints and drops sensitive event fields', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: URL | string, init?: RequestInit) => {
      const url = String(input); requests.push({ url, init });
      if (url.includes('googleapis.com')) return new Response(JSON.stringify({ items: [{ id: 'event-1', summary: 'Planning', description: 'private body', attendees: [{ email: 'private@example.test' }], location: 'private', start: { dateTime: '2026-08-20T01:00:00Z' }, end: { dateTime: '2026-08-20T02:00:00Z' }, updated: '2026-08-20T00:00:00Z' }], nextSyncToken: 'sync-2' }), { status: 200 });
      if (url.includes('/v1/state/') && init?.method !== 'PUT') return new Response('{}', { status: 404 });
      return new Response('{}', { status: 200 });
    }));
    const [result] = await syncGoogleCalendar({ contextHubUrl: 'http://hub.test', contextHubKeyFile: '/not-used', checkpointSchemaId: 'calendar/v1', contextHubApiKey: 'chk_test', accessToken: 'oauth_test', calendars: ['primary'] });
    expect(result).toMatchObject({ status: 'ok', pages: 1, items: 1, checkpointValue: JSON.stringify({ syncToken: 'sync-2', fullReconcile: false }) });
    const upsert = requests.find((request) => request.url.endsWith('/v1/items/batch'));
    expect(upsert).toBeDefined();
    expect(String(upsert?.init?.body)).not.toContain('private');
    expect(requests.some((request) => request.url.includes('/v1/state/') && request.init?.method === 'PUT')).toBe(true);
    vi.unstubAllGlobals();
  });

  it('drops an invalid sync token and performs a full reconciliation', async () => {
    let providerCalls = 0; const providerUrls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: URL | string, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('googleapis.com')) {
        providerCalls += 1; providerUrls.push(url);
        if (providerCalls <= 3) return new Response('{}', { status: 410 });
        return new Response(JSON.stringify({ items: [], nextSyncToken: 'fresh-token' }), { status: 200 });
      }
      if (url.includes('/v1/state/') && init?.method !== 'PUT') return new Response(JSON.stringify({ value: { sync_token: 'stale-token' }, revision: 2 }), { status: 200 });
      return new Response('{}', { status: 200 });
    }));
    const results = await syncGoogleCalendar({ contextHubUrl: 'http://hub.test', contextHubKeyFile: '/not-used', checkpointSchemaId: 'calendar/v1', contextHubApiKey: 'chk_test', accessToken: 'oauth_test', calendars: ['primary'] });
    const result = results[0]!;
    expect(result.status).toBe('ok');
    expect(providerCalls).toBe(4);
    expect(providerUrls.at(-1)).toContain('timeMin=');
    expect(providerUrls.at(-1)).not.toContain('syncToken=');
    vi.unstubAllGlobals();
  });
});
