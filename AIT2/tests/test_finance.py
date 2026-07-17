import io
import os
import tempfile
import unittest
from datetime import datetime, timedelta
from unittest.mock import patch

from pypdf import PdfReader

import app as app_module
from data_manager import DataManager
from models import Container, Event, InventoryItem, User, hash_password


class FinanceFeatureTests(unittest.TestCase):
    def setUp(self):
        self.original_data_manager = app_module.get_default_data_manager()
        self.original_signature = app_module._data_snapshot_signature
        self.original_testing = app_module.app.config.get('TESTING')
        self.original_company_registry_file = app_module.COMPANY_REGISTRY_FILE
        self.original_company_registry_cache = app_module._company_registry_cache
        self.tempdir = tempfile.TemporaryDirectory()

        app_module.COMPANY_REGISTRY_FILE = os.path.join(self.tempdir.name, 'Companies.json')
        app_module._company_registry_cache = None
        company = app_module._new_company_record('SHOWBASE', 'Showbase Test')
        app_module._save_company_registry({
            'defaultCompany': 'SHOWBASE',
            'companies': {'SHOWBASE': company},
            'userCompanies': {
                username: 'SHOWBASE'
                for username in ('bnjm2000', 'alice', 'bob', 'no-sales', 'manager-no-sales')
            },
            'superAdmins': ['bnjm2000'],
        })

        self.data_manager = DataManager(self.tempdir.name)
        self.data_manager.setup_data_folder()
        self.data_manager.users = {
            'bnjm2000': self.make_user('bnjm2000', 'owner', True),
            'alice': self.make_user('alice', 'user', True, name='Alice Lim'),
            'bob': self.make_user('bob', 'user', True),
            'no-sales': self.make_user('no-sales', 'user', False),
            'manager-no-sales': self.make_user('manager-no-sales', 'manager', False),
        }
        self.data_manager.save_users()
        self.data_manager.logs = []
        self.data_manager.save_logs()
        self.data_manager.clients = {}
        self.data_manager.save_clients()
        self.data_manager.events = {}
        self.data_manager.inventory = {
            'AX#01': InventoryItem(
                asset_id='AX#01',
                brand='L-Acoustics',
                model_number='SB18 III',
                serial_number='SN-1',
                description='Subwoofer',
                is_missing=False,
                maintenance_logs=[],
                department_code='AX',
            ),
            'LX#01': InventoryItem(
                asset_id='LX#01',
                brand='Robe',
                model_number='Spiider',
                serial_number='SN-LX-1',
                description='LED wash fixture',
                is_missing=False,
                maintenance_logs=[],
                department_code='LX',
            ),
        }
        self.data_manager.save_inventory()
        self.data_manager.containers = {
            'CASE-1': Container('CASE-1', ['AX#01', 'LX#01'], serial_number='CASE-SN-1'),
        }
        self.data_manager.save_containers()

        app_module.app.config['TESTING'] = True
        app_module.set_data_manager_for_testing(self.data_manager)
        self.client = app_module.app.test_client()
        self.login('alice')

    def tearDown(self):
        app_module.clear_test_data_manager(self.original_data_manager)
        app_module._data_snapshot_signature = self.original_signature
        app_module.app.config['TESTING'] = self.original_testing
        app_module.COMPANY_REGISTRY_FILE = self.original_company_registry_file
        app_module._company_registry_cache = self.original_company_registry_cache
        self.tempdir.cleanup()

    def make_user(self, username, role, sales, name='', phone=''):
        return User(
            username,
            hash_password('pw', f'{username}-salt'),
            f'{username}-salt',
            role in {'owner', 'admin', 'manager'},
            True,
            role=role,
            has_sales_access=sales,
            name=name,
            phone=phone,
        )

    def login(self, username):
        user = self.data_manager.users[username]
        with self.client.session_transaction() as session:
            session.clear()
            session['user'] = username
            session['is_admin'] = bool(user.is_admin)
            session['role'] = user.role
            session['has_sales_access'] = bool(user.has_sales_access)
            session['is_super_admin'] = username == 'bnjm2000'

    def create_quote(self, project='Test Project'):
        response = self.client.post('/api/quotations', json={})
        self.assertEqual(response.status_code, 201, response.get_data(as_text=True))
        quotation = response.get_json()['data']
        if project:
            quotation['projectName'] = project
            quotation['title'] = project
            response = self.client.put(
                f"/api/quotations/{quotation['id']}",
                json=quotation,
            )
            self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
            quotation = response.get_json()['data']
        return quotation

    def test_ownership_visibility_and_unique_global_numbers(self):
        alice_quote = self.create_quote('Alice Project')
        self.assertRegex(alice_quote['number'], r'^QT-\d{4}-001-01$')
        self.assertEqual(alice_quote['createdBy'], 'alice')
        self.assertEqual(alice_quote['salesperson'], 'Alice Lim')

        self.login('bob')
        self.assertEqual(self.client.get('/api/quotations').get_json()['data'], [])
        self.assertEqual(
            self.client.get(f"/api/quotations/{alice_quote['id']}").status_code,
            404,
        )
        bob_quote = self.create_quote('Bob Project')
        self.assertRegex(bob_quote['number'], r'^QT-\d{4}-002-01$')

        self.login('bnjm2000')
        visible = self.client.get('/api/quotations').get_json()['data']
        self.assertEqual({row['id'] for row in visible}, {alice_quote['id'], bob_quote['id']})
        alice_search = self.client.get(
            '/api/quotations', query_string={'query': 'Alice Lim'}
        ).get_json()['data']
        self.assertEqual([row['id'] for row in alice_search], [alice_quote['id']])

        with open(os.path.join(os.path.dirname(app_module.__file__), 'static', 'js', 'finance.js'), encoding='utf-8') as source_file:
            source = source_file.read()
        self.assertIn("ownerView ? '<th>Salesperson</th>'", source)
        self.assertIn(
            'financeEscape(document.salespersonUsername || document.createdBy)',
            source,
        )

    def test_sent_snapshot_revision_expiry_and_statuses(self):
        quotation = self.create_quote('Revision Project')
        sent = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json={'status': 'sent', 'validityDays': 14},
        ).get_json()['data']
        self.assertEqual(sent['status'], 'sent')
        self.assertEqual(sent['revision'], 1)
        self.assertEqual(len(sent['revisions']), 1)
        self.assertTrue(sent['number'].endswith('-01'))
        self.assertEqual(sent['validityDays'], 14)
        self.assertEqual(sent['revisions'][0]['validityDays'], 14)

        sent['notes'] = 'Client requested a change'
        revised_response = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json=sent,
        )
        self.assertEqual(revised_response.status_code, 200)
        revised = revised_response.get_json()['data']
        self.assertEqual(revised['status'], 'draft')
        self.assertEqual(revised['revision'], 2)
        self.assertTrue(revised['number'].endswith('-02'))

        archived_pdf = self.client.get(
            f"/api/quotations/{quotation['id']}/pdf?revision=1"
        )
        self.assertEqual(archived_pdf.status_code, 200)

        reset = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json={'status': 'draft'},
        ).get_json()['data']
        self.assertEqual(reset['revision'], 2)
        self.assertTrue(reset['number'].endswith('-02'))
        self.assertEqual(len(reset['revisions']), 1)

        accepted = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json={'status': 'accepted'},
        ).get_json()['data']
        self.assertEqual(accepted['status'], 'accepted')
        self.assertTrue(accepted['acceptedAt'])
        invoiced = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json={'status': 'invoiced'},
        ).get_json()['data']
        self.assertEqual(invoiced['status'], 'invoiced')
        self.assertTrue(invoiced['invoicedAt'])
        paid = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json={'status': 'paid'},
        ).get_json()['data']
        self.assertEqual(paid['status'], 'paid')
        self.assertTrue(paid['paidAt'])

    def test_invoiced_status_records_due_date_and_becomes_overdue(self):
        quotation = self.create_quote('Payment Timeline Project')
        sent_date = datetime.now().date()
        sent_date_text = sent_date.strftime('%Y-%m-%d')
        due_date_text = (sent_date + timedelta(days=14)).strftime('%Y-%m-%d')
        sent = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json={'status': 'sent', 'validityDays': 30},
        ).get_json()['data']
        accepted = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json={'status': 'accepted'},
        ).get_json()['data']

        invoiced = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json={
                'status': 'invoiced',
                'invoiceSentDate': sent_date_text,
                'paymentTerms': '2 Weeks',
            },
        ).get_json()['data']
        self.assertEqual(invoiced['status'], 'invoiced')
        self.assertEqual(invoiced['invoiceSentDate'], sent_date_text)
        self.assertEqual(invoiced['paymentTermDays'], 14)
        self.assertEqual(invoiced['paymentDueDate'], due_date_text)
        self.assertTrue(invoiced['invoicedAt'].startswith(sent_date_text))
        self.assertEqual(invoiced['revision'], sent['revision'])
        self.assertEqual(invoiced['number'], sent['number'])

        finance_data = app_module._load_finance_data()
        stored = app_module._finance_find_document(
            finance_data,
            quotation['id'],
            'quotation',
        )
        stored['status'] = 'invoiced'
        stored['paymentDueDate'] = (
            datetime.now() - timedelta(days=1)
        ).strftime('%Y-%m-%d')
        app_module._save_finance_data(finance_data)

        refreshed = self.client.get(
            f"/api/quotations/{quotation['id']}"
        ).get_json()['data']
        self.assertEqual(refreshed['status'], 'overdue')

        event = self.data_manager.events[accepted['eventId']]
        listed = self.client.get('/api/quotations').get_json()['data'][0]
        self.assertEqual(listed['eventState'], event.state)
        self.assertEqual(listed['eventName'], event.name)

    def test_deleted_event_id_is_reused_without_inheriting_finance_records(self):
        quotation = self.create_quote('Reusable Event ID')
        accepted = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json={'status': 'accepted'},
        ).get_json()['data']
        event_id = accepted['eventId']
        expense_response = self.client.post(
            f'/api/finance/profit-loss/{event_id}/expenses',
            json={
                'amount': 45,
                'category': 'Transport',
                'vendor': 'Test Payee',
                'description': 'Test expense',
            },
        )
        self.assertEqual(
            expense_response.status_code,
            201,
            expense_response.get_data(as_text=True),
        )

        self.login('bnjm2000')
        deleted = self.client.delete(
            f'/api/events/{event_id}',
            json={'adminPassword': 'pw'},
        )

        self.assertEqual(deleted.status_code, 200, deleted.get_data(as_text=True))
        self.assertEqual(deleted.get_json()['financeLinksRemoved'], 1)
        self.assertEqual(deleted.get_json()['profitLossRowsRemoved'], 1)
        stored_quote = self.client.get(
            f"/api/quotations/{quotation['id']}"
        ).get_json()['data']
        self.assertIsNone(stored_quote['eventId'])
        finance_data = app_module._load_finance_data()
        self.assertNotIn(
            str(event_id),
            finance_data['profitLoss']['expenses'],
        )

        replacement = self.client.post('/api/events', json={
            'name': 'Replacement event',
            'location': 'Studio',
            'startDate': '2026-08-10',
            'endDate': '2026-08-10',
            'tag': 'events',
            'assignedUsers': [],
        })
        self.assertEqual(replacement.status_code, 200, replacement.get_data(as_text=True))
        self.assertEqual(replacement.get_json()['eventId'], event_id)

    def test_accepted_quotation_event_uses_lowest_available_id(self):
        for event_id in (1, 3):
            event = Event(
                event_id=event_id,
                name=f'Existing {event_id}',
                location='Studio',
                start_date='20260801',
                end_date='20260801',
                asset_models=[],
            )
            self.data_manager.events[event_id] = event
            self.data_manager.save_event(event)

        quotation = self.create_quote('Quotation gap event')
        accepted = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json={'status': 'accepted'},
        ).get_json()['data']

        self.assertEqual(accepted['eventId'], 2)
        self.assertEqual(self.data_manager.events[2].name, 'Quotation gap event')

    def test_expired_and_declined_cannot_be_selected_manually(self):
        quotation = self.create_quote('Automated Status Project')
        for status in ('expired', 'declined'):
            response = self.client.put(
                f"/api/quotations/{quotation['id']}",
                json={'status': status},
            )
            self.assertEqual(response.status_code, 400)

    def test_discard_draft_revision_restores_previous_sent_revision(self):
        quotation = self.create_quote('Discard Revision Project')
        quotation['notes'] = 'Original sent wording'
        sent = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json={**quotation, 'status': 'sent'},
        ).get_json()['data']
        revised = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json={**sent, 'notes': 'Unsaved client change'},
        ).get_json()['data']
        self.assertEqual((revised['revision'], revised['status']), (2, 'draft'))

        response = self.client.post(
            f"/api/quotations/{quotation['id']}/discard-revision"
        )

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        discarded = response.get_json()['data']
        self.assertEqual(discarded['status'], 'sent')
        self.assertEqual(discarded['revision'], 1)
        self.assertTrue(discarded['number'].endswith('-01'))
        self.assertEqual(discarded['notes'], 'Original sent wording')
        self.assertEqual(len(discarded['revisions']), 1)

    def test_editing_and_deleting_sent_revisions_does_not_create_new_revision(self):
        quotation = self.create_quote('Direct Revision Editing')
        sent = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json={**quotation, 'notes': 'Original revision', 'status': 'sent'},
        ).get_json()['data']

        edited_response = self.client.put(
            f"/api/quotations/{quotation['id']}/revisions/1",
            json={**sent, 'notes': 'Edited revision one'},
        )
        self.assertEqual(edited_response.status_code, 200, edited_response.get_data(as_text=True))
        edited = edited_response.get_json()['data']
        self.assertEqual((edited['revision'], edited['status']), (1, 'sent'))
        self.assertEqual(edited['notes'], 'Edited revision one')

        current = self.client.get(f"/api/quotations/{quotation['id']}").get_json()['data']
        self.assertEqual((current['revision'], current['status']), (1, 'sent'))
        self.assertEqual(current['notes'], 'Edited revision one')
        self.assertEqual(current['revisions'][0]['snapshot']['notes'], 'Edited revision one')

        draft_two = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json={**current, 'notes': 'Revision two wording'},
        ).get_json()['data']
        sent_two = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json={**draft_two, 'status': 'sent'},
        ).get_json()['data']
        self.assertEqual((sent_two['revision'], sent_two['status']), (2, 'sent'))

        old_revision_edit = self.client.put(
            f"/api/quotations/{quotation['id']}/revisions/1",
            json={**edited, 'notes': 'Revision one corrected again'},
        ).get_json()['data']
        self.assertEqual(old_revision_edit['revision'], 1)
        latest = self.client.get(f"/api/quotations/{quotation['id']}").get_json()['data']
        self.assertEqual((latest['revision'], latest['status']), (2, 'sent'))
        self.assertEqual(latest['notes'], 'Revision two wording')
        self.assertEqual(len(latest['revisions']), 2)

        deleted_old = self.client.delete(
            f"/api/quotations/{quotation['id']}/revisions/1"
        ).get_json()['data']
        self.assertEqual((deleted_old['revision'], deleted_old['status']), (2, 'sent'))
        self.assertEqual([row['revision'] for row in deleted_old['revisions']], [2])

        deleted_current = self.client.delete(
            f"/api/quotations/{quotation['id']}/revisions/2"
        ).get_json()['data']
        self.assertEqual((deleted_current['revision'], deleted_current['status']), (1, 'draft'))
        self.assertEqual(deleted_current['revisions'], [])

    def test_export_invoice_is_idempotent_and_preserves_later_quotation_statuses(self):
        quotation = self.create_quote('Invoice Export Project')
        quotation.update({
            'showUnitPrices': True,
            'showDepartmentDiscounts': True,
            'showDepartmentSubtotals': False,
            'showLineNumbers': False,
            'showSignOff': True,
            'lineItems': [{
                'id': 'invoice-export-line',
                'description': 'Technical production service',
                'department': 'Manpower',
                'departmentCode': 'MANPOWER',
                'days': 1,
                'quantity': 2,
                'uom': 'units',
                'unitPrice': 123.45,
                'discountPercent': 0,
                'subprojectId': 'main',
            }],
        })
        accepted = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json={**quotation, 'status': 'accepted'},
        ).get_json()['data']
        self.assertEqual(accepted['status'], 'accepted')

        first = self.client.post(
            f"/api/quotations/{quotation['id']}/convert-to-invoice"
        )
        self.assertEqual(first.status_code, 201, first.get_data(as_text=True))
        invoice = first.get_json()['data']
        self.assertEqual(invoice['sourceQuotationNumber'], accepted['number'])
        self.assertTrue(invoice['showUnitPrices'])
        self.assertTrue(invoice['showDepartmentDiscounts'])
        self.assertFalse(invoice['showDepartmentSubtotals'])
        self.assertFalse(invoice['showLineNumbers'])
        self.assertTrue(invoice['showSignOff'])
        invoice_pdf = self.client.get(f"/api/invoices/{invoice['id']}/pdf")
        invoice_text = '\n'.join(
            page.extract_text() or ''
            for page in PdfReader(io.BytesIO(invoice_pdf.data)).pages
        )
        self.assertIn('Ref:', invoice_text)
        self.assertNotIn('Quotation reference', invoice_text)
        self.assertIn(accepted['number'], invoice_text)
        self.assertIn('$123.45', invoice_text)
        self.assertIn('Confirmed & accepted by:', invoice_text)
        refreshed = self.client.get(
            f"/api/quotations/{quotation['id']}"
        ).get_json()['data']
        self.assertEqual(refreshed['status'], 'accepted')
        self.assertFalse(refreshed['invoicedAt'])

        quotation_list = self.client.get('/api/quotations').get_json()['data']
        listed = next(row for row in quotation_list if row['id'] == quotation['id'])
        self.assertEqual(listed['invoiceId'], invoice['id'])
        self.assertEqual(listed['invoiceNumber'], invoice['number'])
        invoice_search = self.client.get(
            '/api/quotations', query_string={'query': invoice['number']}
        ).get_json()['data']
        self.assertEqual([row['id'] for row in invoice_search], [quotation['id']])

        changed_visibility = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json={
                'showUnitPrices': False,
                'showDepartmentDiscounts': False,
                'showDepartmentSubtotals': True,
                'showLineNumbers': True,
                'showSignOff': False,
            },
        ).get_json()['data']
        self.assertFalse(changed_visibility['showUnitPrices'])

        repeated = self.client.post(
            f"/api/quotations/{quotation['id']}/convert-to-invoice"
        )
        self.assertEqual(repeated.status_code, 200, repeated.get_data(as_text=True))
        repeated_invoice = repeated.get_json()['data']
        self.assertEqual(repeated_invoice['id'], invoice['id'])
        self.assertFalse(repeated_invoice['showUnitPrices'])
        self.assertFalse(repeated_invoice['showDepartmentDiscounts'])
        self.assertTrue(repeated_invoice['showDepartmentSubtotals'])
        self.assertTrue(repeated_invoice['showLineNumbers'])
        self.assertFalse(repeated_invoice['showSignOff'])
        repeated_pdf = self.client.get(f"/api/invoices/{invoice['id']}/pdf")
        repeated_text = '\n'.join(
            page.extract_text() or ''
            for page in PdfReader(io.BytesIO(repeated_pdf.data)).pages
        )
        self.assertNotIn('$123.45', repeated_text)
        self.assertNotIn('Confirmed & accepted by:', repeated_text)

        cancelled = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json={'status': 'cancelled'},
        ).get_json()['data']
        self.assertEqual(cancelled['status'], 'cancelled')
        self.client.post(f"/api/quotations/{quotation['id']}/convert-to-invoice")
        still_cancelled = self.client.get(
            f"/api/quotations/{quotation['id']}"
        ).get_json()['data']
        self.assertEqual(still_cancelled['status'], 'cancelled')

    def test_custom_quotation_number_keeps_two_digit_revision_suffix(self):
        quotation = self.create_quote('Custom Number')
        quotation['number'] = 'CLIENT-PROPOSAL'
        quotation['customNumber'] = True
        saved = self.client.put(
            f"/api/quotations/{quotation['id']}", json=quotation
        ).get_json()['data']
        self.assertEqual(saved['number'], 'CLIENT-PROPOSAL-01')

        sent = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json={**saved, 'status': 'sent'},
        ).get_json()['data']
        sent['notes'] = 'Revised scope'
        revised = self.client.put(
            f"/api/quotations/{quotation['id']}", json=sent
        ).get_json()['data']
        self.assertEqual(revised['status'], 'draft')
        self.assertEqual(revised['revision'], 2)
        self.assertEqual(revised['number'], 'CLIENT-PROPOSAL-02')

        finance_data = app_module._load_finance_data()
        stored = app_module._finance_find_document(
            finance_data,
            quotation['id'],
            'quotation',
        )
        stored['status'] = 'sent'
        stored['validUntil'] = (
            datetime.now() - timedelta(days=1)
        ).strftime('%Y-%m-%d')
        app_module._save_finance_data(finance_data)
        listed = self.client.get('/api/quotations').get_json()['data']
        self.assertEqual(listed[0]['status'], 'expired')
        self.assertEqual(
            set(app_module.FINANCE_QUOTATION_STATUSES),
            {'draft', 'sent', 'accepted', 'expired', 'cancelled', 'invoiced', 'overdue', 'paid'},
        )

    def test_schedule_days_acceptance_creates_event_and_requirements(self):
        quotation = self.create_quote('Wedding Production')
        catalog = self.client.get('/api/finance/catalog?query=SB18').get_json()['data'][0]
        quotation.update({
            'eventLocation': 'Capella Singapore',
            'setupDate': '2026-07-17',
            'setupTime': '09:00',
            'rehearsalDate': '2026-07-18',
            'rehearsalTime': '14:00',
            'showDate': '2026-07-19',
            'showTime': '18:00',
            'teardownDate': '2026-07-20',
            'teardownTime': '23:00',
            'lineItems': [{
                **catalog,
                'id': 'inventory-line',
                'days': 4,
                'quantity': 2,
                'uom': 'units',
                'discountPercent': 0,
                'unitPrice': 180,
            }, {
                'id': 'custom-line',
                'catalogKey': '',
                'description': 'Audio Engineer',
                'department': 'Manpower',
                'departmentCode': 'MANPOWER',
                'days': 4,
                'quantity': 2,
                'uom': 'pax',
                'unitPrice': 500,
                'discountPercent': 0,
                'isCustom': True,
            }],
        })
        saved = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json=quotation,
        ).get_json()['data']
        self.assertEqual(saved['eventDays'], 4)

        self.data_manager.inventory['AX#01'].model_number = 'SB18 Renamed'
        self.data_manager.inventory['AX#01'].description = 'Renamed subwoofer'

        accepted_response = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json={'status': 'accepted'},
        )
        self.assertEqual(accepted_response.status_code, 200, accepted_response.get_data(as_text=True))
        accepted = accepted_response.get_json()['data']
        event = self.data_manager.events[accepted['eventId']]
        self.assertEqual(event.name, 'Wedding Production')
        self.assertEqual(event.location, 'Capella Singapore')
        self.assertEqual(event.start_date, '20260717')
        self.assertEqual(event.end_date, '20260720')
        self.assertEqual(
            event.prepared_items,
            ['[MODEL]AX|L-Acoustics|SB18 Renamed|2|Renamed subwoofer'],
        )
        self.assertFalse(any('Audio Engineer' in str(row) for row in event.prepared_items))
        self.assertFalse(any(str(row).startswith('[CUSTOM]') for row in event.prepared_items))

        accepted_again = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json={'status': 'accepted'},
        ).get_json()['data']
        self.assertEqual(accepted_again['eventId'], accepted['eventId'])
        self.assertEqual(len(self.data_manager.events), 1)

        accepted_again['lineItems'][0]['quantity'] = 3
        synced_quote = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json=accepted_again,
        ).get_json()['data']
        self.assertTrue(synced_quote['eventManagedByQuotation'])
        self.assertEqual(
            event.prepared_items,
            ['[MODEL]AX|L-Acoustics|SB18 Renamed|3|Renamed subwoofer'],
        )

        event.prepared_items.append('[MODEL]AX|Manual|Asset|1|Manually planned item')
        synced_quote['lineItems'][0]['quantity'] = 4
        stopped_sync = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json=synced_quote,
        ).get_json()['data']
        self.assertFalse(stopped_sync['eventManagedByQuotation'])
        self.assertIn('[MODEL]AX|Manual|Asset|1|Manually planned item', event.prepared_items)
        self.assertNotIn('[MODEL]AX|L-Acoustics|SB18 Renamed|4|Renamed subwoofer', event.prepared_items)

        del self.data_manager.events[accepted['eventId']]
        unlinked_after_delete = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json=stopped_sync,
        ).get_json()['data']
        self.assertIsNone(unlinked_after_delete['eventId'])

        paired_event = Event(
            event_id=99,
            name='Existing Event',
            location='Existing Hall',
            start_date='20260721',
            end_date='20260721',
            asset_models=[],
            prepared_items=['[MODEL]AX|Existing|Model|1|Existing item'],
            returned_items=[],
            actually_prepared=[],
            extra_assets=[],
            assigned_users=['alice'],
        )
        self.data_manager.events[99] = paired_event
        paired_quote = self.create_quote('Paired Production')
        paired_quote['eventId'] = 99
        paired_quote['lineItems'] = saved['lineItems']
        paired_saved = self.client.put(
            f"/api/quotations/{paired_quote['id']}",
            json=paired_quote,
        ).get_json()['data']
        self.assertEqual(paired_saved['eventId'], 99)
        paired_accepted = self.client.put(
            f"/api/quotations/{paired_quote['id']}",
            json={'status': 'accepted'},
        ).get_json()['data']
        self.assertEqual(paired_accepted['eventId'], 99)
        self.assertEqual(len(self.data_manager.events), 1)
        self.assertEqual(
            self.data_manager.events[99].prepared_items,
            ['[MODEL]AX|Existing|Model|1|Existing item'],
        )

        paired_saved['eventId'] = None
        unpaired = self.client.put(
            f"/api/quotations/{paired_quote['id']}",
            json=paired_saved,
        ).get_json()['data']
        self.assertIsNone(unpaired['eventId'])

    def test_asset_price_survives_rename_and_custom_typo_is_not_retained(self):
        quotation = self.create_quote('Price Memory')
        catalog = self.client.get('/api/finance/catalog?query=SB18').get_json()['data'][0]
        quotation['lineItems'] = [{
            **catalog,
            'id': 'inventory-line',
            'days': 1,
            'quantity': 1,
            'uom': 'units',
            'unitPrice': 321,
            'discountPercent': 0,
        }, {
            'id': 'custom-line',
            'catalogKey': '',
            'description': 'Speclal Operator Typo',
            'department': 'Manpower',
            'days': 1,
            'quantity': 1,
            'uom': 'pax',
            'unitPrice': 99,
            'discountPercent': 0,
            'isCustom': True,
        }]
        saved = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json=quotation,
        ).get_json()['data']

        self.data_manager.inventory['AX#01'].model_number = 'SB18 Renamed'
        self.data_manager.inventory['AX#01'].description = 'Renamed subwoofer'
        self.data_manager.save_inventory()
        renamed = self.client.get(
            '/api/finance/catalog?query=Renamed'
        ).get_json()['data'][0]
        self.assertEqual(renamed['unitPrice'], 321)
        self.assertEqual(renamed['uom'], 'units')

        custom_results = self.client.get(
            '/api/finance/catalog?query=Speclal'
        ).get_json()['data']
        self.assertEqual(custom_results[0]['unitPrice'], 99)
        saved['lineItems'] = [
            row for row in saved['lineItems']
            if row['description'] != 'Speclal Operator Typo'
        ]
        self.client.put(
            f"/api/quotations/{quotation['id']}",
            json=saved,
        )
        removed_results = self.client.get(
            '/api/finance/catalog?query=Speclal'
        ).get_json()['data']
        self.assertEqual(removed_results, [])

    def test_container_catalog_expands_to_priced_child_items(self):
        quotation = self.create_quote('Container Price Memory')
        catalog = self.client.get('/api/finance/catalog?query=SB18').get_json()['data'][0]
        quotation['lineItems'] = [{
            **catalog,
            'id': 'inventory-line',
            'days': 1,
            'quantity': 1,
            'uom': 'units',
            'unitPrice': 444,
            'discountPercent': 0,
        }]
        self.client.put(
            f"/api/quotations/{quotation['id']}",
            json=quotation,
        )

        container_results = self.client.get(
            '/api/finance/catalog?query=CASE-1'
        ).get_json()['data']
        container = next(row for row in container_results if row.get('isContainer'))
        self.assertEqual(container['containerId'], 'CASE-1')
        self.assertGreaterEqual(len(container['containerItems']), 2)
        audio_child = next(
            row for row in container['containerItems']
            if 'AX#01' in row.get('sourceAssetIds', [])
        )
        self.assertEqual(audio_child['unitPrice'], 444)
        self.assertEqual(audio_child['containerQuantity'], 1)

    def test_catalog_and_rate_card_search_inventory_tags_without_displaying_them(self):
        self.data_manager.inventory['AX#01'].tags = ['low-end', 'wireless']
        self.data_manager.save_inventory()

        catalog_rows = self.client.get(
            '/api/finance/catalog', query_string={'query': 'wireless'},
        ).get_json()['data']
        inventory_row = next(row for row in catalog_rows if not row.get('isContainer'))
        self.assertEqual(inventory_row['model'], 'SB18 III')
        self.assertTrue(any(row.get('isContainer') for row in catalog_rows))
        self.assertNotIn('tags', inventory_row)

        quotation = self.create_quote('Tagged Rate Card')
        quotation['lineItems'] = [{
            **inventory_row,
            'id': 'tagged-rate', 'days': 1, 'quantity': 1,
            'unitPrice': 444, 'discountPercent': 0,
        }]
        saved = self.client.put(
            f"/api/quotations/{quotation['id']}", json=quotation,
        )
        self.assertEqual(saved.status_code, 200, saved.get_data(as_text=True))

        rate_rows = self.client.get(
            '/api/finance/rate-card', query_string={'query': 'wireless'},
        ).get_json()['data']
        self.assertEqual(len(rate_rows), 1)
        self.assertEqual(rate_rows[0]['model'], 'SB18 III')
        self.assertEqual(rate_rows[0]['searchTags'], ['low-end', 'wireless'])

    def test_rate_card_lists_remembered_inventory_and_custom_items_by_user(self):
        quotation = self.create_quote('Rate Card Memory')
        inventory_line = self.client.get('/api/finance/catalog?query=SB18').get_json()['data'][0]
        quotation['lineItems'] = [
            {
                **inventory_line,
                'id': 'inventory-rate', 'days': 1, 'quantity': 1,
                'unitPrice': 444, 'discountPercent': 0,
            },
            {
                'id': 'custom-rate', 'catalogKey': '', 'sourceAssetIds': [],
                'description': 'Special projection operator',
                'department': 'Manpower', 'departmentCode': '',
                'days': 1, 'quantity': 1, 'uom': 'pax',
                'unitPrice': 325, 'discountPercent': 0, 'isCustom': True,
            },
        ]
        saved = self.client.put(
            f"/api/quotations/{quotation['id']}", json=quotation,
        )
        self.assertEqual(saved.status_code, 200, saved.get_data(as_text=True))

        rows = self.client.get('/api/finance/rate-card').get_json()['data']
        by_description = {row['description']: row for row in rows}
        inventory_rate = next(
            row for row in rows if row.get('catalogKey') == inventory_line['catalogKey']
        )
        self.assertEqual(inventory_rate['brand'], 'L-Acoustics')
        self.assertEqual(inventory_rate['model'], 'SB18 III')
        self.assertEqual(inventory_rate['description'], 'Subwoofer')
        self.assertEqual(inventory_rate['unitPrice'], 444)
        self.assertEqual(by_description['Special projection operator']['unitPrice'], 325)
        self.assertEqual(by_description['Special projection operator']['uom'], 'pax')
        self.assertEqual(
            rows,
            sorted(rows, key=lambda row: (
                row['department'].casefold(),
                ' '.join((row['brand'], row['model'], row['description'])).casefold(),
            )),
        )

        self.login('bob')
        self.assertEqual(self.client.get('/api/finance/rate-card').get_json()['data'], [])

    def test_rate_card_accepts_new_unique_items_and_updates_rates(self):
        created = self.client.post('/api/finance/rate-card', json={
            'brand': 'disguise',
            'model': 'gx 3',
            'description': 'Freelance media server programmer',
            'department': 'Specialist Crew',
            'unitPrice': 650,
            'uom': 'pax',
        })
        self.assertEqual(created.status_code, 200, created.get_data(as_text=True))
        row = next(
            item for item in created.get_json()['data']
            if item['description'] == 'Freelance media server programmer'
        )
        self.assertTrue(row['isCustom'])
        self.assertEqual(row['brand'], 'disguise')
        self.assertEqual(row['model'], 'gx 3')
        self.assertEqual(row['department'], 'Specialist Crew')

        updated = self.client.post('/api/finance/rate-card', json={
            **row,
            'unitPrice': 725,
        })
        self.assertEqual(updated.status_code, 200, updated.get_data(as_text=True))
        searched = self.client.get(
            '/api/finance/rate-card', query_string={'query': 'media server'},
        ).get_json()['data']
        self.assertEqual(len(searched), 1)
        self.assertEqual(searched[0]['unitPrice'], 725)

        deleted = self.client.delete('/api/finance/rate-card', json=searched[0])
        self.assertEqual(deleted.status_code, 200, deleted.get_data(as_text=True))
        searched = self.client.get(
            '/api/finance/rate-card', query_string={'query': 'media server'},
        ).get_json()['data']
        self.assertEqual(searched, [])

    def test_rate_card_inventory_price_update_reuses_catalog_row_and_aliases(self):
        quotation = self.create_quote('Rate Card Asset Update')
        inventory_line = self.client.get('/api/finance/catalog?query=SB18').get_json()['data'][0]
        quotation['lineItems'] = [{
            **inventory_line,
            'id': 'inventory-rate-update',
            'days': 1,
            'quantity': 1,
            'unitPrice': 444,
            'discountPercent': 0,
        }]
        saved = self.client.put(f"/api/quotations/{quotation['id']}", json=quotation)
        self.assertEqual(saved.status_code, 200, saved.get_data(as_text=True))

        row = next(
            item for item in self.client.get('/api/finance/rate-card').get_json()['data']
            if item.get('catalogKey') == inventory_line['catalogKey']
        )
        updated = self.client.post('/api/finance/rate-card', json={**row, 'unitPrice': 555})
        self.assertEqual(updated.status_code, 200, updated.get_data(as_text=True))
        matching = [
            item for item in updated.get_json()['data']
            if item.get('catalogKey') == inventory_line['catalogKey']
        ]
        self.assertEqual(len(matching), 1)
        self.assertEqual(matching[0]['unitPrice'], 555)
        catalog_row = self.client.get('/api/finance/catalog?query=SB18').get_json()['data'][0]
        self.assertEqual(catalog_row['unitPrice'], 555)

    def test_rate_card_migrates_legacy_asset_key_before_catalog_lookup(self):
        quotation = self.create_quote('Legacy Rate Card Asset')
        quotation['lineItems'] = [{
            'id': 'legacy-inventory-rate',
            'catalogKey': 'ax|l-acoustics|sb18 iii|subwoofer',
            'sourceAssetIds': [],
            'brand': 'l-acoustics',
            'model': 'sb18 iii',
            'description': 'L-Acoustics SB18 III Subwoofer',
            'department': 'Audio Department',
            'departmentCode': 'AX',
            'days': 1,
            'quantity': 1,
            'uom': 'units',
            'unitPrice': 444,
            'discountPercent': 0,
        }]
        saved = self.client.put(f"/api/quotations/{quotation['id']}", json=quotation)
        self.assertEqual(saved.status_code, 200, saved.get_data(as_text=True))

        row = next(
            item for item in self.client.get('/api/finance/rate-card').get_json()['data']
            if item.get('model') == 'SB18 III'
        )
        self.assertEqual(row['catalogKey'], 'inventory:ax|l-acoustics|sb18 iii')
        self.assertEqual(row['description'], 'Subwoofer')
        updated = self.client.post('/api/finance/rate-card', json={**row, 'unitPrice': 575})
        self.assertEqual(updated.status_code, 200, updated.get_data(as_text=True))

        catalog_row = self.client.get('/api/finance/catalog?query=SB18').get_json()['data'][0]
        self.assertEqual(catalog_row['unitPrice'], 575)

    def test_rate_card_replaces_subproject_visibility_toggle(self):
        project_root = os.path.dirname(os.path.dirname(__file__))
        with open(
            os.path.join(project_root, 'static', 'js', 'finance.js'),
            encoding='utf-8',
        ) as source_file:
            source = source_file.read()

        self.assertNotIn('financeToggleSubprojectView', source)
        self.assertNotIn('financeState.showSubprojects', source)
        self.assertIn('Show rate card', source)
        self.assertIn('function financeOpenRateCard()', source)
        self.assertIn('function financeDeleteRateCardItem(index)', source)
        self.assertIn('financeRateCardBrand', source)
        self.assertIn('financeRateCardModel', source)
        self.assertIn('financeRenderSubprojectTabs()', source)

    def test_line_total_discount_can_raise_or_lower_total(self):
        quotation = self.create_quote('Editable Line Total')
        quotation['lineItems'] = [{
            'id': 'line-1',
            'catalogKey': '',
            'description': 'Audio package',
            'department': 'Audio Department',
            'departmentCode': 'AX',
            'days': 2,
            'quantity': 3,
            'uom': 'units',
            'unitPrice': 100,
            'discountPercent': 50,
            'isCustom': True,
        }]
        discounted = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json=quotation,
        ).get_json()['data']
        self.assertEqual(discounted['lineItems'][0]['total'], 300)

        discounted['lineItems'][0]['discountPercent'] = -25
        raised = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json=discounted,
        ).get_json()['data']
        self.assertEqual(raised['lineItems'][0]['discountPercent'], -25)
        self.assertEqual(raised['lineItems'][0]['total'], 750)

    def test_selected_department_name_overrides_stale_department_code(self):
        quotation = self.create_quote('Department Canonicalisation')
        quotation['lineItems'] = [{
            'id': 'line-lighting',
            'catalogKey': 'inventory:lx|robe|spiider',
            'description': 'Lighting fixture',
            'department': 'Lighting Department',
            'departmentCode': 'AX',
            'days': 1,
            'quantity': 1,
            'uom': 'units',
            'unitPrice': 100,
            'discountPercent': 0,
        }]

        response = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json=quotation,
        )

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        line = response.get_json()['data']['lineItems'][0]
        self.assertEqual(line['department'], 'Lighting Department')
        self.assertEqual(line['departmentCode'], 'LX')

    def test_free_typed_department_name_remains_custom(self):
        quotation = self.create_quote('Custom Department')
        quotation['lineItems'] = [{
            'id': 'line-custom-department',
            'catalogKey': '',
            'description': 'Custom work',
            'department': 'lig',
            'departmentCode': '',
            'days': 1,
            'quantity': 1,
            'uom': 'units',
            'unitPrice': 100,
            'discountPercent': 0,
            'isCustom': True,
        }]

        response = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json=quotation,
        )

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertEqual(response.get_json()['data']['lineItems'][0]['department'], 'lig')

    def test_department_suggestion_selection_suppresses_stale_change_event(self):
        project_root = os.path.dirname(os.path.dirname(__file__))
        with open(
            os.path.join(project_root, 'static', 'js', 'finance.js'),
            encoding='utf-8',
        ) as source_file:
            source = source_file.read()

        self.assertIn("input.dataset.departmentSelectionCommitted = 'true'", source)
        self.assertIn("line.departmentCode = ''", source)
        self.assertIn('function financeCommitDepartmentInput(index, input)', source)

    def test_locked_pre_gst_total_applies_total_discount_and_exports(self):
        quotation = self.create_quote('Locked Total')
        quotation['lineItems'] = [{
            'id': 'line-1',
            'catalogKey': '',
            'description': 'Operator',
            'department': 'Manpower',
            'days': 1,
            'quantity': 1,
            'uom': 'pax',
            'unitPrice': 1000,
            'discountPercent': 0,
            'isCustom': True,
        }]
        quotation['totalLocked'] = True
        quotation['lockedPreTaxTotal'] = 900
        saved = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json=quotation,
        ).get_json()['data']
        self.assertEqual(saved['totals']['netSubtotal'], 900)
        self.assertEqual(saved['totals']['lockDifference'], 0)
        total_adjustment = next(row for row in saved['adjustments'] if row['scope'] == 'total')
        self.assertEqual(total_adjustment['amount'], -100)
        self.assertIn('total discount', total_adjustment['label'])
        exported = self.client.get(f"/api/quotations/{quotation['id']}/pdf")
        self.assertEqual(exported.status_code, 200)
        self.assertTrue(exported.headers.get('Content-Disposition', '').lower().startswith('inline'))
        downloaded = self.client.get(f"/api/quotations/{quotation['id']}/pdf?download=1")
        self.assertTrue(downloaded.headers.get('Content-Disposition', '').lower().startswith('attachment'))
        saved['taxRate'] = 0
        zero_tax = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json=saved,
        ).get_json()['data']
        zero_tax_pdf = self.client.get(f"/api/quotations/{quotation['id']}/pdf").data
        zero_tax_text = '\n'.join(page.extract_text() or '' for page in PdfReader(io.BytesIO(zero_tax_pdf)).pages)
        self.assertNotIn('Total before GST', zero_tax_text)
        self.assertNotIn('GST (0%)', zero_tax_text)
        self.assertIn('TOTAL', zero_tax_text)
        self.assertIn('$900.00', zero_tax_text)
        saved = zero_tax

        saved['totalLocked'] = False
        unlocked = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json=saved,
        ).get_json()['data']
        self.assertEqual(unlocked['adjustments'], [])
        self.assertIsNone(unlocked['lockedPreTaxTotal'])
        self.assertEqual(unlocked['totals']['netSubtotal'], 1000)

        unlocked['adjustments'] = [{
            'id': 'adjustment_legacy',
            'scope': 'total',
            'department': '',
            'label': '10% overall discount',
            'amount': -100,
            'percent': 10,
            'kind': 'discount',
            'lockedTotalAdjustment': False,
        }]
        legacy_cleaned = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json=unlocked,
        ).get_json()['data']
        self.assertEqual(legacy_cleaned['adjustments'], [])
        self.assertEqual(legacy_cleaned['totals']['netSubtotal'], 1000)

    def test_pdf_columns_visibility_name_order_and_department_page_repeats(self):
        quotation = self.create_quote('Long Audio Quote')
        quotation['client'] = {
            'name': 'Edgar Tan',
            'company': 'Patricia & Edgar Pte Ltd',
        }
        quotation['lineItems'] = [{
            'id': f'line-{index}',
            'catalogKey': '',
            'description': f'Audio item {index}',
            'department': 'Audio Department',
            'departmentCode': 'AX',
            'days': 1,
            'quantity': 2,
            'uom': 'units',
            'unitPrice': 123.45,
            'discountPercent': 0,
            'isCustom': True,
        } for index in range(1, 66)]
        quotation['adjustments'] = [{
            'id': 'discount',
            'scope': 'department',
            'department': 'Audio Department',
            'label': '10% department discount',
            'amount': -1604.85,
            'percent': 10,
            'kind': 'discount',
        }]
        saved = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json=quotation,
        ).get_json()['data']
        hidden_pdf = self.client.get(f"/api/quotations/{quotation['id']}/pdf").data
        hidden_reader = PdfReader(io.BytesIO(hidden_pdf))
        hidden_text = '\n'.join(page.extract_text() or '' for page in hidden_reader.pages)
        hidden_last_page_text = hidden_reader.pages[-1].extract_text() or ''
        self.assertIn('DESCRIPTION', hidden_text)
        self.assertIn('UNIT PRICE', hidden_text)
        self.assertNotIn('$123.45', hidden_text)
        self.assertNotIn('10% department discount', hidden_text)
        self.assertLess(hidden_text.index('Edgar Tan'), hidden_text.index('Patricia & Edgar Pte Ltd'))
        self.assertGreaterEqual(len(hidden_reader.pages), 2)
        self.assertIn('DEPARTMENT SUMMARY', hidden_last_page_text)
        self.assertIn('Audio Department', hidden_last_page_text)
        self.assertIn('TOTAL', hidden_last_page_text)
        self.assertNotIn('Audio item 65', hidden_last_page_text)
        for page in hidden_reader.pages:
            page_text = page.extract_text() or ''
            if 'Audio item ' in page_text:
                self.assertIn('Audio Department', page_text)
                self.assertIn('DESCRIPTION', page_text)
                self.assertNotIn('DEPARTMENT', page_text)

        saved['showDepartmentSubtotals'] = False
        self.client.put(
            f"/api/quotations/{quotation['id']}",
            json=saved,
        )
        total_only_pdf = self.client.get(f"/api/quotations/{quotation['id']}/pdf").data
        total_only_text = '\n'.join(page.extract_text() or '' for page in PdfReader(io.BytesIO(total_only_pdf)).pages)
        self.assertNotIn('DESCRIPTION', total_only_text)
        self.assertNotIn('Audio item 1', total_only_text)

        saved['showUnitPrices'] = True
        saved['showDepartmentSubtotals'] = True
        saved['showDepartmentDiscounts'] = True
        self.client.put(
            f"/api/quotations/{quotation['id']}",
            json=saved,
        )
        visible_pdf = self.client.get(f"/api/quotations/{quotation['id']}/pdf").data
        visible_text = '\n'.join(page.extract_text() or '' for page in PdfReader(io.BytesIO(visible_pdf)).pages)
        self.assertIn('$123.45', visible_text)
        self.assertIn('10% department discount', visible_text)

    def test_pdf_does_not_insert_blank_page_before_boundary_summary(self):
        from quotation_pdf import build_finance_pdf

        quotation = self.create_quote('SLMA: In Relation')
        quotation.update({
            'client': {'name': 'Clarisse Ng'},
            'quotationDate': '2026-07-14',
            'eventLocation': 'Drama Centre Black Box',
            'setupDate': '2026-08-17',
            'rehearsalDate': '2026-08-20',
            'showDate': '2026-08-21',
            'additionalShows': [{'id': 'show-2', 'date': '2026-08-22', 'time': ''}],
            'teardownDate': '2026-08-22',
            'showUnitPrices': False,
            'showDepartmentSubtotals': True,
            'showLineNumbers': True,
            'terms': app_module.DEFAULT_FINANCE_TERMS,
        })
        rows = [
            ('Inter-connecting cables, accessories, etc', 'Audio Department', 6, 1, 'lot', 0),
            ('Panasonic PT-DZ770 1-chip FHD DLP projector 7000 ANSI lumens', 'Video Department', 1.5, 1, 'units', 750),
            ('Panasonic ET-D75LE10 1.3 - 1.7:1 zoom lens', 'Video Department', 1.5, 1, 'units', 250),
            ('Panasonic ET-D75LE6 0.9 - 1.1:1 zoom lens', 'Video Department', 1.5, 1, 'units', 250),
            ('Inter-connecting cables, accessories, etc', 'Video Department', 1.5, 1, 'lot', 0),
            ('Audio Assistant (A2)', 'Manpower', 6, 2, 'pax', 250),
            ('AV Technician for setup/teardown', 'Manpower', 2, 1, 'pax', 200),
            ("10' covered lorry c/w hydraulic tailgate & driver", 'Transportation', 2, 1, 'units', 100),
        ]
        quotation['lineItems'] = [{
            'id': f'boundary-{index}',
            'catalogKey': '',
            'description': description,
            'department': department,
            'departmentCode': '',
            'days': days,
            'quantity': quantity,
            'uom': uom,
            'unitPrice': rate,
            'discountPercent': 0,
            'isCustom': True,
        } for index, (description, department, days, quantity, uom, rate) in enumerate(rows, 1)]
        saved = self.client.put(
            f"/api/quotations/{quotation['id']}", json=quotation,
        ).get_json()['data']
        company = {
            'companyName': 'Avec Vision Private Limited',
            'billingAddress': '601 Sims Drive, PAN-I Complex #04-10, Singapore 387382',
            'footerText': 'AVEC VISION PRIVATE LIMITED | 601 SIMS DRIVE PAN-I COMPLEX #04-10 SINGAPORE 387382',
            'currency': 'SGD',
            'taxLabel': 'GST',
            'themeColor': '#1d90d7',
            'bankName': 'OCBC Bank Limited',
            'bankAccountName': 'Avec Vision Pte Ltd',
            'bankAccountNumber': '601 - 546195 - 001',
        }

        reader = PdfReader(io.BytesIO(build_finance_pdf(saved, company)))
        quotation_text = '\n'.join(page.extract_text() or '' for page in reader.pages)
        self.assertNotIn('PAYMENT DETAILS', quotation_text)
        invoice_reader = PdfReader(io.BytesIO(build_finance_pdf({
            **saved,
            'type': 'invoice',
            'number': 'INV-2026-001',
            'invoiceDate': '2026-08-01',
            'sourceQuotationNumber': saved['number'],
        }, company)))
        invoice_text = '\n'.join(page.extract_text() or '' for page in invoice_reader.pages)
        self.assertIn('PAYMENT DETAILS', invoice_text)
        self.assertIn('601 - 546195 - 001', invoice_text)
        self.assertEqual(len(reader.pages), 2)
        self.assertIn('LINE ITEMS', reader.pages[0].extract_text() or '')
        self.assertIn('DEPARTMENT SUMMARY', reader.pages[1].extract_text() or '')
        for page in reader.pages:
            text = page.extract_text() or ''
            self.assertTrue(any(marker in text for marker in (
                'QUOTATION', 'LINE ITEMS', 'DESCRIPTION',
                'DEPARTMENT SUMMARY', 'TERMS AND CONDITIONS',
            )), text)

    def test_incomplete_draft_default_departments_and_permissions(self):
        blank = self.create_quote(project='')
        saved_blank = self.client.put(
            f"/api/quotations/{blank['id']}",
            json={'notes': 'Cannot save yet'},
        )
        self.assertEqual(saved_blank.status_code, 200)
        self.assertEqual(saved_blank.get_json()['data']['notes'], 'Cannot save yet')

        loaded = self.client.get(
            f"/api/quotations/{blank['id']}"
        ).get_json()['data']
        self.assertEqual(loaded['departments'], [])
        departments = self.client.get('/api/finance/departments').get_json()['data']
        self.assertIn('Manpower', departments)
        self.assertIn('Transportation', departments)

        quote = self.create_quote('Department Cleanup')
        quote['departments'] = ['Audio Department', 'M', 'Ma', 'Man', 'Manpower']
        quote['lineItems'] = [{
            'id': 'line-1',
            'catalogKey': '',
            'description': 'Console',
            'department': 'Audio Department',
            'departmentCode': 'AX',
            'days': 1,
            'quantity': 1,
            'uom': 'units',
            'unitPrice': 100,
            'discountPercent': 0,
            'isCustom': True,
        }]
        cleaned = self.client.put(
            f"/api/quotations/{quote['id']}",
            json=quote,
        ).get_json()['data']
        self.assertEqual(cleaned['departments'], ['Audio Department'])

        with self.client.session_transaction() as session:
            session.clear()
        self.assertEqual(self.client.get('/api/quotations').status_code, 401)

        self.login('no-sales')
        response = self.client.get('/api/quotations')
        self.assertEqual(response.status_code, 403)
        self.assertIn('Sales access required', response.get_json()['error'])

    def test_profit_loss_expense_upload_extracts_amount_and_date(self):
        event = Event(
            event_id=131,
            name='Wedding of Patricia & Edgar',
            location='Capella Singapore',
            start_date='20260530',
            end_date='20260530',
            asset_models=[],
            prepared_items=[],
            returned_items=[],
            actually_prepared=[],
            extra_assets=[],
            assigned_users=['alice'],
        )
        self.data_manager.events[131] = event
        quotation = self.create_quote('Wedding of Patricia & Edgar')
        quotation['eventId'] = 131
        quotation['lineItems'] = [{
            'id': 'audio-package',
            'catalogKey': '',
            'description': 'Audio package',
            'department': 'Audio Department',
            'departmentCode': 'AX',
            'days': 1,
            'quantity': 1,
            'uom': 'lot',
            'unitPrice': 1000,
            'discountPercent': 0,
            'isCustom': True,
        }]
        self.client.put(f"/api/quotations/{quotation['id']}", json=quotation)

        png_bytes = b'\x89PNG\r\n\x1a\nreceipt text is mocked'
        with patch.object(app_module, 'extract_claim_amount', return_value={
            'amount': 123.45,
            'date': '2026-05-29',
            'confidence': 'high',
            'source': 'test',
        }):
            response = self.client.post(
                '/api/finance/profit-loss/131/expenses',
                data={
                    'description': 'Crew meal',
                    'category': 'Meal Claims',
                    'vendor': 'Yummy Catering',
                    'file': (io.BytesIO(png_bytes), 'crew-meal.png'),
                },
                content_type='multipart/form-data',
            )
        self.assertEqual(response.status_code, 201, response.get_data(as_text=True))
        payload = response.get_json()['data']
        self.assertEqual(payload['summary']['revenue'], 1000)
        self.assertEqual(payload['summary']['manualOtherExpenses'], 123.45)
        expense = payload['expenses'][0]
        self.assertEqual(expense['amount'], 123.45)
        self.assertEqual(expense['expenseDate'], '2026-05-29')
        self.assertIn('/api/finance/profit-loss/expenses/', expense['attachment']['previewUrl'])
        file_response = self.client.get(expense['attachment']['previewUrl'])
        self.assertEqual(file_response.status_code, 200)

    def test_repeatable_schedule_rows_extend_event_and_pdf(self):
        quotation = self.create_quote('Multi-day Show')
        quotation.update({
            'setupDate': '2026-08-01',
            'showDate': '2026-08-02',
            'teardownDate': '2026-08-03',
            'additionalShows': [{'id': 'show-2', 'date': '2026-08-04', 'time': '19:30'}],
            'additionalTeardowns': [{'id': 'tear-2', 'date': '2026-08-05', 'time': '23:00'}],
        })
        saved = self.client.put(
            f"/api/quotations/{quotation['id']}", json=quotation,
        ).get_json()['data']
        self.assertEqual(saved['eventDays'], 5)
        self.assertEqual(saved['additionalShows'][0]['date'], '2026-08-04')

        pdf = self.client.get(f"/api/quotations/{quotation['id']}/pdf").data
        text = '\n'.join(page.extract_text() or '' for page in PdfReader(io.BytesIO(pdf)).pages)
        self.assertIn('Show:', text)
        self.assertNotIn('Show 2:', text)
        self.assertIn('Teardown:', text)
        self.assertNotIn('Teardown 2:', text)

        accepted = self.client.put(
            f"/api/quotations/{quotation['id']}", json={'status': 'accepted'},
        ).get_json()['data']
        event = self.data_manager.events[accepted['eventId']]
        self.assertEqual(event.start_date, '20260801')
        self.assertEqual(event.end_date, '20260805')

    def test_salutation_timed_schedule_manpower_default_and_pdf_signoff(self):
        self.data_manager.users['alice'].phone = '+65 9123 4567'
        self.data_manager.save_users()
        quotation = self.create_quote('Signed Evening Event')
        quotation.update({
            'client': {
                'salutation': 'Ms.',
                'name': 'Clarisse Ng',
                'company': 'Example Events',
            },
            'salesperson': 'Alice Lim',
            'salespersonUsername': 'alice',
            'setupDate': '2026-10-07',
            'setupTime': '20:00',
            'showSignOff': True,
            'lineItems': [{
                'id': 'manpower-default-uom',
                'catalogKey': '',
                'description': 'Show technician',
                'department': 'Manpower',
                'departmentCode': 'MANPOWER',
                'days': 1,
                'quantity': 1,
                'unitPrice': 200,
                'discountPercent': 0,
                'isCustom': True,
            }],
        })
        saved = self.client.put(
            f"/api/quotations/{quotation['id']}", json=quotation,
        ).get_json()['data']

        self.assertEqual(saved['client']['salutation'], 'Ms.')
        self.assertEqual(saved['lineItems'][0]['uom'], 'pax')
        self.assertTrue(saved['showSignOff'])
        exported = self.client.get(f"/api/quotations/{quotation['id']}/pdf").data
        reader = PdfReader(io.BytesIO(exported))
        text = '\n'.join(page.extract_text() or '' for page in reader.pages)
        last_page_text = reader.pages[-1].extract_text() or ''
        self.assertIn('Ms. Clarisse Ng', text)
        self.assertIn('7 October 2026, 20:00hrs', text)
        self.assertIn('Quoted by:', last_page_text)
        self.assertIn('Alice Lim', last_page_text)
        self.assertIn('Mobile: +65 9123 4567', last_page_text)
        self.assertIn(f"Quote Ref: {saved['number']}", last_page_text)
        self.assertIn('Confirmed & accepted by:', last_page_text)
        self.assertIn('(Authorised Signature / Date / Co. Stamp)', last_page_text)

        saved['client']['salutation'] = 'Dr.'
        invalid = self.client.put(
            f"/api/quotations/{quotation['id']}", json=saved,
        ).get_json()['data']
        self.assertEqual(invalid['client']['salutation'], '')

    def test_salesperson_suggestions_are_same_company_and_custom_names_remain_valid(self):
        self.data_manager.users['alice'].phone = '+65 9123 4567'
        self.data_manager.save_users()
        suggestions = self.client.get('/api/finance/salespeople')
        self.assertEqual(suggestions.status_code, 200, suggestions.get_data(as_text=True))
        rows = {row['username']: row for row in suggestions.get_json()['data']}
        self.assertEqual(rows['alice']['name'], 'Alice Lim')
        self.assertEqual(rows['alice']['phone'], '+65 9123 4567')

        quotation = self.create_quote('Custom Salesperson')
        saved = self.client.put(f"/api/quotations/{quotation['id']}", json={
            'salesperson': 'External Sales Partner',
            'salespersonUsername': '',
        }).get_json()['data']
        self.assertEqual(saved['salesperson'], 'External Sales Partner')
        self.assertEqual(saved['salespersonUsername'], '')

    def test_saved_client_salutation_round_trips_through_csv(self):
        response = self.client.post('/api/clients', json={
            'salutation': 'Mrs.',
            'name': 'Jane Tan',
            'company': 'Example Pte Ltd',
        })
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertEqual(response.get_json()['data']['salutation'], 'Mrs.')

        reloaded = DataManager(self.tempdir.name)
        reloaded.load_clients()
        self.assertEqual(reloaded.clients['Jane Tan'].salutation, 'Mrs.')

    def test_editor_pairs_setup_teardown_then_rehearsal_show(self):
        project_root = os.path.dirname(os.path.dirname(__file__))
        with open(
            os.path.join(project_root, 'static', 'js', 'finance.js'),
            encoding='utf-8',
        ) as source_file:
            source = source_file.read()

        setup = source.index("financeSchedulePair('Set-up', 'setup')")
        teardown = source.index("financeSchedulePair('Teardown', 'teardown')")
        rehearsal = source.index("financeSchedulePair('Rehearsal', 'rehearsal')")
        show = source.index("financeSchedulePair('Show', 'show')")
        self.assertLess(setup, teardown)
        self.assertLess(teardown, rehearsal)
        self.assertLess(rehearsal, show)
        self.assertNotIn("financeAddScheduleRow('teardown')", source)
        self.assertIn("!['rehearsal', 'show'].includes(kind)", source)

    def test_pdf_groups_consecutive_rehearsal_show_and_teardown_dates(self):
        quotation = self.create_quote('Consecutive Schedule')
        quotation.update({
            'rehearsalDate': '2026-07-07',
            'additionalRehearsals': [{'id': 'reh-2', 'date': '2026-07-08', 'time': ''}],
            'showDate': '2026-07-09',
            'additionalShows': [
                {'id': 'show-2', 'date': '2026-07-10', 'time': ''},
                {'id': 'show-3', 'date': '2026-07-11', 'time': ''},
            ],
            'teardownDate': '2026-07-12',
            'additionalTeardowns': [{'id': 'tear-2', 'date': '2026-07-13', 'time': ''}],
        })
        saved = self.client.put(
            f"/api/quotations/{quotation['id']}", json=quotation,
        ).get_json()['data']
        self.assertEqual(saved['additionalRehearsals'][0]['date'], '2026-07-08')

        pdf = self.client.get(f"/api/quotations/{quotation['id']}/pdf").data
        text = '\n'.join(page.extract_text() or '' for page in PdfReader(io.BytesIO(pdf)).pages)

        rehearsal_position = text.index('Rehearsal:')
        show_position = text.index('Show:')
        teardown_position = text.index('Teardown:')
        self.assertLess(rehearsal_position, show_position)
        self.assertLess(show_position, teardown_position)
        self.assertIn('7-8 July 2026', text)
        self.assertIn('9-11 July 2026', text)
        self.assertIn('12-13 July 2026', text)

    def test_department_discount_remembers_amount_or_percentage_mode(self):
        quotation = self.create_quote('Discount Modes')
        quotation['lineItems'] = [{
            'id': 'audio', 'catalogKey': '', 'description': 'Audio package',
            'department': 'Audio Department', 'departmentCode': 'AX',
            'days': 1, 'quantity': 1, 'uom': 'lot', 'unitPrice': 1000,
            'discountPercent': 0, 'isCustom': True,
        }]
        quotation['adjustments'] = [{
            'id': 'department-discount', 'scope': 'department',
            'department': 'Audio Department', 'label': 'Launch partner discount',
            'amount': -100, 'percent': 10, 'kind': 'discount',
            'calculationMode': 'amount',
        }]
        saved = self.client.put(
            f"/api/quotations/{quotation['id']}", json=quotation,
        ).get_json()['data']
        saved['lineItems'][0]['unitPrice'] = 2000
        amount_mode = self.client.put(
            f"/api/quotations/{quotation['id']}", json=saved,
        ).get_json()['data']
        adjustment = amount_mode['adjustments'][0]
        self.assertEqual(adjustment['amount'], -100)
        self.assertEqual(adjustment['label'], 'Launch partner discount')

        adjustment['calculationMode'] = 'percent'
        adjustment['percent'] = 10
        amount_mode['lineItems'][0]['unitPrice'] = 3000
        percent_mode = self.client.put(
            f"/api/quotations/{quotation['id']}", json=amount_mode,
        ).get_json()['data']
        self.assertEqual(percent_mode['adjustments'][0]['amount'], -300)

    def test_profit_loss_supports_multiple_commission_rows(self):
        event = Event(
            event_id=132, name='Commission Event', location='Studio',
            start_date='20260810', end_date='20260810', asset_models=[],
            prepared_items=[], returned_items=[], actually_prepared=[],
            extra_assets=[], assigned_users=['alice'],
        )
        self.data_manager.events[132] = event
        quotation = self.create_quote('Commission Event')
        quotation['eventId'] = 132
        quotation['lineItems'] = [{
            'id': 'package', 'catalogKey': '', 'description': 'Package',
            'department': 'Audio Department', 'departmentCode': 'AX',
            'days': 1, 'quantity': 1, 'uom': 'lot', 'unitPrice': 1000,
            'discountPercent': 0, 'isCustom': True,
        }]
        self.client.put(f"/api/quotations/{quotation['id']}", json=quotation)

        response = self.client.put('/api/finance/profit-loss/132/commissions', json={
            'commissions': [
                {'id': 'sales', 'recipient': 'Alice', 'calculationMode': 'percent', 'percent': 5},
                {'id': 'referral', 'recipient': 'Partner', 'calculationMode': 'amount', 'amount': 25},
            ]
        })
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        payload = response.get_json()['data']
        self.assertEqual(payload['summary']['commission'], 75)
        self.assertEqual(payload['summary']['netProfit'], 925)
        self.assertEqual([row['recipient'] for row in payload['commissions']], ['Alice', 'Partner'])
        self.assertEqual(app_module._finance_profit_loss_category_label('Parking', 'worker-claim'), 'Parking')

    def test_inventory_rename_cascades_to_events_and_quotations(self):
        quotation = self.create_quote('Inventory Rename')
        catalog = self.client.get('/api/finance/catalog?query=SB18').get_json()['data'][0]
        quotation['lineItems'] = [{
            **catalog, 'id': 'subwoofer', 'days': 1, 'quantity': 1,
            'uom': 'units', 'unitPrice': 100, 'discountPercent': 0,
        }]
        self.client.put(f"/api/quotations/{quotation['id']}", json=quotation)
        event = Event(
            event_id=133, name='Rename Event', location='Store',
            start_date='20260812', end_date='20260812', asset_models=[],
            prepared_items=['[MODEL]AX|L-Acoustics|SB18 III|1|Subwoofer', 'AX#01'],
            returned_items=[], actually_prepared=['AX#01'], extra_assets=[],
            assigned_users=['alice', 'bnjm2000'],
        )
        self.data_manager.events[133] = event
        self.data_manager.save_event(event)

        self.login('bnjm2000')
        response = self.client.put('/api/assets/AX%2301', json={
            'id': 'AX#99', 'department': 'AX', 'brand': 'L-Acoustics',
            'model': 'SB18 IV', 'description': 'Updated subwoofer',
            'applyTo': 'allSimilar',
        })
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertIn('AX#99', event.actually_prepared)
        self.assertNotIn('AX#01', event.actually_prepared)
        self.assertTrue(any('SB18 IV' in item for item in event.prepared_items))

        updated_quote = self.client.get(
            f"/api/quotations/{quotation['id']}"
        ).get_json()['data']
        line = updated_quote['lineItems'][0]
        self.assertIn('AX#99', line['sourceAssetIds'])
        self.assertEqual(line['model'], 'SB18 IV')
        self.assertIn('Updated subwoofer', line['description'])

    def test_compare_manager_can_sync_event_but_not_quotation_without_sales(self):
        event = Event(
            event_id=200,
            name='Comparison Event',
            location='Studio A',
            start_date='20260721',
            end_date='20260721',
            asset_models=[],
            prepared_items=[
                '[MODEL]AX|L-Acoustics|SB18 III|1|Subwoofer',
                '[MODEL]LX|Robe|Spiider|1|LED wash fixture',
            ],
            returned_items=[],
            actually_prepared=[],
            extra_assets=[],
            assigned_users=['alice', 'manager-no-sales'],
        )
        self.data_manager.events[200] = event
        quotation = self.create_quote('Comparison Event')
        catalog = self.client.get('/api/finance/catalog?query=SB18').get_json()['data'][0]
        quotation['eventId'] = 200
        quotation['lineItems'] = [{
            **catalog,
            'id': 'quoted-sub',
            'days': 1,
            'quantity': 2,
            'uom': 'units',
            'unitPrice': 100,
            'discountPercent': 0,
        }]
        saved_quote = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json=quotation,
        ).get_json()['data']

        self.login('manager-no-sales')
        response = self.client.get('/api/finance/compare?eventId=200')
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        data = response.get_json()['data']
        self.assertFalse(data['permissions']['canEditQuotation'])
        mismatch = next(row for row in data['rows'] if row['status'] == 'qty_mismatch')
        extra = next(row for row in data['rows'] if row['status'] == 'extra_in_event')

        added = self.client.post(
            '/api/finance/compare/200/add-to-event',
            json={'quotationId': saved_quote['id'], 'key': mismatch['key']},
        )
        self.assertEqual(added.status_code, 200, added.get_data(as_text=True))
        self.assertIn('[MODEL]AX|L-Acoustics|SB18 III|2|Subwoofer', event.prepared_items)

        blocked = self.client.post(
            '/api/finance/compare/200/add-to-quotation',
            json={'quotationId': saved_quote['id'], 'key': extra['key']},
        )
        self.assertEqual(blocked.status_code, 403)

        removed = self.client.post(
            '/api/finance/compare/200/remove-extra',
            json={'quotationId': saved_quote['id'], 'key': extra['key']},
        )
        self.assertEqual(removed.status_code, 200, removed.get_data(as_text=True))
        self.assertFalse(any('Spiider' in item for item in event.prepared_items))

    def test_compare_adds_brand_model_and_remembered_price_to_quotation(self):
        self.login('bnjm2000')
        priced = self.create_quote('Remembered Lighting Price')
        lighting = self.client.get('/api/finance/catalog?query=Spiider').get_json()['data'][0]
        priced['lineItems'] = [{
            **lighting,
            'id': 'priced-spiider',
            'days': 1,
            'quantity': 1,
            'uom': 'units',
            'unitPrice': 444,
            'discountPercent': 0,
        }]
        self.client.put(f"/api/quotations/{priced['id']}", json=priced)

        event = Event(
            event_id=201,
            name='Breakout Comparison',
            location='Studio B',
            start_date='20260722',
            end_date='20260722',
            asset_models=[],
            prepared_items=['[MODEL]LX|Robe|Spiider|2|LED wash fixture'],
            returned_items=[],
            actually_prepared=[],
            extra_assets=[],
            assigned_users=['bnjm2000'],
        )
        self.data_manager.events[201] = event
        target = self.create_quote('Breakout Comparison')
        target['eventId'] = 201
        target = self.client.put(
            f"/api/quotations/{target['id']}", json=target
        ).get_json()['data']
        comparison = self.client.get(
            f"/api/finance/compare?eventId=201{chr(38)}quotationId={target['id']}"
        ).get_json()['data']
        extra = next(row for row in comparison['rows'] if row['status'] == 'extra_in_event')
        response = self.client.post(
            '/api/finance/compare/201/add-to-quotation',
            json={'quotationId': target['id'], 'key': extra['key']},
        )
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        updated = self.client.get(f"/api/quotations/{target['id']}").get_json()['data']
        line = updated['lineItems'][0]
        self.assertEqual(line['brand'], 'Robe')
        self.assertEqual(line['model'], 'Spiider')
        self.assertEqual(line['description'], 'Robe Spiider LED wash fixture')
        self.assertEqual(line['unitPrice'], 444)

    def test_compare_bulk_adds_event_items_and_repairs_existing_asset_identity(self):
        self.login('bnjm2000')
        lighting = self.client.get('/api/finance/catalog?query=Spiider').get_json()['data'][0]
        event = Event(
            event_id=202,
            name='Bulk Comparison',
            location='Studio C',
            start_date='20260722',
            end_date='20260722',
            asset_models=[],
            prepared_items=[
                '[MODEL]LX|Robe|Spiider|3|LED wash fixture',
                '[MODEL]AX|L-Acoustics|SB18 III|2|Subwoofer',
            ],
            returned_items=[],
            actually_prepared=[],
            extra_assets=[],
            assigned_users=['bnjm2000'],
        )
        self.data_manager.events[202] = event
        target = self.create_quote('Bulk Comparison')
        target['eventId'] = 202
        target['lineItems'] = [{
            'id': 'legacy-spiider',
            'catalogKey': '',
            'sourceAssetIds': lighting['sourceAssetIds'][:1],
            'description': 'LED wash fixture',
            'department': 'Lighting Department',
            'departmentCode': 'LX',
            'days': 1,
            'quantity': 1,
            'uom': 'units',
            'unitPrice': 0,
            'discountPercent': 0,
            'isCustom': True,
        }]
        target = self.client.put(
            f"/api/quotations/{target['id']}", json=target
        ).get_json()['data']
        self.assertEqual(target['lineItems'][0]['brand'], '')
        self.assertEqual(target['lineItems'][0]['model'], '')
        comparison = self.client.get(
            f"/api/finance/compare?eventId=202{chr(38)}quotationId={target['id']}"
        ).get_json()['data']
        targets = [
            row for row in comparison['rows']
            if row['eventItem']['quantity'] > row['quotationItem']['quantity']
        ]

        response = self.client.post(
            '/api/finance/compare/202/add-to-quotation',
            json={
                'quotationId': target['id'],
                'keys': [row['key'] for row in targets],
            },
        )

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        updated = self.client.get(f"/api/quotations/{target['id']}").get_json()['data']
        lines = {line['model']: line for line in updated['lineItems']}
        self.assertEqual(lines['Spiider']['brand'], 'Robe')
        self.assertEqual(lines['Spiider']['description'], 'Robe Spiider LED wash fixture')
        self.assertEqual(lines['Spiider']['quantity'], 3)
        self.assertEqual(lines['SB18 III']['brand'], 'L-Acoustics')
        self.assertEqual(lines['SB18 III']['description'], 'L-Acoustics SB18 III Subwoofer')
        self.assertEqual(lines['SB18 III']['quantity'], 2)
        exported = self.client.get(f"/api/quotations/{target['id']}/pdf").data
        pdf_text = '\n'.join(
            page.extract_text() or ''
            for page in PdfReader(io.BytesIO(exported)).pages
        )
        self.assertIn('Robe Spiider LED wash fixture', pdf_text)
        self.assertIn('L-Acoustics SB18 III Subwoofer', pdf_text)

    def test_subprojects_export_as_rooms_and_copy_to_accepted_event(self):
        quotation = self.create_quote('Multi Room Conference')
        quotation['subprojects'] = [
            {'id': 'main', 'name': 'Main Room'},
            {'id': 'breakout-a', 'name': 'Breakout A'},
        ]
        quotation['lineItems'] = [
            {
                'id': 'main-sub', 'catalogKey': 'inventory:ax|l-acoustics|sb18 iii',
                'brand': 'L-Acoustics', 'model': 'SB18 III', 'description': 'Subwoofer',
                'department': 'Audio Department', 'departmentCode': 'AX',
                'days': 1, 'quantity': 2, 'uom': 'units', 'unitPrice': 100,
                'discountPercent': 0, 'subprojectId': 'main',
            },
            {
                'id': 'breakout-light', 'catalogKey': 'inventory:lx|robe|spiider',
                'brand': 'Robe', 'model': 'Spiider', 'description': 'LED wash fixture',
                'department': 'Lighting Department', 'departmentCode': 'LX',
                'days': 1, 'quantity': 4, 'uom': 'units', 'unitPrice': 200,
                'discountPercent': 0, 'subprojectId': 'breakout-a',
            },
        ]
        saved = self.client.put(
            f"/api/quotations/{quotation['id']}", json=quotation
        ).get_json()['data']
        exported = self.client.get(f"/api/quotations/{quotation['id']}/pdf").data
        reader = PdfReader(io.BytesIO(exported))
        text = '\n'.join(page.extract_text() or '' for page in reader.pages)
        self.assertIn('MAIN ROOM', text)
        self.assertIn('BREAKOUT A', text)
        self.assertIn('SUB-PROJECT SUMMARY', text)
        self.assertIn(f'Page {len(reader.pages)} of {len(reader.pages)}', reader.pages[-1].extract_text() or '')

        accepted = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json={**saved, 'status': 'accepted'},
        ).get_json()['data']
        event = self.data_manager.events[accepted['eventId']]
        self.assertEqual([row['name'] for row in event.subprojects], ['Main Room', 'Breakout A'])
        reloaded = DataManager(self.tempdir.name)
        reloaded.load_events()
        self.assertEqual(
            [row['name'] for row in reloaded.events[accepted['eventId']].subprojects],
            ['Main Room', 'Breakout A'],
        )

    def test_single_project_pdf_omits_project_header(self):
        quotation = self.create_quote('Single Room Conference')
        quotation['subprojects'] = [{'id': 'main', 'name': 'Main Room'}]
        quotation['lineItems'] = [{
            'id': 'main-audio', 'catalogKey': 'inventory:ax|test|speaker',
            'brand': 'Test', 'model': 'Speaker', 'description': 'Main PA',
            'department': 'Audio Department', 'departmentCode': 'AX',
            'days': 1, 'quantity': 2, 'uom': 'units', 'unitPrice': 100,
            'discountPercent': 0, 'subprojectId': 'main',
        }]
        saved = self.client.put(
            f"/api/quotations/{quotation['id']}", json=quotation
        ).get_json()['data']

        exported = self.client.get(f"/api/quotations/{saved['id']}/pdf").data
        text = '\n'.join(page.extract_text() or '' for page in PdfReader(io.BytesIO(exported)).pages)

        self.assertNotIn('MAIN ROOM', text)
        self.assertIn('Audio Department', text)

    def test_quotation_ui_has_no_native_selects(self):
        path = os.path.join(os.path.dirname(app_module.__file__), 'static', 'js', 'finance.js')
        with open(path, encoding='utf-8') as source_file:
            source = source_file.read().lower()
        css_path = os.path.join(os.path.dirname(app_module.__file__), 'static', 'css', 'finance.css')
        with open(css_path, encoding='utf-8') as css_file:
            css_source = css_file.read().lower()
        self.assertNotIn('<select', source)
        self.assertNotIn('set all days', source)
        self.assertIn('apply to all lines', source)
        self.assertIn('ondragstart', source)
        self.assertIn('finance-drag-handle\" draggable=\"true', source)
        self.assertNotIn('class=\"finance-line-row\" draggable=\"true', source)
        self.assertIn('show unit prices', source)
        self.assertIn('show department subtotals', source)
        self.assertIn('finance_salutations', source)
        self.assertIn("financetoggledocumentflag('showsignoff')", source)
        self.assertIn("function financedefaultuom(department, preferred = '')", source)
        self.assertNotIn("financestate.adddepartment = 'manpower'", source)
        self.assertIn("selected.department || 'general'", source)
        self.assertIn("onmousedown=\"event.preventdefault();financechoosedepartment", source)
        self.assertIn('catalogcache', source)
        self.assertNotIn('}, 220);', source)
        self.assertIn('finance-pre-tax-input', source)
        self.assertIn('financecurrencynumber(value)', source)
        self.assertIn('financemoney(document.totallocked ? totals.lockedpretax : totals.netsubtotal)', source)
        self.assertIn('financesetlinetotal', source)
        self.assertIn('finance-line-total-input', source)
        self.assertIn('financesettaxrate', source)
        self.assertIn('financesettaxamount', source)
        self.assertIn('finance-tax-rate-input', source)
        self.assertIn('finance-tax-amount-input', source)
        self.assertIn('min=\"-9999\"', source)
        self.assertIn('<col style=\"width:350px\"><col style=\"width:120px\"', source)
        self.assertIn("aria-label=\"days\" onchange", source)
        self.assertIn("step=\"0.5\" value=\"${financeescapeattr(line.days)}\"", source)
        self.assertIn("step=\"1\" value=\"${financeescapeattr(line.quantity)}\"", source)
        self.assertIn('height: 24px;', css_source)
        self.assertIn('.finance-lines-table .finance-money-input', css_source)
        self.assertIn('padding: 1px 2px;', css_source)
        self.assertIn('window.open(pdfurl', source)
        self.assertNotIn('window.location.href = pdfurl', source)
        self.assertNotIn('link.download', source)
        self.assertIn('/api/events?view=summary&limit=500', source)
        self.assertIn('/api/finance/salespeople', source)
        self.assertIn('financeshowsalespersonsuggestions', source)
        self.assertIn('financesalespersoninput', source)
        self.assertIn('event pairing', source)
        self.assertIn('financepairevent', source)
        self.assertIn('financeunpairevent', source)
        self.assertIn('financehandlequotationeventclick', source)
        self.assertIn('eventpairtargetid', source)
        self.assertIn('quotation paired to event', source)
        self.assertIn("viewevent(id, { updatehistory: false })", source)
        self.assertNotIn("showsection('events')", source)
        self.assertIn('financeeventdatesummary(document)', source)
        self.assertIn('finance-project-dates', source)
        self.assertIn('.finance-status[data-status="paid"]', css_source)
        self.assertIn('.finance-status-menu > button[data-status="paid"]', css_source)
        self.assertIn("label: 'sent on'", source)
        self.assertNotIn("label: 'sent / validity'", source)
        self.assertIn('detail: financevaliditycountdown(document)', source)
        self.assertIn('financepaymentduedisplay', source)
        self.assertIn('financepaymenttermsummary', source)
        self.assertIn('choose a valid invoice sent date', source)
        self.assertIn('financeclientpickermodal', source)
        self.assertIn('financeeventpickermodal', source)
        self.assertIn('profit &amp; loss', source)
        self.assertIn('financeopencomparepage', source)
        self.assertIn('/api/finance/profit-loss/', source)
        self.assertIn('/api/finance/compare', source)
        self.assertIn('financeopenclientpicker', source)
        self.assertIn('financeopeneventpicker', source)
        self.assertIn('will not create another event', source)
        self.assertIn('select known clients', source)
        self.assertIn('valid for', source)
        self.assertIn('financeopenrevisionpdf', source)
        self.assertIn('financeeditrevision', source)
        self.assertIn('financedeleterevision', source)
        self.assertIn('financediscardchanges', source)
        self.assertIn('financeexportinvoicebutton', source)
        self.assertIn("['accepted', 'cancelled', 'invoiced', 'overdue', 'paid']", source)
        self.assertIn('finance-list-status-actions', source)
        self.assertIn('finance-list-export-cell', source)
        self.assertIn('finance-list-export-action', source)
        self.assertIn('finance-list-export-heading', source)
        self.assertIn('data-document-id=', source)
        self.assertIn('financeupdatelistrow(response.data)', source)
        self.assertIn('<h3>pdf options</h3>', source)
        self.assertIn('<th>versions</th>', source)
        self.assertNotIn('<th>revisions</th>', source)
        self.assertIn("document.status === 'cancelled' ? 'is-cancelled'", source)
        self.assertIn('financeexportquotationbutton', source)
        self.assertIn("['draft', 'sent']", source)
        self.assertIn('finance-loading-spinner', source)
        self.assertIn('promise.all([', source)
        self.assertIn('snapshot view', source)
        self.assertIn('<th>date</th>', source)
        self.assertIn('you can press add now', source)
        self.assertIn('abortcontroller', source)
        self.assertIn('iscontainer', source)
        self.assertIn('containeritems', source)
        self.assertIn('financegroupequivalentcontainers', source)
        self.assertIn('matching containers', source)
        self.assertIn('financedropdepartment', source)
        self.assertIn('finance-department-drag-handle\" draggable=\"true', source)
        self.assertIn("closest('.finance-department-row')", source)
        self.assertIn("financeaddschedulerow('show')", source)
        self.assertNotIn("financeaddschedulerow('teardown')", source)
        self.assertIn('financelocationresults', source)
        self.assertIn('financesetdepartmentadjustmentpercent', source)
        self.assertIn('financesetdepartmentadjustmentamount', source)
        self.assertIn('financesettotaldiscountlabel', source)
        self.assertIn('profitlossopencommissionmodal', source)
        self.assertIn('min-width: 1094px;', css_source)
        pdf_path = os.path.join(os.path.dirname(app_module.__file__), 'quotation_pdf.py')
        with open(pdf_path, encoding='utf-8') as pdf_file:
            pdf_source = pdf_file.read().lower()
        self.assertIn('pdf_line_number', pdf_source)
        self.assertIn('financetableheaderlabel', pdf_source)
        self.assertIn("description', table_header_label", pdf_source)
        self.assertNotIn('enumerate(department_lines, start=1)', pdf_source)


if __name__ == '__main__':
    unittest.main()
