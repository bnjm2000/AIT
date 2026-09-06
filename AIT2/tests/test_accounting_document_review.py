"""Customer-facing documents, download controls and linked-acquisition integrity."""
import io
import unittest

from pypdf import PdfReader
from services.accounting_documents import document_view
from tests import test_accounting_workspace as workspace_tests


class AccountingDocumentReviewTests(unittest.TestCase):
    setUp = workspace_tests.AccountingWorkspaceTests.setUp
    tearDown = workspace_tests.AccountingWorkspaceTests.tearDown
    make_user = workspace_tests.AccountingWorkspaceTests.make_user
    login = workspace_tests.AccountingWorkspaceTests.login
    request = workspace_tests.AccountingWorkspaceTests.request
    begin = workspace_tests.AccountingWorkspaceTests.begin
    document = workspace_tests.AccountingWorkspaceTests.document
    post_document = workspace_tests.AccountingWorkspaceTests.post_document
    workspace = workspace_tests.AccountingWorkspaceTests.workspace

    def prepare(self):
        self.begin()
        self.request('settings', dict(gstRegistered=True, gstRegistrationNumber='M200000001'), method='put')
        self.request('actions/controls', dict(businessName='Example Seller Pte Ltd',
                      businessAddress='1 Example Road, Singapore', uen='202600001A'))
        self.request('actions/contacts', dict(name='Example Pte Ltd', address='2 Customer Road, Singapore'))

    def test_foreign_tax_invoice_pdf_contains_all_sgd_totals_and_supply_breakdown(self):
        self.prepare()
        doc = self.post_document(self.document(currency='USD', exchangeRate=1.3, lines=[
            dict(description='Local services', quantity=1, unitPrice=100, taxCode='SR9'),
            dict(description='Qualifying export', quantity=1, unitPrice=50, taxCode='ZR'),
            dict(description='Exempt supply', quantity=1, unitPrice=20, taxCode='ES')]))
        response = self.client.get(f'/api/finance/accounting/documents/{doc["id"]}/pdf')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.mimetype, 'application/pdf')
        self.assertEqual(response.headers['Cache-Control'], 'private, no-store')
        text = '\n'.join(page.extract_text() for page in PdfReader(io.BytesIO(response.data)).pages)
        for required in ['Tax Invoice', 'Total excluding GST: SGD 221.00', 'Total GST: SGD 11.70',
                         'Total including GST: SGD 232.70', 'Standard-rated 9%', 'Zero-rated 0%',
                         'Exempt', 'M200000001', '2 Customer Road']:
            self.assertIn(required, text)
        self.assertNotIn('INCOMPLETE', text)

    def test_saved_preview_retains_issued_identity_and_escapes_document_content(self):
        self.prepare()
        doc = self.post_document(self.document(lines=[dict(description='<img src=x onerror=alert(1)>',
                     quantity=1, unitPrice=100, taxCode='SR9')]))
        self.request('actions/controls', dict(businessName='New name', businessAddress='Changed address'))
        response = self.client.get(f'/api/finance/accounting/documents/{doc["id"]}/preview')
        self.assertEqual(response.status_code, 200)
        html = response.get_json()['html']
        self.assertIn('Example Seller Pte Ltd', html)
        self.assertNotIn('Changed address', html)
        self.assertNotIn('<img', html)
        self.assertIn('&lt;img', html)

    def test_incomplete_draft_is_clearly_a_review_copy(self):
        self.begin()
        doc = self.document()
        response = self.client.get(f'/api/finance/accounting/documents/{doc["id"]}/preview')
        warnings = ' '.join(response.get_json()['warnings'])
        self.assertIn('DRAFT', warnings)
        self.assertIn('supplier business name', warnings)

    def test_pdf_download_requires_accounting_access(self):
        self.prepare()
        doc = self.document()
        self.login('no-sales')
        self.assertEqual(self.client.get(f'/api/finance/accounting/documents/{doc["id"]}/pdf').status_code, 403)

    def test_manual_acquisition_cannot_be_reversed_behind_asset_register(self):
        self.begin()
        journal = self.request('journals', dict(date='2026-01-01', description='Asset opening cost', status='posted',
                       lines=[dict(accountCode='1500', debit=1200), dict(accountCode='3000', credit=1200)]), expected=201)['journal']
        self.request('actions/fixed-assets', dict(name='Laptop', cost=1200, residualValue=0,
                     usefulLifeMonths=12, inServiceDate='2026-01-01', acquisitionJournalId=journal['id']))
        response = self.client.post(f'/api/finance/accounting/journals/{journal["id"]}/reverse', json={'date':'2026-02-01'})
        self.assertEqual(response.status_code, 409)
        self.assertIn('fixed asset register', response.get_json()['error'])
        self.assertEqual(len(self.workspace()['journals']), 1)


if __name__ == '__main__':
    unittest.main()
