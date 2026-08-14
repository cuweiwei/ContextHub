import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../server.js';
import { hasJsonContentType, requireControlSession, sameOrigin, SESSION_COOKIE } from '../control-auth.js';
import { sendError } from '../errors.js';
import { SCOPES, SENSITIVITIES, PRINCIPAL_KINDS } from '../../core/types.js';

const agentCreateSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{1,63}$/),
  name: z.string().min(1).max(200),
  namespace: z.string().min(1).max(64),
  principal_kind: z.enum(['agent', 'service']),
  scopes: z.array(z.enum(SCOPES)).max(SCOPES.length),
  profile: z.enum(['agent-default', 'app-producer', 'reviewer', 'none']).default('none'),
  max_sensitivity: z.enum(SENSITIVITIES).default('normal'),
  read_sources: z.array(z.string().min(1).max(100)).max(100).nullable().default(null),
  auth_method: z.enum(['enrollment_key', 'legacy_key']).default('enrollment_key'),
});

const reviewSchema = z.object({
  decision: z.enum(['accept', 'reject', 'revoke']),
  expected_revision: z.number().int().positive(),
  note: z.string().max(2000).optional(),
  idempotency_key: z.string().min(1).max(200),
});

function noStore(reply: FastifyReply): FastifyReply {
  return reply.header('Cache-Control', 'no-store');
}

function controlRead(req: FastifyRequest, reply: FastifyReply, deps: AppDeps, namespace = '*'): boolean {
  try {
    deps.auditRepo.log({ namespace, clientId: `web:${req.controlSession!.principal.id}`, action: 'control.read', outcome: 'allow', details: { session_id: req.controlSession!.id } });
    return true;
  } catch {
    noStore(reply).code(503).send({ error: { code: 'audit_unavailable', message: 'audit log is unavailable; read refused' } });
    return false;
  }
}

function actor(req: FastifyRequest) {
  const session = req.controlSession!;
  return { principal: session.principal, sessionId: session.id };
}

function requireMutation(req: FastifyRequest, reply: FastifyReply, deps: AppDeps, highRisk = false): boolean {
  if (!requireControlSession(req, reply)) return false;
  if (!hasJsonContentType(req) || !sameOrigin(req, deps.config)) {
    noStore(reply).code(403).send({ error: { code: 'csrf_failed', message: 'JSON content type and same-origin Origin are required' } });
    return false;
  }
  const csrf = req.headers['x-csrf-token'];
  if (typeof csrf !== 'string' || !deps.webSessionsRepo.csrfMatches(req.controlSession!, csrf)) {
    noStore(reply).code(403).send({ error: { code: 'csrf_failed', message: 'valid X-CSRF-Token is required' } });
    return false;
  }
  if (highRisk && Date.now() - Date.parse(req.controlSession!.createdAt) > deps.config.controlCenterFreshSessionMinutes * 60_000) {
    noStore(reply).code(401).send({ error: { code: 'fresh_session_required', message: 're-authenticate through Tailscale before this high-risk action' } });
    return false;
  }
  return true;
}

function requireAdmin(req: FastifyRequest, reply: FastifyReply): boolean {
  if (!requireControlSession(req, reply)) return false;
  if (!req.controlSession!.principal.controlAdmin) {
    noStore(reply).code(403).send({ error: { code: 'control_forbidden', message: 'control_admin capability is required' } });
    return false;
  }
  return true;
}

function linkedClient(deps: AppDeps, req: FastifyRequest, namespace: string | undefined) {
  const clients = deps.webPrincipalsRepo.linkedClients(req.controlSession!.principal.id).filter((c) => !c.disabled && c.principal_kind === 'human');
  const selected = namespace ? clients.find((c) => c.namespace === namespace) : clients.length === 1 ? clients[0] : undefined;
  return selected ? deps.clientsRepo.authForId(selected.id) : null;
}

export function registerControlRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get('/auth/login', async (req, reply) => {
    if (!deps.config.controlCenterEnabled || !deps.config.controlCenterTailscaleAuthEnabled) return reply.code(404).send();
    const identity = (await import('../control-auth.js')).tailscaleIdentity(req, deps.config);
    if (!identity) return noStore(reply).code(403).send({ error: { code: 'identity_required', message: 'Tailscale HTTPS identity headers are required' } });
    const principal = deps.webPrincipalsRepo.getByIdentity(identity.provider, identity.subject);
    if (!principal || principal.disabled) return noStore(reply).code(403).send({ error: { code: 'principal_denied', message: 'This Tailscale identity is not enrolled' } });
    const session = deps.webSessionsRepo.create(principal.id, deps.config.controlCenterSessionIdleMinutes, deps.config.controlCenterSessionMaxDays);
    deps.webPrincipalsRepo.touch(principal.id);
    deps.auditRepo.log({ namespace: '*', clientId: `web:${principal.id}`, action: 'web.session.create', outcome: 'allow', details: { provider: identity.provider } });
    const requested = typeof (req.query as any).return_to === 'string' ? (req.query as any).return_to : '/dashboard';
    const returnTo = /^\/(?!\/)/.test(requested) ? requested : '/dashboard';
    return reply.header('Set-Cookie', `${SESSION_COOKIE}=${session.rawToken}; Path=/; HttpOnly; Secure; SameSite=Strict`).redirect(returnTo);
  });

  app.post('/auth/logout', async (req, reply) => {
    if (!req.controlSession) return noStore(reply).code(204).send();
    if (!requireMutation(req, reply, deps)) return;
    deps.webSessionsRepo.revoke(req.controlSession.id, `web:${req.controlSession.principal.id}`);
    deps.auditRepo.log({ namespace: '*', clientId: `web:${req.controlSession.principal.id}`, action: 'web.session.revoke', outcome: 'allow', details: { session_id: req.controlSession.id } });
    return noStore(reply).header('Set-Cookie', `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`).code(204).send();
  });

  app.get('/v1/control/me', async (req, reply) => {
    if (!requireControlSession(req, reply)) return;
    if (!controlRead(req, reply, deps)) return;
    deps.webSessionsRepo.touch(req.controlSession!.id, deps.config.controlCenterSessionIdleMinutes);
    const linked = deps.webPrincipalsRepo.linkedClients(req.controlSession!.principal.id).filter((c) => c.principal_kind === 'human');
    const csrf = deps.webSessionsRepo.rotateCsrf(req.controlSession!.id);
    return noStore(reply).send({ principal: req.controlSession!.principal, linked_clients: linked, csrf_token: csrf, session: { id: req.controlSession!.id, idle_expires_at: req.controlSession!.idleExpiresAt, absolute_expires_at: req.controlSession!.absoluteExpiresAt } });
  });

  app.get('/v1/control/sessions', async (req, reply) => {
    if (!requireControlSession(req, reply)) return;
    if (!controlRead(req, reply, deps)) return;
    return noStore(reply).send({ sessions: deps.webSessionsRepo.list(req.controlSession!.principal.id) });
  });

  app.delete('/v1/control/sessions/:id', async (req, reply) => {
    if (!requireMutation(req, reply, deps, true)) return;
    const id = (req.params as { id: string }).id;
    const ok = deps.webSessionsRepo.revoke(id, `web:${req.controlSession!.principal.id}`);
    deps.auditRepo.log({ namespace: '*', clientId: `web:${req.controlSession!.principal.id}`, action: 'web.session.revoke', outcome: ok ? 'allow' : 'deny', details: { session_id: id } });
    return noStore(reply).send({ revoked: ok });
  });

  app.get('/v1/control/dashboard', async (req, reply) => {
    if (!requireControlSession(req, reply)) return;
    const ns = typeof (req.query as any).namespace === 'string' ? (req.query as any).namespace : undefined;
    const client = linkedClient(deps, req, ns);
    if (!controlRead(req, reply, deps, ns ?? '*')) return;
    if (!client) return noStore(reply).code(403).send({ error: { code: 'namespace_unavailable', message: 'No linked human client has access to this namespace' } });
    const accepted = deps.commands.listItems(client, { filters: {}, limit: 1, sort: 'created', includeCandidates: false });
    const candidates = deps.commands.listCandidates(client, 'inbox', 100);
    const clients = deps.clientsRepo.list(client.namespace);
    const counts = deps.db.prepare(`SELECT trust_state, information_class, COUNT(*) AS count FROM context_items WHERE namespace = ? AND deleted = 0 GROUP BY trust_state, information_class`).all(client.namespace);
    return noStore(reply).send({ namespace: client.namespace, item_sample_total: accepted.items.length, candidates: candidates.length, counts, agents: clients.filter((c) => c.principal_kind !== 'human').map((c) => ({ ...c, api_key: undefined, activity: deps.clientActivityRepo.get(c.id) })) });
  });

  app.get('/v1/control/memories', async (req, reply) => {
    if (!requireControlSession(req, reply)) return;
    const q = req.query as any;
    const client = linkedClient(deps, req, q.namespace);
    if (!controlRead(req, reply, deps, q.namespace ?? '*')) return;
    if (!client) return noStore(reply).code(403).send({ error: { code: 'namespace_unavailable', message: 'No linked human client has access to this namespace' } });
    try {
      const result = q.q ? deps.commands.search(client, { queries: [String(q.q)], filters: { types: q.type ? [String(q.type)] : undefined }, limit: Math.min(Number(q.limit ?? 50), 100), mode: q.mode === 'lexical' ? 'lexical' : 'hybrid', includeCandidates: q.include_candidates === 'true' }) : deps.commands.listItems(client, { filters: {}, limit: Math.min(Number(q.limit ?? 50), 100), sort: 'created', includeCandidates: q.include_candidates === 'true' });
      return noStore(reply).send({ namespace: client.namespace, ...result });
    } catch (err) { return sendError(reply, err); }
  });

  app.get('/v1/control/memories/:id', async (req, reply) => {
    if (!requireControlSession(req, reply)) return;
    if (!controlRead(req, reply, deps, (req.query as any).namespace ?? '*')) return;
    const client = linkedClient(deps, req, (req.query as any).namespace);
    if (!client) return noStore(reply).code(403).send({ error: { code: 'namespace_unavailable', message: 'No linked human client has access to this namespace' } });
    const item = deps.commands.getItem(client, (req.params as { id: string }).id);
    return item ? noStore(reply).send({ item }) : noStore(reply).code(404).send({ error: { code: 'not_found', message: 'Memory not found' } });
  });

  app.get('/v1/control/memories/:id/history', async (req, reply) => {
    if (!requireControlSession(req, reply)) return;
    if (!controlRead(req, reply, deps, (req.query as any).namespace ?? '*')) return;
    const client = linkedClient(deps, req, (req.query as any).namespace);
    if (!client) return noStore(reply).code(403).send({ error: { code: 'namespace_unavailable', message: 'No linked human client has access to this namespace' } });
    const history = deps.commands.getHistory(client, (req.params as { id: string }).id);
    return history ? noStore(reply).send(history) : noStore(reply).code(404).send({ error: { code: 'not_found', message: 'Memory history not found' } });
  });

  app.get('/v1/control/review/candidates', async (req, reply) => {
    if (!requireControlSession(req, reply)) return;
    if (!controlRead(req, reply, deps, (req.query as any).namespace ?? '*')) return;
    const client = linkedClient(deps, req, (req.query as any).namespace);
    if (!client) return noStore(reply).code(403).send({ error: { code: 'namespace_unavailable', message: 'No linked human reviewer client has access to this namespace' } });
    try { return noStore(reply).send({ namespace: client.namespace, items: deps.commands.listCandidates(client, 'inbox', 100) }); } catch (err) { return sendError(reply, err); }
  });

  app.post('/v1/control/review/items/:id', async (req, reply) => {
    if (!requireMutation(req, reply, deps)) return;
    const parsed = reviewSchema.safeParse(req.body);
    if (!parsed.success) return noStore(reply).code(400).send({ error: { code: 'invalid_request', message: parsed.error.message } });
    const client = linkedClient(deps, req, (req.body as any)?.namespace);
    if (!client) return noStore(reply).code(403).send({ error: { code: 'namespace_unavailable', message: 'No linked human reviewer client has access to this namespace' } });
    try { return noStore(reply).send(deps.commands.reviewMemory(client, (req.params as { id: string }).id, { decision: parsed.data.decision, expectedRevision: parsed.data.expected_revision, note: parsed.data.note }, parsed.data.idempotency_key)); } catch (err) { return sendError(reply, err); }
  });

  app.get('/v1/control/agents', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const ns = typeof (req.query as any).namespace === 'string' ? (req.query as any).namespace : undefined;
    if (!controlRead(req, reply, deps, ns ?? '*')) return;
    const agents = deps.clientsRepo.list(ns).filter((c) => c.principal_kind !== 'human').map((c) => ({ ...c, activity: deps.clientActivityRepo.get(c.id), enrollments: deps.enrollmentsRepo.listForClient(c.id) }));
    return noStore(reply).send({ agents });
  });

  app.post('/v1/control/agents', async (req, reply) => {
    if (!requireMutation(req, reply, deps, true) || !requireAdmin(req, reply)) return;
    const parsed = agentCreateSchema.safeParse(req.body);
    if (!parsed.success) return noStore(reply).code(400).send({ error: { code: 'invalid_request', message: parsed.error.message } });
    if (parsed.data.auth_method === 'enrollment_key' && !deps.config.agentEnrollmentEnabled) {
      return noStore(reply).code(400).send({ error: { code: 'feature_disabled', message: 'agent enrollment is disabled; choose legacy_key or enable enrollment explicitly' } });
    }
    try {
      const created = deps.controlCommands.createAgent(actor(req), { id: parsed.data.id, name: parsed.data.name, namespace: parsed.data.namespace, principalKind: parsed.data.principal_kind, scopes: parsed.data.scopes, profile: parsed.data.profile, maxSensitivity: parsed.data.max_sensitivity, readSources: parsed.data.read_sources });
      return noStore(reply).code(201).send({ client: created.client, enrollment: parsed.data.auth_method === 'enrollment_key' ? deps.controlCommands.createEnrollment(actor(req), created.client.id) : null });
    } catch (err) { return sendError(reply, err); }
  });

  app.get('/v1/control/agents/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const id = (req.params as { id: string }).id;
    const client = deps.clientsRepo.get(id);
    if (!controlRead(req, reply, deps, client?.namespace ?? '*')) return;
    if (!client) return noStore(reply).code(404).send({ error: { code: 'not_found', message: 'Agent not found' } });
    return noStore(reply).send({ client, activity: deps.clientActivityRepo.get(id), enrollments: deps.enrollmentsRepo.listForClient(id), effective_permissions: deps.policiesRepo.getCurrent(client.namespace)?.policy.grants.filter((g) => g.client_id === id) ?? [] });
  });

  for (const [verb, disabled] of [['disable', true], ['enable', false]] as const) {
    app.post(`/v1/control/agents/:id/${verb}`, async (req, reply) => {
      if (!requireMutation(req, reply, deps, true) || !requireAdmin(req, reply)) return;
      const id = (req.params as { id: string }).id;
      if ((req.body as any)?.confirm_id !== id) return noStore(reply).code(400).send({ error: { code: 'confirmation_required', message: 'confirm_id must equal the client id' } });
      return noStore(reply).send({ enabled: !disabled, changed: deps.controlCommands.setAgentDisabled(actor(req), id, disabled) });
    });
  }

  app.post('/v1/control/agents/:id/enrollments', async (req, reply) => {
    if (!requireMutation(req, reply, deps, true) || !requireAdmin(req, reply)) return;
    if (!deps.config.agentEnrollmentEnabled) return noStore(reply).code(404).send({ error: { code: 'feature_disabled', message: 'agent enrollment is disabled' } });
    try { return noStore(reply).send(deps.controlCommands.createEnrollment(actor(req), (req.params as { id: string }).id)); } catch (err) { return sendError(reply, err); }
  });

  app.post('/v1/agent-enrollment/exchange', async (req, reply) => {
    if (!deps.config.agentEnrollmentEnabled) return noStore(reply).code(404).send({ error: { code: 'feature_disabled', message: 'agent enrollment is disabled' } });
    if (!hasJsonContentType(req)) return noStore(reply).code(400).send({ error: { code: 'invalid_request', message: 'application/json is required' } });
    const code = z.object({ code: z.string().min(20).max(200), client_metadata: z.record(z.string()).optional() }).safeParse(req.body);
    if (!code.success) return noStore(reply).code(400).send({ error: { code: 'invalid_request', message: 'invalid enrollment request' } });
    const result = deps.controlCommands.exchangeEnrollment(code.data.code);
    if (!result) return noStore(reply).code(400).send({ error: { code: 'enrollment_failed', message: 'enrollment code is invalid, expired, consumed, revoked, or locked' } });
    return noStore(reply).send({ client_id: result.clientId, api_key: result.apiKey, enrollment_id: result.enrollmentId });
  });

  app.get('/v1/control/namespaces', async (req, reply) => {
    if (!requireControlSession(req, reply)) return;
    if (!controlRead(req, reply, deps)) return;
    const linked = deps.webPrincipalsRepo.linkedClients(req.controlSession!.principal.id);
    const namespaces = [...new Set(linked.map((c) => c.namespace))].map((namespace) => ({ namespace, linked_clients: linked.filter((c) => c.namespace === namespace).map((c) => c.id) }));
    return noStore(reply).send({ namespaces });
  });

  app.get('/v1/control/policies/:namespace', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const namespace = (req.params as { namespace: string }).namespace;
    if (!controlRead(req, reply, deps, namespace)) return;
    const policy = deps.policiesRepo.getCurrent(namespace);
    return policy ? noStore(reply).send({ namespace, version: policy.version, rules: policy.policy, history: deps.policiesRepo.history(namespace) }) : noStore(reply).code(404).send({ error: { code: 'not_found', message: 'policy not found' } });
  });

  app.get('/v1/control/audit', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    if (!controlRead(req, reply, deps, typeof (req.query as any).namespace === 'string' ? (req.query as any).namespace : '*')) return;
    return noStore(reply).send({ entries: deps.auditRepo.query({ namespace: typeof (req.query as any).namespace === 'string' ? (req.query as any).namespace : undefined, limit: 200 }) });
  });

  app.get('/v1/control/settings', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    if (!controlRead(req, reply, deps)) return;
    return noStore(reply).send({ control_center_enabled: deps.config.controlCenterEnabled, tailscale_auth_enabled: deps.config.controlCenterTailscaleAuthEnabled, enrollment_enabled: deps.config.agentEnrollmentEnabled, oauth_enabled: deps.config.mcpOauthEnabled, legacy_api_keys_enabled: deps.config.legacyApiKeysEnabled });
  });
}
