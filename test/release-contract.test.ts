import { describe, expect, it } from 'vitest';
import { parseDeploymentEvidence, parseReleaseManifest } from '../src/ops/release-contract.js';

const commit = 'f'.repeat(40);
const digest = `sha256:${'a'.repeat(64)}`;

function release() {
  return {
    format: 'contexthub-release/v1', repository: 'cuweiwei/ContextHub', ref: 'refs/heads/main', version: '0.9.0', commit,
    image: `ghcr.io/cuweiwei/contexthub@${digest}`, digest, ci_run_id: '123', ci_run_url: 'https://github.com/cuweiwei/ContextHub/actions/runs/123',
    sbom_artifact: 'contexthub-sbom-123', provenance_subject: `cuweiwei/ContextHub@${commit}`, deploy_contract_version: 1,
    created_at: '2026-08-20T00:00:00.000Z',
  };
}

describe('release and deployment contracts', () => {
  it('accepts a commit-bound immutable release manifest', () => {
    expect(parseReleaseManifest(release()).digest).toBe(digest);
  });

  it('rejects an image/digest mismatch and unknown fields', () => {
    expect(() => parseReleaseManifest({ ...release(), image: 'ghcr.io/cuwewei/ContextHub@sha256:' + 'b'.repeat(64) })).toThrow();
    expect(() => parseReleaseManifest({ ...release(), unexpected: true })).toThrow();
  });

  it('accepts metadata-only verified deployment evidence', () => {
    const evidence = {
      format: 'contexthub-deployment/v1', status: 'verified', environment: 'production', repository: 'cuweiwei/ContextHub', version: '0.9.0', commit,
      image: `ghcr.io/cuweiwei/contexthub@${digest}`, digest, workflow_url: 'https://github.com/cuweiwei/ContextHub/actions/runs/123',
      backup_manifest: 'contexthub-20260820T000000Z.manifest.json', schema_version: 14, retrieval_model: 'local-feature-hash-v1',
      health: { status: 'ok', version: '0.9.0', build_commit: commit, audit_writable: true, projection_ready: true },
      restore_drill: { status: 'pass' }, doctor: { status: 'pass' }, rollback_image: 'contexthub:rollback-20260820', completed_at: '2026-08-20T00:01:00.000Z',
    };
    expect(parseDeploymentEvidence(evidence).status).toBe('verified');
  });
});
