import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../server.js';
import { requireScope } from '../auth.js';
import { accessFor, type ReadAccess } from '../../core/types.js';

/**
 * Merged view of registered clients and actual write activity, filtered by
 * the caller's source whitelist — sources outside it are entirely invisible
 * (no names, counts, or last-activity metadata leak).
 */
export function sourcesView(deps: Pick<AppDeps, 'itemsRepo' | 'clientsRepo'>, access: ReadAccess) {
  const overview = new Map(deps.itemsRepo.sourcesOverview(access).map((s) => [s.source, s]));
  const visible = (id: string) => access.readSources === null || access.readSources.includes(id);
  const merged = deps.clientsRepo
    .list()
    .filter((c) => visible(c.id))
    .map((c) => {
      const stats = overview.get(c.id);
      overview.delete(c.id);
      return {
        source: c.id,
        name: c.name,
        kind: c.kind,
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
      kind: (stats.kind as 'app' | 'agent' | null) ?? 'app',
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
    return reply.send({ sources: sourcesView(deps, accessFor(req.client!)) });
  });
}
