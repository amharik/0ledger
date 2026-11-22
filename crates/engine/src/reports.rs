use crate::model::{Ledger, LedgerNature, Voucher, VoucherLine, VoucherStatus};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrialBalanceRow {
    pub ledger_id: String,
    pub name: String,
    pub tally_parent: String,
    pub nature: LedgerNature,
    pub opening_minor: i64,
    pub debit_minor: i64,
    pub credit_minor: i64,
    pub closing_minor: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TrialBalance {
    pub rows: Vec<TrialBalanceRow>,
    pub total_opening_minor: i64,
    pub total_debit_minor: i64,
    pub total_credit_minor: i64,
    pub balanced: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfitAndLossRow {
    pub ledger_id: String,
    pub name: String,
    pub nature: String,
    pub amount_minor: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProfitAndLoss {
    pub income: Vec<ProfitAndLossRow>,
    pub expenses: Vec<ProfitAndLossRow>,
    pub total_income_minor: i64,
    pub total_expense_minor: i64,
    pub net_profit_minor: i64,
}

/// Compute a trial balance from in-memory domain data.
///
/// Only `regular` vouchers are posted; optional and cancelled vouchers are
/// ignored so reports always reconcile with the posted ledger.
pub fn trial_balance(
    ledgers: &[Ledger],
    vouchers: &[Voucher],
    lines: &[VoucherLine],
) -> TrialBalance {
    let posted: BTreeSet<&str> = vouchers
        .iter()
        .filter(|v| v.status == VoucherStatus::Regular)
        .map(|v| v.id.as_str())
        .collect();

    let mut sums: BTreeMap<&str, (i64, i64)> = BTreeMap::new();
    for line in lines {
        if !posted.contains(line.voucher_id.as_str()) {
            continue;
        }
        let entry = sums.entry(line.ledger_id.as_str()).or_insert((0, 0));
        if line.amount_minor >= 0 {
            entry.0 = entry.0.saturating_add(line.amount_minor);
        } else {
            entry.1 = entry.1.saturating_add(-line.amount_minor);
        }
    }

    let mut rows: Vec<TrialBalanceRow> = ledgers
        .iter()
        .map(|ledger| {
            let (debit, credit) = sums.get(ledger.id.as_str()).copied().unwrap_or((0, 0));
            TrialBalanceRow {
                ledger_id: ledger.id.clone(),
                name: ledger.name.clone(),
                tally_parent: ledger.tally_parent.as_str().to_string(),
                nature: ledger.nature,
                opening_minor: ledger.opening_balance_minor,
                debit_minor: debit,
                credit_minor: credit,
                closing_minor: ledger
                    .opening_balance_minor
                    .saturating_add(debit)
                    .saturating_sub(credit),
            }
        })
        .collect();

    rows.sort_by(|a, b| {
        a.tally_parent
            .cmp(&b.tally_parent)
            .then_with(|| a.name.cmp(&b.name))
    });

    let total_opening_minor = rows
        .iter()
        .fold(0_i64, |acc, r| acc.saturating_add(r.opening_minor));
    let total_debit_minor = rows.iter().fold(0_i64, |acc, r| {
        if r.closing_minor > 0 {
            acc.saturating_add(r.closing_minor)
        } else {
            acc
        }
    });
    let total_credit_minor = rows.iter().fold(0_i64, |acc, r| {
        if r.closing_minor < 0 {
            acc.saturating_add(-r.closing_minor)
        } else {
            acc
        }
    });

    TrialBalance {
        rows,
        total_opening_minor,
        total_debit_minor,
        total_credit_minor,
        balanced: total_debit_minor == total_credit_minor,
    }
}

pub fn profit_and_loss(
    ledgers: &[Ledger],
    vouchers: &[Voucher],
    lines: &[VoucherLine],
) -> ProfitAndLoss {
    let tb = trial_balance(ledgers, vouchers, lines);
    let mut income = Vec::new();
    let mut expenses = Vec::new();

    for row in &tb.rows {
        match row.nature {
            LedgerNature::Income => {
                let amount = -row.closing_minor;
                if amount != 0 {
                    income.push(ProfitAndLossRow {
                        ledger_id: row.ledger_id.clone(),
                        name: row.name.clone(),
                        nature: "income".to_string(),
                        amount_minor: amount,
                    });
                }
            }
            LedgerNature::Expense if row.closing_minor != 0 => {
                expenses.push(ProfitAndLossRow {
                    ledger_id: row.ledger_id.clone(),
                    name: row.name.clone(),
                    nature: "expense".to_string(),
                    amount_minor: row.closing_minor,
                });
            }
            _ => {}
        }
    }

    let total_income_minor = income
        .iter()
        .fold(0_i64, |a, r| a.saturating_add(r.amount_minor));
    let total_expense_minor = expenses
        .iter()
        .fold(0_i64, |a, r| a.saturating_add(r.amount_minor));

    ProfitAndLoss {
        income,
        expenses,
        total_income_minor,
        total_expense_minor,
        net_profit_minor: total_income_minor.saturating_sub(total_expense_minor),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{TallyPrimaryGroup, VoucherSource, VoucherType};

    fn ledger(id: &str, nature: LedgerNature, opening: i64) -> Ledger {
        Ledger {
            id: id.to_string(),
            workspace_id: "ws_1".to_string(),
            name: id.to_string(),
            tally_parent: TallyPrimaryGroup::IndirectExpenses,
            nature,
            opening_balance_minor: opening,
            is_party: false,
            is_bank: false,
            is_tax: false,
            billwise: false,
            archived: false,
            created_at: "2025-04-01T00:00:00Z".to_string(),
            updated_at: "2025-04-01T00:00:00Z".to_string(),
        }
    }

    fn voucher(id: &str, status: VoucherStatus) -> Voucher {
        Voucher {
            id: id.to_string(),
            workspace_id: "ws_1".to_string(),
            voucher_type: VoucherType::Journal,
            number: id.to_string(),
            date: "2025-04-01".to_string(),
            status,
            currency: "INR".to_string(),
            party_ledger_id: None,
            invoice_number: None,
            narration: None,
            round_off_amount_minor: 0,
            round_off_ledger_id: None,
            source: VoucherSource::Manual,
            created_at: "2025-04-01T00:00:00Z".to_string(),
            updated_at: "2025-04-01T00:00:00Z".to_string(),
        }
    }

    fn line(id: &str, voucher: &str, ledger: &str, amount: i64) -> VoucherLine {
        VoucherLine {
            id: id.to_string(),
            voucher_id: voucher.to_string(),
            workspace_id: "ws_1".to_string(),
            line_no: 1,
            ledger_id: ledger.to_string(),
            amount_minor: amount,
            currency: "INR".to_string(),
            narration: None,
        }
    }

    #[test]
    fn trial_balance_ignores_cancelled_vouchers() {
        let ledgers = vec![
            ledger("cash", LedgerNature::Asset, 0),
            ledger("sales", LedgerNature::Income, 0),
        ];
        let vouchers = vec![
            voucher("v1", VoucherStatus::Regular),
            voucher("v2", VoucherStatus::Cancelled),
        ];
        let lines = vec![
            line("l1", "v1", "cash", 1000),
            line("l2", "v1", "sales", -1000),
            line("l3", "v2", "cash", 500),
            line("l4", "v2", "sales", -500),
        ];
        let tb = trial_balance(&ledgers, &vouchers, &lines);
        assert!(tb.balanced);
        assert_eq!(tb.total_debit_minor, 1000);
        assert_eq!(tb.total_credit_minor, 1000);
    }

    #[test]
    fn profit_and_loss_nets_income_and_expense() {
        let ledgers = vec![
            ledger("sales", LedgerNature::Income, 0),
            ledger("rent", LedgerNature::Expense, 0),
        ];
        let vouchers = vec![voucher("v1", VoucherStatus::Regular)];
        let lines = vec![
            line("l1", "v1", "rent", 200),
            line("l2", "v1", "sales", -200),
        ];
        let pnl = profit_and_loss(&ledgers, &vouchers, &lines);
        assert_eq!(pnl.total_income_minor, 200);
        assert_eq!(pnl.total_expense_minor, 200);
        assert_eq!(pnl.net_profit_minor, 0);
    }
}
