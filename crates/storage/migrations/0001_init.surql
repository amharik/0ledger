-- Migration 0001: Core Authoritative Ledger, Graph & Sync Schema

DEFINE TABLE _migrations SCHEMAFULL;
DEFINE FIELD version ON _migrations TYPE int;
DEFINE FIELD name ON _migrations TYPE string;
DEFINE FIELD applied_at ON _migrations TYPE datetime DEFAULT time::now();
DEFINE INDEX idx_migrations_version ON _migrations FIELDS version UNIQUE;

DEFINE TABLE meta SCHEMAFULL;
DEFINE FIELD key ON meta TYPE string;
DEFINE FIELD `value` ON meta TYPE string;
DEFINE INDEX idx_meta_key ON meta FIELDS key UNIQUE;

-- Multi-tenant Workspace & Settings
DEFINE TABLE workspace SCHEMAFULL;
DEFINE FIELD id_key ON workspace TYPE string;
DEFINE FIELD slug ON workspace TYPE string;
DEFINE FIELD name ON workspace TYPE string;
DEFINE FIELD readable_name ON workspace TYPE string;
DEFINE FIELD company_id ON workspace TYPE string;
DEFINE FIELD authorized_forwarders ON workspace TYPE array<string> DEFAULT [];
DEFINE FIELD discrepancy_count ON workspace TYPE int DEFAULT 0;
DEFINE FIELD archived ON workspace TYPE bool DEFAULT false;
DEFINE FIELD created_at ON workspace TYPE string;
DEFINE FIELD updated_at ON workspace TYPE string;
DEFINE INDEX idx_workspace_id ON workspace FIELDS id_key UNIQUE;
DEFINE INDEX idx_workspace_slug ON workspace FIELDS slug UNIQUE;

DEFINE TABLE company SCHEMAFULL;
DEFINE FIELD id_key ON company TYPE string;
DEFINE FIELD workspace_id ON company TYPE string;
DEFINE FIELD legal_name ON company TYPE string;
DEFINE FIELD trade_name ON company TYPE option<string>;
DEFINE FIELD gstin ON company TYPE option<string>;
DEFINE FIELD pan ON company TYPE option<string>;
DEFINE FIELD state ON company TYPE option<string>;
DEFINE FIELD currency ON company TYPE string DEFAULT 'INR';
DEFINE FIELD books_begin ON company TYPE string;
DEFINE FIELD fy_start_month ON company TYPE int DEFAULT 4;
DEFINE FIELD round_to_minor ON company TYPE int DEFAULT 1;
DEFINE FIELD rounding_mode ON company TYPE string DEFAULT 'half-up';
DEFINE FIELD decimal_places ON company TYPE int DEFAULT 2;
DEFINE FIELD default_currency ON company TYPE string DEFAULT 'INR';
DEFINE FIELD created_at ON company TYPE string;
DEFINE FIELD updated_at ON company TYPE string;
DEFINE INDEX idx_company_id ON company FIELDS id_key UNIQUE;
DEFINE INDEX idx_company_ws ON company FIELDS workspace_id;

DEFINE TABLE numbering_scheme SCHEMAFULL;
DEFINE FIELD id_key ON numbering_scheme TYPE string;
DEFINE FIELD workspace_id ON numbering_scheme TYPE string;
DEFINE FIELD voucher_type ON numbering_scheme TYPE string;
DEFINE FIELD prefix ON numbering_scheme TYPE string;
DEFINE FIELD next_number ON numbering_scheme TYPE int;
DEFINE FIELD reset_period ON numbering_scheme TYPE string;
DEFINE FIELD width ON numbering_scheme TYPE int DEFAULT 4;
DEFINE FIELD created_at ON numbering_scheme TYPE string;
DEFINE FIELD updated_at ON numbering_scheme TYPE string;
DEFINE INDEX idx_numbering_id ON numbering_scheme FIELDS id_key UNIQUE;

-- Graph Node Tables: Ledgers, Parties, Bank Accounts
DEFINE TABLE ledger SCHEMAFULL;
DEFINE FIELD id_key ON ledger TYPE string;
DEFINE FIELD workspace_id ON ledger TYPE string;
DEFINE FIELD name ON ledger TYPE string;
DEFINE FIELD tally_parent ON ledger TYPE string;
DEFINE FIELD nature ON ledger TYPE string;
DEFINE FIELD normal_side ON ledger TYPE string DEFAULT 'debit'; -- 'debit' | 'credit'
DEFINE FIELD opening_balance_minor ON ledger TYPE int DEFAULT 0;
DEFINE FIELD is_party ON ledger TYPE bool DEFAULT false;
DEFINE FIELD is_bank ON ledger TYPE bool DEFAULT false;
DEFINE FIELD is_tax ON ledger TYPE bool DEFAULT false;
DEFINE FIELD billwise ON ledger TYPE bool DEFAULT false;
DEFINE FIELD is_system ON ledger TYPE bool DEFAULT false;
DEFINE FIELD archived ON ledger TYPE bool DEFAULT false;
DEFINE FIELD created_at ON ledger TYPE string;
DEFINE FIELD updated_at ON ledger TYPE string;
DEFINE INDEX idx_ledger_id ON ledger FIELDS id_key UNIQUE;
DEFINE INDEX idx_ledger_ws_name ON ledger FIELDS workspace_id, name UNIQUE;

DEFINE TABLE party SCHEMAFULL;
DEFINE FIELD id_key ON party TYPE string;
DEFINE FIELD workspace_id ON party TYPE string;
DEFINE FIELD ledger_id ON party TYPE string;
DEFINE FIELD name ON party TYPE string;
DEFINE FIELD gstin ON party TYPE option<string>;
DEFINE FIELD party_type ON party TYPE string;
DEFINE FIELD created_at ON party TYPE string;
DEFINE FIELD updated_at ON party TYPE string;
DEFINE INDEX idx_party_id ON party FIELDS id_key UNIQUE;
DEFINE INDEX idx_party_ws ON party FIELDS workspace_id;

DEFINE TABLE bank_account SCHEMAFULL;
DEFINE FIELD id_key ON bank_account TYPE string;
DEFINE FIELD workspace_id ON bank_account TYPE string;
DEFINE FIELD name ON bank_account TYPE string;
DEFINE FIELD institution_slug ON bank_account TYPE string;
DEFINE FIELD account_tail ON bank_account TYPE string;
DEFINE FIELD statement_kind ON bank_account TYPE string; -- 'bank' | 'credit_card' | 'p2p' | 'fastag'
DEFINE FIELD created_at ON bank_account TYPE string;
DEFINE INDEX idx_bank_account_id ON bank_account FIELDS id_key UNIQUE;
DEFINE INDEX idx_bank_account_ws ON bank_account FIELDS workspace_id;

-- Authoritative Vouchers & Lines
DEFINE TABLE voucher SCHEMAFULL;
DEFINE FIELD id_key ON voucher TYPE string;
DEFINE FIELD workspace_id ON voucher TYPE string;
DEFINE FIELD voucher_type ON voucher TYPE string;
DEFINE FIELD number ON voucher TYPE string;
DEFINE FIELD date ON voucher TYPE string;
DEFINE FIELD status ON voucher TYPE string DEFAULT 'regular';
DEFINE FIELD currency ON voucher TYPE string DEFAULT 'INR';
DEFINE FIELD party_ledger_id ON voucher TYPE option<string>;
DEFINE FIELD invoice_number ON voucher TYPE option<string>;
DEFINE FIELD narration ON voucher TYPE option<string>;
DEFINE FIELD round_off_amount_minor ON voucher TYPE int DEFAULT 0;
DEFINE FIELD round_off_ledger_id ON voucher TYPE option<string>;
DEFINE FIELD source ON voucher TYPE string DEFAULT 'manual';
DEFINE FIELD fy_key ON voucher TYPE string;
DEFINE FIELD content_hash ON voucher TYPE option<string>;
DEFINE FIELD flagged_scrutiny ON voucher TYPE bool DEFAULT false;
DEFINE FIELD audit_patch_id ON voucher TYPE option<record<audit_event>>;
DEFINE FIELD created_at ON voucher TYPE string;
DEFINE FIELD updated_at ON voucher TYPE string;
DEFINE INDEX idx_voucher_id ON voucher FIELDS id_key UNIQUE;
DEFINE INDEX idx_voucher_ws_date ON voucher FIELDS workspace_id, date;

DEFINE TABLE voucher_line SCHEMAFULL;
DEFINE FIELD id_key ON voucher_line TYPE string;
DEFINE FIELD voucher_id ON voucher_line TYPE string;
DEFINE FIELD workspace_id ON voucher_line TYPE string;
DEFINE FIELD line_no ON voucher_line TYPE int;
DEFINE FIELD ledger_id ON voucher_line TYPE string;
DEFINE FIELD amount_minor ON voucher_line TYPE int;
DEFINE FIELD currency ON voucher_line TYPE string;
DEFINE FIELD narration ON voucher_line TYPE option<string>;
DEFINE INDEX idx_voucher_line_id ON voucher_line FIELDS id_key UNIQUE;
DEFINE INDEX idx_voucher_line_voucher ON voucher_line FIELDS voucher_id;
DEFINE INDEX idx_voucher_line_ws ON voucher_line FIELDS workspace_id;

-- Append-Only Tamper-Evident Audit Chain
DEFINE TABLE audit_event SCHEMAFULL;
DEFINE FIELD id_key ON audit_event TYPE string;
DEFINE FIELD workspace_id ON audit_event TYPE string;
DEFINE FIELD entity_type ON audit_event TYPE string;
DEFINE FIELD entity_id ON audit_event TYPE string;
DEFINE FIELD action ON audit_event TYPE string;
DEFINE FIELD actor ON audit_event TYPE string DEFAULT 'system';
DEFINE FIELD rationale ON audit_event TYPE option<string>;
DEFINE FIELD payload ON audit_event TYPE string;
DEFINE FIELD prev_hash ON audit_event TYPE string;
DEFINE FIELD hash ON audit_event TYPE string;
DEFINE FIELD at ON audit_event TYPE string;
DEFINE INDEX idx_audit_id ON audit_event FIELDS id_key UNIQUE;
DEFINE INDEX idx_audit_ws ON audit_event FIELDS workspace_id, at;

-- Polymorphic Money Flow Edge (TYPE RELATION)
-- Invariant: amount_minor > 0. Direction is always OUT (source/credit) -> IN (target/debit).
DEFINE TABLE flow TYPE RELATION IN ledger|party|bank_account OUT ledger|party|bank_account SCHEMAFULL;
DEFINE FIELD workspace_id ON flow TYPE string;
DEFINE FIELD voucher_id ON flow TYPE record<voucher>;
DEFINE FIELD edge_type ON flow TYPE string; -- 'PAYMENT' | 'RECEIPT' | 'TRANSFER' | 'EXPENSE' | 'TAX' | 'SUSPENSE'
DEFINE FIELD amount_minor ON flow TYPE int ASSERT $value > 0;
DEFINE FIELD currency ON flow TYPE string DEFAULT 'INR';
DEFINE FIELD txn_date ON flow TYPE string;
DEFINE FIELD reference ON flow TYPE option<string>;
DEFINE FIELD narration_norm ON flow TYPE option<string>;
DEFINE FIELD daily_rank ON flow TYPE int DEFAULT 1;
DEFINE FIELD flagged_scrutiny ON flow TYPE bool DEFAULT false;
DEFINE FIELD audit_patch_id ON flow TYPE option<record<audit_event>>;
DEFINE INDEX idx_flow_ws_date ON flow FIELDS workspace_id, txn_date;
DEFINE INDEX idx_flow_ref ON flow FIELDS workspace_id, reference;

DEFINE TABLE rolls_up_to TYPE RELATION IN ledger OUT ledger SCHEMAFULL;

-- Sync & Replication Metadata (ChaCha20-Poly1305 envelopes)
DEFINE TABLE change_log SCHEMAFULL;
DEFINE FIELD seq ON change_log TYPE int;
DEFINE FIELD entity_type ON change_log TYPE string;
DEFINE FIELD entity_id ON change_log TYPE string;
DEFINE FIELD op ON change_log TYPE string;
DEFINE FIELD payload ON change_log TYPE string;
DEFINE FIELD lamport ON change_log TYPE int;
DEFINE FIELD device_id ON change_log TYPE string;
DEFINE FIELD content_hash ON change_log TYPE string;
DEFINE FIELD created_at ON change_log TYPE string;
DEFINE INDEX idx_change_log_hash ON change_log FIELDS content_hash UNIQUE;
DEFINE INDEX idx_change_log_lamport ON change_log FIELDS lamport;

DEFINE TABLE tombstone SCHEMAFULL;
DEFINE FIELD entity_type ON tombstone TYPE string;
DEFINE FIELD entity_id ON tombstone TYPE string;
DEFINE FIELD device_id ON tombstone TYPE string;
DEFINE FIELD lamport ON tombstone TYPE int;
DEFINE FIELD deleted_at ON tombstone TYPE string;
DEFINE INDEX idx_tombstone_pk ON tombstone FIELDS entity_type, entity_id UNIQUE;

DEFINE TABLE sync_meta SCHEMAFULL;
DEFINE FIELD key ON sync_meta TYPE string;
DEFINE FIELD `value` ON sync_meta TYPE string;
DEFINE INDEX idx_sync_meta_key ON sync_meta FIELDS key UNIQUE;

