# Packaging and release

0ledger ships as an unpacked/zipped Chromium MV3 extension. There is no store listing yet.

```bash
npm ci
npm run compile
npm test -- --run
npm run build
npm run zip
```

Artifacts:

- `.output/chrome-mv3/` — unpacked extension for local testing.
- `.output/0ledger-<version>-chrome.zip` — zip produced by WXT.

## Manual smoke test

1. Load `.output/chrome-mv3` via `chrome://extensions` → Developer mode → Load unpacked.
2. Create a workspace, post a balanced voucher, edit it, and confirm reports update.
3. Create a stock item with opening stock, post a purchase and a sale with item lines, and check the
   sidepanel **Stock** report.
4. Export and re-import a Tally XML fixture; confirm dedupe on the second import.
5. Create an encrypted backup, restore it into a fresh workspace, and compare totals.
6. If Drive is configured, run a flush twice; the second flush should be a no-op.
7. Open the service worker console and the sidepanel console; there must be no uncaught errors.

## Versioning

Bump `package.json` version and update `docs/ROADMAP.md` before zipping. Keep the zip out of git.
