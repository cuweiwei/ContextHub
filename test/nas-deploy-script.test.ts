import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const repo = process.cwd();
const script = path.join(repo, 'scripts/nas-deploy.sh');
const execFileAsync = promisify(execFile);

async function withHealth<T>(callback: (port: number) => T | Promise<T>): Promise<T> {
  const server = createServer((_req, response) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"status":"ok"}'); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('health server did not bind');
  try { return await callback(address.port); } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}

function appDir(port: number, bind = '127.0.0.1'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contexthub-deploy-test-'));
  fs.mkdirSync(path.join(dir, 'data'));
  fs.writeFileSync(path.join(dir, '.env'), `CONTEXTHUB_BIND_ADDRESS=${bind}\nCONTEXTHUB_HOST_PORT=${port}\n`);
  fs.writeFileSync(path.join(dir, 'docker-compose.yml'), 'services: {}\n');
  fs.writeFileSync(path.join(dir, 'data/contexthub.db'), 'fixture');
  return dir;
}

describe('NAS deployment contract', () => {
  it('preflight is read-only and supports immutable digest input without Docker', async () => {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    const version = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version as string;
    await withHealth(async (port) => {
      const app = appDir(port); const before = fs.readdirSync(app, { recursive: true }).sort().join('\n');
      const digest = `ghcr.io/cuweiwei/contexthub@sha256:${'a'.repeat(64)}`;
      const output = await execFileAsync('bash', [script, '--source-dir', repo, '--app-dir', app, '--image', digest, '--expected-commit', commit, '--expected-version', version, '--workflow-url', `https://github.com/cuweiwei/ContextHub/actions/runs/123`, '--preflight-only'], { encoding: 'utf8' });
      expect(output.stdout).toContain('PREFLIGHT PASS');
      expect(fs.readdirSync(app, { recursive: true }).sort().join('\n')).toBe(before);
      fs.rmSync(app, { recursive: true, force: true });
    });
  });

  it('rejects a public bind before any deployment work', async () => {
    await withHealth(async (port) => {
      const app = appDir(port, '0.0.0.0');
      await expect(execFileAsync('bash', [script, '--source-dir', repo, '--app-dir', app, '--ref', 'HEAD', '--no-fetch', '--preflight-only'], { encoding: 'utf8' })).rejects.toThrow(/CONTEXTHUB_BIND_ADDRESS/);
      fs.rmSync(app, { recursive: true, force: true });
    });
  });

  it('rejects mutable tags and malformed digest labels before health or Docker access', async () => {
    const app = appDir(8788);
    await expect(execFileAsync('bash', [script, '--source-dir', repo, '--app-dir', app, '--image', 'ghcr.io/cuweiwei/contexthub:latest', '--expected-commit', 'f'.repeat(40), '--expected-version', '0.9.0', '--workflow-url', 'https://github.com/cuweiwei/ContextHub/actions/runs/123', '--preflight-only'], { encoding: 'utf8' })).rejects.toThrow(/immutable|digest/);
    fs.rmSync(app, { recursive: true, force: true });
  });
});
