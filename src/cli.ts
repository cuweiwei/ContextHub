/**
 * Admin CLI — operates directly on the database file, so it works even when
 * ADMIN_TOKEN is unset. Run on the machine hosting the DB (or in the
 * container: `docker compose exec contexthub node dist/cli.js ...`).
 *
 *   npm run cli -- create-client --id hermes --name "Hermes 秘書" --kind agent --scopes read,write [--max-sensitivity private] [--read-sources a,b|all]
 *   npm run cli -- list-clients
 *   npm run cli -- review-insight --id <itemId> --action accept|reject --revision <n> [--note "..."]
 *   npm run cli -- seed-demo
 *   npm run cli -- backup [--out /data/backups]
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.js';
import { openDatabase } from './db/connection.js';
import { createClientsRepo, parseScopes } from './core/clients-repo.js';
import { createItemsRepo } from './core/items-repo.js';
import { newItemSchema, type ReadAccess } from './core/types.js';

/** The CLI runs on the DB host as the owner — full access, like the admin token. */
const CLI_ACCESS: ReadAccess = {
  clientId: 'admin',
  isAdmin: true,
  readSources: null,
  maxSensitivity: 'private',
};

function parseFlags(argv: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith('--')) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        flags[arg.slice(2)] = 'true';
      } else {
        flags[arg.slice(2)] = value;
        i++;
      }
    }
  }
  return flags;
}

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString();
}

const DEMO_CLIENTS = [
  { id: 'finance-demo', name: '財經管理 App（demo）' },
  { id: 'crm-demo', name: '人際管理 App（demo）' },
  { id: 'work-demo', name: '工作管理 App（demo）' },
];

const DEMO_ITEMS: { source: string; item: Record<string, unknown> }[] = [
  {
    source: 'finance-demo',
    item: {
      type: 'transaction',
      title: '刷卡：日本機票 NT$18,400',
      content: '華航 台北-東京 來回機票，10/12 出發 10/19 回程，刷國泰 CUBE 卡。',
      data: { amount: -18400, currency: 'TWD', category: 'travel', card: 'CUBE' },
      tags: ['旅遊', '日本'],
      occurred_at: daysAgo(3),
      idempotency_key: 'demo-txn-1',
    },
  },
  {
    source: 'finance-demo',
    item: {
      // "state" + source_item_id：app 每月更新同一個業務物件，而不是灌一堆新 items
      type: 'state',
      title: '本月餐飲預算已用 82%',
      content: '餐飲類別預算 NT$12,000，已支出 NT$9,840，剩 NT$2,160，距月底還有 9 天。',
      data: { budget: 12000, spent: 9840 },
      tags: ['預算', '餐飲'],
      occurred_at: daysAgo(1),
      source_item_id: 'monthly-food-budget',
    },
  },
  {
    source: 'finance-demo',
    item: {
      type: 'task',
      title: '財務規劃：Q3 要重新檢視投資組合配置',
      content: '股債比目前 85/15，偏離目標 75/25，需要在 Q3 底前再平衡。考慮增加美債 ETF。',
      tags: ['財務規劃', '投資'],
      occurred_at: daysAgo(5),
      idempotency_key: 'demo-txn-3',
    },
  },
  {
    source: 'crm-demo',
    item: {
      type: 'contact',
      title: '小美生日 7/20，喜歡手沖咖啡',
      content: '上次聚會她提到最近在學手沖，想要一支好的手沖壺。生日 7/20，記得提前準備禮物。',
      entities: ['person:小美'],
      tags: ['生日', '禮物'],
      occurred_at: daysAgo(10),
      idempotency_key: 'demo-crm-1',
    },
  },
  {
    source: 'crm-demo',
    item: {
      type: 'event',
      title: '答應老王下週約打球',
      content: '老王上週訊息約羽球，答應下週三晚上，場地他訂。要記得帶球拍。',
      entities: ['person:老王'],
      tags: ['運動', '朋友'],
      occurred_at: daysAgo(2),
      idempotency_key: 'demo-crm-2',
    },
  },
  {
    source: 'work-demo',
    item: {
      type: 'task',
      title: 'Q3 產品規劃簡報 7/15 前要交',
      content: '給 VP 的 Q3 roadmap 簡報，需要涵蓋三個新功能的時程與人力估算，7/15 前寄出。',
      entities: ['project:Q3-roadmap'],
      tags: ['簡報', '截止日'],
      occurred_at: daysAgo(4),
      idempotency_key: 'demo-work-1',
    },
  },
  {
    source: 'work-demo',
    item: {
      type: 'event',
      title: '與資安團隊的架構 review 排在 7/10',
      content: 'ContextHub 私有雲部署的資安 review，資安團隊要求先提供網路架構圖與認證設計。',
      entities: ['project:ContextHub'],
      tags: ['會議', '資安'],
      occurred_at: daysAgo(1),
      idempotency_key: 'demo-work-2',
    },
  },
];

function main(): void {
  const [command, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  const config = loadConfig();
  const db = openDatabase(config.dbFile);
  const clientsRepo = createClientsRepo(db);
  const itemsRepo = createItemsRepo(db);

  switch (command) {
    case 'create-client': {
      const { id, name, kind, scopes } = flags;
      const maxSensitivity = flags['max-sensitivity'];
      const readSourcesFlag = flags['read-sources'];
      if (!id || !name || (kind !== 'app' && kind !== 'agent')) {
        console.error(
          'usage: create-client --id <id> --name <name> --kind app|agent [--scopes read,write,review_insight] [--max-sensitivity normal|private] [--read-sources a,b | all]',
        );
        process.exit(1);
      }
      if (maxSensitivity !== undefined && maxSensitivity !== 'normal' && maxSensitivity !== 'private') {
        console.error('--max-sensitivity must be normal or private');
        process.exit(1);
      }
      const readSources =
        readSourcesFlag === undefined || readSourcesFlag === 'all'
          ? null
          : readSourcesFlag.split(',').map((s) => s.trim()).filter(Boolean);
      const { client, apiKey } = clientsRepo.create({
        id,
        name,
        kind,
        scopes: parseScopes((scopes ?? 'read,write').split(',').map((s) => s.trim())),
        maxSensitivity: maxSensitivity as 'normal' | 'private' | undefined,
        readSources,
      });
      console.log(
        `client created: ${client.id} (${client.kind}, scopes: ${client.scopes.join(',')}, max_sensitivity: ${client.max_sensitivity}, read_sources: ${client.read_sources === null ? 'all' : client.read_sources.join(',') || '(none)'})`,
      );
      console.log('');
      console.log(`  API key (shown once, store it now): ${apiKey}`);
      console.log('');
      break;
    }
    case 'list-clients': {
      for (const c of clientsRepo.list()) {
        const sources = c.read_sources === null ? 'all' : c.read_sources.join(',') || '(none)';
        console.log(
          `${c.id.padEnd(20)} ${c.kind.padEnd(6)} scopes=${c.scopes.join(',').padEnd(26)} sens<=${c.max_sensitivity.padEnd(8)} sources=${sources} ${c.disabled ? 'DISABLED' : ''}`,
        );
      }
      break;
    }
    case 'review-insight': {
      // The human review path: you (the hub owner) accept or reject agent
      // proposals from the machine hosting the DB.
      const { id, action, revision, note } = flags;
      if (!id || (action !== 'accept' && action !== 'reject') || !revision) {
        console.error('usage: review-insight --id <itemId> --action accept|reject --revision <n> [--note "..."]');
        process.exit(1);
      }
      const item = itemsRepo.review(id, {
        acceptance: action === 'accept' ? 'accepted' : 'rejected',
        reviewedBy: 'admin',
        expectedRevision: Number(revision),
        note,
      });
      if (!item) {
        console.error(`no item with id "${id}"`);
        process.exit(1);
      }
      console.log(`insight ${item.id} → ${item.acceptance} (revision ${item.revision})`);
      break;
    }
    case 'backup': {
      // WAL means copying the live .db file can miss committed data still in
      // the -wal file. VACUUM INTO writes a consistent snapshot; point NAS
      // backup jobs (e.g. Hyper Backup) at the snapshot directory instead of
      // the live database.
      const outDir = flags.out ?? path.join(config.dataDir, 'backups');
      fs.mkdirSync(outDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const dest = path.join(outDir, `contexthub-${stamp}.db`);
      db.prepare('VACUUM INTO ?').run(dest);
      console.log(`snapshot written: ${dest}`);
      break;
    }
    case 'seed-demo': {
      const existing = new Set(clientsRepo.list().map((c) => c.id));
      for (const dc of DEMO_CLIENTS) {
        if (existing.has(dc.id)) continue;
        const { apiKey } = clientsRepo.create({ id: dc.id, name: dc.name, kind: 'app', scopes: ['read', 'write'] });
        console.log(`created demo client ${dc.id} — API key: ${apiKey}`);
      }
      let created = 0;
      for (const entry of DEMO_ITEMS) {
        const parsed = newItemSchema.parse(entry.item);
        const res = itemsRepo.insert(entry.source, parsed, 'app', CLI_ACCESS);
        if (res.created) created++;
      }
      console.log(`seeded ${created} new demo items (${DEMO_ITEMS.length - created} already existed)`);
      break;
    }
    default:
      console.error('commands: create-client | list-clients | review-insight | seed-demo | backup');
      process.exit(1);
  }
  db.close();
}

main();
