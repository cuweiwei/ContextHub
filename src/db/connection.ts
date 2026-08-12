import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { migrate } from './migrations.js';

export type DB = Database.Database;

export interface OpenOptions {
  /**
   * WAL synchronous level. FULL (default) makes an acknowledged commit
   * durable across power loss — the honest reading of "committed" for a
   * system of record. NORMAL trades that for speed (crash-safe, not
   * power-loss-proof).
   */
  synchronous?: 'FULL' | 'NORMAL';
}

/**
 * Opens (and migrates) the SQLite database. Pass ':memory:' for tests.
 */
export function openDatabase(file: string, opts: OpenOptions = {}): DB {
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const db = new Database(file);
  // sqlite-vec accelerates a rebuildable query projection only. Domain rows
  // in context_items remain the sole authority.
  sqliteVec.load(db);
  db.pragma('journal_mode = WAL');
  db.pragma(`synchronous = ${opts.synchronous ?? 'FULL'}`);
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

/**
 * Enforces the single-active-instance promise: a second server process on the
 * same data directory must fail fast instead of silently double-writing the
 * database. Implemented as an EXCLUSIVE-mode lock on a dedicated sidecar
 * database — the OS releases it automatically when the process dies, so no
 * stale-PID cleanup is ever needed.
 *
 * Returns the lock handle; keep it referenced for the process lifetime.
 */
export function acquireInstanceLock(dataDir: string): DB {
  fs.mkdirSync(dataDir, { recursive: true });
  const lock = new Database(path.join(dataDir, 'instance.lock.db'));
  try {
    lock.pragma('busy_timeout = 0');
    lock.pragma('journal_mode = PERSIST');
    lock.pragma('locking_mode = EXCLUSIVE');
    // A write is required to actually take the exclusive lock.
    lock.exec('CREATE TABLE IF NOT EXISTS lock_holder (pid INTEGER, started_at TEXT)');
    lock.exec('DELETE FROM lock_holder');
    lock
      .prepare('INSERT INTO lock_holder (pid, started_at) VALUES (?, ?)')
      .run(process.pid, new Date().toISOString());
  } catch (err) {
    lock.close();
    throw new Error(
      `another ContextHub instance already holds ${dataDir}/instance.lock.db — refusing to start a second writer (${(err as Error).message})`,
    );
  }
  return lock;
}
