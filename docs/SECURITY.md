# Security review

## Trust boundaries

| Boundary | Trusted | Untrusted |
| --- | --- | --- |
| Extension | Bundled code, local IndexedDB/OPFS | Imported email/PDF/CSV/XLSX/Tally files |
| Google Drive | OAuth token held locally | Files outside the 0ledger folder / `drive.file` grant |
| Webmail capture | User-invoked page snapshot | Page DOM and pasted content |
| Attachments | Local OPFS files | PDF parser input |

All imported text is data, never code. The extension has no `eval`, no remote scripts and no
server-side rendering.

## Controls

- Manifest V3; minimum permissions. Google scopes are optional and requested only on connect.
- OAuth 2.0 PKCE with `drive.file`; refresh token in `chrome.storage.local`.
- Money is integer minor units; every voucher must balance to zero.
- Zod validates imported interchange data and adapter descriptors before use.
- AES-GCM encrypted backups; key derived from the user passphrase.
- Tally/Beancount/OFX/CSV import goes through normal voucher validation and numbering.
- Dedupe checks prevent re-import from silently duplicating vouchers.
- Scanned PDFs are flagged (`ScannedPdfError`) instead of being guessed from an image.
- No secrets are logged. OAuth tokens and passwords must never appear in diagnostics.

## Threat model

- **Malicious statement file**: parser must not execute content, must bound work and surface errors.
- **Malicious webmail DOM**: captured text is parsed as data; selectors should not inject HTML.
- **Stolen laptop**: local data is readable unless encrypted backups are used; OS disk encryption is
  recommended.
- **Compromised Google account**: `drive.file` limits blast radius; mirrored Sheets remain plaintext.
- **Accidental overwrite**: Drive writes require `appProperties.app = 0ledger`; external workbooks are
  never overwritten.
- **Supply chain**: dependencies are pinned in `package-lock.json`; review new parsers before adding.

## Release checklist

- [ ] `npm run compile`
- [ ] `npm test -- --run`
- [ ] `npm run build`
- [ ] `npm run zip`
- [ ] Inspect `.output/` for unexpected remote code or dev-only files
- [ ] Confirm manifest permissions and host permissions are unchanged or justified
- [ ] Confirm no credentials, tokens or real financial fixtures are tracked
- [ ] Re-read privacy policy if data flows changed

Report vulnerabilities privately via GitHub security advisories on `amharik/0ledger`; do not open a
public issue with exploit details or real financial data.
