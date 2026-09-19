"""Regression examples for real document-processing failure modes (synthetic data)."""
import hashlib
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from document_learning import CACHE_FILENAME, MODEL_FILENAME, VERSION, atomic_json, submission_records, train_snapshot
from workforce import (_amount_from_text, _date_from_text, _invoice_due_date_from_text,
                       _unlabelled_invoice_table_total, extract_claim_amount,
                       extract_invoice_amount, money)


class DocumentDetectionTests(unittest.TestCase):
    def test_non_finite_and_oversized_numbers_do_not_crash_money_or_receipts(self):
        for value in ('NaN', 'sNaN', 'Infinity', '-Infinity', '9' * 40, '1e999999'):
            with self.subTest(value=value):
                self.assertIsNone(money(value))
        self.assertEqual(money('1,234.567'), 1234.57)
        result = _amount_from_text('Total $27.50\nTransaction number ' + '9' * 40)
        self.assertEqual(result['amount'], 27.50)

    def test_reference_number_beside_balance_does_not_become_amount(self):
        result = _amount_from_text('Account Number: 010-4-123456 Balance Due-$ 470.00-\nPaynow: 91234567')
        self.assertEqual(result['amount'], 470)
        self.assertEqual(_amount_from_text('Total S$ 2,350.00\nPayment: INV/2026/00048')['amount'], 2350)

    def test_subtotal_is_total_when_invoice_has_no_further_summary(self):
        result = _amount_from_text('Quantity Unit Price Total\n1 200.00$ 200.00$\n1 300.00$ 300.00$\nSubtotal $500.00')
        self.assertEqual(result['amount'], 500)
        result = _amount_from_text('Description Qty Unit price Total price\n3 $400.00 $1,200.00\nNotes: Paynow 91234567 Subtotal $1,200.00')
        self.assertEqual(result['amount'], 1200)

    def test_explicit_total_beats_repeated_item_prices_and_before_tax_summary(self):
        self.assertEqual(_amount_from_text('Item $180.00\nItem $180.00\nTOTAL 360.00$')['amount'], 360)
        self.assertEqual(_amount_from_text('Subtotal $400.00\nGST 9% $36.00\nTotal $436.00')['amount'], 436)
        self.assertEqual(_amount_from_text('150.00\n150.00\nTotal Due:\n300.00')['amount'], 300)

    def test_standalone_trip_fare_beats_referral_offer(self):
        result = _amount_from_text('TRIP SUMMARY\nSGD 24.95\nDriver fare 22.50\nPlatform fee 2.45\nGIVE $5, GET $5')
        self.assertEqual(result['amount'], 24.95)

    def test_currency_ocr_repairs_keep_cents_and_card_balance_is_not_charge(self):
        self.assertEqual(_amount_from_text('Total: SS12.30')['amount'], 12.30)
        self.assertEqual(_amount_from_text('Total Fee Charged\n30.70SGD')['amount'], 30.70)
        self.assertEqual(_amount_from_text('PAID AMOUNT: $O.65\nCARD BALANCE:$128.92')['amount'], .65)
        self.assertEqual(_amount_from_text('Total: 12.3456')['amount'], None)

    def test_cross_currency_order_prefers_explicit_sgd_payment(self):
        text = ('商品总价 ¥1657.6\n支付手续费 SGD9.89\n运费 ¥60\n'
                '价格明细 实付款SGD339.67\n订单信息共4项 5127393710355114019\n'
                '支付宝交易号 2026083123001163631405088658\n订单信息共4项')
        self.assertEqual(_amount_from_text(text)['amount'], 339.67)

    def test_receipt_dates_survive_order_numbers_and_joined_times(self):
        cases = {
            'ORD #10 -REG #99- 18/08/2026 11:05:37': '2026-08-18',
            '付款时间 2026-08-3115:09:31': '2026-08-31',
            'Time:15:0704-09-2026': '2026-09-04',
            '8/19/2612:25PM': '2026-08-19',
            'Receipt Date: 08/09/2026': '2026-09-08',
            'ENTRY TIME:31/08/2026 23:00\nEXIL TIME:01/09/2026 08:00': '2026-09-01',
        }
        for text, expected in cases.items():
            with self.subTest(text=text):
                self.assertEqual(_date_from_text(text)['date'], expected)
        self.assertEqual(_date_from_text('31/04/2026')['date'], '')

    def test_ocr_date_fallback_does_not_replace_stronger_native_amount(self):
        with patch('workforce._pdf_text', return_value='Total amount due $125.00'), \
             patch('workforce._ocr_pdf', return_value='Receipt date 04/09/2026\nReference 80'):
            result = extract_claim_amount('receipt.pdf')
        self.assertEqual(result['amount'], 125)
        self.assertEqual(result['date'], '2026-09-04')
        self.assertEqual(result['source'], 'PDF text')

    def test_invoice_due_date_supports_explicit_dates_and_payment_terms(self):
        explicit = _invoice_due_date_from_text(
            'Invoice Date 01 Jun 2026\nDue Date 01 Jul 2026',
            '2026-09-19T10:00:00+08:00',
        )
        self.assertEqual(explicit['dueDate'], '2026-07-01')
        self.assertEqual(explicit['dueDateSource'], 'Explicit due date')

        cases = {
            'Payment terms: 30 Days': ('2026-07-01', 30),
            'TERM: 14 days from invoice date': ('2026-06-15', 14),
            'Terms Net 30': ('2026-07-01', 30),
            'Payment is due within 30 days of the invoice date.': ('2026-07-01', 30),
        }
        for term, expected in cases.items():
            with self.subTest(term=term):
                result = _invoice_due_date_from_text(
                    f'Invoice Date 01 Jun 2026\n{term}',
                    '2026-09-19T10:00:00+08:00',
                )
                self.assertEqual(result['dueDate'], expected[0])
                self.assertEqual(result['dueInDays'], expected[1])
                self.assertIn('invoice date', result['dueDateSource'])

        submitted = _invoice_due_date_from_text(
            'Submitted Date: 05/06/2026\nDue in 10 days',
            '2026-09-19T10:00:00+08:00',
        )
        self.assertEqual(submitted['dueDate'], '2026-06-15')
        self.assertEqual(submitted['dueDateReferenceDate'], '2026-06-05')

        split_term = _invoice_due_date_from_text(
            'Invoice Date: 05/06/2026\nPayment Terms:\nWithin 30 days',
            '2026-09-19T10:00:00+08:00',
        )
        self.assertEqual(split_term['dueDate'], '2026-07-05')

    def test_invoice_due_term_uses_upload_date_only_when_document_date_is_missing(self):
        result = _invoice_due_date_from_text(
            'Invoice\nPayment Due : 30 days',
            '2026-09-19T23:45:00+08:00',
        )
        self.assertEqual(result['dueDate'], '2026-10-19')
        self.assertEqual(result['dueDateReferenceDate'], '2026-09-19')
        self.assertIn('Showbase upload date', result['dueDateSource'])

    def test_invoice_without_due_date_or_term_stays_empty(self):
        result = _invoice_due_date_from_text(
            'Invoice Date 01 Jun 2026\nAmount Due SGD 400.00\nPayment via bank transfer',
            '2026-09-19T10:00:00+08:00',
        )
        self.assertEqual(result['dueDate'], '')
        self.assertEqual(result['dueDateSource'], '')
        self.assertIsNone(result['dueInDays'])

        legal_text = _invoice_due_date_from_text(
            'Late payment after invoice due date attracts interest after 3 months.',
            '2026-09-19T10:00:00+08:00',
        )
        self.assertEqual(legal_text['dueDate'], '')

    def test_invoice_photo_ocr_extracts_due_date_with_total(self):
        with patch(
            'workforce._ocr_image',
            return_value='Invoice Date 13/3/2026\nPayment Due: May 30, 2026\nTotal $125.00',
        ):
            result = extract_invoice_amount(
                'invoice.jpg', submitted_at='2026-03-14T09:00:00+08:00'
            )
        self.assertEqual(result['amount'], 125)
        self.assertEqual(result['dueDate'], '2026-05-30')
        self.assertEqual(result['dueDateSource'], 'Explicit due date')

    def test_character_spaced_pdf_uses_readable_ocr_instead_of_partial_digits(self):
        native = ('I n v o i c e D e s c r i p t i o n A m o u n t\n' * 4
                  + 'T o t a l\n$ 3 3 0 . 0 0')
        with patch('workforce._pdf_text', return_value=native), \
             patch('workforce._ocr_pdf', return_value='Total $330.00') as ocr:
            self.assertEqual(extract_invoice_amount('invoice.pdf')['amount'], 330)
            ocr.assert_called_once()

    def test_foreign_total_is_not_prefilled_as_singapore_dollars(self):
        with patch('workforce._pdf_text', return_value='Invoice\nTotal EUR 162.00'):
            result = extract_invoice_amount('invoice.pdf')
        self.assertIsNone(result['amount'])
        self.assertIn('enter SGD amount', result['source'])

    def test_reviewed_expense_attachments_supply_labels_only_after_review(self):
        from document_learning import trusted_record
        expense = {'amount': 10, 'attachment': {'storedPath': 'receipt.pdf'},
                   'updatedBy': 'reviewer', 'updatedAt': '2026-09-01', 'needsReview': False}
        finance = {'profitLoss': {'expenses': {'1': [expense, {**expense, 'needsReview': True}]}}}
        rows = list(submission_records({}, finance))
        self.assertTrue(trusted_record(rows[0][1]))
        self.assertFalse(trusted_record(rows[1][1]))

    def test_old_cache_is_invalidated_and_one_bad_document_does_not_abort_snapshot(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            records = []
            for index in range(2):
                (root / f'{index}.pdf').write_bytes(f'PDF {index}'.encode())
                records.append({'storedPath': f'{index}.pdf', 'amount': 25,
                                'status': 'Paid', 'reviewedAt': '2026-09-01'})
            digest = hashlib.sha256((root / '0.pdf').read_bytes()).hexdigest()
            atomic_json(root / CACHE_FILENAME, {'version': VERSION, 'documents': {
                'invoice:' + digest: [{'score': 100, 'lineIndex': 0, 'amount': 25, 'feature': 'x' * 64}]
            }})
            snapshot = {'submissions': {'1': {'worker': {'invoices': records}}}}
            with patch('document_learning.training_candidates', side_effect=[RuntimeError('bad OCR'), []]) as extract:
                report = train_snapshot(folder, workforce_snapshot=snapshot)
            self.assertEqual(extract.call_count, 2)
            self.assertEqual(report['exclusions']['extractionError'], 1)
            self.assertEqual(report['exclusions']['noReadableAmount'], 1)
            self.assertFalse((root / MODEL_FILENAME).exists())

    def test_unlabelled_invoice_total_is_read_in_visual_pdf_order(self):
        import fitz
        from document_learning import predicted_amount, training_candidates
        from workforce import _pdf_text

        # Deliberately write cells in a different order from their page position,
        # as spreadsheet exports do. Repetition made item prices look confident.
        with tempfile.TemporaryDirectory() as folder:
            path = str(Path(folder) / 'invoice.pdf')
            with fitz.open() as document:
                page = document.new_page(width=600, height=700)
                page.insert_text((30, 70), 'Date       Description       Venue       Role       Amount')
                for index in range(6):
                    page.insert_text((30, 100 + 25 * index), f'{index + 1:02d}-Sep-26   Event   Hall   Setup')
                for index in (3, 4):
                    page.insert_text((450, 100 + 25 * index), '$180.00')
                page.insert_text((450, 350), '$1,150.00')
                for index in (0, 1, 2, 5):
                    page.insert_text((450, 100 + 25 * index), '$250.00' if index == 5 else '$180.00')
                page.insert_text((30, 390), 'Bank Details')
                document.save(path)
            native = _amount_from_text(_pdf_text(path))
            self.assertEqual(native['amount'], 180)
            self.assertEqual(native['confidence'], 'High')
            with patch('workforce._ocr_pdf') as ocr:
                result = extract_invoice_amount(path)
                trained = predicted_amount(training_candidates(path, 'invoice'))
            self.assertEqual(result['amount'], 1150)
            self.assertEqual(result['matchedText'], '$1,150.00')
            self.assertEqual(result['source'], 'PDF table layout')
            self.assertEqual(trained, 1150)
            ocr.assert_not_called()

    def test_unlabelled_table_requires_a_printed_matching_summary(self):
        rows = 'Date Description Venue Role Amount\n01-Sep-26 Event Hall Setup $123.45\n02-Sep-26 Event Hall TD $234.56\n'
        self.assertEqual(_unlabelled_invoice_table_total(rows + '$358.01\nBank Details'), 358.01)
        self.assertIsNone(_unlabelled_invoice_table_total(rows + 'Bank Details'))
        self.assertIsNone(_unlabelled_invoice_table_total(rows + '$357.01'))
        self.assertIsNone(_unlabelled_invoice_table_total(rows + 'Discount $10.00\n$348.01'))
        self.assertIsNone(_unlabelled_invoice_table_total(rows + '03-Sep-26 Unreadable\n$358.01'))

    def test_unlabelled_table_rejects_multiple_price_columns_or_summaries(self):
        header = 'Date Description Venue Role Amount\n'
        self.assertIsNone(_unlabelled_invoice_table_total(header + '01-Sep-26 Event $100.00 $200.00\n$200.00'))
        table = header + '01-Sep-26 Event $100.00\n$100.00\n'
        self.assertIsNone(_unlabelled_invoice_table_total(table + table))


if __name__ == '__main__':
    unittest.main()
