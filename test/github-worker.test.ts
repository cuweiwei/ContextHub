import { afterEach, describe, expect, it, vi } from 'vitest';
import { syncGitHub } from '../src/connectors/github-worker.js';

afterEach(() => vi.unstubAllGlobals());

describe('GitHub connector worker', () => {
  it('always resumes provider pagination at page one and uses a valid prior timestamp only as issues since', async () => {
    const providerUrls: string[] = [];
    const stateWrites: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: URL | string, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('api.github.com')) {
        providerUrls.push(url);
        return new Response('[]', { status: 200 });
      }
      if (url.includes('/v1/state/') && init?.method !== 'PUT') {
        return new Response(JSON.stringify({ item: { data: { value: { cursor: '2026-08-20T00:00:00.000Z' } }, revision: 7 } }), { status: 200 });
      }
      if (url.includes('/v1/state/') && init?.method === 'PUT') stateWrites.push(JSON.parse(String(init.body)));
      return new Response('{}', { status: 200 });
    }));

    const [result] = await syncGitHub({
      contextHubUrl: 'http://hub.test', contextHubKeyFile: '/not-used', checkpointSchemaId: 'github/v1',
      contextHubApiKey: 'chk_test', token: 'github_token', repositories: ['owner/repo'], resources: ['issues'],
    });

    expect(result).toMatchObject({ status: 'ok', pages: 1, items: 0 });
    const provider = new URL(providerUrls[0]!);
    expect(provider.searchParams.get('page')).toBe('1');
    expect(provider.searchParams.get('since')).toBe('2026-08-20T00:00:00.000Z');
    expect(stateWrites[0]).toMatchObject({ expected_revision: 7, value: { cursor: expect.stringMatching(/^2026-/) } });
  });

  it('ignores legacy page-number checkpoints instead of skipping new first-page updates', async () => {
    const providerUrls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: URL | string, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('api.github.com')) { providerUrls.push(url); return new Response('[]', { status: 200 }); }
      if (url.includes('/v1/state/') && init?.method !== 'PUT') return new Response(JSON.stringify({ item: { data: { value: { cursor: '7' } }, revision: 1 } }), { status: 200 });
      return new Response('{}', { status: 200 });
    }));
    await syncGitHub({ contextHubUrl: 'http://hub.test', contextHubKeyFile: '/not-used', checkpointSchemaId: 'github/v1', contextHubApiKey: 'chk_test', token: 'github_token', repositories: ['owner/repo'], resources: ['issues'] });
    const provider = new URL(providerUrls[0]!);
    expect(provider.searchParams.get('page')).toBe('1');
    expect(provider.searchParams.has('since')).toBe(false);
  });
});
