import {
  AGENT_LOCAL_MEMORY_MODES,
  type AgentLocalMemoryMode,
} from './types.js';

export const AGENT_MEMORY_FEDERATION_PROTOCOL = 'contexthub-agent-memory-federation/v1';

export interface AgentMemoryCachePointer {
  hub_item_id: string;
  revision: number | null;
  change_cursor: number;
  cached_at: string;
}

export interface AgentMemoryFederationContract {
  protocol: typeof AGENT_MEMORY_FEDERATION_PROTOCOL;
  local_memory_modes: readonly AgentLocalMemoryMode[];
  cache_pointer_fields: readonly ['hub_item_id', 'revision', 'change_cursor', 'cached_at'];
  rules: {
    local_memory_is_authority: false;
    cache_pointer_copies_content: false;
    shared_memory_requires_candidate_review: true;
    unresolved_claims_are_excluded: true;
  };
}

export const AGENT_MEMORY_FEDERATION_CONTRACT: AgentMemoryFederationContract = Object.freeze({
  protocol: AGENT_MEMORY_FEDERATION_PROTOCOL,
  local_memory_modes: AGENT_LOCAL_MEMORY_MODES,
  cache_pointer_fields: ['hub_item_id', 'revision', 'change_cursor', 'cached_at'] as const,
  rules: {
    local_memory_is_authority: false,
    cache_pointer_copies_content: false,
    shared_memory_requires_candidate_review: true,
    unresolved_claims_are_excluded: true,
  },
} as const);

export function cachePointerForChange(event: {
  cursor: number;
  entity_kind: string;
  entity_id: string;
  revision: number | null;
}, cachedAt: string): AgentMemoryCachePointer | null {
  if (event.entity_kind !== 'context_item') return null;
  return {
    hub_item_id: event.entity_id,
    revision: event.revision,
    change_cursor: event.cursor,
    cached_at: cachedAt,
  };
}
