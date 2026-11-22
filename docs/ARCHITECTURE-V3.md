# Architecture v3 — portable engine, authoritative SQLite, native shells

0ledger is no longer a Tauri application that happens to contain bookkeeping
logic. It is a **portable financial engine** with replaceable presentation
layers:

```
┌────────────────────┐  ┌────────────────────┐  ┌────────────────────┐
│ Tauri + React      │  │ Kotlin + Compose   │  │ SwiftUI            │
│ desktop shell      │  │ Android shell      │  │ iOS shell          │
└─────────┬──────────┘  └─────────┬──────────┘  └─────────┬──────────┘
          │ Tauri commands        │ UniFFI                 │ UniFFI
          └───────────┬───────────┴────────────┬───────────┘
                      ▼                        ▼
              ┌───────────────────────────────────────┐
              │ crates/ffi — UniFFI surface           │
              └───────────────┬───────────────────────┘
                              ▼
              ┌───────────────────────────────────────┐
              │ crates/storage — authoritative SQLite │
              │ WAL · migrations · audit chain        │
              │ change log · LWW apply · backups      │
              └───────┬───────────────────────┬───────┘
                      ▼                       ▼
          ┌───────────────────┐   ┌───────────────────┐
          │ crates/engine     │   │ crates/sync       │
          │ pure accounting   │   │ sealed envelopes  │
          │ no I/O            │   │ LWW merge         │
          └───────────────────┘   └───────────────────┘
```

## Non-negotiable rules

1. **The engine is the source of truth.** Money, validation, posting rules and
   reports live in `crates/engine`. No shell re-implements them.
2. **SQLite is authoritative.** `crates/storage` owns schema, migrations, audit
   history and the change log. IndexedDB is never authoritative.
3. **Presentation is replaceable.** Tauri, Android and iOS call the same
   operations. A UI rewrite must not require an engine rewrite.
4. **Sync is UI-agnostic.** `crates/sync` does not know about Tauri, Compose or
   SwiftUI. It moves sealed change envelopes between stores.
5. **No remote backend.** Sync is peer-to-peer over a caller-supplied
   transport (file, socket, future relay). The engine never opens a network
   connection itself.

## Crates

### `crates/engine` (`zeroledger-engine`)

Pure library: no database, no filesystem, no network.

- `money.rs` — integer minor units, parsing, explicit round-off modes.
- `model.rs` — workspaces, ledgers, parties, vouchers, voucher lines.
- `validation.rs` — double-entry balance, GST/TDS readiness, date rules.
- `reports.rs` — trial balance and profit & loss.
- `error.rs` — typed engine errors.

### `crates/storage` (`zeroledger-storage`)

SQLite-backed authoritative store. Uses `rusqlite` with bundled SQLite.

- WAL journal mode, foreign keys on, busy timeout.
- Schema version tracked in `PRAGMA user_version` (currently `1`). A database
  newer than the binary is refused with `StorageError::SchemaTooNew`; older
  databases migrate forward.
- Tables: `workspaces`, `companies`, `ledgers`, `parties`,
  `numbering_schemes`, `vouchers`, `voucher_lines`, `change_log`,
  `tombstones`, `audit_events`, `sync_meta`, `meta`.
- **Audit hash chain** in `audit_events`: each event commits to the previous
  hash, so tampering is detectable via `integrity_check`.
- **Change log**: every mutation records a `Change` with a Lamport clock and
  device id, enabling incremental sync.
- **Backups** use `VACUUM INTO`, producing a consistent single-file snapshot
  without stopping readers.
- `import_bundle` accepts a portable JSON bundle and applies it transactionally.

### `crates/sync` (`zeroledger-sync`)

- `change.rs` — `Change`, `ChangeOp`, `ChangeSet`, deterministic merge.
- `crypto.rs` — `SyncKey`, `seal`, `open` using ChaCha20-Poly1305. The AAD
  binds `version | sender | created_at`, so envelopes cannot be replayed under
  a different sender or timestamp.
- `transport.rs` — `Transport` trait plus `MemoryTransport` and
  `FileTransport` implementations.

Conflict resolution is last-writer-wins on `(lamport, device_id)`. The device
id is the deterministic tiebreak, so all peers converge on the same result.

### `crates/ffi` (`zeroledger-ffi`)

UniFFI (proc-macro mode) surface. It defines FFI records and converts them to
and from engine types, keeping the engine free of binding concerns.

- `FfiStore` — open a database, manage workspaces, ledgers, parties and
  vouchers; compute trial balance and P&L; run integrity checks; import
  bundles; back up; export and import sync envelopes.
- Free functions — `engine_version`, `parse_amount`, `round_to_step`,
  `validate_voucher`, `generate_sync_key`, `seal_changes`, `open_envelope`.
- `uniffi-bindgen` binary behind the `cli` feature generates Kotlin and Swift.

## Shells

### Desktop (Tauri + React)

- `src-tauri/src/engine_commands.rs` exposes the engine over Tauri commands,
  including `store_delete_entity` for tombstoned mirror deletions.
- `src/core/db/native-store.ts` is the typed `invoke` bridge.
- `src/core/db/sqlite-mirror.ts` maps Dexie records to the Rust serde contract,
  builds import bundles, mirrors single entities or whole workspaces, and
  verifies SQLite against the cache.
- `src/core/db/sqlite-bootstrap.ts` mirrors all workspaces on desktop launch.
- `src/core/db/migrate-to-sqlite.ts` reuses the same bundle path for migration.
- `src/ui/ReportsPanel.tsx` reads trial balance and P&L from SQLite when the
  native store is available, falling back to Dexie elsewhere.
- `src/ui/EnginePanel.tsx` provides diagnostics, integrity checks, SQLite/cache
  verification, migration, backup and sync.
- Dexie is a write-through cache for screens still on the old path; SQLite is
  authoritative for the ledger core.

### Android (Kotlin + Compose)

`mobile/android` opens `filesDir/0ledger.sqlite3` through the generated
`uniffi.zeroledger_ffi.FfiStore` and renders engine output. The native library
is built with `cargo-ndk`.

### iOS (SwiftUI)

`mobile/ios` compiles the generated Swift bindings and calls the same
`FfiStore`. The Rust library is linked as a static library; `project.yml` is
consumed by XcodeGen.

`mobile/generate-bindings.sh` regenerates both binding sets from the current
Rust build.

## Sync flow

1. Each store has a stable `device_id` and a Lamport clock.
2. Local mutations append to `change_log`.
3. `export_sync_envelope(key, since_lamport)` returns a sealed JSON envelope.
4. The caller transports it (file, socket, relay).
5. `import_sync_envelope(key, envelope_json)` opens, merges and applies.
6. `apply_change` is idempotent and converges under LWW.

The engine never chooses a transport and never stores the sync key.

## Data migration and cutover

1. Dexie remains the immediate UI cache; every ledger mutation writes through
   to SQLite via `sqlite-mirror.ts`.
2. Startup calls `bootstrapSqlite()`, which mirrors every cached workspace.
   Re-imports are idempotent because SQLite skips unchanged change-log entries.
3. Voucher updates and deletes are mirrored explicitly; deletes create
   tombstones in the change log, and referenced ledgers cannot be deleted.
4. `ReportsPanel` reads trial balance and P&L from SQLite when available;
   Dexie remains the fallback and still serves screens not yet migrated.
5. Once every screen uses the native store, Dexie is removed.

The migration is additive: no destructive rewrite of existing user data.

## Testing and CI

- `cargo test --workspace` — engine, storage and sync (34 tests).
- `cargo clippy --workspace --all-targets -- -D warnings`.
- `cargo fmt --all -- --check`.
- `npm test`, `npm run test:stress`, `npm run compile`, `npm run build`.
- `cargo check --manifest-path src-tauri/Cargo.toml` in a dedicated CI job
  with the Tauri system dependencies installed.

`src-tauri` is excluded from the root workspace so Rust library tests never
require GTK/WebKit; the desktop job installs those explicitly.
