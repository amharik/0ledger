// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;

use commands::*;
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
fn imap_test_connection(config: ImapConfig) -> Result<bool, String> {
    imap_test_connection_impl(config)
}

#[tauri::command]
fn imap_fetch_messages(
    app: tauri::AppHandle,
    config: ImapConfig,
    query: ImapQuery,
) -> Result<Vec<ImapMessageResult>, String> {
    imap_fetch_messages_impl(config, query, Some(&|payload| {
        let _ = app.emit("mail-sync-progress", payload);
    }))
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            get_default_folders,
            scan_inbox_folder,
            read_file_base64,
            organize_accounting_file,
            save_email_eml,
            imap_test_connection,
            imap_fetch_messages
        ])
        .run(tauri::generate_context!())
        .expect("error while running 0ledger desktop application");
}

