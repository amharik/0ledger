//! UniFFI bindings for the portable 0ledger engine.
//!
//! This is the single native surface consumed by Kotlin/Compose, SwiftUI, and
//! any future shell. It contains no UI logic: it opens the SQLite store, posts
//! validated vouchers, computes reports, and exchanges sealed sync envelopes.

uniffi::setup_scaffolding!();

use std::sync::Arc;
use zeroledger_engine::{
    CompanyProfile, CompanySettings, Ledger, LedgerNature, NewVoucher, Party, PartyType,
    RoundingMode, TallyPrimaryGroup, Voucher, VoucherLine, VoucherSource, VoucherStatus,
    VoucherType, Workspace,
};
use zeroledger_storage::Store;
use zeroledger_sync::{ChangeSet, SyncKey};

#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum FfiError {
    #[error("{message}")]
    Failure { message: String },
}

fn fail(message: impl std::fmt::Display) -> FfiError {
    FfiError::Failure {
        message: message.to_string(),
    }
}

// ---- records ---------------------------------------------------------------

#[derive(Debug, Clone, uniffi::Record)]
pub struct FfiCompanySettings {
    pub fy_start_month: u32,
    pub round_to_minor: i64,
    pub rounding_mode: String,
    pub decimal_places: u32,
    pub default_currency: String,
}

#[derive(Debug, Clone, uniffi::Record)]
pub struct FfiCompany {
    pub id: String,
    pub workspace_id: String,
    pub legal_name: String,
    pub trade_name: Option<String>,
    pub gstin: Option<String>,
    pub pan: Option<String>,
    pub state: Option<String>,
    pub currency: String,
    pub books_begin: String,
    pub settings: FfiCompanySettings,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, uniffi::Record)]
pub struct FfiWorkspace {
    pub id: String,
    pub slug: String,
    pub name: String,
    pub readable_name: String,
    pub company_id: String,
    pub archived: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, uniffi::Record)]
pub struct FfiLedger {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    pub tally_parent: String,
    pub nature: String,
    pub opening_balance_minor: i64,
    pub is_party: bool,
    pub is_bank: bool,
    pub is_tax: bool,
    pub billwise: bool,
    pub archived: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, uniffi::Record)]
pub struct FfiParty {
    pub id: String,
    pub workspace_id: String,
    pub ledger_id: String,
    pub name: String,
    pub gstin: Option<String>,
    pub party_type: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, uniffi::Record)]
pub struct FfiVoucher {
    pub id: String,
    pub workspace_id: String,
    pub voucher_type: String,
    pub number: String,
    pub date: String,
    pub status: String,
    pub currency: String,
    pub party_ledger_id: Option<String>,
    pub invoice_number: Option<String>,
    pub narration: Option<String>,
    pub round_off_amount_minor: i64,
    pub round_off_ledger_id: Option<String>,
    pub source: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, uniffi::Record)]
pub struct FfiVoucherLine {
    pub id: String,
    pub voucher_id: String,
    pub workspace_id: String,
    pub line_no: u32,
    pub ledger_id: String,
    pub amount_minor: i64,
    pub currency: String,
    pub narration: Option<String>,
}

#[derive(Debug, Clone, uniffi::Record)]
pub struct FfiVoucherBundle {
    pub voucher: FfiVoucher,
    pub lines: Vec<FfiVoucherLine>,
}

#[derive(Debug, Clone, uniffi::Record)]
pub struct FfiValidationIssue {
    pub code: String,
    pub severity: String,
    pub message: String,
    pub entity_type: Option<String>,
    pub entity_id: Option<String>,
    pub hint: Option<String>,
}

#[derive(Debug, Clone, uniffi::Record)]
pub struct FfiValidationResult {
    pub ok: bool,
    pub issues: Vec<FfiValidationIssue>,
}

#[derive(Debug, Clone, uniffi::Record)]
pub struct FfiTrialBalanceRow {
    pub ledger_id: String,
    pub name: String,
    pub tally_parent: String,
    pub nature: String,
    pub opening_minor: i64,
    pub debit_minor: i64,
    pub credit_minor: i64,
    pub closing_minor: i64,
}

#[derive(Debug, Clone, uniffi::Record)]
pub struct FfiTrialBalance {
    pub rows: Vec<FfiTrialBalanceRow>,
    pub total_opening_minor: i64,
    pub total_debit_minor: i64,
    pub total_credit_minor: i64,
    pub balanced: bool,
}

#[derive(Debug, Clone, uniffi::Record)]
pub struct FfiPnlRow {
    pub ledger_id: String,
    pub name: String,
    pub nature: String,
    pub amount_minor: i64,
}

#[derive(Debug, Clone, uniffi::Record)]
pub struct FfiPnl {
    pub income: Vec<FfiPnlRow>,
    pub expenses: Vec<FfiPnlRow>,
    pub total_income_minor: i64,
    pub total_expense_minor: i64,
    pub net_profit_minor: i64,
}

#[derive(Debug, Clone, uniffi::Record)]
pub struct FfiIntegrityIssue {
    pub code: String,
    pub message: String,
    pub entity_id: Option<String>,
}

#[derive(Debug, Clone, uniffi::Record)]
pub struct FfiIntegrityReport {
    pub ok: bool,
    pub checked_vouchers: u32,
    pub checked_audit_events: u32,
    pub issues: Vec<FfiIntegrityIssue>,
}

#[derive(Debug, Clone, uniffi::Record)]
pub struct FfiApplySummary {
    pub applied: u32,
    pub ignored: u32,
    pub skipped: u32,
}

#[derive(Debug, Clone, uniffi::Record)]
pub struct FfiImportSummary {
    pub workspaces: u32,
    pub companies: u32,
    pub ledgers: u32,
    pub parties: u32,
    pub vouchers: u32,
}

// ---- conversions -----------------------------------------------------------

fn to_company_settings(settings: &FfiCompanySettings) -> CompanySettings {
    CompanySettings {
        fy_start_month: settings.fy_start_month,
        round_to_minor: settings.round_to_minor,
        rounding_mode: RoundingMode::parse(&settings.rounding_mode),
        decimal_places: settings.decimal_places,
        default_currency: settings.default_currency.clone(),
    }
}

fn from_company_settings(settings: &CompanySettings) -> FfiCompanySettings {
    FfiCompanySettings {
        fy_start_month: settings.fy_start_month,
        round_to_minor: settings.round_to_minor,
        rounding_mode: settings.rounding_mode.as_str().to_string(),
        decimal_places: settings.decimal_places,
        default_currency: settings.default_currency.clone(),
    }
}

fn to_company(company: &FfiCompany) -> CompanyProfile {
    CompanyProfile {
        id: company.id.clone(),
        workspace_id: company.workspace_id.clone(),
        legal_name: company.legal_name.clone(),
        trade_name: company.trade_name.clone(),
        gstin: company.gstin.clone(),
        pan: company.pan.clone(),
        state: company.state.clone(),
        currency: company.currency.clone(),
        books_begin: company.books_begin.clone(),
        settings: to_company_settings(&company.settings),
        created_at: company.created_at.clone(),
        updated_at: company.updated_at.clone(),
    }
}

fn from_company(company: &CompanyProfile) -> FfiCompany {
    FfiCompany {
        id: company.id.clone(),
        workspace_id: company.workspace_id.clone(),
        legal_name: company.legal_name.clone(),
        trade_name: company.trade_name.clone(),
        gstin: company.gstin.clone(),
        pan: company.pan.clone(),
        state: company.state.clone(),
        currency: company.currency.clone(),
        books_begin: company.books_begin.clone(),
        settings: from_company_settings(&company.settings),
        created_at: company.created_at.clone(),
        updated_at: company.updated_at.clone(),
    }
}

fn to_workspace(workspace: &FfiWorkspace) -> Workspace {
    Workspace {
        id: workspace.id.clone(),
        slug: workspace.slug.clone(),
        name: workspace.name.clone(),
        readable_name: workspace.readable_name.clone(),
        company_id: workspace.company_id.clone(),
        archived: workspace.archived,
        created_at: workspace.created_at.clone(),
        updated_at: workspace.updated_at.clone(),
    }
}

fn from_workspace(workspace: &Workspace) -> FfiWorkspace {
    FfiWorkspace {
        id: workspace.id.clone(),
        slug: workspace.slug.clone(),
        name: workspace.name.clone(),
        readable_name: workspace.readable_name.clone(),
        company_id: workspace.company_id.clone(),
        archived: workspace.archived,
        created_at: workspace.created_at.clone(),
        updated_at: workspace.updated_at.clone(),
    }
}

fn to_ledger(ledger: &FfiLedger) -> Result<Ledger, FfiError> {
    let tally_parent = TallyPrimaryGroup::parse(&ledger.tally_parent)
        .ok_or_else(|| fail(format!("unknown tally parent: {}", ledger.tally_parent)))?;
    let nature = LedgerNature::parse(&ledger.nature)
        .ok_or_else(|| fail(format!("unknown ledger nature: {}", ledger.nature)))?;
    Ok(Ledger {
        id: ledger.id.clone(),
        workspace_id: ledger.workspace_id.clone(),
        name: ledger.name.clone(),
        tally_parent,
        nature,
        opening_balance_minor: ledger.opening_balance_minor,
        is_party: ledger.is_party,
        is_bank: ledger.is_bank,
        is_tax: ledger.is_tax,
        billwise: ledger.billwise,
        archived: ledger.archived,
        created_at: ledger.created_at.clone(),
        updated_at: ledger.updated_at.clone(),
    })
}

fn from_ledger(ledger: &Ledger) -> FfiLedger {
    FfiLedger {
        id: ledger.id.clone(),
        workspace_id: ledger.workspace_id.clone(),
        name: ledger.name.clone(),
        tally_parent: ledger.tally_parent.as_str().to_string(),
        nature: ledger.nature.as_str().to_string(),
        opening_balance_minor: ledger.opening_balance_minor,
        is_party: ledger.is_party,
        is_bank: ledger.is_bank,
        is_tax: ledger.is_tax,
        billwise: ledger.billwise,
        archived: ledger.archived,
        created_at: ledger.created_at.clone(),
        updated_at: ledger.updated_at.clone(),
    }
}

fn to_party(party: &FfiParty) -> Result<Party, FfiError> {
    let party_type = PartyType::parse(&party.party_type)
        .ok_or_else(|| fail(format!("unknown party type: {}", party.party_type)))?;
    Ok(Party {
        id: party.id.clone(),
        workspace_id: party.workspace_id.clone(),
        ledger_id: party.ledger_id.clone(),
        name: party.name.clone(),
        gstin: party.gstin.clone(),
        party_type,
        created_at: party.created_at.clone(),
        updated_at: party.updated_at.clone(),
    })
}

fn from_party(party: &Party) -> FfiParty {
    FfiParty {
        id: party.id.clone(),
        workspace_id: party.workspace_id.clone(),
        ledger_id: party.ledger_id.clone(),
        name: party.name.clone(),
        gstin: party.gstin.clone(),
        party_type: party.party_type.as_str().to_string(),
        created_at: party.created_at.clone(),
        updated_at: party.updated_at.clone(),
    }
}

fn to_voucher(voucher: &FfiVoucher) -> Result<Voucher, FfiError> {
    let voucher_type = VoucherType::parse(&voucher.voucher_type)
        .ok_or_else(|| fail(format!("unknown voucher type: {}", voucher.voucher_type)))?;
    let status = VoucherStatus::parse(&voucher.status)
        .ok_or_else(|| fail(format!("unknown voucher status: {}", voucher.status)))?;
    let source = VoucherSource::parse(&voucher.source)
        .ok_or_else(|| fail(format!("unknown voucher source: {}", voucher.source)))?;
    Ok(Voucher {
        id: voucher.id.clone(),
        workspace_id: voucher.workspace_id.clone(),
        voucher_type,
        number: voucher.number.clone(),
        date: voucher.date.clone(),
        status,
        currency: voucher.currency.clone(),
        party_ledger_id: voucher.party_ledger_id.clone(),
        invoice_number: voucher.invoice_number.clone(),
        narration: voucher.narration.clone(),
        round_off_amount_minor: voucher.round_off_amount_minor,
        round_off_ledger_id: voucher.round_off_ledger_id.clone(),
        source,
        created_at: voucher.created_at.clone(),
        updated_at: voucher.updated_at.clone(),
    })
}

fn from_voucher(voucher: &Voucher) -> FfiVoucher {
    FfiVoucher {
        id: voucher.id.clone(),
        workspace_id: voucher.workspace_id.clone(),
        voucher_type: voucher.voucher_type.as_str().to_string(),
        number: voucher.number.clone(),
        date: voucher.date.clone(),
        status: voucher.status.as_str().to_string(),
        currency: voucher.currency.clone(),
        party_ledger_id: voucher.party_ledger_id.clone(),
        invoice_number: voucher.invoice_number.clone(),
        narration: voucher.narration.clone(),
        round_off_amount_minor: voucher.round_off_amount_minor,
        round_off_ledger_id: voucher.round_off_ledger_id.clone(),
        source: voucher.source.as_str().to_string(),
        created_at: voucher.created_at.clone(),
        updated_at: voucher.updated_at.clone(),
    }
}

fn to_line(line: &FfiVoucherLine) -> VoucherLine {
    VoucherLine {
        id: line.id.clone(),
        voucher_id: line.voucher_id.clone(),
        workspace_id: line.workspace_id.clone(),
        line_no: line.line_no,
        ledger_id: line.ledger_id.clone(),
        amount_minor: line.amount_minor,
        currency: line.currency.clone(),
        narration: line.narration.clone(),
    }
}

fn from_line(line: &VoucherLine) -> FfiVoucherLine {
    FfiVoucherLine {
        id: line.id.clone(),
        voucher_id: line.voucher_id.clone(),
        workspace_id: line.workspace_id.clone(),
        line_no: line.line_no,
        ledger_id: line.ledger_id.clone(),
        amount_minor: line.amount_minor,
        currency: line.currency.clone(),
        narration: line.narration.clone(),
    }
}

fn from_validation(result: &zeroledger_engine::ValidationResult) -> FfiValidationResult {
    FfiValidationResult {
        ok: result.ok,
        issues: result
            .issues
            .iter()
            .map(|issue| FfiValidationIssue {
                code: issue.code.clone(),
                severity: match issue.severity {
                    zeroledger_engine::IssueSeverity::Error => "error".to_string(),
                    zeroledger_engine::IssueSeverity::Warning => "warning".to_string(),
                },
                message: issue.message.clone(),
                entity_type: issue.entity_type.clone(),
                entity_id: issue.entity_id.clone(),
                hint: issue.hint.clone(),
            })
            .collect(),
    }
}

fn from_trial_balance(tb: &zeroledger_engine::TrialBalance) -> FfiTrialBalance {
    FfiTrialBalance {
        rows: tb
            .rows
            .iter()
            .map(|row| FfiTrialBalanceRow {
                ledger_id: row.ledger_id.clone(),
                name: row.name.clone(),
                tally_parent: row.tally_parent.clone(),
                nature: row.nature.as_str().to_string(),
                opening_minor: row.opening_minor,
                debit_minor: row.debit_minor,
                credit_minor: row.credit_minor,
                closing_minor: row.closing_minor,
            })
            .collect(),
        total_opening_minor: tb.total_opening_minor,
        total_debit_minor: tb.total_debit_minor,
        total_credit_minor: tb.total_credit_minor,
        balanced: tb.balanced,
    }
}

fn from_pnl(pnl: &zeroledger_engine::ProfitAndLoss) -> FfiPnl {
    let map_row = |row: &zeroledger_engine::ProfitAndLossRow| FfiPnlRow {
        ledger_id: row.ledger_id.clone(),
        name: row.name.clone(),
        nature: row.nature.clone(),
        amount_minor: row.amount_minor,
    };
    FfiPnl {
        income: pnl.income.iter().map(map_row).collect(),
        expenses: pnl.expenses.iter().map(map_row).collect(),
        total_income_minor: pnl.total_income_minor,
        total_expense_minor: pnl.total_expense_minor,
        net_profit_minor: pnl.net_profit_minor,
    }
}

// ---- free functions --------------------------------------------------------

#[uniffi::export]
pub fn engine_version() -> String {
    zeroledger_engine::ENGINE_VERSION.to_string()
}

#[uniffi::export]
pub fn parse_amount(
    input: String,
    minor_unit: u32,
    rounding_mode: String,
) -> Result<i64, FfiError> {
    zeroledger_engine::parse_amount_to_minor(
        &input,
        minor_unit,
        RoundingMode::parse(&rounding_mode),
    )
    .map_err(fail)
}

#[uniffi::export]
pub fn round_to_step(value: i64, step: i64, rounding_mode: String) -> Result<i64, FfiError> {
    zeroledger_engine::round_to_step(value, step, RoundingMode::parse(&rounding_mode)).map_err(fail)
}

#[uniffi::export]
pub fn validate_voucher(
    voucher: FfiVoucher,
    lines: Vec<FfiVoucherLine>,
) -> Result<FfiValidationResult, FfiError> {
    let voucher = to_voucher(&voucher)?;
    let lines: Vec<VoucherLine> = lines.iter().map(to_line).collect();
    let result = zeroledger_engine::validate_new_voucher(&NewVoucher { voucher, lines });
    Ok(from_validation(&result))
}

#[uniffi::export]
pub fn generate_sync_key() -> Result<String, FfiError> {
    Ok(SyncKey::generate().map_err(fail)?.to_base64())
}

#[uniffi::export]
pub fn seal_changes(
    key: String,
    device_id: String,
    changes_json: String,
    created_at: String,
) -> Result<String, FfiError> {
    let key = SyncKey::from_base64(&key).map_err(fail)?;
    let changes: ChangeSet = serde_json::from_str(&changes_json).map_err(fail)?;
    let envelope = zeroledger_sync::seal(&key, device_id, created_at, &changes).map_err(fail)?;
    envelope.to_json().map_err(fail)
}

#[uniffi::export]
pub fn open_envelope(key: String, envelope_json: String) -> Result<String, FfiError> {
    let key = SyncKey::from_base64(&key).map_err(fail)?;
    let envelope = zeroledger_sync::SealedEnvelope::from_json(&envelope_json).map_err(fail)?;
    let changes = zeroledger_sync::open(&key, &envelope).map_err(fail)?;
    serde_json::to_string(&changes).map_err(fail)
}

// ---- store object ----------------------------------------------------------

#[derive(uniffi::Object)]
pub struct FfiStore {
    inner: Store,
    rt: tokio::runtime::Runtime,
}

#[uniffi::export]
impl FfiStore {
    #[uniffi::constructor]
    pub fn open(path: String) -> Result<Arc<Self>, FfiError> {
        let rt = tokio::runtime::Runtime::new().map_err(fail)?;
        let store = rt.block_on(Store::open(path)).map_err(fail)?;
        Ok(Arc::new(Self { inner: store, rt }))
    }

    #[uniffi::constructor]
    pub fn open_in_memory() -> Result<Arc<Self>, FfiError> {
        let rt = tokio::runtime::Runtime::new().map_err(fail)?;
        let store = rt.block_on(Store::open_in_memory()).map_err(fail)?;
        Ok(Arc::new(Self { inner: store, rt }))
    }

    pub fn device_id(&self) -> Result<String, FfiError> {
        Ok(self.inner.device_id().to_string())
    }

    pub fn schema_version(&self) -> Result<u32, FfiError> {
        self.rt.block_on(self.inner.schema_version()).map_err(fail)
    }

    pub fn create_workspace(
        &self,
        workspace: FfiWorkspace,
        company: FfiCompany,
    ) -> Result<(), FfiError> {
        self.rt
            .block_on(
                self.inner
                    .create_workspace(&to_workspace(&workspace), &to_company(&company)),
            )
            .map_err(fail)
    }

    pub fn list_workspaces(&self) -> Result<Vec<FfiWorkspace>, FfiError> {
        let workspaces = self
            .rt
            .block_on(self.inner.list_workspaces())
            .map_err(fail)?;
        Ok(workspaces.iter().map(from_workspace).collect())
    }

    pub fn get_company(&self, workspace_id: String) -> Result<Option<FfiCompany>, FfiError> {
        Ok(self
            .rt
            .block_on(self.inner.get_company(&workspace_id))
            .map_err(fail)?
            .map(|company| from_company(&company)))
    }

    pub fn upsert_ledger(&self, ledger: FfiLedger) -> Result<(), FfiError> {
        let ledger = to_ledger(&ledger)?;
        self.rt
            .block_on(self.inner.upsert_ledger(&ledger))
            .map_err(fail)
    }

    pub fn list_ledgers(&self, workspace_id: String) -> Result<Vec<FfiLedger>, FfiError> {
        let ledgers = self
            .rt
            .block_on(self.inner.list_ledgers(&workspace_id))
            .map_err(fail)?;
        Ok(ledgers.iter().map(from_ledger).collect())
    }

    pub fn upsert_party(&self, party: FfiParty) -> Result<(), FfiError> {
        let party = to_party(&party)?;
        self.rt
            .block_on(self.inner.upsert_party(&party))
            .map_err(fail)
    }

    pub fn list_parties(&self, workspace_id: String) -> Result<Vec<FfiParty>, FfiError> {
        let parties = self
            .rt
            .block_on(self.inner.list_parties(&workspace_id))
            .map_err(fail)?;
        Ok(parties.iter().map(from_party).collect())
    }

    pub fn post_voucher(
        &self,
        voucher: FfiVoucher,
        lines: Vec<FfiVoucherLine>,
    ) -> Result<(), FfiError> {
        let input = NewVoucher {
            voucher: to_voucher(&voucher)?,
            lines: lines.iter().map(to_line).collect(),
        };
        self.rt
            .block_on(self.inner.post_voucher(&input))
            .map_err(fail)
    }

    pub fn list_vouchers(&self, workspace_id: String) -> Result<Vec<FfiVoucher>, FfiError> {
        let vouchers = self
            .rt
            .block_on(self.inner.list_vouchers(&workspace_id))
            .map_err(fail)?;
        Ok(vouchers.iter().map(from_voucher).collect())
    }

    pub fn get_voucher(&self, voucher_id: String) -> Result<Option<FfiVoucherBundle>, FfiError> {
        let found = self
            .rt
            .block_on(self.inner.get_voucher(&voucher_id))
            .map_err(fail)?;
        Ok(found.map(|(voucher, lines)| FfiVoucherBundle {
            voucher: from_voucher(&voucher),
            lines: lines.iter().map(from_line).collect(),
        }))
    }

    pub fn trial_balance(&self, workspace_id: String) -> Result<FfiTrialBalance, FfiError> {
        let tb = self
            .rt
            .block_on(self.inner.trial_balance(&workspace_id))
            .map_err(fail)?;
        Ok(from_trial_balance(&tb))
    }

    pub fn profit_and_loss(&self, workspace_id: String) -> Result<FfiPnl, FfiError> {
        let pnl = self
            .rt
            .block_on(self.inner.profit_and_loss(&workspace_id))
            .map_err(fail)?;
        Ok(from_pnl(&pnl))
    }

    pub fn integrity_check(&self, workspace_id: String) -> Result<FfiIntegrityReport, FfiError> {
        let report = self
            .rt
            .block_on(self.inner.integrity_check(&workspace_id))
            .map_err(fail)?;
        Ok(FfiIntegrityReport {
            ok: report.ok,
            checked_vouchers: report.checked_vouchers,
            checked_audit_events: report.checked_audit_events,
            issues: report
                .issues
                .iter()
                .map(|issue| FfiIntegrityIssue {
                    code: issue.code.clone(),
                    message: issue.message.clone(),
                    entity_id: issue.entity_id.clone(),
                })
                .collect(),
        })
    }

    pub fn import_bundle(&self, bundle_json: String) -> Result<FfiImportSummary, FfiError> {
        let bundle: zeroledger_storage::ImportBundle =
            serde_json::from_str(&bundle_json).map_err(fail)?;
        let summary = self
            .rt
            .block_on(self.inner.import_bundle(&bundle))
            .map_err(fail)?;
        Ok(FfiImportSummary {
            workspaces: summary.workspaces,
            companies: summary.companies,
            ledgers: summary.ledgers,
            parties: summary.parties,
            vouchers: summary.vouchers,
        })
    }

    pub fn backup_to(&self, path: String) -> Result<(), FfiError> {
        self.rt
            .block_on(self.inner.backup_to(path))
            .map_err(fail)
    }

    pub fn export_sync_envelope(
        &self,
        key: String,
        since_lamport: u64,
    ) -> Result<String, FfiError> {
        let key = SyncKey::from_base64(&key).map_err(fail)?;
        self.rt
            .block_on(self.inner.export_sync_envelope(&key, since_lamport))
            .map_err(fail)
    }

    pub fn import_sync_envelope(
        &self,
        key: String,
        envelope_json: String,
    ) -> Result<FfiApplySummary, FfiError> {
        let key = SyncKey::from_base64(&key).map_err(fail)?;
        let summary = self
            .rt
            .block_on(self.inner.import_sync_envelope(&key, &envelope_json))
            .map_err(fail)?;
        Ok(FfiApplySummary {
            applied: summary.applied,
            ignored: summary.ignored,
            skipped: summary.skipped,
        })
    }
}
