//! Tauri command surface for the portable SurrealDB engine and audited PDF ingestion.

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::sync::Arc;
use tauri::{Manager, State};
use tokio::sync::Semaphore;
use zeroledger_engine::{
    build_header_fingerprint, detect_institution_slug, normalize_narration, parse_markdown_tables,
    verify_statement_balance, ColumnRole, ExtractedTableData, IngestBatchState, Ledger, NewVoucher,
    ParsedIngestRow, ProfitAndLoss, StatementKind, StatementSummary, TrialBalance, Voucher,
};
use zeroledger_storage::{
    ApplySummary, AuditPatchInput, ForcePostInput, ImportBundle, ImportSummary, IngestBatchDto,
    IntegrityReport, StatementTemplateDto, Store,
};
use zeroledger_sync::SyncKey;

pub struct EngineState(pub Arc<Store>);

/// Strictly caps in-process Docling PDF extraction concurrency at 1 on desktop.
pub struct DoclingSemaphore(pub Arc<Semaphore>);

pub fn init(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let dir = app.path().app_data_dir()?;
    std::fs::create_dir_all(&dir)?;
    let db_path = dir.join("0ledger.surrealkv");
    let store = tauri::async_runtime::block_on(Store::open(&db_path))?;
    app.manage(EngineState(Arc::new(store)));
    app.manage(DoclingSemaphore(Arc::new(Semaphore::new(1))));
    Ok(())
}

#[tauri::command]
pub fn engine_version() -> String {
    zeroledger_engine::ENGINE_VERSION.to_string()
}

#[tauri::command]
pub fn store_device_id(state: State<'_, EngineState>) -> Result<String, String> {
    Ok(state.0.device_id().to_string())
}

#[tauri::command]
pub async fn store_schema_version(state: State<'_, EngineState>) -> Result<u32, String> {
    state.0.schema_version().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn store_list_ledgers(
    state: State<'_, EngineState>,
    workspace_id: String,
) -> Result<Vec<Ledger>, String> {
    state
        .0
        .list_ledgers(&workspace_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn store_list_vouchers(
    state: State<'_, EngineState>,
    workspace_id: String,
) -> Result<Vec<Voucher>, String> {
    state
        .0
        .list_vouchers(&workspace_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn store_trial_balance(
    state: State<'_, EngineState>,
    workspace_id: String,
) -> Result<TrialBalance, String> {
    state
        .0
        .trial_balance(&workspace_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn store_profit_and_loss(
    state: State<'_, EngineState>,
    workspace_id: String,
) -> Result<ProfitAndLoss, String> {
    state
        .0
        .profit_and_loss(&workspace_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn store_integrity_check(
    state: State<'_, EngineState>,
    workspace_id: String,
) -> Result<IntegrityReport, String> {
    state
        .0
        .integrity_check(&workspace_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn store_post_voucher(
    state: State<'_, EngineState>,
    voucher_json: String,
) -> Result<(), String> {
    let input: NewVoucher = serde_json::from_str(&voucher_json).map_err(|e| e.to_string())?;
    state
        .0
        .post_voucher(&input)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn store_import_bundle(
    state: State<'_, EngineState>,
    bundle_json: String,
) -> Result<ImportSummary, String> {
    let bundle: ImportBundle = serde_json::from_str(&bundle_json).map_err(|e| e.to_string())?;
    state
        .0
        .import_bundle(&bundle)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn store_delete_entity(
    state: State<'_, EngineState>,
    entity_type: String,
    entity_id: String,
) -> Result<(), String> {
    state
        .0
        .delete_entity(&entity_type, &entity_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn store_backup(state: State<'_, EngineState>, path: String) -> Result<(), String> {
    state.0.backup_to(path).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sync_generate_key() -> Result<String, String> {
    SyncKey::generate()
        .map(|key| key.to_base64())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sync_export_envelope(
    state: State<'_, EngineState>,
    key: String,
    since_lamport: u64,
) -> Result<String, String> {
    let key = SyncKey::from_base64(&key).map_err(|e| e.to_string())?;
    state
        .0
        .export_sync_envelope(&key, since_lamport)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sync_import_envelope(
    state: State<'_, EngineState>,
    key: String,
    envelope_json: String,
) -> Result<ApplySummary, String> {
    let key = SyncKey::from_base64(&key).map_err(|e| e.to_string())?;
    state
        .0
        .import_sync_envelope(&key, &envelope_json)
        .await
        .map_err(|e| e.to_string())
}

// ---- Audited PDF Ingestion IPC Commands ------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IngestPdfBatchRequest {
    pub workspace_id: String,
    pub bank_ledger_id: String,
    pub source_type: String,
    pub source_reference: Option<String>,
    pub sender_address: Option<String>,
    pub statement_kind: String,
    pub bytes_base64: String,
    pub password: Option<String>,
    pub summary: Option<StatementSummary>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IngestBatchStatusResponse {
    pub batch: IngestBatchDto,
    pub tables: Vec<ExtractedTableData>,
    pub template: Option<StatementTemplateDto>,
    pub discrepancies: Vec<zeroledger_engine::BalanceDiscrepancy>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmColumnMappingRequest {
    pub workspace_id: String,
    pub batch_id: String,
    pub bank_ledger_id: String,
    pub institution_slug: String,
    pub statement_kind: String,
    pub column_mappings: BTreeMap<String, ColumnRole>,
    pub rows: Vec<ParsedIngestRow>,
    pub summary: StatementSummary,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitOcrPatchRequest {
    pub workspace_id: String,
    pub batch_id: String,
    pub bank_ledger_id: String,
    pub statement_kind: String,
    pub rows: Vec<ParsedIngestRow>,
    pub summary: StatementSummary,
    pub patch: AuditPatchInput,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForcePostRequest {
    pub workspace_id: String,
    pub batch_id: String,
    pub bank_ledger_id: String,
    pub rows: Vec<ParsedIngestRow>,
    pub force_post: ForcePostInput,
}

#[tauri::command]
pub async fn ingest_pdf_batch(
    state: State<'_, EngineState>,
    docling_sem: State<'_, DoclingSemaphore>,
    req: IngestPdfBatchRequest,
) -> Result<IngestBatchStatusResponse, String> {
    let raw_bytes = base64::engine::general_purpose::STANDARD
        .decode(&req.bytes_base64)
        .map_err(|e| format!("base64 decode error: {e}"))?;
    let mut hasher = Sha256::new();
    hasher.update(&raw_bytes);
    let content_sha256 = format!("{:x}", hasher.finalize());

    let kind = StatementKind::parse(&req.statement_kind)
        .ok_or_else(|| format!("unsupported statement_kind: {}", req.statement_kind))?;

    let batch = state
        .0
        .create_ingest_batch(
            &req.workspace_id,
            &req.source_type,
            req.source_reference.as_deref(),
            &content_sha256,
            req.sender_address.as_deref(),
            kind,
            None,
            None,
        )
        .await
        .map_err(|e| e.to_string())?;

    state
        .0
        .transition_batch_state(&req.workspace_id, &batch.id_key, IngestBatchState::Queued, None)
        .await
        .map_err(|e| e.to_string())?;

    let _permit = docling_sem
        .0
        .acquire()
        .await
        .map_err(|_| "docling semaphore closed".to_string())?;

    state
        .0
        .transition_batch_state(
            &req.workspace_id,
            &batch.id_key,
            IngestBatchState::Extracting,
            None,
        )
        .await
        .map_err(|e| e.to_string())?;

    let pdf_req = crate::commands::PdfExtractionRequest {
        bytes_base64: req.bytes_base64,
        password: req.password,
        request_id: Some(batch.id_key.clone()),
    };
    let extraction = tauri::async_runtime::spawn_blocking(move || {
        crate::commands::extract_pdf_with_docling_impl(pdf_req, None)
    })
    .await
    .map_err(|e| format!("docling task join error: {e}"))??;

    if let Some(err) = extraction.error {
        let _ = state
            .0
            .transition_batch_state(
                &req.workspace_id,
                &batch.id_key,
                IngestBatchState::Aborted,
                Some(&err),
            )
            .await;
        return Err(err);
    }

    let tables = parse_markdown_tables(&extraction.markdown);
    if tables.is_empty() {
        let msg = "no transaction tables extracted from PDF".to_string();
        let _ = state
            .0
            .transition_batch_state(
                &req.workspace_id,
                &batch.id_key,
                IngestBatchState::Aborted,
                Some(&msg),
            )
            .await;
        return Err(msg);
    }

    state
        .0
        .store_extracted_tables(&batch.id_key, &tables)
        .await
        .map_err(|e| e.to_string())?;

    state
        .0
        .transition_batch_state(
            &req.workspace_id,
            &batch.id_key,
            IngestBatchState::Fingerprinting,
            None,
        )
        .await
        .map_err(|e| e.to_string())?;

    let institution_slug = detect_institution_slug(&extraction.markdown);
    let mut matched_template = None;
    if let Some(ref slug) = institution_slug {
        let (_, fp) = build_header_fingerprint(slug, kind, &tables[0].raw_headers);
        matched_template = state
            .0
            .lookup_statement_template(&req.workspace_id, slug, kind, &fp)
            .await
            .map_err(|e| e.to_string())?;
    }

    if let Some(ref tmpl) = matched_template {
        state
            .0
            .transition_batch_state(
                &req.workspace_id,
                &batch.id_key,
                IngestBatchState::AutoMapped,
                None,
            )
            .await
            .map_err(|e| e.to_string())?;

        // Map extracted rows using saved template and verify balance.
        let rows = map_table_rows(&tables[0], &tmpl.column_mappings);
        let summary = req.summary.unwrap_or_default();
        let check = verify_statement_balance(kind, &rows, &summary);
        if check.ok {
            state
                .0
                .transition_batch_state(
                    &req.workspace_id,
                    &batch.id_key,
                    IngestBatchState::Reconciled,
                    None,
                )
                .await
                .map_err(|e| e.to_string())?;
            state
                .0
                .commit_ingest_batch(
                    &req.workspace_id,
                    &batch.id_key,
                    &req.bank_ledger_id,
                    &rows,
                    None,
                    None,
                )
                .await
                .map_err(|e| e.to_string())?;
        } else {
            state
                .0
                .transition_batch_state(
                    &req.workspace_id,
                    &batch.id_key,
                    IngestBatchState::ScrutinyRequired,
                    Some("balance reconciliation mismatch"),
                )
                .await
                .map_err(|e| e.to_string())?;
        }

        let updated = state
            .0
            .get_ingest_batch(&batch.id_key)
            .await
            .map_err(|e| e.to_string())?
            .unwrap_or(batch);
        return Ok(IngestBatchStatusResponse {
            batch: updated,
            tables,
            template: matched_template,
            discrepancies: check.discrepancies,
        });
    }

    state
        .0
        .transition_batch_state(
            &req.workspace_id,
            &batch.id_key,
            IngestBatchState::NeedsMapping,
            None,
        )
        .await
        .map_err(|e| e.to_string())?;

    let updated = state
        .0
        .get_ingest_batch(&batch.id_key)
        .await
        .map_err(|e| e.to_string())?
        .unwrap_or(batch);
    Ok(IngestBatchStatusResponse {
        batch: updated,
        tables,
        template: None,
        discrepancies: Vec::new(),
    })
}

#[tauri::command]
pub async fn get_ingest_batch_status(
    state: State<'_, EngineState>,
    batch_id: String,
) -> Result<Option<IngestBatchStatusResponse>, String> {
    let Some(batch) = state
        .0
        .get_ingest_batch(&batch_id)
        .await
        .map_err(|e| e.to_string())?
    else {
        return Ok(None);
    };
    let tables = state
        .0
        .get_extracted_tables(&batch_id)
        .await
        .map_err(|e| e.to_string())?;
    Ok(Some(IngestBatchStatusResponse {
        batch,
        tables,
        template: None,
        discrepancies: Vec::new(),
    }))
}

#[tauri::command]
pub async fn confirm_column_mapping(
    state: State<'_, EngineState>,
    req: ConfirmColumnMappingRequest,
) -> Result<IngestBatchStatusResponse, String> {
    let kind = StatementKind::parse(&req.statement_kind)
        .ok_or_else(|| format!("unsupported statement_kind: {}", req.statement_kind))?;
    let tables = state
        .0
        .get_extracted_tables(&req.batch_id)
        .await
        .map_err(|e| e.to_string())?;
    let first_table = tables
        .first()
        .ok_or_else(|| "no extracted tables found for batch".to_string())?;

    let (_, fp) = build_header_fingerprint(&req.institution_slug, kind, &first_table.raw_headers);
    let tmpl = state
        .0
        .save_statement_template(
            &req.workspace_id,
            &req.institution_slug,
            kind,
            &fp,
            &req.column_mappings,
        )
        .await
        .map_err(|e| e.to_string())?;

    state
        .0
        .transition_batch_state(
            &req.workspace_id,
            &req.batch_id,
            IngestBatchState::AutoMapped,
            None,
        )
        .await
        .map_err(|e| e.to_string())?;

    let check = verify_statement_balance(kind, &req.rows, &req.summary);
    if check.ok {
        state
            .0
            .transition_batch_state(
                &req.workspace_id,
                &req.batch_id,
                IngestBatchState::Reconciled,
                None,
            )
            .await
            .map_err(|e| e.to_string())?;
        state
            .0
            .commit_ingest_batch(
                &req.workspace_id,
                &req.batch_id,
                &req.bank_ledger_id,
                &req.rows,
                None,
                None,
            )
            .await
            .map_err(|e| e.to_string())?;
    } else {
        state
            .0
            .transition_batch_state(
                &req.workspace_id,
                &req.batch_id,
                IngestBatchState::ScrutinyRequired,
                Some("balance reconciliation mismatch"),
            )
            .await
            .map_err(|e| e.to_string())?;
    }

    let batch = state
        .0
        .get_ingest_batch(&req.batch_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "batch not found".to_string())?;

    Ok(IngestBatchStatusResponse {
        batch,
        tables,
        template: Some(tmpl),
        discrepancies: check.discrepancies,
    })
}

#[tauri::command]
pub async fn submit_ocr_audit_patch(
    state: State<'_, EngineState>,
    req: SubmitOcrPatchRequest,
) -> Result<IngestBatchStatusResponse, String> {
    let kind = StatementKind::parse(&req.statement_kind)
        .ok_or_else(|| format!("unsupported statement_kind: {}", req.statement_kind))?;
    let check = verify_statement_balance(kind, &req.rows, &req.summary);
    if !check.ok {
        let batch = state
            .0
            .get_ingest_batch(&req.batch_id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "batch not found".to_string())?;
        return Ok(IngestBatchStatusResponse {
            batch,
            tables: Vec::new(),
            template: None,
            discrepancies: check.discrepancies,
        });
    }

    state
        .0
        .transition_batch_state(
            &req.workspace_id,
            &req.batch_id,
            IngestBatchState::Reconciled,
            None,
        )
        .await
        .map_err(|e| e.to_string())?;

    state
        .0
        .commit_ingest_batch(
            &req.workspace_id,
            &req.batch_id,
            &req.bank_ledger_id,
            &req.rows,
            Some(&req.patch),
            None,
        )
        .await
        .map_err(|e| e.to_string())?;

    let batch = state
        .0
        .get_ingest_batch(&req.batch_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "batch not found".to_string())?;

    Ok(IngestBatchStatusResponse {
        batch,
        tables: Vec::new(),
        template: None,
        discrepancies: Vec::new(),
    })
}

#[tauri::command]
pub async fn force_post_batch(
    state: State<'_, EngineState>,
    req: ForcePostRequest,
) -> Result<IngestBatchDto, String> {
    state
        .0
        .transition_batch_state(
            &req.workspace_id,
            &req.batch_id,
            IngestBatchState::Reconciled,
            None,
        )
        .await
        .map_err(|e| e.to_string())?;

    state
        .0
        .commit_ingest_batch(
            &req.workspace_id,
            &req.batch_id,
            &req.bank_ledger_id,
            &req.rows,
            None,
            Some(&req.force_post),
        )
        .await
        .map_err(|e| e.to_string())?;

    state
        .0
        .get_ingest_batch(&req.batch_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "batch not found".to_string())
}

#[tauri::command]
pub async fn export_surreal_snapshot(
    state: State<'_, EngineState>,
    path: String,
) -> Result<(), String> {
    state
        .0
        .export_workspace_snapshot(path)
        .await
        .map_err(|e| e.to_string())
}

fn map_table_rows(
    table: &ExtractedTableData,
    mappings: &BTreeMap<String, ColumnRole>,
) -> Vec<ParsedIngestRow> {
    let mut header_roles: Vec<ColumnRole> = Vec::with_capacity(table.raw_headers.len());
    let mut seen: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for h in &table.raw_headers {
        let norm = zeroledger_engine::normalize_header_token(h);
        let c = seen.entry(norm.clone()).or_insert(0);
        *c += 1;
        let key = if *c == 1 { norm } else { format!("{}_{}", norm, *c) };
        header_roles.push(mappings.get(&key).copied().unwrap_or(ColumnRole::Ignore));
    }

    let parse_minor = |s: &str| -> i64 {
        let cleaned: String = s
            .chars()
            .filter(|c| c.is_ascii_digit() || *c == '.' || *c == '-')
            .collect();
        cleaned
            .parse::<f64>()
            .map(|v| (v * 100.0).round() as i64)
            .unwrap_or(0)
    };

    table
        .raw_rows
        .iter()
        .enumerate()
        .map(|(idx, cells)| {
            let mut date = String::new();
            let mut value_date = None;
            let mut description = String::new();
            let mut reference = None;
            let mut debit_minor = 0_i64;
            let mut credit_minor = 0_i64;
            let mut amount_minor = 0_i64;
            let mut tx_type = String::new();
            let mut balance_minor = None;

            for (col_idx, cell) in cells.iter().enumerate() {
                let role = header_roles.get(col_idx).copied().unwrap_or(ColumnRole::Ignore);
                match role {
                    ColumnRole::Date => date = cell.trim().to_string(),
                    ColumnRole::ValueDate => value_date = Some(cell.trim().to_string()),
                    ColumnRole::Description => description = cell.trim().to_string(),
                    ColumnRole::Reference => {
                        let t = cell.trim();
                        if !t.is_empty() {
                            reference = Some(t.to_string());
                        }
                    }
                    ColumnRole::Debit => debit_minor = parse_minor(cell).abs(),
                    ColumnRole::Credit => credit_minor = parse_minor(cell).abs(),
                    ColumnRole::Amount => amount_minor = parse_minor(cell),
                    ColumnRole::Type => tx_type = cell.trim().to_ascii_lowercase(),
                    ColumnRole::Balance => {
                        if !cell.trim().is_empty() {
                            balance_minor = Some(parse_minor(cell));
                        }
                    }
                    ColumnRole::Ignore => {}
                }
            }

            if debit_minor == 0 && credit_minor == 0 && amount_minor != 0 {
                if tx_type.contains("cr") {
                    credit_minor = amount_minor.abs();
                } else if tx_type.contains("dr") || amount_minor < 0 {
                    debit_minor = amount_minor.abs();
                } else {
                    debit_minor = amount_minor.abs();
                }
            }

            let narration_norm = normalize_narration(&description);
            ParsedIngestRow {
                row_index: idx,
                date,
                value_date,
                description,
                reference,
                debit_minor,
                credit_minor,
                balance_minor,
                narration_norm,
                daily_rank: 1,
            }
        })
        .collect()
}
