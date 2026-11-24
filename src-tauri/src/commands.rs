use base64::Engine;
use imap::Session;
use native_tls::TlsConnector;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};
use walkdir::WalkDir;

#[derive(Debug, Serialize, Deserialize)]
pub struct FolderDefaults {
    pub watch_folder: String,
    pub archive_folder: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DiscoveredFile {
    pub path: String,
    pub filename: String,
    pub extension: String,
    pub size_bytes: u64,
    pub modified_ms: u64,
    pub sha256: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct OrganizeRequest {
    pub source_path: String,
    pub archive_root: String,
    pub company_name: String,
    pub financial_year: String,
    pub period_month: String,
    pub category: String,
    pub action: Option<String>, // "move" (default) or "copy"
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SaveEmailRequest {
    pub archive_root: String,
    pub company_name: String,
    pub financial_year: String,
    pub period_month: String,
    pub subject: String,
    pub uid: u32,
    pub date: String,
    pub raw_base64: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SaveEmailFileRequest {
    pub archive_root: String,
    pub company_name: String,
    pub financial_year: String,
    pub period_month: String,
    pub subfolder: String,
    pub file_name: String,
    pub bytes_base64: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PdfMarkdownRequest {
    pub bytes_base64: String,
    #[serde(default)]
    pub password: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PdfMarkdownResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub markdown: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl PdfMarkdownResult {
    fn ok(markdown: String) -> Self {
        Self {
            markdown: Some(markdown),
            code: None,
            error: None,
        }
    }

    fn failed(code: &str, error: String) -> Self {
        Self {
            markdown: None,
            code: Some(code.to_string()),
            error: Some(error),
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PdfTextItem {
    pub text: String,
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    pub page: u32,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PdfLayoutResult {
    pub items: Vec<PdfTextItem>,
    pub page_count: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl PdfLayoutResult {
    fn ok(items: Vec<PdfTextItem>, page_count: u32) -> Self {
        Self {
            items,
            page_count,
            code: None,
            error: None,
        }
    }

    fn failed(code: &str, error: String) -> Self {
        Self {
            items: Vec::new(),
            page_count: 0,
            code: Some(code.to_string()),
            error: Some(error),
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SavedEmailResult {
    pub file_path: String,
    pub file_name: String,
    pub size_bytes: u64,
    pub sha256: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ImapConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
    pub mailbox: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ImapQuery {
    pub preset: Option<String>, // "fastag" | "bank" | "shopping" | "all" | "custom"
    pub custom_search: Option<String>,
    pub limit: Option<usize>,
    pub days: Option<u32>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ImapMessageResult {
    pub uid: u32,
    pub uid_validity: Option<u32>,
    pub mailbox: String,
    pub subject: String,
    pub from: String,
    pub date: String,
    pub raw_base64: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MailProgressPayload {
    pub stage: String, // "connecting" | "authenticating" | "searching" | "filtering" | "fetching" | "complete"
    pub current: usize,
    pub total: usize,
    pub percent: u8,
    pub message: String,
}

fn sanitize_path_segment(name: &str) -> String {
    name.chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '_' })
        .collect::<String>()
        .trim_matches('_')
        .to_string()
}

pub fn get_default_folders_impl() -> FolderDefaults {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/home"));
    let downloads = dirs::download_dir().unwrap_or_else(|| home.join("Downloads"));
    let archive = home.join("0ledger").join("Archive");

    FolderDefaults {
        watch_folder: downloads.to_string_lossy().to_string(),
        archive_folder: archive.to_string_lossy().to_string(),
    }
}

pub fn scan_inbox_folder_impl(folder_path: &str) -> Result<Vec<DiscoveredFile>, String> {
    let path = Path::new(folder_path);
    if !path.exists() {
        return Err(format!("Folder does not exist: {}", folder_path));
    }
    if !path.is_dir() {
        return Err(format!("Path is not a directory: {}", folder_path));
    }

    let mut files = Vec::new();
    let supported_exts = ["pdf", "csv", "xlsx", "xls", "eml", "msg", "png", "jpg", "jpeg", "txt"];

    for entry in WalkDir::new(path)
        .max_depth(2)
        .follow_links(false)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        if entry.file_type().is_file() {
            let file_path = entry.path();
            let ext = file_path
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_lowercase();

            if supported_exts.contains(&ext.as_str()) {
                if let Ok(metadata) = entry.metadata() {
                    let size_bytes = metadata.len();
                    if size_bytes == 0 || size_bytes > 50 * 1024 * 1024 {
                        continue; // skip empty or > 50MB files
                    }

                    let modified_ms = metadata
                        .modified()
                        .ok()
                        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
                        .map(|d| d.as_millis() as u64)
                        .unwrap_or(0);

                    // Calculate sha256
                    let sha256 = match fs::read(file_path) {
                        Ok(bytes) => {
                            let mut hasher = Sha256::new();
                            hasher.update(&bytes);
                            format!("{:x}", hasher.finalize())
                        }
                        Err(_) => continue,
                    };

                    files.push(DiscoveredFile {
                        path: file_path.to_string_lossy().to_string(),
                        filename: file_path
                            .file_name()
                            .and_then(|n| n.to_str())
                            .unwrap_or("file")
                            .to_string(),
                        extension: ext,
                        size_bytes,
                        modified_ms,
                        sha256,
                    });
                }
            }
        }
    }

    // Sort newest first
    files.sort_by_key(|a| std::cmp::Reverse(a.modified_ms));
    Ok(files)
}

pub fn read_file_base64_impl(file_path: &str) -> Result<String, String> {
    let path = Path::new(file_path);
    // Security check 1: Reject path traversal
    for component in path.components() {
        if matches!(component, std::path::Component::ParentDir) {
            return Err("Access denied: path traversal (..) is not permitted".to_string());
        }
    }

    // Security check 2: Whitelist allowed extensions for financial/document ingest
    let allowed_exts = [
        "pdf", "csv", "xlsx", "xls", "eml", "txt", "json", "xml", "ofx", "qif", "png", "jpg", "jpeg", "tiff",
    ];
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    if !allowed_exts.contains(&ext.as_str()) {
        return Err(format!(
            "Access denied: file extension '.{}' is not permitted for ingest",
            ext
        ));
    }

    // Security check 3: Max file size (50 MB)
    let metadata = fs::metadata(path).map_err(|e| format!("Failed to inspect file: {}", e))?;
    if metadata.len() > 50 * 1024 * 1024 {
        return Err("File exceeds 50 MB limit".to_string());
    }

    let bytes = fs::read(file_path).map_err(|e| format!("Failed to read file: {}", e))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

pub fn organize_accounting_file_impl(req: OrganizeRequest) -> Result<String, String> {
    let source = Path::new(&req.source_path);
    if !source.exists() {
        return Err(format!("Source file does not exist: {}", req.source_path));
    }

    let company = sanitize_path_segment(&req.company_name);
    let fy = sanitize_path_segment(&req.financial_year);
    let period = sanitize_path_segment(&req.period_month);
    let category = sanitize_path_segment(&req.category);

    let target_dir = Path::new(&req.archive_root)
        .join(if company.is_empty() { "General" } else { &company })
        .join(if fy.is_empty() { "FY_Current" } else { &fy })
        .join(if period.is_empty() { "Current" } else { &period })
        .join(if category.is_empty() { "Unclassified" } else { &category });

    fs::create_dir_all(&target_dir)
        .map_err(|e| format!("Failed to create archive directory {}: {}", target_dir.display(), e))?;

    let filename = source
        .file_name()
        .ok_or_else(|| "Source file has no name".to_string())?;

    let mut dest = target_dir.join(filename);
    if dest.exists() && dest != source {
        let stem = source.file_stem().and_then(|s| s.to_str()).unwrap_or("file");
        let ext = source.extension().and_then(|e| e.to_str()).unwrap_or("");
        let timestamp = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let new_name = if ext.is_empty() {
            format!("{}_{}", stem, timestamp)
        } else {
            format!("{}_{}.{}", stem, timestamp, ext)
        };
        dest = target_dir.join(new_name);
    }

    let action = req.action.as_deref().unwrap_or("move");
    if action == "copy" {
        fs::copy(source, &dest).map_err(|e| format!("Failed to copy file: {}", e))?;
    } else {
        // Try move (rename); fallback to copy + delete if crossing filesystems
        if fs::rename(source, &dest).is_err() {
            fs::copy(source, &dest).map_err(|e| format!("Failed to copy file during move: {}", e))?;
            let _ = fs::remove_file(source);
        }
    }

    Ok(dest.to_string_lossy().to_string())
}

fn decrypt_pdf(bytes: &[u8], password: Option<&str>) -> Result<Vec<u8>, String> {
    let Some(password) = password.filter(|value| !value.is_empty()) else {
        return Ok(bytes.to_vec());
    };
    let mut document =
        lopdf::Document::load_mem_with_options(bytes, lopdf::LoadOptions::with_password(password))
            .map_err(|error| format!("PDF password or decryption failed: {}", error))?;
    let mut output = Vec::new();
    document
        .save_to(&mut output)
        .map_err(|error| format!("Could not serialize decrypted PDF: {}", error))?;
    Ok(output)
}

pub fn extract_pdf_markdown_impl(req: PdfMarkdownRequest) -> Result<PdfMarkdownResult, String> {
    let bytes = match base64::engine::general_purpose::STANDARD.decode(&req.bytes_base64) {
        Ok(bytes) => bytes,
        Err(error) => {
            return Ok(PdfMarkdownResult::failed(
                "decode",
                format!("Base64 decode error: {}", error),
            ));
        }
    };
    let decrypted = match decrypt_pdf(&bytes, req.password.as_deref()) {
        Ok(bytes) => bytes,
        Err(error) => return Ok(PdfMarkdownResult::failed("decrypt", error)),
    };

    match anydoc::to_markdown_bytes(&decrypted, Some(anydoc::Format::Pdf)) {
        Ok(markdown) => Ok(PdfMarkdownResult::ok(markdown)),
        Err(error) => Ok(PdfMarkdownResult::failed(error.code(), error.to_string())),
    }
}

/// Extract positioned text runs. This keeps column geometry intact for
/// borderless statement tables that a generic Markdown conversion flattens.
pub fn extract_pdf_layout_impl(req: PdfMarkdownRequest) -> Result<PdfLayoutResult, String> {
    let bytes = match base64::engine::general_purpose::STANDARD.decode(&req.bytes_base64) {
        Ok(bytes) => bytes,
        Err(error) => {
            return Ok(PdfLayoutResult::failed(
                "decode",
                format!("Base64 decode error: {}", error),
            ));
        }
    };
    let decrypted = match decrypt_pdf(&bytes, req.password.as_deref()) {
        Ok(bytes) => bytes,
        Err(error) => return Ok(PdfLayoutResult::failed("decrypt", error)),
    };

    match pdf_inspector::extract_text_with_positions_mem(&decrypted) {
        Ok(items) => {
            let mut page_count = 0;
            let text_items: Vec<PdfTextItem> = items
                .into_iter()
                .filter(|item| {
                    matches!(item.item_type, pdf_inspector::types::ItemType::Text)
                        && !item.text.trim().is_empty()
                })
                .map(|item| {
                    page_count = page_count.max(item.page);
                    PdfTextItem {
                        text: item.text,
                        x: item.x,
                        y: item.y,
                        width: item.width,
                        height: item.height,
                        page: item.page,
                    }
                })
                .collect();
            Ok(PdfLayoutResult::ok(text_items, page_count))
        }
        Err(error) => Ok(PdfLayoutResult::failed("pdfInspector", error.to_string())),
    }
}

fn docling_candidates() -> Vec<(String, bool)> {
    let mut candidates = Vec::new();
    if let Ok(bin) = std::env::var("DOCLING_BIN") {
        let bin = bin.trim();
        if !bin.is_empty() {
            candidates.push((bin.to_string(), false));
        }
    }
    candidates.push(("docling".to_string(), false));
    if let Ok(home) = std::env::var("HOME") {
        candidates.push((format!("{home}/.local/bin/docling"), false));
    }
    candidates.push(("/usr/local/bin/docling".to_string(), false));
    candidates.push(("/usr/bin/docling".to_string(), false));
    candidates.push(("python3".to_string(), true));
    candidates.push(("python".to_string(), true));
    candidates
}

fn find_markdown_file(root: &Path) -> Option<PathBuf> {
    WalkDir::new(root)
        .into_iter()
        .filter_map(Result::ok)
        .map(|entry| entry.into_path())
        .find(|path| path.extension().and_then(|ext| ext.to_str()) == Some("md"))
}

pub fn ocr_pdf_with_docling_impl(req: PdfMarkdownRequest) -> Result<String, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&req.bytes_base64)
        .map_err(|e| format!("Base64 decode error: {}", e))?;
    let bytes = decrypt_pdf(&bytes, req.password.as_deref())?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let temp_dir = std::env::temp_dir().join(format!("0ledger_docling_{}_{}", std::process::id(), stamp));
    let output_dir = temp_dir.join("out");
    fs::create_dir_all(&output_dir).map_err(|e| format!("Could not create docling temp dir: {}", e))?;
    let pdf_path = temp_dir.join("statement.pdf");
    fs::write(&pdf_path, &bytes).map_err(|e| format!("Could not write PDF for docling: {}", e))?;

    let result = (|| {
        let mut errors = Vec::new();
        for (program, python_module) in docling_candidates() {
            let mut command = Command::new(&program);
            if python_module {
                command.arg("-m").arg("docling");
            }
            command
                .arg("convert")
                .arg(&pdf_path)
                .arg("--from")
                .arg("pdf")
                .arg("--to")
                .arg("md")
                .arg("--output")
                .arg(&output_dir)
                .arg("--ocr");
            match command.output() {
                Ok(output) if output.status.success() => {
                    if let Some(markdown_path) = find_markdown_file(&output_dir) {
                        return fs::read_to_string(&markdown_path)
                            .map_err(|e| format!("Could not read docling Markdown: {}", e));
                    }
                    errors.push(format!("{} produced no Markdown file", program));
                }
                Ok(output) => {
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    let stdout = String::from_utf8_lossy(&output.stdout);
                    let detail = if stderr.trim().is_empty() { stdout } else { stderr };
                    errors.push(format!(
                        "{} failed ({}): {}",
                        program,
                        output.status,
                        detail.trim().chars().take(1000).collect::<String>()
                    ));
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    errors.push(format!("{} not found", program));
                }
                Err(error) => {
                    errors.push(format!("{} could not run: {}", program, error));
                }
            }
        }
        Err(format!(
            "Docling OCR is not available. Install it with `pip install docling` or set DOCLING_BIN. {}",
            errors.join(" | ")
        ))
    })();

    let _ = fs::remove_dir_all(&temp_dir);
    result
}

pub fn save_email_file_impl(req: SaveEmailFileRequest) -> Result<SavedEmailResult, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&req.bytes_base64)
        .map_err(|e| format!("Base64 decode error: {}", e))?;

    let company = sanitize_path_segment(&req.company_name);
    let fy = sanitize_path_segment(&req.financial_year);
    let period = sanitize_path_segment(&req.period_month);
    let subfolder = sanitize_path_segment(&req.subfolder);

    let target_dir = Path::new(&req.archive_root)
        .join(if company.is_empty() { "General" } else { &company })
        .join(if fy.is_empty() { "FY_Current" } else { &fy })
        .join(if period.is_empty() { "Current" } else { &period })
        .join("Emails")
        .join(if subfolder.is_empty() { "Attachments" } else { &subfolder });

    fs::create_dir_all(&target_dir)
        .map_err(|e| format!("Failed to create email archive directory {}: {}", target_dir.display(), e))?;

    let clean_name = sanitize_path_segment(&req.file_name);
    let file_name = if clean_name.is_empty() { "attachment.bin".to_string() } else { clean_name };
    let dest = target_dir.join(&file_name);
    fs::write(&dest, &bytes).map_err(|e| format!("Failed to write email attachment: {}", e))?;

    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    let sha256 = format!("{:x}", hasher.finalize());

    Ok(SavedEmailResult {
        file_path: dest.to_string_lossy().to_string(),
        file_name,
        size_bytes: bytes.len() as u64,
        sha256,
    })
}

pub fn save_email_eml_impl(req: SaveEmailRequest) -> Result<SavedEmailResult, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&req.raw_base64)
        .map_err(|e| format!("Base64 decode error: {}", e))?;

    let company = sanitize_path_segment(&req.company_name);
    let fy = sanitize_path_segment(&req.financial_year);
    let period = sanitize_path_segment(&req.period_month);

    let target_dir = Path::new(&req.archive_root)
        .join(if company.is_empty() { "General" } else { &company })
        .join(if fy.is_empty() { "FY_Current" } else { &fy })
        .join(if period.is_empty() { "Current" } else { &period })
        .join("Emails");

    fs::create_dir_all(&target_dir)
        .map_err(|e| format!("Failed to create email archive directory {}: {}", target_dir.display(), e))?;

    let clean_date = sanitize_path_segment(&req.date);
    let clean_sub = sanitize_path_segment(&req.subject);
    let safe_sub = if clean_sub.is_empty() {
        "email".to_string()
    } else {
        clean_sub.chars().take(40).collect::<String>()
    };
    let file_name = format!(
        "{}_{}_{}.eml",
        if clean_date.is_empty() { "msg" } else { &clean_date },
        safe_sub,
        req.uid
    );

    let dest = target_dir.join(&file_name);
    fs::write(&dest, &bytes).map_err(|e| format!("Failed to write .eml file: {}", e))?;

    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    let sha256 = format!("{:x}", hasher.finalize());

    Ok(SavedEmailResult {
        file_path: dest.to_string_lossy().to_string(),
        file_name,
        size_bytes: bytes.len() as u64,
        sha256,
    })
}

// IMAP Implementation
fn connect_imap(config: &ImapConfig) -> Result<Session<native_tls::TlsStream<std::net::TcpStream>>, String> {
    let tls = TlsConnector::builder()
        .build()
        .map_err(|e| format!("TLS builder error: {}", e))?;

    let socket_addrs: Vec<std::net::SocketAddr> = std::net::ToSocketAddrs::to_socket_addrs(&(config.host.as_str(), config.port))
        .map_err(|e| format!("DNS resolution failed for {}: {}", config.host, e))?
        .collect();

    if socket_addrs.is_empty() {
        return Err(format!("Could not resolve address for {}:{}", config.host, config.port));
    }

    let timeout = std::time::Duration::from_secs(12);
    let mut last_err = String::new();
    let mut connected_stream = None;

    for addr in socket_addrs {
        match std::net::TcpStream::connect_timeout(&addr, timeout) {
            Ok(stream) => {
                connected_stream = Some(stream);
                break;
            }
            Err(e) => {
                last_err = format!("{}: {}", addr, e);
            }
        }
    }

    let tcp_stream = connected_stream.ok_or_else(|| {
        format!("Could not connect to {}:{}: {}", config.host, config.port, last_err)
    })?;

    let _ = tcp_stream.set_read_timeout(Some(std::time::Duration::from_secs(25)));
    let _ = tcp_stream.set_write_timeout(Some(std::time::Duration::from_secs(15)));

    let tls_stream = tls
        .connect(&config.host, tcp_stream)
        .map_err(|e| format!("TLS handshake error with {}:{}: {}", config.host, config.port, e))?;

    let client = imap::Client::new(tls_stream);

    let session = client
        .login(&config.username, &config.password)
        .map_err(|e| format!("IMAP login failed for {}: {}", config.username, e.0))?;

    Ok(session)
}

pub fn imap_test_connection_impl(config: ImapConfig) -> Result<bool, String> {
    let mut session = connect_imap(&config)?;
    let mailbox = config.mailbox.as_deref().unwrap_or("INBOX");
    session
        .select(mailbox)
        .map_err(|e| format!("Failed to select mailbox {}: {}", mailbox, e))?;
    session.logout().map_err(|e| format!("IMAP logout error: {}", e))?;
    Ok(true)
}

fn matches_preset(preset: &str, subject: &str, from: &str) -> bool {
    let s = subject.to_lowercase();
    let f = from.to_lowercase();

    match preset {
        "fastag" => {
            const FASTAG_TERMS: &[&str] = &[
                "fastag", "netc", "toll", "nhai", "ihmcl", "toll plaza", "plaza", "highway", "vehicle",
            ];
            FASTAG_TERMS.iter().any(|&term| s.contains(term) || f.contains(term))
        }
        "bank" => {
            const BANK_TERMS: &[&str] = &[
                "bank", "alert", "debited", "credited", "statement", "neft", "rtgs", "imps", "upi",
                "hdfc", "icici", "sbi", "axis", "kotak", "idfc", "pnb", "bob", "canara", "rbl",
                "federal", "paytm", "phonepe", "cred", "txn alert", "transaction alert", "a/c", "acct",
                "salary", "interest",
            ];
            BANK_TERMS.iter().any(|&term| s.contains(term) || f.contains(term))
        }
        "shopping" => {
            const SHOPPING_TERMS: &[&str] = &[
                "amazon", "flipkart", "swiggy", "zomato", "uber", "ola", "blinkit", "zepto",
                "invoice", "bill", "order", "receipt", "aws", "google", "microsoft", "payment",
                "razorpay", "cashfree", "subscription",
            ];
            SHOPPING_TERMS.iter().any(|&term| s.contains(term) || f.contains(term))
        }
        "all" => true,
        _ => true,
    }
}

pub fn imap_fetch_messages_impl(
    config: ImapConfig,
    query: ImapQuery,
    progress_callback: Option<&dyn Fn(MailProgressPayload)>,
) -> Result<Vec<ImapMessageResult>, String> {
    let notify = |stage: &str, current: usize, total: usize, percent: u8, msg: &str| {
        if let Some(ref cb) = progress_callback {
            cb(MailProgressPayload {
                stage: stage.to_string(),
                current,
                total,
                percent,
                message: msg.to_string(),
            });
        }
    };

    notify("connecting", 0, 100, 10, &format!("Connecting to {}:{}...", config.host, config.port));
    let mut session = connect_imap(&config)?;

    notify("authenticating", 10, 100, 25, &format!("Authenticated as {}.", config.username));
    let mailbox = config.mailbox.as_deref().unwrap_or("INBOX");
    let mb_data = session
        .select(mailbox)
        .map_err(|e| format!("Failed to select mailbox {}: {}", mailbox, e))?;
    let uid_validity = mb_data.uid_validity;

    let days = query.days.unwrap_or(60);
    let since_date = chrono::Utc::now() - chrono::Duration::days(days as i64);
    let since_str = since_date.format("%d-%b-%Y").to_string(); // RFC 3501 date-text e.g. "01-Oct-2026"

    notify("searching", 25, 100, 40, &format!("Searching mailbox {} since {}...", mailbox, since_str));

    // RFC 3501 standard search criteria (unquoted date-text)
    let search_criteria = if let Some(ref custom) = query.custom_search {
        custom.clone()
    } else {
        format!("SINCE {}", since_str)
    };

    let uids = session
        .search(&search_criteria)
        .map_err(|e| format!("IMAP search failed with criteria '{}': {}", search_criteria, e))?;

    let mut uids_to_inspect: Vec<u32> = uids.into_iter().collect();
    uids_to_inspect.sort_unstable_by(|a, b| b.cmp(a)); // newest first

    let preset = query.preset.as_deref().unwrap_or("all");
    let max_count = query.limit.unwrap_or(25).min(100);

    // If preset is "all", we take the newest max_count UIDs directly
    // Otherwise, we inspect candidate headers (up to 150 candidate emails) and filter by preset
    let target_uids: Vec<u32> = if preset == "all" {
        uids_to_inspect.into_iter().take(max_count).collect()
    } else {
        let inspect_batch_size = (max_count * 4).min(100);
        let candidate_slice = &uids_to_inspect[..uids_to_inspect.len().min(inspect_batch_size)];
        let mut matched = Vec::new();

        notify(
            "filtering",
            0,
            candidate_slice.len(),
            45,
            &format!("Scanning {} headers for '{}' preset...", candidate_slice.len(), preset),
        );

        for chunk in candidate_slice.chunks(25) {
            let uid_query = chunk.iter().map(|u| u.to_string()).collect::<Vec<_>>().join(",");
            if let Ok(messages) = session.uid_fetch(&uid_query, "ENVELOPE") {
                for msg in messages.iter() {
                    let uid = msg.uid.unwrap_or(0);
                    let envelope = msg.envelope();
                    let subject = envelope
                        .and_then(|e| e.subject.as_ref())
                        .and_then(|s| std::str::from_utf8(s).ok())
                        .unwrap_or("");
                    let from = envelope
                        .and_then(|e| e.from.as_ref())
                        .and_then(|f| f.first())
                        .and_then(|addr| {
                            let mailbox = addr.mailbox.as_ref().and_then(|m| std::str::from_utf8(m).ok()).unwrap_or("");
                            let host = addr.host.as_ref().and_then(|h| std::str::from_utf8(h).ok()).unwrap_or("");
                            if !mailbox.is_empty() && !host.is_empty() {
                                Some(format!("{}@{}", mailbox, host))
                            } else {
                                None
                            }
                        })
                        .unwrap_or_default();

                    if matches_preset(preset, subject, &from) && uid > 0 {
                        matched.push(uid);
                        if matched.len() >= max_count {
                            break;
                        }
                    }
                }
            }
            if matched.len() >= max_count {
                break;
            }
        }
        matched
    };

    let total_to_fetch = target_uids.len();
    let mut results = Vec::new();

    for (idx, uid) in target_uids.into_iter().enumerate() {
        let current_num = idx + 1;
        let pct = 60 + ((current_num * 35) / total_to_fetch.max(1)) as u8;

        if let Ok(messages) = session.uid_fetch(uid.to_string(), "(BODY.PEEK[] ENVELOPE)") {
            for msg in messages.iter() {
                if let Some(body) = msg.body() {
                    let envelope = msg.envelope();
                    let subject = envelope
                        .and_then(|e| e.subject.as_ref())
                        .and_then(|s| std::str::from_utf8(s).ok())
                        .unwrap_or("No Subject")
                        .to_string();

                    let from = envelope
                        .and_then(|e| e.from.as_ref())
                        .and_then(|f| f.first())
                        .and_then(|addr| {
                            let mailbox = addr.mailbox.as_ref().and_then(|m| std::str::from_utf8(m).ok()).unwrap_or("");
                            let host = addr.host.as_ref().and_then(|h| std::str::from_utf8(h).ok()).unwrap_or("");
                            if !mailbox.is_empty() && !host.is_empty() {
                                Some(format!("{}@{}", mailbox, host))
                            } else {
                                None
                            }
                        })
                        .unwrap_or_else(|| "unknown".to_string());

                    let date = envelope
                        .and_then(|e| e.date.as_ref())
                        .and_then(|d| std::str::from_utf8(d).ok())
                        .unwrap_or("")
                        .to_string();

                    notify(
                        "fetching",
                        current_num,
                        total_to_fetch,
                        pct,
                        &format!("Fetching message {} of {}: {}", current_num, total_to_fetch, &subject[..subject.len().min(45)]),
                    );

                    let raw_base64 = base64::engine::general_purpose::STANDARD.encode(body);

                    results.push(ImapMessageResult {
                        uid,
                        uid_validity,
                        mailbox: mailbox.to_string(),
                        subject,
                        from,
                        date,
                        raw_base64,
                    });
                }
            }
        }
    }

    notify(
        "complete",
        results.len(),
        results.len(),
        100,
        &format!("Completed scan. Successfully fetched {} message(s).", results.len()),
    );

    let _ = session.logout();
    Ok(results)
}

pub fn keyring_store_credential_impl(service: &str, account: &str, secret: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(service, account).map_err(|e| format!("Keyring error: {}", e))?;
    entry.set_password(secret).map_err(|e| format!("Keyring set error: {}", e))
}

pub fn keyring_get_credential_impl(service: &str, account: &str) -> Result<String, String> {
    let entry = keyring::Entry::new(service, account).map_err(|e| format!("Keyring error: {}", e))?;
    entry.get_password().map_err(|e| format!("Keyring get error: {}", e))
}

pub fn keyring_delete_credential_impl(service: &str, account: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(service, account).map_err(|e| format!("Keyring error: {}", e))?;
    let _ = entry.delete_credential();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sanitize_path_segment() {
        assert_eq!(sanitize_path_segment("Acme Traders / Pvt Ltd!"), "Acme_Traders___Pvt_Ltd");
        assert_eq!(sanitize_path_segment("FY2026-27"), "FY2026-27");
        assert_eq!(sanitize_path_segment("2026-11"), "2026-11");
    }

    #[test]
    fn test_get_default_folders() {
        let defaults = get_default_folders_impl();
        assert!(!defaults.watch_folder.is_empty());
        assert!(defaults.archive_folder.contains("0ledger"));
    }

    #[test]
    fn test_matches_preset() {
        assert!(matches_preset("fastag", "NETC FASTag Toll Transaction Alert", "alerts@fastag.netc.org.in"));
        assert!(matches_preset("bank", "HDFC Bank: A/c debited INR 5,000 for UPI", "alerts@hdfcbank.net"));
        assert!(matches_preset("shopping", "Your Amazon.in order #405-1234567-8901234", "auto-confirm@amazon.in"));
        assert!(!matches_preset("fastag", "Weekly newsletter from Substack", "newsletter@substack.com"));
        assert!(matches_preset("all", "Any Subject", "anyone@example.com"));
    }

    #[test]
    fn test_save_email_eml() {
        let temp_dir = std::env::temp_dir().join(format!("0ledger_eml_test_{}", std::process::id()));
        let req = SaveEmailRequest {
            archive_root: temp_dir.to_string_lossy().to_string(),
            company_name: "Acme Corp".to_string(),
            financial_year: "FY2026-27".to_string(),
            period_month: "2026-11".to_string(),
            subject: "FASTag Toll Alert ₹45".to_string(),
            uid: 1042,
            date: "2026-11-21".to_string(),
            raw_base64: base64::engine::general_purpose::STANDARD.encode(b"Subject: FASTag Toll\nFrom: toll@nhai.org\n\nAmount: INR 45"),
        };

        let res = save_email_eml_impl(req).unwrap();
        assert!(res.file_path.contains("Acme_Corp"));
        assert!(res.file_path.contains("Emails"));
        assert!(res.file_name.contains("1042.eml"));
        assert!(Path::new(&res.file_path).exists());
        assert_eq!(res.size_bytes, 56);
        assert!(!res.sha256.is_empty());

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_organize_accounting_file() {
        let temp_dir = std::env::temp_dir().join(format!("0ledger_test_{}", std::process::id()));
        let source_dir = temp_dir.join("incoming");
        let archive_dir = temp_dir.join("archive");

        fs::create_dir_all(&source_dir).unwrap();
        let sample_file = source_dir.join("hdfc_nov2026.pdf");
        fs::write(&sample_file, b"%PDF-1.4 sample bank statement content").unwrap();

        let req = OrganizeRequest {
            source_path: sample_file.to_string_lossy().to_string(),
            archive_root: archive_dir.to_string_lossy().to_string(),
            company_name: "Acme Traders".to_string(),
            financial_year: "FY2026-27".to_string(),
            period_month: "2026-11".to_string(),
            category: "Bank_Statements".to_string(),
            action: Some("copy".to_string()),
        };

        let dest = organize_accounting_file_impl(req).unwrap();
        assert!(dest.contains("Acme_Traders"));
        assert!(dest.contains("FY2026-27"));
        assert!(dest.contains("2026-11"));
        assert!(dest.contains("Bank_Statements"));
        assert!(Path::new(&dest).exists());

        // Test duplicate naming
        let req2 = OrganizeRequest {
            source_path: sample_file.to_string_lossy().to_string(),
            archive_root: archive_dir.to_string_lossy().to_string(),
            company_name: "Acme Traders".to_string(),
            financial_year: "FY2026-27".to_string(),
            period_month: "2026-11".to_string(),
            category: "Bank_Statements".to_string(),
            action: Some("move".to_string()),
        };
        let dest2 = organize_accounting_file_impl(req2).unwrap();
        assert!(Path::new(&dest2).exists());

        // Cleanup
        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_extract_pdf_markdown() {
        let bytes = include_bytes!("../../tests/fixtures/bank-table.pdf");
        let req = PdfMarkdownRequest {
            bytes_base64: base64::engine::general_purpose::STANDARD.encode(bytes),
            password: None,
        };
        let markdown = extract_pdf_markdown_impl(req).unwrap().markdown.unwrap();
        assert!(markdown.contains("2026-10-01"));
        assert!(markdown.contains("UPI PAYMENT"));
        assert!(markdown.contains("SALARY CREDIT"));
    }

    #[test]
    fn test_extract_pdf_markdown_with_password_on_unencrypted_pdf() {
        let bytes = include_bytes!("../../tests/fixtures/bank-table.pdf");
        let req = PdfMarkdownRequest {
            bytes_base64: base64::engine::general_purpose::STANDARD.encode(bytes),
            password: Some("unused-password".to_string()),
        };
        let markdown = extract_pdf_markdown_impl(req).unwrap().markdown.unwrap();
        assert!(markdown.contains("UPI PAYMENT"));
    }

    #[test]
    fn test_extract_pdf_layout_keeps_table_text() {
        let bytes = include_bytes!("../../tests/fixtures/bank-table.pdf");
        let req = PdfMarkdownRequest {
            bytes_base64: base64::engine::general_purpose::STANDARD.encode(bytes),
            password: Some("unused-password".to_string()),
        };
        let result = extract_pdf_layout_impl(req).unwrap();
        assert!(result.error.is_none());
        assert!(result.page_count >= 1);
        assert!(result
            .items
            .iter()
            .any(|item| item.text.contains("UPI PAYMENT")));
        assert!(result
            .items
            .iter()
            .any(|item| item.text.contains("SALARY CREDIT")));
        assert!(result
            .items
            .iter()
            .any(|item| item.text.contains("2026-10-01")));
    }

    #[test]
    fn test_scan_inbox_folder() {
        let temp_dir = std::env::temp_dir().join(format!("0ledger_scan_{}", std::process::id()));
        fs::create_dir_all(&temp_dir).unwrap();
        fs::write(temp_dir.join("test_statement.csv"), b"Date,Desc,Debit,Credit\n2026-11-01,Fuel,500,0").unwrap();
        fs::write(temp_dir.join("ignore.exe"), b"executable content").unwrap();

        let files = scan_inbox_folder_impl(&temp_dir.to_string_lossy()).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].filename, "test_statement.csv");
        assert_eq!(files[0].extension, "csv");
        assert!(!files[0].sha256.is_empty());

        let _ = fs::remove_dir_all(&temp_dir);
    }
}

