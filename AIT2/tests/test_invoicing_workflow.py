"""Billing workflow regressions, using an isolated company and storage."""

import unittest

from tests import test_finance


class InvoicingWorkflowTests(unittest.TestCase):
    setUp = test_finance.FinanceFeatureTests.setUp
    tearDown = test_finance.FinanceFeatureTests.tearDown
    make_user = test_finance.FinanceFeatureTests.make_user
    login = test_finance.FinanceFeatureTests.login
    create_quote = test_finance.FinanceFeatureTests.create_quote

    def create_plan(self, amount=100):
        quotation = self.create_quote('Invoice workflow review')
        quotation['lineItems'] = [{
            'id': 'review-line', 'description': 'Sample production services',
            'department': 'Audio', 'days': 1, 'quantity': 1, 'unitPrice': 1000,
        }]
        response = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json={**quotation, 'status': 'accepted'},
        )
        self.assertEqual(response.status_code, 200)
        quotation = response.get_json()['data']
        response = self.client.put(f"/api/invoice-plans/{quotation['id']}", json={
            'installments': [{
                'id': 'deposit', 'label': 'Deposit', 'mode': 'amount', 'value': amount,
            }],
        })
        self.assertEqual(response.status_code, 200)
        return quotation, response.get_json()['data']['plan']

    def issue(self, quotation):
        return self.client.post(
            f"/api/invoice-plans/{quotation['id']}/installments/deposit/issue", json={},
        )

    def test_repeated_issue_returns_existing_invoice_and_editor_plan(self):
        quotation, _ = self.create_plan()
        first = self.issue(quotation)
        self.assertEqual(first.status_code, 201)
        repeated = self.issue(quotation)
        self.assertEqual(repeated.status_code, 200)
        data = repeated.get_json()
        self.assertTrue(data['unchanged'])
        self.assertEqual(data['data']['id'], first.get_json()['data']['id'])
        self.assertEqual(data['data']['documentVersion'], first.get_json()['data']['documentVersion'])
        self.assertEqual(data['plan']['quotation']['id'], quotation['id'])
        self.assertEqual(data['plan']['plan']['installments'][0]['invoiceId'], data['data']['id'])

    def test_zero_amount_cannot_be_issued(self):
        quotation, _ = self.create_plan(amount=0)
        self.assertEqual(self.issue(quotation).status_code, 400)
        self.assertEqual(self.client.get('/api/invoices').get_json()['data'], [])

    def test_void_invoice_cannot_record_payment(self):
        quotation, _ = self.create_plan()
        invoice = self.issue(quotation).get_json()['data']
        response = self.client.put(f"/api/invoices/{invoice['id']}", json={'status': 'void'})
        self.assertEqual(response.status_code, 200)
        response = self.client.post(f"/api/invoices/{invoice['id']}/mark-paid", json={})
        self.assertEqual(response.status_code, 409)
        plan = self.client.get(f"/api/invoice-plans/{quotation['id']}").get_json()['data']['plan']
        self.assertEqual(plan['payments'], [])

    def test_payment_confirmation_rejects_changed_invoice(self):
        quotation, _ = self.create_plan()
        invoice = self.issue(quotation).get_json()['data']
        self.client.put(f"/api/invoices/{invoice['id']}", json={'reference': 'New client PO'})
        response = self.client.post(f"/api/invoices/{invoice['id']}/mark-paid", json={
            'documentVersion': invoice['documentVersion'],
        })
        self.assertEqual(response.status_code, 409)
        plan = self.client.get(f"/api/invoice-plans/{quotation['id']}").get_json()['data']['plan']
        self.assertEqual(plan['payments'], [])

    def test_delete_confirmation_rejects_newly_recorded_payment(self):
        quotation, _ = self.create_plan()
        invoice = self.issue(quotation).get_json()['data']
        self.assertEqual(self.save_payment(quotation, invoice['id']).status_code, 200)
        response = self.client.delete(f"/api/invoices/{invoice['id']}", json={
            'documentVersion': invoice['documentVersion'],
        })
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.get_json()['code'], 'document_version_conflict')
        self.assertEqual(self.client.get(f"/api/invoices/{invoice['id']}").status_code, 200)
        plan = self.client.get(f"/api/invoice-plans/{quotation['id']}").get_json()['data']['plan']
        self.assertEqual(plan['installments'][0]['invoiceId'], invoice['id'])
        self.assertEqual(plan['payments'][0]['amount'], 25)
        current = self.client.get(f"/api/invoices/{invoice['id']}").get_json()['data']
        confirmed = self.client.delete(f"/api/invoices/{invoice['id']}", json={
            'documentVersion': current['documentVersion'],
        })
        self.assertEqual(confirmed.status_code, 200)

    def save_payment(self, quotation, invoice_id, amount=25):
        return self.client.put(f"/api/invoice-plans/{quotation['id']}", json={
            'payments': [{'id': 'receipt', 'amount': amount, 'invoiceId': invoice_id, 'date': '2026-09-05'}],
        })

    def test_partial_receipt_and_removal_update_invoice_status_and_balance(self):
        quotation, _ = self.create_plan()
        invoice = self.issue(quotation).get_json()['data']
        sent = self.client.put(f"/api/invoices/{invoice['id']}", json={
            'status': 'sent', 'invoiceSentDate': '2026-09-05', 'paymentTermDays': 3650,
        }).get_json()['data']
        response = self.save_payment(quotation, invoice['id'])
        self.assertEqual(response.status_code, 200)
        current = self.client.get(f"/api/invoices/{invoice['id']}").get_json()['data']
        self.assertEqual(current['status'], 'partially-paid')
        self.assertGreater(current['documentVersion'], sent['documentVersion'])
        paid = self.client.post(f"/api/invoices/{invoice['id']}/mark-paid", json={
            'expectedAmountDue': 75,
        })
        self.assertEqual(paid.status_code, 200)
        self.assertEqual(paid.get_json()['paymentAmount'], 75)
        self.assertEqual(paid.get_json()['plan']['plan']['summary']['paid'], 100)
        response = self.client.put(f"/api/invoice-plans/{quotation['id']}", json={'payments': []})
        self.assertEqual(response.status_code, 200)
        reopened = self.client.get(f"/api/invoices/{invoice['id']}").get_json()['data']
        self.assertEqual(reopened['status'], 'sent')
        self.assertEqual(reopened['paidAt'], '')

    def test_unallocated_receipt_cannot_be_counted_twice_by_mark_paid(self):
        quotation, _ = self.create_plan()
        invoice = self.issue(quotation).get_json()['data']
        self.assertEqual(self.save_payment(quotation, '').status_code, 200)
        response = self.client.post(f"/api/invoices/{invoice['id']}/mark-paid", json={})
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.get_json()['code'], 'unallocated_payments')
        self.assertEqual(self.save_payment(quotation, invoice['id']).status_code, 200)
        response = self.client.post(f"/api/invoices/{invoice['id']}/mark-paid", json={})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()['paymentAmount'], 75)

    def test_fully_receipted_draft_changes_version_when_marked_paid(self):
        quotation, _ = self.create_plan()
        invoice = self.issue(quotation).get_json()['data']
        self.assertEqual(self.save_payment(quotation, invoice['id'], 100).status_code, 200)
        before = self.client.get(f"/api/invoices/{invoice['id']}").get_json()['data']
        self.assertEqual(before['status'], 'draft')
        response = self.client.post(f"/api/invoices/{invoice['id']}/mark-paid", json={
            'documentVersion': before['documentVersion'], 'expectedAmountDue': 0,
        })
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()['paymentAmount'], 0)
        after = self.client.get(f"/api/invoices/{invoice['id']}").get_json()['data']
        self.assertEqual(after['status'], 'paid')
        self.assertGreater(after['documentVersion'], before['documentVersion'])
        stale = self.client.put(f"/api/invoices/{invoice['id']}", json={
            'status': 'sent', 'documentVersion': before['documentVersion'],
        })
        self.assertEqual(stale.status_code, 409)

    def test_payment_cannot_be_allocated_to_another_project(self):
        quotation, _ = self.create_plan()
        other, _ = self.create_plan()
        invoice = self.issue(other).get_json()['data']
        self.assertEqual(self.save_payment(quotation, invoice['id']).status_code, 400)

    def test_installment_cannot_link_another_projects_invoice(self):
        quotation, _ = self.create_plan()
        other, _ = self.create_plan(200)
        invoice = self.issue(other).get_json()['data']
        response = self.client.put(f"/api/invoice-plans/{quotation['id']}", json={
            'installments': [{
                'id': 'deposit', 'mode': 'amount', 'value': 100,
                'invoiceId': invoice['id'], 'label': 'Wrong plan',
            }],
        })
        self.assertEqual(response.status_code, 400)
        unchanged = self.client.get(f"/api/invoices/{invoice['id']}").get_json()['data']
        self.assertEqual(unchanged['invoiceAmount'], 200)
        self.assertEqual(unchanged['invoiceLabel'], invoice['invoiceLabel'])
        self.assertEqual(unchanged['documentVersion'], invoice['documentVersion'])

    def test_installment_cannot_link_unknown_invoice(self):
        quotation, _ = self.create_plan()
        response = self.client.put(f"/api/invoice-plans/{quotation['id']}", json={
            'installments': [{
                'id': 'deposit', 'mode': 'amount', 'value': 100,
                'invoiceId': 'missing-invoice',
            }],
        })
        self.assertEqual(response.status_code, 400)
        plan = self.client.get(f"/api/invoice-plans/{quotation['id']}").get_json()['data']['plan']
        self.assertEqual(plan['installments'][0]['invoiceId'], '')

    def test_invoice_cannot_link_multiple_installments(self):
        quotation, _ = self.create_plan()
        invoice = self.issue(quotation).get_json()['data']
        response = self.client.put(f"/api/invoice-plans/{quotation['id']}", json={
            'installments': [{
                'id': 'duplicate', 'mode': 'amount', 'value': 200,
                'invoiceId': invoice['id'],
            }],
        })
        self.assertEqual(response.status_code, 400)
        plan = self.client.get(f"/api/invoice-plans/{quotation['id']}").get_json()['data']['plan']
        self.assertEqual(len(plan['installments']), 1)
        self.assertEqual(plan['installments'][0]['amount'], 100)

    def test_changed_confirmation_amounts_require_review(self):
        quotation, _ = self.create_plan()
        self.client.put(f"/api/invoice-plans/{quotation['id']}", json={
            'installments': [{'id': 'deposit', 'mode': 'amount', 'value': 200}],
        })
        response = self.client.post(
            f"/api/invoice-plans/{quotation['id']}/installments/deposit/issue",
            json={'expectedAmount': 100},
        )
        self.assertEqual(response.status_code, 409)
        invoice = self.issue(quotation).get_json()['data']
        self.save_payment(quotation, invoice['id'])
        response = self.client.post(f"/api/invoices/{invoice['id']}/mark-paid", json={'expectedAmountDue': 200})
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.get_json()['code'], 'invoice_balance_conflict')
