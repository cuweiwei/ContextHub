import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../server.js';
import { buildInfo } from '../../build-info.js';

const MIN_FREE_BYTES = 1_073_741_824;

/**
 * Unauthenticated liveness + degradation surface. Reports whether the audit
 * log is writable (the system fails closed when it is not — reads return 503)
 * and how much disk the data volume has left, so NAS monitoring can alert
 * BEFORE fail-closed kicks in.
 */
export function registerHealthRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get('/health', async (_req, reply) => {
    const auditWritable = deps.auditRepo.writable();
    let diskStatus: 'ok' | 'low' | 'unknown' = 'unknown';
    try {
      const stat = fs.statfsSync(deps.config.dataDir);
      const diskFreeBytes = stat.bavail * stat.bsize;
      diskStatus = diskFreeBytes >= MIN_FREE_BYTES ? 'ok' : 'low';
    } catch {
      diskStatus = 'unknown';
    }
    const schemaRow = deps.db
      .prepare('SELECT MAX(version) AS version, COUNT(*) AS count FROM schema_migrations')
      .get() as { version: number | null; count: number };
    const migrationsCurrent = schemaRow.version === buildInfo.schema_version && schemaRow.count === buildInfo.schema_version;
    const retrievalProjection = deps.itemsRepo.retrievalProjectionStatus();
    const degraded = !auditWritable || !migrationsCurrent || !retrievalProjection.ready || diskStatus !== 'ok';
    return reply.header('Cache-Control', 'no-store').code(degraded ? 503 : 200).send({
      status: degraded ? 'degraded' : 'ok',
      service: 'contexthub',
      version: buildInfo.version,
      build_commit: buildInfo.build_commit,
      schema_version: buildInfo.schema_version,
      retrieval_model: buildInfo.retrieval_model,
      audit_writable: auditWritable,
      checks: {
        audit_writable: auditWritable,
        migrations_current: migrationsCurrent,
        retrieval_projection_ready: retrievalProjection.ready,
        disk: diskStatus,
      },
    });
  });
}
