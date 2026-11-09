# Privacy policy

0ledger is local-first. There is no 0ledger backend, analytics service or telemetry endpoint.

## What stays on your device

- Ledger data, parties, stock items, vouchers, attachments and staged imports live in the browser's
  IndexedDB/OPFS for the extension.
- Email and statement contents are parsed on-device.
- Backup files are created locally with AES-GCM encryption before download or Drive upload.

## Optional Google Drive

If you connect Google Drive, 0ledger requests only `drive.file`. It can create and manage files that
it created or that you explicitly opened with it; it cannot read your whole Drive.

- The live mirror is a Google Sheet in a dedicated folder. **Sheets are plaintext by design.**
- Monthly `.xlsx` archives are also plaintext.
- Encrypted `.0ledger` backups are the portable encrypted copy.
- OAuth refresh tokens are stored in `chrome.storage.local`; access tokens are kept in memory.
- You can disconnect at any time in 0ledger settings. Revoke access in your Google Account to remove
  the grant itself.

## Email

- `.eml` files and pasted webmail content are parsed locally.
- Optional Gmail sync, if configured, uses read-only Gmail scope and stores only the parsed financial
  fields you commit. 0ledger never stores mailbox passwords or raw email bodies.
- Imported email bodies are sanitized before staging; only short subject/from metadata and parsed
  statement lines are retained.
- The webmail capture flow reads the visible message only when you invoke it.

## Statement passwords

Protected PDFs ask for a password at parse time. The password is kept in memory for that parse.
The optional per-batch "remember" value is encrypted; it is never sent anywhere.

## Data deletion

Delete a workspace in 0ledger settings to remove its local records. Delete the 0ledger folder in
Google Drive to remove mirrored copies and archives. Clearing extension storage removes local tokens
and settings.

## Contact

Open an issue at <https://github.com/amharik/0ledger/issues> for privacy questions or data-handling
concerns. Do not include real financial data in an issue.
