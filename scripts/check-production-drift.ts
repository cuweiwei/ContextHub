import fs from 'node:fs';
import { parseReleaseManifest } from '../src/ops/release-contract.js';

const healthUrl = process.env.DRIFT_HEALTH_URL?.trim();
const manifestFile = process.env.RELEASE_MANIFEST_FILE?.trim();
if (!healthUrl || !manifestFile) throw new Error('DRIFT_HEALTH_URL and RELEASE_MANIFEST_FILE are required');
const release = parseReleaseManifest(JSON.parse(fs.readFileSync(manifestFile, 'utf8')));
const response = await fetch(healthUrl);
const health = await response.json() as { status?: string; version?: string; build_commit?: string; checks?: { retrieval_projection_ready?: boolean }; image_digest?: string };
const projectionReady = health.checks?.retrieval_projection_ready === true;
const matches = response.ok && health.status === 'ok' && health.version === release.version && health.build_commit === release.commit && projectionReady && (!health.image_digest || health.image_digest === release.digest);
const evidence = { format: 'contexthub-drift/v1', status: matches ? 'pass' : 'fail', expected_version: release.version, expected_commit: release.commit, expected_digest: release.digest, observed_version: health.version ?? null, observed_commit: health.build_commit ?? null, observed_digest: health.image_digest ?? null, projection_ready: projectionReady, checked_at: new Date().toISOString() };
console.log(JSON.stringify(evidence));
if (!matches) process.exitCode = 1;
