import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AppDeps } from '../http/server.js';
import { toCompact } from '../core/items-repo.js';
import {
  AuditUnavailableError,
  IdempotencyConflictError,
  NotFoundError,
  PolicyDeniedError,
  RevisionConflictError,
  SourceItemConflictError,
  ValidationError,
} from '../core/errors.js';
import {
  DECAY_POLICIES,
  MEMORY_KINDS,
  newItemSchema,
  STATUSES,
  type ClientAuth,
} from '../core/types.js';
import { CONTEXT_TARGETS } from '../core/context-compiler.js';
import { sourcesView } from '../http/routes/sources.js';

export type McpDeps = Pick<AppDeps, 'commands' | 'clientsRepo'>;

function jsonResult(payload: unknown) {
  const structuredContent =
    typeof payload === 'object' && payload !== null && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : { value: payload };
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
    structuredContent,
  };
}

function errorResult(message: string) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
    structuredContent: { error: message },
    isError: true,
  };
}

function normalizeIso(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

function isDomainError(err: unknown): err is Error {
  return (
    err instanceof ValidationError ||
    err instanceof NotFoundError ||
    err instanceof PolicyDeniedError ||
    err instanceof SourceItemConflictError ||
    err instanceof RevisionConflictError ||
    err instanceof IdempotencyConflictError ||
    err instanceof AuditUnavailableError
  );
}

/**
 * Builds a per-request MCP server bound to the authenticated client. The MCP
 * connection itself is the namespace boundary: this credential reads and
 * writes ONLY its own namespace, and every call is policy-checked and audited
 * server-side — tool arguments are intents, never authorizations.
 */
export function buildMcpServer(deps: McpDeps, client: ClientAuth): McpServer {
  const { commands } = deps;
  const workGovernance =
    client.namespace === 'work'
      ? ' In work, save only extracted summaries, tasks, decisions, and work preferences; never store raw email, chat, meeting transcripts, PII, customer data, undisclosed financials, or confidential technical details.'
      : '';
  const server = new McpServer(
    { name: 'contexthub', version: '0.5.0' },
    {
      instructions:
        `ContextHub is the context control plane for namespace "${client.namespace}": source projections and durable memory remain persistent; compiled context is ephemeral. ` +
        'Before user-specific planning, call compile_context for a task-specific package, get_context_brief, or search_context. ' +
        'Treat only accepted items as shared facts; candidates are unreviewed proposals. ' +
        'Do not save transient conversation details. Every mutation needs a fresh UUID idempotency_key; ' +
        `reuse a key only when retrying the same logical operation.${workGovernance}`,
    },
  );

  const canRead = client.scopes.includes('read');
  const canWrite = client.scopes.includes('write');

  function guarded<T extends Record<string, unknown>>(fn: (args: T) => unknown) {
    return async (args: T) => {
      try {
        return jsonResult(fn(args));
      } catch (err) {
        if (isDomainError(err)) return errorResult(err.message);
        throw err;
      }
    };
  }

  /**
   * include_private is an intent — real authorization is the server-side
   * max_sensitivity ceiling (the repo clamps regardless; this only produces
   * the explanatory note).
   */
  function resolveSensitivity(includePrivate: boolean): { sensitivity: 'normal' | 'all'; note?: string } {
    if (!includePrivate) return { sensitivity: 'normal' };
    if (client.maxSensitivity === 'private') return { sensitivity: 'all' };
    return {
      sensitivity: 'normal',
      note: 'include_private was requested but this client is not authorized for private items',
    };
  }

  // ---------------- read surfaces ----------------

  server.registerTool(
    'search_context',
    {
      title: 'Search cross-app context',
      description:
        "Hybrid lexical, local-vector, and entity search over this namespace of the user's memory hub. Call this BEFORE planning or answering questions about the user's life, schedule, money, people, or work. Pass an array of queries to search several angles in ONE call (weighted rank-fusion merged). Results carry provenance, trust_state, and retrieval_sources. Unreviewed candidates are EXCLUDED by default. Use get_context_item for the full record.",
      inputSchema: {
        query: z
          .union([z.string(), z.array(z.string()).min(1).max(10)])
          .describe('Search query, or up to 10 queries to merge in one call (e.g. ["財務規劃", "報稅"])'),
        types: z.array(z.string()).optional().describe('Filter by item types, e.g. ["transaction","event"]'),
        sources: z.array(z.string()).optional().describe('Filter by source client ids (see list_context_sources)'),
        tags: z.array(z.string()).optional().describe('Only items carrying ALL of these tags'),
        entities: z.array(z.string()).optional().describe('Boost exact/partial structured entity matches'),
        entity_filters: z
          .array(z.string().min(1).max(200))
          .optional()
          .describe('Exact canonical entities to require, e.g. ["project:contexthub"]'),
        information_classes: z
          .array(z.enum(['source', 'memory', 'task_state']))
          .optional()
          .describe('Hard filter for persistent information role'),
        memory_kinds: z
          .array(z.enum(MEMORY_KINDS))
          .optional()
          .describe('Hard filter for reusable memory semantics'),
        mode: z.enum(['hybrid', 'lexical']).default('hybrid'),
        since: z.string().optional().describe('Only items on/after this ISO 8601 datetime'),
        until: z.string().optional().describe('Only items on/before this ISO 8601 datetime'),
        limit: z.number().int().min(1).max(50).default(10),
        include_private: z
          .boolean()
          .default(false)
          .describe('Request private items too. Honored only if this client is authorized server-side.'),
        include_candidates: z
          .boolean()
          .default(false)
          .describe('Also return your own UNREVIEWED candidates. For self-auditing — do not treat them as facts.'),
      },
    },
    guarded((args: any) => {
      if (!canRead) throw new PolicyDeniedError('this API key lacks the "read" scope');
      const queries = typeof args.query === 'string' ? [args.query] : args.query;
      const { sensitivity, note: privacyNote } = resolveSensitivity(args.include_private);
      const { items, totalMatched, retrieval, note } = commands.search(client, {
        queries,
        filters: {
          types: args.types,
          sources: args.sources,
          tags: args.tags,
          information_classes: args.information_classes,
          memory_kinds: args.memory_kinds,
          entity_filters: args.entity_filters,
          since: normalizeIso(args.since),
          until: normalizeIso(args.until),
          sensitivity,
        },
        limit: args.limit,
        mode: args.mode,
        entities: args.entities,
        includeCandidates: args.include_candidates,
      });
      return {
        total_matched: totalMatched,
        returned: items.length,
        retrieval,
        note: [privacyNote, note].filter(Boolean).join('; ') || undefined,
        hint:
          totalMatched > items.length
            ? 'More items matched than returned; narrow with types/sources/tags/since instead of paging.'
            : undefined,
        items,
      };
    }),
  );

  server.registerTool(
    'get_current_context',
    {
      title: 'Current state of the user',
      description:
        'What is true for the user RIGHT NOW in this namespace: active tasks (nearest deadline first), future events, latest durable states/facts/preferences/memories, and accepted insights — all trust_state=accepted only. Your own unreviewed candidates appear only as a count. Use when planning or prioritizing; search_context covers history.',
      inputSchema: {
        per_section: z.number().int().min(1).max(25).default(10),
        include_private: z.boolean().default(false),
      },
    },
    guarded((args: any) => {
      if (!canRead) throw new PolicyDeniedError('this API key lacks the "read" scope');
      const { sensitivity, note } = resolveSensitivity(args.include_private);
      return { note, ...commands.currentContext(client, { sensitivity, perSection: args.per_section }) };
    }),
  );

  server.registerTool(
    'curation_suggestions',
    {
      title: 'Find memory hygiene suggestions',
      description:
        'Read-only suggestions for duplicate, conflicting, stale, or expired working_state memories. Suggestions never mutate accepted memory; use human review and successor workflows to act on them.',
      inputSchema: {
        limit: z.number().int().min(1).max(100).default(50),
      },
    },
    guarded((args: any) => {
      if (!canRead) throw new PolicyDeniedError('this API key lacks the "read" scope');
      return { suggestions: commands.curationSuggestions(client, args.limit) };
    }),
  );

  server.registerTool(
    'get_recent_context',
    {
      title: 'Recent context timeline',
      description:
        "Chronological timeline of what recently happened in this namespace (most recent first). Use to catch up without a specific search term. For 'what is true now' prefer get_current_context; for a structured digest prefer get_context_brief.",
      inputSchema: {
        days: z.number().int().min(1).max(365).default(7).describe('Look-back window in days'),
        sources: z.array(z.string()).optional(),
        types: z.array(z.string()).optional(),
        limit: z.number().int().min(1).max(100).default(20),
        include_private: z.boolean().default(false),
        include_candidates: z.boolean().default(false),
      },
    },
    guarded((args: any) => {
      if (!canRead) throw new PolicyDeniedError('this API key lacks the "read" scope');
      const since = new Date(Date.now() - args.days * 86_400_000).toISOString();
      const { sensitivity, note: privacyNote } = resolveSensitivity(args.include_private);
      const { items, nextCursor, note } = commands.recent(client, {
        days: args.days,
        filters: {
          sources: args.sources,
          types: args.types,
          since,
          sensitivity,
        },
        limit: args.limit,
        sort: 'occurred',
        includeCandidates: args.include_candidates,
      });
      return {
        window_days: args.days,
        returned: items.length,
        has_more: Boolean(nextCursor),
        note: [privacyNote, note].filter(Boolean).join('; ') || undefined,
        items: items.map((it) => toCompact(it)),
      };
    }),
  );

  server.registerTool(
    'get_context_item',
    {
      title: 'Get full context item',
      description:
        'Fetch one item in full — content, data payload, provenance (authority, evidence), trust_state, acceptance metadata, supersession links, review verdict. Your own rejected proposals are fetchable by id, including the review_note explaining why.',
      inputSchema: {
        id: z.string().describe('Item id from a previous search/timeline result'),
      },
    },
    guarded((args: any) => {
      if (!canRead) throw new PolicyDeniedError('this API key lacks the "read" scope');
      const item = commands.getItem(client, args.id);
      if (!item) throw new NotFoundError(`no item with id "${args.id}"`);
      return { item };
    }),
  );

  server.registerTool(
    'get_memory_history',
    {
      title: 'Version history of a memory',
      description:
        'Full audit trail of one item: every version snapshot (who changed what, when) and every review/adjudication event. Use to understand how a memory evolved or why it was accepted/rejected/superseded.',
      inputSchema: {
        id: z.string().describe('Item id'),
      },
    },
    guarded((args: any) => {
      if (!canRead) throw new PolicyDeniedError('this API key lacks the "read" scope');
      const history = commands.getHistory(client, args.id);
      if (!history) throw new NotFoundError(`no item with id "${args.id}"`);
      return history;
    }),
  );

  server.registerTool(
    'my_candidates',
    {
      title: 'Your pending proposals',
      description:
        'Lists YOUR memories still waiting for review (trust_state=candidate). They are invisible to every other reader until accepted. Use to avoid duplicate proposals and to refresh stale ones (revise_my_candidate).',
      inputSchema: {
        limit: z.number().int().min(1).max(100).default(20),
      },
    },
    guarded((args: any) => {
      if (!canRead) throw new PolicyDeniedError('this API key lacks the "read" scope');
      const items = commands.listCandidates(client, 'my', args.limit);
      return { returned: items.length, items: items.map((it) => toCompact(it)) };
    }),
  );

  server.registerTool(
    'list_context_sources',
    {
      title: 'List context sources',
      description:
        'Lists every client feeding THIS namespace that you are authorized to read, with item counts per type and last activity. Call on first contact with the hub.',
      inputSchema: {},
    },
    guarded(() => {
      if (!canRead) throw new PolicyDeniedError('this API key lacks the "read" scope');
      return { sources: sourcesView(deps, client) };
    }),
  );

  server.registerTool(
    'get_context_brief',
    {
      title: 'Cross-source situational brief',
      description:
        "One-call digest of the user's recent situation in this namespace: latest highlights per source plus stats, optionally weighted toward a focus topic. Deterministic aggregation (no hidden LLM). Call ONCE at the start of planning work.",
      inputSchema: {
        days: z.number().int().min(1).max(90).default(14),
        focus: z.string().optional().describe('Optional topic keyword(s); adds a focused search section'),
        include_private: z.boolean().default(false),
      },
    },
    guarded((args: any) => {
      if (!canRead) throw new PolicyDeniedError('this API key lacks the "read" scope');
      const { sensitivity, note } = resolveSensitivity(args.include_private);
      const brief = commands.brief(client, { days: args.days, focus: args.focus, sensitivity });
      return note ? { note, ...brief } : brief;
    }),
  );

  server.registerTool(
    'compile_context',
    {
      title: 'Compile task-specific context',
      description:
        'Build an EPHEMERAL, token-budgeted context package for one task from accepted source projections, durable memories, and explicitly authorized operational state. The package is filtered by namespace, ACL, sensitivity, validity, lifecycle, relevance, freshness, authority, and deduplication. It is not stored as memory. Use the returned rendered_context as model input and package_id for optional outcome feedback.',
      inputSchema: {
        intent: z.string().min(1).max(10_000).describe('The task or decision this context must support'),
        queries: z.array(z.string().min(1).max(1000)).max(5).optional(),
        entities: z.array(z.string().min(1).max(200)).max(50).optional(),
        target_agent: z.enum(CONTEXT_TARGETS).default('generic'),
        token_budget: z.number().int().min(256).max(32_000).default(4000),
        sources: z.array(z.string()).max(50).optional(),
        types: z.array(z.string()).max(50).optional(),
        tags: z.array(z.string()).max(50).optional(),
        information_classes: z.array(z.enum(['source', 'memory', 'task_state'])).max(3).optional(),
        memory_kinds: z.array(z.enum(MEMORY_KINDS)).max(MEMORY_KINDS.length).optional(),
        entity_filters: z.array(z.string().min(1).max(200)).max(50).optional(),
        state_keys: z
          .array(z.string().min(1).max(200))
          .max(20)
          .optional()
          .describe('Exact operational state keys; each still requires a matching state read rule'),
        include_private: z.boolean().default(false),
      },
    },
    guarded((args: any) => {
      if (!canRead) throw new PolicyDeniedError('this API key lacks the "read" scope');
      const { sensitivity, note } = resolveSensitivity(args.include_private);
      const contextPackage = commands.compileContext(client, {
        intent: args.intent,
        queries: args.queries,
        target: args.target_agent,
        tokenBudget: args.token_budget,
        filters: {
          sources: args.sources,
          types: args.types,
          tags: args.tags,
          information_classes: args.information_classes,
          memory_kinds: args.memory_kinds,
          entity_filters: args.entity_filters,
          sensitivity,
        },
        stateKeys: args.state_keys,
        entities: args.entities,
      });
      return note ? { note, ...contextPackage } : contextPackage;
    }),
  );

  // ---------------- memory lifecycle ----------------

  const saveMemoryShape = {
    type: z
      .string()
      .min(1)
      .max(64)
      .describe(
        'Policy-controlled item type: fact/preference/contact/state/memory for durable knowledge, insight for reviewed inferences, task for follow-ups, note for free text. memory_kind separately describes reusable memory semantics.',
      ),
    title: z.string().min(1).max(500).describe('Short one-line summary'),
    content: z.string().max(50_000).default('').describe('Full detail, plain text or markdown'),
    data: z.unknown().optional().describe('Optional structured JSON payload'),
    tags: z.array(z.string()).max(50).default([]),
    entities: z
      .array(z.string())
      .max(50)
      .default([])
      .describe('Related entities as "kind:name", e.g. ["person:王小明", "project:Q3-report"]'),
    confidence: z.number().min(0).max(1).optional().describe('How sure you are (insights)'),
    memory_kind: z
      .enum(MEMORY_KINDS)
      .describe('Required reusable semantics: fact/preference/decision/experience/procedure/relationship/working_state.'),
    derived_from: z
      .array(z.string())
      .max(20)
      .default([])
      .describe('Insights only: ids of the NON-insight items this inference is based on'),
    occurred_at: z.string().optional().describe('When the underlying event happened (ISO 8601)'),
    expires_at: z.string().optional().describe('Optional TTL (ISO 8601)'),
    valid_from: z.string().optional().describe('When this assertion starts being valid (ISO 8601)'),
    valid_until: z.string().optional().describe('When this assertion stops being valid (ISO 8601)'),
    last_verified_at: z.string().optional().describe('Last explicit verification time (ISO 8601)'),
    decay_policy: z.enum(DECAY_POLICIES).optional().describe('none, standard, or rapid relevance decay'),
    sensitivity: z.enum(['normal', 'private']).default('normal'),
    status: z.enum(STATUSES).default('active'),
    source_item_id: z
      .string()
      .optional()
      .describe('Stable key: reuse it to refresh YOUR still-unreviewed candidate in place'),
    idempotency_key: z
      .string()
      .min(1)
      .max(200)
      .describe('REQUIRED: a UUID you generate per logical write; retries with the same key are safe'),
  };

  server.registerTool(
    'save_memory',
    {
      title: 'Save a memory',
      description:
        `Write a durable memory into the hub (recorded as source "${client.id}", provenance authority=${client.principalKind === 'agent' ? 'agent' : 'user/app'}). Depending on namespace policy your write starts as trust_state=candidate — INVISIBLE to other readers until the owner reviews it — or accepted. Save things worth remembering across sessions: stable user preferences, durable facts, project context, follow-up tasks. Do NOT store transient conversation details. Generate a fresh UUID idempotency_key per logical memory; reuse source_item_id to refresh a still-unreviewed candidate.`,
      inputSchema: saveMemoryShape,
    },
    guarded((args: any) => {
      if (!canWrite) throw new PolicyDeniedError('this API key lacks the "write" scope');
      const parsed = newItemSchema.safeParse(args);
      if (!parsed.success) throw new ValidationError(parsed.error.message);
      const { item, created, replayed } = commands.createMemory(client, parsed.data);
      return {
        item_id: item.id,
        created,
        replayed,
        revision: item.revision,
        trust_state: item.trust_state,
        sensitivity: item.sensitivity,
        note:
          item.trust_state === 'candidate'
            ? 'saved as a candidate — invisible to other readers until the owner accepts it'
            : undefined,
      };
    }),
  );

  server.registerTool(
    'propose_insight',
    {
      title: 'Propose an insight',
      description:
        `Propose a durable conclusion you inferred (source "${client.id}", authority=agent, trust_state=candidate). Candidates are INVISIBLE to normal reads until a human reviewer accepts them, so write to be reviewed: honest confidence, and cite the NON-insight items your inference rests on via derived_from. Private evidence makes the proposal private. Once reviewed it is immutable — propose anew or use propose_successor.`,
      inputSchema: saveMemoryShape,
    },
    guarded((args: any) => {
      if (!canWrite) throw new PolicyDeniedError('this API key lacks the "write" scope');
      const parsed = newItemSchema.safeParse({ ...args, type: 'insight' });
      if (!parsed.success) throw new ValidationError(parsed.error.message);
      const { item, created, replayed } = commands.createMemory(client, parsed.data);
      return {
        item_id: item.id,
        created,
        replayed,
        revision: item.revision,
        trust_state: item.trust_state,
        sensitivity: item.sensitivity,
      };
    }),
  );

  server.registerTool(
    'revise_my_candidate',
    {
      title: 'Revise your pending proposal',
      description:
        'Update YOUR still-unreviewed candidate in place (title/content/data/tags/confidence). Requires expected_revision from a fresh read. Once reviewed, items are immutable — use propose_successor instead.',
      inputSchema: {
        id: z.string(),
        title: z.string().min(1).max(500).optional(),
        content: z.string().max(50_000).optional(),
        data: z.unknown().optional(),
        tags: z.array(z.string()).max(50).optional(),
        confidence: z.number().min(0).max(1).optional(),
        expected_revision: z.number().int().min(1),
        idempotency_key: z.string().min(1).max(200),
      },
    },
    guarded((args: any) => {
      if (!canWrite) throw new PolicyDeniedError('this API key lacks the "write" scope');
      const { id, idempotency_key, ...patch } = args;
      const { item } = commands.reviseCandidate(client, id, patch, idempotency_key);
      return { item_id: item.id, revision: item.revision, trust_state: item.trust_state };
    }),
  );

  server.registerTool(
    'propose_successor',
    {
      title: 'Propose replacing an accepted memory',
      description:
        'When an ACCEPTED memory is outdated or wrong, propose its replacement. The successor starts as a candidate; if the owner accepts it, the old memory is atomically marked superseded (single-winner conflict adjudication, recorded in the hub). The predecessor stays current until then.',
      inputSchema: {
        predecessor_id: z.string().describe('Id of the accepted item to replace'),
        ...saveMemoryShape,
      },
    },
    guarded((args: any) => {
      if (!canWrite) throw new PolicyDeniedError('this API key lacks the "write" scope');
      const { predecessor_id, ...rest } = args;
      const parsed = newItemSchema.safeParse(rest);
      if (!parsed.success) throw new ValidationError(parsed.error.message);
      const { item, created, replayed } = commands.proposeSuccessor(client, predecessor_id, parsed.data);
      return {
        item_id: item.id,
        created,
        replayed,
        successor_of: item.successor_of,
        trust_state: item.trust_state,
        note: 'candidate successor — the predecessor stays current until the owner accepts',
      };
    }),
  );

  server.registerTool(
    'operate_task',
    {
      title: 'Operate on a task',
      description:
        'Typed task operations: set_status / set_progress / set_blocked / complete_checklist_item (and, if granted, set_due_date / set_priority / set_assignee / set_dependencies). Semantic fields (title, description, goal) are immutable here — propose a successor to change what the task MEANS. Requires expected_revision.',
      inputSchema: {
        id: z.string(),
        kind: z.enum([
          'set_status',
          'set_progress',
          'set_blocked',
          'complete_checklist_item',
          'set_due_date',
          'set_priority',
          'set_assignee',
          'set_dependencies',
        ]),
        status: z.enum(STATUSES).optional(),
        progress: z.number().min(0).max(100).optional(),
        blocked_reason: z.string().max(2000).nullable().optional(),
        checklist_index: z.number().int().min(0).optional(),
        due_date: z.string().nullable().optional(),
        priority: z.enum(['low', 'medium', 'high']).nullable().optional(),
        assignee: z.string().max(200).nullable().optional(),
        dependencies: z.array(z.string()).max(50).optional(),
        expected_revision: z.number().int().min(1),
        idempotency_key: z.string().min(1).max(200),
      },
    },
    guarded((args: any) => {
      if (!canWrite) throw new PolicyDeniedError('this API key lacks the "write" scope');
      const { id, idempotency_key, due_date, ...action } = args;
      const { item } = commands.operateTask(
        client,
        id,
        { ...action, due_date: due_date === undefined ? undefined : normalizeIso(due_date ?? undefined) ?? null },
        idempotency_key,
      );
      return { item_id: item.id, revision: item.revision, status: item.status, data: item.data };
    }),
  );

  server.registerTool(
    'curate_note',
    {
      title: 'Curate a note',
      description:
        'Organize a note WITHOUT touching its content: tags, collection, archived flag, related item links. Note content is immutable for other clients — only curation fields are reachable here.',
      inputSchema: {
        id: z.string(),
        tags: z.array(z.string()).max(50).optional(),
        collection: z.string().max(200).nullable().optional(),
        archived: z.boolean().optional(),
        related_item_ids: z.array(z.string()).max(50).optional(),
        expected_revision: z.number().int().min(1),
        idempotency_key: z.string().min(1).max(200),
      },
    },
    guarded((args: any) => {
      if (!canWrite) throw new PolicyDeniedError('this API key lacks the "write" scope');
      const { id, idempotency_key, ...curate } = args;
      const { item } = commands.curateNote(client, id, curate, idempotency_key);
      return { item_id: item.id, revision: item.revision, status: item.status, tags: item.tags };
    }),
  );

  server.registerTool(
    'update_operational_state',
    {
      title: 'Update an operational state slot',
      description:
        'Write a machine-updated state slot (e.g. a budget gauge). Requires an EXACT state_key rule in the namespace policy naming you as a writer, the matching schema_id, and a schema-valid value. These slots live outside search — read them back with get_operational_state.',
      inputSchema: {
        state_key: z.string().min(1).max(200),
        schema_id: z.string().min(1).max(100),
        title: z.string().max(500).optional().describe('Display title (first write only)'),
        value: z.unknown().optional(),
        observed_at: z.string().nullable().optional(),
        expires_at: z.string().nullable().optional(),
        status: z.enum(STATUSES).optional(),
        expected_revision: z.number().int().min(1).optional().describe('Required when the slot already exists'),
        idempotency_key: z.string().min(1).max(200),
      },
    },
    guarded((args: any) => {
      if (!canWrite) throw new PolicyDeniedError('this API key lacks the "write" scope');
      const { idempotency_key, ...input } = args;
      const { item, created } = commands.updateOperationalState(client, input, idempotency_key);
      return { item_id: item.id, state_key: item.state_key, revision: item.revision, created };
    }),
  );

  server.registerTool(
    'get_operational_state',
    {
      title: 'Read an operational state slot',
      description:
        'Read a machine-updated state slot by exact key. Requires a state rule naming you as a reader.',
      inputSchema: {
        state_key: z.string().min(1).max(200),
      },
    },
    guarded((args: any) => {
      if (!canRead) throw new PolicyDeniedError('this API key lacks the "read" scope');
      const item = commands.readOperationalState(client, args.state_key);
      if (!item) throw new NotFoundError(`no state slot "${args.state_key}"`);
      return { item };
    }),
  );

  server.registerTool(
    'record_context_outcome',
    {
      title: 'Record whether context changed the action',
      description:
        'Record coarse effectiveness feedback for a compiled context package: whether it changed the agent action and whether the result was helpful. Only package/item ids and coarse labels are stored — never prompts, action text, or package contents.',
      inputSchema: {
        package_id: z.string().min(1).max(100),
        item_ids: z.array(z.string().min(1)).max(50).default([]),
        outcome: z.enum(['helpful', 'mixed', 'harmful', 'unknown']),
        action_changed: z.boolean(),
        idempotency_key: z.string().min(1).max(200),
      },
    },
    guarded((args: any) => {
      if (!canWrite) throw new PolicyDeniedError('this API key lacks the "write" scope');
      const { idempotency_key, ...input } = args;
      return commands.recordContextOutcome(client, input, idempotency_key);
    }),
  );

  return server;
}
