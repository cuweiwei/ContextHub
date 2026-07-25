import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../server.js';
import { requireScope } from '../auth.js';
import { sendError } from '../errors.js';
import { isoDateTime, STATUSES } from '../../core/types.js';

const statePutSchema = z.object({
  schema_id: z.string().min(1).max(100),
  title: z.string().min(1).max(500).optional(),
  value: z.unknown().optional(),
  observed_at: isoDateTime.nullable().optional(),
  expires_at: isoDateTime.nullable().optional(),
  status: z.enum(STATUSES).optional(),
  expected_revision: z.number().int().min(1).optional(),
  idempotency_key: z.string().min(1).max(200),
});

/**
 * Operational state slots: the dedicated read/write surface. These items are
 * EXCLUDED from search/list/brief/current — visibility is governed solely by
 * the namespace policy's exact-key state rules.
 */
export function registerStateRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { commands } = deps;

  app.get('/v1/state/:key', { preHandler: requireScope('read') }, async (req, reply) => {
    const { key } = req.params as { key: string };
    try {
      const item = commands.readOperationalState(req.client!, key);
      if (!item) {
        return reply.code(404).send({ error: { code: 'not_found', message: `no state slot "${key}"` } });
      }
      return reply.send({ item });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.put('/v1/state/:key', { preHandler: requireScope('write') }, async (req, reply) => {
    const { key } = req.params as { key: string };
    const parsed = statePutSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'invalid_request', message: parsed.error.message } });
    }
    const { idempotency_key, ...input } = parsed.data;
    try {
      const { item, created } = commands.updateOperationalState(
        req.client!,
        { state_key: key, ...input },
        idempotency_key,
      );
      return reply.code(created ? 201 : 200).send({ item, created });
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
