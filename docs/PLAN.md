# 0ledger — Product & Technical Plan

## 1. Goal

A zero-backend, local-first browser extension for Indian small-business bookkeeping. It ingests financial information from email, bank statements and FASTag, produces a Tally-compatible double-entry ledger, reconciles it, and optionally mirrors to Google Drive.

## 2. Locked decisions

| Area | Decision |
|---|---|
| Voucher scope | Full accounting: Contra, Payment, Receipt, Journal, Sales, Purchase, Credit/Debit Note (+ delivery/receipt notes in schema) |
| GST/TDS | Capture fields only; no computation or returns |
| Company | One company per workspace; FY filtered by date (April–March default) |
| Inventory | MVP: capture item lines only, no valuation; schema is valuation-ready |
| Multi-currency | Capture fields only; INR-first; explicit round-off / forex lines |
| Numbering | Auto per voucher type + FY, editable, uniqueness enforced |
| Ledger presentation | Tally-style Dr/Cr vouchers and groups |
| Portable formats | Beancount-first open model; Tally XML, CSV, OFX exports |
| Drive | Google Sheets live mirror + monthly `.xlsx` archive; one workbook per workspace |
| Auto-detect | App-created files only (`drive.file`); external files via pasted URL/ID |
| Tally XML | Export/import; model captures every Tally field from day one |
| Runtime | Chromium MV3; no backend; no remote code |

## 3. Layered design

```
ingestion adapters (email, statements, FASTag)
        │  staged candidates, confidence, dedupe
        ▼
domain services (numbering, round-off, validation, posting)
        │  atomic Dexie transactions + append-only audit
        ▼
local ledger (IndexedDB) ── attachments (OPFS) ── encrypted backups
        │
        ├─ template spec ──► .xlsx renderer
        ├─ template spec ──► Google Sheets mirror + monthly archive
        └─ exporters ─────► Tally XML / Beancount / CSV / OFX
```

## 4. Money, currency and round-off

- All amounts are **integer minor units** (paise for INR). No float arithmetic on money.
- Multi-currency stores `currency`, `forexAmountMinor`, `exchangeRate` (decimal string), `baseAmountMinor`.
- Company policy: `roundingMode` (half-up/half-even), `invoiceRoundTo` (0.01/1/5), `taxRoundingLevel` (line/invoice), `roundOffLedgerId`.
- Round once at the voucher total. The difference is always posted to a `Round Off` ledger, so Dr = Cr exactly.
- Forex conversion difference posts to `Forex Gain/Loss` (configurable).
- Reconciliation never absorbs rounding; differences are surfaced and must be posted.
- Tally stores `roundOffAmount` and `roundOffLedgerId`.

## 5. Domain model (Zod-validated)

- `Workspace` + `CompanyProfile` (legal name, GSTIN, state, currency, FY start, books begin)
- `Ledger` (Tally parent group, nature, opening balance, bank/party/tax flags, bill-wise, cost center)
- `Party` (linked ledger, GSTIN, addresses, credit terms) — Sundry Debtors/Creditors
- `StockItem`, `Godown`, `Batch` (optional; capture only)
- `Voucher` (type, date, number, party, invoice fields, place of supply, reverse charge, status, Tally GUID/ALTERID)
- `VoucherLine` (ledger, signed Dr/Cr, forex)
- `ItemLine` (item, qty, rate, amount, discount, HSN/SAC, godown/batch)
- `BillAllocation` (New Ref / Against Ref / Advance / On Account, due date)
- `CostCenterAllocation`, `TaxAllocation`, `Attachment`
- `NumberingScheme`
- `AuditEvent` (append-only, ISO-8601 UTC)

## 6. Validation invariants

1. Every voucher balances to zero minor units per currency (including round-off).
2. Ledgers referenced by vouchers exist and are not archived.
3. Bill allocations do not exceed bill balances.
4. Voucher numbers are unique per scheme + FY unless manual override is allowed.
5. Dates and FY are valid; effective date precedes posting date.
6. Tally readiness: parent groups, party/item mappings, GST fields when tax ledgers are used.
7. Imports are staged; nothing is committed until validation passes.

## 7. Workbook template

Tabs: `_meta`, `_sync`, `_snapshot` (chunked restore payload), `CoA`, `Parties`, `Items`, `Godowns`, `Vouchers`, `VoucherLines`, `ItemLines`, `BillAllocations`, `CostCenters`, `TaxAllocations`, `TallyFields`, `TrialBalance`, `ProfitAndLoss`, `BalanceSheet`, `PartyOutstanding`, `BillAging`, `Reconcile`, `Segments Weekly`, `Segments Biweekly`, `Segments Monthly`, `Segments Quarterly`, `Segments Custom`, `<Account> — Ledger`, `Dashboard`, `ReadMe`.

- One template spec renders both `.xlsx` (ExcelJS) and Google Sheets (Sheets API).
- Formulas pre-provisioned to a bounded row count (default 5,000), using `SUMIFS`, `INDEX/MATCH`, `IFERROR`, `ROUND`.
- The extension only appends values; formulas are written once.
- `TallyFields` preserves Tally-only data so the main tabs stay readable.
- `_meta` stores the identity manifest; `_sync` stores row ids and content hashes.

## 8. Naming

```
workspaceId  ws_<uuidv7>     slug: acme-traders       readable: "Acme Traders"
accountId    acct_<uuidv7>   slug: hdfc-1234          readable: "HDFC Current A/C 1234"
ledgerId     led_<uuidv7>    code: 4000-Food          readable: "Food & Beverage"
composite    "Acme Traders / HDFC 1234 / Food & Beverage"
```

The embedded `_meta` manifest is authoritative; filenames are hints only.

## 9. Drive layout

```
My Drive/0ledger/<workspace-slug>/
  <Workspace Readable> — Ledger.gsheet
  archives/<Workspace Readable> — YYYY-MM.xlsx
```

`drive.file` scope; `fileId → workspaceId` cached locally; auto-detect app-created workbooks on load; external workbooks via pasted URL/ID. Never auto-overwrite.

## 10. Email ingestion

- `.eml` import and webmail DOM capture in v1.
- Optional Gmail API sync (`gmail.readonly`) behind explicit disclosure; restricted-scope verification required for public distribution.
- MIME parsing on-device; attachments routed to statement parsers.
- Bank-alert rules are data-driven (sender, regex, field map) with confidence scores.
- No mailbox password is ever requested.

## 11. Statement ingestion

- CSV (PapaParse), Excel (ExcelJS), text PDF and password-protected PDF (pdf.js).
- Password prompt on `PasswordException`; optional encrypted remember-for-batch.
- Scanned PDFs: detect empty text layer; optional OCR (flagged, later).
- Data-driven adapters: HDFC, ICICI, SBI, Axis, Kotak, IDFC First, Yes, PNB, BoB, Canara + FASTag.
- Dedupe: Message-ID, UTR/reference, amount+date+merchant, file SHA-256.
- Import preview, edit, undo; nothing posts without review by default.

## 12. Reconciliation

- Match order: exact reference/UTR → amount + date window → fuzzy narration.
- Manual link/unlink, 1:N splits, confidence display.
- Balance assertion per statement period; bill-wise and party reconciliation.
- Rounding differences surface as explicit postings, never hidden.

## 13. Interchange

- Tally XML masters and vouchers in separate envelopes or a combined file; export is gated by Tally readiness unless explicitly overridden.
- Tally XML import recreates groups, ledgers, stock items, bills, cost centres and inventory lines, then posts through the same validation/numbering path.
- Beancount export uses sanitised `Assets` / `Liabilities` / `Equity` / `Income` / `Expenses` accounts and preserves 0ledger ids in metadata; import dedupes by `source-ref` or a content hash.
- CSV exports cover voucher lines, ledgers and trial balance. OFX exports one bank ledger statement at a time.
- Re-imports are idempotent: Tally uses content hashes plus type/date/number checks, Beancount uses `source-ref` metadata or content hashes.

## 14. Security & privacy

- No server, no remote code; strict MV3 CSP.
- Minimal permissions; optional Google host access only when connected.
- Secrets never logged; email bodies and statements processed on-device.
- Encrypted backups and optional encrypted sync; Sheets mirror is plaintext by design.
- Append-only audit trail; stable GUIDs for Tally.
- Threat guards: size limits, zip-bomb protection, sanitized HTML, parser sandboxing.

## 15. Delivery phases

See [ROADMAP.md](ROADMAP.md). Critical path: M1A → M1B → M2 → M3 → M4 → M5 → M6. M2 and M4 can run in parallel after M1B.

## 16. Out of scope (v1)

Inventory valuation/COGS/stock reports, GST computation/returns, payroll, bank API integrations, Safari/Firefox packaging, cloud backend.
