"""Populated report cases found during the accountant workflow review."""
import unittest

from openpyxl import load_workbook

from services.accounting_exports import report_xlsx
from services.accounting_reports import build_report
from services.accounting_workspace import initialise


class AccountingReportReviewTests(unittest.TestCase):
    def setUp(self):
        accounts = [
            ('1000', 'Bank', 'asset', 'Current Assets'),
            ('1100', 'Trade receivables', 'asset', 'Current Assets'),
            ('1500', 'Equipment', 'asset', 'Non-current Assets'),
            ('1590', 'Accumulated depreciation', 'asset', 'Non-current Assets'),
            ('2000', 'Trade payables', 'liability', 'Current Liabilities'),
            ('2500', 'Loan', 'liability', 'Non-current Liabilities'),
            ('3000', 'Share capital', 'equity', 'Equity'),
            ('3100', 'Retained earnings', 'equity', 'Equity'),
            ('4000', 'Sales', 'revenue', 'Income'),
            ('6800', 'Expenses', 'expense', 'Expenses'),
        ]
        self.store = initialise(dict(
            accounts=[dict(code=c, name=n, type=t, group=g, active=True) for c, n, t, g in accounts],
            settings=dict(defaultBankAccount='1000', defaultReceivableAccount='1100',
                          defaultPayableAccount='2000', businessName='Example Pte Ltd', uen='202600001A'),
            journals=[], bankTransactions=[]))

    def journal(self, journal_id, date, **amounts):
        self.assertEqual(sum(amounts.values()), 0, 'The fixture must be a balanced journal')
        self.store['journals'].append(dict(
            id=journal_id, number=journal_id, date=date, status='posted',
            description='Entry ' + journal_id,
            lines=[dict(accountCode=code, debit=max(value, 0), credit=max(-value, 0))
                   for code, value in amounts.items()]))

    def report(self, name, **args):
        return build_report(self.store, name, {'from': '2026-01-01', 'to': '2026-03-31', **args})

    def test_cash_flow_comparison_includes_prior_only_entries_and_subtotal_support(self):
        self.journal('OLD-RECEIPT', '2025-01-15', **{'1000': 200, '4000': -200})
        self.journal('NEW-RECEIPT', '2026-02-15', **{'1000': 80, '4000': -80})
        report = self.report('cash-flow', compare='year', groupBy='monthly')
        rows = {r['key']: r for r in report['rows']}
        self.assertEqual(rows['OLD-RECEIPT']['amount'], 0)
        self.assertEqual(rows['OLD-RECEIPT']['comparison'], 200)
        self.assertEqual(rows['OLD-RECEIPT']['variance'], -200)
        self.assertEqual([rows['OLD-RECEIPT']['period' + str(i)] for i in range(3)], [0, 0, 0])
        self.assertEqual(rows['OLD-RECEIPT']['cellRefs']['comparison']['journalIds'], ['OLD-RECEIPT'])
        self.assertEqual(rows['total-operating']['ref']['journalIds'], ['NEW-RECEIPT'])
        self.assertEqual(rows['total-operating']['cellRefs']['comparison']['journalIds'], ['OLD-RECEIPT'])
        detail = [r for r in report['rows'] if not r.get('total') and not r.get('section')]
        self.assertEqual(sum(r['comparison'] for r in detail), rows['movement']['comparison'])
        self.assertEqual(sum(r['amount'] for r in detail), rows['movement']['amount'])

    def test_cash_flow_comparison_preserves_a_prior_only_classification_review(self):
        self.journal('MIXED', '2025-01-15', **{'1000': -150, '1500': 100, '6800': 50})
        self.journal('RECEIPT', '2026-01-15', **{'1000': 50, '4000': -50})
        report = self.report('cash-flow', compare='year')
        keys = [row['key'] for row in report['rows']]
        self.assertLess(keys.index('unclassified'), keys.index('MIXED'))
        self.assertLess(keys.index('MIXED'), keys.index('total-unclassified'))
        total = next(r for r in report['rows'] if r['key'] == 'total-unclassified')
        self.assertEqual((total['amount'], total['comparison'], total['variance']), (0, -150, 150))

    def test_cash_flow_looks_through_capital_bill_settlement_including_fx(self):
        self.journal('BILL', '2026-01-15', **{'1500': 390, '2000': -390})
        self.journal('PAYMENT', '2026-02-15', **{'1000': -420, '2000': 390, '6960': 30})
        self.store['documents'] = [dict(id='CAPITAL-BILL', lines=[dict(accountCode='1500')])]
        self.store['settlements'] = [dict(documentId='CAPITAL-BILL', journalId='PAYMENT')]
        report = self.report('cash-flow')
        rows = {row['key']: row for row in report['rows']}
        self.assertEqual(rows['total-investing']['amount'], -420)
        self.assertEqual(rows['total-operating']['amount'], 0)
        self.assertEqual(rows['movement']['amount'], -420)
        self.assertEqual(rows['total-investing']['ref']['journalIds'], ['PAYMENT'])
        # A supplier bill covering equipment and services cannot be silently
        # treated wholly as operating or investing without an allocation.
        self.store['documents'][0]['lines'].append(dict(accountCode='6800'))
        mixed = {row['key']: row for row in self.report('cash-flow')['rows']}
        self.assertEqual(mixed['total-unclassified']['amount'], -420)

    def test_equity_totals_reconcile_and_each_period_drills_to_its_own_entries(self):
        self.journal('CAPITAL', '2025-12-01', **{'1000': 1000, '3000': -1000})
        self.journal('OLD-PROFIT', '2025-12-10', **{'1100': 100, '4000': -100})
        self.journal('NEW-PROFIT', '2026-01-10', **{'1100': 80, '4000': -80})
        self.journal('DISTRIBUTION', '2026-02-10', **{'3100': 30, '1000': -30})
        report = self.report('equity')
        total = report['rows'][-1]
        self.assertTrue(total['total'])
        self.assertEqual((total['opening'], total['movement'], total['closing']), (1100, 50, 1150))
        earnings = next(r for r in report['rows'] if r['label'] == 'Unclosed earnings')
        self.assertEqual(earnings['cellRefs']['opening']['journalIds'], ['OLD-PROFIT'])
        self.assertEqual(earnings['cellRefs']['movement']['journalIds'], ['NEW-PROFIT'])
        balance_sheet = self.report('balance-sheet')
        self.assertEqual(total['closing'], next(r['amount'] for r in balance_sheet['rows'] if r['key'] == 'total-equity'))

    def test_schedule_totals_cover_only_reporting_date_records(self):
        self.store['fixedAssets'] = [dict(
            name='Laptop', inServiceDate='2025-12-01', cost=1200, residualValue=0,
            usefulLifeMonths=12, acquisitionJournalId='ACQUIRE',
            depreciation=[dict(date='2025-12-31', amount=100, journalId='DEP-OLD'),
                          dict(date='2026-01-31', amount=100, journalId='DEP-NEW'),
                          dict(date='2026-04-30', amount=300, journalId='DEP-FUTURE')])]
        total = self.report('fixed-assets')['rows'][-1]
        self.assertEqual((total['cost'], total['opening'], total['charge'], total['nbv']), (1200, 100, 100, 1000))
        self.assertEqual(total['pending'], 200)
        self.assertEqual(set(total['ref']['journalIds']), {'ACQUIRE', 'DEP-OLD', 'DEP-NEW'})
        self.store['stockItems'] = [dict(id='A', sku='A', name='Cables'), dict(id='B', sku='B', name='Cases')]
        self.store['stockMoves'] = [dict(itemId='A', date='2026-01-01', quantity=2, value=50, journalId='STOCK-A'),
                                    dict(itemId='B', date='2026-02-01', quantity=3, value=90, journalId='STOCK-B'),
                                    dict(itemId='B', date='2026-04-01', quantity=3, value=90, journalId='FUTURE')]
        inventory = self.report('inventory')['rows'][-1]
        self.assertEqual(inventory['value'], 140)
        self.assertNotIn('quantity', inventory, 'Different stock units must not be added together')
        self.assertEqual(set(inventory['ref']['journalIds']), {'STOCK-A', 'STOCK-B'})

    def test_bank_reconciliation_recognises_lump_sum_matches_and_legacy_links(self):
        self.journal('PAY-ONE', '2026-02-01', **{'1000': -60, '2000': 60})
        self.journal('PAY-TWO', '2026-02-01', **{'1000': -40, '2000': 40})
        self.journal('RECEIPT', '2026-02-03', **{'1000': 150, '1100': -150})
        self.store['bankTransactions'] = [dict(id='BATCH', date='2026-02-01', bankAccount='1000',
            amount=-100, description='Supplier batch', status='matched', journalId='PAY-ONE', journalIds=['PAY-ONE', 'PAY-TWO']),
            dict(id='LEGACY', date='2026-02-03', bankAccount='1000', amount=150,
                 description='Receipt', status='matched', journalId='RECEIPT')]
        self.store['bankReconciliations'] = [dict(date='2026-03-31', bankAccount='1000', closingBalance=50, createdBy='Accountant')]
        report = self.report('bank-reconciliation')
        self.assertEqual(report['reconciliation']['difference'], 0)
        self.assertEqual(report['reconciliation']['unmatchedStatementCount'], 0)
        self.assertEqual(report['reconciliation']['outstandingLedgerCount'], 0)

    def test_excel_identifies_company_and_keeps_notes_readable_and_values_numeric(self):
        self.journal('RECEIPT', '2026-02-01', **{'1000': 100, '4000': -100})
        report = self.report('cash-flow', compare='year')
        report['businessName'] = '=UNTRUSTED()'
        book = load_workbook(report_xlsx(report))
        sheet = book.active
        self.assertIn('=UNTRUSTED()', sheet['A1'].value)
        self.assertEqual(sheet['A1'].data_type, 's')
        self.assertIn('202600001A', sheet['A2'].value)
        self.assertIn('A1:D1', {str(r) for r in sheet.merged_cells.ranges})
        self.assertEqual(sheet.page_setup.fitToHeight, 0)
        self.assertEqual(sheet.freeze_panes, 'A5')
        receipt_row = next(row for row in sheet if row[0].value and 'RECEIPT' in str(row[0].value))
        self.assertIsInstance(receipt_row[1].value, (int, float))
        note_row = next(row[0].row for row in sheet if str(row[0].value).startswith('Direct method.'))
        self.assertIn(f'A{note_row}:D{note_row}', {str(r) for r in sheet.merged_cells.ranges})
        self.assertGreaterEqual(sheet.row_dimensions[note_row].height, 30)


if __name__ == '__main__':
    unittest.main()
