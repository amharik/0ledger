use crate::money::{Minor, RoundingMode};
use serde::{Deserialize, Serialize};

pub const TALLY_PRIMARY_GROUPS: &[&str] = &[
    "Capital Account",
    "Loans (Liability)",
    "Current Liabilities",
    "Fixed Assets",
    "Current Assets",
    "Investments",
    "Sundry Debtors",
    "Sundry Creditors",
    "Sales Accounts",
    "Purchase Accounts",
    "Direct Income",
    "Indirect Income",
    "Direct Expenses",
    "Indirect Expenses",
    "Bank Accounts",
    "Cash-in-Hand",
    "Duties & Taxes",
    "Suspense Account",
    "Branch/Divisions",
    "Miscellaneous Expenses (Asset)",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LedgerNature {
    Asset,
    Liability,
    Equity,
    Income,
    Expense,
}

impl LedgerNature {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "asset" => Some(Self::Asset),
            "liability" => Some(Self::Liability),
            "equity" => Some(Self::Equity),
            "income" => Some(Self::Income),
            "expense" => Some(Self::Expense),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Asset => "asset",
            Self::Liability => "liability",
            Self::Equity => "equity",
            Self::Income => "income",
            Self::Expense => "expense",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum TallyPrimaryGroup {
    #[serde(rename = "Capital Account")]
    CapitalAccount,
    #[serde(rename = "Loans (Liability)")]
    LoansLiability,
    #[serde(rename = "Current Liabilities")]
    CurrentLiabilities,
    #[serde(rename = "Fixed Assets")]
    FixedAssets,
    #[serde(rename = "Current Assets")]
    CurrentAssets,
    #[serde(rename = "Investments")]
    Investments,
    #[serde(rename = "Sundry Debtors")]
    SundryDebtors,
    #[serde(rename = "Sundry Creditors")]
    SundryCreditors,
    #[serde(rename = "Sales Accounts")]
    SalesAccounts,
    #[serde(rename = "Purchase Accounts")]
    PurchaseAccounts,
    #[serde(rename = "Direct Income")]
    DirectIncome,
    #[serde(rename = "Indirect Income")]
    IndirectIncome,
    #[serde(rename = "Direct Expenses")]
    DirectExpenses,
    #[serde(rename = "Indirect Expenses")]
    IndirectExpenses,
    #[serde(rename = "Bank Accounts")]
    BankAccounts,
    #[serde(rename = "Cash-in-Hand")]
    CashInHand,
    #[serde(rename = "Duties & Taxes")]
    DutiesAndTaxes,
    #[serde(rename = "Suspense Account")]
    SuspenseAccount,
    #[serde(rename = "Branch/Divisions")]
    BranchDivisions,
    #[serde(rename = "Miscellaneous Expenses (Asset)")]
    MiscellaneousExpensesAsset,
}

impl TallyPrimaryGroup {
    pub fn parse(value: &str) -> Option<Self> {
        let group = match value {
            "Capital Account" => Self::CapitalAccount,
            "Loans (Liability)" => Self::LoansLiability,
            "Current Liabilities" => Self::CurrentLiabilities,
            "Fixed Assets" => Self::FixedAssets,
            "Current Assets" => Self::CurrentAssets,
            "Investments" => Self::Investments,
            "Sundry Debtors" => Self::SundryDebtors,
            "Sundry Creditors" => Self::SundryCreditors,
            "Sales Accounts" => Self::SalesAccounts,
            "Purchase Accounts" => Self::PurchaseAccounts,
            "Direct Income" => Self::DirectIncome,
            "Indirect Income" => Self::IndirectIncome,
            "Direct Expenses" => Self::DirectExpenses,
            "Indirect Expenses" => Self::IndirectExpenses,
            "Bank Accounts" => Self::BankAccounts,
            "Cash-in-Hand" => Self::CashInHand,
            "Duties & Taxes" => Self::DutiesAndTaxes,
            "Suspense Account" => Self::SuspenseAccount,
            "Branch/Divisions" => Self::BranchDivisions,
            "Miscellaneous Expenses (Asset)" => Self::MiscellaneousExpensesAsset,
            _ => return None,
        };
        Some(group)
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::CapitalAccount => "Capital Account",
            Self::LoansLiability => "Loans (Liability)",
            Self::CurrentLiabilities => "Current Liabilities",
            Self::FixedAssets => "Fixed Assets",
            Self::CurrentAssets => "Current Assets",
            Self::Investments => "Investments",
            Self::SundryDebtors => "Sundry Debtors",
            Self::SundryCreditors => "Sundry Creditors",
            Self::SalesAccounts => "Sales Accounts",
            Self::PurchaseAccounts => "Purchase Accounts",
            Self::DirectIncome => "Direct Income",
            Self::IndirectIncome => "Indirect Income",
            Self::DirectExpenses => "Direct Expenses",
            Self::IndirectExpenses => "Indirect Expenses",
            Self::BankAccounts => "Bank Accounts",
            Self::CashInHand => "Cash-in-Hand",
            Self::DutiesAndTaxes => "Duties & Taxes",
            Self::SuspenseAccount => "Suspense Account",
            Self::BranchDivisions => "Branch/Divisions",
            Self::MiscellaneousExpensesAsset => "Miscellaneous Expenses (Asset)",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum VoucherType {
    #[serde(rename = "Contra")]
    Contra,
    #[serde(rename = "Payment")]
    Payment,
    #[serde(rename = "Receipt")]
    Receipt,
    #[serde(rename = "Journal")]
    Journal,
    #[serde(rename = "Sales")]
    Sales,
    #[serde(rename = "Purchase")]
    Purchase,
    #[serde(rename = "Credit Note")]
    CreditNote,
    #[serde(rename = "Debit Note")]
    DebitNote,
    #[serde(rename = "Delivery Note")]
    DeliveryNote,
    #[serde(rename = "Receipt Note")]
    ReceiptNote,
    #[serde(rename = "Rejection In")]
    RejectionIn,
    #[serde(rename = "Rejection Out")]
    RejectionOut,
    #[serde(rename = "Stock Journal")]
    StockJournal,
    #[serde(rename = "Physical Stock")]
    PhysicalStock,
}

impl VoucherType {
    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "Contra" => Self::Contra,
            "Payment" => Self::Payment,
            "Receipt" => Self::Receipt,
            "Journal" => Self::Journal,
            "Sales" => Self::Sales,
            "Purchase" => Self::Purchase,
            "Credit Note" => Self::CreditNote,
            "Debit Note" => Self::DebitNote,
            "Delivery Note" => Self::DeliveryNote,
            "Receipt Note" => Self::ReceiptNote,
            "Rejection In" => Self::RejectionIn,
            "Rejection Out" => Self::RejectionOut,
            "Stock Journal" => Self::StockJournal,
            "Physical Stock" => Self::PhysicalStock,
            _ => return None,
        })
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Contra => "Contra",
            Self::Payment => "Payment",
            Self::Receipt => "Receipt",
            Self::Journal => "Journal",
            Self::Sales => "Sales",
            Self::Purchase => "Purchase",
            Self::CreditNote => "Credit Note",
            Self::DebitNote => "Debit Note",
            Self::DeliveryNote => "Delivery Note",
            Self::ReceiptNote => "Receipt Note",
            Self::RejectionIn => "Rejection In",
            Self::RejectionOut => "Rejection Out",
            Self::StockJournal => "Stock Journal",
            Self::PhysicalStock => "Physical Stock",
        }
    }

    pub fn requires_party(self) -> bool {
        matches!(
            self,
            Self::Sales | Self::Purchase | Self::CreditNote | Self::DebitNote
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum VoucherStatus {
    #[default]
    Regular,
    Optional,
    Cancelled,
}

impl VoucherStatus {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "regular" => Some(Self::Regular),
            "optional" => Some(Self::Optional),
            "cancelled" => Some(Self::Cancelled),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Regular => "regular",
            Self::Optional => "optional",
            Self::Cancelled => "cancelled",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum VoucherSource {
    #[default]
    Manual,
    Email,
    Statement,
    Fastag,
    Import,
    System,
}

impl VoucherSource {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "manual" => Some(Self::Manual),
            "email" => Some(Self::Email),
            "statement" => Some(Self::Statement),
            "fastag" => Some(Self::Fastag),
            "import" => Some(Self::Import),
            "system" => Some(Self::System),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Manual => "manual",
            Self::Email => "email",
            Self::Statement => "statement",
            Self::Fastag => "fastag",
            Self::Import => "import",
            Self::System => "system",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PartyType {
    Debtor,
    Creditor,
    Both,
}

impl PartyType {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "debtor" => Some(Self::Debtor),
            "creditor" => Some(Self::Creditor),
            "both" => Some(Self::Both),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Debtor => "debtor",
            Self::Creditor => "creditor",
            Self::Both => "both",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NumberingResetPeriod {
    Never,
    Yearly,
    Fy,
    Monthly,
}

impl NumberingResetPeriod {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "never" => Some(Self::Never),
            "yearly" => Some(Self::Yearly),
            "fy" => Some(Self::Fy),
            "monthly" => Some(Self::Monthly),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Never => "never",
            Self::Yearly => "yearly",
            Self::Fy => "fy",
            Self::Monthly => "monthly",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanySettings {
    pub fy_start_month: u32,
    pub round_to_minor: Minor,
    pub rounding_mode: RoundingMode,
    pub decimal_places: u32,
    pub default_currency: String,
}

impl Default for CompanySettings {
    fn default() -> Self {
        Self {
            fy_start_month: 4,
            round_to_minor: 1,
            rounding_mode: RoundingMode::HalfUp,
            decimal_places: 2,
            default_currency: "INR".to_string(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub slug: String,
    pub name: String,
    pub readable_name: String,
    pub company_id: String,
    #[serde(default)]
    pub archived: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanyProfile {
    pub id: String,
    pub workspace_id: String,
    pub legal_name: String,
    pub trade_name: Option<String>,
    pub gstin: Option<String>,
    pub pan: Option<String>,
    pub state: Option<String>,
    pub currency: String,
    pub books_begin: String,
    pub settings: CompanySettings,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ledger {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    pub tally_parent: TallyPrimaryGroup,
    pub nature: LedgerNature,
    pub opening_balance_minor: Minor,
    #[serde(default)]
    pub is_party: bool,
    #[serde(default)]
    pub is_bank: bool,
    #[serde(default)]
    pub is_tax: bool,
    #[serde(default)]
    pub billwise: bool,
    #[serde(default)]
    pub archived: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Party {
    pub id: String,
    pub workspace_id: String,
    pub ledger_id: String,
    pub name: String,
    pub gstin: Option<String>,
    pub party_type: PartyType,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NumberingScheme {
    pub id: String,
    pub workspace_id: String,
    pub voucher_type: VoucherType,
    pub prefix: String,
    pub next_number: u64,
    pub reset_period: NumberingResetPeriod,
    pub width: u32,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Voucher {
    pub id: String,
    pub workspace_id: String,
    pub voucher_type: VoucherType,
    pub number: String,
    pub date: String,
    #[serde(default)]
    pub status: VoucherStatus,
    pub currency: String,
    pub party_ledger_id: Option<String>,
    pub invoice_number: Option<String>,
    pub narration: Option<String>,
    #[serde(default)]
    pub round_off_amount_minor: Minor,
    pub round_off_ledger_id: Option<String>,
    #[serde(default)]
    pub source: VoucherSource,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoucherLine {
    pub id: String,
    pub voucher_id: String,
    pub workspace_id: String,
    pub line_no: u32,
    pub ledger_id: String,
    /// Signed minor amount: positive = debit, negative = credit.
    pub amount_minor: Minor,
    pub currency: String,
    pub narration: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewVoucher {
    pub voucher: Voucher,
    pub lines: Vec<VoucherLine>,
}

/// Derive an Indian financial-year key (`2025-26`) for a `YYYY-MM-DD` date.
pub fn financial_year_key(date: &str, fy_start_month: u32) -> Result<String, crate::EngineError> {
    let mut parts = date.split('-');
    let year: i32 = parts
        .next()
        .and_then(|v| v.parse().ok())
        .ok_or_else(|| crate::EngineError::InvalidDate(date.to_string()))?;
    let month: u32 = parts
        .next()
        .and_then(|v| v.parse().ok())
        .ok_or_else(|| crate::EngineError::InvalidDate(date.to_string()))?;
    let day: u32 = parts
        .next()
        .and_then(|v| v.parse().ok())
        .ok_or_else(|| crate::EngineError::InvalidDate(date.to_string()))?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || parts.next().is_some() {
        return Err(crate::EngineError::InvalidDate(date.to_string()));
    }
    let start_month = fy_start_month.clamp(1, 12);
    let start_year = if month >= start_month { year } else { year - 1 };
    let end_year = start_year + 1;
    Ok(format!("{}-{:02}", start_year, (end_year % 100) as u32))
}

/// A ledger is a party ledger when it sits under Sundry Debtors/Creditors.
pub fn is_party_group(group: &TallyPrimaryGroup) -> bool {
    matches!(
        group,
        TallyPrimaryGroup::SundryDebtors | TallyPrimaryGroup::SundryCreditors
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn financial_year_rolls_in_april() {
        assert_eq!(financial_year_key("2025-04-01", 4).unwrap(), "2025-26");
        assert_eq!(financial_year_key("2025-03-31", 4).unwrap(), "2024-25");
        assert_eq!(financial_year_key("2025-12-31", 4).unwrap(), "2025-26");
    }

    #[test]
    fn voucher_type_round_trips_ts_strings() {
        let json = serde_json::to_string(&VoucherType::CreditNote).unwrap();
        assert_eq!(json, "\"Credit Note\"");
        assert_eq!(
            VoucherType::parse("Credit Note"),
            Some(VoucherType::CreditNote)
        );
    }
}
