use crate::error::{StorageError, StorageResult};
use serde::Deserialize;
use surrealdb::engine::any::Any;
use surrealdb::Surreal;

pub const SCHEMA_VERSION: u32 = 2;

const MIGRATION_0001: &str = include_str!("../migrations/0001_init.surql");
const MIGRATION_0002: &str = include_str!("../migrations/0002_ingest.surql");

#[derive(Debug, Deserialize)]
struct MigrationRow {
    version: u32,
}

pub async fn migrate(db: &Surreal<Any>) -> StorageResult<()> {
    let res = db
        .query("SELECT version FROM _migrations ORDER BY version DESC LIMIT 1")
        .await;

    let current: u32 = match res {
        Ok(mut response) => {
            let rows: Vec<MigrationRow> = response.take(0).unwrap_or_default();
            rows.first().map(|r| r.version).unwrap_or(0)
        }
        Err(_) => 0,
    };

    if current > SCHEMA_VERSION {
        return Err(StorageError::SchemaTooNew {
            found: current,
            supported: SCHEMA_VERSION,
        });
    }

    if current < 1 {
        let script = format!(
            "BEGIN TRANSACTION;\n{}\nCREATE _migrations SET version = 1, name = '0001_init';\nCOMMIT TRANSACTION;",
            MIGRATION_0001
        );
        db.query(script).await?.check()?;
    }

    if current < 2 {
        let script = format!(
            "BEGIN TRANSACTION;\n{}\nCREATE _migrations SET version = 2, name = '0002_ingest';\nCOMMIT TRANSACTION;",
            MIGRATION_0002
        );
        db.query(script).await?.check()?;
    }

    Ok(())
}
