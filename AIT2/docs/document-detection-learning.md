# One-time invoice and claim calibration

`document_learning.py` explicitly trains a company-local amount-scoring profile
from a fixed snapshot of existing uploads. Uploading, reviewing, approving or
paying future documents does **not** retrain it. The runtime only reads the saved
profile. No files or document contents are sent to an AI service.

## Running a new snapshot (only when requested)

For PostgreSQL deployments, use the database rather than an older `Workforce.json`
export. The connection is read-only and uses the application's configured
`DATABASE_URL`; it never initializes schema or updates financial records.

```powershell
.\.venv\Scripts\python.exe document_learning.py --data-folder ..\showbase-storage\companies\AVPL\data --from-database --inventory-only
.\.venv\Scripts\python.exe document_learning.py --data-folder ..\showbase-storage\companies\AVPL\data --from-database --apply
```

For file-backed installations, omit `--from-database`. Omitting `--apply` evaluates
without saving a model or cache. Repeat `--data-folder` to process other companies;
profiles and training examples never cross company boundaries.

To stage a reviewable model, add `--output-folder tmp/audit-document-detection/AVPL`
with `--apply` and one company. Only the output folder is written; source records
and the active profile are untouched. Publish the staged profile only after
reviewing its report and validating the matching extractor version.

## What is learned

- Amount-line layout cues, normalized to remove numeric values and then hashed.
- The position of a candidate when a line contains several amounts.
- Repeated evidence that a candidate represents the reviewed payable total or a
  non-total value. A pattern needs at least two distinct documents and no
  contradictory examples before it affects scoring.
- Native PDF extraction and local RapidOCR remain responsible for reading text.
  Learning selects among numbers actually read from the new document; it cannot
  invent a missing total, repair unreadable digits, or copy a past payable amount.

Only reviewed Approved/Paid records with a positive amount supply labels. Reviewed
Profit & Loss expense attachments also supply labels when `needsReview` is false
and a user and timestamp identify the saved review. Denied,
pending, missing, unsupported, conflicting, and unreadable examples are reported
as exclusions. Byte-identical uploads count once, preventing duplicate files from
inflating support or leaking into their own evaluation.

Evaluation leaves each document out of its own training and compares exact amount
agreement with the reviewed value. A new profile is not published if any evaluated
document regresses against baseline or the previous profile, and the complete
published profile is checked separately. The previous-profile comparison uses the
current extractor; historical end-to-end comparisons belong in the audit report.
This is an internal validation result, not a guarantee of
accuracy on new vendors, layouts or low-quality scans.

## Saved files

Files live in the company's durable data folder:

- `DocumentDetectionLearning.json`: fixed, versioned profile and snapshot digest;
  contains hashed cues and score adjustments, not original text or prior amounts.
- `DocumentDetectionTrainingReport.json`: counts, exclusions and validation metrics.
- `DocumentDetectionTrainingCache.json`: company-private, content-hash-keyed numeric
  candidates and hashed cues, so an explicitly requested rerun need not repeat OCR.
  It contains extracted numeric values, but not raw OCR text or uploaded files.
- `DocumentDetectionLabelExclusions.json`: content hashes and explicit audit reasons
  for records whose reviewed amount is not the full document total (such as a
  partial event allocation or an amount before GST). Exclusions affect training
  only and do not edit accounting records.

Caches carry `extractorVersion` and are invalidated when extraction changes. One
unreadable document is reported without aborting the entire training run. No
profile is replaced when validation fails or there are no usable labels.

Deleting or setting `enabled` to `false` in the learning profile restores baseline
amount detection. A missing or malformed profile also falls back safely.

## Date handling

Dates use the local parser rather than a trained model. It prefers OUT/exit over
entry on overnight parking receipts, handles dates joined to OCR timestamps, and
accepts month/day order only when day/month order is impossible. Ambiguous dates
remain day-first; due dates and expiry dates retain their penalties.

The live extractor and trainer share PDF/OCR routing. Character-spaced text and
unlabelled invoice layouts receive OCR fallback; date-only fallback preserves a
stronger native amount. Currency OCR repairs are limited to specific patterns
such as `$O.65` and `SS11.30`. Explicit foreign-currency totals require the actual
SGD charge instead of treating the foreign number as SGD.

Extractor version 3 also handles invoices whose single amount-column table ends
with an unlabelled printed total. For these PDFs, it checks visual reading order
and confirms that the printed summary equals the dated line items to the cent.
This check runs even when a repeated item price scored High in the original text.
It requires one readable amount per row and a unique matching printed summary;
it does not infer a missing total, hard-code a vendor, or use past invoice values.
Training and runtime share this routing, and version-2 candidate caches are
invalidated on the next explicitly requested calibration.
