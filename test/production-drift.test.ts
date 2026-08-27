import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

describe('production drift detector', () => {
  it('passes only when health metadata and release manifest agree', async () => {
    const commit = 'f'.repeat(40); const digest = `sha256:${'a'.repeat(64)}`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contexthub-drift-'));
    const manifestFile = path.join(dir, 'release.json');
    fs.writeFileSync(manifestFile, JSON.stringify({ schemaVersion: 1, serviceId: 'contexthub', repository: 'cuweiwei/ContextHub', commitSha: commit, imageDigest: digest, composePath: 'compose.prod.yml', composeSha256: 'b'.repeat(64), deploymentProjectId: 'contexthub', health: { path: '/health' } }));
    const server = createServer((_req, response) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ service: 'contexthub', release: { commit, imageDigest: digest } })); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('drift server did not bind');
    try {
      const result = await execFileAsync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'scripts/check-production-drift.ts'], { cwd: process.cwd(), env: { ...process.env, DRIFT_HEALTH_URL: `http://127.0.0.1:${address.port}/health/ops`, RELEASE_MANIFEST_FILE: manifestFile }, encoding: 'utf8' });
      expect(result.stdout).toContain('"status":"pass"');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
