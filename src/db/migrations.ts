import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { seedPersonalPolicy, seedWorkPolicy, validatePolicy } from '../core/policy.js';

// Migrations are embedded as strings so the compiled dist/ needs no extra
// asset copying. `post` hooks run inside the same transaction as the SQL and
// are written against the schema AS OF that migration (never import repos
// here — future migrations would break them).
const MIGRATIONS: {
  version: number;
  name: string;
  sql: string;
  post?: (db: Database.Database) => void;
}[] = [
  {
    version: 1,
    name: 'init',
    sql: `
      CREATE TABLE clients (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('app','agent')),
        api_key_hash TEXT NOT NULL,
        scopes TEXT NOT NULL,
        created_at TEXT NOT NULL,
        disabled INTEGER NOT NULL DEFAULT 0
      );
      CREATE UNIQUE INDEX idx_clients_key ON clients(api_key_hash);

      CREATE TABLE context_items (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        data TEXT,
        tags TEXT NOT NULL DEFAULT '[]',
        entities TEXT NOT NULL DEFAULT '[]',
        sensitivity TEXT NOT NULL DEFAULT 'normal' CHECK (sensitivity IN ('normal','private')),
        occurred_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT,
        idempotency_key TEXT,
        deleted INTEGER NOT NULL DEFAULT 0
      );
      CREATE UNIQUE INDEX idx_items_idem ON context_items(source, idempotency_key)
        WHERE idempotency_key IS NOT NULL;
      CREATE INDEX idx_items_source ON context_items(source, id);
      CREATE INDEX idx_items_type ON context_items(type, id);
      CREATE INDEX idx_items_occurred ON context_items(occurred_at);

      -- Full-text index. Stores CJK-segmented copies of title/content/tags
      -- (spaces injected between CJK chars) so 2-character Chinese queries work
      -- with the unicode61 tokenizer. rowid mirrors context_items.rowid and is
      -- kept in sync by items-repo on every write. Fully rebuildable with the
      -- \`reindex\` command (mandatory after a snapshot restore).
      CREATE VIRTUAL TABLE items_fts USING fts5(
        title, content, tags,
        tokenize = 'unicode61'
      );
    `,
  },
  {
    version: 2,
    name: 'provenance-lifecycle-acl',
    sql: `
      ALTER TABLE context_items ADD COLUMN authority TEXT NOT NULL DEFAULT 'app'
        CHECK (authority IN ('user','app','agent'));
      ALTER TABLE context_items ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active','completed','cancelled','superseded'));
      ALTER TABLE context_items ADD COLUMN confidence REAL;
      ALTER TABLE context_items ADD COLUMN source_item_id TEXT;
      ALTER TABLE context_items ADD COLUMN source_uri TEXT;
      ALTER TABLE context_items ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
      CREATE UNIQUE INDEX idx_items_source_item ON context_items(source, source_item_id)
        WHERE source_item_id IS NOT NULL;
      CREATE INDEX idx_items_status ON context_items(status, type);

      ALTER TABLE clients ADD COLUMN max_sensitivity TEXT NOT NULL DEFAULT 'normal'
        CHECK (max_sensitivity IN ('normal','private'));
    `,
  },
  {
    version: 3,
    name: 'insight-review-evidence-acl',
    sql: `
      ALTER TABLE context_items ADD COLUMN acceptance TEXT
        CHECK (acceptance IN ('proposed','accepted','rejected'));
      ALTER TABLE context_items ADD COLUMN reviewed_by TEXT;
      ALTER TABLE context_items ADD COLUMN reviewed_at TEXT;
      ALTER TABLE context_items ADD COLUMN review_note TEXT;
      CREATE INDEX idx_items_acceptance ON context_items(acceptance)
        WHERE acceptance IS NOT NULL;

      CREATE TABLE insight_evidence (
        insight_id TEXT NOT NULL REFERENCES context_items(id),
        evidence_id TEXT NOT NULL REFERENCES context_items(id),
        PRIMARY KEY (insight_id, evidence_id)
      );
      CREATE INDEX idx_evidence_reverse ON insight_evidence(evidence_id);

      ALTER TABLE clients ADD COLUMN read_sources TEXT;

      UPDATE context_items SET acceptance = 'proposed' WHERE type = 'insight';
    `,
  },
  {
    version: 4,
    name: 'namespaces-identity-policy-audit',
    sql: `
      -- Namespaces are first-class: existence is a registration, not "some row
      -- mentions this string". A namespace without a valid current policy is
      -- unusable (fail-closed).
      CREATE TABLE namespaces (
        id TEXT PRIMARY KEY,
        description TEXT,
        created_at TEXT NOT NULL
      );
      INSERT INTO namespaces (id, description, created_at) VALUES
        ('personal', 'Personal memories', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        ('work', 'Work memories (see ADR-001 for what may be stored here)', strftime('%Y-%m-%dT%H:%M:%fZ','now'));

      -- One credential = one namespace, decided server-side. The slug id is the
      -- immutable principal identity: never reused, never renamed; keys rotate
      -- via credential_version, disablement is a timestamp (soft, reversible).
      ALTER TABLE clients ADD COLUMN namespace TEXT REFERENCES namespaces(id);
      ALTER TABLE clients ADD COLUMN principal_kind TEXT
        CHECK (principal_kind IN ('agent','human','service'));
      ALTER TABLE clients ADD COLUMN credential_version INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE clients ADD COLUMN disabled_at TEXT;
      -- One-time backfill of pre-namespace data. This is a migration decision,
      -- NOT a runtime default: new clients must state their namespace.
      UPDATE clients SET namespace = 'personal' WHERE namespace IS NULL;
      UPDATE clients SET principal_kind = CASE kind WHEN 'agent' THEN 'agent' ELSE 'service' END
        WHERE principal_kind IS NULL;

      ALTER TABLE context_items ADD COLUMN namespace TEXT NOT NULL DEFAULT 'personal';
      CREATE INDEX idx_items_namespace ON context_items(namespace, id);

      -- Versioned policies: policy_versions is append-only history; policies
      -- points at the version currently in force. Items record which policy
      -- version/rule accepted them, so "why was this auto-accepted" stays
      -- answerable after policy changes.
      CREATE TABLE policy_versions (
        namespace TEXT NOT NULL REFERENCES namespaces(id),
        version INTEGER NOT NULL,
        rules TEXT NOT NULL,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        PRIMARY KEY (namespace, version)
      );
      CREATE TABLE policies (
        namespace TEXT PRIMARY KEY REFERENCES namespaces(id),
        current_version INTEGER NOT NULL
      );

      -- Application-level append-only audit (no UPDATE/DELETE code path
      -- exists). details carries summaries only — never item content or raw
      -- query text. Not tamper-proof against a hostile DB administrator; see
      -- ADR-001 for the honest boundary.
      CREATE TABLE audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        namespace TEXT NOT NULL,
        client_id TEXT NOT NULL,
        action TEXT NOT NULL,
        item_id TEXT,
        outcome TEXT NOT NULL CHECK (outcome IN ('allow','deny')),
        details TEXT
      );
      CREATE INDEX idx_audit_ns ON audit_log(namespace, id);
    `,
    post: (db) => {
      const now = new Date().toISOString();
      const clients = db
        .prepare("SELECT id, principal_kind FROM clients WHERE namespace = 'personal'")
        .all() as { id: string; principal_kind: string }[];
      const ids = new Set(clients.map((c) => c.id));
      const personal = validatePolicy(
        seedPersonalPolicy(clients.map((c) => ({ id: c.id, principalKind: c.principal_kind }))),
        { namespaceClientIds: ids, stateSchemaIds: new Set() },
      );
      const work = validatePolicy(seedWorkPolicy(), {
        namespaceClientIds: new Set(),
        stateSchemaIds: new Set(),
      });
      const insertVersion = db.prepare(
        'INSERT INTO policy_versions (namespace, version, rules, created_at, created_by) VALUES (?, 1, ?, ?, ?)',
      );
      const insertCurrent = db.prepare('INSERT INTO policies (namespace, current_version) VALUES (?, 1)');
      insertVersion.run('personal', JSON.stringify(personal), now, 'migration-v4');
      insertCurrent.run('personal');
      insertVersion.run('work', JSON.stringify(work), now, 'migration-v4');
      insertCurrent.run('work');
    },
  },
  {
    version: 5,
    name: 'trust-lifecycle-versions-idempotency',
    sql: `
      -- Trust dimension, separate from provenance (authority) and lifecycle
      -- (status). The legacy insight-only 'acceptance' column stops being
      -- written; trust_state is authoritative for ALL items.
      ALTER TABLE context_items ADD COLUMN trust_state TEXT NOT NULL DEFAULT 'accepted'
        CHECK (trust_state IN ('candidate','accepted','rejected','revoked'));
      ALTER TABLE context_items ADD COLUMN acceptance_method TEXT
        CHECK (acceptance_method IN ('human_review','policy','trusted_import'));
      ALTER TABLE context_items ADD COLUMN accepted_by TEXT;
      ALTER TABLE context_items ADD COLUMN accepted_at TEXT;
      ALTER TABLE context_items ADD COLUMN acceptance_policy_version INTEGER;
      ALTER TABLE context_items ADD COLUMN acceptance_rule_id TEXT;
      -- Conflict model: single-winner succession. successor_of links a
      -- candidate to the accepted item it proposes to replace; accepting it
      -- atomically sets superseded_by on the predecessor.
      ALTER TABLE context_items ADD COLUMN successor_of TEXT;
      ALTER TABLE context_items ADD COLUMN superseded_by TEXT;
      -- Operational state slots: machine-updated, schema-validated, excluded
      -- from the general read surfaces (read via state rules only).
      ALTER TABLE context_items ADD COLUMN state_kind TEXT
        CHECK (state_kind IN ('semantic','operational'));
      ALTER TABLE context_items ADD COLUMN state_key TEXT;
      ALTER TABLE context_items ADD COLUMN schema_id TEXT;
      CREATE UNIQUE INDEX idx_items_state_key ON context_items(namespace, state_key)
        WHERE state_key IS NOT NULL;
      CREATE INDEX idx_items_trust ON context_items(namespace, trust_state);

      CREATE TABLE state_schemas (
        schema_id TEXT PRIMARY KEY,
        json_schema TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      -- Full snapshot per revision, append-only, written in the same
      -- transaction as every mutation.
      CREATE TABLE item_versions (
        item_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        snapshot TEXT NOT NULL,
        change_kind TEXT NOT NULL,
        changed_by TEXT NOT NULL,
        changed_at TEXT NOT NULL,
        PRIMARY KEY (item_id, revision)
      );

      -- Append-only review/adjudication events (the denormalized reviewed_*
      -- columns on context_items keep only the latest verdict).
      CREATE TABLE item_reviews (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id TEXT NOT NULL,
        item_revision INTEGER NOT NULL,
        decision TEXT NOT NULL,
        decided_by TEXT NOT NULL,
        decided_at TEXT NOT NULL,
        note TEXT
      );
      CREATE INDEX idx_reviews_item ON item_reviews(item_id, id);

      -- Retry safety for a system of record: same key + same payload replays
      -- the stored result; same key + different payload is a conflict.
      CREATE TABLE idempotency_records (
        namespace TEXT NOT NULL,
        client_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        operation TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (namespace, client_id, idempotency_key)
      );

      -- Conservative trust backfill (owner decision, see plan):
      --   agent-authored non-insights  -> candidate (never reviewed by anyone)
      --   insights                     -> map from legacy acceptance
      --   app/user-authored            -> accepted (apps are trusted producers
      --                                   of their own projections)
      UPDATE context_items SET trust_state = CASE
        WHEN type = 'insight' AND acceptance = 'proposed' THEN 'candidate'
        WHEN type = 'insight' AND acceptance = 'rejected' THEN 'rejected'
        WHEN type != 'insight' AND authority = 'agent' THEN 'candidate'
        ELSE 'accepted'
      END;
      UPDATE context_items SET acceptance_method = CASE
        WHEN authority = 'user' THEN 'trusted_import'
        WHEN type = 'insight' THEN 'human_review'
        ELSE 'policy'
      END WHERE trust_state = 'accepted';
      UPDATE context_items SET accepted_by = reviewed_by, accepted_at = reviewed_at
        WHERE type = 'insight' AND trust_state = 'accepted' AND reviewed_by IS NOT NULL;
      -- Pre-existing 'state' items are app projections: semantic by default.
      UPDATE context_items SET state_kind = 'semantic' WHERE type = 'state';
    `,
    post: (db) => {
      const now = new Date().toISOString();
      // Seed version history: one 'migrate' snapshot per surviving item so the
      // history surface is never empty for pre-v5 data.
      const rows = db.prepare('SELECT * FROM context_items WHERE deleted = 0').all() as Record<
        string,
        unknown
      >[];
      const insertVersion = db.prepare(
        'INSERT INTO item_versions (item_id, revision, snapshot, change_kind, changed_by, changed_at) VALUES (?, ?, ?, ?, ?, ?)',
      );
      for (const row of rows) {
        insertVersion.run(
          row.id,
          row.revision,
          JSON.stringify(row),
          'migrate',
          'migration-v5',
          now,
        );
      }
      // Reconstruct review events for previously reviewed insights.
      const reviewed = db
        .prepare(
          "SELECT id, revision, acceptance, reviewed_by, reviewed_at, review_note FROM context_items WHERE type = 'insight' AND reviewed_by IS NOT NULL",
        )
        .all() as {
        id: string;
        revision: number;
        acceptance: string;
        reviewed_by: string;
        reviewed_at: string;
        review_note: string | null;
      }[];
      const insertReview = db.prepare(
        'INSERT INTO item_reviews (item_id, item_revision, decision, decided_by, decided_at, note) VALUES (?, ?, ?, ?, ?, ?)',
      );
      for (const r of reviewed) {
        insertReview.run(r.id, r.revision, r.acceptance === 'accepted' ? 'accept' : 'reject', r.reviewed_by, r.reviewed_at, r.review_note);
      }
      // Inventory CSV for the owner to audit the conservative mapping.
      if (!db.memory) {
        const dir = path.join(path.dirname(db.name), 'backups');
        fs.mkdirSync(dir, { recursive: true });
        const stamp = now.replace(/[:.]/g, '-');
        const lines = ['id,namespace,source,type,authority,legacy_acceptance,trust_state'];
        const inv = db
          .prepare('SELECT id, namespace, source, type, authority, acceptance, trust_state FROM context_items')
          .all() as Record<string, string | null>[];
        for (const r of inv) {
          lines.push(
            [r.id, r.namespace, r.source, r.type, r.authority, r.acceptance ?? '', r.trust_state].join(','),
          );
        }
        fs.writeFileSync(path.join(dir, `migration-v5-inventory-${stamp}.csv`), lines.join('\n') + '\n');
      }
    },
  },
  {
    version: 6,
    name: 'context-memory-separation-compiler-feedback',
    sql: `
      -- Persistent information layers. Compiled context packages are
      -- intentionally ephemeral and therefore never stored in context_items.
      ALTER TABLE context_items ADD COLUMN information_class TEXT NOT NULL DEFAULT 'source'
        CHECK (information_class IN ('source','memory','task_state'));
      ALTER TABLE context_items ADD COLUMN memory_kind TEXT
        CHECK (memory_kind IN ('fact','preference','decision','experience','procedure','relationship','working_state'));
      ALTER TABLE context_items ADD COLUMN valid_from TEXT;
      ALTER TABLE context_items ADD COLUMN valid_until TEXT;
      ALTER TABLE context_items ADD COLUMN last_verified_at TEXT;
      ALTER TABLE context_items ADD COLUMN decay_policy TEXT
        CHECK (decay_policy IN ('none','standard','rapid'));

      -- Conservative classification of legacy rows. App projections remain
      -- source unless they were explicit insights; user/agent assertions are
      -- memories. Operational exact-key slots are task state.
      UPDATE context_items SET information_class = CASE
        WHEN state_kind = 'operational' THEN 'task_state'
        WHEN authority IN ('user','agent') OR type = 'insight' THEN 'memory'
        ELSE 'source'
      END;
      UPDATE context_items SET memory_kind = CASE type
        WHEN 'fact' THEN 'fact'
        WHEN 'preference' THEN 'preference'
        WHEN 'decision' THEN 'decision'
        WHEN 'experience' THEN 'experience'
        WHEN 'procedure' THEN 'procedure'
        WHEN 'contact' THEN 'relationship'
        WHEN 'relationship' THEN 'relationship'
        WHEN 'task' THEN 'working_state'
        WHEN 'state' THEN 'working_state'
        WHEN 'working_state' THEN 'working_state'
        ELSE NULL
      END WHERE information_class = 'memory';
      UPDATE context_items SET decay_policy = CASE memory_kind
        WHEN 'fact' THEN 'none'
        WHEN 'preference' THEN 'none'
        WHEN 'decision' THEN 'none'
        WHEN 'procedure' THEN 'none'
        WHEN 'relationship' THEN 'none'
        WHEN 'working_state' THEN 'rapid'
        WHEN 'experience' THEN 'standard'
        ELSE NULL
      END WHERE information_class = 'memory';
      CREATE INDEX idx_items_information_class ON context_items(namespace, information_class, memory_kind);
      CREATE INDEX idx_items_validity ON context_items(namespace, valid_from, valid_until);

      -- Outcome feedback closes the context -> action -> memory lifecycle
      -- without persisting prompts or compiled package contents. It records
      -- only ids and coarse effectiveness signals.
      CREATE TABLE context_outcomes (
        id TEXT PRIMARY KEY,
        package_id TEXT NOT NULL,
        namespace TEXT NOT NULL REFERENCES namespaces(id),
        client_id TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN ('helpful','mixed','harmful','unknown')),
        action_changed INTEGER NOT NULL CHECK (action_changed IN (0,1)),
        item_ids TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_context_outcomes_ns ON context_outcomes(namespace, id);
      CREATE INDEX idx_context_outcomes_package ON context_outcomes(package_id);
    `,
    post: (db) => {
      // Classification/validity metadata is domain state, so migration v6
      // gets its own append-only version snapshot rather than silently
      // changing the latest v5 revision in place.
      const now = new Date().toISOString();
      db.prepare('UPDATE context_items SET revision = revision + 1 WHERE 1 = 1').run();
      const rows = db.prepare('SELECT * FROM context_items').all() as Record<string, unknown>[];
      const insertVersion = db.prepare(
        'INSERT INTO item_versions (item_id, revision, snapshot, change_kind, changed_by, changed_at) VALUES (?, ?, ?, ?, ?, ?)',
      );
      for (const row of rows) {
        insertVersion.run(row.id, row.revision, JSON.stringify(row), 'migrate', 'migration-v6', now);
      }
    },
  },
  {
    version: 7,
    name: 'hybrid-retrieval-projection',
    sql: `
      -- Rebuildable local vector projection. It intentionally stores no
      -- namespace/trust/ACL authority: every read joins context_items and
      -- applies the authoritative filters before ranking.
      CREATE TABLE item_embeddings (
        item_id TEXT PRIMARY KEY REFERENCES context_items(id) ON DELETE CASCADE,
        model TEXT NOT NULL,
        dimensions INTEGER NOT NULL CHECK (dimensions > 0),
        content_hash TEXT NOT NULL,
        embedding BLOB NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_item_embeddings_model ON item_embeddings(model, dimensions);
    `,
  },
  {
    version: 8,
    name: 'control-center-web-auth-and-agent-enrollment',
    sql: `
      ALTER TABLE clients ADD COLUMN auth_method TEXT NOT NULL DEFAULT 'legacy_key'
        CHECK (auth_method IN ('legacy_key','enrollment_key','oauth_user','oauth_client_credentials'));

      CREATE TABLE web_principals (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        subject TEXT NOT NULL,
        display_name TEXT NOT NULL,
        profile_pic_url TEXT,
        control_admin INTEGER NOT NULL DEFAULT 0,
        disabled INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_seen_at TEXT,
        UNIQUE(provider, subject)
      );
      CREATE INDEX idx_web_principals_subject ON web_principals(provider, subject);

      CREATE TABLE web_principal_clients (
        principal_id TEXT NOT NULL REFERENCES web_principals(id),
        client_id TEXT NOT NULL REFERENCES clients(id),
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        PRIMARY KEY(principal_id, client_id)
      );

      CREATE TABLE web_sessions (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        principal_id TEXT NOT NULL REFERENCES web_principals(id),
        csrf_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        idle_expires_at TEXT NOT NULL,
        absolute_expires_at TEXT NOT NULL,
        revoked_at TEXT,
        revoked_by TEXT
      );
      CREATE INDEX idx_web_sessions_principal ON web_sessions(principal_id, revoked_at);

      CREATE TABLE agent_enrollments (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL REFERENCES clients(id),
        code_hash TEXT NOT NULL UNIQUE,
        created_by_principal_id TEXT NOT NULL REFERENCES web_principals(id),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed_at TEXT,
        revoked_at TEXT,
        failed_attempts INTEGER NOT NULL DEFAULT 0,
        locked_at TEXT
      );
      CREATE INDEX idx_agent_enrollments_client ON agent_enrollments(client_id, created_at);

      CREATE TABLE client_activity (
        client_id TEXT PRIMARY KEY REFERENCES clients(id),
        last_authenticated_at TEXT,
        last_mcp_initialize_at TEXT,
        last_tool_call_at TEXT,
        last_tool_name TEXT,
        last_auth_error_at TEXT,
        last_auth_error_code TEXT,
        last_policy_denial_at TEXT,
        last_policy_denial_action TEXT,
        updated_at TEXT NOT NULL
      );
    `,
  },
];

export function migrate(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map((r: any) => r.version as number),
  );
  const pending = MIGRATIONS.filter((m) => !applied.has(m.version));
  if (pending.length === 0) return;

  // Pre-migration consistent snapshot (skip fresh/in-memory databases). If
  // the snapshot cannot be written we do NOT migrate — restore is the only
  // rollback path, so it must exist first.
  if (!db.memory && applied.size > 0) {
    const dir = path.join(path.dirname(db.name), 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = pending[pending.length - 1]!.version;
    db.prepare('VACUUM INTO ?').run(path.join(dir, `pre-migration-v${target}-${stamp}.db`));
  }

  const insert = db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)');
  for (const m of pending) {
    db.transaction(() => {
      db.exec(m.sql);
      m.post?.(db);
      insert.run(m.version, m.name, new Date().toISOString());
    })();
  }
}
