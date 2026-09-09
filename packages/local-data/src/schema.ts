import type { DatabaseSync } from 'node:sqlite'
import { LOCAL_DATA_SCHEMA_VERSION } from './types.js'

const migrationV1 = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS local_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS scope_revisions (
  workspace_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, card_id, session_id)
);
CREATE TABLE IF NOT EXISTS cards (
  workspace_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  title TEXT NOT NULL,
  data_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, card_id)
);
CREATE TABLE IF NOT EXISTS assets (
  workspace_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  id TEXT NOT NULL,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  category TEXT NOT NULL,
  label TEXT,
  byte_length INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, card_id, session_id, id)
);
CREATE INDEX IF NOT EXISTS assets_scope_created ON assets(workspace_id, card_id, session_id, created_at DESC, id DESC);
CREATE TABLE IF NOT EXISTS ledger_entries (
  workspace_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  description TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  reverses_entry_id TEXT,
  PRIMARY KEY (workspace_id, card_id, session_id, id),
  UNIQUE (workspace_id, card_id, session_id, command_id)
);
CREATE INDEX IF NOT EXISTS ledger_scope_created ON ledger_entries(workspace_id, card_id, session_id, created_at DESC, id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS ledger_one_reversal ON ledger_entries(workspace_id, card_id, session_id, reverses_entry_id) WHERE reverses_entry_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS knowledge_items (
  workspace_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  id TEXT NOT NULL,
  text TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('user', 'rp-projection')),
  branch_id TEXT,
  source_seq INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, card_id, session_id, id)
);
CREATE INDEX IF NOT EXISTS knowledge_scope_created ON knowledge_items(workspace_id, card_id, session_id, created_at DESC, id DESC);
CREATE TABLE IF NOT EXISTS memory_index (
  workspace_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  source_seq INTEGER NOT NULL,
  id TEXT NOT NULL,
  text TEXT NOT NULL,
  emotion TEXT,
  PRIMARY KEY (workspace_id, card_id, session_id, branch_id, id)
);
CREATE INDEX IF NOT EXISTS memory_scope_seq ON memory_index(workspace_id, card_id, session_id, branch_id, source_seq, id);
CREATE TABLE IF NOT EXISTS relationship_edges (
  workspace_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  source_seq INTEGER NOT NULL,
  id TEXT NOT NULL,
  subject TEXT NOT NULL,
  object TEXT NOT NULL,
  relation TEXT NOT NULL,
  status TEXT,
  PRIMARY KEY (workspace_id, card_id, session_id, branch_id, id)
);
CREATE INDEX IF NOT EXISTS relationship_scope_seq ON relationship_edges(workspace_id, card_id, session_id, branch_id, source_seq, id);
CREATE TABLE IF NOT EXISTS location_snapshots (
  workspace_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  source_seq INTEGER NOT NULL,
  id TEXT NOT NULL,
  world TEXT NOT NULL,
  region TEXT,
  scene TEXT,
  landmark TEXT,
  PRIMARY KEY (workspace_id, card_id, session_id, branch_id, id)
);
CREATE INDEX IF NOT EXISTS location_scope_seq ON location_snapshots(workspace_id, card_id, session_id, branch_id, source_seq, id);
CREATE TABLE IF NOT EXISTS backups (
  workspace_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('staging', 'ready', 'failed')),
  manifest_hash TEXT NOT NULL,
  file_name TEXT NOT NULL,
  PRIMARY KEY (workspace_id, card_id, session_id, id),
  UNIQUE (workspace_id, card_id, session_id, command_id)
);
CREATE INDEX IF NOT EXISTS backups_scope_created ON backups(workspace_id, card_id, session_id, created_at DESC, id DESC);
CREATE TABLE IF NOT EXISTS notifications (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  id TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  acknowledged INTEGER NOT NULL DEFAULT 0,
  UNIQUE (workspace_id, card_id, session_id, branch_id, id)
);
CREATE INDEX IF NOT EXISTS notifications_scope_seq ON notifications(workspace_id, card_id, session_id, seq);
CREATE TABLE IF NOT EXISTS notification_cursors (
  workspace_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  pruned_through INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, card_id, session_id, branch_id)
);
CREATE TABLE IF NOT EXISTS pairing_tokens (
  token_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  client_name TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  session_ids_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS pairing_client ON pairing_tokens(client_id, created_at DESC);
CREATE TABLE IF NOT EXISTS command_journal (
  workspace_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  domain TEXT NOT NULL,
  command_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, card_id, session_id, domain, command_id)
);
CREATE TABLE IF NOT EXISTS restore_stages (
  workspace_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  backup_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  base_revision INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, card_id, session_id, backup_id)
);
CREATE TABLE IF NOT EXISTS restore_audit (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  source_backup_id TEXT NOT NULL,
  rollback_backup_id TEXT NOT NULL,
  source_manifest_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS restore_audit_scope_created ON restore_audit(workspace_id, card_id, session_id, created_at DESC);
`

export function migrate(database: DatabaseSync, now: string): void {
  database.exec('BEGIN IMMEDIATE')
  try {
    const userVersion = Number(database.prepare('PRAGMA user_version').get()?.user_version ?? 0)
    const hasMigrations = database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'schema_migrations'").get()
    const storedVersion = hasMigrations ? Number(database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()?.version ?? 0) : 0
    if (userVersion > LOCAL_DATA_SCHEMA_VERSION || storedVersion > LOCAL_DATA_SCHEMA_VERSION) throw new Error('Unsupported local-data schema version')
    // Preserve pre-release v1 notifications without guessing their missing branch ownership.
    const columns = database.prepare('PRAGMA table_info(notifications)').all()
    if (columns.length > 0 && !columns.some(column => column.name === 'branch_id')) {
      database.exec('ALTER TABLE notifications RENAME TO notifications_unscoped_v1')
      database.exec('DROP INDEX IF EXISTS notifications_scope_seq')
    }
    database.exec(migrationV1)
    database.prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(LOCAL_DATA_SCHEMA_VERSION, now)
    const row = database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()
    const version = Number(row?.version ?? 0)
    if (version !== LOCAL_DATA_SCHEMA_VERSION) throw new Error(`Unsupported local-data schema version: ${version}`)
    database.exec('PRAGMA user_version = 1')
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}
