//! Portable double-entry financial engine.
//!
//! This crate deliberately has no dependency on a database, a UI toolkit, a
//! network stack, or an FFI layer. Desktop (Tauri), mobile (Kotlin/Swift), CLI
//! and server shells all consume the same rules from here.
//!
//! Invariants enforced by this crate:
//! * money is always integer minor units (`i64`, paise for INR);
//! * every posted voucher balances to zero per currency;
//! * round-off is explicit and posted to a round-off ledger;
//! * financial years are derived from an explicit start month.

pub mod error;
pub mod model;
pub mod money;
pub mod reports;
pub mod validation;

pub use error::{EngineError, EngineResult};
pub use model::*;
pub use money::{
    allocate_minor, format_minor, minor_to_decimal_string, parse_amount_to_minor,
    round_off_difference, round_to_step, Minor, RoundingMode,
};
pub use reports::{
    profit_and_loss, trial_balance, ProfitAndLoss, ProfitAndLossRow, TrialBalance, TrialBalanceRow,
};
pub use validation::{
    check_tally_readiness, compute_totals, validate_line_balance, validate_new_voucher,
    IssueSeverity, TallyReadinessInput, ValidationIssue, ValidationResult, VoucherTotals,
};

/// Semantic version of the portable engine, surfaced to native shells.
pub const ENGINE_VERSION: &str = env!("CARGO_PKG_VERSION");
