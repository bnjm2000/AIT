"""Period review, retained report packs and evidence of external statutory filings.

This module prepares records; it never transmits a return or initiates payment.
Commands run inside the accounting store's atomic mutation boundary.
"""
from __future__ import annotations

import copy
import hashlib
import json
from datetime import date

from services import accounting_workspace as books
from services.accounting_reports import CATALOG, GST_LABELS, build_report, ledger, sum_net

FILING_TYPES = {
    'gst': 'GST F5', 'eci': 'Estimated Chargeable Income (ECI)',
    'income-tax': 'Corporate income tax · C-S / C-S (Lite) / C',
    'annual-return': 'ACRA annual return & financial statements',
    'gst-correction': 'GST correction / F7', 'gst-final': 'Final GST return / F8', 'withholding': 'Withholding tax',
    'employment': 'Employment income / AIS', 'other': 'Other filing',
}
PORTALS = {'iras': 'https://mytax.iras.gov.sg/', 'acra': 'https://www.bizfile.gov.sg/'}
# Guidance is deliberately separate from due dates: company-specific obligations,
# extensions and notifications must be checked by the preparer in the portal.
FILING_GUIDES = {
    'gst': dict(
        deadline='Generally one month after the assigned GST period, including payment.',
        guidance='File a nil return even when there are no transactions. Reconcile tax codes, input tax eligibility and special declarations; confirm the assigned period and due date in myTax Portal.',
        preparation='Ledger-based F5 working paper with reviewed adjustments and declarations. File and arrange payment in myTax Portal.',
        links=[('IRAS: completing GST returns', 'https://www.iras.gov.sg/taxes/goods-services-tax-%28gst%29/filing-gst/completing-gst-returns'),
               ('IRAS: GST InvoiceNow requirement', 'https://www.iras.gov.sg/taxes/goods-services-tax-%28gst%29/gst-invoicenow-requirement')]),
    'eci': dict(
        deadline='Generally within three months after financial year end.',
        guidance='Confirm the basis period and YA. The usual ECI waiver requires annual revenue of S$5 million or less and nil ECI before tax exemptions. Assess both conditions; an ECI waiver does not automatically waive the annual income tax return.',
        preparation='Book-profit reconciliation and accountant-entered declared income. Retain the detailed tax computation and file in myTax Portal.',
        links=[('IRAS: ECI filing and waiver', 'https://www.iras.gov.sg/taxes/corporate-income-tax/estimated-chargeable-income-%28eci%29-filing')]),
    'income-tax': dict(
        deadline='Normally 30 November of the Year of Assessment.',
        guidance='Confirm eligibility for Form C-S, C-S (Lite) or C and any filing waiver. Prepare the financial statements and detailed tax computation; verify capital allowances, losses, donations and exemptions.',
        preparation='Tax reconciliation working paper. Form eligibility, full tax computation and submission require the accountant’s review and myTax Portal.',
        links=[('IRAS: corporate return filing guide', 'https://www.iras.gov.sg/taxes/corporate-income-tax/form-c-s-form-c-s-%28lite%29-form-c-filing/guidance-on-filing-form-c-s-form-c-s-%28lite%29-form-c')]),
    'annual-return': dict(
        deadline='Normally seven months after FYE for non-listed companies; five for listed companies. Special cases and extensions differ.',
        guidance='Confirm the annual-return obligation separately from any exemption from filing financial statements. Dormant companies generally still file annual returns. Assess the required XBRL/PDF format, complete notes and approvals, and use the current ACRA taxonomy and validation tools.',
        preparation='Report schedules and retained filing package. Complete statutory statements, disclosures and XBRL validation in BizFinx or an appropriate filing provider, then file in Bizfile.',
        links=[('ACRA: annual-return deadlines', 'https://www.acra.gov.sg/manage/companies/legal-requirements-common-offences/filing-annual-returns-companies/deadline-requirements/'),
               ('ACRA: financial-statement requirements', 'https://www.acra.gov.sg/manage/companies/legal-requirements-common-offences/filing-financial-statements-in-xbrl-format/requirements-exemptions/'),
               ('ACRA: current BizFinx tools', 'https://www.acra.gov.sg/resources/eservice-tools-portals/xbrl-filing-tools/')]),
    'gst-correction': dict(
        deadline='Confirm the correction period and due date with IRAS.',
        guidance='Assess whether a subsequent F5 adjustment is permitted or GST F7 is required. F7 replaces the prior return for that period: prepare complete corrected figures, link the original filing and retain the error computation.',
        preparation='Attach the complete correction computation and proposed return. This working paper does not generate or transmit an F7.',
        links=[('IRAS: correcting GST returns', 'https://www.iras.gov.sg/taxes/goods-services-tax-%28gst%29/filing-gst/correcting-errors-made-in-gst-return-%28filing-gst-f7%29')]),
    'gst-final': dict(
        deadline='Within one month after the period stated on the final return.',
        guidance='Use the final period issued by IRAS. Assess output tax on qualifying assets held at deregistration and supplies spanning the cancellation date. Reconcile outstanding returns and payments before closure.',
        preparation='Attach the final GST F8 computation, asset review and proposed return. The F5 report alone does not include all deregistration adjustments.',
        links=[('IRAS: final GST return and deregistration', 'https://www.iras.gov.sg/taxes/goods-services-tax-%28gst%29/gst-registration-deregistration/cancelling-gst-registration')]),
    'withholding': dict(
        deadline='Generally the 15th of the second month from the applicable date of payment.',
        guidance='Determine the IRAS date of payment, payment category, non-resident status and treaty treatment. Exempt payments can still require a filing; confirm any consolidation concession and retain supporting evidence.',
        preparation='Attach the reviewed withholding computation and payee schedule. File and arrange payment through the IRAS service.',
        links=[('IRAS: withholding filing and payment', 'https://www.iras.gov.sg/taxes/withholding-tax/withholding-tax-filing/withholding-tax-filing-and-payment-due-date')]),
    'employment': dict(
        deadline='Employment income reporting is generally due by 1 March of the following year.',
        guidance='Confirm AIS participation, reporting year and employee coverage. Reconcile payroll to the ledger and complete IR8A and applicable appendices before reporting.',
        preparation='Attach reconciled employment-income schedules. Prepare employee-level returns and submit through an AIS-capable payroll service or IRAS.',
        links=[('IRAS: AIS requirements', 'https://www.iras.gov.sg/taxes/individual-income-tax/employers/auto-inclusion-scheme-%28ais%29-for-employment-income/join-the-auto-inclusion-scheme-%28ais%29-for-employment-income')]),
    'other': dict(
        deadline='Confirm the obligation and due date with the relevant authority.',
        guidance='Record the applicable authority, official service, required schedules and submission evidence in the working paper notes.',
        preparation='Retain the prepared package and external acknowledgement. No automatic submission is available.', links=[]),
}
MANUAL_PACKAGE_TYPES = {'annual-return', 'gst-correction', 'gst-final', 'withholding', 'employment'}
REVIEW_ITEMS = {
    'scope': 'Entity, reporting period, filing obligation and portal due date confirmed',
    'reconciliations': 'Ledger, subledgers and relevant bank reconciliations reviewed',
    'treatment': 'Tax treatment, declarations, adjustments and supporting schedules reviewed',
    'documents': 'Required financial statements, notes, approvals and filing attachments prepared',
    'authority': 'Filing access and authorised submitter confirmed',
}


def period(value):
    start, end = books.day(value.get('from')), books.day(value.get('to'))
    if start > end:
        raise ValueError('Start date must be on or before end date')
    return {'from': start, 'to': end}


def signature(store, end):
    """Detect changes relevant to previously reviewed books without using audit timestamps."""
    data = {key: [r for r in store[key] if r.get('date', r.get('inServiceDate', '')) <= end]
            for key in ('journals', 'documents', 'settlements', 'exchangeRates', 'revaluations',
                        'bankTransactions', 'bankReconciliations', 'stockMoves', 'fixedAssets')}
    data['accounts'] = store['accounts']
    data['stockItems'] = store['stockItems']
    data['settings'] = {k: v for k, v in store['settings'].items()
                        if k not in {'roles', 'approvalRequired', 'periodLockDate', 'invoiceNowProvider', 'peppolId'}}
    return hashlib.sha256(json.dumps(data, sort_keys=True, separators=(',', ':'), default=str).encode()).hexdigest()


def readiness(store, dates):
    end = dates['to']
    checks = []

    def check(key, label, count, detail, target, hard=False):
        checks.append(dict(id=key, label=label, status='review' if count else 'clear',
                           count=count, detail=detail, target=target, blocking=bool(hard and count)))

    lines = ledger(store, end=end)
    check('balance', 'Trial balance', abs(sum_net(lines)), 'Debits must equal credits.', 'trial-balance', True)
    drafts = [r for r in store['documents'] if r['date'] <= end and r['status'] in {'draft', 'submitted'}
              and r['kind'] not in books.NON_POSTING]
    drafts += [r for r in store['journals'] if r['date'] <= end and r['status'] == 'draft']
    check('drafts', 'Unposted transactions', len(drafts), 'Review or void drafts dated on or before the closing date.', 'tasks')
    for side in ('ar', 'ap'):
        report = build_report(store, side + '-aging', dates)
        gap = report.get('reconciliation', {}).get('difference', 0)
        check(side, side.upper() + ' control reconciliation', abs(gap),
              f'Ledger less open documents: SGD {gap:,.2f}.', side + '-aging')
        missing = [r for r in report['rows'] if not r.get('total') and r.get('closingRate') is None]
        fx = sum(abs(books.dec(r.get('fx'))) for r in report['rows'] if not r.get('total'))
        check(side + '-fx', side.upper() + ' closing currency valuation', len(missing) + float(fx),
              f'{len(missing)} open items lack a closing rate; absolute unposted FX SGD {fx:,.2f}.', side + '-aging')
    assets = build_report(store, 'fixed-assets', dates)
    pending = sum(abs(books.dec(r.get('pending'))) for r in assets['rows'] if not r.get('total'))
    check('depreciation', 'Depreciation', float(pending), f'Unposted charge SGD {pending:,.2f}.', 'fixed-assets')
    cf = build_report(store, 'cash-flow', dates)
    unclassified = any(r.get('key') == 'unclassified' for r in cf['rows'])
    check('cash-flow', 'Cash flow classifications', int(unclassified), 'Review mixed or unclassified cash journals.', 'cash-flow')
    cash = set(store['settings'].get('cashAccounts', [])) | {store['settings']['defaultBankAccount']}
    active_cash = {r['accountCode'] for r in lines if r['accountCode'] in cash}
    active_cash |= {r['bankAccount'] for r in store['bankTransactions'] if r['date'] <= end}
    for code in sorted(active_cash):
        bank = build_report(store, 'bank-reconciliation', dict(dates, bankAccount=code))
        info = bank['reconciliation']
        count = (1 if info['difference'] is None else abs(info['difference'])) + info['unmatchedStatementCount']
        check('bank-' + code, 'Bank reconciliation · ' + code, count,
              'Enter the actual closing statement and clear unbooked statement items. Review outstanding cheques and deposits.', 'bank-reconciliation')
        checks[-1]['bankAccount'] = code
    attached = {(a['collection'], a['recordId']) for a in store['attachments']}
    unsupported = [r for r in store['documents'] if dates['from'] <= r['date'] <= end and r['status'] == 'posted'
                   and r['kind'] in {'bill', 'expense', 'vendor_credit'} and ('documents', r['id']) not in attached
                   and ('journals', r.get('journalId')) not in attached]
    check('evidence', 'Purchase source documents', len(unsupported), 'Bills, expenses and vendor credits should retain source evidence.', 'purchases')
    overdue = [r for r in store['tasks'] if r['dueDate'] <= end and r['status'] != 'complete']
    check('tasks', 'Open close tasks', len(overdue), 'Resolve tasks due on or before the closing date.', 'tasks')
    recurring = [r for r in store['recurring'] if r.get('active') and r['nextDate'] <= end]
    check('recurring', 'Recurring drafts due', len(recurring), 'Generate and review recurring transactions due by the closing date.', 'tasks')
    return checks


def gst_worksheet(store, dates, adjustments=None, declarations=None):
    adjustments, declarations = adjustments or {}, declarations or {}
    base = build_report(store, 'gst', dates)
    rows = []
    for i, source in enumerate(base['rows'], 1):
        if i in (4, 8):
            continue
        ledger_amount = source['amount']
        raw = declarations.get(str(i)) if ledger_amount is None else adjustments.get(str(i), 0)
        entered = None if raw in ('', None) else books.money(raw)
        proposed = entered if ledger_amount is None else books.money(books.dec(ledger_amount) + books.dec(entered))
        if ledger_amount is None and proposed is not None and proposed < 0:
            raise ValueError(f'GST declaration Box {i} cannot be negative')
        rows.append(dict(box=i, label=GST_LABELS[i], ledger=ledger_amount, adjustment=entered,
                         amount=proposed, ref=source.get('ref')))
    values = {r['box']: r['amount'] for r in rows}
    for box, amount in ((4, sum(books.dec(values[i]) for i in (1, 2, 3))),
                        (8, books.dec(values[6]) - books.dec(values[7]))):
        rows.append(dict(box=box, label=GST_LABELS[box], amount=books.money(amount), derived=True))
    return sorted(rows, key=lambda r: r['box'])


def filing_view(store, record):
    result = copy.deepcopy(record)
    result['booksChanged'] = bool(record.get('bookSignature') and record['bookSignature'] != signature(store, record['period']['to']))
    result['portal'] = '' if record['type'] == 'other' else PORTALS['acra' if record['type'] == 'annual-return' else 'iras']
    result['guide'] = copy.deepcopy(FILING_GUIDES[record['type']])
    return result


def filing_report(record):
    rows = []
    if record['type'] == 'gst':
        rows = [dict(label=f'Box {r["box"]} · {r["label"]}', ledger=r.get('ledger'),
                     adjustment=r.get('adjustment'), amount=r['amount']) for r in record['gstRows']]
    elif record['type'] in {'eci', 'income-tax'}:
        rows = [dict(label='Book profit / (loss)', amount=record['bookProfit'])]
        rows += [dict(label=r['label'], amount=r['amount'], reference=r['reference']) for r in record['taxAdjustments']]
        rows += [dict(label='Profit after listed adjustments', amount=record['adjustedProfit'], total=True),
                 dict(label='Proposed declared income', amount=record['declaredIncome'], total=True)]
    notes = [f'Working paper version {record["version"]} · {record["status"]} · Assigned to {record["assignedTo"]}',
             'Due date confirmed by preparer: ' + record['dueDate'],
             record.get('adjustmentReason', ''), record.get('notes', ''), record.get('reviewNotes', '')]
    if record.get('yearOfAssessment'):
        notes.append('Year of Assessment: ' + record['yearOfAssessment'])
    notes += [label + ': ' + ('Checked' if record['checklist'].get(key) else 'Not checked') for key, label in REVIEW_ITEMS.items()]
    if record.get('reviewedBy'):
        notes.append(f'Reviewed by {record["reviewedBy"]} at {record["reviewedAt"]}')
    notes += ['Supporting package at review: ' + a['name'] + ' · SHA-256 ' + a.get('sha256', '')
              for a in record.get('reviewAttachments', [])]
    if record.get('externalReference'):
        notes.append(f'External acknowledgement {record["externalReference"]} · {record["filedDate"]} · recorded by {record["recordedBy"]}')
    if record.get('resolutionReason'):
        notes.append(f'No filing required: {record["resolutionReason"]} · recorded by {record["resolvedBy"]}')
    notes.append('Prepared working paper. This export does not submit a return or replace the portal acknowledgement.')
    return dict(title=record['title'], period=record['period'], currency='SGD',
                columns=[dict(key=k, label=v, format=f) for k, v, f in
                         [('label','Item','text'),('ledger','Ledger SGD','money'),('adjustment','Adjustment / declaration SGD','money'),
                          ('amount','Proposed SGD','money'),('reference','Supporting schedule','text')]], rows=rows, notes=[n for n in notes if n])


def dashboard(store, value):
    dates = period(value)
    return dict(period=dates, checks=readiness(store, dates),
                filings=[filing_view(store, r) for r in store['filings']],
                packs=[{k: v for k, v in r.items() if k not in {'reports', 'sourceSnapshot'}} for r in store['reportPacks']],
                filingTypes=FILING_TYPES, reviewItems=REVIEW_ITEMS, filingGuides=copy.deepcopy(FILING_GUIDES),
                gst=gst_worksheet(store, dates))


def command(store, name, value, actor, role, users):
    books.allow(role, 'write')
    if name == 'pack-create':
        dates = period(value)
        reports = [build_report(store, row[0], dates) for row in CATALOG
                   if row[0] not in {'customer-statement', 'supplier-statement', 'bank-reconciliation'}]
        cash = set(store['settings'].get('cashAccounts', [])) | {store['settings']['defaultBankAccount']}
        for code in sorted(cash):
            report = build_report(store, 'bank-reconciliation', dict(dates, bankAccount=code))
            report['title'] += ' · ' + code
            reports.append(report)
        record = dict(id=books.uid(), title=books.required(value.get('title'), 'Pack name'), period=dates,
                      createdBy=actor, createdAt=books.now(), businessName=store['settings'].get('businessName', ''),
                      uen=store['settings'].get('uen', ''), reports=reports, checks=readiness(store, dates),
                      bookSignature=signature(store, dates['to']))
        # Retain the entries behind each amount, even when the live books later change.
        record['sourceSnapshot'] = {key: copy.deepcopy(store[key]) for key in
                                    ('settings', 'accounts', 'journals', 'documents', 'settlements', 'fixedAssets',
                                     'stockItems', 'stockMoves', 'exchangeRates', 'revaluations', 'bankTransactions',
                                     'bankReconciliations', 'attachments')}
        store['reportPacks'].append(record)
        books.audit(store, actor, 'report-pack.created', record['id'], after={k: v for k, v in record.items() if k not in {'reports', 'sourceSnapshot'}})
        return {k: v for k, v in record.items() if k not in {'reports', 'sourceSnapshot'}}
    if name == 'filing-save':
        old = books.find(store, 'filings', value['id']) if value.get('id') else None
        if old and old['status'] in {'filed', 'not-required'}:
            raise ValueError('Filed evidence is retained. Create a separate correction record linked to this filing.')
        if old and str(value.get('version')) != str(old['version']):
            raise ValueError('This working paper changed. Reopen it before saving.')
        kind = value.get('type')
        if kind not in FILING_TYPES:
            raise ValueError('Choose a filing type')
        dates = period(value)
        assigned = value.get('assignedTo') or actor
        if assigned not in users:
            raise ValueError('Choose an active company user')
        related = value.get('relatedFilingId', '')
        if related:
            books.find(store, 'filings', related)
        record = dict(id=old['id'] if old else books.uid(), type=kind,
                      title=books.required(value.get('title') or FILING_TYPES[kind], 'Filing title'), period=dates,
                      dueDate=books.day(value.get('dueDate')), assignedTo=assigned,
                      yearOfAssessment=str(value.get('yearOfAssessment') or '')[:10], relatedFilingId=related,
                      notes=str(value.get('notes') or '')[:12000], reviewNotes=str(value.get('reviewNotes') or '')[:8000],
                      checklist={k: (value.get('checklist') or {}).get(k) is True for k in REVIEW_ITEMS},
                      status='draft', version=(old['version'] + 1) if old else 1,
                      createdBy=old['createdBy'] if old else actor, createdAt=old['createdAt'] if old else books.now(),
                      updatedBy=actor, updatedAt=books.now(), bookSignature=signature(store, dates['to']))
        if kind == 'gst':
            if not store['settings'].get('gstRegistered'):
                raise ValueError('Confirm GST registration in Settings before preparing GST F5')
            adjustments = value.get('adjustments') or {}
            declarations = value.get('declarations') or {}
            if not isinstance(adjustments, dict) or not isinstance(declarations, dict):
                raise ValueError('Enter valid GST box values')
            record['gstRows'] = gst_worksheet(store, dates, adjustments, declarations)
            record['adjustments'] = {str(r['box']): r['adjustment'] for r in record['gstRows'] if not r.get('derived') and r['ledger'] is not None}
            record['declarations'] = {str(r['box']): r['amount'] for r in record['gstRows'] if not r.get('derived') and r['ledger'] is None}
            record['adjustmentReason'] = str(value.get('adjustmentReason') or '')[:8000]
            if any(record['adjustments'].values()) and not record['adjustmentReason'].strip():
                raise ValueError('Explain GST adjustments and reference the supporting journal / schedule')
        if kind in {'eci', 'income-tax'}:
            if not record['yearOfAssessment'].isdigit() or not 2000 <= int(record['yearOfAssessment']) <= 2200:
                raise ValueError('Enter the Year of Assessment confirmed for this basis period')
            pnl = build_report(store, 'profit-loss', dates)
            record['bookProfit'] = next(r['amount'] for r in pnl['rows'] if r.get('key') == 'net-profit')
            adjustments = value.get('taxAdjustments') or []
            if not isinstance(adjustments, list) or len(adjustments) > 200:
                raise ValueError('Use at most 200 tax adjustment lines')
            record['taxAdjustments'] = [dict(label=books.required(r.get('label'), 'Adjustment description'),
                                              amount=books.money(r.get('amount')),
                                              reference=books.required(r.get('reference'), 'Supporting schedule reference')) for r in adjustments]
            record['adjustedProfit'] = books.money(books.dec(record['bookProfit']) + sum(books.dec(r['amount']) for r in record['taxAdjustments']))
            record['declaredIncome'] = None if value.get('declaredIncome') in (None, '') else books.money(value['declaredIncome'])
            if record['declaredIncome'] is not None and record['declaredIncome'] < 0:
                raise ValueError('Declared income must be zero or positive; retain tax losses in the supporting computation')
        before = copy.deepcopy(old)
        if old:
            old.clear()
            old.update(record)
        else:
            store['filings'].append(record)
        books.audit(store, actor, 'filing.saved', record['id'], before, record)
        return filing_view(store, record)
    record = books.find(store, 'filings', value.get('id'))
    before = copy.deepcopy(record)
    if str(value.get('version')) != str(record['version']):
        raise ValueError('This filing changed. Reopen it before continuing.')
    if name == 'filing-review':
        books.allow(role, 'approve')
        if record['status'] != 'draft':
            raise ValueError('Only a draft working paper can be reviewed')
        if record['bookSignature'] != signature(store, record['period']['to']):
            raise ValueError('The books changed. Reopen and save the working paper to refresh its figures before review.')
        if store['settings'].get('approvalRequired') and actor in {record['createdBy'], record['updatedBy']}:
            raise ValueError('Independent review requires another accountant')
        if not all(record['checklist'].values()):
            raise ValueError('Complete every review check before marking reviewed')
        if record['type'] == 'gst' and any(r['amount'] is None for r in record['gstRows']):
            raise ValueError('Complete all GST declarations, including explicit zeros where not applicable')
        if record['type'] in {'eci', 'income-tax'} and record['declaredIncome'] is None:
            raise ValueError('Enter the proposed declared income from the reviewed tax computation')
        prepared_files = [copy.deepcopy(a) for a in store['attachments']
                          if a['collection'] == 'filings' and a['recordId'] == record['id']]
        if record['type'] in MANUAL_PACKAGE_TYPES and not prepared_files:
            raise ValueError('Attach the prepared filing package or assessment of applicable filing requirements before review')
        checks = readiness(store, record['period'])
        if any(c['blocking'] for c in checks):
            raise ValueError('Resolve the trial balance difference before review')
        if any(c['status'] == 'review' for c in checks) and not record['reviewNotes'].strip():
            raise ValueError('Resolve the period checks or document the reviewer’s treatment of outstanding items')
        record.update(status='reviewed', reviewedBy=actor, reviewedAt=books.now(), reviewChecks=checks,
                      reviewAttachments=prepared_files)
    elif name == 'filing-not-required':
        books.allow(role, 'approve')
        if record['status'] not in {'draft', 'reviewed'}:
            raise ValueError('Only an open working paper can be resolved')
        if store['settings'].get('approvalRequired') and actor in {record['createdBy'], record['updatedBy']}:
            raise ValueError('Independent review requires another accountant')
        record.update(status='not-required', resolutionReason=books.required(value.get('reason'), 'Reason / exemption basis', 8000),
                      resolvedBy=actor, resolvedAt=books.now())
    elif name == 'filing-file':
        books.allow(role, 'approve')
        if record['status'] != 'reviewed':
            raise ValueError('Review the working paper before recording external filing evidence')
        if record['bookSignature'] != signature(store, record['period']['to']):
            raise ValueError('The books changed after review. Refresh and review the working paper again.')
        proof = books.find(store, 'attachments', value.get('attachmentId'))
        if proof['collection'] != 'filings' or proof['recordId'] != record['id']:
            raise ValueError('Attach the acknowledgement to this filing first')
        filed_date = books.day(value.get('filedDate'))
        if filed_date > date.today().isoformat():
            raise ValueError('An external filing date cannot be in the future')
        record.update(status='filed', externalReference=books.required(value.get('reference'), 'Acknowledgement reference'),
                      filedDate=filed_date, acknowledgementId=proof['id'], recordedBy=actor, recordedAt=books.now())
    else:
        raise ValueError('Unknown close / filing action')
    record['version'] += 1
    books.audit(store, actor, name, record['id'], before, record)
    return filing_view(store, record)
