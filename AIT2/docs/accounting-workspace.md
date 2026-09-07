# Singapore accounting workspace

The Accounting page uses the active company's finance store. Existing event,
quotation, invoice, claims and costing data are retained. New business rules live
in `services/accounting_workspace.py`; reports in `services/accounting_reports.py`;
new HTTP routes in `routes/accounting.py`. Period close and filing preparation
live in `services/accounting_close.py`; Excel exports in
`services/accounting_exports.py`; document previews and PDFs in
`services/accounting_documents.py`.

## Start here

1. Accounting is fully editable only by active company admins. Platform owners
   have read-only page, report and export access. In
   **Settings → Books & permissions**, select the reporting framework, identify
   cash accounts and enable trading inventory if needed.
2. In **Settings → GST & period lock**, confirm GST registration, financial year
   and control accounts. The functional/reporting currency is SGD and the books
   use accrual accounting. SR9/TX9 represent 9% GST.
   In **Books & permissions**, select the operating revenue accounts for GST
   Box 13. The initial selection excludes the default Other Income accounts;
   confirm the selection against the company's actual revenue classifications.
3. Review **Sales → Review existing app documents**. Posting a source creates one
   journal and links its invoice or bill to AR/AP. **Link earlier posted documents**
   links historical source journals without posting them again. Manual control
   account balances are shown as reconciliation differences in aging reports.
4. Enter opening balances as balanced journal drafts. Attach the opening balance
   schedule and have another accountant review before posting. There is no full
   migration wizard or opening AR/AP import: a journal to a control account alone
   does not create the corresponding customer or supplier open items. Reconcile
   the opening ledger, subledgers, stock and assets before using the new books.

## Daily work

- **Sales:** quotation → approval → convert to invoice → review/post → allocate
  receipts → customer statement. Credit notes can be applied to an invoice or
  refunded. Documents retain their original currency and SGD exchange rate.
- **Purchases:** purchase order → approval → convert to bill → review/post →
  allocate payments. Vendor credits can be applied to bills or refunded.
- **Expenses / receive money:** direct cash transactions for items that do not
  use the receivable or payable subledger, including liability payments. Choose
  GST-inclusive or exclusive line prices. BL9 adds non-claimable 9% GST to the
  expense/asset cost and excludes it from GST Boxes 5 and 7. The legacy BL code
  expects the full gross cost. An incorrect direct cash entry can be reversed
  with a dated, audited correction; record actual refunds as new transactions.
- **Banking:** record payments against invoices/bills first, import the statement,
  then match existing cash entries. One statement line can match a group of
  posted cash journals, such as a batch of receipts or payments. The selection
  shows its total and difference and must equal the statement amount for the
  selected bank account. Already matched journals cannot be reused. Reversing
  a constituent entry releases the whole group for reconciliation again.
  Use a new cash transaction only when the item has not already been booked.
  Enter the actual statement closing balance and
  review the reconciliation report. A zero movement difference alone does not
  establish a completed reconciliation. The report bridges the statement and
  ledger balances using outstanding cash entries and unbooked statement items,
  including items from earlier periods. Retain source bank statements against
  saved closing balances in **Banking → Retained statement balances**.
- **Documents:** save a draft, then attach source files. Posted documents retain
  their source files. Downloads require company accounting access. The allowed
  formats are PDF, images, CSV, XLSX, DOCX and text, up to 10 MB per attachment.
  Files are stored under the company's backend `accounting_documents` folder;
  include that folder in backups alongside the finance store.
- **Preview / PDF:** open a saved document to preview, download its paginated PDF
  or print it. Business and customer/supplier details are captured on approval
  or posting, so later directory or settings changes do not rewrite issued
  details. Drafts and incomplete documents carry review warnings; historical
  documents whose details were captured later must be checked against the
  retained original. The output groups supplies by tax treatment and includes
  totals excluding GST, GST and totals including GST. Foreign-currency documents
  also show all three totals in SGD using the document's recorded rate and
  the same per-line rounding as the ledger. Review required identity and GST
  details before issue; a PDF download is not InvoiceNow transmission.

Company admins have full accounting access. Platform owners can open the page,
view reports and download exports, but every Accounting mutation is rejected.
Owners are omitted from the Accounting access list and cannot gain additional
permissions from an old accounting-specific assignment in stored settings.
Application managers and users cannot open the page or call its APIs.
Enabling independent approval prevents the creator, last editor or submitter
from approving their own document, so the company needs another company admin
for that review. Manual journals must likewise be saved as drafts
and posted by another authorised administrator.

Posted documents are corrected with credit notes. Payment reversals retain an
opposite journal and settlement event, preserving historical aging. Generated
subledger journals cannot be edited, deleted or reversed independently of their
source records. Acquisition journals linked to the fixed asset register are also
protected from independent reversal. Other posted journals are corrected by
dated reversal.

Use **Unapply credit** in the settlement history to correct an eligible credit
allocation. It retains a dated reason and opposite settlement records, restores
both open balances and reverses any associated realised FX entry. Corrections
must respect later settlements/revaluations and period locks. Legacy allocations
without an identifiable linked pair require separate reviewed correction;
they are not silently altered.

## Month-end

1. Resolve submitted documents and assigned tasks in **Tasks & approvals**.
   Recurring schedules generate drafts on demand, once per scheduled date, for
   ordinary review and approval; they do not silently auto-post.
2. Reconcile receipts/payments and enter bank statement closing balances.
3. Register fixed assets against acquisition journals already in the ledger.
   Straight-line depreciation charges a full month at month end, including the
   service month, capped at residual value. Repeated runs post only the increment.
4. Add closing FX rates with their source in **Settings → Currencies**. Review
   AR/AP aging, then post revaluation. Rates are SGD per unit of foreign currency.
   Settlements recognise realised exchange differences and update carrying values.
5. Review reports and resolve unallocated AR/AP differences, missing FX rates,
   unclassified cash flows and unposted depreciation.
6. Complete GST working papers and financial statement review, then lock the
   posting period in Settings.

## Close and filing preparation

The **Close & filing** tab has four views:

1. **Period checks** identifies unbalanced books, AR/AP control differences,
   unposted documents, missing closing rates, FX differences, depreciation,
   unresolved bank items, missing purchase evidence, tasks and recurring drafts.
   Follow each check to its supporting report or workflow. Existing app source
   documents awaiting posting are also highlighted.
2. **Filing register** records the obligation, period, portal-confirmed due date,
   assignee, working paper and supporting files. It supports GST F5, ECI,
   corporate income tax, ACRA annual returns, GST corrections/F7, final GST/F8,
   withholding tax, employment income/AIS and other obligations. These are
   preparation/evidence workflows, not direct filing integrations.
   Filing attachments also accept XML, XBRL and ZIP packages (10 MB per file).
3. **Saved report packs** retains the schedules, period checks and source data
   captured at creation. Download the Excel workbook or the JSON data snapshot.
   Later ledger changes do not alter a retained pack. Attachment references are
   included; the JSON download does not contain the source file binaries.
4. **Filing guide** explains all nine obligation types, preparation steps and
   general deadline rules, with official IRAS/ACRA guidance and portal links.
   Guidance was checked on 5 September 2026. Confirm the company's actual
   obligation and due date with the authority; these rules do not automatically
   calculate company-specific deadlines, extensions or exemptions. The same
   guidance appears when preparing a filing, before saving a draft.

Filing forms show preparation instructions appropriate to the selected
obligation. Year of Assessment is shown for ECI and corporate income tax;
the other obligations use their reporting period without an irrelevant YA field.

For GST F5, the working paper separates ledger figures, adjustments and proposed
declarations. Boxes 4 and 8 are derived. Special declarations require explicit
values, including zero where not applicable, before review. Adjustments require
an explanation and supporting journal/schedule reference. They do not silently
post to the ledger or add special declarations into other boxes a second time.

ECI and corporate income tax working papers start with book profit and retain
signed adjustments and schedule references. The accountant enters proposed
declared income from the reviewed tax computation. The app does not determine
allowance/relief eligibility, automatically calculate final tax, or generate
every corporate tax form. Withholding/AIS and ACRA packages must be attached
from the applicable preparation tools. Annual-return, GST F7/F8, withholding
and employment-income records require an attached prepared package or filing
assessment before review. F8 needs a final-return and deregistration asset
assessment; the ordinary F5 report alone is insufficient. Review retains the
attachment identities and hash metadata, which are included with exported
review evidence.

The review checklist covers scope, reconciliations, tax treatment, supporting
documents and submission authority. Outstanding period checks require review
conclusions. Independent review follows the company approval setting. Saving
changes resets review; changes to the books require refreshed figures and a
new review before recording a filing. Changing the period refreshes the ledger
figures and clears the review checks while retaining entered adjustments,
declarations, explanations and tax computation lines. Reassess those retained
entries against the new period. Changing the filing type also clears the checks.

After filing through the official portal, attach the acknowledgement and record
its reference and actual filing date. The status is **filed externally** and
the original working paper remains retained. Correct a filed return through a
separate linked correction record. An accountant can record a reasoned
**no filing required** decision for a waiver, exemption or inapplicable entry;
this records the team's assessment and does not obtain authority approval.

## Reports

The library includes P&L, balance sheet, direct-method cash flow, changes in equity,
trial balance, GL detail with opening/running balances, journals, AR/AP aging,
customer and supplier statements, GST F5 summary, GST detail by tax code, bank reconciliation,
fixed asset/depreciation schedule and inventory valuation. P&L, balance sheet and
cash flow support monthly/yearly columns and previous/custom-period comparisons.
Yearly columns follow the configured financial year. AR/AP totals are in SGD;
individual original-currency balances are not added across currencies.

Select a linked report amount to open supporting journals, then the source
document and attachments. Variance drill-down includes both periods. Reports can
be exported to Excel or CSV, or printed/saved as PDF
using the browser's print dialog. Audit history includes before/after records;
the full history is available through the audit export.

Cash-flow comparisons include entries that exist only in the comparison period,
and subtotals link to their supporting entries. Payments of capital-asset bills
are classified using the underlying bill accounts, including FX settlement
amounts; mixed-purpose payments remain flagged for classification review.
Changes in equity separates opening and movement support and includes a total
that reconciles to balance-sheet equity. The fixed asset and inventory schedules
include monetary totals; inventory quantities with different units are not
added together. Bank reconciliation includes every journal in a grouped match.
Report previews and standalone Excel exports carry the configured business name
and UEN, and Excel exports retain numeric formats and readable review notes.

## Integration and accounting boundaries

- **InvoiceNow:** UEN, Peppol IDs, customer identifiers and provider details can be
  stored. **No provider has been chosen.** Transmission is explicitly
  **not connected**. An accredited access-point
  integration, credentials, conformance testing and delivery acknowledgements are
  required before this can be used for mandatory e-invoicing.
- **Financial statements:** these are ledger-backed preparation schedules, not a
  complete statutory filing package or compliance certification. Accountants must
  review classifications, financial statement notes, applicable disclosures,
  comparatives and the selected framework. No ACRA/XBRL or IRAS filing is submitted.
- **GST:** ordinary supported tax codes populate the working schedule. Special
  declarations are completed in the retained filing working paper. Blank values
  are not assumed to be zero. Non-operating revenue is excluded from Box 13
  through the accountant's account mapping.
  Historical tax rates, reverse charge, import schemes, refunds and other special
  treatments require additional accounting work before filing.
- **Inventory:** weighted average costing supports bills, sales invoices and
  dated stock adjustments. It is separate from event/rental asset tracking.
  Returns use explicit stock adjustments; multiwarehouse, serial/lot valuation
  and landed-cost allocation are not implemented.
- **Assets:** acquisition linking and straight-line depreciation are supported.
  Disposal, impairment and other depreciation methods require separate reviewed
  accounting procedures; this version does not automate them.
- **Cash and FX:** source documents support foreign currencies; bank statement
  and cash ledger amounts are in SGD. Direct foreign-currency bank ledgers, bank
  feeds, payment initiation and automatically fetched exchange rates are not
  connected. Payment recording does not transfer funds.
- **Migration and settlement limits:** no complete import/mapping wizard or
  opening AR/AP migration is available. Batch recording and several cash journals
  matched to one bank statement line are supported; allocating one cash journal
  across several statement lines is not. Some legacy settlement records lack the
  identifiers needed for automatic reversal and require reviewed correction.

These boundaries and company-specific migration/reconciliation need review
before retiring another accounting system. The workspace does not yet offer
full product parity with Zoho, QuickBooks or Odoo. Additional needs such as
foreign-currency bank accounts, asset disposals, advanced stock, full financial
statement notes/XBRL generation and direct filing integrations remain material
to an accountant's acceptance assessment.

### Acceptance before replacing another system

| Work area | Available in this workspace | Remaining acceptance work or external tools |
| --- | --- | --- |
| Daily bookkeeping | GL, chart of accounts, journal drafts/posting and audit trail; quotes, invoices, credits, purchase orders, bills, statements; direct expenses/receipts; payment matching and batch recording | Reconcile opening balances and legacy records; confirm document details, admin access and approval rules for the company |
| Month-end | Bank reconciliation and retained statements, grouped matching, AR/AP revaluation, straight-line depreciation, weighted-average stock, period checks and locks | Foreign-currency bank ledgers, advanced assets/stock and company-specific close procedures remain outside the implemented scope |
| Reports and audit | Requested ledger and management reports, drill-downs, comparisons, attachments, Excel/CSV/print output and retained report packs | Complete statutory notes/disclosures, classification review and an applicable validated XBRL package still need preparation |
| GST and tax | F5 ledger working paper, reviewed adjustments/declarations, ECI and income-tax reconciliations, F7/F8/withholding/AIS preparation records | Special GST treatments, complete tax computation and relief eligibility, employee-level returns and actual authority submission require further tools/review |
| Filing and e-invoicing | Obligation guide, assignees, due dates, review controls, package evidence and externally filed acknowledgements | No direct IRAS/ACRA submission; choose and integrate an InvoiceNow access-point provider before transmission |

Prioritise the missing capabilities used by the company before cutover. Run a
parallel close and reconcile the trial balance, AR/AP, bank, GST, inventory and
asset schedules to the existing system. Acceptance requires populated company
data and accountant review; successful UI checks and automated fixtures do not
establish statutory completeness or full replacement readiness.

## Reference guidance checked during implementation

- [IRAS: completing GST returns](https://www.iras.gov.sg/taxes/goods-services-tax-%28gst%29/filing-gst/completing-gst-returns)
- [IMDA: InvoiceNow technical playbook](https://www.imda.gov.sg/how-we-can-help/nationwide-e-invoicing-framework/peppol-technical-playbook)
- [ACRA: accounting standards](https://www.acra.gov.sg/regulations/accounting-standards-financial-reporting-surveillance/accounting-standards/)
- [IFRS: IAS 7 statement of cash flows](https://www.ifrs.org/issued-standards/list-of-standards/ias-7-statement-of-cash-flows.html/)
- [IRAS: corporate income tax filing guide](https://www.iras.gov.sg/taxes/corporate-income-tax/basics-of-corporate-income-tax/basic-guide-to-corporate-income-tax-for-companies)
- [IRAS: keeping GST records](https://www.iras.gov.sg/taxes/goods-services-tax-(gst)/basics-of-gst/invoicing-price-display-and-record-keeping/keeping-records)
- [IRAS: invoicing customers](https://www.iras.gov.sg/taxes/goods-services-tax-%28gst%29/basics-of-gst/invoicing-price-display-and-record-keeping/invoicing-customers)
- [IRAS: foreign-currency transactions](https://www.iras.gov.sg/taxes/goods-services-tax-%28gst%29/charging-gst-%28output-tax%29/foreign-currency-transactions)

The Filing guide also links to official guidance for the named obligations;
**Other filing** asks the preparer to identify the relevant authority. Review
the current authority guidance when preparing an actual return.

## Verification

Run `python -m unittest discover -s tests` and
`node tests/test_accounting_ui.cjs`, plus syntax checks for the accounting
scripts. The focused accounting suites cover
posting/conversion, comparisons and historical balances, FX settlement/revaluation,
atomic batches, credits, permissions, depreciation, inventory, recurring dates,
bank matching, attachments, GST, period locks, payment reversal and source linking,
retained packs, filing review, external evidence, tax working papers, inclusive
and blocked GST, direct cash correction and supplier statements.

On the deeper 5 September 2026 review, the full Python regression suite ran
811 tests: **810 passed and 1 was skipped**. This includes 27 added tests across
bookkeeping integrity, reports, filing preparation and document output/access.
The JavaScript renderer/state checks and accounting script syntax checks passed,
including grouped bank totals, reversal eligibility, bank account choices,
negative-zero formatting and accounting-only sidebar access. A synthetic
three-page mixed-supply foreign-currency invoice PDF was rendered and visually
checked for pagination, readable tax labels, repeated headers and SGD totals.

The user signed into the live accounting page for the 4 September 2026 visual
review. All 11 main views, all 16 reports, monthly/custom comparison controls,
invoice and bill editors, the asset and bank-closing forms, filing preparation,
retained-pack screens and all four settings sections were inspected. The live
page has one Accounting sidebar entry, no vertical tab-strip overflow, bank
selectors limited to configured cash accounts, contextual blocked-GST guidance
and close checks that distinguish clear ledger checks from unposted sources.
The browser reported no errors or warnings during this walkthrough.

That 4 September walkthrough used a historical unposted sample; it is not a
statement of the current signed-in company's balances or source-document count.
Populated drill-downs, settlement and reconciliation results were verified by
automated fixtures, not by posting live data. No accounting record, setting,
attachment or filing was saved during that browser review.

On 5 September 2026 the scheduled AIM Web App service was restarted through its
registered task. A second signed-in browser check confirmed the selected-period
total (closing balance for the balance sheet) beside monthly/yearly comparisons,
server-side negative-zero normalisation, a clean browser console and a healthy
public HTTPS page after restart.

The deeper review changes described above were deployed through a subsequent
restart of the registered AIM Web App task. The subsequent signed-in check
verified all nine Filing guide entries, the 17-box GST worksheet, and a period
change that retained an entered adjustment while clearing all review checks.
F8 showed its own preparation guidance without ACRA instructions or a YA field;
ECI showed an enabled YA field and tax worksheet. The cash-flow, changes-in-equity,
fixed-asset and inventory reports rendered their headings, configured company
identity and totals correctly with the current empty ledger. No horizontal page
overflow or browser errors/warnings appeared. The final contextual-field change
passed JavaScript syntax and renderer checks and was verified after a live reload.
The Filing guide was left open for the user. No records or settings were saved
during these checks. Populated document output, drill-downs and accounting results
remain covered by the automated and synthetic-PDF checks described above.

The later access-control update makes the company application role authoritative:
active company admins receive full accounting permissions, platform owners receive
read-only access without appearing in the Accounting access list, and managers and
users are blocked at navigation, page-route and API layers. Legacy accounting-role
records cannot grant write access or reveal an owner in that list. The full 811-test suite,
JavaScript syntax/renderer checks and a signed-in live admin reload passed after
deployment. The live Settings view showed the application role and resulting
access without editable accounting-role selectors.
