import { z } from 'zod';

/**
 * PolicyV1 — the owner-maintained, per-namespace authorization document.
 *
 * Policies configure DEPLOYMENT DIFFERENCES ONLY (who may read/write what,
 * and what trust level a creation starts at). Safety invariants — accepted
 * semantic content is immutable, insights are append-only, candidates never
 * enter the shared read surface, successor acceptance is atomic, namespaces
 * are unforgeable — are hard-coded in core and cannot be configured away.
 *
 * Everything here is fail-closed: an unknown field, capability, schema
 * version, or a missing/invalid policy denies instead of defaulting.
 */

export const CAPABILITIES = [
  'memory.read_accepted',
  'memory.read_own_candidates',
  'memory.read_all_candidates',
  'memory.review',
  'memory.propose_successor',
  'task.operate',
  'task.coordinate',
  'note.curate',
  'state.read',
  'state.write',
  'audit.read',
  'policy.manage',
  'change.read',
  'change.manage',
  'connector.sync',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

const grantSchema = z
  .object({
    client_id: z.string().min(1),
    capabilities: z.array(z.enum(CAPABILITIES)),
  })
  .strict();

const createRuleSchema = z
  .object({
    rule_id: z.string().min(1).max(100),
    client_id: z.string().min(1),
    /**
     * Exact item type, or '*' meaning "any type this client writes".
     * '*' is intended for service principals maintaining their own
     * projections; state_rules never support wildcards.
     */
    item_type: z.string().min(1).max(64),
    create_as: z.enum(['candidate', 'accepted']),
    acceptance_method: z.literal('policy').optional(),
  })
  .strict();

const stateRuleSchema = z
  .object({
    rule_id: z.string().min(1).max(100),
    /** EXACT key only — no wildcard/regex/prefix (typo must not match). */
    state_key: z.string().min(1).max(200),
    schema_id: z.string().min(1).max(100),
    read_clients: z.array(z.string().min(1)).default([]),
    write_clients: z.array(z.string().min(1)).default([]),
    mutable_fields: z
      .array(z.enum(['value', 'observed_at', 'expires_at', 'status']))
      .min(1),
  })
  .strict();

export const policyV1Schema = z
  .object({
    schema_version: z.literal(1),
    namespace_mode: z.enum(['personal', 'work']),
    grants: z.array(grantSchema).default([]),
    create_rules: z.array(createRuleSchema).default([]),
    state_rules: z.array(stateRuleSchema).default([]),
  })
  .strict();

export type PolicyV1 = z.infer<typeof policyV1Schema>;
export type CreateRule = z.infer<typeof createRuleSchema>;
export type StateRule = z.infer<typeof stateRuleSchema>;

export type PolicySimulationCase =
  | { kind: 'capability'; client_id: string; capability: Capability }
  | { kind: 'create' | 'create_rule'; client_id: string; item_type: string }
  | { kind: 'state_read' | 'state_write'; client_id: string; state_key: string; schema_id?: string }
  | { kind: 'batch'; client_id: string; capability: Capability; item_type?: string; state_key?: string };

export interface PolicySimulationResult {
  allowed: boolean;
  reason_code: 'allowed' | 'unknown_client' | 'missing_capability' | 'missing_create_rule' | 'missing_state_rule' | 'schema_mismatch';
  matched_rule_id: string | null;
  trust_state: 'candidate' | 'accepted' | null;
}

export interface PolicyValidationDeps {
  /** Client ids that exist in THIS namespace (cross-namespace refs are invalid). */
  namespaceClientIds: Set<string>;
  /** Registered operational-state schema ids. */
  stateSchemaIds: Set<string>;
}

/**
 * Structural + referential validation. Throws Error with a human-readable
 * message listing every problem. Strict zod parsing already rejects unknown
 * fields/capabilities/schema versions.
 */
export function validatePolicy(raw: unknown, deps: PolicyValidationDeps): PolicyV1 {
  const parsed = policyV1Schema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`policy rejected: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  const policy = parsed.data;
  const problems: string[] = [];

  const ruleIds = new Set<string>();
  for (const r of [...policy.create_rules, ...policy.state_rules]) {
    if (ruleIds.has(r.rule_id)) problems.push(`duplicate rule_id "${r.rule_id}"`);
    ruleIds.add(r.rule_id);
  }

  const referenced = [
    ...policy.grants.map((g) => g.client_id),
    ...policy.create_rules.map((r) => r.client_id),
    ...policy.state_rules.flatMap((r) => [...r.read_clients, ...r.write_clients]),
  ];
  for (const id of new Set(referenced)) {
    if (!deps.namespaceClientIds.has(id)) {
      problems.push(`client "${id}" does not exist in this namespace (policies may only reference same-namespace clients)`);
    }
  }

  const stateKeys = new Set<string>();
  for (const r of policy.state_rules) {
    if (stateKeys.has(r.state_key)) problems.push(`duplicate state_key "${r.state_key}"`);
    stateKeys.add(r.state_key);
    if (!deps.stateSchemaIds.has(r.schema_id)) {
      problems.push(`state schema "${r.schema_id}" is not registered`);
    }
  }

  if (problems.length > 0) throw new Error(`policy rejected: ${problems.join('; ')}`);
  return policy;
}

export function capabilitiesFor(policy: PolicyV1, clientId: string): Set<Capability> {
  const caps = new Set<Capability>();
  for (const g of policy.grants) {
    if (g.client_id === clientId) for (const c of g.capabilities) caps.add(c);
  }
  return caps;
}

/** Exact item_type rule wins over a '*' rule for the same client. */
export function createRuleFor(policy: PolicyV1, clientId: string, itemType: string): CreateRule | null {
  let wildcard: CreateRule | null = null;
  for (const r of policy.create_rules) {
    if (r.client_id !== clientId) continue;
    if (r.item_type === itemType) return r;
    if (r.item_type === '*') wildcard = r;
  }
  return wildcard;
}

export function stateRuleFor(policy: PolicyV1, stateKey: string): StateRule | null {
  return policy.state_rules.find((r) => r.state_key === stateKey) ?? null;
}

export function simulatePolicy(policy: PolicyV1, input: PolicySimulationCase): PolicySimulationResult {
  const clientExists = new Set([
    ...policy.grants.map((grant) => grant.client_id),
    ...policy.create_rules.map((rule) => rule.client_id),
    ...policy.state_rules.flatMap((rule) => [...rule.read_clients, ...rule.write_clients]),
  ]).has(input.client_id);
  if (!clientExists) return { allowed: false, reason_code: 'unknown_client', matched_rule_id: null, trust_state: null };

  if (input.kind === 'capability' || input.kind === 'batch') {
    const allowed = capabilitiesFor(policy, input.client_id).has(input.capability);
    return { allowed, reason_code: allowed ? 'allowed' : 'missing_capability', matched_rule_id: null, trust_state: null };
  }
  if (input.kind === 'create' || input.kind === 'create_rule') {
    const rule = createRuleFor(policy, input.client_id, input.item_type);
    if (!rule) return { allowed: false, reason_code: 'missing_create_rule', matched_rule_id: null, trust_state: null };
    return { allowed: true, reason_code: 'allowed', matched_rule_id: rule.rule_id, trust_state: rule.create_as };
  }
  const stateInput = input as Extract<PolicySimulationCase, { kind: 'state_read' | 'state_write' }>;
  const rule = stateRuleFor(policy, stateInput.state_key);
  if (!rule) return { allowed: false, reason_code: 'missing_state_rule', matched_rule_id: null, trust_state: null };
  if (stateInput.schema_id && stateInput.schema_id !== rule.schema_id) return { allowed: false, reason_code: 'schema_mismatch', matched_rule_id: rule.rule_id, trust_state: null };
  const allowed = (stateInput.kind === 'state_read' ? rule.read_clients : rule.write_clients).includes(stateInput.client_id);
  return { allowed, reason_code: allowed ? 'allowed' : 'missing_capability', matched_rule_id: rule.rule_id, trust_state: null };
}

/**
 * Minimal declarative schema for operational-state values (deliberately NOT
 * full JSON Schema — no new dependencies, no ambiguity). Shape:
 *   { fields: { spent: { type: 'number', required: true }, note: { type: 'string' } } }
 * Unknown fields in the value are rejected.
 */
export const stateValueSchemaSchema = z
  .object({
    fields: z.record(
      z.string().min(1).max(100),
      z
        .object({
          type: z.enum(['string', 'number', 'boolean']),
          required: z.boolean().optional(),
        })
        .strict(),
    ),
  })
  .strict();
export type StateValueSchema = z.infer<typeof stateValueSchemaSchema>;

export function validateStateValue(schema: StateValueSchema, value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return 'state value must be a JSON object';
  }
  const obj = value as Record<string, unknown>;
  for (const [name, spec] of Object.entries(schema.fields)) {
    const v = obj[name];
    if (v === undefined || v === null) {
      if (spec.required) return `missing required field "${name}"`;
      continue;
    }
    if (typeof v !== spec.type) return `field "${name}" must be a ${spec.type}`;
  }
  for (const key of Object.keys(obj)) {
    if (!(key in schema.fields)) return `unknown field "${key}" not in schema`;
  }
  return null;
}

/**
 * Grant profiles — convenience bundles used by client onboarding and the v4
 * migration seed. Applying a profile writes a NEW policy version (grants stay
 * explicit and versioned; profiles are shorthand, not hidden defaults).
 */
export const GRANT_PROFILES = ['agent-default', 'app-producer', 'connector-producer', 'reviewer', 'none'] as const;
export type GrantProfile = (typeof GRANT_PROFILES)[number];

export function profileFor(
  profile: Exclude<GrantProfile, 'none'>,
  clientId: string,
): { grant: PolicyV1['grants'][number]; create_rules: PolicyV1['create_rules'] } {
  switch (profile) {
    case 'agent-default':
      return {
        grant: {
          client_id: clientId,
          capabilities: [
            'memory.read_accepted',
            'memory.read_own_candidates',
            'memory.propose_successor',
            'task.operate',
            'note.curate',
          ],
        },
        // Agents create CANDIDATES of any type — invisible to the shared
        // surface until reviewed, so a permissive type list is safe.
        create_rules: [
          { rule_id: `profile-agent-${clientId}`, client_id: clientId, item_type: '*', create_as: 'candidate' },
        ],
      };
    case 'app-producer':
      return {
        grant: { client_id: clientId, capabilities: ['memory.read_accepted'] },
        // Source apps are trusted producers of their OWN projections.
        create_rules: [
          {
            rule_id: `profile-producer-${clientId}`,
            client_id: clientId,
            item_type: '*',
            create_as: 'accepted',
            acceptance_method: 'policy',
          },
        ],
      };
    case 'connector-producer':
      return {
        grant: { client_id: clientId, capabilities: ['memory.read_accepted', 'state.read', 'state.write', 'connector.sync'] },
        create_rules: [
          { rule_id: `profile-connector-${clientId}`, client_id: clientId, item_type: '*', create_as: 'accepted', acceptance_method: 'policy' },
        ],
      };
    case 'reviewer':
      return {
        grant: {
          client_id: clientId,
          capabilities: [
            'memory.read_accepted',
            'memory.read_own_candidates',
            'memory.read_all_candidates',
            'memory.review',
            'memory.propose_successor',
            'audit.read',
          ],
        },
        // Human principals: direct entry is trusted (acceptance_method is
        // resolved to trusted_import at write time for principal_kind=human).
        create_rules: [
          { rule_id: `profile-human-${clientId}`, client_id: clientId, item_type: '*', create_as: 'accepted' },
        ],
      };
  }
}

/** Seed policies written by the v4 migration. Kept here so tests and the
 * migration share one definition. */
export function seedPersonalPolicy(clients: { id: string; principalKind: string }[]): PolicyV1 {
  const grants: PolicyV1['grants'] = [];
  const create_rules: PolicyV1['create_rules'] = [];
  for (const c of clients) {
    const p = profileFor(c.principalKind === 'agent' ? 'agent-default' : 'app-producer', c.id);
    grants.push(p.grant);
    create_rules.push(
      ...p.create_rules.map((r) => ({ ...r, rule_id: r.rule_id.replace('profile-', 'seed-') })),
    );
  }
  return { schema_version: 1, namespace_mode: 'personal', grants, create_rules, state_rules: [] };
}

export function seedWorkPolicy(): PolicyV1 {
  // Deny-by-default: no grants, no create rules. The owner adds allowlist
  // entries deliberately (see ADR-001 — work agents always create candidates).
  return { schema_version: 1, namespace_mode: 'work', grants: [], create_rules: [], state_rules: [] };
}
