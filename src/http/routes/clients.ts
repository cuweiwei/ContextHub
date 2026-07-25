import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../server.js';
import { requireScope } from '../auth.js';
import { sendError } from '../errors.js';
import { parseScopes } from '../../core/clients-repo.js';
import { GRANT_PROFILES } from '../../core/policy.js';
import { PRINCIPAL_KINDS } from '../../core/types.js';

const createClientSchema = z.object({
  id: z.string().min(2).max(64),
  name: z.string().min(1).max(200),
  // REQUIRED: there is no default namespace for new principals (fail-closed).
  namespace: z.string().min(1),
  principal_kind: z.enum(PRINCIPAL_KINDS),
  scopes: z.array(z.string()).min(1).default(['read', 'write']),
  max_sensitivity: z.enum(['normal', 'private']).optional(),
  read_sources: z.array(z.string().min(1)).nullable().optional(),
  // Optional grant profile — applied as an explicit, versioned policy change.
  profile: z.enum(GRANT_PROFILES).optional(),
});

const patchClientSchema = z.object({
  disabled: z.boolean(),
});

const createNamespaceSchema = z.object({
  id: z.string().min(2).max(64),
  description: z.string().max(500).optional(),
});

export function registerClientRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { clientsRepo, commands, config } = deps;

  const adminGuard = requireScope('admin');

  function adminEnabled(reply: any): boolean {
    if (!config.adminToken) {
      reply.code(503).send({
        error: { code: 'admin_disabled', message: 'Set ADMIN_TOKEN to enable administration over REST' },
      });
      return false;
    }
    return true;
  }

  app.post('/v1/clients', { preHandler: adminGuard }, async (req, reply) => {
    if (!adminEnabled(reply)) return reply;
    const parsed = createClientSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'invalid_request', message: parsed.error.message } });
    }
    try {
      const { client, apiKey } = commands.adminCreateClient(req.client!, {
        id: parsed.data.id,
        name: parsed.data.name,
        namespace: parsed.data.namespace,
        principalKind: parsed.data.principal_kind,
        scopes: parseScopes(parsed.data.scopes),
        maxSensitivity: parsed.data.max_sensitivity,
        readSources: parsed.data.read_sources ?? null,
        profile: parsed.data.profile,
      });
      // The plaintext key is returned exactly once; only its hash is stored.
      return reply.code(201).send({ client, api_key: apiKey });
    } catch (err) {
      try {
        return sendError(reply, err);
      } catch {
        return reply.code(409).send({ error: { code: 'conflict', message: (err as Error).message } });
      }
    }
  });

  app.get('/v1/clients', { preHandler: adminGuard }, async (req, reply) => {
    const { namespace } = req.query as { namespace?: string };
    return reply.send({ clients: clientsRepo.list(namespace) });
  });

  app.post('/v1/clients/:id/rotate-key', { preHandler: adminGuard }, async (req, reply) => {
    if (!adminEnabled(reply)) return reply;
    const { id } = req.params as { id: string };
    try {
      const { client, apiKey } = commands.adminRotateKey(req.client!, id);
      return reply.send({ client, api_key: apiKey });
    } catch (err) {
      try {
        return sendError(reply, err);
      } catch {
        return reply.code(404).send({ error: { code: 'not_found', message: (err as Error).message } });
      }
    }
  });

  app.patch('/v1/clients/:id', { preHandler: adminGuard }, async (req, reply) => {
    if (!adminEnabled(reply)) return reply;
    const { id } = req.params as { id: string };
    const parsed = patchClientSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'invalid_request', message: parsed.error.message } });
    }
    try {
      const ok = commands.adminSetDisabled(req.client!, id, parsed.data.disabled);
      if (!ok) {
        return reply.code(404).send({ error: { code: 'not_found', message: `No client with id "${id}"` } });
      }
      return reply.send({ ok: true });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/v1/namespaces', { preHandler: adminGuard }, async (_req, reply) => {
    return reply.send({ namespaces: clientsRepo.listNamespaces() });
  });

  app.post('/v1/namespaces', { preHandler: adminGuard }, async (req, reply) => {
    if (!adminEnabled(reply)) return reply;
    const parsed = createNamespaceSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'invalid_request', message: parsed.error.message } });
    }
    try {
      commands.adminCreateNamespace(req.client!, parsed.data.id, parsed.data.description);
      return reply.code(201).send({ ok: true });
    } catch (err) {
      try {
        return sendError(reply, err);
      } catch {
        return reply.code(409).send({ error: { code: 'conflict', message: (err as Error).message } });
      }
    }
  });
}
