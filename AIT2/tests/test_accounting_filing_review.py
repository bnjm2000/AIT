"""Filing preparation must distinguish native working papers from external packages."""
import io
import unittest
from urllib.parse import urlparse

from openpyxl import load_workbook
from services.accounting_close import FILING_TYPES, MANUAL_PACKAGE_TYPES
from tests import test_accounting_close as close_tests


class AccountingFilingReviewTests(unittest.TestCase):
    setUp = close_tests.AccountingCloseTests.setUp
    tearDown = close_tests.AccountingCloseTests.tearDown
    login = close_tests.AccountingCloseTests.login
    make_user = close_tests.AccountingCloseTests.make_user
    request = close_tests.AccountingCloseTests.request
    begin = close_tests.AccountingCloseTests.begin
    workspace = close_tests.AccountingCloseTests.workspace
    close = close_tests.AccountingCloseTests.close
    filing = close_tests.AccountingCloseTests.filing

    def attach(self, filing, name='prepared-return.txt'):
        response = self.client.post('/api/finance/accounting/attachments/filings/' + filing['id'],
                                    data={'file': (io.BytesIO(b'Reviewed filing computation for testing'), name)})
        self.assertEqual(response.status_code, 200)
        return response.get_json()['record']

    def test_filing_guide_is_available_before_creating_a_filing(self):
        self.begin()
        data = self.close()
        self.assertEqual(data['filings'], [])
        self.assertEqual(set(data['filingGuides']), set(FILING_TYPES))
        for kind, guide in data['filingGuides'].items():
            with self.subTest(kind=kind):
                self.assertTrue(guide['preparation'])
                for label, url in guide['links']:
                    self.assertTrue(label)
                    parsed = urlparse(url)
                    self.assertEqual(parsed.scheme, 'https')
                    self.assertTrue(parsed.hostname.endswith('.gov.sg'))

    def test_manual_filings_need_their_own_prepared_package_before_review(self):
        self.begin()
        unrelated = self.filing(type='other')
        self.attach(unrelated)
        for kind in sorted(MANUAL_PACKAGE_TYPES):
            with self.subTest(kind=kind):
                draft = self.filing(type=kind)
                rejected = self.client.post('/api/finance/accounting/actions/filing-review',
                                           json={'id': draft['id'], 'version': draft['version']})
                self.assertEqual(rejected.status_code, 400)
                self.assertIn('prepared filing package', rejected.get_json()['error'])
                attachment = self.attach(draft)
                reviewed = self.request('actions/filing-review',
                                        dict(id=draft['id'], version=draft['version']))['record']
                self.assertEqual(reviewed['status'], 'reviewed')
                self.assertEqual(reviewed['reviewAttachments'][0]['id'], attachment['id'])
                self.assertEqual(reviewed['reviewAttachments'][0]['sha256'], attachment['sha256'])

    def test_final_gst_return_can_be_prepared_after_registration_has_ended(self):
        self.begin()
        self.assertFalse(self.workspace()['settings']['gstRegistered'])
        draft = self.filing(type='gst-final', notes='Cancellation notice and final asset assessment attached.')
        self.assertNotIn('gstRows', draft)
        self.assertIn('final period', draft['guide']['guidance'])
        self.assertEqual(draft['portal'], 'https://mytax.iras.gov.sg/')
        self.attach(draft)
        result = self.request('actions/filing-review', dict(id=draft['id'], version=draft['version']))['record']
        self.assertEqual(result['status'], 'reviewed')
        self.assertEqual(len(self.workspace()['journals']), 0)

    def test_package_at_review_is_retained_when_acknowledgement_is_added_later(self):
        self.begin()
        draft = self.filing(type='annual-return')
        prepared = self.attach(draft, 'financial-statements.xbrl')
        reviewed = self.request('actions/filing-review', dict(id=draft['id'], version=draft['version']))['record']
        self.attach(reviewed, 'portal-acknowledgement.txt')
        response = self.client.get('/api/finance/accounting/filings/' + draft['id'])
        retained = response.get_json()['filing']
        self.assertEqual([a['id'] for a in retained['reviewAttachments']], [prepared['id']])
        exported = self.client.get('/api/finance/accounting/filings/' + draft['id'] + '/xlsx')
        book = load_workbook(io.BytesIO(exported.data))
        text = '\n'.join(str(c.value) for row in book.active for c in row if c.value is not None)
        self.assertIn(prepared['sha256'], text)
        self.assertIn('does not submit', text)

    def test_other_filing_does_not_claim_iras_is_the_relevant_authority(self):
        self.begin()
        draft = self.filing(type='other', title='Industry-specific reporting')
        self.assertEqual(draft['portal'], '')
        self.assertIn('relevant authority', draft['guide']['deadline'])


if __name__ == '__main__':
    unittest.main()
