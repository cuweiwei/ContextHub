import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../server.js';
import { requireScope } from '../auth.js';
import { sendError } from '../errors.js';
import { newItemSchema } from '../../core/types.js';

const sha256 = z.string().regex(/^(?:sha256:)?[0-9a-f]{64}$/i, 'must be a SHA-256 hex digest');
const radarItemSchema = newItemSchema
  .omit({ idempotency_key: true, source_item_id: true })
  .extend({ type: z.literal('insight') });

const publicationBodySchema = z.object({
  schema_version: z.literal(1),
  insight_id: z.string().min(1).max(200),
  revision: z.number().int().positive(),
  operation_key: z.string().min(1).max(200),
  content_hash: sha256,
  hub_content_hash: sha256.optional(),
  action: z.enum(['publish', 'withdraw']),
  item: radarItemSchema.optional(),
}).superRefine((body, ctx) => {
  if (body.action === 'publish' && !body.item) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['item'], message: 'publish requires an item' });
  }
  if (body.action === 'withdraw' && body.item) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['item'], message: 'withdraw must not include an item' });
  }
  if (body.action === 'withdraw' && body.hub_content_hash) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['hub_content_hash'], message: 'withdraw must not include hub_content_hash' });
  }
});

const publicationQuerySchema = z.object({
  insight_id: z.string().min(1).max(200).optional(),
  publisher_id: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
});

export function registerRadarRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.post('/v1/radar/publications', { preHandler: requireScope('write') }, async (req, reply) => {
    const parsed = publicationBodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'invalid_request', message: parsed.error.message } });
    const body = parsed.data;
    try {
      const result = deps.commands.publishRadarInsight(req.client!, {
        schemaVersion: body.schema_version,
        insightId: body.insight_id,
        revision: body.revision,
        operationKey: body.operation_key,
        contentHash: body.content_hash,
        ...(body.hub_content_hash ? { hubContentHash: body.hub_content_hash } : {}),
        action: body.action,
        ...(body.item ? { item: body.item } : {}),
      });
      return reply.code(result.created && !result.replayed ? 201 : 200).send(result);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/v1/radar/publications', { preHandler: requireScope('read') }, async (req, reply) => {
    const parsed = publicationQuerySchema.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'invalid_request', message: parsed.error.message } });
    try {
      return reply.send(deps.commands.listRadarPublications(req.client!, {
        insightId: parsed.data.insight_id,
        publisherId: parsed.data.publisher_id,
        limit: parsed.data.limit,
      }));
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
