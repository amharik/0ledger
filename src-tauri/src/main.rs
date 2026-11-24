// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod engine_commands;

use commands::*;
use engine_commands::*;
use tauri::Emitter;

#[tauri::command]
fn get_default_folders() -> FolderDefaults {
    get_default_folders_impl()
}

#[tauri::command]
fn scan_inbox_folder(folder_path: String) -> Result<Vec<DiscoveredFile>, String> {
    scan_inbox_folder_impl(&folder_path)
}

#[tauri::command]
fn read_file_base64(file_path: String) -> Result<String, String> {
    read_file_base64_impl(&file_path)
}

#[tauri::command]
fn organize_accounting_file(req: OrganizeRequest) -> Result<String, String> {
    organize_accounting_file_impl(req)
}

#[tauri::command]
fn save_email_eml(req: SaveEmailRequest) -> Result<SavedEmailResult, String> {
    save_email_eml_impl(req)
}

#[tauri::command]
fn save_email_file(req: SaveEmailFileRequest) -> Result<SavedEmailResult, String> {
    save_email_file_impl(req)
}

#[tauri::command]
async fn extract_pdf_markdown(req: PdfMarkdownRequest) -> Result<PdfMarkdownResult, String> {
    tauri::async_runtime::spawn_blocking(move || extract_pdf_markdown_impl(req))
        .await
        .map_err(|e| format!("PDF parse task error: {}", e))?
}

#[tauri::command]
async fn extract_pdf_layout(req: PdfMarkdownRequest) -> Result<PdfLayoutResult, String> {
    tauri::async_runtime::spawn_blocking(move || extract_pdf_layout_impl(req))
        .await
        .map_err(|e| format!("PDF layout task error: {}", e))?
}

#[tauri::command]
async fn ocr_pdf_with_docling(req: PdfMarkdownRequest) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || ocr_pdf_with_docling_impl(req))
        .await
        .map_err(|e| format!("Docling OCR task error: {}", e))?
}

#[tauri::command]
async fn imap_test_connection(config: ImapConfig) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        imap_test_connection_impl(config)
    })
    .await
    .map_err(|e| format!("Connection test task error: {}", e))?
}

#[tauri::command]
async fn imap_fetch_messages(
    app: tauri::AppHandle,
    config: ImapConfig,
    query: ImapQuery,
) -> Result<Vec<ImapMessageResult>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        imap_fetch_messages_impl(config, query, Some(&|payload| {
            let _ = app.emit("mail-sync-progress", payload);
        }))
    })
    .await
    .map_err(|e| format!("Mail fetch task error: {}", e))?
}

#[tauri::command]
async fn keyring_store_credential(service: String, account: String, secret: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        keyring_store_credential_impl(&service, &account, &secret)
    })
    .await
    .map_err(|e| format!("Keyring store task error: {}", e))?
}

#[tauri::command]
async fn keyring_get_credential(service: String, account: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        keyring_get_credential_impl(&service, &account)
    })
    .await
    .map_err(|e| format!("Keyring get task error: {}", e))?
}

#[tauri::command]
async fn keyring_delete_credential(service: String, account: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        keyring_delete_credential_impl(&service, &account)
    })
    .await
    .map_err(|e| format!("Keyring delete task error: {}", e))?
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            engine_commands::init(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_default_folders,
            scan_inbox_folder,
            read_file_base64,
            organize_accounting_file,
            save_email_eml,
            save_email_file,
            extract_pdf_markdown,
            extract_pdf_layout,
            ocr_pdf_with_docling,
            imap_test_connection,
            imap_fetch_messages,
            keyring_store_credential,
            keyring_get_credential,
            keyring_delete_credential,
            engine_version,
            store_device_id,
            store_schema_version,
            store_list_ledgers,
            store_list_vouchers,
            store_trial_balance,
            store_profit_and_loss,
            store_integrity_check,
            store_post_voucher,
            store_import_bundle,
            store_delete_entity,
            store_backup,
            sync_generate_key,
            sync_export_envelope,
            sync_import_envelope
        ])
        .run(tauri::generate_context!())
        .expect("error while running 0ledger desktop application");
}

