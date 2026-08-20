import fs from 'node:fs';
import path from 'node:path';
import { parseReleaseManifest } from '../src/ops/release-contract.js';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const digest = required('RELEASE_DIGEST');
const manifest = parseReleaseManifest({
  format: 'contexthub-release/v1',
  repository: 'cuweiwei/ContextHub',
  ref: 'refs/heads/main',
  version: required('RELEASE_VERSION'),
  commit: required('RELEASE_COMMIT'),
  image: `ghcr.io/cuweiwei/contexthub@${digest}`,
  digest,
  ci_run_id: required('CI_RUN_ID'),
  ci_run_url: required('CI_RUN_URL'),
  sbom_artifact: required('SBOM_ARTIFACT'),
  provenance_subject: `cuweiwei/ContextHub@${required('RELEASE_COMMIT')}`,
  deploy_contract_version: 1,
  created_at: new Date().toISOString(),
});

const out = process.env.RELEASE_MANIFEST_OUT?.trim() || 'artifacts/release-manifest.json';
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o644 });
console.log(`release manifest written: ${out}`);
