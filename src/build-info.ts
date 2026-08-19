import packageJson from '../package.json' with { type: 'json' };
import { LATEST_SCHEMA_VERSION } from './db/migrations.js';

export interface BuildInfo {
  version: string;
  build_commit: string;
  schema_version: number;
  retrieval_model: string;
}

const commit = process.env.CONTEXTHUB_BUILD_COMMIT?.trim();

/** Runtime identity shared by health, settings, MCP and maintenance tooling. */
export const buildInfo: BuildInfo = {
  version: packageJson.version,
  build_commit: commit && /^[0-9a-f]{7,40}$/i.test(commit) ? commit : 'unknown',
  schema_version: LATEST_SCHEMA_VERSION,
  retrieval_model: 'local-feature-hash-v1',
};
