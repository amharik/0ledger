# Security review

## Trust boundaries

| Boundary | Trusted | Untrusted |
| --- | --- | --- |
| Desktop shell / local server | Bundled code, local SQLite/IndexedDB/OPFS, loopback API | Imported email/PDF/CSV/XLSX/Tally files, network IMAP hosts |
| Authenticated API | Bearer token holder for a tenant/workspace set | Other tenants, unauthenticated callers, mismatched tenant headers |
| Google Drive | OAuth token held locally | Files outside the 0ledger folder / `drive.file` grant |
| Webmail capture | User-invoked page snapshot | Page DOM and pasted content |
| Attachments | Local OPFS files | PDF parser input |

All imported text is data, never code. The extension has no `eval`, no remote scripts and no
server-side rendering.

## Controls

- Manifest V3; minimum permissions. Google scopes are optional and requested only on connect.
- OAuth 2.0 PKCE with `drive.file`; refresh token in `chrome.storage.local`, access token in memory only.
- Optional Gmail sync requests `gmail.readonly` only after an explicit action; restricted-scope
  verification is required for public distribution.
- Money is integer minor units; every voucher must balance to zero.
- Zod validates imported interchange data, restored backup rows and adapter descriptors before use.
- AES-GCM encrypted backups; key derived from the user passphrase, with bounded KDF iterations,
  ciphertext size and restore record counts.
- Import limits: 25 MB files/attachments, 5M text characters, 100k statement rows, 200 PDF pages,
  25 attachments per email.
- Drive sheet writes use `RAW` values; only typed `formula()` cells are promoted via `USER_ENTERED`,
  preventing spreadsheet formula injection from statement or voucher text.
- Tally/Beancount/OFX/CSV import goes through normal voucher validation and numbering.
- Dedupe checks prevent re-import from silently duplicating vouchers.
- Scanned PDFs are flagged (`ScannedPdfError`) instead of being guessed from an image.
- No secrets are logged. OAuth tokens and passwords must never appear in diagnostics.
- Server API tokens are HMAC-SHA256 signed and scoped to a tenant plus explicit workspace ids; a
  mismatched `X-Tenant-Id` or unlisted `X-Workspace-Id` is rejected. Production requires
  `SERVER_AUTH_SECRET` (32+ characters), and non-loopback binds require a signing secret.
- IMAP host validation rejects URLs and hosts resolving to private, loopback, link-local, or reserved
  addresses unless `ALLOW_PRIVATE_IMAP=true` is explicitly set. DNS results are checked before connect.
- `/api` is rate limited (`SERVER_RATE_LIMIT_PER_MINUTE`, default 60) and returns `Retry-After` on 429.
- Optional TLS via `SERVER_TLS_CERT`/`SERVER_TLS_KEY`; HSTS and restrictive security headers are set.
- Mailbox passwords and optional statement-PDF passwords are stored in the OS keyring (desktop) or
  memory only (browser session), scoped by tenant/workspace/account. Legacy XOR ciphers are migrated and
  stripped from storage.
- IMAP fetch is paginated (`limit` max 50, `cursor`/`nextCursor`) to bound memory and response size.
- Custom sender/subject filters are stored as mailbox metadata, not credentials. Multi-filter runs are
  sequential to respect IMAP rate limits.
- Transaction-producing emails are archived with their attachments. Desktop stores raw `.eml` and
  attachment files in the local vault and keeps only paths in IndexedDB; browser mode stores the bytes
  in IndexedDB. Treat the browser profile and desktop vault as sensitive local data and use disk
  encryption.

## Threat model

- **Malicious statement file**: parser must not execute content, must bound work and surface errors.
- **Malicious webmail DOM**: captured text is parsed as data; selectors should not inject HTML.
- **Stolen laptop**: local data is readable unless encrypted backups are used; OS disk encryption is
  recommended.
- **Compromised Google account**: `drive.file` limits blast radius; mirrored Sheets remain plaintext.
- **Accidental overwrite**: Drive writes require `appProperties.app = 0ledger`; external workbooks are
  never overwritten.
- **Malicious IMAP host**: SSRF validation blocks private/reserved targets; use `ALLOW_PRIVATE_IMAP`
  only for trusted internal servers. DNS rebinding remains a residual risk for any DNS-based allowlist.
- **Stolen API token**: tokens are short-lived and workspace-scoped; rotate `SERVER_AUTH_SECRET` to
  invalidate all outstanding tokens.
- **Supply chain**: dependencies are pinned in `bun.lock` (authoritative); review new parsers before adding.

## Release checklist

- [ ] `bun run compile`
- [ ] `bun run test`
- [ ] `bun run test:stress`
- [ ] `bun run build`
- [ ] `cargo test --workspace`
- [ ] `cargo clippy --workspace --all-targets -- -D warnings`
- [ ] Inspect `.output/` for unexpected remote code or dev-only files
- [ ] Confirm manifest permissions and host permissions are unchanged or justified
- [ ] Confirm no credentials, tokens or real financial fixtures are tracked
- [ ] Re-read privacy policy if data flows changed

Report vulnerabilities privately via GitHub security advisories on `amharik/0ledger`; do not open a
public issue with exploit details or real financial data.
