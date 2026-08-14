import { z } from 'zod';

/** Accepts anything Date.parse understands and normalizes to UTC ISO 8601. */
export const isoDateTime = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), { message: 'invalid ISO 8601 datetime' })
  .transform((s) => new Date(s).toISOString());

export const SENSITIVITIES = ['normal', 'private'] as const;
export type Sensitivity = (typeof SENSITIVITIES)[number];

/**
 * Who ORIGINALLY asserted this item (provenance). Decided entirely by the
 * server from the authenticated identity — never taken from request bodies
 * (admin excepted). Reviewing/accepting an item NEVER changes its authority.
 */
export const AUTHORITIES = ['user', 'app', 'agent'] as const;
export type Authority = (typeof AUTHORITIES)[number];

/** Lifecycle state. Expiry/completion/supersession are distinct from deletion. */
export const STATUSES = ['active', 'completed', 'cancelled', 'superseded'] as const;
export type ItemStatus = (typeof STATUSES)[number];

/**
 * Trust dimension — SEPARATE from provenance (authority) and lifecycle
 * (status). candidate = written but not yet allowed into the shared default
 * read surface; accepted = allowed in (via human review, an explicit policy
 * rule, or a trusted human-entry path); rejected/revoked = final verdicts.
 * Accepting agent content never disguises it as human-authored.
 */
export const TRUST_STATES = ['candidate', 'accepted', 'rejected', 'revoked'] as const;
export type TrustState = (typeof TRUST_STATES)[number];

export const ACCEPTANCE_METHODS = ['human_review', 'policy', 'trusted_import'] as const;
export type AcceptanceMethod = (typeof ACCEPTANCE_METHODS)[number];

/** What kind of principal holds a credential. */
export const PRINCIPAL_KINDS = ['agent', 'human', 'service'] as const;
export type PrincipalKind = (typeof PRINCIPAL_KINDS)[number];

/** semantic = meaning-bearing memory; operational = machine-updated state slot. */
export const STATE_KINDS = ['semantic', 'operational'] as const;
export type StateKind = (typeof STATE_KINDS)[number];

/**
 * Persistent information is classified independently from provenance and
 * trust. Source projections point back to an authoritative app; memories are
 * reusable knowledge formed from interactions/evidence; task_state is an
 * exact-key operational slot. A compiled context is deliberately NOT a row in
 * this table — it is an ephemeral read result.
 */
export const INFORMATION_CLASSES = ['source', 'memory', 'task_state'] as const;
export type InformationClass = (typeof INFORMATION_CLASSES)[number];

/** Memory semantics have different validity and decay expectations. */
export const MEMORY_KINDS = [
  'fact',
  'preference',
  'decision',
  'experience',
  'procedure',
  'relationship',
  'working_state',
] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

/** Ranking policy for information that has no explicit valid_until. */
export const DECAY_POLICIES = ['none', 'standard', 'rapid'] as const;
export type DecayPolicy = (typeof DECAY_POLICIES)[number];

/**
 * Item types are conventions, not an enum — writers may introduce their own,
 * subject to the namespace policy's create_rules. Documented conventions:
 * event, fact, state, transaction, note, task, contact, preference, insight,
 * memory.
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
  memory_kind: z
    .enum(MEMORY_KINDS)
    .optional()
    .describe('Reusable memory semantics; omit for a source projection'),
  valid_from: isoDateTime.optional(),
  valid_until: isoDateTime.optional(),
  last_verified_at: isoDateTime.optional(),
  decay_policy: z.enum(DECAY_POLICIES).optional(),
  /**
   * Evidence for insights: ids of the NON-insight context items this
   * inference is based on. Must live in the writer's namespace.
   */
  derived_from: z.array(z.string().min(1)).max(20).default([]),
  /**
   * Stable id of the underlying business object in the source app. Repeated
   * writes with the same (source, source_item_id) follow the per-type update
   * policy (upsert / dedup-only / candidate-refresh) instead of duplicating.
   */
  source_item_id: z.string().min(1).max(200).optional(),
  /** Deep link back to the source of truth in the origin app. */
  source_uri: z.string().max(1000).optional(),
  /**
   * REQUIRED on every create: AI agents retry on timeouts, and a system of
   * record must make retries safe. Same key + same payload replays the
   * original result; same key + different payload is a 409.
   */
  idempotency_key: z.string().min(1).max(200),
});
export type NewItem = z.infer<typeof newItemSchema>;

/**
 * PATCH is reserved for non-agent principals maintaining their OWN
 * projections (apps correcting their own records, human entry). Semantic
 * content of accepted agent memories cannot be patched — propose a successor.
 */
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
    valid_from: isoDateTime.nullable(),
    valid_until: isoDateTime.nullable(),
    last_verified_at: isoDateTime.nullable(),
    decay_policy: z.enum(DECAY_POLICIES).nullable(),
    source_uri: z.string().max(1000).nullable(),
    expected_revision: z.number().int().min(1),
  })
  .partial();
export type PatchItem = z.infer<typeof patchItemSchema>;

export interface ContextItem {
  id: string;
  source: string;
  namespace: string;
  type: string;
  title: string;
  content: string;
  data: unknown;
  tags: string[];
  entities: string[];
  sensitivity: Sensitivity;
  authority: Authority;
  status: ItemStatus;
  trust_state: TrustState;
  acceptance_method: AcceptanceMethod | null;
  accepted_by: string | null;
  accepted_at: string | null;
  acceptance_policy_version: number | null;
  acceptance_rule_id: string | null;
  information_class: InformationClass;
  memory_kind: MemoryKind | null;
  confidence: number | null;
  occurred_at: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  valid_from: string | null;
  valid_until: string | null;
  last_verified_at: string | null;
  decay_policy: DecayPolicy | null;
  source_item_id: string | null;
  source_uri: string | null;
  revision: number;
  derived_from: string[];
  successor_of: string | null;
  superseded_by: string | null;
  state_kind: StateKind | null;
  state_key: string | null;
  schema_id: string | null;
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
  trust_state: TrustState;
  information_class: InformationClass;
  memory_kind: MemoryKind | null;
  confidence: number | null;
  occurred_at: string | null;
  created_at: string;
}

export type SensitivityFilter = 'normal' | 'private' | 'all';

/**
 * Which trust slice a read surface exposes. Fixed per route/tool by server
 * code — NEVER derived from a caller-supplied string, so a caller cannot
 * claim the reviewer inbox by parameter.
 */
export type TrustSurface =
  | 'accepted' // default shared surface
  | 'plus_own' // accepted + the caller's own candidates
  | 'plus_all' // accepted + all candidates (reviewer)
  | 'own_candidates' // only the caller's candidates
  | 'inbox'; // only candidates, all writers (reviewer)

export interface ListFilters {
  sources?: string[];
  types?: string[];
  tags?: string[];
  statuses?: ItemStatus[];
  since?: string;
  until?: string;
  sensitivity?: SensitivityFilter;
}

export const SCOPES = ['read', 'write', 'review_insight', 'admin'] as const;
export type Scope = (typeof SCOPES)[number];

export interface ClientAuth {
  id: string;
  name: string;
  principalKind: PrincipalKind;
  /** The single namespace this credential is bound to (server-side, unforgeable). */
  namespace: string;
  scopes: Scope[];
  /** Server-side read ceiling: private items are invisible beyond it. */
  maxSensitivity: Sensitivity;
  /** Source whitelist within the namespace: null = all sources, [] = none. */
  readSources: string[] | null;
  credentialVersion: number;
  isAdmin: boolean;
}

/**
 * The ACL context every repository read method requires. namespace === null
 * is ONLY valid together with isAdmin — the repo enforces the namespace
 * predicate for every non-admin reader.
 */
export interface ReadAccess {
  clientId: string;
  isAdmin: boolean;
  namespace: string | null;
  readSources: string[] | null;
  maxSensitivity: Sensitivity;
}

export function accessFor(client: ClientAuth): ReadAccess {
  return {
    clientId: client.id,
    isAdmin: client.isAdmin,
    namespace: client.isAdmin ? null : client.namespace,
    readSources: client.readSources,
    maxSensitivity: client.maxSensitivity,
  };
}

export interface ClientInfo {
  id: string;
  name: string;
  principal_kind: PrincipalKind;
  namespace: string;
  scopes: Scope[];
  max_sensitivity: Sensitivity;
  read_sources: string[] | null;
  credential_version: number;
  created_at: string;
  disabled: boolean;
  auth_method?: 'legacy_key' | 'enrollment_key' | 'oauth_user' | 'oauth_client_credentials';
}

export interface ControlPrincipal {
  id: string;
  provider: string;
  subject: string;
  displayName: string;
  controlAdmin: boolean;
  disabled: boolean;
}

export interface ControlActor {
  principal: ControlPrincipal;
  sessionId: string;
}

/**
 * Authority (provenance) is decided by the server from the principal kind:
 * agent → agent, service → app, human → user. Only the admin token (import
 * path) may specify an authority explicitly.
 */
export function resolveAuthority(client: ClientAuth, requested?: Authority): Authority {
  if (client.isAdmin) return requested ?? 'app';
  if (client.principalKind === 'agent') return 'agent';
  if (client.principalKind === 'human') return 'user';
  return 'app';
}

/**
 * Default agent memory types, used ONLY to generate seed policy create_rules.
 * Runtime authorization always reads the namespace policy — there is no
 * fallback to this constant (fail-closed).
 */
export const DEFAULT_AGENT_MEMORY_TYPES = [
  'insight',
  'task',
  'note',
  'fact',
  'preference',
  'contact',
  'state',
  'memory',
] as const;

/** Clamp a requested sensitivity filter to the client's server-side ceiling. */
export function clampSensitivity(
  requested: SensitivityFilter | undefined,
  ceiling: Sensitivity,
): SensitivityFilter {
  const want = requested ?? 'all';
  return ceiling === 'private' ? want : 'normal';
}
