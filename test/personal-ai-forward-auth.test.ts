import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestEnv } from './helpers.js';

describe('Personal AI Portal forward-auth projection', () => {
  let env: ReturnType<typeof buildTestEnv>;
  let app: FastifyInstance;

  beforeEach(() => {
    env = buildTestEnv({
      controlCenterEnabled: true,
      controlCenterTrustedProxy: true,
      controlCenterPaiForwardAuthEnabled: true,
      controlCenterPaiOrigin: 'https://portal.test:9084',
    });
    app = env.app;
  });
  afterEach(async () => app.close());

  function headers(ownerId = 'owner-id') {
    return {
      host: 'portal.test:9084',
      'x-pai-verified': '1',
      'x-pai-owner-id': ownerId,
      'x-pai-session-id': 'session-id',
      'x-pai-auth-time': String(Date.now()),
      'x-pai-request-id': 'request-id',
    };
  }

  it('maps an explicitly enrolled Personal AI owner to linked human namespaces', async () => {
    const human = env.newClient({ id: 'portal-human', principalKind: 'human', profile: 'reviewer', scopes: ['read', 'review_insight'] });
    const principal = env.webPrincipalsRepo.add({ provider: 'personal-ai', subject: 'owner-id', displayName: 'Owner', controlAdmin: true });
    env.webPrincipalsRepo.linkClient(principal.id, env.clientsRepo.get(human.auth.id)!, 'test');

    const response = await app.inject({ method: 'GET', url: '/v1/control/namespaces', headers: headers() });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ namespaces: [{ namespace: 'personal', linked_clients: ['portal-human'] }] });
  });

  it('fails closed for mutations, unknown owners, and the wrong public origin', async () => {
    env.webPrincipalsRepo.add({ provider: 'personal-ai', subject: 'owner-id', displayName: 'Owner', controlAdmin: true });
    const mutation = await app.inject({ method: 'POST', url: '/v1/control/agents', headers: { ...headers(), 'content-type': 'application/json' }, payload: {} });
    expect(mutation.statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/v1/control/namespaces', headers: headers('unknown-owner') })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/v1/control/namespaces', headers: { ...headers(), host: 'hub.test' } })).statusCode).toBe(401);
  });
});
