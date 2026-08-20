import { ConnectorRestClient } from './sdk.js';
import { mapGitHubObject, type GitHubObjectFixture } from './github.js';
import { runConnectorWorker, type ConnectorPage, type ConnectorWorkerResult } from './worker-runtime.js';
import type { ConnectorWorkerConfig } from './worker-config.js';

export type GitHubResource = 'issues' | 'milestones' | 'releases';

export interface GitHubWorkerOptions extends ConnectorWorkerConfig {
  apiBaseUrl?: string;
  token: string;
  contextHubApiKey: string;
  repositories: string[];
  resources?: GitHubResource[];
  pageSize?: number;
}

function apiError(status: number): Error {
  return new Error(`github_http_${status}`);
}

function resourceKind(resource: GitHubResource, object: GitHubObjectFixture): 'issue' | 'pull_request' | 'milestone' | 'release' {
  if (resource === 'issues' && object.repository === undefined && 'pull_request' in object) return 'pull_request';
  return resource === 'issues' ? 'issue' : resource === 'milestones' ? 'milestone' : 'release';
}

async function fetchGitHubPage(options: GitHubWorkerOptions, repo: string, resource: GitHubResource, cursor: string | null): Promise<ConnectorPage<GitHubObjectFixture>> {
  const page = Number(cursor ?? '1');
  const url = new URL(`${options.apiBaseUrl ?? 'https://api.github.com'}/repos/${repo}/${resource}`);
  url.searchParams.set('state', 'all'); url.searchParams.set('per_page', String(options.pageSize ?? 100)); url.searchParams.set('page', String(page));
  const response = await fetch(url, { headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${options.token}`, 'x-github-api-version': '2022-11-28' } });
  if (!response.ok) throw apiError(response.status);
  const body = await response.json() as GitHubObjectFixture[];
  const items = Array.isArray(body) ? body : [];
  const complete = items.length < (options.pageSize ?? 100);
  return { items, nextCursor: complete ? null : String(page + 1), complete, checkpointValue: String(page) };
}

export async function syncGitHub(options: GitHubWorkerOptions): Promise<ConnectorWorkerResult[]> {
  const client = new ConnectorRestClient(options.contextHubUrl, options.contextHubApiKey);
  const results: ConnectorWorkerResult[] = [];
  for (const repo of options.repositories) {
    for (const resource of options.resources ?? ['issues', 'milestones', 'releases']) {
      const checkpointKey = `github:${repo}:${resource}`;
      const stateKey = `connector.${checkpointKey}`;
      const state = await client.getOperationalState(stateKey).catch(() => ({ value: null, revision: null }));
      results.push(await runConnectorWorker({
        connector: `github:${repo}:${resource}`,
        checkpointKey,
        client,
        initialCursor: typeof state.value === 'string' ? state.value : null,
        fetchPage: (cursor) => fetchGitHubPage(options, repo, resource, cursor),
        map: (object) => mapGitHubObject(resourceKind(resource, object), object, repo),
        loadCheckpoint: async () => typeof state.value === 'string' ? state.value : null,
        saveCheckpoint: async (value) => {
          await client.putOperationalState(stateKey, { cursor: value }, options.checkpointSchemaId, typeof state.revision === 'number' ? state.revision : null, `github:checkpoint:${repo}:${resource}:${value ?? 'initial'}`);
        },
      }));
    }
  }
  return results;
}
