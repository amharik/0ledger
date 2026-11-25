//! SurrealDB (`Surreal<SurrealKv>`)-authoritative persistence for the portable 0ledger engine.
//!
//! * Embedded SurrealKV with `.versioned()` point-in-time audit snapshots (`VERSION`).
//! * Local-only ingestion staging (`ingest_batch`, `extracted_table`, `statement_template`).
//! * Graph ledger (`ledger`, `party`, `bank_account` connected by `flow` `TYPE RELATION`).
//! * An append-only audit hash chain detects out-of-band tampering.
//! * A replication change log feeds the UI-agnostic sync crate.

pub mod error;
pub mod schema;
pub mod store;

pub use error::{StorageError, StorageResult};
pub use schema::{migrate, SCHEMA_VERSION};
pub use store::{
    now_iso, ApplyOutcome, ApplySummary, AuditPatchInput, FlowStatementRow, ForcePostInput,
    GraphTrialBalanceRow, ImportBundle, ImportSummary, IngestBatchDto, IntegrityIssue,
    IntegrityReport, StatementTemplateDto, Store,
};
