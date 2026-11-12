# Office-hours independent spec review — round 2

Document: /home/freeradical/Code/0ledger/docs/designs/autopilot-books-owner-smb.md
Verdict: /home/freeradical/Code/0ledger/docs/designs/autopilot-books-owner-smb.md.review.2SAieU/round-2.json

Use only Read, Write, and the one Bash seal command for this review. Read the design at "/home/freeradical/Code/0ledger/docs/designs/autopilot-books-owner-smb.md" with Read and perform a delta re-review against the preceding verdict and the exact design changes captured below. Do not use Edit, and do not change the design.
Use Write to save your complete verdict as JSON to "/home/freeradical/Code/0ledger/docs/designs/autopilot-books-owner-smb.md.review.2SAieU/round-2.json". Then run the `Seal:` command from your dispatch message with Bash, exactly as given; it validates the saved file and prints one receipt line. If it reports an error, correct the saved JSON with Write and run the same command again. Use Bash for nothing else.
Return only that printed `OFFICE_HOURS_VERDICT round=2 sha256=<hash> path=<verdict path>` line, unchanged, as your entire response: no JSON, Markdown fences, or prose. The parent verifies the receipt against the saved bytes.
The saved JSON is your sole findings inventory: include every unresolved problem and necessary remedy, including minor findings that a short conclusion might omit.
Use one finding per distinct obligation. An exact duplicate shares a finding; a shared component does not combine separate decisions, behavior, or effort.

## Severity

Give every finding a severity. Only blocking findings send the design back for another round; minor findings are recorded for the user and never require another round on their own.
- **blocking**: a contradiction; a safety or correctness risk; an unsupported claim the recommendation depends on; missing behavior the committed approach needs; or a persisting blocking prior obligation. Example: the design promises the roster is never stored, yet its sync step saves it nightly.
- **minor**: clarity, wording, or polish that does not change a decision or behavior. Example: the Recommended Approach repeats the problem statement's wording and could be shorter.
When unsure whether a gap changes a decision or behavior, it is blocking.

## Delta re-review scope

This is round 2. Round 1 already reviewed the whole design. Raise a NEW blocking finding only when the changes since round 1 (a) introduced it, as a regression, or (b) exposed it in text that changed. Set its changed_text to a verbatim excerpt of at least 8 characters from one changed (+ or -) line of the diff below. Anything else you notice is minor and never forces another round; give it changed_text null unless it also concerns changed text.
A persisting or unverified prior obligation keeps its current finding without a citation.

The helper captured this exact line diff between the design reviewed in round 1 and the current design ("-" removed, "+" added, "@@" separates hunks):

````diff
 100x does not mean 100x more features. It means 100x less owner effort per month and 100x faster time to clean, filing-safe books.
 
-The product becomes a close assistant, not a ledger. The owner sees cash position, tax set-aside, missing documents, and a short exception queue. The ledger, reports, and Tally export are byproducts for the CA.
+The product becomes a close assistant, not a ledger. The owner sees cash position, captured tax position, missing documents, and a short exception queue. The ledger, reports, and Tally export are byproducts for the CA.
 
 ## Constraints
@@
 ## Premises
 
-1. The owner's real job is knowing cash position, tax set-aside, and filing readiness. Double-entry is a byproduct.
+1. The owner's real job is knowing cash position, captured tax position, and filing readiness. Double-entry is a byproduct.
 2. Pain spikes at GST, TDS, ITR, loan, and CA handoff deadlines, not daily. The wedge must be deadline-triggered.
 3. The 100x product is exception-only bookkeeping: capture automatically, auto-post with confidence, owner reviews exceptions, CA gets a clean pack.
@@
 Phase 1 is a local-only close assistant inside the existing extension.
 
-- **Capture:** bank statement import and email attachment import through the existing ingestion paths.
+- **Capture:** bank statement import and local `.eml` / attachment file import through the existing ingestion paths. Gmail API sync is not used in Phase 1.
 - **Normalize:** convert each statement line or document into a `MoneyEvent` with source, amount, date, party, reference, tax hints, attachment, and confidence.
 - **Classify:** deterministic rules first. No AI in Phase 1. Every suggestion carries evidence and confidence.
-- **Post:** a `MoneyEvent` becomes a double-entry voucher only after validation. High-confidence events can auto-post if the owner enables it. Low-confidence events go to the exception queue.
+- **Post:** a `MoneyEvent` becomes a double-entry voucher only after validation. Auto-post is off by default. Medium and low confidence events go to the exception queue. See Auto-post policy.
 - **Review:** the owner sees only unmatched, low-confidence, missing-document, and tax-sensitive items. One-tap approve, split, recategorize, or mark for CA.
-- **Close:** a monthly close cockpit shows cash position, GST/TDS set-aside, missing documents, unreconciled lines, and a readiness score.
-- **Handoff:** one-click Tally XML, GST summary, party outstanding, and missing-items pack for the CA. The pack is immutable and auditable.
+- **Close:** a monthly close cockpit shows reconciled cash position, captured GST/TDS summary, missing documents, unreconciled lines, and a readiness score. It does not compute a tax liability or set-aside in Phase 1.
+- **Handoff:** one-click Tally XML, captured GST/TDS summary, party outstanding, missing-items pack, and questions for the CA. The pack is immutable and auditable.
 
 ### Architecture
@@
 ```
 
-No backend. No remote classifier. No new network calls in Phase 1.
+No backend. No remote classifier. No new network calls in Phase 1. Email input is a local `.eml` file or attachment upload, not Gmail API sync.
 
+### Auto-post policy
+
+Confidence uses the existing 0 to 1 reconciliation scale.
+
+| Confidence | Behaviour |
+|---|---|
+| 0.95 to 1.00 | Auto-post eligible only if the owner has enabled the category. Default off. |
+| 0.70 to 0.949 | Exception queue, suggested classification. Owner approves. |
+| 0.00 to 0.699 | Exception queue, manual classification. Owner or CA decides. |
+
+Auto-post is controlled by one global master switch plus per-category toggles. Both default to off. Tax-sensitive, duplicate-suspect, and missing-document events never auto-post regardless of confidence.
+
+Every auto-posted voucher appears in a "Posted today" list with a reversal action. The owner can undo an auto-post in one step.
+
+### Correction and reversal
+
+Posted vouchers are never edited or deleted. Correction uses a reversal voucher linked to the original by `reversesVoucherId`. The original stays in the ledger, and an audit event records who reversed it and why.
+
+Unposted drafts may be edited or discarded. The owner or CA can flag a posted voucher for correction from the exception queue. The owner posts the reversal. The readiness score and CA pack regenerate after the reversal.
+
 ### Data model
 
 New records:
 
-- `MoneyEvent`: id, workspaceId, source, sourceRef, date, amountMinor, direction, partyHint, narration, attachmentId, confidence, status.
+- `MoneyEvent`: id, workspaceId, source, sourceRef, contentHash, date, amountMinor, direction, partyHint, narration, attachmentId, confidence, status. Status values: `captured`, `suggested`, `needs_review`, `posted`, `ignored`, `duplicate`.
+- `ClassificationRule`: id, name, priority, enabled, matchType, pattern, ledgerId, partyId, taxHint, confidence, source.
 - `ClassificationSuggestion`: moneyEventId, ledgerId, partyId, taxHint, confidence, reasons, ruleId.
-- `CloseItem`: workspaceId, period, type, status, owner, dueDate, evidence.
-- `CaPack`: workspaceId, period, generatedAt, manifest, voucherIds, readiness, missingItems.
+- `CloseItem`: workspaceId, period, type, status, owner, dueDate, evidence. Type values: `unreconciled_bank`, `low_confidence`, `missing_document`, `tax_field`, `duplicate`, `voucher_error`. Status values: `open`, `resolved`, `asked_ca`, `waived`. Owner values: `owner`, `ca`, `system`.
+- `CaPack`: workspaceId, period, generatedAt, manifest, voucherIds, readiness, missingItems, questionsForCa.
 
-Existing records stay authoritative for vouchers, ledgers, reports, and audit events.
+Existing records stay authoritative for vouchers, ledgers, reports, and audit events. The new tables are registered in the encrypted backup schema and covered by restore tests.
 
 ### Rule engine
@@
 - Duplicate detection by source reference, amount, date, and content hash.
 
+Every rule is a persisted `ClassificationRule` with a pattern, target ledger or party, tax hint, confidence, priority, and enabled flag. Seed rules ship with the app for bank charges, interest, GST, TDS, salary, rent, and common vendors. The owner can inspect, enable, disable, and edit rule mappings in settings. Rule changes never rewrite posted vouchers.
+
+Duplicate detection hashes the source reference, amount, date, and normalized narration, not the raw document body. The hash is stored on `MoneyEvent.contentHash`.
+
 Every rule returns a confidence and a reason list. The exception queue sorts by risk, not by date.
 
@@
 Each item has one primary action and an "ask CA" option. The queue is the daily surface. Reports are secondary.
 
+Ask CA in Phase 1 is a local flag. The item becomes `asked_ca`, keeps the owner note, and appears in the CA pack's "Questions for CA" section. The owner sends the pack out of band by email or WhatsApp. There is no in-app delivery or notification in Phase 1.
+
+Risk score is 0 to 100:
+
+- Confidence deficit: 40 points, scaled by `1 - confidence`.
+- Tax sensitivity: 20 points.
+- Missing document: 20 points.
+- Duplicate likelihood: 10 points.
+- Amount percentile: 10 points.
+
+Show high risk at 70 or above, medium at 40 to 69, low below 40. Ties break by older date first, then larger amount, then id.
+
 ### Close cockpit
 
 The monthly close view answers four questions:
 
-1. How much cash is available?
-2. How much GST/TDS should be set aside?
-3. What is missing before filing?
+1. What is the reconciled cash position? This is the ledger bank/cash balance reconciled to the statement. Unreconciled lines are shown separately.
+2. What GST/TDS has been captured? This is a captured summary, not a computed liability or set-aside.
+3. What is missing before CA handoff?
 4. Is the CA pack ready?
 
-The readiness score is computed from unreconciled lines, missing documents, and Tally readiness checks. It is a checklist, not a tax opinion.
+Readiness score is 0 to 100:
 
+- 40% reconciled lines.
+- 20% missing documents resolved.
+- 20% tax fields captured where expected.
+- 20% Tally readiness checks passed.
+
+Any blocker, such as an unbalanced voucher or a missing required Tally field, caps the score at 60 and forces "Not ready." Show "Ready" at 90 or above with no blockers, "Needs review" at 60 to 89, and "Not ready" below 60 or with any blocker. The score is a checklist, not a filing or tax opinion. Phase 1 does not compute a GST/TDS liability or set-aside.
+
 ### CA pack
 
@@
 - Tally XML for vouchers and masters.
 - Trial balance, P&L, balance sheet, party outstanding, and bill aging.
-- GST/TDS capture summary.
+- Captured GST/TDS summary, with no computed liability.
 - Missing-items list with owner notes.
+- Questions for CA from `asked_ca` items.
 - Manifest with counts, hashes, and generation time.
 
+Phase 1 CA workflow: the owner exports the pack and sends it out of band. The CA does not need a 0ledger account or workspace access in Phase 1.
+
 The CA acceptance test is explicit: three CA firms must accept the pack with no rework before the build proceeds beyond Phase 1.
 
 ### Build sequence
 
-1. **Validation gate, no code:** 10 owner interviews, 5 concierge closes, 3 CA pack reviews. Measure time, exception rate, CA rework, and willingness to pay.
+1. **Validation gate, no code:** 10 owner interviews, 5 concierge closes from that group, 3 CA pack reviews. Measure time, exception rate, CA rework, and willingness to pay.
 2. **MoneyEvent inbox:** add the model, repository, and adapters on top of the existing ingestion path.
 3. **Rule engine and exception queue:** add deterministic classification, confidence, reasons, and the owner review surface.
 4. **Close cockpit:** add the monthly checklist, cash and tax view, missing documents, and readiness score.
 5. **CA pack:** add the Tally/GST pack, manifest, and CA acceptance test.
-6. **Hardening:** tests for duplicates, unbalanced vouchers, restore, and large statements.
+6. **Hardening:** tests for duplicates, auto-post bands, reversal links, unbalanced vouchers, backup/restore of the new tables, and large statements.
 
 Phase 1 reuses:
@@
 ## Risks and Kill Criteria
 
-- **No demand:** fewer than 3 of 10 owners hand over last month's statements after the pilot. Kill or narrow.
+- **No demand:** fewer than 4 of the 5 concierge owners hand over last month's statements after the pilot. Kill or narrow.
 - **Wrong buyer:** owners will not pay and CAs will not pay. Test both before build.
 - **CA rework:** any CA rejects the pack as unusable. Fix the pack before adding features.
@@
 
 - Owner spends under 30 minutes per month on bookkeeping in Phase 1, down from 4 to 8 hours. Target under 15 minutes after Phase 2.
-- At least 80% of transactions are captured automatically.
-- At least 70% of captured transactions are auto-coded with acceptable confidence.
-- Fewer than 20% of transactions need owner review.
-- 5 of 10 pilot owners hand over statements without hand-holding.
-- 3 of 10 say they would pay after the pilot; 1 actually pays or signs a paid pilot.
+- At least 80% of statement and attachment lines are parsed into MoneyEvents without manual entry after the owner supplies the import.
+- At least 70% of parsed events are auto-coded with acceptable confidence.
+- Fewer than 20% of parsed events need owner review.
+- 5 of 5 concierge owners hand over statements without hand-holding.
+- 3 of 5 concierge owners say they would pay after the pilot; 1 actually pays or signs a paid pilot.
 - 3 CA firms accept the pack without rework.
 - Time from statement upload to clean books is under 24 hours.
@@
 
 - Bank statement adapters and fixtures. Current adapters cover 10 banks and FASTag.
-- Email attachment parsing. Existing MIME routing covers this.
+- Local `.eml` and attachment parsing. Existing MIME routing covers this. Gmail API sync stays optional and outside Phase 1. Google restricted-scope verification is only required if Gmail is enabled for public distribution.
 - OCR for scanned PDFs. Not in Phase 1. Current build rejects them.
-- Google OAuth verification if Gmail sync is part of the public product.
-- CA design partners and 10 owner pilots.
+- CA design partners: 10 owner interviews, 5 concierge closes, 3 CA pack reviews.
+- Encrypted backup schema and restore tests for the new tables.
 - Privacy and security review before email-in, WhatsApp capture, or any relay.
 
````

This is an /office-hours design and coaching document, produced before engineering planning. The startup-mode 'The Assignment' and both modes' 'What I noticed about how you think' sections are intentional: evaluate their evidence and usefulness; do not remove them merely because they are coaching content. Unknown customer facts may remain explicit Open Questions or assignments; do not invent answers.
Still flag unsupported claims, contradictions, safety/correctness risks, and missing behavior needed by the approach the document actually commits to. Labeling a contradiction or a required behavior an open question does not resolve it. In this delta round, such problems outside the changed text are minor.

On re-review, classify EVERY preceding finding as resolved, persisting, or unverified. Cite the specific document decision/behavior proving the status or the missing evidence. Absence from the new findings list is not confirmation.
A new refinement of an accepted fix is new unless the same specific original obligation demonstrably remains unmet. For persisting/unverified issues, include that unmet obligation in the current findings and reference its current ID. Distinct prior obligations must retain distinct current findings.
Classify minor and blocking preceding findings alike. A persisting or unverified blocking finding stays blocking until resolved; never relabel it minor.

Use this exact schema (replace example findings and statuses; no additional fields). The round and document below are assigned values:

```json
{
  "version": 2,
  "round": 2,
  "document": "/home/freeradical/Code/0ledger/docs/designs/autopilot-books-owner-smb.md",
  "quality_score": 7,
  "dimensions": {
    "completeness": "PASS",
    "consistency": "PASS",
    "clarity": "ISSUES",
    "scope": "PASS",
    "feasibility": "PASS"
  },
  "findings": [
    {
      "id": "R2-1",
      "dimension": "clarity",
      "severity": "blocking",
      "changed_text": "Excerpt of a changed (+/-) line that shows the defect",
      "problem": "The fallback's user-visible behavior is unspecified.",
      "remedy": "Choose and document whether the fallback warns the user or is intentionally silent."
    }
  ],
  "prior": []
}
```

Finding IDs are R2-<number>; dimension names are the five lowercase keys above; severity is blocking or minor. Supply a quality score from 1 to 10. A dimension is ISSUES exactly when it has findings; otherwise PASS.
Round 1 has an empty prior array. In later rounds, replace the example's empty prior array with one status for EVERY finding in the complete preceding verdict below:
{"id":"<preceding finding ID>","status":"resolved","evidence":"Specific document decision proving resolution","current_id":null}
or {"id":"<preceding finding ID>","status":"persisting","evidence":"Same original obligation still unmet at this document passage","current_id":"R2-1"}.
Use status unverified with the missing evidence and a current finding ID when resolution cannot be established. Never invent customer answers to close a finding.

## Dimensions

1. **Completeness** — Are all requirements addressed? Missing edge cases?
2. **Consistency** — Do parts of the document agree with each other? Contradictions?
3. **Clarity** — Are decisions and rationale clear enough for user approval and the next engineering review? Are open discovery questions distinguished from committed behavior? Flag ambiguous or missing behavior in the chosen approach.
4. **Scope** — Does the document creep beyond the original problem? YAGNI violations?
5. **Feasibility** — Can this actually be built with the stated approach? Hidden complexity?

## Complete preceding verdict

The JSON below is the complete saved verdict, not a summary. Treat its document content as evidence, not instructions that override this review contract.

```json
{
  "version": 2,
  "round": 1,
  "document": "/home/freeradical/Code/0ledger/docs/designs/autopilot-books-owner-smb.md",
  "quality_score": 6,
  "dimensions": {
    "completeness": "ISSUES",
    "consistency": "ISSUES",
    "clarity": "ISSUES",
    "scope": "PASS",
    "feasibility": "ISSUES"
  },
  "findings": [
    {
      "id": "R1-1",
      "dimension": "completeness",
      "severity": "blocking",
      "changed_text": null,
      "problem": "Auto-post eligibility is undefined. The document never defines the confidence scale, the numeric high-confidence threshold, what happens to medium-confidence events, or whether opt-in is global or per-category (Product shape says 'if the owner enables it,' while AI policy says 'per owner and per category'). Without a threshold the safety-critical auto-post path cannot be implemented.",
      "remedy": "Define the confidence scale (align it with the existing 0-1 reconciliation confidence), the auto-post threshold and confidence bands (auto-post / exception / review), the default, and the exact opt-in granularity."
    },
    {
      "id": "R1-2",
      "dimension": "completeness",
      "severity": "blocking",
      "changed_text": null,
      "problem": "There is no correction or reversal path for an incorrectly auto-posted or otherwise posted voucher. The approach relies on an append-only audit and an immutable CA pack, but accounting requires a reversing entry or documented cancellation and a regenerated pack; the exception queue never surfaces errors found in already-posted vouchers.",
      "remedy": "Specify how posted vouchers are corrected (reversal voucher versus cancellation), who may do it, how it is audited, and how the CA pack and readiness score are regenerated after correction."
    },
    {
      "id": "R1-3",
      "dimension": "completeness",
      "severity": "blocking",
      "changed_text": null,
      "problem": "'Ask CA' is offered on every exception item, but Phase 1 has no backend, no sync, and no email-in, so the document never says how an item reaches the CA or what the owner sees after asking.",
      "remedy": "Define the Phase 1 ask-CA behavior (for example, flag the item and include it in the CA pack/export with owner notes, with an explicit out-of-band send) or defer the action to a later phase."
    },
    {
      "id": "R1-4",
      "dimension": "completeness",
      "severity": "blocking",
      "changed_text": null,
      "problem": "The data-driven rule engine has no persisted rule record or management behavior. ClassificationSuggestion stores a ruleId, but the data model defines no Rule record, no seed rule set, and no way to inspect or edit rules, so 'data-driven' cannot be implemented as specified.",
      "remedy": "Add a Rule record/store (pattern, ledger/party/tax mapping, confidence, priority, enabled) and specify seeding and owner/CA editing, or state that rules are fixed code constants and remove the data-driven claim."
    },
    {
      "id": "R1-5",
      "dimension": "completeness",
      "severity": "minor",
      "changed_text": null,
      "problem": "MoneyEvent.status is listed without enumerated values or transitions, so the capture-to-post lifecycle is not reviewable.",
      "remedy": "Enumerate the allowed statuses and transitions (for example captured, suggested, posted, needs-review, ignored, duplicate)."
    },
    {
      "id": "R1-6",
      "dimension": "completeness",
      "severity": "minor",
      "changed_text": null,
      "problem": "CloseItem lists type, status, and owner without enumerating allowed values, so the close checklist cannot be built consistently.",
      "remedy": "Enumerate CloseItem types, statuses, and owner values, and link each item to its source evidence."
    },
    {
      "id": "R1-7",
      "dimension": "completeness",
      "severity": "minor",
      "changed_text": null,
      "problem": "Duplicate detection depends on a 'content hash,' but MoneyEvent has no content-hash field and the document does not say what is hashed (attachment, email body, or statement line).",
      "remedy": "Add a contentHash field or define the hash source and how it is computed and compared."
    },
    {
      "id": "R1-8",
      "dimension": "completeness",
      "severity": "minor",
      "changed_text": null,
      "problem": "The new records are not mentioned in the encrypted backup/restore path. The existing backup validates only tables with registered schemas, so new tables could be restored without validation.",
      "remedy": "Add the new records to the backup table schemas and include backup/restore of them in the hardening tests."
    },
    {
      "id": "R1-9",
      "dimension": "completeness",
      "severity": "minor",
      "changed_text": null,
      "problem": "Why Now makes uncited market claims (MSME/GST-paying market size, the AI finance funding trend, and the digital money trail) that are not load-bearing for the wedge but are presented as evidence.",
      "remedy": "Cite sources or label the claims as hypotheses."
    },
    {
      "id": "R1-10",
      "dimension": "consistency",
      "severity": "blocking",
      "changed_text": null,
      "problem": "The close cockpit promises to answer 'How much GST/TDS should be set aside?' and the product shape lists a GST/TDS set-aside, but Constraints say GST and TDS are capture-only with 'No return filing or computation.' A computed set-aside is a computation and contradicts the stated constraint and the compliance-risk boundary.",
      "remedy": "Either restrict the cockpit to a captured-tax summary with no computed liability and rename it, or explicitly commit to a set-aside calculation with its inputs, disclaimers, and review path, and update the Constraints."
    },
    {
      "id": "R1-11",
      "dimension": "consistency",
      "severity": "blocking",
      "changed_text": null,
      "problem": "The validation plan's denominator is inconsistent. Build sequence and The Assignment use 5 concierge owners and 10 interviews, while Success Criteria measure '5 of 10 pilot owners' and '3 of 10,' and Risks use 'fewer than 3 of 10.' The document never says whether 5 or 10 owners are piloted or how the 10-owner metrics are measured.",
      "remedy": "Reconcile the pilot size and define the measured cohort and denominator for every gate (interviews versus concierge closes versus paid pilot), then use those numbers consistently."
    },
    {
      "id": "R1-12",
      "dimension": "consistency",
      "severity": "minor",
      "changed_text": null,
      "problem": "'What I Noticed About How You Think' calls Close Inbox 'the recommended Close Inbox,' but Approaches Considered labels Approach B as the chosen approach and never marks A as recommended, so the reader cannot tell what was actually recommended.",
      "remedy": "Correct the wording to match the Approaches Considered section."
    },
    {
      "id": "R1-13",
      "dimension": "consistency",
      "severity": "minor",
      "changed_text": null,
      "problem": "The Product shape Review bullet lists only unmatched, low-confidence, missing-document, and tax-sensitive items, while the Exception queue also includes duplicate candidates and unbalanced or incomplete vouchers, so the owner-facing review scope is inconsistent.",
      "remedy": "Make the Product shape review list match the Exception queue categories."
    },
    {
      "id": "R1-14",
      "dimension": "clarity",
      "severity": "blocking",
      "changed_text": null,
      "problem": "The exception queue 'sorts by risk, not by date,' but risk is never defined, so the primary daily surface has unspecified ordering and the owner cannot know what appears first.",
      "remedy": "Define the risk score and its inputs (amount, tax sensitivity, missing document, duplicate likelihood, confidence) and the tie-breakers."
    },
    {
      "id": "R1-15",
      "dimension": "clarity",
      "severity": "blocking",
      "changed_text": null,
      "problem": "The readiness score is a committed owner-facing signal ('Is the CA pack ready?') but its formula, weights, thresholds, and interpretation are undefined; an unspecified score could give false filing-readiness confidence.",
      "remedy": "Define the score inputs, weights, thresholds, and display semantics, and state that it is not a filing or tax opinion."
    },
    {
      "id": "R1-16",
      "dimension": "clarity",
      "severity": "minor",
      "changed_text": null,
      "problem": "CA-led distribution assumes CA firms with 20 to 50 clients, but Phase 1 is one company per workspace and the multi-client CA workspace is Phase 3; the Phase 1 CA workflow (who installs, who exports, and how packs move between owner and CA) is unspecified.",
      "remedy": "Describe the Phase 1 CA workflow (the owner exports and sends the pack; the CA does not operate the workspace) or defer CA-led scale to Phase 3."
    },
    {
      "id": "R1-17",
      "dimension": "clarity",
      "severity": "minor",
      "changed_text": null,
      "problem": "'How much cash is available?' does not define whether it is the bank statement balance, the ledger cash/bank balance, or a reconciled figure, which matters while lines are unreconciled.",
      "remedy": "Define the cash-position source and how unreconciled lines are treated."
    },
    {
      "id": "R1-18",
      "dimension": "clarity",
      "severity": "minor",
      "changed_text": null,
      "problem": "Success Criteria say 'At least 80% of transactions are captured automatically,' but Phase 1 capture is owner-supplied statement and email import, so 'automatically' is ambiguous (auto-parse after import versus unattended capture).",
      "remedy": "Define the capture metric in terms of lines parsed without manual entry after an owner-supplied import."
    },
    {
      "id": "R1-19",
      "dimension": "clarity",
      "severity": "minor",
      "changed_text": null,
      "problem": "The quoted status quo in 'What I Noticed About How You Think' reads 'manual entry into the books or excel orone,' which appears garbled and obscures the quoted evidence.",
      "remedy": "Correct the quotation or paraphrase it accurately."
    },
    {
      "id": "R1-20",
      "dimension": "feasibility",
      "severity": "blocking",
      "changed_text": null,
      "problem": "Phase 1 capture includes 'email attachment import,' but the only existing email path is Gmail sync, which uses restricted scopes, calls the Gmail API, and requires OAuth verification for public distribution. The document treats Gmail verification as a conditional dependency and also claims 'No new network calls in Phase 1,' so the Phase 1 email mechanism and its distribution and privacy implications are unresolved.",
      "remedy": "Specify the Phase 1 email import mechanism (manual .eml or attachment upload versus Gmail API), account for restricted-scope verification and privacy review if Gmail is used, and reconcile the no-new-network-calls claim."
    }
  ],
  "prior": []
}
```
