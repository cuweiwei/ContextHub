import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { chromium } from '@playwright/test';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'contexthub-browser-'));
const port = await new Promise((resolve, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (!address || typeof address === 'string') return reject(new Error('unable to allocate browser test port'));
    server.close((error) => error ? reject(error) : resolve(address.port));
  });
});
const testEnv = {
  ...process.env,
  DATA_DIR: dataDir,
  PORT: String(port),
  HOST: '127.0.0.1',
  LOG_LEVEL: 'fatal',
  SQLITE_SYNCHRONOUS: 'NORMAL',
  CONTROL_CENTER_ENABLED: 'true',
  CONTROL_CENTER_TAILSCALE_AUTH_ENABLED: 'true',
  CONTROL_CENTER_TRUSTED_PROXY: 'true',
  CONTROL_CENTER_CANONICAL_ORIGIN: `https://localhost:${port}`,
};

function cli(args) {
  const result = spawnSync(process.execPath, ['dist/cli.js', ...args], { cwd: process.cwd(), env: testEnv, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`browser fixture setup failed: ${result.stderr || result.stdout}`);
}

cli(['create-client', '--id', 'browser-reviewer', '--name', 'Browser Reviewer', '--namespace', 'personal', '--principal-kind', 'human', '--profile', 'reviewer', '--scopes', 'read,review_insight']);
cli(['web-principal-add', '--provider', 'tailscale', '--subject', 'browser@example.test', '--name', 'Browser Owner', '--control-admin']);
cli(['web-principal-link', '--subject', 'browser@example.test', '--client', 'browser-reviewer']);
cli(['seed-demo']);

const child = spawn(process.execPath, ['dist/index.js'], {
  cwd: process.cwd(),
  env: testEnv,
  stdio: 'ignore',
});
let browser;
try {
  let ready = false;
  for (let i = 0; i < 40; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) { ready = true; break; }
    } catch { /* server is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!ready) throw new Error('server did not become ready');
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    javaScriptEnabled: true,
    extraHTTPHeaders: {
      'x-forwarded-proto': 'https',
      'tailscale-user-login': 'browser@example.test',
      'tailscale-user-name': 'Browser Owner',
    },
  });
  const page = await context.newPage();
  const response = await page.goto(`http://127.0.0.1:${port}/health`);
  if (!response || !response.ok()) throw new Error(`health page returned ${response?.status()}`);
  const body = await response.json();
  if (body.version !== '0.9.0' || body.build_commit !== 'unknown' || body.schema_version !== 17) throw new Error('build metadata mismatch');

  await page.goto(`http://localhost:${port}/dashboard`);
  await page.waitForSelector('.app-shell');
  await page.waitForFunction(() => document.body.textContent?.includes('ContextHub'));
  const me = await page.evaluate(async () => {
    const res = await fetch('/v1/control/me');
    return { status: res.status, body: await res.json() };
  });
  if (me.status !== 200 || me.body.principal?.subject !== 'browser@example.test' || !me.body.csrf_token) throw new Error('authenticated Control Center session failed');

  await page.goto(`http://localhost:${port}/memories`);
  await page.waitForFunction(() => document.body.textContent?.includes('記憶庫'));
  await page.waitForSelector('.data-table tbody tr');
  const apiFailures = [];
  page.on('response', (res) => {
    if (res.url().includes('/v1/control/') && !res.url().endsWith('/v1/control/maintenance') && res.status() >= 500) apiFailures.push(`${res.status()} ${res.url()}`);
  });
  await page.goto(`http://localhost:${port}/settings`);
  await page.waitForFunction(() => document.body.textContent?.includes('安全與維運'));
  if (apiFailures.length) throw new Error(`Control Center API failures: ${apiFailures.join(', ')}`);
  console.log('Playwright Control Center login/navigation/API smoke: pass');
} finally {
  await browser?.close();
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
  await fs.rm(dataDir, { recursive: true, force: true });
}
