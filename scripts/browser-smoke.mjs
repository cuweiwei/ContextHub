import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from '@playwright/test';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'contexthub-browser-'));
const port = 8897;
const child = spawn(process.execPath, ['dist/index.js'], {
  cwd: process.cwd(),
  env: { ...process.env, DATA_DIR: dataDir, PORT: String(port), HOST: '127.0.0.1', LOG_LEVEL: 'fatal' },
  stdio: 'ignore',
});
try {
  for (let i = 0; i < 40; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) break;
    } catch { /* server is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ javaScriptEnabled: true });
  const response = await page.goto(`http://127.0.0.1:${port}/health`);
  if (!response || !response.ok()) throw new Error(`health page returned ${response?.status()}`);
  const body = await response.json();
  if (body.version !== '0.9.0' || body.build_commit !== 'unknown') throw new Error('build metadata mismatch');
  await browser.close();
  console.log('Playwright browser smoke: pass');
} finally {
  child.kill('SIGTERM');
  await fs.rm(dataDir, { recursive: true, force: true });
}
