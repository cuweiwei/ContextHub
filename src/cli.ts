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
 *   npm run cli -- reindex          # rebuild FTS + vectors (MANDATORY after restore/upgrade)
 *   npm run cli -- retrieval-status # vector extension/model/index coverage
 *   npm run cli -- backup [--out /data/backups]
 *   npm run cli -- audit-verify | audit-anchor | audit-chain-extend
 *   npm run cli -- namespace-export --namespace personal --out archive.jsonl
 *   npm run cli -- namespace-import --archive archive.jsonl --target-namespace personal
 *   npm run cli -- purge --id 01K...
 *   npm run cli -- idempotency-gc [--days 90]
 *   npm run cli -- seed-demo
 *   npm run cli -- web-principal-add --provider tailscale --subject user@example.com --name "Owner" --control-admin
 *   npm run cli -- web-principal-link --subject user@example.com --client tim-reviewer-personal
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { loadConfig } from './config.js';
import { openDatabase, openExistingDatabase } from './db/connection.js';
import { createAuditRepo } from './core/audit-repo.js';
import { createClientsRepo, parseScopes } from './core/clients-repo.js';
import { createCommands } from './core/commands.js';
import { createItemsRepo } from './core/items-repo.js';
import { createPoliciesRepo } from './core/policies-repo.js';
import { GRANT_PROFILES, type GrantProfile } from './core/policy.js';
import { newItemSchema } from './core/types.js';
import { ADMIN_CLIENT } from './http/auth.js';
import { createWebPrincipalsRepo } from './core/web-principals-repo.js';
import { createBackup, restoreDrill, runDoctor, writeMaintenanceRecord } from './core/maintenance.js';
import { buildInfo } from './build-info.js';
import { exportNamespace, importNamespace } from './core/namespace-archive.js';
import { auditChainExtend, verifyAuditAnchor, writeAuditAnchor } from './core/audit-chain-admin.js';

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
  if (command === 'backup') {
    // Backups are maintenance reads and must never become an implicit schema
    // upgrade. This also lets the NAS deploy workflow create a verified
    // manifest with the candidate image before that image is allowed to start.
    const db = openExistingDatabase(config.dbFile);
    try {
      const outDir = flags.out ?? path.join(config.dataDir, 'backups');
      const manifest = createBackup(db, { outDir });
      console.log(`snapshot written: ${manifest.database.file}`);
      console.log(`manifest written: ${manifest.database.file.replace(/\.db$/, '.manifest.json')}`);
    } finally {
      db.close();
    }
    return;
  }
  if (command === 'doctor') {
    const db = openExistingDatabase(config.dbFile);
    const report = runDoctor(db, config.dataDir);
    db.close();
    if (flags.json === 'true') console.log(JSON.stringify(report, null, 2));
    else {
      console.log(`ContextHub doctor: ${report.status.toUpperCase()} (exit ${report.exit_code})`);
      for (const [name, check] of Object.entries(report.checks)) console.log(`${check.status.padEnd(4)} ${name}: ${check.message} — ${check.remediation}`);
    }
    process.exitCode = report.exit_code;
    return;
  }
  if (command === 'restore-drill') {
    const manifest = flags.snapshot;
    if (!manifest) {
      console.error('usage: restore-drill --snapshot <manifest.json> [--json]');
      process.exitCode = 2;
      return;
    }
    const record = restoreDrill(path.resolve(manifest), config.dataDir);
    if (flags.json === 'true') console.log(JSON.stringify(record, null, 2));
    else console.log(`restore drill ${record.status}: ${record.checks.filter((c) => c.status === 'pass').length}/${record.checks.length} checks passed`);
    process.exitCode = record.status === 'pass' ? 0 : 2;
    return;
  }
  const db = openDatabase(config.dbFile, { synchronous: config.sqliteSynchronous });
  const clientsRepo = createClientsRepo(db);
  const itemsRepo = createItemsRepo(db);
  const policiesRepo = createPoliciesRepo(db);
  const auditRepo = createAuditRepo(db);
  const commands = createCommands({ db, itemsRepo, clientsRepo, policiesRepo, auditRepo, webhookAllowedHosts: config.webhookAllowedHosts, webhookSigningMasterKey: config.webhookSigningMasterKey });
  const webPrincipalsRepo = createWebPrincipalsRepo(db);
  /** The CLI runs on the DB host as the owner — same authority as the admin token. */
  const admin = ADMIN_CLIENT;

  switch (command) {
    case 'audit-verify': {
      const result = auditRepo.verifyChain();
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.verified ? 0 : 2;
      break;
    }
    case 'audit-chain-extend': {
      const result = auditChainExtend(db);
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.status.verified ? 0 : 2;
      break;
    }
    case 'audit-anchor': {
      if (!flags.out) { console.error('usage: audit-anchor --out <path> [--backup-id <id>]'); process.exit(2); }
      const anchor = writeAuditAnchor(db, flags.out, buildInfo.version, buildInfo.schema_version, flags['backup-id']);
      console.log(JSON.stringify(anchor, null, 2));
      break;
    }
    case 'namespace-export': {
      if (!flags.namespace || !flags.out) { console.error('usage: namespace-export --namespace <ns> --out <archive.jsonl>'); process.exit(2); }
      const result = exportNamespace(db, flags.namespace, flags.out);
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    case 'oauth-bind': {
      if (!flags.issuer || !flags.subject || !flags.client) { console.error('usage: oauth-bind --issuer <issuer> --subject <subject> --client <client-id>'); process.exit(2); }
      const target = clientsRepo.get(flags.client);
      if (!target) { console.error('client not found'); process.exit(2); }
      db.prepare('INSERT INTO oauth_bindings (issuer, subject, namespace, client_id, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(issuer, subject) DO UPDATE SET namespace = excluded.namespace, client_id = excluded.client_id').run(flags.issuer, flags.subject, target.namespace, target.id, new Date().toISOString(), admin.id);
      auditRepo.log({ namespace: target.namespace, clientId: admin.id, action: 'admin.oauth_bind', outcome: 'allow', details: { issuer: flags.issuer, subject_hash: createHash('sha256').update(flags.subject).digest('hex').slice(0, 16), client_id: target.id } });
      console.log(`OAuth subject bound to ${target.id} (${target.namespace})`);
      break;
    }
    case 'namespace-import': {
      if (!flags.archive || !flags['target-namespace']) { console.error('usage: namespace-import --archive <archive.jsonl> --target-namespace <ns> --mode candidates|trusted --collision fail|skip|remap [--source-map map.json] [--dry-run]'); process.exit(2); }
      const mode = flags.mode === 'trusted' ? 'trusted' : flags.mode === 'candidates' || flags.mode === undefined ? 'candidates' : null;
      const collision = flags.collision === 'skip' || flags.collision === 'remap' || flags.collision === 'fail' || flags.collision === undefined ? (flags.collision ?? 'fail') : null;
      if (!mode || !collision) { console.error('invalid mode or collision'); process.exit(2); }
      if (mode === 'trusted' && flags['break-glass'] !== 'true') { console.error('trusted import requires --break-glass true on the NAS host'); process.exit(2); }
      let sourceMap: Record<string, string> | undefined;
      if (flags['source-map']) sourceMap = JSON.parse(fs.readFileSync(flags['source-map'], 'utf8')) as Record<string, string>;
      const snapshotDir = path.join(config.dataDir, 'backups');
      const snapshot = createBackup(db, { outDir: snapshotDir });
      const result = importNamespace(db, commands, path.resolve(flags.archive), flags['target-namespace'], { sourceMap, mode, collision, dryRun: flags['dry-run'] === 'true', snapshotPath: snapshot.database.file });
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    case 'namespace-import-rollback': {
      if (!flags.run) { console.error('usage: namespace-import-rollback --run <run_id>'); process.exit(2); }
      const run = db.prepare("SELECT id, mode, status FROM namespace_import_runs WHERE id = ?").get(flags.run) as { id: string; mode: string; status: string } | undefined;
      if (!run) { console.error('no such import run'); process.exit(2); }
      if (run.mode !== 'candidates') { console.error('trusted import rollback requires restoring its snapshot'); process.exit(2); }
      const rows = db.prepare("SELECT p.item_id, p.imported_revision, i.revision, i.trust_state FROM import_provenance p JOIN context_items i ON i.id = p.item_id WHERE p.run_id = ?").all(flags.run) as Array<{ item_id: string; imported_revision: number | null; revision: number; trust_state: string }>;
      let purged = 0;
      for (const row of rows) if (row.trust_state === 'candidate' && row.imported_revision === row.revision) { const result = commands.purgeItem(admin, row.item_id, `rollback:${flags.run}:${row.item_id}`); if (result.purged) purged += 1; }
      db.prepare("UPDATE namespace_import_runs SET status = 'rolled_back', completed_at = ? WHERE id = ?").run(new Date().toISOString(), flags.run);
      console.log(JSON.stringify({ run_id: flags.run, purged }, null, 2));
      break;
    }
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
    case 'web-principal-add': {
      const provider = flags.provider;
      const subject = flags.subject?.trim().toLowerCase();
      const name = flags.name;
      if (!provider || !subject || !name) {
        console.error('usage: web-principal-add --provider tailscale --subject <login> --name <name> [--control-admin]');
        process.exit(1);
      }
      const principal = webPrincipalsRepo.add({ provider, subject, displayName: name, controlAdmin: flags['control-admin'] === 'true' });
      auditRepo.log({ namespace: '*', clientId: ADMIN_CLIENT.id, action: 'web.principal.create', outcome: 'allow', details: { principal_id: principal.id, provider, control_admin: principal.controlAdmin } });
      console.log(`web principal created: ${principal.id} (${principal.provider}:${principal.subject})`);
      break;
    }
    case 'web-principal-link': {
      const subject = flags.subject?.trim().toLowerCase();
      const clientId = flags.client;
      if (!subject || !clientId) {
        console.error('usage: web-principal-link --subject <login> [--provider tailscale] --client <human-client-id>');
        process.exit(1);
      }
      const principal = webPrincipalsRepo.getByIdentity(flags.provider ?? 'tailscale', subject);
      const target = clientsRepo.get(clientId);
      if (!principal || !target) {
        console.error('principal or client not found');
        process.exit(1);
      }
      webPrincipalsRepo.linkClient(principal.id, target, ADMIN_CLIENT.id);
      auditRepo.log({ namespace: target.namespace, clientId: ADMIN_CLIENT.id, action: 'web.principal.link_client', outcome: 'allow', details: { principal_id: principal.id, target: clientId } });
      console.log(`linked ${principal.subject} to ${target.id} (${target.namespace})`);
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
      const { indexed, vectorIndexed } = itemsRepo.reindex();
      console.log(
        `retrieval projections rebuilt from base table: FTS=${indexed}, vectors=${vectorIndexed}`,
      );
      break;
    }
    case 'retrieval-status': {
      console.log(JSON.stringify(itemsRepo.retrievalProjectionStatus(), null, 2));
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
      writeMaintenanceRecord(config.dataDir, {
        format: 'contexthub-maintenance/v1', kind: 'idempotency_gc', status: 'pass',
        started_at: new Date().toISOString(), completed_at: new Date().toISOString(),
        runtime: buildInfo,
        checks: [{ name: 'gc', status: 'pass' }], details: { removed, days: Number(flags.days ?? 90) },
      });
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
        void apiKey;
        console.log(`created demo client ${dc.id}`);
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
        'commands: create-client | list-clients | rotate-key | disable-client | create-namespace | policy-show | policy-apply | register-state-schema | review | candidates | audit | audit-verify | audit-anchor | audit-chain-extend | oauth-bind | namespace-export | namespace-import | namespace-import-rollback | reindex | retrieval-status | backup | restore-drill | doctor | purge | idempotency-gc | seed-demo',
      );
      process.exit(1);
  }
  db.close();
}

main();
