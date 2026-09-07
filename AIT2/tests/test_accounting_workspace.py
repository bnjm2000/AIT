import io
import copy
import re
import unittest

import app as app_module
from tests import test_finance as finance_tests


class AccountingWorkspaceTests(unittest.TestCase):
    setUp = finance_tests.FinanceFeatureTests.setUp
    tearDown = finance_tests.FinanceFeatureTests.tearDown
    make_user = finance_tests.FinanceFeatureTests.make_user
    login = finance_tests.FinanceFeatureTests.login
    create_quote = finance_tests.FinanceFeatureTests.create_quote

    def request(self, path, value, method='post', expected=200):
        response = getattr(self.client, method)('/api/finance/accounting/' + path, json=value)
        self.assertEqual(response.status_code, expected, response.get_data(as_text=True))
        return response.get_json()

    def begin(self):
        self.login('sales-admin')

    def document(self, kind='invoice', amount=100, **extra):
        data = dict(kind=kind, date='2026-01-15', dueDate='2026-02-15', contact='Example Pte Ltd',
                    currency='SGD', exchangeRate=1, lines=[dict(description='Services', quantity=1,
                    unitPrice=amount, accountCode='4000' if kind in {'quote', 'invoice', 'credit_note', 'receive_money'} else '6800', taxCode='OP')])
        data.update(extra)
        return self.request('documents', data)['record']

    def post_document(self, doc):
        return self.request(f'documents/{doc["id"]}/post', {})['record']

    def workspace(self):
        response = self.client.get('/api/finance/accounting?from=2026-01-01&to=2026-12-31')
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        return response.get_json()['data']

    def report(self, name, query=''):
        response = self.client.get(f'/api/finance/accounting/reports/{name}?from=2026-01-01&to=2026-12-31{query}')
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        return response.get_json()['report']

    def test_document_conversion_posting_and_duplicate_guards(self):
        self.begin()
        quote = self.post_document(self.document('quote'))
        self.assertEqual(quote['status'], 'approved')
        self.assertEqual(len(self.workspace()['journals']), 0)
        converted = self.request(f'documents/{quote["id"]}/convert', {})['record']
        self.request(f'documents/{quote["id"]}/convert', {}, expected=400)
        invoice = next(d for d in self.workspace()['workspace']['documents'] if d['id'] == converted['convertedTo'])
        posted = self.post_document(invoice)
        self.assertEqual(posted['status'], 'posted')
        self.request(f'documents/{invoice["id"]}/post', {}, expected=400)
        self.request(f'documents/{invoice["id"]}', invoice, method='put', expected=400)
        self.assertEqual(len(self.workspace()['journals']), 1)

    def test_balance_sheet_includes_prior_earnings_and_compares_periods(self):
        self.begin()
        self.post_document(self.document(date='2025-12-31', dueDate='2026-01-31'))
        self.post_document(self.document(amount=50, date='2026-01-15'))
        data = self.workspace()
        self.assertEqual(sum(r['amount'] for r in data['balanceSheet']['assets']), 150)
        self.assertEqual(sum(r['amount'] for r in data['balanceSheet']['equity']), 150)
        report = self.report('balance-sheet', '&groupBy=monthly&compare=custom&compareFrom=2025-12-01&compareTo=2025-12-31')
        check = next(r for r in report['rows'] if r['key'] == 'check')
        self.assertEqual(check['amount'], 0)
        ar = next(r for r in report['rows'] if r['key'] == '1100')
        self.assertEqual(ar['period0'], 150)
        self.assertEqual(ar['comparison'], 100)
        self.assertEqual(ar['variance'], 50)
        self.assertEqual(ar['amount'], 150)
        self.assertEqual([c['key'] for c in report['columns']][-3:], ['amount', 'comparison', 'variance'])
        self.assertEqual(report['columns'][-3]['label'], 'Closing balance SGD')
        self.assertTrue(ar['cellRefs']['comparison']['journalIds'])

    def test_partial_foreign_payments_revaluation_and_historical_aging(self):
        self.begin()
        doc = self.post_document(self.document(amount=200, currency='USD', exchangeRate=1.3))
        self.request('actions/payments', dict(date='2026-02-20', requestId='batch-1',
                     allocations=[dict(documentId=doc['id'], amount=100, exchangeRate=1.4)]))
        before = self.client.get('/api/finance/accounting/reports/ar-aging?from=2026-01-01&to=2026-01-31').get_json()['report']
        self.assertEqual(before['rows'][0]['outstanding'], 200)
        self.request('actions/rates', dict(currency='USD', rate=1.5, date='2026-02-28', source='Treasury closing rate'))
        self.request('actions/revalue', dict(date='2026-02-28'))
        journal_count = len(self.workspace()['journals'])
        self.request('actions/revalue', dict(date='2026-02-28'))
        self.assertEqual(len(self.workspace()['journals']), journal_count)
        aged = self.report('ar-aging')['rows'][0]
        self.assertEqual(aged['carrying'], 150)
        self.assertEqual(aged['fx'], 0)
        self.request('actions/payments', dict(date='2026-03-05', requestId='batch-2',
                     allocations=[dict(documentId=doc['id'], amount=100, exchangeRate=1.4)]))
        data = self.workspace()
        self.assertEqual(data['summary']['receivables'], 0)
        self.assertEqual(data['summary']['cash'], 280)
        self.assertEqual([r for r in self.report('ar-aging')['rows'] if not r.get('total')], [])

    def test_batch_is_atomic_and_cannot_overpay_or_repeat(self):
        self.begin()
        first = self.post_document(self.document())
        second = self.post_document(self.document())
        value = dict(date='2026-02-01', requestId='same-batch', allocations=[
            dict(documentId=first['id'], amount=50, exchangeRate=1),
            dict(documentId=second['id'], amount=101, exchangeRate=1)])
        self.request('actions/payments', value, expected=400)
        self.assertEqual(len(self.workspace()['workspace']['settlements']), 0)
        self.assertEqual(len(self.workspace()['journals']), 2)
        value['allocations'][1]['amount'] = 100
        self.request('actions/payments', value)
        self.request('actions/payments', value, expected=400)
        self.assertEqual(self.workspace()['summary']['receivables'], 50)

    def test_vendor_credit_application_and_customer_statement(self):
        self.begin()
        bill = self.post_document(self.document('bill', amount=100))
        credit = self.post_document(self.document('vendor_credit', amount=25))
        self.request('actions/apply-credit', dict(documentId=bill['id'], creditId=credit['id'], amount=25, date='2026-01-20'))
        self.assertEqual(self.report('ap-aging')['rows'][0]['outstanding'], 75)
        self.assertEqual(self.workspace()['summary']['payables'], 75)
        invoice = self.post_document(self.document())
        self.request('actions/payments', dict(date='2026-02-01', requestId='receipt', allocations=[dict(documentId=invoice['id'], amount=40, exchangeRate=1)]))
        statement = self.report('customer-statement', '&contact=Example%20Pte%20Ltd&currency=SGD')
        self.assertEqual(statement['rows'][-1]['balance'], 60)

    def test_company_admins_have_full_access_and_owner_is_read_only(self):
        self.begin()
        self.request('actions/controls', dict(roles={
            'alice': 'bookkeeper',
            'bob': 'accountant',
            'no-sales': 'auditor',
        }, approvalRequired=True))
        # Simulate a role left behind by an older release. It must not make the
        # platform owner writable or visible in Accounting access management.
        finance_data = app_module._load_finance_data()
        app_module._accounting_store(finance_data)['settings']['roles']['bnjm2000'] = 'manager'
        app_module._save_finance_data(finance_data)
        self.login('alice')
        self.assertEqual(self.client.get('/accounting').status_code, 302)
        self.assertEqual(self.client.get('/api/finance/accounting').status_code, 403)
        self.request('documents', {}, expected=403)
        self.login('manager-no-sales')
        self.assertEqual(self.client.get('/accounting').status_code, 302)
        self.assertEqual(self.client.get('/api/finance/accounting').status_code, 403)
        self.login('no-sales')
        self.assertEqual(self.client.get('/accounting').status_code, 302)
        self.assertEqual(self.client.get('/api/finance/accounting').status_code, 403)
        self.request('documents', {}, expected=403)
        self.login('bnjm2000')
        self.assertEqual(self.client.get('/accounting').status_code, 200)
        owner_workspace = self.workspace()
        self.assertEqual(owner_workspace['workspace']['role'], 'auditor')
        self.assertEqual(owner_workspace['workspace']['permissions'], ['read'])
        self.assertNotIn('bnjm2000', owner_workspace['accountingUsers'])
        self.assertNotIn('bnjm2000', owner_workspace['settings']['roles'])
        finance_before = copy.deepcopy(app_module._load_finance_data())
        for rule in app_module.app.url_map.iter_rules():
            if not rule.rule.startswith('/api/finance/accounting'):
                continue
            for method in sorted(rule.methods - {'GET', 'HEAD', 'OPTIONS'}):
                path = re.sub(r'<(?:[^:<>]+:)?[^<>]+>', 'blocked-id', rule.rule)
                with self.subTest(method=method, path=path):
                    response = self.client.open(path, method=method, json={})
                    self.assertEqual(
                        response.status_code, 403, response.get_data(as_text=True),
                    )
        self.assertEqual(app_module._load_finance_data(), finance_before)
        self.login('sales-admin')
        self.assertEqual(self.client.get('/accounting').status_code, 200)
        workspace = self.workspace()
        self.assertEqual(workspace['workspace']['role'], 'manager')
        self.assertEqual(set(workspace['workspace']['permissions']), {'read', 'write', 'post', 'approve', 'settings'})
        self.assertTrue(workspace['accountingUsers']['sales-admin']['hasAccountingAccess'])
        self.assertNotIn('bnjm2000', workspace['accountingUsers'])
        self.request('documents', dict(kind='invoice', date='2026-01-15', dueDate='2026-02-15',
                     contact='Admin Customer', currency='SGD', exchangeRate=1,
                     lines=[dict(description='Service', quantity=1, unitPrice=100,
                                 accountCode='4000', taxCode='OP')]))

    def test_fixed_asset_depreciation_posts_only_increment_and_has_cost_cover(self):
        self.begin()
        acquisition = self.post_document(self.document('expense', amount=1200, date='2026-01-01',
                    lines=[dict(description='Laptop', quantity=1, unitPrice=1200, accountCode='1500')]))
        asset = dict(name='Laptop', cost=1200, residualValue=0, usefulLifeMonths=12,
                     inServiceDate='2026-01-10', acquisitionJournalId=acquisition['journalId'])
        self.request('actions/fixed-assets', asset)
        self.request('actions/fixed-assets', asset, expected=400)
        self.request('actions/depreciate', dict(date='2026-01-31'))
        self.request('actions/depreciate', dict(date='2026-01-31'))
        self.assertEqual(len(self.workspace()['workspace']['fixedAssets'][0]['depreciation']), 1)
        self.request('actions/depreciate', dict(date='2026-03-31'))
        schedule = self.report('fixed-assets')['rows'][0]
        self.assertEqual(schedule['accumulated'], 300)
        self.assertEqual(schedule['nbv'], 900)

    def test_inventory_purchase_sale_weighted_average_and_insufficient_stock(self):
        self.begin()
        self.request('actions/controls', dict(inventoryEnabled=True))
        item = self.request('actions/stock-items', dict(sku='STK-1', name='Cable'))['record']
        self.post_document(self.document('bill', lines=[dict(description='Cable', quantity=10, unitPrice=20, stockItemId=item['id'])]))
        self.post_document(self.document('invoice', lines=[dict(description='Cable', quantity=3, unitPrice=40, stockItemId=item['id'])]))
        stock = self.workspace()['workspace']['stockItems'][0]
        self.assertEqual(stock['quantity'], 7)
        self.assertEqual(stock['value'], 140)
        invalid = self.document('invoice', lines=[dict(description='Cable', quantity=8, unitPrice=40, stockItemId=item['id'])])
        count = len(self.workspace()['journals'])
        self.request(f'documents/{invalid["id"]}/post', {}, expected=400)
        self.assertEqual(len(self.workspace()['journals']), count)
        self.assertEqual(self.workspace()['summary']['netProfit'], 60)

    def test_recurring_month_end_anchor_and_idempotence(self):
        self.begin()
        doc = self.document('bill')
        self.request('actions/recurring', dict(name='Rent', documentId=doc['id'], nextDate='2026-01-31', intervalMonths=1))
        self.request('actions/run-recurring', dict(date='2026-03-31'))
        self.request('actions/run-recurring', dict(date='2026-03-31'))
        generated = [d for d in self.workspace()['workspace']['documents'] if d.get('recurringId')]
        self.assertEqual([d['date'] for d in generated], ['2026-01-31', '2026-02-28', '2026-03-31'])
        self.assertEqual({d['status'] for d in generated}, {'draft'})

    def test_bank_match_links_existing_payment_without_double_posting(self):
        self.begin()
        doc = self.post_document(self.document())
        paid = self.request('actions/payments', dict(date='2026-02-01', requestId='bank-payment', allocations=[dict(documentId=doc['id'], amount=100, exchangeRate=1)]))['record'][0]
        bank = self.request('bank-transactions', dict(date='2026-02-01', description='Receipt', amount=100, bankAccount='1000', status='matched'), expected=201)['transaction']
        self.assertEqual(bank['status'], 'unmatched')
        self.request('actions/bank-match-existing', dict(bankTransactionId=bank['id'], journalId=paid['journalId']))
        self.assertEqual(len(self.workspace()['journals']), 2)
        self.request('actions/bank-closing', dict(date='2026-12-31', bankAccount='1000', closingBalance=100, reference='Year end bank statement'))
        report = self.report('bank-reconciliation')
        self.assertEqual(report['rows'][2]['amount'], 0)

    def test_attachments_audit_and_invalid_files(self):
        self.begin()
        doc = self.document()
        response = self.client.post(f'/api/finance/accounting/attachments/documents/{doc["id"]}',
                                   data={'file': (io.BytesIO(b'%PDF-test'), 'source.pdf')})
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        attachment = response.get_json()['record']
        downloaded = self.client.get('/api/finance/accounting/attachments/' + attachment['id'])
        self.assertEqual(downloaded.data, b'%PDF-test')
        downloaded.close()
        self.assertEqual(len(attachment['sha256']), 64)
        response = self.client.post(f'/api/finance/accounting/attachments/documents/{doc["id"]}',
                                   data={'file': (io.BytesIO(b'<script>'), 'source.html')})
        self.assertEqual(response.status_code, 400)
        self.assertIn('attachment.added', [a['action'] for a in self.workspace()['workspace']['auditTrail']])

    def test_all_reports_export_and_gst_special_boxes_not_assumed_zero(self):
        self.begin()
        self.request('settings', dict(gstRegistered=True, accountingBasis='accrual'), method='put')
        self.post_document(self.document(lines=[dict(description='Service', quantity=1, unitPrice=100, taxCode='SR9')]))
        for report in self.workspace()['workspace']['reportCatalog']:
            with self.subTest(report=report['id']):
                self.report(report['id'])
                response = self.client.get('/api/finance/accounting/reports/' + report['id'] + '?from=2026-01-01&to=2026-12-31&format=csv')
                self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        gst = self.report('gst')
        self.assertEqual(gst['rows'][0]['amount'], 100)
        self.assertEqual(gst['rows'][5]['amount'], 9)
        self.assertIsNone(gst['rows'][8]['amount'])

    def test_locked_periods_and_invalid_amounts_are_rejected(self):
        self.begin()
        self.request('settings', dict(periodLockDate='2026-01-31', accountingBasis='accrual'), method='put')
        response = self.client.post('/api/finance/accounting/documents', json=dict(kind='invoice', date='2026-01-10'))
        self.assertEqual(response.status_code, 400)
        self.request('journals', dict(date='2026-01-10', status='posted', _allowLocked=True, lines=[dict(accountCode='1000', debit=1), dict(accountCode='4000', credit=1)]), expected=400)
        self.request('actions/rates', dict(date='2026-02-01', currency='USD', rate='NaN', source='invalid'), expected=400)

    def test_payment_reversal_restores_balance_and_preserves_historical_report(self):
        self.begin()
        doc = self.post_document(self.document())
        paid = self.request('actions/payments', dict(date='2026-02-01', requestId='undo-me', allocations=[dict(documentId=doc['id'], amount=100, exchangeRate=1)]))['record'][0]
        self.request('actions/reverse-payment', dict(id=paid['id'], date='2026-03-01'))
        self.request('actions/reverse-payment', dict(id=paid['id'], date='2026-03-01'), expected=400)
        before = self.client.get('/api/finance/accounting/reports/ar-aging?from=2026-02-01&to=2026-02-28').get_json()['report']
        self.assertEqual([r for r in before['rows'] if not r.get('total')], [])
        self.assertEqual(self.report('ar-aging')['rows'][0]['outstanding'], 100)
        self.assertEqual(self.workspace()['summary']['cash'], 0)

    def test_existing_source_invoice_links_to_ar_without_reposting(self):
        self.begin()
        quote = self.create_quote('Source integration')
        quote['lineItems'] = [dict(id='legacy-line', department='Audio Department', description='Service', quantity=1, days=1, unitPrice=100, discountPercent=0, uom='lot')]
        quote = self.client.put('/api/quotations/' + quote['id'], json=quote).get_json()['data']
        invoice = self.client.post('/api/quotations/' + quote['id'] + '/convert-to-invoice').get_json()['data']
        self.request('sources/post', dict(sourceKey='sales-invoice:' + invoice['id']), expected=201)
        self.request('sources/link', {})
        self.request('sources/link', {})
        data = self.workspace()
        self.assertEqual(len(data['journals']), 1)
        self.assertEqual(len(data['workspace']['documents']), 1)
        self.assertEqual(data['workspace']['documents'][0]['outstanding'], invoice['totals']['total'])
        self.assertEqual(len([r for r in self.report('ar-aging')['rows'] if not r.get('total')]), 1)

    def test_customer_text_is_escaped_in_csv_and_drafts_reject_stale_save(self):
        self.begin()
        doc = self.document(contact='=HYPERLINK("https://example.invalid")')
        updated = self.request('documents/' + doc['id'], dict(doc, notes='First update'), method='put')['record']
        self.request('documents/' + doc['id'], dict(doc, notes='Stale update'), method='put', expected=400)
        self.post_document(updated)
        exported = self.client.get('/api/finance/accounting/reports/ar-aging?from=2026-01-01&to=2026-12-31&format=csv')
        self.assertIn("'=HYPERLINK", exported.get_data(as_text=True))

    def test_concurrent_accounting_commands_do_not_merge_stale_payment_lists(self):
        from finance_concurrency import FinanceMergeConflict
        base = {'accounting': {'settlements': []}}
        first, second = copy.deepcopy(base), copy.deepcopy(base)
        first['accounting']['settlements'].append({'id': 'a', 'amount': 100})
        second['accounting']['settlements'].append({'id': 'b', 'amount': 100})
        with self.assertRaises(FinanceMergeConflict):
            app_module._finance_merge_storage_payloads(base, first, second)
