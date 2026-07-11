import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../server.js';
import { requireScope } from '../auth.js';
import { parseScopes } from '../../core/clients-repo.js';

const createClientSchema = z.object({
  id: z.string().min(2).max(64),
  name: z.string().min(1).max(200),
  kind: z.enum(['app', 'agent']),
  scopes: z.array(z.string()).min(1).default(['read', 'write']),
  // Read ceiling; defaults to 'private' for apps, 'normal' for agents.
  max_sensitivity: z.enum(['normal', 'private']).optional(),
  // Source whitelist: null/absent = all sources, [] = none.
  read_sources: z.array(z.string().min(1)).nullable().optional(),
});

const patchClientSchema = z.object({
  disabled: z.boolean(),
});

export function registerClientRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { clientsRepo, config } = deps;

  const adminGuard = requireScope('admin');

  app.post('/v1/clients', { preHandler: adminGuard }, async (req, reply) => {
    if (!config.adminToken) {
      return reply.code(503).send({
        error: { code: 'admin_disabled', message: 'Set ADMIN_TOKEN to enable client management over REST' },
      });
    }
    const parsed = createClientSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'invalid_request', message: parsed.error.message } });
    }
    try {
      const { client, apiKey } = clientsRepo.create({
        id: parsed.data.id,
        name: parsed.data.name,
        kind: parsed.data.kind,
        scopes: parseScopes(parsed.data.scopes),
        maxSensitivity: parsed.data.max_sensitivity,
        readSources: parsed.data.read_sources ?? null,
      });
      // The plaintext key is returned exactly once; only its hash is stored.
      return reply.code(201).send({ client, api_key: apiKey });
    } catch (err) {
      return reply.code(409).send({ error: { code: 'conflict', message: (err as Error).message } });
    }
  });

  app.get('/v1/clients', { preHandler: adminGuard }, async (_req, reply) => {
    return reply.send({ clients: clientsRepo.list() });
  });

  app.patch('/v1/clients/:id', { preHandler: adminGuard }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = patchClientSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'invalid_request', message: parsed.error.message } });
    }
    const ok = clientsRepo.setDisabled(id, parsed.data.disabled);
    if (!ok) {
      return reply.code(404).send({ error: { code: 'not_found', message: `No client with id "${id}"` } });
    }
    return reply.send({ ok: true });
  });
}
