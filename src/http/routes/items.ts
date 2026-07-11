import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../server.js';
import { requireScope } from '../auth.js';
import { RevisionConflictError, SourceItemConflictError, ValidationError } from '../../core/errors.js';
import {
  accessFor,
  AGENT_WRITABLE_TYPES,
  AUTHORITIES,
  isoDateTime,
  newItemSchema,
  patchItemSchema,
  resolveAuthority,
  STATUSES,
  type ClientAuth,
} from '../../core/types.js';

const createBodySchema = newItemSchema.extend({
  // Admin-only: write on behalf of another source (seeding/import)…
  source: z.string().optional(),
  // …and specify authority (the human-entry path for authority=user).
  // For every other client this field is IGNORED — authority comes from identity.
  authority: z.enum(AUTHORITIES).optional(),
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
  since: isoDateTime.optional(),
  until: isoDateTime.optional(),
  sensitivity: z.enum(['normal', 'private', 'all']).default('all'),
  include_proposed: z.coerce.boolean().default(false),
  sort: z.enum(['created', 'occurred']).default('created'),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
  cursor: z.string().optional(),
});

function csv(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const parts = value.split(',').map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts : undefined;
}

function sendError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof SourceItemConflictError || err instanceof RevisionConflictError) {
    return reply.code(409).send({ error: { code: err.code, message: err.message } });
  }
  if (err instanceof ValidationError) {
    return reply.code(400).send({ error: { code: err.code, message: err.message } });
  }
  throw err;
}

/** Insight isolation: agents may only create insight/task/note items. */
function agentTypeViolation(client: ClientAuth, type: string): string | null {
  if (client.kind === 'agent' && !AGENT_WRITABLE_TYPES.has(type)) {
    return `agent clients may only write types ${[...AGENT_WRITABLE_TYPES].join('/')} — facts and states belong to source apps or the user`;
  }
  return null;
}

export function registerItemRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { itemsRepo } = deps;

  app.post('/v1/items', { preHandler: requireScope('write') }, async (req, reply) => {
    const parsed = createBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'invalid_request', message: parsed.error.message } });
    }
    const { source: requestedSource, authority: requestedAuthority, ...input } = parsed.data;
    const client = req.client!;
    if (requestedSource && requestedSource !== client.id && !client.isAdmin) {
      return reply.code(403).send({
        error: { code: 'forbidden', message: 'Only the admin token may write on behalf of another source' },
      });
    }
    const violation = agentTypeViolation(client, input.type);
    if (violation) return reply.code(403).send({ error: { code: 'forbidden', message: violation } });
    try {
      const { item, created } = itemsRepo.insert(
        requestedSource ?? client.id,
        input,
        resolveAuthority(client, requestedAuthority),
        accessFor(client),
      );
      return reply.code(created ? 201 : 200).send({ item, created });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/v1/items/batch', { preHandler: requireScope('write') }, async (req, reply) => {
    const parsed = batchBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'invalid_request', message: parsed.error.message } });
    }
    const client = req.client!;
    for (const entry of parsed.data.items) {
      if (entry.source && entry.source !== client.id && !client.isAdmin) {
        return reply.code(403).send({
          error: { code: 'forbidden', message: 'Only the admin token may write on behalf of another source' },
        });
      }
      const violation = agentTypeViolation(client, entry.type);
      if (violation) return reply.code(403).send({ error: { code: 'forbidden', message: violation } });
    }
    try {
      const results = parsed.data.items.map(({ source, authority, ...input }) =>
        itemsRepo.insert(
          source ?? client.id,
          input,
          resolveAuthority(client, authority),
          accessFor(client),
        ),
      );
      return reply.code(201).send({ results });
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
    const client = req.client!;
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
      includeProposed: qp.include_proposed,
    };
    const access = accessFor(client);
    if (qp.q?.trim()) {
      const { fullItems, totalMatched } = itemsRepo.search(access, {
        queries: [qp.q],
        filters,
        limit: qp.limit,
        offset: qp.offset,
      });
      return reply.send({ items: fullItems, total_matched: totalMatched, offset: qp.offset });
    }
    const { items, nextCursor } = itemsRepo.list(access, {
      filters,
      limit: qp.limit,
      cursor: qp.cursor,
      sort: qp.sort,
    });
    return reply.send({ items, next_cursor: nextCursor ?? null });
  });

  app.get('/v1/items/:id', { preHandler: requireScope('read') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const item = itemsRepo.get(accessFor(req.client!), id);
    if (!item) {
      // Unauthorized and nonexistent are indistinguishable — no existence leak.
      return reply.code(404).send({ error: { code: 'not_found', message: `No item with id "${id}"` } });
    }
    return reply.send({ item });
  });

  app.patch('/v1/items/:id', { preHandler: requireScope('write') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = patchItemSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'invalid_request', message: parsed.error.message } });
    }
    const patch = parsed.data;
    const client = req.client!;
    const existing = itemsRepo.get(accessFor(client), id);
    if (!existing) {
      return reply.code(404).send({ error: { code: 'not_found', message: `No item with id "${id}"` } });
    }

    // ---- Review operation: acceptance change is standalone and capability-gated.
    if (patch.acceptance !== undefined) {
      const extraKeys = Object.keys(patch).filter(
        (k) => !['acceptance', 'expected_revision', 'review_note'].includes(k),
      );
      if (extraKeys.length > 0) {
        return reply.code(400).send({
          error: {
            code: 'invalid_request',
            message: 'an acceptance change must be a standalone operation (only expected_revision and review_note may accompany it)',
          },
        });
      }
      if (patch.expected_revision === undefined) {
        return reply.code(400).send({
          error: { code: 'invalid_request', message: 'expected_revision is required when changing acceptance' },
        });
      }
      if (!client.isAdmin && !client.scopes.includes('review_insight')) {
        return reply.code(403).send({
          error: { code: 'forbidden', message: 'reviewing insights requires the "review_insight" scope' },
        });
      }
      if (!client.isAdmin && existing.source === client.id) {
        return reply.code(403).send({
          error: { code: 'forbidden', message: 'a client cannot review its own insight proposals' },
        });
      }
      try {
        const item = itemsRepo.review(id, {
          acceptance: patch.acceptance,
          reviewedBy: client.id,
          expectedRevision: patch.expected_revision,
          note: patch.review_note,
        });
        return reply.send({ item });
      } catch (err) {
        return sendError(reply, err);
      }
    }

    // ---- Content updates.
    if (existing.type === 'insight' && !client.isAdmin) {
      // Insights are append-only: reviewers may change status (e.g. supersede
      // an outdated accepted insight); nobody but admin edits the content.
      const keys = Object.keys(patch);
      const statusOnly = keys.every((k) => ['status', 'expected_revision'].includes(k));
      if (!statusOnly || !client.scopes.includes('review_insight')) {
        return reply.code(403).send({
          error: {
            code: 'forbidden',
            message: 'insights are append-only: propose a new insight instead of editing (only reviewers may change status)',
          },
        });
      }
    } else {
      if (existing.source !== client.id && !client.isAdmin) {
        return reply.code(403).send({
          error: { code: 'forbidden', message: 'Items can only be modified by the client that created them' },
        });
      }
      if (patch.type && client.kind === 'agent' && !AGENT_WRITABLE_TYPES.has(patch.type)) {
        return reply.code(403).send({
          error: { code: 'forbidden', message: `agent clients may only use types ${[...AGENT_WRITABLE_TYPES].join('/')}` },
        });
      }
    }
    const item = itemsRepo.update(id, patch);
    return reply.send({ item });
  });

  app.delete('/v1/items/:id', { preHandler: requireScope('write') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const client = req.client!;
    const existing = itemsRepo.get(accessFor(client), id);
    if (!existing) {
      return reply.code(404).send({ error: { code: 'not_found', message: `No item with id "${id}"` } });
    }
    if (existing.source !== client.id && !client.isAdmin) {
      return reply.code(403).send({
        error: { code: 'forbidden', message: 'Items can only be deleted by the client that created them' },
      });
    }
    itemsRepo.softDelete(id);
    return reply.code(204).send();
  });
}
