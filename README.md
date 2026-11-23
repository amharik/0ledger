# 0ledger

Local-first, double-entry bookkeeping and tax reconciliation for Indian businesses — built as a portable Rust financial engine with Tauri + React desktop and native Android/iOS shells. There is no remote backend; an optional local server process handles IMAP fetch and authenticated API access.

0ledger captures financial information from email, bank statements (PDF/CSV/Excel), OCR bills and FASTag statements, turns it into a Tally-compatible ledger, reconciles GSTR-2B Input Tax Credit (ITC), and helps you close books in under 15 minutes a month. It stores everything locally first and optionally mirrors to a dedicated Google Drive folder as a live Google Sheet plus monthly `.xlsx` archives.

> Status: Active desktop product. Managed as a native desktop application via Tauri (`npm run tauri:dev` / `npm run tauri:build`). The legacy Chromium MV3 extension path has been deprecated in favor of the Tauri desktop application, which provides direct local socket access to Tally Prime (`localhost:9000`), system-level file drag-and-drop, and unbounded local storage without browser quota restrictions.

## Why

- **Local-first**: your ledger lives in a local SQLite database managed by the Rust engine; the app works completely offline.
- **No remote backend**: an optional local server process handles IMAP fetch and authenticated API access. Only Google APIs you explicitly authorize (optional) receive data; raw financial data never touches a 0ledger-hosted service.
- **1-Year Free Pro Trial**: new workspaces include a 365-day full Pro trial with GSTR-2B reconciliation and Tally bridge unlocked.
- **GSTR-2B Reconciler**: match GST portal 2B data with your purchase ledger to claim all eligible ITC and generate instant WhatsApp reminders for delinquent vendors.
- **Tally Prime Live Bridge**: 1-click direct push to your local Tally Prime installation over `http://localhost:9000` without browser CORS limitations.
- **Accountant-friendly**: generates an immutable, verified CA Close Pack (Tally XML, BRS, Trial Balance, GSTR-2B match, open exceptions).
- **India-aware**: INR + paise integers, FY April–March, 10 major banks, FASTag, GST/TDS capture fields.
- **Zero float money bugs**: every amount is an integer minor unit; round-off is always explicit.

## Screens

Screenshots use a fictional `Acme Traders` workspace and demo data. No real customer data is shown.

| Dashboard | Reports |
| --- | --- |
| ![0ledger dashboard](docs/screenshots/dashboard.png) | ![Trial balance report](docs/screenshots/reports.png) |
| **Invoice / note** | **Settings** |
| ![Invoice entry with GST and TDS fields](docs/screenshots/invoice.png) | ![Workspace and chart of accounts settings](docs/screenshots/settings.png) |

See [docs/SCREENSHOTS.md](docs/SCREENSHOTS.md) for the full set, including statement import and P&L.

## What it does (target)

1. **Capture** — import `.eml`, capture a webmail message, or optionally sync Gmail.
2. **Parse** — bank/FASTag statements in PDF, password-protected PDF, CSV and Excel; statement adapters are data-driven.
3. **Post** — review parsed candidates, group them under a project / expense / accounting ID, add manual entries.
4. **Reconcile** — match statement lines to ledger vouchers; post explicit round-off; balance assertions.
5. **Mirror** — scheduled push to one Google Sheet workbook per workspace, plus monthly `.xlsx` archives.
6. **Hand off** — export to Tally XML, Beancount, CSV or OFX when needed.

## Architecture

```
Email / PDF / CSV / XLSX
          │
          ▼
   adapters + parsers (staged, confidence-scored)
          │
          ▼
  Authoritative ledger (Rust engine + SQLite)
  ├─ append-only audit hash chain + double-entry vouchers
  ├─ integer minor units + explicit round-off
  ├─ Tally-complete model (GST/TDS/forex/inventory fields captured)
  ├─ sealed device-to-device sync envelopes (ChaCha20-Poly1305)
  └─ local backups via SQLite VACUUM INTO
          │
          ├──► Google Sheets live mirror (one workbook per workspace)
          └──► monthly .xlsx archive + Tally/Beancount/CSV/OFX exports
```

- **Engine**: portable Rust crates (`crates/engine`, `crates/storage`, `crates/sync`) with no UI or network coupling.
- **UI & Runtime**: React + TypeScript, Vite, Tauri v2 desktop; Kotlin/Compose and SwiftUI mobile shells.
- **Storage**: SQLite via `zeroledger-storage` (WAL, migrations, audit chain, change log). Dexie/IndexedDB is a write-through cache for screens that have not moved to the native store yet; desktop reports read SQLite when it is available.
- **Sync**: UI-agnostic, transport-agnostic change envelopes with last-writer-wins conflict resolution.
- **Parsing**: pdf.js, PapaParse, ExcelJS, postal-mime, client-side OCR.
- **No remote code**; the optional API server runs locally and can be locked down with tenant tokens and TLS.

## Development

```bash
bun install
bun run dev            # run desktop app in development server mode (http://127.0.0.1:3000, override with PORT)
bun run build          # production frontend build into dist-desktop/
bun run test           # core unit tests
bun run compile        # strict type-check
bun run tauri:dev      # run native desktop window with hot reload
bun run tauri:build    # build release desktop binaries (.deb, .AppImage, .exe, .dmg)
bun run tauri:build:debug # build debug desktop binary for local testing

cargo test --workspace # Rust engine, storage and sync tests
cargo clippy --workspace --all-targets -- -D warnings
./mobile/generate-bindings.sh  # regenerate Kotlin + Swift UniFFI bindings
```

`npm` remains supported (`npm install`, `npm run dev`, `npm test`); Bun is used in CI and is the
recommended package manager because `bun.lock` is authoritative.

### Server port and host

`server.config.ts` is the single source of truth for the development/production
server address. The default port is `3000`; override it with `PORT=4100` and the
same value is used by Vite and forwarded to Tauri's `devUrl` by
`npm run tauri:dev`. The server binds to `127.0.0.1` by default; set
`HOST=0.0.0.0` only when you intentionally expose it (for example in a
container).

### Server authentication, TLS and tenant isolation

The optional local API server is secure by default for loopback development. Set
`SERVER_AUTH_SECRET` (32+ characters in production) to require bearer tokens. Generate a token for a
tenant and one or more workspaces:

```bash
export SERVER_AUTH_SECRET="$(openssl rand -base64 48)"
bun run server:token -- --tenant acme --workspace ws_acme --ttl 3600
```

Send the token as `Authorization: Bearer <token>`, the workspace as `X-Workspace-Id`, and optionally
`X-Tenant-Id`. The server rejects a mismatched tenant, a workspace outside the token grant, missing
workspace headers, expired/tampered tokens, and any non-loopback bind without a signing secret.
Tokens are HMAC-SHA256 signed and contain `tenantId`, `workspaceIds`, `subject`, `iat`, and `exp`.

Additional hardening:

- **TLS**: set `SERVER_TLS_CERT` and `SERVER_TLS_KEY` to serve HTTPS and enable HSTS.
- **SSRF protection**: IMAP hosts resolving to private, loopback, link-local, or reserved addresses are
  rejected. Set `ALLOW_PRIVATE_IMAP=true` only for trusted local mail servers.
- **Rate limiting**: `SERVER_RATE_LIMIT_PER_MINUTE` defaults to 60 (max 1000), keyed by
  tenant/workspace/client address.
- **Pagination**: `/api/imap/fetch` accepts `limit` (max 50) and `cursor`, and returns `scanned`,
  `matched`, `nextCursor`, and `hasMore`.
- **Structured logs**: JSON request logs redact passwords, tokens, cookies, and credentials; use
  `X-Request-Id` to correlate requests.

Mailbox credentials are never written to IndexedDB or `localStorage`. On desktop they are stored in the
OS keyring; in a browser they live only in memory for the session. Credentials are scoped by
`tenantId`, workspace, and account id. Legacy XOR-encrypted credentials are migrated on first use and
then stripped from storage.

### Desktop Target (Primary)

The application is bundled into native desktop binaries via Tauri. It has direct socket communication with local Tally Prime installations (`http://localhost:9000`), native file dropzones, and persistent offline storage.

*(Note: Legacy MV3 browser extension builds can still be produced with `npm run build:mv3:deprecated` for historical reference, but all active feature development is on the Tauri desktop path).*

## Repository layout

```
crates/
  engine/           pure double-entry rules, money, validation, reports
  storage/          authoritative SQLite schema, migrations, audit chain, change log
  sync/             sealed change envelopes, LWW merge, transports
  ffi/              UniFFI surface for Kotlin and Swift
mobile/
  android/          Kotlin + Jetpack Compose shell
  ios/              SwiftUI shell
src/
  entrypoints/      background, popup, sidepanel, options
  core/
    money/          integer minor units, currency, round-off
    model/          Zod schemas + domain types
    db/             Dexie schema and repositories
    numbering/      voucher numbering schemes
    ledger/         validation, Tally readiness, reports
    backup/         encrypted AES-GCM backup and restore
    template/       single workbook template spec (xlsx + Sheets + snapshot)
    ingest/         email, statement, FASTag and Gmail adapters
    drive/          OAuth PKCE, Drive folders, Sheets mirror, archives, restore
    interchange/    Tally XML, Beancount, CSV, OFX import/export
  ui/               shared React hooks and workspace state
docs/
  PLAN.md           full product/technical plan
  ROADMAP.md        milestone tracker
  SCREENSHOTS.md    UI screenshot gallery
  screenshots/      PNG captures used by README and docs
  TALLY.md          Tally XML field mapping
tests/              Vitest + fixture harness
```

## Google Drive setup

1. Create a Google Cloud project and enable the **Google Drive API** and **Google Sheets API**.
2. Configure the OAuth consent screen (External is fine for personal use) and create an OAuth
   client of type **Web application** for the Chrome extension redirect
   `https://<extension-id>.chromiumapp.org/`.
3. Open **0ledger settings → Google Drive sync**, paste the client ID, and connect.

0ledger uses PKCE, requests only `drive.file`, stores refresh tokens in `chrome.storage.local`
(access tokens stay in memory), and only overwrites workbooks where `appProperties.app = 0ledger`.
Optional Gmail import requests `gmail.readonly` only when you enable it. Sheets mirrors are plaintext
by design; use encrypted `.0ledger` backups for portable encrypted copies.

## Interchange

Open **0ledger settings → Interchange & Tally** to download voucher lines, ledgers, trial balance,
OFX, Beancount and Tally XML. Beancount and Tally XML can also be imported back into a workspace.

Tally export runs readiness checks first (Tally parent groups, party masters, GST fields, numbering
and balances). Override with **Allow Tally export even when readiness checks fail** only if you
accept Tally-specific data loss. Imported vouchers always pass through the normal double-entry
validation and numbering path; re-imports are deduplicated.

## Privacy & security

- No remote 0ledger service. The optional API server runs locally; enable `SERVER_AUTH_SECRET` whenever it is exposed beyond loopback. Nothing is uploaded unless you connect Google Drive/Sheets.
- Email bodies and statement contents are processed on-device. Parsed data is staged before commit.
- Mailbox passwords are stored in the OS keyring on desktop or in memory for the browser session; they are never written to IndexedDB or `localStorage`. Protected PDFs ask for a password at parse time; optional "remember this batch" is encrypted.
- Google Sheets mirror is plaintext in your Drive by design; local data and backups can be encrypted.
- Scanned PDFs without a text layer are flagged as requiring OCR; this build does not bundle OCR.

See [docs/PRIVACY.md](docs/PRIVACY.md) and [docs/SECURITY.md](docs/SECURITY.md) for details.

## Contributing

Bank and FASTag formats change. Adapters are data-driven; see [docs/ADAPTERS.md](docs/ADAPTERS.md). Please submit **anonymized** statement fixtures only.

## Packaging

`bun run build` writes the desktop frontend to `dist-desktop/`; `bun run tauri:build` produces native
desktop installers. See [docs/RELEASE.md](docs/RELEASE.md) for the release checklist.

## License

MIT
