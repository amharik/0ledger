use crate::error::{StorageError, StorageResult};
use crate::schema;
use chrono::{SecondsFormat, Utc};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::Path;
use zeroledger_engine::{
    financial_year_key, profit_and_loss, trial_balance, validate_line_balance,
    validate_new_voucher, CompanyProfile, Ledger, LedgerNature, NewVoucher, Party, PartyType,
    ProfitAndLoss, RoundingMode, TallyPrimaryGroup, TrialBalance, Voucher, VoucherLine,
    VoucherSource, VoucherStatus, VoucherType,
};
use zeroledger_sync::{merge_changes, Change, ChangeOp, ChangeSet, SyncKey};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ApplyOutcome {
    Applied,
    Ignored,
    Skipped,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ApplySummary {
    pub applied: u32,
    pub ignored: u32,
    pub skipped: u32,
}

/// A one-shot migration payload used to seed SQLite from the legacy Dexie
/// database. Every entity is upserted idempotently and recorded in the change
/// log so the new store can immediately participate in device-to-device sync.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportBundle {
    #[serde(default)]
    pub workspaces: Vec<zeroledger_engine::Workspace>,
    #[serde(default)]
    pub companies: Vec<CompanyProfile>,
    #[serde(default)]
    pub ledgers: Vec<Ledger>,
    #[serde(default)]
    pub parties: Vec<Party>,
    #[serde(default)]
    pub vouchers: Vec<NewVoucher>,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    pub workspaces: u32,
    pub companies: u32,
    pub ledgers: u32,
    pub parties: u32,
    pub vouchers: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrityIssue {
    pub code: String,
    pub message: String,
    pub entity_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrityReport {
    pub ok: bool,
    pub checked_vouchers: u32,
    pub checked_audit_events: u32,
    pub issues: Vec<IntegrityIssue>,
}

pub fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true)
}

fn random_hex(bytes: usize) -> String {
    let mut buffer = vec![0_u8; bytes];
    if getrandom::getrandom(&mut buffer).is_err() {
        // Extremely unlikely; fall back to a timestamp-derived id rather than panic.
        let stamp = Utc::now().timestamp_nanos_opt().unwrap_or(0);
        return format!("{stamp:x}");
    }
    let mut out = String::with_capacity(bytes * 2);
    for byte in buffer {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

fn hex_digest(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

fn audit_hash(
    prev: &str,
    entity_type: &str,
    entity_id: &str,
    action: &str,
    payload: &str,
    at: &str,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(prev.as_bytes());
    hasher.update(b"|");
    hasher.update(entity_type.as_bytes());
    hasher.update(b"|");
    hasher.update(entity_id.as_bytes());
    hasher.update(b"|");
    hasher.update(action.as_bytes());
    hasher.update(b"|");
    hasher.update(payload.as_bytes());
    hasher.update(b"|");
    hasher.update(at.as_bytes());
    hex_digest(&hasher.finalize())
}

fn corrupt(idx: usize, message: impl Into<String>) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(
        idx,
        rusqlite::types::Type::Text,
        Box::new(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            message.into(),
        )),
    )
}

/// Authoritative local ledger store backed by SQLite (WAL).
///
/// The store owns migrations, double-entry enforcement, an append-only audit
/// hash chain, encrypted-backup-friendly snapshots, and the replication change
/// log consumed by the UI-agnostic sync crate.
pub struct Store {
    conn: Connection,
    device_id: String,
}

impl Store {
    pub fn open(path: impl AsRef<Path>) -> StorageResult<Self> {
        let conn = Connection::open(path)?;
        Self::from_connection(conn, None)
    }

    pub fn open_in_memory() -> StorageResult<Self> {
        let conn = Connection::open_in_memory()?;
        Self::from_connection(conn, None)
    }

    pub fn open_with_device(
        path: impl AsRef<Path>,
        device_id: impl Into<String>,
    ) -> StorageResult<Self> {
        let conn = Connection::open(path)?;
        Self::from_connection(conn, Some(device_id.into()))
    }

    pub fn in_memory_with_device(device_id: impl Into<String>) -> StorageResult<Self> {
        let conn = Connection::open_in_memory()?;
        Self::from_connection(conn, Some(device_id.into()))
    }

    fn from_connection(conn: Connection, device_override: Option<String>) -> StorageResult<Self> {
        schema::configure(&conn)?;
        schema::migrate(&conn)?;
        let device_id = match device_override {
            Some(device) => {
                conn.execute(
                    "INSERT INTO sync_meta(key, value) VALUES('device_id', ?1)
                     ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                    [&device],
                )?;
                device
            }
            None => ensure_device_id(&conn)?,
        };
        Ok(Self { conn, device_id })
    }

    pub fn device_id(&self) -> &str {
        &self.device_id
    }

    pub fn schema_version(&self) -> StorageResult<u32> {
        Ok(self
            .conn
            .pragma_query_value(None, "user_version", |row| row.get(0))?)
    }

    pub fn next_lamport(&self) -> StorageResult<u64> {
        Ok(max_lamport(&self.conn)?.saturating_add(1))
    }

    pub fn get_sync_meta(&self, key: &str) -> StorageResult<Option<String>> {
        Ok(self
            .conn
            .query_row("SELECT value FROM sync_meta WHERE key = ?1", [key], |row| {
                row.get(0)
            })
            .optional()?)
    }

    pub fn set_sync_meta(&self, key: &str, value: &str) -> StorageResult<()> {
        self.conn.execute(
            "INSERT INTO sync_meta(key, value) VALUES(?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    // ---- workspace / company -------------------------------------------------

    pub fn create_workspace(
        &self,
        workspace: &zeroledger_engine::Workspace,
        company: &CompanyProfile,
    ) -> StorageResult<()> {
        let tx = self.conn.unchecked_transaction()?;
        upsert_workspace_row(&tx, workspace)?;
        upsert_company_row(&tx, company)?;
        record_local_change(
            &tx,
            "workspace",
            &workspace.id,
            ChangeOp::Upsert,
            &serde_json::to_string(workspace)?,
            &self.device_id,
        )?;
        record_local_change(
            &tx,
            "company",
            &company.id,
            ChangeOp::Upsert,
            &serde_json::to_string(company)?,
            &self.device_id,
        )?;
        record_audit(
            &tx,
            &workspace.id,
            "workspace",
            &workspace.id,
            "create",
            "{}",
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn get_workspace(
        &self,
        workspace_id: &str,
    ) -> StorageResult<Option<zeroledger_engine::Workspace>> {
        Ok(self
            .conn
            .query_row(
                "SELECT id, slug, name, readable_name, company_id, archived, created_at, updated_at
                 FROM workspaces WHERE id = ?1",
                [workspace_id],
                map_workspace,
            )
            .optional()?)
    }

    pub fn list_workspaces(&self) -> StorageResult<Vec<zeroledger_engine::Workspace>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, slug, name, readable_name, company_id, archived, created_at, updated_at
             FROM workspaces ORDER BY name",
        )?;
        let rows = stmt.query_map([], map_workspace)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn get_company(&self, workspace_id: &str) -> StorageResult<Option<CompanyProfile>> {
        Ok(self
            .conn
            .query_row(
                "SELECT id, workspace_id, legal_name, trade_name, gstin, pan, state, currency,
                        books_begin, fy_start_month, round_to_minor, rounding_mode, decimal_places,
                        default_currency, created_at, updated_at
                 FROM companies WHERE workspace_id = ?1",
                [workspace_id],
                map_company,
            )
            .optional()?)
    }

    // ---- masters -------------------------------------------------------------

    pub fn upsert_ledger(&self, ledger: &Ledger) -> StorageResult<()> {
        let tx = self.conn.unchecked_transaction()?;
        upsert_ledger_row(&tx, ledger)?;
        record_local_change(
            &tx,
            "ledger",
            &ledger.id,
            ChangeOp::Upsert,
            &serde_json::to_string(ledger)?,
            &self.device_id,
        )?;
        record_audit(
            &tx,
            &ledger.workspace_id,
            "ledger",
            &ledger.id,
            "upsert",
            &serde_json::to_string(ledger)?,
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn get_ledger(&self, ledger_id: &str) -> StorageResult<Option<Ledger>> {
        Ok(self
            .conn
            .query_row(
                "SELECT id, workspace_id, name, tally_parent, nature, opening_balance_minor,
                        is_party, is_bank, is_tax, billwise, archived, created_at, updated_at
                 FROM ledgers WHERE id = ?1",
                [ledger_id],
                map_ledger,
            )
            .optional()?)
    }

    pub fn list_ledgers(&self, workspace_id: &str) -> StorageResult<Vec<Ledger>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, workspace_id, name, tally_parent, nature, opening_balance_minor,
                    is_party, is_bank, is_tax, billwise, archived, created_at, updated_at
             FROM ledgers WHERE workspace_id = ?1 ORDER BY name",
        )?;
        let rows = stmt.query_map([workspace_id], map_ledger)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn upsert_party(&self, party: &Party) -> StorageResult<()> {
        let tx = self.conn.unchecked_transaction()?;
        upsert_party_row(&tx, party)?;
        record_local_change(
            &tx,
            "party",
            &party.id,
            ChangeOp::Upsert,
            &serde_json::to_string(party)?,
            &self.device_id,
        )?;
        record_audit(
            &tx,
            &party.workspace_id,
            "party",
            &party.id,
            "upsert",
            &serde_json::to_string(party)?,
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn list_parties(&self, workspace_id: &str) -> StorageResult<Vec<Party>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, workspace_id, ledger_id, name, gstin, party_type, created_at, updated_at
             FROM parties WHERE workspace_id = ?1 ORDER BY name",
        )?;
        let rows = stmt.query_map([workspace_id], map_party)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    // ---- vouchers ------------------------------------------------------------

    pub fn post_voucher(&self, input: &NewVoucher) -> StorageResult<()> {
        let validation = validate_new_voucher(input);
        if !validation.ok {
            let message = validation
                .issues
                .iter()
                .filter(|issue| issue.severity == zeroledger_engine::IssueSeverity::Error)
                .map(|issue| issue.message.clone())
                .collect::<Vec<_>>()
                .join("; ");
            return Err(StorageError::Validation(message));
        }

        let fy_month = self.fy_start_month(&input.voucher.workspace_id)?;
        let fy_key = financial_year_key(&input.voucher.date, fy_month)?;

        let tx = self.conn.unchecked_transaction()?;
        upsert_voucher_rows(&tx, input, &fy_key)?;
        let payload = serde_json::to_string(input)?;
        record_local_change(
            &tx,
            "voucher",
            &input.voucher.id,
            ChangeOp::Upsert,
            &payload,
            &self.device_id,
        )?;
        record_audit(
            &tx,
            &input.voucher.workspace_id,
            "voucher",
            &input.voucher.id,
            "post",
            &payload,
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn get_voucher(
        &self,
        voucher_id: &str,
    ) -> StorageResult<Option<(Voucher, Vec<VoucherLine>)>> {
        let voucher = self
            .conn
            .query_row(
                "SELECT id, workspace_id, voucher_type, number, date, status, currency,
                        party_ledger_id, invoice_number, narration, round_off_amount_minor,
                        round_off_ledger_id, source, created_at, updated_at
                 FROM vouchers WHERE id = ?1",
                [voucher_id],
                map_voucher,
            )
            .optional()?;
        let Some(voucher) = voucher else {
            return Ok(None);
        };
        let lines = self.lines_for_voucher(voucher_id)?;
        Ok(Some((voucher, lines)))
    }

    pub fn list_vouchers(&self, workspace_id: &str) -> StorageResult<Vec<Voucher>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, workspace_id, voucher_type, number, date, status, currency,
                    party_ledger_id, invoice_number, narration, round_off_amount_minor,
                    round_off_ledger_id, source, created_at, updated_at
             FROM vouchers WHERE workspace_id = ?1 ORDER BY date, number",
        )?;
        let rows = stmt.query_map([workspace_id], map_voucher)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn list_voucher_lines(&self, workspace_id: &str) -> StorageResult<Vec<VoucherLine>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, voucher_id, workspace_id, line_no, ledger_id, amount_minor, currency, narration
             FROM voucher_lines WHERE workspace_id = ?1 ORDER BY voucher_id, line_no",
        )?;
        let rows = stmt.query_map([workspace_id], map_line)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    fn lines_for_voucher(&self, voucher_id: &str) -> StorageResult<Vec<VoucherLine>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, voucher_id, workspace_id, line_no, ledger_id, amount_minor, currency, narration
             FROM voucher_lines WHERE voucher_id = ?1 ORDER BY line_no",
        )?;
        let rows = stmt.query_map([voucher_id], map_line)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    fn fy_start_month(&self, workspace_id: &str) -> StorageResult<u32> {
        let value: Option<i64> = self
            .conn
            .query_row(
                "SELECT fy_start_month FROM companies WHERE workspace_id = ?1",
                [workspace_id],
                |row| row.get(0),
            )
            .optional()?;
        Ok(value.unwrap_or(4).clamp(1, 12) as u32)
    }

    // ---- reports -------------------------------------------------------------

    pub fn trial_balance(&self, workspace_id: &str) -> StorageResult<TrialBalance> {
        let ledgers = self.list_ledgers(workspace_id)?;
        let vouchers = self.list_vouchers(workspace_id)?;
        let lines = self.list_voucher_lines(workspace_id)?;
        Ok(trial_balance(&ledgers, &vouchers, &lines))
    }

    pub fn profit_and_loss(&self, workspace_id: &str) -> StorageResult<ProfitAndLoss> {
        let ledgers = self.list_ledgers(workspace_id)?;
        let vouchers = self.list_vouchers(workspace_id)?;
        let lines = self.list_voucher_lines(workspace_id)?;
        Ok(profit_and_loss(&ledgers, &vouchers, &lines))
    }

    // ---- integrity / backup --------------------------------------------------

    pub fn integrity_check(&self, workspace_id: &str) -> StorageResult<IntegrityReport> {
        let vouchers = self.list_vouchers(workspace_id)?;
        let lines = self.list_voucher_lines(workspace_id)?;
        let mut issues = Vec::new();

        let mut lines_by_voucher: BTreeMap<&str, Vec<VoucherLine>> = BTreeMap::new();
        for line in &lines {
            lines_by_voucher
                .entry(line.voucher_id.as_str())
                .or_default()
                .push(line.clone());
        }

        for voucher in &vouchers {
            let voucher_lines = lines_by_voucher
                .get(voucher.id.as_str())
                .cloned()
                .unwrap_or_default();
            let result = validate_line_balance(&voucher_lines);
            if !result.ok {
                for issue in result.issues {
                    if issue.severity == zeroledger_engine::IssueSeverity::Error {
                        issues.push(IntegrityIssue {
                            code: issue.code,
                            message: issue.message,
                            entity_id: Some(voucher.id.clone()),
                        });
                    }
                }
            }
            let round_off = zeroledger_engine::validate_round_off(voucher, &voucher_lines);
            for issue in round_off.issues {
                if issue.severity == zeroledger_engine::IssueSeverity::Error {
                    issues.push(IntegrityIssue {
                        code: issue.code,
                        message: issue.message,
                        entity_id: Some(voucher.id.clone()),
                    });
                }
            }
        }

        let mut stmt = self.conn.prepare(
            "SELECT voucher_type, fy_key, number, COUNT(*)
             FROM vouchers WHERE workspace_id = ?1
             GROUP BY voucher_type, fy_key, number HAVING COUNT(*) > 1",
        )?;
        let duplicates = stmt.query_map([workspace_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?;
        for duplicate in duplicates {
            let (voucher_type, fy_key, number) = duplicate?;
            issues.push(IntegrityIssue {
                code: "voucher.duplicate-number".to_string(),
                message: format!(
                    "Duplicate {voucher_type} number {number} in financial year {fy_key}"
                ),
                entity_id: None,
            });
        }

        let mut checked_audit_events = 0_u32;
        let mut stmt = self.conn.prepare(
            "SELECT entity_type, entity_id, action, payload, prev_hash, hash, at
             FROM audit_events WHERE workspace_id = ?1 ORDER BY rowid",
        )?;
        let mut rows = stmt.query([workspace_id])?;
        let mut previous = String::new();
        while let Some(row) = rows.next()? {
            let entity_type: String = row.get(0)?;
            let entity_id: String = row.get(1)?;
            let action: String = row.get(2)?;
            let payload: String = row.get(3)?;
            let prev_hash: String = row.get(4)?;
            let hash: String = row.get(5)?;
            let at: String = row.get(6)?;
            checked_audit_events += 1;
            if prev_hash != previous {
                issues.push(IntegrityIssue {
                    code: "audit.chain-broken".to_string(),
                    message: format!("Audit chain break at event for {entity_type}:{entity_id}"),
                    entity_id: Some(entity_id.clone()),
                });
            }
            let expected = audit_hash(&prev_hash, &entity_type, &entity_id, &action, &payload, &at);
            if expected != hash {
                issues.push(IntegrityIssue {
                    code: "audit.hash-mismatch".to_string(),
                    message: format!("Audit hash mismatch for {entity_type}:{entity_id}"),
                    entity_id: Some(entity_id.clone()),
                });
            }
            previous = hash;
        }

        Ok(IntegrityReport {
            ok: issues.is_empty(),
            checked_vouchers: vouchers.len() as u32,
            checked_audit_events,
            issues,
        })
    }

    /// Delete a mirrored entity and record a tombstone change for sync.
    ///
    /// Ledgers that are still referenced by voucher lines are refused so the
    /// authoritative store cannot be left in a dangling state.
    pub fn delete_entity(&self, entity_type: &str, entity_id: &str) -> StorageResult<()> {
        let tx = self.conn.unchecked_transaction()?;
        match entity_type {
            "voucher" => {
                tx.execute(
                    "DELETE FROM voucher_lines WHERE voucher_id = ?1",
                    [entity_id],
                )?;
                tx.execute("DELETE FROM vouchers WHERE id = ?1", [entity_id])?;
            }
            "ledger" => {
                let used: i64 = tx.query_row(
                    "SELECT COUNT(*) FROM voucher_lines WHERE ledger_id = ?1",
                    [entity_id],
                    |row| row.get(0),
                )?;
                if used > 0 {
                    return Err(StorageError::Validation(format!(
                        "ledger {entity_id} is still referenced by vouchers"
                    )));
                }
                tx.execute("DELETE FROM ledgers WHERE id = ?1", [entity_id])?;
            }
            "party" => {
                tx.execute("DELETE FROM parties WHERE id = ?1", [entity_id])?;
            }
            other => {
                return Err(StorageError::Validation(format!(
                    "cannot delete entity type {other}"
                )))
            }
        }
        record_local_change(
            &tx,
            entity_type,
            entity_id,
            ChangeOp::Delete,
            "",
            &self.device_id,
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Create a consistent, standalone SQLite snapshot at `path`.
    pub fn backup_to(&self, path: impl AsRef<Path>) -> StorageResult<()> {
        let path = path.as_ref();
        if path.exists() {
            return Err(StorageError::BackupExists(path.display().to_string()));
        }
        self.conn
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")?;
        self.conn
            .execute("VACUUM INTO ?1", [path.to_string_lossy().as_ref()])?;

        let check = Connection::open(path)?;
        let result: String = check.query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
        if result != "ok" {
            return Err(StorageError::Corrupt(format!(
                "backup integrity_check returned: {result}"
            )));
        }
        Ok(())
    }

    /// Import a legacy snapshot into the authoritative store.
    pub fn import_bundle(&self, bundle: &ImportBundle) -> StorageResult<ImportSummary> {
        let tx = self.conn.unchecked_transaction()?;
        let mut summary = ImportSummary::default();

        for workspace in &bundle.workspaces {
            upsert_workspace_row(&tx, workspace)?;
            record_local_change(
                &tx,
                "workspace",
                &workspace.id,
                ChangeOp::Upsert,
                &serde_json::to_string(workspace)?,
                &self.device_id,
            )?;
            summary.workspaces += 1;
        }
        for company in &bundle.companies {
            upsert_company_row(&tx, company)?;
            record_local_change(
                &tx,
                "company",
                &company.id,
                ChangeOp::Upsert,
                &serde_json::to_string(company)?,
                &self.device_id,
            )?;
            summary.companies += 1;
        }
        for ledger in &bundle.ledgers {
            upsert_ledger_row(&tx, ledger)?;
            record_local_change(
                &tx,
                "ledger",
                &ledger.id,
                ChangeOp::Upsert,
                &serde_json::to_string(ledger)?,
                &self.device_id,
            )?;
            summary.ledgers += 1;
        }
        for party in &bundle.parties {
            upsert_party_row(&tx, party)?;
            record_local_change(
                &tx,
                "party",
                &party.id,
                ChangeOp::Upsert,
                &serde_json::to_string(party)?,
                &self.device_id,
            )?;
            summary.parties += 1;
        }
        for input in &bundle.vouchers {
            let fy_month = tx
                .query_row(
                    "SELECT fy_start_month FROM companies WHERE workspace_id = ?1",
                    [&input.voucher.workspace_id],
                    |row| row.get::<_, i64>(0),
                )
                .optional()?
                .unwrap_or(4)
                .clamp(1, 12) as u32;
            let fy_key = financial_year_key(&input.voucher.date, fy_month)?;
            upsert_voucher_rows(&tx, input, &fy_key)?;
            record_local_change(
                &tx,
                "voucher",
                &input.voucher.id,
                ChangeOp::Upsert,
                &serde_json::to_string(input)?,
                &self.device_id,
            )?;
            summary.vouchers += 1;
        }

        if let Some(workspace) = bundle.workspaces.first() {
            record_audit(
                &tx,
                &workspace.id,
                "workspace",
                &workspace.id,
                "import-snapshot",
                "{}",
            )?;
        }
        tx.commit()?;
        Ok(summary)
    }

    // ---- replication ---------------------------------------------------------

    pub fn changes_since(&self, since_lamport: u64) -> StorageResult<Vec<Change>> {
        let mut stmt = self.conn.prepare(
            "SELECT entity_type, entity_id, op, payload, lamport, device_id, content_hash, created_at
             FROM change_log WHERE lamport > ?1 ORDER BY lamport, device_id",
        )?;
        let rows = stmt.query_map([since_lamport as i64], map_change)?;
        let changes: Vec<Change> = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(merge_changes(&[], &changes))
    }

    pub fn change_set_since(&self, since_lamport: u64) -> StorageResult<ChangeSet> {
        let changes = self.changes_since(since_lamport)?;
        Ok(ChangeSet::new(
            &self.device_id,
            max_lamport(&self.conn)?,
            changes,
        ))
    }

    pub fn apply_change(&self, change: &Change) -> StorageResult<ApplyOutcome> {
        let tx = self.conn.unchecked_transaction()?;
        let outcome = apply_change_in(&tx, change)?;
        tx.commit()?;
        Ok(outcome)
    }

    pub fn apply_change_set(&self, change_set: &ChangeSet) -> StorageResult<ApplySummary> {
        let mut ordered = change_set.changes.clone();
        ordered.sort_by(|a, b| a.version().cmp(&b.version()));

        let tx = self.conn.unchecked_transaction()?;
        let mut summary = ApplySummary::default();
        for change in &ordered {
            match apply_change_in(&tx, change)? {
                ApplyOutcome::Applied => summary.applied += 1,
                ApplyOutcome::Ignored => summary.ignored += 1,
                ApplyOutcome::Skipped => summary.skipped += 1,
            }
        }
        tx.commit()?;
        Ok(summary)
    }

    /// Build and seal a sync envelope for another device.
    pub fn export_sync_envelope(&self, key: &SyncKey, since_lamport: u64) -> StorageResult<String> {
        let change_set = self.change_set_since(since_lamport)?;
        let envelope = zeroledger_sync::seal(key, &self.device_id, now_iso(), &change_set)?;
        Ok(envelope.to_json()?)
    }

    /// Open and apply a sync envelope received from another device.
    pub fn import_sync_envelope(
        &self,
        key: &SyncKey,
        envelope_json: &str,
    ) -> StorageResult<ApplySummary> {
        let envelope = zeroledger_sync::SealedEnvelope::from_json(envelope_json)?;
        let change_set = zeroledger_sync::open(key, &envelope)?;
        self.apply_change_set(&change_set)
    }
}

fn ensure_device_id(conn: &Connection) -> StorageResult<String> {
    if let Some(existing) = conn
        .query_row(
            "SELECT value FROM sync_meta WHERE key = 'device_id'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()?
    {
        return Ok(existing);
    }
    let device_id = format!("dev_{}", random_hex(16));
    conn.execute(
        "INSERT INTO sync_meta(key, value) VALUES('device_id', ?1)",
        [&device_id],
    )?;
    Ok(device_id)
}

fn max_lamport(conn: &Connection) -> StorageResult<u64> {
    let a: i64 = conn.query_row(
        "SELECT COALESCE(MAX(lamport), 0) FROM change_log",
        [],
        |row| row.get(0),
    )?;
    let b: i64 = conn.query_row(
        "SELECT COALESCE(MAX(lamport), 0) FROM tombstones",
        [],
        |row| row.get(0),
    )?;
    Ok(a.max(b) as u64)
}

fn insert_change(conn: &Connection, change: &Change) -> StorageResult<()> {
    conn.execute(
        "INSERT OR IGNORE INTO change_log
           (entity_type, entity_id, op, payload, lamport, device_id, content_hash, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            change.entity_type,
            change.entity_id,
            change.op.as_str(),
            change.payload,
            change.lamport as i64,
            change.device_id,
            change.content_hash,
            change.created_at,
        ],
    )?;
    Ok(())
}

fn record_local_change(
    conn: &Connection,
    entity_type: &str,
    entity_id: &str,
    op: ChangeOp,
    payload: &str,
    device_id: &str,
) -> StorageResult<()> {
    // Mirroring a whole workspace is idempotent. Skip the change-log entry
    // when the latest change for this entity already has the same operation
    // and payload, so repeated imports do not create sync churn.
    let previous: Option<(String, String)> = conn
        .query_row(
            "SELECT op, payload FROM change_log
             WHERE entity_type = ?1 AND entity_id = ?2
             ORDER BY lamport DESC, rowid DESC LIMIT 1",
            params![entity_type, entity_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    if let Some((previous_op, previous_payload)) = previous {
        if previous_op == op.as_str() && previous_payload == payload {
            return Ok(());
        }
    }

    let lamport = max_lamport(conn)?.saturating_add(1);
    let change = Change::new(
        entity_type,
        entity_id,
        op,
        payload,
        lamport,
        device_id,
        now_iso(),
    );
    insert_change(conn, &change)
}

fn record_audit(
    conn: &Connection,
    workspace_id: &str,
    entity_type: &str,
    entity_id: &str,
    action: &str,
    payload: &str,
) -> StorageResult<()> {
    let prev_hash: String = conn
        .query_row(
            "SELECT hash FROM audit_events WHERE workspace_id = ?1 ORDER BY rowid DESC LIMIT 1",
            [workspace_id],
            |row| row.get(0),
        )
        .optional()?
        .unwrap_or_default();
    let at = now_iso();
    let hash = audit_hash(&prev_hash, entity_type, entity_id, action, payload, &at);
    let id = format!("aud_{}", random_hex(16));
    conn.execute(
        "INSERT INTO audit_events
           (id, workspace_id, entity_type, entity_id, action, payload, prev_hash, hash, at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            id,
            workspace_id,
            entity_type,
            entity_id,
            action,
            payload,
            prev_hash,
            hash,
            at
        ],
    )?;
    Ok(())
}

fn apply_change_in(conn: &Connection, change: &Change) -> StorageResult<ApplyOutcome> {
    let winner: Option<(i64, String)> = conn
        .query_row(
            "SELECT lamport, device_id FROM change_log
             WHERE entity_type = ?1 AND entity_id = ?2
             ORDER BY lamport DESC, device_id DESC LIMIT 1",
            params![change.entity_type, change.entity_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    if let Some((winner_lamport, winner_device)) = winner {
        if (change.lamport, change.device_id.as_str())
            <= (winner_lamport as u64, winner_device.as_str())
        {
            return Ok(ApplyOutcome::Ignored);
        }
    }

    let applied = match change.entity_type.as_str() {
        "workspace" => {
            if change.op == ChangeOp::Upsert {
                let workspace: zeroledger_engine::Workspace =
                    serde_json::from_str(&change.payload)?;
                upsert_workspace_row(conn, &workspace)?;
            } else {
                conn.execute("DELETE FROM workspaces WHERE id = ?1", [&change.entity_id])?;
            }
            true
        }
        "company" => {
            if change.op == ChangeOp::Upsert {
                let company: CompanyProfile = serde_json::from_str(&change.payload)?;
                upsert_company_row(conn, &company)?;
            } else {
                conn.execute("DELETE FROM companies WHERE id = ?1", [&change.entity_id])?;
            }
            true
        }
        "ledger" => {
            if change.op == ChangeOp::Upsert {
                let ledger: Ledger = serde_json::from_str(&change.payload)?;
                upsert_ledger_row(conn, &ledger)?;
            } else {
                conn.execute("DELETE FROM ledgers WHERE id = ?1", [&change.entity_id])?;
            }
            true
        }
        "party" => {
            if change.op == ChangeOp::Upsert {
                let party: Party = serde_json::from_str(&change.payload)?;
                upsert_party_row(conn, &party)?;
            } else {
                conn.execute("DELETE FROM parties WHERE id = ?1", [&change.entity_id])?;
            }
            true
        }
        "voucher" => {
            if change.op == ChangeOp::Upsert {
                let input: NewVoucher = serde_json::from_str(&change.payload)?;
                let fy_month = conn
                    .query_row(
                        "SELECT fy_start_month FROM companies WHERE workspace_id = ?1",
                        [&input.voucher.workspace_id],
                        |row| row.get::<_, i64>(0),
                    )
                    .optional()?
                    .unwrap_or(4)
                    .clamp(1, 12) as u32;
                let fy_key = financial_year_key(&input.voucher.date, fy_month)?;
                upsert_voucher_rows(conn, &input, &fy_key)?;
            } else {
                conn.execute(
                    "DELETE FROM voucher_lines WHERE voucher_id = ?1",
                    [&change.entity_id],
                )?;
                conn.execute("DELETE FROM vouchers WHERE id = ?1", [&change.entity_id])?;
            }
            true
        }
        _ => false,
    };

    if !applied {
        return Ok(ApplyOutcome::Skipped);
    }

    insert_change(conn, change)?;
    if change.op == ChangeOp::Delete {
        conn.execute(
            "INSERT INTO tombstones(entity_type, entity_id, device_id, lamport, deleted_at)
             VALUES(?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(entity_type, entity_id) DO UPDATE SET
               device_id=excluded.device_id, lamport=excluded.lamport, deleted_at=excluded.deleted_at",
            params![
                change.entity_type,
                change.entity_id,
                change.device_id,
                change.lamport as i64,
                change.created_at
            ],
        )?;
    }
    Ok(ApplyOutcome::Applied)
}

// ---- row writers ------------------------------------------------------------

fn upsert_workspace_row(
    conn: &Connection,
    workspace: &zeroledger_engine::Workspace,
) -> StorageResult<()> {
    conn.execute(
        "INSERT INTO workspaces(id, slug, name, readable_name, company_id, archived, created_at, updated_at)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(id) DO UPDATE SET
           slug=excluded.slug, name=excluded.name, readable_name=excluded.readable_name,
           company_id=excluded.company_id, archived=excluded.archived, updated_at=excluded.updated_at",
        params![
            workspace.id,
            workspace.slug,
            workspace.name,
            workspace.readable_name,
            workspace.company_id,
            workspace.archived,
            workspace.created_at,
            workspace.updated_at
        ],
    )?;
    Ok(())
}

fn upsert_company_row(conn: &Connection, company: &CompanyProfile) -> StorageResult<()> {
    conn.execute(
        "INSERT INTO companies(
           id, workspace_id, legal_name, trade_name, gstin, pan, state, currency, books_begin,
           fy_start_month, round_to_minor, rounding_mode, decimal_places, default_currency,
           created_at, updated_at)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
         ON CONFLICT(id) DO UPDATE SET
           workspace_id=excluded.workspace_id, legal_name=excluded.legal_name,
           trade_name=excluded.trade_name, gstin=excluded.gstin, pan=excluded.pan,
           state=excluded.state, currency=excluded.currency, books_begin=excluded.books_begin,
           fy_start_month=excluded.fy_start_month, round_to_minor=excluded.round_to_minor,
           rounding_mode=excluded.rounding_mode, decimal_places=excluded.decimal_places,
           default_currency=excluded.default_currency, updated_at=excluded.updated_at",
        params![
            company.id,
            company.workspace_id,
            company.legal_name,
            company.trade_name,
            company.gstin,
            company.pan,
            company.state,
            company.currency,
            company.books_begin,
            company.settings.fy_start_month as i64,
            company.settings.round_to_minor,
            company.settings.rounding_mode.as_str(),
            company.settings.decimal_places as i64,
            company.settings.default_currency,
            company.created_at,
            company.updated_at
        ],
    )?;
    Ok(())
}

fn upsert_ledger_row(conn: &Connection, ledger: &Ledger) -> StorageResult<()> {
    conn.execute(
        "INSERT INTO ledgers(
           id, workspace_id, name, tally_parent, nature, opening_balance_minor, is_party,
           is_bank, is_tax, billwise, archived, created_at, updated_at)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
         ON CONFLICT(id) DO UPDATE SET
           workspace_id=excluded.workspace_id, name=excluded.name,
           tally_parent=excluded.tally_parent, nature=excluded.nature,
           opening_balance_minor=excluded.opening_balance_minor, is_party=excluded.is_party,
           is_bank=excluded.is_bank, is_tax=excluded.is_tax, billwise=excluded.billwise,
           archived=excluded.archived, updated_at=excluded.updated_at",
        params![
            ledger.id,
            ledger.workspace_id,
            ledger.name,
            ledger.tally_parent.as_str(),
            ledger.nature.as_str(),
            ledger.opening_balance_minor,
            ledger.is_party,
            ledger.is_bank,
            ledger.is_tax,
            ledger.billwise,
            ledger.archived,
            ledger.created_at,
            ledger.updated_at
        ],
    )?;
    Ok(())
}

fn upsert_party_row(conn: &Connection, party: &Party) -> StorageResult<()> {
    conn.execute(
        "INSERT INTO parties(id, workspace_id, ledger_id, name, gstin, party_type, created_at, updated_at)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(id) DO UPDATE SET
           workspace_id=excluded.workspace_id, ledger_id=excluded.ledger_id, name=excluded.name,
           gstin=excluded.gstin, party_type=excluded.party_type, updated_at=excluded.updated_at",
        params![
            party.id,
            party.workspace_id,
            party.ledger_id,
            party.name,
            party.gstin,
            party.party_type.as_str(),
            party.created_at,
            party.updated_at
        ],
    )?;
    Ok(())
}

fn upsert_voucher_rows(conn: &Connection, input: &NewVoucher, fy_key: &str) -> StorageResult<()> {
    let voucher = &input.voucher;
    let content_hash = {
        let mut hasher = Sha256::new();
        hasher.update(serde_json::to_vec(input)?);
        hex_digest(&hasher.finalize())
    };
    conn.execute(
        "INSERT INTO vouchers(
           id, workspace_id, voucher_type, number, date, status, currency, party_ledger_id,
           invoice_number, narration, round_off_amount_minor, round_off_ledger_id, source,
           fy_key, content_hash, created_at, updated_at)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
         ON CONFLICT(id) DO UPDATE SET
           workspace_id=excluded.workspace_id, voucher_type=excluded.voucher_type,
           number=excluded.number, date=excluded.date, status=excluded.status,
           currency=excluded.currency, party_ledger_id=excluded.party_ledger_id,
           invoice_number=excluded.invoice_number, narration=excluded.narration,
           round_off_amount_minor=excluded.round_off_amount_minor,
           round_off_ledger_id=excluded.round_off_ledger_id, source=excluded.source,
           fy_key=excluded.fy_key, content_hash=excluded.content_hash,
           updated_at=excluded.updated_at",
        params![
            voucher.id,
            voucher.workspace_id,
            voucher.voucher_type.as_str(),
            voucher.number,
            voucher.date,
            voucher.status.as_str(),
            voucher.currency,
            voucher.party_ledger_id,
            voucher.invoice_number,
            voucher.narration,
            voucher.round_off_amount_minor,
            voucher.round_off_ledger_id,
            voucher.source.as_str(),
            fy_key,
            content_hash,
            voucher.created_at,
            voucher.updated_at
        ],
    )?;

    conn.execute(
        "DELETE FROM voucher_lines WHERE voucher_id = ?1",
        [&voucher.id],
    )?;
    for line in &input.lines {
        conn.execute(
            "INSERT INTO voucher_lines(
               id, voucher_id, workspace_id, line_no, ledger_id, amount_minor, currency, narration)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                line.id,
                line.voucher_id,
                line.workspace_id,
                line.line_no as i64,
                line.ledger_id,
                line.amount_minor,
                line.currency,
                line.narration
            ],
        )?;
    }
    Ok(())
}

// ---- row mappers ------------------------------------------------------------

fn map_workspace(row: &Row<'_>) -> rusqlite::Result<zeroledger_engine::Workspace> {
    Ok(zeroledger_engine::Workspace {
        id: row.get(0)?,
        slug: row.get(1)?,
        name: row.get(2)?,
        readable_name: row.get(3)?,
        company_id: row.get(4)?,
        archived: row.get(5)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

fn map_company(row: &Row<'_>) -> rusqlite::Result<CompanyProfile> {
    let rounding_mode: String = row.get(11)?;
    Ok(CompanyProfile {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        legal_name: row.get(2)?,
        trade_name: row.get(3)?,
        gstin: row.get(4)?,
        pan: row.get(5)?,
        state: row.get(6)?,
        currency: row.get(7)?,
        books_begin: row.get(8)?,
        settings: zeroledger_engine::CompanySettings {
            fy_start_month: row.get::<_, i64>(9)? as u32,
            round_to_minor: row.get(10)?,
            rounding_mode: RoundingMode::parse(&rounding_mode),
            decimal_places: row.get::<_, i64>(12)? as u32,
            default_currency: row.get(13)?,
        },
        created_at: row.get(14)?,
        updated_at: row.get(15)?,
    })
}

fn map_ledger(row: &Row<'_>) -> rusqlite::Result<Ledger> {
    let parent: String = row.get(3)?;
    let tally_parent = TallyPrimaryGroup::parse(&parent)
        .ok_or_else(|| corrupt(3, format!("unknown tally parent: {parent}")))?;
    let nature: String = row.get(4)?;
    let nature = LedgerNature::parse(&nature)
        .ok_or_else(|| corrupt(4, format!("unknown ledger nature: {nature}")))?;
    Ok(Ledger {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        name: row.get(2)?,
        tally_parent,
        nature,
        opening_balance_minor: row.get(5)?,
        is_party: row.get(6)?,
        is_bank: row.get(7)?,
        is_tax: row.get(8)?,
        billwise: row.get(9)?,
        archived: row.get(10)?,
        created_at: row.get(11)?,
        updated_at: row.get(12)?,
    })
}

fn map_party(row: &Row<'_>) -> rusqlite::Result<Party> {
    let party_type: String = row.get(5)?;
    let party_type = PartyType::parse(&party_type)
        .ok_or_else(|| corrupt(5, format!("unknown party type: {party_type}")))?;
    Ok(Party {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        ledger_id: row.get(2)?,
        name: row.get(3)?,
        gstin: row.get(4)?,
        party_type,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

fn map_voucher(row: &Row<'_>) -> rusqlite::Result<Voucher> {
    let voucher_type: String = row.get(2)?;
    let voucher_type = VoucherType::parse(&voucher_type)
        .ok_or_else(|| corrupt(2, format!("unknown voucher type: {voucher_type}")))?;
    let status: String = row.get(5)?;
    let status = VoucherStatus::parse(&status)
        .ok_or_else(|| corrupt(5, format!("unknown voucher status: {status}")))?;
    let source: String = row.get(12)?;
    let source = VoucherSource::parse(&source)
        .ok_or_else(|| corrupt(12, format!("unknown voucher source: {source}")))?;
    Ok(Voucher {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        voucher_type,
        number: row.get(3)?,
        date: row.get(4)?,
        status,
        currency: row.get(6)?,
        party_ledger_id: row.get(7)?,
        invoice_number: row.get(8)?,
        narration: row.get(9)?,
        round_off_amount_minor: row.get(10)?,
        round_off_ledger_id: row.get(11)?,
        source,
        created_at: row.get(13)?,
        updated_at: row.get(14)?,
    })
}

fn map_line(row: &Row<'_>) -> rusqlite::Result<VoucherLine> {
    Ok(VoucherLine {
        id: row.get(0)?,
        voucher_id: row.get(1)?,
        workspace_id: row.get(2)?,
        line_no: row.get::<_, i64>(3)? as u32,
        ledger_id: row.get(4)?,
        amount_minor: row.get(5)?,
        currency: row.get(6)?,
        narration: row.get(7)?,
    })
}

fn map_change(row: &Row<'_>) -> rusqlite::Result<Change> {
    let op: String = row.get(2)?;
    let op = ChangeOp::parse(&op).ok_or_else(|| corrupt(2, format!("unknown change op: {op}")))?;
    Ok(Change {
        entity_type: row.get(0)?,
        entity_id: row.get(1)?,
        op,
        payload: row.get(3)?,
        lamport: row.get::<_, i64>(4)? as u64,
        device_id: row.get(5)?,
        content_hash: row.get(6)?,
        created_at: row.get(7)?,
    })
}
