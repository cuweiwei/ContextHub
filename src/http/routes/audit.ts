import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../server.js';
import { requireScope } from '../auth.js';
import { sendError } from '../errors.js';

const auditQuerySchema = z.object({
  namespace: z.string().optional(),
  client_id: z.string().optional(),
  action: z.string().optional(),
  outcome: z.enum(['allow', 'deny']).optional(),
  item_id: z.string().optional(),
  item_type: z.string().optional(),
  item_sensitivity: z.enum(['normal', 'private']).optional(),
  since: z.string().optional(),
  until: z.string().optional(),
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
        clientId: parsed.data.client_id,
        action: parsed.data.action,
        outcome: parsed.data.outcome,
        itemId: parsed.data.item_id,
        itemType: parsed.data.item_type,
        itemSensitivity: parsed.data.item_sensitivity,
        since: parsed.data.since,
        until: parsed.data.until,
        limit: parsed.data.limit,
        beforeId: parsed.data.before_id,
      });
      return reply.send({ entries });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/v1/audit/verify', { preHandler: requireScope('admin') }, async (req, reply) => {
    try { return reply.send(deps.auditRepo.verifyChain()); } catch (err) { return sendError(reply, err); }
  });
  app.get('/v1/audit/operations', { preHandler: requireScope('admin') }, async (req, reply) => {
    try { return reply.send(deps.commands.auditOperations(req.client!)); } catch (err) { return sendError(reply, err); }
  });

  app.get('/v1/audit/export', { preHandler: requireScope('read') }, async (req, reply) => {
    const parsed = auditQuerySchema.extend({ limit: z.coerce.number().int().min(1).max(10_000).default(10_000), format: z.enum(['jsonl', 'csv']).default('jsonl') }).safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'invalid_request', message: parsed.error.message } });
    try {
      const entries = deps.commands.queryAudit(req.client!, { namespace: parsed.data.namespace, clientId: parsed.data.client_id, action: parsed.data.action, outcome: parsed.data.outcome, itemId: parsed.data.item_id, itemType: parsed.data.item_type, itemSensitivity: parsed.data.item_sensitivity, since: parsed.data.since, until: parsed.data.until, limit: Math.min(parsed.data.limit, 10_000), beforeId: parsed.data.before_id });
      // Details are deliberately reduced to metadata only. Export never contains
      // title/content/query/snippet fields even if an old row has them.
      const metadataKeys = new Set(['reason', 'count', 'limit', 'target', 'token_budget', 'query_count', 'entity_count', 'include_candidates', 'runtime_input_count', 'runtime_input_bytes', 'runtime_input_kinds', 'version', 'schema_id', 'profile', 'principal_kind', 'credential_version', 'window_hours', 'probe']);
      const safe = entries.map((entry) => ({ id: entry.id, ts: entry.ts, namespace: entry.namespace, client_id: entry.client_id, action: entry.action, item_id: entry.item_id, outcome: entry.outcome, details: entry.details && typeof entry.details === 'object' ? Object.fromEntries(Object.entries(entry.details as Record<string, unknown>).filter(([key]) => metadataKeys.has(key))) : null }));
      if (parsed.data.format === 'csv') {
        const esc = (value: unknown) => `"${String(value ?? '').replaceAll('"', '""')}"`;
        const lines = ['id,ts,namespace,client_id,action,item_id,outcome,details', ...safe.map((entry) => [entry.id, entry.ts, entry.namespace, entry.client_id, entry.action, entry.item_id, entry.outcome, JSON.stringify(entry.details ?? {})].map(esc).join(','))];
        return reply.type('text/csv; charset=utf-8').send(lines.join('\n') + '\n');
      }
      return reply.type('application/x-ndjson').send(safe.map((entry) => JSON.stringify(entry)).join('\n') + (safe.length ? '\n' : ''));
    } catch (err) { return sendError(reply, err); }
  });
}
