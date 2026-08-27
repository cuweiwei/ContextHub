import { z } from 'zod';

const sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const commit = z.string().regex(/^[0-9a-f]{40}$/);
const semver = z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/);

export const releaseManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    serviceId: z.literal('contexthub'),
    repository: z.literal('cuweiwei/ContextHub'),
    commitSha: commit,
    imageDigest: sha256,
    composePath: z.literal('compose.prod.yml'),
    composeSha256: z.string().regex(/^[0-9a-f]{64}$/),
    deploymentProjectId: z.literal('contexthub'),
    health: z.object({ path: z.literal('/health') }).strict(),
  })
  .strict();

export type ReleaseManifestV1 = z.infer<typeof releaseManifestSchema>;

const status = z.enum(['candidate', 'verified', 'failed', 'rolled_back']);

export const deploymentEvidenceSchema = z
  .object({
    format: z.literal('contexthub-deployment/v1'),
    status,
    environment: z.literal('production'),
    repository: z.literal('cuweiwei/ContextHub'),
    version: semver,
    commit,
    image: z.string().regex(/^ghcr\.io\/cuweiwei\/contexthub@sha256:[0-9a-f]{64}$/),
    digest: sha256,
    workflow_url: z.string().regex(/^https:\/\/github\.com\/cuweiwei\/ContextHub\/actions\/runs\/[0-9]+$/),
    backup_manifest: z.string().regex(/^contexthub-[A-Za-z0-9_.-]+\.manifest\.json$/),
    schema_version: z.number().int().positive(),
    retrieval_model: z.string().min(1).max(100),
    health: z.object({
      status: z.enum(['ok', 'degraded']),
      version: semver,
      build_commit: z.string().regex(/^[0-9a-f]{7,40}$/),
      audit_writable: z.boolean(),
      projection_ready: z.boolean(),
    }).strict(),
    restore_drill: z.object({ status: z.enum(['pass', 'fail']) }).strict(),
    doctor: z.object({ status: z.enum(['pass', 'warn', 'fail']) }).strict(),
    rollback_image: z.string().min(1).max(200),
    completed_at: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.image !== `ghcr.io/cuweiwei/contexthub@${value.digest}`) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['image'], message: 'image must contain the same digest as digest' });
    }
    if (value.health.version !== value.version) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['health', 'version'], message: 'health version does not match deployment version' });
    }
    if (!value.health.build_commit.startsWith(value.commit.slice(0, 7))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['health', 'build_commit'], message: 'health build commit does not match deployment commit' });
    }
  });

export type DeploymentEvidenceV1 = z.infer<typeof deploymentEvidenceSchema>;

export function parseReleaseManifest(value: unknown): ReleaseManifestV1 {
  return releaseManifestSchema.parse(value);
}

export function parseDeploymentEvidence(value: unknown): DeploymentEvidenceV1 {
  return deploymentEvidenceSchema.parse(value);
}
