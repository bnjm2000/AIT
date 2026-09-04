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

## What is learned

- Amount-line layout cues, normalized to remove numeric values and then hashed.
- The position of a candidate when a line contains several amounts.
- Repeated evidence that a candidate represents the reviewed payable total or a
  non-total value. A pattern needs at least two distinct documents and no
  contradictory examples before it affects scoring.
- Native PDF extraction and local RapidOCR remain responsible for reading text.
  Learning selects among numbers actually read from the new document; it cannot
  invent a missing total, repair unreadable digits, or copy a past payable amount.

Only reviewed Approved/Paid records with a positive amount supply labels. Denied,
pending, missing, unsupported, conflicting, and unreadable examples are reported
as exclusions. Byte-identical uploads count once, preventing duplicate files from
inflating support or leaking into their own evaluation.

Evaluation leaves each document out of its own training and compares exact amount
agreement with the reviewed value. A new profile is not published if any evaluated
document regresses. This is an internal validation result, not a guarantee of
accuracy on new vendors, layouts or low-quality scans.

## Saved files

Files live in the company's durable data folder:

- `DocumentDetectionLearning.json`: fixed, versioned profile and snapshot digest;
  contains hashed cues and score adjustments, not original text or prior amounts.
- `DocumentDetectionTrainingReport.json`: counts, exclusions and validation metrics.
- `DocumentDetectionTrainingCache.json`: company-private, content-hash-keyed numeric
  candidates and hashed cues, so an explicitly requested rerun need not repeat OCR.
  It contains extracted numeric values, but not raw OCR text or uploaded files.

Deleting or setting `enabled` to `false` in the learning profile restores baseline
amount detection. A missing or malformed profile also falls back safely.

## Date handling

Dates still use the existing local date parser, not an automatically trained model.
The current-document audit identified overnight parking receipts with labelled IN
and OUT dates. A targeted rule prefers OUT/exit when both entry and exit dates are
present. Other formats and the existing due-date/expiry penalties are unchanged.
