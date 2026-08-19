import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../server.js';
import { requireScope } from '../auth.js';
import { sendError } from '../errors.js';

export function registerChangeRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get('/v1/changes', { preHandler: requireScope('read') }, async (req, reply) => {
    const parsed = z.object({ after: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(1000).default(100) }).safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'invalid_request', message: parsed.error.message } });
    try { return reply.send(deps.commands.changes(req.client!, parsed.data)); } catch (err) { return sendError(reply, err); }
  });
}
