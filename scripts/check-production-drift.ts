import fs from 'node:fs';
import { parseReleaseManifest } from '../src/ops/release-contract.js';

const healthUrl = process.env.DRIFT_HEALTH_URL?.trim();
const manifestFile = process.env.RELEASE_MANIFEST_FILE?.trim();
if (!healthUrl || !manifestFile) throw new Error('DRIFT_HEALTH_URL and RELEASE_MANIFEST_FILE are required');
const release = parseReleaseManifest(JSON.parse(fs.readFileSync(manifestFile, 'utf8')));
const response = await fetch(healthUrl);
const health = await response.json() as { service?: string; release?: { commit?: string | null; imageDigest?: string | null } };
const matches = response.ok
  && health.service === release.serviceId
  && health.release?.commit === release.commitSha
  && health.release.imageDigest === release.imageDigest;
const evidence = {
  format: 'contexthub-drift/v1',
  status: matches ? 'pass' : 'fail',
  expected_commit: release.commitSha,
  expected_digest: release.imageDigest,
  observed_commit: health.release?.commit ?? null,
  observed_digest: health.release?.imageDigest ?? null,
  checked_at: new Date().toISOString(),
};
console.log(JSON.stringify(evidence));
if (!matches) process.exitCode = 1;
