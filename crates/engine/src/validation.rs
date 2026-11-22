use crate::model::{
    financial_year_key, is_party_group, CompanyProfile, Ledger, NewVoucher, Party, Voucher,
    VoucherLine, VoucherStatus, VoucherType,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum IssueSeverity {
    Error,
    Warning,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationIssue {
    pub code: String,
    pub severity: IssueSeverity,
    pub message: String,
    pub entity_type: Option<String>,
    pub entity_id: Option<String>,
    pub hint: Option<String>,
}

impl ValidationIssue {
    fn error(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            severity: IssueSeverity::Error,
            message: message.into(),
            entity_type: None,
            entity_id: None,
            hint: None,
        }
    }

    fn warning(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            severity: IssueSeverity::Warning,
            message: message.into(),
            entity_type: None,
            entity_id: None,
            hint: None,
        }
    }

    fn on(mut self, entity_type: &str, entity_id: &str) -> Self {
        self.entity_type = Some(entity_type.to_string());
        self.entity_id = Some(entity_id.to_string());
        self
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ValidationResult {
    pub ok: bool,
    pub issues: Vec<ValidationIssue>,
}

impl ValidationResult {
    pub fn from_issues(issues: Vec<ValidationIssue>) -> Self {
        let ok = !issues.iter().any(|i| i.severity == IssueSeverity::Error);
        Self { ok, issues }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CurrencyTotals {
    pub debit: i64,
    pub credit: i64,
    pub net: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct VoucherTotals {
    pub total_debit_minor: i64,
    pub total_credit_minor: i64,
    pub by_currency: BTreeMap<String, CurrencyTotals>,
}

fn clamp_i128(value: i128) -> i64 {
    i64::try_from(value).unwrap_or(if value > 0 { i64::MAX } else { i64::MIN })
}

pub fn compute_totals(lines: &[VoucherLine]) -> VoucherTotals {
    let mut by_currency: BTreeMap<String, CurrencyTotals> = BTreeMap::new();
    let mut total_debit: i128 = 0;
    let mut total_credit: i128 = 0;

    for line in lines {
        let entry = by_currency.entry(line.currency.clone()).or_default();
        if line.amount_minor >= 0 {
            entry.debit = entry.debit.saturating_add(line.amount_minor);
            total_debit += line.amount_minor as i128;
        } else {
            entry.credit = entry.credit.saturating_add(-line.amount_minor);
            total_credit += -(line.amount_minor as i128);
        }
        entry.net = entry.debit - entry.credit;
    }

    VoucherTotals {
        total_debit_minor: clamp_i128(total_debit),
        total_credit_minor: clamp_i128(total_credit),
        by_currency,
    }
}

pub fn validate_line_balance(lines: &[VoucherLine]) -> ValidationResult {
    let mut issues = Vec::new();
    if lines.len() < 2 {
        issues.push(ValidationIssue::error(
            "voucher.too-few-lines",
            "A voucher needs at least two ledger lines",
        ));
    }
    if lines.iter().any(|line| line.amount_minor == 0) {
        issues.push(ValidationIssue::warning(
            "voucher.zero-line",
            "Voucher contains a zero-amount line",
        ));
    }
    let totals = compute_totals(lines);
    for (currency, entry) in &totals.by_currency {
        if entry.net != 0 {
            issues.push(ValidationIssue::error(
                "voucher.unbalanced",
                format!(
                    "Voucher is unbalanced in {currency}: debit {}, credit {}",
                    entry.debit, entry.credit
                ),
            ));
        }
    }
    ValidationResult::from_issues(issues)
}

pub fn validate_round_off(voucher: &Voucher, lines: &[VoucherLine]) -> ValidationResult {
    let mut issues = Vec::new();
    match voucher.round_off_ledger_id.as_deref() {
        None => {
            if voucher.round_off_amount_minor != 0 {
                issues.push(ValidationIssue::error(
                    "voucher.roundoff-ledger-missing",
                    "Voucher has a round-off amount but no round-off ledger",
                ));
            }
        }
        Some(ledger_id) => {
            let posted: i64 = lines
                .iter()
                .filter(|line| line.ledger_id == ledger_id)
                .fold(0_i64, |acc, line| acc.saturating_add(line.amount_minor));
            if posted != voucher.round_off_amount_minor {
                issues.push(ValidationIssue::error(
                    "voucher.roundoff-mismatch",
                    format!(
                        "Voucher round-off is {} but lines to ledger {ledger_id} total {posted}",
                        voucher.round_off_amount_minor
                    ),
                ));
            }
        }
    }
    ValidationResult::from_issues(issues)
}

pub fn validate_new_voucher(input: &NewVoucher) -> ValidationResult {
    let mut issues = validate_line_balance(&input.lines).issues;
    let voucher = &input.voucher;

    if voucher.voucher_type.requires_party() && voucher.party_ledger_id.is_none() {
        issues.push(ValidationIssue::error(
            "voucher.party-required",
            format!(
                "{} vouchers require a party ledger",
                voucher.voucher_type.as_str()
            ),
        ));
    }
    if voucher.voucher_type.requires_party() && voucher.invoice_number.is_none() {
        issues.push(ValidationIssue::warning(
            "voucher.invoice-number-missing",
            format!(
                "{} voucher has no invoice number",
                voucher.voucher_type.as_str()
            ),
        ));
    }
    if input
        .lines
        .iter()
        .any(|line| line.currency != voucher.currency)
    {
        issues.push(ValidationIssue::warning(
            "voucher.forex-rate-missing",
            "Mixed-currency voucher requires an explicit exchange rate on every foreign line",
        ));
    }
    issues.extend(validate_round_off(voucher, &input.lines).issues);
    if !is_valid_date(&voucher.date) {
        issues.push(ValidationIssue::error(
            "voucher.invalid-date",
            format!(
                "Voucher date '{}' is not a valid YYYY-MM-DD date",
                voucher.date
            ),
        ));
    }
    if voucher.currency.len() != 3 || !voucher.currency.chars().all(|c| c.is_ascii_uppercase()) {
        issues.push(ValidationIssue::error(
            "voucher.invalid-currency",
            format!(
                "Currency '{}' must be a 3-letter ISO-4217 code",
                voucher.currency
            ),
        ));
    }

    ValidationResult::from_issues(issues)
}

pub fn is_valid_date(value: &str) -> bool {
    let mut parts = value.split('-');
    let year = parts.next().and_then(|v| v.parse::<i32>().ok());
    let month = parts.next().and_then(|v| v.parse::<u32>().ok());
    let day = parts.next().and_then(|v| v.parse::<u32>().ok());
    if parts.next().is_some() {
        return false;
    }
    matches!((year, month, day), (Some(y), Some(m), Some(d))
        if (1900..=9999).contains(&y) && (1..=12).contains(&m) && (1..=31).contains(&d))
}

#[derive(Debug, Clone, Default)]
pub struct TallyReadinessInput<'a> {
    pub company: Option<&'a CompanyProfile>,
    pub ledgers: &'a [Ledger],
    pub parties: &'a [Party],
    pub vouchers: &'a [Voucher],
    pub lines: &'a [VoucherLine],
    pub fy_start_month: u32,
}

pub fn check_tally_readiness(input: &TallyReadinessInput<'_>) -> ValidationResult {
    let mut issues = Vec::new();
    let fy_start_month = if input.fy_start_month == 0 {
        input
            .company
            .map(|c| c.settings.fy_start_month)
            .unwrap_or(4)
    } else {
        input.fy_start_month
    };

    match input.company {
        None => issues.push(ValidationIssue::error(
            "company.missing",
            "Company profile is missing",
        )),
        Some(company) => {
            if company.legal_name.trim().is_empty() {
                issues.push(ValidationIssue::error(
                    "company.name",
                    "Company legal name is required for Tally",
                ));
            }
            if company.books_begin.is_empty() || !is_valid_date(&company.books_begin) {
                issues.push(ValidationIssue::error(
                    "company.books-begin",
                    "Company books-begin date is required for Tally",
                ));
            }
            if company.state.is_none() {
                issues.push(ValidationIssue::warning(
                    "company.state",
                    "Company state is required for place-of-supply defaults",
                ));
            }
        }
    }

    let party_ledger_ids: std::collections::BTreeSet<&str> =
        input.parties.iter().map(|p| p.ledger_id.as_str()).collect();

    for ledger in input.ledgers {
        if ledger.is_party && !party_ledger_ids.contains(ledger.id.as_str()) {
            issues.push(
                ValidationIssue::error(
                    "ledger.party-master-missing",
                    format!("Party ledger '{}' has no party master", ledger.name),
                )
                .on("ledger", &ledger.id),
            );
        }
        if ledger.is_party && !is_party_group(&ledger.tally_parent) {
            issues.push(
                ValidationIssue::error(
                    "ledger.party-group",
                    format!(
                        "Party ledger '{}' must sit under Sundry Debtors or Sundry Creditors",
                        ledger.name
                    ),
                )
                .on("ledger", &ledger.id),
            );
        }
    }

    let mut lines_by_voucher: BTreeMap<&str, Vec<VoucherLine>> = BTreeMap::new();
    for line in input.lines {
        lines_by_voucher
            .entry(line.voucher_id.as_str())
            .or_default()
            .push(line.clone());
    }

    let mut seen_numbers: BTreeMap<(String, String, String), &str> = BTreeMap::new();
    for voucher in input.vouchers {
        let lines = lines_by_voucher
            .get(voucher.id.as_str())
            .cloned()
            .unwrap_or_default();
        for issue in validate_line_balance(&lines).issues {
            issues.push(issue.on("voucher", &voucher.id));
        }

        let fy = financial_year_key(&voucher.date, fy_start_month)
            .unwrap_or_else(|_| "invalid".to_string());
        let key = (
            voucher.voucher_type.as_str().to_string(),
            fy,
            voucher.number.clone(),
        );
        if let Some(previous) = seen_numbers.get(&key) {
            issues.push(
                ValidationIssue::error(
                    "voucher.duplicate-number",
                    format!(
                        "Duplicate {} number '{}' in the same financial year",
                        voucher.voucher_type.as_str(),
                        voucher.number
                    ),
                )
                .on("voucher", &voucher.id)
                .with_hint(format!("Also used by {previous}")),
            );
        } else {
            seen_numbers.insert(key, voucher.id.as_str());
        }

        if voucher.voucher_type.requires_party() && voucher.party_ledger_id.is_none() {
            issues.push(
                ValidationIssue::error(
                    "voucher.party-required",
                    format!(
                        "{} {} has no party ledger",
                        voucher.voucher_type.as_str(),
                        voucher.number
                    ),
                )
                .on("voucher", &voucher.id),
            );
        }

        if voucher.round_off_amount_minor != 0 {
            match voucher.round_off_ledger_id.as_deref() {
                None => issues.push(
                    ValidationIssue::error(
                        "voucher.roundoff-ledger-missing",
                        format!(
                            "Voucher {} has a round-off amount but no round-off ledger",
                            voucher.number
                        ),
                    )
                    .on("voucher", &voucher.id),
                ),
                Some(id) => {
                    let ledger = input.ledgers.iter().find(|l| l.id.as_str() == id);
                    match ledger {
                        None => issues.push(
                            ValidationIssue::error(
                                "voucher.roundoff-ledger-missing",
                                format!(
                                    "Voucher {} references missing round-off ledger {id}",
                                    voucher.number
                                ),
                            )
                            .on("voucher", &voucher.id),
                        ),
                        Some(ledger)
                            if !matches!(
                                ledger.tally_parent,
                                crate::model::TallyPrimaryGroup::IndirectExpenses
                                    | crate::model::TallyPrimaryGroup::IndirectIncome
                            ) =>
                        {
                            issues.push(
                                ValidationIssue::error(
                                    "voucher.roundoff-group",
                                    format!(
                                        "Round-off ledger '{}' must be under Indirect Expenses or Indirect Income",
                                        ledger.name
                                    ),
                                )
                                .on("voucher", &voucher.id),
                            );
                        }
                        Some(_) => {}
                    }
                }
            }
        }

        if voucher.status != VoucherStatus::Cancelled
            && matches!(
                voucher.voucher_type,
                VoucherType::Sales | VoucherType::Purchase
            )
            && voucher.invoice_number.is_none()
        {
            issues.push(
                ValidationIssue::warning(
                    "voucher.invoice-number-missing",
                    format!(
                        "{} {} has no invoice number",
                        voucher.voucher_type.as_str(),
                        voucher.number
                    ),
                )
                .on("voucher", &voucher.id),
            );
        }
    }

    ValidationResult::from_issues(issues)
}

impl ValidationIssue {
    fn with_hint(mut self, hint: impl Into<String>) -> Self {
        self.hint = Some(hint.into());
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{VoucherSource, VoucherStatus};

    fn voucher(id: &str, voucher_type: VoucherType) -> Voucher {
        Voucher {
            id: id.to_string(),
            workspace_id: "ws_1".to_string(),
            voucher_type,
            number: "1".to_string(),
            date: "2025-04-01".to_string(),
            status: VoucherStatus::Regular,
            currency: "INR".to_string(),
            party_ledger_id: Some("led_party".to_string()),
            invoice_number: Some("INV-1".to_string()),
            narration: None,
            round_off_amount_minor: 0,
            round_off_ledger_id: None,
            source: VoucherSource::Manual,
            created_at: "2025-04-01T00:00:00Z".to_string(),
            updated_at: "2025-04-01T00:00:00Z".to_string(),
        }
    }

    fn line(id: &str, amount: i64) -> VoucherLine {
        VoucherLine {
            id: id.to_string(),
            voucher_id: "vch_1".to_string(),
            workspace_id: "ws_1".to_string(),
            line_no: 1,
            ledger_id: "led_1".to_string(),
            amount_minor: amount,
            currency: "INR".to_string(),
            narration: None,
        }
    }

    #[test]
    fn balanced_voucher_passes() {
        let result = validate_line_balance(&[line("l1", 1000), line("l2", -1000)]);
        assert!(result.ok);
    }

    #[test]
    fn unbalanced_voucher_fails() {
        let result = validate_line_balance(&[line("l1", 1000), line("l2", -999)]);
        assert!(!result.ok);
        assert!(result.issues.iter().any(|i| i.code == "voucher.unbalanced"));
    }

    #[test]
    fn round_off_must_match_posted_line() {
        let mut v = voucher("vch_1", VoucherType::Journal);
        v.round_off_amount_minor = 2;
        v.round_off_ledger_id = Some("led_round".to_string());

        let mut round_line = line("l3", 2);
        round_line.ledger_id = "led_round".to_string();
        let lines = vec![line("l1", 1000), line("l2", -1002), round_line];
        assert!(validate_round_off(&v, &lines).ok);

        let mut tampered = lines.clone();
        tampered[2].amount_minor = 3;
        let result = validate_round_off(&v, &tampered);
        assert!(!result.ok);
        assert!(result
            .issues
            .iter()
            .any(|i| i.code == "voucher.roundoff-mismatch"));
    }

    #[test]
    fn sales_requires_party() {
        let mut v = voucher("vch_1", VoucherType::Sales);
        v.party_ledger_id = None;
        let result = validate_new_voucher(&NewVoucher {
            voucher: v,
            lines: vec![line("l1", 1000), line("l2", -1000)],
        });
        assert!(!result.ok);
    }

    #[test]
    fn duplicate_numbers_are_rejected_per_fy() {
        let v = voucher("vch_1", VoucherType::Journal);
        let v2 = voucher("vch_2", VoucherType::Journal);
        let lines = vec![line("l1", 1000), line("l2", -1000)];
        let result = check_tally_readiness(&TallyReadinessInput {
            vouchers: &[v, v2],
            lines: &lines,
            fy_start_month: 4,
            ..Default::default()
        });
        assert!(result
            .issues
            .iter()
            .any(|i| i.code == "voucher.duplicate-number"));
    }
}
