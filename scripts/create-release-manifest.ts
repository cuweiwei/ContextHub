import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { parseReleaseManifest } from '../src/ops/release-contract.js';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const composePath = 'compose.prod.yml';
const manifest = parseReleaseManifest({
  schemaVersion: 1,
  serviceId: 'contexthub',
  repository: 'cuweiwei/ContextHub',
  commitSha: required('RELEASE_COMMIT'),
  imageDigest: required('RELEASE_DIGEST'),
  composePath,
  composeSha256: createHash('sha256').update(fs.readFileSync(composePath)).digest('hex'),
  deploymentProjectId: 'contexthub',
  health: { path: '/health' },
});

const out = process.env.RELEASE_MANIFEST_OUT?.trim() || 'artifacts/release-manifest.json';
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o644 });
console.log(`release manifest written: ${out}`);
