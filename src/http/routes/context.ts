import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CONTEXT_TARGETS } from '../../core/context-compiler.js';
import { requireScope } from '../auth.js';
import { sendError } from '../errors.js';
import type { AppDeps } from '../server.js';

const compileBodySchema = z.object({
  intent: z.string().min(1).max(10_000),
  queries: z.array(z.string().min(1).max(1000)).max(5).optional(),
  target_agent: z.enum(CONTEXT_TARGETS).default('generic'),
  token_budget: z.number().int().min(256).max(32_000).default(4000),
  sources: z.array(z.string().min(1)).max(50).optional(),
  types: z.array(z.string().min(1)).max(50).optional(),
  tags: z.array(z.string().min(1)).max(50).optional(),
  entities: z.array(z.string().min(1).max(200)).max(50).optional(),
  entity_filters: z.array(z.string().min(1).max(200)).max(50).optional(),
  information_classes: z.array(z.enum(['source', 'memory', 'task_state'])).max(3).optional(),
  memory_kinds: z.array(z.enum(['fact', 'preference', 'decision', 'experience', 'procedure', 'relationship', 'working_state'])).max(7).optional(),
  include_private: z.boolean().default(false),
  state_keys: z.array(z.string().min(1).max(200)).max(20).optional(),
});

const outcomeBodySchema = z.object({
  package_id: z.string().min(1).max(100),
  item_ids: z.array(z.string().min(1)).max(50).default([]),
  outcome: z.enum(['helpful', 'mixed', 'harmful', 'unknown']),
  action_changed: z.boolean(),
  idempotency_key: z.string().min(1).max(200),
});

export function registerContextRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.post('/v1/context/compile', { preHandler: requireScope('read') }, async (req, reply) => {
    const parsed = compileBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'invalid_request', message: parsed.error.message } });
    }
    const body = parsed.data;
    const sensitivity =
      body.include_private && req.client!.maxSensitivity === 'private' ? 'all' : 'normal';
    try {
      const contextPackage = deps.commands.compileContext(req.client!, {
        intent: body.intent,
        queries: body.queries,
        target: body.target_agent,
        tokenBudget: body.token_budget,
        filters: {
          sources: body.sources,
          types: body.types,
          tags: body.tags,
          entity_filters: body.entity_filters,
          information_classes: body.information_classes,
          memory_kinds: body.memory_kinds,
          sensitivity,
        },
        stateKeys: body.state_keys,
        entities: body.entities,
      });
      return reply.send({
        ...contextPackage,
        note:
          body.include_private && req.client!.maxSensitivity !== 'private'
            ? 'include_private was requested but this client is not authorized for private items'
            : undefined,
      });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/v1/context/outcomes', { preHandler: requireScope('write') }, async (req, reply) => {
    const parsed = outcomeBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'invalid_request', message: parsed.error.message } });
    }
    const { idempotency_key, ...input } = parsed.data;
    try {
      const result = deps.commands.recordContextOutcome(req.client!, input, idempotency_key);
      return reply.code(result.replayed ? 200 : 201).send(result);
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
