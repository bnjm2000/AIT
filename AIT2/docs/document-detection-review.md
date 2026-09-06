# Document detection review - 6 September 2026

The current database inventory covered 122 uploaded records: 119 AVPL worker and
transport submissions, one AVPL Profit & Loss receipt, and two SP submissions.
The other four companies had no relevant uploaded submissions. One legacy
spreadsheet remains a manual-entry document; the PDF/image uploads were audited
locally without sending documents to an external AI service.

## Findings and changes

- A long transaction identifier on a shopping receipt triggered
  `decimal.InvalidOperation`, aborting extraction. Invalid and oversized numbers
  are now handled safely; dates, times and segmented references no longer compete
  as payable amounts.
- Repeated item prices, quantities, referral offers and card balances sometimes
  outranked totals. The parser now gives directly labelled totals and sole
  subtotal summaries appropriate priority.
- PDF text could be collapsed into one line, spaced character by character, or
  ordered independently of its visual layout. The PDF/OCR fallback now handles
  these cases and preserves a strong native amount when OCR is needed for a date.
- Receipts containing `SS11.30`, `$O.65`, Chinese-labelled SGD payments, or dates
  joined to times now have targeted parsing support. Foreign-currency totals need
  the actual SGD charge and are not automatically converted.
- The trainer now includes reviewed expense attachments, versions its candidate
  cache, isolates per-document extraction failures, and checks both held-out
  predictions and the complete candidate profile before publication.

## Calibration and validation

AVPL had 101 reviewed records. Three labels were excluded after visual inspection
because they were partial or before-GST amounts rather than full invoice totals.
One byte-identical duplicate counted once, and one foreign-currency invoice had no
printed SGD amount matching its reviewed charge. This left 96 distinct documents
with usable total labels. SP's two documents were unreviewed and supplied no labels.

On those same 96 documents, original detection matched 83 reviewed totals (86.5%);
the corrected extractor and refreshed calibration matched 96 (100%). The failed
shopping receipt is included in this comparison. The expense receipt's original
result comes from its saved extraction metadata. All 37 labelled claim/expense
dates matched after applying the normal filename fallback where necessary.

The refreshed AVPL profile contains 164 invoice cues and 83 claim cues. Its
leave-one-document-out check and full-profile check each matched all 96 totals,
with no regressions. The parser changes were informed by this audit, so these are
internal historical results, not an untouched test set or a guarantee about new
vendors, layouts, currencies, or unreadable scans.

Existing financial amounts, statuses and original attachments were not rewritten.
Only the company-local detection profile, training metadata and extractor code
are updated. Future uploads read the saved calibration; they do not automatically
retrain it from unreviewed predictions.

## Activation

The refreshed AVPL profile and both companies' reports were installed on
6 September 2026 with the previous calibration files backed up. The existing
`AIM Web App` scheduled service was restarted and both its local login endpoint
and public HTTPS login returned HTTP 200. Database hashes confirmed that workforce
and finance records remained unchanged after publication and restart.

Validation passed 840 regression tests (one skipped), plus fresh local extraction
of five representative uploaded documents: a character-spaced PDF, an invoice
ending at Subtotal, the shopping receipt that previously crashed, a parking
receipt with a misread zero, and a foreign-currency invoice requiring manual SGD
entry.
