import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { parseDeploymentEvidence, parseReleaseManifest } from '../src/ops/release-contract.js';

const commit = 'f'.repeat(40);
const digest = `sha256:${'a'.repeat(64)}`;
const execFileAsync = promisify(execFile);

function release() {
  return {
    schemaVersion: 1, serviceId: 'contexthub', repository: 'cuweiwei/ContextHub', commitSha: commit,
    imageDigest: digest, composePath: 'compose.prod.yml', composeSha256: 'b'.repeat(64),
    deploymentProjectId: 'contexthub', health: { path: '/health' },
  };
}

describe('release and deployment contracts', () => {
  it('accepts a commit-bound immutable release manifest', () => {
    expect(parseReleaseManifest(release()).imageDigest).toBe(digest);
  });

  it('rejects invalid release coordinates and unknown fields', () => {
    expect(() => parseReleaseManifest({ ...release(), imageDigest: 'latest' })).toThrow();
    expect(() => parseReleaseManifest({ ...release(), unexpected: true })).toThrow();
  });

  it('generates the AiHomePlatform contract with the checked-in Compose checksum', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'contexthub-release-'));
    const output = path.join(directory, 'release-manifest.json');
    try {
      await execFileAsync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'scripts/create-release-manifest.ts'], {
        cwd: process.cwd(),
        env: { ...process.env, RELEASE_COMMIT: commit, RELEASE_DIGEST: digest, RELEASE_MANIFEST_OUT: output },
      });
      const generated = parseReleaseManifest(JSON.parse(fs.readFileSync(output, 'utf8')));
      const compose = fs.readFileSync('compose.prod.yml');
      const composeText = compose.toString('utf8');
      const composeSha256 = createHash('sha256').update(compose).digest('hex');
      expect(composeText.match(/@\$\{[A-Z][A-Z0-9_]*(?::[^}]*)?\}/g)).toEqual([
        '@${IMAGE_DIGEST:?IMAGE_DIGEST is required}',
      ]);
      expect(composeText).toContain('AIHP_RELEASE_COMMIT: ${AIHP_RELEASE_COMMIT:-}');
      expect(composeText).toContain('AIHP_IMAGE_DIGEST: ${AIHP_IMAGE_DIGEST:-}');
      expect(generated).toMatchObject({
        schemaVersion: 1,
        serviceId: 'contexthub',
        commitSha: commit,
        imageDigest: digest,
        composeSha256,
        health: { path: '/health' },
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
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
