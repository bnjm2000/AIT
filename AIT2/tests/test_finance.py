import io
import os
import tempfile
import unittest
from datetime import datetime, timedelta

from pypdf import PdfReader

import app as app_module
from data_manager import DataManager
from models import InventoryItem, User, hash_password


class FinanceFeatureTests(unittest.TestCase):
    def setUp(self):
        self.original_data_manager = app_module.get_default_data_manager()
        self.original_signature = app_module._data_snapshot_signature
        self.original_testing = app_module.app.config.get('TESTING')
        self.tempdir = tempfile.TemporaryDirectory()

        self.data_manager = DataManager(self.tempdir.name)
        self.data_manager.setup_data_folder()
        self.data_manager.users = {
            'bnjm2000': self.make_user('bnjm2000', 'owner', True),
            'alice': self.make_user('alice', 'user', True),
            'bob': self.make_user('bob', 'user', True),
            'no-sales': self.make_user('no-sales', 'user', False),
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
        }
        self.data_manager.save_inventory()

        app_module.app.config['TESTING'] = True
        app_module.set_data_manager_for_testing(self.data_manager)
        self.client = app_module.app.test_client()
        self.login('alice')

    def tearDown(self):
        app_module.clear_test_data_manager(self.original_data_manager)
        app_module._data_snapshot_signature = self.original_signature
        app_module.app.config['TESTING'] = self.original_testing
        self.tempdir.cleanup()

    def make_user(self, username, role, sales):
        return User(
            username,
            hash_password('pw', f'{username}-salt'),
            f'{username}-salt',
            role in {'owner', 'admin', 'manager'},
            True,
            role=role,
            has_sales_access=sales,
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
            {'draft', 'sent', 'accepted', 'declined', 'expired', 'cancelled', 'invoiced', 'paid'},
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
        self.assertTrue(any(str(row).startswith('[MODEL]AX|L-Acoustics|SB18 III|2|') for row in event.prepared_items))
        self.assertTrue(any(str(row).startswith('[CUSTOM]') and 'Audio Engineer' in row for row in event.prepared_items))

        accepted_again = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json={'status': 'accepted'},
        ).get_json()['data']
        self.assertEqual(accepted_again['eventId'], accepted['eventId'])
        self.assertEqual(len(self.data_manager.events), 1)

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

    def test_locked_pre_gst_total_blocks_export_until_departments_match(self):
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
        self.assertEqual(saved['totals']['lockDifference'], 100)
        blocked = self.client.get(f"/api/quotations/{quotation['id']}/pdf")
        self.assertEqual(blocked.status_code, 400)

        saved['adjustments'] = [{
            'id': 'discount',
            'scope': 'department',
            'department': 'Manpower',
            'label': '10% department discount',
            'amount': -100,
            'percent': 10,
            'kind': 'discount',
        }]
        matched = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json=saved,
        ).get_json()['data']
        self.assertEqual(matched['totals']['lockDifference'], 0)
        exported = self.client.get(f"/api/quotations/{quotation['id']}/pdf")
        self.assertEqual(exported.status_code, 200)

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
        self.assertIn('DESCRIPTION', hidden_text)
        self.assertIn('DEPARTMENT', hidden_text)
        self.assertIn('UNIT PRICE', hidden_text)
        self.assertNotIn('$123.45', hidden_text)
        self.assertNotIn('10% department discount', hidden_text)
        self.assertLess(hidden_text.index('Edgar Tan'), hidden_text.index('Patricia & Edgar Pte Ltd'))
        self.assertGreaterEqual(len(hidden_reader.pages), 2)
        for page in hidden_reader.pages:
            page_text = page.extract_text() or ''
            if 'Audio item ' in page_text:
                self.assertIn('Audio Department', page_text)
                self.assertIn('DESCRIPTION', page_text)
                self.assertIn('DEPARTMENT', page_text)

        saved['showUnitPrices'] = True
        saved['showDepartmentDiscounts'] = True
        self.client.put(
            f"/api/quotations/{quotation['id']}",
            json=saved,
        )
        visible_pdf = self.client.get(f"/api/quotations/{quotation['id']}/pdf").data
        visible_text = '\n'.join(page.extract_text() or '' for page in PdfReader(io.BytesIO(visible_pdf)).pages)
        self.assertIn('$123.45', visible_text)
        self.assertIn('10% department discount', visible_text)

    def test_mandatory_project_default_departments_and_permissions(self):
        blank = self.create_quote(project='')
        rejected = self.client.put(
            f"/api/quotations/{blank['id']}",
            json={'notes': 'Cannot save yet'},
        )
        self.assertEqual(rejected.status_code, 400)

        loaded = self.client.get(
            f"/api/quotations/{blank['id']}"
        ).get_json()['data']
        self.assertIn('Manpower', loaded['departments'])
        self.assertIn('Transportation', loaded['departments'])

        with self.client.session_transaction() as session:
            session.clear()
        self.assertEqual(self.client.get('/api/quotations').status_code, 401)

        self.login('no-sales')
        response = self.client.get('/api/quotations')
        self.assertEqual(response.status_code, 403)
        self.assertIn('Sales access required', response.get_json()['error'])

    def test_quotation_ui_has_no_native_selects(self):
        path = os.path.join(os.path.dirname(app_module.__file__), 'static', 'js', 'finance.js')
        with open(path, encoding='utf-8') as source_file:
            source = source_file.read().lower()
        self.assertNotIn('<select', source)
        self.assertIn('set all days', source)
        self.assertIn('show unit prices', source)


if __name__ == '__main__':
    unittest.main()
