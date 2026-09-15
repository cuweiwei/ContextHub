import { describe, expect, it } from 'vitest';
import { ensureConsolidationQueue } from '../src/core/consolidation.js';
import { ensureEntityGraph } from '../src/core/entity-graph.js';
import { newItemSchema } from '../src/core/types.js';
import { buildTestEnv, idem } from './helpers.js';

describe('derived projection generations', () => {
  it('does not rebuild entity graph or consolidation on every read', () => {
    const env = buildTestEnv();
    expect(ensureEntityGraph(env.db).rebuilt).toBe(true);
    expect(ensureEntityGraph(env.db).rebuilt).toBe(false);
    expect(ensureConsolidationQueue(env.db).rebuilt).toBe(true);
    expect(ensureConsolidationQueue(env.db).rebuilt).toBe(false);
    env.db.close();
  });

  it('marks both projections dirty when authoritative items change', () => {
    const env = buildTestEnv();
    ensureEntityGraph(env.db);
    ensureConsolidationQueue(env.db);
    env.seed('source-app', newItemSchema.parse({ type: 'entity_definition', title: 'Person', content: 'Entity', entities: ['person:tim'], idempotency_key: idem() }));
    expect(ensureEntityGraph(env.db).rebuilt).toBe(true);
    expect(ensureConsolidationQueue(env.db).rebuilt).toBe(true);
    env.db.close();
  });
});
