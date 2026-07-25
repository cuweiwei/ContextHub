import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../server.js';
import { requireScope } from '../auth.js';
import { sendError } from '../errors.js';
import type { ClientAuth } from '../../core/types.js';

/**
 * Merged view of registered clients and actual write activity, scoped to the
 * caller's namespace and source whitelist — clients and sources outside the
 * boundary are entirely invisible (no names, counts, or last-activity leak).
 */
export function sourcesView(deps: Pick<AppDeps, 'commands' | 'clientsRepo'>, client: ClientAuth) {
  const overview = new Map(deps.commands.sourcesOverview(client).map((s) => [s.source, s]));
  const visible = (id: string) => client.readSources === null || client.readSources.includes(id);
  const registered = deps.clientsRepo.list(client.isAdmin ? undefined : client.namespace);
  const merged = registered
    .filter((c) => visible(c.id))
    .map((c) => {
      const stats = overview.get(c.id);
      overview.delete(c.id);
      return {
        source: c.id,
        name: c.name,
        kind: c.principal_kind,
        namespace: c.namespace,
        disabled: c.disabled,
        total_items: stats?.total ?? 0,
        last_write: stats?.last_write ?? null,
        types: stats?.types ?? {},
      };
    });
  // Sources that wrote items but are no longer registered clients (e.g. seeded).
  for (const stats of overview.values()) {
    merged.push({
      source: stats.source,
      name: stats.name ?? stats.source,
      kind: 'service',
      namespace: client.namespace || '*',
      disabled: false,
      total_items: stats.total,
      last_write: stats.last_write,
      types: stats.types,
    });
  }
  return merged.sort((a, b) => (b.last_write ?? '').localeCompare(a.last_write ?? ''));
}

export function registerSourceRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get('/v1/sources', { preHandler: requireScope('read') }, async (req, reply) => {
    try {
      return reply.send({ sources: sourcesView(deps, req.client!) });
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
