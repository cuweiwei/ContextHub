import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../server.js';
import { requireScope } from '../auth.js';
import { sendError, idempotencyKeyFrom } from '../errors.js';

export function registerConnectorRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.post('/v1/connectors/runs', { preHandler: requireScope('write') }, async (req, reply) => {
    const parsed = z.object({ connector: z.string().min(1).max(100), checkpoint_key: z.string().min(1).max(200), checkpoint_value: z.string().max(1000).nullable().optional(), status: z.enum(['ok', 'stale', 'failed']), counts: z.record(z.number().int().nonnegative()).optional(), idempotency_key: z.string().min(1).optional() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'invalid_request', message: parsed.error.message } });
    const key = idempotencyKeyFrom(req.headers as Record<string, unknown>, parsed.data) ?? parsed.data.idempotency_key;
    if (!key) return reply.code(400).send({ error: { code: 'invalid_request', message: 'idempotency_key is required' } });
    try { return reply.send(deps.commands.connectorRun(req.client!, { connector: parsed.data.connector, checkpointKey: parsed.data.checkpoint_key, checkpointValue: parsed.data.checkpoint_value, status: parsed.data.status, counts: parsed.data.counts }, key)); } catch (err) { return sendError(reply, err); }
  });
  app.post('/v1/connectors/tombstones', { preHandler: requireScope('write') }, async (req, reply) => {
    const parsed = z.object({ items: z.array(z.object({ id: z.string().min(1), expected_revision: z.number().int().positive() })).min(1).max(100), idempotency_key: z.string().min(1).optional() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'invalid_request', message: parsed.error.message } });
    const key = idempotencyKeyFrom(req.headers as Record<string, unknown>, parsed.data) ?? parsed.data.idempotency_key; if (!key) return reply.code(400).send({ error: { code: 'invalid_request', message: 'idempotency_key is required' } });
    try { return reply.send(deps.commands.connectorTombstones(req.client!, parsed.data.items.map((item) => ({ id: item.id, expectedRevision: item.expected_revision })), key)); } catch (err) { return sendError(reply, err); }
  });
  app.post('/v1/changes/subscriptions', { preHandler: requireScope('write') }, async (req, reply) => {
    const parsed = z.object({ kind: z.enum(['webhook', 'telegram']), endpoint: z.string().url().optional(), event_categories: z.array(z.string().min(1).max(64)).max(20).optional(), idempotency_key: z.string().min(1).optional() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'invalid_request', message: parsed.error.message } });
    const key = idempotencyKeyFrom(req.headers as Record<string, unknown>, parsed.data) ?? parsed.data.idempotency_key;
    if (!key) return reply.code(400).send({ error: { code: 'invalid_request', message: 'idempotency_key is required' } });
    try { return reply.code(201).send(deps.commands.createSubscription(req.client!, { kind: parsed.data.kind, endpoint: parsed.data.endpoint, eventCategories: parsed.data.event_categories }, key)); } catch (err) { return sendError(reply, err); }
  });
}
