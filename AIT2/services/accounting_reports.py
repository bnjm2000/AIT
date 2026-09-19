"""Ledger-backed financial statements and drill-down report tables."""
from __future__ import annotations

import calendar
from datetime import date, timedelta

from services.accounting_workspace import (
    CREDITS, carrying_value, closing_rate, day, dec,
    depreciation_target, money, outstanding, stock_position,
)

CATALOG = [
    ('profit-loss', 'Profit & Loss', 'Financial statements', 'Income, expenses and profit with period comparisons.'),
    ('balance-sheet', 'Balance Sheet', 'Financial statements', 'Assets, liabilities and equity at each reporting date.'),
    ('cash-flow', 'Cash Flow Statement', 'Financial statements', 'Direct method: operating, investing and financing activities.'),
    ('equity', 'Statement of Changes in Equity', 'Financial statements', 'Opening equity, movements, earnings and closing equity.'),
    ('trial-balance', 'Trial Balance', 'Ledger & audit', 'Closing debit and credit balances with a balancing check.'),
    ('general-ledger', 'General Ledger Detail', 'Ledger & audit', 'Opening balance, activity and running balance by account.'),
    ('journals', 'Journal Report', 'Ledger & audit', 'Posted journals and their individual lines.'),
    ('ar-aging', 'AR Aging', 'Receivables & payables', 'Unpaid invoices and credits, with closing FX valuation.'),
    ('ap-aging', 'AP Aging', 'Receivables & payables', 'Unpaid bills and vendor credits, with closing FX valuation.'),
    ('customer-statement', 'Customer Statement', 'Receivables & payables', 'Opening balance, invoices, credits and payments per customer.'),
    ('supplier-statement', 'Supplier Statement', 'Receivables & payables', 'Opening balance, bills, vendor credits and payments per supplier.'),
    ('gst', 'GST F5 Summary', 'Tax & schedules', 'GST working schedule from posted tax codes.'),
    ('gst-detail', 'GST Transaction Detail', 'Tax & schedules', 'Taxable value and GST by transaction and tax code.'),
    ('bank-reconciliation', 'Bank Reconciliation', 'Tax & schedules', 'Statement closing balance, ledger balance and outstanding items.'),
    ('fixed-assets', 'Fixed Assets & Depreciation', 'Tax & schedules', 'Cost, opening depreciation, period charge and net book value.'),
    ('inventory', 'Inventory Valuation', 'Tax & schedules', 'Trading stock quantities and weighted average carrying values.'),
]

GST_LABELS = {
    1: 'Standard-rated supplies', 2: 'Zero-rated supplies', 3: 'Exempt supplies',
    4: 'Total supplies', 5: 'Taxable purchases', 6: 'Output tax due',
    7: 'Input tax and refunds claimed', 8: 'Net GST payable / (claimable)',
    9: 'Imports under approved suspension schemes', 10: 'Tourist refunds claimed',
    11: 'Bad debt / reverse-charge refunds', 12: 'Pre-registration input tax claims',
    13: 'Revenue', 14: 'Reverse-charge imported services / low-value goods',
    15: 'Remote services supplied through a marketplace',
    16: 'Low-value goods supplied through a marketplace / redeliverer',
    17: 'Own supplies of imported low-value goods',
}


def col(key, label, fmt='text'):
    return dict(key=key, label=label, format=fmt)


def ledger(store, start='0001-01-01', end='9999-12-31'):
    accounts = {a['code']: a for a in store['accounts']}
    rows = []
    for journal in store['journals']:
        if journal['status'] != 'posted' or not start <= journal['date'] <= end:
            continue
        for item in journal['lines']:
            account = accounts.get(item['accountCode'], {})
            rows.append(dict(**item, date=journal['date'], journalId=journal['id'],
                             number=journal['number'], reference=journal.get('reference', ''),
                             memo=item.get('description') or journal.get('description', ''),
                             accountName=account.get('name', item['accountCode']),
                             accountType=account.get('type', ''), group=account.get('group', ''),
                             documentId=journal.get('documentId', ''), createdBy=journal.get('createdBy', '')))
    return sorted(rows, key=lambda r: (r['date'], r['number'], r['accountCode']))


def sum_net(rows):
    return money(sum(dec(r.get('debit')) - dec(r.get('credit')) for r in rows))


def ref(rows):
    return dict(journalIds=list(dict.fromkeys(r['journalId'] for r in rows)))


def combined_ref(rows):
    return dict(journalIds=list(dict.fromkeys(
        journal_id for row in rows for journal_id in (row.get('ref') or {}).get('journalIds', []))))


def result(columns, rows, notes=None):
    return dict(columns=columns, rows=rows, notes=notes or [])


def financial(store, name, start, end):
    activity = ledger(store, start, end)
    closing = ledger(store, end=end)
    accounts = sorted(store['accounts'], key=lambda a: a['code'])
    rows = []
    columns = [col('label', 'Account / line item'), col('amount', 'SGD', 'money')]
    if name == 'profit-loss':
        totals = {}
        for kind, label in (('revenue', 'Income'), ('expense', 'Expenses')):
            selected = [r for r in activity if r['accountType'] == kind]
            totals[kind] = money(dec(sum_net(selected)) * (-1 if kind == 'revenue' else 1))
            rows.append(dict(key=kind, label=label, section=True))
            for a in accounts:
                if a['type'] != kind:
                    continue
                lines = [r for r in selected if r['accountCode'] == a['code']]
                rows.append(dict(key=a['code'], label=f'{a["code"]} · {a["name"]}',
                                 amount=money(dec(sum_net(lines)) * (-1 if kind == 'revenue' else 1)), ref=ref(lines)))
            rows.append(dict(key='total-' + kind, label='Total ' + label.lower(), amount=totals[kind], total=True, ref=ref(selected)))
        rows.append(dict(key='net-profit', label='Profit / (loss) for the period',
                         amount=money(dec(totals['revenue']) - dec(totals['expense'])), total=True,
                         ref=ref([r for r in activity if r['accountType'] in {'revenue', 'expense'}])))
    elif name == 'balance-sheet':
        totals = {}
        for kind, label in (('asset', 'Assets'), ('liability', 'Liabilities'), ('equity', 'Equity')):
            selected = [r for r in closing if r['accountType'] == kind]
            totals[kind] = money(dec(sum_net(selected)) * (1 if kind == 'asset' else -1))
            rows.append(dict(key=kind, label=label, section=True))
            for a in accounts:
                if a['type'] != kind:
                    continue
                lines = [r for r in selected if r['accountCode'] == a['code']]
                rows.append(dict(key=a['code'], label=f'{a["code"]} · {a["name"]}',
                                 amount=money(dec(sum_net(lines)) * (1 if kind == 'asset' else -1)), ref=ref(lines)))
            if kind == 'equity':
                lines = [r for r in closing if r['accountType'] in {'revenue', 'expense'}]
                earnings = money(-dec(sum_net(lines)))
                totals[kind] = money(dec(totals[kind]) + dec(earnings))
                rows.append(dict(key='unclosed-earnings', label='Accumulated unclosed earnings', amount=earnings, ref=ref(lines)))
                selected = selected + lines
            rows.append(dict(key='total-' + kind, label='Total ' + label.lower(), amount=totals[kind], total=True, ref=ref(selected)))
        rows.append(dict(key='check', label='Assets less liabilities and equity', total=True,
                         amount=money(dec(totals['asset']) - dec(totals['liability']) - dec(totals['equity']))))
    elif name == 'cash-flow':
        cash = set(store['settings'].get('cashAccounts') or ['1000'])
        opening_lines = [r for r in closing if r['date'] < start and r['accountCode'] in cash]
        cash_lines = [r for r in activity if r['accountCode'] in cash]
        by_journal = {}
        for row in activity:
            by_journal.setdefault(row['journalId'], []).append(row)
        groups = {k: [] for k in ('operating', 'investing', 'financing', 'unclassified')}
        mappings = store['settings'].get('cashFlowMappings', {})
        account_by_code = {account['code']: account for account in store['accounts']}
        documents = {document['id']: document for document in store['documents']}
        settled_documents = {}
        for settlement in store['settlements']:
            document = documents.get(settlement['documentId'])
            if document and settlement.get('journalId'):
                settled_documents.setdefault(settlement['journalId'], []).append(document)

        def category_for(code, kind, group):
            if mappings.get(code):
                return mappings[code]
            if kind == 'equity' or (kind == 'liability' and 'non-current' in group.lower()):
                return 'financing'
            if kind == 'asset' and 'non-current' in group.lower():
                return 'investing'
            return 'operating'

        for journal_rows in by_journal.values():
            cash_rows = [r for r in journal_rows if r['accountCode'] in cash]
            movement = sum_net(cash_rows)
            if not movement:
                continue
            other = [r for r in journal_rows if r['accountCode'] not in cash]
            sources = settled_documents.get(journal_rows[0]['journalId'], [])
            if not sources and journal_rows[0].get('documentId') in documents:
                sources = [documents[journal_rows[0]['documentId']]]
            if sources:
                # A bill payment's AP control line does not describe what was
                # purchased. Classify the cash by the original document lines;
                # this also keeps settlement FX and GST within that cash flow.
                categories = set()
                for document in sources:
                    for item in document['lines']:
                        account = account_by_code.get(item.get('accountCode'), {})
                        categories.add(category_for(account.get('code'), account.get('type', ''), account.get('group', ''))
                                       if account else 'unclassified')
            else:
                categories = {category_for(row['accountCode'], row['accountType'], row['group']) for row in other}
            category = next(iter(categories)) if len(categories) == 1 else 'unclassified'
            groups[category].append(dict(key=journal_rows[0]['journalId'], label=f'{journal_rows[0]["number"]} · {journal_rows[0]["memo"]}', amount=movement, ref=ref(journal_rows)))
        rows.append(dict(key='opening', label='Cash and cash equivalents at beginning of period', amount=sum_net(opening_lines), total=True, ref=ref(opening_lines)))
        for key, label in (('operating', 'Operating activities'), ('investing', 'Investing activities'), ('financing', 'Financing activities'), ('unclassified', 'Classification review required')):
            if key == 'unclassified' and not groups[key]:
                continue
            rows.append(dict(key=key, label=label, section=True))
            rows.extend(groups[key])
            rows.append(dict(key='total-' + key, label='Net cash from / (used in) ' + label.lower(), total=True,
                             amount=money(sum(dec(r['amount']) for r in groups[key])), ref=combined_ref(groups[key])))
        rows.extend([dict(key='movement', label='Net increase / (decrease) in cash', amount=sum_net(cash_lines), total=True, ref=ref(cash_lines)),
                     dict(key='closing', label='Cash and cash equivalents at end of period',
                          amount=sum_net([r for r in closing if r['accountCode'] in cash]), total=True,
                          ref=ref([r for r in closing if r['accountCode'] in cash]))])
        notes = ['Direct method. Cash account scope and classifications are configured in Settings. Non-cash transactions are excluded.',
                 'Linked receipts and payments follow the original document line accounts, including capital purchases settled through payables. Mixed-purpose documents require classification review.']
        if groups['unclassified']:
            notes.append('Mixed-category journals need classification review before issuing this statement; split cash postings into separately classified journals.')
        return result(columns, rows, notes)
    return result(columns, rows)


def aging(store, name, end):
    kinds = {'invoice', 'credit_note'} if name == 'ar-aging' else {'bill', 'vendor_credit'}
    columns = [col('contact', 'Contact'), col('number', 'Document'), col('dueDate', 'Due date'),
               col('currency', 'Currency'), col('outstanding', 'Unpaid (FC)', 'money'),
               *[col(k, label, 'money') for k, label in (('current', 'Not due'), ('d30', '1–30'), ('d60', '31–60'), ('d90', '61–90'), ('older', 'Over 90'))],
               col('carrying', 'Carrying SGD', 'money'), col('closingRate', 'Closing rate', 'number'),
               col('revalued', 'Closing SGD', 'money'), col('fx', 'Unposted FX SGD', 'money')]
    rows, missing = [], set()
    for doc in store['documents']:
        if doc['kind'] not in kinds or doc['status'] != 'posted' or doc['date'] > end:
            continue
        amount = outstanding(store, doc, end)
        if not amount:
            continue
        sign = -1 if doc['kind'] in CREDITS else 1
        age = (date.fromisoformat(end) - date.fromisoformat(doc['dueDate'])).days
        bucket = 'current' if age <= 0 else 'd30' if age <= 30 else 'd60' if age <= 60 else 'd90' if age <= 90 else 'older'
        rate = closing_rate(store, doc['currency'], end)
        carry = money(dec(carrying_value(store, doc, end)) * sign)
        revalued = money(dec(amount) * dec(rate) * sign) if rate else None
        if rate is None:
            missing.add(doc['currency'])
        rows.append(dict(contact=doc['contact'], number=doc['number'], dueDate=doc['dueDate'], currency=doc['currency'],
                         outstanding=money(dec(amount) * sign), **{k: carry if bucket == k else 0 for k in ('current', 'd30', 'd60', 'd90', 'older')},
                         carrying=carry, closingRate=rate, revalued=revalued,
                         fx=money(dec(revalued) - dec(carry)) if revalued is not None else None,
                         ref=dict(documentId=doc['id'])))
    rows.sort(key=lambda r: (r['contact'].casefold(), r['dueDate']))
    control = store['settings']['defaultReceivableAccount'] if name == 'ar-aging' else store['settings']['defaultPayableAccount']
    ledger_balance = money(dec(sum_net([r for r in ledger(store, end=end) if r['accountCode'] == control])) * (1 if name == 'ar-aging' else -1))
    subledger = money(sum(dec(r['carrying']) for r in rows))
    notes = ['Aging buckets are in SGD at carrying value. Closing valuation uses the latest recorded rate on or before the reporting date.']
    gap = money(dec(ledger_balance) - dec(subledger))
    if gap:
        notes.append(f'Control account reconciliation: ledger SGD {ledger_balance:,.2f}; open documents SGD {subledger:,.2f}; unallocated difference SGD {gap:,.2f}. Review legacy or manual control-account entries.')
    if missing:
        notes.append('Closing rates missing: ' + ', '.join(sorted(missing)) + '. Add rates in the Currencies workspace.')
    totals = {key: money(sum(dec(r.get(key)) for r in rows)) for key in ('current', 'd30', 'd60', 'd90', 'older', 'carrying', 'revalued', 'fx')}
    if missing:
        totals.update(revalued=None, fx=None)
    rows.append(dict(contact='Total SGD', total=True, **totals))
    return dict(result(columns, rows, notes),
                reconciliation=dict(ledger=ledger_balance, subledger=subledger, difference=gap))


def single_report(store, name, start, end, args):
    if name in {'profit-loss', 'balance-sheet', 'cash-flow'}:
        return financial(store, name, start, end)
    if name in {'ar-aging', 'ap-aging'}:
        return aging(store, name, end)
    activity = ledger(store, start, end)
    closing = ledger(store, end=end)
    if name == 'equity':
        rows = []
        for account in store['accounts'] + [dict(code='earnings', name='Unclosed earnings', type='equity')]:
            if account['type'] != 'equity':
                continue
            selected = [r for r in closing if (r['accountType'] in {'revenue', 'expense'} if account['code'] == 'earnings' else r['accountCode'] == account['code'])]
            opening = money(-dec(sum_net([r for r in selected if r['date'] < start])))
            movement = money(-dec(sum_net([r for r in selected if r['date'] >= start])))
            rows.append(dict(label=account['name'], opening=opening, movement=movement,
                             closing=money(dec(opening) + dec(movement)), ref=ref(selected),
                             cellRefs=dict(opening=ref([r for r in selected if r['date'] < start]),
                                           movement=ref([r for r in selected if r['date'] >= start]),
                                           closing=ref(selected))))
        equity_lines = [r for r in closing if r['accountType'] in {'equity', 'revenue', 'expense'}]
        rows.append(dict(label='Total equity', total=True,
                         **{key: money(sum(dec(r[key]) for r in rows)) for key in ('opening', 'movement', 'closing')},
                         ref=ref(equity_lines), cellRefs=dict(
                             opening=ref([r for r in equity_lines if r['date'] < start]),
                             movement=ref([r for r in equity_lines if r['date'] >= start]),
                             closing=ref(equity_lines))))
        return result([col('label', 'Equity component'), col('opening', 'Opening SGD', 'money'),
                       col('movement', 'Movement SGD', 'money'), col('closing', 'Closing SGD', 'money')], rows,
                      ['Equity account movements include contributions, distributions and transfers. Create separate reserve accounts for other comprehensive income where applicable; drill down to review each movement.'])
    if name == 'trial-balance':
        rows = []
        for a in sorted(store['accounts'], key=lambda a: a['code']):
            selected = [r for r in closing if r['accountCode'] == a['code']]
            net = sum_net(selected)
            if selected:
                rows.append(dict(label=f'{a["code"]} · {a["name"]}', debit=max(net, 0), credit=max(-net, 0), ref=ref(selected)))
        rows.append(dict(label='Total', total=True, debit=money(sum(dec(r['debit']) for r in rows)), credit=money(sum(dec(r['credit']) for r in rows))))
        return result([col('label', 'Account'), col('debit', 'Debit SGD', 'money'), col('credit', 'Credit SGD', 'money')], rows)
    if name in {'general-ledger', 'journals', 'gst-detail'}:
        rows = []
        if name == 'general-ledger':
            codes = [args['accountCode']] if args.get('accountCode') else sorted({r['accountCode'] for r in closing})
            for code in codes:
                selected = [r for r in activity if r['accountCode'] == code]
                opening = sum_net([r for r in closing if r['accountCode'] == code and r['date'] < start])
                name_value = next((a['name'] for a in store['accounts'] if a['code'] == code), code)
                rows.append(dict(date=start, accountCode=code, accountName=name_value, memo='Opening balance', balance=opening, total=True,
                                 ref=ref([r for r in closing if r['accountCode'] == code and r['date'] < start])))
                balance = dec(opening)
                for r in selected:
                    balance += dec(r['debit']) - dec(r['credit'])
                    rows.append(dict(r, balance=money(balance), ref=dict(journalIds=[r['journalId']])))
        else:
            rows = [dict(r, ref=dict(journalIds=[r['journalId']])) for r in activity
                    if name != 'gst-detail' or (r.get('taxCode') != 'OP' and (r.get('taxBase') or r.get('gstAmount')))]
            if name == 'gst-detail':
                rows.sort(key=lambda r: (r['taxCode'], r['date'], r['number']))
                if args.get('taxCode'):
                    rows = [r for r in rows if r['taxCode'] == args['taxCode']]
        columns = [col('date', 'Date'), col('number', 'Journal'), col('accountCode', 'Account'), col('accountName', 'Account name'), col('memo', 'Description')]
        columns += ([col('taxCode', 'GST code'), col('taxBase', 'Taxable SGD', 'money'), col('gstAmount', 'GST SGD', 'money')]
                    if name == 'gst-detail' else [col('debit', 'Debit SGD', 'money'), col('credit', 'Credit SGD', 'money')])
        if name == 'general-ledger':
            columns.append(col('balance', 'Running SGD', 'money'))
        return result(columns, rows)
    if name == 'gst':
        values = {i: 0 for i in range(1, 9)}
        refs = {}
        for code, box, taxbox in (('SR9', 1, 6), ('ZR', 2, None), ('ES', 3, None), ('TX9', 5, 7), ('TX0', 5, None)):
            selected = [r for r in activity if r.get('taxCode') == code]
            values[box] = money(dec(values[box]) + sum(dec(r.get('taxBase')) for r in selected))
            refs.setdefault(box, []).extend(selected)
            if taxbox:
                values[taxbox] = money(sum(dec(r.get('gstAmount')) for r in selected))
                refs[taxbox] = selected
        values[4] = money(sum(dec(values[i]) for i in (1, 2, 3)))
        values[8] = money(dec(values[6]) - dec(values[7]))
        revenue_codes = store['settings'].get('gstRevenueAccounts', ['4000'])
        revenue = [r for r in activity if r['accountCode'] in revenue_codes]
        values[13] = money(-dec(sum_net(revenue)))
        refs.update({4: sum([refs.get(i, []) for i in (1, 2, 3)], []), 8: refs.get(6, []) + refs.get(7, []), 13: revenue})
        return result([col('label', 'GST F5 box'), col('amount', 'SGD', 'money'), col('status', 'Review')],
                      [dict(label=f'Box {i} · {GST_LABELS[i]}', amount=values.get(i),
                            status='Computed from ledger' if i in values else 'Accountant declaration required',
                            ref=ref(refs.get(i, []))) for i in range(1, 18)],
                      ['Working schedule for review in myTax Portal. Special schemes, refunds, reverse charge and pre-registration claims require supporting declarations; blank boxes are not assumed to be zero.',
                       'Box 13 uses operating revenue accounts selected in Settings. Review non-operating income, grants and disposal proceeds separately.',
                       'GST registration: ' + ('enabled' if store['settings']['gstRegistered'] else 'not enabled')])
    if name == 'bank-reconciliation':
        bank = args.get('bankAccount') or store['settings']['defaultBankAccount']
        statements = [b for b in store['bankTransactions'] if b['bankAccount'] == bank and b['date'] <= end]
        selected = [r for r in closing if r['accountCode'] == bank]
        reconciliations = [r for r in store['bankReconciliations'] if r['bankAccount'] == bank and r['date'] == end]
        saved = reconciliations[-1] if reconciliations else None
        ledger_close = sum_net(selected)
        journal_ids = {r['journalId'] for r in selected}
        matched_ids, unbooked = set(), []
        for statement in statements:
            linked = set(statement.get('journalIds') or []) | {statement.get('journalId')}
            linked.discard(None)
            linked.discard('')
            if statement.get('status') == 'matched' and linked and linked <= journal_ids:
                matched_ids.update(linked)
            else:
                unbooked.append(statement)
        outstanding = [r for r in selected if r['journalId'] not in matched_ids]
        pending_cash = sum_net(outstanding)
        unbooked_cash = money(sum(dec(b['amount']) for b in unbooked))
        adjusted = money(dec(saved['closingBalance']) + dec(pending_cash) - dec(unbooked_cash)) if saved else None
        difference = money(dec(adjusted) - dec(ledger_close)) if adjusted is not None else None
        rows = [dict(label='Statement closing balance', amount=saved['closingBalance'] if saved else None),
                dict(label='Add / (deduct): cash entries outstanding on the statement', amount=pending_cash, ref=ref(outstanding)),
                dict(label='Deduct / (add): statement items not yet booked', amount=money(-dec(unbooked_cash))),
                dict(label='Adjusted statement balance', amount=adjusted, total=True),
                dict(label='Ledger closing balance', amount=ledger_close, ref=ref(selected)),
                dict(label='Unexplained reconciliation difference', amount=difference, total=True),
                dict(label='Unbooked statement items through the reporting date', section=True)]
        rows += [dict(label=f'{b["date"]} · {b["description"]}', amount=b['amount']) for b in unbooked]
        rows.append(dict(label='Outstanding ledger cash entries through the reporting date', section=True))
        rows += [dict(label=f'{r["date"]} · {r["number"]} · {r["memo"]}', amount=sum_net([r]), ref=ref([r])) for r in outstanding]
        return dict(result([col('label', 'Reconciliation line'), col('amount', 'SGD', 'money')], rows,
                      [f'Bank account {bank}. ' + ('Statement closing balance entered by ' + saved['createdBy'] if saved else 'Enter the actual statement closing balance in Banking to complete the reconciliation.'),
                       'Review outstanding cheques and deposits and clear unbooked statement items. A zero unexplained difference alone does not establish sign-off.']),
                    reconciliation=dict(bankAccount=bank, difference=difference, unmatchedStatementCount=len(unbooked),
                                        outstandingLedgerCount=len(outstanding)))
    if name == 'fixed-assets':
        rows = []
        for asset in store['fixedAssets']:
            if asset['inServiceDate'] > end:
                continue
            opening = money(sum(dec(r['amount']) for r in asset['depreciation'] if r['date'] < start))
            charge = money(sum(dec(r['amount']) for r in asset['depreciation'] if start <= r['date'] <= end))
            accumulated = money(dec(opening) + dec(charge))
            rows.append(dict(name=asset['name'], start=asset['inServiceDate'], cost=asset['cost'], opening=opening,
                             charge=charge, accumulated=accumulated, nbv=money(dec(asset['cost']) - dec(accumulated)),
                             pending=money(dec(depreciation_target(asset, end)) - dec(accumulated)),
                             ref=dict(journalIds=[asset['acquisitionJournalId']] + [r['journalId'] for r in asset['depreciation'] if r['date'] <= end])))
        rows.append(dict(name='Total', total=True,
                         **{key: money(sum(dec(r[key]) for r in rows)) for key in ('cost', 'opening', 'charge', 'accumulated', 'nbv', 'pending')},
                         ref=combined_ref(rows)))
        return result([col('name', 'Asset'), col('start', 'In service'), *[col(k, label, 'money') for k, label in
                       [('cost', 'Cost SGD'), ('opening', 'Opening dep.'), ('charge', 'Period charge'), ('accumulated', 'Accumulated dep.'), ('nbv', 'Net book value'), ('pending', 'Unposted dep.')]]], rows,
                      ['Straight-line depreciation: full monthly charge at month end, including the service month; no charge below residual value. Acquisition journals establish cost in the ledger.'])
    if name == 'inventory':
        rows = []
        for item in store['stockItems']:
            quantity, value = stock_position(store, item['id'], end)
            journal_ids = [m.get('journalId') or next((d.get('journalId') for d in store['documents']
                           if d['id'] == m.get('source')), None) for m in store['stockMoves']
                           if m['itemId'] == item['id'] and m['date'] <= end]
            rows.append(dict(sku=item['sku'], name=item['name'], quantity=quantity, value=value,
                             unitCost=money(dec(value) / dec(quantity)) if quantity else 0,
                             ref=dict(journalIds=list(dict.fromkeys(j for j in journal_ids if j)))))
        rows.append(dict(name='Total inventory value', total=True,
                         value=money(sum(dec(r['value']) for r in rows)), ref=combined_ref(rows)))
        return result([col('sku', 'SKU'), col('name', 'Stock item'), col('quantity', 'On hand', 'number'), col('unitCost', 'Average cost SGD', 'money'), col('value', 'Value SGD', 'money')], rows)
    if name in {'customer-statement', 'supplier-statement'}:
        party = 'customer' if name == 'customer-statement' else 'supplier'
        kinds = {'invoice', 'credit_note'} if name == 'customer-statement' else {'bill', 'vendor_credit'}
        contact = args.get('contact', '')
        if not contact:
            return result([col('label', party.title() + ' statement')], [], [f'Choose a {party} to generate their statement.'])
        docs = [d for d in store['documents'] if d['contact'] == contact and d['kind'] in kinds and d['status'] == 'posted' and d['date'] <= end]
        currency = args.get('currency') or 'SGD'
        docs = [d for d in docs if d['currency'] == currency]
        ids = {d['id']: d for d in docs}
        entries = [dict(date=d['date'], label=d['number'], amount=money(dec(d['total']) * (-1 if d['kind'] in CREDITS else 1)), ref=dict(documentId=d['id'])) for d in docs]
        entries.extend(dict(date=s['date'], label=s.get('reference') or 'Payment / credit allocation',
                            amount=money(dec(s['amount']) * (1 if ids[s['documentId']]['kind'] in CREDITS else -1)),
                            ref=dict(documentId=s['documentId'])) for s in store['settlements'] if s['documentId'] in ids and s['date'] <= end)
        balance = sum(dec(r['amount']) for r in entries if r['date'] < start)
        rows = [dict(date=start, label='Opening balance', balance=money(balance), total=True)]
        for row in sorted([r for r in entries if r['date'] >= start], key=lambda r: r['date']):
            balance += dec(row['amount'])
            rows.append(dict(row, balance=money(balance)))
        rows.append(dict(date=end, label='Closing balance', balance=money(balance), total=True))
        return result([col('date', 'Date'), col('label', 'Document / payment'), col('amount', currency + ' movement', 'money'), col('balance', currency + ' balance', 'money')], rows, [contact + ' · ' + currency])
    raise ValueError('Unknown accounting report')


def include_comparison_cash_flows(table, previous):
    """Keep comparison-only cash entries inside their activity group.

    Financial account rows are stable across periods, but cash-flow detail keys
    are journal IDs. Comparing only current rows otherwise hides every prior
    cash receipt/payment while still showing the prior activity subtotal.
    """
    current_keys = {row['key'] for row in table['rows']}
    no_current_activity = {column['key']: 0 for column in table['columns'] if column['key'].startswith('period')}
    category = None
    for prior_row in previous['rows']:
        key = prior_row['key']
        if prior_row.get('section'):
            category = key
            if key not in current_keys:
                insertion = next(i for i, row in enumerate(table['rows']) if row['key'] == 'movement')
                previous_total = next(row for row in previous['rows'] if row['key'] == 'total-' + key)
                table['rows'][insertion:insertion] = [dict(prior_row), dict(previous_total, **no_current_activity, amount=0, ref=ref([]))]
                current_keys.update((key, 'total-' + key))
        elif category and not prior_row.get('total') and key not in current_keys:
            insertion = next(i for i, row in enumerate(table['rows']) if row['key'] == 'total-' + category)
            table['rows'].insert(insertion, dict(prior_row, **no_current_activity, amount=0, ref=ref([])))
            current_keys.add(key)


def build_report(store, name, args):
    start, end = day(args.get('from') or date.today().replace(day=1).isoformat()), day(args.get('to') or date.today().isoformat())
    if start > end:
        raise ValueError('Start date must be on or before end date')
    if name not in {r[0] for r in CATALOG}:
        raise ValueError('Unknown accounting report')
    table = single_report(store, name, start, end, args)
    granularity = args.get('groupBy', 'total')
    if granularity in {'monthly', 'yearly'} and name in {'profit-loss', 'balance-sheet', 'cash-flow'}:
        periods, cursor = [], date.fromisoformat(start)
        while cursor <= date.fromisoformat(end):
            if len(periods) >= 36:
                raise ValueError('Choose a range of at most 36 reporting columns')
            fiscal_month = int(store['settings'].get('financialYearStartMonth', 1))
            fiscal_year = cursor.year + (1 if cursor.month >= fiscal_month else 0)
            fiscal_end = date(fiscal_year, fiscal_month, 1) - timedelta(days=1)
            stop = date(cursor.year, cursor.month, calendar.monthrange(cursor.year, cursor.month)[1]) if granularity == 'monthly' else fiscal_end
            stop = min(stop, date.fromisoformat(end))
            periods.append((cursor.isoformat(), stop.isoformat()))
            cursor = stop + timedelta(days=1)
        table['columns'] = [col('label', 'Account / line item')]
        lookup = {r['key']: r for r in table['rows']}
        for index, (first, last) in enumerate(periods):
            key = 'period' + str(index)
            table['columns'].append(col(key, last[:7] if granularity == 'monthly' else 'FY to ' + last, 'money'))
            for row in financial(store, name, first, last)['rows']:
                if row['key'] not in lookup:
                    # Cash-flow transaction rows can differ across periods.
                    lookup[row['key']] = dict(row)
                    table['rows'].append(lookup[row['key']])
                lookup[row['key']][key] = row.get('amount')
                lookup[row['key']].setdefault('cellRefs', {})[key] = row.get('ref')
    compare = args.get('compare', 'none')
    if compare in {'previous', 'year', 'custom'} and name in {'profit-loss', 'balance-sheet', 'cash-flow'}:
        if compare == 'custom':
            previous_start, previous_end = day(args.get('compareFrom')), day(args.get('compareTo'))
        elif compare == 'year':
            def prior(value):
                d = date.fromisoformat(value)
                return d.replace(year=d.year - 1, day=min(d.day, calendar.monthrange(d.year - 1, d.month)[1])).isoformat()
            previous_start, previous_end = prior(start), prior(end)
        else:
            first, last = date.fromisoformat(start), date.fromisoformat(end)
            previous_end = (first - timedelta(days=1)).isoformat()
            if first.day == 1 and last.day == calendar.monthrange(last.year, last.month)[1]:
                months = (last.year - first.year) * 12 + last.month - first.month + 1
                index = first.year * 12 + first.month - 1 - months
                previous_start = date(index // 12, index % 12 + 1, 1).isoformat()
            else:
                length = (last - first).days + 1
                previous_start = (first - timedelta(days=length)).isoformat()
        if previous_start > previous_end:
            raise ValueError('Comparison start must precede its end')
        previous = financial(store, name, previous_start, previous_end)
        if name == 'cash-flow':
            include_comparison_cash_flows(table, previous)
        lookup = {r['key']: r for r in previous['rows']}
        if granularity in {'monthly', 'yearly'}:
            label = 'Closing balance SGD' if name == 'balance-sheet' else 'Selected period total SGD'
            table['columns'].append(col('amount', label, 'money'))
        table['columns'] += [col('comparison', 'Comparison SGD', 'money'), col('variance', 'Change SGD', 'money')]
        for row in table['rows']:
            if row.get('section'):
                continue
            previous_row = lookup.get(row['key'], {})
            row['comparison'] = previous_row.get('amount', 0)
            row['variance'] = money(dec(row.get('amount')) - dec(row['comparison']))
            row.setdefault('cellRefs', {})['comparison'] = previous_row.get('ref')
            row['cellRefs']['variance'] = dict(journalIds=list(dict.fromkeys(
                (row.get('ref') or {}).get('journalIds', []) + (previous_row.get('ref') or {}).get('journalIds', []))))
        table['notes'].append(f'Comparison: {previous_start} to {previous_end}. Change compares the full selected period with the comparison period.')
    title = next(r[1] for r in CATALOG if r[0] == name)
    return dict(table, name=name, title=title, period=dict(**{'from': start, 'to': end}),
                businessName=store['settings'].get('businessName', ''), uen=store['settings'].get('uen', ''),
                currency=(args.get('currency') or 'SGD') if name in {'customer-statement', 'supplier-statement'} else 'SGD',
                framework=store['settings'].get('reportingFramework', 'FRS'))
