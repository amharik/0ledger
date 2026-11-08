# Statement adapter SDK

Adapters are small data-driven descriptors. They tell the parser which bank or FASTag format a
statement belongs to; the shared parser handles columns, dates, amounts and narration extraction.
No adapter-specific JavaScript runs in the extension.

## Descriptor

```ts
interface StatementAdapter {
  id: string;              // lowercase-hyphen slug, unique, e.g. "hdfc"
  name: string;            // display name, e.g. "HDFC Bank"
  kind: 'bank' | 'fastag';
  markers: string[];       // lowercase strings expected in statement text
  filePatterns?: string[]; // lowercase fragments expected in the file name
}
```

Use the SDK rather than hand-writing the object:

```ts
import { defineAdapter } from '@/core/ingest/adapter-sdk';

export const myBank = defineAdapter({
  id: 'my-bank',
  name: 'My Bank',
  kind: 'bank',
  markers: ['my bank', 'mybank000'],
  filePatterns: ['mybank'],
});
```

`defineAdapter` validates the shape and normalises absent optional fields. The built-in registry is
checked in tests with `validateAdapterRegistry()`.

## Adding an adapter

1. Add the descriptor to `src/core/ingest/adapters.ts`.
2. If the bank needs column-name aliases or a different date/amount layout, extend the shared
   tables in `src/core/ingest/parsers.ts`. Prefer adding aliases over a new parser.
3. Add an **anonymised** fixture under `tests/fixtures/`. Remove names, account numbers, UTRs,
   addresses and balances; keep the header, date, narration and amount column shapes.
4. Add a test that detects the adapter and asserts row count, dates, amounts and narration.
5. Run `npm run compile`, `npm test -- --run` and `npm run build`.

## Detection rules

- An explicit `adapterId` from the UI wins.
- Otherwise, score `filePatterns` matches in the file name and `markers` matches in the extracted
  text. The highest score wins.
- Unknown formats fall back to `generic-bank` or `generic-fastag`. Generic parsing is intentionally
  conservative; if columns are ambiguous, rows are dropped rather than guessed.

## Scanned PDFs

PDFs without a text layer are rejected with `ScannedPdfError` and `requiresOcr = true`.
`OCR_ENABLED` is currently `false`; there is no OCR engine bundled. Do not silently guess from an
image-only statement. Add OCR behind an explicit feature flag and keep the original file local.

## Fixture policy

- Only synthetic or fully anonymised statements.
- Do not commit real account numbers, customer names, addresses, phone numbers or UTRs.
- Keep files small; one representative page is usually enough.
- Password-protected fixtures need a documented test password and no real credentials.
