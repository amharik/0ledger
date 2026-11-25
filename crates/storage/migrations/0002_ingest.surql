-- Migration 0002: Local-Only Ingestion Staging & PII-Free Templates
-- NEVER written to change_log.

DEFINE TABLE ingest_batch SCHEMAFULL;
DEFINE FIELD id_key ON ingest_batch TYPE string;
DEFINE FIELD workspace_id ON ingest_batch TYPE string;
DEFINE FIELD bank_account_id ON ingest_batch TYPE option<record<bank_account>>;
DEFINE FIELD source_type ON ingest_batch TYPE string;        -- 'upload' | 'imap' | 'gmail'
DEFINE FIELD source_reference ON ingest_batch TYPE option<string>;
DEFINE FIELD content_sha256 ON ingest_batch TYPE string;
DEFINE FIELD sender_address ON ingest_batch TYPE option<string>;
DEFINE FIELD state ON ingest_batch TYPE string;              -- 'RECEIVED' | 'QUEUED' | 'EXTRACTING' | 'FINGERPRINTING' | 'AUTO_MAPPED' | 'NEEDS_MAPPING' | 'SCRUTINY_REQUIRED' | 'RECONCILED' | 'COMMITTED' | 'ABORTED'
DEFINE FIELD statement_kind ON ingest_batch TYPE string;     -- 'bank' | 'credit_card' | 'p2p' | 'fastag'
DEFINE FIELD institution_slug ON ingest_batch TYPE option<string>;
DEFINE FIELD account_tail ON ingest_batch TYPE option<string>;
DEFINE FIELD total_rows ON ingest_batch TYPE int DEFAULT 0;
DEFINE FIELD reconciled_rows ON ingest_batch TYPE int DEFAULT 0;
DEFINE FIELD skipped_duplicate_count ON ingest_batch TYPE int DEFAULT 0;
DEFINE FIELD error_message ON ingest_batch TYPE option<string>;
DEFINE FIELD created_at ON ingest_batch TYPE string;
DEFINE FIELD updated_at ON ingest_batch TYPE string;
DEFINE INDEX idx_ingest_batch_id ON ingest_batch FIELDS id_key UNIQUE;
DEFINE INDEX idx_ingest_batch_ws_state ON ingest_batch FIELDS workspace_id, state;
DEFINE INDEX idx_ingest_batch_hash ON ingest_batch FIELDS workspace_id, content_sha256;

DEFINE TABLE extracted_table SCHEMAFULL;
DEFINE FIELD id_key ON extracted_table TYPE string;
DEFINE FIELD batch_id ON extracted_table TYPE record<ingest_batch>;
DEFINE FIELD table_index ON extracted_table TYPE int;
DEFINE FIELD raw_headers ON extracted_table TYPE array<string>;
DEFINE FIELD raw_rows ON extracted_table TYPE array<array<string>>;
DEFINE FIELD created_at ON extracted_table TYPE string;
DEFINE INDEX idx_extracted_table_id ON extracted_table FIELDS id_key UNIQUE;
DEFINE INDEX idx_extracted_table_batch ON extracted_table FIELDS batch_id;

DEFINE TABLE statement_template SCHEMAFULL;
DEFINE FIELD id_key ON statement_template TYPE string;
DEFINE FIELD workspace_id ON statement_template TYPE string;
DEFINE FIELD institution_slug ON statement_template TYPE string;
DEFINE FIELD statement_kind ON statement_template TYPE string;
DEFINE FIELD header_fingerprint ON statement_template TYPE string;
DEFINE FIELD column_mappings ON statement_template TYPE object FLEXIBLE;
DEFINE FIELD created_at ON statement_template TYPE string;
DEFINE FIELD updated_at ON statement_template TYPE string;
DEFINE INDEX idx_statement_template_id ON statement_template FIELDS id_key UNIQUE;
DEFINE INDEX idx_statement_template_lookup ON statement_template FIELDS workspace_id, institution_slug, statement_kind, header_fingerprint UNIQUE;

