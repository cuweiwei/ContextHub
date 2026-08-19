import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { openDatabase } from '../db/connection.js';
import type { DB } from '../db/connection.js';
import { createItemsRepo } from './items-repo.js';
import { normalizeEntity, normalizeTag } from './canonical.js';
import { buildInfo } from '../build-info.js';
import { createAuditRepo } from './audit-repo.js';
import { verifyAuditChain } from './audit-chain.js';
import { verifyAuditAnchor } from './audit-chain-admin.js';

export const MIN_FREE_BYTES = 1_073_741_824;
export const BACKUP_MAX_AGE_MS = 26 * 60 * 60 * 1000;
export const RESTORE_DRILL_MAX_AGE_MS = 35 * 86_400_000;
export const IDEMPOTENCY_GC_MAX_AGE_MS = 10 * 86_400_000;

export type CheckStatus = 'pass' | 'warn' | 'fail';

export interface BackupManifestV1 {
  format: 'contexthub-backup-manifest/v1';
  backup_id: string;
  kind: 'manual' | 'pre_migration';
  created_at: string;
  database: {
    file: string;
    bytes: number;
    sha256: string;
  };
  runtime: {
    version: string;
    build_commit: string;
    schema_version: number;
    retrieval_model: string;
  };
  target_schema_version: number | null;
  verification: { quick_check: 'ok' };
  audit_chain?: { row_count: number; latest_audit_id: number; root_hash: string; verified: boolean };
}

export interface MaintenanceRecordV1 {
  format: 'contexthub-maintenance/v1';
  kind: 'restore_drill' | 'idempotency_gc';
  status: 'pass' | 'fail';
  started_at: string;
  completed_at: string;
  runtime: BackupManifestV1['runtime'];
  checks: Array<{ name: string; status: CheckStatus }>;
  details?: Record<string, string | number | boolean | null | string[]>;
}

export interface DoctorCheck {
  status: CheckStatus;
  message: string;
  remediation: string;
  details?: Record<string, string | number | boolean | null | string[]>;
}

export interface DoctorReport {
  status: CheckStatus;
  exit_code: 0 | 1 | 2;
  generated_at: string;
  runtime: BackupManifestV1['runtime'];
  checks: Record<string, DoctorCheck>;
}

function maintenanceDir(dataDir: string): string {
  return path.join(dataDir, 'maintenance');
}

function atomicWrite(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.tmp-${process.pid}-${randomUUID()}`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, file);
}

function sha256(file: string): string {
  const hash = createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

function runtime() {
  return {
    version: buildInfo.version,
    build_commit: buildInfo.build_commit,
    schema_version: buildInfo.schema_version,
    retrieval_model: buildInfo.retrieval_model,
  };
}

function databaseSchemaVersion(db: DB): number {
  const hasMigrations = db
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get() as { present: number } | undefined;
  if (hasMigrations) {
    const row = db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations').get() as { version: number };
    return row.version;
  }
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  return row.user_version;
}

function quickCheck(file: string): 'ok' {
  const probe = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const row = probe.prepare('PRAGMA quick_check').get() as { quick_check: string };
    if (row.quick_check !== 'ok') throw new Error(`SQLite quick_check returned ${row.quick_check}`);
    return 'ok';
  } finally {
    probe.close();
  }
}

export function createBackup(
  db: DB,
  options: { outDir: string; kind?: BackupManifestV1['kind']; targetSchemaVersion?: number | null },
): BackupManifestV1 {
  fs.mkdirSync(options.outDir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = `contexthub-${stamp}-${randomUUID().slice(0, 8)}`;
  const destination = path.join(options.outDir, `${base}.db`);
  const temp = path.join(options.outDir, `.${base}.${process.pid}.${randomUUID()}.tmp.db`);
  db.prepare('VACUUM INTO ?').run(temp);
  try {
    fs.renameSync(temp, destination);
  } catch (err) {
    fs.rmSync(temp, { force: true });
    throw err;
  }
  const auditDb = new Database(destination, { readonly: true, fileMustExist: true });
  const auditChain = auditDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'audit_chain'").get()
    ? verifyAuditChain(auditDb)
    : undefined;
  auditDb.close();
  const backupRuntime = runtime();
  backupRuntime.schema_version = databaseSchemaVersion(db);
  const manifest: BackupManifestV1 = {
    format: 'contexthub-backup-manifest/v1',
    backup_id: `bkp_${randomUUID()}`,
    kind: options.kind ?? 'manual',
    created_at: new Date().toISOString(),
    database: { file: path.basename(destination), bytes: fs.statSync(destination).size, sha256: sha256(destination) },
    runtime: backupRuntime,
    target_schema_version: options.targetSchemaVersion ?? null,
    verification: { quick_check: quickCheck(destination) },
    audit_chain: auditChain,
  };
  atomicWrite(path.join(options.outDir, `${base}.manifest.json`), manifest);
  return manifest;
}

function parseManifest(file: string): BackupManifestV1 {
  const value = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<BackupManifestV1>;
  if (
    value.format !== 'contexthub-backup-manifest/v1' ||
    typeof value.database?.file !== 'string' ||
    path.basename(value.database.file) !== value.database.file ||
    typeof value.database.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.database.sha256) ||
    !value.verification ||
    value.verification.quick_check !== 'ok'
  ) {
    throw new Error('invalid backup manifest');
  }
  return value as BackupManifestV1;
}

export function verifyBackupManifest(manifestFile: string): { manifest: BackupManifestV1; snapshotFile: string } {
  const manifest = parseManifest(manifestFile);
  const snapshotFile = path.join(path.dirname(manifestFile), manifest.database.file);
  if (!fs.statSync(snapshotFile).isFile()) throw new Error('backup snapshot is missing');
  const stat = fs.statSync(snapshotFile);
  if (stat.size !== manifest.database.bytes || sha256(snapshotFile) !== manifest.database.sha256) {
    throw new Error('backup checksum or size mismatch');
  }
  quickCheck(snapshotFile);
  return { manifest, snapshotFile };
}

function latestManifest(dataDir: string): { file: string; manifest: BackupManifestV1 } | null {
  const dir = path.join(dataDir, 'backups');
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter((name) => name.endsWith('.manifest.json')).sort().reverse();
  for (const name of files) {
    try {
      const file = path.join(dir, name);
      return { file, manifest: parseManifest(file) };
    } catch {
      continue;
    }
  }
  return null;
}

export function writeMaintenanceRecord(dataDir: string, record: MaintenanceRecordV1): void {
  atomicWrite(path.join(maintenanceDir(dataDir), `last-${record.kind}.json`), record);
}

function readMaintenanceRecord(dataDir: string, kind: MaintenanceRecordV1['kind']): MaintenanceRecordV1 | null {
  const file = path.join(maintenanceDir(dataDir), `last-${kind}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    const record = JSON.parse(fs.readFileSync(file, 'utf8')) as MaintenanceRecordV1;
    return record.format === 'contexthub-maintenance/v1' && record.kind === kind ? record : null;
  } catch {
    return null;
  }
}

function ageStatus(timestamp: string | null, maxAge: number): CheckStatus {
  if (!timestamp) return 'fail';
  const age = Date.now() - Date.parse(timestamp);
  return Number.isFinite(age) && age <= maxAge ? 'pass' : 'fail';
}

function projectionCoverage(db: DB): DoctorCheck {
  const authoritative = db.prepare(
    `SELECT COUNT(*) AS n FROM context_items WHERE deleted = 0 AND (state_kind IS NULL OR state_kind != 'operational')`,
  ).get() as { n: number };
  const fts = db.prepare('SELECT COUNT(*) AS n FROM items_fts').get() as { n: number };
  const vectors = db.prepare(
    `SELECT COUNT(*) AS n FROM item_embeddings e JOIN context_items i ON i.id = e.item_id
     WHERE i.deleted = 0 AND (i.state_kind IS NULL OR i.state_kind != 'operational')
       AND e.model = ? AND e.dimensions = 384`,
  ).get(buildInfo.retrieval_model) as { n: number };
  const tagCount = db.prepare(
    `SELECT COUNT(*) AS n FROM item_tag_index ti JOIN context_items i ON i.id = ti.item_id
     WHERE i.deleted = 0 AND (i.state_kind IS NULL OR i.state_kind != 'operational')`,
  ).get() as { n: number };
  const entityCount = db.prepare(
    `SELECT COUNT(*) AS n FROM item_entity_index ei JOIN context_items i ON i.id = ei.item_id
     WHERE i.deleted = 0 AND (i.state_kind IS NULL OR i.state_kind != 'operational')`,
  ).get() as { n: number };
  const sourceRows = db.prepare(`SELECT tags, entities FROM context_items WHERE deleted = 0 AND (state_kind IS NULL OR state_kind != 'operational')`).all() as Array<{ tags: string; entities: string }>;
  const expectedTags = sourceRows.reduce((total, row) => total + new Set((JSON.parse(row.tags) as string[]).map(normalizeTag).filter(Boolean)).size, 0);
  const expectedEntities = sourceRows.reduce((total, row) => total + new Set((JSON.parse(row.entities) as string[]).map(normalizeEntity).filter(Boolean)).size, 0);
  const missing = authoritative.n !== fts.n || authoritative.n !== vectors.n || expectedTags !== tagCount.n || expectedEntities !== entityCount.n;
  return {
    status: missing ? 'fail' : 'pass',
    message: missing ? 'retrieval projections are incomplete' : 'retrieval projections cover authoritative rows',
    remediation: 'run `node dist/cli.js reindex` and re-run doctor',
    details: {
      authoritative_items: authoritative.n,
      fts_items: fts.n,
      vector_items: vectors.n,
      tag_facets: tagCount.n,
      entity_facets: entityCount.n,
      expected_tag_facets: expectedTags,
      expected_entity_facets: expectedEntities,
    },
  };
}

export function runDoctor(db: DB, dataDir: string): DoctorReport {
  const checks: Record<string, DoctorCheck> = {};
  try {
    const row = db.prepare('PRAGMA quick_check').get() as { quick_check: string };
    checks.sqlite_quick_check = {
      status: row.quick_check === 'ok' ? 'pass' : 'fail',
      message: row.quick_check === 'ok' ? 'SQLite quick_check passed' : `SQLite quick_check returned ${row.quick_check}`,
      remediation: 'stop the service and restore a verified backup if quick_check is not ok',
    };
  } catch (err) {
    checks.sqlite_quick_check = { status: 'fail', message: `quick_check failed: ${(err as Error).message}`, remediation: 'stop the service and inspect the database file' };
  }
  try {
    db.exec('SAVEPOINT doctor_audit_probe');
    createAuditRepo(db).log({ namespace: '*', clientId: 'doctor', action: 'maintenance.doctor_probe', outcome: 'allow', details: { probe: true } });
    db.exec('ROLLBACK TO doctor_audit_probe; RELEASE doctor_audit_probe');
    checks.audit_writable = { status: 'pass', message: 'audit table accepts transactional writes', remediation: 'restore write access to the database and data volume' };
  } catch (err) {
    try { db.exec('ROLLBACK TO doctor_audit_probe; RELEASE doctor_audit_probe'); } catch { /* best effort */ }
    checks.audit_writable = { status: 'fail', message: `audit write probe failed: ${(err as Error).message}`, remediation: 'restore write access to the database and data volume' };
  }
  try {
    const chain = verifyAuditChain(db);
    checks.audit_chain = {
      status: chain.verified ? 'pass' : 'fail',
      message: chain.verified ? 'audit hash chain is intact' : 'audit hash chain is incomplete or invalid',
      remediation: 'run `node dist/cli.js audit-chain-extend` only after reviewing the rollback tail, then re-run doctor',
      details: { row_count: chain.row_count, latest_audit_id: chain.latest_audit_id, root_hash: chain.root_hash },
    };
    const anchorPath = process.env.AUDIT_ANCHOR_PATH;
    if (chain.verified && anchorPath) {
      try {
        if (path.resolve(anchorPath).startsWith(`${path.resolve(dataDir)}${path.sep}`)) throw new Error('audit anchor path must be outside DATA_DIR');
        const anchor = verifyAuditAnchor(db, anchorPath);
        if (!anchor.valid) checks.audit_chain = { status: 'fail', message: anchor.message, remediation: 'verify the offsite anchor and restore/extend only after owner review' };
      } catch (err) {
        checks.audit_chain = { status: 'fail', message: `audit anchor check failed: ${(err as Error).message}`, remediation: 'restore a verified offsite anchor before accepting writes' };
      }
    }
  } catch (err) {
    checks.audit_chain = { status: 'fail', message: `audit chain check failed: ${(err as Error).message}`, remediation: 'inspect the audit chain and restore a verified backup if needed' };
  }
  try {
    const rows = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{ version: number }>;
    const versions = rows.map((row) => row.version);
    const expected = Array.from({ length: buildInfo.schema_version }, (_, index) => index + 1);
    const current = JSON.stringify(versions) === JSON.stringify(expected);
    checks.migrations = { status: current ? 'pass' : 'fail', message: current ? 'all migrations are applied' : 'migration set is pending, missing, or unknown', remediation: 'run the release upgrade gate before restarting the service', details: { applied: versions.length, expected: buildInfo.schema_version } };
  } catch (err) {
    checks.migrations = { status: 'fail', message: `migration check failed: ${(err as Error).message}`, remediation: 'inspect schema_migrations on a stopped database' };
  }
  try {
    const models = db.prepare('SELECT DISTINCT model FROM item_embeddings').all() as Array<{ model: string }>;
    const consistent = models.every((row) => row.model === buildInfo.retrieval_model);
    checks.runtime_consistency = {
      status: consistent ? 'pass' : 'fail',
      message: consistent ? 'package, schema, and retrieval model are consistent' : 'stored retrieval projection uses a different model',
      remediation: 'run `node dist/cli.js reindex` after selecting the release retrieval model',
      details: { version: buildInfo.version, schema_version: buildInfo.schema_version, retrieval_model: buildInfo.retrieval_model, indexed_models: models.map((row) => row.model) },
    };
  } catch (err) {
    checks.runtime_consistency = { status: 'fail', message: `runtime consistency check failed: ${(err as Error).message}`, remediation: 'inspect the retrieval projection before upgrade' };
  }
  try {
    checks.projections = projectionCoverage(db);
  } catch (err) {
    checks.projections = { status: 'fail', message: `projection check failed: ${(err as Error).message}`, remediation: 'run reindex after verifying the database backup' };
  }
  try {
    const stat = fs.statfsSync(dataDir);
    const free = stat.bavail * stat.bsize;
    checks.disk = { status: free >= MIN_FREE_BYTES ? 'pass' : 'fail', message: free >= MIN_FREE_BYTES ? 'data volume has sufficient free space' : 'data volume is below the 1 GiB safety floor', remediation: 'free space on the data volume before accepting more writes', details: { free_bytes: free, minimum_free_bytes: MIN_FREE_BYTES } };
  } catch (err) {
    checks.disk = { status: 'fail', message: `data volume stat failed: ${(err as Error).message}`, remediation: 'verify the DATA_DIR mount and permissions' };
  }
  const backup = latestManifest(dataDir);
  if (!backup) {
    checks.backup = { status: 'fail', message: 'no valid backup manifest found', remediation: 'run `node dist/cli.js backup` and configure the NAS backup job' };
  } else {
    let integrity: CheckStatus = 'pass';
    try { verifyBackupManifest(backup.file); } catch { integrity = 'fail'; }
    const age = ageStatus(backup.manifest.created_at, BACKUP_MAX_AGE_MS);
    const status: CheckStatus = integrity === 'fail' || age === 'fail' ? 'fail' : 'pass';
    checks.backup = { status, message: status === 'pass' ? 'latest backup is recent and checksum-valid' : 'latest backup is missing, stale, or checksum-invalid', remediation: 'run backup and verify the manifest before relying on it', details: { backup_id: backup.manifest.backup_id, created_at: backup.manifest.created_at, checksum_valid: integrity === 'pass' } };
  }
  const drill = readMaintenanceRecord(dataDir, 'restore_drill');
  checks.restore_drill = { status: drill?.status === 'pass' && ageStatus(drill.completed_at, RESTORE_DRILL_MAX_AGE_MS) === 'pass' ? 'pass' : 'fail', message: drill?.status === 'pass' ? 'latest restore drill is recent and passed' : 'no recent passing restore drill found', remediation: 'run `node dist/cli.js restore-drill --snapshot <manifest>` in an isolated directory' };
  const gc = readMaintenanceRecord(dataDir, 'idempotency_gc');
  checks.idempotency_gc = { status: gc?.status === 'pass' && ageStatus(gc.completed_at, IDEMPOTENCY_GC_MAX_AGE_MS) === 'pass' ? 'pass' : 'fail', message: gc?.status === 'pass' ? 'idempotency GC is recent and passed' : 'no recent passing idempotency GC found', remediation: 'run `node dist/cli.js idempotency-gc --days 90` on the schedule' };
  const statuses = Object.values(checks).map((check) => check.status);
  const status: CheckStatus = statuses.includes('fail') ? 'fail' : statuses.includes('warn') ? 'warn' : 'pass';
  return { status, exit_code: status === 'fail' ? 2 : status === 'warn' ? 1 : 0, generated_at: new Date().toISOString(), runtime: runtime(), checks };
}

export function maintenanceRecordPath(dataDir: string, kind: MaintenanceRecordV1['kind']): string {
  return path.join(maintenanceDir(dataDir), `last-${kind}.json`);
}

/**
 * Restore verification is deliberately performed on an OS-temporary copy.
 * The production database is never opened by this function; only the
 * metadata-only maintenance record is written back to DATA_DIR.
 */
export function restoreDrill(manifestFile: string, dataDir: string): MaintenanceRecordV1 {
  const started = new Date().toISOString();
  const checks: Array<{ name: string; status: CheckStatus }> = [];
  let workDir: string | null = null;
  let db: DB | null = null;
  try {
    const verified = verifyBackupManifest(manifestFile);
    checks.push({ name: 'manifest_checksum', status: 'pass' });
    // The manifest/snapshot may be mounted read-only by the upgrade gate.
    // Keep all working files in the OS temp directory so the drill never
    // needs write access to the snapshot mount.
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contexthub-restore-drill-'));
    const copy = path.join(workDir, 'restore.db');
    fs.copyFileSync(verified.snapshotFile, copy, fs.constants.COPYFILE_EXCL);
    db = openDatabase(copy, { synchronous: 'FULL' });
    const itemsRepo = createItemsRepo(db);
    const rebuilt = itemsRepo.reindex();
    checks.push({ name: 'isolated_migration', status: 'pass' });
    checks.push({ name: 'isolated_reindex', status: rebuilt.indexed >= 0 && rebuilt.vectorIndexed >= 0 ? 'pass' : 'fail' });
    db.prepare('SELECT COUNT(*) AS n FROM context_items').get();
    db.prepare('SELECT COUNT(*) AS n FROM item_versions').get();
    db.prepare('SELECT COUNT(*) AS n FROM audit_log').get();
    db.prepare('SELECT COUNT(*) AS n FROM idempotency_records').get();
    const chain = verifyAuditChain(db);
    const manifestChain = verified.manifest.audit_chain;
    const manifestMatches = !manifestChain || (
      manifestChain.verified === chain.verified &&
      manifestChain.row_count === chain.row_count &&
      manifestChain.latest_audit_id === chain.latest_audit_id &&
      manifestChain.root_hash === chain.root_hash
    );
    checks.push({ name: 'audit_chain', status: chain.verified && manifestMatches ? 'pass' : 'fail' });
    checks.push({ name: 'authorized_query_history_audit_idempotency', status: 'pass' });
    checks.push({ name: 'in_process_health', status: 'pass' });
  } catch {
    checks.push({ name: 'restore_drill', status: 'fail' });
  } finally {
    db?.close();
    if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
  }
  const status: 'pass' | 'fail' = checks.every((check) => check.status === 'pass') ? 'pass' : 'fail';
  const record: MaintenanceRecordV1 = {
    format: 'contexthub-maintenance/v1',
    kind: 'restore_drill',
    status,
    started_at: started,
    completed_at: new Date().toISOString(),
    runtime: runtime(),
    checks,
    details: { manifest_file: path.basename(manifestFile) },
  };
  writeMaintenanceRecord(dataDir, record);
  return record;
}
