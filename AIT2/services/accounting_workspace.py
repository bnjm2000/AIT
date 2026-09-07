"""Company-scoped bookkeeping rules. All amounts are calculated with Decimal.

The caller holds the finance lock and saves only after a command succeeds.
Documents, settlements and generated journals therefore commit together.
"""
from __future__ import annotations

import calendar
import copy
import re
import uuid
from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP


KINDS = {
    'quote': 'Quotation', 'invoice': 'Invoice', 'credit_note': 'Credit note',
    'purchase_order': 'Purchase order', 'bill': 'Bill', 'vendor_credit': 'Vendor credit',
    'expense': 'Expense', 'receive_money': 'Receive money',
}
SALES = {'quote', 'invoice', 'credit_note', 'receive_money'}
NON_POSTING = {'quote', 'purchase_order'}
OPEN_ITEMS = {'invoice', 'bill', 'credit_note', 'vendor_credit'}
CREDITS = {'credit_note', 'vendor_credit'}
ROLES = {
    'manager': {'read', 'write', 'post', 'approve', 'settings'},
    'accountant': {'read', 'write', 'post', 'approve'},
    'bookkeeper': {'read', 'write'},
    'auditor': {'read'},
}
EXTRA_ACCOUNTS = [
    ('1400', 'Trading inventory', 'asset', 'Current Assets'),
    ('4200', 'Foreign exchange gains', 'revenue', 'Other Income'),
    ('6950', 'Depreciation expense', 'expense', 'Operating Expenses'),
    ('6960', 'Foreign exchange losses', 'expense', 'Operating Expenses'),
]


def uid():
    return uuid.uuid4().hex


def now():
    return datetime.now(timezone.utc).isoformat()


def dec(value):
    try:
        result = Decimal(str(value if value not in (None, '') else 0))
    except (InvalidOperation, ValueError):
        raise ValueError('Enter a valid number') from None
    if not result.is_finite() or abs(result) > Decimal('1000000000000'):
        raise ValueError('Amount is outside the supported range')
    return result


def money(value):
    rounded = dec(value).quantize(Decimal('.01'), rounding=ROUND_HALF_UP)
    return 0.0 if rounded == 0 else float(rounded)


def day(value):
    try:
        return date.fromisoformat(str(value)).isoformat()
    except ValueError:
        raise ValueError('Enter a valid date (YYYY-MM-DD)') from None


def required(value, label, limit=250):
    result = str(value or '').strip()[:limit]
    if not result:
        raise ValueError(f'{label} is required')
    return result


def initialise(store):
    for key in ('documents', 'settlements', 'fixedAssets', 'stockItems', 'stockMoves',
                'recurring', 'tasks', 'auditTrail', 'attachments', 'exchangeRates',
                'revaluations', 'bankReconciliations', 'contacts', 'filings', 'reportPacks'):
        store.setdefault(key, [])
    settings = store['settings']
    for key, value in {'baseCurrency': 'SGD', 'approvalRequired': False,
                       'inventoryEnabled': False, 'roles': {}, 'uen': '', 'peppolId': '',
                       'businessName': '', 'businessAddress': '',
                       'invoiceNowProvider': '', 'cashAccounts': ['1000'],
                       'reportingFramework': 'FRS', 'cashFlowMappings': {}}.items():
        settings.setdefault(key, value)
    codes = {a['code'] for a in store['accounts']}
    for code, name, kind, group in EXTRA_ACCOUNTS:
        if code not in codes:
            store['accounts'].append(dict(code=code, name=name, type=kind, group=group,
                                          active=True, system=True))
    settings.setdefault('gstRevenueAccounts', [a['code'] for a in store['accounts']
                                              if a['type'] == 'revenue' and a.get('group', '').lower() != 'other income'])
    return store


def role_for(store, actor, owner=False):
    return 'manager' if owner else store['settings'].get('roles', {}).get(actor, '')


def allow(role, permission):
    if permission not in ROLES.get(role, set()):
        raise PermissionError(f'Your accounting role does not allow this action ({permission})')


def unlocked(store, value):
    entry_date = day(value)
    locked = store['settings'].get('periodLockDate', '')
    if locked and entry_date <= locked:
        raise ValueError(f'The accounting period is locked through {locked}')
    return entry_date


def audit(store, actor, action, target, before=None, after=None):
    store['auditTrail'].append(dict(id=uid(), at=now(), by=actor, action=action,
                                   target=str(target), before=copy.deepcopy(before),
                                   after=copy.deepcopy(after)))


def find(store, collection, record_id):
    result = next((r for r in store[collection] if r['id'] == record_id), None)
    if result is None:
        raise ValueError('Record not found')
    return result


def matched_journal_ids(bank_transaction):
    return set(bank_transaction.get('journalIds') or []) | ({bank_transaction['journalId']}
               if bank_transaction.get('journalId') else set())


def unmatch_journal_bank_lines(store, journal_id):
    """A grouped statement match is invalid if any constituent is reversed."""
    for bank in store['bankTransactions']:
        if journal_id in matched_journal_ids(bank):
            bank.update(status='unmatched', journalId='', journalIds=[], matchedAt='', matchedBy='')


def account(store, code, types=None):
    result = next((a for a in store['accounts'] if a['code'] == str(code)), None)
    if not result or result.get('active') is False or (types and result['type'] not in types):
        raise ValueError(f'Choose an active {" / ".join(types or [])} account: {code}')
    return str(code)


def fx_rate(currency, value):
    currency = str(currency or 'SGD').upper().strip()
    if not re.fullmatch('[A-Z]{3}', currency):
        raise ValueError('Use a three-letter currency code')
    rate = dec(1 if currency == 'SGD' else value)
    if rate <= 0:
        raise ValueError('Enter the SGD value of one unit of the foreign currency')
    return currency, float(rate)


def line(code, amount, **metadata):
    amount = money(amount)
    return dict(accountCode=code, debit=max(amount, 0), credit=max(-amount, 0), **metadata)


def post_journal(store, actor, description, entry_date, lines, source_key, **extra):
    unlocked(store, entry_date)
    if any(j.get('sourceKey') == source_key for j in store['journals']):
        raise ValueError('This transaction has already been recorded')
    lines = [dict({'id': uid(), 'taxCode': 'OP', 'taxBase': 0, 'gstAmount': 0}, **row)
        for row in lines if row.get('debit') or row.get('credit')]
    for row in lines:
        account(store, row['accountCode'])
    if len(lines) < 2 or money(sum(dec(l['debit']) - dec(l['credit']) for l in lines)):
        raise ValueError('Posting must balance to the cent')
    prefix = f'JE-{entry_date[:4]}-'
    sequence = max([int(j['number'][len(prefix):]) for j in store['journals']
                    if re.fullmatch(re.escape(prefix) + r'\d+', j.get('number', ''))] or [0]) + 1
    journal = dict(id=uid(), number=f'{prefix}{sequence:05d}', date=entry_date,
                   description=description, reference=extra.pop('reference', ''), status='posted',
                   sourceKey=source_key, sourceType='accounting', lines=lines,
                   debitTotal=money(sum(dec(l['debit']) for l in lines)),
                   creditTotal=money(sum(dec(l['credit']) for l in lines)),
                   createdAt=now(), createdBy=actor, updatedAt=now(), updatedBy=actor,
                   postedAt=now(), history=[], **extra)
    store['journals'].append(journal)
    audit(store, actor, 'journal.posted', journal['id'], after=journal)
    return journal


def normalise_document(store, value, actor, existing=None):
    existing = existing or {}
    kind = value.get('kind', existing.get('kind'))
    if kind not in KINDS:
        raise ValueError('Choose a document type')
    entry_date = unlocked(store, value.get('date'))
    due = day(value.get('dueDate') or entry_date)
    currency, rate = fx_rate(value.get('currency'), value.get('exchangeRate'))
    price_basis = value.get('priceBasis', existing.get('priceBasis', 'exclusive'))
    if price_basis not in {'exclusive', 'inclusive'}:
        raise ValueError('Choose tax-exclusive or tax-inclusive prices')
    contact = required(value.get('contact'), 'Customer / supplier')
    rows = value.get('lines')
    if not isinstance(rows, list) or not 1 <= len(rows) <= 200:
        raise ValueError('Add between 1 and 200 document lines')
    normal = []
    for raw in rows:
        description = required(raw.get('description'), 'Line description', 500)
        quantity, price = dec(raw.get('quantity', 1)), dec(raw.get('unitPrice'))
        if quantity <= 0 or price < 0:
            raise ValueError('Quantity must be positive and unit price cannot be negative')
        base = money(quantity * price)
        code = str(raw.get('taxCode') or 'OP')
        allowed = {'SR9', 'ZR', 'ES', 'OP'} if kind in SALES else {'TX9', 'TX0', 'BL9', 'BL', 'OP'}
        if code not in allowed:
            raise ValueError('Choose a GST code appropriate for this transaction')
        if code in {'SR9', 'TX9'} and not store['settings']['gstRegistered']:
            raise ValueError('Enable GST registration before using a GST code')
        taxed = code in {'SR9', 'TX9', 'BL9'}
        if taxed and price_basis == 'inclusive':
            gross = base
            base = money(dec(gross) / Decimal('1.09'))
            tax = money(dec(gross) - dec(base))
        else:
            tax = money(dec(base) * Decimal('.09')) if taxed else 0
        default = '4000' if kind in SALES else '6800'
        direct_cash = kind in {'expense', 'receive_money'}
        ledger_code = account(store, raw.get('accountCode') or default,
                              None if direct_cash else ['revenue', 'equity', 'liability'] if kind in SALES else ['expense', 'asset'])
        if direct_cash and ledger_code in {store['settings']['defaultReceivableAccount'], store['settings']['defaultPayableAccount']}:
            raise ValueError('Use payment matching for receivable or payable control accounts')
        item_id = str(raw.get('stockItemId') or '')
        if item_id:
            if not store['settings']['inventoryEnabled']:
                raise ValueError('Enable trading inventory in settings first')
            find(store, 'stockItems', item_id)
            if kind not in {'quote', 'purchase_order', 'invoice', 'bill'}:
                raise ValueError('Stock lines are supported on invoices and bills; use stock adjustments for returns')
            if kind in {'bill', 'purchase_order'}:
                ledger_code = '1400'
        normal.append(dict(id=uid(), description=description, quantity=float(quantity),
                           unitPrice=float(price), net=base, tax=tax, taxCode=code,
                           accountCode=ledger_code, stockItemId=item_id))
    net = money(sum(dec(r['net']) for r in normal))
    tax = money(sum(dec(r['tax']) for r in normal))
    if net <= 0:
        raise ValueError('Document total must be greater than zero')
    number = str(existing.get('number') or value.get('number') or
                 f'{kind.upper().replace("_", "-")}-{entry_date[:4]}-{len(store["documents"]) + 1:05d}').strip()[:80]
    if any(d['id'] != existing.get('id') and d['number'].casefold() == number.casefold()
           for d in store['documents']):
        raise ValueError('This document number already exists')
    return dict(id=existing.get('id') or uid(), kind=kind, number=number, date=entry_date,
                dueDate=due, contact=contact, currency=currency, exchangeRate=rate,
                lines=normal, net=net, tax=tax, total=money(dec(net) + dec(tax)), priceBasis=price_basis,
                baseTotal=money((dec(net) + dec(tax)) * dec(rate)),
                bankAccount=account(store, value.get('bankAccount') or store['settings']['defaultBankAccount'], ['asset']),
                reference=str(value.get('reference') or '')[:250],
                notes=str(value.get('notes') or '')[:4000], status='draft',
                createdAt=existing.get('createdAt') or now(), createdBy=existing.get('createdBy') or actor,
                updatedAt=now(), updatedBy=actor, version=int(existing.get('version', 0)) + 1,
                convertedFrom=existing.get('convertedFrom', ''))


def save_document(store, value, actor, record_id=None):
    old = find(store, 'documents', record_id) if record_id else None
    if old and old['status'] != 'draft':
        raise ValueError('Only drafts can be edited. Return a submitted document to draft first.')
    if old and value.get('version') != old['version']:
        raise ValueError('This document changed in another session. Reload before saving.')
    if old:
        unlocked(store, old['date'])
    document = normalise_document(store, value, actor, old)
    audit(store, actor, 'document.updated' if old else 'document.created', document['id'], old, document)
    if old:
        old.clear()
        old.update(document)
    else:
        store['documents'].append(document)
    return document


def snapshot_document_parties(store, doc):
    """Retain the identities used when a document is approved or posted.

    Changing a company's address or a contact later must not silently rewrite
    issued documents. Drafts deliberately resolve current details instead.
    """
    settings = store['settings']
    contact = next((row for row in store['contacts']
                    if row['name'].casefold() == doc['contact'].casefold()), {})
    return dict(businessName=settings.get('businessName', ''),
                businessAddress=settings.get('businessAddress', ''),
                uen=settings.get('uen', ''),
                gstRegistrationNumber=settings.get('gstRegistrationNumber', ''),
                gstRegistered=settings.get('gstRegistered') is True,
                contactName=doc['contact'], contactAddress=contact.get('address', ''),
                recordedAt=now())


def document_action(store, record_id, action, actor, role):
    doc = find(store, 'documents', record_id)
    before = copy.deepcopy(doc)
    unlocked(store, doc['date'])
    if action == 'submit':
        allow(role, 'write')
        if doc['status'] != 'draft':
            raise ValueError('Only drafts can be submitted')
        doc.update(status='submitted', submittedBy=actor, submittedAt=now())
    elif action == 'return':
        allow(role, 'approve')
        if doc['status'] != 'submitted':
            raise ValueError('Only submitted documents can be returned')
        doc['status'] = 'draft'
    elif action == 'post':
        allow(role, 'post')
        if doc['status'] not in {'draft', 'submitted'}:
            raise ValueError('Document has already been processed')
        if store['settings']['approvalRequired']:
            allow(role, 'approve')
            if doc['status'] != 'submitted':
                raise ValueError('Submit the document for approval first')
            if actor in {doc['createdBy'], doc.get('updatedBy'), doc.get('submittedBy')}:
                raise ValueError('A different accountant must approve this document')
        if doc['kind'] in NON_POSTING:
            doc['status'] = 'approved'
        else:
            post_document(store, doc, actor)
            doc['status'] = 'posted'
        doc['partySnapshot'] = snapshot_document_parties(store, doc)
        doc.update(approvedBy=actor, approvedAt=now())
    elif action == 'convert':
        allow(role, 'write')
        if doc['kind'] not in NON_POSTING or doc['status'] != 'approved':
            raise ValueError('Approve the quotation / purchase order before converting it')
        if doc.get('convertedTo'):
            raise ValueError('This document has already been converted')
        converted = save_document(store, {**doc, 'number': '',
                                         'kind': 'invoice' if doc['kind'] == 'quote' else 'bill'}, actor)
        converted['convertedFrom'] = doc['id']
        doc['convertedTo'] = converted['id']
    elif action == 'void':
        allow(role, 'write')
        if doc['status'] not in {'draft', 'submitted'}:
            raise ValueError('Posted documents must be corrected with a credit note')
        doc['status'] = 'void'
    else:
        raise ValueError('Unknown document action')
    doc['version'] += 1
    audit(store, actor, 'document.' + action, doc['id'], before, doc)
    return doc


def post_document(store, doc, actor):
    kind, rate = doc['kind'], dec(doc['exchangeRate'])
    outgoing = kind in SALES
    sign = -1 if kind in CREDITS else 1
    counter = doc['bankAccount'] if kind in {'expense', 'receive_money'} else (
        store['settings']['defaultReceivableAccount'] if outgoing else store['settings']['defaultPayableAccount'])
    rows, base_sum = [], Decimal(0)
    for item in doc['lines']:
        base, tax = money(dec(item['net']) * rate), money(dec(item['tax']) * rate)
        blocked = item['taxCode'] == 'BL9'
        expense_base = money(dec(base) + dec(tax)) if blocked else base
        amount = dec(expense_base) * sign * (-1 if outgoing else 1)
        rows.append(line(item['accountCode'], amount, description=item['description'],
                         contact=doc['contact'], taxCode=item['taxCode'],
                         taxBase=money(dec(base) * sign), gstAmount=money(dec(tax) * sign)))
        base_sum += dec(base) + dec(tax)
        if tax and not blocked:
            rows.append(line('2100' if outgoing else '1200', dec(tax) * sign * (-1 if outgoing else 1)))
        if item.get('stockItemId'):
            quantity = dec(item['quantity']) * (-1 if kind == 'invoice' else 1)
            move = stock_move(store, actor, dict(itemId=item['stockItemId'], date=doc['date'],
                                                 quantity=quantity, unitCost=str(dec(expense_base) / dec(item['quantity'])),
                                                 reference=doc['number']), post=False, source=doc['id'])
            if kind == 'invoice':
                rows.extend([line('5000', move['value']), line('1400', -dec(move['value']))])
    rows.append(line(counter, base_sum * sign * (1 if outgoing else -1), contact=doc['contact']))
    doc['baseTotal'] = money(base_sum)
    journal = post_journal(store, actor, f"{KINDS[kind]} · {doc['contact']}", doc['date'], rows,
                           'document:' + doc['id'], reference=doc['number'], documentId=doc['id'],
                           currency=doc['currency'], exchangeRate=doc['exchangeRate'])
    doc['journalId'] = journal['id']


def outstanding(store, doc, as_at='9999-12-31'):
    paid = sum(dec(s['amount']) for s in store['settlements'] if s['documentId'] == doc['id'] and s['date'] <= as_at)
    return money(dec(doc['total']) - paid)


def carrying_value(store, doc, as_at='9999-12-31'):
    balance = dec(doc['baseTotal'])
    for settlement in store['settlements']:
        if settlement['documentId'] == doc['id'] and settlement['date'] <= as_at:
            balance -= dec(settlement['carryingAmount'])
    for revaluation in store['revaluations']:
        if revaluation['documentId'] == doc['id'] and revaluation['date'] <= as_at:
            balance += dec(revaluation['adjustment'])
    return money(balance)


def settle_batch(store, value, actor, role):
    allow(role, 'post')
    entry_date = unlocked(store, value.get('date'))
    bank = account(store, value.get('bankAccount') or store['settings']['defaultBankAccount'], ['asset'])
    token = required(value.get('requestId'), 'Payment request ID', 100)
    if any(s.get('requestId') == token for s in store['settlements']):
        raise ValueError('This payment batch has already been recorded')
    allocations = value.get('allocations')
    if not isinstance(allocations, list) or not 1 <= len(allocations) <= 200:
        raise ValueError('Select up to 200 invoices / bills and enter the amount allocated to each')
    result = []
    for allocation in allocations:
        doc = find(store, 'documents', allocation.get('documentId'))
        if doc['status'] != 'posted' or doc['kind'] not in OPEN_ITEMS:
            raise ValueError('Payments can only be allocated to posted invoices, bills or credits')
        if entry_date < doc['date']:
            raise ValueError('Payment date cannot precede the document date')
        latest = max([s['date'] for s in store['settlements'] + store['revaluations'] if s['documentId'] == doc['id']] or [doc['date']])
        if entry_date < latest:
            raise ValueError('Record settlements in date order after the latest payment or revaluation')
        amount = money(allocation.get('amount'))
        remaining = outstanding(store, doc)
        if amount <= 0 or amount > remaining:
            raise ValueError(f'{doc["number"]}: payment exceeds the outstanding balance or is not positive')
        _, rate = fx_rate(doc['currency'], allocation.get('exchangeRate'))
        base = money(dec(amount) * dec(rate))
        carrying = carrying_value(store, doc)
        removed = carrying if amount == remaining else money(dec(carrying) * dec(amount) / dec(remaining))
        incoming = doc['kind'] in {'invoice', 'vendor_credit'}
        direction = 1 if incoming else -1
        control = store['settings']['defaultReceivableAccount'] if doc['kind'] in {'invoice', 'credit_note'} else store['settings']['defaultPayableAccount']
        diff = money((dec(base) - dec(removed)) * direction)
        rows = [line(bank, dec(base) * direction), line(control, -dec(removed) * direction)]
        if diff:
            rows.append(line('4200' if diff > 0 else '6960', -dec(diff)))
        journal = post_journal(store, actor, f'Payment · {doc["number"]}', entry_date, rows,
                               f'payment:{token}:{doc["id"]}', reference=value.get('reference', ''), documentId=doc['id'])
        settlement = dict(id=uid(), requestId=token, documentId=doc['id'], date=entry_date,
                          amount=amount, baseAmount=base, carryingAmount=removed, exchangeRate=rate,
                          currency=doc['currency'], bankAccount=bank, journalId=journal['id'],
                          reference=str(value.get('reference') or '')[:250], createdBy=actor, createdAt=now())
        store['settlements'].append(settlement)
        result.append(settlement)
    audit(store, actor, 'payment.batch', token, after=result)
    return result


def apply_credit(store, value, actor, role):
    allow(role, 'post')
    credit = find(store, 'documents', value.get('creditId'))
    doc = find(store, 'documents', value.get('documentId'))
    expected = 'invoice' if credit['kind'] == 'credit_note' else 'bill'
    if credit['kind'] not in CREDITS or doc['kind'] != expected or any(d['status'] != 'posted' for d in (doc, credit)):
        raise ValueError('Choose a posted credit and matching invoice / bill')
    if credit['contact'] != doc['contact'] or credit['currency'] != doc['currency']:
        raise ValueError('Credit and document must belong to the same contact and currency')
    entry_date = unlocked(store, value.get('date'))
    latest = max([doc['date'], credit['date']] + [s['date'] for s in store['settlements'] + store['revaluations'] if s['documentId'] in {doc['id'], credit['id']}])
    if entry_date < latest:
        raise ValueError('Apply credits after the latest document, payment or revaluation date')
    amount = money(value.get('amount'))
    if amount <= 0 or any(amount > outstanding(store, d) for d in (doc, credit)):
        raise ValueError('Credit allocation must be positive and within both outstanding balances')
    rows, settlements = [], []
    allocation_id = uid()
    control = store['settings']['defaultReceivableAccount'] if expected == 'invoice' else store['settings']['defaultPayableAccount']
    for item, sign in ((doc, -1), (credit, 1)):
        carry = money(dec(carrying_value(store, item)) * dec(amount) / dec(outstanding(store, item)))
        rows.append(line(control, dec(carry) * sign * (1 if expected == 'invoice' else -1)))
        settlements.append(dict(id=uid(), documentId=item['id'], date=entry_date, amount=amount,
                                carryingAmount=carry, baseAmount=0, currency=item['currency'],
                                allocationId=allocation_id, creditId=credit['id'], allocatedDocumentId=doc['id'],
                                reference='Credit applied: ' + credit['number'], createdBy=actor, createdAt=now()))
    net = money(sum(dec(r['debit']) - dec(r['credit']) for r in rows))
    journal_id = ''
    if net:
        rows.append(line('4200' if net > 0 else '6960', -dec(net)))
        journal_id = post_journal(store, actor, 'Credit allocation', entry_date, rows, 'credit:' + allocation_id)['id']
    for settlement in settlements:
        settlement['journalId'] = journal_id
        store['settlements'].append(settlement)
    audit(store, actor, 'credit.applied', credit['id'], after=settlements)
    return settlements


def reverse_credit(store, value, actor, role):
    allow(role, 'post')
    original = find(store, 'settlements', value.get('id'))
    allocation_id = original.get('allocationId')
    if not allocation_id or original.get('reversalOf') or original.get('reversedById') or original['amount'] <= 0:
        raise ValueError('Choose an unreversed credit allocation recorded in this workspace')
    pair = [s for s in store['settlements'] if s.get('allocationId') == allocation_id and not s.get('reversalOf')]
    if len(pair) != 2 or any(s.get('reversedById') for s in pair):
        raise ValueError('The paired credit allocation is unavailable or already reversed')
    entry_date = unlocked(store, value.get('date'))
    reason = required(value.get('reason'), 'Credit reversal reason', 1000)
    document_ids = {s['documentId'] for s in pair}
    latest = max(r['date'] for r in store['settlements'] + store['revaluations'] if r['documentId'] in document_ids)
    if entry_date < latest:
        raise ValueError('Reverse after the latest document payment, credit allocation or revaluation date')
    journal_id = ''
    original_journal_id = original.get('journalId')
    if original_journal_id:
        journal = find(store, 'journals', original_journal_id)
        if journal.get('reversedJournalId'):
            raise ValueError('This credit allocation journal is already reversed')
        reversal = post_journal(store, actor, 'Credit allocation reversal · ' + journal['number'], entry_date,
                                [line(r['accountCode'], dec(r['credit']) - dec(r['debit'])) for r in journal['lines']],
                                'credit-reversal:' + allocation_id, reversalOf=journal['id'], reference=reason)
        journal_id = reversal['id']
        journal['reversedJournalId'] = journal_id
        unmatch_journal_bank_lines(store, journal['id'])
    reversals = []
    for settlement in pair:
        reversal = dict(settlement, id=uid(), date=entry_date, amount=-settlement['amount'],
                        carryingAmount=-settlement['carryingAmount'], baseAmount=-settlement['baseAmount'],
                        journalId=journal_id, reversalOf=settlement['id'],
                        reference='Credit allocation reversed: ' + reason, createdBy=actor, createdAt=now())
        settlement['reversedById'] = reversal['id']
        store['settlements'].append(reversal)
        reversals.append(reversal)
    audit(store, actor, 'credit.reversed', allocation_id, after=reversals)
    return reversals


def save_rate(store, value, actor):
    currency, rate = fx_rate(value.get('currency'), value.get('rate'))
    entry_date = day(value.get('date'))
    if any(r['currency'] == currency and r['date'] == entry_date for r in store['exchangeRates']):
        raise ValueError('A closing rate already exists for this currency and date')
    record = dict(id=uid(), currency=currency, rate=rate, date=entry_date,
                  source=required(value.get('source'), 'Rate source'))
    store['exchangeRates'].append(record)
    audit(store, actor, 'rate.saved', record['id'], after=record)
    return record


def closing_rate(store, currency, as_at):
    if currency == 'SGD':
        return 1.0
    rates = [r for r in store['exchangeRates'] if r['currency'] == currency and r['date'] <= as_at]
    return max(rates, key=lambda r: r['date'])['rate'] if rates else None


def revalue(store, value, actor, role):
    allow(role, 'post')
    entry_date = unlocked(store, value.get('date'))
    result = []
    for doc in store['documents']:
        if doc['kind'] not in OPEN_ITEMS or doc['status'] != 'posted' or doc['currency'] == 'SGD' or doc['date'] > entry_date:
            continue
        balance = outstanding(store, doc, entry_date)
        if not balance:
            continue
        if any(r['documentId'] == doc['id'] and r['date'] > entry_date for r in store['settlements'] + store['revaluations']):
            raise ValueError('Cannot revalue before a later settlement or revaluation')
        rate = closing_rate(store, doc['currency'], entry_date)
        if rate is None:
            raise ValueError('Add a closing rate for ' + doc['currency'])
        adjustment = money(dec(balance) * dec(rate) - dec(carrying_value(store, doc, entry_date)))
        if not adjustment:
            continue
        receivable = doc['kind'] in {'invoice', 'credit_note'}
        effect = dec(adjustment) * (1 if receivable else -1) * (-1 if doc['kind'] in CREDITS else 1)
        code = store['settings']['defaultReceivableAccount'] if receivable else store['settings']['defaultPayableAccount']
        record = dict(id=uid(), documentId=doc['id'], date=entry_date, adjustment=adjustment, rate=rate)
        journal = post_journal(store, actor, 'FX revaluation · ' + doc['number'], entry_date,
                               [line(code, effect), line('4200' if effect > 0 else '6960', -effect)],
                               'revaluation:' + record['id'], documentId=doc['id'])
        record['journalId'] = journal['id']
        store['revaluations'].append(record)
        result.append(record)
    audit(store, actor, 'fx.revalued', entry_date, after=result)
    return result


def register_asset(store, value, actor):
    cost, residual = money(value.get('cost')), money(value.get('residualValue'))
    months = dec(value.get('usefulLifeMonths'))
    if cost <= 0 or not 0 <= residual < cost or months != int(months) or not 1 <= months <= 1200:
        raise ValueError('Enter cost, residual value below cost, and a useful life of 1–1200 whole months')
    start = unlocked(store, value.get('inServiceDate'))
    journal_id = required(value.get('acquisitionJournalId'), 'Acquisition journal')
    journal = find(store, 'journals', journal_id)
    asset_account = account(store, value.get('assetAccount') or '1500', ['asset'])
    available = money(sum(dec(l['debit']) - dec(l['credit']) for l in journal['lines'] if l['accountCode'] == asset_account))
    allocated = sum(dec(a['cost']) for a in store['fixedAssets'] if a['acquisitionJournalId'] == journal_id and a['assetAccount'] == asset_account)
    if journal['status'] != 'posted' or journal.get('reversedJournalId') or journal['date'] > start or dec(cost) + allocated > dec(available):
        raise ValueError('Asset cost must be covered by an unallocated posted acquisition debit dated on or before service')
    record = dict(id=uid(), name=required(value.get('name'), 'Asset name'), cost=cost,
                  residualValue=residual, usefulLifeMonths=int(months), inServiceDate=start,
                  acquisitionJournalId=journal_id, assetAccount=asset_account,
                  depreciationAccount=account(store, value.get('depreciationAccount') or '6950', ['expense']),
                  accumulatedAccount=account(store, value.get('accumulatedAccount') or '1590', ['asset']),
                  method='straight-line', createdBy=actor, createdAt=now(), depreciation=[])
    store['fixedAssets'].append(record)
    audit(store, actor, 'asset.registered', record['id'], after=record)
    return record


def depreciation_target(asset, as_at):
    end, start = date.fromisoformat(as_at), date.fromisoformat(asset['inServiceDate'])
    # Monthly convention: one full charge at each month end, including service month.
    months = (end.year - start.year) * 12 + end.month - start.month + (1 if end.day == calendar.monthrange(end.year, end.month)[1] else 0)
    months = max(0, min(months, asset['usefulLifeMonths']))
    return money((dec(asset['cost']) - dec(asset['residualValue'])) * dec(months) / dec(asset['usefulLifeMonths']))


def depreciate(store, value, actor, role):
    allow(role, 'post')
    entry_date = unlocked(store, value.get('date'))
    result = []
    for asset in store['fixedAssets']:
        if any(r['date'] > entry_date for r in asset['depreciation']):
            raise ValueError('Depreciation must be run in date order')
        posted = sum(dec(r['amount']) for r in asset['depreciation'])
        amount = money(dec(depreciation_target(asset, entry_date)) - posted)
        if amount <= 0:
            continue
        journal = post_journal(store, actor, 'Depreciation · ' + asset['name'], entry_date,
                               [line(asset['depreciationAccount'], amount), line(asset['accumulatedAccount'], -dec(amount))],
                               f'depreciation:{asset["id"]}:{entry_date}')
        record = dict(date=entry_date, amount=amount, journalId=journal['id'])
        asset['depreciation'].append(record)
        result.append(record)
    audit(store, actor, 'depreciation.posted', entry_date, after=result)
    return result


def stock_position(store, item_id, as_at='9999-12-31'):
    moves = [m for m in store['stockMoves'] if m['itemId'] == item_id and m['date'] <= as_at]
    qty = sum(dec(m['quantity']) for m in moves)
    value = sum(dec(m['value']) * (1 if m['quantity'] > 0 else -1) for m in moves)
    return float(qty), money(value)


def stock_move(store, actor, value, post=True, source=''):
    if not store['settings']['inventoryEnabled']:
        raise ValueError('Enable trading inventory in accounting settings first')
    item = find(store, 'stockItems', value.get('itemId'))
    entry_date = unlocked(store, value.get('date'))
    if any(m['itemId'] == item['id'] and m['date'] > entry_date for m in store['stockMoves']):
        raise ValueError('Stock movements must be recorded in date order')
    qty = dec(value.get('quantity'))
    if not qty:
        raise ValueError('Quantity must be non-zero')
    current_qty, current_value = stock_position(store, item['id'])
    if dec(current_qty) + qty < 0:
        raise ValueError('Insufficient stock for ' + item['name'])
    if qty < 0:
        cost = dec(current_value) if -qty == dec(current_qty) else -qty * dec(current_value) / dec(current_qty)
    else:
        cost = qty * dec(value.get('unitCost'))
        if cost <= 0:
            raise ValueError('Enter a positive unit cost for stock received')
    record = dict(id=uid(), itemId=item['id'], date=entry_date, quantity=float(qty), value=money(cost),
                  reference=required(value.get('reference'), 'Stock movement reference'), source=source)
    if post:
        offset = account(store, value.get('offsetAccount') or '5000', ['expense', 'equity'])
        amount = dec(record['value']) * (1 if qty > 0 else -1)
        record['journalId'] = post_journal(store, actor, 'Stock adjustment · ' + item['name'], entry_date,
                                          [line('1400', amount), line(offset, -amount)], 'stock:' + record['id'])['id']
    store['stockMoves'].append(record)
    audit(store, actor, 'stock.moved', record['id'], after=record)
    return record


def next_month(value, increment=1):
    d = date.fromisoformat(value)
    month_index = d.year * 12 + d.month - 1 + increment
    year, month = month_index // 12, month_index % 12 + 1
    return date(year, month, min(d.day, calendar.monthrange(year, month)[1])).isoformat()


def run_recurring(store, value, actor):
    through = day(value.get('date'))
    result = []
    for template in store['recurring']:
        if not template['active']:
            continue
        count = 0
        while template['nextDate'] <= through:
            count += 1
            if count > 60:
                raise ValueError('Generate no more than 60 occurrences per template at once')
            source = find(store, 'documents', template['documentId'])
            due_days = (date.fromisoformat(source['dueDate']) - date.fromisoformat(source['date'])).days
            from datetime import timedelta
            due = (date.fromisoformat(template['nextDate']) + timedelta(days=max(0, due_days))).isoformat()
            generated = save_document(store, {**source, 'number': '', 'date': template['nextDate'], 'dueDate': due}, actor)
            generated['recurringId'] = template['id']
            result.append(generated['id'])
            # Keep the original day anchor across February and shorter months.
            template['occurrences'] = template.get('occurrences', 0) + 1
            template['nextDate'] = next_month(template['startDate'], template['intervalMonths'] * template['occurrences'])
    audit(store, actor, 'recurring.generated', through, after=result)
    return result


def workspace_payload(store, actor, owner=False, role=None):
    from services.accounting_reports import CATALOG
    role = role_for(store, actor, owner) if role is None else role
    documents = [dict(d, outstanding=outstanding(store, d), carryingValue=carrying_value(store, d))
                 for d in store['documents']]
    stock = [dict(i, quantity=stock_position(store, i['id'])[0], value=stock_position(store, i['id'])[1])
             for i in store['stockItems']]
    return dict(documents=documents, settlements=store['settlements'], fixedAssets=store['fixedAssets'],
                stockItems=stock, stockMoves=store['stockMoves'], recurring=store['recurring'],
                tasks=store['tasks'], attachments=store['attachments'], exchangeRates=store['exchangeRates'],
                revaluations=store['revaluations'], contacts=store['contacts'], filings=store['filings'],
                bankReconciliations=store['bankReconciliations'],
                reportPacks=[{k: v for k, v in r.items() if k not in {'reports', 'sourceSnapshot'}} for r in store['reportPacks']],
                auditTrail=list(reversed(store['auditTrail'][-300:])),
                role=role, permissions=sorted(ROLES.get(role, set())),
                reportCatalog=[dict(id=r[0], name=r[1], group=r[2], description=r[3]) for r in CATALOG],
                invoiceNow=dict(status='not_connected', provider=store['settings']['invoiceNowProvider'],
                                peppolId=store['settings']['peppolId']))


def adopt_legacy_sources(store, sources, actor):
    """Link existing posted source journals to open documents without re-posting."""
    sources_by_key = {s['key']: s for s in sources}
    count = 0
    settings = store['settings']
    for journal in store['journals']:
        source = sources_by_key.get(journal.get('sourceKey'))
        if not source or source['kind'] == 'sales-payment' or journal.get('documentId') or journal.get('reversedJournalId') or journal['status'] != 'posted':
            continue
        control = settings['defaultReceivableAccount'] if source['kind'] == 'sales-invoice' else settings['defaultPayableAccount']
        control_lines = [l for l in journal['lines'] if l['accountCode'] == control]
        if not control_lines:
            continue
        gross = money(abs(sum(dec(l['debit']) - dec(l['credit']) for l in control_lines)))
        if gross <= 0:
            continue
        is_sale = source['kind'] == 'sales-invoice'
        lines = [l for l in journal['lines'] if l['accountCode'] not in {control, '1200', '2100'}]
        normal = []
        for raw in lines:
            net = money(abs(dec(raw['debit']) - dec(raw['credit'])))
            normal.append(dict(id=uid(), description=raw.get('description') or source['description'],
                               quantity=1, unitPrice=net, net=net, tax=abs(money(raw.get('gstAmount'))),
                               taxCode=raw.get('taxCode', 'OP'), accountCode=raw['accountCode'], stockItemId=''))
        record_id = uid()
        number = str(source['number'])
        if any(d['number'] == number for d in store['documents']):
            number += ' · app source ' + str(len(store['documents']) + 1)
        record = dict(id=record_id, kind='invoice' if is_sale else 'bill', number=number,
                      date=journal['date'], dueDate=source.get('dueDate') or journal['date'],
                      contact=source.get('contact') or 'Unspecified contact', currency='SGD', exchangeRate=1,
                      lines=normal, net=money(sum(dec(l['net']) for l in normal)),
                      tax=money(sum(dec(l['tax']) for l in normal)), total=gross, baseTotal=gross,
                      bankAccount=settings['defaultBankAccount'], reference=source['number'],
                      notes='Linked from existing app document; acquisition already posted.', status='posted',
                      createdAt=journal.get('createdAt', now()), createdBy=journal.get('createdBy', actor),
                      updatedAt=now(), updatedBy=actor, version=1, convertedFrom='',
                      legacySourceKey=source['key'], journalId=journal['id'])
        record['partySnapshot'] = snapshot_document_parties(store, record)
        record['partySnapshot']['capturedAtAdoption'] = True
        journal['documentId'] = record_id
        store['documents'].append(record)
        audit(store, actor, 'source.linked', record_id, after=record)
        count += 1
    for journal in store['journals']:
        source = sources_by_key.get(journal.get('sourceKey'))
        if not source or source['kind'] != 'sales-payment' or journal.get('documentId') or journal.get('reversedJournalId') or journal['status'] != 'posted':
            continue
        invoice_key = source['key'].replace('sales-payment:', 'sales-invoice:', 1)
        doc = next((d for d in store['documents'] if d.get('legacySourceKey') == invoice_key), None)
        if not doc:
            continue
        amount = money(sum(dec(l['credit']) - dec(l['debit']) for l in journal['lines'] if l['accountCode'] == settings['defaultReceivableAccount']))
        if not 0 < amount <= outstanding(store, doc):
            raise ValueError('Existing payment overlaps an allocated receipt for ' + doc['number'])
        settlement = dict(id=uid(), documentId=doc['id'], date=journal['date'], amount=amount,
                          carryingAmount=amount, baseAmount=amount, currency='SGD', exchangeRate=1,
                          bankAccount=settings['defaultBankAccount'], journalId=journal['id'],
                          reference=source['number'], createdBy=actor, createdAt=now())
        store['settlements'].append(settlement)
        journal['documentId'] = doc['id']
        audit(store, actor, 'source.payment-linked', doc['id'], after=settlement)
    return count


def command(store, name, value, actor, role, users):
    allow(role, 'write')
    if name in {'pack-create', 'filing-save', 'filing-review', 'filing-file', 'filing-not-required'}:
        from services.accounting_close import command as close_command
        return close_command(store, name, value, actor, role, users)
    if name == 'payments':
        return settle_batch(store, value, actor, role)
    if name == 'reverse-cash':
        allow(role, 'post')
        doc = find(store, 'documents', value.get('id'))
        if doc['kind'] not in {'expense', 'receive_money'} or doc['status'] != 'posted' or doc.get('reversedJournalId'):
            raise ValueError('Choose an unreversed direct expense or receive-money transaction')
        entry_date = unlocked(store, value.get('date'))
        if entry_date < doc['date']:
            raise ValueError('Reversal date cannot precede the original transaction')
        reason = required(value.get('reason'), 'Correction reason', 1000)
        original = find(store, 'journals', doc['journalId'])
        if any(asset['acquisitionJournalId'] == original['id'] for asset in store['fixedAssets']):
            raise ValueError('This acquisition is linked to the fixed asset register. Review the asset correction before reversing its cost.')
        rows = [line(r['accountCode'], dec(r['credit']) - dec(r['debit']),
                     taxCode=r.get('taxCode', 'OP'), taxBase=-money(r.get('taxBase')),
                     gstAmount=-money(r.get('gstAmount')), description=reason, contact=doc['contact']) for r in original['lines']]
        journal = post_journal(store, actor, 'Direct cash correction · ' + doc['number'], entry_date, rows,
                               'cash-reversal:' + doc['id'], documentId=doc['id'], reversalOf=original['id'])
        before = copy.deepcopy(doc)
        doc.update(status='reversed', reversedJournalId=journal['id'], reversedAt=now(), reversedBy=actor)
        doc['version'] += 1
        original['reversedJournalId'] = journal['id']
        unmatch_journal_bank_lines(store, original['id'])
        audit(store, actor, 'cash-document.reversed', doc['id'], before, doc)
        return doc
    if name == 'reverse-payment':
        allow(role, 'post')
        payment = find(store, 'settlements', value.get('id'))
        if not payment.get('requestId') or payment.get('reversedById') or payment['amount'] <= 0:
            raise ValueError('Choose an unreversed payment recorded in this workspace')
        entry_date = unlocked(store, value.get('date'))
        if entry_date < payment['date']:
            raise ValueError('Reversal date cannot precede the original payment')
        latest = max(r['date'] for r in store['settlements'] + store['revaluations'] if r['documentId'] == payment['documentId'])
        if entry_date < latest:
            raise ValueError('Reverse after the latest payment or revaluation date')
        original = find(store, 'journals', payment['journalId'])
        journal = post_journal(store, actor, 'Payment reversal · ' + original['number'], entry_date,
                               [line(r['accountCode'], dec(r['credit']) - dec(r['debit'])) for r in original['lines']],
                               'payment-reversal:' + payment['id'], documentId=payment['documentId'], reversalOf=original['id'])
        reversal = dict(payment, id=uid(), date=entry_date, amount=-payment['amount'],
                        carryingAmount=-payment['carryingAmount'], baseAmount=-payment['baseAmount'],
                        journalId=journal['id'], reversalOf=payment['id'], reference='Reversal: ' + payment.get('reference', ''),
                        createdBy=actor, createdAt=now())
        payment['reversedById'] = reversal['id']
        original['reversedJournalId'] = journal['id']
        store['settlements'].append(reversal)
        unmatch_journal_bank_lines(store, original['id'])
        audit(store, actor, 'payment.reversed', payment['id'], after=reversal)
        return reversal
    if name == 'apply-credit':
        return apply_credit(store, value, actor, role)
    if name == 'reverse-credit':
        return reverse_credit(store, value, actor, role)
    if name == 'rates':
        return save_rate(store, value, actor)
    if name == 'revalue':
        return revalue(store, value, actor, role)
    if name == 'fixed-assets':
        return register_asset(store, value, actor)
    if name == 'depreciate':
        return depreciate(store, value, actor, role)
    if name == 'stock-move':
        allow(role, 'post')
        return stock_move(store, actor, value)
    if name == 'stock-items':
        sku = required(value.get('sku'), 'SKU', 80)
        if any(i['sku'].casefold() == sku.casefold() for i in store['stockItems']):
            raise ValueError('This SKU already exists')
        record = dict(id=uid(), sku=sku, name=required(value.get('name'), 'Stock item name'),
                      uom=str(value.get('uom') or 'unit')[:40])
        store['stockItems'].append(record)
    elif name == 'recurring':
        source = find(store, 'documents', value.get('documentId'))
        if source['kind'] in CREDITS or source['status'] == 'void':
            raise ValueError('Choose an invoice, bill, expense, receipt, quote or purchase order template')
        interval = int(dec(value.get('intervalMonths', 1)))
        if interval not in {1, 3, 6, 12}:
            raise ValueError('Choose monthly, quarterly, half-yearly or yearly')
        record = dict(id=uid(), name=required(value.get('name'), 'Schedule name'), documentId=source['id'],
                      nextDate=day(value.get('nextDate')), startDate=day(value.get('nextDate')),
                      intervalMonths=interval, active=True, occurrences=0)
        store['recurring'].append(record)
    elif name == 'recurring-toggle':
        record = find(store, 'recurring', value.get('id'))
        record['active'] = not record['active']
    elif name == 'run-recurring':
        return run_recurring(store, value, actor)
    elif name == 'tasks':
        assigned = str(value.get('assignedTo') or actor)
        if assigned not in users:
            raise ValueError('Choose an active company user')
        record = dict(id=uid(), title=required(value.get('title'), 'Task title'),
                      dueDate=day(value.get('dueDate')), assignedTo=assigned, status='open',
                      createdBy=actor, createdAt=now())
        store['tasks'].append(record)
    elif name == 'task-toggle':
        record = find(store, 'tasks', value.get('id'))
        record['status'] = 'complete' if record['status'] != 'complete' else 'open'
    elif name == 'contacts':
        existing = find(store, 'contacts', value['id']) if value.get('id') else None
        contact_name = required(value.get('name'), 'Contact name')
        if existing and existing['name'] != contact_name and any(d['contact'] == existing['name'] for d in store['documents']):
            raise ValueError('This contact has transactions. Keep its name and update its contact details.')
        record = dict(id=existing['id'] if existing else uid(), name=contact_name,
                      kind=value.get('kind') if value.get('kind') in {'customer', 'supplier', 'both'} else 'both',
                      email=str(value.get('email') or '')[:250], uen=str(value.get('uen') or '')[:50],
                      peppolId=str(value.get('peppolId') or '')[:100], address=str(value.get('address') or '')[:500])
        if any(c['id'] != record['id'] and c['name'].casefold() == record['name'].casefold() for c in store['contacts']):
            raise ValueError('This contact already exists')
        if existing:
            audit(store, actor, 'contact.updated', record['id'], existing, record)
            existing.update(record)
            return record
        store['contacts'].append(record)
    elif name == 'controls':
        allow(role, 'settings')
        before = copy.deepcopy(store['settings'])
        roles = value.get('roles', before.get('roles', {}))
        if not isinstance(roles, dict) or any(user not in users or role_name not in ROLES for user, role_name in roles.items()):
            raise ValueError('Assign valid accounting roles to active company users')
        framework = value.get('reportingFramework', before.get('reportingFramework'))
        if framework not in {'FRS', 'SFRS(I)', 'SFRS for Small Entities'}:
            raise ValueError('Choose a reporting framework')
        cash_accounts = value.get('cashAccounts', before['cashAccounts'])
        if not isinstance(cash_accounts, list) or not cash_accounts:
            raise ValueError('Select at least one cash account')
        for code in cash_accounts:
            account(store, code, ['asset'])
        mappings = value.get('cashFlowMappings', before.get('cashFlowMappings', {}))
        if not isinstance(mappings, dict) or any(v not in {'operating', 'investing', 'financing'} for v in mappings.values()):
            raise ValueError('Choose a valid cash flow classification')
        for code in mappings:
            account(store, code)
        gst_revenue = value.get('gstRevenueAccounts', before['gstRevenueAccounts'])
        if not isinstance(gst_revenue, list):
            raise ValueError('Select the operating revenue accounts for GST Box 13')
        for code in gst_revenue:
            if not any(a['code'] == code and a['type'] == 'revenue' for a in store['accounts']):
                raise ValueError('Choose revenue accounts for GST Box 13')
        store['settings']['gstRevenueAccounts'] = list(dict.fromkeys(gst_revenue))
        store['settings'].update(roles=roles, reportingFramework=framework, cashAccounts=cash_accounts, cashFlowMappings=mappings)
        for key in ('inventoryEnabled', 'approvalRequired'):
            if key in value:
                store['settings'][key] = value[key] is True
        for key in ('uen', 'peppolId', 'invoiceNowProvider', 'businessName', 'businessAddress'):
            if key in value:
                store['settings'][key] = str(value[key] or '')[:200]
        audit(store, actor, 'controls.updated', 'settings', before, store['settings'])
        return store['settings']
    elif name == 'bank-match-existing':
        allow(role, 'post')
        bank = find(store, 'bankTransactions', value.get('bankTransactionId'))
        journal_ids = value.get('journalIds', [value.get('journalId')])
        if not isinstance(journal_ids, list) or not 1 <= len(journal_ids) <= 200 or any(not isinstance(j, str) or not j for j in journal_ids):
            raise ValueError('Select between 1 and 200 posted cash journals')
        if len(set(journal_ids)) != len(journal_ids):
            raise ValueError('Select each cash journal only once')
        journals = [find(store, 'journals', journal_id) for journal_id in journal_ids]
        unlocked(store, bank['date'])
        if bank['status'] == 'matched' or any(j['status'] != 'posted' or j.get('reversedJournalId') for j in journals):
            raise ValueError('Choose an unmatched statement line and an unreversed posted journal')
        if any(set(journal_ids) & matched_journal_ids(b) and b['bankAccount'] == bank['bankAccount']
               for b in store['bankTransactions'] if b['status'] == 'matched'):
            raise ValueError('This cash journal is already matched')
        movements = [money(sum(dec(r['debit']) - dec(r['credit']) for r in journal['lines']
                              if r['accountCode'] == bank['bankAccount'])) for journal in journals]
        if any(not amount for amount in movements):
            raise ValueError('Every selected journal must have a cash movement in this bank account')
        amount = money(sum(dec(movement) for movement in movements))
        if amount != money(bank['amount']):
            raise ValueError('Statement amount must equal the selected journal movements for this bank account')
        bank.update(status='matched', journalId=journal_ids[0], journalIds=list(journal_ids), matchedAt=now(), matchedBy=actor)
        record = bank
    elif name == 'bank-closing':
        record = dict(id=uid(), bankAccount=account(store, value.get('bankAccount'), ['asset']),
                      date=day(value.get('date')), closingBalance=money(value.get('closingBalance')),
                      createdBy=actor, createdAt=now(), reference=required(value.get('reference'), 'Statement reference'))
        store['bankReconciliations'].append(record)
    else:
        raise ValueError('Unknown accounting action')
    audit(store, actor, name, record['id'], after=record)
    return record
