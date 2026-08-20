import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestEnv } from './helpers.js';

describe('Control Center web auth and enrollment', () => {
  let env: ReturnType<typeof buildTestEnv>;
  let app: FastifyInstance;
  beforeEach(() => {
    env = buildTestEnv({
      controlCenterEnabled: true,
      controlCenterTailscaleAuthEnabled: true,
      controlCenterTrustedProxy: true,
      controlCenterCanonicalOrigin: 'https://hub.test',
      agentEnrollmentEnabled: true,
    });
    app = env.app;
  });
  afterEach(async () => app.close());

  const proxyHeaders = {
    host: 'hub.test',
    'x-forwarded-proto': 'https',
    'tailscale-user-login': 'Owner@Example.com',
    'tailscale-user-name': 'Owner',
  };

  async function signedIn() {
    const human = env.newClient({ id: 'owner-reviewer', principalKind: 'human', profile: 'reviewer', scopes: ['read', 'review_insight'] });
    const principal = env.webPrincipalsRepo.add({ provider: 'tailscale', subject: 'owner@example.com', displayName: 'Owner', controlAdmin: true });
    env.webPrincipalsRepo.linkClient(principal.id, env.clientsRepo.get(human.auth.id)!, 'test');
    const login = await app.inject({ method: 'GET', url: '/auth/login?return_to=/agents', headers: proxyHeaders });
    expect(login.statusCode).toBe(302);
    const setCookie = login.headers['set-cookie'];
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)!.split(';')[0]!;
    const me = await app.inject({ method: 'GET', url: '/v1/control/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    return { cookie, csrf: me.json().csrf_token as string, human, principal };
  }

  it('does not trust identity headers when the request is not from the trusted HTTPS proxy', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/login', headers: { 'tailscale-user-login': 'owner@example.com', host: 'hub.test' } });
    expect(res.statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/v1/control/me' })).statusCode).toBe(401);
  });

  it('creates a revocable HttpOnly session without storing a reviewer key in HTML', async () => {
    const { cookie } = await signedIn();
    const page = await app.inject({ method: 'GET', url: '/memories', headers: { cookie } });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-security-policy']).toContain("script-src 'self'");
    expect(page.body).toContain('class="app-shell"');
    expect(page.body).toContain('type="module" src="/assets/control-center.js"');
    expect(page.body).toContain('id="namespace-selector"');
    expect(page.body).not.toMatch(/chk_[A-Za-z0-9_-]{20,}/);
    expect(page.body).not.toContain('ADMIN_TOKEN');
    const script = await app.inject({ method: 'GET', url: '/assets/control-center.js' });
    expect(script.statusCode).toBe(200);
    expect(script.headers['content-type']).toContain('text/javascript');
    expect(script.body).toContain("from './components.js'");
    const effectivenessPage = await app.inject({ method: 'GET', url: '/effectiveness', headers: { cookie } });
    expect(effectivenessPage.statusCode).toBe(200);
    const logout = await app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie, origin: 'https://hub.test', 'content-type': 'application/json', 'x-csrf-token': (await app.inject({ method: 'GET', url: '/v1/control/me', headers: { cookie } })).json().csrf_token }, payload: {} });
    expect(logout.statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/v1/control/me', headers: { cookie } })).statusCode).toBe(401);
  });

  it('separates control administration from namespace memory access and exchanges enrollment once', async () => {
    const { cookie, csrf, human } = await signedIn();
    const dashboard = await app.inject({ method: 'GET', url: '/v1/control/dashboard?namespace=work', headers: { cookie } });
    expect(dashboard.statusCode).toBe(403);

    const create = await app.inject({
      method: 'POST', url: '/v1/control/agents', headers: { cookie, origin: 'https://hub.test', 'content-type': 'application/json', 'x-csrf-token': csrf },
      payload: { id: 'new-agent', name: 'New Agent', namespace: 'work', principal_kind: 'agent', scopes: ['read', 'write'], profile: 'none', auth_method: 'enrollment_key' },
    });
    expect(create.statusCode).toBe(201);
    expect(create.json().api_key).toBeUndefined();
    const code = create.json().enrollment.code as string;
    expect(code).toMatch(/^enr_/);
    const exchanged = await app.inject({ method: 'POST', url: '/v1/agent-enrollment/exchange', headers: { 'content-type': 'application/json' }, payload: { code } });
    expect(exchanged.statusCode).toBe(200);
    expect(exchanged.json().api_key).toMatch(/^chk_/);
    const reused = await app.inject({ method: 'POST', url: '/v1/agent-enrollment/exchange', headers: { 'content-type': 'application/json' }, payload: { code } });
    expect(reused.statusCode).toBe(400);

    const disable = await app.inject({ method: 'POST', url: '/v1/control/agents/new-agent/disable', headers: { cookie, origin: 'https://hub.test', 'content-type': 'application/json', 'x-csrf-token': csrf }, payload: { confirm_id: 'new-agent' } });
    expect(disable.statusCode).toBe(200);
    expect(env.clientsRepo.verifyKey(exchanged.json().api_key)).toBeNull();
    expect(human.auth.namespace).toBe('personal');
  });
});
