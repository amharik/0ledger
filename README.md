# 0ledger

Local-first, double-entry bookkeeping for Indian businesses — in a browser extension, with no backend.

0ledger captures financial information from email, bank statements (PDF/CSV/Excel) and FASTag statements, turns it into a Tally-compatible ledger, and helps you reconcile it. It stores everything locally first and optionally mirrors to a dedicated Google Drive folder as a live Google Sheet plus monthly `.xlsx` archives.

> Status: early development. Phase 1A (ledger core) is in progress. See [docs/ROADMAP.md](docs/ROADMAP.md).

## Why

- **Local-first**: your ledger lives in IndexedDB on your machine; the extension works offline.
- **No backend**: only Google APIs you explicitly authorize (optional).
- **Portable**: open, plain-text-friendly model; exports to Tally XML, Beancount, CSV and OFX.
- **Accountant-friendly**: Tally-style Dr/Cr vouchers, groups, parties, bill-wise tracking and reports.
- **India-aware**: INR + paise integers, FY April–March, 10 major banks, FASTag, GST/TDS capture fields.
- **Zero float money bugs**: every amount is an integer minor unit; round-off is always explicit.

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
  Local ledger (IndexedDB via Dexie)
  ├─ append-only audit + double-entry vouchers
  ├─ integer minor units + explicit round-off
  ├─ Tally-complete model (GST/TDS/forex/inventory fields captured)
  └─ encrypted backups (AES-GCM)
          │
          ├──► Google Sheets live mirror (one workbook per workspace)
          └──► monthly .xlsx archive + Tally/Beancount/CSV/OFX exports
```

- **UI**: React + TypeScript, WXT, Manifest V3 (Chromium).
- **Storage**: Dexie/IndexedDB; attachments in OPFS.
- **Parsing**: pdf.js, PapaParse, ExcelJS, postal-mime.
- **No remote code**, minimal permissions, optional Google scopes only.

## Development

```bash
npm install
npm run dev        # load .output/chrome-mv3 (unpacked) in Chrome
npm test           # core unit tests
npm run compile    # type-check
npm run build      # production build
```

Chrome: `chrome://extensions` → enable Developer mode → **Load unpacked** → select `.output/chrome-mv3`.

## Repository layout

```
src/
  entrypoints/      background, popup, sidepanel, options
  core/
    money/          integer minor units, currency, round-off
    model/          Zod schemas + domain types
    db/             Dexie schema and repositories
    numbering/      voucher numbering schemes
    ledger/         validation, Tally readiness, reports
    template/       single workbook template spec (xlsx + Sheets)
    parsers/        email + statement adapters (planned)
    sync/           Drive folder + Sheets mirror (planned)
  ui/               shared React components
docs/
  PLAN.md           full product/technical plan
  ROADMAP.md        milestone tracker
  TALLY.md          Tally XML field mapping
tests/              Vitest + fixture harness
```

## Privacy & security

- No 0ledger server. Nothing is uploaded unless you connect Google Drive/Sheets.
- Email bodies and statement contents are processed on-device. Parsed data is staged before commit.
- Never stores mailbox passwords. Protected PDFs ask for a password at parse time; optional "remember this batch" is encrypted.
- Google Sheets mirror is plaintext in your Drive by design; local data and backups can be encrypted.

## Contributing

Bank and FASTag formats change. Adapters are data-driven; see `docs/ROADMAP.md` and (soon) `docs/ADAPTERS.md`. Please submit **anonymized** statement fixtures only.

## License

MIT
