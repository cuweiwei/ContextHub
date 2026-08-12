import { performance } from 'node:perf_hooks';
import { createItemsRepo, type TrustDecision, type WriteContext } from '../src/core/items-repo.js';
import { newItemSchema, type ReadAccess } from '../src/core/types.js';
import { openDatabase } from '../src/db/connection.js';

const requested = Number(process.argv.find((arg) => arg.startsWith('--items='))?.split('=')[1] ?? 2000);
const itemCount = Number.isFinite(requested) ? Math.max(100, Math.min(20_000, requested)) : 2000;
const db = openDatabase(':memory:', { synchronous: 'NORMAL' });
const repo = createItemsRepo(db);

const access: ReadAccess = {
  clientId: 'benchmark-reader',
  isAdmin: false,
  namespace: 'personal',
  readSources: null,
  maxSensitivity: 'private',
};
const writer: WriteContext = {
  clientId: 'benchmark-source',
  namespace: 'personal',
  principalKind: 'service',
  isAdmin: false,
  access: { ...access, clientId: 'benchmark-source' },
};
const trust: TrustDecision = {
  trustState: 'accepted',
  acceptanceMethod: 'policy',
  policyVersion: 1,
  ruleId: 'benchmark',
};

function insert(index: number, title: string, content: string, entities: string[] = []): string {
  return repo.insert(
    writer,
    newItemSchema.parse({
      type: 'note',
      title,
      content,
      entities,
      tags: [`bucket-${index % 32}`],
      idempotency_key: `benchmark-${index}`,
    }),
    'app',
    trust,
  ).item.id;
}

const targets = new Map<string, string>();
targets.set(
  'exact',
  insert(0, 'ContextHub NAS deployment checklist', 'Validate backup restore and rollback before release'),
);
targets.set(
  'cjk',
  insert(1, '家庭年度保險檢視', '九月重新檢查醫療險與意外險保障範圍'),
);
targets.set(
  'entity',
  insert(2, 'Orion roadmap decision', 'The owner approved the second milestone', ['project:Orion']),
);

const topics = ['budget', 'calendar', 'recipe', 'travel', 'fitness', 'reading', 'meeting', 'garden'];
for (let i = 3; i < itemCount; i += 1) {
  const topic = topics[i % topics.length]!;
  insert(
    i,
    `Archive ${topic} note ${i}`,
    `Historical ${topic} record for quarter ${i % 12}; retained for retrieval benchmark coverage.`,
    [`topic:${topic}`],
  );
}

const cases = [
  { name: 'exact', query: 'NAS deployment checklist', expected: targets.get('exact')! },
  { name: 'typo', query: 'ContextHbu deploymnt cheklist', expected: targets.get('exact')! },
  { name: 'cjk', query: '醫療險', expected: targets.get('cjk')! },
  {
    name: 'entity',
    query: 'what is the current project decision',
    entities: ['project:Orion'],
    expected: targets.get('entity')!,
  },
];

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
}

function evaluate(mode: 'lexical' | 'hybrid') {
  const latencies: number[] = [];
  let recalled = 0;
  let reciprocalRank = 0;
  const details = [];
  for (let round = 0; round < 10; round += 1) {
    for (const testCase of cases) {
      const started = performance.now();
      const result = repo.search(access, {
        queries: [testCase.query],
        entities: testCase.entities,
        limit: 5,
        surface: 'accepted',
        mode,
      });
      latencies.push(performance.now() - started);
      if (round === 0) {
        const rank = result.items.findIndex((item) => item.id === testCase.expected) + 1;
        if (rank > 0) {
          recalled += 1;
          reciprocalRank += 1 / rank;
        }
        details.push({
          case: testCase.name,
          rank: rank || null,
          sources: rank > 0 ? result.items[rank - 1]!.retrieval_sources : [],
        });
      }
    }
  }
  return {
    recall_at_5: Number((recalled / cases.length).toFixed(3)),
    mrr: Number((reciprocalRank / cases.length).toFixed(3)),
    latency_ms: {
      p50: Number(percentile(latencies, 0.5).toFixed(3)),
      p95: Number(percentile(latencies, 0.95).toFixed(3)),
    },
    cases: details,
  };
}

repo.reindex();
const report = {
  dataset_items: itemCount,
  projection: repo.retrievalProjectionStatus(),
  lexical: evaluate('lexical'),
  hybrid: evaluate('hybrid'),
};
console.log(JSON.stringify(report, null, 2));
db.close();

if (report.hybrid.recall_at_5 < report.lexical.recall_at_5 || report.hybrid.recall_at_5 < 0.75) {
  process.exitCode = 1;
}
