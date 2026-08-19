import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../server.js';
import { requireScope } from '../auth.js';
import { sendError } from '../errors.js';

export function registerEntityRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.post('/v1/entities/traverse', { preHandler: requireScope('read') }, async (req, reply) => {
    const parsed = z.object({ entity: z.string().min(1).max(200), depth: z.number().int().min(1).max(3).default(2) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'invalid_request', message: parsed.error.message } });
    try { return reply.send(deps.commands.traverseGraph(req.client!, parsed.data)); } catch (err) { return sendError(reply, err); }
  });
  app.get('/v1/consolidation/suggestions', { preHandler: requireScope('read') }, async (req, reply) => {
    const namespace = typeof (req.query as any).namespace === 'string' ? (req.query as any).namespace : undefined;
    try { return reply.send({ suggestions: deps.commands.consolidation(req.client!, namespace) }); } catch (err) { return sendError(reply, err); }
  });
}
