import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAuditRepo } from '../src/core/audit-repo.js';
import { createClientsRepo } from '../src/core/clients-repo.js';
import { createCommands } from '../src/core/commands.js';
import { createItemsRepo } from '../src/core/items-repo.js';
import { createPoliciesRepo } from '../src/core/policies-repo.js';
import { newItemSchema } from '../src/core/types.js';
import { acquireInstanceLock, openDatabase, type DB } from '../src/db/connection.js';
import { ACCEPT_TRUST, ADMIN_CLIENT, ADMIN_ACCESS, idem, writerFor } from './helpers.js';

function stack(db: DB) {
  const itemsRepo = createItemsRepo(db);
  const clientsRepo = createClientsRepo(db);
  const policiesRepo = createPoliciesRepo(db);
  const auditRepo = createAuditRepo(db);
  const commands = createCommands({ db, itemsRepo, clientsRepo, policiesRepo, auditRepo });
  return { itemsRepo, clientsRepo, policiesRepo, auditRepo, commands };
}

describe('backup / restore / reindex on a real file database', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contexthub-test-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('VACUUM INTO snapshot restores to a fully working hub after reindex', () => {
    const dbFile = path.join(dir, 'contexthub.db');
    const db = openDatabase(dbFile);
    const s = stack(db);

    // seed: client + policy grant + items + review + audit + idempotency
    const { apiKey } = s.commands.adminCreateClient(ADMIN_CLIENT, {
      id: 'hermes',
      name: 'hermes',
      namespace: 'personal',
      principalKind: 'agent',
      scopes: ['read', 'write'],
      profile: 'agent-default',
    });
    const hermes = s.clientsRepo.verifyKey(apiKey)!;
    const saved = s.commands.createMemory(
      hermes,
      newItemSchema.parse({ type: 'fact', title: '財務規劃長期記憶', idempotency_key: 'seed-1' }),
    );
    s.commands.reviewMemory(ADMIN_CLIENT, saved.item.id, { decision: 'accept', expectedRevision: 1 }, idem());

    // consistent snapshot (the backup path)
    const snapshot = path.join(dir, 'backup.db');
    db.prepare('VACUUM INTO ?').run(snapshot);
    db.close();

    // "restore": open the snapshot as the new live DB, then MANDATORY reindex
    const restored = openDatabase(snapshot);
    const r = stack(restored);
    r.itemsRepo.reindex();

    // everything survived: item + trust + versions + reviews + policy + audit + idempotency
    const item = r.itemsRepo.get(ADMIN_ACCESS, saved.item.id)!;
    expect(item.trust_state).toBe('accepted');
    const found = r.itemsRepo.search(ADMIN_ACCESS, { queries: ['財務'], limit: 10, surface: 'accepted' });
    expect(found.totalMatched).toBe(1);
    const history = r.itemsRepo.history(ADMIN_ACCESS, saved.item.id)!;
    expect(history.versions.length).toBeGreaterThanOrEqual(2);
    expect(history.reviews).toHaveLength(1);
    expect(r.policiesRepo.getCurrent('personal')).not.toBeNull();
    expect(r.auditRepo.query({ namespace: 'personal' }).length).toBeGreaterThan(0);
    const idm = restored.prepare('SELECT COUNT(*) AS n FROM idempotency_records').get() as { n: number };
    expect(idm.n).toBeGreaterThan(0);
    // and the restored hub keeps read-after-write semantics with the SAME key
    const again = r.commands.createMemory(
      r.clientsRepo.verifyKey(apiKey)!,
      newItemSchema.parse({ type: 'note', title: '還原後的寫入', idempotency_key: 'seed-2' }),
    );
    expect(r.itemsRepo.get(ADMIN_ACCESS, again.item.id)).not.toBeNull();
    restored.close();
  });

  it('migrations are idempotent across reopen, and a pre-migration backup is only made when upgrading', () => {
    const dbFile = path.join(dir, 'contexthub.db');
    const db = openDatabase(dbFile);
    db.close();
    // reopen: no pending migrations → no error, no extra backup
    const db2 = openDatabase(dbFile);
    const migrations = db2.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number };
    expect(migrations.n).toBe(14);
    db2.close();
    const backups = fs.existsSync(path.join(dir, 'backups')) ? fs.readdirSync(path.join(dir, 'backups')) : [];
    expect(backups.filter((f) => f.startsWith('pre-migration'))).toHaveLength(0); // fresh DB → no upgrade backup
  });

  it('snapshots a v6 database before migration v7 and restores plus reindexes that snapshot', () => {
    const dbFile = path.join(dir, 'upgrade.db');
    const db = openDatabase(dbFile);
    const repo = createItemsRepo(db);
    const saved = repo.insert(
      writerFor('upgrade-source'),
      newItemSchema.parse({
        type: 'note',
        title: 'migration vector recovery marker',
        idempotency_key: 'upgrade-marker',
      }),
      'app',
      ACCEPT_TRUST,
    ).item;
    // Simulate the exact schema state immediately before migration v7.
    db.exec('DROP TABLE item_embeddings; DELETE FROM schema_migrations WHERE version = 7');
    db.close();

    const upgraded = openDatabase(dbFile);
    const upgradeBackups = fs
      .readdirSync(path.join(dir, 'backups'))
      .filter((name) => name.startsWith('pre-migration-v7-'));
    expect(upgradeBackups).toHaveLength(1);
    upgraded.close();

    const preMigrationSnapshot = path.join(dir, 'backups', upgradeBackups[0]!);
    const restoredFile = path.join(dir, 'restored-v6.db');
    fs.copyFileSync(preMigrationSnapshot, restoredFile);
    const restored = openDatabase(restoredFile);
    const restoredRepo = createItemsRepo(restored);
    expect(restoredRepo.retrievalProjectionStatus()).toMatchObject({ ready: false, missing_items: 1 });
    restoredRepo.reindex();
    expect(restoredRepo.retrievalProjectionStatus()).toMatchObject({ ready: true, indexed_items: 1 });
    expect(restoredRepo.get(ADMIN_ACCESS, saved.id)?.title).toBe('migration vector recovery marker');
    restored.close();
  });

  it('the instance lock refuses a second writer on the same data dir', () => {
    const lock = acquireInstanceLock(dir);
    expect(() => acquireInstanceLock(dir)).toThrow(/another ContextHub instance/);
    lock.close();
    // released on close → can acquire again
    const lock2 = acquireInstanceLock(dir);
    lock2.close();
  });
});
