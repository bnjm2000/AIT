import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from document_learning import (
    MODEL_FILENAME, VERSION, atomic_json, calibrate, load_amount_profile,
    train_snapshot, trusted_record,
)
from workforce import _amount_candidates, _amount_from_text, _date_from_text, extract_invoice_amount


def example_text(amount):
    return f'Total $900.00\nNotes\nServices\nTerms\nDetails\nSettlement sum ${amount:.2f}'


def examples():
    return [
        {'kind': 'invoice', 'expected': amount,
         'candidates': _amount_candidates(example_text(amount))}
        for amount in (101.0, 202.0, 303.0)
    ]


class DocumentLearningTests(unittest.TestCase):
    def test_overnight_parking_uses_exit_date_not_entry_date(self):
        result = _date_from_text(
            'TAX RECEIPT\nIN : 01 Sep 26 23:45:25\nOUT: 02 Sep 26 07:43:34\nTOTAL FEE $1.30'
        )
        self.assertEqual(result['date'], '2026-09-02')
        self.assertIn('OUT:', result['dateMatchedText'])
        scanned = _date_from_text('IN : 01 Sep 26 23:46:25\nOUf: 02 Sep 26 07:43:34')
        self.assertEqual(scanned['date'], '2026-09-02')
        result = _date_from_text('Entry Time: 31/08/2026 23:50\nExit Time: 01/09/2026 08:00')
        self.assertEqual(result['date'], '2026-09-01')

    def test_date_rule_does_not_confuse_outstanding_payment_or_expiry(self):
        result = _date_from_text(
            'Receipt Date: 01/09/2026\nOutstanding balance due date: 20/09/2026\nExpires 30/09/2026'
        )
        self.assertEqual(result['date'], '2026-09-01')

    def test_learns_layout_not_historical_amount_and_evaluates_without_self(self):
        profiles, evaluation, enabled = calibrate(examples())
        self.assertTrue(enabled)
        self.assertEqual(evaluation['baselineCorrect'], 0)
        self.assertEqual(evaluation['learnedCorrect'], 3)
        self.assertEqual(evaluation['regressed'], 0)
        self.assertEqual(_amount_from_text(example_text(777), profiles['invoice'])['amount'], 777)
        self.assertEqual(_amount_from_text(example_text(777))['amount'], 900)
        self.assertTrue(all(len(key) == 64 for key in profiles['invoice']))

    def test_one_document_cannot_teach_itself(self):
        profiles, evaluation, enabled = calibrate(examples()[:1])
        self.assertFalse(enabled)
        self.assertEqual(profiles['invoice'], {})
        self.assertEqual(evaluation['learnedCorrect'], 0)

    def test_conflicting_layout_labels_are_not_promoted(self):
        samples = examples()
        samples[1]['expected'] = 900
        profiles, _, _ = calibrate(samples)
        self.assertEqual(profiles['invoice'], {})

    def test_only_reviewed_accepted_amounts_are_trusted(self):
        base = {'amount': 100, 'status': 'Paid', 'reviewedAt': '2026-01-01'}
        self.assertTrue(trusted_record(base))
        self.assertFalse(trusted_record({**base, 'status': 'Denied'}))
        self.assertFalse(trusted_record({**base, 'reviewedAt': ''}))
        self.assertFalse(trusted_record({**base, 'amount': 0}))

    def test_company_scoped_runtime_profile_and_corrupt_fallback(self):
        profiles, _, _ = calibrate(examples())
        with tempfile.TemporaryDirectory() as company_a, tempfile.TemporaryDirectory() as company_b:
            atomic_json(Path(company_a) / MODEL_FILENAME, {
                'version': VERSION, 'enabled': True, 'profiles': profiles,
            })
            self.assertEqual(load_amount_profile(company_b, 'invoice'), {})
            self.assertEqual(load_amount_profile(company_a, 'claim'), {})
            with patch('workforce._pdf_text', return_value=example_text(444)):
                self.assertEqual(extract_invoice_amount('new.pdf', data_folder=company_a)['amount'], 444)
                self.assertEqual(extract_invoice_amount('new.pdf', data_folder=company_b)['amount'], 900)
            atomic_json(Path(company_a) / MODEL_FILENAME, {'version': VERSION, 'enabled': True, 'profiles': []})
            self.assertEqual(load_amount_profile(company_a, 'invoice'), {})

    def test_snapshot_deduplicates_files_and_never_modifies_submission_records(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            records = []
            for index, amount in enumerate((101, 202, 303)):
                path = root / f'upload-{index}.pdf'
                path.write_bytes(f'%PDF fixture {index}'.encode())
                records.append({'storedPath': path.name, 'amount': amount,
                                'status': 'Paid', 'verifiedAt': '2026-01-01'})
            records.append(dict(records[0]))
            records.append({**records[0], 'status': 'Denied'})
            store = root / 'Workforce.json'
            original = json.dumps({'submissions': {'1': {'worker': {'invoices': records}}}})
            store.write_text(original, encoding='utf-8')
            with patch('document_learning.training_candidates', side_effect=[
                sample['candidates'] for sample in examples()
            ]) as extract:
                report = train_snapshot(folder, apply=True)
            self.assertEqual(extract.call_count, 3)
            self.assertEqual(report['evaluation']['documents'], 3)
            self.assertEqual(report['exclusions']['duplicateDocument'], 1)
            self.assertEqual(report['exclusions']['unreviewedOrDenied'], 1)
            self.assertEqual(store.read_text(encoding='utf-8'), original)
            self.assertTrue(report['enabled'])
            model = json.loads((root / MODEL_FILENAME).read_text(encoding='utf-8'))
            self.assertFalse(model['automaticTraining'])


if __name__ == '__main__':
    unittest.main()
