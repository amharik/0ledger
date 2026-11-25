use std::collections::BTreeMap;
use zeroledger_engine::{
    build_header_fingerprint, detect_institution_slug, parse_markdown_tables,
    verify_statement_balance, ColumnRole, CompanyProfile, CompanySettings, IngestBatchState,
    Ledger, LedgerNature, ParsedIngestRow, RoundingMode, StatementKind, StatementSummary,
    TallyPrimaryGroup, Workspace,
};
use zeroledger_storage::{ForcePostInput, Store};

fn sample_workspace_and_company() -> (Workspace, CompanyProfile) {
    let ws = Workspace {
        id: "ws_test".into(),
        slug: "test-co".into(),
        name: "Test Co".into(),
        readable_name: "Test Co".into(),
        company_id: "comp_test".into(),
        archived: false,
        created_at: "2026-11-01T00:00:00Z".into(),
        updated_at: "2026-11-01T00:00:00Z".into(),
    };
    let comp = CompanyProfile {
        id: "comp_test".into(),
        workspace_id: "ws_test".into(),
        legal_name: "Test Co Pvt Ltd".into(),
        trade_name: None,
        gstin: None,
        pan: None,
        state: Some("KA".into()),
        currency: "INR".into(),
        books_begin: "2026-04-01".into(),
        settings: CompanySettings {
            fy_start_month: 4,
            round_to_minor: 1,
            rounding_mode: RoundingMode::HalfUp,
            decimal_places: 2,
            default_currency: "INR".into(),
        },
        created_at: "2026-11-01T00:00:00Z".into(),
        updated_at: "2026-11-01T00:00:00Z".into(),
    };
    (ws, comp)
}

#[tokio::test]
async fn surreal_ingest_end_to_end_dedup_and_graph_balances() {
    let store = Store::open_in_memory().await.expect("open in-memory surreal");
    assert_eq!(store.schema_version().await.unwrap(), 2);

    let (ws, comp) = sample_workspace_and_company();
    store.create_workspace(&ws, &comp).await.unwrap();

    let bank_ledger = Ledger {
        id: "led_hdfc".into(),
        workspace_id: "ws_test".into(),
        name: "HDFC Bank".into(),
        tally_parent: TallyPrimaryGroup::BankAccounts,
        nature: LedgerNature::Asset,
        opening_balance_minor: 1_000_000,
        is_party: false,
        is_bank: true,
        is_tax: false,
        billwise: false,
        archived: false,
        created_at: "2026-11-01T00:00:00Z".into(),
        updated_at: "2026-11-01T00:00:00Z".into(),
    };
    store.upsert_ledger(&bank_ledger).await.unwrap();

    let md = "HDFC BANK\nIFSC: HDFC0001234\n\n| Date | Narration | Debit | Credit | Balance |\n| --- | --- | --- | --- | --- |\n| 2026-11-01 | UPI/tea/1 | 200.00 | | 9800.00 |\n| 2026-11-01 | UPI/tea/1 | 200.00 | | 9600.00 |\n";
    assert_eq!(detect_institution_slug(md), Some("hdfc".to_string()));
    let tables = parse_markdown_tables(md);
    assert_eq!(tables.len(), 1);

    let batch = store
        .create_ingest_batch(
            "ws_test",
            "upload",
            Some("hdfc_nov.pdf"),
            "sha256_batch_1",
            None,
            StatementKind::Bank,
            Some("hdfc"),
            Some("1234"),
        )
        .await
        .unwrap();

    // Duplicate non-ABORTED SHA-256 is rejected.
    assert!(store
        .create_ingest_batch(
            "ws_test",
            "upload",
            Some("hdfc_nov_copy.pdf"),
            "sha256_batch_1",
            None,
            StatementKind::Bank,
            Some("hdfc"),
            Some("1234"),
        )
        .await
        .is_err());

    store.store_extracted_tables(&batch.id_key, &tables).await.unwrap();
    let (_, fp) = build_header_fingerprint("hdfc", StatementKind::Bank, &tables[0].raw_headers);
    let mut mappings = BTreeMap::new();
    mappings.insert("date".into(), ColumnRole::Date);
    mappings.insert("narration".into(), ColumnRole::Description);
    mappings.insert("debit".into(), ColumnRole::Debit);
    mappings.insert("credit".into(), ColumnRole::Credit);
    mappings.insert("balance".into(), ColumnRole::Balance);
    store
        .save_statement_template("ws_test", "hdfc", StatementKind::Bank, &fp, &mappings)
        .await
        .unwrap();
    assert!(store
        .lookup_statement_template("ws_test", "hdfc", StatementKind::Bank, &fp)
        .await
        .unwrap()
        .is_some());

    // Two identical same-day rows within the same PDF are preserved (with distinct UTRs or intra-PDF).
    let rows = vec![
        ParsedIngestRow {
            row_index: 0,
            date: "2026-11-01".into(),
            value_date: None,
            description: "UPI/tea/1".into(),
            reference: Some("UTR_1".into()),
            debit_minor: 20_000,
            credit_minor: 0,
            balance_minor: Some(980_000),
            narration_norm: "upi/tea/1".into(),
            daily_rank: 1,
        },
        ParsedIngestRow {
            row_index: 1,
            date: "2026-11-01".into(),
            value_date: None,
            description: "UPI/tea/1".into(),
            reference: Some("UTR_2".into()),
            debit_minor: 20_000,
            credit_minor: 0,
            balance_minor: Some(960_000),
            narration_norm: "upi/tea/1".into(),
            daily_rank: 2,
        },
    ];
    let check = verify_statement_balance(
        StatementKind::Bank,
        &rows,
        &StatementSummary {
            opening_balance_minor: Some(1_000_000),
            ..Default::default()
        },
    );
    assert!(check.ok);

    let (committed, skipped) = store
        .commit_ingest_batch("ws_test", &batch.id_key, "led_hdfc", &rows, None, None)
        .await
        .unwrap();
    assert_eq!(committed, 2);
    assert_eq!(skipped, 0);

    // Overlapping second PDF with UTR_2 repeated + 1 new UTR_3 skips UTR_2 cleanly.
    let batch2 = store
        .create_ingest_batch(
            "ws_test",
            "upload",
            Some("hdfc_nov_overlap.pdf"),
            "sha256_batch_2",
            None,
            StatementKind::Bank,
            Some("hdfc"),
            Some("1234"),
        )
        .await
        .unwrap();
    let overlap_rows = vec![
        rows[1].clone(),
        ParsedIngestRow {
            row_index: 1,
            date: "2026-11-03".into(),
            value_date: None,
            description: "NEFT/Client".into(),
            reference: Some("UTR_3".into()),
            debit_minor: 0,
            credit_minor: 50_000,
            balance_minor: Some(1_010_000),
            narration_norm: "neft/client".into(),
            daily_rank: 1,
        },
    ];
    let (committed2, skipped2) = store
        .commit_ingest_batch(
            "ws_test",
            &batch2.id_key,
            "led_hdfc",
            &overlap_rows,
            None,
            Some(&ForcePostInput {
                actor: "user".into(),
                rationale: "test force post".into(),
                discrepancy_minor: 0,
            }),
        )
        .await
        .unwrap();
    assert_eq!(committed2, 1);
    assert_eq!(skipped2, 1);

    let stmt = store
        .get_ledger_statement_with_running_balance("ws_test", "led_hdfc", 1_000_000)
        .await
        .unwrap();
    assert_eq!(stmt.len(), 3);
    assert_eq!(stmt.last().unwrap().running_balance_minor, 1_010_000);

    let tb = store.get_graph_trial_balance("ws_test").await.unwrap();
    assert!(!tb.is_empty());
    store
        .transition_batch_state("ws_test", &batch2.id_key, IngestBatchState::Committed, None)
        .await
        .unwrap();
}

