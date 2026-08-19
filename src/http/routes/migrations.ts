import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../server.js';
import { requireScope } from '../auth.js';
import { idempotencyKeyFrom, sendError } from '../errors.js';

export function registerMigrationRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.post('/v1/migrations/campaigns', { preHandler: requireScope('write') }, async (req, reply) => {
    const parsed = z.object({ namespace: z.string().min(1), name: z.string().min(1).max(200), idempotency_key: z.string().min(1).optional() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'invalid_request', message: parsed.error.message } });
    const key = idempotencyKeyFrom(req.headers as Record<string, unknown>, parsed.data) ?? parsed.data.idempotency_key;
    if (!key) return reply.code(400).send({ error: { code: 'invalid_request', message: 'idempotency_key is required' } });
    try { return reply.code(201).send(deps.commands.createMigrationCampaign(req.client!, { namespace: parsed.data.namespace, name: parsed.data.name }, key)); } catch (err) { return sendError(reply, err); }
  });
  app.get('/v1/migrations/campaigns/:id', { preHandler: requireScope('read') }, async (req, reply) => { try { return reply.send(deps.commands.getMigrationCampaign(req.client!, (req.params as { id: string }).id)); } catch (err) { return sendError(reply, err); } });
  app.post('/v1/migrations/campaigns/:id/gates', { preHandler: requireScope('write') }, async (req, reply) => {
    const parsed = z.object({ gate: z.enum(['fresh_query', 'legacy_store', 'backup_restore']), idempotency_key: z.string().min(1).optional() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'invalid_request', message: parsed.error.message } });
    const key = idempotencyKeyFrom(req.headers as Record<string, unknown>, parsed.data) ?? parsed.data.idempotency_key; if (!key) return reply.code(400).send({ error: { code: 'invalid_request', message: 'idempotency_key is required' } });
    try { return reply.send(deps.commands.markMigrationGate(req.client!, { campaignId: (req.params as { id: string }).id, gate: parsed.data.gate }, key)); } catch (err) { return sendError(reply, err); }
  });
  app.post('/v1/migrations/sources', { preHandler: requireScope('write') }, async (req, reply) => {
    const parsed = z.object({ campaign_id: z.string().min(1), source_key: z.string().min(1), domain: z.string().min(1), status: z.enum(['pending', 'inaccessible', 'unknown', 'ready', 'complete']), expected_count: z.number().int().nonnegative().nullable().optional(), idempotency_key: z.string().min(1).optional() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'invalid_request', message: parsed.error.message } });
    const key = idempotencyKeyFrom(req.headers as Record<string, unknown>, parsed.data) ?? parsed.data.idempotency_key;
    if (!key) return reply.code(400).send({ error: { code: 'invalid_request', message: 'idempotency_key is required' } });
    try { return reply.send(deps.commands.updateMigrationSource(req.client!, { campaignId: parsed.data.campaign_id, sourceKey: parsed.data.source_key, domain: parsed.data.domain, status: parsed.data.status, expectedCount: parsed.data.expected_count }, key)); } catch (err) { return sendError(reply, err); }
  });
  app.post('/v1/migrations/ledger', { preHandler: requireScope('write') }, async (req, reply) => {
    const parsed = z.object({ campaign_id: z.string().min(1), source_key: z.string().min(1), external_ref_hash: z.string().regex(/^[a-f0-9]{64}$/), disposition: z.enum(['imported', 'duplicate', 'excluded', 'pending', 'submitted']), candidate_item_id: z.string().optional(), exclusion_reason: z.string().max(500).optional(), idempotency_key: z.string().min(1).optional() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'invalid_request', message: parsed.error.message } });
    const key = idempotencyKeyFrom(req.headers as Record<string, unknown>, parsed.data) ?? parsed.data.idempotency_key; if (!key) return reply.code(400).send({ error: { code: 'invalid_request', message: 'idempotency_key is required' } });
    try { return reply.send(deps.commands.recordMigrationLedger(req.client!, { campaignId: parsed.data.campaign_id, sourceKey: parsed.data.source_key, externalRefHash: parsed.data.external_ref_hash, disposition: parsed.data.disposition, candidateItemId: parsed.data.candidate_item_id, exclusionReason: parsed.data.exclusion_reason }, key)); } catch (err) { return sendError(reply, err); }
  });
}
