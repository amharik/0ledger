# 0ledger — Milestone Tracker

Status legend: `[ ]` todo · `[~]` in progress · `[x]` done · `[!]` blocked

Updated: 2026-11-09

## M0 — Foundations

- [x] Repository, `dev` branch, remote `origin`
- [x] WXT + React + TypeScript scaffold
- [x] README, plan, roadmap, Tally mapping docs
- [x] Vitest harness with `fake-indexeddb`
- [x] CI (typecheck + tests + build) on pushes/PRs to `dev`

## M1A — Ledger core (current)

- [x] Integer money + currency + round-off engine
- [x] IDs, slugs, naming (`workspace / account / readable`)
- [x] Zod domain model: company, ledger, party, item, voucher, lines, allocations
- [x] Dexie schema v1 + repositories
- [x] Voucher numbering (auto + editable, FY reset)
- [x] Double-entry validation + balance assertion
- [x] Tally readiness validator
- [x] Unit tests: money, IDs/FY, numbering, round-off, validation, workspace/posting/reports
- [x] Encrypted backup / restore (AES-256-GCM + PBKDF2, replace/merge)
- [x] Manual voucher entry UI (Payment / Receipt / Contra / Journal)
- [x] Workspace + company settings UI, encrypted backup UI
- [x] Ledger / account editor (add, rename via service, opening balances, archive/delete)
- [x] Voucher review, edit, cancel, and delete UI (manual types; allocated invoices read-only)
- [x] Workbook template spec renderer (xlsx + Sheets)

## M1B — Invoicing & reports

- [x] Sales / Purchase invoices with optional item lines
- [x] Bill-wise allocations, party outstanding
- [x] Trial balance, P&L, balance sheet, bill aging
- [x] GST/TDS capture fields (no computation)
- [x] Stock-item capture schema (valuation-ready, no valuation)

## M2 — Ingestion

- [x] `.eml` import + MIME/attachment routing
- [x] Webmail DOM capture (Gmail)
- [x] CSV / Excel statement parsers
- [x] Text PDF + password-protected PDF (pdf.js)
- [x] Bank adapters: HDFC, ICICI, SBI, Axis, Kotak, IDFC First, Yes, PNB, BoB, Canara
- [x] FASTag adapters (PDF/CSV), vehicle/plaza grouping
- [x] Staged import, confidence, dedupe, undo
- [x] Optional Gmail API sync (restricted scope disclosure)

## M3 — Reconciliation

- [x] Statement ↔ voucher matcher (ref → amount+date → fuzzy)
- [x] Unmatched queue, manual link, 1:N splits
- [x] Balance assertions per statement period
- [x] Bill-wise / party reconciliation
- [x] Dashboard

## M4 — Drive sync

- [x] OAuth PKCE (`drive.file`), app-created detection
- [x] `0ledger/<workspace>/` folder, one workbook per workspace
- [x] Segmented tabs (weekly/biweekly/monthly/quarterly/custom)
- [x] Idempotent upsert flush (`_sync`), offline queue, alarms
- [x] Monthly `.xlsx` archive
- [x] Pull / conflict diff / restore

## M5 — Interchange

- [x] Beancount export/import
- [x] CSV / OFX export
- [x] Tally XML export (Prime; ERP 9 where compatible)
- [x] Tally XML import round-trip

## M6 — Hardening

- [x] Full inventory (additive: valuation, stock reports)
- [x] OCR for scanned PDFs (flagged: detect and reject with `requiresOcr`)
- [x] Adapter SDK + schema + contribution guide
- [x] Privacy policy, security review, packaging
- [x] Cross-browser evaluation (Firefox/Safari)
- [x] Audit hardening: opening stock, stock-journal direction, Drive/CSV formula injection,
      parser/email/backup limits, raw email minimisation, token storage, stock-reference checks,
      Gmail UI/scope, GST/TDS capture UI and Tally docs alignment

## Release gates

- [x] Every voucher balances to zero minor units; 10k-entry no-drift test (`npm run test:stress`)
- [x] Round-off posts explicitly; multi-currency is capture-only, with no implicit conversion
- [x] Numbering: FY rollover, uniqueness, atomic save
- [x] Tally readiness blocks export on missing required fields
- [x] Re-running Sheets flush is a no-op
- [x] Restore from Drive reproduces the local ledger
