# Invoicing workflow review — 5 September 2026

## Scope and safety

This pass focused on the Invoicing page, its billing-plan and invoice APIs, accessibility, responsive layout, and concurrent editing. It preserves the established visual design and invoice lifecycle. Receipt allocation is now explicit because unallocated receipts previously could be counted again by the mark-paid action.

Changes are local workspace changes, not a production deployment. Browser checks used a disposable local sample company, not customer records or the live DEMO company. Unrelated existing workspace changes were preserved. This is not a certification of all application features or all live user accounts.

## Corrected issues

- Partial receipts now update invoice balances and payment status consistently. Removing a receipt reopens the balance and clears obsolete settlement dates.
- Mark-paid records only the remaining amount, rejects void invoices and stale confirmations, and asks users to allocate existing advance/unallocated receipts before collecting the balance again.
- Receipt allocations and issued-installment links must belong to the correct quotation. Unknown or duplicate installment links are rejected before synchronization.
- Repeated invoice creation returns the existing invoice and complete editor state. The response uses the saved document version. Zero-value issuance is rejected consistently with the existing editor rule.
- Invoice issuance and payment confirmation validate the amount being confirmed. Deletion validates the captured invoice version, protecting payments added while a confirmation is open.
- Save operations are serialized. Navigation and PDF/receipt exports wait for outstanding saves. New edits made during a save are retained.
- Unrelated realtime events no longer close the active billing plan. Delayed responses cannot replace a different plan or a newer queued version.
- Same-field conflicts retain the original comparison base when the user selects Review First; this choice no longer implicitly authorizes an overwrite on a later autosave.
- Server-merged changes are reflected in the editor. Ordinary saves update relevant fragments without replacing the whole form; necessary editor replacements preserve focus, selection and scroll. Open dropdown interactions defer replacement.
- Background list updates retain loaded pages, query text, and position. Failed refreshes preserve the existing list instead of replacing it with an error screen.
- Receipt buttons enable after entering a positive amount, and billing-history payment text stays current.
- Payment deletion and due-date dialogs bind to stable row IDs, so inserted rows or a switched quotation cannot redirect an action to the wrong record.
- Discounted installment conversions and voided-invoice replacement presets use the correct remaining total. Over-allocation is identified accurately.
- Keyboard status-menu navigation, expanded state, focus return, live save announcements, the client-name label, and nested landmark markup were corrected.
- Client-selection controls no longer extend beyond phone-width pages. Existing styling is retained.

## Verification

- Final targeted Python run: **189 passed** across invoicing workflow, finance features, and finance concurrency.
- JavaScript runner: **44 checks passed**, including invoice editor, async dialogs, finance status, and the existing accounting UI harness.
- Final full Python suite: **933 passed, 8 skipped, 1 unrelated failure**. The failure is `test_event_menus_are_portaled_clamped_and_restored` in `tests/test_event_overview_ui.py`; it expects an old literal source expression in the Events menu implementation. That Events code/test was not changed in this pass.
- Browser sample: draft invoice → sent → partial receipt → mark remaining balance paid. Verified that a $125 receipt on a $500 invoice leaves $375 and that settlement records only $375.
- Browser checks: autosave preserves input focus; receipt export enables; history updates; search retains focus/value; issued-invoice balances display correctly; keyboard status actions work.
- Two editor sessions: separate PO-reference and venue changes merged successfully. Focused fields were not interrupted; deferred changes appeared on leaving the field.
- Responsive checks: phone viewport 390 × 844 (375px usable content width) and tablet viewport 768 × 1024. Tested invoice controls fit without horizontal overflow. This does not replace real-device or screen-reader testing.
- No browser console errors observed in the final sample editor session.

## Remaining observations and recommendations

1. **Status wording:** billing-plan status intentionally summarizes issued invoices, not the entire quotation. A paid $500 deposit against a $1,090 quotation can therefore show “Paid” while $590 remains uninvoiced. This behavior is explicit in the existing implementation and was preserved. Consider naming this “Issued invoice status” separately from quotation billing completion if it confuses users.
2. **Shared dropdown polling:** `static/js/custom-select.js` scans and synchronizes all enhanced selects every 400ms, even when idle. This is unnecessary background work on long forms. Prefer change-driven synchronization plus explicit updates after programmatic selection changes; retain a fallback only where needed. It was not changed globally in this invoicing pass.
3. **Large-company performance:** invoice directory refreshes and finance synchronization still operate over the shared finance document collection. The UI now keeps its context and requests only the required pages, but this is not a production-scale load benchmark. Indexed server queries and row-level realtime updates are the longer-term alternative to repeatedly scanning and refreshing list pages.
4. **Accessibility follow-up:** the shared custom-select component exposes both its native control and custom button to accessibility APIs; its visible button does not inherit the select's explicit label. A shared-component accessibility pass should validate one clearly named interactive control with actual screen readers. This was observed, not changed globally.
5. **Deployment acceptance:** these fixes have not been deployed to `avpl2.asuscomm.com`. A deployed smoke test with the actual role accounts and representative company data remains necessary. No claim is made that the costing, event, logistics, inventory, or maintenance workflows were re-audited in this invoicing-focused pass.

## Reproduction

Use the repository virtual environment and disable bytecode/cache writes for test runs:

```powershell
$env:PYTHONDONTWRITEBYTECODE = '1'
& '.\.venv\Scripts\python.exe' -B -m pytest tests/test_invoicing_workflow.py tests/test_finance.py tests/test_finance_concurrency.py -q -p no:cacheprovider
node --test tests/test_invoices_ui.cjs tests/test_invoice_dialogs_ui.cjs tests/test_finance_status_ui.cjs tests/test_accounting_ui.cjs
```

`tmp/invoicing_review_preview.py` starts a localhost-only, disposable sample using the test fixture. It is a review utility, not a production server.
