import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ClientsRepo } from '../core/clients-repo.js';
import type { ItemsRepo } from '../core/items-repo.js';
import { toCompact } from '../core/items-repo.js';
import { RevisionConflictError, SourceItemConflictError, ValidationError } from '../core/errors.js';
import {
  accessFor,
  newItemSchema,
  type ClientAuth,
  type ListFilters,
  type SensitivityFilter,
} from '../core/types.js';
import { sourcesView } from '../http/routes/sources.js';

export interface McpDeps {
  itemsRepo: ItemsRepo;
  clientsRepo: ClientsRepo;
}

function jsonResult(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
}

function errorResult(message: string) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }], isError: true };
}

function normalizeIso(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/**
 * Builds a per-request MCP server bound to the authenticated agent client.
 * Tool descriptions are written for the consuming LLM: they say when to call
 * the tool, not just what it does.
 */
export function buildMcpServer(deps: McpDeps, client: ClientAuth): McpServer {
  const { itemsRepo } = deps;
  const server = new McpServer({ name: 'contexthub', version: '0.1.0' });
  const access = accessFor(client);

  const canRead = client.scopes.includes('read');
  const canWrite = client.scopes.includes('write');

  /**
   * include_private in tool args is only an intent — actual access is decided
   * server-side by the client's max_sensitivity policy (and the repo clamps
   * again regardless of what is passed here).
   */
  function resolveSensitivity(includePrivate: boolean): { sensitivity: SensitivityFilter; note?: string } {
    if (!includePrivate) return { sensitivity: 'normal' };
    if (client.maxSensitivity === 'private') return { sensitivity: 'all' };
    return {
      sensitivity: 'normal',
      note: 'include_private was requested but this client is not authorized for private items',
    };
  }

  server.registerTool(
    'search_context',
    {
      title: 'Search cross-app context',
      description:
        "Full-text search over the user's shared context hub, which aggregates items written by their apps (finance, relationships/CRM, work, notes) and by other agents. Call this BEFORE planning tasks or answering questions about the user's life, schedule, money, people, or work so your answer uses cross-app background instead of guessing. Supports Chinese and English. Pass an array of queries to search several angles in ONE call (results are merged with rank fusion). Every result carries provenance: authority=user (the user said it), app (a source app observed it), agent (another agent inferred it). Unreviewed agent proposals are EXCLUDED by default — set include_proposed only when auditing what agents have inferred. Use get_context_item for the full record.",
      inputSchema: {
        query: z
          .union([z.string(), z.array(z.string()).min(1).max(10)])
          .describe('Search query, or up to 10 queries to merge in one call (e.g. ["財務規劃", "報稅"])'),
        types: z.array(z.string()).optional().describe('Filter by item types, e.g. ["transaction","event"]'),
        sources: z.array(z.string()).optional().describe('Filter by source app ids (see list_context_sources)'),
        tags: z.array(z.string()).optional().describe('Only items carrying ALL of these tags'),
        since: z.string().optional().describe('Only items on/after this ISO 8601 datetime'),
        until: z.string().optional().describe('Only items on/before this ISO 8601 datetime'),
        limit: z.number().int().min(1).max(50).default(10),
        include_private: z
          .boolean()
          .default(false)
          .describe('Request private items too. Honored only if this client is authorized server-side.'),
        include_proposed: z
          .boolean()
          .default(false)
          .describe('Also return UNREVIEWED agent proposals (acceptance=proposed). For auditing/debugging only — do not treat them as facts.'),
      },
    },
    async (args) => {
      if (!canRead) return errorResult('this API key lacks the "read" scope');
      const queries = typeof args.query === 'string' ? [args.query] : args.query;
      const { sensitivity, note } = resolveSensitivity(args.include_private);
      const filters: ListFilters = {
        types: args.types,
        sources: args.sources,
        tags: args.tags,
        since: normalizeIso(args.since),
        until: normalizeIso(args.until),
        sensitivity,
        includeProposed: args.include_proposed,
      };
      const { items, totalMatched } = itemsRepo.search(access, { queries, filters, limit: args.limit });
      return jsonResult({
        total_matched: totalMatched,
        returned: items.length,
        note,
        hint:
          totalMatched > items.length
            ? 'More items matched than returned; narrow with types/sources/tags/since instead of paging.'
            : undefined,
        items,
      });
    },
  );

  server.registerTool(
    'get_current_context',
    {
      title: 'Current state of the user',
      description:
        "What is true for the user RIGHT NOW. current ≡ status=active, not deleted, not expired — concretely: active tasks (nearest deadline first), future events, latest durable states/facts/preferences, and ACCEPTED insights only (reviewed and confirmed). Unreviewed proposals appear only as a count. Transactions are history, not current context. Use this when planning or prioritizing; search_context covers history.",
      inputSchema: {
        per_section: z.number().int().min(1).max(25).default(10),
        include_private: z.boolean().default(false),
      },
    },
    async (args) => {
      if (!canRead) return errorResult('this API key lacks the "read" scope');
      const { sensitivity, note } = resolveSensitivity(args.include_private);
      const current = itemsRepo.currentContext(access, { sensitivity, perSection: args.per_section });
      return jsonResult({ note, ...current });
    },
  );

  server.registerTool(
    'get_recent_context',
    {
      title: 'Recent context timeline',
      description:
        "Chronological timeline of what recently happened across the user's apps (most recent first). Use it to catch up when you have no specific search term. For 'what is true now' prefer get_current_context; for a structured digest prefer get_context_brief. Unreviewed agent proposals are excluded unless include_proposed is set.",
      inputSchema: {
        days: z.number().int().min(1).max(365).default(7).describe('Look-back window in days'),
        sources: z.array(z.string()).optional().describe('Filter by source app ids'),
        types: z.array(z.string()).optional().describe('Filter by item types'),
        limit: z.number().int().min(1).max(100).default(20),
        include_private: z.boolean().default(false),
        include_proposed: z.boolean().default(false),
      },
    },
    async (args) => {
      if (!canRead) return errorResult('this API key lacks the "read" scope');
      const since = new Date(Date.now() - args.days * 86_400_000).toISOString();
      const { sensitivity, note } = resolveSensitivity(args.include_private);
      const { items, nextCursor } = itemsRepo.list(access, {
        filters: {
          sources: args.sources,
          types: args.types,
          since,
          sensitivity,
          includeProposed: args.include_proposed,
        },
        limit: args.limit,
        sort: 'occurred',
      });
      return jsonResult({
        window_days: args.days,
        returned: items.length,
        has_more: Boolean(nextCursor),
        note,
        items: items.map((it) => toCompact(it)),
      });
    },
  );

  server.registerTool(
    'get_context_item',
    {
      title: 'Get full context item',
      description:
        'Fetch one context item in full — complete content, structured data payload, entities, provenance (authority/acceptance/derived_from evidence ids), review verdict. Use after search/timeline/current when a snippet is not enough. Your own rejected proposals are fetchable by id, including the review_note explaining why.',
      inputSchema: {
        id: z.string().describe('Item id from a previous search/timeline result'),
      },
    },
    async (args) => {
      if (!canRead) return errorResult('this API key lacks the "read" scope');
      const item = itemsRepo.get(access, args.id);
      if (!item) return errorResult(`no item with id "${args.id}"`);
      return jsonResult({ item });
    },
  );

  server.registerTool(
    'propose_insight',
    {
      title: 'Propose an insight into the hub',
      description:
        `Propose a durable conclusion you derived (recorded as source "${client.id}", authority=agent, acceptance=proposed). Proposals are INVISIBLE to normal reads until a human reviewer accepts them, so write them to be reviewed: honest confidence, and cite the NON-insight context items your inference is based on via derived_from (insights cannot cite other insights). If any evidence is private, the proposal automatically becomes private. Use when you learn something lasting — a preference you inferred, a follow-up, a pattern. Do NOT store transient conversation details or restate existing facts. To update a still-unreviewed proposal, reuse its source_item_id; once reviewed it is immutable — propose anew with a new source_item_id.`,
      inputSchema: {
        type: z
          .enum(['insight', 'task', 'note'])
          .default('insight')
          .describe('insight = your inference (goes through review); task = a follow-up you created; note = supporting notes'),
        title: z.string().min(1).max(500).describe('Short one-line summary'),
        content: z.string().max(50_000).default('').describe('Full detail, plain text or markdown'),
        tags: z.array(z.string()).max(50).default([]),
        entities: z
          .array(z.string())
          .max(50)
          .default([])
          .describe('Related entities as "kind:name", e.g. ["person:王小明", "project:Q3-report"]'),
        confidence: z
          .number()
          .min(0)
          .max(1)
          .default(0.7)
          .describe('How sure you are — shown to the reviewer and weighted in ranking'),
        derived_from: z
          .array(z.string())
          .max(20)
          .default([])
          .describe('Ids of the NON-insight context items this inference is based on'),
        occurred_at: z.string().optional().describe('When the underlying event happened (ISO 8601)'),
        sensitivity: z.enum(['normal', 'private']).default('normal'),
        source_item_id: z
          .string()
          .optional()
          .describe('Stable key for this proposal; reuse to refresh it while still unreviewed'),
        idempotency_key: z.string().optional().describe('Stable key to avoid duplicates when retrying'),
      },
    },
    async (args) => {
      if (!canWrite) return errorResult('this API key lacks the "write" scope');
      const parsed = newItemSchema.safeParse(args);
      if (!parsed.success) return errorResult(parsed.error.message);
      try {
        const { item, created } = itemsRepo.insert(client.id, parsed.data, 'agent', access);
        return jsonResult({
          item_id: item.id,
          created,
          revision: item.revision,
          acceptance: item.acceptance,
          sensitivity: item.sensitivity,
        });
      } catch (err) {
        if (
          err instanceof ValidationError ||
          err instanceof SourceItemConflictError ||
          err instanceof RevisionConflictError
        ) {
          return errorResult(err.message);
        }
        throw err;
      }
    },
  );

  server.registerTool(
    'list_context_sources',
    {
      title: 'List context sources',
      description:
        'Lists every app/agent feeding the hub that YOU are authorized to read, with item counts per type and last activity. Call this on first contact with the hub to learn what kinds of context exist before searching.',
      inputSchema: {},
    },
    async () => {
      if (!canRead) return errorResult('this API key lacks the "read" scope');
      return jsonResult({ sources: sourcesView(deps, access) });
    },
  );

  server.registerTool(
    'get_context_brief',
    {
      title: 'Cross-app situational brief',
      description:
        "One-call digest of the user's recent situation: latest highlights from every source app plus per-source stats, optionally weighted toward a focus topic. Deterministic aggregation (no hidden LLM). Call this ONCE at the start of planning work — it usually replaces several list/search round trips. Pair with get_current_context for open tasks and standing facts.",
      inputSchema: {
        days: z.number().int().min(1).max(90).default(14).describe('Look-back window in days'),
        focus: z
          .string()
          .optional()
          .describe('Optional topic keyword(s); adds a focused search section to the brief'),
        include_private: z.boolean().default(false),
      },
    },
    async (args) => {
      if (!canRead) return errorResult('this API key lacks the "read" scope');
      const { sensitivity, note } = resolveSensitivity(args.include_private);
      const brief = itemsRepo.brief(access, { days: args.days, focus: args.focus, sensitivity });
      return jsonResult(note ? { note, ...brief } : brief);
    },
  );

  return server;
}
