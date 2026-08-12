import { createHash } from 'node:crypto';
import type { DB } from '../db/connection.js';
import type { AuditRepo } from './audit-repo.js';
import type { ClientsRepo } from './clients-repo.js';
import {
  IdempotencyConflictError,
  NotFoundError,
  PolicyDeniedError,
  RevisionConflictError,
  SourceItemConflictError,
  ValidationError,
} from './errors.js';
import type { ItemsRepo, TrustDecision, WriteContext } from './items-repo.js';
import {
  capabilitiesFor,
  createRuleFor,
  profileFor,
  stateRuleFor,
  validateStateValue,
  type Capability,
  type GrantProfile,
  type PolicyV1,
} from './policy.js';
import type { PoliciesRepo } from './policies-repo.js';
import {
  compileContextPackage,
  type ContextCandidate,
  type ContextTarget,
} from './context-compiler.js';
import { ulid } from './ids.js';
import {
  accessFor,
  resolveAuthority,
  type Authority,
  type ClientAuth,
  type ContextItem,
  type ItemStatus,
  type NewItem,
  type PatchItem,
  type ReadAccess,
  type TrustSurface,
} from './types.js';

/**
 * The domain-command layer. EVERY mutation — REST or MCP — flows through
 * here, so the safety invariants live in exactly one place:
 *
 *  - policy resolution is fail-closed (missing/invalid policy = deny)
 *  - every mutation requires an Idempotency-Key and is recorded atomically
 *  - every mutation writes its audit row in the SAME transaction
 *  - denials are audited (best-effort, outside the rolled-back transaction)
 *  - reads are audited BEFORE execution and refuse to run unaudited
 *  - there is NO generic patch for agents: only typed commands with
 *    field-level allowlists (operate_task, curate_note, state updates …)
 */

export interface CommandDeps {
  db: DB;
  itemsRepo: ItemsRepo;
  clientsRepo: ClientsRepo;
  policiesRepo: PoliciesRepo;
  auditRepo: AuditRepo;
}

export interface AuthzContext {
  client: ClientAuth;
  access: ReadAccess;
  policy: PolicyV1 | null; // null only for admin
  policyVersion: number | null;
  capabilities: Set<Capability>;
}

export interface TaskAction {
  kind:
    | 'set_status'
    | 'set_progress'
    | 'set_blocked'
    | 'complete_checklist_item'
    | 'set_due_date'
    | 'set_priority'
    | 'set_assignee'
    | 'set_dependencies';
  status?: ItemStatus;
  progress?: number;
  blocked_reason?: string | null;
  checklist_index?: number;
  due_date?: string | null;
  priority?: 'low' | 'medium' | 'high' | null;
  assignee?: string | null;
  dependencies?: string[];
  expected_revision: number;
}

const OPERATE_KINDS = new Set(['set_status', 'set_progress', 'set_blocked', 'complete_checklist_item']);

export type Commands = ReturnType<typeof createCommands>;

/** Deterministic local intent expansion for the context compiler. */
function contextRetrievalQueries(intent: string, related: string[] = []): string[] {
  const queries = new Set<string>();
  const add = (value: string) => {
    const trimmed = value.trim();
    if (trimmed) queries.add(trimmed);
  };
  add(intent);
  for (const query of related) add(query);
  for (const part of intent.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+|[\p{L}\p{N}_-]+/gu) ?? []) {
    if (/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+$/u.test(part)) {
      const chars = [...part];
      for (let i = 0; i < chars.length - 1; i++) add(chars.slice(i, i + 2).join(''));
    } else if (part.length >= 3) {
      add(part);
    }
  }
  return [...queries].slice(0, 20);
}

export function createCommands(deps: CommandDeps) {
  const { db, itemsRepo, clientsRepo, policiesRepo, auditRepo } = deps;

  const idemSelect = db.prepare(
    'SELECT operation, request_hash, result_json FROM idempotency_records WHERE namespace = ? AND client_id = ? AND idempotency_key = ?',
  );
  const idemInsert = db.prepare(
    'INSERT INTO idempotency_records (namespace, client_id, idempotency_key, operation, request_hash, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );

  // ---------- authorization ----------

  function resolveAuthz(client: ClientAuth): AuthzContext {
    const access = accessFor(client);
    if (client.isAdmin) {
      return { client, access, policy: null, policyVersion: null, capabilities: new Set() };
    }
    const current = policiesRepo.getCurrent(client.namespace);
    if (!current) {
      throw new PolicyDeniedError(
        `namespace "${client.namespace}" has no valid current policy — denied (fail-closed)`,
      );
    }
    return {
      client,
      access,
      policy: current.policy,
      policyVersion: current.version,
      capabilities: capabilitiesFor(current.policy, client.id),
    };
  }

  function has(ctx: AuthzContext, cap: Capability): boolean {
    return ctx.client.isAdmin || ctx.capabilities.has(cap);
  }

  function requireCap(ctx: AuthzContext, cap: Capability): void {
    if (!has(ctx, cap)) {
      throw new PolicyDeniedError(`this operation requires the "${cap}" capability in namespace policy`);
    }
  }

  function auditNamespace(client: ClientAuth, target?: string | null): string {
    return target ?? (client.namespace || '*');
  }

  // ---------- audited reads ----------

  /**
   * Runs a read with capability check + pre-execution audit. The audit row is
   * written BEFORE the read runs; if it cannot be written the read is refused
   * (AuditUnavailableError → 503). Denials are audited best-effort.
   */
  function readAudited<T>(
    client: ClientAuth,
    action: string,
    requiredCap: Capability | null,
    details: Record<string, unknown>,
    fn: (ctx: AuthzContext) => T,
  ): T {
    let ctx: AuthzContext;
    try {
      ctx = resolveAuthz(client);
      if (requiredCap) requireCap(ctx, requiredCap);
    } catch (err) {
      if (err instanceof PolicyDeniedError) {
        auditRepo.logDenySafe({
          namespace: auditNamespace(client),
          clientId: client.id,
          action,
          details: { reason: 'policy_denied' },
        });
      }
      throw err;
    }
    auditRepo.log({
      namespace: auditNamespace(client),
      clientId: client.id,
      action,
      outcome: 'allow',
      details,
    });
    return fn(ctx);
  }

  // ---------- mutation wrapper ----------

  function requestHash(operation: string, payload: unknown): string {
    return createHash('sha256').update(JSON.stringify({ operation, payload })).digest('hex');
  }

  /**
   * Idempotent, audited, transactional mutation runner. Same key + same
   * payload replays the stored result without re-executing; same key +
   * different payload is a 409. Result, idempotency record, and audit row
   * commit (or roll back) together.
   */
  function runMutation<T>(
    client: ClientAuth,
    operation: string,
    idempotencyKey: string,
    payload: unknown,
    opts: { targetNamespace?: string | null; itemId?: (result: T) => string | null },
    fn: (ctx: AuthzContext) => T,
  ): { result: T; replayed: boolean } {
    if (!idempotencyKey || typeof idempotencyKey !== 'string') {
      throw new ValidationError('idempotency_key is required on every mutation');
    }
    const hash = requestHash(operation, payload);
    let ctx: AuthzContext;
    try {
      ctx = resolveAuthz(client);
    } catch (err) {
      if (err instanceof PolicyDeniedError) {
        auditRepo.logDenySafe({
          namespace: auditNamespace(client, opts.targetNamespace),
          clientId: client.id,
          action: operation,
          details: { reason: 'policy_denied' },
        });
      }
      throw err;
    }
    const ns = auditNamespace(client, opts.targetNamespace);
    try {
      return db.transaction((): { result: T; replayed: boolean } => {
        const existing = idemSelect.get(ns, client.id, idempotencyKey) as
          | { operation: string; request_hash: string; result_json: string }
          | undefined;
        if (existing) {
          if (existing.operation !== operation || existing.request_hash !== hash) {
            throw new IdempotencyConflictError(
              `idempotency key "${idempotencyKey}" was already used with a different request`,
            );
          }
          return { result: JSON.parse(existing.result_json) as T, replayed: true };
        }
        const result = fn(ctx);
        idemInsert.run(ns, client.id, idempotencyKey, operation, hash, JSON.stringify(result), new Date().toISOString());
        auditRepo.log({
          namespace: ns,
          clientId: client.id,
          action: operation,
          itemId: opts.itemId ? opts.itemId(result) : null,
          outcome: 'allow',
        });
        return { result, replayed: false };
      })();
    } catch (err) {
      if (
        err instanceof PolicyDeniedError ||
        err instanceof ValidationError ||
        err instanceof NotFoundError ||
        err instanceof SourceItemConflictError ||
        err instanceof RevisionConflictError ||
        err instanceof IdempotencyConflictError
      ) {
        auditRepo.logDenySafe({
          namespace: ns,
          clientId: client.id,
          action: operation,
          details: { reason: (err as { code?: string }).code ?? 'error' },
        });
      }
      throw err;
    }
  }

  // ---------- write-context / trust resolution ----------

  function writeContextFor(ctx: AuthzContext, source: string, namespace: string): WriteContext {
    return {
      clientId: source,
      namespace,
      principalKind: ctx.client.isAdmin ? 'human' : ctx.client.principalKind,
      access: ctx.access,
      isAdmin: ctx.client.isAdmin,
    };
  }

  /** Trust verdict for a creation — from create_rules for normal clients. */
  function trustFor(ctx: AuthzContext, itemType: string): TrustDecision {
    if (ctx.client.isAdmin) {
      return {
        trustState: 'accepted',
        acceptanceMethod: 'trusted_import',
        policyVersion: null,
        ruleId: null,
      };
    }
    const rule = createRuleFor(ctx.policy!, ctx.client.id, itemType);
    if (!rule) {
      throw new PolicyDeniedError(
        `namespace policy has no create rule allowing client "${ctx.client.id}" to create type "${itemType}"`,
      );
    }
    // Hard invariant (not configurable): machine-produced INSIGHTS are never
    // auto-accepted — an app or agent inferring something is not the same as
    // it being verified. Only human entry (or admin import) skips review.
    const forcedCandidate = itemType === 'insight' && ctx.client.principalKind !== 'human';
    if (rule.create_as === 'candidate' || forcedCandidate) {
      return { trustState: 'candidate', acceptanceMethod: null, policyVersion: ctx.policyVersion, ruleId: rule.rule_id };
    }
    return {
      trustState: 'accepted',
      acceptanceMethod: ctx.client.principalKind === 'human' ? 'trusted_import' : 'policy',
      policyVersion: ctx.policyVersion,
      ruleId: rule.rule_id,
    };
  }

  /** Resolve the namespace an admin write lands in (fail-closed, no default). */
  function adminTargetNamespace(requestedSource: string | undefined, explicit: string | undefined): string {
    if (explicit) {
      if (!clientsRepo.namespaceExists(explicit)) {
        throw new ValidationError(`namespace "${explicit}" does not exist`);
      }
      return explicit;
    }
    if (requestedSource) {
      const src = clientsRepo.get(requestedSource);
      if (src) return src.namespace;
    }
    throw new ValidationError(
      'admin writes must resolve a namespace: pass "namespace" explicitly or use a registered client as "source"',
    );
  }

  // ---------- memory lifecycle commands ----------

  function createMemory(
    client: ClientAuth,
    input: NewItem,
    adminExtras: { source?: string; authority?: Authority; namespace?: string } = {},
  ): { item: ContextItem; created: boolean; replayed: boolean } {
    if ((adminExtras.source || adminExtras.authority || adminExtras.namespace) && !client.isAdmin) {
      throw new PolicyDeniedError('only the admin token may write on behalf of another source/namespace');
    }
    const { result, replayed } = runMutation(
      client,
      'write.create',
      input.idempotency_key,
      { input, adminExtras },
      {
        targetNamespace: client.isAdmin
          ? adminTargetNamespace(adminExtras.source, adminExtras.namespace)
          : client.namespace,
        itemId: (r: { item: ContextItem }) => r.item.id,
      },
      (ctx) => {
        const source = adminExtras.source ?? client.id;
        const namespace = client.isAdmin
          ? adminTargetNamespace(adminExtras.source, adminExtras.namespace)
          : client.namespace;
        const trust = trustFor(ctx, input.type);
        const authority = resolveAuthority(client, adminExtras.authority);
        return itemsRepo.insert(writeContextFor(ctx, source, namespace), input, authority, trust);
      },
    );
    return { ...result, replayed };
  }

  function createMemoryBatch(
    client: ClientAuth,
    batchKey: string,
    inputs: NewItem[],
    adminExtras: { source?: string; authority?: Authority; namespace?: string } = {},
  ): { results: { item: ContextItem; created: boolean }[]; replayed: boolean } {
    if ((adminExtras.source || adminExtras.authority || adminExtras.namespace) && !client.isAdmin) {
      throw new PolicyDeniedError('only the admin token may write on behalf of another source/namespace');
    }
    const { result, replayed } = runMutation(
      client,
      'write.batch',
      batchKey,
      { inputs, adminExtras },
      {
        targetNamespace: client.isAdmin
          ? adminTargetNamespace(adminExtras.source, adminExtras.namespace)
          : client.namespace,
      },
      (ctx) => {
        const source = adminExtras.source ?? client.id;
        const namespace = client.isAdmin
          ? adminTargetNamespace(adminExtras.source, adminExtras.namespace)
          : client.namespace;
        const authority = resolveAuthority(client, adminExtras.authority);
        const writer = writeContextFor(ctx, source, namespace);
        return {
          results: itemsRepo.insertBatch(
            writer,
            inputs.map((input) => ({ input, authority, trust: trustFor(ctx, input.type) })),
          ),
        };
      },
    );
    return { ...result, replayed };
  }

  /**
   * Generic PATCH is reserved for non-agent principals maintaining their OWN
   * records, and for admin. Insights and transactions are never patchable
   * (append-only / dedup-only); accepted agent memories need a successor.
   */
  function patchProjection(
    client: ClientAuth,
    itemId: string,
    patch: PatchItem,
    idempotencyKey: string,
  ): { item: ContextItem; replayed: boolean } {
    const { result, replayed } = runMutation(
      client,
      'write.patch',
      idempotencyKey,
      { itemId, patch },
      { itemId: () => itemId },
      (ctx) => {
        const existing = itemsRepo.get(ctx.access, itemId, { allCandidates: ctx.client.isAdmin });
        if (!existing) throw new NotFoundError(`no item with id "${itemId}"`);
        if (!ctx.client.isAdmin) {
          if (ctx.client.principalKind === 'agent') {
            throw new PolicyDeniedError(
              'agents cannot patch items directly — use revise (own candidates), propose_successor, operate_task, or curate_note',
            );
          }
          if (existing.source !== ctx.client.id) {
            throw new PolicyDeniedError('items can only be patched by the principal that created them');
          }
          if (existing.type === 'insight') {
            throw new PolicyDeniedError('insights are append-only');
          }
          if (existing.type === 'transaction') {
            throw new PolicyDeniedError('transactions are append-only — write a correction/reversal as a new item');
          }
          if (existing.state_kind === 'operational') {
            throw new PolicyDeniedError('operational state slots are updated via the state interface');
          }
        }
        if (patch.expected_revision === undefined) {
          throw new ValidationError('expected_revision is required');
        }
        const item = itemsRepo.update(itemId, patch, ctx.client.id);
        if (!item) throw new NotFoundError(`no item with id "${itemId}"`);
        return { item };
      },
    );
    return { ...result, replayed };
  }

  /** Creator refreshes their own still-unreviewed candidate. */
  function reviseCandidate(
    client: ClientAuth,
    itemId: string,
    patch: PatchItem,
    idempotencyKey: string,
  ): { item: ContextItem; replayed: boolean } {
    const { result, replayed } = runMutation(
      client,
      'write.revise',
      idempotencyKey,
      { itemId, patch },
      { itemId: () => itemId },
      (ctx) => {
        const existing = itemsRepo.get(ctx.access, itemId);
        if (!existing) throw new NotFoundError(`no item with id "${itemId}"`);
        if (existing.source !== ctx.client.id && !ctx.client.isAdmin) {
          throw new PolicyDeniedError('only the creator may revise a candidate');
        }
        if (existing.trust_state !== 'candidate') {
          throw new SourceItemConflictError(
            'only still-unreviewed candidates can be revised; accepted memories need a successor',
          );
        }
        if (patch.expected_revision === undefined) {
          throw new ValidationError('expected_revision is required');
        }
        // Field allowlist: content-shaped fields only; trust/provenance/
        // namespace/type are untouchable by construction.
        const allowed: PatchItem = {
          ...(patch.title !== undefined ? { title: patch.title } : {}),
          ...(patch.content !== undefined ? { content: patch.content } : {}),
          ...('data' in patch ? { data: patch.data } : {}),
          ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
          ...(patch.entities !== undefined ? { entities: patch.entities } : {}),
          ...(patch.confidence !== undefined ? { confidence: patch.confidence } : {}),
          ...('occurred_at' in patch ? { occurred_at: patch.occurred_at } : {}),
          ...('expires_at' in patch ? { expires_at: patch.expires_at } : {}),
          ...('valid_from' in patch ? { valid_from: patch.valid_from } : {}),
          ...('valid_until' in patch ? { valid_until: patch.valid_until } : {}),
          ...('last_verified_at' in patch ? { last_verified_at: patch.last_verified_at } : {}),
          ...('decay_policy' in patch ? { decay_policy: patch.decay_policy } : {}),
          expected_revision: patch.expected_revision,
        };
        const item = itemsRepo.update(itemId, allowed, ctx.client.id);
        if (!item) throw new NotFoundError(`no item with id "${itemId}"`);
        return { item };
      },
    );
    return { ...result, replayed };
  }

  /** Propose a replacement for an ACCEPTED item. Always starts as candidate. */
  function proposeSuccessor(
    client: ClientAuth,
    predecessorId: string,
    input: NewItem,
  ): { item: ContextItem; created: boolean; replayed: boolean } {
    const { result, replayed } = runMutation(
      client,
      'write.successor',
      input.idempotency_key,
      { predecessorId, input },
      { itemId: (r: { item: ContextItem }) => r.item.id },
      (ctx) => {
        requireCap(ctx, 'memory.propose_successor');
        if (!ctx.client.isAdmin) {
          const rule = createRuleFor(ctx.policy!, ctx.client.id, input.type);
          if (!rule) {
            throw new PolicyDeniedError(
              `namespace policy has no create rule allowing client "${ctx.client.id}" to create type "${input.type}"`,
            );
          }
        }
        const trust: TrustDecision = {
          trustState: 'candidate',
          acceptanceMethod: null,
          policyVersion: ctx.policyVersion,
          ruleId: null,
        };
        const namespace = ctx.client.isAdmin
          ? (itemsRepo.get(ctx.access, predecessorId, { allCandidates: true })?.namespace ??
            (() => {
              throw new ValidationError(`predecessor "${predecessorId}" does not exist or is not readable`);
            })())
          : ctx.client.namespace;
        return itemsRepo.insert(
          writeContextFor(ctx, ctx.client.id, namespace),
          input,
          resolveAuthority(ctx.client),
          trust,
          { successorOf: predecessorId },
        );
      },
    );
    return { ...result, replayed };
  }

  /**
   * Adjudication: accept/reject a candidate, or revoke an accepted item. The
   * verdict is written back into the hub (trust flip + review event + version
   * snapshot; successor acceptance also supersedes the predecessor) in ONE
   * transaction. No self-review.
   */
  function reviewMemory(
    client: ClientAuth,
    itemId: string,
    opts: { decision: 'accept' | 'reject' | 'revoke'; expectedRevision: number; note?: string },
    idempotencyKey: string,
  ): { item: ContextItem; replayed: boolean } {
    const { result, replayed } = runMutation(
      client,
      'write.review',
      idempotencyKey,
      { itemId, opts },
      { itemId: () => itemId },
      (ctx) => {
        requireCap(ctx, 'memory.review');
        const existing = itemsRepo.get(ctx.access, itemId, { allCandidates: true });
        if (!existing) throw new NotFoundError(`no item with id "${itemId}"`);
        if (existing.source === ctx.client.id && !ctx.client.isAdmin) {
          throw new PolicyDeniedError('a client cannot review its own proposals');
        }
        const item = itemsRepo.review(itemId, {
          decision: opts.decision,
          reviewedBy: ctx.client.id,
          expectedRevision: opts.expectedRevision,
          note: opts.note,
        });
        if (!item) throw new NotFoundError(`no item with id "${itemId}"`);
        return { item };
      },
    );
    return { ...result, replayed };
  }

  /** Typed task mutations — semantic fields are unreachable by construction. */
  function operateTask(
    client: ClientAuth,
    itemId: string,
    action: TaskAction,
    idempotencyKey: string,
  ): { item: ContextItem; replayed: boolean } {
    const { result, replayed } = runMutation(
      client,
      'write.task_op',
      idempotencyKey,
      { itemId, action },
      { itemId: () => itemId },
      (ctx) => {
        requireCap(ctx, OPERATE_KINDS.has(action.kind) ? 'task.operate' : 'task.coordinate');
        const existing = itemsRepo.get(ctx.access, itemId);
        if (!existing) throw new NotFoundError(`no item with id "${itemId}"`);
        if (existing.type !== 'task') throw new ValidationError('task operations apply only to task items');
        if (existing.trust_state !== 'accepted' && existing.source !== ctx.client.id && !ctx.client.isAdmin) {
          throw new PolicyDeniedError('only accepted tasks (or your own candidates) can be operated on');
        }

        const data = { ...((existing.data ?? {}) as Record<string, unknown>) };
        const patch: PatchItem = { expected_revision: action.expected_revision };
        switch (action.kind) {
          case 'set_status': {
            if (!action.status) throw new ValidationError('status is required for set_status');
            patch.status = action.status;
            if (action.status === 'completed') data.completed_at = new Date().toISOString();
            break;
          }
          case 'set_progress': {
            if (typeof action.progress !== 'number' || action.progress < 0 || action.progress > 100) {
              throw new ValidationError('progress must be a number 0-100');
            }
            data.progress = action.progress;
            if (data.started_at === undefined && action.progress > 0) data.started_at = new Date().toISOString();
            break;
          }
          case 'set_blocked': {
            data.blocked_reason = action.blocked_reason ?? null;
            break;
          }
          case 'complete_checklist_item': {
            const checklist = Array.isArray(data.checklist) ? (data.checklist as unknown[]) : null;
            if (!checklist || typeof action.checklist_index !== 'number' || !checklist[action.checklist_index]) {
              throw new ValidationError('checklist_index does not reference an existing checklist item');
            }
            const entry = checklist[action.checklist_index];
            if (typeof entry !== 'object' || entry === null) {
              throw new ValidationError('checklist entries must be objects');
            }
            (entry as Record<string, unknown>).done = true;
            data.checklist = checklist; // item-level completion only; wholesale replacement is not offered
            break;
          }
          case 'set_due_date': {
            patch.occurred_at = action.due_date ?? null;
            break;
          }
          case 'set_priority': {
            data.priority = action.priority ?? null;
            break;
          }
          case 'set_assignee': {
            data.assignee = action.assignee ?? null;
            break;
          }
          case 'set_dependencies': {
            const dependencies = action.dependencies ?? [];
            for (const dep of dependencies) {
              const depItem = itemsRepo.get(ctx.access, dep);
              if (!depItem) throw new ValidationError(`dependency "${dep}" does not exist or is not readable`);
            }
            data.dependencies = dependencies;
            break;
          }
        }
        patch.data = data;
        const item = itemsRepo.update(itemId, patch, ctx.client.id);
        if (!item) throw new NotFoundError(`no item with id "${itemId}"`);
        return { item };
      },
    );
    return { ...result, replayed };
  }

  /** Note curation: organizational fields only — content is untouchable. */
  function curateNote(
    client: ClientAuth,
    itemId: string,
    curate: {
      tags?: string[];
      collection?: string | null;
      archived?: boolean;
      related_item_ids?: string[];
      expected_revision: number;
    },
    idempotencyKey: string,
  ): { item: ContextItem; replayed: boolean } {
    const { result, replayed } = runMutation(
      client,
      'write.curate',
      idempotencyKey,
      { itemId, curate },
      { itemId: () => itemId },
      (ctx) => {
        requireCap(ctx, 'note.curate');
        const existing = itemsRepo.get(ctx.access, itemId);
        if (!existing) throw new NotFoundError(`no item with id "${itemId}"`);
        if (existing.type !== 'note') throw new ValidationError('curate applies only to note items');
        if (existing.trust_state !== 'accepted' && existing.source !== ctx.client.id && !ctx.client.isAdmin) {
          throw new PolicyDeniedError('only accepted notes (or your own candidates) can be curated');
        }
        const data = { ...((existing.data ?? {}) as Record<string, unknown>) };
        const patch: PatchItem = { expected_revision: curate.expected_revision };
        if (curate.tags !== undefined) patch.tags = curate.tags;
        if (curate.collection !== undefined) data.collection = curate.collection;
        if (curate.related_item_ids !== undefined) {
          for (const rel of curate.related_item_ids) {
            const relItem = itemsRepo.get(ctx.access, rel);
            if (!relItem) throw new ValidationError(`related item "${rel}" does not exist or is not readable`);
          }
          data.related_item_ids = curate.related_item_ids;
        }
        if (curate.archived !== undefined) patch.status = curate.archived ? 'completed' : 'active';
        patch.data = data;
        const item = itemsRepo.update(itemId, patch, ctx.client.id);
        if (!item) throw new NotFoundError(`no item with id "${itemId}"`);
        return { item };
      },
    );
    return { ...result, replayed };
  }

  /**
   * Operational state slot update. Requires an EXACT state_key rule, matching
   * schema_id, schema-valid value, and every touched field inside the rule's
   * mutable allowlist. No wildcards.
   */
  function updateOperationalState(
    client: ClientAuth,
    input: {
      state_key: string;
      schema_id: string;
      title?: string;
      value?: unknown;
      observed_at?: string | null;
      expires_at?: string | null;
      status?: ItemStatus;
      expected_revision?: number;
    },
    idempotencyKey: string,
  ): { item: ContextItem; created: boolean; replayed: boolean } {
    const { result, replayed } = runMutation(
      client,
      'write.state',
      idempotencyKey,
      { input },
      { itemId: (r: { item: ContextItem }) => r.item.id },
      (ctx) => {
        if (ctx.client.isAdmin) {
          throw new ValidationError(
            'operational state updates run under a namespace client with a state rule (admin has no namespace)',
          );
        }
        requireCap(ctx, 'state.write');
        const rule = stateRuleFor(ctx.policy!, input.state_key);
        if (!rule || !rule.write_clients.includes(ctx.client.id)) {
          throw new PolicyDeniedError(`no state rule allows client "${ctx.client.id}" to write "${input.state_key}"`);
        }
        if (input.schema_id !== rule.schema_id) {
          throw new PolicyDeniedError(`schema_id mismatch: rule "${rule.rule_id}" requires "${rule.schema_id}"`);
        }
        const touched: ('value' | 'observed_at' | 'expires_at' | 'status')[] = [];
        if (input.value !== undefined) touched.push('value');
        if (input.observed_at !== undefined) touched.push('observed_at');
        if (input.expires_at !== undefined) touched.push('expires_at');
        if (input.status !== undefined) touched.push('status');
        for (const f of touched) {
          if (!rule.mutable_fields.includes(f)) {
            throw new PolicyDeniedError(`field "${f}" is not in the mutable allowlist of rule "${rule.rule_id}"`);
          }
        }
        if (input.value !== undefined) {
          const schema = policiesRepo.getStateSchema(rule.schema_id);
          if (!schema) throw new PolicyDeniedError(`state schema "${rule.schema_id}" is not registered`);
          const problem = validateStateValue(schema, input.value);
          if (problem) throw new ValidationError(`state value rejected: ${problem}`);
        }
        return itemsRepo.upsertOperationalState(
          writeContextFor(ctx, ctx.client.id, ctx.client.namespace),
          {
            stateKey: input.state_key,
            schemaId: input.schema_id,
            title: input.title,
            value: input.value,
            observedAt: input.observed_at,
            expiresAt: input.expires_at,
            status: input.status,
            expectedRevision: input.expected_revision,
          },
          { trustState: 'accepted', acceptanceMethod: 'policy', policyVersion: ctx.policyVersion, ruleId: rule.rule_id },
        );
      },
    );
    return { ...result, replayed };
  }

  function readOperationalState(client: ClientAuth, stateKey: string): ContextItem | null {
    return readAudited(client, 'read.state', client.isAdmin ? null : 'state.read', { state_key: stateKey }, (ctx) => {
      if (ctx.client.isAdmin) {
        throw new ValidationError('admin state reads must go through SQL/CLI; state rules are namespace-scoped');
      }
      const rule = stateRuleFor(ctx.policy!, stateKey);
      if (!rule || !rule.read_clients.includes(ctx.client.id)) {
        throw new PolicyDeniedError(`no state rule allows client "${ctx.client.id}" to read "${stateKey}"`);
      }
      return itemsRepo.getStateByKey(ctx.client.namespace, stateKey);
    });
  }

  /**
   * Build an ephemeral context package from accepted, currently-valid rows.
   * The task text is used for retrieval but never written to audit details or
   * persisted as a context item.
   */
  function compileContext(
    client: ClientAuth,
    opts: {
      intent: string;
      queries?: string[];
      target: ContextTarget;
      tokenBudget: number;
      filters?: Parameters<ItemsRepo['search']>[1]['filters'];
      stateKeys?: string[];
      entities?: string[];
    },
  ) {
    return readAudited(
      client,
      'read.compile_context',
      client.isAdmin ? null : 'memory.read_accepted',
      {
        query_count: 1 + (opts.queries?.length ?? 0),
        target: opts.target,
        token_budget: opts.tokenBudget,
        state_key_count: opts.stateKeys?.length ?? 0,
      },
      (ctx) => {
        if (ctx.client.isAdmin) {
          throw new ValidationError('context compilation requires a namespace-bound client');
        }
        const retrievalQueries = contextRetrievalQueries(opts.intent, opts.queries);
        const found = itemsRepo.search(ctx.access, {
          queries: retrievalQueries,
          filters: { ...opts.filters, statuses: ['active'] },
          limit: 100,
          surface: 'accepted',
          mode: 'hybrid',
          entities: opts.entities,
        });
        const scoreById = new Map(found.items.map((item) => [item.id, item.score]));
        const sourcesById = new Map(found.items.map((item) => [item.id, item.retrieval_sources]));
        const candidates: ContextCandidate[] = found.fullItems.map((item) => ({
          item,
          score: scoreById.get(item.id) ?? 0,
          retrieval_sources: sourcesById.get(item.id) ?? [],
        }));

        for (const stateKey of new Set(opts.stateKeys ?? [])) {
          requireCap(ctx, 'state.read');
          const rule = stateRuleFor(ctx.policy!, stateKey);
          if (!rule || !rule.read_clients.includes(ctx.client.id)) {
            throw new PolicyDeniedError(`no state rule allows client "${ctx.client.id}" to read "${stateKey}"`);
          }
          const item = itemsRepo.getStateByKey(ctx.client.namespace, stateKey);
          if (!item || item.status !== 'active' || (item.expires_at && item.expires_at <= new Date().toISOString())) {
            continue;
          }
          candidates.push({ item, score: 1, retrieval_sources: ['state'] });
        }

        return compileContextPackage({
          namespace: ctx.client.namespace,
          target: opts.target,
          tokenBudget: opts.tokenBudget,
          candidates,
          retrieval: found.retrieval,
        });
      },
    );
  }

  /**
   * Coarse feedback for the memory-quality KPI: did compiled context change
   * the action, and was the result helpful? No prompt, action text, or package
   * content is retained.
   */
  function recordContextOutcome(
    client: ClientAuth,
    input: {
      package_id: string;
      item_ids: string[];
      outcome: 'helpful' | 'mixed' | 'harmful' | 'unknown';
      action_changed: boolean;
    },
    idempotencyKey: string,
  ) {
    const { result, replayed } = runMutation(
      client,
      'write.context_outcome',
      idempotencyKey,
      input,
      {},
      (ctx) => {
        if (ctx.client.isAdmin) {
          throw new ValidationError('context outcome feedback requires a namespace-bound client');
        }
        requireCap(ctx, 'memory.read_accepted');
        const itemIds = [...new Set(input.item_ids)];
        for (const id of itemIds) {
          const item = itemsRepo.get(ctx.access, id);
          if (!item || item.trust_state !== 'accepted') {
            throw new ValidationError(`context item "${id}" does not exist or is not readable`);
          }
        }
        const id = ulid();
        const createdAt = new Date().toISOString();
        db.prepare(
          `INSERT INTO context_outcomes
             (id, package_id, namespace, client_id, outcome, action_changed, item_ids, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id,
          input.package_id,
          ctx.client.namespace,
          ctx.client.id,
          input.outcome,
          input.action_changed ? 1 : 0,
          JSON.stringify(itemIds),
          createdAt,
        );
        return { id, package_id: input.package_id, item_ids: itemIds, created_at: createdAt };
      },
    );
    return { ...result, replayed };
  }

  function softDeleteItem(
    client: ClientAuth,
    itemId: string,
    idempotencyKey: string,
  ): { deleted: boolean; replayed: boolean } {
    const { result, replayed } = runMutation(
      client,
      'write.delete',
      idempotencyKey,
      { itemId },
      { itemId: () => itemId },
      (ctx) => {
        const existing = itemsRepo.get(ctx.access, itemId, { allCandidates: ctx.client.isAdmin });
        if (!existing) throw new NotFoundError(`no item with id "${itemId}"`);
        if (existing.source !== ctx.client.id && !ctx.client.isAdmin) {
          throw new PolicyDeniedError('items can only be deleted by the principal that created them');
        }
        return { deleted: itemsRepo.softDelete(itemId, ctx.client.id) };
      },
    );
    return { ...result, replayed };
  }

  /** True deletion (admin): removes item + versions + reviews + index entry.
   * The audit row keeps metadata only. */
  function purgeItem(client: ClientAuth, itemId: string, idempotencyKey: string): { purged: boolean; replayed: boolean } {
    if (!client.isAdmin) throw new PolicyDeniedError('purge is an admin-only operation');
    const target = itemsRepo.get(accessFor(client), itemId, { allCandidates: true });
    const { result, replayed } = runMutation(
      client,
      'write.purge',
      idempotencyKey,
      { itemId },
      { targetNamespace: target?.namespace ?? '*', itemId: () => itemId },
      () => ({ purged: itemsRepo.purge(itemId) }),
    );
    return { ...result, replayed };
  }

  // ---------- audited read surfaces ----------

  /** Resolve which trust surface a read with include_candidates gets. */
  function surfaceFor(ctx: AuthzContext, includeCandidates: boolean): { surface: TrustSurface; note?: string } {
    if (!includeCandidates) return { surface: 'accepted' };
    if (ctx.client.isAdmin || has(ctx, 'memory.read_all_candidates')) return { surface: 'plus_all' };
    if (has(ctx, 'memory.read_own_candidates')) return { surface: 'plus_own' };
    return {
      surface: 'accepted',
      note: 'include_candidates was requested but this client may not read candidates',
    };
  }

  function search(
    client: ClientAuth,
    opts: Omit<Parameters<ItemsRepo['search']>[1], 'surface'> & { includeCandidates?: boolean },
  ) {
    return readAudited(
      client,
      'read.search',
      client.isAdmin ? null : 'memory.read_accepted',
      {
        query_count: opts.queries.length,
        types: opts.filters?.types ?? null,
        sources: opts.filters?.sources ?? null,
        limit: opts.limit,
        retrieval_mode: opts.mode ?? 'hybrid',
        entity_count: opts.entities?.length ?? 0,
        include_candidates: Boolean(opts.includeCandidates),
      },
      (ctx) => {
        const { surface, note } = surfaceFor(ctx, Boolean(opts.includeCandidates));
        const res = itemsRepo.search(ctx.access, { ...opts, mode: opts.mode ?? 'hybrid', surface });
        return { ...res, note };
      },
    );
  }

  function listItems(
    client: ClientAuth,
    opts: Omit<Parameters<ItemsRepo['list']>[1], 'surface'> & { includeCandidates?: boolean },
  ) {
    return readAudited(
      client,
      'read.list',
      client.isAdmin ? null : 'memory.read_accepted',
      {
        types: opts.filters?.types ?? null,
        sources: opts.filters?.sources ?? null,
        limit: opts.limit,
        include_candidates: Boolean(opts.includeCandidates),
      },
      (ctx) => {
        const { surface, note } = surfaceFor(ctx, Boolean(opts.includeCandidates));
        const res = itemsRepo.list(ctx.access, { ...opts, surface });
        return { ...res, note };
      },
    );
  }

  function getItem(client: ClientAuth, id: string): ContextItem | null {
    return readAudited(client, 'read.get', client.isAdmin ? null : 'memory.read_accepted', { item_id: id }, (ctx) => {
      const item = itemsRepo.get(ctx.access, id, {
        allCandidates: ctx.client.isAdmin || has(ctx, 'memory.read_all_candidates'),
      });
      if (!item) return null;
      if (
        item.trust_state === 'candidate' &&
        !ctx.client.isAdmin &&
        item.source === ctx.client.id &&
        !has(ctx, 'memory.read_own_candidates') &&
        !has(ctx, 'memory.read_all_candidates')
      ) {
        return null;
      }
      return item;
    });
  }

  function getHistory(client: ClientAuth, id: string) {
    return readAudited(client, 'read.history', client.isAdmin ? null : 'memory.read_accepted', { item_id: id }, (ctx) =>
      itemsRepo.history(ctx.access, id, {
        allCandidates: ctx.client.isAdmin || has(ctx, 'memory.read_all_candidates'),
      }),
    );
  }

  function listCandidates(client: ClientAuth, scope: 'my' | 'inbox', limit: number) {
    const cap: Capability = scope === 'inbox' ? 'memory.read_all_candidates' : 'memory.read_own_candidates';
    return readAudited(client, 'read.candidates', client.isAdmin ? null : cap, { scope, limit }, (ctx) =>
      itemsRepo.listCandidates(ctx.access, scope === 'inbox' ? 'inbox' : 'own_candidates', limit),
    );
  }

  function brief(client: ClientAuth, opts: Parameters<ItemsRepo['brief']>[1]) {
    return readAudited(client, 'read.brief', client.isAdmin ? null : 'memory.read_accepted', { days: opts.days }, (ctx) =>
      itemsRepo.brief(ctx.access, opts),
    );
  }

  function currentContext(client: ClientAuth, opts: Parameters<ItemsRepo['currentContext']>[1]) {
    return readAudited(client, 'read.current', client.isAdmin ? null : 'memory.read_accepted', {}, (ctx) =>
      itemsRepo.currentContext(ctx.access, opts),
    );
  }

  function recent(
    client: ClientAuth,
    opts: Omit<Parameters<ItemsRepo['list']>[1], 'surface'> & { includeCandidates?: boolean; days: number },
  ) {
    return readAudited(
      client,
      'read.recent',
      client.isAdmin ? null : 'memory.read_accepted',
      { days: opts.days, limit: opts.limit },
      (ctx) => {
        const { surface, note } = surfaceFor(ctx, Boolean(opts.includeCandidates));
        const res = itemsRepo.list(ctx.access, { ...opts, surface });
        return { ...res, note };
      },
    );
  }

  function sourcesOverview(client: ClientAuth) {
    return readAudited(client, 'read.sources', client.isAdmin ? null : 'memory.read_accepted', {}, (ctx) =>
      itemsRepo.sourcesOverview(ctx.access),
    );
  }

  function queryAudit(client: ClientAuth, opts: { namespace?: string; limit?: number; beforeId?: number }) {
    return readAudited(
      client,
      'read.audit',
      client.isAdmin ? null : 'audit.read',
      { namespace: opts.namespace ?? null, limit: opts.limit ?? null },
      (ctx) => {
        // Non-admin audit readers are pinned to their own namespace.
        const namespace = ctx.client.isAdmin ? opts.namespace : ctx.client.namespace;
        return auditRepo.query({ ...opts, namespace });
      },
    );
  }

  // ---------- administration (audited) ----------

  function requirePolicyManage(client: ClientAuth, namespace: string): AuthzContext {
    const ctx = resolveAuthz(client);
    if (!client.isAdmin) {
      requireCap(ctx, 'policy.manage');
      if (client.namespace !== namespace) {
        throw new PolicyDeniedError('policy.manage is namespace-scoped: you may only manage your own namespace');
      }
    }
    return ctx;
  }

  function applyPolicy(client: ClientAuth, namespace: string, rules: unknown): { namespace: string; version: number } {
    try {
      requirePolicyManage(client, namespace);
      const current = policiesRepo.apply(namespace, rules, client.id);
      auditRepo.log({
        namespace,
        clientId: client.id,
        action: 'admin.policy_apply',
        outcome: 'allow',
        details: { version: current.version },
      });
      return { namespace, version: current.version };
    } catch (err) {
      if (err instanceof PolicyDeniedError) {
        auditRepo.logDenySafe({ namespace, clientId: client.id, action: 'admin.policy_apply', details: { reason: 'policy_denied' } });
      }
      throw err;
    }
  }

  function getPolicy(client: ClientAuth, namespace: string) {
    const ctx = resolveAuthz(client);
    if (!client.isAdmin) {
      requireCap(ctx, 'policy.manage');
      if (client.namespace !== namespace) {
        throw new PolicyDeniedError('policy.manage is namespace-scoped: you may only view your own namespace policy');
      }
    }
    auditRepo.log({ namespace, clientId: client.id, action: 'read.policy', outcome: 'allow' });
    const current = policiesRepo.getCurrent(namespace);
    return current
      ? { namespace, version: current.version, rules: current.policy, history: policiesRepo.history(namespace) }
      : null;
  }

  /**
   * Client onboarding. Optionally applies a grant profile in the same call —
   * the grant is still an explicit, versioned policy change (audited), just
   * not a separate manual step.
   */
  function adminCreateClient(
    client: ClientAuth,
    input: Parameters<ClientsRepo['create']>[0] & { profile?: GrantProfile },
  ) {
    if (!client.isAdmin) throw new PolicyDeniedError('client management requires the admin token');
    const { profile, ...clientInput } = input;
    const created = clientsRepo.create(clientInput);
    policiesRepo.invalidate(clientInput.namespace);
    auditRepo.log({
      namespace: clientInput.namespace,
      clientId: client.id,
      action: 'admin.client_create',
      outcome: 'allow',
      details: { new_client: created.client.id, principal_kind: created.client.principal_kind, profile: profile ?? 'none' },
    });
    if (profile && profile !== 'none') {
      const current = policiesRepo.getCurrent(clientInput.namespace);
      if (!current) {
        throw new ValidationError(
          `namespace "${clientInput.namespace}" has no valid current policy — fix the policy before granting profiles`,
        );
      }
      const p = profileFor(profile, created.client.id);
      const next: PolicyV1 = {
        ...current.policy,
        grants: [...current.policy.grants.filter((g) => g.client_id !== created.client.id), p.grant],
        create_rules: [
          ...current.policy.create_rules.filter((r) => r.client_id !== created.client.id),
          ...p.create_rules,
        ],
      };
      applyPolicy(client, clientInput.namespace, next);
    }
    return created;
  }

  function adminRotateKey(client: ClientAuth, id: string) {
    if (!client.isAdmin) throw new PolicyDeniedError('key rotation requires the admin token');
    const rotated = clientsRepo.rotateKey(id);
    auditRepo.log({
      namespace: rotated.client.namespace,
      clientId: client.id,
      action: 'admin.client_rotate',
      outcome: 'allow',
      details: { target: id, credential_version: rotated.client.credential_version },
    });
    return rotated;
  }

  function adminSetDisabled(client: ClientAuth, id: string, disabled: boolean): boolean {
    if (!client.isAdmin) throw new PolicyDeniedError('client management requires the admin token');
    const target = clientsRepo.get(id);
    const ok = clientsRepo.setDisabled(id, disabled);
    if (ok) {
      policiesRepo.invalidate(target?.namespace);
      auditRepo.log({
        namespace: target?.namespace ?? '*',
        clientId: client.id,
        action: 'admin.client_disable',
        outcome: 'allow',
        details: { target: id, disabled },
      });
    }
    return ok;
  }

  function adminCreateNamespace(client: ClientAuth, id: string, description?: string): void {
    if (!client.isAdmin) throw new PolicyDeniedError('namespace management requires the admin token');
    clientsRepo.createNamespace(id, description);
    // New namespaces start with an empty deny-by-default policy so they are
    // immediately valid (fail-closed would otherwise brick them) but grant nothing.
    policiesRepo.apply(
      id,
      { schema_version: 1, namespace_mode: 'work', grants: [], create_rules: [], state_rules: [] },
      client.id,
    );
    auditRepo.log({ namespace: id, clientId: client.id, action: 'admin.namespace_create', outcome: 'allow' });
  }

  function adminRegisterStateSchema(client: ClientAuth, schemaId: string, schema: unknown) {
    if (!client.isAdmin) throw new PolicyDeniedError('state schema registration requires the admin token');
    const registered = policiesRepo.registerStateSchema(schemaId, schema);
    auditRepo.log({
      namespace: '*',
      clientId: client.id,
      action: 'admin.schema_register',
      outcome: 'allow',
      details: { schema_id: schemaId },
    });
    return registered;
  }

  /** Retention: idempotency records expire after `days` (default 90, ADR-001). */
  function idempotencyGc(days = 90): number {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    const res = db.prepare('DELETE FROM idempotency_records WHERE created_at < ?').run(cutoff);
    return res.changes;
  }

  return {
    resolveAuthz,
    createMemory,
    createMemoryBatch,
    patchProjection,
    reviseCandidate,
    proposeSuccessor,
    reviewMemory,
    operateTask,
    curateNote,
    updateOperationalState,
    readOperationalState,
    compileContext,
    recordContextOutcome,
    softDeleteItem,
    purgeItem,
    search,
    listItems,
    getItem,
    getHistory,
    listCandidates,
    brief,
    currentContext,
    recent,
    sourcesOverview,
    queryAudit,
    applyPolicy,
    getPolicy,
    adminCreateClient,
    adminRotateKey,
    adminSetDisabled,
    adminCreateNamespace,
    adminRegisterStateSchema,
    idempotencyGc,
  };
}
