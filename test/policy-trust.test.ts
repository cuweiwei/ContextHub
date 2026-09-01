import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  IdempotencyConflictError,
  NotFoundError,
  PolicyDeniedError,
  SourceItemConflictError,
} from '../src/core/errors.js';
import { newItemSchema } from '../src/core/types.js';
import { ADMIN_CLIENT, buildTestEnv, idem } from './helpers.js';

function item(overrides: Record<string, unknown> = {}) {
  return newItemSchema.parse({ type: 'note', title: 'n', content: '', idempotency_key: idem(), ...overrides });
}

describe('policy engine & trusted lifecycle (commands layer)', () => {
  let env: ReturnType<typeof buildTestEnv>;
  beforeEach(() => {
    env = buildTestEnv();
  });

  describe('fail-closed policy resolution', () => {
    it('denies everything when the namespace has no valid current policy', () => {
      const { auth } = env.newClient({ id: 'orphan', principalKind: 'agent' });
      env.db.prepare("DELETE FROM policies WHERE namespace = 'personal'").run();
      env.policiesRepo.invalidate();
      expect(() => env.commands.search(auth, { queries: ['x'], limit: 5 })).toThrow(PolicyDeniedError);
      expect(() => env.commands.createMemory(auth, item())).toThrow(PolicyDeniedError);
    });

    it('denies everything when the stored policy is corrupted or has an unknown schema version', () => {
      const { auth } = env.newClient({ id: 'agent-x', principalKind: 'agent' });
      const v = env.db.prepare("SELECT current_version FROM policies WHERE namespace = 'personal'").get() as {
        current_version: number;
      };
      env.db
        .prepare('UPDATE policy_versions SET rules = ? WHERE namespace = ? AND version = ?')
        .run(JSON.stringify({ schema_version: 99, something: 'else' }), 'personal', v.current_version);
      env.policiesRepo.invalidate();
      expect(() => env.commands.search(auth, { queries: ['x'], limit: 5 })).toThrow(PolicyDeniedError);
    });

    it('rejects policies referencing clients from another namespace', () => {
      env.newClient({ id: 'work-client', principalKind: 'agent', namespace: 'work', profile: 'none' });
      expect(() =>
        env.commands.applyPolicy(ADMIN_CLIENT, 'personal', {
          schema_version: 1,
          namespace_mode: 'personal',
          grants: [{ client_id: 'work-client', capabilities: ['memory.read_accepted'] }],
          create_rules: [],
          state_rules: [],
        }),
      ).toThrow(/does not exist in this namespace/);
    });

    it('rejects unknown capabilities, duplicate rule ids, and unregistered state schemas', () => {
      env.newClient({ id: 'a1', principalKind: 'agent' });
      expect(() =>
        env.commands.applyPolicy(ADMIN_CLIENT, 'personal', {
          schema_version: 1,
          namespace_mode: 'personal',
          grants: [{ client_id: 'a1', capabilities: ['memory.superpowers'] }],
          create_rules: [],
          state_rules: [],
        }),
      ).toThrow(/policy rejected/);
      expect(() =>
        env.commands.applyPolicy(ADMIN_CLIENT, 'personal', {
          schema_version: 1,
          namespace_mode: 'personal',
          grants: [],
          create_rules: [
            { rule_id: 'dup', client_id: 'a1', item_type: 'note', create_as: 'candidate' },
            { rule_id: 'dup', client_id: 'a1', item_type: 'task', create_as: 'candidate' },
          ],
          state_rules: [],
        }),
      ).toThrow(/duplicate rule_id/);
      expect(() =>
        env.commands.applyPolicy(ADMIN_CLIENT, 'personal', {
          schema_version: 1,
          namespace_mode: 'personal',
          grants: [],
          create_rules: [],
          state_rules: [
            { rule_id: 's1', state_key: 'k', schema_id: 'ghost', read_clients: ['a1'], write_clients: ['a1'], mutable_fields: ['value'] },
          ],
        }),
      ).toThrow(/not registered/);
    });

    it('policy history preserves every version for later adjudication questions', () => {
      env.newClient({ id: 'a1', principalKind: 'agent' }); // profile write = v2
      const shown = env.commands.getPolicy(ADMIN_CLIENT, 'personal')!;
      expect(shown.version).toBeGreaterThanOrEqual(2);
      const v1 = env.policiesRepo.getVersion('personal', 1);
      expect(v1).not.toBeNull(); // the seed version is still retrievable
    });

    it('refreshes a cached policy after an external CLI-style version update', () => {
      const { auth } = env.newClient({ id: 'external-policy-agent', principalKind: 'agent', profile: 'none' });
      const cached = env.policiesRepo.getCurrent('personal')!;
      expect(cached.policy.grants.some((grant) => grant.client_id === auth.id)).toBe(false);

      const nextVersion = cached.version + 1;
      const nextPolicy = {
        ...cached.policy,
        grants: [...cached.policy.grants, { client_id: auth.id, capabilities: ['memory.read_accepted'] }],
      };
      // Simulate the documented CLI, which updates SQLite in a separate
      // process and cannot call policiesRepo.invalidate() in this process.
      env.db
        .prepare('INSERT INTO policy_versions (namespace, version, rules, created_at, created_by) VALUES (?, ?, ?, ?, ?)')
        .run('personal', nextVersion, JSON.stringify(nextPolicy), new Date().toISOString(), ADMIN_CLIENT.id);
      env.db.prepare('UPDATE policies SET current_version = ? WHERE namespace = ?').run(nextVersion, 'personal');

      const refreshed = env.policiesRepo.getCurrent('personal')!;
      expect(refreshed.version).toBe(nextVersion);
      expect(refreshed.policy.grants.some((grant) => grant.client_id === auth.id)).toBe(true);
    });
  });

  describe('acceptance metadata & caller-supplied trust claims', () => {
    it('records WHICH policy version and rule accepted an item', () => {
      const { auth } = env.newClient({ id: 'finance-app', principalKind: 'service' });
      const currentVersion = env.policiesRepo.getCurrent('personal')!.version;
      const { item: created } = env.commands.createMemory(auth, item({ type: 'state', title: 's' }));
      expect(created.trust_state).toBe('accepted');
      expect(created.acceptance_method).toBe('policy');
      expect(created.acceptance_policy_version).toBe(currentVersion);
      expect(created.acceptance_rule_id).toContain('finance-app');
    });

    it('caller payload cannot elevate trust: user_confirmed flags and body fields are inert', () => {
      const { auth } = env.newClient({ id: 'hermes', principalKind: 'agent' });
      const { item: created } = env.commands.createMemory(auth, {
        ...item({ type: 'fact', title: '想直接變事實' }),
        // extraneous claims an injected agent might smuggle in:
        ...( { trust_state: 'accepted', user_confirmed: true, authority: 'user' } as object),
      } as any);
      expect(created.trust_state).toBe('candidate');
      expect(created.authority).toBe('agent');
    });

    it('insights from services are forced to candidate even with a create_as=accepted wildcard rule', () => {
      const { auth } = env.newClient({ id: 'finance-app', principalKind: 'service' });
      const { item: created } = env.commands.createMemory(auth, item({ type: 'insight', title: 'app 推論' }));
      expect(created.trust_state).toBe('candidate');
    });
  });

  describe('idempotent mutations', () => {
    it('replays the original result for the same key+payload, conflicts on different payload', () => {
      const { auth } = env.newClient({ id: 'hermes', principalKind: 'agent' });
      const body = item({ title: '一筆記憶', idempotency_key: 'fixed-key' });
      const first = env.commands.createMemory(auth, body);
      expect(first.replayed).toBe(false);
      // simulate a timeout retry: identical request
      const retry = env.commands.createMemory(auth, body);
      expect(retry.replayed).toBe(true);
      expect(retry.item.id).toBe(first.item.id);
      // only ONE item exists
      const count = env.db.prepare('SELECT COUNT(*) AS n FROM context_items').get() as { n: number };
      expect(count.n).toBe(1);
      // same key, different payload → conflict
      expect(() => env.commands.createMemory(auth, item({ title: '不同內容', idempotency_key: 'fixed-key' }))).toThrow(
        IdempotencyConflictError,
      );
    });

    it('review is idempotent under retry and never double-applies', () => {
      const { auth } = env.newClient({ id: 'hermes', principalKind: 'agent' });
      const { item: proposal } = env.commands.createMemory(auth, item({ type: 'insight', title: 'p' }));
      const key = randomUUID();
      const r1 = env.commands.reviewMemory(ADMIN_CLIENT, proposal.id, { decision: 'accept', expectedRevision: 1 }, key);
      const r2 = env.commands.reviewMemory(ADMIN_CLIENT, proposal.id, { decision: 'accept', expectedRevision: 1 }, key);
      expect(r2.replayed).toBe(true);
      expect(r2.item.revision).toBe(r1.item.revision);
      const reviews = env.db.prepare('SELECT COUNT(*) AS n FROM item_reviews WHERE item_id = ?').get(proposal.id) as { n: number };
      expect(reviews.n).toBe(1);
    });
  });

  describe('mutation invariants', () => {
    it('agents cannot patch; owners cannot patch insights/transactions; accepted agent memory needs a successor', () => {
      const service = env.newClient({ id: 'finance-app', principalKind: 'service' }).auth;
      const agent = env.newClient({ id: 'hermes', principalKind: 'agent' }).auth;

      const txn = env.commands.createMemory(service, item({ type: 'transaction', title: 't' })).item;
      expect(() =>
        env.commands.patchProjection(service, txn.id, { title: 'edited', expected_revision: 1 }, idem()),
      ).toThrow(PolicyDeniedError);

      const note = env.commands.createMemory(service, item({ title: 'service note' })).item;
      expect(() =>
        env.commands.patchProjection(agent, note.id, { title: 'agent edit', expected_revision: 1 }, idem()),
      ).toThrow(PolicyDeniedError);

      // accepted agent memory: revise → conflict; successor is the path
      const mem = env.commands.createMemory(agent, item({ type: 'fact', title: '事實', source_item_id: 'f1' })).item;
      env.commands.reviewMemory(ADMIN_CLIENT, mem.id, { decision: 'accept', expectedRevision: 1 }, idem());
      expect(() =>
        env.commands.reviseCandidate(agent, mem.id, { title: 'rewrite', expected_revision: 2 }, idem()),
      ).toThrow(SourceItemConflictError);
    });

    it('revise_candidate: creator only, while candidate, expected_revision enforced', () => {
      const agent = env.newClient({ id: 'hermes', principalKind: 'agent' }).auth;
      const other = env.newClient({ id: 'other', principalKind: 'agent' }).auth;
      const c = env.commands.createMemory(agent, item({ type: 'note', title: 'v1' })).item;
      // another client cannot even see it → 404
      expect(() => env.commands.reviseCandidate(other, c.id, { title: 'x', expected_revision: 1 }, idem())).toThrow(
        NotFoundError,
      );
      const revised = env.commands.reviseCandidate(agent, c.id, { title: 'v2', expected_revision: 1 }, idem());
      expect(revised.item.title).toBe('v2');
      expect(revised.item.trust_state).toBe('candidate');
    });

    it('task title is unreachable through operate_task by construction', () => {
      const service = env.newClient({ id: 'work-app', principalKind: 'service' }).auth;
      const agent = env.newClient({ id: 'hermes', principalKind: 'agent' }).auth;
      const task = env.commands.createMemory(service, item({ type: 'task', title: '原始任務語意' })).item;
      const done = env.commands.operateTask(
        agent,
        task.id,
        { kind: 'set_status', status: 'completed', expected_revision: 1 },
        idem(),
      );
      expect(done.item.title).toBe('原始任務語意'); // untouched
      expect(done.item.status).toBe('completed');
      // checklist completion requires an existing checklist entry
      expect(() =>
        env.commands.operateTask(agent, task.id, { kind: 'complete_checklist_item', checklist_index: 0, expected_revision: 2 }, idem()),
      ).toThrow(/checklist/);
    });

    it('curate_note reaches organisation fields only; note content stays intact', () => {
      const service = env.newClient({ id: 'crm-app', principalKind: 'service' }).auth;
      const agent = env.newClient({ id: 'hermes', principalKind: 'agent' }).auth;
      const note = env.commands.createMemory(service, item({ type: 'note', title: '原始內容', content: '本文' })).item;
      const curated = env.commands.curateNote(
        agent,
        note.id,
        { tags: ['整理過'], collection: 'inbox', archived: true, expected_revision: 1 },
        idem(),
      );
      expect(curated.item.title).toBe('原始內容');
      expect(curated.item.content).toBe('本文');
      expect(curated.item.tags).toEqual(['整理過']);
      expect(curated.item.status).toBe('completed');
      expect((curated.item.data as any).collection).toBe('inbox');
    });
  });

  describe('audit fail-closed', () => {
    it('refuses reads when the audit log cannot be written', () => {
      const { auth } = env.newClient({ id: 'hermes', principalKind: 'agent' });
      // fault injection: make audit_log unwritable
      env.db.exec('DROP TABLE audit_log');
      expect(() => env.commands.search(auth, { queries: ['x'], limit: 5 })).toThrow(/audit log write failed/);
      expect(env.auditRepo.writable()).toBe(false);
    });

    it('rolls a mutation back if its audit row cannot be committed', () => {
      const { auth } = env.newClient({ id: 'hermes', principalKind: 'agent' });
      env.db.exec('DROP TABLE audit_log');
      expect(() => env.commands.createMemory(auth, item({ title: '不該存在' }))).toThrow();
      // re-create the table to inspect state
      env.db.exec(
        "CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, namespace TEXT NOT NULL, client_id TEXT NOT NULL, action TEXT NOT NULL, item_id TEXT, outcome TEXT NOT NULL CHECK (outcome IN ('allow','deny')), details TEXT)",
      );
      const count = env.db.prepare("SELECT COUNT(*) AS n FROM context_items WHERE title = '不該存在'").get() as { n: number };
      expect(count.n).toBe(0);
    });
  });

  describe('disabled credentials and audit continuity', () => {
    it('a disabled key stops verifying immediately; identity survives rotation in the audit trail', () => {
      const { apiKey } = env.newClient({ id: 'hermes', principalKind: 'agent' });
      expect(env.clientsRepo.verifyKey(apiKey)).not.toBeNull();
      env.commands.adminSetDisabled(ADMIN_CLIENT, 'hermes', true);
      expect(env.clientsRepo.verifyKey(apiKey)).toBeNull();
      env.commands.adminSetDisabled(ADMIN_CLIENT, 'hermes', false);

      const rotated = env.commands.adminRotateKey(ADMIN_CLIENT, 'hermes');
      expect(env.clientsRepo.verifyKey(apiKey)).toBeNull(); // old key dead
      const fresh = env.clientsRepo.verifyKey(rotated.apiKey)!;
      expect(fresh.id).toBe('hermes');
      expect(fresh.credentialVersion).toBe(2);

      env.commands.createMemory(fresh, item({ title: 'after rotation' }));
      const trail = env.auditRepo.query({ namespace: 'personal' });
      const clientIds = new Set(trail.map((e) => e.client_id));
      expect(clientIds.has('hermes')).toBe(true); // same principal id throughout
    });
  });
});
