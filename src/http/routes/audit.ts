import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../server.js';
import { requireScope } from '../auth.js';
import { sendError } from '../errors.js';

const auditQuerySchema = z.object({
  namespace: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  before_id: z.coerce.number().int().optional(),
});

/**
 * Audit inspection. Admin sees everything (optionally filtered); a namespace
 * client with audit.read is pinned to its own namespace — work and personal
 * audit trails stay separate.
 */
export function registerAuditRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get('/v1/audit', { preHandler: requireScope('read') }, async (req, reply) => {
    const parsed = auditQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'invalid_request', message: parsed.error.message } });
    }
    try {
      const entries = deps.commands.queryAudit(req.client!, {
        namespace: parsed.data.namespace,
        limit: parsed.data.limit,
        beforeId: parsed.data.before_id,
      });
      return reply.send({ entries });
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
