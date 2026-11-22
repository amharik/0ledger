//! SQLite-authoritative persistence for the portable 0ledger engine.
//!
//! * WAL journal, foreign keys, and a `user_version` migration guard.
//! * Every mutation is wrapped in an atomic transaction.
//! * An append-only audit hash chain detects out-of-band tampering.
//! * A replication change log feeds the UI-agnostic sync crate.

pub mod error;
pub mod schema;
pub mod store;

pub use error::{StorageError, StorageResult};
pub use schema::{migrate, SCHEMA_VERSION};
pub use store::{
    now_iso, ApplyOutcome, ApplySummary, ImportBundle, ImportSummary, IntegrityIssue,
    IntegrityReport, Store,
};
