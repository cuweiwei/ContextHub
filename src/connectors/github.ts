import type { ConnectorItem } from './sdk.js';

export interface GitHubObjectFixture { id: number; node_id?: string; html_url?: string; title?: string; name?: string; number?: number; state?: string; updated_at?: string; archived?: boolean; repository?: { id?: number; full_name?: string }; }

/** GitHub projection mapper. Body/comment/diff/patch/assets are never copied. */
export function mapGitHubObject(kind: 'issue' | 'pull_request' | 'milestone' | 'release' | 'project', object: GitHubObjectFixture, repo: string): ConnectorItem {
  const stable = object.node_id ?? `${repo}:${kind}:${object.id}`;
  return { type: `github_${kind}`, title: object.title ?? object.name ?? `${kind} ${object.number ?? object.id}`, content: '', data: { repository: repo, state: object.state ?? null, updated: object.updated_at ?? null, archived: object.archived ?? false }, source_item_id: stable, source_uri: object.html_url, idempotency_key: `github:${stable}:${object.updated_at ?? ''}` };
}

export function classifyGitHubFailure(status: number): 'tombstone' | 'stale' | 'retry' { return status === 403 || status === 404 ? 'tombstone' : status >= 500 ? 'stale' : 'retry'; }
