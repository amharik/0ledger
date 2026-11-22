//! UI-agnostic device-to-device synchronization.
//!
//! The protocol is intentionally independent of any presentation framework or
//! transport. A change log is sealed into an authenticated envelope with a
//! workspace sync key and can be moved over any byte channel (shared folder,
//! USB drive, LAN socket, or a future relay). Conflict resolution is
//! deterministic last-writer-wins on `(lamport, device_id)`.

pub mod change;
pub mod crypto;
pub mod transport;

pub use change::{merge_changes, Change, ChangeOp, ChangeSet, CHANGESET_SCHEMA_VERSION};
pub use crypto::{open, seal, SealedEnvelope, SyncKey};
pub use transport::{FileTransport, MemoryTransport, Transport};

use thiserror::Error;

#[derive(Debug, Error)]
pub enum SyncError {
    #[error("cryptographic failure: {0}")]
    Crypto(String),
    #[error("serialization failure: {0}")]
    Serialization(#[from] serde_json::Error),
    #[error("invalid sync key: {0}")]
    InvalidKey(String),
    #[error("unsupported envelope version: {0}")]
    UnsupportedVersion(u32),
    #[error("envelope authentication failed (wrong key or tampered payload)")]
    Tampered,
    #[error("transport error: {0}")]
    Transport(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

pub type SyncResult<T> = Result<T, SyncError>;
