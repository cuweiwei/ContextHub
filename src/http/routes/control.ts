import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { AppDeps } from '../server.js';
import { hasJsonContentType, requireControlSession, sameOrigin, SESSION_COOKIE } from '../control-auth.js';
import { sendError } from '../errors.js';
import { IdempotencyConflictError } from '../../core/errors.js';
import { SCOPES, SENSITIVITIES, PRINCIPAL_KINDS, INFORMATION_CLASSES, MEMORY_KINDS, STATUSES, TRUST_STATES, type ListFilters, type ValidityFilter } from '../../core/types.js';
import { newItemSchema } from '../../core/types.js';
import { runDoctor } from '../../core/maintenance.js';
import { capabilitiesFor } from '../../core/policy.js';
import { hashEnrollmentCode } from '../../core/enrollments-repo.js';

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
  // Older control-center clients did not send this field; keep parsing them
  // while the command layer still records all new domain mutations.
  idempotency_key: z.string().min(1).max(200).optional().default('legacy-control-agent-create'),
  confirm_id: z.string().optional(),
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

function csv(value: unknown): string[] | undefined {
  if (typeof value !== 'string') return undefined;
  const values = value.split(',').map((part) => part.trim()).filter(Boolean);
  return values.length ? values : undefined;
}

function controlFilters(query: Record<string, unknown>): ListFilters {
  const valid = <T extends string>(value: string[] | undefined, allowed: readonly T[]): T[] | undefined => {
    const result = value?.filter((entry): entry is T => allowed.includes(entry as T));
    return result?.length ? result : undefined;
  };
  return {
    sources: csv(query.source), types: csv(query.type), tags: csv(query.tag), entity_filters: csv(query.entity),
    information_classes: valid(csv(query.information_class), INFORMATION_CLASSES), memory_kinds: valid(csv(query.memory_kind), MEMORY_KINDS),
    statuses: valid(csv(query.status), STATUSES), trust_states: valid(csv(query.trust), TRUST_STATES),
    sensitivity: query.sensitivity === 'normal' || query.sensitivity === 'private' || query.sensitivity === 'all' ? query.sensitivity : undefined,
    validity: query.validity === 'scheduled' || query.validity === 'expired' || query.validity === 'all' ? query.validity as ValidityFilter : 'current',
    since: typeof query.since === 'string' ? query.since : undefined, until: typeof query.until === 'string' ? query.until : undefined,
  };
}

function cursorHash(query: Record<string, unknown>): string {
  const copy = { ...query };
  delete copy.cursor;
  return createHash('sha256').update(JSON.stringify(copy, Object.keys(copy).sort())).digest('hex');
}

function packCursor(hash: string, cursor: string): string {
  return Buffer.from(JSON.stringify({ hash, cursor }), 'utf8').toString('base64url');
}

function unpackCursor(value: string, hash: string): string | null {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as { hash?: string; cursor?: string };
    return parsed.hash === hash && typeof parsed.cursor === 'string' ? parsed.cursor : null;
  } catch { return null; }
}

function controlMutation<T>(
  deps: AppDeps,
  req: FastifyRequest,
  operation: string,
  idempotencyKey: string,
  payload: unknown,
  execute: () => T,
  redact: (result: T) => unknown,
): { result: T | unknown; replayed: boolean } {
  const clientId = `web:${req.controlSession!.principal.id}`;
  const hash = createHash('sha256').update(JSON.stringify({ operation, payload })).digest('hex');
  return deps.db.transaction(() => {
    const existing = deps.db.prepare('SELECT operation, request_hash, result_json FROM idempotency_records WHERE namespace = ? AND client_id = ? AND idempotency_key = ?').get('*', clientId, idempotencyKey) as { operation: string; request_hash: string; result_json: string } | undefined;
    if (existing) {
      if (existing.operation !== operation || existing.request_hash !== hash) throw new IdempotencyConflictError('idempotency key was already used with a different control request');
      return { result: JSON.parse(existing.result_json), replayed: true };
    }
    const result = execute();
    deps.db.prepare('INSERT INTO idempotency_records (namespace, client_id, idempotency_key, operation, request_hash, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('*', clientId, idempotencyKey, operation, hash, JSON.stringify(redact(result)), new Date().toISOString());
    return { result, replayed: false };
  })();
}

export function registerControlRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get('/v1/control/maintenance', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    if (!controlRead(req, reply, deps)) return;
    try {
      const report = runDoctor(deps.db, deps.config.dataDir);
      return noStore(reply).code(report.status === 'fail' ? 503 : 200).send(report);
    } catch (err) {
      return noStore(reply).code(503).send({ error: { code: 'maintenance_unavailable', message: (err as Error).message } });
    }
  });

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
    if (id === req.controlSession!.id) return noStore(reply).code(400).send({ error: { code: 'current_session_logout_required', message: 'use logout to end the current session' } });
    const ok = deps.webSessionsRepo.revokeForPrincipal(id, req.controlSession!.principal.id, `web:${req.controlSession!.principal.id}`);
    deps.auditRepo.log({ namespace: '*', clientId: `web:${req.controlSession!.principal.id}`, action: 'web.session.revoke', outcome: ok ? 'allow' : 'deny', details: { session_id: id } });
    return noStore(reply).send({ revoked: ok });
  });

  app.post('/v1/control/sessions/:id/revoke', async (req, reply) => {
    if (!requireMutation(req, reply, deps, true)) return;
    const id = (req.params as { id: string }).id;
    if (id === req.controlSession!.id) return noStore(reply).code(400).send({ error: { code: 'current_session_logout_required', message: 'use logout to end the current session' } });
    const ok = deps.webSessionsRepo.revokeForPrincipal(id, req.controlSession!.principal.id, `web:${req.controlSession!.principal.id}`);
    deps.auditRepo.log({ namespace: '*', clientId: `web:${req.controlSession!.principal.id}`, action: 'web.session.revoke', outcome: ok ? 'allow' : 'deny', details: { session_id: id } });
    return noStore(reply).send({ revoked: ok });
  });

  app.get('/v1/control/dashboard', async (req, reply) => {
    if (!requireControlSession(req, reply)) return;
    const ns = typeof (req.query as any).namespace === 'string' ? (req.query as any).namespace : undefined;
    const client = linkedClient(deps, req, ns);
    if (!controlRead(req, reply, deps, ns ?? '*')) return;
    if (!client) return noStore(reply).code(403).send({ error: { code: 'namespace_unavailable', message: 'No linked human client has access to this namespace' } });
    const accepted = deps.commands.listItems(client, { filters: {}, limit: 100, sort: 'created', includeCandidates: false });
    const candidates = deps.commands.countCandidates(client, 'inbox');
    const clients = deps.clientsRepo.list(client.namespace);
    const counts = deps.commands.summary(client);
    const visibleTotal = (accepted as any).totalMatched ?? accepted.items.length;
    return noStore(reply).send({ namespace: client.namespace, visible_total: visibleTotal, item_sample_total: visibleTotal, candidates, counts, agents: clients.filter((c) => c.principal_kind !== 'human').map((c) => ({ ...c, api_key: undefined, activity: deps.clientActivityRepo.get(c.id) })) });
  });

  app.get('/v1/control/memories', async (req, reply) => {
    if (!requireControlSession(req, reply)) return;
    const q = req.query as any;
    const client = linkedClient(deps, req, q.namespace);
    if (!controlRead(req, reply, deps, q.namespace ?? '*')) return;
    if (!client) return noStore(reply).code(403).send({ error: { code: 'namespace_unavailable', message: 'No linked human client has access to this namespace' } });
    try {
      const filters = controlFilters(q);
      const hash = cursorHash(q);
      const unpacked = q.cursor ? unpackCursor(String(q.cursor), hash) : null;
      if (q.cursor && !unpacked) return noStore(reply).code(400).send({ error: { code: 'invalid_cursor', message: 'cursor does not match the query or filters' } });
      const rawCursor = unpacked ?? undefined;
      if (q.q && rawCursor !== undefined && (!/^\d+$/.test(rawCursor) || Number(rawCursor) < 0)) return noStore(reply).code(400).send({ error: { code: 'invalid_cursor', message: 'search cursor is malformed' } });
      const result = q.q
        ? deps.commands.search(client, { queries: [String(q.q)], filters, limit: Math.min(Number(q.limit ?? 50), 100), mode: q.mode === 'lexical' ? 'lexical' : 'hybrid', includeCandidates: q.include_candidates === 'true', offset: rawCursor ? Number(rawCursor) : 0 })
        : deps.commands.listItems(client, { filters, limit: Math.min(Number(q.limit ?? 50), 100), cursor: rawCursor, sort: q.sort === 'occurred' ? 'occurred' : 'created', includeCandidates: q.include_candidates === 'true' });
      const next = 'nextCursor' in result ? result.nextCursor : undefined;
      return noStore(reply).send({ namespace: client.namespace, ...result, next_cursor: next ? packCursor(hash, next) : null });
    } catch (err) { return sendError(reply, err); }
  });

  app.get('/v1/control/memories/facets', async (req, reply) => {
    if (!requireControlSession(req, reply)) return;
    const q = req.query as Record<string, unknown>;
    const client = linkedClient(deps, req, typeof q.namespace === 'string' ? q.namespace : undefined);
    if (!controlRead(req, reply, deps, typeof q.namespace === 'string' ? q.namespace : '*')) return;
    if (!client) return noStore(reply).code(403).send({ error: { code: 'namespace_unavailable', message: 'No linked human client has access to this namespace' } });
    try { return noStore(reply).send({ namespace: client.namespace, facets: deps.commands.facets(client, controlFilters(q)) }); } catch (err) { return sendError(reply, err); }
  });

  app.get('/v1/control/memories/:id', async (req, reply) => {
    if (!requireControlSession(req, reply)) return;
    if (!controlRead(req, reply, deps, (req.query as any).namespace ?? '*')) return;
    const client = linkedClient(deps, req, (req.query as any).namespace);
    if (!client) return noStore(reply).code(403).send({ error: { code: 'namespace_unavailable', message: 'No linked human client has access to this namespace' } });
    const item = deps.commands.getWorkbench(client, (req.params as { id: string }).id);
    return item ? noStore(reply).send(item) : noStore(reply).code(404).send({ error: { code: 'not_found', message: 'Memory not found' } });
  });

  app.post('/v1/control/memories/:id/successors', async (req, reply) => {
    if (!requireMutation(req, reply, deps)) return;
    const parsed = newItemSchema.safeParse(req.body);
    if (!parsed.success) return noStore(reply).code(400).send({ error: { code: 'invalid_request', message: parsed.error.message } });
    const client = linkedClient(deps, req, (req.body as any)?.namespace);
    if (!client) return noStore(reply).code(403).send({ error: { code: 'namespace_unavailable', message: 'No linked human reviewer client has access to this namespace' } });
    try { return noStore(reply).code(201).send(deps.commands.proposeSuccessor(client, (req.params as { id: string }).id, parsed.data)); } catch (err) { return sendError(reply, err); }
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
    try {
      const existing = deps.commands.getItem(client, (req.params as { id: string }).id);
      if (!existing) return noStore(reply).code(404).send({ error: { code: 'not_found', message: 'Memory not found' } });
      if (existing.trust_state === 'candidate' && parsed.data.decision === 'revoke') return noStore(reply).code(400).send({ error: { code: 'invalid_review_transition', message: 'candidates can only be accepted or rejected' } });
      if (existing.trust_state === 'accepted' && parsed.data.decision !== 'revoke') return noStore(reply).code(400).send({ error: { code: 'invalid_review_transition', message: 'accepted items can only be revoked or corrected with a successor' } });
      return noStore(reply).send(deps.commands.reviewMemory(client, (req.params as { id: string }).id, { decision: parsed.data.decision, expectedRevision: parsed.data.expected_revision, note: parsed.data.note }, parsed.data.idempotency_key));
    } catch (err) { return sendError(reply, err); }
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
      if (parsed.data.confirm_id !== undefined && parsed.data.confirm_id !== parsed.data.id) return noStore(reply).code(400).send({ error: { code: 'confirmation_required', message: 'confirm_id must equal the client id' } });
      const operation = 'control.agent.create';
      const controlKey = parsed.data.idempotency_key === 'legacy-control-agent-create' ? `legacy-control-agent-create-${parsed.data.id}` : parsed.data.idempotency_key;
      const outcome = controlMutation(deps, req, operation, controlKey, parsed.data, () => {
        const created = deps.controlCommands.createAgent(actor(req), { id: parsed.data.id, name: parsed.data.name, namespace: parsed.data.namespace, principalKind: parsed.data.principal_kind, scopes: parsed.data.scopes, profile: parsed.data.profile, maxSensitivity: parsed.data.max_sensitivity, readSources: parsed.data.read_sources, authMethod: parsed.data.auth_method });
        return { client: created.client, enrollment: parsed.data.auth_method === 'enrollment_key' ? deps.controlCommands.createEnrollment(actor(req), created.client.id) : null };
      }, (result) => ({ client: (result as any).client, enrollment: (result as any).enrollment ? { id: (result as any).enrollment.id, expiresAt: (result as any).enrollment.expiresAt } : null }));
      const body = outcome.replayed ? { ...(outcome.result as any), replayed: true, secret_replay: false } : { ...(outcome.result as any), replayed: false };
      return noStore(reply).code(outcome.replayed ? 200 : 201).send(body);
    } catch (err) { return sendError(reply, err); }
  });

  app.get('/v1/control/agents/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const id = (req.params as { id: string }).id;
    const client = deps.clientsRepo.get(id);
    if (!controlRead(req, reply, deps, client?.namespace ?? '*')) return;
    if (!client) return noStore(reply).code(404).send({ error: { code: 'not_found', message: 'Agent not found' } });
    const currentPolicy = deps.policiesRepo.getCurrent(client.namespace);
    const enrollments = deps.enrollmentsRepo.listForClient(id);
    const state = client.disabled ? 'disabled' : enrollments.some((e: any) => e.status === 'pending') ? 'reenrollment_pending' : client.auth_method === 'enrollment_key' ? 'active' : 'pending';
    return noStore(reply).send({
      client,
      namespace: client.namespace,
      scopes: client.scopes,
      policy_capabilities: currentPolicy ? [...capabilitiesFor(currentPolicy.policy, id)] : [],
      sensitivity_ceiling: client.max_sensitivity,
      source_ceiling: client.read_sources,
      activity: deps.clientActivityRepo.get(id),
      credential_version: client.credential_version,
      enrollment_lifecycle: { state, enrollments },
      enrollments,
      effective_permissions: currentPolicy?.policy.grants.filter((g) => g.client_id === id) ?? [],
    });
  });

  for (const [verb, disabled] of [['disable', true], ['enable', false]] as const) {
    app.post(`/v1/control/agents/:id/${verb}`, async (req, reply) => {
      if (!requireMutation(req, reply, deps, true) || !requireAdmin(req, reply)) return;
      const id = (req.params as { id: string }).id;
      if ((req.body as any)?.confirm_id !== id) return noStore(reply).code(400).send({ error: { code: 'confirmation_required', message: 'confirm_id must equal the client id' } });
      const idempotencyKey = typeof (req.body as any)?.idempotency_key === 'string' ? (req.body as any).idempotency_key : `legacy-agent-${verb}-${id}`;
      try {
        const outcome = controlMutation(deps, req, `control.agent.${verb}`, idempotencyKey, { id, disabled }, () => ({ enabled: !disabled, changed: deps.controlCommands.setAgentDisabled(actor(req), id, disabled) }), (result) => result);
        return noStore(reply).send({ ...(outcome.result as any), replayed: outcome.replayed });
      } catch (err) { return sendError(reply, err); }
    });
  }

  app.post('/v1/control/agents/:id/enrollments', async (req, reply) => {
    if (!requireMutation(req, reply, deps, true) || !requireAdmin(req, reply)) return;
    if (!deps.config.agentEnrollmentEnabled) return noStore(reply).code(404).send({ error: { code: 'feature_disabled', message: 'agent enrollment is disabled' } });
    const id = (req.params as { id: string }).id;
    if ((req.body as any)?.confirm_id !== id) return noStore(reply).code(400).send({ error: { code: 'confirmation_required', message: 'confirm_id must equal the client id' } });
    const idempotencyKey = typeof (req.body as any)?.idempotency_key === 'string' ? (req.body as any).idempotency_key : `legacy-agent-enrollment-${id}`;
    try {
      const outcome = controlMutation(deps, req, 'control.agent.enrollment.create', idempotencyKey, { id }, () => deps.controlCommands.createEnrollment(actor(req), id), (result) => ({ id: (result as any).id, expiresAt: (result as any).expiresAt }));
      return noStore(reply).send(outcome.replayed ? { ...(outcome.result as any), replayed: true, secret_replay: false } : { ...(outcome.result as any), replayed: false });
    } catch (err) { return sendError(reply, err); }
  });

  app.post('/v1/control/agents/:id/re-enroll', async (req, reply) => {
    if (!requireMutation(req, reply, deps, true) || !requireAdmin(req, reply)) return;
    if (!deps.config.agentEnrollmentEnabled) return noStore(reply).code(404).send({ error: { code: 'feature_disabled', message: 'agent enrollment is disabled' } });
    const id = (req.params as { id: string }).id;
    if ((req.body as any)?.confirm_id !== id) return noStore(reply).code(400).send({ error: { code: 'confirmation_required', message: 'confirm_id must equal the client id' } });
    const idempotencyKey = typeof (req.body as any)?.idempotency_key === 'string' ? (req.body as any).idempotency_key : `legacy-agent-reenroll-${id}`;
    try {
      const outcome = controlMutation(deps, req, 'control.agent.reenroll', idempotencyKey, { id }, () => deps.controlCommands.reEnroll(actor(req), id), (result) => ({ id: (result as any).id, expiresAt: (result as any).expiresAt }));
      return noStore(reply).send(outcome.replayed ? { ...(outcome.result as any), replayed: true, secret_replay: false } : { ...(outcome.result as any), replayed: false });
    } catch (err) { return sendError(reply, err); }
  });

  app.post('/v1/control/enrollments/:id/revoke', async (req, reply) => {
    if (!requireMutation(req, reply, deps, true) || !requireAdmin(req, reply)) return;
    const enrollmentId = (req.params as { id: string }).id;
    if ((req.body as any)?.confirm_id !== enrollmentId) return noStore(reply).code(400).send({ error: { code: 'confirmation_required', message: 'confirm_id must equal the enrollment id' } });
    const idempotencyKey = typeof (req.body as any)?.idempotency_key === 'string' ? (req.body as any).idempotency_key : `legacy-enrollment-revoke-${enrollmentId}`;
    try {
      const outcome = controlMutation(deps, req, 'control.agent.enrollment.revoke', idempotencyKey, { enrollmentId }, () => ({ revoked: deps.controlCommands.revokeEnrollment(actor(req), enrollmentId) }), (result) => result);
      return noStore(reply).send({ ...(outcome.result as any), replayed: outcome.replayed });
    } catch (err) { return sendError(reply, err); }
  });

  app.post('/v1/agent-enrollment/exchange', async (req, reply) => {
    if (!deps.config.agentEnrollmentEnabled) return noStore(reply).code(404).send({ error: { code: 'feature_disabled', message: 'agent enrollment is disabled' } });
    if (!hasJsonContentType(req)) return noStore(reply).code(400).send({ error: { code: 'invalid_request', message: 'application/json is required' } });
    const code = z.object({ code: z.string().min(20).max(200), client_metadata: z.record(z.string()).optional(), idempotency_key: z.string().min(1).max(200).optional() }).safeParse(req.body);
    if (!code.success) return noStore(reply).code(400).send({ error: { code: 'invalid_request', message: 'invalid enrollment request' } });
    const parsedCode = deps.enrollmentsRepo.parseV2Code(code.data.code);
    const idemClient = `enrollment:${parsedCode?.id ?? hashEnrollmentCode(code.data.code).slice(0, 24)}`;
    const headerIdempotency = typeof req.headers['idempotency-key'] === 'string' ? req.headers['idempotency-key'] : undefined;
    const idempotencyKey = code.data.idempotency_key ?? headerIdempotency;
    const requestHash = createHash('sha256').update(JSON.stringify({ code_hash: hashEnrollmentCode(code.data.code), client_metadata: code.data.client_metadata ?? null })).digest('hex');
    const existing = idempotencyKey ? deps.db.prepare('SELECT operation, request_hash, result_json FROM idempotency_records WHERE namespace = ? AND client_id = ? AND idempotency_key = ?').get('*', idemClient, idempotencyKey) as { operation: string; request_hash: string; result_json: string } | undefined : undefined;
    if (existing) {
      if (existing.operation !== 'agent.enrollment.exchange' || existing.request_hash !== requestHash) return noStore(reply).code(409).send({ error: { code: 'idempotency_conflict', message: 'idempotency key was already used with a different enrollment request' } });
      return noStore(reply).send({ ...JSON.parse(existing.result_json), replayed: true, secret_replay: false });
    }
    const result = deps.controlCommands.exchangeEnrollment(code.data.code);
    if (!result) return noStore(reply).code(400).send({ error: { code: 'enrollment_failed', message: 'enrollment code is invalid, expired, consumed, revoked, or locked' } });
    const response = { client_id: result.clientId, api_key: result.apiKey, enrollment_id: result.enrollmentId };
    if (idempotencyKey) deps.db.prepare('INSERT INTO idempotency_records (namespace, client_id, idempotency_key, operation, request_hash, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('*', idemClient, idempotencyKey, 'agent.enrollment.exchange', requestHash, JSON.stringify({ client_id: result.clientId, enrollment_id: result.enrollmentId }), new Date().toISOString());
    return noStore(reply).send(response);
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
    return noStore(reply).send({
      control_center_enabled: deps.config.controlCenterEnabled,
      tailscale_auth_enabled: deps.config.controlCenterTailscaleAuthEnabled,
      enrollment_enabled: deps.config.agentEnrollmentEnabled,
      oauth_enabled: deps.config.mcpOauthEnabled,
      legacy_api_keys_enabled: deps.config.legacyApiKeysEnabled,
      current_session_id: req.controlSession!.id,
      session: { idle_expires_at: req.controlSession!.idleExpiresAt, absolute_expires_at: req.controlSession!.absoluteExpiresAt, last_seen_at: new Date().toISOString() },
      sessions: deps.webSessionsRepo.list(req.controlSession!.principal.id),
    });
  });
}
