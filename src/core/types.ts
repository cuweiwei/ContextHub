import { z } from 'zod';

/** Accepts anything Date.parse understands and normalizes to UTC ISO 8601. */
export const isoDateTime = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), { message: 'invalid ISO 8601 datetime' })
  .transform((s) => new Date(s).toISOString());

export const SENSITIVITIES = ['normal', 'private'] as const;
export type Sensitivity = (typeof SENSITIVITIES)[number];

/**
 * Who ORIGINALLY asserted this item. Decided entirely by the server from the
 * authenticated identity — never taken from request bodies (admin excepted).
 * Reviewing an insight NEVER changes its authority: an accepted hermes
 * proposal stays authority=agent. Only the admin human-entry path may create
 * authority=user content.
 */
export const AUTHORITIES = ['user', 'app', 'agent'] as const;
export type Authority = (typeof AUTHORITIES)[number];

/** Lifecycle state. Expiry/completion/supersession are distinct concepts from deletion. */
export const STATUSES = ['active', 'completed', 'cancelled', 'superseded'] as const;
export type ItemStatus = (typeof STATUSES)[number];

/**
 * Review state — only ever set on insights. `authority` records who said it;
 * `acceptance` records whether a reviewer confirmed it. proposed → accepted |
 * rejected, one-way; rejected can never be reopened.
 */
export const ACCEPTANCES = ['proposed', 'accepted', 'rejected'] as const;
export type Acceptance = (typeof ACCEPTANCES)[number];

/**
 * Item types are conventions, not an enum — apps may introduce their own.
 * Documented conventions: event, fact, state, transaction, note, task,
 * contact, preference, insight.
 */
export const newItemSchema = z.object({
  type: z.string().min(1).max(64),
  title: z.string().min(1).max(500),
  content: z.string().max(50_000).default(''),
  data: z.unknown().optional(),
  tags: z.array(z.string().min(1).max(100)).max(50).default([]),
  entities: z.array(z.string().min(1).max(200)).max(50).default([]),
  sensitivity: z.enum(SENSITIVITIES).default('normal'),
  status: z.enum(STATUSES).default('active'),
  confidence: z.number().min(0).max(1).optional(),
  occurred_at: isoDateTime.optional(),
  expires_at: isoDateTime.optional(),
  /**
   * Evidence for insights: ids of the NON-insight context items this
   * inference is based on. Insight-as-evidence is forbidden in the MVP to
   * prevent transitive provenance/ACL laundering.
   */
  derived_from: z.array(z.string().min(1)).max(20).default([]),
  /**
   * Stable id of the underlying business object in the source app. Repeated
   * writes with the same (source, source_item_id) follow the per-type update
   * policy (upsert / dedup-only / append-only) instead of duplicating.
   */
  source_item_id: z.string().min(1).max(200).optional(),
  /** Deep link back to the source of truth in the origin app. */
  source_uri: z.string().max(1000).optional(),
  idempotency_key: z.string().min(1).max(200).optional(),
});
export type NewItem = z.infer<typeof newItemSchema>;

export const patchItemSchema = z
  .object({
    type: z.string().min(1).max(64),
    title: z.string().min(1).max(500),
    content: z.string().max(50_000),
    data: z.unknown(),
    tags: z.array(z.string().min(1).max(100)).max(50),
    entities: z.array(z.string().min(1).max(200)).max(50),
    sensitivity: z.enum(SENSITIVITIES),
    status: z.enum(STATUSES),
    confidence: z.number().min(0).max(1).nullable(),
    occurred_at: isoDateTime.nullable(),
    expires_at: isoDateTime.nullable(),
    source_uri: z.string().max(1000).nullable(),
    /** Review operation: accepted | rejected only; requires expected_revision. */
    acceptance: z.enum(['accepted', 'rejected']),
    expected_revision: z.number().int().min(1),
    review_note: z.string().max(2000),
  })
  .partial();
export type PatchItem = z.infer<typeof patchItemSchema>;

export interface ContextItem {
  id: string;
  source: string;
  type: string;
  title: string;
  content: string;
  data: unknown;
  tags: string[];
  entities: string[];
  sensitivity: Sensitivity;
  authority: Authority;
  status: ItemStatus;
  acceptance: Acceptance | null;
  confidence: number | null;
  occurred_at: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  source_item_id: string | null;
  source_uri: string | null;
  revision: number;
  derived_from: string[];
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
}

/** Token-efficient shape returned by search/timeline/brief/current. */
export interface CompactItem {
  id: string;
  source: string;
  type: string;
  title: string;
  snippet: string;
  tags: string[];
  authority: Authority;
  status: ItemStatus;
  acceptance: Acceptance | null;
  confidence: number | null;
  occurred_at: string | null;
  created_at: string;
}

export type SensitivityFilter = 'normal' | 'private' | 'all';

export interface ListFilters {
  sources?: string[];
  types?: string[];
  tags?: string[];
  statuses?: ItemStatus[];
  since?: string;
  until?: string;
  sensitivity?: SensitivityFilter;
  /** Proposed insights are excluded from all reads unless explicitly requested. */
  includeProposed?: boolean;
}

export const SCOPES = ['read', 'write', 'review_insight', 'admin'] as const;
export type Scope = (typeof SCOPES)[number];

export interface ClientAuth {
  id: string;
  name: string;
  kind: 'app' | 'agent' | 'admin';
  scopes: Scope[];
  /** Server-side read ceiling: private items are invisible beyond it. */
  maxSensitivity: Sensitivity;
  /** Source whitelist: null = all sources, [] = none. */
  readSources: string[] | null;
  isAdmin: boolean;
}

/**
 * The ACL context every repository read method requires. Constructed from the
 * authenticated client — new routes cannot bypass source/sensitivity rules
 * because the repo refuses to run without one.
 */
export interface ReadAccess {
  clientId: string;
  isAdmin: boolean;
  readSources: string[] | null;
  maxSensitivity: Sensitivity;
}

export function accessFor(client: ClientAuth): ReadAccess {
  return {
    clientId: client.id,
    isAdmin: client.isAdmin,
    readSources: client.readSources,
    maxSensitivity: client.maxSensitivity,
  };
}

export interface ClientInfo {
  id: string;
  name: string;
  kind: 'app' | 'agent';
  scopes: Scope[];
  max_sensitivity: Sensitivity;
  read_sources: string[] | null;
  created_at: string;
  disabled: boolean;
}

/**
 * Authority is decided by the server: agents assert as agent, apps as app.
 * Only the admin token (human-entry / import path) may specify an authority,
 * including `user`. Client-supplied authority is otherwise IGNORED.
 */
export function resolveAuthority(client: ClientAuth, requested?: Authority): Authority {
  if (client.isAdmin) return requested ?? 'app';
  return client.kind === 'agent' ? 'agent' : 'app';
}

/** Item types agent clients are allowed to create (insight isolation). */
export const AGENT_WRITABLE_TYPES = new Set(['insight', 'task', 'note']);

/** Clamp a requested sensitivity filter to the client's server-side ceiling. */
export function clampSensitivity(
  requested: SensitivityFilter | undefined,
  ceiling: Sensitivity,
): SensitivityFilter {
  const want = requested ?? 'all';
  return ceiling === 'private' ? want : 'normal';
}
