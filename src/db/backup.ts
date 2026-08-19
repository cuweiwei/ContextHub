import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import packageJson from '../../package.json' with { type: 'json' };

export interface PreMigrationManifest {
  format: 'contexthub-backup-manifest/v1';
  backup_id: string;
  kind: 'pre_migration';
  created_at: string;
  database: { file: string; bytes: number; sha256: string };
  runtime: { version: string; build_commit: string; schema_version: number; retrieval_model: string };
  target_schema_version: number;
  verification: { quick_check: 'ok' };
}

function sha256(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** Writes a pre-migration snapshot and its metadata atomically. */
export function writePreMigrationSnapshot(db: Database.Database, outDir: string, targetSchemaVersion: number): PreMigrationManifest {
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = `pre-migration-v${targetSchemaVersion}-${stamp}`;
  const destination = path.join(outDir, `${base}.db`);
  const temp = path.join(outDir, `.${base}.${process.pid}.${randomUUID()}.tmp.db`);
  db.prepare('VACUUM INTO ?').run(temp);
  fs.renameSync(temp, destination);
  const probe = new Database(destination, { readonly: true, fileMustExist: true });
  try {
    const quick = probe.prepare('PRAGMA quick_check').get() as { quick_check: string };
    if (quick.quick_check !== 'ok') throw new Error('pre-migration snapshot quick_check failed');
  } finally {
    probe.close();
  }
  const manifest: PreMigrationManifest = {
    format: 'contexthub-backup-manifest/v1',
    backup_id: `bkp_${randomUUID()}`,
    kind: 'pre_migration',
    created_at: new Date().toISOString(),
    database: { file: path.basename(destination), bytes: fs.statSync(destination).size, sha256: sha256(destination) },
    runtime: {
      version: packageJson.version,
      build_commit: process.env.CONTEXTHUB_BUILD_COMMIT?.trim() || 'unknown',
      schema_version: targetSchemaVersion - 1,
      retrieval_model: 'local-feature-hash-v1',
    },
    target_schema_version: targetSchemaVersion,
    verification: { quick_check: 'ok' },
  };
  // Keep the snapshot filename discoverable by legacy restore tooling while
  // hiding the sidecar from glob patterns that enumerate snapshot files.
  const manifestFile = path.join(outDir, `.${base}.manifest.json`);
  const manifestTemp = `${manifestFile}.tmp-${process.pid}-${randomUUID()}`;
  fs.writeFileSync(manifestTemp, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(manifestTemp, manifestFile);
  return manifest;
}
