use base64::Engine;
use imap::Session;
use native_tls::TlsConnector;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, OnceLock};
use docling::{ConvertOptions, DocumentConverter, InputFormat, SourceDocument, WarmPipeline};
use std::time::SystemTime;
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
pub struct PdfExtractionRequest {
    pub bytes_base64: String,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub request_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PdfExtractionProgress {
    pub request_id: String,
    pub stage: String,
    pub current: usize,
    pub total: usize,
    pub percent: u8,
    pub message: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PdfExtractionResult {
    pub markdown: String,
    pub page_count: u32,
    pub text_pages: u32,
    pub ocr_pages: u32,
    pub mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl PdfExtractionResult {
    fn failed(code: &str, error: String) -> Self {
        Self {
            markdown: String::new(),
            page_count: 0,
            text_pages: 0,
            ocr_pages: 0,
            mode: "unavailable".to_string(),
            code: Some(code.to_string()),
            error: Some(error),
        }
    }
}

pub type PdfProgressCallback = Arc<dyn Fn(PdfExtractionProgress) + Send + Sync>;

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

#[derive(Debug)]
enum PdfUnlockError {
    PasswordRequired,
    InvalidPassword,
    Unreadable(String),
}

impl PdfUnlockError {
    fn code(&self) -> &'static str {
        match self {
            Self::PasswordRequired => "password_required",
            Self::InvalidPassword => "invalid_password",
            Self::Unreadable(_) => "decrypt",
        }
    }

    fn message(&self) -> String {
        match self {
            Self::PasswordRequired => {
                "This PDF is password-protected. Enter the password to continue.".to_string()
            }
            Self::InvalidPassword => {
                "That PDF password was not accepted. Check it and try again.".to_string()
            }
            Self::Unreadable(error) => format!("Could not read the PDF: {}", error),
        }
    }
}

/// Decrypt a PDF in memory. Owner-password-only PDFs (an empty user password)
/// open without asking; a real user password produces a structured error so
/// the UI can prompt instead of surfacing a raw decryption failure.
fn decrypt_pdf(bytes: &[u8], password: Option<&str>) -> Result<Vec<u8>, PdfUnlockError> {
    let supplied = password.unwrap_or("");
    let mut document = match lopdf::Document::load_mem_with_options(
        bytes,
        lopdf::LoadOptions::with_password(supplied),
    ) {
        Ok(document) => document,
        Err(lopdf::Error::InvalidPassword) => {
            return Err(if supplied.is_empty() {
                PdfUnlockError::PasswordRequired
            } else {
                PdfUnlockError::InvalidPassword
            });
        }
        Err(error) => {
            // Some encrypted files fail a structural load without a password.
            // If a bare load still reports encryption, ask for the password.
            let encrypted = lopdf::Document::load_mem(bytes)
                .map(|document| document.is_encrypted())
                .unwrap_or(false);
            return Err(if encrypted {
                if supplied.is_empty() {
                    PdfUnlockError::PasswordRequired
                } else {
                    PdfUnlockError::InvalidPassword
                }
            } else {
                PdfUnlockError::Unreadable(error.to_string())
            });
        }
    };

    // The loader removes /Encrypt after a successful decrypt, so `is_encrypted`
    // is false for both a plain PDF and a just-decrypted one. `was_encrypted`
    // tells them apart: only a plain PDF can be passed through untouched.
    if !document.is_encrypted() && !document.was_encrypted() {
        return Ok(bytes.to_vec());
    }

    // Safety net for files that keep the /Encrypt dictionary around after
    // decryption; Docling must receive a clean, unencrypted PDF.
    if let Ok(encrypt_ref) = document
        .trailer
        .get(b"Encrypt")
        .and_then(|object| object.as_reference())
    {
        document.objects.remove(&encrypt_ref);
    }
    document.trailer.remove(b"Encrypt");
    document.encryption_state = None;

    let mut output = Vec::new();
    document
        .save_to(&mut output)
        .map_err(|error| PdfUnlockError::Unreadable(format!("Could not serialize decrypted PDF: {}", error)))?;
    Ok(output)
}

#[derive(Debug, Clone)]
struct TextLayerInfo {
    page_count: u32,
    text_pages: u32,
    ocr_pages: u32,
    broken: bool,
}

/// Inspect the PDF's native text layer. Pages with real text are extracted
/// natively by Docling; pages without text (or with a broken glyph mapping)
/// are the only ones that should go through OCR.
fn analyze_text_layer(bytes: &[u8]) -> TextLayerInfo {
    let mut page_chars: BTreeMap<u32, usize> = BTreeMap::new();
    let mut broken_chars = 0usize;
    let mut total_chars = 0usize;

    if let Ok(items) = pdf_inspector::extract_text_with_positions_mem(bytes) {
        for item in items {
            if !matches!(item.item_type, pdf_inspector::types::ItemType::Text) {
                continue;
            }
            let text = item.text.trim();
            if text.is_empty() {
                continue;
            }
            let chars = text.chars().count();
            total_chars += chars;
            if text.contains('\u{FFFD}')
                || text
                    .chars()
                    .any(|c| c.is_control() && c != '\n' && c != '\t')
            {
                broken_chars += chars;
            }
            *page_chars.entry(item.page).or_default() += chars;
        }
    }

    let detected_pages = page_chars.keys().copied().max().unwrap_or(0);
    let page_count = lopdf::Document::load_mem(bytes)
        .map(|document| document.get_pages().len() as u32)
        .unwrap_or(detected_pages);
    let text_pages = page_chars
        .values()
        .filter(|count| **count >= 20)
        .count() as u32;
    let broken = total_chars > 0 && (broken_chars as f64 / total_chars as f64) > 0.05;
    let ocr_pages = if text_pages == 0 {
        page_count
    } else {
        page_count
            .saturating_sub(text_pages)
            .max(if broken { 1 } else { 0 })
    };

    TextLayerInfo {
        page_count,
        text_pages,
        ocr_pages,
        broken,
    }
}

fn emit_pdf_progress(
    callback: &Option<PdfProgressCallback>,
    request_id: &str,
    stage: &str,
    percent: u8,
    message: impl Into<String>,
) {
    if let Some(callback) = callback {
        callback(PdfExtractionProgress {
            request_id: request_id.to_string(),
            stage: stage.to_string(),
            current: percent as usize,
            total: 100,
            percent,
            message: message.into(),
        });
    }
}









fn docling_converter(needs_ocr: bool) -> Result<DocumentConverter, String> {
    static NATIVE: OnceLock<Result<DocumentConverter, String>> = OnceLock::new();
    static OCR: OnceLock<Result<DocumentConverter, String>> = OnceLock::new();
    if needs_ocr {
        OCR.get_or_init(|| build_docling_converter(true)).clone()
    } else {
        NATIVE.get_or_init(|| build_docling_converter(false)).clone()
    }
}

fn build_docling_converter(needs_ocr: bool) -> Result<DocumentConverter, String> {
    let mut options = ConvertOptions::default();
    options.no_ocr = Some(!needs_ocr);
    if needs_ocr {
        options.ocr_mode = Some("layout_regions".to_string());
        options.replace_broken_text_layer = Some(true);
    }
    options
        .apply(DocumentConverter::new())
        .map(|converter| converter.warm_pipeline(&WarmPipeline::new()))
        .map_err(|error| format!("Could not configure Docling: {}", error))
}

fn docling_progress_callback(
    progress: &Option<PdfProgressCallback>,
    request_id: &str,
    needs_ocr: bool,
) -> Option<docling::ProgressCallback> {
    let progress = progress.clone()?;
    let request_id = request_id.to_string();
    let last_percent = Arc::new(AtomicU8::new(8));
    Some(Arc::new(move |event: &docling::ProgressEvent| {
        if let docling::ProgressKind::PageCompleted {
            completed_pages,
            total_pages,
            ..
        } = &event.kind
        {
            if *total_pages == 0 {
                return;
            }
            let ratio = *completed_pages as f32 / *total_pages as f32;
            let percent = (8.0 + ratio * 91.0).round().clamp(8.0, 99.0) as u8;
            let previous = last_percent.fetch_max(percent, Ordering::Relaxed);
            if percent > previous {
                emit_pdf_progress(
                    &Some(progress.clone()),
                    &request_id,
                    if needs_ocr { "ocr" } else { "extract" },
                    percent,
                    format!("Processed {}/{} pages", completed_pages, total_pages),
                );
            }
        }
    }))
}

fn docling_error(error: &docling::ConversionError) -> (&'static str, String) {
    if let Some(encryption) = error.encryption() {
        return match encryption.code() {
            "password_required" => (
                "password_required",
                "This PDF is password protected. Enter the password to continue.".to_string(),
            ),
            "wrong_password" => (
                "invalid_password",
                "That password did not open the PDF. Check it and try again.".to_string(),
            ),
            "not_decryptable" => (
                "decrypt",
                format!("This PDF is encrypted in an unsupported way: {}", encryption),
            ),
            _ => (
                "decrypt",
                format!("This PDF could not be decrypted: {}", encryption),
            ),
        };
    }
    ("docling", format!("Docling extraction failed: {}", error))
}

pub fn extract_pdf_with_docling_impl(
    req: PdfExtractionRequest,
    progress: Option<PdfProgressCallback>,
) -> Result<PdfExtractionResult, String> {
    let request_id = req
        .request_id
        .clone()
        .unwrap_or_else(|| "pdf-extraction".to_string());
    let bytes = match base64::engine::general_purpose::STANDARD.decode(&req.bytes_base64) {
        Ok(bytes) => bytes,
        Err(error) => {
            return Ok(PdfExtractionResult::failed(
                "decode",
                format!("Base64 decode error: {}", error),
            ));
        }
    };
    let bytes = match decrypt_pdf(&bytes, req.password.as_deref()) {
        Ok(bytes) => bytes,
        Err(error) => return Ok(PdfExtractionResult::failed(error.code(), error.message())),
    };

    emit_pdf_progress(
        &progress,
        &request_id,
        "analyze",
        2,
        "Inspecting the PDF text layer",
    );
    let info = analyze_text_layer(&bytes);
    let needs_ocr = info.text_pages == 0 || info.text_pages < info.page_count || info.broken;
    let mode = if needs_ocr { "ocr" } else { "native" };
    emit_pdf_progress(
        &progress,
        &request_id,
        "mode",
        8,
        if needs_ocr {
            format!(
                "Selectable text on {} of {} pages; OCR will run only on image/broken regions",
                info.text_pages, info.page_count
            )
        } else {
            format!(
                "Selectable text on all {} pages; extracting native text and tables without OCR",
                info.page_count
            )
        },
    );

    let source = SourceDocument::from_bytes("statement.pdf", InputFormat::Pdf, bytes);
    let converter = match docling_converter(needs_ocr) {
        Ok(converter) => converter,
        Err(error) => {
            emit_pdf_progress(&progress, &request_id, "error", 100, "PDF extraction failed");
            return Ok(PdfExtractionResult::failed("docling", error));
        }
    };
    let callback = docling_progress_callback(&progress, &request_id, needs_ocr);
    match converter.convert_with_progress(source, 0, callback) {
        Ok(conversion) => {
            let markdown = conversion.document.export_to_markdown();
            emit_pdf_progress(
                &progress,
                &request_id,
                "complete",
                100,
                format!("Docling finished ({} mode)", mode),
            );
            Ok(PdfExtractionResult {
                markdown,
                page_count: info.page_count,
                text_pages: info.text_pages,
                ocr_pages: info.ocr_pages,
                mode: mode.to_string(),
                code: None,
                error: None,
            })
        }
        Err(error) => {
            emit_pdf_progress(&progress, &request_id, "error", 100, "PDF extraction failed");
            let (code, message) = docling_error(&error);
            Ok(PdfExtractionResult::failed(code, message))
        }
    }
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
    fn test_decrypt_pdf_classifies_passwords() {
        // Synthetic fixtures; the documented test password is `0ledger-test`.
        let encrypted = include_bytes!("../../tests/fixtures/bank-table-encrypted.pdf");
        let owner_only = include_bytes!("../../tests/fixtures/bank-table-owner.pdf");

        assert!(matches!(
            decrypt_pdf(encrypted, None),
            Err(PdfUnlockError::PasswordRequired)
        ));
        assert!(matches!(
            decrypt_pdf(encrypted, Some("wrong")),
            Err(PdfUnlockError::InvalidPassword)
        ));

        let decrypted = decrypt_pdf(encrypted, Some("0ledger-test")).expect("decrypts");
        let document = lopdf::Document::load_mem(&decrypted).expect("loads decrypted PDF");
        assert!(!document.is_encrypted());

        // Owner-password-only PDFs (empty user password) open without prompting.
        let opened = decrypt_pdf(owner_only, None).expect("owner-only opens");
        let document = lopdf::Document::load_mem(&opened).expect("loads owner-only PDF");
        assert!(!document.is_encrypted());
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
    fn test_analyze_text_layer_detects_selectable_text() {
        let bytes = include_bytes!("../../tests/fixtures/bank-table.pdf");
        let info = analyze_text_layer(bytes);
        assert!(info.page_count >= 1);
        assert!(info.text_pages >= 1);
        assert!(!info.broken);
    }

    /// Manual end-to-end check against a real or synthetic statement. Set
    /// `ZERO_LEDGER_TEST_PDF` (and optionally `ZERO_LEDGER_TEST_PDF_PASSWORD`)
    /// and run with `--ignored` on a machine with the Docling models available
    /// (bundled under `resources/models` or via `DOCLING_RS_MODELS_DIR`).
    #[test]
    #[ignore = "requires Docling models and a statement PDF"]
    fn test_extract_pdf_with_docling_end_to_end() {
        let path = std::env::var("ZERO_LEDGER_TEST_PDF")
            .expect("set ZERO_LEDGER_TEST_PDF to a statement PDF");
        let password = std::env::var("ZERO_LEDGER_TEST_PDF_PASSWORD")
            .ok()
            .filter(|value| !value.is_empty());
        let bytes = fs::read(&path).expect("could not read test PDF");
        let req = PdfExtractionRequest {
            bytes_base64: base64::engine::general_purpose::STANDARD.encode(bytes),
            password,
            request_id: Some("test".to_string()),
        };

        let events = Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = events.clone();
        let progress: PdfProgressCallback = Arc::new(move |payload| {
            sink.lock().unwrap().push(payload);
        });

        let result = extract_pdf_with_docling_impl(req, Some(progress)).expect("extraction task failed");
        assert!(result.error.is_none(), "extraction error: {:?}", result.error);
        assert!(!result.markdown.is_empty(), "Docling returned no Markdown");
        assert!(result.page_count >= 1);
        assert!(result.text_pages + result.ocr_pages >= 1);

        let events = events.lock().unwrap();
        assert!(!events.is_empty(), "extraction emitted no progress events");
        assert!(events.iter().any(|event| event.percent >= 8));
        assert!(events.iter().all(|event| event.request_id == "test"));

        // Optional escape hatch for validating the TypeScript parser against
        // real Docling output. The caller is responsible for deleting the file.
        if let Ok(path) = std::env::var("ZERO_LEDGER_TEST_MARKDOWN_OUT") {
            fs::write(path, &result.markdown).expect("could not write extracted Markdown");
        }
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

