use crate::error::{StorageError, StorageResult};
use crate::schema;
use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use surrealdb::engine::any::Any;
use surrealdb::Surreal;
use zeroledger_engine::{
    financial_year_key, profit_and_loss, resolve_counterparty_hint, trial_balance,
    validate_line_balance, validate_new_voucher, ColumnRole, CompanyProfile, CompanySettings,
    ExtractedTableData, IngestBatchState, Ledger, LedgerNature, NewVoucher, ParsedIngestRow,
    Party, PartyType, ProfitAndLoss, RoundingMode, StatementKind, TallyPrimaryGroup, TrialBalance,
    Voucher, VoucherLine, VoucherSource, VoucherStatus, VoucherType, Workspace,
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

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportBundle {
    #[serde(default)]
    pub workspaces: Vec<Workspace>,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IngestBatchDto {
    #[serde(alias = "id_key")]
    pub id_key: String,
    #[serde(alias = "workspace_id")]
    pub workspace_id: String,
    #[serde(alias = "bank_account_id")]
    pub bank_account_id: Option<String>,
    #[serde(alias = "source_type")]
    pub source_type: String,
    #[serde(alias = "source_reference")]
    pub source_reference: Option<String>,
    #[serde(alias = "content_sha256")]
    pub content_sha256: String,
    #[serde(alias = "sender_address")]
    pub sender_address: Option<String>,
    pub state: String,
    #[serde(alias = "statement_kind")]
    pub statement_kind: String,
    #[serde(alias = "institution_slug")]
    pub institution_slug: Option<String>,
    #[serde(alias = "account_tail")]
    pub account_tail: Option<String>,
    #[serde(alias = "total_rows")]
    pub total_rows: i64,
    #[serde(alias = "reconciled_rows")]
    pub reconciled_rows: i64,
    #[serde(alias = "skipped_duplicate_count")]
    pub skipped_duplicate_count: i64,
    #[serde(alias = "error_message")]
    pub error_message: Option<String>,
    #[serde(alias = "created_at")]
    pub created_at: String,
    #[serde(alias = "updated_at")]
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatementTemplateDto {
    #[serde(alias = "id_key")]
    pub id_key: String,
    #[serde(alias = "workspace_id")]
    pub workspace_id: String,
    #[serde(alias = "institution_slug")]
    pub institution_slug: String,
    #[serde(alias = "statement_kind")]
    pub statement_kind: String,
    #[serde(alias = "header_fingerprint")]
    pub header_fingerprint: String,
    #[serde(alias = "column_mappings")]
    pub column_mappings: BTreeMap<String, ColumnRole>,
    #[serde(alias = "created_at")]
    pub created_at: String,
    #[serde(alias = "updated_at")]
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditPatchInput {
    pub field: String,
    pub raw_value: String,
    pub repaired_value: i64,
    pub repair_type: String,
    pub actor: String,
    pub rationale: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForcePostInput {
    pub actor: String,
    pub rationale: String,
    pub discrepancy_minor: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphTrialBalanceRow {
    pub ledger_id: String,
    pub name: String,
    pub normal_side: String,
    pub total_debits_minor: i64,
    pub total_credits_minor: i64,
    pub net_balance_minor: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowStatementRow {
    pub voucher_id: String,
    pub txn_date: String,
    pub edge_type: String,
    pub amount_minor: i64,
    pub reference: Option<String>,
    pub narration: Option<String>,
    pub running_balance_minor: i64,
    pub flagged_scrutiny: bool,
}

pub fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true)
}

fn random_hex(bytes: usize) -> String {
    let mut buffer = vec![0_u8; bytes];
    if getrandom::getrandom(&mut buffer).is_err() {
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

fn sha256_hex(input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    hex_digest(&hasher.finalize())
}

#[derive(Clone)]
pub struct Store {
    db: Surreal<Any>,
    device_id: String,
}

impl Store {
    pub async fn open(path: impl AsRef<Path>) -> StorageResult<Self> {
        let endpoint = format!("surrealkv://{}?versioned=true", path.as_ref().display());
        let db = surrealdb::engine::any::connect(endpoint).await?;
        db.use_ns("zeroledger").use_db("main").await?;
        schema::migrate(&db).await?;
        let device_id = Self::ensure_device_id(&db).await?;
        Ok(Self { db, device_id })
    }

    pub async fn open_in_memory() -> StorageResult<Self> {
        let db = surrealdb::engine::any::connect("mem://").await?;
        db.use_ns("zeroledger").use_db("main").await?;
        schema::migrate(&db).await?;
        let device_id = Self::ensure_device_id(&db).await?;
        Ok(Self { db, device_id })
    }

    pub async fn open_with_device(
        path: impl AsRef<Path>,
        device_id: impl Into<String>,
    ) -> StorageResult<Self> {
        let endpoint = format!("surrealkv://{}?versioned=true", path.as_ref().display());
        let db = surrealdb::engine::any::connect(endpoint).await?;
        db.use_ns("zeroledger").use_db("main").await?;
        schema::migrate(&db).await?;
        let device_id = device_id.into();
        Self::set_meta(&db, "device_id", &device_id).await?;
        Ok(Self { db, device_id })
    }

    pub async fn in_memory_with_device(device_id: impl Into<String>) -> StorageResult<Self> {
        let db = surrealdb::engine::any::connect("mem://").await?;
        db.use_ns("zeroledger").use_db("main").await?;
        schema::migrate(&db).await?;
        let device_id = device_id.into();
        Self::set_meta(&db, "device_id", &device_id).await?;
        Ok(Self { db, device_id })
    }

    async fn ensure_device_id(db: &Surreal<Any>) -> StorageResult<String> {
        #[derive(Deserialize)]
        struct MetaRow {
            value: String,
        }
        let mut res = db
            .query("SELECT `value` FROM meta WHERE key = 'device_id' LIMIT 1")
            .await?;
        let rows: Vec<MetaRow> = res.take(0).unwrap_or_default();
        if let Some(row) = rows.into_iter().next() {
            return Ok(row.value);
        }
        let id = format!("dev_{}", random_hex(8));
        Self::set_meta(db, "device_id", &id).await?;
        Ok(id)
    }

    async fn set_meta(db: &Surreal<Any>, key: &str, value: &str) -> StorageResult<()> {
        db.query("DELETE meta WHERE key = $key; CREATE meta SET key = $key, `value` = $val;")
            .bind(("key", key.to_string()))
            .bind(("val", value.to_string()))
            .await?
            .check()?;
        Ok(())
    }

    pub fn device_id(&self) -> &str {
        &self.device_id
    }

    pub async fn schema_version(&self) -> StorageResult<u32> {
        #[derive(Deserialize)]
        struct MRow {
            version: u32,
        }
        let mut res = self
            .db
            .query("SELECT version FROM _migrations ORDER BY version DESC LIMIT 1")
            .await?;
        let rows: Vec<MRow> = res.take(0).unwrap_or_default();
        Ok(rows.first().map(|r| r.version).unwrap_or(0))
    }

    pub async fn get_sync_meta(&self, key: &str) -> StorageResult<Option<String>> {
        #[derive(Deserialize)]
        struct Row {
            value: String,
        }
        let mut res = self
            .db
            .query("SELECT `value` FROM sync_meta WHERE key = $key LIMIT 1")
            .bind(("key", key.to_string()))
            .await?;
        let rows: Vec<Row> = res.take(0).unwrap_or_default();
        Ok(rows.into_iter().next().map(|r| r.value))
    }

    pub async fn set_sync_meta(&self, key: &str, value: &str) -> StorageResult<()> {
        self.db
            .query("DELETE sync_meta WHERE key = $key; CREATE sync_meta SET key = $key, `value` = $val;")
            .bind(("key", key.to_string()))
            .bind(("val", value.to_string()))
            .await?
            .check()?;
        Ok(())
    }

    pub async fn next_lamport(&self) -> StorageResult<u64> {
        let current = self
            .get_sync_meta("lamport")
            .await?
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(0);
        let next = current + 1;
        self.set_sync_meta("lamport", &next.to_string()).await?;
        Ok(next)
    }

    async fn append_audit_event(
        &self,
        workspace_id: &str,
        entity_type: &str,
        entity_id: &str,
        action: &str,
        actor: &str,
        rationale: Option<&str>,
        payload_json: &str,
    ) -> StorageResult<String> {
        #[derive(Deserialize)]
        struct HashRow {
            hash: String,
        }
        let mut res = self
            .db
            .query("SELECT hash, at FROM audit_event WHERE workspace_id = $ws ORDER BY at DESC LIMIT 1")
            .bind(("ws", workspace_id.to_string()))
            .await?;
        let prev_hash = res
            .take::<Vec<HashRow>>(0)
            .unwrap_or_default()
            .into_iter()
            .next()
            .map(|r| r.hash)
            .unwrap_or_else(|| "GENESIS".to_string());

        let at = now_iso();
        let id_key = format!("aud_{}", random_hex(8));
        let hash = sha256_hex(&format!(
            "{}|{}|{}|{}|{}|{}|{}",
            prev_hash, workspace_id, entity_type, entity_id, action, payload_json, at
        ));

        self.db
            .query(
                "CREATE type::thing('audit_event', $id_key) SET
                    id_key = $id_key,
                    workspace_id = $ws,
                    entity_type = $et,
                    entity_id = $eid,
                    action = $act,
                    actor = $actor,
                    rationale = $rat,
                    payload = $pay,
                    prev_hash = $prev,
                    hash = $hash,
                    at = $at;",
            )
            .bind(("id_key", id_key.clone()))
            .bind(("ws", workspace_id.to_string()))
            .bind(("et", entity_type.to_string()))
            .bind(("eid", entity_id.to_string()))
            .bind(("act", action.to_string()))
            .bind(("actor", actor.to_string()))
            .bind(("rat", rationale.map(|s| s.to_string())))
            .bind(("pay", payload_json.to_string()))
            .bind(("prev", prev_hash))
            .bind(("hash", hash))
            .bind(("at", at))
            .await?
            .check()?;

        Ok(id_key)
    }

    async fn record_change(
        &self,
        entity_type: &str,
        entity_id: &str,
        op: ChangeOp,
        payload_json: &str,
    ) -> StorageResult<()> {
        let lamport = self.next_lamport().await?;
        let created_at = now_iso();
        let op_str = match op {
            ChangeOp::Upsert => "upsert",
            ChangeOp::Delete => "delete",
        };
        let content_hash = sha256_hex(&format!(
            "{}|{}|{}|{}|{}",
            entity_type, entity_id, op_str, lamport, payload_json
        ));

        self.db
            .query(
                "CREATE change_log SET
                    seq = $seq,
                    entity_type = $et,
                    entity_id = $eid,
                    op = $op,
                    payload = $pay,
                    lamport = $lam,
                    device_id = $dev,
                    content_hash = $hash,
                    created_at = $at;",
            )
            .bind(("seq", lamport as i64))
            .bind(("et", entity_type.to_string()))
            .bind(("eid", entity_id.to_string()))
            .bind(("op", op_str.to_string()))
            .bind(("pay", payload_json.to_string()))
            .bind(("lam", lamport as i64))
            .bind(("dev", self.device_id.clone()))
            .bind(("hash", content_hash))
            .bind(("at", created_at))
            .await?
            .check()?;
        Ok(())
    }

    async fn seed_system_ledgers(&self, workspace_id: &str) -> StorageResult<()> {
        let now = now_iso();
        for (id_suffix, name, normal_side) in [
            ("uncategorized", "Unknown / Uncategorized", "debit"),
            ("unreconciled_suspense", "Unreconciled Suspense", "debit"),
        ] {
            let id_key = format!("{}_{}", workspace_id, id_suffix);
            self.db
                .query(
                    "UPSERT type::thing('ledger', $id_key) SET
                        id_key = $id_key,
                        workspace_id = $ws,
                        name = $name,
                        tally_parent = 'Suspense A/c',
                        nature = 'expense',
                        normal_side = $ns,
                        opening_balance_minor = 0,
                        is_party = false,
                        is_bank = false,
                        is_tax = false,
                        billwise = false,
                        is_system = true,
                        archived = false,
                        created_at = $now,
                        updated_at = $now;",
                )
                .bind(("id_key", id_key))
                .bind(("ws", workspace_id.to_string()))
                .bind(("name", name.to_string()))
                .bind(("ns", normal_side.to_string()))
                .bind(("now", now.clone()))
                .await?
                .check()?;
        }
        Ok(())
    }

    pub async fn create_workspace(
        &self,
        workspace: &Workspace,
        company: &CompanyProfile,
    ) -> StorageResult<()> {
        self.db
            .query(
                "UPSERT type::thing('workspace', $id) SET
                    id_key = $id,
                    slug = $slug,
                    name = $name,
                    readable_name = $rname,
                    company_id = $cid,
                    authorized_forwarders = [],
                    discrepancy_count = 0,
                    archived = $arch,
                    created_at = $cat,
                    updated_at = $uat;",
            )
            .bind(("id", workspace.id.clone()))
            .bind(("slug", workspace.slug.clone()))
            .bind(("name", workspace.name.clone()))
            .bind(("rname", workspace.readable_name.clone()))
            .bind(("cid", workspace.company_id.clone()))
            .bind(("arch", workspace.archived))
            .bind(("cat", workspace.created_at.clone()))
            .bind(("uat", workspace.updated_at.clone()))
            .await?
            .check()?;

        self.db
            .query(
                "UPSERT type::thing('company', $id) SET
                    id_key = $id,
                    workspace_id = $ws,
                    legal_name = $lname,
                    trade_name = $tname,
                    gstin = $gstin,
                    pan = $pan,
                    state = $state,
                    currency = $cur,
                    books_begin = $bb,
                    fy_start_month = $fy,
                    round_to_minor = $rtm,
                    rounding_mode = $rm,
                    decimal_places = $dp,
                    default_currency = $dc,
                    created_at = $cat,
                    updated_at = $uat;",
            )
            .bind(("id", company.id.clone()))
            .bind(("ws", company.workspace_id.clone()))
            .bind(("lname", company.legal_name.clone()))
            .bind(("tname", company.trade_name.clone()))
            .bind(("gstin", company.gstin.clone()))
            .bind(("pan", company.pan.clone()))
            .bind(("state", company.state.clone()))
            .bind(("cur", company.currency.clone()))
            .bind(("bb", company.books_begin.clone()))
            .bind(("fy", company.settings.fy_start_month as i64))
            .bind(("rtm", company.settings.round_to_minor))
            .bind(("rm", company.settings.rounding_mode.as_str().to_string()))
            .bind(("dp", company.settings.decimal_places as i64))
            .bind(("dc", company.settings.default_currency.clone()))
            .bind(("cat", company.created_at.clone()))
            .bind(("uat", company.updated_at.clone()))
            .await?
            .check()?;

        self.seed_system_ledgers(&workspace.id).await?;
        let payload = serde_json::to_string(workspace)?;
        self.record_change("workspace", &workspace.id, ChangeOp::Upsert, &payload)
            .await?;
        Ok(())
    }

    pub async fn get_workspace(&self, workspace_id: &str) -> StorageResult<Option<Workspace>> {
        #[derive(Deserialize)]
        struct WsRow {
            id_key: String,
            slug: String,
            name: String,
            readable_name: String,
            company_id: String,
            archived: bool,
            created_at: String,
            updated_at: String,
        }
        let mut res = self
            .db
            .query("SELECT id_key, slug, name, readable_name, company_id, archived, created_at, updated_at FROM workspace WHERE id_key = $id LIMIT 1")
            .bind(("id", workspace_id.to_string()))
            .await?;
        let rows: Vec<WsRow> = res.take(0).unwrap_or_default();
        Ok(rows.into_iter().next().map(|r| Workspace {
            id: r.id_key,
            slug: r.slug,
            name: r.name,
            readable_name: r.readable_name,
            company_id: r.company_id,
            archived: r.archived,
            created_at: r.created_at,
            updated_at: r.updated_at,
        }))
    }

    pub async fn list_workspaces(&self) -> StorageResult<Vec<Workspace>> {
        #[derive(Deserialize)]
        struct WsRow {
            id_key: String,
            slug: String,
            name: String,
            readable_name: String,
            company_id: String,
            archived: bool,
            created_at: String,
            updated_at: String,
        }
        let mut res = self
            .db
            .query("SELECT id_key, slug, name, readable_name, company_id, archived, created_at, updated_at FROM workspace ORDER BY created_at ASC")
            .await?;
        let rows: Vec<WsRow> = res.take(0).unwrap_or_default();
        Ok(rows
            .into_iter()
            .map(|r| Workspace {
                id: r.id_key,
                slug: r.slug,
                name: r.name,
                readable_name: r.readable_name,
                company_id: r.company_id,
                archived: r.archived,
                created_at: r.created_at,
                updated_at: r.updated_at,
            })
            .collect())
    }

    pub async fn get_company(&self, workspace_id: &str) -> StorageResult<Option<CompanyProfile>> {
        #[derive(Deserialize)]
        struct CompRow {
            id_key: String,
            workspace_id: String,
            legal_name: String,
            trade_name: Option<String>,
            gstin: Option<String>,
            pan: Option<String>,
            state: Option<String>,
            currency: String,
            books_begin: String,
            fy_start_month: u32,
            round_to_minor: i64,
            rounding_mode: String,
            decimal_places: u32,
            default_currency: String,
            created_at: String,
            updated_at: String,
        }
        let mut res = self
            .db
            .query("SELECT * FROM company WHERE workspace_id = $ws LIMIT 1")
            .bind(("ws", workspace_id.to_string()))
            .await?;
        let rows: Vec<CompRow> = res.take(0).unwrap_or_default();
        Ok(rows.into_iter().next().map(|r| CompanyProfile {
            id: r.id_key,
            workspace_id: r.workspace_id,
            legal_name: r.legal_name,
            trade_name: r.trade_name,
            gstin: r.gstin,
            pan: r.pan,
            state: r.state,
            currency: r.currency,
            books_begin: r.books_begin,
            settings: CompanySettings {
                fy_start_month: r.fy_start_month,
                round_to_minor: r.round_to_minor,
                rounding_mode: RoundingMode::parse(&r.rounding_mode),
                decimal_places: r.decimal_places,
                default_currency: r.default_currency,
            },
            created_at: r.created_at,
            updated_at: r.updated_at,
        }))
    }

    pub async fn upsert_ledger(&self, ledger: &Ledger) -> StorageResult<()> {
        let normal_side = match ledger.nature {
            LedgerNature::Asset | LedgerNature::Expense => "debit",
            LedgerNature::Liability | LedgerNature::Income | LedgerNature::Equity => "credit",
        };
        self.db
            .query(
                "UPSERT type::thing('ledger', $id) SET
                    id_key = $id,
                    workspace_id = $ws,
                    name = $name,
                    tally_parent = $tp,
                    nature = $nat,
                    normal_side = $ns,
                    opening_balance_minor = $ob,
                    is_party = $ip,
                    is_bank = $ib,
                    is_tax = $it,
                    billwise = $bw,
                    is_system = false,
                    archived = $arch,
                    created_at = $cat,
                    updated_at = $uat;",
            )
            .bind(("id", ledger.id.clone()))
            .bind(("ws", ledger.workspace_id.clone()))
            .bind(("name", ledger.name.clone()))
            .bind(("tp", ledger.tally_parent.as_str().to_string()))
            .bind(("nat", ledger.nature.as_str().to_string()))
            .bind(("ns", normal_side.to_string()))
            .bind(("ob", ledger.opening_balance_minor))
            .bind(("ip", ledger.is_party))
            .bind(("ib", ledger.is_bank))
            .bind(("it", ledger.is_tax))
            .bind(("bw", ledger.billwise))
            .bind(("arch", ledger.archived))
            .bind(("cat", ledger.created_at.clone()))
            .bind(("uat", ledger.updated_at.clone()))
            .await?
            .check()?;
        let payload = serde_json::to_string(ledger)?;
        self.record_change("ledger", &ledger.id, ChangeOp::Upsert, &payload)
            .await?;
        Ok(())
    }

    pub async fn get_ledger(&self, ledger_id: &str) -> StorageResult<Option<Ledger>> {
        let mut res = self
            .db
            .query("SELECT * FROM ledger WHERE id_key = $id LIMIT 1")
            .bind(("id", ledger_id.to_string()))
            .await?;
        let rows: Vec<LedgerRow> = res.take(0).unwrap_or_default();
        Ok(rows.into_iter().next().and_then(LedgerRow::into_ledger))
    }

    pub async fn list_ledgers(&self, workspace_id: &str) -> StorageResult<Vec<Ledger>> {
        let mut res = self
            .db
            .query("SELECT * FROM ledger WHERE workspace_id = $ws ORDER BY name ASC")
            .bind(("ws", workspace_id.to_string()))
            .await?;
        let rows: Vec<LedgerRow> = res.take(0).unwrap_or_default();
        Ok(rows.into_iter().filter_map(LedgerRow::into_ledger).collect())
    }

    pub async fn upsert_party(&self, party: &Party) -> StorageResult<()> {
        self.db
            .query(
                "UPSERT type::thing('party', $id) SET
                    id_key = $id,
                    workspace_id = $ws,
                    ledger_id = $lid,
                    name = $name,
                    gstin = $gstin,
                    party_type = $pt,
                    created_at = $cat,
                    updated_at = $uat;",
            )
            .bind(("id", party.id.clone()))
            .bind(("ws", party.workspace_id.clone()))
            .bind(("lid", party.ledger_id.clone()))
            .bind(("name", party.name.clone()))
            .bind(("gstin", party.gstin.clone()))
            .bind(("pt", party.party_type.as_str().to_string()))
            .bind(("cat", party.created_at.clone()))
            .bind(("uat", party.updated_at.clone()))
            .await?
            .check()?;
        let payload = serde_json::to_string(party)?;
        self.record_change("party", &party.id, ChangeOp::Upsert, &payload)
            .await?;
        Ok(())
    }

    pub async fn list_parties(&self, workspace_id: &str) -> StorageResult<Vec<Party>> {
        #[derive(Deserialize)]
        struct PartyRow {
            id_key: String,
            workspace_id: String,
            ledger_id: String,
            name: String,
            gstin: Option<String>,
            party_type: String,
            created_at: String,
            updated_at: String,
        }
        let mut res = self
            .db
            .query("SELECT * FROM party WHERE workspace_id = $ws ORDER BY name ASC")
            .bind(("ws", workspace_id.to_string()))
            .await?;
        let rows: Vec<PartyRow> = res.take(0).unwrap_or_default();
        Ok(rows
            .into_iter()
            .filter_map(|r| {
                PartyType::parse(&r.party_type).map(|pt| Party {
                    id: r.id_key,
                    workspace_id: r.workspace_id,
                    ledger_id: r.ledger_id,
                    name: r.name,
                    gstin: r.gstin,
                    party_type: pt,
                    created_at: r.created_at,
                    updated_at: r.updated_at,
                })
            })
            .collect())
    }

    pub async fn post_voucher(&self, input: &NewVoucher) -> StorageResult<()> {
        let validation = validate_new_voucher(input);
        if !validation.ok {
            let msg = validation
                .issues
                .iter()
                .map(|i| i.message.clone())
                .collect::<Vec<_>>()
                .join("; ");
            return Err(StorageError::Validation(msg));
        }

        let fy_key = match self.get_company(&input.voucher.workspace_id).await? {
            Some(c) => financial_year_key(&input.voucher.date, c.settings.fy_start_month)?,
            None => financial_year_key(&input.voucher.date, 4)?,
        };
        let payload = serde_json::to_string(input)?;
        let content_hash = sha256_hex(&payload);

        self.db
            .query(
                "UPSERT type::thing('voucher', $id) SET
                    id_key = $id,
                    workspace_id = $ws,
                    voucher_type = $vt,
                    number = $num,
                    date = $dt,
                    status = $st,
                    currency = $cur,
                    party_ledger_id = $plid,
                    invoice_number = $inv,
                    narration = $nar,
                    round_off_amount_minor = $roa,
                    round_off_ledger_id = $rol,
                    source = $src,
                    fy_key = $fy,
                    content_hash = $ch,
                    flagged_scrutiny = false,
                    created_at = $cat,
                    updated_at = $uat;",
            )
            .bind(("id", input.voucher.id.clone()))
            .bind(("ws", input.voucher.workspace_id.clone()))
            .bind(("vt", input.voucher.voucher_type.as_str().to_string()))
            .bind(("num", input.voucher.number.clone()))
            .bind(("dt", input.voucher.date.clone()))
            .bind(("st", input.voucher.status.as_str().to_string()))
            .bind(("cur", input.voucher.currency.clone()))
            .bind(("plid", input.voucher.party_ledger_id.clone()))
            .bind(("inv", input.voucher.invoice_number.clone()))
            .bind(("nar", input.voucher.narration.clone()))
            .bind(("roa", input.voucher.round_off_amount_minor))
            .bind(("rol", input.voucher.round_off_ledger_id.clone()))
            .bind(("src", input.voucher.source.as_str().to_string()))
            .bind(("fy", fy_key))
            .bind(("ch", content_hash))
            .bind(("cat", input.voucher.created_at.clone()))
            .bind(("uat", input.voucher.updated_at.clone()))
            .await?
            .check()?;

        for line in &input.lines {
            self.db
                .query(
                    "UPSERT type::thing('voucher_line', $id) SET
                        id_key = $id,
                        voucher_id = $vid,
                        workspace_id = $ws,
                        line_no = $ln,
                        ledger_id = $lid,
                        amount_minor = $amt,
                        currency = $cur,
                        narration = $nar;",
                )
                .bind(("id", line.id.clone()))
                .bind(("vid", line.voucher_id.clone()))
                .bind(("ws", line.workspace_id.clone()))
                .bind(("ln", line.line_no as i64))
                .bind(("lid", line.ledger_id.clone()))
                .bind(("amt", line.amount_minor))
                .bind(("cur", line.currency.clone()))
                .bind(("nar", line.narration.clone()))
                .await?
                .check()?;
        }

        // Emit directed flow edge(s) for paired debit/credit lines.
        let credits: Vec<&VoucherLine> = input.lines.iter().filter(|l| l.amount_minor < 0).collect();
        let debits: Vec<&VoucherLine> = input.lines.iter().filter(|l| l.amount_minor > 0).collect();
        if let (Some(src), Some(dst)) = (credits.first(), debits.first()) {
            let amt = dst.amount_minor.abs();
            if amt > 0 {
                self.db
                    .query(
                        "LET $src_rec = type::thing('ledger', $src);
                         LET $dst_rec = type::thing('ledger', $dst);
                         RELATE $src_rec -> flow -> $dst_rec SET
                            workspace_id = $ws,
                            voucher_id = type::thing('voucher', $vid),
                            edge_type = $et,
                            amount_minor = $amt,
                            currency = $cur,
                            txn_date = $dt,
                            reference = $ref,
                            narration_norm = $nar,
                            daily_rank = 1,
                            flagged_scrutiny = false;",
                    )
                    .bind(("src", src.ledger_id.clone()))
                    .bind(("dst", dst.ledger_id.clone()))
                    .bind(("ws", input.voucher.workspace_id.clone()))
                    .bind(("vid", input.voucher.id.clone()))
                    .bind(("et", input.voucher.voucher_type.as_str().to_ascii_uppercase()))
                    .bind(("amt", amt))
                    .bind(("cur", input.voucher.currency.clone()))
                    .bind(("dt", input.voucher.date.clone()))
                    .bind(("ref", input.voucher.invoice_number.clone()))
                    .bind(("nar", input.voucher.narration.as_deref().map(zeroledger_engine::normalize_narration)))
                    .await?
                    .check()?;
            }
        }

        self.append_audit_event(
            &input.voucher.workspace_id,
            "voucher",
            &input.voucher.id,
            "POST",
            "system",
            None,
            &payload,
        )
        .await?;
        self.record_change("voucher", &input.voucher.id, ChangeOp::Upsert, &payload)
            .await?;
        Ok(())
    }

    pub async fn get_voucher(
        &self,
        voucher_id: &str,
    ) -> StorageResult<Option<(Voucher, Vec<VoucherLine>)>> {
        let mut res = self
            .db
            .query("SELECT * FROM voucher WHERE id_key = $id LIMIT 1")
            .bind(("id", voucher_id.to_string()))
            .await?;
        let rows: Vec<VoucherRow> = res.take(0).unwrap_or_default();
        let Some(v) = rows.into_iter().next().and_then(VoucherRow::into_voucher) else {
            return Ok(None);
        };
        let mut lres = self
            .db
            .query("SELECT * FROM voucher_line WHERE voucher_id = $vid ORDER BY line_no ASC")
            .bind(("vid", voucher_id.to_string()))
            .await?;
        let lrows: Vec<VoucherLineRow> = lres.take(0).unwrap_or_default();
        let lines = lrows
            .into_iter()
            .map(VoucherLineRow::into_line)
            .collect::<Vec<_>>();
        Ok(Some((v, lines)))
    }

    pub async fn list_vouchers(&self, workspace_id: &str) -> StorageResult<Vec<Voucher>> {
        let mut res = self
            .db
            .query("SELECT * FROM voucher WHERE workspace_id = $ws ORDER BY date ASC, number ASC")
            .bind(("ws", workspace_id.to_string()))
            .await?;
        let rows: Vec<VoucherRow> = res.take(0).unwrap_or_default();
        Ok(rows
            .into_iter()
            .filter_map(VoucherRow::into_voucher)
            .collect())
    }

    pub async fn list_voucher_lines(&self, workspace_id: &str) -> StorageResult<Vec<VoucherLine>> {
        let mut res = self
            .db
            .query("SELECT * FROM voucher_line WHERE workspace_id = $ws ORDER BY voucher_id ASC, line_no ASC")
            .bind(("ws", workspace_id.to_string()))
            .await?;
        let rows: Vec<VoucherLineRow> = res.take(0).unwrap_or_default();
        Ok(rows.into_iter().map(VoucherLineRow::into_line).collect())
    }

    pub async fn trial_balance(&self, workspace_id: &str) -> StorageResult<TrialBalance> {
        let ledgers = self.list_ledgers(workspace_id).await?;
        let vouchers = self.list_vouchers(workspace_id).await?;
        let lines = self.list_voucher_lines(workspace_id).await?;
        Ok(trial_balance(&ledgers, &vouchers, &lines))
    }

    pub async fn profit_and_loss(&self, workspace_id: &str) -> StorageResult<ProfitAndLoss> {
        let ledgers = self.list_ledgers(workspace_id).await?;
        let vouchers = self.list_vouchers(workspace_id).await?;
        let lines = self.list_voucher_lines(workspace_id).await?;
        Ok(profit_and_loss(&ledgers, &vouchers, &lines))
    }

    pub async fn integrity_check(&self, workspace_id: &str) -> StorageResult<IntegrityReport> {
        let vouchers = self.list_vouchers(workspace_id).await?;
        let lines = self.list_voucher_lines(workspace_id).await?;
        let mut issues = Vec::new();
        let mut by_voucher: HashMap<String, Vec<VoucherLine>> = HashMap::new();
        for l in lines {
            by_voucher.entry(l.voucher_id.clone()).or_default().push(l);
        }
        for v in &vouchers {
            let vlines = by_voucher.get(&v.id).map(|s| s.as_slice()).unwrap_or(&[]);
            if !validate_line_balance(vlines).ok {
                issues.push(IntegrityIssue {
                    code: "UNBALANCED_VOUCHER".to_string(),
                    message: format!("voucher {} does not balance to zero", v.id),
                    entity_id: Some(v.id.clone()),
                });
            }
        }
        Ok(IntegrityReport {
            ok: issues.is_empty(),
            checked_vouchers: vouchers.len() as u32,
            checked_audit_events: 0,
            issues,
        })
    }

    pub async fn delete_entity(&self, entity_type: &str, entity_id: &str) -> StorageResult<()> {
        let table = match entity_type {
            "workspace" | "ledger" | "party" | "voucher" => entity_type,
            _ => return Err(StorageError::Validation(format!("unknown entity_type: {entity_type}"))),
        };
        let query = format!("DELETE {table} WHERE id_key = $id;");
        self.db
            .query(query)
            .bind(("id", entity_id.to_string()))
            .await?
            .check()?;
        let lamport = self.next_lamport().await?;
        self.db
            .query(
                "UPSERT tombstone SET entity_type = $et, entity_id = $eid, device_id = $dev, lamport = $lam, deleted_at = $at;",
            )
            .bind(("et", entity_type.to_string()))
            .bind(("eid", entity_id.to_string()))
            .bind(("dev", self.device_id.clone()))
            .bind(("lam", lamport as i64))
            .bind(("at", now_iso()))
            .await?
            .check()?;
        self.record_change(entity_type, entity_id, ChangeOp::Delete, "{}")
            .await?;
        Ok(())
    }

    pub async fn backup_to(&self, path: impl AsRef<Path>) -> StorageResult<()> {
        let target = path.as_ref();
        if target.exists() {
            return Err(StorageError::BackupExists(target.display().to_string()));
        }
        self.db.export(target).await?;
        Ok(())
    }

    pub async fn export_workspace_snapshot(&self, path: impl AsRef<Path>) -> StorageResult<()> {
        self.db.export(path.as_ref()).await?;
        Ok(())
    }

    pub async fn import_workspace_snapshot(&self, path: impl AsRef<Path>) -> StorageResult<()> {
        self.db.import(path.as_ref()).await?;
        Ok(())
    }

    pub async fn import_bundle(&self, bundle: &ImportBundle) -> StorageResult<ImportSummary> {
        let mut summary = ImportSummary::default();
        for ws in &bundle.workspaces {
            if let Some(comp) = bundle
                .companies
                .iter()
                .find(|c| c.workspace_id == ws.id)
            {
                self.create_workspace(ws, comp).await?;
                summary.workspaces += 1;
                summary.companies += 1;
            }
        }
        for ledger in &bundle.ledgers {
            self.upsert_ledger(ledger).await?;
            summary.ledgers += 1;
        }
        for party in &bundle.parties {
            self.upsert_party(party).await?;
            summary.parties += 1;
        }
        for v in &bundle.vouchers {
            self.post_voucher(v).await?;
            summary.vouchers += 1;
        }
        Ok(summary)
    }

    pub async fn changes_since(&self, since_lamport: u64) -> StorageResult<Vec<Change>> {
        #[derive(Deserialize)]
        struct ChangeRow {
            entity_type: String,
            entity_id: String,
            op: String,
            payload: String,
            lamport: u64,
            device_id: String,
            content_hash: String,
            created_at: String,
        }
        let mut res = self
            .db
            .query("SELECT entity_type, entity_id, op, payload, lamport, device_id, content_hash, created_at FROM change_log WHERE lamport > $since ORDER BY lamport ASC")
            .bind(("since", since_lamport as i64))
            .await?;
        let rows: Vec<ChangeRow> = res.take(0).unwrap_or_default();
        Ok(rows
            .into_iter()
            .filter_map(|r| {
                let op = match r.op.as_str() {
                    "upsert" => ChangeOp::Upsert,
                    "delete" => ChangeOp::Delete,
                    _ => return None,
                };
                Some(Change {
                    entity_type: r.entity_type,
                    entity_id: r.entity_id,
                    op,
                    payload: r.payload,
                    lamport: r.lamport,
                    device_id: r.device_id,
                    content_hash: r.content_hash,
                    created_at: r.created_at,
                })
            })
            .collect())
    }

    pub async fn change_set_since(&self, since_lamport: u64) -> StorageResult<ChangeSet> {
        let changes = self.changes_since(since_lamport).await?;
        let max_lamport = changes.iter().map(|c| c.lamport).max().unwrap_or(since_lamport);
        Ok(ChangeSet {
            schema_version: zeroledger_sync::CHANGESET_SCHEMA_VERSION,
            device_id: self.device_id.clone(),
            lamport: max_lamport,
            changes,
        })
    }

    pub async fn apply_change_set(&self, change_set: &ChangeSet) -> StorageResult<ApplySummary> {
        let existing = self.changes_since(0).await?;
        let merged = merge_changes(&existing, &change_set.changes);
        let mut summary = ApplySummary::default();
        for ch in merged {
            if existing.iter().any(|e| e.content_hash == ch.content_hash) {
                summary.skipped += 1;
            } else {
                self.record_change(&ch.entity_type, &ch.entity_id, ch.op, &ch.payload)
                    .await?;
                summary.applied += 1;
            }
        }
        Ok(summary)
    }

    pub async fn export_sync_envelope(
        &self,
        key: &SyncKey,
        since_lamport: u64,
    ) -> StorageResult<String> {
        let change_set = self.change_set_since(since_lamport).await?;
        let envelope = zeroledger_sync::seal(key, self.device_id.clone(), now_iso(), &change_set)?;
        Ok(envelope.to_json()?)
    }

    pub async fn import_sync_envelope(
        &self,
        key: &SyncKey,
        envelope_json: &str,
    ) -> StorageResult<ApplySummary> {
        let envelope = zeroledger_sync::SealedEnvelope::from_json(envelope_json)?;
        let change_set = zeroledger_sync::open(key, &envelope)?;
        self.apply_change_set(&change_set).await
    }

    // ---- Audited PDF Ingestion & Graph Ledger Methods ----------------------

    pub async fn create_ingest_batch(
        &self,
        workspace_id: &str,
        source_type: &str,
        source_reference: Option<&str>,
        content_sha256: &str,
        sender_address: Option<&str>,
        statement_kind: StatementKind,
        institution_slug: Option<&str>,
        account_tail: Option<&str>,
    ) -> StorageResult<IngestBatchDto> {
        // Guard against duplicate non-ABORTED batches.
        let mut dup_res = self
            .db
            .query("SELECT id_key FROM ingest_batch WHERE workspace_id = $ws AND content_sha256 = $hash AND state != 'ABORTED' LIMIT 1")
            .bind(("ws", workspace_id.to_string()))
            .bind(("hash", content_sha256.to_string()))
            .await?;
        let dups: Vec<serde_json::Value> = dup_res.take(0).unwrap_or_default();
        if !dups.is_empty() {
            return Err(StorageError::Validation(format!(
                "duplicate batch content_sha256: {}",
                content_sha256
            )));
        }

        // Guard sender authorization for non-upload sources.
        if source_type != "upload" {
            #[derive(Deserialize)]
            struct FwdRow {
                authorized_forwarders: Vec<String>,
            }
            let mut ws_res = self
                .db
                .query("SELECT authorized_forwarders FROM workspace WHERE id_key = $ws LIMIT 1")
                .bind(("ws", workspace_id.to_string()))
                .await?;
            let fwds = ws_res
                .take::<Vec<FwdRow>>(0)
                .unwrap_or_default()
                .into_iter()
                .next()
                .map(|r| r.authorized_forwarders)
                .unwrap_or_default();
            if !fwds.is_empty() {
                let allowed = sender_address
                    .map(|s| fwds.iter().any(|f| f.eq_ignore_ascii_case(s)))
                    .unwrap_or(false);
                if !allowed {
                    return Err(StorageError::Validation(
                        "unauthorized email sender for forwarded statement".to_string(),
                    ));
                }
            }
        }

        let now = now_iso();
        let id_key = format!("batch_{}", random_hex(8));
        let batch = IngestBatchDto {
            id_key: id_key.clone(),
            workspace_id: workspace_id.to_string(),
            bank_account_id: None,
            source_type: source_type.to_string(),
            source_reference: source_reference.map(|s| s.to_string()),
            content_sha256: content_sha256.to_string(),
            sender_address: sender_address.map(|s| s.to_string()),
            state: IngestBatchState::Received.as_str().to_string(),
            statement_kind: statement_kind.as_str().to_string(),
            institution_slug: institution_slug.map(|s| s.to_string()),
            account_tail: account_tail.map(|s| s.to_string()),
            total_rows: 0,
            reconciled_rows: 0,
            skipped_duplicate_count: 0,
            error_message: None,
            created_at: now.clone(),
            updated_at: now,
        };

        self.db
            .query(
                "CREATE type::thing('ingest_batch', $id) SET
                    id_key = $id,
                    workspace_id = $ws,
                    source_type = $st,
                    source_reference = $sr,
                    content_sha256 = $hash,
                    sender_address = $sa,
                    state = $state,
                    statement_kind = $sk,
                    institution_slug = $inst,
                    account_tail = $tail,
                    total_rows = 0,
                    reconciled_rows = 0,
                    skipped_duplicate_count = 0,
                    created_at = $cat,
                    updated_at = $uat;",
            )
            .bind(("id", batch.id_key.clone()))
            .bind(("ws", batch.workspace_id.clone()))
            .bind(("st", batch.source_type.clone()))
            .bind(("sr", batch.source_reference.clone()))
            .bind(("hash", batch.content_sha256.clone()))
            .bind(("sa", batch.sender_address.clone()))
            .bind(("state", batch.state.clone()))
            .bind(("sk", batch.statement_kind.clone()))
            .bind(("inst", batch.institution_slug.clone()))
            .bind(("tail", batch.account_tail.clone()))
            .bind(("cat", batch.created_at.clone()))
            .bind(("uat", batch.updated_at.clone()))
            .await?
            .check()?;

        Ok(batch)
    }

    pub async fn get_ingest_batch(&self, batch_id: &str) -> StorageResult<Option<IngestBatchDto>> {
        let mut res = self
            .db
            .query("SELECT id_key, workspace_id, source_type, source_reference, content_sha256, sender_address, state, statement_kind, institution_slug, account_tail, total_rows, reconciled_rows, skipped_duplicate_count, error_message, created_at, updated_at FROM ingest_batch WHERE id_key = $id LIMIT 1")
            .bind(("id", batch_id.to_string()))
            .await?;
        let mut rows: Vec<serde_json::Value> = res.take(0).unwrap_or_default();
        let Some(val) = rows.pop() else {
            return Ok(None);
        };
        let mut dto: IngestBatchDto = serde_json::from_value(val)?;
        dto.bank_account_id = None;
        Ok(Some(dto))
    }

    pub async fn transition_batch_state(
        &self,
        workspace_id: &str,
        batch_id: &str,
        next_state: IngestBatchState,
        error_message: Option<&str>,
    ) -> StorageResult<()> {
        let now = now_iso();
        self.db
            .query(
                "UPDATE type::thing('ingest_batch', $id) SET
                    state = $state,
                    error_message = $err,
                    updated_at = $now;",
            )
            .bind(("id", batch_id.to_string()))
            .bind(("state", next_state.as_str().to_string()))
            .bind(("err", error_message.map(|s| s.to_string())))
            .bind(("now", now))
            .await?
            .check()?;

        let payload = serde_json::json!({
            "state": next_state.as_str(),
            "error_message": error_message,
        })
        .to_string();
        self.append_audit_event(
            workspace_id,
            "ingest_batch",
            batch_id,
            "STATE_TRANSITION",
            "system",
            error_message,
            &payload,
        )
        .await?;
        Ok(())
    }

    pub async fn store_extracted_tables(
        &self,
        batch_id: &str,
        tables: &[ExtractedTableData],
    ) -> StorageResult<()> {
        let now = now_iso();
        for table in tables {
            let id_key = format!("ext_{}", random_hex(8));
            self.db
                .query(
                    "CREATE type::thing('extracted_table', $id) SET
                        id_key = $id,
                        batch_id = type::thing('ingest_batch', $bid),
                        table_index = $tidx,
                        raw_headers = $headers,
                        raw_rows = $rows,
                        created_at = $now;",
                )
                .bind(("id", id_key))
                .bind(("bid", batch_id.to_string()))
                .bind(("tidx", table.table_index as i64))
                .bind(("headers", table.raw_headers.clone()))
                .bind(("rows", table.raw_rows.clone()))
                .bind(("now", now.clone()))
                .await?
                .check()?;
        }
        Ok(())
    }

    pub async fn get_extracted_tables(
        &self,
        batch_id: &str,
    ) -> StorageResult<Vec<ExtractedTableData>> {
        let mut res = self
            .db
            .query("SELECT table_index, raw_headers, raw_rows FROM extracted_table WHERE batch_id = type::thing('ingest_batch', $bid) ORDER BY table_index ASC")
            .bind(("bid", batch_id.to_string()))
            .await?;
        let rows: Vec<ExtractedTableData> = res.take(0).unwrap_or_default();
        Ok(rows)
    }

    pub async fn lookup_statement_template(
        &self,
        workspace_id: &str,
        institution_slug: &str,
        statement_kind: StatementKind,
        header_fingerprint: &str,
    ) -> StorageResult<Option<StatementTemplateDto>> {
        let mut res = self
            .db
            .query(
                "SELECT id_key, workspace_id, institution_slug, statement_kind, header_fingerprint, column_mappings, created_at, updated_at
                 FROM statement_template
                 WHERE workspace_id = $ws AND institution_slug = $inst AND statement_kind = $sk AND header_fingerprint = $fp
                 LIMIT 1",
            )
            .bind(("ws", workspace_id.to_string()))
            .bind(("inst", institution_slug.to_string()))
            .bind(("sk", statement_kind.as_str().to_string()))
            .bind(("fp", header_fingerprint.to_string()))
            .await?;
        let mut rows: Vec<StatementTemplateDto> = res.take(0).unwrap_or_default();
        Ok(rows.pop())
    }

    pub async fn save_statement_template(
        &self,
        workspace_id: &str,
        institution_slug: &str,
        statement_kind: StatementKind,
        header_fingerprint: &str,
        column_mappings: &BTreeMap<String, ColumnRole>,
    ) -> StorageResult<StatementTemplateDto> {
        let now = now_iso();
        let id_key = format!("tmpl_{}", random_hex(8));
        self.db
            .query(
                "DELETE statement_template WHERE workspace_id = $ws AND institution_slug = $inst AND statement_kind = $sk AND header_fingerprint = $fp;
                 CREATE type::thing('statement_template', $id) SET
                    id_key = $id,
                    workspace_id = $ws,
                    institution_slug = $inst,
                    statement_kind = $sk,
                    header_fingerprint = $fp,
                    column_mappings = $maps,
                    created_at = $now,
                    updated_at = $now;",
            )
            .bind(("id", id_key.clone()))
            .bind(("ws", workspace_id.to_string()))
            .bind(("inst", institution_slug.to_string()))
            .bind(("sk", statement_kind.as_str().to_string()))
            .bind(("fp", header_fingerprint.to_string()))
            .bind(("maps", column_mappings.clone()))
            .bind(("now", now.clone()))
            .await?
            .check()?;

        Ok(StatementTemplateDto {
            id_key,
            workspace_id: workspace_id.to_string(),
            institution_slug: institution_slug.to_string(),
            statement_kind: statement_kind.as_str().to_string(),
            header_fingerprint: header_fingerprint.to_string(),
            column_mappings: column_mappings.clone(),
            created_at: now.clone(),
            updated_at: now,
        })
    }

    /// Resolves a counterparty ledger/party from narration, falling back to `ledger:<ws>_uncategorized`.
    pub async fn resolve_counterparty_or_uncategorized(
        &self,
        workspace_id: &str,
        narration: &str,
    ) -> StorageResult<String> {
        if let Some(hint) = resolve_counterparty_hint(narration) {
            #[derive(Deserialize)]
            struct MatchRow {
                ledger_id: String,
            }
            let mut res = self
                .db
                .query("SELECT ledger_id FROM party WHERE workspace_id = $ws AND string::lowercase(name) CONTAINS $hint LIMIT 1")
                .bind(("ws", workspace_id.to_string()))
                .bind(("hint", hint))
                .await?;
            if let Some(found) = res.take::<Vec<MatchRow>>(0).unwrap_or_default().into_iter().next() {
                return Ok(found.ledger_id);
            }
        }
        Ok(format!("{}_uncategorized", workspace_id))
    }

    /// Commits reconciled rows for a batch, enforcing cross-PDF deduplication
    /// while preserving identical intra-PDF transactions.
    pub async fn commit_ingest_batch(
        &self,
        workspace_id: &str,
        batch_id: &str,
        bank_ledger_id: &str,
        rows: &[ParsedIngestRow],
        patch: Option<&AuditPatchInput>,
        force_post: Option<&ForcePostInput>,
    ) -> StorageResult<(i64, i64)> {
        let mut audit_patch_id: Option<String> = None;
        let flagged_scrutiny = patch.is_some() || force_post.is_some();

        if let Some(p) = patch {
            let payload = serde_json::to_string(p)?;
            audit_patch_id = Some(
                self.append_audit_event(
                    workspace_id,
                    "ingest_batch",
                    batch_id,
                    "OCR_PATCH",
                    &p.actor,
                    Some(&p.rationale),
                    &payload,
                )
                .await?,
            );
        }

        if let Some(fp) = force_post {
            let payload = serde_json::to_string(fp)?;
            let fp_id = self
                .append_audit_event(
                    workspace_id,
                    "ingest_batch",
                    batch_id,
                    "FORCE_POST",
                    &fp.actor,
                    Some(&fp.rationale),
                    &payload,
                )
                .await?;
            if audit_patch_id.is_none() {
                audit_patch_id = Some(fp_id);
            }
            self.db
                .query("UPDATE type::thing('workspace', $ws) SET discrepancy_count += 1;")
                .bind(("ws", workspace_id.to_string()))
                .await?
                .check()?;

            if fp.discrepancy_minor != 0 {
                let suspense_id = format!("{}_unreconciled_suspense", workspace_id);
                let vid = format!("vch_susp_{}", random_hex(6));
                self.db
                    .query(
                        "LET $src_rec = type::thing('ledger', $src);
                         LET $dst_rec = type::thing('ledger', $dst);
                         RELATE $src_rec -> flow -> $dst_rec SET
                            workspace_id = $ws,
                            voucher_id = type::thing('voucher', $vid),
                            edge_type = 'SUSPENSE',
                            amount_minor = $amt,
                            currency = 'INR',
                            txn_date = $dt,
                            flagged_scrutiny = true;",
                    )
                    .bind(("src", bank_ledger_id.to_string()))
                    .bind(("dst", suspense_id))
                    .bind(("ws", workspace_id.to_string()))
                    .bind(("vid", vid))
                    .bind(("amt", fp.discrepancy_minor.abs()))
                    .bind(("dt", now_iso()))
                    .await?
                    .check()?;
            }
        }

        let mut committed = 0_i64;
        let mut skipped_duplicates = 0_i64;

        for row in rows {
            #[derive(Deserialize)]
            struct ExistsRow {
                #[allow(dead_code)]
                amount_minor: i64,
            }
            // Cross-PDF deduplication only (intra-PDF rows are never deduplicated against each other).
            let is_dup = if let Some(ref reference) = row.reference {
                let mut res = self
                    .db
                    .query("SELECT amount_minor FROM flow WHERE workspace_id = $ws AND reference = $ref AND (`in` = type::thing('ledger', $acct) OR `out` = type::thing('ledger', $acct)) LIMIT 1")
                    .bind(("ws", workspace_id.to_string()))
                    .bind(("ref", reference.clone()))
                    .bind(("acct", bank_ledger_id.to_string()))
                    .await?;
                !res.take::<Vec<ExistsRow>>(0)?.is_empty()
            } else {
                let amt = (row.debit_minor - row.credit_minor).abs();
                let mut res = self
                    .db
                    .query("SELECT amount_minor FROM flow WHERE workspace_id = $ws AND txn_date = $dt AND amount_minor = $amt AND narration_norm = $nar AND daily_rank = $rank AND (`in` = type::thing('ledger', $acct) OR `out` = type::thing('ledger', $acct)) LIMIT 1")
                    .bind(("ws", workspace_id.to_string()))
                    .bind(("dt", row.date.clone()))
                    .bind(("amt", amt))
                    .bind(("nar", row.narration_norm.clone()))
                    .bind(("rank", row.daily_rank))
                    .bind(("acct", bank_ledger_id.to_string()))
                    .await?;
                !res.take::<Vec<ExistsRow>>(0)?.is_empty()
            };

            if is_dup {
                skipped_duplicates += 1;
                continue;
            }

            let counterparty_id = self
                .resolve_counterparty_or_uncategorized(workspace_id, &row.description)
                .await?;
            let (src_id, dst_id, amt, edge_type) = if row.debit_minor > 0 {
                (bank_ledger_id.to_string(), counterparty_id, row.debit_minor, "PAYMENT")
            } else {
                (counterparty_id, bank_ledger_id.to_string(), row.credit_minor, "RECEIPT")
            };

            if amt <= 0 {
                continue;
            }

            let voucher_id = format!("vch_{}", random_hex(8));
            let now = now_iso();
            self.db
                .query(
                    "CREATE type::thing('voucher', $vid) SET
                        id_key = $vid,
                        workspace_id = $ws,
                        voucher_type = 'payment',
                        number = $num,
                        date = $dt,
                        status = 'regular',
                        currency = 'INR',
                        narration = $nar,
                        source = 'pdf_docling',
                        fy_key = '2026-27',
                        flagged_scrutiny = $scr,
                        audit_patch_id = IF $apid != NONE THEN type::thing('audit_event', $apid) ELSE NONE END,
                        created_at = $now,
                        updated_at = $now;
                     LET $src_rec = type::thing('ledger', $src);
                     LET $dst_rec = type::thing('ledger', $dst);
                     RELATE $src_rec -> flow -> $dst_rec SET
                        workspace_id = $ws,
                        voucher_id = type::thing('voucher', $vid),
                        edge_type = $et,
                        amount_minor = $amt,
                        currency = 'INR',
                        txn_date = $dt,
                        reference = $ref,
                        narration_norm = $nn,
                        daily_rank = $rank,
                        flagged_scrutiny = $scr,
                        audit_patch_id = IF $apid != NONE THEN type::thing('audit_event', $apid) ELSE NONE END;",
                )
                .bind(("vid", voucher_id.clone()))
                .bind(("ws", workspace_id.to_string()))
                .bind(("num", format!("PDF-{}", &voucher_id[4..10])))
                .bind(("dt", row.date.clone()))
                .bind(("nar", row.description.clone()))
                .bind(("scr", flagged_scrutiny))
                .bind(("apid", audit_patch_id.clone()))
                .bind(("now", now))
                .bind(("src", src_id))
                .bind(("dst", dst_id))
                .bind(("et", edge_type.to_string()))
                .bind(("amt", amt))
                .bind(("ref", row.reference.clone()))
                .bind(("nn", row.narration_norm.clone()))
                .bind(("rank", row.daily_rank))
                .await?
                .check()?;

            committed += 1;
        }

        self.db
            .query(
                "UPDATE type::thing('ingest_batch', $id) SET
                    state = 'COMMITTED',
                    total_rows = $tot,
                    reconciled_rows = $rec,
                    skipped_duplicate_count = $skip,
                    updated_at = $now;",
            )
            .bind(("id", batch_id.to_string()))
            .bind(("tot", rows.len() as i64))
            .bind(("rec", committed))
            .bind(("skip", skipped_duplicates))
            .bind(("now", now_iso()))
            .await?
            .check()?;

        Ok((committed, skipped_duplicates))
    }

    pub async fn get_graph_trial_balance(
        &self,
        workspace_id: &str,
    ) -> StorageResult<Vec<GraphTrialBalanceRow>> {
        #[derive(Deserialize)]
        struct RawRow {
            id_key: String,
            name: String,
            normal_side: String,
            total_debits_minor: Option<i64>,
            total_credits_minor: Option<i64>,
        }
        let mut res = self
            .db
            .query(
                "SELECT id_key, name, normal_side,
                    math::sum(<-flow[WHERE workspace_id = $ws].amount_minor) AS total_debits_minor,
                    math::sum(->flow[WHERE workspace_id = $ws].amount_minor) AS total_credits_minor
                 FROM ledger
                 WHERE workspace_id = $ws;",
            )
            .bind(("ws", workspace_id.to_string()))
            .await?;
        let rows: Vec<RawRow> = res.take(0).unwrap_or_default();
        Ok(rows
            .into_iter()
            .map(|r| {
                let debits = r.total_debits_minor.unwrap_or(0);
                let credits = r.total_credits_minor.unwrap_or(0);
                let net = if r.normal_side == "credit" {
                    credits - debits
                } else {
                    debits - credits
                };
                GraphTrialBalanceRow {
                    ledger_id: r.id_key,
                    name: r.name,
                    normal_side: r.normal_side,
                    total_debits_minor: debits,
                    total_credits_minor: credits,
                    net_balance_minor: net,
                }
            })
            .collect())
    }

    /// Computes chronological running balances in Rust via `.scan()` (since SurrealQL lacks window functions).
    pub async fn get_ledger_statement_with_running_balance(
        &self,
        workspace_id: &str,
        ledger_id: &str,
        opening_balance_minor: i64,
    ) -> StorageResult<Vec<FlowStatementRow>> {
        #[derive(Deserialize)]
        struct RawFlow {
            txn_date: String,
            edge_type: String,
            amount_minor: i64,
            reference: Option<String>,
            narration_norm: Option<String>,
            flagged_scrutiny: bool,
            is_inflow: bool,
        }
        let mut res = self
            .db
            .query(
                "SELECT txn_date, edge_type, amount_minor, reference, narration_norm, flagged_scrutiny,
                    (`out` = type::thing('ledger', $lid)) AS is_inflow
                 FROM flow
                 WHERE workspace_id = $ws AND (`in` = type::thing('ledger', $lid) OR `out` = type::thing('ledger', $lid))
                 ORDER BY txn_date ASC;",
            )
            .bind(("ws", workspace_id.to_string()))
            .bind(("lid", ledger_id.to_string()))
            .await?;
        let raw: Vec<RawFlow> = res.take(0).unwrap_or_default();
        let rows = raw
            .into_iter()
            .scan(opening_balance_minor, |bal, f| {
                if f.is_inflow {
                    *bal += f.amount_minor;
                } else {
                    *bal -= f.amount_minor;
                }
                Some(FlowStatementRow {
                    voucher_id: String::new(),
                    txn_date: f.txn_date,
                    edge_type: f.edge_type,
                    amount_minor: f.amount_minor,
                    reference: f.reference,
                    narration: f.narration_norm,
                    running_balance_minor: *bal,
                    flagged_scrutiny: f.flagged_scrutiny,
                })
            })
            .collect();
        Ok(rows)
    }
}

#[derive(Deserialize)]
struct LedgerRow {
    id_key: String,
    workspace_id: String,
    name: String,
    tally_parent: String,
    nature: String,
    opening_balance_minor: i64,
    is_party: bool,
    is_bank: bool,
    is_tax: bool,
    billwise: bool,
    archived: bool,
    created_at: String,
    updated_at: String,
}

impl LedgerRow {
    fn into_ledger(self) -> Option<Ledger> {
        Some(Ledger {
            id: self.id_key,
            workspace_id: self.workspace_id,
            name: self.name,
            tally_parent: TallyPrimaryGroup::parse(&self.tally_parent)?,
            nature: LedgerNature::parse(&self.nature)?,
            opening_balance_minor: self.opening_balance_minor,
            is_party: self.is_party,
            is_bank: self.is_bank,
            is_tax: self.is_tax,
            billwise: self.billwise,
            archived: self.archived,
            created_at: self.created_at,
            updated_at: self.updated_at,
        })
    }
}

#[derive(Deserialize)]
struct VoucherRow {
    id_key: String,
    workspace_id: String,
    voucher_type: String,
    number: String,
    date: String,
    status: String,
    currency: String,
    party_ledger_id: Option<String>,
    invoice_number: Option<String>,
    narration: Option<String>,
    round_off_amount_minor: i64,
    round_off_ledger_id: Option<String>,
    source: String,
    created_at: String,
    updated_at: String,
}

impl VoucherRow {
    fn into_voucher(self) -> Option<Voucher> {
        Some(Voucher {
            id: self.id_key,
            workspace_id: self.workspace_id,
            voucher_type: VoucherType::parse(&self.voucher_type)?,
            number: self.number,
            date: self.date,
            status: VoucherStatus::parse(&self.status)?,
            currency: self.currency,
            party_ledger_id: self.party_ledger_id,
            invoice_number: self.invoice_number,
            narration: self.narration,
            round_off_amount_minor: self.round_off_amount_minor,
            round_off_ledger_id: self.round_off_ledger_id,
            source: VoucherSource::parse(&self.source)?,
            created_at: self.created_at,
            updated_at: self.updated_at,
        })
    }
}

#[derive(Deserialize)]
struct VoucherLineRow {
    id_key: String,
    voucher_id: String,
    workspace_id: String,
    line_no: u32,
    ledger_id: String,
    amount_minor: i64,
    currency: String,
    narration: Option<String>,
}

impl VoucherLineRow {
    fn into_line(self) -> VoucherLine {
        VoucherLine {
            id: self.id_key,
            voucher_id: self.voucher_id,
            workspace_id: self.workspace_id,
            line_no: self.line_no,
            ledger_id: self.ledger_id,
            amount_minor: self.amount_minor,
            currency: self.currency,
            narration: self.narration,
        }
    }
}
