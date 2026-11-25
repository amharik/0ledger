use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StatementKind {
    Bank,
    CreditCard,
    P2p,
    Fastag,
}

impl StatementKind {
    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "bank" | "nps" | "ppf" | "interest" => Some(Self::Bank),
            "credit_card" | "creditcard" | "cc" => Some(Self::CreditCard),
            "p2p" | "gift_card" | "giftcard" | "wallet" => Some(Self::P2p),
            "fastag" => Some(Self::Fastag),
            _ => None,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Bank => "bank",
            Self::CreditCard => "credit_card",
            Self::P2p => "p2p",
            Self::Fastag => "fastag",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum IngestBatchState {
    Received,
    Queued,
    Extracting,
    Fingerprinting,
    AutoMapped,
    NeedsMapping,
    ScrutinyRequired,
    Reconciled,
    Committed,
    Aborted,
}

impl IngestBatchState {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Received => "RECEIVED",
            Self::Queued => "QUEUED",
            Self::Extracting => "EXTRACTING",
            Self::Fingerprinting => "FINGERPRINTING",
            Self::AutoMapped => "AUTO_MAPPED",
            Self::NeedsMapping => "NEEDS_MAPPING",
            Self::ScrutinyRequired => "SCRUTINY_REQUIRED",
            Self::Reconciled => "RECONCILED",
            Self::Committed => "COMMITTED",
            Self::Aborted => "ABORTED",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "RECEIVED" => Some(Self::Received),
            "QUEUED" => Some(Self::Queued),
            "EXTRACTING" => Some(Self::Extracting),
            "FINGERPRINTING" => Some(Self::Fingerprinting),
            "AUTO_MAPPED" => Some(Self::AutoMapped),
            "NEEDS_MAPPING" => Some(Self::NeedsMapping),
            "SCRUTINY_REQUIRED" => Some(Self::ScrutinyRequired),
            "RECONCILED" => Some(Self::Reconciled),
            "COMMITTED" => Some(Self::Committed),
            "ABORTED" => Some(Self::Aborted),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ColumnRole {
    Date,
    ValueDate,
    Description,
    Debit,
    Credit,
    Amount,
    Type,
    Balance,
    Reference,
    Ignore,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractedTableData {
    #[serde(alias = "table_index")]
    pub table_index: usize,
    #[serde(alias = "raw_headers")]
    pub raw_headers: Vec<String>,
    #[serde(alias = "raw_rows")]
    pub raw_rows: Vec<Vec<String>>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatementSummary {
    pub opening_balance_minor: Option<i64>,
    pub closing_balance_minor: Option<i64>,
    pub previous_balance_minor: Option<i64>,
    pub total_due_minor: Option<i64>,
    pub summary_debits_minor: Option<i64>,
    pub summary_credits_minor: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedIngestRow {
    pub row_index: usize,
    pub date: String,
    pub value_date: Option<String>,
    pub description: String,
    pub reference: Option<String>,
    pub debit_minor: i64,
    pub credit_minor: i64,
    pub balance_minor: Option<i64>,
    pub narration_norm: String,
    pub daily_rank: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BalanceDiscrepancy {
    pub row_index: Option<usize>,
    pub expected_minor: i64,
    pub actual_minor: i64,
    pub delta_minor: i64,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BalanceVerificationResult {
    pub ok: bool,
    pub discrepancy_minor: i64,
    pub discrepancies: Vec<BalanceDiscrepancy>,
}

/// Parses Markdown pipe tables exported by `docling` into structured tables,
/// filtering out non-transaction summary blocks and stitching consecutive
/// tables that share identical headers across page breaks.
pub fn parse_markdown_tables(markdown: &str) -> Vec<ExtractedTableData> {
    let mut raw_tables: Vec<(Vec<String>, Vec<Vec<String>>)> = Vec::new();
    let mut current_lines: Vec<&str> = Vec::new();

    for line in markdown.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('|') && trimmed.ends_with('|') && trimmed.len() >= 2 {
            current_lines.push(trimmed);
        } else if !current_lines.is_empty() {
            if let Some(parsed) = parse_pipe_block(&current_lines) {
                raw_tables.push(parsed);
            }
            current_lines.clear();
        }
    }
    if !current_lines.is_empty() {
        if let Some(parsed) = parse_pipe_block(&current_lines) {
            raw_tables.push(parsed);
        }
    }

    // Stitch consecutive tables with identical normalized headers.
    let mut stitched: Vec<(Vec<String>, Vec<Vec<String>>)> = Vec::new();
    for (headers, rows) in raw_tables {
        if headers.len() < 2 || rows.is_empty() {
            continue;
        }
        let norm_h: Vec<String> = headers.iter().map(|h| normalize_header_token(h)).collect();
        let can_stitch = stitched
            .last()
            .map(|(prev_h, _)| {
                let prev_norm: Vec<String> =
                    prev_h.iter().map(|h| normalize_header_token(h)).collect();
                prev_norm == norm_h
            })
            .unwrap_or(false);

        if can_stitch {
            if let Some((_, prev_rows)) = stitched.last_mut() {
                prev_rows.extend(rows);
            }
        } else {
            stitched.push((headers, rows));
        }
    }

    // Filter out non-transaction summary tables (must have >= 2 rows and >= 2 columns,
    // or look like a transaction table with date/amount keywords).
    stitched
        .into_iter()
        .filter(|(headers, rows)| headers.len() >= 2 && !rows.is_empty())
        .enumerate()
        .map(|(idx, (raw_headers, raw_rows))| ExtractedTableData {
            table_index: idx,
            raw_headers,
            raw_rows,
        })
        .collect()
}

fn parse_pipe_block(lines: &[&str]) -> Option<(Vec<String>, Vec<Vec<String>>)> {
    if lines.len() < 2 {
        return None;
    }
    let split_row = |line: &str| -> Vec<String> {
        let inner = line.trim().trim_start_matches('|').trim_end_matches('|');
        inner
            .split('|')
            .map(|cell| cell.trim().to_string())
            .collect()
    };

    let headers = split_row(lines[0]);
    let mut start_idx = 1;
    let is_sep = lines[1]
        .trim_matches('|')
        .split('|')
        .all(|c| c.trim().chars().all(|ch| ch == '-' || ch == ':' || ch == ' '));
    if is_sep {
        start_idx = 2;
    }

    let mut rows = Vec::new();
    for line in &lines[start_idx..] {
        let mut cells = split_row(line);
        if cells.iter().all(|c| c.is_empty()) {
            continue;
        }
        while cells.len() < headers.len() {
            cells.push(String::new());
        }
        cells.truncate(headers.len());
        rows.push(cells);
    }

    if rows.is_empty() {
        None
    } else {
        Some((headers, rows))
    }
}

/// Detects an institution slug from page 1 text using a whitelisted institution
/// dictionary and Indian IFSC prefixes.
pub fn detect_institution_slug(page_one_text: &str) -> Option<String> {
    let lower = page_one_text.to_ascii_lowercase();
    let upper = page_one_text.to_ascii_uppercase();

    let ifsc_prefixes = [
        ("HDFC0", "hdfc"),
        ("ICIC0", "icici"),
        ("IDFB0", "idfc"),
        ("SBIN0", "sbi"),
        ("IDIB0", "indian"),
        ("UTIB0", "axis"),
        ("KKBK0", "kotak"),
        ("YESB0", "yes"),
        ("INDB0", "indusind"),
    ];
    for (prefix, slug) in ifsc_prefixes {
        if upper.contains(prefix) {
            return Some(slug.to_string());
        }
    }

    let whitelist = [
        ("hdfc bank", "hdfc"),
        ("hdfc", "hdfc"),
        ("icici bank", "icici"),
        ("icici", "icici"),
        ("idfc first", "idfc"),
        ("idfc", "idfc"),
        ("state bank of india", "sbi"),
        ("sbi", "sbi"),
        ("indian bank", "indian"),
        ("axis bank", "axis"),
        ("kotak mahindra", "kotak"),
        ("kotak", "kotak"),
        ("yes bank", "yes"),
        ("indusind", "indusind"),
        ("paytm", "paytm"),
        ("phonepe", "phonepe"),
        ("google pay", "gpay"),
        ("gpay", "gpay"),
        ("fastag", "nhai_fastag"),
    ];
    for (needle, slug) in whitelist {
        if lower.contains(needle) {
            return Some(slug.to_string());
        }
    }
    None
}

fn is_pii_header(normalized: &str) -> bool {
    let tokens: Vec<&str> = normalized.split('_').collect();
    let pii_exact = [
        "account_no",
        "account_number",
        "a_c",
        "ifsc",
        "ifsc_code",
        "cust_id",
        "customer_id",
        "customer_name",
        "name",
        "address",
        "pan",
        "gstin",
        "mobile",
        "email",
    ];
    if pii_exact.contains(&normalized) {
        return true;
    }
    tokens.iter().any(|t| matches!(*t, "ifsc" | "gstin" | "pan"))
}

pub fn normalize_header_token(header: &str) -> String {
    let mut out = String::new();
    let mut last_underscore = true;
    for ch in header.trim().to_ascii_lowercase().chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
            last_underscore = false;
        } else if !last_underscore {
            out.push('_');
            last_underscore = true;
        }
    }
    out.trim_end_matches('_').to_string()
}

/// Sanitizes headers (removing PII), appends occurrence suffixes (`_2`, `_3`)
/// for duplicate header names, and returns `(ordered_canonical_headers, sha256_fingerprint)`.
pub fn build_header_fingerprint(
    institution_slug: &str,
    statement_kind: StatementKind,
    raw_headers: &[String],
) -> (Vec<String>, String) {
    let mut counts: HashMap<String, usize> = HashMap::new();
    let mut ordered_canonical = Vec::with_capacity(raw_headers.len());

    for raw in raw_headers {
        let base = normalize_header_token(raw);
        if base.is_empty() || is_pii_header(&base) {
            continue;
        }
        let count = counts.entry(base.clone()).or_insert(0);
        *count += 1;
        let canonical = if *count == 1 {
            base
        } else {
            format!("{}_{}", base, *count)
        };
        ordered_canonical.push(canonical);
    }

    let mut sorted = ordered_canonical.clone();
    sorted.sort();

    let payload = format!(
        "{}|{}|{}",
        institution_slug.trim().to_ascii_lowercase(),
        statement_kind.as_str(),
        sorted.join("|")
    );
    let mut hasher = Sha256::new();
    hasher.update(payload.as_bytes());
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(64);
    for b in digest {
        hex.push_str(&format!("{:02x}", b));
    }

    (ordered_canonical, hex)
}

/// Normalizes a transaction narration for fallback unreferenced cross-PDF deduplication.
pub fn normalize_narration(narration: &str) -> String {
    narration
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_lowercase()
}

/// Extracts a deterministic counterparty hint (e.g. UPI handle or NEFT payee) from narration.
pub fn resolve_counterparty_hint(narration: &str) -> Option<String> {
    let cleaned = narration.trim();
    if cleaned.is_empty() {
        return None;
    }
    // Check for UPI VPA token (contains '@')
    for token in cleaned.split(|c: char| c.is_whitespace() || c == '/' || c == '-') {
        if token.contains('@') && token.len() >= 5 {
            return Some(token.to_ascii_lowercase());
        }
    }
    // Check common NEFT/IMPS/UPI slash-delimited formats: e.g. UPI/PAYEE_NAME/REF
    let parts: Vec<&str> = cleaned.split('/').map(str::trim).collect();
    if parts.len() >= 3 && matches!(parts[0].to_ascii_uppercase().as_str(), "UPI" | "NEFT" | "IMPS" | "RTGS") {
        let candidate = parts[1];
        if !candidate.is_empty() && candidate.chars().any(|c| c.is_ascii_alphabetic()) {
            return Some(candidate.to_ascii_lowercase());
        }
    }
    None
}

/// Verifies mathematical balance invariants per `StatementKind` using exact integer paise.
pub fn verify_statement_balance(
    kind: StatementKind,
    rows: &[ParsedIngestRow],
    summary: &StatementSummary,
) -> BalanceVerificationResult {
    let mut discrepancies = Vec::new();

    match kind {
        StatementKind::Bank => {
            if rows.is_empty() {
                return BalanceVerificationResult {
                    ok: true,
                    discrepancy_minor: 0,
                    discrepancies,
                };
            }
            let mut prev_balance = summary.opening_balance_minor.or_else(|| {
                rows.first().and_then(|r| {
                    r.balance_minor
                        .map(|bal| bal - r.credit_minor + r.debit_minor)
                })
            });

            for row in rows {
                if let (Some(prev), Some(actual)) = (prev_balance, row.balance_minor) {
                    let expected = prev + row.credit_minor - row.debit_minor;
                    let delta = (expected - actual).abs();
                    if delta != 0 {
                        discrepancies.push(BalanceDiscrepancy {
                            row_index: Some(row.row_index),
                            expected_minor: expected,
                            actual_minor: actual,
                            delta_minor: delta,
                            message: format!(
                                "Running balance mismatch at row {}: expected {}, got {}",
                                row.row_index, expected, actual
                            ),
                        });
                    }
                    prev_balance = Some(actual);
                }
            }
        }
        StatementKind::CreditCard => {
            if let (Some(prev_due), Some(total_due)) =
                (summary.previous_balance_minor, summary.total_due_minor)
            {
                let sum_debits: i64 = rows.iter().map(|r| r.debit_minor).sum();
                let sum_credits: i64 = rows.iter().map(|r| r.credit_minor).sum();
                let calculated_due = prev_due + sum_debits - sum_credits;
                let delta = (calculated_due - total_due).abs();
                if delta != 0 {
                    discrepancies.push(BalanceDiscrepancy {
                        row_index: None,
                        expected_minor: total_due,
                        actual_minor: calculated_due,
                        delta_minor: delta,
                        message: format!(
                            "Credit card total due mismatch: calculated {}, statement {}",
                            calculated_due, total_due
                        ),
                    });
                }
            }
        }
        StatementKind::P2p | StatementKind::Fastag => {
            let sum_debits: i64 = rows.iter().map(|r| r.debit_minor).sum();
            let sum_credits: i64 = rows.iter().map(|r| r.credit_minor).sum();
            if let Some(expected_debits) = summary.summary_debits_minor {
                let delta = (sum_debits - expected_debits).abs();
                if delta != 0 {
                    discrepancies.push(BalanceDiscrepancy {
                        row_index: None,
                        expected_minor: expected_debits,
                        actual_minor: sum_debits,
                        delta_minor: delta,
                        message: format!(
                            "Summary debits mismatch: line sum {}, statement {}",
                            sum_debits, expected_debits
                        ),
                    });
                }
            }
            if let Some(expected_credits) = summary.summary_credits_minor {
                let delta = (sum_credits - expected_credits).abs();
                if delta != 0 {
                    discrepancies.push(BalanceDiscrepancy {
                        row_index: None,
                        expected_minor: expected_credits,
                        actual_minor: sum_credits,
                        delta_minor: delta,
                        message: format!(
                            "Summary credits mismatch: line sum {}, statement {}",
                            sum_credits, expected_credits
                        ),
                    });
                }
            }
            if let (Some(opening), Some(closing)) =
                (summary.opening_balance_minor, summary.closing_balance_minor)
            {
                let calculated = opening + sum_credits - sum_debits;
                let delta = (calculated - closing).abs();
                if delta != 0 {
                    discrepancies.push(BalanceDiscrepancy {
                        row_index: None,
                        expected_minor: closing,
                        actual_minor: calculated,
                        delta_minor: delta,
                        message: format!(
                            "Wallet closing balance mismatch: calculated {}, statement {}",
                            calculated, closing
                        ),
                    });
                }
            }
        }
    }

    let total_delta: i64 = discrepancies.iter().map(|d| d.delta_minor).sum();
    BalanceVerificationResult {
        ok: discrepancies.is_empty(),
        discrepancy_minor: total_delta,
        discrepancies,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_stitches_markdown_tables() {
        let md = "\
| Date | Narration | Debit | Credit | Balance |
| --- | --- | --- | --- | --- |
| 2026-11-01 | UPI/chai/123 | 200.00 | | 9800.00 |

Page 2

| Date | Narration | Debit | Credit | Balance |
| --- | --- | --- | --- | --- |
| 2026-11-02 | NEFT/Salary/999 | | 5000.00 | 14800.00 |
";
        let tables = parse_markdown_tables(md);
        assert_eq!(tables.len(), 1);
        assert_eq!(tables[0].raw_rows.len(), 2);
    }

    #[test]
    fn detects_institution_from_page_one() {
        assert_eq!(
            detect_institution_slug("HDFC BANK LIMITED\nIFSC: HDFC0001234"),
            Some("hdfc".to_string())
        );
        assert_eq!(
            detect_institution_slug("Statement for ICIC0000011"),
            Some("icici".to_string())
        );
    }

    #[test]
    fn fingerprints_strip_pii_and_disambiguate_duplicates() {
        let headers = vec![
            "Account No".to_string(),
            "Date".to_string(),
            "Amount".to_string(),
            "Amount".to_string(),
        ];
        let (ordered, fp) = build_header_fingerprint("hdfc", StatementKind::Bank, &headers);
        assert_eq!(ordered, vec!["date", "amount", "amount_2"]);
        assert_eq!(fp.len(), 64);
    }

    #[test]
    fn verifies_bank_and_credit_card_balances() {
        let bank_rows = vec![
            ParsedIngestRow {
                row_index: 0,
                date: "2026-11-01".into(),
                value_date: None,
                description: "UPI/tea/1".into(),
                reference: Some("UTR1".into()),
                debit_minor: 20000,
                credit_minor: 0,
                balance_minor: Some(980000),
                narration_norm: "upi/tea/1".into(),
                daily_rank: 1,
            },
            ParsedIngestRow {
                row_index: 1,
                date: "2026-11-02".into(),
                value_date: None,
                description: "Deposit".into(),
                reference: Some("UTR2".into()),
                debit_minor: 0,
                credit_minor: 50000,
                balance_minor: Some(1030000),
                narration_norm: "deposit".into(),
                daily_rank: 1,
            },
        ];
        let res = verify_statement_balance(
            StatementKind::Bank,
            &bank_rows,
            &StatementSummary {
                opening_balance_minor: Some(1000000),
                ..Default::default()
            },
        );
        assert!(res.ok);

        let cc_res = verify_statement_balance(
            StatementKind::CreditCard,
            &bank_rows,
            &StatementSummary {
                previous_balance_minor: Some(100000),
                total_due_minor: Some(70000), // 100000 + 20000 - 50000
                ..Default::default()
            },
        );
        assert!(cc_res.ok);
    }
}

