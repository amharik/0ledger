use thiserror::Error;

#[derive(Debug, Error)]
pub enum StorageError {
    #[error("surrealdb error: {0}")]
    Surreal(#[from] surrealdb::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("engine error: {0}")]
    Engine(#[from] zeroledger_engine::EngineError),
    #[error("sync error: {0}")]
    Sync(#[from] zeroledger_sync::SyncError),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("validation failed: {0}")]
    Validation(String),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("corrupt data: {0}")]
    Corrupt(String),
    #[error(
        "schema version {found} is newer than supported version {supported}; refusing to downgrade"
    )]
    SchemaTooNew { found: u32, supported: u32 },
    #[error("backup target already exists: {0}")]
    BackupExists(String),
}

pub type StorageResult<T> = Result<T, StorageError>;
