use crate::error::{StorageError, StorageResult};
use rusqlite::Connection;

/// Current on-disk schema version. Bump this and add a migration branch when
/// the schema changes. Downgrades are refused so an older binary cannot corrupt
/// a newer ledger.
pub const SCHEMA_VERSION: u32 = 1;

pub const SCHEMA_V1: &str = r#"
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  readable_name TEXT NOT NULL,
  company_id TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS companies (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  legal_name TEXT NOT NULL,
  trade_name TEXT,
  gstin TEXT,
  pan TEXT,
  state TEXT,
  currency TEXT NOT NULL,
  books_begin TEXT NOT NULL,
  fy_start_month INTEGER NOT NULL DEFAULT 4,
  round_to_minor INTEGER NOT NULL DEFAULT 1,
  rounding_mode TEXT NOT NULL DEFAULT 'half-up',
  decimal_places INTEGER NOT NULL DEFAULT 2,
  default_currency TEXT NOT NULL DEFAULT 'INR',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_companies_workspace ON companies(workspace_id);

CREATE TABLE IF NOT EXISTS ledgers (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  tally_parent TEXT NOT NULL,
  nature TEXT NOT NULL,
  opening_balance_minor INTEGER NOT NULL DEFAULT 0,
  is_party INTEGER NOT NULL DEFAULT 0,
  is_bank INTEGER NOT NULL DEFAULT 0,
  is_tax INTEGER NOT NULL DEFAULT 0,
  billwise INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(workspace_id, name)
);
CREATE INDEX IF NOT EXISTS idx_ledgers_workspace ON ledgers(workspace_id);

CREATE TABLE IF NOT EXISTS parties (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  ledger_id TEXT NOT NULL,
  name TEXT NOT NULL,
  gstin TEXT,
  party_type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_parties_workspace ON parties(workspace_id);
CREATE INDEX IF NOT EXISTS idx_parties_ledger ON parties(ledger_id);

CREATE TABLE IF NOT EXISTS numbering_schemes (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  voucher_type TEXT NOT NULL,
  prefix TEXT NOT NULL,
  next_number INTEGER NOT NULL,
  reset_period TEXT NOT NULL,
  width INTEGER NOT NULL DEFAULT 4,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS vouchers (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  voucher_type TEXT NOT NULL,
  number TEXT NOT NULL,
  date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'regular',
  currency TEXT NOT NULL,
  party_ledger_id TEXT,
  invoice_number TEXT,
  narration TEXT,
  round_off_amount_minor INTEGER NOT NULL DEFAULT 0,
  round_off_ledger_id TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  fy_key TEXT NOT NULL,
  content_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(workspace_id, voucher_type, number, fy_key)
);
CREATE INDEX IF NOT EXISTS idx_vouchers_workspace_date ON vouchers(workspace_id, date);
CREATE INDEX IF NOT EXISTS idx_vouchers_workspace_type ON vouchers(workspace_id, voucher_type);

CREATE TABLE IF NOT EXISTS voucher_lines (
  id TEXT PRIMARY KEY,
  voucher_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  line_no INTEGER NOT NULL,
  ledger_id TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  narration TEXT
);
CREATE INDEX IF NOT EXISTS idx_voucher_lines_voucher ON voucher_lines(voucher_id);
CREATE INDEX IF NOT EXISTS idx_voucher_lines_workspace ON voucher_lines(workspace_id);
CREATE INDEX IF NOT EXISTS idx_voucher_lines_ledger ON voucher_lines(ledger_id);

CREATE TABLE IF NOT EXISTS change_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  op TEXT NOT NULL,
  payload TEXT NOT NULL,
  lamport INTEGER NOT NULL,
  device_id TEXT NOT NULL,
  content_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_change_log_entity ON change_log(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_change_log_lamport ON change_log(lamport);

CREATE TABLE IF NOT EXISTS tombstones (
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  lamport INTEGER NOT NULL,
  deleted_at TEXT NOT NULL,
  PRIMARY KEY(entity_type, entity_id)
);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  payload TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_workspace ON audit_events(workspace_id, at);

CREATE TABLE IF NOT EXISTS sync_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
"#;

pub fn configure(conn: &Connection) -> StorageResult<()> {
    conn.execute_batch(
        "PRAGMA journal_mode=WAL;
         PRAGMA foreign_keys=ON;
         PRAGMA synchronous=NORMAL;
         PRAGMA busy_timeout=5000;
         PRAGMA wal_autocheckpoint=1000;",
    )?;
    Ok(())
}

pub fn migrate(conn: &Connection) -> StorageResult<()> {
    let current: u32 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if current > SCHEMA_VERSION {
        return Err(StorageError::SchemaTooNew {
            found: current,
            supported: SCHEMA_VERSION,
        });
    }
    if current < 1 {
        conn.execute_batch(SCHEMA_V1)?;
    }
    // Future migrations: `if current < 2 { ... }`.
    if current < SCHEMA_VERSION {
        conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    }
    Ok(())
}
