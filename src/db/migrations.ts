import type Database from 'better-sqlite3';

// Migrations are embedded as strings so the compiled dist/ needs no extra
// asset copying and the Docker image stays a plain `tsc` output.
const MIGRATIONS: { version: number; name: string; sql: string }[] = [
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
      -- kept in sync by items-repo on every write.
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
      -- Provenance & lifecycle (see DESIGN.md §4): who asserted the item,
      -- whether it is still in force, and a stable link to the source app's
      -- own object so state-like items are UPDATED instead of duplicated.
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

      -- Server-side read ceiling per client: a tool argument alone must never
      -- unlock private items.
      ALTER TABLE clients ADD COLUMN max_sensitivity TEXT NOT NULL DEFAULT 'normal'
        CHECK (max_sensitivity IN ('normal','private'));
    `,
  },
  {
    version: 3,
    name: 'insight-review-evidence-acl',
    sql: `
      -- Review state for insights: authority records who asserted it,
      -- acceptance records whether a reviewer confirmed it. Reviewing never
      -- changes authority.
      ALTER TABLE context_items ADD COLUMN acceptance TEXT
        CHECK (acceptance IN ('proposed','accepted','rejected'));
      ALTER TABLE context_items ADD COLUMN reviewed_by TEXT;
      ALTER TABLE context_items ADD COLUMN reviewed_at TEXT;
      ALTER TABLE context_items ADD COLUMN review_note TEXT;
      CREATE INDEX idx_items_acceptance ON context_items(acceptance)
        WHERE acceptance IS NOT NULL;

      -- Evidence lineage for insights (referential integrity + reverse lookup).
      -- MVP forbids insight-as-evidence, so this graph is one level deep.
      CREATE TABLE insight_evidence (
        insight_id TEXT NOT NULL REFERENCES context_items(id),
        evidence_id TEXT NOT NULL REFERENCES context_items(id),
        PRIMARY KEY (insight_id, evidence_id)
      );
      CREATE INDEX idx_evidence_reverse ON insight_evidence(evidence_id);

      -- Source whitelist per client: NULL = all sources, JSON [] = none.
      ALTER TABLE clients ADD COLUMN read_sources TEXT;

      -- Backfill strictly: earlier versions accepted client-supplied
      -- authority, so no pre-existing insight can be trusted as reviewed.
      UPDATE context_items SET acceptance = 'proposed' WHERE type = 'insight';
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
  const insert = db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)');
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      insert.run(m.version, m.name, new Date().toISOString());
    })();
  }
}
