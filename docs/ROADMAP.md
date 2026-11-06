# 0ledger — Milestone Tracker

Status legend: `[ ]` todo · `[~]` in progress · `[x]` done · `[!]` blocked

Updated: 2026-11-06

## M0 — Foundations

- [x] Repository, `dev` branch, remote `origin`
- [x] WXT + React + TypeScript scaffold
- [x] README, plan, roadmap, Tally mapping docs
- [x] Vitest harness with `fake-indexeddb`
- [ ] CI (lint + typecheck + tests) on PRs to `dev`

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
- [ ] Ledger / account editor
- [ ] Voucher review, edit, cancel, and delete UI
- [ ] Workbook template spec renderer (xlsx + Sheets)

## M1B — Invoicing & reports

- [ ] Sales / Purchase invoices with optional item lines
- [ ] Bill-wise allocations, party outstanding
- [ ] Trial balance, P&L, balance sheet, bill aging
- [ ] GST/TDS capture fields (no computation)
- [ ] Stock-item capture schema (valuation-ready, no valuation)

## M2 — Ingestion

- [ ] `.eml` import + MIME/attachment routing
- [ ] Webmail DOM capture (Gmail)
- [ ] CSV / Excel statement parsers
- [ ] Text PDF + password-protected PDF (pdf.js)
- [ ] Bank adapters: HDFC, ICICI, SBI, Axis, Kotak, IDFC First, Yes, PNB, BoB, Canara
- [ ] FASTag adapters (PDF/CSV), vehicle/plaza grouping
- [ ] Staged import, confidence, dedupe, undo
- [ ] Optional Gmail API sync (restricted scope disclosure)

## M3 — Reconciliation

- [ ] Statement ↔ voucher matcher (ref → amount+date → fuzzy)
- [ ] Unmatched queue, manual link, 1:N splits
- [ ] Balance assertions per statement period
- [ ] Bill-wise / party reconciliation
- [ ] Dashboard

## M4 — Drive sync

- [ ] OAuth PKCE (`drive.file`), app-created detection
- [ ] `0ledger/<workspace>/` folder, one workbook per workspace
- [ ] Segmented tabs (weekly/biweekly/monthly/quarterly/custom)
- [ ] Idempotent upsert flush (`_sync`), offline queue, alarms
- [ ] Monthly `.xlsx` archive
- [ ] Pull / conflict diff / restore

## M5 — Interchange

- [ ] Beancount export/import
- [ ] CSV / OFX export
- [ ] Tally XML export (Prime; ERP 9 where compatible)
- [ ] Tally XML import round-trip

## M6 — Hardening

- [ ] Full inventory (additive: valuation, stock reports)
- [ ] OCR for scanned PDFs (flagged)
- [ ] Adapter SDK + schema + contribution guide
- [ ] Privacy policy, security review, packaging
- [ ] Cross-browser evaluation (Firefox/Safari)

## Release gates

- [ ] Every voucher balances to zero minor units; 10k-entry no-drift test
- [ ] Round-off and multi-currency conversion always post explicitly
- [ ] Numbering: FY rollover, uniqueness, atomic save
- [ ] Tally readiness blocks export on missing required fields
- [ ] Re-running Sheets flush is a no-op
- [ ] Restore from Drive reproduces the local ledger
