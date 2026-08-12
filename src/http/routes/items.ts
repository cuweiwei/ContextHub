import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../server.js';
import { requireScope } from '../auth.js';
import { idempotencyKeyFrom, sendError } from '../errors.js';
import {
  AUTHORITIES,
  isoDateTime,
  newItemSchema,
  patchItemSchema,
  STATUSES,
} from '../../core/types.js';

const createBodySchema = newItemSchema.extend({
  // Admin-only: write on behalf of another source (seeding/import), specify
  // authority (the human-entry path for authority=user), or target a
  // namespace explicitly. IGNORED → rejected for every other client.
  source: z.string().optional(),
  authority: z.enum(AUTHORITIES).optional(),
  namespace: z.string().optional(),
});

const batchBodySchema = z.object({
  items: z.array(createBodySchema).min(1).max(100),
});

const listQuerySchema = z.object({
  source: z.string().optional(),
  type: z.string().optional(),
  tags: z.string().optional(),
  status: z.string().optional(),
  q: z.string().optional(),
  entity: z.string().optional(),
  retrieval_mode: z.enum(['hybrid', 'lexical']).default('hybrid'),
  since: isoDateTime.optional(),
  until: isoDateTime.optional(),
  sensitivity: z.enum(['normal', 'private', 'all']).default('all'),
  include_candidates: z.coerce.boolean().default(false),
  sort: z.enum(['created', 'occurred']).default('created'),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
  cursor: z.string().optional(),
});

const reviewBodySchema = z.object({
  decision: z.enum(['accept', 'reject']),
  expected_revision: z.number().int().min(1),
  note: z.string().max(2000).optional(),
  idempotency_key: z.string().min(1).max(200),
});

const revokeBodySchema = z.object({
  expected_revision: z.number().int().min(1),
  note: z.string().max(2000).optional(),
  idempotency_key: z.string().min(1).max(200),
});

const taskOpBodySchema = z.object({
  kind: z.enum([
    'set_status',
    'set_progress',
    'set_blocked',
    'complete_checklist_item',
    'set_due_date',
    'set_priority',
    'set_assignee',
    'set_dependencies',
  ]),
  status: z.enum(STATUSES).optional(),
  progress: z.number().min(0).max(100).optional(),
  blocked_reason: z.string().max(2000).nullable().optional(),
  checklist_index: z.number().int().min(0).optional(),
  due_date: isoDateTime.nullable().optional(),
  priority: z.enum(['low', 'medium', 'high']).nullable().optional(),
  assignee: z.string().max(200).nullable().optional(),
  dependencies: z.array(z.string().min(1)).max(50).optional(),
  expected_revision: z.number().int().min(1),
  idempotency_key: z.string().min(1).max(200),
});

const curateBodySchema = z.object({
  tags: z.array(z.string().min(1).max(100)).max(50).optional(),
  collection: z.string().max(200).nullable().optional(),
  archived: z.boolean().optional(),
  related_item_ids: z.array(z.string().min(1)).max(50).optional(),
  expected_revision: z.number().int().min(1),
  idempotency_key: z.string().min(1).max(200),
});

const reviseBodySchema = patchItemSchema.extend({
  idempotency_key: z.string().min(1).max(200),
});

function csv(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const parts = value.split(',').map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts : undefined;
}

export function registerItemRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { commands } = deps;

  app.post('/v1/items', { preHandler: requireScope('write') }, async (req, reply) => {
    const parsed = createBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'invalid_request', message: parsed.error.message } });
    }
    const { source, authority, namespace, ...input } = parsed.data;
    try {
      const { item, created, replayed } = commands.createMemory(req.client!, input, {
        source,
        authority,
        namespace,
      });
      return reply.code(created && !replayed ? 201 : 200).send({ item, created, replayed });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/v1/items/batch', { preHandler: requireScope('write') }, async (req, reply) => {
    const parsed = batchBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'invalid_request', message: parsed.error.message } });
    }
    const batchKey = idempotencyKeyFrom(req.headers as Record<string, unknown>);
    if (!batchKey) {
      return reply.code(400).send({
        error: { code: 'invalid_request', message: 'batch writes require an Idempotency-Key header' },
      });
    }
    const first = parsed.data.items[0]!;
    for (const entry of parsed.data.items) {
      if ((entry.source ?? first.source) !== first.source || (entry.namespace ?? first.namespace) !== first.namespace) {
        return reply.code(400).send({
          error: { code: 'invalid_request', message: 'a batch must target a single source/namespace' },
        });
      }
    }
    try {
      const { results, replayed } = commands.createMemoryBatch(
        req.client!,
        batchKey,
        parsed.data.items.map(({ source: _s, authority: _a, namespace: _n, ...input }) => input),
        { source: first.source, authority: first.authority, namespace: first.namespace },
      );
      return reply.code(replayed ? 200 : 201).send({ results, replayed });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/v1/items', { preHandler: requireScope('read') }, async (req, reply) => {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'invalid_request', message: parsed.error.message } });
    }
    const qp = parsed.data;
    const statuses = csv(qp.status)?.filter((s): s is (typeof STATUSES)[number] =>
      (STATUSES as readonly string[]).includes(s),
    );
    const filters = {
      sources: csv(qp.source),
      types: csv(qp.type),
      tags: csv(qp.tags),
      statuses,
      since: qp.since,
      until: qp.until,
      sensitivity: qp.sensitivity, // repo clamps to the client ceiling
    };
    try {
      if (qp.q?.trim()) {
        const { items, fullItems, totalMatched, retrieval, note } = commands.search(req.client!, {
          queries: [qp.q],
          filters,
          limit: qp.limit,
          offset: qp.offset,
          mode: qp.retrieval_mode,
          entities: csv(qp.entity),
          includeCandidates: qp.include_candidates,
        });
        return reply.send({
          items: fullItems.map((item) => ({
            ...item,
            retrieval_sources:
              items.find((compact) => compact.id === item.id)?.retrieval_sources ?? [],
          })),
          total_matched: totalMatched,
          offset: qp.offset,
          retrieval,
          note,
        });
      }
      const { items, nextCursor, note } = commands.listItems(req.client!, {
        filters,
        limit: qp.limit,
        cursor: qp.cursor,
        sort: qp.sort,
        includeCandidates: qp.include_candidates,
      });
      return reply.send({ items, next_cursor: nextCursor ?? null, note });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/v1/candidates', { preHandler: requireScope('read') }, async (req, reply) => {
    const qp = z
      .object({
        scope: z.enum(['my', 'inbox']).default('my'),
        limit: z.coerce.number().int().min(1).max(100).default(20),
      })
      .safeParse(req.query);
    if (!qp.success) {
      return reply.code(400).send({ error: { code: 'invalid_request', message: qp.error.message } });
    }
    try {
      const items = commands.listCandidates(req.client!, qp.data.scope, qp.data.limit);
      return reply.send({ scope: qp.data.scope, items });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/v1/items/:id', { preHandler: requireScope('read') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const item = commands.getItem(req.client!, id);
      if (!item) {
        // Unauthorized, cross-namespace, and nonexistent are indistinguishable.
        return reply.code(404).send({ error: { code: 'not_found', message: `No item with id "${id}"` } });
      }
      return reply.send({ item });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/v1/items/:id/history', { preHandler: requireScope('read') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const history = commands.getHistory(req.client!, id);
      if (!history) {
        return reply.code(404).send({ error: { code: 'not_found', message: `No item with id "${id}"` } });
      }
      return reply.send(history);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.patch('/v1/items/:id', { preHandler: requireScope('write') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = patchItemSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'invalid_request', message: parsed.error.message } });
    }
    const key = idempotencyKeyFrom(req.headers as Record<string, unknown>, req.body);
    if (!key) {
      return reply.code(400).send({
        error: { code: 'invalid_request', message: 'mutations require an Idempotency-Key header' },
      });
    }
    try {
      const { item } = commands.patchProjection(req.client!, id, parsed.data, key);
      return reply.send({ item });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/v1/items/:id/revise', { preHandler: requireScope('write') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = reviseBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'invalid_request', message: parsed.error.message } });
    }
    const { idempotency_key, ...patch } = parsed.data;
    try {
      const { item } = commands.reviseCandidate(req.client!, id, patch, idempotency_key);
      return reply.send({ item });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/v1/items/:id/successor', { preHandler: requireScope('write') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = newItemSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'invalid_request', message: parsed.error.message } });
    }
    try {
      const { item, created } = commands.proposeSuccessor(req.client!, id, parsed.data);
      return reply.code(created ? 201 : 200).send({ item, created });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/v1/items/:id/review', { preHandler: requireScope('write') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = reviewBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'invalid_request', message: parsed.error.message } });
    }
    try {
      const { item } = commands.reviewMemory(
        req.client!,
        id,
        {
          decision: parsed.data.decision,
          expectedRevision: parsed.data.expected_revision,
          note: parsed.data.note,
        },
        parsed.data.idempotency_key,
      );
      return reply.send({ item });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/v1/items/:id/revoke', { preHandler: requireScope('write') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = revokeBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'invalid_request', message: parsed.error.message } });
    }
    try {
      const { item } = commands.reviewMemory(
        req.client!,
        id,
        { decision: 'revoke', expectedRevision: parsed.data.expected_revision, note: parsed.data.note },
        parsed.data.idempotency_key,
      );
      return reply.send({ item });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/v1/items/:id/task-op', { preHandler: requireScope('write') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = taskOpBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'invalid_request', message: parsed.error.message } });
    }
    const { idempotency_key, ...action } = parsed.data;
    try {
      const { item } = commands.operateTask(req.client!, id, action, idempotency_key);
      return reply.send({ item });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/v1/items/:id/curate', { preHandler: requireScope('write') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = curateBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'invalid_request', message: parsed.error.message } });
    }
    const { idempotency_key, ...curate } = parsed.data;
    try {
      const { item } = commands.curateNote(req.client!, id, curate, idempotency_key);
      return reply.send({ item });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete('/v1/items/:id', { preHandler: requireScope('write') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const key = idempotencyKeyFrom(req.headers as Record<string, unknown>, req.body);
    if (!key) {
      return reply.code(400).send({
        error: { code: 'invalid_request', message: 'mutations require an Idempotency-Key header' },
      });
    }
    try {
      commands.softDeleteItem(req.client!, id, key);
      return reply.code(204).send();
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
