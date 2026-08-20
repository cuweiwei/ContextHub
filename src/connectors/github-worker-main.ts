import fs from 'node:fs';
import { syncGitHub, type GitHubResource } from './github-worker.js';
import { read0600Secret, readWorkerConfig } from './worker-config.js';

const configPath = process.env.GITHUB_CONNECTOR_CONFIG_FILE ?? '/etc/contexthub/connectors/github.json';
const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as { repositories?: string[]; resources?: GitHubResource[]; api_base_url?: string; page_size?: number };
const base = readWorkerConfig(configPath);
const repositories = config.repositories ?? [];
if (repositories.length === 0 || repositories.some((repo) => !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo))) throw new Error('GitHub connector repositories must be explicit owner/repository allowlist entries');
const results = await syncGitHub({
  ...base,
  contextHubApiKey: read0600Secret(base.contextHubKeyFile),
  token: read0600Secret(process.env.GITHUB_CONNECTOR_TOKEN_FILE ?? '/run/secrets/github-token'),
  repositories,
  resources: config.resources,
  apiBaseUrl: config.api_base_url,
  pageSize: config.page_size,
});
console.log(JSON.stringify({ connector: 'github', results: results.map(({ connector, status, pages, items, checkpointValue, error_code }) => ({ connector, status, pages, items, checkpointValue, error_code })) }));
if (results.some((result) => result.status === 'failed')) process.exitCode = 1;
