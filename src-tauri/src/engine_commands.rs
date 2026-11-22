//! Tauri command surface for the portable engine.
//!
//! The desktop shell is intentionally thin: every financial rule lives in
//! `zeroledger-engine`, persistence in `zeroledger-storage`, and replication in
//! `zeroledger-sync`. Mobile shells call the same code through UniFFI.

use std::sync::Mutex;
use tauri::{Manager, State};
use zeroledger_engine::{Ledger, NewVoucher, ProfitAndLoss, TrialBalance, Voucher};
use zeroledger_storage::{ApplySummary, ImportBundle, ImportSummary, IntegrityReport, Store};
use zeroledger_sync::SyncKey;

pub struct EngineState(pub Mutex<Store>);

fn lock<'a>(
    state: &'a State<'_, EngineState>,
) -> Result<std::sync::MutexGuard<'a, Store>, String> {
    state
        .0
        .lock()
        .map_err(|_| "store lock poisoned".to_string())
}

pub fn init(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let dir = app.path().app_data_dir()?;
    std::fs::create_dir_all(&dir)?;
    let db_path = dir.join("0ledger.sqlite3");
    let store = Store::open(&db_path)?;
    app.manage(EngineState(Mutex::new(store)));
    Ok(())
}

#[tauri::command]
pub fn engine_version() -> String {
    zeroledger_engine::ENGINE_VERSION.to_string()
}

#[tauri::command]
pub fn store_device_id(state: State<'_, EngineState>) -> Result<String, String> {
    Ok(lock(&state)?.device_id().to_string())
}

#[tauri::command]
pub fn store_schema_version(state: State<'_, EngineState>) -> Result<u32, String> {
    lock(&state)?.schema_version().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn store_list_ledgers(
    state: State<'_, EngineState>,
    workspace_id: String,
) -> Result<Vec<Ledger>, String> {
    lock(&state)?
        .list_ledgers(&workspace_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn store_list_vouchers(
    state: State<'_, EngineState>,
    workspace_id: String,
) -> Result<Vec<Voucher>, String> {
    lock(&state)?
        .list_vouchers(&workspace_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn store_trial_balance(
    state: State<'_, EngineState>,
    workspace_id: String,
) -> Result<TrialBalance, String> {
    lock(&state)?
        .trial_balance(&workspace_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn store_profit_and_loss(
    state: State<'_, EngineState>,
    workspace_id: String,
) -> Result<ProfitAndLoss, String> {
    lock(&state)?
        .profit_and_loss(&workspace_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn store_integrity_check(
    state: State<'_, EngineState>,
    workspace_id: String,
) -> Result<IntegrityReport, String> {
    lock(&state)?
        .integrity_check(&workspace_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn store_post_voucher(
    state: State<'_, EngineState>,
    voucher_json: String,
) -> Result<(), String> {
    let input: NewVoucher = serde_json::from_str(&voucher_json).map_err(|e| e.to_string())?;
    lock(&state)?.post_voucher(&input).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn store_import_bundle(
    state: State<'_, EngineState>,
    bundle_json: String,
) -> Result<ImportSummary, String> {
    let bundle: ImportBundle = serde_json::from_str(&bundle_json).map_err(|e| e.to_string())?;
    lock(&state)?
        .import_bundle(&bundle)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn store_backup(state: State<'_, EngineState>, path: String) -> Result<(), String> {
    lock(&state)?.backup_to(path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sync_generate_key() -> Result<String, String> {
    SyncKey::generate()
        .map(|key| key.to_base64())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sync_export_envelope(
    state: State<'_, EngineState>,
    key: String,
    since_lamport: u64,
) -> Result<String, String> {
    let key = SyncKey::from_base64(&key).map_err(|e| e.to_string())?;
    lock(&state)?
        .export_sync_envelope(&key, since_lamport)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sync_import_envelope(
    state: State<'_, EngineState>,
    key: String,
    envelope_json: String,
) -> Result<ApplySummary, String> {
    let key = SyncKey::from_base64(&key).map_err(|e| e.to_string())?;
    lock(&state)?
        .import_sync_envelope(&key, &envelope_json)
        .map_err(|e| e.to_string())
}
