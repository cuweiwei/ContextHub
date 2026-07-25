/**
 * Admin CLI — operates directly on the database file, so it works even when
 * ADMIN_TOKEN is unset. Run on the machine hosting the DB (or in the
 * container: `docker compose exec contexthub node dist/cli.js ...`).
 *
 *   npm run cli -- create-client --id hermes-personal --name "Hermes 秘書" --namespace personal \
 *       --principal-kind agent --profile agent-default [--scopes read,write] [--max-sensitivity private] [--read-sources a,b|all]
 *   npm run cli -- list-clients [--namespace personal]
 *   npm run cli -- rotate-key --id hermes-personal
 *   npm run cli -- disable-client --id hermes-personal [--enable]
 *   npm run cli -- create-namespace --id side-project [--description "..."]
 *   npm run cli -- policy-show --namespace work
 *   npm run cli -- policy-apply --namespace work --file work-policy.json
 *   npm run cli -- register-state-schema --id budget-v1 --file budget-schema.json
 *   npm run cli -- review --id 01K... --action accept|reject|revoke --revision <n> [--note "..."]
 *   npm run cli -- candidates [--namespace personal] [--limit 20]
 *   npm run cli -- audit [--namespace work] [--limit 50]
 *   npm run cli -- reindex          # rebuild FTS from the base table (MANDATORY after restore)
 *   npm run cli -- backup [--out /data/backups]
 *   npm run cli -- purge --id 01K...
 *   npm run cli -- idempotency-gc [--days 90]
 *   npm run cli -- seed-demo
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig } from './config.js';
import { openDatabase } from './db/connection.js';
import { createAuditRepo } from './core/audit-repo.js';
import { createClientsRepo, parseScopes } from './core/clients-repo.js';
import { createCommands } from './core/commands.js';
import { createItemsRepo } from './core/items-repo.js';
import { createPoliciesRepo } from './core/policies-repo.js';
import { GRANT_PROFILES, type GrantProfile } from './core/policy.js';
import { newItemSchema } from './core/types.js';
import { ADMIN_CLIENT } from './http/auth.js';

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
      type: 'state',
      title: '本月餐飲預算已用 82%',
      content: '餐飲類別預算 NT$12,000，已支出 NT$9,840，剩 NT$2,160，距月底還有 9 天。',
      data: { budget: 12000, spent: 9840 },
      tags: ['預算', '餐飲'],
      occurred_at: daysAgo(1),
      source_item_id: 'monthly-food-budget',
      idempotency_key: 'demo-txn-2',
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
  const db = openDatabase(config.dbFile, { synchronous: config.sqliteSynchronous });
  const clientsRepo = createClientsRepo(db);
  const itemsRepo = createItemsRepo(db);
  const policiesRepo = createPoliciesRepo(db);
  const auditRepo = createAuditRepo(db);
  const commands = createCommands({ db, itemsRepo, clientsRepo, policiesRepo, auditRepo });
  /** The CLI runs on the DB host as the owner — same authority as the admin token. */
  const admin = ADMIN_CLIENT;

  switch (command) {
    case 'create-client': {
      const { id, name, namespace, scopes, profile } = flags;
      const principalKind = flags['principal-kind'];
      const maxSensitivity = flags['max-sensitivity'];
      const readSourcesFlag = flags['read-sources'];
      if (
        !id ||
        !name ||
        !namespace ||
        (principalKind !== 'agent' && principalKind !== 'human' && principalKind !== 'service')
      ) {
        console.error(
          'usage: create-client --id <id> --name <name> --namespace <ns> --principal-kind agent|human|service ' +
            `[--profile ${GRANT_PROFILES.join('|')}] [--scopes read,write,review_insight] [--max-sensitivity normal|private] [--read-sources a,b | all]`,
        );
        process.exit(1);
      }
      if (maxSensitivity !== undefined && maxSensitivity !== 'normal' && maxSensitivity !== 'private') {
        console.error('--max-sensitivity must be normal or private');
        process.exit(1);
      }
      if (profile !== undefined && !(GRANT_PROFILES as readonly string[]).includes(profile)) {
        console.error(`--profile must be one of ${GRANT_PROFILES.join(', ')}`);
        process.exit(1);
      }
      const readSources =
        readSourcesFlag === undefined || readSourcesFlag === 'all'
          ? null
          : readSourcesFlag.split(',').map((s) => s.trim()).filter(Boolean);
      const { client, apiKey } = commands.adminCreateClient(admin, {
        id,
        name,
        namespace,
        principalKind,
        scopes: parseScopes((scopes ?? 'read,write').split(',').map((s) => s.trim())),
        maxSensitivity: maxSensitivity as 'normal' | 'private' | undefined,
        readSources,
        profile: (profile as GrantProfile | undefined) ?? 'none',
      });
      console.log(
        `client created: ${client.id} (${client.principal_kind} @ ${client.namespace}, scopes: ${client.scopes.join(',')}, profile: ${profile ?? 'none'})`,
      );
      console.log('');
      console.log(`  API key (shown once, store it now): ${apiKey}`);
      console.log('');
      if (!profile || profile === 'none') {
        console.log('  NOTE: no grant profile applied — the client has NO capabilities until you edit the namespace policy.');
      }
      break;
    }
    case 'list-clients': {
      for (const c of clientsRepo.list(flags.namespace)) {
        const sources = c.read_sources === null ? 'all' : c.read_sources.join(',') || '(none)';
        console.log(
          `${c.id.padEnd(24)} ${c.namespace.padEnd(10)} ${c.principal_kind.padEnd(8)} scopes=${c.scopes.join(',').padEnd(26)} sens<=${c.max_sensitivity.padEnd(8)} keyv=${c.credential_version} sources=${sources} ${c.disabled ? 'DISABLED' : ''}`,
        );
      }
      break;
    }
    case 'rotate-key': {
      if (!flags.id) {
        console.error('usage: rotate-key --id <clientId>');
        process.exit(1);
      }
      const { client, apiKey } = commands.adminRotateKey(admin, flags.id);
      console.log(`key rotated for ${client.id} (credential_version ${client.credential_version}); old key is dead.`);
      console.log(`  New API key (shown once): ${apiKey}`);
      break;
    }
    case 'disable-client': {
      if (!flags.id) {
        console.error('usage: disable-client --id <clientId> [--enable]');
        process.exit(1);
      }
      const disable = flags.enable !== 'true';
      const ok = commands.adminSetDisabled(admin, flags.id, disable);
      console.log(ok ? `${flags.id} ${disable ? 'disabled' : 'enabled'}` : `no client "${flags.id}"`);
      break;
    }
    case 'create-namespace': {
      if (!flags.id) {
        console.error('usage: create-namespace --id <ns> [--description "..."]');
        process.exit(1);
      }
      commands.adminCreateNamespace(admin, flags.id, flags.description);
      console.log(`namespace "${flags.id}" created with an empty deny-by-default policy (v1)`);
      break;
    }
    case 'policy-show': {
      if (!flags.namespace) {
        console.error('usage: policy-show --namespace <ns>');
        process.exit(1);
      }
      const current = commands.getPolicy(admin, flags.namespace);
      if (!current) {
        console.error(`namespace "${flags.namespace}" has no VALID current policy — everything is denied (fail-closed)`);
        process.exit(1);
      }
      console.log(JSON.stringify(current, null, 2));
      break;
    }
    case 'policy-apply': {
      if (!flags.namespace || !flags.file) {
        console.error('usage: policy-apply --namespace <ns> --file <rules.json>');
        process.exit(1);
      }
      const rules = JSON.parse(fs.readFileSync(flags.file, 'utf8'));
      const res = commands.applyPolicy(admin, flags.namespace, rules);
      console.log(`policy for "${res.namespace}" is now version ${res.version}`);
      break;
    }
    case 'register-state-schema': {
      if (!flags.id || !flags.file) {
        console.error('usage: register-state-schema --id <schemaId> --file <schema.json>');
        process.exit(1);
      }
      commands.adminRegisterStateSchema(admin, flags.id, JSON.parse(fs.readFileSync(flags.file, 'utf8')));
      console.log(`state schema "${flags.id}" registered`);
      break;
    }
    case 'review': {
      const { id, action, revision, note } = flags;
      if (!id || (action !== 'accept' && action !== 'reject' && action !== 'revoke') || !revision) {
        console.error('usage: review --id <itemId> --action accept|reject|revoke --revision <n> [--note "..."]');
        process.exit(1);
      }
      const { item } = commands.reviewMemory(
        admin,
        id,
        { decision: action, expectedRevision: Number(revision), note },
        `cli-review-${randomUUID()}`,
      );
      console.log(`item ${item.id} → trust_state=${item.trust_state} (revision ${item.revision})`);
      if (item.successor_of && item.trust_state === 'accepted') {
        console.log(`  predecessor ${item.successor_of} atomically marked superseded`);
      }
      break;
    }
    case 'candidates': {
      const items = commands.listCandidates(admin, 'inbox', Number(flags.limit ?? 20));
      for (const it of items) {
        console.log(`${it.id}  [${it.namespace}] ${it.source.padEnd(20)} ${it.type.padEnd(10)} rev=${it.revision}  ${it.title}`);
      }
      if (items.length === 0) console.log('no pending candidates');
      break;
    }
    case 'audit': {
      const entries = auditRepo.query({ namespace: flags.namespace, limit: Number(flags.limit ?? 50) });
      for (const e of entries) {
        console.log(
          `#${e.id} ${e.ts} [${e.namespace}] ${e.client_id.padEnd(20)} ${e.outcome.padEnd(5)} ${e.action}${e.item_id ? ' ' + e.item_id : ''}${e.details ? ' ' + JSON.stringify(e.details) : ''}`,
        );
      }
      break;
    }
    case 'reindex': {
      const { indexed } = itemsRepo.reindex();
      console.log(`FTS index rebuilt from base table: ${indexed} items indexed`);
      break;
    }
    case 'backup': {
      // WAL means copying the live .db can miss committed data still in the
      // -wal file. VACUUM INTO writes a consistent snapshot; point NAS backup
      // jobs (Hyper Backup, with its client-side encryption ON) at the
      // snapshot directory. After RESTORING a snapshot, ALWAYS run `reindex`
      // (implicit rowids may be renumbered by VACUUM, invalidating FTS).
      const outDir = flags.out ?? path.join(config.dataDir, 'backups');
      fs.mkdirSync(outDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const dest = path.join(outDir, `contexthub-${stamp}.db`);
      db.prepare('VACUUM INTO ?').run(dest);
      console.log(`snapshot written: ${dest}`);
      break;
    }
    case 'purge': {
      if (!flags.id) {
        console.error('usage: purge --id <itemId>   # HARD delete: item + versions + reviews + index');
        process.exit(1);
      }
      const { purged } = commands.purgeItem(admin, flags.id, `cli-purge-${randomUUID()}`);
      console.log(purged ? `item ${flags.id} purged (audit keeps a metadata row)` : `no item "${flags.id}"`);
      break;
    }
    case 'idempotency-gc': {
      const removed = commands.idempotencyGc(Number(flags.days ?? 90));
      console.log(`removed ${removed} idempotency records older than ${flags.days ?? 90} days`);
      break;
    }
    case 'seed-demo': {
      const existing = new Set(clientsRepo.list().map((c) => c.id));
      for (const dc of DEMO_CLIENTS) {
        if (existing.has(dc.id)) continue;
        const { apiKey } = commands.adminCreateClient(admin, {
          id: dc.id,
          name: dc.name,
          namespace: 'personal',
          principalKind: 'service',
          scopes: ['read', 'write'],
          profile: 'app-producer',
        });
        console.log(`created demo client ${dc.id} — API key: ${apiKey}`);
      }
      let created = 0;
      for (const entry of DEMO_ITEMS) {
        const parsed = newItemSchema.parse(entry.item);
        const res = commands.createMemory(admin, parsed, { source: entry.source });
        if (res.created) created++;
      }
      console.log(`seeded ${created} new demo items (${DEMO_ITEMS.length - created} already existed)`);
      break;
    }
    default:
      console.error(
        'commands: create-client | list-clients | rotate-key | disable-client | create-namespace | policy-show | policy-apply | register-state-schema | review | candidates | audit | reindex | backup | purge | idempotency-gc | seed-demo',
      );
      process.exit(1);
  }
  db.close();
}

main();
