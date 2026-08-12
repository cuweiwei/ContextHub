import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../server.js';

/**
 * Unauthenticated liveness + degradation surface. Reports whether the audit
 * log is writable (the system fails closed when it is not — reads return 503)
 * and how much disk the data volume has left, so NAS monitoring can alert
 * BEFORE fail-closed kicks in.
 */
export function registerHealthRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get('/health', async (_req, reply) => {
    const auditWritable = deps.auditRepo.writable();
    let diskFreeBytes: number | null = null;
    try {
      const stat = fs.statfsSync(deps.config.dataDir);
      diskFreeBytes = stat.bavail * stat.bsize;
    } catch {
      diskFreeBytes = null;
    }
    const degraded = !auditWritable;
    const retrievalProjection = deps.itemsRepo.retrievalProjectionStatus();
    return reply.code(degraded ? 503 : 200).send({
      status: degraded ? 'degraded' : 'ok',
      service: 'contexthub',
      audit_writable: auditWritable,
      disk_free_bytes: diskFreeBytes,
      retrieval_projection: retrievalProjection,
    });
  });
}
