"""Integrity checks for issued documents and asset acquisition corrections."""
import copy
import unittest

from services import accounting_workspace as books


class AccountingBookkeepingReviewTests(unittest.TestCase):
    def setUp(self):
        self.store = books.initialise({
            'settings': {
                'gstRegistered': True, 'gstRegistrationNumber': 'M200000001',
                'defaultBankAccount': '1000', 'defaultReceivableAccount': '1100',
                'defaultPayableAccount': '2000', 'businessName': 'Original Seller Pte Ltd',
                'businessAddress': '1 Original Road', 'uen': '202600001A',
            },
            'accounts': [dict(code=code, name=code, type=kind, active=True)
                         for code, kind in [('1000', 'asset'), ('1100', 'asset'),
                                            ('1200', 'asset'), ('1500', 'asset'),
                                            ('1590', 'asset'), ('2000', 'liability'),
                                            ('2100', 'liability'), ('4000', 'revenue'),
                                            ('6800', 'expense')]],
            'journals': [], 'bankTransactions': [],
            'contacts': [dict(id='customer', name='Customer Pte Ltd', address='2 Original Road')],
        })

    def document(self, kind='invoice', account='4000', amount=100):
        return books.save_document(self.store, dict(
            kind=kind, date='2026-01-15', dueDate='2026-02-15',
            contact='Customer Pte Ltd', currency='SGD', exchangeRate=1,
            lines=[dict(description='Services', quantity=1, unitPrice=amount,
                        accountCode=account, taxCode='OP')]), 'maker')

    def post(self, doc):
        return books.document_action(self.store, doc['id'], 'post', 'reviewer', 'manager')

    def test_issued_document_keeps_party_details_when_directory_changes(self):
        doc = self.document()
        self.assertNotIn('partySnapshot', doc)
        self.post(doc)
        issued = copy.deepcopy(doc['partySnapshot'])
        self.store['settings'].update(businessName='New Seller Name', businessAddress='9 New Road',
                                      gstRegistered=False, gstRegistrationNumber='')
        self.store['contacts'][0]['address'] = '10 New Road'
        self.assertEqual(doc['partySnapshot'], issued)
        self.assertEqual(issued['businessName'], 'Original Seller Pte Ltd')
        self.assertEqual(issued['contactAddress'], '2 Original Road')
        self.assertTrue(issued['gstRegistered'])
        self.assertEqual(issued['gstRegistrationNumber'], 'M200000001')

    def test_quote_conversion_captures_current_details_only_when_approved(self):
        quote = self.post(self.document('quote'))
        self.store['settings']['businessAddress'] = 'Updated Road'
        books.document_action(self.store, quote['id'], 'convert', 'maker', 'manager')
        invoice = books.find(self.store, 'documents', quote['convertedTo'])
        self.assertNotIn('partySnapshot', invoice)
        self.post(invoice)
        self.assertEqual(quote['partySnapshot']['businessAddress'], '1 Original Road')
        self.assertEqual(invoice['partySnapshot']['businessAddress'], 'Updated Road')

    def test_missing_directory_details_do_not_block_historical_posting(self):
        self.store['contacts'] = []
        self.store['settings'].update(businessName='', businessAddress='', uen='')
        doc = self.post(self.document())
        self.assertEqual(doc['status'], 'posted')
        self.assertEqual(doc['partySnapshot']['businessName'], '')
        self.assertEqual(doc['partySnapshot']['contactName'], 'Customer Pte Ltd')
        self.assertEqual(doc['partySnapshot']['contactAddress'], '')

    def test_reversing_registered_cash_acquisition_preserves_asset_cover(self):
        doc = self.post(self.document('expense', account='1500', amount=1200))
        books.register_asset(self.store, dict(name='Laptop', cost=1200, residualValue=0,
                              usefulLifeMonths=12, inServiceDate='2026-01-15',
                              acquisitionJournalId=doc['journalId']), 'maker')
        before = copy.deepcopy(self.store)
        with self.assertRaisesRegex(ValueError, 'fixed asset register'):
            books.command(self.store, 'reverse-cash', dict(id=doc['id'], date='2026-02-01',
                           reason='Incorrect acquisition'), 'reviewer', 'manager', {})
        self.assertEqual(self.store, before)

    def test_unregistered_cash_acquisition_can_still_be_corrected(self):
        doc = self.post(self.document('expense', account='1500', amount=1200))
        books.command(self.store, 'reverse-cash', dict(id=doc['id'], date='2026-02-01',
                       reason='Duplicate receipt'), 'reviewer', 'manager', {})
        self.assertEqual(doc['status'], 'reversed')
        self.assertEqual(len(self.store['journals']), 2)

    def test_batch_bank_match_covers_all_receipts_and_reversal_clears_group(self):
        invoices = [self.post(self.document(amount=amount)) for amount in [40, 60]]
        payments = books.settle_batch(self.store, dict(date='2026-02-01', requestId='batch',
                    allocations=[dict(documentId=d['id'], amount=d['total']) for d in invoices]),
                    'reviewer', 'manager')
        bank = dict(id='statement', date='2026-02-01', amount=100, bankAccount='1000', status='unmatched')
        self.store['bankTransactions'].append(bank)
        books.command(self.store, 'bank-match-existing', dict(bankTransactionId=bank['id'],
                      journalIds=[p['journalId'] for p in payments]), 'reviewer', 'manager', {})
        self.assertEqual(bank['status'], 'matched')
        self.assertEqual(books.matched_journal_ids(bank), {p['journalId'] for p in payments})
        second = dict(id='second', date='2026-02-01', amount=60, bankAccount='1000', status='unmatched')
        self.store['bankTransactions'].append(second)
        with self.assertRaisesRegex(ValueError, 'already matched'):
            books.command(self.store, 'bank-match-existing', dict(bankTransactionId='second',
                          journalId=payments[1]['journalId']), 'reviewer', 'manager', {})
        # The second entry is not the legacy journalId: its reversal must still unmatch the group.
        books.command(self.store, 'reverse-payment', dict(id=payments[1]['id'], date='2026-02-02'),
                      'reviewer', 'manager', {})
        self.assertEqual(bank['status'], 'unmatched')
        self.assertEqual(books.matched_journal_ids(bank), set())

    def test_bank_group_rejects_duplicates_and_unbalanced_selected_total(self):
        journal = self.post(self.document('receive_money', amount=40))['journalId']
        self.store['bankTransactions'].append(dict(id='bank', date='2026-02-01', amount=100,
                                                  bankAccount='1000', status='unmatched'))
        for journal_ids, error in [([journal, journal], 'only once'), ([journal], 'must equal')]:
            before = copy.deepcopy(self.store)
            with self.assertRaisesRegex(ValueError, error):
                books.command(self.store, 'bank-match-existing', dict(bankTransactionId='bank', journalIds=journal_ids),
                              'reviewer', 'manager', {})
            self.assertEqual(self.store, before)

    def test_credit_unapply_restores_both_items_and_preserves_historical_balances(self):
        invoice = self.post(self.document(amount=100))
        credit = self.post(self.document('credit_note', amount=40))
        allocated = books.apply_credit(self.store, dict(creditId=credit['id'], documentId=invoice['id'],
                         date='2026-02-01', amount=40), 'reviewer', 'manager')
        self.assertEqual(allocated[0]['allocationId'], allocated[1]['allocationId'])
        self.assertEqual(books.outstanding(self.store, invoice), 60)
        self.assertEqual(books.outstanding(self.store, credit), 0)
        reversals = books.command(self.store, 'reverse-credit', dict(id=allocated[0]['id'], date='2026-02-03',
                                 reason='Allocated to the wrong invoice'), 'reviewer', 'manager', {})
        self.assertEqual(len(reversals), 2)
        self.assertEqual(books.outstanding(self.store, invoice), 100)
        self.assertEqual(books.outstanding(self.store, credit), 40)
        self.assertEqual(books.outstanding(self.store, invoice, '2026-02-02'), 60)
        self.assertEqual(books.outstanding(self.store, credit, '2026-02-02'), 0)
        self.assertEqual(books.carrying_value(self.store, invoice), 100)
        with self.assertRaisesRegex(ValueError, 'unreversed credit allocation'):
            books.command(self.store, 'reverse-credit', dict(id=allocated[0]['id'], date='2026-02-03', reason='Again'),
                          'reviewer', 'manager', {})

    def test_foreign_credit_unapply_reverses_allocation_exchange_difference(self):
        invoice = self.document(amount=100)
        credit = self.document('credit_note', amount=40)
        for doc, rate in [(invoice, 1.3), (credit, 1.4)]:
            updated = dict(doc, currency='USD', exchangeRate=rate)
            books.save_document(self.store, updated, 'maker', doc['id'])
            self.post(doc)
        allocated = books.apply_credit(self.store, dict(creditId=credit['id'], documentId=invoice['id'],
                         date='2026-02-01', amount=40), 'reviewer', 'manager')
        self.assertTrue(allocated[0]['journalId'])
        books.command(self.store, 'reverse-credit', dict(id=allocated[1]['id'], date='2026-02-03', reason='Wrong allocation'),
                      'reviewer', 'manager', {})
        self.assertEqual(books.carrying_value(self.store, invoice), 130)
        self.assertEqual(books.carrying_value(self.store, credit), 56)
        fx = sum(books.dec(row['credit']) - books.dec(row['debit'])
                 for journal in self.store['journals'] for row in journal['lines']
                 if row['accountCode'] in {'4200', '6960'})
        self.assertEqual(fx, 0)

    def test_credit_unapply_date_cannot_rewrite_later_payment_history(self):
        invoice = self.post(self.document(amount=100))
        credit = self.post(self.document('credit_note', amount=40))
        allocated = books.apply_credit(self.store, dict(creditId=credit['id'], documentId=invoice['id'],
                         date='2026-02-01', amount=40), 'reviewer', 'manager')
        books.settle_batch(self.store, dict(date='2026-02-05', requestId='later',
                    allocations=[dict(documentId=invoice['id'], amount=60)]), 'reviewer', 'manager')
        before = copy.deepcopy(self.store)
        with self.assertRaisesRegex(ValueError, 'latest'):
            books.command(self.store, 'reverse-credit', dict(id=allocated[0]['id'], date='2026-02-03', reason='Wrong allocation'),
                          'reviewer', 'manager', {})
        self.assertEqual(self.store, before)


if __name__ == '__main__':
    unittest.main()
