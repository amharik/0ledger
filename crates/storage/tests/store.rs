use std::path::PathBuf;
use zeroledger_engine::{
    CompanyProfile, CompanySettings, Ledger, LedgerNature, NewVoucher, TallyPrimaryGroup, Voucher,
    VoucherLine, VoucherSource, VoucherStatus, VoucherType, Workspace,
};
use zeroledger_storage::{ImportBundle, Store};
use zeroledger_sync::{ChangeOp, SyncKey};

fn temp_path(label: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!("0ledger-{label}-{nanos}.db"))
}

fn workspace() -> Workspace {
    Workspace {
        id: "ws_test".into(),
        slug: "acme-traders".into(),
        name: "Acme Traders".into(),
        readable_name: "Acme Traders".into(),
        company_id: "cmp_test".into(),
        archived: false,
        created_at: "2025-04-01T00:00:00Z".into(),
        updated_at: "2025-04-01T00:00:00Z".into(),
    }
}

fn company() -> CompanyProfile {
    CompanyProfile {
        id: "cmp_test".into(),
        workspace_id: "ws_test".into(),
        legal_name: "Acme Traders Pvt Ltd".into(),
        trade_name: Some("Acme".into()),
        gstin: Some("29ABCDE1234F1Z5".into()),
        pan: Some("ABCDE1234F".into()),
        state: Some("Karnataka".into()),
        currency: "INR".into(),
        books_begin: "2025-04-01".into(),
        settings: CompanySettings::default(),
        created_at: "2025-04-01T00:00:00Z".into(),
        updated_at: "2025-04-01T00:00:00Z".into(),
    }
}

fn ledger(id: &str, name: &str, parent: TallyPrimaryGroup, nature: LedgerNature) -> Ledger {
    Ledger {
        id: id.into(),
        workspace_id: "ws_test".into(),
        name: name.into(),
        tally_parent: parent,
        nature,
        opening_balance_minor: 0,
        is_party: false,
        is_bank: false,
        is_tax: false,
        billwise: false,
        archived: false,
        created_at: "2025-04-01T00:00:00Z".into(),
        updated_at: "2025-04-01T00:00:00Z".into(),
    }
}

fn journal(id: &str, amount: i64) -> NewVoucher {
    NewVoucher {
        voucher: Voucher {
            id: id.into(),
            workspace_id: "ws_test".into(),
            voucher_type: VoucherType::Journal,
            number: id.into(),
            date: "2025-04-10".into(),
            status: VoucherStatus::Regular,
            currency: "INR".into(),
            party_ledger_id: None,
            invoice_number: None,
            narration: Some("test".into()),
            round_off_amount_minor: 0,
            round_off_ledger_id: None,
            source: VoucherSource::Manual,
            created_at: "2025-04-10T00:00:00Z".into(),
            updated_at: "2025-04-10T00:00:00Z".into(),
        },
        lines: vec![
            VoucherLine {
                id: format!("{id}-dr"),
                voucher_id: id.into(),
                workspace_id: "ws_test".into(),
                line_no: 1,
                ledger_id: "led_cash".into(),
                amount_minor: amount,
                currency: "INR".into(),
                narration: None,
            },
            VoucherLine {
                id: format!("{id}-cr"),
                voucher_id: id.into(),
                workspace_id: "ws_test".into(),
                line_no: 2,
                ledger_id: "led_sales".into(),
                amount_minor: -amount,
                currency: "INR".into(),
                narration: None,
            },
        ],
    }
}

fn seed(store: &Store) {
    store.create_workspace(&workspace(), &company()).unwrap();
    store
        .upsert_ledger(&ledger(
            "led_cash",
            "Cash",
            TallyPrimaryGroup::CashInHand,
            LedgerNature::Asset,
        ))
        .unwrap();
    store
        .upsert_ledger(&ledger(
            "led_sales",
            "Sales",
            TallyPrimaryGroup::DirectIncome,
            LedgerNature::Income,
        ))
        .unwrap();
}

#[test]
fn posts_balanced_voucher_and_reports() {
    let store = Store::in_memory_with_device("dev-test").unwrap();
    seed(&store);
    store.post_voucher(&journal("vch_1", 100_000)).unwrap();

    let tb = store.trial_balance("ws_test").unwrap();
    assert!(tb.balanced);
    assert_eq!(tb.total_debit_minor, 100_000);
    assert_eq!(tb.total_credit_minor, 100_000);

    let pnl = store.profit_and_loss("ws_test").unwrap();
    assert_eq!(pnl.total_income_minor, 100_000);
    assert_eq!(pnl.net_profit_minor, 100_000);
}

#[test]
fn rejects_unbalanced_voucher() {
    let store = Store::in_memory_with_device("dev-test").unwrap();
    seed(&store);
    let mut unbalanced = journal("vch_bad", 100_000);
    unbalanced.lines[1].amount_minor = -99_999;
    assert!(store.post_voucher(&unbalanced).is_err());
    assert!(store.list_vouchers("ws_test").unwrap().is_empty());
}

#[test]
fn rejects_duplicate_voucher_number() {
    let store = Store::in_memory_with_device("dev-test").unwrap();
    seed(&store);
    store.post_voucher(&journal("vch_1", 1000)).unwrap();
    let mut duplicate = journal("vch_2", 2000);
    duplicate.voucher.number = "vch_1".into();
    assert!(store.post_voucher(&duplicate).is_err());
}

#[test]
fn persists_across_reopen() {
    let path = temp_path("reopen");
    {
        let store = Store::open_with_device(&path, "dev-test").unwrap();
        seed(&store);
        store.post_voucher(&journal("vch_1", 500)).unwrap();
    }
    {
        let store = Store::open(&path).unwrap();
        let vouchers = store.list_vouchers("ws_test").unwrap();
        assert_eq!(vouchers.len(), 1);
        assert_eq!(store.device_id(), "dev-test");
        assert!(store.trial_balance("ws_test").unwrap().balanced);
    }
    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_file(format!("{}-wal", path.display()));
    let _ = std::fs::remove_file(format!("{}-shm", path.display()));
}

#[test]
fn integrity_check_passes_and_audit_chain_is_verified() {
    let store = Store::in_memory_with_device("dev-test").unwrap();
    seed(&store);
    store.post_voucher(&journal("vch_1", 750)).unwrap();

    let report = store.integrity_check("ws_test").unwrap();
    assert!(report.ok, "issues: {:?}", report.issues);
    assert_eq!(report.checked_vouchers, 1);
    assert!(report.checked_audit_events >= 4);
}

#[test]
fn backup_is_standalone_and_restorable() {
    let path = temp_path("source");
    let backup = temp_path("backup");
    let store = Store::open_with_device(&path, "dev-test").unwrap();
    seed(&store);
    store.post_voucher(&journal("vch_1", 1234)).unwrap();
    store.backup_to(&backup).unwrap();

    let restored = Store::open(&backup).unwrap();
    let vouchers = restored.list_vouchers("ws_test").unwrap();
    assert_eq!(vouchers.len(), 1);
    assert!(restored.integrity_check("ws_test").unwrap().ok);

    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_file(&backup);
}

#[test]
fn sync_envelope_replicates_ledger_to_another_device() {
    let key = SyncKey::generate().unwrap();
    let a = Store::in_memory_with_device("dev-a").unwrap();
    let b = Store::in_memory_with_device("dev-b").unwrap();

    seed(&a);
    a.post_voucher(&journal("vch_1", 42_000)).unwrap();

    let envelope = a.export_sync_envelope(&key, 0).unwrap();
    let summary = b.import_sync_envelope(&key, &envelope).unwrap();
    assert!(summary.applied >= 4);

    let tb_a = a.trial_balance("ws_test").unwrap();
    let tb_b = b.trial_balance("ws_test").unwrap();
    assert_eq!(tb_a, tb_b);
    assert!(b.integrity_check("ws_test").unwrap().ok);
}

#[test]
fn sync_conflicts_resolve_deterministically() {
    let key = SyncKey::generate().unwrap();
    let a = Store::in_memory_with_device("dev-a").unwrap();
    let b = Store::in_memory_with_device("dev-b").unwrap();

    seed(&a);
    seed(&b);

    let mut ledger_a = ledger(
        "led_cash",
        "Cash (A)",
        TallyPrimaryGroup::CashInHand,
        LedgerNature::Asset,
    );
    ledger_a.updated_at = "2025-04-02T00:00:00Z".into();
    let mut ledger_b = ledger(
        "led_cash",
        "Cash (B)",
        TallyPrimaryGroup::CashInHand,
        LedgerNature::Asset,
    );
    ledger_b.updated_at = "2025-04-03T00:00:00Z".into();
    a.upsert_ledger(&ledger_a).unwrap();
    b.upsert_ledger(&ledger_b).unwrap();

    let a_to_b = a.export_sync_envelope(&key, 0).unwrap();
    let b_to_a = b.export_sync_envelope(&key, 0).unwrap();
    b.import_sync_envelope(&key, &a_to_b).unwrap();
    a.import_sync_envelope(&key, &b_to_a).unwrap();

    let a_cash = a.get_ledger("led_cash").unwrap().unwrap();
    let b_cash = b.get_ledger("led_cash").unwrap().unwrap();
    assert_eq!(a_cash.name, b_cash.name);
    // Device id is the deterministic tie-breaker at equal lamports.
    assert_eq!(a_cash.name, "Cash (B)");
}

#[test]
fn schema_version_is_recorded() {
    let store = Store::in_memory_with_device("dev-test").unwrap();
    assert_eq!(store.schema_version().unwrap(), 1);
}

#[test]
fn importing_the_same_bundle_twice_does_not_churn_the_change_log() {
    let store = Store::in_memory_with_device("dev-test").unwrap();
    let bundle = ImportBundle {
        workspaces: vec![workspace()],
        companies: vec![company()],
        ledgers: vec![
            ledger(
                "led_cash",
                "Cash",
                TallyPrimaryGroup::CashInHand,
                LedgerNature::Asset,
            ),
            ledger(
                "led_sales",
                "Sales",
                TallyPrimaryGroup::DirectIncome,
                LedgerNature::Income,
            ),
        ],
        parties: vec![],
        vouchers: vec![journal("vch_1", 100_000)],
    };

    store.import_bundle(&bundle).unwrap();
    let first_count = store.changes_since(0).unwrap().len();
    store.import_bundle(&bundle).unwrap();
    let second_count = store.changes_since(0).unwrap().len();

    assert_eq!(first_count, second_count);
    assert_eq!(store.list_vouchers("ws_test").unwrap().len(), 1);
}

#[test]
fn delete_entity_removes_children_and_blocks_referenced_ledgers() {
    let store = Store::in_memory_with_device("dev-test").unwrap();
    seed(&store);
    store.post_voucher(&journal("vch_1", 100_000)).unwrap();

    assert!(store.delete_entity("ledger", "led_cash").is_err());

    store.delete_entity("voucher", "vch_1").unwrap();
    assert!(store.list_vouchers("ws_test").unwrap().is_empty());
    assert!(store.list_voucher_lines("ws_test").unwrap().is_empty());

    let changes = store.changes_since(0).unwrap();
    assert!(changes.iter().any(|change| {
        change.entity_type == "voucher"
            && change.entity_id == "vch_1"
            && change.op == ChangeOp::Delete
    }));

    store.delete_entity("ledger", "led_cash").unwrap();
    assert!(store
        .list_ledgers("ws_test")
        .unwrap()
        .iter()
        .all(|ledger| ledger.id != "led_cash"));
}
