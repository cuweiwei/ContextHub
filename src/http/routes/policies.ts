import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../server.js';
import { requireScope } from '../auth.js';
import { sendError } from '../errors.js';
import { CAPABILITIES } from '../../core/policy.js';

/**
 * Policy administration. PUT installs a NEW policy version (history is
 * append-only, so "which rules were in force when item X was auto-accepted"
 * stays answerable). Reachable by the admin token or a namespace client
 * holding policy.manage for its OWN namespace.
 */
export function registerPolicyRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { commands, policiesRepo } = deps;
  const simulationCase = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('capability'), client_id: z.string().min(1), capability: z.enum(CAPABILITIES) }).strict(),
    z.object({ kind: z.literal('batch'), client_id: z.string().min(1), capability: z.enum(CAPABILITIES), item_type: z.string().optional(), state_key: z.string().optional() }).strict(),
    z.object({ kind: z.literal('create'), client_id: z.string().min(1), item_type: z.string().min(1) }).strict(),
    z.object({ kind: z.literal('create_rule'), client_id: z.string().min(1), item_type: z.string().min(1) }).strict(),
    z.object({ kind: z.enum(['state_read', 'state_write']), client_id: z.string().min(1), state_key: z.string().min(1), schema_id: z.string().optional() }).strict(),
  ]);

  app.get('/v1/policies/:namespace', { preHandler: requireScope('read') }, async (req, reply) => {
    const { namespace } = req.params as { namespace: string };
    try {
      const current = commands.getPolicy(req.client!, namespace);
      if (!current) {
        return reply.code(404).send({
          error: { code: 'not_found', message: `namespace "${namespace}" has no valid current policy` },
        });
      }
      return reply.send(current);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/v1/policies/:namespace/versions/:version', { preHandler: requireScope('admin') }, async (req, reply) => {
    const { namespace, version } = req.params as { namespace: string; version: string };
    const v = policiesRepo.getVersion(namespace, Number(version));
    if (!v) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'no such policy version' } });
    }
    return reply.send({ namespace, version: Number(version), rules: v.rules });
  });

  app.put('/v1/policies/:namespace', { preHandler: requireScope('write') }, async (req, reply) => {
    const { namespace } = req.params as { namespace: string };
    const body = z.object({ rules: z.unknown(), base_version: z.number().int().nonnegative().optional(), idempotency_key: z.string().min(1) }).safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: { code: 'invalid_request', message: 'body must be {"rules": {...}}' } });
    }
    try {
      const result = commands.applyPolicy(req.client!, namespace, body.data.rules, { expectedVersion: body.data.base_version, idempotencyKey: body.data.idempotency_key });
      return reply.send(result);
    } catch (err) {
      try {
        return sendError(reply, err);
      } catch {
        return reply.code(400).send({ error: { code: 'policy_rejected', message: (err as Error).message } });
      }
    }
  });

  app.post('/v1/policies/:namespace/validate', { preHandler: requireScope('write') }, async (req, reply) => {
    const { namespace } = req.params as { namespace: string };
    const body = z.object({ rules: z.unknown() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: { code: 'invalid_request', message: body.error.message } });
    try { return reply.send(commands.validatePolicyDraft(req.client!, namespace, body.data.rules)); } catch (err) { return sendError(reply, err); }
  });

  app.post('/v1/policies/:namespace/simulate', { preHandler: requireScope('write') }, async (req, reply) => {
    const { namespace } = req.params as { namespace: string };
    const body = z.object({ rules: z.unknown(), cases: z.array(simulationCase).max(100) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: { code: 'invalid_request', message: body.error.message } });
    try { return reply.send(commands.simulatePolicyDraft(req.client!, namespace, body.data.rules, body.data.cases as never)); } catch (err) { return sendError(reply, err); }
  });

  app.post('/v1/policies/:namespace/rollback', { preHandler: requireScope('write') }, async (req, reply) => {
    const { namespace } = req.params as { namespace: string };
    const body = z.object({ version: z.number().int().positive(), base_version: z.number().int().nonnegative().optional(), idempotency_key: z.string().min(1) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: { code: 'invalid_request', message: body.error.message } });
    const historical = policiesRepo.getVersion(namespace, body.data.version);
    if (!historical) return reply.code(404).send({ error: { code: 'not_found', message: 'no such policy version' } });
    try { return reply.send(commands.applyPolicy(req.client!, namespace, historical.rules, { expectedVersion: body.data.base_version, idempotencyKey: body.data.idempotency_key })); } catch (err) { return sendError(reply, err); }
  });

  // Operational-state value schemas (admin).
  app.get('/v1/state-schemas', { preHandler: requireScope('admin') }, async (_req, reply) => {
    return reply.send({ schemas: deps.policiesRepo.listStateSchemas() });
  });

  app.put('/v1/state-schemas/:id', { preHandler: requireScope('admin') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const schema = commands.adminRegisterStateSchema(req.client!, id, req.body);
      return reply.send({ schema_id: id, schema });
    } catch (err) {
      try {
        return sendError(reply, err);
      } catch {
        return reply.code(400).send({ error: { code: 'invalid_request', message: (err as Error).message } });
      }
    }
  });
}
