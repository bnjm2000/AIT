# Dean invoice extraction - 15 September 2026

Dean Chua's latest uploaded invoice showed seven dated line items (six at $200
and one at $250) and an unlabelled $1,450 total. The PDF serialized its cells out
of visual order. The repeated $200 entries received a High score, so the previous
fallback did not run and the app prefilled $200.

The extractor now checks visual PDF order for invoices without total labels.
It accepts a table summary only when it is printed below the dated rows and
equals their sum to the cent. Ambiguous price columns, unreadable dated rows,
discount/tax sections, and multiple matching summaries leave the established
fallback in place. No vendor identity or historical amount is embedded in the
rule. Runtime extraction and offline calibration share the same routing.

All four current Dean invoices were visually checked and extracted directly from
their PDF files without OCR:

| Uploaded invoice | Detected total |
| --- | ---: |
| Dean_invoice9_AVEC.pdf | $450.00 |
| Dean_invoice10_AVEC.pdf | $200.00 |
| Dean_invoice11_AVE.pdf | $200.00 |
| Dean_invoice12_AVEC.pdf | $1,450.00 |

All 24 detection/calibration tests passed, including a synthetic PDF with cells
written out of order, repeated item prices, and different amounts from Dean's
documents. Runtime and training predictions agree. The previous 96-document
validation set retained 96 correct totals; that check reused cached OCR text
while re-reading PDF text and layout.

The full suite ran 919 tests with four failures, one error, and one skip. All five
unsuccessful tests reproduced with the unchanged version-2 extractor: two event
closure expectations, invoice overdue status, a delivery-order source assertion,
and an undefined variable in an existing finance test. They are unrelated to this
invoice extraction change.

Existing financial amounts and statuses are not rewritten. The saved local
calibration stays in place; extractor version 3 invalidates old candidate caches
on a future explicit training run.

The existing AIM Web App service was restarted to load the fix. Its new local
process and public HTTPS login both responded successfully (HTTP 200). All four
Dean submission records were compared after activation and remained identical,
including their manually entered amounts and review statuses. Company-wide
snapshot hashes changed for AVPL and AVERY during the session, so this review
does not claim that all other concurrent business records were unchanged.
