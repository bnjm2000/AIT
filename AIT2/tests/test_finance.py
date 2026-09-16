import base64
import copy
import io
import os
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import patch

from pypdf import PdfReader

import app as app_module
from data_manager import DataManager
from models import Container, Event, InventoryItem, User, hash_password
from tests.static_source import APP_BUNDLE_SOURCE
from workforce import save_workforce


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
                for username in (
                    'bnjm2000', 'alice', 'bob', 'sales-admin',
                    'review-admin', 'sales-manager', 'no-sales', 'manager-no-sales',
                )
            },
            'superAdmins': ['bnjm2000'],
        })

        self.data_manager = DataManager(self.tempdir.name)
        self.data_manager.setup_data_folder()
        self.data_manager.users = {
            'bnjm2000': self.make_user('bnjm2000', 'owner', True),
            'alice': self.make_user('alice', 'user', True, name='Alice Lim'),
            'bob': self.make_user('bob', 'user', True),
            'sales-admin': self.make_user('sales-admin', 'admin', True),
            'review-admin': self.make_user('review-admin', 'admin', False),
            'sales-manager': self.make_user('sales-manager', 'manager', True),
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

    def test_plan_can_link_unpaired_quotation_without_changing_event_plan(self):
        first = self.create_quote('First Project')
        second = self.create_quote('Second Project')
        event = Event(
            event_id=321,
            name='Existing Plan',
            location='Existing Hall',
            start_date='20260920',
            end_date='20260920',
            asset_models=[],
            prepared_items=['[MODEL]AX|Existing|Model|2|Keep this plan'],
            returned_items=[],
            actually_prepared=[],
            extra_assets=[],
            assigned_users=['alice', 'no-sales'],
        )
        self.data_manager.events[321] = event

        self.login('no-sales')
        self.assertEqual(
            self.client.get('/api/events/321/quotation-link').status_code, 403,
        )

        self.login('review-admin')  # Admin without the Sales flag.
        options = self.client.get('/api/events/321/quotation-link?query=First')
        self.assertEqual(options.status_code, 200, options.get_data(as_text=True))
        self.assertEqual([row['id'] for row in options.get_json()['data']], [first['id']])
        linked = self.client.put('/api/events/321/quotation-link', json={
            'quotationId': first['id'],
            'documentVersion': first['documentVersion'],
        })
        self.assertEqual(linked.status_code, 200, linked.get_data(as_text=True))
        self.assertEqual(event.prepared_items, ['[MODEL]AX|Existing|Model|2|Keep this plan'])
        self.assertEqual(event.name, 'Existing Plan')
        self.assertEqual(
            self.client.get('/api/events/321?view=plan').get_json()['data']['quotationId'],
            first['id'],
        )
        available_ids = {
            row['id'] for row in self.client.get('/api/events/321/quotation-link').get_json()['data']
        }
        self.assertNotIn(first['id'], available_ids)
        self.assertIn(second['id'], available_ids)

        duplicate = self.client.put('/api/events/321/quotation-link', json={
            'quotationId': second['id'],
            'documentVersion': second['documentVersion'],
        })
        self.assertEqual(duplicate.status_code, 409)

        self.login('alice')  # Assigned Sales user can use the same picker.
        sales_options = self.client.get('/api/events/321/quotation-link')
        self.assertEqual(sales_options.status_code, 200)
        self.assertIn(second['id'], {
            row['id'] for row in sales_options.get_json()['data']
        })
        second_event = Event(
            event_id=322,
            name='Sales Event',
            location='Hall B',
            start_date='20260921',
            end_date='20260921',
            asset_models=[],
            prepared_items=[],
            returned_items=[],
            actually_prepared=[],
            extra_assets=[],
            assigned_users=['alice'],
        )
        self.data_manager.events[322] = second_event
        stale = self.client.put('/api/events/322/quotation-link', json={
            'quotationId': second['id'],
            'documentVersion': second['documentVersion'] + 1,
        })
        self.assertEqual(stale.status_code, 409)
        sales_link = self.client.put('/api/events/322/quotation-link', json={
            'quotationId': second['id'],
            'documentVersion': second['documentVersion'],
        })
        self.assertEqual(sales_link.status_code, 200, sales_link.get_data(as_text=True))

    def test_stale_quotation_save_is_rejected_with_latest_document(self):
        quotation = self.create_quote('Concurrent Quotation')
        stale_copy = copy.deepcopy(quotation)

        first = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json={**quotation, 'notes': 'Saved by the first editor'},
        )
        self.assertEqual(first.status_code, 200, first.get_data(as_text=True))
        first_document = first.get_json()['data']

        conflict = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json={**stale_copy, 'reference': 'STALE-CHANGE'},
        )
        self.assertEqual(conflict.status_code, 409, conflict.get_data(as_text=True))
        payload = conflict.get_json()
        self.assertEqual(payload['code'], 'document_version_conflict')
        self.assertEqual(payload['actualVersion'], first_document['documentVersion'])
        self.assertEqual(payload['data']['notes'], 'Saved by the first editor')

    def test_stale_quotation_non_overlapping_edits_merge_with_base_document(self):
        quotation = self.create_quote('Concurrent Line Editing')
        quotation['lineItems'] = [
            {
                'id': 'line-a', 'description': 'Console',
                'department': 'Audio Department', 'departmentCode': 'AX',
                'days': 1, 'quantity': 1, 'uom': 'units',
                'unitPrice': 100, 'discountPercent': 0,
                'subprojectId': 'main',
            },
            {
                'id': 'line-b', 'description': 'Microphone',
                'department': 'Audio Department', 'departmentCode': 'AX',
                'days': 1, 'quantity': 1, 'uom': 'units',
                'unitPrice': 20, 'discountPercent': 0,
                'subprojectId': 'main',
            },
        ]
        quotation = self.client.put(
            f"/api/quotations/{quotation['id']}", json=quotation,
        ).get_json()['data']
        first_editor = copy.deepcopy(quotation)
        second_editor = copy.deepcopy(quotation)

        first_editor['lineItems'][0]['quantity'] = 2
        first = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json={**first_editor, '_baseDocument': quotation},
        )
        self.assertEqual(first.status_code, 200, first.get_data(as_text=True))

        second_editor['lineItems'][1]['quantity'] = 3
        second = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json={**second_editor, '_baseDocument': quotation},
        )
        self.assertEqual(second.status_code, 200, second.get_data(as_text=True))
        lines = {
            line['id']: line for line in second.get_json()['data']['lineItems']
        }
        self.assertEqual(lines['line-a']['quantity'], 2)
        self.assertEqual(lines['line-b']['quantity'], 3)

    def test_stale_quotation_same_line_edit_still_conflicts(self):
        quotation = self.create_quote('Concurrent Same Line')
        quotation['lineItems'] = [{
            'id': 'same-line', 'description': 'Console',
            'department': 'Audio Department', 'departmentCode': 'AX',
            'days': 1, 'quantity': 1, 'uom': 'units',
            'unitPrice': 100, 'discountPercent': 0,
            'subprojectId': 'main',
        }]
        quotation = self.client.put(
            f"/api/quotations/{quotation['id']}", json=quotation,
        ).get_json()['data']
        stale = copy.deepcopy(quotation)

        first = copy.deepcopy(quotation)
        first['lineItems'][0]['quantity'] = 2
        self.client.put(
            f"/api/quotations/{quotation['id']}",
            json={**first, '_baseDocument': quotation},
        )
        stale['lineItems'][0]['quantity'] = 3
        conflict = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json={**stale, '_baseDocument': quotation},
        )

        self.assertEqual(conflict.status_code, 409, conflict.get_data(as_text=True))
        self.assertEqual(conflict.get_json()['code'], 'document_version_conflict')

    def test_large_quotation_group_splits_cleanly_across_pdf_pages(self):
        quotation = self.create_quote('Large Package')
        quotation['lineItems'] = [{
            'id': f'package-line-{index}',
            'description': f'Package child {index} with a detailed client-facing description',
            'department': 'Audio Department',
            'systemName': 'Audio',
            'days': 1,
            'quantity': 1,
            'uom': 'units',
            'unitPrice': 10,
            'discountPercent': 0,
            'subprojectId': 'main',
            'groupId': 'large-package',
            'groupTitle': 'Large Audio Package',
            'groupLeader': index == 1,
            'groupItemQuantity': 1,
            'groupDisplayFields': ['description'],
        } for index in range(1, 121)]
        saved = self.client.put(
            f"/api/quotations/{quotation['id']}", json=quotation,
        )
        self.assertEqual(saved.status_code, 200, saved.get_data(as_text=True))

        exported = self.client.get(f"/api/quotations/{quotation['id']}/pdf")
        self.assertEqual(exported.status_code, 200)
        reader = PdfReader(io.BytesIO(exported.data))
        self.assertGreater(len(reader.pages), 2)
        text = '\n'.join(page.extract_text() or '' for page in reader.pages)
        self.assertIn('Large Audio Package (continued)', text)

    def test_quotation_can_be_duplicated_as_next_numbered_draft(self):
        source = self.create_quote('Annual Conference')
        source.update({
            'status': 'sent',
            'sentDate': datetime.now().strftime('%Y-%m-%d'),
            'lineItems': [{
                'id': 'copy-line',
                'description': 'Audio package',
                'department': 'Audio Department',
                'days': 2,
                'quantity': 1,
                'uom': 'lot',
                'unitPrice': 500,
                'discountPercent': 0,
                'subprojectId': 'main',
            }],
        })
        source = self.client.put(
            f"/api/quotations/{source['id']}",
            json=source,
        ).get_json()['data']
        original = copy.deepcopy(source)

        response = self.client.post(f"/api/quotations/{source['id']}/duplicate")

        self.assertEqual(response.status_code, 201, response.get_data(as_text=True))
        duplicate = response.get_json()['data']
        self.assertNotEqual(duplicate['id'], source['id'])
        self.assertNotEqual(duplicate['number'], source['number'])
        self.assertTrue(duplicate['number'].endswith('-01'))
        self.assertEqual(duplicate['baseSequence'], source['baseSequence'] + 1)
        self.assertEqual(duplicate['projectName'], 'Copy of Annual Conference')
        self.assertEqual((duplicate['revision'], duplicate['status']), (1, 'draft'))
        self.assertEqual(duplicate['revisions'], [])
        self.assertEqual(duplicate['quotationDate'], datetime.now().strftime('%Y-%m-%d'))
        self.assertFalse(duplicate['sentAt'])
        self.assertIsNone(duplicate['eventId'])
        self.assertEqual(duplicate['salespersonUsername'], 'alice')
        self.assertEqual(duplicate['lineItems'][0]['description'], 'Audio package')
        persisted_source = self.client.get(
            f"/api/quotations/{source['id']}"
        ).get_json()['data']
        self.assertEqual(persisted_source['number'], original['number'])
        self.assertEqual(persisted_source['revisions'], original['revisions'])

    def test_draft_quotation_detail_autosaves_do_not_fill_system_logs(self):
        quotation = self.create_quote(project='')
        self.data_manager.logs = []
        self.data_manager.save_logs()
        quotation['projectName'] = 'Autosaved project'
        quotation['title'] = 'Autosaved project'

        response = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json=quotation,
        )

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertEqual(self.data_manager.logs, [])

    def test_viewing_quotation_does_not_change_last_modified_order(self):
        quotation = self.create_quote('Read only visit')
        original_updated_at = quotation['updatedAt']

        unchanged = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json=quotation,
        )

        self.assertEqual(unchanged.status_code, 200, unchanged.get_data(as_text=True))
        self.assertTrue(unchanged.get_json().get('unchanged'))
        self.assertEqual(unchanged.get_json()['data']['updatedAt'], original_updated_at)

        quotation = unchanged.get_json()['data']
        quotation['quotationDate'] = '2026-01-01'
        changed = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json=quotation,
        )
        self.assertEqual(changed.status_code, 200, changed.get_data(as_text=True))
        changed = changed.get_json()['data']
        date_edit_updated_at = changed['updatedAt']

        changed['quotationDate'] = datetime.now().strftime('%Y-%m-%d')
        changed['_automaticDraftDateRefresh'] = True
        refreshed = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json=changed,
        )

        self.assertEqual(refreshed.status_code, 200, refreshed.get_data(as_text=True))
        refreshed = refreshed.get_json()['data']
        self.assertEqual(refreshed['quotationDate'], datetime.now().strftime('%Y-%m-%d'))
        self.assertEqual(refreshed['updatedAt'], date_edit_updated_at)
        persisted = self.client.get(
            f"/api/quotations/{quotation['id']}"
        ).get_json()['data']
        self.assertEqual(persisted['quotationDate'], datetime.now().strftime('%Y-%m-%d'))
        self.assertEqual(persisted['updatedAt'], date_edit_updated_at)

        source = Path(app_module.__file__).with_name('static').joinpath(
            'js', 'finance.js'
        ).read_text(encoding='utf-8')
        self.assertIn(
            'financeQueueSave({ automaticDraftDateRefresh: true })',
            source,
        )
        self.assertIn('_automaticDraftDateRefresh: true', source)

    def test_ownership_visibility_and_unique_global_numbers(self):
        alice_quote = self.create_quote('Alice Project')
        self.assertRegex(alice_quote['number'], r'^QT-\d{4}-001-01$')
        self.assertEqual(alice_quote['createdBy'], 'alice')
        self.assertEqual(alice_quote['salesperson'], 'Alice Lim')
        self.assertEqual(alice_quote['salespersonUsername'], 'alice')

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
        self.assertIn("showSalesperson ? '<th>Salesperson</th>'", source)
        self.assertIn(
            'financeEscape(document.salespersonUsername || document.createdBy)',
            source,
        )

    def test_manager_sees_own_quotations_and_invoices_while_admin_sees_all(self):
        alice_quote = self.create_quote('Alice Billing Project')
        alice_quote = self.client.put(
            f"/api/quotations/{alice_quote['id']}",
            json={**alice_quote, 'status': 'accepted'},
        ).get_json()['data']

        self.login('sales-manager')
        manager_quote = self.create_quote('Manager Billing Project')
        manager_quote = self.client.put(
            f"/api/quotations/{manager_quote['id']}",
            json={**manager_quote, 'status': 'accepted'},
        ).get_json()['data']

        manager_quotes = self.client.get('/api/quotations').get_json()['data']
        self.assertEqual({row['id'] for row in manager_quotes}, {manager_quote['id']})
        manager_plans = self.client.get('/api/invoice-plans').get_json()['data']
        self.assertEqual(
            {row['quotation']['id'] for row in manager_plans},
            {manager_quote['id']},
        )
        self.assertEqual(
            self.client.get(f"/api/quotations/{alice_quote['id']}").status_code,
            404,
        )
        self.assertEqual(
            self.client.get(f"/api/invoice-plans/{alice_quote['id']}").status_code,
            404,
        )

        self.login('sales-admin')
        admin_quotes = self.client.get('/api/quotations').get_json()['data']
        self.assertEqual(
            {row['id'] for row in admin_quotes},
            {alice_quote['id'], manager_quote['id']},
        )
        admin_plans = self.client.get('/api/invoice-plans').get_json()['data']
        self.assertEqual(
            {row['quotation']['id'] for row in admin_plans},
            {alice_quote['id'], manager_quote['id']},
        )
        admin_own_plans = self.client.get(
            '/api/invoice-plans', query_string={'mine': '1'},
        ).get_json()['data']
        self.assertEqual(admin_own_plans, [])

        admin_quote = self.create_quote('Admin Billing Project')
        admin_quote = self.client.put(
            f"/api/quotations/{admin_quote['id']}",
            json={**admin_quote, 'status': 'accepted'},
        ).get_json()['data']
        admin_own_plans = self.client.get(
            '/api/invoice-plans', query_string={'mine': '1'},
        ).get_json()['data']
        self.assertEqual(
            [row['quotation']['id'] for row in admin_own_plans],
            [admin_quote['id']],
        )

    def test_finance_reference_data_is_cached_for_each_request(self):
        with app_module.app.test_request_context('/api/quotations'):
            first_departments = app_module._load_departments()
            second_departments = app_module._load_departments()
            first_settings = app_module._load_pdf_settings()
            second_settings = app_module._load_pdf_settings()

        self.assertIs(first_departments, second_departments)
        self.assertIs(first_settings, second_settings)

    def test_current_finance_schema_skips_migration_on_read(self):
        self.create_quote('Current Schema')

        with patch.object(app_module, '_migrate_finance_data') as migrate:
            response = self.client.get('/api/quotations?view=summary&limit=10')

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        migrate.assert_not_called()

    def test_quotation_summary_is_lightweight_and_paginated(self):
        created = {
            self.create_quote('First Project')['id'],
            self.create_quote('Second Project')['id'],
            self.create_quote('Third Project')['id'],
        }

        with patch.object(app_module, '_normalise_finance_document') as normalise:
            first_response = self.client.get(
                '/api/quotations?view=summary&limit=2&offset=0'
            )
        self.assertEqual(
            first_response.status_code,
            200,
            first_response.get_data(as_text=True),
        )
        normalise.assert_not_called()
        first_payload = first_response.get_json()
        self.assertEqual(len(first_payload['data']), 2)
        self.assertEqual(first_payload['meta']['total'], 3)
        self.assertTrue(first_payload['meta']['hasMore'])
        self.assertEqual(first_payload['meta']['nextOffset'], 2)
        self.assertNotIn('lineItems', first_payload['data'][0])

        second_payload = self.client.get(
            '/api/quotations?view=summary&limit=2&offset=2'
        ).get_json()
        self.assertEqual(len(second_payload['data']), 1)
        self.assertFalse(second_payload['meta']['hasMore'])
        self.assertIsNone(second_payload['meta']['nextOffset'])
        listed_ids = {
            row['id']
            for row in first_payload['data'] + second_payload['data']
        }
        self.assertEqual(listed_ids, created)

        number_sorted = self.client.get(
            '/api/quotations?view=summary&limit=10&sort=number'
        ).get_json()['data']
        number_values = [row['number'] for row in number_sorted]
        self.assertEqual(number_values, sorted(number_values, reverse=True))

        full_row = self.client.get('/api/quotations').get_json()['data'][0]
        self.assertIn('lineItems', full_row)

    def test_quotation_summary_can_be_filtered_by_status(self):
        draft = self.create_quote('Draft Project')
        cancelled = self.create_quote('Cancelled Project')
        cancelled = self.client.put(
            f"/api/quotations/{cancelled['id']}",
            json={'status': 'cancelled'},
        ).get_json()['data']

        draft_payload = self.client.get(
            '/api/quotations',
            query_string={'view': 'summary', 'status': 'draft'},
        ).get_json()
        self.assertEqual([row['id'] for row in draft_payload['data']], [draft['id']])
        self.assertEqual(draft_payload['meta']['total'], 1)
        self.assertEqual(draft_payload['meta']['statusTotal'], 2)
        self.assertEqual(draft_payload['meta']['statusCounts']['draft'], 1)
        self.assertEqual(draft_payload['meta']['statusCounts']['cancelled'], 1)

        cancelled_payload = self.client.get(
            '/api/quotations',
            query_string={'view': 'summary', 'status': 'cancelled'},
        ).get_json()
        self.assertEqual(
            [row['id'] for row in cancelled_payload['data']],
            [cancelled['id']],
        )
        self.assertEqual(cancelled_payload['meta']['total'], 1)

        combined_payload = self.client.get(
            '/api/quotations',
            query_string=[
                ('view', 'summary'),
                ('status', 'draft'),
                ('status', 'cancelled'),
            ],
        ).get_json()
        self.assertEqual(
            {row['id'] for row in combined_payload['data']},
            {draft['id'], cancelled['id']},
        )
        self.assertEqual(combined_payload['meta']['total'], 2)
        self.assertEqual(
            self.client.get('/api/quotations?status=not-a-status').status_code,
            400,
        )

        project_root = os.path.dirname(os.path.dirname(__file__))
        with open(
            os.path.join(project_root, 'static', 'js', 'finance.js'),
            encoding='utf-8',
        ) as source_file:
            source = source_file.read()
        self.assertIn("params.append('status', status)", source)
        self.assertIn('financeListStatusFiltersHtml()', source)
        self.assertIn('listStatuses: []', source)
        self.assertIn('financeToggleListStatus', source)
        self.assertIn('finance-list-status-filters', source)

    def test_sales_admin_can_manage_all_quotations_but_sales_manager_only_their_own(self):
        alice_quote = self.create_quote('Alice Project')

        self.login('sales-manager')
        manager_quote = self.create_quote('Manager Project')
        manager_visible = self.client.get('/api/quotations').get_json()['data']
        self.assertEqual([row['id'] for row in manager_visible], [manager_quote['id']])
        self.assertEqual(
            self.client.get(f"/api/quotations/{alice_quote['id']}").status_code,
            404,
        )
        self.assertEqual(
            self.client.put(
                f"/api/quotations/{alice_quote['id']}",
                json={'projectName': 'Manager should not change this'},
            ).status_code,
            404,
        )

        self.login('sales-admin')
        admin_visible = self.client.get('/api/quotations').get_json()['data']
        self.assertEqual(
            {row['id'] for row in admin_visible},
            {alice_quote['id'], manager_quote['id']},
        )
        admin_own = self.client.get(
            '/api/quotations',
            query_string={'mine': '1'},
        ).get_json()['data']
        self.assertEqual(admin_own, [])
        edit_response = self.client.put(
            f"/api/quotations/{alice_quote['id']}",
            json={
                'projectName': 'Updated by sales admin',
                'salesperson': 'Sales Admin',
                'salespersonUsername': 'sales-admin',
            },
        )
        self.assertEqual(edit_response.status_code, 200, edit_response.get_data(as_text=True))
        self.assertEqual(
            edit_response.get_json()['data']['projectName'],
            'Updated by sales admin',
        )
        admin_own = self.client.get(
            '/api/quotations',
            query_string={'mine': '1'},
        ).get_json()['data']
        self.assertEqual([row['id'] for row in admin_own], [alice_quote['id']])
        with open(
            os.path.join(os.path.dirname(app_module.__file__), 'static', 'js', 'finance.js'),
            encoding='utf-8',
        ) as source_file:
            source = source_file.read()
        with open(
            os.path.join(os.path.dirname(app_module.__file__), 'static', 'js', 'costing.js'),
            encoding='utf-8',
        ) as source_file:
            costing_source = source_file.read()
        with open(
            os.path.join(os.path.dirname(app_module.__file__), 'static', 'css', 'finance.css'),
            encoding='utf-8',
        ) as source_file:
            stylesheet = source_file.read()
        self.assertIn('mineOnly: true', source)
        self.assertIn("typeof isPlatformAdminUser === 'function'", source)
        self.assertIn("params.set('mine', '1')", source)
        self.assertIn('finance-list-mine-toggle', source)
        self.assertIn('My projects</button>', source)
        self.assertIn('mineOnly: true', costing_source)
        self.assertIn('costing-list-mine-toggle', costing_source)
        self.assertIn('My projects</button>', costing_source)
        self.assertIn('finance-toolbar-title-line', source)
        self.assertIn(
            '.finance-toolbar-title-line .finance-list-mine-toggle {',
            stylesheet,
        )
        self.assertIn('flex: none;', stylesheet)

    def test_selected_salesperson_account_controls_quotation_ownership(self):
        quotation = self.create_quote('Reassigned Project')
        reassigned = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json={
                'salesperson': 'bob',
                'salespersonUsername': 'bob',
            },
        )
        self.assertEqual(reassigned.status_code, 200, reassigned.get_data(as_text=True))

        self.assertEqual(
            self.client.get(f"/api/quotations/{quotation['id']}").status_code,
            404,
        )
        self.login('bob')
        visible = self.client.get('/api/quotations').get_json()['data']
        self.assertEqual([row['id'] for row in visible], [quotation['id']])
        self.assertEqual(
            self.client.get(f"/api/quotations/{quotation['id']}").status_code,
            200,
        )

    def test_quotation_status_transition_queues_notification(self):
        quotation = self.create_quote('Notification Project')
        with patch.object(
            app_module, '_queue_quotation_status_notification'
        ) as queue_status:
            response = self.client.put(
                f"/api/quotations/{quotation['id']}",
                json={'status': 'sent'},
            )

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertEqual(queue_status.call_args.kwargs['previous_status'], 'draft')
        self.assertEqual(queue_status.call_args.kwargs['new_status'], 'sent')

    def test_sent_snapshot_revision_expiry_and_statuses(self):
        quotation = self.create_quote('Revision Project')
        quotation['quotationDate'] = '2025-01-15'
        quotation = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json=quotation,
        ).get_json()['data']
        selected_sent_date = (datetime.now() - timedelta(days=2)).strftime('%Y-%m-%d')
        expected_valid_until = (datetime.now() + timedelta(days=12)).strftime('%Y-%m-%d')
        sent = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json={'status': 'sent', 'sentDate': selected_sent_date, 'validityDays': 14},
        ).get_json()['data']
        self.assertEqual(sent['status'], 'sent')
        self.assertEqual(sent['revision'], 1)
        self.assertEqual(len(sent['revisions']), 1)
        self.assertTrue(sent['number'].endswith('-01'))
        self.assertEqual(sent['validityDays'], 14)
        self.assertEqual(sent['revisions'][0]['validityDays'], 14)
        self.assertEqual(sent['sentAt'][:10], selected_sent_date)
        self.assertEqual(sent['quotationDate'], selected_sent_date)
        self.assertEqual(sent['validUntil'], expected_valid_until)

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
        self.assertEqual(revised['quotationDate'], datetime.now().strftime('%Y-%m-%d'))

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

    def test_accepting_a_draft_creates_a_saved_version(self):
        quotation = self.create_quote('Direct Acceptance Project')
        self.assertEqual(quotation['status'], 'draft')
        self.assertEqual(quotation['revisions'], [])

        response = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json={'status': 'accepted'},
        )

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        accepted = response.get_json()['data']
        self.assertEqual(accepted['status'], 'accepted')
        self.assertEqual(accepted['revision'], 1)
        self.assertEqual(len(accepted['revisions']), 1)
        saved_version = accepted['revisions'][0]
        self.assertEqual(saved_version['revision'], 1)
        self.assertEqual(saved_version['number'], accepted['number'])
        self.assertEqual(saved_version['acceptedAt'], accepted['acceptedAt'])
        self.assertEqual(
            saved_version['snapshot']['projectName'],
            'Direct Acceptance Project',
        )

        archived_pdf = self.client.get(
            f"/api/quotations/{quotation['id']}/pdf?revision=1"
        )
        self.assertEqual(archived_pdf.status_code, 200)

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
        self.login('sales-admin')
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

    def test_expired_quotation_status_changes_preserve_revision(self):
        for status in ('accepted', 'cancelled', 'sent', 'draft'):
            with self.subTest(status=status):
                quotation = self.create_quote(f'Expired to {status}')
                endpoint = f"/api/quotations/{quotation['id']}"
                response = self.client.put(endpoint, json={
                    'status': 'sent',
                    'sentDate': (datetime.now() - timedelta(days=3)).strftime('%Y-%m-%d'),
                    'validityDays': 1,
                    'documentVersion': quotation['documentVersion'],
                })
                self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
                expired = self.client.get(endpoint).get_json()['data']
                self.assertEqual(expired['status'], 'expired')
                payload = {
                    'status': status,
                    'documentVersion': expired['documentVersion'],
                }
                if status == 'sent':
                    payload.update({
                        'sentDate': datetime.now().strftime('%Y-%m-%d'),
                        'validityAmount': 30,
                        'validityUnit': 'days',
                        'validityDays': 30,
                    })
                response = self.client.put(endpoint, json=payload)
                self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
                for result in (response.get_json()['data'], self.client.get(endpoint).get_json()['data']):
                    self.assertEqual(result['status'], status)
                    self.assertEqual(result['revision'], expired['revision'])
                    self.assertEqual(result['number'], expired['number'])
                    self.assertEqual(len(result['revisions']), len(expired['revisions']))
                    if status == 'accepted':
                        self.assertTrue(result['eventId'])

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
        exported = self.client.get(f"/api/quotations/{quotation['id']}/pdf?v=restored")
        self.assertEqual(exported.status_code, 200)
        exported_text = '\n'.join(
            page.extract_text() or ''
            for page in PdfReader(io.BytesIO(exported.data)).pages
        )
        self.assertIn(discarded['number'], exported_text)
        self.assertNotIn(discarded['number'][:-2] + '02', exported_text)

    def test_discard_revision_reconciles_draft_only_costing_lines(self):
        quotation = self.create_quote('Discard Changed Lines Project')
        sent_line = {
            'id': 'sent-line',
            'description': 'Original speaker',
            'department': 'Audio Department',
            'departmentCode': 'AX',
            'days': 1,
            'quantity': 1,
            'uom': 'units',
            'unitPrice': 100,
            'discountPercent': 0,
            'subprojectId': 'main',
        }
        prepared = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json={**quotation, 'lineItems': [sent_line]},
        ).get_json()['data']
        sent = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json={**prepared, 'status': 'sent'},
        ).get_json()['data']

        draft_line = {
            **sent_line,
            'id': 'draft-only-line',
            'description': 'Temporary draft speaker',
        }
        revised_response = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json={**sent, 'lineItems': [draft_line]},
        )
        self.assertEqual(
            revised_response.status_code,
            200,
            revised_response.get_data(as_text=True),
        )
        revised = revised_response.get_json()['data']
        self.assertEqual((revised['revision'], revised['status']), (2, 'draft'))

        before_discard = app_module._load_finance_data()
        draft_costing = app_module._linked_costing_for_quotation(
            before_discard,
            revised,
        )
        self.assertEqual(
            {line['quotationLineId'] for line in draft_costing['lineItems']},
            {'draft-only-line'},
        )

        response = self.client.post(
            f"/api/quotations/{quotation['id']}/discard-revision"
        )

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        restored = response.get_json()['data']
        self.assertEqual((restored['revision'], restored['status']), (1, 'sent'))
        self.assertEqual([line['id'] for line in restored['lineItems']], ['sent-line'])
        after_discard = app_module._load_finance_data()
        restored_costing = app_module._linked_costing_for_quotation(
            after_discard,
            restored,
        )
        self.assertEqual(
            {line['quotationLineId'] for line in restored_costing['lineItems']},
            {'sent-line'},
        )
        app_module._validate_linked_line_store(
            after_discard,
            require_projections=True,
        )

    def test_discard_draft_revision_reapplies_automatic_expiry(self):
        quotation = self.create_quote('Expired Discard Project')
        sent = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json={**quotation, 'status': 'sent'},
        ).get_json()['data']
        yesterday = (datetime.now() - timedelta(days=1)).strftime('%Y-%m-%d')
        finance_data = app_module._load_finance_data()
        stored = app_module._finance_find_document(
            finance_data,
            quotation['id'],
            'quotation',
        )
        stored['validUntil'] = yesterday
        stored['revisions'][0]['validUntil'] = yesterday
        stored['revisions'][0]['snapshot']['validUntil'] = yesterday
        app_module._save_finance_data(finance_data)

        expired = self.client.get(
            f"/api/quotations/{quotation['id']}"
        ).get_json()['data']
        self.assertEqual(expired['status'], 'expired')
        revised = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json={**expired, 'notes': 'Create a temporary second version'},
        ).get_json()['data']
        self.assertEqual((revised['revision'], revised['status']), (2, 'draft'))

        response = self.client.post(
            f"/api/quotations/{quotation['id']}/discard-revision"
        )
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        discarded = response.get_json()['data']
        self.assertEqual((discarded['revision'], discarded['status']), (1, 'expired'))
        self.assertTrue(discarded['number'].endswith('-01'))
        listed = self.client.get('/api/quotations?view=summary').get_json()['data']
        listed_quote = next(row for row in listed if row['id'] == quotation['id'])
        self.assertEqual((listed_quote['revision'], listed_quote['status']), (1, 'expired'))
        self.assertEqual(listed_quote['revisions'][0]['status'], 'expired')

    def test_saved_version_status_is_restored_and_latest_version_takes_precedence(self):
        quotation = self.create_quote('Version Status Project')
        sent_one = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json={**quotation, 'status': 'sent'},
        ).get_json()['data']
        sent_one['notes'] = 'Create version two'
        draft_two = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json=sent_one,
        ).get_json()['data']
        self.assertEqual((draft_two['revision'], draft_two['status']), (2, 'draft'))
        self.assertEqual(draft_two['revisions'][0]['status'], 'sent')

        finance_data = app_module._load_finance_data()
        stored = app_module._finance_find_document(
            finance_data,
            quotation['id'],
            'quotation',
        )
        yesterday = (datetime.now() - timedelta(days=1)).strftime('%Y-%m-%d')
        stored['revisions'][0]['validUntil'] = yesterday
        stored['revisions'][0]['snapshot']['validUntil'] = yesterday
        app_module._save_finance_data(finance_data)
        listed = self.client.get('/api/quotations?view=summary').get_json()['data']
        listed_quote = next(row for row in listed if row['id'] == quotation['id'])
        self.assertEqual((listed_quote['revision'], listed_quote['status']), (2, 'draft'))
        self.assertEqual(listed_quote['revisions'][0]['status'], 'expired')

        accepted_two = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json={'status': 'accepted'},
        ).get_json()['data']
        self.assertEqual((accepted_two['revision'], accepted_two['status']), (2, 'accepted'))
        self.assertEqual(
            [(row['revision'], row['status']) for row in accepted_two['revisions']],
            [(1, 'expired'), (2, 'accepted')],
        )

        accepted_two['notes'] = 'Temporary version three'
        draft_three = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json=accepted_two,
        ).get_json()['data']
        self.assertEqual((draft_three['revision'], draft_three['status']), (3, 'draft'))
        restored = self.client.post(
            f"/api/quotations/{quotation['id']}/discard-revision"
        ).get_json()['data']
        self.assertEqual((restored['revision'], restored['status']), (2, 'accepted'))
        self.assertTrue(restored['number'].endswith('-02'))

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
            json={
                **edited,
                'notes': 'Revision one corrected again',
                'documentVersion': sent_two['documentVersion'],
            },
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

    def test_deleting_only_saved_revision_rebases_custom_unsaved_draft(self):
        quotation = self.create_quote('Custom Draft Revision Rebase')
        custom = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json={
                **quotation,
                'customNumber': True,
                'number': 'TC-2027-002-01',
            },
        ).get_json()['data']
        sent = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json={**custom, 'status': 'sent'},
        ).get_json()['data']
        reopened = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json={'status': 'draft'},
        ).get_json()['data']
        draft_two = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json={**reopened, 'notes': 'Keep this unsaved draft content'},
        ).get_json()['data']

        self.assertEqual((draft_two['revision'], draft_two['status']), (2, 'draft'))
        self.assertEqual(draft_two['number'], 'TC-2027-002-02')
        self.assertEqual([row['revision'] for row in draft_two['revisions']], [1])

        rebased = self.client.delete(
            f"/api/quotations/{quotation['id']}/revisions/1"
        ).get_json()['data']
        self.assertEqual((rebased['revision'], rebased['status']), (1, 'draft'))
        self.assertEqual(rebased['number'], 'TC-2027-002-01')
        self.assertEqual(rebased['revisions'], [])
        self.assertEqual(rebased['notes'], 'Keep this unsaved draft content')

        malformed = {
            **draft_two,
            'revisions': [],
        }
        normalised = app_module._normalise_finance_document(
            malformed,
            'quotation',
            malformed,
        )
        self.assertEqual((normalised['revision'], normalised['status']), (1, 'draft'))
        self.assertEqual(normalised['number'], 'TC-2027-002-01')

    def test_editing_saved_revision_relinks_legacy_line_ids_without_losing_costs(self):
        quotation = self.create_quote('Legacy Revision Line IDs')
        quotation['lineItems'] = [{
            'id': 'canonical-quote-line',
            'description': 'Original quoted service',
            'department': 'Audio Department',
            'departmentCode': 'AX',
            'days': 1,
            'quantity': 1,
            'uom': 'units',
            'unitPrice': 500,
            'discountPercent': 0,
            'subprojectId': 'main',
        }]
        quotation = self.client.put(
            f"/api/quotations/{quotation['id']}", json=quotation,
        ).get_json()['data']

        costing = self.client.get(
            f"/api/costings/{quotation['sourceCostingId']}"
        ).get_json()['data']
        costing['lineItems'][0]['itemCost'] = 175
        costing_response = self.client.put(
            f"/api/costings/{costing['id']}", json=costing,
        )
        self.assertEqual(
            costing_response.status_code, 200, costing_response.get_data(as_text=True)
        )

        quotation = self.client.get(
            f"/api/quotations/{quotation['id']}"
        ).get_json()['data']
        sent = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json={**quotation, 'status': 'sent'},
        ).get_json()['data']

        finance_data = app_module._load_finance_data()
        stored = app_module._finance_find_document(
            finance_data, quotation['id'], 'quotation'
        )
        stored['revisions'][0]['snapshot']['lineItems'][0]['id'] = 'legacy-snapshot-line'
        app_module._save_finance_data(finance_data)

        detail = self.client.get(
            f"/api/quotations/{quotation['id']}"
        ).get_json()['data']
        snapshot = copy.deepcopy(detail['revisions'][0]['snapshot'])
        snapshot['lineItems'][0]['description'] = 'Corrected quoted service'
        snapshot['documentVersion'] = detail['documentVersion']

        edited_response = self.client.put(
            f"/api/quotations/{quotation['id']}/revisions/1",
            json=snapshot,
        )

        self.assertEqual(
            edited_response.status_code, 200, edited_response.get_data(as_text=True)
        )
        edited = edited_response.get_json()['data']
        self.assertEqual(edited['lineItems'][0]['id'], 'canonical-quote-line')
        self.assertEqual(
            edited['lineItems'][0]['description'], 'Corrected quoted service'
        )
        self.assertEqual((edited['revision'], edited['status']), (1, 'sent'))
        self.assertGreater(edited['documentVersion'], sent['documentVersion'])

        refreshed_costing = self.client.get(
            f"/api/costings/{quotation['sourceCostingId']}"
        ).get_json()['data']
        self.assertEqual(refreshed_costing['lineItems'][0]['itemCost'], 175)
        self.assertEqual(
            refreshed_costing['lineItems'][0]['quotationLineId'],
            'canonical-quote-line',
        )

    def test_summary_page_hydrates_saved_version_before_editing(self):
        quotation = self.create_quote('Summary Version Editing')
        quotation['lineItems'] = [{
            'id': 'saved-version-line',
            'description': 'Archived quoted item',
            'department': 'Audio Department',
            'days': 1,
            'quantity': 2,
            'uom': 'units',
            'unitPrice': 150,
            'discountPercent': 0,
            'subprojectId': 'main',
        }]
        sent = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json={**quotation, 'status': 'sent'},
        ).get_json()['data']

        listed = self.client.get('/api/quotations?view=summary').get_json()['data']
        summary = next(row for row in listed if row['id'] == quotation['id'])
        self.assertIs(summary['revisions'][0]['snapshot'], True)
        detail = self.client.get(f"/api/quotations/{quotation['id']}").get_json()['data']
        self.assertEqual(
            detail['revisions'][0]['snapshot']['lineItems'][0]['description'],
            'Archived quoted item',
        )

        source = Path('static/js/finance.js').read_text(encoding='utf-8')
        start = source.index('async function financeEditRevision')
        end = source.index('async function financeDeleteRevision', start)
        edit_source = source[start:end]
        self.assertIn('if (snapshotRow.snapshot === true)', edit_source)
        self.assertIn(
            'apiCall(`/api/quotations/${encodeURIComponent(documentId)}`)',
            edit_source,
        )
        self.assertIn("typeof snapshotRow.snapshot !== 'object'", edit_source)
        self.assertIn('updateAppDetailHistory(`/quotations/', edit_source)

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
        self.assertFalse(invoice['showSignOff'])
        invoice_pdf = self.client.get(f"/api/invoices/{invoice['id']}/pdf")
        invoice_text = '\n'.join(
            page.extract_text() or ''
            for page in PdfReader(io.BytesIO(invoice_pdf.data)).pages
        )
        self.assertIn('Quotation ref', invoice_text)
        self.assertIn(accepted['number'], invoice_text)
        self.assertIn('$123.45', invoice_text)
        self.assertNotIn('Confirmed & accepted by:', invoice_text)
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
        quotation['number'] = 'CLIENT-PROPOSAL-77'
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

    def test_quotation_number_base_must_be_unique_within_company(self):
        first = self.create_quote('First')
        second = self.create_quote('Second')

        duplicate_base = self.client.put(
            f"/api/quotations/{second['id']}",
            json={
                **second,
                'number': app_module._finance_number_with_revision(first['number'], 42),
                'customNumber': True,
            },
        )
        self.assertEqual(duplicate_base.status_code, 409)
        self.assertIn('already in use', duplicate_base.get_json()['error'])

        renamed = self.client.put(
            f"/api/quotations/{second['id']}",
            json={**second, 'number': 'CLIENT-PROPOSAL-01', 'customNumber': True},
        )
        self.assertEqual(renamed.status_code, 200, renamed.get_data(as_text=True))
        self.assertEqual(renamed.get_json()['data']['number'], 'CLIENT-PROPOSAL-01')

    def test_renumbering_sent_quotation_keeps_new_base_on_next_revision(self):
        quotation = self.create_quote('Renumber Sent')
        sent = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json={
                **quotation,
                'status': 'sent',
                'sentDate': datetime.now().strftime('%Y-%m-%d'),
            },
        ).get_json()['data']

        response = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json={**sent, 'number': 'CLIENT-RENAMED-01', 'customNumber': True},
        )

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        renumbered = response.get_json()['data']
        self.assertEqual(renumbered['number'], 'CLIENT-RENAMED-02')
        self.assertEqual(renumbered['revision'], 2)
        self.assertEqual(renumbered['status'], 'draft')

    def test_accounting_page_supports_company_admin_and_read_only_owner(self):
        page = self.client.get('/accounting')
        self.assertEqual(page.status_code, 302)
        self.assertTrue(page.headers['Location'].endswith('/events'))
        self.assertEqual(self.client.get('/api/finance/accounting').status_code, 403)

        self.login('sales-admin')
        page = self.client.get('/accounting')
        self.assertEqual(page.status_code, 200)
        self.assertIn(b'accounting.js', page.data)
        response = self.client.get('/api/finance/accounting')
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        data = response.get_json()['data']
        self.assertEqual(data['settings']['gstRate'], 9.0)
        self.assertTrue(any(row['code'] == '4000' for row in data['accounts']))

        self.login('bnjm2000')
        self.assertEqual(self.client.get('/accounting').status_code, 200)
        owner_workspace = self.client.get('/api/finance/accounting')
        self.assertEqual(
            owner_workspace.status_code,
            200,
            owner_workspace.get_data(as_text=True),
        )
        self.assertEqual(
            owner_workspace.get_json()['data']['workspace']['permissions'],
            ['read'],
        )
        self.assertNotIn(
            'bnjm2000',
            owner_workspace.get_json()['data']['accountingUsers'],
        )
        self.assertEqual(
            self.client.put('/api/finance/accounting/settings', json={}).status_code,
            403,
        )

    def test_accounting_balanced_journal_gst_reports_and_reversal(self):
        self.login('sales-admin')
        settings = self.client.put('/api/finance/accounting/settings', json={
            'gstRegistered': True,
            'gstRegistrationNumber': 'M21234567K',
            'gstRate': 9,
            'filingFrequency': 'quarterly',
            'financialYearStartMonth': 1,
            'recordRetentionYears': 5,
            'accountingBasis': 'accrual',
            'periodLockDate': '',
        })
        self.assertEqual(settings.status_code, 200, settings.get_data(as_text=True))

        unbalanced = self.client.post('/api/finance/accounting/journals', json={
            'date': datetime.now().strftime('%Y-%m-%d'),
            'description': 'Unbalanced sale',
            'status': 'posted',
            'lines': [
                {'accountCode': '1100', 'debit': 109, 'credit': 0},
                {'accountCode': '4000', 'debit': 0, 'credit': 100},
            ],
        })
        self.assertEqual(unbalanced.status_code, 400)

        posted = self.client.post('/api/finance/accounting/journals', json={
            'date': datetime.now().strftime('%Y-%m-%d'),
            'description': 'GST sale',
            'reference': 'INV-TEST-001',
            'status': 'posted',
            'lines': [
                {'accountCode': '1100', 'debit': 109, 'credit': 0},
                {
                    'accountCode': '4000',
                    'debit': 0,
                    'credit': 100,
                    'taxCode': 'SR9',
                    'taxBase': 100,
                    'gstAmount': 9,
                },
                {'accountCode': '2100', 'debit': 0, 'credit': 9},
            ],
        })
        self.assertEqual(posted.status_code, 201, posted.get_data(as_text=True))
        posted_data = posted.get_json()['data']
        self.assertEqual(posted_data['summary']['receivables'], 109)
        self.assertEqual(posted_data['summary']['revenue'], 100)
        self.assertEqual(posted_data['gst']['box1'], 100)
        self.assertEqual(posted_data['gst']['box6'], 9)
        self.assertEqual(posted_data['gst']['box8'], 9)
        journal_id = posted.get_json()['journal']['id']

        edit_posted = self.client.put(
            f'/api/finance/accounting/journals/{journal_id}',
            json={'description': 'Changed'},
        )
        self.assertEqual(edit_posted.status_code, 409)

        reversed_response = self.client.post(
            f'/api/finance/accounting/journals/{journal_id}/reverse',
            json={},
        )
        self.assertEqual(
            reversed_response.status_code,
            200,
            reversed_response.get_data(as_text=True),
        )
        reversed_data = reversed_response.get_json()['data']
        self.assertEqual(reversed_data['summary']['receivables'], 0)
        self.assertEqual(reversed_data['summary']['revenue'], 0)
        self.assertEqual(reversed_data['gst']['box1'], 0)
        self.assertEqual(reversed_data['gst']['box6'], 0)

    def test_accounting_source_document_can_only_be_posted_once(self):
        self.login('sales-admin')
        quotation = self.create_quote('Accounting Source')
        quotation['taxRate'] = 9
        quotation['lineItems'] = [{
            'id': 'source-line',
            'department': 'Audio Department',
            'description': 'Production services',
            'quantity': 1,
            'days': 1,
            'unitPrice': 100,
            'discountPercent': 0,
            'uom': 'lot',
        }]
        quotation = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json=quotation,
        ).get_json()['data']
        invoice = self.client.post(
            f"/api/quotations/{quotation['id']}/convert-to-invoice"
        ).get_json()['data']
        source_key = f"sales-invoice:{invoice['id']}"

        posted = self.client.post('/api/finance/accounting/sources/post', json={
            'sourceKey': source_key,
        })
        self.assertEqual(posted.status_code, 201, posted.get_data(as_text=True))
        self.assertEqual(posted.get_json()['journal']['debitTotal'], 109)
        repeated = self.client.post('/api/finance/accounting/sources/post', json={
            'sourceKey': source_key,
        })
        self.assertEqual(repeated.status_code, 400)
        self.assertIn('already been posted', repeated.get_json()['error'])

    def test_accounting_bank_import_matching_and_duplicate_detection(self):
        self.login('sales-admin')
        self.client.put('/api/finance/accounting/settings', json={
            'gstRegistered': True,
            'gstRegistrationNumber': 'M21234567K',
            'gstRate': 9,
            'filingFrequency': 'quarterly',
            'financialYearStartMonth': 1,
            'recordRetentionYears': 5,
            'accountingBasis': 'accrual',
            'periodLockDate': '',
        })
        today = datetime.now().strftime('%Y-%m-%d')
        csv_data = (
            'Date,Description,Reference,Debit,Credit\n'
            f'{today},Equipment repair,R-100,109.00,\n'
        ).encode('utf-8')
        imported = self.client.post(
            '/api/finance/accounting/bank-transactions/import',
            data={
                'file': (io.BytesIO(csv_data), 'bank.csv'),
                'bankAccount': '1000',
            },
            content_type='multipart/form-data',
        )
        self.assertEqual(imported.status_code, 200, imported.get_data(as_text=True))
        imported_json = imported.get_json()
        self.assertEqual(imported_json['imported'], 1)
        transaction = imported_json['data']['bankTransactions'][0]
        self.assertEqual(transaction['amount'], -109)
        self.assertEqual(imported_json['data']['bankSummary']['difference'], -109)

        duplicate = self.client.post(
            '/api/finance/accounting/bank-transactions/import',
            data={
                'file': (io.BytesIO(csv_data), 'bank.csv'),
                'bankAccount': '1000',
            },
            content_type='multipart/form-data',
        ).get_json()
        self.assertEqual(duplicate['imported'], 0)
        self.assertEqual(duplicate['duplicates'], 1)

        matched = self.client.post(
            f"/api/finance/accounting/bank-transactions/{transaction['id']}/match",
            json={
                'accountCode': '6300',
                'taxCode': 'TX9',
                'description': 'Equipment repair',
            },
        )
        self.assertEqual(matched.status_code, 200, matched.get_data(as_text=True))
        matched_data = matched.get_json()['data']
        self.assertEqual(matched_data['bankSummary']['difference'], 0)
        self.assertEqual(matched_data['gst']['box5'], 100)
        self.assertEqual(matched_data['gst']['box7'], 9)

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

        unpaired = self.client.put(
            f"/api/quotations/{paired_quote['id']}",
            json={
                'eventId': None,
                'documentVersion': paired_accepted['documentVersion'],
            },
        ).get_json()['data']
        self.assertIsNone(unpaired['eventId'])

    def test_asset_price_survives_rename_and_custom_rate_requires_product_opt_in(self):
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
        self.assertEqual(
            self.client.get(
                '/api/finance/catalog', query_string={'query': 'SB18 III'},
            ).get_json()['data'],
            [],
        )
        renamed_products = [
            row for row in self.client.get('/api/finance/products').get_json()['data']
            if row.get('brand') == 'L-Acoustics'
            and str(row.get('model') or '').startswith('SB18')
        ]
        self.assertEqual(len(renamed_products), 1)
        self.assertEqual(renamed_products[0]['model'], 'SB18 Renamed')
        self.assertEqual(renamed_products[0]['availableQuantity'], 1)

        custom_results = self.client.get(
            '/api/finance/catalog?query=Speclal'
        ).get_json()['data']
        self.assertEqual(custom_results, [])
        created_product = self.client.post('/api/finance/rate-card', json={
            **next(row for row in saved['lineItems'] if row['description'] == 'Speclal Operator Typo'),
            'isCustom': True,
        })
        self.assertEqual(created_product.status_code, 200, created_product.get_data(as_text=True))
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
        self.assertEqual(len(removed_results), 1)
        self.assertEqual(removed_results[0]['unitPrice'], 99)

        rate_row = self.client.get(
            '/api/finance/rate-card', query_string={'query': 'Speclal'},
        ).get_json()['data'][0]
        deleted = self.client.delete('/api/finance/rate-card', json=rate_row)
        self.assertEqual(deleted.status_code, 200, deleted.get_data(as_text=True))
        self.assertEqual(
            self.client.get(
                '/api/finance/catalog', query_string={'query': 'Speclal'},
            ).get_json()['data'],
            [],
        )

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

    def test_container_catalog_keeps_same_model_with_distinct_descriptions(self):
        self.data_manager.inventory['AX#02'] = InventoryItem(
            asset_id='AX#02',
            brand='L-Acoustics',
            model_number='SB18 III',
            serial_number='SN-2',
            description='Subwoofer with wheel board',
            is_missing=False,
            maintenance_logs=[],
            department_code='AX',
        )
        self.data_manager.containers['DRUM-1'] = Container(
            'DRUM-1', ['AX#01', 'AX#02'], serial_number='DRUM-SN-1'
        )

        rows = self.client.get(
            '/api/finance/catalog?query=DRUM-1'
        ).get_json()['data']
        container = next(row for row in rows if row.get('isContainer'))

        self.assertEqual(len(container['containerItems']), 2)
        self.assertEqual(
            {row['description'] for row in container['containerItems']},
            {'L-Acoustics SB18 III Subwoofer',
             'L-Acoustics SB18 III Subwoofer with wheel board'},
        )
        self.assertEqual(
            len({row['containerItemKey'] for row in container['containerItems']}),
            2,
        )
        self.assertEqual(
            len({row['catalogKey'] for row in container['containerItems']}),
            1,
        )

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

    def test_catalog_model_match_is_not_displaced_by_matching_container_names(self):
        self.data_manager.inventory['ESPRITE#01'] = InventoryItem(
            asset_id='ESPRITE#01',
            brand='Robe',
            model_number='ESPRITE',
            serial_number='ESPRITE-SN-1',
            description='Profile LED',
            is_missing=False,
            maintenance_logs=[],
            department_code='LX',
        )
        for index in range(35):
            container_id = f'Esprite Case #{index + 1:02d}'
            self.data_manager.containers[container_id] = Container(
                container_id,
                ['ESPRITE#01'],
            )

        response = self.client.get(
            '/api/finance/catalog', query_string={'query': 'Esprite'},
        )

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        rows = response.get_json()['data']
        product = next(
            row for row in rows
            if not row.get('isContainer') and row.get('model') == 'ESPRITE'
        )
        self.assertEqual(rows[0]['catalogKey'], product['catalogKey'])
        self.assertEqual(product['brand'], 'Robe')

    def test_products_list_inventory_but_not_unapproved_custom_quotation_items(self):
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
        self.assertNotIn('Special projection operator', by_description)
        self.assertEqual(
            rows,
            sorted(rows, key=lambda row: (
                row['department'].casefold(),
                ' '.join((row['brand'], row['model'], row['description'])).casefold(),
            )),
        )

        self.login('bob')
        bob_rows = self.client.get('/api/finance/rate-card').get_json()['data']
        self.assertTrue(bob_rows)
        self.assertTrue(all(not row.get('isCustom') for row in bob_rows))
        self.assertTrue(all(row.get('unitPrice') == 0 for row in bob_rows))

    def test_sales_admin_uses_latest_company_rate_while_managers_keep_their_own(self):
        catalog_line = self.client.get(
            '/api/finance/catalog?query=SB18'
        ).get_json()['data'][0]
        alice_quote = self.create_quote('Alice Rate')
        alice_quote['lineItems'] = [{
            **catalog_line,
            'id': 'alice-rate',
            'days': 1,
            'quantity': 1,
            'unitPrice': 410,
            'discountPercent': 0,
        }]
        self.client.put(
            f"/api/quotations/{alice_quote['id']}", json=alice_quote,
        )

        self.login('bob')
        bob_quote = self.create_quote('Bob Rate')
        bob_quote['lineItems'] = [{
            **catalog_line,
            'id': 'bob-rate',
            'days': 1,
            'quantity': 1,
            'unitPrice': 460,
            'discountPercent': 0,
        }]
        self.client.put(
            f"/api/quotations/{bob_quote['id']}", json=bob_quote,
        )

        bob_catalog = self.client.get(
            '/api/finance/catalog?query=SB18'
        ).get_json()['data'][0]
        self.assertEqual(bob_catalog['unitPrice'], 460)

        self.login('alice')
        alice_catalog = self.client.get(
            '/api/finance/catalog?query=SB18'
        ).get_json()['data'][0]
        self.assertEqual(alice_catalog['unitPrice'], 410)

        self.login('sales-admin')
        admin_catalog = self.client.get(
            '/api/finance/catalog?query=SB18'
        ).get_json()['data'][0]
        self.assertEqual(admin_catalog['unitPrice'], 460)
        admin_rate = next(
            row for row in self.client.get('/api/finance/rate-card').get_json()['data']
            if row.get('catalogKey') == catalog_line['catalogKey']
        )
        self.assertEqual(admin_rate['unitPrice'], 460)

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

    def test_products_are_shared_with_admins_and_sales_but_not_other_users(self):
        self.login('review-admin')
        available = self.client.get('/api/finance/products')
        self.assertEqual(available.status_code, 200, available.get_data(as_text=True))
        admin_page = self.client.get('/products')
        self.assertEqual(admin_page.status_code, 200)
        self.assertIn(
            'window.__INITIAL_APP_SECTION__ = "products"',
            admin_page.get_data(as_text=True),
        )
        inventory = next(
            row for row in available.get_json()['data']
            if row.get('model') == 'SB18 III'
        )
        self.assertEqual(inventory['sourceType'], 'inventory')
        self.assertEqual(inventory['availableQuantity'], 1)

        created = self.client.post('/api/finance/products', json={
            'productLabel': 'Admin-added consumable',
            'description': 'Admin-added consumable',
            'department': 'General',
            'unitPrice': 0,
            'uom': 'units',
            'isCustom': True,
        })
        self.assertEqual(created.status_code, 200, created.get_data(as_text=True))
        product = next(
            row for row in created.get_json()['data']
            if row['description'] == 'Admin-added consumable'
        )
        self.assertEqual(product['sourceType'], 'additional')
        self.assertEqual(product['unitPrice'], 0)
        self.assertEqual(product['brand'], '')
        self.assertEqual(product['model'], '')
        self.assertEqual(product['productLabel'], 'Admin-added consumable')

        self.login('alice')
        self.assertEqual(self.client.get('/products').status_code, 200)
        shared = self.client.get(
            '/api/finance/products', query_string={'query': 'Admin-added'},
        )
        self.assertEqual(shared.status_code, 200, shared.get_data(as_text=True))
        self.assertEqual(len(shared.get_json()['data']), 1)
        by_brand = self.client.get(
            '/api/finance/catalog', query_string={'query': 'acoustics l'},
        )
        self.assertEqual(by_brand.status_code, 200, by_brand.get_data(as_text=True))
        brand_matches = [
            row for row in by_brand.get_json()['data']
            if row.get('model') == 'SB18 III'
        ]
        self.assertEqual(len(brand_matches), 1)
        self.assertEqual(
            brand_matches[0]['productLabel'],
            'L-Acoustics SB18 III Subwoofer',
        )

        self.login('no-sales')
        denied = self.client.get('/api/finance/products')
        self.assertEqual(denied.status_code, 403)
        self.assertEqual(self.client.get('/products').status_code, 302)

    def test_zero_inventory_products_are_not_listed_or_suggested(self):
        finance_data = app_module._load_finance_data()
        stored_product = {
            'description': 'Subwoofer',
            'productLabel': 'L-Acoustics SB18 III Subwoofer',
            'productCategory': 'Audio Department',
            'department': 'Audio Department',
            'departmentCode': 'AX',
            'brand': 'L-Acoustics',
            'model': 'SB18 III',
            'unitPrice': 400,
            'uom': 'units',
        }
        finance_data.setdefault('priceBook', {})[
            'product::inventory:ax|l-acoustics|sb18 iii'
        ] = stored_product
        finance_data['priceBook']['product::asset:ax#01'] = stored_product
        app_module._save_finance_data(finance_data)

        original_quantity = app_module._asset_inventory_quantity

        def inventory_quantity(asset):
            if getattr(asset, 'asset_id', '') == 'AX#01':
                return 0
            return original_quantity(asset)

        with patch.object(
            app_module,
            '_asset_inventory_quantity',
            side_effect=inventory_quantity,
        ):
            products = self.client.get('/api/finance/products').get_json()['data']
            suggestions = self.client.get(
                '/api/finance/catalog', query_string={'query': 'SB18'},
            ).get_json()['data']

        self.assertFalse(any(row.get('model') == 'SB18 III' for row in products))
        self.assertFalse(any(row.get('model') == 'SB18 III' for row in suggestions))
        self.assertTrue(any(row.get('model') == 'Spiider' for row in products))
        remaining_keys = {
            key.casefold()
            for key in app_module._load_finance_data()['priceBook']
        }
        self.assertNotIn(
            'product::inventory:ax|l-acoustics|sb18 iii', remaining_keys
        )
        self.assertNotIn('product::asset:ax#01', remaining_keys)

        restored = self.client.get(
            '/api/finance/catalog', query_string={'query': 'SB18'},
        ).get_json()['data']
        restored_product = next(
            row for row in restored if row.get('model') == 'SB18 III'
        )
        self.assertEqual(restored_product['unitPrice'], 0)

    def test_catalog_search_skips_full_finance_hydration_for_current_data(self):
        self.create_quote('Fast Asset Search')
        with patch.object(
            app_module, '_load_finance_data',
            side_effect=AssertionError('Catalog search hydrated all finance lines'),
        ):
            response = self.client.get(
                '/api/finance/catalog', query_string={'query': 'SB18'},
            )
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        asset = next(
            row for row in response.get_json()['data']
            if row.get('model') == 'SB18 III'
        )
        self.assertEqual(asset['sourceAssetIds'], ['AX#01'])

        source = Path('static/js/finance.js').read_text(encoding='utf-8')
        self.assertIn('financeRunCatalogSearch(clean, cacheKey, requestSeq)', source)
        self.assertIn('catalogInFlight: false', source)
        self.assertIn('catalogQueuedSearch: null', source)
        self.assertIn('catalogQueuedSearch = { clean, cacheKey, requestSeq }', source)
        self.assertIn('searchInFlight: false', source)
        self.assertIn('queuedSearch = { query, requestSeq }', source)
        self.assertIn('}, 300)', source)
        self.assertIn('searchRequestSeq: 0', source)
        self.assertIn('signal: controller.signal', source)

    def test_product_price_changes_only_apply_to_future_quotation_additions(self):
        original_product = next(
            row for row in self.client.get('/api/finance/products').get_json()['data']
            if row.get('model') == 'SB18 III'
        )
        self.assertEqual(
            original_product['productLabel'],
            'L-Acoustics SB18 III Subwoofer',
        )
        priced = self.client.post('/api/finance/products', json={
            **original_product,
            'unitPrice': 100,
        })
        self.assertEqual(priced.status_code, 200, priced.get_data(as_text=True))

        quotation = self.create_quote('Existing Product Price')
        selected = self.client.get(
            '/api/finance/catalog', query_string={'query': 'SB18'},
        ).get_json()['data'][0]
        quotation['lineItems'] = [{
            **selected,
            'id': 'saved-product-line',
            'days': 1,
            'quantity': 1,
            'discountPercent': 0,
        }]
        saved = self.client.put(
            f"/api/quotations/{quotation['id']}", json=quotation,
        )
        self.assertEqual(saved.status_code, 200, saved.get_data(as_text=True))
        saved_line = saved.get_json()['data']['lineItems'][0]
        self.assertEqual(saved_line['unitPrice'], 100)

        updated = self.client.post('/api/finance/products', json={
            **original_product,
            'unitPrice': 175,
            'productLabel': 'Premium subwoofer package',
            'uom': 'lot',
        })
        self.assertEqual(updated.status_code, 200, updated.get_data(as_text=True))
        existing = self.client.get(
            f"/api/quotations/{quotation['id']}"
        ).get_json()['data']
        self.assertEqual(existing['lineItems'][0]['unitPrice'], 100)
        self.assertEqual(existing['lineItems'][0]['description'], saved_line['description'])
        self.assertEqual(existing['lineItems'][0]['uom'], saved_line['uom'])
        future = self.client.get(
            '/api/finance/catalog', query_string={'query': 'Premium subwoofer'},
        ).get_json()['data'][0]
        self.assertEqual(future['unitPrice'], 175)
        self.assertEqual(future['productLabel'], 'Premium subwoofer package')
        self.assertEqual(future['uom'], 'lot')
        by_inventory_identity = self.client.get(
            '/api/finance/catalog', query_string={'query': 'Subwoofer L-Acoustics'},
        ).get_json()['data']
        self.assertTrue(any(
            row.get('productKey') == original_product['productKey']
            for row in by_inventory_identity
        ))
        by_brand = self.client.get(
            '/api/finance/catalog', query_string={'query': 'L-Acoustics'},
        ).get_json()['data']
        same_product = next(row for row in by_brand if row.get('model') == 'SB18 III')
        self.assertEqual(same_product['productKey'], original_product['productKey'])
        self.assertEqual(same_product['productLabel'], 'Premium subwoofer package')

    def test_inventory_product_default_label_can_change_without_losing_identity(self):
        self.data_manager.inventory['AX#02'] = InventoryItem(
            asset_id='AX#02',
            brand='Shure',
            model_number='ULXD2 (L50)',
            serial_number='SHURE-1',
            description='handheld microphone',
            is_missing=False,
            maintenance_logs=[],
            department_code='AX',
        )
        self.data_manager.save_inventory()

        product = next(
            row for row in self.client.get('/api/finance/products').get_json()['data']
            if row.get('model') == 'ULXD2 (L50)'
        )
        self.assertEqual(
            product['productLabel'],
            'Shure ULXD2 (L50) handheld microphone',
        )
        product_key = product['productKey']

        updated = self.client.post('/api/finance/products', json={
            **product,
            'productLabel': 'Wireless handheld mic',
        })
        self.assertEqual(updated.status_code, 200, updated.get_data(as_text=True))

        by_custom_label = self.client.get(
            '/api/finance/catalog', query_string={'query': 'Wireless handheld'},
        ).get_json()['data']
        by_inventory_fields = self.client.get(
            '/api/finance/catalog', query_string={'query': 'Shure ULXD2 microphone'},
        ).get_json()['data']
        for rows in (by_custom_label, by_inventory_fields):
            matched = next(row for row in rows if row.get('model') == 'ULXD2 (L50)')
            self.assertEqual(matched['productKey'], product_key)
            self.assertEqual(matched['productLabel'], 'Wireless handheld mic')

    def test_product_category_can_change_and_category_delete_hides_sale_products(self):
        inventory = next(
            row for row in self.client.get('/api/finance/products').get_json()['data']
            if row.get('model') == 'SB18 III'
        )
        operational_department = inventory['department']
        moved = self.client.post('/api/finance/products', json={
            **inventory,
            'productCategory': 'Premium Audio',
        })
        self.assertEqual(moved.status_code, 200, moved.get_data(as_text=True))
        moved_inventory = next(
            row for row in moved.get_json()['data']
            if row.get('model') == 'SB18 III'
        )
        self.assertEqual(moved_inventory['productCategory'], 'Premium Audio')
        self.assertEqual(moved_inventory['department'], operational_department)

        added = self.client.post('/api/finance/products', json={
            'description': 'Premium audio technician',
            'productLabel': 'Premium audio technician',
            'department': 'Specialist Crew',
            'productCategory': 'Premium Audio',
            'unitPrice': 700,
            'uom': 'pax',
            'isCustom': True,
        })
        self.assertEqual(added.status_code, 200, added.get_data(as_text=True))
        catalog = self.client.get(
            '/api/finance/catalog', query_string={'query': 'Premium Audio'},
        ).get_json()['data']
        self.assertTrue(any(row.get('model') == 'SB18 III' for row in catalog))
        self.assertTrue(all(
            row.get('productCategory') == 'Premium Audio' for row in catalog
        ))

        deleted = self.client.delete(
            '/api/finance/products/category',
            json={'category': 'Premium Audio'},
        )
        self.assertEqual(deleted.status_code, 200, deleted.get_data(as_text=True))
        self.assertEqual(deleted.get_json()['deletedCount'], 1)
        self.assertEqual(deleted.get_json()['retainedInventoryCount'], 1)
        retained = self.client.get(
            '/api/finance/catalog', query_string={'query': 'SB18 III'},
        ).get_json()['data']
        self.assertTrue(any(
            row.get('model') == 'SB18 III' for row in retained
        ))
        self.assertFalse(any(
            row.get('productLabel') == 'Premium audio technician'
            for row in self.client.get('/api/finance/products').get_json()['data']
        ))
        denied_delete = self.client.delete(
            '/api/finance/products/category',
            json={'category': 'Premium Audio'},
        )
        self.assertEqual(denied_delete.status_code, 409)
        self.assertIn('AX#01', self.data_manager.inventory)
        self.assertEqual(self.data_manager.inventory['AX#01'].department_code, 'AX')

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

    def test_changed_line_price_does_not_overwrite_rate_card_or_other_quotes(self):
        catalog_line = self.client.get(
            '/api/finance/catalog?query=SB18'
        ).get_json()['data'][0]
        first = self.create_quote('First Rate Snapshot')
        second = self.create_quote('Second Rate Snapshot')

        for quotation, line_id in ((first, 'first-rate'), (second, 'second-rate')):
            quotation['lineItems'] = [{
                **catalog_line,
                'id': line_id,
                'days': 1,
                'quantity': 1,
                'uom': 'sqm',
                'unitPrice': 100,
                'discountPercent': 0,
            }]
            saved = self.client.put(
                f"/api/quotations/{quotation['id']}",
                json=quotation,
            )
            self.assertEqual(saved.status_code, 200, saved.get_data(as_text=True))
            quotation.update(saved.get_json()['data'])

        first['lineItems'][0]['unitPrice'] = 175
        changed = self.client.put(
            f"/api/quotations/{first['id']}",
            json=first,
        )
        self.assertEqual(changed.status_code, 200, changed.get_data(as_text=True))

        remembered = self.client.get(
            '/api/finance/catalog?query=SB18'
        ).get_json()['data'][0]
        self.assertEqual(remembered['unitPrice'], 100)
        self.assertEqual(remembered['uom'], 'sqm')

        second['notes'] = 'An unrelated change to the older quotation'
        unchanged_price_save = self.client.put(
            f"/api/quotations/{second['id']}",
            json=second,
        )
        self.assertEqual(
            unchanged_price_save.status_code,
            200,
            unchanged_price_save.get_data(as_text=True),
        )
        self.assertEqual(
            unchanged_price_save.get_json()['data']['lineItems'][0]['unitPrice'],
            100,
        )
        remembered_after_autosave = self.client.get(
            '/api/finance/catalog?query=SB18'
        ).get_json()['data'][0]
        self.assertEqual(remembered_after_autosave['unitPrice'], 100)

    def test_remembered_inventory_rate_survives_line_removal(self):
        catalog_line = self.client.get(
            '/api/finance/catalog?query=SB18'
        ).get_json()['data'][0]
        quotation = self.create_quote('Persistent Inventory Rate')
        quotation['lineItems'] = [{
            **catalog_line,
            'id': 'persistent-inventory-rate',
            'days': 1,
            'quantity': 1,
            'unitPrice': 480,
            'discountPercent': 0,
        }]
        self.client.put(
            f"/api/quotations/{quotation['id']}", json=quotation,
        )
        saved['lineItems'] = []
        removed = self.client.put(
            f"/api/quotations/{quotation['id']}", json=saved,
        )
        self.assertEqual(removed.status_code, 200, removed.get_data(as_text=True))

        remembered = self.client.get(
            '/api/finance/catalog?query=SB18'
        ).get_json()['data'][0]
        self.assertEqual(remembered['unitPrice'], 480)
        rate_card = self.client.get('/api/finance/rate-card').get_json()['data']
        stored = next(
            row for row in rate_card
            if row.get('catalogKey') == catalog_line['catalogKey']
        )
        self.assertEqual(stored['unitPrice'], 480)

    def test_custom_quotation_edits_do_not_create_products(self):
        original = self.create_quote('Original Custom Rate')
        original['lineItems'] = [{
            'id': 'original-custom-line',
            'catalogKey': '',
            'sourceAssetIds': [],
            'brand': 'Scenic Works',
            'model': 'Backdrop A',
            'description': 'Custom scenic backdrop',
            'department': 'Backdrop',
            'departmentCode': 'BACKDROP',
            'days': 1,
            'quantity': 1,
            'uom': 'lot',
            'unitPrice': 1000,
            'discountPercent': 0,
            'isCustom': True,
        }]
        original_saved = self.client.put(
            f"/api/quotations/{original['id']}", json=original,
        ).get_json()['data']

        latest = self.create_quote('Latest Custom Rate')
        latest['lineItems'] = [{
            **original_saved['lineItems'][0],
            'id': 'latest-custom-line',
        }]
        latest_saved = self.client.put(
            f"/api/quotations/{latest['id']}", json=latest,
        ).get_json()['data']
        latest_saved['lineItems'][0].update({
            'brand': 'Scenic Works SG',
            'model': 'Backdrop B',
            'description': 'Revised scenic backdrop',
            'unitPrice': 1250,
        })
        renamed = self.client.put(
            f"/api/quotations/{latest['id']}", json=latest_saved,
        )
        self.assertEqual(renamed.status_code, 200, renamed.get_data(as_text=True))

        rate_rows = self.client.get('/api/finance/rate-card').get_json()['data']
        self.assertFalse(any(
            row['description'] in {'Custom scenic backdrop', 'Revised scenic backdrop'}
            for row in rate_rows
        ))

        unchanged_original = self.client.get(
            f"/api/quotations/{original['id']}"
        ).get_json()['data']['lineItems'][0]
        self.assertEqual(unchanged_original['description'], 'Custom scenic backdrop')
        self.assertEqual(unchanged_original['unitPrice'], 1000)

        added = self.client.post('/api/finance/rate-card', json={
            **renamed.get_json()['data']['lineItems'][0],
            'isCustom': True,
        })
        self.assertEqual(added.status_code, 200, added.get_data(as_text=True))
        retained = self.client.get(
            '/api/finance/rate-card', query_string={'query': 'Revised scenic'},
        ).get_json()['data']
        self.assertEqual(len(retained), 1)
        self.assertEqual(retained[0]['unitPrice'], 1250)

        deleted = self.client.delete('/api/finance/rate-card', json=retained[0])
        self.assertEqual(deleted.status_code, 200, deleted.get_data(as_text=True))
        self.assertEqual(
            self.client.get(
                '/api/finance/rate-card', query_string={'query': 'Revised scenic'},
            ).get_json()['data'],
            [],
        )
        self.assertEqual(
            self.client.get(
                '/api/finance/catalog', query_string={'query': 'Revised scenic'},
            ).get_json()['data'],
            [],
        )
        self.assertEqual(
            self.client.get(
                '/api/finance/price-suggestion',
                query_string={'description': 'Revised scenic backdrop'},
            ).get_json()['data'],
            {},
        )

    def test_finance_migration_does_not_backfill_custom_quotation_products(self):
        data = app_module._finance_defaults()
        data['version'] = app_module.FINANCE_VERSION - 1
        data['documents'] = [
            {
                'id': 'older-rate',
                'type': 'quotation',
                'number': 'QT-2026-001-01',
                'createdBy': 'admin',
                'salespersonUsername': 'admin',
                'updatedAt': '2026-01-01T10:00:00',
                'lineItems': [{
                    'id': 'older-line',
                    'description': 'Historical custom service',
                    'department': 'General',
                    'days': 1,
                    'quantity': 1,
                    'uom': 'lot',
                    'unitPrice': 100,
                }],
            },
            {
                'id': 'newer-rate',
                'type': 'quotation',
                'number': 'QT-2026-002-01',
                'createdBy': 'admin',
                'salespersonUsername': 'admin',
                'updatedAt': '2026-02-01T10:00:00',
                'lineItems': [{
                    'id': 'newer-line',
                    'description': 'Historical custom service',
                    'department': 'General',
                    'days': 1,
                    'quantity': 1,
                    'uom': 'lot',
                    'unitPrice': 175,
                }],
            },
        ]

        self.assertTrue(app_module._migrate_finance_data(data))
        self.assertNotIn(
            'admin::custom:historical custom service', data['priceBook'],
        )
        self.assertEqual(data['version'], app_module.FINANCE_VERSION)

    def test_finance_migration_and_normalisation_align_special_category_departments(self):
        data = app_module._finance_defaults()
        data['version'] = app_module.FINANCE_VERSION - 1
        data['documents'] = [{
            'id': 'special-category-quote',
            'type': 'quotation',
            'number': 'QT-2026-009-01',
            'createdBy': 'alice',
            'salespersonUsername': 'alice',
            'lineItems': [{
                'id': 'crew-line',
                'description': 'Standby crew',
                'department': 'General',
                'departmentCode': 'GENERAL',
                'systemName': 'Manpower',
                'days': 1,
                'quantity': 1,
                'unitPrice': 5000,
            }, {
                'id': 'lorry-line',
                'description': 'Lorry',
                'department': 'General',
                'departmentCode': 'GENERAL',
                'systemName': 'Transportation',
                'days': 1,
                'quantity': 1,
                'unitPrice': 500,
            }],
            'revisions': [{
                'revision': 1,
                'snapshot': {
                    'lineItems': [{
                        'id': 'snapshot-crew',
                        'department': 'General',
                        'departmentCode': 'GENERAL',
                        'systemName': 'Manpower',
                    }],
                },
            }],
        }]
        linked_public = {
            'id': 'linked-crew',
            'department': 'General',
            'departmentCode': 'GENERAL',
            'systemName': 'Manpower',
        }
        data['linkedLineItems'] = {
            'linked-quotation': {
                'schemaVersion': 1,
                'quotationId': 'linked-quotation',
                'costingId': 'linked-costing',
                'quotationLineCount': 1,
                'costingLineCount': 0,
                'lines': [{
                    'id': 'linked-crew',
                    'public': linked_public,
                    'allocations': [],
                }],
            },
        }

        self.assertTrue(app_module._migrate_finance_data(data))
        quotation = data['documents'][0]
        self.assertEqual(
            [
                (row['department'], row['departmentCode'])
                for row in quotation['lineItems']
            ],
            [
                ('Manpower', 'MANPOWER'),
                ('Transportation', 'TRANSPORTATION'),
            ],
        )
        snapshot_line = quotation['revisions'][0]['snapshot']['lineItems'][0]
        self.assertEqual(
            (snapshot_line['department'], snapshot_line['departmentCode']),
            ('Manpower', 'MANPOWER'),
        )
        linked_record = data['linkedLineItems']['linked-quotation']
        self.assertEqual(
            (
                linked_record['lines'][0]['public']['department'],
                linked_record['lines'][0]['public']['departmentCode'],
            ),
            ('Manpower', 'MANPOWER'),
        )
        self.assertEqual(
            linked_record['checksum'],
            app_module._linked_line_record_checksum(linked_record),
        )

        normalised = app_module._normalise_finance_line({
            'description': 'New crew line',
            'department': 'General',
            'departmentCode': 'GENERAL',
            'systemName': 'Manpower',
            'days': 1,
            'quantity': 1,
            'unitPrice': 100,
        })
        self.assertEqual(
            (normalised['department'], normalised['departmentCode']),
            ('Manpower', 'MANPOWER'),
        )

    def test_finance_migration_does_not_restore_deleted_rate_aliases(self):
        catalog_key = 'inventory:ax|l-acoustics|sb18 iii'
        data = app_module._finance_defaults()
        data['version'] = app_module.FINANCE_VERSION - 1
        data['priceBook'] = {
            f'admin::{catalog_key}': {
                'deleted': True,
                'description': 'Subwoofer',
                'department': 'Audio Department',
                'departmentCode': 'AX',
                'brand': 'L-Acoustics',
                'model': 'SB18 III',
                'owner': 'admin',
            },
        }
        data['documents'] = [{
            'id': 'historical-deleted-rate',
            'type': 'quotation',
            'number': 'QT-2026-003-01',
            'createdBy': 'admin',
            'salespersonUsername': 'admin',
            'updatedAt': '2026-03-01T10:00:00',
            'lineItems': [{
                'id': 'deleted-inventory-line',
                'catalogKey': catalog_key,
                'sourceAssetIds': ['AX#01'],
                'brand': 'L-Acoustics',
                'model': 'SB18 III',
                'description': 'Subwoofer',
                'department': 'Audio Department',
                'departmentCode': 'AX',
                'days': 1,
                'quantity': 1,
                'uom': 'units',
                'unitPrice': 500,
            }],
        }]

        self.assertTrue(app_module._migrate_finance_data(data))
        self.assertTrue(data['priceBook'][f'admin::{catalog_key}']['deleted'])
        self.assertNotIn('admin::asset:ax#01', data['priceBook'])

    def test_changed_line_price_propagates_across_subprojects_in_same_quote_only(self):
        catalog_line = self.client.get(
            '/api/finance/catalog?query=SB18'
        ).get_json()['data'][0]
        quotation = self.create_quote('Subproject Rate Sync')
        quotation['subprojects'] = [
            {'id': 'main', 'name': 'Main Room'},
            {'id': 'breakout', 'name': 'Breakout Room'},
        ]
        quotation['lineItems'] = [
            {
                **catalog_line,
                'id': 'main-rate',
                'days': 1,
                'quantity': 1,
                'uom': 'units',
                'unitPrice': 100,
                'discountPercent': 0,
                'subprojectId': 'main',
            },
            {
                **catalog_line,
                'id': 'breakout-rate',
                'days': 1,
                'quantity': 2,
                'uom': 'units',
                'unitPrice': 100,
                'discountPercent': 0,
                'subprojectId': 'breakout',
            },
        ]
        saved_response = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json=quotation,
        )
        self.assertEqual(saved_response.status_code, 200, saved_response.get_data(as_text=True))
        saved = saved_response.get_json()['data']

        separate = self.create_quote('Separate Rate')
        separate['lineItems'] = [{
            **catalog_line,
            'id': 'separate-rate',
            'days': 1,
            'quantity': 1,
            'uom': 'units',
            'unitPrice': 90,
            'discountPercent': 0,
            'subprojectId': 'main',
        }]
        separate_response = self.client.put(
            f"/api/quotations/{separate['id']}",
            json=separate,
        )
        self.assertEqual(separate_response.status_code, 200, separate_response.get_data(as_text=True))

        saved['lineItems'][0]['unitPrice'] = 175
        changed_response = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json=saved,
        )
        self.assertEqual(changed_response.status_code, 200, changed_response.get_data(as_text=True))
        changed_lines = changed_response.get_json()['data']['lineItems']
        self.assertEqual([line['unitPrice'] for line in changed_lines], [175, 175])
        self.assertEqual([line['total'] for line in changed_lines], [175, 350])

        separate_after = self.client.get(
            f"/api/quotations/{separate['id']}"
        ).get_json()['data']
        self.assertEqual(separate_after['lineItems'][0]['unitPrice'], 90)

        project_root = os.path.dirname(os.path.dirname(__file__))
        with open(
            os.path.join(project_root, 'static', 'js', 'finance.js'),
            encoding='utf-8',
        ) as source_file:
            source = source_file.read()
        self.assertIn('function financePropagateLineUnitPrice(sourceLine)', source)
        self.assertIn("if (field === 'unitPrice') financePropagateLineUnitPrice(line)", source)

    def test_uom_menu_and_add_item_reset_behaviour(self):
        project_root = os.path.dirname(os.path.dirname(__file__))
        with open(
            os.path.join(project_root, 'static', 'js', 'finance.js'),
            encoding='utf-8',
        ) as source_file:
            source = source_file.read()
        with open(
            os.path.join(project_root, 'static', 'css', 'finance.css'),
            encoding='utf-8',
        ) as source_file:
            stylesheet = source_file.read()

        self.assertIn("{ value: 'sqm', label: 'sqm' }", source)
        self.assertIn("target.classList.add('open-up')", source)
        self.assertIn('.finance-custom-menu.open-up', stylesheet)
        self.assertIn('.finance-schedule-placement-flow', stylesheet)
        self.assertIn('Select a line to place this custom date in the PDF order.', source)
        self.assertIn('financeCustomScheduleDateChange', source)
        self.assertIn('finance-schedule-heading-order', source)
        self.assertIn("state.weekdays.length ? '' : 'disabled'", source)
        select_catalog = source.split('function financeSelectCatalog(index)', 1)[1].split(
            'async function financeAddCustomItem()', 1
        )[0]
        add_custom = source.split('async function financeAddCustomItem()', 1)[1].split(
            'function financeAddItemKeydown(event)', 1
        )[0]
        self.assertIn("financeState.addDepartment = ''", select_catalog)
        self.assertIn("financeState.addDepartment = ''", add_custom)
        self.assertIn('financeAddContainerAsGroup(selected)', select_catalog)
        self.assertIn('financeAddLineFromCatalog(', select_catalog)
        self.assertIn('function financeAddContainerAsGroup(selected)', source)
        self.assertIn('groupTitle: containerId', source)
        self.assertIn("financeLineGroupState.title = selected.containerId", source)
        self.assertIn('function financeContainerMajorityDepartment(', source)
        self.assertIn('function financeDepartmentIdentity(line)', source)
        self.assertIn('const key = financeDepartmentIdentity(line);', source)
        self.assertIn('financeCategoryOperationalDepartment(category)', add_custom)
        self.assertIn("return `code:${code}`;", source)
        self.assertIn("return `name:${name || 'general'}`;", source)
        self.assertIn(
            "results?.classList.contains('open') && financeState.catalog.length > 0",
            source,
        )
        self.assertIn(
            "onkeydown=\"showbaseLineWorkspace.suggestionKeydown(event,'${departmentResultsId}')\"",
            source,
        )
        self.assertIn(
            "onblur=\"setTimeout(()=>showbaseLineWorkspace.hideSuggestions('${departmentResultsId}'),120)\"",
            source,
        )

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
        with open(
            os.path.join(project_root, 'static', 'css', 'finance.css'),
            encoding='utf-8',
        ) as source_file:
            stylesheet = source_file.read()

        self.assertNotIn('financeToggleSubprojectView', source)
        self.assertNotIn('financeState.showSubprojects', source)
        self.assertIn('Browse products', source)
        self.assertIn('function loadProducts(', source)
        self.assertIn('function productCatalogToggleSource(', source)
        self.assertIn('function productCatalogSetCategory(', source)
        self.assertIn('function productCatalogPageRows(', source)
        self.assertIn("filter(row => !row.isContainer)", source)
        self.assertNotIn('>All products</button>', source)
        products_tabs_css = stylesheet.split('.finance-products-tabs {', 1)[1].split('}', 1)[0]
        self.assertIn('flex-wrap: wrap', products_tabs_css)
        self.assertNotIn('overflow-x', products_tabs_css)
        self.assertIn("productCatalogUpdateField(${index},'productLabel'", source)
        self.assertIn("productCatalogUpdateField(${index},'productCategory'", source)
        self.assertIn("productCatalogUpdateField(${index},'uom'", source)
        product_form = source.split('function productCatalogFormMarkup()', 1)[1].split(
            'function productCatalogRender()', 1,
        )[0]
        self.assertIn('name="productLabel"', product_form)
        self.assertNotIn('name="brand"', product_form)
        self.assertNotIn('name="model"', product_form)
        self.assertNotIn('name="description"', product_form)
        self.assertNotIn('finance-product-details', source)
        self.assertNotIn('function financeCatalogProductDetails(', source)
        self.assertIn('function financeCatalogMatchesQuery(', source)
        self.assertIn('const requestSeq = ++financeState.catalogRequestSeq;', source)
        self.assertIn('financeRunCatalogSearch(clean, cacheKey, requestSeq)', source)
        self.assertIn('catalogQueuedSearch = { clean, cacheKey, requestSeq }', source)
        update_price = source.split('async function productCatalogUpdatePrice', 1)[1].split(
            'async function productCatalogUpdateField', 1,
        )[0]
        update_field = source.split('async function productCatalogUpdateField', 1)[1].split(
            'function productCatalogEnsureCategoryMenu', 1,
        )[0]
        self.assertIn('productCatalogPersistInline(', update_price)
        self.assertIn('productCatalogPersistInline(', update_field)
        self.assertIn('const productCatalogSaveQueues = new Map();', source)
        self.assertIn('financePersistProduct(snapshot, { applyRows: false })', source)
        self.assertNotIn('productCatalogRender()', update_price)
        self.assertNotIn('productCatalogRender()', update_field)
        self.assertIn('aria-label="Product categories"', source)
        self.assertIn('function productCatalogOpenCategoryMenu(', source)
        self.assertIn('function productCatalogDeleteCategory(', source)
        self.assertIn("'/api/finance/products/category', 'DELETE'", source)
        self.assertIn("title: 'Add this as a product?'", source)
        self.assertIn("title: 'Update the product price?'", source)
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

    def test_total_discount_name_is_edited_in_the_line_items_table(self):
        source = Path('static/js/finance.js').read_text(encoding='utf-8')
        row_start = source.index('function financeTotalAdjustmentRows()')
        row_end = source.index('function financeRenderLineGroups()', row_start)
        row_source = source[row_start:row_end]
        self.assertIn(
            'finance-adjustment-editor-row finance-total-adjustment-row',
            row_source,
        )
        self.assertIn('aria-label="Total discount name"', row_source)
        self.assertIn('financeSetTotalDiscountLabel(this.value)', row_source)

        summary_start = source.index('<h3>Quotation summary</h3>')
        summary_end = source.index('<h3>PDF options</h3>', summary_start)
        summary_source = source[summary_start:summary_end]
        self.assertIn('<span>Total before GST</span>', summary_source)
        self.assertNotIn('finance-total-discount-label', summary_source)
        self.assertNotIn('financeSetTotalDiscountLabel', summary_source)

    def test_quotation_group_header_has_edit_menu_button(self):
        source = Path('static/js/finance.js').read_text(encoding='utf-8')
        render_start = source.index('function financeRenderLineGroups()')
        render_end = source.index('function financeRenderSubprojectTabs()', render_start)
        render_source = source[render_start:render_end]

        self.assertIn('class="finance-group-menu-button"', render_source)
        self.assertIn('aria-haspopup="dialog"', render_source)
        self.assertIn(
            "financeOpenLineGroupEditor('finance','${financeEscapeAttr(groupId)}')",
            render_source,
        )
        self.assertIn('>...</button>', render_source)

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
        self.assertEqual(line['systemName'], 'Lighting')

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

    def test_system_group_rename_preserves_inventory_asset_identity(self):
        quotation = self.create_quote('System Grouping')
        quotation['lineItems'] = [{
            'id': 'linked-speaker',
            'catalogKey': 'inventory:ax|l-acoustics|sb18 iii',
            'sourceAssetIds': ['AX#01'],
            'brand': 'L-Acoustics',
            'model': 'SB18 III',
            'description': 'Subwoofer',
            'department': 'Audio Department',
            'departmentCode': 'AX',
            'systemName': 'Main PA System',
            'days': 1,
            'quantity': 1,
            'uom': 'units',
            'unitPrice': 100,
            'discountPercent': 0,
        }]
        quotation['adjustments'] = [{
            'id': 'system-discount',
            'scope': 'department',
            'department': 'Main PA System',
            'label': 'Package discount',
            'amount': -10,
            'percent': 10,
            'kind': 'discount',
            'calculationMode': 'percent',
            'subprojectId': 'main',
        }]

        saved = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json=quotation,
        ).get_json()['data']
        line = saved['lineItems'][0]
        self.assertEqual(line['systemName'], 'Main PA System')
        self.assertEqual(line['department'], 'Audio Department')
        self.assertEqual(line['departmentCode'], 'AX')
        self.assertEqual(line['catalogKey'], 'inventory:ax|l-acoustics|sb18 iii')
        self.assertEqual(line['sourceAssetIds'], ['AX#01'])

        line['systemName'] = 'Front of House'
        saved['adjustments'][0]['department'] = 'Front of House'
        renamed = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json=saved,
        ).get_json()['data']
        renamed_line = renamed['lineItems'][0]
        self.assertEqual(renamed_line['systemName'], 'Front of House')
        self.assertEqual(renamed_line['department'], 'Audio Department')
        self.assertEqual(renamed_line['departmentCode'], 'AX')
        self.assertEqual(
            renamed_line['catalogKey'],
            'inventory:ax|l-acoustics|sb18 iii',
        )
        self.assertEqual(renamed_line['sourceAssetIds'], ['AX#01'])
        self.assertEqual(renamed['adjustments'][0]['department'], 'Front of House')

        renamed_line['brand'] = 'Quotation-only brand'
        renamed_line['model'] = 'Quotation-only model'
        renamed_line['description'] = 'Quotation-only description'
        accepted = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json={**renamed, 'status': 'accepted'},
        ).get_json()['data']
        event = self.data_manager.events[accepted['eventId']]
        self.assertIn(
            '[MODEL]AX|L-Acoustics|SB18 III|1|Subwoofer',
            event.prepared_items,
        )
        inventory_asset = self.data_manager.inventory['AX#01']
        self.assertEqual(inventory_asset.brand, 'L-Acoustics')
        self.assertEqual(inventory_asset.model_number, 'SB18 III')
        self.assertEqual(inventory_asset.description, 'Subwoofer')

    def test_custom_inventory_description_survives_costing_save_and_reload(self):
        catalog_line = self.client.get(
            '/api/finance/catalog?query=SB18'
        ).get_json()['data'][0]
        quotation = self.create_quote('Custom Inventory Wording')
        quotation['lineItems'] = [{
            **catalog_line,
            'id': 'speaker-for-dsm',
            'days': 1,
            'quantity': 1,
            'unitPrice': 100,
        }]
        saved = self.client.put(
            f"/api/quotations/{quotation['id']}", json=quotation,
        ).get_json()['data']
        line = saved['lineItems'][0]
        custom_description = f"{line['description']} (for DSM)"
        line['description'] = custom_description
        line['inventoryNameMode'] = 'custom'
        edited = self.client.put(
            f"/api/quotations/{quotation['id']}", json=saved,
        ).get_json()['data']
        self.assertEqual(edited['lineItems'][0]['description'], custom_description)

        costing = self.client.get(
            f"/api/costings/{edited['sourceCostingId']}"
        ).get_json()['data']
        costing['lineItems'][0]['itemCost'] = 25
        costing_save = self.client.put(
            f"/api/costings/{costing['id']}", json=costing,
        )
        self.assertEqual(
            costing_save.status_code, 200,
            costing_save.get_data(as_text=True),
        )

        reloaded = self.client.get(
            f"/api/quotations/{quotation['id']}"
        ).get_json()['data']['lineItems'][0]
        self.assertEqual(reloaded['description'], custom_description)
        self.assertEqual(reloaded['inventoryNameMode'], 'custom')
        self.assertEqual(reloaded['catalogKey'], line['catalogKey'])
        self.assertEqual(reloaded['sourceAssetIds'], line['sourceAssetIds'])
        self.assertEqual(reloaded['brand'], line['brand'])
        self.assertEqual(reloaded['model'], line['model'])
        self.assertEqual(
            app_module._finance_inventory_group_from_line(reloaded),
            {
                'department': 'AX',
                'brand': 'L-Acoustics',
                'model': 'SB18 III',
                'description': 'Subwoofer',
            },
        )

        # A real relink to another asset must use that asset's name rather than
        # carrying the old quotation-only annotation to the new item.
        costing = self.client.get(
            f"/api/costings/{edited['sourceCostingId']}"
        ).get_json()['data']
        costing['lineItems'][0].update({
            'catalogKey': 'inventory:lx|robe|spiider',
            'sourceAssetIds': ['LX#01'],
            'inventoryNameMode': 'inventory',
            'departmentCode': 'LX',
            'category': 'Lighting System',
        })
        relinked = self.client.put(
            f"/api/costings/{costing['id']}", json=costing,
        )
        self.assertEqual(
            relinked.status_code, 200, relinked.get_data(as_text=True),
        )
        new_quotation_line = self.client.get(
            f"/api/quotations/{quotation['id']}"
        ).get_json()['data']['lineItems'][0]
        self.assertEqual(new_quotation_line['sourceAssetIds'], ['LX#01'])
        self.assertEqual(new_quotation_line['inventoryNameMode'], 'inventory')
        self.assertIn('Spiider', new_quotation_line['description'])
        self.assertNotIn('(for DSM)', new_quotation_line['description'])

    def test_distinct_custom_inventory_lines_do_not_merge_on_costing_save(self):
        catalog_line = self.client.get(
            '/api/finance/catalog?query=SB18'
        ).get_json()['data'][0]
        quotation = self.create_quote('Two Speaker Purposes')
        quotation['lineItems'] = [{
            **catalog_line,
            'id': f'speaker-{purpose}',
            'description': f"{catalog_line['description']} (for {purpose})",
            'inventoryNameMode': 'custom',
            'quantity': 1,
            'days': 1,
            'unitPrice': 100,
        } for purpose in ('DSM', 'front fills')]
        saved = self.client.put(
            f"/api/quotations/{quotation['id']}", json=quotation,
        ).get_json()['data']
        original_lines = saved['lineItems']
        self.assertEqual(len(original_lines), 2)

        costing = self.client.get(
            f"/api/costings/{saved['sourceCostingId']}"
        ).get_json()['data']
        self.assertEqual(len(costing['lineItems']), 2)
        costing['lineItems'][0]['itemCost'] = 25
        response = self.client.put(
            f"/api/costings/{costing['id']}", json=costing,
        )
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))

        reloaded = self.client.get(
            f"/api/quotations/{quotation['id']}"
        ).get_json()['data']['lineItems']
        self.assertEqual(len(reloaded), 2)
        self.assertEqual(
            [line['id'] for line in reloaded],
            [line['id'] for line in original_lines],
        )
        self.assertEqual(
            [line['description'] for line in reloaded],
            [line['description'] for line in original_lines],
        )
        self.assertTrue(all(
            line['catalogKey'] == catalog_line['catalogKey']
            and line['sourceAssetIds'] == catalog_line['sourceAssetIds']
            for line in reloaded
        ))

    def test_new_inventory_line_reuses_visual_category_without_changing_identity(self):
        quotation = self.create_quote('Reusable Category Name')
        quotation['lineItems'] = [
            {
                'id': 'existing-audio-line',
                'catalogKey': 'inventory:ax|l-acoustics|sb18 iii',
                'sourceAssetIds': ['AX#01'],
                'brand': 'L-Acoustics',
                'model': 'SB18 III',
                'description': 'Subwoofer',
                'department': 'Audio Department',
                'departmentCode': 'AX',
                'systemName': 'Sound',
                'days': 1,
                'quantity': 1,
                'uom': 'units',
                'unitPrice': 100,
                'discountPercent': 0,
                'subprojectId': 'main',
            },
            {
                'id': 'new-audio-line',
                'catalogKey': 'inventory:ax|shure|sm58',
                'sourceAssetIds': [],
                'brand': 'Shure',
                'model': 'SM58',
                'description': 'Dynamic microphone',
                'department': 'Audio Department',
                'departmentCode': 'AX',
                'days': 1,
                'quantity': 1,
                'uom': 'units',
                'unitPrice': 20,
                'discountPercent': 0,
                'subprojectId': 'main',
            },
        ]

        saved = self.client.put(
            f"/api/quotations/{quotation['id']}", json=quotation,
        ).get_json()['data']

        self.assertEqual([line['systemName'] for line in saved['lineItems']], ['Sound', 'Sound'])
        self.assertTrue(all(
            line['department'] == 'Audio Department'
            and line['departmentCode'] == 'AX'
            for line in saved['lineItems']
        ))

    def test_misc_line_uses_renamed_category_majority_department_in_event_and_compare(self):
        self.data_manager.inventory.update({
            'AX#02': InventoryItem(
                asset_id='AX#02', brand='Shure', model_number='SM58',
                serial_number='SM58-2', description='Dynamic microphone',
                is_missing=False, maintenance_logs=[], department_code='AX',
            ),
            'AX#03': InventoryItem(
                asset_id='AX#03', brand='Shure', model_number='SM81',
                serial_number='SM81-3', description='Condenser microphone',
                is_missing=False, maintenance_logs=[], department_code='AX',
            ),
        })
        self.data_manager.save_inventory()
        quotation = self.create_quote('Renamed Audio Category')
        quotation['lineItems'] = [{
            'id': 'sm58-line',
            'catalogKey': 'inventory:ax|shure|sm58',
            'sourceAssetIds': ['AX#02'],
            'brand': 'Shure', 'model': 'SM58',
            'description': 'Dynamic microphone',
            'department': 'Audio Department', 'departmentCode': 'AX',
            'systemName': 'Audio Works',
            'days': 1, 'quantity': 1, 'uom': 'units', 'unitPrice': 20,
        }, {
            'id': 'sm81-line',
            'catalogKey': 'inventory:ax|shure|sm81',
            'sourceAssetIds': ['AX#03'],
            'brand': 'Shure', 'model': 'SM81',
            'description': 'Condenser microphone',
            'department': 'Audio Department', 'departmentCode': 'AX',
            'days': 1, 'quantity': 1, 'uom': 'units', 'unitPrice': 30,
        }, {
            'id': 'lighting-in-audio-works',
            'catalogKey': 'inventory:lx|robe|spiider',
            'sourceAssetIds': ['LX#01'],
            'brand': 'Robe', 'model': 'Spiider',
            'description': 'LED wash fixture',
            'department': 'Lighting Department', 'departmentCode': 'LX',
            'systemName': 'Audio Works',
            'days': 1, 'quantity': 1, 'uom': 'units', 'unitPrice': 40,
        }, {
            'id': 'battery-line',
            'catalogKey': '', 'sourceAssetIds': [],
            'description': 'AA Battery',
            'department': 'Audio Works', 'departmentCode': '',
            'systemName': 'Audio Works',
            'days': 1, 'quantity': 4, 'uom': 'units', 'unitPrice': 1,
            'isCustom': True, 'customType': 'MISC',
        }]

        saved = self.client.put(
            f"/api/quotations/{quotation['id']}", json=quotation,
        ).get_json()['data']
        by_id = {line['id']: line for line in saved['lineItems']}
        self.assertEqual(by_id['sm81-line']['systemName'], 'Audio Works')
        self.assertEqual(by_id['sm81-line']['departmentCode'], 'AX')
        self.assertEqual(by_id['lighting-in-audio-works']['departmentCode'], 'LX')
        self.assertEqual(by_id['battery-line']['systemName'], 'Audio Works')
        self.assertEqual(by_id['battery-line']['departmentCode'], 'AX')
        self.assertEqual(by_id['battery-line']['department'], 'Audio Department')

        accepted = self.client.put(
            f"/api/quotations/{quotation['id']}", json={'status': 'accepted'},
        ).get_json()['data']
        event = self.data_manager.events[accepted['eventId']]
        battery_marker = next(
            app_module._parse_custom_marker(ref)
            for ref in event.prepared_items
            if (app_module._parse_custom_marker(ref) or {}).get('name') == 'AA Battery'
        )
        self.assertEqual(battery_marker['department'], 'AX')
        battery_item = next(
            item for room in event.subprojects
            for item in room.get('items') or []
            if item.get('description') == 'AA Battery'
        )
        self.assertEqual(battery_item['departmentCode'], 'AX')

        self.login('sales-admin')
        comparison = self.client.get('/api/finance/compare', query_string={
            'eventId': event.event_id,
            'quotationId': accepted['id'],
        }).get_json()['data']
        battery_row = next(
            row for row in comparison['rows']
            if row['quotationItem']['title'] == 'AA Battery'
        )
        self.assertEqual(battery_row['status'], 'matched')
        self.assertEqual(battery_row['quotationItem']['departmentCode'], 'AX')
        self.assertEqual(battery_row['eventItem']['departmentCode'], 'AX')

    def test_compare_adds_event_items_to_existing_renamed_category(self):
        event = Event(
            event_id=206,
            name='Compare Category Mapping',
            location='Studio C',
            start_date='20260721',
            end_date='20260721',
            asset_models=[],
            prepared_items=[
                '[MODEL]AX|Shure|SM81|1|Condenser microphone',
                app_module._make_custom_marker('MISC', 'AA Battery', 4, 'AX'),
            ],
            returned_items=[],
            actually_prepared=[],
            extra_assets=[],
            assigned_users=['alice', 'sales-admin'],
        )
        self.data_manager.events[event.event_id] = event
        self.data_manager.save_event(event)
        quotation = self.create_quote('Compare Category Mapping')
        quotation['eventId'] = event.event_id
        quotation['lineItems'] = [{
            'id': 'existing-audio-category',
            'catalogKey': 'inventory:ax|l-acoustics|sb18 iii',
            'sourceAssetIds': ['AX#01'],
            'brand': 'L-Acoustics', 'model': 'SB18 III',
            'description': 'Subwoofer',
            'department': 'Audio Department', 'departmentCode': 'AX',
            'systemName': 'Audio Works',
            'days': 1, 'quantity': 1, 'uom': 'units', 'unitPrice': 100,
        }]
        saved = self.client.put(
            f"/api/quotations/{quotation['id']}", json=quotation,
        ).get_json()['data']

        self.login('sales-admin')
        comparison = self.client.get('/api/finance/compare', query_string={
            'eventId': event.event_id,
            'quotationId': saved['id'],
        }).get_json()['data']
        extra_keys = [
            row['key'] for row in comparison['rows']
            if row['status'] == 'extra_in_event'
        ]
        response = self.client.post(
            f'/api/finance/compare/{event.event_id}/add-to-quotation',
            json={'quotationId': saved['id'], 'keys': extra_keys},
        )
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        added = [
            line for line in response.get_json()['quotation']['lineItems']
            if line['id'] != 'existing-audio-category'
        ]
        self.assertEqual(len(added), 2)
        self.assertTrue(all(line['systemName'] == 'Audio Works' for line in added))
        self.assertTrue(all(line['departmentCode'] == 'AX' for line in added))
        battery = next(line for line in added if line['description'] == 'AA Battery')
        self.assertTrue(battery['isCustom'])

    def test_department_suggestion_selection_suppresses_stale_change_event(self):
        project_root = os.path.dirname(os.path.dirname(__file__))
        with open(
            os.path.join(project_root, 'static', 'js', 'finance.js'),
            encoding='utf-8',
        ) as source_file:
            source = source_file.read()

        self.assertIn("input.dataset.departmentSelectionCommitted = 'true'", source)
        self.assertIn('line.systemName = value', source)
        self.assertIn('function financeCommitDepartmentInput(index, input)', source)
        rename_source = source.split(
            'async function financeRenameDepartment(encodedDepartment)',
            1,
        )[1].split('function financeDragLineStart', 1)[0]
        drop_source = source.split(
            'function financeDropDepartment(event, encodedTargetDepartment)',
            1,
        )[1].split('function financeDragDepartmentEnd', 1)[0]
        self.assertIn('line.systemName = nextName', rename_source)
        self.assertIn('line.systemName = targetDepartment', drop_source)
        self.assertNotIn('line.department =', rename_source)
        self.assertNotIn('line.departmentCode =', rename_source)
        self.assertNotIn('line.department =', drop_source)
        self.assertNotIn('line.departmentCode =', drop_source)
        self.assertIn('function financeCatalogCategory(', source)
        self.assertIn('function financePreferredCatalogCategory(', source)
        self.assertIn('financeSameOperationalDepartment(line, selected)', source)
        self.assertIn('newest(matches).find(financeIsRenamedCategory)', source)
        preferred_category_source = source.split(
            'function financePreferredCatalogCategory(', 1,
        )[1].split('function financeCatalogCategory', 1)[0]
        self.assertIn(
            "String(line.subprojectId || 'main') === String(subprojectId)",
            preferred_category_source,
        )
        catalog_category_source = source.split(
            'function financeCatalogCategory(', 1
        )[1].split('function financeCategoryOperationalDepartment', 1)[0]
        self.assertLess(
            catalog_category_source.index('financeIsRenamedCategory(existing)'),
            catalog_category_source.index('selected?.productCategory'),
        )
        suggestion_source = source.split(
            'function financeDepartmentSuggestions(query)', 1,
        )[1].split('function financeShowDepartmentSuggestions', 1)[0]
        self.assertLess(
            suggestion_source.index('...renamedCategories'),
            suggestion_source.index('...(financeState.departments || []).map(financeDefaultSystemName)'),
        )
        add_line_source = source.split(
            'function financeAddLineFromCatalog(', 1,
        )[1].split('function financeSelectCatalog(', 1)[0]
        self.assertIn("const department = selected.department || 'General'", add_line_source)
        self.assertIn('systemName: category', add_line_source)

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

        def assert_line_table_matches_detail_width(reader):
            page = next(
                page for page in reader.pages
                if 'Audio item ' in (page.extract_text() or '')
            )
            wide_rectangle_widths = [
                float(operands[2])
                for operands, operator in page.get_contents().operations
                if operator == b're'
                and 500 < float(operands[2]) < 550
            ]
            self.assertGreaterEqual(len(wide_rectangle_widths), 2)
            self.assertAlmostEqual(
                min(wide_rectangle_widths),
                max(wide_rectangle_widths),
                places=2,
            )

        assert_line_table_matches_detail_width(hidden_reader)
        hidden_text = '\n'.join(page.extract_text() or '' for page in hidden_reader.pages)
        hidden_last_page_text = hidden_reader.pages[-1].extract_text() or ''
        self.assertIn('DESCRIPTION', hidden_text)
        self.assertNotIn('UNIT PRICE', hidden_text)
        self.assertNotIn('DISC %', hidden_text)
        self.assertNotIn('$123.45', hidden_text)
        self.assertNotIn('10% department discount', hidden_text)
        self.assertIn('$14,443.65', hidden_text)
        self.assertLess(hidden_text.index('Edgar Tan'), hidden_text.index('Patricia & Edgar Pte Ltd'))
        self.assertGreaterEqual(len(hidden_reader.pages), 2)
        self.assertIn('Summary', hidden_last_page_text)
        self.assertIn('Audio', hidden_last_page_text)
        self.assertIn('TOTAL', hidden_last_page_text)
        self.assertNotIn('Audio item 65', hidden_last_page_text)
        for page in hidden_reader.pages:
            page_text = page.extract_text() or ''
            if 'Audio item ' in page_text:
                self.assertIn('Audio', page_text)
                self.assertIn('DESCRIPTION', page_text)
                self.assertNotIn('DEPARTMENT', page_text)

        line_item_page = next(
            page for page in hidden_reader.pages
            if 'Audio item ' in (page.extract_text() or '')
        )
        header_positions = {}

        def capture_header_position(text, current_matrix, text_matrix, *_args):
            label = text.strip()
            if label in {'DESCRIPTION', 'DAY(S)', 'MULT', 'QTY'}:
                header_positions.setdefault(
                    label, current_matrix[4] + text_matrix[4]
                )

        line_item_page.extract_text(visitor_text=capture_header_position)
        multiplier_label = 'DAY(S)' if 'DAY(S)' in header_positions else 'MULT'
        self.assertGreater(header_positions['QTY'], 440)
        self.assertGreater(
            header_positions[multiplier_label], header_positions['QTY']
        )

        saved['showDepartmentSubtotals'] = False
        saved = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json=saved,
        ).get_json()['data']
        total_only_pdf = self.client.get(f"/api/quotations/{quotation['id']}/pdf").data
        total_only_reader = PdfReader(io.BytesIO(total_only_pdf))
        total_only_text = '\n'.join(page.extract_text() or '' for page in total_only_reader.pages)
        total_only_summary_text = total_only_reader.pages[-1].extract_text() or ''
        self.assertIn('DESCRIPTION', total_only_text)
        self.assertIn('Audio item 1', total_only_text)
        self.assertNotIn('$123.45', total_only_text)
        self.assertNotIn('Audio subtotal', total_only_text)
        self.assertIn('CATEGORY', total_only_summary_text)
        self.assertIn('LINE ITEMS', total_only_summary_text)
        self.assertIn('Audio', total_only_summary_text)
        self.assertNotIn('SUBTOTAL', total_only_summary_text)
        self.assertIn('TOTAL', total_only_summary_text)

        saved['showUnitPrices'] = True
        saved['showDepartmentSubtotals'] = True
        saved['showDepartmentDiscounts'] = True
        self.client.put(
            f"/api/quotations/{quotation['id']}",
            json=saved,
        )
        visible_pdf = self.client.get(f"/api/quotations/{quotation['id']}/pdf").data
        visible_reader = PdfReader(io.BytesIO(visible_pdf))
        assert_line_table_matches_detail_width(visible_reader)
        visible_text = '\n'.join(
            page.extract_text() or '' for page in visible_reader.pages
        )
        self.assertIn('$123.45', visible_text)
        self.assertIn('10% department discount', visible_text)

    def test_changed_gst_rate_is_used_by_the_next_pdf_export(self):
        quotation = self.create_quote('Updated GST Export')
        quotation.update({
            'taxRate': 7.5,
            'lineItems': [{
                'id': 'gst-line',
                'description': 'Production package',
                'department': 'Audio Department',
                'days': 1,
                'quantity': 1,
                'uom': 'lot',
                'unitPrice': 100,
                'discountPercent': 0,
                'subprojectId': 'main',
            }],
        })
        saved = self.client.put(
            f"/api/quotations/{quotation['id']}", json=quotation,
        ).get_json()['data']
        self.assertEqual(saved['taxRate'], 7.5)

        response = self.client.get(f"/api/quotations/{quotation['id']}/pdf?v=updated")
        text = '\n'.join(
            page.extract_text() or '' for page in PdfReader(io.BytesIO(response.data)).pages
        )
        self.assertIn('GST (7.5%)', text)
        self.assertNotIn('GST (9%)', text)
        self.assertIn('no-store', response.headers.get('Cache-Control', ''))

    def test_manually_entered_line_total_is_preserved_in_pdf(self):
        quotation = self.create_quote('Backdrop Fabrication')
        quotation.update({
            'showUnitPrices': True,
            'lineItems': [{
                'id': 'backdrop-line',
                'description': 'Backdrop fabrication',
                'department': 'Backdrop',
                'systemName': 'Backdrop Fabrication',
                'days': 1.5,
                'quantity': 1,
                'uom': 'units',
                'unitPrice': 1533.33,
                'discountPercent': 0,
                'total': 2300,
                'totalMode': 'amount',
                'subprojectId': 'main',
            }],
        })

        response = self.client.put(
            f"/api/quotations/{quotation['id']}", json=quotation,
        )
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        saved = response.get_json()['data']
        self.assertEqual(saved['lineItems'][0]['total'], 2300)
        self.assertEqual(saved['lineItems'][0]['totalMode'], 'amount')

        pdf = self.client.get(f"/api/quotations/{quotation['id']}/pdf")
        text = '\n'.join(
            page.extract_text() or '' for page in PdfReader(io.BytesIO(pdf.data)).pages
        )
        self.assertIn('$2,300.00', text)
        self.assertNotIn('$2,299.99', text)

        finance_source = Path('static/js/finance.js').read_text(encoding='utf-8')
        self.assertIn("line.totalMode = 'amount'", finance_source)
        self.assertIn("line.totalMode = 'calculated'", finance_source)

    def test_pdf_uses_compact_multiplier_column_label(self):
        quotation = self.create_quote('Multiplier Label')
        quotation['lineItems'] = [{
            'id': 'mult-line',
            'description': 'Production package',
            'department': 'Audio Department',
            'days': 2,
            'costingMultiplierLabel': 'Mult',
            'quantity': 1,
            'uom': 'lot',
            'unitPrice': 100,
            'discountPercent': 0,
            'subprojectId': 'main',
        }]
        saved = self.client.put(
            f"/api/quotations/{quotation['id']}", json=quotation,
        ).get_json()['data']
        self.assertEqual(saved['lineItems'][0]['costingMultiplierLabel'], 'Mult')

        pdf = self.client.get(f"/api/quotations/{quotation['id']}/pdf")
        text = '\n'.join(
            page.extract_text() or '' for page in PdfReader(io.BytesIO(pdf.data)).pages
        )
        self.assertIn('MULT', text)
        self.assertNotIn('DAY(S)', text)

    def test_pdf_uses_multiplier_label_for_each_category(self):
        quotation = self.create_quote('Category Multiplier Labels')
        quotation['lineItems'] = [
            {
                'id': 'mult-line',
                'description': 'Audio package',
                'department': 'Audio Department',
                'days': 2,
                'costingMultiplierLabel': 'Mult',
                'quantity': 1,
                'uom': 'lot',
                'unitPrice': 100,
                'discountPercent': 0,
                'subprojectId': 'main',
            },
            {
                'id': 'day-line',
                'description': 'Lighting package',
                'department': 'Lighting Department',
                'days': 2,
                'costingMultiplierLabel': 'Day',
                'quantity': 1,
                'uom': 'lot',
                'unitPrice': 100,
                'discountPercent': 0,
                'subprojectId': 'main',
            },
        ]
        saved = self.client.put(
            f"/api/quotations/{quotation['id']}", json=quotation,
        ).get_json()['data']

        pdf = self.client.get(f"/api/quotations/{saved['id']}/pdf")
        text = '\n'.join(
            page.extract_text() or '' for page in PdfReader(io.BytesIO(pdf.data)).pages
        )
        audio_index = text.index('Audio')
        mult_index = text.index('MULT', audio_index)
        lighting_index = text.index('Lighting', mult_index)
        day_index = text.index('DAY(S)', lighting_index)
        self.assertLess(audio_index, mult_index)
        self.assertLess(mult_index, lighting_index)
        self.assertLess(lighting_index, day_index)

    def test_group_persists_after_adding_line_and_exports_as_one_pdf_row(self):
        from quotation_pdf import _group_pdf_line_units

        quotation = self.create_quote('Persistent Group')
        shared = {
            'department': 'Audio Department',
            'days': 2,
            'quantity': 1,
            'uom': 'units',
            'discountPercent': 0,
            'subprojectId': 'main',
            'groupId': 'drum-package',
            'groupTitle': 'Pearl Reference Pure',
            'groupDisplayFields': ['model', 'description'],
            'groupCustomText': False,
        }
        quotation['lineItems'] = [
            {
                **shared,
                'id': 'rack-tom',
                'brand': 'Pearl',
                'model': 'Rack Tom 10x8',
                'description': 'Rack tom',
                'unitPrice': 25,
            },
            {
                **shared,
                'id': 'floor-tom',
                'brand': 'Pearl',
                'model': 'Floor Tom 14x14',
                'description': 'Floor tom',
                'unitPrice': 30,
            },
        ]
        saved = self.client.put(
            f"/api/quotations/{quotation['id']}", json=quotation,
        ).get_json()['data']
        group_leader = next(
            line for line in saved['lineItems'] if line.get('groupLeader')
        )
        group_leader.update({
            'quantity': 2,
            'totalMode': 'calculated',
            'total': 220,
        })
        saved['lineItems'].append({
            'id': 'guitar-amp',
            'description': 'J120 Guitar Amp',
            'department': 'Audio Department',
            'days': 2,
            'quantity': 1,
            'uom': 'units',
            'unitPrice': 100,
            'discountPercent': 0,
            'subprojectId': 'main',
        })
        saved = self.client.put(
            f"/api/quotations/{quotation['id']}", json=saved,
        ).get_json()['data']

        grouped_lines = [
            line for line in saved['lineItems']
            if line.get('groupId') == 'drum-package'
        ]
        self.assertEqual(len(grouped_lines), 2)
        self.assertTrue(all(
            line['groupTitle'] == 'Pearl Reference Pure'
            for line in grouped_lines
        ))
        leaders = [line for line in grouped_lines if line.get('groupLeader')]
        self.assertEqual(len(leaders), 1)
        self.assertEqual(leaders[0]['days'], 2)
        self.assertEqual(leaders[0]['quantity'], 2)
        self.assertEqual(leaders[0]['uom'], 'sets')
        self.assertEqual(leaders[0]['unitPrice'], 55)
        self.assertEqual(leaders[0]['total'], 220)
        self.assertEqual(sum(line['total'] for line in grouped_lines), 220)
        self.assertEqual(
            [line['groupItemQuantity'] for line in grouped_lines], [1, 1]
        )
        self.assertTrue(all(
            line['groupHeaderQuantity'] == 2 for line in grouped_lines
        ))
        self.assertEqual(
            [line['groupItemUnitPrice'] for line in grouped_lines], [25, 30]
        )
        self.assertEqual(
            [line['groupItemPriceContribution'] for line in grouped_lines],
            [25, 30],
        )
        self.assertTrue(all(
            line['groupItemCommercialStored'] for line in grouped_lines
        ))
        requirements = app_module._finance_event_subprojects(saved)[0]['items']
        requirement_quantities = {
            row['model']: row['quantity'] for row in requirements if row.get('model')
        }
        self.assertEqual(requirement_quantities['Rack Tom 10x8'], 2)
        self.assertEqual(requirement_quantities['Floor Tom 14x14'], 2)
        units = _group_pdf_line_units(saved['lineItems'])
        self.assertEqual([len(unit) for unit in units], [2, 1])

        pdf = self.client.get(f"/api/quotations/{quotation['id']}/pdf")
        text = '\n'.join(
            page.extract_text() or '' for page in PdfReader(io.BytesIO(pdf.data)).pages
        )
        self.assertEqual(text.count('Pearl Reference Pure'), 1)
        self.assertIn('1x Rack Tom 10x8 Rack tom', text)
        self.assertIn('1x Floor Tom 14x14 Floor tom', text)
        self.assertIn('J120 Guitar Amp', text)

    def test_manual_group_price_is_remembered_for_future_groups(self):
        quotation = self.create_quote('Remembered Group Price')
        shared = {
            'groupId': 'remembered-audio-kit',
            'groupTitle': 'Audio Package',
            'groupDisplayFields': ['description'],
            'groupCustomText': False,
            'groupHeaderQuantity': 1,
            'groupItemQuantity': 1,
            'groupItemDays': 1,
            'groupItemUom': 'units',
            'groupItemDiscountPercent': 0,
            'groupItemTotalMode': 'calculated',
            'groupItemCommercialStored': True,
            'groupPricingMode': 'total',
            'department': 'Audio Department',
            'systemName': 'Audio',
            'subprojectId': 'main',
            'days': 1,
            'quantity': 1,
            'uom': 'lot',
            'unitPrice': 275,
            'discountPercent': 0,
            'totalMode': 'amount',
        }
        quotation['lineItems'] = [{
            **shared,
            'id': 'remembered-speaker',
            'description': 'Speaker',
            'catalogKey': 'inventory:ax|speaker||',
            'groupLeader': True,
            'groupItemUnitPrice': 75,
            'groupItemTotal': 75,
            'groupItemPriceContribution': 75,
            'total': 275,
        }, {
            **shared,
            'id': 'remembered-stand',
            'description': 'Stand',
            'catalogKey': 'inventory:ax|stand||',
            'groupLeader': False,
            'groupItemUnitPrice': 25,
            'groupItemTotal': 25,
            'groupItemPriceContribution': 25,
            'total': 0,
        }]

        saved = self.client.put(
            f"/api/quotations/{quotation['id']}", json=quotation,
        ).get_json()['data']
        self.assertTrue(all(
            line['groupPricingMode'] == 'total'
            for line in saved['lineItems']
        ))

        suggestion = self.client.get(
            '/api/finance/group-price-suggestion',
            query_string={'title': '  AUDIO   package '},
        )
        self.assertEqual(suggestion.status_code, 200)
        remembered = suggestion.get_json()['data']
        self.assertTrue(remembered['remembered'])
        self.assertEqual(remembered['unitPrice'], 275)
        self.assertEqual(remembered['uom'], 'lot')

    def test_group_custom_text_preserves_new_lines_in_editor_and_pdf(self):
        quotation = self.create_quote('Multiline Group Text')
        quotation['lineItems'] = [{
            'id': 'custom-package-details',
            'description': 'Package includes:\nDigital console\nStage box',
            'department': 'Audio Department',
            'systemName': 'Audio',
            'days': 1,
            'quantity': 1,
            'uom': 'lot',
            'unitPrice': 500,
            'discountPercent': 0,
            'subprojectId': 'main',
            'groupId': 'custom-package',
            'groupTitle': 'Audio Package',
            'groupDisplayFields': ['description'],
            'groupCustomText': True,
            'groupLeader': True,
            'groupItemQuantity': 1,
        }]
        saved = self.client.put(
            f"/api/quotations/{quotation['id']}", json=quotation,
        ).get_json()['data']
        self.assertEqual(
            saved['lineItems'][0]['description'],
            'Package includes:\nDigital console\nStage box',
        )

        pdf = self.client.get(f"/api/quotations/{quotation['id']}/pdf")
        text = '\n'.join(
            page.extract_text() or '' for page in PdfReader(io.BytesIO(pdf.data)).pages
        )
        self.assertIn('Package includes:\nDigital console\nStage box', text)
        self.assertNotIn('1x Package includes:', text)

        finance_source = Path('static/js/finance.js').read_text(encoding='utf-8')
        costing_source = Path('static/js/costing.js').read_text(encoding='utf-8')
        shared_css = Path('static/css/line-workspace.css').read_text(encoding='utf-8')
        self.assertIn("bucket.customText ? 'showbase-group-custom-text' : ''", finance_source)
        self.assertIn("line.groupCustomText ? 'showbase-group-custom-text' : ''", costing_source)
        self.assertIn('.showbase-group-custom-text {', shared_css)
        self.assertIn('white-space: pre-line;', shared_css)

    def test_custom_group_quantities_aggregate_across_subprojects(self):
        document = {
            'lineItems': [
                {
                    'id': 'custom-main',
                    'groupId': 'stage-package',
                    'groupTitle': 'Stage package',
                    'groupCustomText': True,
                    'description': 'Main room stage package',
                    'departmentCode': 'STAGING',
                    'quantity': 1,
                    'groupItemQuantity': 1,
                    'subprojectId': 'main',
                    'isCustom': True,
                },
                {
                    'id': 'custom-breakout',
                    'groupId': 'stage-package',
                    'groupTitle': 'Stage package',
                    'groupCustomText': True,
                    'description': 'Breakout stage package',
                    'departmentCode': 'STAGING',
                    'quantity': 2,
                    'groupItemQuantity': 1,
                    'subprojectId': 'breakout',
                    'isCustom': True,
                },
            ],
        }

        refs = app_module._finance_event_prepared_items(document)

        self.assertEqual(len(refs), 1)
        parsed = app_module._parse_custom_marker(refs[0])
        self.assertEqual(parsed['name'], 'Stage package')
        self.assertEqual(parsed['quantity'], 3)

    def test_zero_quantity_lines_do_not_create_event_requirements(self):
        quotation = {
            'lineItems': [{
                'id': 'zero-quotation-line',
                'catalogKey': 'inventory|l-acoustics|sb18-iii',
                'sourceAssetIds': ['AX#01'],
                'brand': 'L-Acoustics',
                'model': 'SB18 III',
                'description': 'Subwoofer',
                'department': 'Audio',
                'departmentCode': 'AX',
                'quantity': 0,
                'subprojectId': 'main',
            }],
        }
        costing = {
            'id': 'cost-zero',
            'lineItems': [{
                **quotation['lineItems'][0],
                'id': 'zero-costing-line',
                'groupHeaderQuantity': 0,
            }],
        }

        self.assertEqual(app_module._finance_event_prepared_items(quotation), [])
        self.assertEqual(
            app_module._finance_event_subprojects(quotation)[0]['items'],
            [],
        )
        self.assertEqual(app_module._costing_event_prepared_items(costing), [])
        self.assertEqual(
            app_module._costing_event_subprojects(costing)[0]['items'],
            [],
        )

    def test_event_date_range_uses_the_earliest_schedule_date(self):
        start, end = app_module._finance_event_date_range({
            'setupDate': '2026-08-20',
            'rehearsalDate': '2026-08-18',
            'showDate': '2026-08-19',
            'teardownDate': '2026-08-21',
        })

        self.assertEqual(start, '2026-08-18')
        self.assertEqual(end, '2026-08-21')

    def test_event_workflow_frontend_uses_progressive_shared_selection(self):
        finance_source = Path('static/js/finance.js').read_text(encoding='utf-8')
        plan_source = Path('static/js/plan.js').read_text(encoding='utf-8')
        app_source = Path('static/js/app.js').read_text(encoding='utf-8')
        workforce_source = Path('static/js/workforce-admin.js').read_text(
            encoding='utf-8'
        )

        self.assertNotIn('view=summary&limit=500', finance_source)
        self.assertIn('startProgressiveEventOptions(', finance_source)
        self.assertIn('financeRefreshEventCreationControls(', finance_source)
        self.assertIn("financePreviewEventField('projectName'", finance_source)
        self.assertIn('financeEventCreationNote', finance_source)
        self.assertIn("planOpenEventChooser('return')", app_source)
        self.assertIn("planOpenEventChooser('workforce')", workforce_source)
        self.assertNotIn('returnEventChooserModal', app_source)
        self.assertNotIn('workforceEventChooserModal', workforce_source)
        self.assertIn("context === 'return'", plan_source)
        self.assertIn("context === 'workforce'", plan_source)

        schedule = finance_source.split(
            '<div class="finance-schedule-grid">', 1
        )[1].split('${financeCustomScheduleMarkup(document)}', 1)[0]
        self.assertLess(schedule.index("'setup'"), schedule.index("'rehearsal'"))
        self.assertLess(schedule.index("'rehearsal'"), schedule.index("'show'"))
        self.assertLess(schedule.index("'show'"), schedule.index("'teardown'"))

    def test_group_description_only_consolidates_matching_asset_labels(self):
        from quotation_pdf import (
            _group_description_part,
            _group_display_entries,
            _group_line_description,
        )

        members = [
            {
                'groupId': 'speaker-package',
                'groupDisplayFields': ['description'],
                'brand': 'Brand A',
                'model': 'Model One',
                'description': 'Powered loudspeaker',
                'groupItemQuantity': 1,
            },
            {
                'groupId': 'speaker-package',
                'groupDisplayFields': ['description'],
                'brand': 'Brand B',
                'model': 'Model Two',
                'description': 'Powered loudspeaker',
                'groupItemQuantity': 2,
            },
        ]

        self.assertEqual(
            [_group_line_description(line) for line in members],
            ['Powered loudspeaker', 'Powered loudspeaker'],
        )
        self.assertEqual(
            _group_display_entries(members),
            [{
                'description': 'Powered loudspeaker',
                'quantity': 3.0,
                'customText': False,
            }],
        )

        prefixed = {
            'groupId': 'microphone-package',
            'brand': 'Shure',
            'model': 'SM58',
            'description': 'Shure SM58 Dynamic microphone',
            'groupItemQuantity': 1,
        }
        self.assertEqual(_group_description_part(prefixed), 'Dynamic microphone')
        self.assertEqual(
            _group_line_description({
                **prefixed,
                'groupDisplayFields': ['description'],
            }),
            'Dynamic microphone',
        )
        self.assertEqual(
            _group_line_description({
                **prefixed,
                'groupDisplayFields': ['brand', 'model', 'description'],
            }),
            'Shure SM58 Dynamic microphone',
        )

        hyphenated = {
            'groupId': 'drum-package',
            'brand': "DW Collector's Series",
            'model': '10" x 9" Rack Tom',
            'description': "DW Collector's Series 10\" x 9\" Rack Tom - Green",
            'groupItemQuantity': 1,
        }
        self.assertEqual(_group_description_part(hyphenated), '- Green')
        self.assertEqual(
            _group_line_description({
                **hyphenated,
                'groupDisplayFields': ['description'],
            }),
            '- Green',
        )
        self.assertEqual(
            _group_line_description({
                **hyphenated,
                'groupDisplayFields': ['brand', 'model', 'description'],
            }),
            "DW Collector's Series 10\" x 9\" Rack Tom - Green",
        )

    def test_group_pdf_wraps_to_cell_width_and_only_splits_at_page_height(self):
        from reportlab.lib.styles import ParagraphStyle
        from reportlab.lib.units import mm
        from reportlab.platypus import Paragraph
        from quotation_pdf import (
            _group_content_markup,
            _split_paragraph_by_height,
        )

        style = ParagraphStyle(
            'MeasuredGroupBody',
            fontName='Helvetica',
            fontSize=8.5,
            leading=11,
        )
        cell_width = 72 * mm - 6
        description = (
            'DW Collector\'s Series - Natural Finish with Gold '
            'Lugs 14" x 11" Floor Tom'
        )
        paragraph = Paragraph(_group_content_markup([{
            'description': description,
            'quantity': 1,
            'customText': False,
        }]), style)
        chunks = _split_paragraph_by_height(paragraph, cell_width, 568)

        self.assertEqual(len(chunks), 1)
        chunks[0].wrap(cell_width, 1_000)
        rendered_lines = [
            ''.join(getattr(word, 'text', '') for word in line.words)
            for line in chunks[0].blPara.lines
        ]
        self.assertTrue(
            any('Floor Tom' in line for line in rendered_lines),
            rendered_lines,
        )

        drum_sizes = (
            '10" x 8" Rack Tom', '12" x 8" Rack Tom',
            '13" x 9" Rack Tom', '14" x 11" Floor Tom',
            '14" x 5.5" Snare', '16" x 13" Floor Tom',
            '18" x 16" Floor Tom', '20" x 16" Kick',
            '22" x 17" Kick', '24" x 18" Kick', '8" x 7" Rack Tom',
        )
        full_group = Paragraph(_group_content_markup([
            {
                'description': (
                    'DW Collector\'s Series - Natural Finish with Gold '
                    f'Lugs {size}'
                ),
                'quantity': 1,
                'customText': False,
            }
            for size in drum_sizes
        ]), style)
        self.assertEqual(
            len(_split_paragraph_by_height(full_group, cell_width, 568)),
            1,
        )

        oversized_group = Paragraph(_group_content_markup([
            {
                'description': f'{description} item {index}',
                'quantity': 1,
                'customText': False,
            }
            for index in range(40)
        ]), style)
        oversized_chunks = _split_paragraph_by_height(
            oversized_group, cell_width, 568,
        )
        self.assertGreater(len(oversized_chunks), 1)
        self.assertTrue(all(
            chunk.wrap(cell_width, 10_000)[1] <= 568
            for chunk in oversized_chunks
        ))

        pdf_source = Path('quotation_pdf.py').read_text(encoding='utf-8')
        self.assertNotIn('textwrap.wrap(', pdf_source)
        self.assertNotIn('wrap_width=', pdf_source)

        from quotation_pdf import build_finance_pdf

        group_lines = [{
            'id': f'drum-{index}',
            'groupId': 'drum-kit',
            'groupLeader': index == 0,
            'groupTitle': 'DW Collectors - Natural Finish w Gold Lug',
            'groupDisplayFields': ['description'],
            'groupCustomText': False,
            'groupItemQuantity': 1,
            'description': (
                'DW Collector\'s Series - Natural Finish with Gold '
                f'Lugs {size}'
            ),
            'department': 'Musical Instruments',
            'days': 4 if index == 0 else 0,
            'quantity': 1 if index == 0 else 0,
            'uom': 'units',
            'unitPrice': 0,
            'total': 0,
            'subprojectId': 'main',
        } for index, size in enumerate(drum_sizes)]
        pdf = build_finance_pdf({
            'type': 'quotation',
            'number': 'QT-WRAP-QA',
            'projectName': 'Measured PDF wrapping QA',
            'quotationDate': '2026-08-16',
            'lineItems': group_lines,
            'subprojects': [{'id': 'main', 'name': 'Main Room'}],
            'showLineNumbers': True,
            'showUnitPrices': False,
            'showDepartmentSubtotals': False,
            'totals': {},
            'terms': 'QA preview',
        }, {
            'companyName': 'Showbase QA',
            'currency': 'SGD',
            'taxLabel': 'GST',
            'themeColor': '#334155',
        })
        pdf_text = '\n'.join(
            page.extract_text() or ''
            for page in PdfReader(io.BytesIO(pdf)).pages
        )
        self.assertNotIn('(continued)', pdf_text)
        self.assertTrue(
            any('Floor Tom' in line for line in pdf_text.splitlines()),
            pdf_text,
        )

    def test_pdf_marks_a_department_heading_when_its_table_continues(self):
        from quotation_pdf import build_finance_pdf

        lines = [{
            'id': f'audio-{index}',
            'description': (
                f'Audio equipment line {index + 1} with enough descriptive '
                'text to exercise measured table pagination'
            ),
            'department': 'Audio',
            'days': 2,
            'quantity': 1,
            'uom': 'units',
            'unitPrice': 10,
            'total': 20,
            'subprojectId': 'main',
        } for index in range(75)] + [{
            'id': 'transport-1',
            'description': 'Delivery and collection',
            'department': 'Transportation',
            'days': 1,
            'quantity': 1,
            'uom': 'trip',
            'unitPrice': 100,
            'total': 100,
            'subprojectId': 'main',
        }]
        pdf = build_finance_pdf({
            'type': 'quotation',
            'number': 'QT-CONTINUED-QA',
            'projectName': 'Department table pagination QA',
            'quotationDate': '2026-09-13',
            'lineItems': lines,
            'subprojects': [{'id': 'main', 'name': 'Main Room'}],
            'showLineNumbers': True,
            'showUnitPrices': False,
            'showDepartmentSubtotals': True,
            'totals': {'subtotal': 1500, 'netSubtotal': 1500, 'total': 1500},
            'terms': 'QA preview',
        }, {
            'companyName': 'Showbase QA',
            'currency': 'SGD',
            'taxLabel': 'GST',
            'themeColor': '#334155',
        })
        pages = [
            page.extract_text() or ''
            for page in PdfReader(io.BytesIO(pdf)).pages
        ]

        self.assertGreaterEqual(len(pages), 3)
        self.assertNotIn('Continued', pages[0])
        self.assertTrue(
            any('Continued' in page for page in pages[1:-1]),
            '\n--- PAGE ---\n'.join(pages),
        )
        first_audio_continuation = next(
            page for page in pages
            if 'Audio equipment line 28' in page
        )
        self.assertIn('Audio', first_audio_continuation)
        self.assertIn('Continued', first_audio_continuation)
        self.assertNotIn('Transportation', first_audio_continuation)
        self.assertEqual(
            sum(page.count('Audio equipment line') for page in pages),
            75,
        )

    def test_pdf_neutral_panels_use_a_faint_company_theme_tint(self):
        from quotation_pdf import _light_theme_tint, build_finance_pdf

        self.assertEqual(_light_theme_tint('#1D90D7'), '#F1F8FD')
        pdf = build_finance_pdf({
            'type': 'quotation',
            'number': 'QT-TINT-QA',
            'projectName': 'Theme tint check',
            'eventLocation': 'Singapore',
            'quotationDate': '2026-09-07',
            'setupDate': '2026-10-10',
            'setupTime': '09:00',
            'lineItems': [{
                'id': 'tint-line',
                'description': 'Audio package',
                'department': 'Audio',
                'days': 1,
                'quantity': 1,
                'uom': 'lot',
                'unitPrice': 100,
                'discountPercent': 0,
                'subprojectId': 'main',
            }],
            'subprojects': [{'id': 'main', 'name': 'Main Room'}],
            'showUnitPrices': True,
            'showDepartmentSubtotals': True,
            'totals': {
                'subtotal': 100,
                'netSubtotal': 100,
                'grandTotal': 100,
                'total': 100,
            },
        }, {
            'companyName': 'Showbase QA',
            'currency': 'SGD',
            'themeColor': '#1D90D7',
        })
        fill_colours = [
            tuple(float(value) for value in operands)
            for page in PdfReader(io.BytesIO(pdf)).pages
            for operands, operator in page.get_contents().operations
            if operator == b'rg'
        ]
        expected = tuple(channel / 255 for channel in (0xF1, 0xF8, 0xFD))
        tinted_fills = [colour for colour in fill_colours if
            all(abs(actual - target) < 0.001 for actual, target in zip(colour, expected))
        ]
        self.assertGreaterEqual(len(tinted_fills), 4)
        pdf_source = Path('quotation_pdf.py').read_text(encoding='utf-8')
        finance_pdf_source = pdf_source.split(
            'def build_finance_pdf', 1
        )[1].split('def build_receipt_pdf', 1)[0]
        self.assertNotIn('#F1F5F9', finance_pdf_source)
        self.assertNotIn('#F8FAFC', finance_pdf_source)

        positions = {}

        def capture_panel_text(text, current_matrix, text_matrix, *_args):
            content = text.strip()
            if content in {
                'PROJECT', 'Theme tint check', 'LOCATION', 'Singapore',
                'EVENT SCHEDULE', 'Set-up:',
            }:
                positions.setdefault(
                    content, current_matrix[5] + text_matrix[5]
                )

        PdfReader(io.BytesIO(pdf)).pages[0].extract_text(
            visitor_text=capture_panel_text
        )
        project_gap = positions['PROJECT'] - positions['Theme tint check']
        location_gap = positions['LOCATION'] - positions['Singapore']
        schedule_gap = positions['EVENT SCHEDULE'] - positions['Set-up:']
        self.assertLessEqual(project_gap, schedule_gap + 3)
        self.assertLessEqual(location_gap, schedule_gap + 3)

    def test_pdf_bill_to_addressee_is_bold(self):
        from quotation_pdf import build_finance_pdf

        pdf = build_finance_pdf({
            'type': 'quotation',
            'number': 'QT-BILL-TO-QA',
            'quotationDate': '2026-09-07',
            'client': {
                'salutation': 'Mr',
                'name': 'Wesley',
                'company': 'Example Client Pte Ltd',
            },
            'lineItems': [],
            'totals': {},
        }, {
            'companyName': 'Showbase QA',
            'currency': 'SGD',
            'themeColor': '#1D90D7',
        })
        rendered_text = {}

        def capture_bill_to_font(text, _cm, _tm, font, font_size):
            content = text.strip()
            if content in {'Mr Wesley', 'Example Client Pte Ltd'}:
                rendered_text[content] = {
                    'font': str((font or {}).get('/BaseFont') or ''),
                    'size': font_size,
                }

        PdfReader(io.BytesIO(pdf)).pages[0].extract_text(
            visitor_text=capture_bill_to_font
        )
        self.assertIn('bold', rendered_text['Mr Wesley']['font'].lower())
        self.assertNotIn(
            'bold', rendered_text['Example Client Pte Ltd']['font'].lower()
        )
        self.assertGreater(
            rendered_text['Mr Wesley']['size'],
            rendered_text['Example Client Pte Ltd']['size'],
        )

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
        self.assertIn('QTY', quotation_text)
        self.assertNotIn('QTY / UOM', quotation_text)
        self.assertIn('2 pax', quotation_text)
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
        self.assertIn('QTY', invoice_text)
        self.assertNotIn('QTY / UOM', invoice_text)
        self.assertIn('2 pax', invoice_text)
        self.assertIn('PROJECT', quotation_text)
        self.assertIn('EVENT SCHEDULE', quotation_text)
        self.assertIn('Quotation ref', invoice_text)
        self.assertEqual(len(reader.pages), 2)
        self.assertIn('LINE ITEMS', reader.pages[0].extract_text() or '')
        self.assertIn('Quotation Summary', reader.pages[1].extract_text() or '')
        for page in reader.pages:
            text = page.extract_text() or ''
            self.assertTrue(any(marker in text for marker in (
                'QUOTATION', 'LINE ITEMS', 'DESCRIPTION',
                'Summary', 'TERMS AND CONDITIONS',
            )), text)

    def test_quotation_pdf_exports_mandarin_characters(self):
        from quotation_pdf import build_finance_pdf

        quotation = self.create_quote('不着一字 : In Relation')
        quotation.update({
            'client': {
                'name': '王小明',
                'company': '华艺制作有限公司',
            },
            'eventLocation': '新加坡华族文化中心',
            'quotationDate': '2026-07-28',
            'lineItems': [{
                'id': 'mandarin-line',
                'description': '无线麦克风与音响系统',
                'department': '音响部门',
                'departmentCode': 'AX',
                'days': 1,
                'quantity': 2,
                'uom': 'units',
                'unitPrice': 100,
                'discountPercent': 0,
                'total': 200,
                'subprojectId': 'main',
            }],
            'notes': '包括安装、彩排及现场技术支持。',
            'terms': '付款期限：活动结束后十四天。',
        })
        company = {
            'companyName': '示范制作有限公司',
            'billingAddress': '新加坡实龙岗路一号',
            'footerText': '示范制作有限公司 | 新加坡',
            'currency': 'SGD',
            'taxLabel': 'GST',
            'themeColor': '#0F766E',
        }

        pdf = build_finance_pdf(quotation, company)
        text = '\n'.join(
            page.extract_text() or ''
            for page in PdfReader(io.BytesIO(pdf)).pages
        )

        for expected in (
            '不着一字',
            '王小明',
            '华艺制作有限公司',
            '无线麦克风与音响系统',
            '音响部门',
            '付款期限',
        ):
            self.assertIn(expected, text)
        self.assertNotIn('■■', text)

    def test_company_letterhead_can_be_disabled_and_restored(self):
        from quotation_pdf import build_finance_pdf

        self.login('bnjm2000')
        with patch.object(app_module, '_mark_company_branding_setup_complete'):
            disabled = self.client.put('/api/pdf-settings', json={
                'companyName': 'No Header Company Pte Ltd',
                'billingAddress': '1 Example Street',
                'letterheadText': '',
                'letterheadEnabled': False,
            })
        self.assertEqual(disabled.status_code, 200, disabled.get_data(as_text=True))
        disabled_settings = disabled.get_json()['data']
        self.assertEqual(disabled_settings['letterheadText'], '')
        self.assertFalse(disabled_settings['letterheadEnabled'])

        reloaded = self.client.get('/api/pdf-settings').get_json()['data']
        self.assertEqual(reloaded['letterheadText'], '')
        self.assertFalse(reloaded['letterheadEnabled'])

        quotation = self.create_quote('Letterhead Test')
        logo_path = os.path.join(self.tempdir.name, 'letterhead-logo.png')
        with open(logo_path, 'wb') as logo_file:
            logo_file.write(base64.b64decode(
                'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwC'
                'AAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
            ))
        pdf = build_finance_pdf(quotation, {
            **disabled_settings,
            'letterheadEnabled': False,
        }, logo_path)
        pdf_reader = PdfReader(io.BytesIO(pdf))
        pdf_text = '\n'.join(
            page.extract_text() or ''
            for page in pdf_reader.pages
        )
        self.assertNotIn('No Header Company Pte Ltd', pdf_text)
        self.assertNotIn('1 Example Street', pdf_text)
        self.assertTrue(any(page.images for page in pdf_reader.pages))

        restored_text = (
            'No Header Company Pte Ltd\n'
            'UEN / Reg No: 202600001A\n'
            '1 Example Street'
        )
        with patch.object(app_module, '_mark_company_branding_setup_complete'):
            restored = self.client.put('/api/pdf-settings', json={
                'registrationNumber': '202600001A',
                'letterheadText': restored_text,
                'letterheadEnabled': True,
            })
        self.assertEqual(restored.status_code, 200, restored.get_data(as_text=True))
        restored_settings = restored.get_json()['data']
        self.assertTrue(restored_settings['letterheadEnabled'])
        self.assertEqual(restored_settings['letterheadText'], restored_text)

    def test_company_payment_details_can_be_customised_and_used_on_invoices(self):
        from quotation_pdf import build_finance_pdf

        self.login('bnjm2000')
        custom_details = (
            'Please remit payment by bank transfer\n'
            'Reference: Use the invoice number'
        )
        with patch.object(app_module, '_mark_company_branding_setup_complete'):
            response = self.client.put('/api/pdf-settings', json={
                'bankName': 'Default Bank',
                'bankAccountNumber': '123-456-789',
                'paymentDetailsText': custom_details,
                'paymentDetailsEnabled': True,
            })
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        settings = response.get_json()['data']
        self.assertEqual(settings['paymentDetailsText'], custom_details)
        self.assertTrue(settings['paymentDetailsEnabled'])

        quotation = self.create_quote('Custom Payment Details')
        invoice = {
            **quotation,
            'type': 'invoice',
            'number': 'INV-2026-099',
            'invoiceDate': '2026-08-10',
            'invoiceAmount': 100,
            'quotationTotal': 100,
        }
        pdf_text = '\n'.join(
            page.extract_text() or ''
            for page in PdfReader(io.BytesIO(
                build_finance_pdf(invoice, settings)
            )).pages
        )
        self.assertIn('Please remit payment by bank transfer', pdf_text)
        self.assertIn('Reference: Use the invoice number', pdf_text)
        self.assertNotIn('123-456-789', pdf_text)
        self.assertIn('Invoice Summary', pdf_text)

        pdf_source = (
            Path(__file__).resolve().parents[1] / 'quotation_pdf.py'
        ).read_text(encoding='utf-8')
        self.assertIn(
            'colWidths=[bottom_column_width, bottom_column_width]',
            pdf_source,
        )

    def test_company_pdf_typography_round_trips_and_preview_renders(self):
        self.login('bnjm2000')
        payload = {
            'fontFamily': 'Georgia',
            'letterheadText': 'Typography Preview Company',
            'letterheadHtml': (
                '<div><strong>Typography</strong> Preview '
                '<span style="font-family:Arial;font-size:14pt;color:#cc1122">'
                '<u>Company</u></span></div>'
            ),
            'footerText': 'Confidential footer',
            'footerHtml': '<div><em>Confidential</em> footer</div>',
            'defaultTerms': 'Preview terms and conditions.',
            'defaultTermsHtml': (
                '<div>Preview <span style="color:#334455">terms</span> '
                'and conditions.</div>'
            ),
            'paymentDetailsText': 'Pay by bank transfer.',
            'paymentDetailsHtml': (
                '<div>Pay by <strong>bank transfer</strong>.</div>'
            ),
            'letterheadTypography': {
                'fontFamily': 'Arial', 'fontSize': 14,
                'bold': True, 'italic': False, 'underline': True,
            },
            'footerTypography': {
                'fontFamily': 'Georgia', 'fontSize': 8,
                'bold': False, 'italic': True, 'underline': False,
            },
            'termsTypography': {
                'fontFamily': 'Times New Roman', 'fontSize': 10,
                'bold': False, 'italic': False, 'underline': True,
            },
            'paymentDetailsTypography': {
                'fontFamily': 'Verdana', 'fontSize': 9,
                'bold': True, 'italic': False, 'underline': False,
            },
        }
        with patch.object(app_module, '_mark_company_branding_setup_complete'):
            response = self.client.put('/api/pdf-settings', json=payload)
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        saved = response.get_json()['data']
        self.assertEqual(saved['fontFamily'], 'Georgia')
        self.assertEqual(saved['letterheadTypography']['fontSize'], 14)
        self.assertTrue(saved['letterheadTypography']['bold'])
        self.assertTrue(saved['letterheadTypography']['underline'])
        self.assertEqual(saved['letterheadText'], 'Typography Preview Company')
        self.assertIn('<strong>Typography</strong> Preview', saved['letterheadHtml'])
        self.assertIn('font-family:Arial;font-size:14pt;color:#cc1122', saved['letterheadHtml'])
        self.assertEqual(saved['footerHtml'], '<div><em>Confidential</em> footer</div>')
        self.assertIn('color:#334455', saved['defaultTermsHtml'])
        self.assertIn('<strong>bank transfer</strong>', saved['paymentDetailsHtml'])

        preview = self.client.post('/api/pdf-settings/preview', json=payload)
        self.assertEqual(preview.status_code, 200)
        self.assertEqual(preview.mimetype, 'application/pdf')
        self.assertGreater(len(preview.data), 1000)
        preview_text = '\n'.join(
            page.extract_text() or ''
            for page in PdfReader(io.BytesIO(preview.data)).pages
        )
        self.assertIn('Typography Preview Company', preview_text)
        self.assertIn('Preview terms and conditions.', preview_text)
        self.assertIn('Pay by bank transfer.', preview_text)

        app_source = APP_BUNDLE_SOURCE
        self.assertIn('function defaultCompanyPaymentDetailsText', app_source)
        self.assertIn('populateDefaultCompanyPaymentDetails()', app_source)

    def test_invoice_and_quotation_terms_are_full_width_and_left_aligned(self):
        from quotation_pdf import build_finance_pdf

        company = {
            'companyName': 'Terms Layout Company',
            'themeColor': '#0F766E',
            'paymentDetailsEnabled': True,
            'paymentDetailsText': 'Pay by bank transfer.',
            'defaultTerms': 'Standard terms apply.',
        }
        base = {
            'projectName': 'Terms layout check',
            'client': {'name': 'Layout Client'},
            'paymentTerms': '30 Days',
            'taxRate': 9,
            'lineItems': [{
                'id': 'terms-layout-line', 'description': 'Production services',
                'department': 'Production', 'days': 1, 'quantity': 1,
                'unitPrice': 100, 'total': 100,
            }],
            'showUnitPrices': True,
            'showDepartmentSubtotals': True,
            'totals': {
                'subtotal': 100, 'netSubtotal': 100, 'tax': 9, 'total': 109,
            },
        }

        def text_positions(pdf, labels):
            positions = {}

            def capture(text, current_matrix, text_matrix, *_args):
                content = text.strip()
                if content in labels:
                    positions.setdefault(
                        content, current_matrix[4] + text_matrix[4]
                    )

            PdfReader(io.BytesIO(pdf)).pages[-1].extract_text(
                visitor_text=capture
            )
            return positions

        invoice_positions = text_positions(build_finance_pdf({
            **base,
            'type': 'invoice', 'number': 'INV-TERMS-LAYOUT',
            'invoiceDate': '2026-09-07', 'dueDate': '2026-10-07',
            'invoiceAmount': 109, 'quotationTotal': 109,
            'quotationPreTax': 100, 'invoiceAdjustedPreTax': 100,
            'invoiceAdjustedTax': 9,
        }, company), {
            'PAYMENT DETAILS', 'TERMS AND CONDITIONS',
            'Total (as per quotation)',
        })
        self.assertAlmostEqual(
            invoice_positions['PAYMENT DETAILS'],
            invoice_positions['TERMS AND CONDITIONS'],
            places=2,
        )
        self.assertLess(
            invoice_positions['TERMS AND CONDITIONS'],
            invoice_positions['Total (as per quotation)'],
        )

        quotation_positions = text_positions(build_finance_pdf({
            **base,
            'type': 'quotation', 'number': 'QT-TERMS-LAYOUT',
            'quotationDate': '2026-09-07',
        }, company), {'TERMS AND CONDITIONS', 'Total before GST'})
        self.assertLess(
            quotation_positions['TERMS AND CONDITIONS'],
            quotation_positions['Total before GST'],
        )
        pdf_source = Path('quotation_pdf.py').read_text(encoding='utf-8')
        self.assertIn('[[terms_details]]', pdf_source)
        self.assertIn('colWidths=[doc.width]', pdf_source)
        self.assertNotIn('bottom_left_details.extend(terms_details)', pdf_source)

    def test_quotation_pdf_stacks_notes_with_gap_and_matching_left_edge(self):
        from quotation_pdf import build_finance_pdf

        document = {
            'type': 'quotation',
            'number': 'QT-TERMS-NOTES-LAYOUT',
            'projectName': 'Terms and notes layout',
            'terms': 'Terms end here.',
            'notes': 'Notes start here.',
            'lineItems': [{
                'id': 'layout-line', 'description': 'Production services',
                'department': 'Production', 'days': 1, 'quantity': 1,
                'unitPrice': 100,
            }],
        }
        pdf = build_finance_pdf(document, {
            'companyName': 'Terms Layout Company',
            'themeColor': '#0F766E',
        })
        headings = {}

        def capture(text, current_matrix, text_matrix, *_args):
            content = text.strip()
            if content in {'TERMS AND CONDITIONS', 'Terms end here.', 'NOTES'}:
                headings[content] = (
                    current_matrix[4] + text_matrix[4],
                    current_matrix[5] + text_matrix[5],
                )

        last_page = PdfReader(io.BytesIO(pdf)).pages[-1]
        page_text = last_page.extract_text(visitor_text=capture) or ''
        self.assertIn('Notes start here.', page_text)
        self.assertIn('Terms end here.', page_text)
        self.assertEqual(
            set(headings), {'TERMS AND CONDITIONS', 'Terms end here.', 'NOTES'},
        )
        self.assertAlmostEqual(
            headings['TERMS AND CONDITIONS'][0], headings['NOTES'][0],
            delta=1,
        )
        self.assertGreater(
            headings['TERMS AND CONDITIONS'][1] - headings['NOTES'][1],
            35,
        )
        self.assertGreater(
            headings['Terms end here.'][1] - headings['NOTES'][1],
            25,
        )

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
        self.assertNotIn('Loan Department', departments)
        self.assertNotIn('Misc Department', departments)
        self.assertNotIn('Unknown Department', departments)

        finance_source = (
            Path(__file__).resolve().parents[1] / 'static' / 'js' / 'finance.js'
        ).read_text(encoding='utf-8')
        suggestion_source = finance_source.split(
            'function financeDepartmentSuggestions(query)', 1
        )[1].split('function financeShowDepartmentSuggestions', 1)[0]
        self.assertIn('!isSelectableCompanyDepartment({', suggestion_source)

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
        self.assertEqual(cleaned['departments'], ['Audio'])

        with self.client.session_transaction() as session:
            session.clear()
        self.assertEqual(self.client.get('/api/quotations').status_code, 401)

        self.login('no-sales')
        response = self.client.get('/api/quotations')
        self.assertEqual(response.status_code, 403)
        self.assertIn('Sales access required', response.get_json()['error'])

    def test_profit_loss_expense_upload_extracts_amount_and_date(self):
        self.login('sales-admin')
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
        self.assertEqual(payload['summary']['manualMealExpenses'], 123.45)
        self.assertEqual(payload['summary']['manpowerCost'], 0)
        self.assertEqual(payload['summary']['manpowerCardCost'], 0)
        self.assertEqual(payload['summary']['mealCost'], 0)
        self.assertEqual(payload['summary']['manualOtherExpenses'], 0)
        self.assertEqual(payload['summary']['manualExpensesTotal'], 123.45)
        self.assertEqual(payload['summary']['otherExpenses'], 123.45)
        expense = payload['expenses'][0]
        self.assertEqual(expense['amount'], 123.45)
        self.assertEqual(expense['expenseDate'], '2026-05-29')
        self.assertIn('/api/finance/profit-loss/expenses/', expense['attachment']['previewUrl'])
        file_response = self.client.get(expense['attachment']['previewUrl'])
        self.assertEqual(file_response.status_code, 200)

    def test_profit_loss_expense_upload_returns_queued_before_background_extraction(self):
        self.login('sales-admin')
        self.data_manager.events[139] = Event(
            event_id=139,
            name='Queued Expense Upload',
            location='Test Venue',
            start_date='20260821',
            end_date='20260821',
            asset_models=[],
            prepared_items=[],
            returned_items=[],
            actually_prepared=[],
            extra_assets=[],
            assigned_users=['sales-admin'],
        )
        with patch.object(app_module, '_queue_profit_loss_expense_processing') as queue_processing, \
             patch.object(app_module, 'extract_claim_amount') as extract:
            response = self.client.post(
                '/api/finance/profit-loss/139/expenses',
                data={'file': (io.BytesIO(b'%PDF-1.4 queued'), 'queued-expense.pdf')},
                content_type='multipart/form-data',
            )
        self.assertEqual(response.status_code, 201, response.get_data(as_text=True))
        expense = response.get_json()['expense']
        self.assertEqual(expense['processingState'], 'Queued')
        self.assertEqual(expense['submissionStage'], 'Queued')
        queue_processing.assert_called_once()
        extract.assert_not_called()

    def test_profit_loss_upload_ui_queues_files_and_shows_each_progress_state(self):
        source_path = os.path.join(
            os.path.dirname(app_module.__file__), 'static', 'js', 'finance.js'
        )
        with open(source_path, encoding='utf-8') as source_file:
            source = source_file.read()
        self.assertIn('const profitLossExpenseUploadState = {', source)
        self.assertIn('function profitLossExpenseUploadRequest(', source)
        self.assertIn('async function profitLossProcessExpenseUploadQueue()', source)
        self.assertIn('data-pnl-upload-progress', source)
        with open(app_module.__file__, encoding='utf-8') as app_source_file:
            app_source = app_source_file.read()
        self.assertIn("'profit-loss-expense-processing-started'", app_source)

    def test_profit_loss_needs_review_and_edit_share_attachment_review_editor(self):
        static_folder = os.path.join(os.path.dirname(app_module.__file__), 'static')
        with open(os.path.join(static_folder, 'js', 'finance.js'), encoding='utf-8') as source_file:
            source = source_file.read()
        with open(os.path.join(static_folder, 'css', 'finance.css'), encoding='utf-8') as css_file:
            css = css_file.read()

        self.assertIn('class="pnl-review-pill" onclick="${action}"', source)
        self.assertIn("`profitLossOpenExpenseModal('${financeEscapeAttr(expense.id)}')`", source)
        self.assertIn('class="pnl-expense-edit" onclick="profitLossOpenExpenseModal', source)
        self.assertIn('id="profitLossExpensePreviewPanel"', source)
        self.assertIn('function profitLossRenderExpenseReviewPreview(expense)', source)
        self.assertIn("preview = document.createElement('iframe')", source)
        self.assertIn("preview = document.createElement('img')", source)
        self.assertIn(
            "`${previewUrl}#toolbar=1&navpanes=0&pagemode=none&view=Fit`",
            source,
        )
        self.assertIn("title.textContent = isReview ? 'Review Expense'", source)
        self.assertIn('id="profitLossExpenseOtherCategoryField" hidden', source)
        self.assertIn("profitLossChooseExpenseCategory('${category}')", source)
        categories = ('Meal', 'Crew Transport', 'Equipment Transport', 'Purchase', 'Other')
        for category in categories:
            self.assertIn(category, source)
        self.assertIn(
            "['Meal', 'Crew Transport', 'Equipment Transport', 'Purchase', 'Other']",
            source,
        )
        self.assertIn('.pnl-expense-modal.has-preview', css)
        self.assertIn('grid-template-columns: minmax(0, 1.3fr) minmax(330px, .7fr)', css)
        self.assertIn('.pnl-expense-fields .finance-field[hidden]', css)
        self.assertIn("function profitLossOpenClaimReview(submissionId)", source)
        claim_actions = source.split("['worker-claim', 'transport-invoice', 'transport-claim'].includes(row.source) ?", 1)[1].split(
            ': row.readOnly ?', 1
        )[0]
        self.assertIn('profitLossOpenClaimReview', claim_actions)
        self.assertIn("row.source === 'transport-invoice' ? 'transport invoice' : 'claim'", claim_actions)
        self.assertIn("row.source.startsWith('transport-') ? 'transport' : 'claims'", claim_actions)
        self.assertIn('aria-label="Open Crew &amp; Vendors"', claim_actions)
        self.assertNotIn('finance-delete-line', claim_actions)
        self.assertIn("source === 'transport-invoice'", source)
        self.assertIn("group = 'transport';", source)
        self.assertIn("department && source !== 'transport-invoice'", source)

    def test_repeatable_schedule_rows_extend_event_and_pdf(self):
        quotation = self.create_quote('Multi-day Show')
        quotation.update({
            'setupDate': '2026-08-02',
            'additionalSetups': [{'id': 'setup-2', 'date': '2026-08-01', 'time': '09:00'}],
            'showDate': '2026-08-03',
            'teardownDate': '2026-08-04',
            'additionalShows': [{'id': 'show-2', 'date': '2026-08-04', 'time': '19:30'}],
            'additionalTeardowns': [{'id': 'tear-2', 'date': '2026-08-05', 'time': '23:00'}],
        })
        saved = self.client.put(
            f"/api/quotations/{quotation['id']}", json=quotation,
        ).get_json()['data']
        self.assertEqual(saved['eventDays'], 5)
        self.assertEqual(saved['additionalSetups'][0]['date'], '2026-08-01')
        self.assertEqual(saved['additionalShows'][0]['date'], '2026-08-04')

        pdf = self.client.get(f"/api/quotations/{quotation['id']}/pdf").data
        text = '\n'.join(page.extract_text() or '' for page in PdfReader(io.BytesIO(pdf)).pages)
        self.assertIn('Set-up:', text)
        self.assertNotIn('Set-up 2:', text)
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

    def test_schedule_tbc_time_is_preserved_and_rendered_without_hours_suffix(self):
        from quotation_pdf import _schedule_date_summary

        quotation = self.create_quote('TBC Schedule')
        quotation.update({
            'showDate': '2026-08-03',
            'showTime': 'TBC',
            'additionalShows': [
                {'id': 'show-2', 'date': '2026-08-04', 'time': 'TBC'},
            ],
        })
        saved = self.client.put(
            f"/api/quotations/{quotation['id']}", json=quotation,
        ).get_json()['data']

        self.assertEqual(saved['showTime'], 'TBC')
        self.assertEqual(saved['additionalShows'][0]['time'], 'TBC')
        self.assertEqual(
            _schedule_date_summary([
                {'date': saved['showDate'], 'time': saved['showTime']},
                saved['additionalShows'][0],
            ]),
            '3 - 4 August 2026, TBC',
        )

        pdf = self.client.get(f"/api/quotations/{quotation['id']}/pdf").data
        text = '\n'.join(
            page.extract_text() or '' for page in PdfReader(io.BytesIO(pdf)).pages
        )
        self.assertIn('TBC', text)
        self.assertNotIn('TBChrs', text)

    def test_dry_hire_schedule_labels_pdf_and_created_event_tag(self):
        quotation = self.create_quote('Dry Hire Schedule')
        quotation.update({
            'scheduleMode': 'dry-hire',
            'setupDate': '2026-08-10',
            'rehearsalDate': '2026-08-11',
            'showDate': '2026-08-12',
            'teardownDate': '2026-08-13',
        })
        saved = self.client.put(
            f"/api/quotations/{quotation['id']}", json=quotation,
        ).get_json()['data']

        self.assertEqual(saved['scheduleMode'], 'dry-hire')
        pdf = self.client.get(f"/api/quotations/{quotation['id']}/pdf").data
        text = '\n'.join(
            page.extract_text() or '' for page in PdfReader(io.BytesIO(pdf)).pages
        )
        self.assertIn('Delivery / Collection:', text)
        self.assertIn('Return:', text)
        self.assertIn('Rehearsal:', text)
        self.assertIn('Show:', text)
        self.assertNotIn('Set-up:', text)
        self.assertNotIn('Teardown:', text)

        accepted = self.client.put(
            f"/api/quotations/{quotation['id']}", json={'status': 'accepted'},
        ).get_json()['data']
        self.assertEqual(self.data_manager.events[accepted['eventId']].tag, 'dry hire')

    def test_custom_schedule_dates_keep_the_selected_pdf_order(self):
        quotation = self.create_quote('Ordered Custom Schedule')
        quotation.update({
            'setupDate': '2026-08-03',
            'rehearsalDate': '2026-08-04',
            'showDate': '2026-08-05',
            'teardownDate': '2026-08-08',
            'customScheduleGroups': [
                {
                    'id': 'venue-access',
                    'label': 'Venue access',
                    'dates': [{'id': 'access-1', 'date': '2026-08-02', 'time': '09:00'}],
                },
                {
                    'id': 'handover',
                    'label': 'Handover',
                    'dates': [
                        {'id': 'handover-1', 'date': '2026-08-06', 'time': ''},
                        {'id': 'handover-2', 'date': '2026-08-07', 'time': ''},
                    ],
                },
            ],
            'scheduleOrder': [
                'custom:venue-access',
                'setup',
                'rehearsal',
                'show',
                'custom:handover',
                'teardown',
            ],
        })
        response = self.client.put(
            f"/api/quotations/{quotation['id']}", json=quotation,
        )
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        saved = response.get_json()['data']
        self.assertEqual(saved['eventDays'], 7)
        self.assertEqual(saved['scheduleOrder'][0], 'custom:venue-access')
        self.assertEqual(saved['scheduleOrder'][-2], 'custom:handover')
        self.assertEqual(saved['customScheduleGroups'][1]['label'], 'Handover')

        pdf = self.client.get(f"/api/quotations/{quotation['id']}/pdf").data
        text = '\n'.join(
            page.extract_text() or ''
            for page in PdfReader(io.BytesIO(pdf)).pages
        )
        labels = [
            'Venue access:', 'Set-up:', 'Rehearsal:',
            'Show:', 'Handover:', 'Teardown:',
        ]
        positions = [text.index(label) for label in labels]
        self.assertEqual(positions, sorted(positions))
        self.assertIn('2 August 2026, 09:00hrs', text)
        self.assertIn('6 - 7 August 2026', text)

        accepted = self.client.put(
            f"/api/quotations/{quotation['id']}", json={'status': 'accepted'},
        ).get_json()['data']
        event = self.data_manager.events[accepted['eventId']]
        self.assertEqual(event.start_date, '20260802')
        self.assertEqual(event.end_date, '20260808')

    def test_custom_schedule_batches_persist_and_render_recurrence(self):
        quotation = self.create_quote('Recurring Custom Schedule')
        quotation.update({
            'customScheduleGroups': [{
                'id': 'handover',
                'label': 'Handover',
                'dates': [
                    {
                        'id': f'handover-{index}',
                        'date': date,
                        'time': '10:00',
                        'batchId': 'weekly-handover',
                    }
                    for index, date in enumerate((
                        '2026-08-07',
                        '2026-08-14',
                        '2026-08-21',
                    ), start=1)
                ],
            }],
            'scheduleOrder': [
                'setup', 'rehearsal', 'show', 'custom:handover', 'teardown',
            ],
            'scheduleBatches': [{
                'id': 'weekly-handover',
                'kind': 'custom:handover',
                'method': 'recurring',
                'startDate': '2026-08-07',
                'endDate': '2026-08-21',
                'weekdays': [5],
                'intervalWeeks': 1,
                'time': '10:00',
                'excludedDates': [],
            }],
        })
        response = self.client.put(
            f"/api/quotations/{quotation['id']}", json=quotation,
        )
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        saved = response.get_json()['data']
        self.assertEqual(saved['scheduleBatches'][0]['kind'], 'custom:handover')
        self.assertEqual(
            saved['customScheduleGroups'][0]['dates'][0]['batchId'],
            'weekly-handover',
        )

        pdf = self.client.get(f"/api/quotations/{quotation['id']}/pdf").data
        text = '\n'.join(
            page.extract_text() or ''
            for page in PdfReader(io.BytesIO(pdf)).pages
        )
        self.assertIn('Handover:', text)
        self.assertIn('Every Friday, 7 - 21 August 2026, 10:00hrs', text)

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
        self.assertNotIn('bnjm2000', rows)

        self.login('bnjm2000')
        owner_rows = {
            row['username']
            for row in self.client.get('/api/finance/salespeople').get_json()['data']
        }
        self.assertIn('bnjm2000', owner_rows)
        self.login('alice')

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

    def test_client_directory_requires_admin_or_sales_access(self):
        self.login('no-sales')
        self.assertEqual(self.client.get('/api/clients').status_code, 403)
        self.assertEqual(
            self.client.post('/api/clients', json={'name': 'Blocked Client'}).status_code,
            403,
        )
        denied_page = self.client.get('/clients')
        self.assertEqual(denied_page.status_code, 302)
        self.assertTrue(denied_page.headers['Location'].endswith('/events'))

        self.login('manager-no-sales')
        self.assertEqual(self.client.get('/api/clients').status_code, 403)
        self.assertEqual(self.client.get('/clients').status_code, 302)

        self.login('review-admin')
        self.assertEqual(self.client.get('/api/clients').status_code, 200)
        admin_page = self.client.get('/clients')
        self.assertEqual(admin_page.status_code, 200)
        self.assertIn(
            'window.__INITIAL_APP_SECTION__ = "clients"',
            admin_page.get_data(as_text=True),
        )

        self.login('sales-manager')
        self.assertEqual(self.client.get('/api/clients').status_code, 200)
        self.assertEqual(self.client.get('/clients').status_code, 200)

    def test_client_directory_edits_every_field_and_supports_renaming(self):
        created = self.client.post('/api/clients', json={
            'salutation': 'Mr.',
            'name': 'Original Client',
            'company': 'Original Company',
            'contactPerson': 'Original Contact',
            'email': 'original@example.com',
            'phone': '+65 6123 4567',
            'taxNumber': 'TAX-OLD',
            'address1': '1 Old Street',
            'address2': 'Level 1',
            'address3': 'Old District',
            'postalCode': '111111',
        })
        self.assertEqual(created.status_code, 200, created.get_data(as_text=True))

        updated = self.client.put('/api/clients/Original%20Client', json={
            'salutation': 'Ms.',
            'name': 'Renamed Client',
            'company': 'Renamed Company',
            'contactPerson': 'New Contact',
            'email': 'new@example.com',
            'phone': '+65 6987 6543',
            'taxNumber': 'TAX-NEW',
            'address1': '2 New Street',
            'address2': 'Level 9',
            'address3': 'New District',
            'postalCode': '999999',
        })
        self.assertEqual(updated.status_code, 200, updated.get_data(as_text=True))
        payload = updated.get_json()['data']
        self.assertEqual(payload, {
            'salutation': 'Ms.',
            'name': 'Renamed Client',
            'company': 'Renamed Company',
            'contactPerson': 'New Contact',
            'email': 'new@example.com',
            'phone': '+65 6987 6543',
            'taxNumber': 'TAX-NEW',
            'address1': '2 New Street',
            'address2': 'Level 9',
            'address3': 'New District',
            'postalCode': '999999',
        })
        self.assertNotIn('Original Client', self.data_manager.clients)
        self.assertIn('Renamed Client', self.data_manager.clients)
        matched = self.client.get('/api/clients?query=new%20district').get_json()['data']
        self.assertEqual([row['name'] for row in matched], ['Renamed Client'])

    def test_client_directory_rejects_duplicate_names(self):
        self.assertEqual(
            self.client.post('/api/clients', json={'name': 'Existing Client'}).status_code,
            200,
        )
        duplicate = self.client.post('/api/clients', json={'name': 'existing client'})
        self.assertEqual(duplicate.status_code, 409)

        self.assertEqual(
            self.client.post('/api/clients', json={'name': 'Another Client'}).status_code,
            200,
        )
        renamed = self.client.put(
            '/api/clients/Another%20Client',
            json={'name': 'Existing Client'},
        )
        self.assertEqual(renamed.status_code, 409)

    def test_deleting_client_hides_suggestions_without_changing_existing_documents(self):
        quotation = self.create_quote('Retained Client Details')
        quotation['client'] = {
            'salutation': 'Mrs.',
            'name': 'Archived Directory Client',
            'company': 'Snapshot Company',
            'contactPerson': 'Jamie Snapshot',
            'email': 'snapshot@example.com',
            'phone': '+65 6123 4567',
            'taxNumber': 'SNAP-123',
            'address1': '10 Snapshot Street',
            'address2': 'Level 5',
            'address3': 'Central',
            'postalCode': '123456',
        }
        saved = self.client.put(
            f"/api/quotations/{quotation['id']}", json=quotation,
        ).get_json()['data']
        embedded_client = copy.deepcopy(saved['client'])

        deleted = self.client.delete('/api/clients/Archived%20Directory%20Client')
        self.assertEqual(deleted.status_code, 200, deleted.get_data(as_text=True))
        self.assertFalse(
            self.data_manager.clients['Archived Directory Client'].is_active,
        )
        self.assertNotIn(
            'Archived Directory Client',
            [row['name'] for row in self.client.get('/api/clients').get_json()['data']],
        )
        self.assertEqual(
            self.client.get('/api/clients/Archived%20Directory%20Client').status_code,
            404,
        )

        existing = self.client.get(f"/api/quotations/{quotation['id']}")
        self.assertEqual(existing.get_json()['data']['client'], embedded_client)

        # Routine edits retain the embedded details without restoring a client
        # that was intentionally removed from the directory.
        existing_document = existing.get_json()['data']
        existing_document['notes'] = 'Client details remain on this document.'
        resaved = self.client.put(
            f"/api/quotations/{quotation['id']}", json=existing_document,
        )
        self.assertEqual(resaved.status_code, 200, resaved.get_data(as_text=True))
        self.assertEqual(resaved.get_json()['data']['client'], embedded_client)
        self.assertNotIn(
            'Archived Directory Client',
            [row['name'] for row in self.client.get('/api/clients').get_json()['data']],
        )

        reloaded = DataManager(self.tempdir.name)
        reloaded.load_clients()
        self.assertFalse(reloaded.clients['Archived Directory Client'].is_active)

        restored = self.client.post('/api/clients', json={
            **embedded_client,
            'company': 'Restored Company',
        })
        self.assertEqual(restored.status_code, 200, restored.get_data(as_text=True))
        self.assertEqual(restored.get_json()['data']['company'], 'Restored Company')
        self.assertTrue(self.data_manager.clients['Archived Directory Client'].is_active)

    def test_client_directory_ui_is_wired_into_finance_navigation(self):
        project_root = Path(__file__).resolve().parents[1]
        finance_source = (project_root / 'static' / 'js' / 'finance.js').read_text(encoding='utf-8')
        app_source = (project_root / 'static' / 'js' / 'app.js').read_text(encoding='utf-8')
        self.assertIn('data-section="clients"', finance_source)
        self.assertIn("['clients-section'", finance_source)
        self.assertIn('function loadClientsPage(', finance_source)
        self.assertIn('function clientDirectoryDelete(', finance_source)
        self.assertIn('will no longer appear in client suggestions', finance_source)
        for field in (
            'name="salutation"', 'name="name"', 'name="company"',
            'name="contactPerson"', 'name="email"', 'name="phone"',
            'name="taxNumber"', 'name="address1"', 'name="address2"',
            'name="address3"', 'name="postalCode"',
        ):
            self.assertIn(field, finance_source)
        self.assertIn("clients: '/clients'", app_source)
        self.assertIn("sectionName === 'clients' && !canCurrentUserAccessClients()", app_source)
        self.assertIn("a3.value = rec.postalCode || rec.address3 || ''", app_source)

    def test_saved_client_address_lines_can_be_cleared(self):
        created = self.client.post('/api/clients', json={
            'name': 'Clear Address Client',
            'company': 'Example Pte Ltd',
            'address1': '10 Example Street',
            'address2': 'Level 2',
            'address3': 'Unit 03-04',
            'postalCode': '123456',
            'phone': '+65 9123 4567',
        })
        self.assertEqual(created.status_code, 200, created.get_data(as_text=True))

        updated = self.client.put('/api/clients/Clear%20Address%20Client', json={
            'address2': '',
        })
        self.assertEqual(updated.status_code, 200, updated.get_data(as_text=True))
        client = updated.get_json()['data']
        self.assertEqual(client['address1'], '10 Example Street')
        self.assertEqual(client['address2'], '')
        self.assertEqual(client['address3'], 'Unit 03-04')

        reloaded = DataManager(self.tempdir.name)
        reloaded.load_clients()
        self.assertEqual(reloaded.clients['Clear Address Client'].address2, '')
        self.assertEqual(reloaded.clients['Clear Address Client'].address1, '10 Example Street')

    def test_quotation_client_details_create_and_update_known_client(self):
        quotation = self.create_quote('Client Sync')
        quotation['client'] = {
            'salutation': 'Ms.',
            'name': 'Jamie Tan',
            'company': 'First Company',
            'phone': '+65 9123 4567',
            'email': 'jamie@example.com',
            'address1': '1 First Street',
        }
        created = self.client.put(
            f"/api/quotations/{quotation['id']}", json=quotation,
        )
        self.assertEqual(created.status_code, 200, created.get_data(as_text=True))
        saved = created.get_json()['data']
        self.assertEqual(saved['clientRecordName'], 'Jamie Tan')
        self.assertEqual(self.data_manager.clients['Jamie Tan'].company, 'First Company')

        saved['client'].update({
            'name': 'Jamie Lim',
            'company': 'Updated Company',
            'phone': '+65 9876 5432',
            'address1': '',
        })
        updated = self.client.put(
            f"/api/quotations/{quotation['id']}", json=saved,
        )
        self.assertEqual(updated.status_code, 200, updated.get_data(as_text=True))
        self.assertNotIn('Jamie Tan', self.data_manager.clients)
        self.assertEqual(updated.get_json()['data']['clientRecordName'], 'Jamie Lim')
        self.assertEqual(self.data_manager.clients['Jamie Lim'].company, 'Updated Company')
        self.assertEqual(self.data_manager.clients['Jamie Lim'].phone, '+65 9876 5432')
        self.assertEqual(self.data_manager.clients['Jamie Lim'].address1, '')

    def test_quotation_list_backfills_missing_clients_without_overwriting_existing(self):
        quotation = self.create_quote('Legacy Client')
        quotation['client'] = {
            'name': 'Legacy Person',
            'company': 'Quotation Company',
            'email': 'legacy@example.com',
        }
        saved = self.client.put(
            f"/api/quotations/{quotation['id']}", json=quotation,
        ).get_json()['data']
        self.data_manager.clients.pop('Legacy Person')
        self.data_manager.save_clients()

        response = self.client.get('/api/quotations?view=summary')
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertEqual(
            self.data_manager.clients['Legacy Person'].company,
            'Quotation Company',
        )

        self.data_manager.clients['Legacy Person'].company = 'Canonical Company'
        self.data_manager.save_clients()
        saved['client']['company'] = 'Older Quotation Value'
        finance_data = app_module._load_finance_data()
        for index, row in enumerate(finance_data['documents']):
            if row.get('id') == saved['id']:
                finance_data['documents'][index] = saved
        app_module._save_finance_data(finance_data)

        self.client.get('/api/quotations?view=summary')
        self.assertEqual(
            self.data_manager.clients['Legacy Person'].company,
            'Canonical Company',
        )

    def test_editor_orders_schedule_chronologically(self):
        project_root = os.path.dirname(os.path.dirname(__file__))
        with open(
            os.path.join(project_root, 'static', 'js', 'finance.js'),
            encoding='utf-8',
        ) as source_file:
            source = source_file.read()

        schedule_start = source.index('<h3>Event schedule</h3>')
        schedule_source = source[schedule_start:source.index('</section>', schedule_start)]
        setup = schedule_source.index("financeSchedulePair(setupLabel, 'setup')")
        additional_setups = schedule_source.index("financeScheduleRowsMarkup('setup', document)")
        teardown = schedule_source.index("financeSchedulePair(teardownLabel, 'teardown')")
        additional_teardowns = schedule_source.index("financeScheduleRowsMarkup('teardown', document)")
        rehearsal = schedule_source.index("financeSchedulePair('Rehearsal', 'rehearsal')")
        additional_rehearsals = schedule_source.index("financeScheduleRowsMarkup('rehearsal', document)")
        show = schedule_source.index("financeSchedulePair('Show', 'show')")
        additional_shows = schedule_source.index("financeScheduleRowsMarkup('show', document)")
        self.assertLess(setup, additional_setups)
        self.assertLess(additional_setups, rehearsal)
        self.assertLess(rehearsal, additional_rehearsals)
        self.assertLess(additional_rehearsals, show)
        self.assertLess(show, additional_shows)
        self.assertLess(additional_shows, teardown)
        self.assertLess(teardown, additional_teardowns)
        self.assertIn('finance-schedule-stack', schedule_source)
        self.assertIn("financeAddScheduleRow('setup')", schedule_source)
        self.assertIn("financeAddScheduleRow('teardown')", schedule_source)
        self.assertIn('!FINANCE_SCHEDULE_KEYS[kind]', source)
        self.assertNotIn('Dates are optional. New line items will use', schedule_source)
        self.assertIn('financeScheduleModeControl(document)', schedule_source)
        self.assertIn("financeSetScheduleMode('dry-hire')", source)
        self.assertIn("return 'Delivery / Collection'", source)
        self.assertIn("return 'Return'", source)

    def test_editor_supports_ordered_custom_schedule_dates(self):
        project_root = os.path.dirname(os.path.dirname(__file__))
        with open(
            os.path.join(project_root, 'static', 'js', 'finance.js'),
            encoding='utf-8',
        ) as source_file:
            source = source_file.read().lower()

        self.assertIn('+ custom date(s)', source)
        self.assertIn('customschedulegroups', source)
        self.assertIn('scheduleorder', source)
        self.assertIn('schedule position', source)
        self.assertIn('financecustomscheduleplacementmarkup', source)
        self.assertIn('financescheduletokenhasdate', source)
        self.assertIn(
            '.filter(token => financescheduletokenhasdate(token, document))',
            source,
        )
        self.assertIn('place here', source)
        self.assertIn('positionindex: -1', source)
        self.assertIn('choose where the custom dates should appear in the schedule', source)
        self.assertIn('between', source)
        self.assertIn('financeopencustomschedule', source)

    def test_bulk_schedule_batches_persist_and_pdf_uses_compact_recurrence(self):
        quotation = self.create_quote('Long-running Show')
        quotation.update({
            'additionalShows': [
                {
                    'id': f'weekly-{index}',
                    'date': date,
                    'time': '19:00',
                    'batchId': 'weekly-shows',
                }
                for index, date in enumerate((
                    '2026-08-07',
                    '2026-08-14',
                    '2026-08-21',
                    '2026-08-28',
                ), start=1)
            ],
            'scheduleBatches': [{
                'id': 'weekly-shows',
                'kind': 'show',
                'method': 'recurring',
                'startDate': '2026-08-07',
                'endDate': '2026-08-28',
                'weekdays': [5],
                'intervalWeeks': 1,
                'time': '19:00',
                'pasteText': '',
                'excludedDates': [],
            }],
        })

        response = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json=quotation,
        )
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        saved = response.get_json()['data']
        self.assertEqual(saved['scheduleBatches'][0]['id'], 'weekly-shows')
        self.assertEqual(saved['additionalShows'][0]['batchId'], 'weekly-shows')
        self.assertEqual(saved['eventDays'], 22)

        pdf = self.client.get(f"/api/quotations/{quotation['id']}/pdf").data
        text = '\n'.join(page.extract_text() or '' for page in PdfReader(io.BytesIO(pdf)).pages)
        self.assertIn('Every Friday, 7 - 28 August 2026, 19:00hrs', text)

    def test_bulk_schedule_pdf_lists_recurring_exceptions(self):
        quotation = self.create_quote('Long-running Show With Exception')
        quotation.update({
            'additionalShows': [
                {
                    'id': f'weekly-{index}',
                    'date': date,
                    'time': '19:00',
                    'batchId': 'weekly-shows',
                }
                for index, date in enumerate((
                    '2026-08-07',
                    '2026-08-21',
                    '2026-08-28',
                ), start=1)
            ],
            'scheduleBatches': [{
                'id': 'weekly-shows',
                'kind': 'show',
                'method': 'recurring',
                'startDate': '2026-08-07',
                'endDate': '2026-08-28',
                'weekdays': [5],
                'intervalWeeks': 1,
                'time': '19:00',
                'excludedDates': ['2026-08-14|19:00'],
            }],
        })
        response = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json=quotation,
        )
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))

        pdf = self.client.get(f"/api/quotations/{quotation['id']}/pdf").data
        text = '\n'.join(page.extract_text() or '' for page in PdfReader(io.BytesIO(pdf)).pages)
        compact_text = ' '.join(text.split())
        self.assertIn('Every Friday, 7 - 28 August 2026, 19:00hrs', compact_text)
        self.assertIn('except 14 August 2026', compact_text)

    def test_bulk_schedule_without_weekdays_repeats_every_day(self):
        quotation = self.create_quote('Daily Show')
        quotation.update({
            'additionalShows': [
                {
                    'id': f'daily-{index}',
                    'date': date,
                    'time': '19:00',
                    'batchId': 'daily-shows',
                }
                for index, date in enumerate((
                    '2026-08-07',
                    '2026-08-08',
                    '2026-08-09',
                ), start=1)
            ],
            'scheduleBatches': [{
                'id': 'daily-shows',
                'kind': 'show',
                'method': 'recurring',
                'startDate': '2026-08-07',
                'endDate': '2026-08-09',
                'weekdays': [],
                'intervalWeeks': 1,
                'time': '19:00',
                'excludedDates': [],
            }],
        })
        response = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json=quotation,
        )
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        saved = response.get_json()['data']
        self.assertEqual(saved['scheduleBatches'][0]['weekdays'], [])

        pdf = self.client.get(f"/api/quotations/{quotation['id']}/pdf").data
        text = '\n'.join(page.extract_text() or '' for page in PdfReader(io.BytesIO(pdf)).pages)
        self.assertIn('7 - 9 August 2026, 19:00hrs', text)
        self.assertNotIn('Every day', text)

    def test_bulk_schedule_builder_includes_recurring_paste_and_batch_actions(self):
        project_root = os.path.dirname(os.path.dirname(__file__))
        with open(
            os.path.join(project_root, 'static', 'js', 'finance.js'),
            encoding='utf-8',
        ) as source_file:
            source = source_file.read().lower()

        self.assertIn('bulk add dates', source)
        self.assertIn('recurring range', source)
        self.assertIn('paste dates', source)
        self.assertIn('limited to 500 dates', source)
        self.assertIn('duplicate', source)
        self.assertIn('financebulkschedulecandidates', source)
        self.assertIn('financeschedulekindoptions', source)
        self.assertIn('financecustomschedulegroupforkind', source)
        self.assertIn('finance-schedule-type-segments', source)
        self.assertIn('financeparsebulkscheduleline', source)
        self.assertIn('financeparseclientbriefline', source)
        self.assertIn('financebriefstarttime', source)
        self.assertIn('dates, times or client brief', source)
        self.assertIn('restrictpastekind', source)
        self.assertIn('financetoggleschedulebatch', source)
        self.assertIn('financeduplicateschedulebatch', source)
        self.assertIn('financedeleteschedulebatch', source)

    def test_pdf_groups_consecutive_rehearsal_show_and_teardown_dates(self):
        quotation = self.create_quote('Consecutive Schedule')
        quotation.update({
            'setupDate': '2026-07-05',
            'additionalSetups': [{'id': 'setup-2', 'date': '2026-07-06', 'time': ''}],
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
        self.assertEqual(saved['additionalSetups'][0]['date'], '2026-07-06')
        self.assertEqual(saved['additionalRehearsals'][0]['date'], '2026-07-08')

        pdf = self.client.get(f"/api/quotations/{quotation['id']}/pdf").data
        text = '\n'.join(page.extract_text() or '' for page in PdfReader(io.BytesIO(pdf)).pages)

        setup_position = text.index('Set-up:')
        rehearsal_position = text.index('Rehearsal:')
        show_position = text.index('Show:')
        teardown_position = text.index('Teardown:')
        self.assertLess(setup_position, rehearsal_position)
        self.assertLess(rehearsal_position, show_position)
        self.assertLess(show_position, teardown_position)
        self.assertIn('5 - 6 July 2026', text)
        self.assertIn('7 - 8 July 2026', text)
        self.assertIn('9 - 11 July 2026', text)
        self.assertIn('12 - 13 July 2026', text)

    def test_pdf_keeps_multiple_show_times_on_the_same_date(self):
        quotation = self.create_quote('Multiple Shows Per Day')
        quotation.update({
            'showDate': '2026-10-07',
            'showTime': '10:00',
            'additionalShows': [
                {'id': 'show-2', 'date': '2026-10-07', 'time': '14:00'},
                {'id': 'show-3', 'date': '2026-10-08', 'time': '20:00'},
            ],
        })
        saved = self.client.put(
            f"/api/quotations/{quotation['id']}", json=quotation,
        ).get_json()['data']
        self.assertEqual(len(saved['additionalShows']), 2)

        pdf = self.client.get(f"/api/quotations/{quotation['id']}/pdf").data
        text = '\n'.join(page.extract_text() or '' for page in PdfReader(io.BytesIO(pdf)).pages)
        compact_text = ' '.join(text.split())

        self.assertNotIn('BILL TO', text)
        self.assertNotIn('No client selected', text)
        self.assertNotIn('Reference', text)
        self.assertIn('7 October 2026, 10:00hrs', compact_text)
        self.assertIn('7 October 2026, 14:00hrs', compact_text)
        self.assertIn('8 October 2026, 20:00hrs', compact_text)
        self.assertIn(
            '7 October 2026, 10:00hrs; 7 October 2026, 14:00hrs; 8 October 2026, 20:00hrs',
            compact_text,
        )

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

    def test_category_discount_survives_other_edits_with_legacy_category_suffix(self):
        quotation = self.create_quote('Persistent Category Discount')
        quotation['lineItems'] = [{
            'id': 'audio', 'catalogKey': '', 'description': 'Audio package',
            'department': 'Audio Department', 'departmentCode': 'AX',
            'systemName': 'Audio Department',
            'days': 1, 'quantity': 1, 'uom': 'lot', 'unitPrice': 1000,
            'discountPercent': 0, 'isCustom': True,
        }]
        quotation['adjustments'] = [{
            'id': 'persistent-category-discount', 'scope': 'department',
            'department': 'Audio Department', 'label': 'Discount',
            'amount': -100, 'percent': 10, 'kind': 'discount',
            'calculationMode': 'percent', 'subprojectId': 'main',
        }]
        saved = self.client.put(
            f"/api/quotations/{quotation['id']}", json=quotation,
        ).get_json()['data']
        self.assertEqual(len(saved['adjustments']), 1)
        self.assertEqual(
            saved['adjustments'][0]['department'], 'Audio Department',
        )

        saved['lineItems'][0]['description'] = 'Updated audio package'
        edited = self.client.put(
            f"/api/quotations/{quotation['id']}", json=saved,
        ).get_json()['data']
        self.assertEqual(len(edited['adjustments']), 1)
        self.assertEqual(edited['adjustments'][0]['percent'], 10)
        self.assertEqual(edited['adjustments'][0]['amount'], -100)
        self.assertEqual(
            edited['adjustments'][0]['department'], 'Audio Department',
        )

        source = Path('static/js/finance.js').read_text(encoding='utf-8')
        sync_source = source.split(
            'function financeSyncDocumentDepartments', 1,
        )[1].split('function financeLineGroupMembers', 1)[0]
        self.assertIn('financeNormalisedDepartmentName(category)', sync_source)
        self.assertIn('if (match) row.department = match;', sync_source)

    def test_category_discount_defaults_to_discount_and_pdf_shows_percentage(self):
        quotation = self.create_quote('Default Discount Label')
        quotation.update({
            'showUnitPrices': True,
            'showDepartmentDiscounts': True,
            'showDepartmentSubtotals': True,
            'lineItems': [{
                'id': 'discounted-package',
                'catalogKey': '',
                'description': 'Audio package',
                'department': 'Audio Department',
                'departmentCode': 'AX',
                'days': 1,
                'quantity': 1,
                'uom': 'lot',
                'unitPrice': 1000,
                'discountPercent': 12.3456,
                'isCustom': True,
            }],
            'adjustments': [{
                'id': 'default-category-discount',
                'scope': 'department',
                'department': 'Audio Department',
                'label': 'System discount',
                'amount': -125,
                'percent': 12.5,
                'kind': 'discount',
                'calculationMode': 'percent',
            }],
        })
        saved = self.client.put(
            f"/api/quotations/{quotation['id']}", json=quotation,
        ).get_json()['data']
        self.assertEqual(saved['adjustments'][0]['label'], 'Discount')

        pdf = self.client.get(f"/api/quotations/{quotation['id']}/pdf")
        text = '\n'.join(
            page.extract_text() or ''
            for page in PdfReader(io.BytesIO(pdf.data)).pages
        )
        self.assertIn('12.35%', text)
        self.assertIn('Discount (12.50%)', text)
        self.assertNotIn('System discount', text)

        source = Path('static/js/finance.js').read_text(encoding='utf-8')
        self.assertNotIn("label: 'System discount'", source)
        self.assertIn("label: 'Discount'", source)

        pdf_source = Path('quotation_pdf.py').read_text(encoding='utf-8')
        discount_block = pdf_source[
            pdf_source.index('show_department_adjustment_block = bool('):
            pdf_source.index(
                'items_table = FinanceDepartmentTable(',
                pdf_source.index('show_department_adjustment_block = bool('),
            )
        ]
        adjustment_line = discount_block.index(
            "('LINEABOVE', (0, adjustment_index), (-1, adjustment_index), 0.8, ink)"
        )
        subtotal_row = discount_block.index("_paragraph(f\"{department} subtotal\"")
        conditional_subtotal_line = discount_block.index(
            'if not show_department_adjustment_block:'
        )
        self.assertLess(adjustment_line, subtotal_row)
        self.assertGreater(conditional_subtotal_line, subtotal_row)
        self.assertIn(
            "('BACKGROUND', (0, adjustment_index), (-1, adjustment_index), panel)",
            discount_block,
        )
        self.assertIn(
            '_paragraph(_adjustment_label(adjustment), right)',
            discount_block,
        )

    def test_profit_loss_supports_multiple_commission_rows(self):
        self.login('sales-admin')
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
        self.assertEqual(
            app_module._finance_profit_loss_category_label('Parking', 'worker-claim'),
            'Equipment Transport',
        )

    def test_profit_loss_separates_vendor_services_and_bases_commission_on_profit(self):
        self.login('sales-admin')
        event = Event(
            event_id=139, name='Vendor Service Event', location='Studio',
            start_date='20260823', end_date='20260823', asset_models=[],
            prepared_items=[], returned_items=[], actually_prepared=[],
            extra_assets=[], assigned_users=['sales-admin'],
        )
        self.data_manager.events[139] = event
        quotation = self.create_quote('Vendor Service Event')
        quotation['eventId'] = 139
        quotation['lineItems'] = [{
            'id': 'package', 'catalogKey': '', 'description': 'Package',
            'department': 'Audio Department', 'departmentCode': 'AX',
            'days': 1, 'quantity': 1, 'uom': 'lot', 'unitPrice': 1000,
            'discountPercent': 0, 'isCustom': True,
        }]
        saved = self.client.put(f"/api/quotations/{quotation['id']}", json=quotation)
        self.assertEqual(saved.status_code, 200, saved.get_data(as_text=True))

        workforce = app_module.load_workforce(app_module._workforce_folder())
        workforce['freelancers'] = [{
            'id': 'worker-profit', 'name': 'Audio Crew', 'active': True,
        }]
        workforce['vendors'] = [
            {
                'id': 'vendor-profit', 'name': 'External Audio', 'active': True,
            },
            {
                'id': 'manpower-vendor-profit', 'name': 'Lighting Crew Vendor',
                'active': True,
            },
        ]
        workforce['assignments'] = {'139': [
            {
                'id': 'worker-row', 'freelancerId': 'worker-profit',
                'department': 'AX', 'dailyRate': 100, 'days': 1,
            },
            {
                'id': 'service-row', 'vendorId': 'vendor-profit',
                'subjectType': 'vendor', 'providerType': 'service',
                'department': 'AX', 'serviceName': 'Audio system service',
                'serviceCost': 250, 'days': 1,
            },
            {
                'id': 'vendor-manpower-row', 'vendorId': 'vendor-profit',
                'subjectType': 'vendor', 'providerType': 'manpower',
                'department': 'LX', 'roleName': 'Lighting crew',
                'pax': 1, 'ratePerPax': 50, 'days': 1,
            },
            {
                'id': 'manpower-vendor-row',
                'vendorId': 'manpower-vendor-profit',
                'subjectType': 'vendor', 'providerType': 'manpower',
                'department': 'LX', 'roleName': 'Lighting operators',
                'pax': 1, 'ratePerPax': 60, 'days': 1,
            },
        ]}
        workforce['submissions'] = {'139': {
            'worker-profit': {'invoices': [{
                'id': 'worker-invoice-profit', 'amount': 110,
                'status': 'Approved',
            }], 'claims': []},
            'vendor-profit': {'invoices': [{
                'id': 'vendor-invoice-profit', 'amount': 275,
                'status': 'Approved',
                'allocations': [{'department': 'AX', 'amount': 275}],
            }], 'claims': []},
            'manpower-vendor-profit': {'invoices': [{
                'id': 'manpower-vendor-invoice-profit', 'amount': 60,
                'status': 'Approved',
                'allocations': [{'department': 'LX', 'amount': 60}],
            }], 'claims': []},
        }}
        save_workforce(app_module._workforce_folder(), workforce)

        response = self.client.put('/api/finance/profit-loss/139/commissions', json={
            'commissions': [{
                'recipient': 'Sales', 'calculationMode': 'percent', 'percent': 10,
            }],
        })

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        payload = response.get_json()['data']
        summary = payload['summary']
        self.assertEqual(summary['manpowerCost'], 170)
        self.assertEqual(summary['manpowerCardCost'], 170)
        self.assertEqual(summary['vendorServiceCost'], 275)
        self.assertEqual(summary['directCosts'], 170)
        self.assertEqual(summary['otherExpenses'], 275)
        self.assertEqual(
            [(row['label'], row['amount']) for row in payload['otherExpenseCategories']],
            [('Service', 275)],
        )
        self.assertEqual(summary['beforeCommission'], 555)
        self.assertEqual(summary['commissionBase'], 555)
        self.assertEqual(summary['commission'], 55.5)
        self.assertEqual(summary['netProfit'], 499.5)
        self.assertEqual(payload['vendorServiceDepartments'], [{
            'department': 'AX', 'label': 'Service - Audio', 'amount': 275.0,
        }])
        departmental_chart_rows = [
            row for row in payload['profitChart']
            if row.get('group') == 'manpower' and row.get('department') == 'AX'
        ]
        self.assertEqual(len(departmental_chart_rows), 1)
        self.assertEqual(departmental_chart_rows[0]['amount'], 110)
        self.assertTrue(
            departmental_chart_rows[0]['label'].startswith('Manpower - ')
        )
        self.assertIn(
            {'group': 'vendor', 'label': 'Service - Audio', 'amount': 275},
            [
                {
                    'group': row.get('group'),
                    'label': row.get('label'),
                    'amount': row.get('amount'),
                }
                for row in payload['profitChart']
            ],
        )
        vendor_invoice = next(
            row for row in payload['expenses']
            if row.get('sourceId') == 'vendor-invoice-profit'
        )
        self.assertEqual(vendor_invoice['categoryKey'], 'vendor-service')
        self.assertEqual(vendor_invoice['category'], 'Vendor service')
        self.assertEqual(vendor_invoice['categoryLabel'], 'Crew & Vendors')
        manpower_vendor_invoice = next(
            row for row in payload['expenses']
            if row.get('sourceId') == 'manpower-vendor-invoice-profit'
        )
        self.assertEqual(manpower_vendor_invoice['categoryKey'], 'manpower')
        self.assertEqual(manpower_vendor_invoice['category'], 'Manpower')
        finance_source = Path('static/js/finance.js').read_text(encoding='utf-8')
        self.assertIn("category = 'Service';", finance_source)

    def test_profit_loss_estimates_each_uninvoiced_vendor_manpower_assignment(self):
        self.login('sales-admin')
        self.data_manager.events[145] = Event(
            event_id=145, name='Uninvoiced Vendor Manpower', location='Studio',
            start_date='20260825', end_date='20260825', asset_models=[],
            prepared_items=[], returned_items=[], actually_prepared=[],
            extra_assets=[], assigned_users=['sales-admin'],
        )
        workforce = app_module.load_workforce(app_module._workforce_folder())
        workforce['freelancers'] = [{
            'id': 'invoiced-worker', 'name': 'Invoiced Worker', 'active': True,
        }]
        workforce['vendors'] = [
            {'id': 'mixed-vendor', 'name': 'Mixed Vendor', 'active': True},
            {'id': 'manpower-vendor', 'name': 'Manpower Vendor', 'active': True},
        ]
        workforce['assignments'] = {'145': [
            {
                'id': 'worker-assignment', 'freelancerId': 'invoiced-worker',
                'department': 'AX', 'dailyRate': 100, 'days': 1,
            },
            {
                'id': 'mixed-service', 'vendorId': 'mixed-vendor',
                'subjectType': 'vendor', 'providerType': 'service',
                'department': 'AX', 'serviceCost': 250, 'days': 1,
            },
            {
                'id': 'mixed-manpower', 'vendorId': 'mixed-vendor',
                'subjectType': 'vendor', 'providerType': 'manpower',
                'department': 'LX', 'pax': 2, 'ratePerPax': 75, 'days': 2,
            },
            {
                'id': 'vendor-manpower', 'vendorId': 'manpower-vendor',
                'subjectType': 'vendor', 'providerType': 'manpower',
                'department': 'VX', 'pax': 3, 'ratePerPax': 40, 'days': 1,
            },
        ]}
        workforce['submissions'] = {'145': {
            'invoiced-worker': {
                'invoices': [{
                    'id': 'worker-invoice', 'amount': 110, 'status': 'Approved',
                }],
                'claims': [],
            },
            'mixed-vendor': {'invoices': [], 'claims': []},
            'manpower-vendor': {'invoices': [], 'claims': []},
        }}
        save_workforce(app_module._workforce_folder(), workforce)

        response = self.client.get('/api/finance/profit-loss/145')

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        payload = response.get_json()['data']
        summary = payload['summary']
        self.assertEqual(summary['manpowerCost'], 530)
        self.assertEqual(summary['manpowerInvoiceCost'], 110)
        self.assertEqual(summary['manpowerEstimatedCost'], 520)
        self.assertEqual(summary['manpowerFallbackEstimatedCost'], 420)
        self.assertEqual(summary['vendorServiceCost'], 250)
        self.assertEqual(summary['vendorServiceInvoiceCost'], 0)
        self.assertEqual(summary['vendorServiceEstimatedCost'], 250)
        self.assertEqual(summary['vendorServiceFallbackEstimatedCost'], 250)
        self.assertEqual(
            {row['department']: row['amount'] for row in payload['manpowerDepartments']},
            {'AX': 110.0, 'LX': 300.0, 'VX': 120.0},
        )
        self.assertEqual(sum(
            row['amount'] for row in payload['profitChart']
            if row.get('group') == 'manpower'
        ), 530)
        self.assertIn(
            {'group': 'vendor', 'department': 'AX', 'amount': 250},
            [
                {
                    'group': row.get('group'),
                    'department': row.get('department'),
                    'amount': row.get('amount'),
                }
                for row in payload['profitChart']
            ],
        )

    def test_profit_loss_expenses_sort_by_source_department_and_name(self):
        rows = [
            {
                'id': 'invoice-z', 'source': 'worker-invoice',
                'department': 'LX', 'vendor': 'Zulu Vendor',
            },
            {
                'id': 'claim-z', 'source': 'worker-claim',
                'department': 'LX', 'vendor': 'Zulu Worker',
            },
            {
                'id': 'added-z', 'source': 'manual',
                'department': 'LX', 'vendor': 'Zulu Supplier',
            },
            {
                'id': 'claim-audio-z', 'source': 'worker-claim',
                'department': 'AX', 'vendor': 'Zulu Worker',
            },
            {
                'id': 'claim-audio-a', 'source': 'worker-claim',
                'department': 'AX', 'vendor': 'Alpha Worker',
            },
            {
                'id': 'added-a', 'source': 'manual',
                'department': 'AX', 'vendor': 'Alpha Supplier',
            },
            {
                'id': 'invoice-a', 'source': 'worker-invoice',
                'department': 'AX', 'vendor': 'Alpha Vendor',
            },
        ]

        rows.sort(key=app_module._finance_profit_loss_expense_sort_key)

        self.assertEqual(
            [row['id'] for row in rows],
            [
                'added-a', 'added-z',
                'claim-audio-a', 'claim-audio-z', 'claim-z',
                'invoice-a', 'invoice-z',
            ],
        )
        finance_source = Path('static/js/finance.js').read_text(encoding='utf-8')
        self.assertIn(
            '.slice().sort(profitLossCompareExpenses)',
            finance_source,
        )

    def test_profit_loss_groups_worker_claims_under_crew_and_vendors(self):
        self.login('sales-admin')
        event = Event(
            event_id=136, name='Budgeted Event', location='Studio',
            start_date='20260818', end_date='20260818', asset_models=[],
            prepared_items=[], returned_items=[], actually_prepared=[],
            extra_assets=[], assigned_users=['alice'],
        )
        self.data_manager.events[136] = event
        quotation = self.create_quote('Budgeted Event')
        quotation['eventId'] = 136
        quotation['lineItems'] = [
            {
                'id': 'manpower', 'catalogKey': '', 'description': 'Crew',
                'department': 'Manpower', 'departmentCode': 'MANPOWER',
                'days': 1, 'quantity': 1, 'uom': 'pax', 'unitPrice': 1000,
                'discountPercent': 0, 'isCustom': True,
            },
            {
                'id': 'general-manpower', 'catalogKey': '',
                'description': 'Standby and teardown crew',
                'department': 'General', 'departmentCode': 'GENERAL',
                'systemName': 'Manpower',
                'days': 1, 'quantity': 1, 'uom': 'pax', 'unitPrice': 5000,
                'discountPercent': 0, 'isCustom': True,
            },
            {
                'id': 'transport', 'catalogKey': '', 'description': 'Lorry',
                'department': 'Transportation', 'departmentCode': 'TRANSPORT',
                'days': 1, 'quantity': 1, 'uom': 'trip', 'unitPrice': 500,
                'discountPercent': 0, 'isCustom': True,
            },
            {
                'id': 'equipment', 'catalogKey': '', 'description': 'Equipment',
                'department': 'Audio System', 'departmentCode': 'AX',
                'days': 1, 'quantity': 1, 'uom': 'lot', 'unitPrice': 200,
                'discountPercent': 0, 'isCustom': True,
            },
        ]
        quotation['adjustments'] = [
            {
                'id': 'manpower-discount',
                'scope': 'department',
                'department': 'Manpower',
                'label': 'Crew package discount',
                'amount': -100,
                'percent': 10,
                'kind': 'discount',
                'calculationMode': 'percent',
                'subprojectId': 'main',
            },
            {
                'id': 'overall-discount',
                'scope': 'total',
                'label': 'Overall discount',
                'amount': -160,
                'percent': 10,
                'kind': 'discount',
                'calculationMode': 'percent',
            },
        ]
        quotation['status'] = 'accepted'
        saved_quote = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json=quotation,
        )
        self.assertEqual(saved_quote.status_code, 200, saved_quote.get_data(as_text=True))
        accepted_quote = saved_quote.get_json()['data']

        newer_draft = self.create_quote('Newer unaccepted budget')
        newer_draft['eventId'] = 136
        newer_draft['lineItems'] = [{
            'id': 'draft-manpower', 'catalogKey': '',
            'description': 'Draft crew allowance',
            'department': 'Manpower', 'departmentCode': 'MANPOWER',
            'systemName': 'Manpower',
            'days': 1, 'quantity': 1, 'uom': 'pax', 'unitPrice': 9999,
            'discountPercent': 0, 'isCustom': True,
        }]
        draft_response = self.client.put(
            f"/api/quotations/{newer_draft['id']}",
            json=newer_draft,
        )
        self.assertEqual(
            draft_response.status_code,
            200,
            draft_response.get_data(as_text=True),
        )

        workforce = app_module.load_workforce(app_module._workforce_folder())
        workforce['freelancers'] = [{
            'id': 'worker-1',
            'name': 'Wesley Tan',
            'active': True,
        }]
        workforce['assignments'] = {
            '136': [{
                'freelancerId': 'worker-1',
                'department': 'AX',
                'dailyRate': 600,
                'days': 1,
            }],
        }
        workforce['submissions'] = {
            '136': {
                'worker-1': {
                    'invoices': [{
                        'id': 'invoice-1',
                        'amount': 700,
                        'status': 'Approved',
                        'submittedAt': '2026-08-18T12:00:00',
                    }],
                    'claims': [
                        {
                            'id': 'claim-cab',
                            'amount': 50,
                            'category': 'Cab transport',
                            'status': 'Approved',
                            'detailsComplete': True,
                        },
                        {
                            'id': 'claim-meal',
                            'amount': 30,
                            'category': 'Meal',
                            'status': 'Approved',
                            'detailsComplete': True,
                        },
                        {
                            'id': 'claim-purchase',
                            'amount': 20,
                            'category': 'Consumables',
                            'status': 'Approved',
                            'detailsComplete': True,
                        },
                    ],
                },
            },
        }
        workforce['transportBookings'] = {
            '136': [{
                'id': 'trip-1',
                'sourceType': 'fleet',
                'cost': 100,
                'status': 'Approved',
                'claims': [{
                    'id': 'fleet-parking',
                    'amount': 15,
                    'claimDate': '2026-08-18',
                    'category': 'Parking',
                    'description': 'Own fleet parking',
                    'detailsComplete': True,
                    'status': 'Approved',
                }],
            }],
        }
        save_workforce(app_module._workforce_folder(), workforce)

        for expense in (
            {'description': 'Crew dinner', 'category': 'Meal', 'amount': 40},
            {'description': 'Crew shuttle', 'category': 'Crew Transport', 'amount': 70},
            {'description': 'Equipment lorry', 'category': 'Equipment Transport', 'amount': 60},
            {'description': 'Tape', 'category': 'Consumables', 'amount': 25},
        ):
            response = self.client.post(
                '/api/finance/profit-loss/136/expenses',
                json=expense,
            )
            self.assertEqual(response.status_code, 201, response.get_data(as_text=True))

        payload = self.client.get('/api/finance/profit-loss/136').get_json()['data']
        summary = payload['summary']
        self.assertEqual(payload['quotation']['id'], accepted_quote['id'])
        self.assertEqual(summary['manpowerCost'], 850)
        self.assertEqual(summary['manpowerCardCost'], 850)
        self.assertEqual(summary['crewVendorInvoiceCost'], 850)
        self.assertEqual(summary['mealCost'], 30)
        self.assertEqual(summary['crewTransportClaimsCost'], 50)
        self.assertEqual(summary['transportBookingCost'], 100)
        self.assertEqual(summary['transportCost'], 175)
        self.assertEqual(summary['manualCrewTransportExpenses'], 70)
        self.assertEqual(summary['manualEquipmentTransportExpenses'], 60)
        self.assertEqual(summary['ownFleetEquipmentClaimsCost'], 15)
        self.assertEqual(summary['manualExpensesTotal'], 195)
        self.assertEqual(summary['otherExpenses'], 85)
        self.assertEqual(summary['manpowerBudget'], 4860)
        self.assertEqual(summary['manpowerBudgetVariance'], 4010)
        self.assertEqual(summary['transportBudget'], 450)
        self.assertEqual(summary['transportBudgetVariance'], 275)

        descriptions = {row['description'] for row in payload['expenses']}
        self.assertIn('Wesley Tan - Invoice', descriptions)
        self.assertIn('Wesley Tan - Meal claim', descriptions)
        self.assertIn('Wesley Tan - Transport claim', descriptions)
        department_costs = {
            row['department']: row['amount']
            for row in payload['manpowerDepartments']
        }
        self.assertEqual(department_costs['AX'], 700)
        self.assertNotIn('Unallocated', department_costs)
        self.assertTrue(any(
            row.get('department') == 'AX'
            and row.get('group') == 'manpower'
            and row.get('amount') == 700
            for row in payload['profitChart']
        ))
        self.assertIn(
            {'group': 'transport', 'amount': 150},
            [
                {'group': row['group'], 'amount': row['amount']}
                for row in payload['profitChart']
            ],
        )
        self.assertIn(
            {'group': 'meal', 'amount': 70},
            [
                {'group': row['group'], 'amount': row['amount']}
                for row in payload['profitChart']
            ],
        )
        self.assertIn(
            {'group': 'crew-transport', 'label': 'Crew Transport', 'amount': 70},
            [
                {
                    'group': row['group'],
                    'label': row['label'],
                    'amount': row['amount'],
                }
                for row in payload['profitChart']
            ],
        )
        self.assertIn(
            {'group': 'equipment-transport', 'label': 'Equipment Transport', 'amount': 75},
            [
                {'group': row['group'], 'label': row['label'], 'amount': row['amount']}
                for row in payload['profitChart']
            ],
        )
        self.assertEqual(
            [row['amount'] for row in payload['profitChart'] if row['label'] == 'Consumables'],
            [45],
        )
        self.assertEqual(
            [(row['label'], row['amount']) for row in payload['otherExpenseCategories']],
            [('Consumables', 45), ('Meal', 40)],
        )

    def test_profit_loss_combines_added_expenses_and_claims_by_category(self):
        self.login('sales-admin')
        self.data_manager.events[146] = Event(
            event_id=146, name='Shared Expense Categories', location='Studio',
            start_date='20260826', end_date='20260826', asset_models=[],
            prepared_items=[], returned_items=[], actually_prepared=[],
            extra_assets=[], assigned_users=['sales-admin'],
        )
        workforce = app_module.load_workforce(app_module._workforce_folder())
        workforce['freelancers'] = [{
            'id': 'worker-category', 'name': 'Category Worker', 'active': True,
        }]
        workforce['submissions'] = {'146': {'worker-category': {
            'invoices': [],
            'claims': [
                {
                    'id': f'claim-{index}', 'category': category, 'amount': amount,
                    'status': 'Approved', 'detailsComplete': True,
                }
                for index, (category, amount) in enumerate((
                    ('Crew Transport', 30), ('Purchase', 12), ('Meal', 7),
                    ('Equipment Transport', 9), ('Other', 5),
                ))
            ],
        }}}
        save_workforce(app_module._workforce_folder(), workforce)
        for category, amount in (
            ('Crew Transport', 40), ('purchase', 18), ('Meal', 13),
            ('Equipment Transport', 11), ('Other', 6),
        ):
            response = self.client.post('/api/finance/profit-loss/146/expenses', json={
                'description': f'Added {category}', 'category': category, 'amount': amount,
            })
            self.assertEqual(response.status_code, 201, response.get_data(as_text=True))

        payload = self.client.get('/api/finance/profit-loss/146').get_json()['data']
        category_rows = [
            row for row in payload['profitChart']
            if row['group'] not in {'profit', 'commission'}
        ]
        chart = {row['label']: row for row in category_rows}
        self.assertEqual(len(category_rows), 5)
        self.assertEqual(len(chart), 5)
        self.assertEqual(
            {label: (chart[label]['group'], chart[label]['amount']) for label in chart},
            {
                'Crew Transport': ('crew-transport', 70),
                'Purchase': ('other', 30),
                'Meals': ('meal', 20),
                'Equipment Transport': ('equipment-transport', 20),
                'Other': ('other', 11),
            },
        )
        self.assertFalse(any('Added Expense' in row['label'] for row in chart.values()))
        self.assertEqual(
            sum(row['amount'] for row in chart.values()),
            payload['summary']['directCosts'] + payload['summary']['otherExpenses'],
        )
        self.assertEqual(
            [(row['label'], row['amount']) for row in payload['expenseCategories']],
            [('Purchase', 30), ('Other', 11)],
        )
        self.assertEqual(payload['summary']['manpowerCost'], 77)
        self.assertEqual(payload['summary']['transportCost'], 11)
        self.assertEqual(payload['summary']['otherExpenses'], 63)
        self.assertEqual(payload['summary']['netProfit'], -151)
        self.assertEqual(
            [(row['label'], row['amount']) for row in payload['otherExpenseCategories']],
            [('Purchase', 30), ('Meal', 13), ('Other', 11), ('Equipment Transport', 9)],
        )

    def test_profit_loss_invoice_expenses_include_department_allocation_amounts(self):
        self.login('sales-admin')
        self.data_manager.events[147] = Event(
            event_id=147, name='Split Department Invoice', location='Studio',
            start_date='20260827', end_date='20260827', asset_models=[],
            prepared_items=[], returned_items=[], actually_prepared=[],
            extra_assets=[], assigned_users=['sales-admin'],
        )
        workforce = app_module.load_workforce(app_module._workforce_folder())
        workforce['freelancers'] = [{
            'id': 'split-worker', 'name': 'Split Worker', 'active': True,
        }]
        workforce['assignments'] = {'147': [
            {
                'id': 'split-audio', 'freelancerId': 'split-worker',
                'department': 'AX', 'dailyRate': 300, 'days': 1,
            },
            {
                'id': 'split-lighting', 'freelancerId': 'split-worker',
                'department': 'LX', 'dailyRate': 100, 'days': 1,
            },
        ]}
        workforce['submissions'] = {'147': {'split-worker': {
            'invoices': [{
                'id': 'split-invoice', 'amount': 400, 'status': 'Approved',
                'allocations': [
                    {'department': 'AX', 'amount': 300},
                    {'department': 'LX', 'amount': 100},
                ],
            }],
            'claims': [],
        }}}
        save_workforce(app_module._workforce_folder(), workforce)

        response = self.client.get('/api/finance/profit-loss/147')

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        payload = response.get_json()['data']
        invoice = next(
            row for row in payload['expenses']
            if row.get('sourceId') == 'split-invoice'
        )
        self.assertEqual(invoice['department'], 'AX, LX')
        self.assertEqual(invoice['departmentAllocations'], [
            {'department': 'AX', 'amount': 300.0},
            {'department': 'LX', 'amount': 100.0},
        ])
        self.assertEqual(
            {row['department']: row['amount'] for row in payload['manpowerDepartments']},
            {'AX': 300.0, 'LX': 100.0},
        )

    def test_profit_loss_resolves_full_time_app_user_names(self):
        self.login('sales-admin')
        event = Event(
            event_id=140, name='Full Time Crew Event', location='Studio',
            start_date='20260823', end_date='20260823', asset_models=[],
            prepared_items=[], returned_items=[], actually_prepared=[],
            extra_assets=[], assigned_users=['sales-admin'],
        )
        self.data_manager.events[140] = event
        workforce = app_module.load_workforce(app_module._workforce_folder())
        workforce['assignments'] = {'140': [{
            'id': 'staff-row', 'subjectType': 'app-user',
            'userUsername': 'alice', 'department': 'AX',
            'dailyRate': 100, 'days': 1,
        }]}
        workforce['submissions'] = {'140': {'user:alice': {
            'invoices': [{
                'id': 'staff-invoice', 'amount': 100, 'status': 'Approved',
            }],
            'claims': [],
        }}}
        save_workforce(app_module._workforce_folder(), workforce)

        response = self.client.get('/api/finance/profit-loss/140')

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        payload = response.get_json()['data']
        invoice = next(row for row in payload['expenses'] if row['sourceId'] == 'staff-invoice')
        self.assertEqual(invoice['vendor'], 'Alice Lim')
        self.assertEqual(invoice['description'], 'Alice Lim - Invoice')
        self.assertEqual(invoice['department'], 'AX')

    def test_profit_loss_marks_pending_claims_for_review_without_counting_incomplete_claims(self):
        self.login('sales-admin')
        event = Event(
            event_id=141, name='Pending Claims Event', location='Studio',
            start_date='20260823', end_date='20260823', asset_models=[],
            prepared_items=[], returned_items=[], actually_prepared=[],
            extra_assets=[], assigned_users=['sales-admin'],
        )
        self.data_manager.events[141] = event
        workforce = app_module.load_workforce(app_module._workforce_folder())
        workforce['freelancers'] = [{
            'id': 'worker-pending', 'name': 'Pending Worker', 'active': True,
        }]
        workforce['assignments'] = {'141': [{
            'id': 'pending-row', 'freelancerId': 'worker-pending',
            'department': 'AX', 'dailyRate': 100, 'days': 1,
        }]}
        workforce['submissions'] = {'141': {'worker-pending': {
            'invoices': [],
            'claims': [{
                'id': 'claim-pending-review', 'amount': 24,
                'status': 'Pending Review', 'category': 'Meal',
                'detailsComplete': False, 'submissionStage': 'Details Required',
                'processingState': 'Complete',
            }],
        }}}
        save_workforce(app_module._workforce_folder(), workforce)

        added = self.client.post('/api/finance/profit-loss/141/expenses', json={
            'description': 'Purchased tape', 'category': 'Purchase', 'amount': 12,
        })
        self.assertEqual(added.status_code, 201, added.get_data(as_text=True))
        self.assertEqual(added.get_json()['expense']['sourceLabel'], 'Added')

        payload = self.client.get('/api/finance/profit-loss/141').get_json()['data']
        claim = next(row for row in payload['expenses'] if row.get('sourceId') == 'claim-pending-review')
        self.assertEqual(claim['sourceLabel'], 'Claim')
        self.assertTrue(claim['needsReview'])
        self.assertFalse(claim['countsTowardCosts'])
        self.assertEqual(payload['summary']['mealCost'], 0)
        self.assertEqual(payload['summary']['otherExpenses'], 12)

        for state in ('Failed', 'Manual Required'):
            with self.subTest(processing_state=state):
                rows = workforce['submissions']['141']['worker-pending']
                rows['invoices'] = [{
                    'id': 'invoice-manual', 'amount': 900, 'status': 'Pending Review',
                    'processingState': state,
                }]
                rows['claims'].append({
                    'id': 'claim-manual', 'amount': 80, 'category': 'Meal',
                    'status': 'Pending Review', 'processingState': state,
                    'detailsComplete': False, 'submissionStage': 'Details Required',
                })
                save_workforce(app_module._workforce_folder(), workforce)
                payload = self.client.get('/api/finance/profit-loss/141').get_json()['data']
                ids = {row.get('sourceId') for row in payload['expenses']}
                self.assertNotIn('invoice-manual', ids)
                self.assertNotIn('claim-manual', ids)
                self.assertEqual(payload['summary']['manpowerInvoiceCost'], 0)
                self.assertEqual(payload['summary']['mealCost'], 0)

                rows['invoices'][0]['verifiedAt'] = '2026-09-06T12:00:00'
                rows['claims'][-1].update({
                    'detailsCompletedAt': '2026-09-06T12:00:00',
                    'detailsComplete': True, 'submissionStage': 'Submitted',
                })
                save_workforce(app_module._workforce_folder(), workforce)
                payload = self.client.get('/api/finance/profit-loss/141').get_json()['data']
                ids = {row.get('sourceId') for row in payload['expenses']}
                self.assertIn('invoice-manual', ids)
                self.assertIn('claim-manual', ids)
                self.assertEqual(payload['summary']['manpowerInvoiceCost'], 900)
                self.assertEqual(payload['summary']['mealCost'], 80)
                rows['claims'].pop()

    def test_profit_loss_pdf_exports_project_summary_and_expense_details(self):
        self.login('sales-admin')
        event = Event(
            event_id=138, name='P&L Export Event', location='Grand Ballroom',
            start_date='20260821', end_date='20260822', asset_models=[],
            prepared_items=[], returned_items=[], actually_prepared=[],
            extra_assets=[], assigned_users=['sales-admin'],
        )
        self.data_manager.events[138] = event
        quotation = self.create_quote('P&L Export Event')
        quotation['eventId'] = 138
        quotation['client'] = {
            'name': 'Jordan Lee',
            'company': 'Example Client Pte Ltd',
        }
        quotation['lineItems'] = [{
            'id': 'package', 'catalogKey': '', 'description': 'Event package',
            'department': 'Audio System', 'departmentCode': 'AX',
            'days': 1, 'quantity': 1, 'uom': 'lot', 'unitPrice': 2000,
            'discountPercent': 0, 'isCustom': True,
        }]
        saved_quote = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json=quotation,
        )
        self.assertEqual(saved_quote.status_code, 200, saved_quote.get_data(as_text=True))
        quotation_number = saved_quote.get_json()['data']['number']

        workforce = app_module.load_workforce(app_module._workforce_folder())
        workforce['freelancers'] = [{
            'id': 'worker-pdf',
            'name': 'Wesley Tan',
            'active': True,
        }]
        workforce['assignments'] = {
            '138': [{
                'freelancerId': 'worker-pdf',
                'department': 'AX',
                'dailyRate': 400,
                'days': 1,
            }],
        }
        workforce['submissions'] = {
            '138': {
                'worker-pdf': {
                    'invoices': [{
                        'id': 'invoice-pdf',
                        'amount': 425,
                        'status': 'Approved',
                        'submittedAt': '2026-08-22T12:00:00',
                    }],
                    'claims': [],
                },
            },
        }
        save_workforce(app_module._workforce_folder(), workforce)
        expense = self.client.post(
            '/api/finance/profit-loss/138/expenses',
            json={
                'description': 'Additional consumables',
                'category': 'Consumables',
                'vendor': 'Supply House',
                'amount': 75.50,
                'expenseDate': '2026-08-21',
            },
        )
        self.assertEqual(expense.status_code, 201, expense.get_data(as_text=True))
        commission = self.client.put(
            '/api/finance/profit-loss/138/commissions',
            json={'commissions': [{
                'recipient': 'Sales Team',
                'calculationMode': 'percent',
                'percent': 5,
            }]},
        )
        self.assertEqual(commission.status_code, 200, commission.get_data(as_text=True))

        response = self.client.get('/api/finance/profit-loss/138/pdf')

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.mimetype, 'application/pdf')
        self.assertIn('Profit-Loss-Event-138', response.headers['Content-Disposition'])
        self.assertIn('no-store', response.headers['Cache-Control'])
        reader = PdfReader(io.BytesIO(response.data))
        self.assertTrue(all(
            float(page.mediabox.width) < float(page.mediabox.height)
            for page in reader.pages
        ))
        report_text = '\n'.join(page.extract_text() or '' for page in reader.pages)
        for expected in (
            'PROJECT PROFIT AND LOSS',
            'P&L Export Event',
            quotation_number,
            'PROFIT CALCULATION',
            'Budget Performance',
            'Cost Sources',
            'Commission Recipients',
            'Invoices, Claims & Expenses',
            'Wesley Tan - Invoice',
            'Additional consumables',
            'Supply House',
            'Page 1 of',
        ):
            self.assertIn(expected, report_text)
        self.assertNotIn('Recent Event Activity', report_text)

    def test_profit_loss_requires_sales_then_applies_financial_permissions(self):
        event = Event(
            event_id=137, name='Restricted Event', location='Studio',
            start_date='20260819', end_date='20260819', asset_models=[],
            prepared_items=[], returned_items=[], actually_prepared=[],
            extra_assets=[], assigned_users=['alice', 'no-sales'],
        )
        self.data_manager.events[137] = event
        self.login('sales-manager')
        quotation = self.create_quote('Restricted Event')
        quotation['eventId'] = 137
        response = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json=quotation,
        )
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        manager_payload = self.client.get(
            '/api/finance/profit-loss/137'
        ).get_json()['data']
        self.assertTrue(manager_payload['permissions']['canViewFinancials'])
        self.assertIn('summary', manager_payload)

        self.login('alice')
        non_owner_payload = self.client.get(
            '/api/finance/profit-loss/137'
        ).get_json()['data']
        self.assertFalse(
            non_owner_payload['permissions']['canViewFinancials']
        )
        self.assertTrue(non_owner_payload['censored'])
        self.assertNotIn('summary', non_owner_payload)

        owned_event = Event(
            event_id=139, name='Sales-owned Event', location='Studio',
            start_date='20260820', end_date='20260820', asset_models=[],
            prepared_items=[], returned_items=[], actually_prepared=[],
            extra_assets=[], assigned_users=['alice'],
        )
        self.data_manager.events[139] = owned_event
        owned_quotation = self.create_quote('Sales-owned Event')
        owned_quotation['eventId'] = 139
        response = self.client.put(
            f"/api/quotations/{owned_quotation['id']}",
            json=owned_quotation,
        )
        self.assertEqual(
            response.status_code,
            200,
            response.get_data(as_text=True),
        )
        owner_payload = self.client.get(
            '/api/finance/profit-loss/139'
        ).get_json()['data']
        self.assertTrue(owner_payload['permissions']['canViewFinancials'])
        self.assertIn('summary', owner_payload)

        self.login('manager-no-sales')
        self.assertEqual(
            self.client.get('/api/finance/profit-loss/137').status_code,
            403,
        )
        self.assertEqual(
            self.client.get('/api/finance/profit-loss/137/pdf').status_code,
            403,
        )

        self.login('no-sales')
        self.assertEqual(
            self.client.get('/api/finance/profit-loss/137').status_code,
            403,
        )
        denied = self.client.post(
            '/api/finance/profit-loss/137/expenses',
            json={'description': 'Hidden', 'category': 'Other', 'amount': 10},
        )
        self.assertEqual(denied.status_code, 403)

        self.login('sales-admin')
        admin_payload = self.client.get(
            '/api/finance/profit-loss/137'
        ).get_json()['data']
        self.assertTrue(admin_payload['permissions']['canViewFinancials'])
        self.assertIn('summary', admin_payload)

    def test_profit_loss_can_pair_quotation_or_save_event_manual_revenue(self):
        self.login('sales-admin')
        manual_event = Event(
            event_id=134, name='Manual Revenue Event', location='Studio',
            start_date='20260815', end_date='20260815', asset_models=[],
            prepared_items=[], returned_items=[], actually_prepared=[],
            extra_assets=[], assigned_users=['alice'],
        )
        quote_event = Event(
            event_id=135, name='Quotation Revenue Event', location='Ballroom',
            start_date='20260816', end_date='20260816', asset_models=[],
            prepared_items=[], returned_items=[], actually_prepared=[],
            extra_assets=[], assigned_users=['alice'],
        )
        self.data_manager.events.update({134: manual_event, 135: quote_event})

        quotation = self.create_quote('Quotation Revenue Event')
        quotation['lineItems'] = [{
            'id': 'package', 'catalogKey': '', 'description': 'Production package',
            'department': 'Audio Department', 'departmentCode': 'AX',
            'days': 1, 'quantity': 1, 'uom': 'lot', 'unitPrice': 2400,
            'discountPercent': 0, 'isCustom': True,
        }]
        quotation = self.client.put(
            f"/api/quotations/{quotation['id']}", json=quotation,
        ).get_json()['data']

        empty_payload = self.client.get(
            '/api/finance/profit-loss/134'
        ).get_json()['data']
        self.assertEqual(empty_payload['revenueSource'], 'none')
        self.assertIsNone(empty_payload['manualRevenue'])
        self.assertIn(
            quotation['id'],
            {row['id'] for row in empty_payload['availableQuotations']},
        )

        manual_response = self.client.put(
            '/api/finance/profit-loss/134/revenue',
            json={'manualAmount': '1,275.50'},
        )
        self.assertEqual(
            manual_response.status_code,
            200,
            manual_response.get_data(as_text=True),
        )
        manual_payload = manual_response.get_json()['data']
        self.assertEqual(manual_payload['revenueSource'], 'manual')
        self.assertEqual(manual_payload['manualRevenue']['amount'], 1275.50)
        self.assertEqual(manual_payload['summary']['revenue'], 1275.50)
        persisted = app_module._load_finance_data()['profitLoss']['manualRevenue']['134']
        self.assertEqual(persisted['amount'], 1275.50)

        replace_manual_response = self.client.put(
            '/api/finance/profit-loss/134/revenue',
            json={'quotationId': quotation['id']},
        )
        self.assertEqual(
            replace_manual_response.status_code,
            200,
            replace_manual_response.get_data(as_text=True),
        )
        replaced_payload = replace_manual_response.get_json()['data']
        self.assertEqual(replaced_payload['revenueSource'], 'quotation')
        self.assertIsNone(replaced_payload['manualRevenue'])
        self.assertNotIn(
            '134',
            app_module._load_finance_data()['profitLoss']['manualRevenue'],
        )

        second_quotation = self.create_quote('Second Quotation Revenue Event')
        second_quotation['lineItems'] = [{
            'id': 'second-package', 'catalogKey': '', 'description': 'Second package',
            'department': 'Audio Department', 'departmentCode': 'AX',
            'days': 1, 'quantity': 1, 'uom': 'lot', 'unitPrice': 2400,
            'discountPercent': 0, 'isCustom': True,
        }]
        second_quotation = self.client.put(
            f"/api/quotations/{second_quotation['id']}", json=second_quotation,
        ).get_json()['data']

        pair_response = self.client.put(
            '/api/finance/profit-loss/135/revenue',
            json={'quotationId': second_quotation['id']},
        )
        self.assertEqual(
            pair_response.status_code,
            200,
            pair_response.get_data(as_text=True),
        )
        paired_payload = pair_response.get_json()['data']
        self.assertEqual(paired_payload['revenueSource'], 'quotation')
        self.assertEqual(paired_payload['quotation']['id'], second_quotation['id'])
        self.assertEqual(paired_payload['summary']['revenue'], 2400)
        self.assertNotIn(
            second_quotation['id'],
            {row['id'] for row in paired_payload['availableQuotations']},
        )
        self.assertEqual(
            self.client.put(
                '/api/finance/profit-loss/135/revenue',
                json={'manualAmount': 800},
            ).status_code,
            409,
        )

        self.login('bob')
        self.assertEqual(
            self.client.put(
                '/api/finance/profit-loss/134/revenue',
                json={'manualAmount': 100},
            ).status_code,
            403,
        )

    def test_profit_loss_applies_additional_invoice_discount_to_revenue(self):
        self.login('sales-admin')
        event = Event(
            event_id=142, name='Invoice Discount P&L Event', location='Studio',
            start_date='20260824', end_date='20260824', asset_models=[],
            prepared_items=[], returned_items=[], actually_prepared=[],
            extra_assets=[], assigned_users=['sales-admin'],
        )
        self.data_manager.events[142] = event
        quotation = self.create_quote('Invoice Discount P&L Event')
        quotation['eventId'] = 142
        quotation['lineItems'] = [{
            'id': 'package', 'catalogKey': '', 'description': 'Production package',
            'department': 'Audio Department', 'departmentCode': 'AX',
            'days': 1, 'quantity': 1, 'uom': 'lot', 'unitPrice': 2400,
            'discountPercent': 0, 'isCustom': True,
        }]
        accepted = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json={**quotation, 'status': 'accepted'},
        ).get_json()['data']

        without_discount = self.client.get(
            '/api/finance/profit-loss/142'
        ).get_json()['data']
        self.assertEqual(without_discount['summary']['revenue'], 2400)
        self.assertEqual(without_discount['summary']['invoiceDiscount'], 0)

        plan_response = self.client.put(
            f"/api/invoice-plans/{accepted['id']}",
            json={
                'strategy': 'full',
                'invoiceDiscountMode': 'percentage',
                'invoiceDiscountValue': 10,
                'installments': [{
                    'id': 'discounted-full', 'label': 'Discounted invoice',
                    'mode': 'percentage', 'value': 100,
                }],
            },
        )
        self.assertEqual(
            plan_response.status_code,
            200,
            plan_response.get_data(as_text=True),
        )

        payload = self.client.get(
            '/api/finance/profit-loss/142'
        ).get_json()['data']
        self.assertEqual(payload['summary']['quotationRevenue'], 2400)
        self.assertEqual(payload['summary']['invoiceDiscount'], 240)
        self.assertEqual(payload['summary']['revenue'], 2160)
        self.assertEqual(payload['summary']['netProfit'], 2160)

        report = self.client.get('/api/finance/profit-loss/142/pdf')
        self.assertEqual(report.status_code, 200)
        report_text = '\n'.join(
            page.extract_text() or ''
            for page in PdfReader(io.BytesIO(report.data)).pages
        )
        self.assertIn('Quotation revenue', report_text)
        self.assertIn('Invoice discount', report_text)
        self.assertIn('Revenue after invoice discount', report_text)
        self.assertIn('-$240.00', report_text)

        finance_source = Path('static/js/finance.js').read_text(encoding='utf-8')
        self.assertIn("'Revenue after Invoice Discount'", finance_source)
        self.assertIn('Invoice discount -${financeSgd(invoiceDiscount)}', finance_source)

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

    def test_compare_keeps_same_model_with_different_descriptions_separate(self):
        event = Event(
            event_id=207,
            name='Description Comparison',
            location='Studio A',
            start_date='20260721',
            end_date='20260721',
            asset_models=[],
            prepared_items=[
                '[MODEL]AX|Shure|SM58|2|Black microphone',
                '[MODEL]AX|Shure|SM58|1|Silver microphone',
            ],
            returned_items=[],
            actually_prepared=[],
            extra_assets=[],
            assigned_users=['manager-no-sales'],
        )
        self.data_manager.events[event.event_id] = event
        self.login('manager-no-sales')

        response = self.client.get('/api/finance/compare?eventId=207')

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        rows = response.get_json()['data']['rows']
        event_items = [row['eventItem'] for row in rows if row.get('eventItem')]
        self.assertEqual(
            {item['description']: item['quantity'] for item in event_items},
            {'Black microphone': 2, 'Silver microphone': 1},
        )
        self.assertEqual(len({row['key'] for row in rows}), 2)

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
        self.assertEqual(len(event.subprojects), 1)
        self.assertEqual(event.subprojects[0]['id'], 'main')
        self.assertEqual(
            event.subprojects[0]['items'][0]['quantity'],
            2,
        )

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

    def test_compare_canonicalises_legacy_inventory_line_without_asset_ids(self):
        event = Event(
            event_id=206,
            name='Legacy Catalog Comparison',
            location='Studio A',
            start_date='20260721',
            end_date='20260721',
            asset_models=[],
            prepared_items=[],
            returned_items=[],
            actually_prepared=[],
            extra_assets=[],
            assigned_users=['alice', 'manager-no-sales'],
        )
        self.data_manager.events[event.event_id] = event
        quotation = self.create_quote('Legacy Catalog Comparison')
        quotation['eventId'] = event.event_id
        quotation['lineItems'] = [{
            'id': 'legacy-inventory-line',
            'catalogKey': 'ax|l-acoustics|sb18 iii|subwoofer',
            'sourceAssetIds': [],
            'brand': 'l-acoustics',
            'model': 'sb18 iii',
            'description': 'L-Acoustics SB18 III Subwoofer',
            'department': 'Audio Department',
            'departmentCode': 'AX',
            'days': 1,
            'quantity': 2,
            'uom': 'units',
            'unitPrice': 100,
            'discountPercent': 0,
            'isCustom': False,
        }]
        saved_quote = self.client.put(
            f"/api/quotations/{quotation['id']}", json=quotation,
        ).get_json()['data']

        self.login('manager-no-sales')
        comparison = self.client.get(
            f'/api/finance/compare?eventId={event.event_id}'
        ).get_json()['data']
        missing = next(
            row for row in comparison['rows']
            if row['status'] == 'missing_in_event'
        )
        self.assertEqual(missing['quotationItem']['title'], 'L-Acoustics SB18 III Subwoofer')

        response = self.client.post(
            f'/api/finance/compare/{event.event_id}/add-to-event',
            json={'quotationId': saved_quote['id'], 'key': missing['key']},
        )
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertIn(
            '[MODEL]AX|L-Acoustics|SB18 III|2|Subwoofer',
            event.prepared_items,
        )
        item = event.subprojects[0]['items'][0]
        self.assertEqual(item['brand'], 'L-Acoustics')
        self.assertEqual(item['model'], 'SB18 III')
        self.assertEqual(item['description'], 'Subwoofer')
        requirement = app_module._target_model_requirements(event)[
            app_module._asset_match_key(self.data_manager.inventory['AX#01'])
        ]
        self.assertEqual(requirement['required'], 2)

    def test_compare_creates_missing_event_room_for_quotation_items(self):
        event = Event(
            event_id=203,
            name='Multi-room Comparison Event',
            location='Convention Centre',
            start_date='20260721',
            end_date='20260721',
            asset_models=[],
            prepared_items=[
                '[MODEL]AX|L-Acoustics|SB18 III|2|Subwoofer',
            ],
            returned_items=[],
            actually_prepared=[],
            extra_assets=[],
            assigned_users=['alice', 'manager-no-sales'],
        )
        event.subprojects = [
            {
                'id': 'main',
                'name': 'Main Room',
                'items': [{
                    'lineId': 'event-main-sub',
                    'department': 'AX',
                    'departmentCode': 'AX',
                    'brand': 'L-Acoustics',
                    'model': 'SB18 III',
                    'description': 'Subwoofer',
                    'quantity': 1,
                    'isCustom': False,
                    'assetRefs': [],
                }],
            },
            {
                'id': 'breakout',
                'name': 'Breakout Room',
                'items': [{
                    'lineId': 'event-breakout-sub',
                    'department': 'AX',
                    'departmentCode': 'AX',
                    'brand': 'L-Acoustics',
                    'model': 'SB18 III',
                    'description': 'Subwoofer',
                    'quantity': 1,
                    'isCustom': False,
                    'assetRefs': [],
                }],
            },
        ]
        self.data_manager.events[203] = event
        self.data_manager.save_event(event)

        quotation = self.create_quote('Multi-room Comparison Event')
        catalog = self.client.get('/api/finance/catalog?query=SB18').get_json()['data'][0]
        quotation['eventId'] = 203
        quotation['subprojects'] = [
            {'id': 'main', 'name': 'Main Room'},
            {'id': 'quote-room-three', 'name': 'Quote Room Three'},
        ]
        quotation['lineItems'] = [
            {
                **catalog,
                'id': 'quote-main-sub',
                'subprojectId': 'main',
                'days': 1,
                'quantity': 2,
                'uom': 'units',
                'unitPrice': 100,
                'discountPercent': 0,
            },
            {
                **catalog,
                'id': 'quote-room-three-sub',
                'subprojectId': 'quote-room-three',
                'days': 1,
                'quantity': 2,
                'uom': 'units',
                'unitPrice': 100,
                'discountPercent': 0,
            },
        ]
        saved_quote = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json=quotation,
        ).get_json()['data']

        self.login('manager-no-sales')
        comparison = self.client.get('/api/finance/compare?eventId=203').get_json()['data']
        mismatch = next(row for row in comparison['rows'] if row['status'] == 'qty_mismatch')
        self.assertEqual(mismatch['quotationItem']['quantity'], 4)
        self.assertEqual(mismatch['eventItem']['quantity'], 2)
        views_by_scope = {
            view['scope']: view for view in comparison['subprojectViews']
        }
        self.assertEqual(set(views_by_scope), {
            'paired', 'quotation_only', 'event_only',
        })
        paired_row = views_by_scope['paired']['rows'][0]
        self.assertEqual(paired_row['quotationItem']['quantity'], 2)
        self.assertEqual(paired_row['eventItem']['quantity'], 1)
        quotation_only_row = views_by_scope['quotation_only']['rows'][0]
        self.assertEqual(quotation_only_row['quotationItem']['quantity'], 2)
        self.assertEqual(quotation_only_row['eventItem']['quantity'], 0)
        event_only_row = views_by_scope['event_only']['rows'][0]
        self.assertEqual(event_only_row['quotationItem']['quantity'], 0)
        self.assertEqual(event_only_row['eventItem']['quantity'], 1)

        response = self.client.post(
            '/api/finance/compare/203/add-to-event',
            json={
                'quotationId': saved_quote['id'],
                'key': quotation_only_row['key'],
                'viewId': views_by_scope['quotation_only']['id'],
            },
        )
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertEqual(event.subprojects[0]['items'][0]['quantity'], 1)
        self.assertEqual(event.subprojects[1]['items'][0]['quantity'], 1)
        self.assertEqual(
            [room['id'] for room in event.subprojects],
            ['main', 'breakout', 'quote-room-three'],
        )
        created_room = event.subprojects[2]
        self.assertEqual(created_room['name'], 'Quote Room Three')
        self.assertEqual(created_room['items'][0]['quantity'], 2)
        self.assertEqual(created_room['items'][0]['model'], 'SB18 III')
        refreshed_row = next(
            row for row in response.get_json()['data']['rows']
            if row['key'] == mismatch['key']
        )
        self.assertEqual(refreshed_row['eventItem']['quantity'], 4)
        self.assertEqual(refreshed_row['status'], 'matched')
        created_room_view = next(
            view for view in response.get_json()['data']['subprojectViews']
            if view.get('quoteSubprojectId') == 'quote-room-three'
        )
        self.assertEqual(created_room_view['scope'], 'paired')
        self.assertEqual(created_room_view['eventSubprojectId'], 'quote-room-three')
        finance_source = Path('static/js/finance.js').read_text(encoding='utf-8')
        self.assertIn("keys: targets.map(row => row.key)", finance_source)
        self.assertIn("viewId: bulkViewId", finance_source)

    def test_compare_adds_custom_requirement_difference_to_main_room(self):
        main_ref = app_module._make_custom_marker(
            'MISC', 'Short mic stand', 1, 'AX'
        )
        breakout_ref = app_module._make_custom_marker(
            'MISC', 'Short mic stand', 1, 'AX'
        )
        event = Event(
            event_id=204,
            name='Custom Multi-room Event',
            location='Convention Centre',
            start_date='20260721',
            end_date='20260721',
            asset_models=[],
            prepared_items=[main_ref, breakout_ref],
            returned_items=[],
            actually_prepared=[],
            extra_assets=[],
            assigned_users=['alice', 'manager-no-sales'],
        )
        event.subprojects = [
            {
                'id': 'main',
                'name': 'Main Room',
                'items': [{
                    'lineId': 'main-custom',
                    'department': 'AX',
                    'departmentCode': 'AX',
                    'description': 'Short mic stand',
                    'quantity': 1,
                    'isCustom': True,
                    'assetRefs': [main_ref],
                }],
            },
            {
                'id': 'breakout',
                'name': 'Breakout Room',
                'items': [{
                    'lineId': 'breakout-custom',
                    'department': 'AX',
                    'departmentCode': 'AX',
                    'description': 'Short mic stand',
                    'quantity': 1,
                    'isCustom': True,
                    'assetRefs': [breakout_ref],
                }],
            },
        ]
        self.data_manager.events[204] = event
        self.data_manager.save_event(event)

        quotation = self.create_quote('Custom Multi-room Event')
        quotation['eventId'] = 204
        quotation['lineItems'] = [{
            'id': 'quote-custom',
            'description': 'Short mic stand',
            'department': 'Audio Department',
            'departmentCode': 'AX',
            'days': 1,
            'quantity': 4,
            'uom': 'units',
            'unitPrice': 10,
            'discountPercent': 0,
            'isCustom': True,
            'customType': 'MISC',
        }]
        saved_quote = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json=quotation,
        ).get_json()['data']

        self.login('manager-no-sales')
        comparison = self.client.get('/api/finance/compare?eventId=204').get_json()['data']
        mismatch = next(row for row in comparison['rows'] if row['status'] == 'qty_mismatch')
        self.assertEqual(mismatch['eventItem']['quantity'], 2)

        response = self.client.post(
            '/api/finance/compare/204/add-to-event',
            json={'quotationId': saved_quote['id'], 'key': mismatch['key']},
        )
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertEqual(event.subprojects[0]['items'][0]['quantity'], 3)
        self.assertEqual(event.subprojects[1]['items'][0]['quantity'], 1)
        refreshed_row = next(
            row for row in response.get_json()['data']['rows']
            if row['key'] == mismatch['key']
        )
        self.assertEqual(refreshed_row['eventItem']['quantity'], 4)
        self.assertEqual(refreshed_row['status'], 'matched')

    def test_compare_uses_custom_quotation_header_instead_of_legacy_department(self):
        description = 'Curtain telescopic post, cross bar, base plate, accessories'
        marker = app_module._make_custom_marker(
            'MISC', description, 1, 'PIPEDRAPESYSTEM'
        )
        event = Event(
            event_id=205,
            name='Pipe and Drape Comparison',
            location='Studio A',
            start_date='20260721',
            end_date='20260721',
            asset_models=[],
            prepared_items=[marker],
            returned_items=[],
            actually_prepared=[],
            extra_assets=[],
            assigned_users=['alice'],
        )
        event.subprojects = [{
            'id': 'main',
            'name': 'Main Room',
            'items': [{
                'lineId': 'event-curtain-system',
                'department': 'PIPEDRAPESYSTEM',
                'departmentCode': 'PIPEDRAPESYSTEM',
                'description': description,
                'quantity': 1,
                'isCustom': True,
                'assetRefs': [marker],
            }],
        }]
        self.data_manager.events[event.event_id] = event
        self.data_manager.save_event(event)

        quotation = self.create_quote('Pipe and Drape Comparison')
        quotation['eventId'] = event.event_id
        quotation['lineItems'] = [{
            'id': 'quoted-curtain-system',
            'description': description,
            'department': 'General',
            'departmentCode': 'GENERAL',
            'systemName': 'Pipe & Drape System',
            'days': 1,
            'quantity': 1,
            'uom': 'lot',
            'unitPrice': 0,
            'discountPercent': 0,
            'isCustom': True,
        }]
        saved_quote = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json=quotation,
        ).get_json()['data']

        self.login('sales-admin')
        comparison = self.client.get(
            '/api/finance/compare',
            query_string={
                'eventId': event.event_id,
                'quotationId': saved_quote['id'],
            },
        )

        self.assertEqual(comparison.status_code, 200, comparison.get_data(as_text=True))
        rows = comparison.get_json()['data']['rows']
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['status'], 'matched')
        self.assertEqual(
            rows[0]['quotationItem']['departmentCode'],
            'PIPEDRAPESYSTEM',
        )
        self.assertEqual(
            rows[0]['quotationItem']['department'],
            'Pipe & Drape System',
        )

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

    def test_compare_preserves_custom_item_types_for_visibility_filters(self):
        self.login('bnjm2000')
        event = Event(
            event_id=203,
            name='Custom Item Comparison',
            location='Studio D',
            start_date='20260722',
            end_date='20260722',
            asset_models=[],
            prepared_items=[
                app_module._make_custom_marker(
                    'MISC', 'Lectern signage', 1, 'STAGING'
                ),
                app_module._make_custom_marker(
                    'LOAN', 'LED processor', 2, 'VIDEO', 'Rental Partner'
                ),
            ],
            returned_items=[],
            actually_prepared=[],
            extra_assets=[],
            assigned_users=['bnjm2000'],
        )
        self.data_manager.events[203] = event
        target = self.create_quote('Custom Item Comparison')
        target['eventId'] = 203
        target = self.client.put(
            f"/api/quotations/{target['id']}", json=target
        ).get_json()['data']

        comparison = self.client.get(
            f"/api/finance/compare?eventId=203{chr(38)}quotationId={target['id']}"
        ).get_json()['data']
        rows_by_type = {
            row['eventItem']['identity'].get('type'): row
            for row in comparison['rows']
        }
        self.assertIn('MISC', rows_by_type)
        self.assertIn('LOAN', rows_by_type)

        response = self.client.post(
            '/api/finance/compare/203/add-to-quotation',
            json={
                'quotationId': target['id'],
                'key': rows_by_type['LOAN']['key'],
            },
        )
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        updated = self.client.get(f"/api/quotations/{target['id']}").get_json()['data']
        self.assertEqual(updated['lineItems'][0]['customType'], 'LOAN')
        self.assertEqual(updated['lineItems'][0]['customCompany'], 'Rental Partner')

        with open(
            os.path.join(
                os.path.dirname(app_module.__file__), 'static', 'js', 'finance.js'
            ),
            encoding='utf-8',
        ) as source_file:
            finance_source = source_file.read()
        self.assertIn('showMisc: false', finance_source)
        self.assertIn('showLoans: true', finance_source)

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

    def test_linked_subproject_metadata_round_trips_with_quotation(self):
        quotation = self.create_quote('Linked Rooms')
        quotation['subprojects'] = [
            {'id': 'main', 'name': 'Ballroom', 'linkedGroupId': 'linked-rooms-1'},
            {'id': 'breakout', 'name': 'Breakout', 'linkedGroupId': 'linked-rooms-1'},
        ]
        quotation['lineItems'] = [
            {
                'id': 'main-speaker', 'linkedItemId': 'linked-speaker',
                'description': 'Speaker', 'department': 'Audio Department',
                'departmentCode': 'AX', 'days': 1, 'quantity': 1,
                'uom': 'units', 'unitPrice': 100, 'discountPercent': 0,
                'subprojectId': 'main',
            },
            {
                'id': 'breakout-speaker', 'linkedItemId': 'linked-speaker',
                'description': 'Speaker', 'department': 'Audio Department',
                'departmentCode': 'AX', 'days': 1, 'quantity': 1,
                'uom': 'units', 'unitPrice': 100, 'discountPercent': 0,
                'subprojectId': 'breakout',
            },
        ]
        quotation['headerRows'] = [{
            'id': 'main-header', 'linkedHeaderId': 'linked-header',
            'content': 'Sound package', 'beforeLineId': 'main-speaker',
            'subprojectId': 'main',
        }, {
            'id': 'breakout-header', 'linkedHeaderId': 'linked-header',
            'content': 'Sound package', 'beforeLineId': 'breakout-speaker',
            'subprojectId': 'breakout',
        }]
        quotation['adjustments'] = [{
            'id': 'main-discount', 'linkedAdjustmentId': 'linked-discount',
            'scope': 'department', 'department': 'Audio', 'label': 'Discount',
            'amount': -5, 'subprojectId': 'main',
        }, {
            'id': 'breakout-discount', 'linkedAdjustmentId': 'linked-discount',
            'scope': 'department', 'department': 'Audio', 'label': 'Discount',
            'amount': -5, 'subprojectId': 'breakout',
        }]

        response = self.client.put(
            f"/api/quotations/{quotation['id']}", json=quotation
        )

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        saved = response.get_json()['data']
        self.assertEqual(
            {row['linkedGroupId'] for row in saved['subprojects']},
            {'linked-rooms-1'},
        )
        self.assertEqual(
            {row['linkedItemId'] for row in saved['lineItems']},
            {'linked-speaker'},
        )
        self.assertEqual(
            {row['linkedHeaderId'] for row in saved['headerRows']},
            {'linked-header'},
        )
        self.assertEqual(
            {row['linkedAdjustmentId'] for row in saved['adjustments']},
            {'linked-discount'},
        )
        finance_data = app_module._load_finance_data()
        costing = app_module._linked_costing_for_quotation(finance_data, saved)
        self.assertEqual(
            {row['linkedGroupId'] for row in costing['subprojects']},
            {'linked-rooms-1'},
        )

        reloaded = self.client.get(
            f"/api/quotations/{quotation['id']}"
        ).get_json()['data']
        self.assertEqual(
            {row['linkedGroupId'] for row in reloaded['subprojects']},
            {'linked-rooms-1'},
        )
        self.assertEqual(
            {row['linkedItemId'] for row in reloaded['lineItems']},
            {'linked-speaker'},
        )

    def test_link_only_change_persists_for_otherwise_identical_subprojects(self):
        quotation = self.create_quote('Identical Rooms')
        quotation['subprojects'] = [
            {'id': 'main', 'name': 'Ballroom'},
            {'id': 'breakout', 'name': 'Breakout'},
        ]
        quotation['lineItems'] = [{
            'id': 'main-speaker', 'description': 'Speaker',
            'department': 'Audio Department', 'departmentCode': 'AX',
            'days': 1, 'quantity': 1, 'uom': 'units', 'unitPrice': 100,
            'discountPercent': 0, 'subprojectId': 'main',
        }, {
            'id': 'breakout-speaker', 'description': 'Speaker',
            'department': 'Audio Department', 'departmentCode': 'AX',
            'days': 1, 'quantity': 1, 'uom': 'units', 'unitPrice': 100,
            'discountPercent': 0, 'subprojectId': 'breakout',
        }]
        baseline_response = self.client.put(
            f"/api/quotations/{quotation['id']}", json=quotation
        )
        self.assertEqual(
            baseline_response.status_code, 200,
            baseline_response.get_data(as_text=True),
        )
        linked = baseline_response.get_json()['data']
        for subproject in linked['subprojects']:
            subproject['linkedGroupId'] = 'linked-identical-rooms'
        for line in linked['lineItems']:
            line['linkedItemId'] = 'linked-identical-speaker'

        linked_response = self.client.put(
            f"/api/quotations/{quotation['id']}", json=linked
        )

        self.assertEqual(
            linked_response.status_code, 200,
            linked_response.get_data(as_text=True),
        )
        self.assertFalse(linked_response.get_json().get('unchanged', False))
        reloaded = self.client.get(
            f"/api/quotations/{quotation['id']}"
        ).get_json()['data']
        self.assertEqual(
            {row.get('linkedGroupId') for row in reloaded['subprojects']},
            {'linked-identical-rooms'},
        )
        self.assertEqual(
            {row.get('linkedItemId') for row in reloaded['lineItems']},
            {'linked-identical-speaker'},
        )

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
                'id': 'main-video', 'catalogKey': 'inventory:vx|test|screen',
                'brand': 'Test', 'model': 'Screen', 'description': 'Projection screen',
                'department': 'Video Department', 'departmentCode': 'VX',
                'days': 1, 'quantity': 1, 'uom': 'units', 'unitPrice': 150,
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
        self.assertIn('Main Room', text)
        self.assertIn('Breakout A', text)
        self.assertIn('1.01', text)
        self.assertIn('1.02', text)
        self.assertIn('2.01', text)
        self.assertIn('Summary', text)
        self.assertIn('PROJECT', text)
        self.assertTrue(saved['summaryBySubproject'])
        self.assertIn(f'Page {len(reader.pages)} of {len(reader.pages)}', reader.pages[-1].extract_text() or '')

        department_summary = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json={**saved, 'summaryBySubproject': False},
        )
        self.assertEqual(
            department_summary.status_code,
            200,
            department_summary.get_data(as_text=True),
        )
        department_pdf = self.client.get(
            f"/api/quotations/{quotation['id']}/pdf"
        ).data
        department_text = '\n'.join(
            page.extract_text() or ''
            for page in PdfReader(io.BytesIO(department_pdf)).pages
        )
        self.assertIn('Summary', department_text)
        self.assertIn('CATEGORY', department_text)
        self.assertIn('Audio', department_text)
        self.assertIn('Lighting', department_text)

        saved = department_summary.get_json()['data']
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

    def test_reordering_rooms_preserves_ids_in_pdf_and_linked_event(self):
        quotation = self.create_quote('Reordered Rooms')
        quotation['subprojects'] = [
            {'id': 'main', 'name': 'Main Room'},
            {'id': 'breakout-a', 'name': 'Breakout A'},
            {'id': 'breakout-b', 'name': 'Breakout B'},
        ]
        quotation['lineItems'] = [
            {
                'id': 'line-main', 'description': 'Main room item',
                'department': 'Audio Department', 'departmentCode': 'AX',
                'days': 1, 'quantity': 1, 'uom': 'units', 'unitPrice': 100,
                'discountPercent': 0, 'subprojectId': 'main', 'isCustom': True,
            },
            {
                'id': 'line-a', 'description': 'Breakout A item',
                'department': 'Video Department', 'departmentCode': 'VX',
                'days': 1, 'quantity': 1, 'uom': 'units', 'unitPrice': 100,
                'discountPercent': 0, 'subprojectId': 'breakout-a', 'isCustom': True,
            },
            {
                'id': 'line-b', 'description': 'Breakout B item',
                'department': 'Lighting Department', 'departmentCode': 'LX',
                'days': 1, 'quantity': 1, 'uom': 'units', 'unitPrice': 100,
                'discountPercent': 0, 'subprojectId': 'breakout-b', 'isCustom': True,
            },
        ]
        saved = self.client.put(
            f"/api/quotations/{quotation['id']}", json=quotation
        ).get_json()['data']
        accepted = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json={**saved, 'status': 'accepted'},
        ).get_json()['data']

        rooms_by_id = {room['id']: room for room in accepted['subprojects']}
        reordered_rooms = [
            rooms_by_id['breakout-b'], rooms_by_id['main'], rooms_by_id['breakout-a'],
        ]
        response = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json={**accepted, 'subprojects': reordered_rooms},
        )
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        reordered = response.get_json()['data']
        expected_ids = ['breakout-b', 'main', 'breakout-a']
        self.assertEqual([room['id'] for room in reordered['subprojects']], expected_ids)

        event = self.data_manager.events[accepted['eventId']]
        self.assertEqual([room['id'] for room in event.subprojects], expected_ids)
        self.assertEqual(
            {room['id']: [item['lineId'] for item in room['items']] for room in event.subprojects},
            {
                'breakout-b': ['line-b'],
                'main': ['line-main'],
                'breakout-a': ['line-a'],
            },
        )

        exported = self.client.get(f"/api/quotations/{quotation['id']}/pdf").data
        pdf_text = '\n'.join(
            page.extract_text() or ''
            for page in PdfReader(io.BytesIO(exported)).pages
        )
        self.assertLess(pdf_text.index('Breakout B'), pdf_text.index('Main Room'))
        self.assertLess(pdf_text.index('Main Room'), pdf_text.index('Breakout A'))
        self.assertIn('1.01', pdf_text)
        self.assertIn('2.01', pdf_text)
        self.assertIn('3.01', pdf_text)

        finance_source = Path('static/js/finance.js').read_text(encoding='utf-8')
        shared_source = Path('static/js/line-workspace.js').read_text(encoding='utf-8')
        self.assertIn('financeSubprojectDragStart', finance_source)
        self.assertIn('financeSubprojectDrop', finance_source)
        self.assertIn('draggable="true"', shared_source)
        self.assertIn('financeSubprojectDropAtEnd', finance_source)
        self.assertIn('financeSubprojectDropAtIndex', finance_source)
        self.assertIn('finance-subproject-drop-slot', shared_source)
        self.assertIn("index === 0 ? 'is-first' : ''", shared_source)

    def test_line_item_dragging_supports_after_and_end_positions(self):
        finance_source = Path('static/js/finance.js').read_text(encoding='utf-8')
        finance_css = Path('static/css/finance.css').read_text(encoding='utf-8')
        shared_source = Path('static/js/line-workspace.js').read_text(encoding='utf-8')

        self.assertIn(
            "event.clientY < rect.top + (rect.height / 2) ? 'before' : 'after'",
            shared_source,
        )
        self.assertIn("if (position === 'after') insertionIndex += 1;", finance_source)
        self.assertIn(
            'function financeDropLineAtEnd(event, encodedDepartment)',
            finance_source,
        )
        self.assertIn('finance-line-drop-end-target', finance_source)
        self.assertIn('.finance-line-row.drag-over-after', finance_css)
        self.assertIn('.finance-line-drop-end-target.drag-over td', finance_css)
        self.assertIn('function financeAttachLineToGroup(', finance_source)
        self.assertIn('function financeDetachLineFromGroup(', finance_source)
        self.assertIn('financeAttachLineToGroup(moved, target.groupId', finance_source)
        self.assertIn('if (moved.groupId) financeDetachLineFromGroup(moved);', finance_source)
        self.assertIn('class="finance-line-row finance-group-child-row"', finance_source)
        self.assertIn('${financeCategoryColumnHeader(department)}', finance_source)
        self.assertIn('.finance-category-column-header td', finance_css)
        self.assertIn('function financeDragLineGroupStart(', finance_source)
        self.assertIn('function financeDragLineBundleStart(', finance_source)
        self.assertIn('data-group-boundary="before"', finance_source)
        self.assertIn('function financeRenameLineGroup(', finance_source)
        self.assertIn('function financeGroupDisplayBuckets(', finance_source)
        self.assertIn(
            'showbaseLineWorkspace.draggedWholeGroup(lines, sourceIndexes)',
            finance_source,
        )
        self.assertIn(
            'const sourceIndexes = financeDraggedLineIndexes(event)',
            finance_source,
        )
        self.assertIn('draggedWholeGroup(lines, indexes)', shared_source)

    def test_quotation_days_and_multiplier_controls_are_scoped_to_category(self):
        finance_source = Path('static/js/finance.js').read_text(encoding='utf-8')
        header_source = finance_source.split(
            'function financeCategoryColumnHeader(department) {', 1
        )[1].split('function financeGroupDisplayBuckets', 1)[0]
        category_functions = finance_source.split(
            'function financeCategoryLineItems(category,', 1
        )[1].split('function financeToggleTotalLock', 1)[0]

        self.assertIn('financeCategoryMultiplierHeaderLabel(department)', header_source)
        self.assertIn("financeSetCategoryMultiplierLabels('Day',", header_source)
        self.assertIn("financeSetCategoryMultiplierLabels('Mult',", header_source)
        self.assertIn('financeApplyCategoryDays(', header_source)
        self.assertIn('Apply to this category', header_source)
        self.assertNotIn('Apply to all lines', header_source)
        self.assertIn('financeLineSystem(line) === String(category', category_functions)
        self.assertIn("(line.subprojectId || 'main') === subprojectId", category_functions)
        self.assertIn('financeCategoryLineItems(category).forEach(line => {', category_functions)

    def test_group_child_quantities_are_editable_in_both_workspaces(self):
        finance_source = Path('static/js/finance.js').read_text(encoding='utf-8')
        costing_source = Path('static/js/costing.js').read_text(encoding='utf-8')
        finance_css = Path('static/css/finance.css').read_text(encoding='utf-8')

        self.assertIn('financeLineGroupSelectionQuantityChange(', finance_source)
        self.assertIn('financeGroupBucketQuantityChange(', finance_source)
        self.assertIn('key: financeLineGroupResultKey(line)', finance_source)
        self.assertIn('if (existing) {', finance_source)
        self.assertIn('aria-label="Child asset quantity"', finance_source)
        self.assertIn('line.groupItemQuantity = Math.max(0, costingNumber(value));', costing_source)
        self.assertIn('.finance-line-group-quantity input', finance_css)
        self.assertIn('.finance-lines-table input[type="number"]', finance_css)

    def test_group_editor_defaults_and_reordering_controls(self):
        finance_source = Path('static/js/finance.js').read_text(encoding='utf-8')
        finance_css = Path('static/css/finance.css').read_text(encoding='utf-8')

        self.assertIn("{ value: 'sets', label: 'set(s)' }", finance_source)
        self.assertIn("uom: 'sets'", finance_source)
        self.assertIn('const headerDays = 1;', finance_source)
        self.assertIn('const headerQuantity = groupQuantity;', finance_source)
        self.assertIn('financeLineGroupCategoryResults', finance_source)
        self.assertIn(
            'function financeShowLineGroupCategorySuggestions(', finance_source
        )
        self.assertIn(
            'function financeLineGroupSelectionDragStart(', finance_source
        )
        self.assertIn(
            'function financeLineGroupSelectionHandleKeydown(', finance_source
        )
        self.assertIn('.finance-line-group-selection-row.drag-over-before', finance_css)
        self.assertIn(
            '.finance-lines-table .finance-col-uom .finance-custom-control',
            finance_css,
        )

    def test_category_reorder_is_scoped_to_the_active_subproject(self):
        source = Path('static/js/finance.js').read_text(encoding='utf-8')
        reorder_source = source.split(
            'function financeDropDepartment(event, encodedTargetDepartment)', 1,
        )[1].split('function financeDragDepartmentEnd', 1)[0]

        self.assertIn(
            'financeActiveDepartments(financeState.current, subprojectId)',
            reorder_source,
        )
        self.assertIn(
            "String(line.subprojectId || 'main') === String(subprojectId)\n"
            "      ? reordered[reorderedIndex++]\n"
            "      : line",
            reorder_source,
        )
        self.assertIn(
            'financeQueueSave({ sourceSubprojectId: subprojectId });',
            reorder_source,
        )

    def test_delayed_save_does_not_sync_from_a_newly_selected_subproject(self):
        source = Path('static/js/finance.js').read_text(encoding='utf-8')
        save_source = source.split(
            'async function financeSaveCurrent', 1,
        )[1].split('async function financeFlushPendingSave', 1)[0]

        self.assertNotIn('financeSynchroniseLinkedSubprojects(', save_source)

    def test_category_collapse_state_is_saved_per_subproject(self):
        quotation = self.create_quote('Remember Category Collapse')
        quotation['subprojects'] = [
            {
                'id': 'main',
                'name': 'Ballroom',
                'collapsedCategories': [
                    'Audio System', ' audio system ', '', 'Lighting System',
                ],
            },
            {
                'id': 'breakout',
                'name': 'Breakout',
                'collapsedCategories': ['Video System'],
            },
        ]
        saved = self.client.put(
            f"/api/quotations/{quotation['id']}", json=quotation,
        ).get_json()['data']
        reloaded = self.client.get(
            f"/api/quotations/{quotation['id']}",
        ).get_json()['data']

        self.assertEqual(
            reloaded['subprojects'][0]['collapsedCategories'],
            ['Audio System', 'Lighting System'],
        )
        self.assertEqual(
            reloaded['subprojects'][1]['collapsedCategories'],
            ['Video System'],
        )

        source = Path('static/js/finance.js').read_text(encoding='utf-8')
        toggle_source = source.split(
            'function financeToggleDepartmentCollapse', 1,
        )[1].split('async function financeRenameDepartment', 1)[0]
        self.assertIn('subproject.collapsedCategories = existing', toggle_source)
        self.assertIn(
            'financeQueueSave({ sourceSubprojectId: subprojectId });',
            toggle_source,
        )

    def test_set_uom_round_trips_and_exports_with_display_label(self):
        quotation = self.create_quote('Set UOM')
        quotation['lineItems'] = [{
            'id': 'group-line',
            'description': 'Lighting package',
            'department': 'Lighting Department',
            'systemName': 'Lighting System',
            'days': 1,
            'quantity': 2,
            'uom': 'set(s)',
            'unitPrice': 100,
            'discountPercent': 0,
            'subprojectId': 'main',
            'groupId': 'lighting-package',
            'groupTitle': 'Lighting package',
            'groupLeader': True,
            'groupHeaderQuantity': 2,
        }]
        saved = self.client.put(
            f"/api/quotations/{quotation['id']}", json=quotation,
        ).get_json()['data']

        self.assertEqual(saved['lineItems'][0]['uom'], 'sets')
        pdf = self.client.get(f"/api/quotations/{quotation['id']}/pdf")
        text = '\n'.join(
            page.extract_text() or '' for page in PdfReader(io.BytesIO(pdf.data)).pages
        )
        self.assertIn('2 set(s)', text)

    def test_optional_categories_are_visible_but_excluded_from_totals(self):
        quotation = self.create_quote('Optional Systems')
        quotation.update({
            'taxRate': 9,
            'summaryBySubproject': False,
            'showDepartmentSubtotals': True,
            'lineItems': [
                {
                    'id': 'required-audio',
                    'description': 'Main PA',
                    'department': 'Audio Department',
                    'systemName': 'Audio System',
                    'days': 1,
                    'quantity': 1,
                    'uom': 'units',
                    'unitPrice': 100,
                    'discountPercent': 0,
                    'subprojectId': 'main',
                },
                {
                    'id': 'optional-lighting',
                    'description': 'Decorative wash',
                    'department': 'Lighting Department',
                    'systemName': 'oPtIoNaL Lighting System',
                    'days': 1,
                    'quantity': 1,
                    'uom': 'units',
                    'unitPrice': 200,
                    'discountPercent': 0,
                    'subprojectId': 'main',
                },
            ],
            'adjustments': [
                {
                    'id': 'required-discount',
                    'scope': 'department',
                    'department': 'Audio System',
                    'label': 'Required discount',
                    'amount': -10,
                    'calculationMode': 'amount',
                    'kind': 'discount',
                    'subprojectId': 'main',
                },
                {
                    'id': 'optional-discount',
                    'scope': 'department',
                    'department': 'oPtIoNaL Lighting System',
                    'label': 'Optional discount',
                    'amount': -20,
                    'calculationMode': 'amount',
                    'kind': 'discount',
                    'subprojectId': 'main',
                },
            ],
        })
        # Optional arrives first in the source data, but the PDF summary must
        # always place it after every included category.
        quotation['lineItems'].reverse()

        response = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json=quotation,
        )
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        saved = response.get_json()['data']
        self.assertEqual(saved['totals']['subtotal'], 100)
        self.assertEqual(saved['totals']['adjustments'], -10)
        self.assertEqual(saved['totals']['netSubtotal'], 90)
        self.assertEqual(saved['totals']['tax'], 8.1)
        self.assertEqual(saved['totals']['total'], 98.1)

        pdf = self.client.get(f"/api/quotations/{quotation['id']}/pdf").data
        reader = PdfReader(io.BytesIO(pdf))
        text = '\n'.join(page.extract_text() or '' for page in reader.pages)
        last_page_text = reader.pages[-1].extract_text() or ''
        self.assertIn('Summary', text)
        self.assertIn('CATEGORY', text)
        self.assertIn('oPtIoNaL Lighting System', text)
        self.assertIn('$180.00', text)
        self.assertIn('$98.10', text)
        summary_position = last_page_text.index('Summary')
        optional_summary_position = last_page_text.index(
            'oPtIoNaL Lighting System', summary_position
        )
        required_summary_position = last_page_text.index(
            'Audio System', summary_position
        )
        total_position = last_page_text.rindex('TOTAL')
        self.assertLess(required_summary_position, optional_summary_position)
        self.assertLess(optional_summary_position, total_position)
        self.assertIn('Not included in total', last_page_text)
        self.assertNotIn('Optional items', last_page_text)
        self.assertTrue(
            app_module._finance_is_optional_category('OPTIONAL Audio System')
        )

        saved['showDepartmentSubtotals'] = False
        hidden_response = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json=saved,
        )
        self.assertEqual(
            hidden_response.status_code,
            200,
            hidden_response.get_data(as_text=True),
        )
        hidden_pdf = self.client.get(f"/api/quotations/{quotation['id']}/pdf").data
        hidden_text = '\n'.join(
            page.extract_text() or ''
            for page in PdfReader(io.BytesIO(hidden_pdf)).pages
        )
        self.assertNotIn('Audio System subtotal', hidden_text)
        self.assertIn('oPtIoNaL Lighting System subtotal', hidden_text)
        self.assertIn('$180.00', hidden_text)

    def test_compact_optional_summary_keeps_signoff_on_the_summary_page(self):
        quotation = self.create_quote('Compact Optional Summary')
        included_systems = [
            'Audio System',
            'Video System',
            'Camera System',
            'Lighting System',
            'Trussing System',
            'Pipe & Drape System',
            'Electrical Distribution System',
            'Endorsement & Certification',
            'Transportation',
            'Manpower',
        ]
        quotation.update({
            'showDepartmentSubtotals': True,
            'summaryBySubproject': False,
            'showSignOff': True,
            'salesperson': 'Terence Chew',
            'terms': (
                '1. Validity: 14 days\n'
                '2. Work will only begin after receiving written confirmation.\n'
                '3. A non-refundable deposit is required upon confirmation.\n'
                '4. All items are available for indoor use unless stated otherwise.\n'
                '5. Rental confirmations are provided on a first-come basis.\n'
                '6. Payment is due within the agreed payment period.\n'
                '7. The hirer is responsible for exercising due diligence and care '
                'for the equipment and assumes liability for loss or damage.\n'
                '8. Cancellation charges apply after setup completion.\n'
                '9. Extra services or equipment not included in this quotation '
                'will incur additional charges.\n\n'
                'We hope the quotation provided is acceptable and look forward '
                'to your prompt confirmation. Please contact us if you need any '
                'further information.'
            ),
            'lineItems': [
                {
                    'id': f'included-{index}',
                    'description': f'{system} package',
                    'department': system,
                    'systemName': system,
                    'days': 1,
                    'quantity': 1,
                    'uom': 'lot',
                    'unitPrice': 100,
                    'discountPercent': 0,
                    'subprojectId': 'main',
                }
                for index, system in enumerate(included_systems, start=1)
            ] + [
                {
                    'id': 'optional-wireless-podium',
                    'description': 'Wireless podium package',
                    'department': 'Optional - Wireless Podium',
                    'systemName': 'Optional - Wireless Podium',
                    'days': 1,
                    'quantity': 1,
                    'uom': 'lot',
                    'unitPrice': 200,
                    'discountPercent': 0,
                    'subprojectId': 'main',
                },
                {
                    'id': 'optional-foyer',
                    'description': 'Foyer package',
                    'department': 'Optional - Foyer System',
                    'systemName': 'Optional - Foyer System',
                    'days': 1,
                    'quantity': 1,
                    'uom': 'lot',
                    'unitPrice': 800,
                    'discountPercent': 0,
                    'subprojectId': 'main',
                },
            ],
        })
        saved = self.client.put(
            f"/api/quotations/{quotation['id']}", json=quotation,
        ).get_json()['data']

        exported = self.client.get(f"/api/quotations/{saved['id']}/pdf").data
        reader = PdfReader(io.BytesIO(exported))
        last_page_text = reader.pages[-1].extract_text() or ''

        self.assertIn('Optional - Wireless Podium', last_page_text)
        self.assertIn('Optional - Foyer System', last_page_text)
        self.assertIn('Not included in total', last_page_text)
        self.assertNotIn('Optional items', last_page_text)
        self.assertIn('TERMS AND CONDITIONS', last_page_text)
        self.assertIn('Quoted by:', last_page_text)
        self.assertIn('Confirmed & accepted by:', last_page_text)

        pdf_source = Path('quotation_pdf.py').read_text(encoding='utf-8')
        self.assertIn("name='FinanceFinalSummaryPage'", pdf_source)
        self.assertIn("mode='shrink'", pdf_source)
        self.assertIn('final_page_story.extend([Spacer(1, 8 * mm), signoff])', pdf_source)
        self.assertNotIn('CondPageBreak(doc.height)', pdf_source)

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
        self.assertIn('Audio', text)

    def test_quotation_custom_headers_persist_without_affecting_totals_and_export(self):
        quotation = self.create_quote('Mixed case headers')
        quotation['lineItems'] = [
            {
                'id': 'audio-console', 'description': 'Audio console',
                'department': 'Audio Department', 'departmentCode': 'AX',
                'days': 1, 'quantity': 1, 'uom': 'units', 'unitPrice': 100,
                'discountPercent': 0, 'subprojectId': 'main',
            },
            {
                'id': 'audio-mics', 'description': 'Wireless microphones',
                'department': 'Audio Department', 'departmentCode': 'AX',
                'days': 1, 'quantity': 2, 'uom': 'units', 'unitPrice': 50,
                'discountPercent': 0, 'subprojectId': 'main',
            },
        ]
        quotation['headerRows'] = [
            {
                'id': 'header-intro',
                'content': 'Phase 1 overview\nAudio setup',
                'beforeLineId': 'audio-console',
                'subprojectId': 'main',
            },
            {
                'id': 'header-mics',
                'content': 'Microphone package 2',
                'beforeLineId': 'audio-mics',
                'subprojectId': 'main',
            },
        ]

        response = self.client.put(
            f"/api/quotations/{quotation['id']}", json=quotation,
        )
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        saved = response.get_json()['data']

        self.assertEqual(saved['headerRows'], quotation['headerRows'])
        self.assertEqual(saved['totals']['subtotal'], 200)
        exported = self.client.get(f"/api/quotations/{saved['id']}/pdf").data
        pdf_text = '\n'.join(
            page.extract_text() or ''
            for page in PdfReader(io.BytesIO(exported)).pages
        )
        self.assertIn('Phase 1 overview', pdf_text)
        self.assertIn('Audio setup', pdf_text)
        self.assertIn('Microphone package 2', pdf_text)
        self.assertLess(pdf_text.index('Phase 1 overview'), pdf_text.index('Audio console'))
        self.assertLess(pdf_text.index('Audio console'), pdf_text.index('Microphone package 2'))
        self.assertLess(pdf_text.index('Microphone package 2'), pdf_text.index('Wireless microphones'))

    def test_revision_line_id_relink_keeps_custom_header_anchor(self):
        snapshot_line = {
            'id': 'snapshot-line', 'description': 'Console',
            'department': 'Audio Department', 'departmentCode': 'AX',
            'quantity': 1, 'uom': 'units',
        }
        canonical_line = {**snapshot_line, 'id': 'canonical-line'}
        request_data = {
            'lineItems': [copy.deepcopy(snapshot_line)],
            'headerRows': [{
                'id': 'header-one', 'content': 'Audio package',
                'beforeLineId': 'snapshot-line', 'subprojectId': 'main',
            }],
        }

        relinked = app_module._finance_relink_revision_line_ids(
            request_data,
            {'snapshot': {'lineItems': [snapshot_line]}},
            {'lineItems': [canonical_line]},
        )

        self.assertEqual(relinked['lineItems'][0]['id'], 'canonical-line')
        self.assertEqual(
            relinked['headerRows'][0]['beforeLineId'], 'canonical-line'
        )

    def test_quotation_ui_supports_editable_draggable_full_width_headers(self):
        js_source = Path('static/js/finance.js').read_text(encoding='utf-8').lower()
        css_source = Path('static/css/finance.css').read_text(encoding='utf-8').lower()

        self.assertIn('onclick="financeaddheader()">+ header</button>', js_source)
        self.assertIn('function financedragheaderstart', js_source)
        self.assertIn('function financeheaderanchorforlinedrop', js_source)
        self.assertIn('class="finance-quotation-header-input"', js_source)
        self.assertIn('colspan="10"', js_source)
        self.assertIn('.finance-quotation-header-input', css_source)
        self.assertIn('text-align: center;', css_source)
        self.assertIn('text-transform: none;', css_source)

    def test_quotation_line_columns_align_and_show_quantity_before_multiplier(self):
        source = Path('static/js/finance.js').read_text(encoding='utf-8')
        css_source = Path('static/css/finance.css').read_text(encoding='utf-8')
        header_source = source.split(
            'function financeCategoryColumnHeader(department) {', 1
        )[1].split('function financeGroupDisplayBuckets', 1)[0]
        line_source = source.split(
            'const itemControl = `<input class="finance-line-input"', 1
        )[1].split('const categoryHeader =', 1)[0]

        self.assertLess(header_source.index('>Qty</td>'), header_source.index('>UOM</td>'))
        self.assertLess(
            header_source.index('>UOM</td>'),
            header_source.index('financeCategoryMultiplierHeaderLabel(department)'),
        )
        self.assertLess(
            line_source.index('aria-label="Quantity"'),
            line_source.index('financeUomControl(line, index)'),
        )
        self.assertLess(
            line_source.index('financeUomControl(line, index)'),
            line_source.index('aria-label="Days"'),
        )
        self.assertIn('.finance-col-uom', css_source)
        self.assertIn('.finance-col-multiplier', css_source)
        price_alignment = css_source.split(
            '.finance-line-unit-price-input input,', 1
        )[1].split('}', 1)[0]
        self.assertIn('text-align: right;', price_alignment)

    def test_quotation_ui_has_no_native_selects(self):
        path = os.path.join(os.path.dirname(app_module.__file__), 'static', 'js', 'finance.js')
        with open(path, encoding='utf-8') as source_file:
            source = source_file.read().lower()
        css_path = os.path.join(os.path.dirname(app_module.__file__), 'static', 'css', 'finance.css')
        with open(css_path, encoding='utf-8') as css_file:
            css_source = css_file.read().lower()
        self.assertIn('financepaymenttermsmarkup', source)
        self.assertNotIn('set all days', source)
        self.assertNotIn('apply to all lines', source)
        self.assertIn('apply to this category', source)
        self.assertIn('ondragstart', source)
        self.assertIn('finance-drag-handle\" draggable=\"true', source)
        self.assertNotIn('class=\"finance-line-row\" draggable=\"true', source)
        self.assertIn('show unit prices', source)
        self.assertIn('show category subtotals', source)
        self.assertIn('group summary by', source)
        self.assertIn('financesetsummarygrouping', source)
        self.assertIn('role="radiogroup"', source)
        pdf_options = source.split('<h3>pdf options</h3>', 1)[1].split(
            'export pdf', 1
        )[0]
        self.assertLess(
            pdf_options.index('financesummarygroupingcontrol'),
            pdf_options.index('show unit prices'),
        )
        self.assertIn('financesubprojects(document).length > 1', source)
        self.assertIn('<th>category</th>', source)
        self.assertIn('aria-label="category"', source)
        self.assertNotIn('<th>system</th>', source)
        self.assertIn('finance_salutations', source)
        self.assertIn("financetoggledocumentflag('showsignoff')", source)
        self.assertIn("function financedefaultuom(department, preferred = '')", source)
        self.assertNotIn("financestate.adddepartment = 'manpower'", source)
        self.assertIn("selected.department || 'general'", source)
        self.assertIn('onmousedown="event.preventdefault()"', source)
        self.assertIn('onclick="financechoosedepartment', source)
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
        self.assertIn('<col style=\"width:368px\"><col style=\"width:120px\"', source)
        self.assertIn('<col style=\"width:70px\">', source)
        self.assertIn("aria-label=\"days\" onchange", source)
        self.assertIn("step=\"0.5\" value=\"${financeescapeattr(line.days)}\"", source)
        self.assertIn("step=\"1\" value=\"${financeescapeattr(line.quantity)}\"", source)
        self.assertIn('height: 24px;', css_source)
        self.assertIn('.finance-lines-table .finance-money-input', css_source)
        self.assertIn('padding: 1px 2px;', css_source)
        side_column_css = css_source.split('.finance-side-column {', 2)[2].split('}', 1)[0]
        self.assertIn('overflow-y: auto;', side_column_css)
        self.assertIn('overscroll-behavior-y: auto;', side_column_css)
        self.assertNotIn('overscroll-behavior: contain;', side_column_css)
        self.assertIn('window.open(pdfurl', source)
        self.assertNotIn('window.location.href = pdfurl', source)
        self.assertNotIn('link.download', source)
        self.assertIn('financerequireexportprojectname(quotation)', source)
        self.assertIn('financeprojectnameinput', source)
        self.assertIn('project name before exporting the quotation', source)
        self.assertIn('.finance-input[aria-invalid="true"]', css_source)
        self.assertIn("params.set('sort', financestate.listsort)", source)
        self.assertIn('quotation number', source)
        self.assertIn('last modified', source)
        self.assertIn('financelistresultshtml', source)
        self.assertIn('financestate.listrequestseq += 1', source)
        self.assertIn('settimeout(() => financeloadlist(query), 400)', source)
        self.assertNotIn('/api/events?view=summary&limit=500', source)
        self.assertIn('startprogressiveeventoptions(', source)
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
        self.assertNotIn('financeensureinvoicedmodal', source)
        self.assertIn('financeclientpickermodal', source)
        self.assertNotIn('financeeventpickermodal', source)
        self.assertIn("planopeneventchooser('quotation-link')", source)
        self.assertIn('profit &amp; loss', source)
        self.assertIn('financeopencomparepage', source)
        self.assertIn('/api/finance/profit-loss/', source)
        self.assertIn('profitlossshowcharttooltip', source)
        self.assertIn('pnl-chart-tooltip', source)
        self.assertIn('profitlosspreviewattachment', source)
        self.assertIn('previeweventfile(', source)
        self.assertIn('profitlossexpensecategorymarkup', source)
        self.assertIn('profitlossdepartmentmeta', source)
        self.assertIn('profitlosssolidcolour', source)
        self.assertIn("profitlosschartcolour(group, colourindex, row)", source)
        self.assertIn('pnl-budget-variance', source)
        self.assertIn('.pnl-budget-variance.is-under', css_source)
        self.assertIn('.pnl-budget-variance.is-over', css_source)
        self.assertNotIn('<th>department</th>', source)
        self.assertNotIn('>view in manpower</button>', source)
        self.assertIn('aria-label="open crew &amp; vendors"', source)
        self.assertNotIn('<h3>expense categories</h3>', source)
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
        self.assertIn("['accepted', 'cancelled']", source)
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
        self.assertIn("const invoicepath = `/invoices/${encodeuricomponent(current.id)}`", source)
        self.assertIn("showsection('invoices', { updatehistory: false })", source)
        self.assertNotIn("showsection('invoices', { loaddetail: false })", source)
        self.assertIn('#111827 calc(50% - 1px)', css_source)
        self.assertIn('financeexportquotationbutton', source)
        self.assertIn("['draft', 'sent']", source)
        self.assertIn('finance-loading-spinner', source)
        self.assertIn('promise.all([', source)
        self.assertIn('snapshot view', source)
        self.assertIn('<th>date</th>', source)
        self.assertIn('you can press add now', source)
        self.assertIn('abortcontroller', source)
        save_current_source = source.split(
            'async function financesavecurrent(', 1
        )[1].split('async function financeflushpendingsave(', 1)[0]
        self.assertIn('if (financestate.activesaves.size)', save_current_source)
        self.assertIn("state.textcontent = 'waiting to save...'", save_current_source)
        self.assertIn(
            'financemergedocumentconflict(\n        localsnapshot,\n        newestlocal,\n        response.data',
            save_current_source,
        )
        self.assertIn(
            'rebased.documentversion = response.data.documentversion',
            save_current_source,
        )
        self.assertIn('iscontainer', source)
        self.assertIn('containeritems', source)
        self.assertIn('financegroupequivalentcontainers', source)
        self.assertIn('matching containers', source)
        self.assertIn('financedropdepartment', source)
        self.assertIn('finance-department-drag-handle\" draggable=\"true', source)
        self.assertIn("closest('.finance-department-row')", source)
        self.assertIn("financeaddschedulerow('show')", source)
        self.assertIn("financeaddschedulerow('setup')", source)
        self.assertIn("financeaddschedulerow('teardown')", source)
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

    def test_payment_terms_and_laptop_sidebar_use_compact_controls(self):
        root = Path(app_module.__file__).resolve().parent
        source = (root / 'static' / 'js' / 'finance.js').read_text(
            encoding='utf-8'
        )
        compact_styles = (root / 'static' / 'css' / 'split-screen.css').read_text(
            encoding='utf-8'
        )
        payment_start = source.index('function financePaymentTermsMarkup(')
        payment_end = source.index(
            'function financeRememberPaymentTermOption(', payment_start
        )
        payment_source = source[payment_start:payment_end]

        self.assertIn("currentValue || '30 Days'", payment_source)
        self.assertIn('id="financePaymentTermsInput"', payment_source)
        self.assertIn('role="combobox"', payment_source)
        self.assertIn('id="financePaymentTermsResults"', payment_source)
        self.assertIn('role="listbox"', payment_source)
        self.assertIn('role="option"', payment_source)
        self.assertIn('function financeShowPaymentTermSuggestions(', payment_source)
        self.assertIn('function financeChoosePaymentTerm(', payment_source)
        self.assertNotIn('<select', payment_source)
        self.assertNotIn('financeCustomPaymentTerms', payment_source)
        self.assertIn(
            '@media (min-width: 1301px) and (max-width: 1512px) and (max-height: 982px)',
            compact_styles,
        )
        self.assertIn('--ui-scale: 0.8;', compact_styles)
        self.assertIn('html.browser-safari body', compact_styles)
        self.assertIn('zoom: 1;', compact_styles)
        self.assertIn('transform: scale(var(--ui-scale));', compact_styles)
        self.assertIn('max-height: calc(var(--scaled-dvh) - 8px);', compact_styles)
        self.assertIn('.finance-quotation-summary-card', compact_styles)
        self.assertIn('.finance-event-pairing-card .finance-picker-button', compact_styles)

        viewport_bound_sources = {
            'finance.css': root / 'static' / 'css' / 'finance.css',
            'invoices.css': root / 'static' / 'css' / 'invoices.css',
            'accounting.css': root / 'static' / 'css' / 'accounting.css',
            'workforce-admin.css': root / 'static' / 'css' / 'workforce-admin.css',
            'worker.css': root / 'static' / 'css' / 'worker.css',
            'vehicles.css': root / 'static' / 'css' / 'vehicles.css',
        }
        for name, path in viewport_bound_sources.items():
            with self.subTest(name=name):
                self.assertIn(
                    'var(--scaled-', path.read_text(encoding='utf-8')
                )

        overlay_sources = [
            root / 'static' / 'js' / 'app.js',
            root / 'static' / 'js' / 'custom-select.js',
            root / 'static' / 'js' / 'events-overview.js',
            root / 'static' / 'js' / 'finance.js',
            root / 'static' / 'js' / 'invoices.js',
            root / 'static' / 'js' / 'costing.js',
            root / 'static' / 'js' / 'workforce-admin.js',
            root / 'static' / 'js' / 'workforce-schedule.js',
        ]
        for path in overlay_sources:
            with self.subTest(overlay=path.name):
                self.assertIn(
                    'showbaseViewport', path.read_text(encoding='utf-8')
                )

    def test_draft_quotation_can_create_a_planning_event_without_acceptance(self):
        quotation = self.create_quote('Early Planning')
        quotation['eventLocation'] = 'Marina Bay Sands'
        quotation['showDate'] = '2026-09-12'
        quotation['lineItems'] = [{
            'id': 'early-line',
            'catalogKey': 'inventory|l-acoustics|sb18-iii',
            'sourceAssetIds': ['AX#01'],
            'brand': 'L-Acoustics',
            'model': 'SB18 III',
            'description': 'Subwoofer',
            'department': 'Audio',
            'departmentCode': 'AX',
            'quantity': 1,
            'days': 1,
            'unitPrice': 100,
        }]
        saved = self.client.put(
            f"/api/quotations/{quotation['id']}", json=quotation,
        ).get_json()['data']

        response = self.client.post(
            f"/api/quotations/{quotation['id']}/create-event", json={},
        )

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        created = response.get_json()['data']
        self.assertEqual(created['status'], 'draft')
        self.assertFalse(created.get('acceptedAt'))
        self.assertTrue(created['eventId'])
        event = self.data_manager.events[created['eventId']]
        self.assertEqual(event.name, 'Early Planning')
        self.assertEqual(event.state, 'New')
        self.assertEqual(len(event.prepared_items), 1)

    def test_draft_quotation_event_creation_requires_event_details(self):
        quotation = self.create_quote('Incomplete Planning Event')

        missing_details = self.client.post(
            f"/api/quotations/{quotation['id']}/create-event", json={},
        )

        self.assertEqual(missing_details.status_code, 400)
        self.assertIn('Location is required', missing_details.get_json()['error'])
        self.assertFalse(self.data_manager.events)

        quotation['eventLocation'] = 'Suntec Convention Centre'
        quotation = self.client.put(
            f"/api/quotations/{quotation['id']}", json=quotation,
        ).get_json()['data']
        missing_schedule = self.client.post(
            f"/api/quotations/{quotation['id']}/create-event", json={},
        )

        self.assertEqual(missing_schedule.status_code, 400)
        self.assertIn(
            'schedule date',
            missing_schedule.get_json()['error'].lower(),
        )
        self.assertFalse(self.data_manager.events)

    def test_managed_event_tracks_quotation_metadata_and_owners(self):
        quotation = self.create_quote('Original Event Name')
        quotation.update({
            'eventLocation': 'Original Venue',
            'showDate': '2026-09-12',
            'salespersonUsername': 'bob',
        })
        quotation = self.client.put(
            f"/api/quotations/{quotation['id']}", json=quotation,
        ).get_json()['data']
        self.login('bob')
        created = self.client.post(
            f"/api/quotations/{quotation['id']}/create-event", json={},
        ).get_json()['data']
        event = self.data_manager.events[created['eventId']]

        self.assertEqual(set(event.assigned_users), {'alice', 'bob'})

        updated = {
            **created,
            'projectName': 'Updated Event Name',
            'title': 'Updated Event Name',
            'eventLocation': 'Updated Venue',
            'rehearsalDate': '2026-09-10',
            'showDate': '2026-09-13',
        }
        response = self.client.put(
            f"/api/quotations/{quotation['id']}", json=updated,
        )

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        event = self.data_manager.events[created['eventId']]
        self.assertEqual(event.name, 'Updated Event Name')
        self.assertEqual(event.location, 'Updated Venue')
        self.assertEqual(event.start_date, '20260910')
        self.assertEqual(event.end_date, '20260913')

    def test_invoice_plans_only_start_from_accepted_quotations_and_track_installments(self):
        draft = self.create_quote('Not Ready For Invoicing')
        listing = self.client.get('/api/invoice-plans')
        self.assertEqual(listing.status_code, 200, listing.get_data(as_text=True))
        self.assertNotIn(
            draft['id'],
            [row['quotation']['id'] for row in listing.get_json()['data']],
        )

        draft['lineItems'] = [{
            'id': 'invoice-plan-line',
            'description': 'Production package',
            'department': 'Audio',
            'departmentCode': 'AX',
            'days': 1,
            'quantity': 1,
            'uom': 'lot',
            'unitPrice': 1000,
            'discountPercent': 0,
            'subprojectId': 'main',
        }]
        accepted_response = self.client.put(
            f"/api/quotations/{draft['id']}",
            json={**draft, 'status': 'accepted'},
        )
        self.assertEqual(
            accepted_response.status_code, 200,
            accepted_response.get_data(as_text=True),
        )
        accepted = accepted_response.get_json()['data']

        listing = self.client.get('/api/invoice-plans').get_json()['data']
        self.assertIn(accepted['id'], [row['quotation']['id'] for row in listing])

        plan_response = self.client.put(
            f"/api/invoice-plans/{accepted['id']}",
            json={
                'status': 'sent',
                'strategy': 'deposit',
                'strategyLabel': '50% deposit / 50% balance',
                'installments': [
                    {
                        'id': 'deposit',
                        'label': 'Deposit',
                        'mode': 'percentage',
                        'value': 50,
                        'dueDate': '2026-08-10',
                    },
                    {
                        'id': 'balance',
                        'label': 'Balance after show',
                        'mode': 'percentage',
                        'value': 50,
                        'dueDate': '2026-09-10',
                    },
                ],
                'payments': [],
            },
        )
        self.assertEqual(plan_response.status_code, 200, plan_response.get_data(as_text=True))
        plan = plan_response.get_json()['data']['plan']
        self.assertEqual(plan['status'], 'draft')
        accepted_total = accepted['totals']['total']
        self.assertEqual(plan['summary']['planned'], accepted_total)
        self.assertEqual(
            [row['amount'] for row in plan['installments']],
            [accepted_total / 2, accepted_total / 2],
        )

        detail_before_issue = self.client.get(
            f"/api/invoice-plans/{accepted['id']}"
        ).get_json()['data']
        self.assertTrue(detail_before_issue['nextInvoiceNumber'])
        directory_before_issue = self.client.get(
            '/api/invoice-plans'
        ).get_json()['data']
        listed_before_issue = next(
            row for row in directory_before_issue
            if row['quotation']['id'] == accepted['id']
        )
        self.assertEqual(listed_before_issue['plan']['invoiceNumber'], '')

        issued_response = self.client.post(
            f"/api/invoice-plans/{accepted['id']}/installments/deposit/issue",
            json={
                'invoiceDate': '2026-08-10', 'status': 'sent',
                'number': 'CLIENT-INV-900',
            },
        )
        self.assertEqual(issued_response.status_code, 201, issued_response.get_data(as_text=True))
        invoice = issued_response.get_json()['data']
        self.assertEqual(invoice['invoiceAmount'], accepted_total / 2)
        self.assertEqual(invoice['invoiceLabel'], 'Deposit')
        self.assertEqual(invoice['sourceQuotationNumber'], accepted['number'])
        self.assertEqual(invoice['number'], 'CLIENT-INV-900')

        duplicate_number = self.client.post(
            f"/api/invoice-plans/{accepted['id']}/installments/balance/issue",
            json={'invoiceDate': '2026-08-10', 'number': 'client-inv-900'},
        )
        self.assertEqual(
            duplicate_number.status_code, 409,
            duplicate_number.get_data(as_text=True),
        )
        self.assertEqual(
            duplicate_number.get_json()['code'], 'invoice_number_conflict'
        )

        refreshed_plan = self.client.get(
            f"/api/invoice-plans/{accepted['id']}"
        ).get_json()['data']
        deposit = refreshed_plan['plan']['installments'][0]
        self.assertEqual(deposit['invoiceNumber'], invoice['number'])
        self.assertEqual(
            refreshed_plan['plan']['summary']['invoiced'], accepted_total / 2
        )
        invoice_pdf = self.client.get(f"/api/invoices/{invoice['id']}/pdf")
        invoice_text = '\n'.join(
            page.extract_text() or ''
            for page in PdfReader(io.BytesIO(invoice_pdf.data)).pages
        )
        self.assertNotIn('Paid on', invoice_text)
        self.assertIn('Deposit', invoice_text)
        self.assertNotIn('Invoiced to date', invoice_text)
        self.assertNotIn('Balance remaining', invoice_text)
        self.assertIn('AMOUNT DUE', invoice_text)

    def test_invoice_plan_defaults_new_installments_to_thirty_days(self):
        quotation = self.create_quote('Default Due Date')
        quotation['lineItems'] = [{
            'id': 'due-date-line',
            'description': 'Production package',
            'department': 'Audio',
            'days': 1,
            'quantity': 1,
            'unitPrice': 500,
        }]
        accepted = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json={**quotation, 'status': 'accepted'},
        ).get_json()['data']

        response = self.client.put(
            f"/api/invoice-plans/{accepted['id']}",
            json={
                'strategy': 'full',
                'installments': [{
                    'id': 'full', 'label': 'Full payment',
                    'mode': 'percentage', 'value': 100,
                }],
            },
        )

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        expected_due_date = (datetime.now() + timedelta(days=30)).strftime('%Y-%m-%d')
        self.assertEqual(
            response.get_json()['data']['plan']['installments'][0]['dueDate'],
            expected_due_date,
        )

    def test_invoice_page_removes_plans_when_quotation_is_no_longer_ready(self):
        quotation = self.create_quote('Invoice Eligibility')
        quotation['lineItems'] = [{
            'id': 'eligibility-line', 'description': 'Production package',
            'department': 'Audio', 'days': 1, 'quantity': 1,
            'unitPrice': 100,
        }]
        accepted = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json={**quotation, 'status': 'accepted'},
        ).get_json()['data']
        self.client.put(
            f"/api/invoice-plans/{accepted['id']}",
            json={'installments': [{
                'id': 'full', 'label': 'Full payment',
                'mode': 'percentage', 'value': 100,
            }]},
        )
        self.assertIn(
            accepted['id'],
            [
                row['quotation']['id']
                for row in self.client.get('/api/invoice-plans').get_json()['data']
            ],
        )

        reverted = self.client.put(
            f"/api/quotations/{accepted['id']}",
            json={**accepted, 'status': 'draft'},
        )
        self.assertEqual(reverted.status_code, 200, reverted.get_data(as_text=True))
        self.assertEqual(reverted.get_json()['data']['status'], 'draft')
        self.assertNotIn(
            accepted['id'],
            [
                row['quotation']['id']
                for row in self.client.get('/api/invoice-plans').get_json()['data']
            ],
        )
        direct = self.client.get(f"/api/invoice-plans/{accepted['id']}")
        self.assertEqual(direct.status_code, 409, direct.get_data(as_text=True))
        self.assertEqual(
            direct.get_json()['code'], 'quotation_not_invoice_ready'
        )
        stale_issue = self.client.post(
            f"/api/invoice-plans/{accepted['id']}/installments/full/issue",
            json={},
        )
        self.assertEqual(
            stale_issue.status_code, 409, stale_issue.get_data(as_text=True)
        )

        cancelled_quote = self.create_quote('Cancelled Eligibility')
        cancelled = self.client.put(
            f"/api/quotations/{cancelled_quote['id']}",
            json={**cancelled_quote, 'status': 'cancelled'},
        ).get_json()['data']
        self.client.put(
            f"/api/invoice-plans/{cancelled['id']}",
            json={'installments': [{
                'id': 'cancellation', 'label': 'Cancellation fee',
                'mode': 'amount', 'value': 50,
            }]},
        )
        resent = self.client.put(
            f"/api/quotations/{cancelled['id']}",
            json={
                **cancelled, 'status': 'sent',
                'sentDate': datetime.now().strftime('%Y-%m-%d'),
            },
        )
        self.assertEqual(resent.status_code, 200, resent.get_data(as_text=True))
        self.assertEqual(resent.get_json()['data']['status'], 'sent')
        self.assertNotIn(
            cancelled['id'],
            [
                row['quotation']['id']
                for row in self.client.get('/api/invoice-plans').get_json()['data']
            ],
        )

    def test_first_invoice_cannot_exceed_accepted_quotation_total(self):
        quotation = self.create_quote('First Invoice Overage')
        quotation['lineItems'] = [{
            'id': 'overage-line', 'description': 'Production package',
            'department': 'Audio', 'days': 1, 'quantity': 1, 'unitPrice': 100,
        }]
        accepted = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json={**quotation, 'status': 'accepted'},
        ).get_json()['data']
        plan_response = self.client.put(
            f"/api/invoice-plans/{accepted['id']}",
            json={
                'strategy': 'custom',
                'installments': [{
                    'id': 'too-large', 'label': 'Too large',
                    'mode': 'amount', 'value': accepted['totals']['total'] + 1,
                }],
            },
        )
        self.assertEqual(plan_response.status_code, 200, plan_response.get_data(as_text=True))

        issued = self.client.post(
            f"/api/invoice-plans/{accepted['id']}/installments/too-large/issue",
            json={},
        )

        self.assertEqual(issued.status_code, 409, issued.get_data(as_text=True))
        self.assertIn('exceed', issued.get_json()['error'].lower())
        self.assertFalse([
            row for row in self.client.get('/api/invoices').get_json()['data']
            if row.get('sourceQuotationId') == accepted['id']
        ])

    def test_invoice_plan_merges_non_overlapping_stale_edits(self):
        quotation = self.create_quote('Concurrent Invoice Plan')
        quotation['lineItems'] = [{
            'id': 'concurrent-plan-line', 'description': 'Production package',
            'department': 'Audio', 'days': 1, 'quantity': 1, 'unitPrice': 100,
        }]
        accepted = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json={**quotation, 'status': 'accepted'},
        ).get_json()['data']
        base = self.client.get(
            f"/api/invoice-plans/{accepted['id']}"
        ).get_json()['data']['plan']

        first = self.client.put(
            f"/api/invoice-plans/{accepted['id']}",
            json={**base, 'strategyLabel': 'Milestone billing', '_baseDocument': base},
        )
        self.assertEqual(first.status_code, 200, first.get_data(as_text=True))
        stale_details = dict(base.get('invoiceDetails') or {})
        stale_details['reference'] = 'PO-CONCURRENT'
        second = self.client.put(
            f"/api/invoice-plans/{accepted['id']}",
            json={
                **base,
                'invoiceDetails': stale_details,
                '_baseDocument': base,
            },
        )

        self.assertEqual(second.status_code, 200, second.get_data(as_text=True))
        merged = second.get_json()['data']['plan']
        self.assertEqual(merged['strategyLabel'], 'Milestone billing')
        self.assertEqual(merged['invoiceDetails']['reference'], 'PO-CONCURRENT')
        self.assertGreater(merged['documentVersion'], base['documentVersion'])

    def test_issued_invoice_survives_plan_switch_and_blocks_duplicate_issue(self):
        quotation = self.create_quote('Immutable Issued Invoice')
        quotation['lineItems'] = [{
            'id': 'immutable-invoice-line',
            'description': 'Production package',
            'department': 'Audio',
            'days': 1,
            'quantity': 1,
            'unitPrice': 1000,
        }]
        accepted = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json={**quotation, 'status': 'accepted'},
        ).get_json()['data']
        saved = self.client.put(
            f"/api/invoice-plans/{accepted['id']}",
            json={
                'strategy': 'full',
                'installments': [{
                    'id': 'issued-full', 'label': 'Full payment',
                    'mode': 'percentage', 'value': 100,
                }],
            },
        )
        self.assertEqual(saved.status_code, 200, saved.get_data(as_text=True))
        issued = self.client.post(
            f"/api/invoice-plans/{accepted['id']}/installments/issued-full/issue",
            json={'invoiceDate': '2026-08-10'},
        )
        self.assertEqual(issued.status_code, 201, issued.get_data(as_text=True))
        invoice_id = issued.get_json()['data']['id']

        switched = self.client.put(
            f"/api/invoice-plans/{accepted['id']}",
            json={
                'strategy': 'custom',
                'strategyLabel': 'Custom installment plan',
                'installments': [{
                    'id': 'duplicate-full', 'label': 'Another full payment',
                    'mode': 'percentage', 'value': 100,
                }],
            },
        )
        self.assertEqual(switched.status_code, 200, switched.get_data(as_text=True))
        installments = switched.get_json()['data']['plan']['installments']
        retained = next(row for row in installments if row['id'] == 'issued-full')
        self.assertEqual(retained['invoiceId'], invoice_id)
        self.assertEqual(retained['amount'], accepted['totals']['total'])

        duplicate = self.client.post(
            f"/api/invoice-plans/{accepted['id']}/installments/duplicate-full/issue",
            json={'invoiceDate': '2026-08-10'},
        )
        self.assertEqual(duplicate.status_code, 409, duplicate.get_data(as_text=True))
        self.assertIn('already been invoiced', duplicate.get_json()['error'])

    def test_draft_invoice_details_are_editable_then_lock_when_sent(self):
        quotation = self.create_quote('Draft Invoice Details')
        quotation['lineItems'] = [{
            'id': 'draft-details-line',
            'description': 'Production package',
            'department': 'Audio',
            'days': 1,
            'quantity': 1,
            'unitPrice': 600,
        }]
        accepted = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json={**quotation, 'status': 'accepted'},
        ).get_json()['data']
        saved = self.client.put(
            f"/api/invoice-plans/{accepted['id']}",
            json={
                'strategy': 'full',
                'installments': [{
                    'id': 'draft-invoice', 'label': 'Initial label',
                    'mode': 'percentage', 'value': 100,
                    'dueDate': '2026-09-01',
                }],
            },
        ).get_json()['data']
        exported = self.client.post(
            f"/api/invoice-plans/{accepted['id']}/installments/draft-invoice/export",
            json={'invoiceDate': '2026-08-10'},
        )
        self.assertEqual(exported.status_code, 201, exported.get_data(as_text=True))
        invoice_id = exported.get_json()['data']['id']

        draft_plan = exported.get_json()['plan']['plan']
        draft_plan['installments'][0].update({
            'label': 'Final production invoice',
            'mode': 'amount',
            'value': 450,
            'dueDate': '2026-09-15',
        })
        edited = self.client.put(
            f"/api/invoice-plans/{accepted['id']}", json=draft_plan,
        )
        self.assertEqual(edited.status_code, 200, edited.get_data(as_text=True))
        edited_invoice = self.client.get(
            f"/api/invoices/{invoice_id}"
        ).get_json()['data']
        self.assertEqual(edited_invoice['invoiceLabel'], 'Final production invoice')
        self.assertEqual(edited_invoice['invoiceAmount'], 450)
        self.assertEqual(edited_invoice['dueDate'], '2026-09-15')
        edited_pdf = self.client.get(f"/api/invoices/{invoice_id}/pdf")
        edited_pdf_text = '\n'.join(
            page.extract_text() or ''
            for page in PdfReader(io.BytesIO(edited_pdf.data)).pages
        )
        self.assertIn('Final production invoice', edited_pdf_text)
        self.assertNotIn('Initial label', edited_pdf_text)

        edited_plan = edited.get_json()['data']['plan']
        edited_plan['installments'][0]['label'] = ''
        blanked = self.client.put(
            f"/api/invoice-plans/{accepted['id']}", json=edited_plan,
        )
        self.assertEqual(blanked.status_code, 200, blanked.get_data(as_text=True))
        self.assertEqual(
            blanked.get_json()['data']['plan']['installments'][0]['label'], ''
        )
        blank_invoice = self.client.get(
            f"/api/invoices/{invoice_id}"
        ).get_json()['data']
        self.assertEqual(blank_invoice['invoiceLabel'], '')
        blank_pdf = self.client.get(f"/api/invoices/{invoice_id}/pdf")
        blank_pdf_text = '\n'.join(
            page.extract_text() or ''
            for page in PdfReader(io.BytesIO(blank_pdf.data)).pages
        )
        self.assertNotIn('Final production invoice', blank_pdf_text)

        sent = self.client.put(
            f"/api/invoices/{invoice_id}", json={'status': 'sent'},
        )
        self.assertEqual(sent.status_code, 200, sent.get_data(as_text=True))
        sent_due_date = sent.get_json()['data']['dueDate']
        locked_plan = self.client.get(
            f"/api/invoice-plans/{accepted['id']}"
        ).get_json()['data']['plan']
        locked_plan['installments'][0].update({
            'label': 'Should not replace sent label',
            'mode': 'percentage',
            'value': 25,
            'dueDate': '2026-12-31',
        })
        saved_locked = self.client.put(
            f"/api/invoice-plans/{accepted['id']}", json=locked_plan,
        )
        self.assertEqual(saved_locked.status_code, 200, saved_locked.get_data(as_text=True))
        retained = saved_locked.get_json()['data']['plan']['installments'][0]
        self.assertEqual(retained['label'], '')
        self.assertEqual(retained['mode'], 'amount')
        self.assertEqual(retained['value'], 450)
        self.assertEqual(retained['dueDate'], sent_due_date)

        direct_edit = self.client.put(
            f"/api/invoices/{invoice_id}",
            json={'invoiceLabel': 'Direct sent edit'},
        )
        self.assertEqual(direct_edit.status_code, 409, direct_edit.get_data(as_text=True))

    def test_paid_confirmation_button_has_explicit_visible_style(self):
        invoice_source = Path('static/js/invoices.js').read_text(encoding='utf-8')
        invoice_css = Path('static/css/invoices.css').read_text(encoding='utf-8')
        self.assertIn('class="btn invoice-paid-confirm"', invoice_source)
        self.assertIn('.invoice-paid-modal .invoice-paid-confirm', invoice_css)
        self.assertIn(
            'background: var(--invoice-green, var(--company-theme-color, #0f766e)) !important',
            invoice_css,
        )

    def test_invoice_summary_status_menu_uses_viewport_portal(self):
        invoice_source = Path('static/js/invoices.js').read_text(encoding='utf-8')
        invoice_css = Path('static/css/invoices.css').read_text(encoding='utf-8')
        self.assertIn('portal.dataset.invoiceStatusPortal = id', invoice_source)
        self.assertIn('document.body.appendChild(portal)', invoice_source)
        self.assertIn('portal.style.top =', invoice_source)
        self.assertIn('portal.style.maxHeight =', invoice_source)
        self.assertIn('function invoiceCloseStatusMenus', invoice_source)
        self.assertIn('overscroll-behavior: contain', invoice_css)

    def test_cancelled_invoice_rows_use_black_strikethrough(self):
        invoice_source = Path('static/js/invoices.js').read_text(encoding='utf-8')
        invoice_css = Path('static/css/invoices.css').read_text(encoding='utf-8')
        self.assertIn("plan.status || '').toLowerCase() === 'cancelled'", invoice_source)
        self.assertIn("['cancelled', 'void'].includes", invoice_source)
        self.assertIn('tr.is-cancelled td', invoice_css)
        self.assertIn('#111827 calc(50% - 1px)', invoice_css)

    def test_invoice_discount_supports_percentage_amount_and_pdf_output(self):
        quotation = self.create_quote('Invoice Discount Project')
        quotation['lineItems'] = [{
            'id': 'invoice-discount-line',
            'description': 'Production package',
            'department': 'Audio',
            'days': 1,
            'quantity': 1,
            'unitPrice': 1000,
        }]
        accepted = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json={**quotation, 'status': 'accepted'},
        ).get_json()['data']
        percentage = self.client.put(
            f"/api/invoice-plans/{accepted['id']}",
            json={
                'strategy': 'full',
                'invoiceDiscountMode': 'percentage',
                'invoiceDiscountValue': 10,
                'installments': [{
                    'id': 'discounted-full', 'label': 'Discounted invoice',
                    'mode': 'percentage', 'value': 100,
                }],
            },
        )
        self.assertEqual(percentage.status_code, 200, percentage.get_data(as_text=True))
        percentage_plan = percentage.get_json()['data']['plan']
        quotation_total = accepted['totals']['total']
        quotation_pre_tax = accepted['totals']['netSubtotal']
        tax_rate = accepted['taxRate']
        percentage_discount = round(quotation_pre_tax * 0.10, 2)
        percentage_pre_tax = round(quotation_pre_tax - percentage_discount, 2)
        percentage_tax = round(percentage_pre_tax * tax_rate / 100, 2)
        percentage_total = round(percentage_pre_tax + percentage_tax, 2)
        self.assertEqual(
            percentage_plan['summary']['invoiceDiscountAmount'],
            percentage_discount,
        )
        self.assertEqual(percentage_plan['summary']['adjustedTotal'], percentage_total)
        self.assertEqual(percentage_plan['installments'][0]['amount'], percentage_total)

        percentage_plan.update({
            'invoiceDiscountMode': 'amount',
            'invoiceDiscountValue': 125,
        })
        fixed = self.client.put(
            f"/api/invoice-plans/{accepted['id']}", json=percentage_plan,
        )
        self.assertEqual(fixed.status_code, 200, fixed.get_data(as_text=True))
        fixed_plan = fixed.get_json()['data']['plan']
        self.assertEqual(fixed_plan['summary']['invoiceDiscountAmount'], 125)
        discounted_pre_tax = round(quotation_pre_tax - 125, 2)
        discounted_tax = round(discounted_pre_tax * tax_rate / 100, 2)
        discounted_total = round(discounted_pre_tax + discounted_tax, 2)
        self.assertEqual(fixed_plan['summary']['adjustedTotal'], discounted_total)
        self.assertEqual(fixed_plan['installments'][0]['amount'], discounted_total)

        issued = self.client.post(
            f"/api/invoice-plans/{accepted['id']}/installments/discounted-full/issue",
            json={'invoiceDate': '2026-08-10'},
        )
        self.assertEqual(issued.status_code, 201, issued.get_data(as_text=True))
        invoice = issued.get_json()['data']
        self.assertEqual(invoice['invoiceDiscountMode'], 'amount')
        self.assertEqual(invoice['invoiceDiscountAmount'], 125)
        self.assertEqual(invoice['invoiceAmount'], discounted_total)

        pdf = self.client.get(f"/api/invoices/{invoice['id']}/pdf")
        pdf_text = '\n'.join(
            page.extract_text() or ''
            for page in PdfReader(io.BytesIO(pdf.data)).pages
        )
        self.assertIn('Total (as per quotation)', pdf_text)
        self.assertIn('Discounts', pdf_text)
        self.assertIn('-$125.00', pdf_text)
        self.assertIn(f'${discounted_total:,.2f}', pdf_text)
        self.assertIn(f'GST amount included ({tax_rate:g}%)', pdf_text)
        self.assertIn(f'${discounted_tax:,.2f}', pdf_text)
        self.assertNotIn('Total after GST', pdf_text)
        pdf_lines = [line.strip() for line in pdf_text.splitlines()]
        summary_positions = {
            label: pdf_lines.index(label)
            for label in ('Total (as per quotation)', 'Discounts', 'Grand Total', 'AMOUNT DUE')
        }
        gst_position = pdf_lines.index(f'GST amount included ({tax_rate:g}%)')
        self.assertLess(summary_positions['Total (as per quotation)'], summary_positions['Discounts'])
        self.assertLess(summary_positions['Discounts'], summary_positions['Grand Total'])
        self.assertLess(summary_positions['Grand Total'], gst_position)
        self.assertLess(gst_position, summary_positions['AMOUNT DUE'])

        sent = self.client.put(
            f"/api/invoices/{invoice['id']}", json={'status': 'sent'},
        )
        self.assertEqual(sent.status_code, 200, sent.get_data(as_text=True))
        issued_plan = self.client.get(
            f"/api/invoice-plans/{accepted['id']}"
        ).get_json()['data']['plan']
        issued_plan.update({
            'invoiceDiscountMode': 'percentage',
            'invoiceDiscountValue': 50,
        })
        locked = self.client.put(
            f"/api/invoice-plans/{accepted['id']}", json=issued_plan,
        )
        self.assertEqual(locked.status_code, 200, locked.get_data(as_text=True))
        locked_plan = locked.get_json()['data']['plan']
        self.assertEqual(locked_plan['invoiceDiscountMode'], 'amount')
        self.assertEqual(locked_plan['invoiceDiscountValue'], 125)
        self.assertEqual(locked_plan['installments'][0]['amount'], discounted_total)

        draft = self.client.put(
            f"/api/invoices/{invoice['id']}", json={'status': 'draft'},
        )
        self.assertEqual(draft.status_code, 200, draft.get_data(as_text=True))
        self.assertEqual(draft.get_json()['data']['status'], 'draft')

        invoice_source = Path('static/js/invoices.js').read_text(encoding='utf-8')
        self.assertIn('function invoiceUpdateDiscount', invoice_source)
        self.assertIn('Additional discount', invoice_source)

    def test_invoice_plan_has_independent_client_and_invoicing_details(self):
        quotation = self.create_quote('Quotation Project')
        quotation['lineItems'] = [{
            'id': 'invoice-details-line', 'description': 'Production services',
            'department': 'Audio', 'days': 1, 'quantity': 1, 'unitPrice': 100,
        }]
        quotation['client'] = {
            'salutation': 'Mr.', 'name': 'Original Client',
            'company': 'Original Co', 'phone': '+65 6000 0000',
            'email': 'original@example.com', 'address1': 'Old address',
        }
        quotation['eventLocation'] = 'Original venue'
        quotation['reference'] = 'PO-OLD'
        accepted = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json={**quotation, 'status': 'accepted'},
        ).get_json()['data']
        plan_response = self.client.get(
            f"/api/invoice-plans/{accepted['id']}"
        )
        self.assertEqual(
            plan_response.status_code, 200, plan_response.get_data(as_text=True)
        )
        plan = plan_response.get_json()['data']['plan']
        self.assertEqual(plan['invoiceDetails']['client']['name'], 'Original Client')
        self.assertEqual(plan['invoiceDetails']['reference'], 'PO-OLD')
        plan['invoiceDetails'].update({
            'client': {
                'salutation': 'Ms.', 'name': 'Invoice Client',
                'company': 'Invoice Co', 'phone': '+65 6111 1111',
                'email': 'invoice@example.com', 'address1': 'New address',
            },
            'projectName': 'Invoice Project',
            'eventLocation': 'Invoice venue',
            'salesperson': 'Custom Salesperson',
            'salespersonUsername': '',
            'reference': 'PO-NEW',
            'paymentTerms': '14 Days',
        })
        plan['installments'] = [{
            'id': 'invoice-details-full', 'label': 'Full payment',
            'mode': 'percentage', 'value': 100,
        }]
        saved = self.client.put(
            f"/api/invoice-plans/{accepted['id']}", json=plan,
        )
        self.assertEqual(saved.status_code, 200, saved.get_data(as_text=True))

        unchanged_quote = self.client.get(
            f"/api/quotations/{accepted['id']}"
        ).get_json()['data']
        self.assertEqual(unchanged_quote['projectName'], 'Quotation Project')
        self.assertEqual(unchanged_quote['client']['name'], 'Original Client')

        issued = self.client.post(
            f"/api/invoice-plans/{accepted['id']}/installments/invoice-details-full/export",
            json={'invoiceDate': '2026-08-10'},
        )
        self.assertEqual(issued.status_code, 201, issued.get_data(as_text=True))
        invoice = issued.get_json()['data']
        self.assertEqual(invoice['projectName'], 'Invoice Project')
        self.assertEqual(invoice['client']['name'], 'Invoice Client')
        self.assertEqual(invoice['eventLocation'], 'Invoice venue')
        self.assertEqual(invoice['salesperson'], 'Custom Salesperson')
        self.assertEqual(invoice['reference'], 'PO-NEW')
        self.assertEqual(invoice['paymentTerms'], '14 Days')

        edited_reference = self.client.put(
            f"/api/invoices/{invoice['id']}",
            json={
                'reference': 'PO-DIRECT-EDIT',
                'documentVersion': invoice['documentVersion'],
            },
        )
        self.assertEqual(
            edited_reference.status_code,
            200,
            edited_reference.get_data(as_text=True),
        )
        self.assertEqual(
            edited_reference.get_json()['data']['reference'],
            'PO-DIRECT-EDIT',
        )
        refreshed_plan = self.client.get(
            f"/api/invoice-plans/{accepted['id']}"
        ).get_json()['data']['plan']
        self.assertEqual(
            refreshed_plan['invoiceDetails']['reference'],
            'PO-DIRECT-EDIT',
        )
        directory_invoice = next(
            row for row in self.client.get(
                '/api/invoices?view=summary'
            ).get_json()['data']
            if row['id'] == invoice['id']
        )
        self.assertEqual(directory_invoice['reference'], 'PO-DIRECT-EDIT')

        known_clients = self.client.get('/api/clients').get_json()['data']
        self.assertIn('Invoice Client', [row['name'] for row in known_clients])

        invoice_source = Path('static/js/invoices.js').read_text(encoding='utf-8')
        self.assertIn('Client &amp; invoicing details', invoice_source)
        self.assertIn('function invoiceOpenClientPicker', invoice_source)
        self.assertIn('function invoiceUpdateDetail', invoice_source)
        self.assertIn('function invoiceEditReference', invoice_source)
        self.assertIn('<th>PO / Reference</th>', invoice_source)
        self.assertIn('function invoiceExportInstallment', invoice_source)

    def test_invoice_workspace_preserves_issued_rows_across_presets(self):
        invoice_source = Path('static/js/invoices.js').read_text(encoding='utf-8')
        invoice_css = Path('static/css/invoices.css').read_text(encoding='utf-8')
        self.assertIn('const issuedRows = existingRows.filter(item => item.invoiceId)', invoice_source)
        self.assertIn("invoiceDateFromToday(30)", invoice_source)
        self.assertIn("invoiceDueCountdown", invoice_source)
        self.assertIn("This quotation has already been invoiced in full", invoice_source)
        self.assertIn('.invoice-due-date-field > span button', invoice_css)

    def test_invoice_plan_payments_flow_to_invoice_pdf_and_balance_history(self):
        quotation = self.create_quote('Payment History Project')
        quotation['lineItems'] = [{
            'id': 'payment-plan-line',
            'description': 'Technical service',
            'department': 'Manpower',
            'departmentCode': 'MANPOWER',
            'days': 1,
            'quantity': 1,
            'uom': 'lot',
            'unitPrice': 400,
            'discountPercent': 0,
            'subprojectId': 'main',
        }]
        accepted = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json={**quotation, 'status': 'accepted'},
        ).get_json()['data']
        self.client.put(
            f"/api/invoice-plans/{accepted['id']}",
            json={
                'strategy': 'full',
                'strategyLabel': 'Full amount',
                'installments': [{
                    'id': 'full', 'label': 'Full payment',
                    'mode': 'percentage', 'value': 100,
                }],
                'payments': [],
            },
        )
        issued = self.client.post(
            f"/api/invoice-plans/{accepted['id']}/installments/full/issue",
            json={'invoiceDate': '2026-08-10'},
        ).get_json()['data']

        current_plan = self.client.get(
            f"/api/invoice-plans/{accepted['id']}"
        ).get_json()['data']['plan']
        paid_plan = self.client.put(
            f"/api/invoice-plans/{accepted['id']}",
            json={
                **current_plan,
                'status': 'partially-paid',
                'payments': [{
                    'id': 'client-deposit',
                    'date': '2026-08-11',
                    'label': 'Deposit received',
                    'amount': 150,
                }],
            },
        )
        self.assertEqual(paid_plan.status_code, 200, paid_plan.get_data(as_text=True))
        summary = paid_plan.get_json()['data']['plan']['summary']
        self.assertEqual(summary['paid'], 150)
        self.assertEqual(summary['due'], accepted['totals']['total'] - 150)

        pdf_response = self.client.get(f"/api/invoices/{issued['id']}/pdf")
        self.assertEqual(pdf_response.status_code, 200)
        pdf_text = '\n'.join(
            page.extract_text() or ''
            for page in PdfReader(io.BytesIO(pdf_response.data)).pages
        )
        self.assertIn('Amount paid on 11 August 2026', pdf_text)
        self.assertIn('Balance remaining', pdf_text)
        self.assertIn('AMOUNT DUE', pdf_text)
        self.assertNotIn('Invoiced to date', pdf_text)
        self.assertIn(
            f"${accepted['totals']['total'] - 150:,.2f}", pdf_text
        )

        receipt_response = self.client.get(
            f"/api/invoice-plans/{accepted['id']}/payments/client-deposit/receipt"
        )
        self.assertEqual(
            receipt_response.status_code, 200,
            (
                receipt_response.get_data(as_text=True)
                if receipt_response.status_code != 200 else ''
            ),
        )
        receipt_text = '\n'.join(
            page.extract_text() or ''
            for page in PdfReader(io.BytesIO(receipt_response.data)).pages
        )
        self.assertIn('PAYMENT RECEIPT', receipt_text)
        self.assertIn('11 August 2026', receipt_text)
        self.assertIn('$150.00', receipt_text)
        self.assertIn('Deposit received', receipt_text)
        self.assertIn(accepted['number'], receipt_text)
        self.assertIn('Not allocated', receipt_text)

    def test_sent_invoice_pdf_is_frozen_when_payments_are_recorded(self):
        quotation = self.create_quote('Frozen Sent Invoice')
        quotation['lineItems'] = [{
            'id': 'frozen-invoice-line',
            'description': 'Production package',
            'department': 'Audio',
            'days': 1,
            'quantity': 1,
            'uom': 'lot',
            'unitPrice': 400,
            'discountPercent': 0,
            'subprojectId': 'main',
        }]
        accepted = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json={**quotation, 'status': 'accepted'},
        ).get_json()['data']
        self.client.put(
            f"/api/invoice-plans/{accepted['id']}",
            json={
                'strategy': 'full',
                'installments': [{
                    'id': 'frozen-full', 'label': 'Full payment',
                    'mode': 'percentage', 'value': 100,
                }],
            },
        )
        issued = self.client.post(
            f"/api/invoice-plans/{accepted['id']}/installments/frozen-full/issue",
            json={'invoiceDate': '2026-08-10', 'status': 'sent'},
        ).get_json()['data']

        def pdf_text():
            response = self.client.get(f"/api/invoices/{issued['id']}/pdf")
            self.assertEqual(response.status_code, 200)
            return '\n'.join(
                page.extract_text() or ''
                for page in PdfReader(io.BytesIO(response.data)).pages
            )

        sent_pdf_text = pdf_text()
        self.assertNotIn('Paid on', sent_pdf_text)

        current_plan = self.client.get(
            f"/api/invoice-plans/{accepted['id']}"
        ).get_json()['data']['plan']
        current_plan['status'] = 'partially-paid'
        current_plan['payments'] = [{
            'id': 'frozen-deposit',
            'date': '2026-08-11',
            'label': 'Deposit received',
            'amount': 150,
            'invoiceId': issued['id'],
        }]
        partial = self.client.put(
            f"/api/invoice-plans/{accepted['id']}", json=current_plan,
        )
        self.assertEqual(partial.status_code, 200, partial.get_data(as_text=True))
        self.assertEqual(partial.get_json()['data']['plan']['summary']['paid'], 150)
        partial_pdf_text = pdf_text()
        self.assertIn('Amount paid on 11 August 2026', partial_pdf_text)
        self.assertIn('Balance remaining', partial_pdf_text)
        self.assertIn('Production package', partial_pdf_text)

        paid = self.client.post(
            f"/api/invoices/{issued['id']}/mark-paid",
            json={'receivedDate': '2026-08-12'},
        )
        self.assertEqual(paid.status_code, 200, paid.get_data(as_text=True))
        self.assertEqual(paid.get_json()['plan']['plan']['summary']['due'], 0)
        paid_pdf_text = pdf_text()
        self.assertIn('Amount paid on 12 August 2026', paid_pdf_text)
        self.assertIn('Production package', paid_pdf_text)

        stored = self.client.get(
            f"/api/invoices/{issued['id']}"
        ).get_json()['data']
        self.assertEqual(stored['status'], 'paid')
        self.assertEqual(stored['invoiceSentSnapshot']['invoicePlanPayments'], [])

    def test_sent_invoice_can_return_to_draft_and_be_resnapshotted(self):
        quotation = self.create_quote('Editable Sent Invoice')
        quotation['lineItems'] = [{
            'id': 'editable-sent-line',
            'description': 'Production package',
            'department': 'Audio',
            'days': 1,
            'quantity': 1,
            'uom': 'lot',
            'unitPrice': 300,
            'discountPercent': 0,
            'subprojectId': 'main',
        }]
        accepted = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json={**quotation, 'status': 'accepted'},
        ).get_json()['data']
        self.client.put(
            f"/api/invoice-plans/{accepted['id']}",
            json={
                'strategy': 'full',
                'installments': [{
                    'id': 'editable-full', 'label': 'Original invoice',
                    'mode': 'percentage', 'value': 100,
                }],
            },
        )
        issued = self.client.post(
            f"/api/invoice-plans/{accepted['id']}/installments/editable-full/issue",
            json={'invoiceDate': '2026-08-10', 'status': 'sent'},
        ).get_json()['data']
        self.assertIn('invoiceSentSnapshot', issued)

        draft = self.client.put(
            f"/api/invoices/{issued['id']}",
            json={
                'status': 'draft',
                'invoiceLabel': 'Revised invoice',
                'dueDate': '2026-09-30',
            },
        )
        self.assertEqual(draft.status_code, 200, draft.get_data(as_text=True))
        draft_data = draft.get_json()['data']
        self.assertEqual(draft_data['status'], 'draft')
        self.assertNotIn('invoiceSentSnapshot', draft_data)
        self.assertEqual(draft_data['invoiceLabel'], 'Revised invoice')

    def test_invoice_workspace_requires_sales_access(self):
        self.login('no-sales')
        self.assertEqual(self.client.get('/api/invoice-plans').status_code, 403)
        self.assertEqual(
            self.client.get('/api/statements-of-account/companies').status_code,
            403,
        )
        self.assertEqual(
            self.client.get('/api/statements-of-account/pdf?company=Acme').status_code,
            403,
        )
        page = self.client.get('/invoices')
        self.assertEqual(page.status_code, 302)

    def test_invoice_workspace_navigation_and_assets_are_wired(self):
        app_source = APP_BUNDLE_SOURCE
        finance_source = Path('static/js/finance.js').read_text(encoding='utf-8')
        invoice_source = Path('static/js/invoices.js').read_text(encoding='utf-8')
        template_source = Path('templates/index.html').read_text(encoding='utf-8')
        self.assertIn("invoices: '/invoices'", app_source)
        self.assertIn('data-section="invoices">Invoices', finance_source)
        self.assertIn('function invoiceOpenPlan', invoice_source)
        self.assertIn('50% deposit / 50% balance', invoice_source)
        self.assertIn('+ Create plan', invoice_source)
        self.assertIn('Receipt PDF', invoice_source)
        self.assertIn('mineOnly: true', invoice_source)
        self.assertIn("params.set('mine', '1')", invoice_source)
        self.assertIn('invoice-list-mine-toggle', invoice_source)
        self.assertIn('My projects</button>', invoice_source)
        self.assertIn('listRequestVersion: 0', invoice_source)
        self.assertIn('if (!requestIsCurrent()) return;', invoice_source)
        self.assertIn('requestedMineOnly === invoiceState.mineOnly', invoice_source)
        self.assertIn('function invoiceEnsureSentModal', invoice_source)
        self.assertIn("await apiCall('/api/pdf-settings')", invoice_source)
        self.assertIn('invoiceStatusBadgeMarkup(plan.status)', invoice_source)
        self.assertIn('Invoice / Quotation', invoice_source)
        self.assertIn('function invoiceExportInstallment', invoice_source)
        self.assertIn('/installments/${encodeURIComponent(row.id)}/export', invoice_source)
        self.assertIn('function invoiceOpenSoaModal', invoice_source)
        self.assertIn('/api/statements-of-account/companies', invoice_source)
        self.assertIn('Create SOA', invoice_source)
        self.assertIn("filename='js/invoices.js'", template_source)

    def test_cancelled_quotation_can_create_a_cancellation_invoice_plan(self):
        quotation = self.create_quote('Cancelled Production')
        cancelled = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json={**quotation, 'status': 'cancelled'},
        ).get_json()['data']
        listing = self.client.get('/api/invoice-plans').get_json()['data']
        self.assertIn(cancelled['id'], [row['quotation']['id'] for row in listing])

        response = self.client.put(
            f"/api/invoice-plans/{cancelled['id']}",
            json={
                'strategy': 'custom',
                'strategyLabel': 'Cancellation fee',
                'installments': [{
                    'id': 'cancellation-fee',
                    'label': 'Cancellation fee',
                    'mode': 'amount',
                    'value': 250,
                }],
            },
        )
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertEqual(
            response.get_json()['data']['plan']['installments'][0]['amount'],
            250,
        )

    def test_marking_invoice_paid_records_payment_without_rewriting_pdf(self):
        quotation = self.create_quote('Paid Invoice Project')
        quotation['lineItems'] = [{
            'id': 'paid-invoice-line',
            'description': 'Cancellation administration',
            'department': 'General',
            'departmentCode': 'GEN',
            'days': 1,
            'quantity': 1,
            'uom': 'lot',
            'unitPrice': 200,
            'discountPercent': 0,
            'subprojectId': 'main',
        }]
        accepted = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json={**quotation, 'status': 'accepted'},
        ).get_json()['data']
        self.client.put(
            f"/api/invoice-plans/{accepted['id']}",
            json={
                'strategy': 'full',
                'strategyLabel': 'Full amount',
                'installments': [{
                    'id': 'full-payment',
                    'label': 'Final production invoice',
                    'mode': 'percentage',
                    'value': 100,
                }],
            },
        )
        invoice = self.client.post(
            f"/api/invoice-plans/{accepted['id']}/installments/full-payment/issue",
            json={'invoiceDate': '2026-08-10'},
        ).get_json()['data']

        paid_response = self.client.post(
            f"/api/invoices/{invoice['id']}/mark-paid",
            json={'receivedDate': '2026-08-12'},
        )
        self.assertEqual(
            paid_response.status_code, 200,
            paid_response.get_data(as_text=True),
        )
        paid = paid_response.get_json()
        self.assertEqual(paid['data']['status'], 'paid')
        self.assertEqual(paid['receivedDate'], '2026-08-12')
        self.assertEqual(paid['paymentAmount'], accepted['totals']['total'])
        payment = paid['plan']['plan']['payments'][0]
        self.assertEqual(payment['date'], '2026-08-12')
        self.assertEqual(payment['invoiceId'], invoice['id'])
        self.assertEqual(paid['plan']['plan']['summary']['due'], 0)

        pdf_response = self.client.get(f"/api/invoices/{invoice['id']}/pdf")
        self.assertEqual(pdf_response.status_code, 200)
        pdf_text = '\n'.join(
            page.extract_text() or ''
            for page in PdfReader(io.BytesIO(pdf_response.data)).pages
        )
        self.assertIn('Amount paid on 12 August 2026', pdf_text)
        self.assertIn('Balance remaining', pdf_text)
        self.assertIn('AMOUNT DUE', pdf_text)
        self.assertIn('Final production invoice', pdf_text)
        self.assertNotIn('Invoiced to date', pdf_text)
        self.assertIn(f"${accepted['totals']['total']:,.2f}", pdf_text)

    def test_invoice_can_be_renumbered_and_deleted_without_sticking_installment(self):
        quotation = self.create_quote('Invoice Actions Project')
        quotation['lineItems'] = [{
            'id': 'invoice-actions-line',
            'description': 'Administration services',
            'department': 'Administration',
            'days': 1,
            'quantity': 1,
            'unitPrice': 80,
        }]
        accepted = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json={**quotation, 'status': 'accepted'},
        ).get_json()['data']
        self.client.put(
            f"/api/invoice-plans/{accepted['id']}",
            json={
                'strategy': 'custom',
                'installments': [{
                    'id': 'admin-fee', 'label': 'Administration fee',
                    'mode': 'amount', 'value': 80,
                }],
            },
        )
        invoice = self.client.post(
            f"/api/invoice-plans/{accepted['id']}/installments/admin-fee/issue",
            json={},
        ).get_json()['data']

        renumbered = self.client.put(
            f"/api/invoices/{invoice['id']}",
            json={'number': 'SPECIAL-INV-42'},
        )
        self.assertEqual(renumbered.status_code, 200, renumbered.get_data(as_text=True))
        self.assertEqual(renumbered.get_json()['data']['number'], 'SPECIAL-INV-42')

        deleted = self.client.delete(f"/api/invoices/{invoice['id']}")
        self.assertEqual(deleted.status_code, 200, deleted.get_data(as_text=True))
        plan = self.client.get(
            f"/api/invoice-plans/{accepted['id']}"
        ).get_json()['data']['plan']
        installment = plan['installments'][0]
        self.assertFalse(installment['invoiceId'])
        self.assertFalse(installment['invoiceNumber'])
        self.assertEqual(installment['status'], 'planned')

    def test_statement_of_account_groups_invoices_by_company_not_contact_person(self):
        issued = []
        for index, contact_name in enumerate(('Alex Buyer', 'Jamie Buyer'), start=1):
            quotation = self.create_quote(f'Acme Project {index}')
            quotation['client'] = {
                'name': contact_name,
                'company': 'Acme Events Pte Ltd',
                'address1': '10 Event Street',
                'postalCode': '018956',
            }
            quotation['lineItems'] = [{
                'id': f'acme-line-{index}',
                'description': f'Production package {index}',
                'department': 'Production',
                'days': 1,
                'quantity': 1,
                'unitPrice': 100 * index,
            }]
            accepted = self.client.put(
                f"/api/quotations/{quotation['id']}",
                json={**quotation, 'status': 'accepted'},
            ).get_json()['data']
            installment_id = f'acme-installment-{index}'
            self.client.put(
                f"/api/invoice-plans/{accepted['id']}",
                json={'installments': [{
                    'id': installment_id,
                    'label': f'Invoice {index}',
                    'mode': 'percentage',
                    'value': 100,
                }]},
            )
            invoice_response = self.client.post(
                f"/api/invoice-plans/{accepted['id']}/installments/{installment_id}/issue",
                json={
                    'invoiceDate': '2026-08-10',
                    'number': f'ACME-INV-{index:02d}',
                },
            )
            self.assertEqual(
                invoice_response.status_code, 201,
                invoice_response.get_data(as_text=True),
            )
            issued.append(invoice_response.get_json()['data'])

        paid = self.client.post(
            f"/api/invoices/{issued[0]['id']}/mark-paid",
            json={'receivedDate': '2026-08-15'},
        )
        self.assertEqual(paid.status_code, 200, paid.get_data(as_text=True))

        companies = self.client.get(
            '/api/statements-of-account/companies'
        ).get_json()['data']
        acme = next(row for row in companies if row['company'] == 'Acme Events Pte Ltd')
        self.assertEqual(acme['invoiceCount'], 2)
        self.assertGreater(acme['outstanding'], 0)

        statement = self.client.get(
            '/api/statements-of-account/pdf',
            query_string={
                'company': 'acme events pte ltd',
                'statementDate': '2026-08-24',
            },
        )
        self.assertEqual(statement.status_code, 200)
        statement_text = '\n'.join(
            page.extract_text() or ''
            for page in PdfReader(io.BytesIO(statement.data)).pages
        )
        for expected in (
            'STATEMENT OF ACCOUNT', 'Acme Events Pte Ltd',
            'ACME-INV-01', 'ACME-INV-02',
            'Acme Project 1', 'Acme Project 2',
            'PAYMENTS RECEIVED', 'BALANCE OUTSTANDING',
        ):
            self.assertIn(expected, statement_text)
        self.assertNotIn('Alex Buyer', statement_text)
        self.assertNotIn('Jamie Buyer', statement_text)

    def test_statement_pdf_draws_logo_even_without_text_letterhead(self):
        from PIL import Image
        from statement_pdf import build_statement_of_account_pdf

        logo_path = Path(self.tempdir.name) / 'soa-logo.png'
        Image.new('RGB', (16, 8), '#0f766e').save(logo_path)
        pdf = build_statement_of_account_pdf(
            {
                'accountCompany': 'Logo Client Pte Ltd',
                'statementDate': '2026-08-24',
                'currency': 'SGD',
                'invoices': [],
            },
            company={
                'companyName': 'Showbase Test',
                'letterheadEnabled': False,
            },
            logo_path=str(logo_path),
        )
        page = PdfReader(io.BytesIO(pdf)).pages[0]
        self.assertTrue(page['/Resources'].get('/XObject'))

    def test_statement_logo_falls_back_to_company_branding(self):
        branding_folder = Path(self.tempdir.name) / 'branding'
        branding_folder.mkdir()
        logo_path = branding_folder / 'logo.png'
        logo_path.write_bytes(b'company-logo')
        with (
            patch.object(app_module, '_pdf_logo_path', return_value=''),
            patch.object(
                app_module,
                '_company_record_for_code',
                return_value={'frontendFolder': str(branding_folder)},
            ),
            patch.object(
                app_module,
                '_company_record_frontend_folder',
                return_value=str(branding_folder),
            ),
            patch.object(
                app_module,
                '_is_inherited_default_company_logo',
                return_value=False,
            ),
        ):
            resolved = app_module._pdf_effective_logo_path({}, 'SHOWBASE')
        self.assertEqual(resolved, str(logo_path))

    def test_invoice_project_status_is_derived_from_all_issued_invoices(self):
        quotation = self.create_quote('Milestone Billing')
        quotation['lineItems'] = [{
            'id': 'milestone-line', 'description': 'Production services',
            'department': 'Production', 'days': 1, 'quantity': 1,
            'unitPrice': 200,
        }]
        accepted = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json={**quotation, 'status': 'accepted'},
        ).get_json()['data']
        self.client.put(
            f"/api/invoice-plans/{accepted['id']}",
            json={'strategy': 'custom', 'installments': [
                {'id': 'deposit', 'label': 'Deposit', 'mode': 'amount', 'value': 100},
                {'id': 'balance', 'label': 'Balance', 'mode': 'amount', 'value': 100},
            ]},
        )
        first = self.client.post(
            f"/api/invoice-plans/{accepted['id']}/installments/deposit/issue",
            json={},
        ).get_json()['data']
        second = self.client.post(
            f"/api/invoice-plans/{accepted['id']}/installments/balance/issue",
            json={},
        ).get_json()['data']
        self.assertEqual(
            self.client.get(f"/api/invoice-plans/{accepted['id']}")
            .get_json()['data']['plan']['status'],
            'draft',
        )

        sent = self.client.put(
            f"/api/invoices/{first['id']}",
            json={
                'status': 'sent', 'invoiceSentDate': '2026-08-15',
                'paymentTermDays': 30,
            },
        )
        self.assertEqual(sent.status_code, 200, sent.get_data(as_text=True))
        self.assertEqual(
            self.client.get(f"/api/invoice-plans/{accepted['id']}")
            .get_json()['data']['plan']['status'],
            'sent',
        )
        summary_row = next(
            row for row in self.client.get('/api/invoice-plans').get_json()['data']
            if row['quotation']['id'] == accepted['id']
        )
        self.assertEqual(summary_row['plan']['status'], 'sent')

        self.client.post(
            f"/api/invoices/{first['id']}/mark-paid",
            json={'receivedDate': '2026-08-16'},
        )
        self.assertEqual(
            self.client.get(f"/api/invoice-plans/{accepted['id']}")
            .get_json()['data']['plan']['status'],
            'partially-paid',
        )
        self.client.put(
            f"/api/invoices/{second['id']}",
            json={
                'status': 'sent', 'invoiceSentDate': '2026-08-15',
                'paymentTermDays': 30,
            },
        )
        self.client.post(
            f"/api/invoices/{second['id']}/mark-paid",
            json={'receivedDate': '2026-08-16'},
        )
        self.assertEqual(
            self.client.get(f"/api/invoice-plans/{accepted['id']}")
            .get_json()['data']['plan']['status'],
            'paid',
        )

    def test_sent_invoice_uses_company_terms_and_becomes_overdue(self):
        self.login('sales-admin')
        settings = self.client.put(
            '/api/pdf-settings', json={'defaultPaymentTerms': '21 Days'},
        )
        self.assertEqual(settings.status_code, 200, settings.get_data(as_text=True))
        self.login('alice')
        quotation = self.create_quote('Payment Clock')
        quotation['lineItems'] = [{
            'id': 'clock-line', 'description': 'Clock test',
            'department': 'Production', 'days': 1, 'quantity': 1,
            'unitPrice': 100,
        }]
        accepted = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json={**quotation, 'status': 'accepted'},
        ).get_json()['data']
        self.client.put(
            f"/api/invoice-plans/{accepted['id']}",
            json={'installments': [{
                'id': 'clock', 'label': 'Full payment',
                'mode': 'percentage', 'value': 100,
            }]},
        )
        invoice = self.client.post(
            f"/api/invoice-plans/{accepted['id']}/installments/clock/issue",
            json={},
        ).get_json()['data']
        sent_date = (datetime.now() - timedelta(days=2)).strftime('%Y-%m-%d')
        sent = self.client.put(
            f"/api/invoices/{invoice['id']}",
            json={'status': 'sent', 'invoiceSentDate': sent_date},
        )
        self.assertEqual(sent.status_code, 200, sent.get_data(as_text=True))
        sent_invoice = sent.get_json()['data']
        self.assertEqual(sent_invoice['paymentTermDays'], 21)
        self.assertEqual(
            sent_invoice['dueDate'],
            (
                datetime.strptime(sent_date, '%Y-%m-%d')
                + timedelta(days=21)
            ).strftime('%Y-%m-%d'),
        )

        # The displayed invoice due date is canonical. A stale, later hidden
        # payment-clock date must not leave an already-due invoice as Sent.
        finance_data = app_module._load_finance_data()
        stored = app_module._finance_find_document(
            finance_data, invoice['id'], 'invoice'
        )
        visible_due_date = (
            datetime.now() - timedelta(days=2)
        ).strftime('%Y-%m-%d')
        stored['status'] = 'sent'
        stored['dueDate'] = visible_due_date
        stored['paymentDueDate'] = (
            datetime.now() + timedelta(days=21)
        ).strftime('%Y-%m-%d')
        plan = finance_data['invoicePlans'][accepted['id']]
        plan_installment = next(
            row for row in plan['installments']
            if row.get('invoiceId') == invoice['id']
        )
        plan_installment['dueDate'] = visible_due_date
        plan_installment['status'] = 'sent'
        app_module._save_finance_data(finance_data)

        corrected = self.client.get(
            f"/api/invoices/{invoice['id']}"
        ).get_json()['data']
        self.assertEqual(corrected['status'], 'overdue')
        self.assertEqual(corrected['dueDate'], visible_due_date)
        self.assertEqual(corrected['paymentDueDate'], visible_due_date)
        corrected_plan = self.client.get(
            f"/api/invoice-plans/{accepted['id']}"
        ).get_json()['data']['plan']
        self.assertEqual(corrected_plan['status'], 'overdue')
        self.assertEqual(
            corrected_plan['installments'][0]['paymentDueDate'],
            visible_due_date,
        )

        second_quote = self.create_quote('Overdue Clock')
        second_quote['lineItems'] = [{
            'id': 'overdue-line', 'description': 'Overdue test',
            'department': 'Production', 'days': 1, 'quantity': 1,
            'unitPrice': 100,
        }]
        accepted_second = self.client.put(
            f"/api/quotations/{second_quote['id']}",
            json={**second_quote, 'status': 'accepted'},
        ).get_json()['data']
        self.client.put(
            f"/api/invoice-plans/{accepted_second['id']}",
            json={'installments': [{
                'id': 'overdue', 'label': 'Full payment',
                'mode': 'percentage', 'value': 100,
            }]},
        )
        overdue_invoice = self.client.post(
            f"/api/invoice-plans/{accepted_second['id']}/installments/overdue/issue",
            json={},
        ).get_json()['data']
        self.client.put(
            f"/api/invoices/{overdue_invoice['id']}",
            json={
                'status': 'sent', 'invoiceSentDate': sent_date,
                'paymentTermDays': 0,
            },
        )
        refreshed = self.client.get(
            f"/api/invoices/{overdue_invoice['id']}"
        ).get_json()['data']
        self.assertEqual(refreshed['status'], 'overdue')
        self.assertEqual(
            self.client.get(f"/api/invoice-plans/{accepted_second['id']}")
            .get_json()['data']['plan']['status'],
            'overdue',
        )

    def test_sent_invoices_are_locked_for_renumbering_but_can_be_deleted(self):
        quotation = self.create_quote('Locked Invoice')
        quotation['lineItems'] = [{
            'id': 'locked-line', 'description': 'Locked invoice test',
            'department': 'Production', 'days': 1, 'quantity': 1,
            'unitPrice': 100,
        }]
        accepted = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json={**quotation, 'status': 'accepted'},
        ).get_json()['data']
        self.client.put(
            f"/api/invoice-plans/{accepted['id']}",
            json={'installments': [{
                'id': 'locked', 'label': 'Full payment',
                'mode': 'percentage', 'value': 100,
            }]},
        )
        invoice = self.client.post(
            f"/api/invoice-plans/{accepted['id']}/installments/locked/issue",
            json={},
        ).get_json()['data']
        self.client.put(
            f"/api/invoices/{invoice['id']}",
            json={
                'status': 'sent', 'invoiceSentDate': '2026-08-15',
                'paymentTermDays': 30,
            },
        )
        renumber = self.client.put(
            f"/api/invoices/{invoice['id']}", json={'number': 'NOT-ALLOWED'},
        )
        self.assertEqual(renumber.status_code, 409, renumber.get_data(as_text=True))
        deleted = self.client.delete(f"/api/invoices/{invoice['id']}")
        self.assertEqual(deleted.status_code, 200, deleted.get_data(as_text=True))

    def test_deleted_invoice_number_is_reused(self):
        def issue_for(project):
            quotation = self.create_quote(project)
            quotation['lineItems'] = [{
                'id': f'{project}-line', 'description': project,
                'department': 'Production', 'days': 1, 'quantity': 1,
                'unitPrice': 50,
            }]
            accepted = self.client.put(
                f"/api/quotations/{quotation['id']}",
                json={**quotation, 'status': 'accepted'},
            ).get_json()['data']
            self.client.put(
                f"/api/invoice-plans/{accepted['id']}",
                json={'installments': [{
                    'id': 'full', 'label': 'Full payment',
                    'mode': 'percentage', 'value': 100,
                }]},
            )
            return self.client.post(
                f"/api/invoice-plans/{accepted['id']}/installments/full/issue",
                json={},
            ).get_json()['data']

        first = issue_for('Reusable One')
        second = issue_for('Reusable Two')
        self.assertNotEqual(first['number'], second['number'])
        self.assertEqual(
            self.client.delete(f"/api/invoices/{first['id']}").status_code,
            200,
        )
        replacement = issue_for('Reusable Three')
        self.assertEqual(replacement['number'], first['number'])

    def test_saved_invoice_plan_seeds_quotation_payment_terms(self):
        created = self.client.post('/api/invoice-plan-templates', json={
            'name': 'Milestone plan',
            'installments': [
                {'label': 'Booking', 'mode': 'percentage', 'value': 40, 'dueDays': 7},
                {'label': 'Completion', 'mode': 'percentage', 'value': 60, 'dueDays': 45},
            ],
        })
        self.assertEqual(created.status_code, 201, created.get_data(as_text=True))
        template = created.get_json()['data']

        quotation = self.create_quote('Saved Terms Project')
        quotation['paymentTerms'] = 'Milestone plan'
        quotation['lineItems'] = [{
            'id': 'saved-plan-line', 'description': 'Production package',
            'department': 'Production', 'days': 1, 'quantity': 1,
            'unitPrice': 100,
        }]
        accepted = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json={**quotation, 'status': 'accepted'},
        ).get_json()['data']
        plan = self.client.get(
            f"/api/invoice-plans/{accepted['id']}"
        ).get_json()['data']['plan']
        self.assertEqual(plan['strategyLabel'], 'Milestone plan')
        self.assertEqual(
            [(row['label'], row['value']) for row in plan['installments']],
            [('Booking', 40), ('Completion', 60)],
        )

        renamed = self.client.put(
            f"/api/invoice-plan-templates/{template['id']}",
            json={**template, 'name': 'Milestone billing'},
        )
        self.assertEqual(renamed.status_code, 200, renamed.get_data(as_text=True))
        self.assertEqual(
            self.client.delete(
                f"/api/invoice-plan-templates/{template['id']}"
            ).status_code,
            200,
        )

    def test_paid_invoice_can_return_to_draft_and_delete_clears_payment(self):
        quotation = self.create_quote('Paid Invoice Reversal')
        quotation['lineItems'] = [{
            'id': 'paid-reversal-line', 'description': 'Production package',
            'department': 'Production', 'days': 1, 'quantity': 1,
            'unitPrice': 100,
        }]
        accepted = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json={**quotation, 'status': 'accepted'},
        ).get_json()['data']
        plan = self.client.get(
            f"/api/invoice-plans/{accepted['id']}"
        ).get_json()['data']['plan']
        plan['installments'][0]['id'] = 'paid-reversal'
        self.client.put(f"/api/invoice-plans/{accepted['id']}", json=plan)
        invoice = self.client.post(
            f"/api/invoice-plans/{accepted['id']}/installments/paid-reversal/issue",
            json={'status': 'sent'},
        ).get_json()['data']
        self.client.post(
            f"/api/invoices/{invoice['id']}/mark-paid",
            json={'receivedDate': '2026-08-12'},
        )
        draft = self.client.put(
            f"/api/invoices/{invoice['id']}", json={'status': 'draft'},
        )
        self.assertEqual(draft.status_code, 200, draft.get_data(as_text=True))
        self.assertEqual(draft.get_json()['data']['status'], 'draft')
        self.assertNotIn('invoiceSentSnapshot', draft.get_json()['data'])
        refreshed = self.client.get(
            f"/api/invoice-plans/{accepted['id']}"
        ).get_json()['data']['plan']
        self.assertEqual(refreshed['payments'], [])
        self.assertEqual(self.client.delete(
            f"/api/invoices/{invoice['id']}"
        ).status_code, 200)

    def test_payment_on_deposit_does_not_zero_balance_invoice_pdf(self):
        quotation = self.create_quote('Separate Installment Payments')
        quotation['lineItems'] = [{
            'id': 'installment-payment-line',
            'description': 'Production package',
            'department': 'Production', 'days': 1, 'quantity': 1,
            'unitPrice': 640,
        }]
        accepted = self.client.put(
            f"/api/quotations/{quotation['id']}",
            json={**quotation, 'status': 'accepted'},
        ).get_json()['data']
        plan_response = self.client.put(
            f"/api/invoice-plans/{accepted['id']}",
            json={'installments': [
                {
                    'id': 'deposit-80', 'label': 'Deposit',
                    'mode': 'percentage', 'value': 80,
                },
                {
                    'id': 'balance-20', 'label': 'Balance',
                    'mode': 'percentage', 'value': 20,
                },
            ]},
        )
        plan = plan_response.get_json()['data']['plan']
        deposit = self.client.post(
            f"/api/invoice-plans/{accepted['id']}/installments/deposit-80/issue",
            json={'status': 'sent'},
        ).get_json()['data']
        self.client.post(
            f"/api/invoices/{deposit['id']}/mark-paid",
            json={'receivedDate': '2026-08-21'},
        )
        balance = self.client.post(
            f"/api/invoice-plans/{accepted['id']}/installments/balance-20/issue",
            json={},
        ).get_json()['data']
        expected_balance = plan['installments'][1]['amount']
        pdf_response = self.client.get(f"/api/invoices/{balance['id']}/pdf")
        pdf_text = '\n'.join(
            page.extract_text() or ''
            for page in PdfReader(io.BytesIO(pdf_response.data)).pages
        )
        self.assertIn('Balance remaining', pdf_text)
        self.assertIn('AMOUNT DUE', pdf_text)
        self.assertGreater(expected_balance, 0)
        self.assertGreaterEqual(
            pdf_text.count(f"${expected_balance:,.2f}"), 2
        )
        sent = self.client.put(
            f"/api/invoices/{balance['id']}",
            json={
                'status': 'sent', 'invoiceSentDate': '2026-08-22',
                'paymentTermDays': 30,
            },
        )
        self.assertEqual(sent.status_code, 200, sent.get_data(as_text=True))
        self.assertEqual(sent.get_json()['data']['invoiceAmount'], expected_balance)
        sent_plan = self.client.get(
            f"/api/invoice-plans/{accepted['id']}"
        ).get_json()['data']['plan']
        sent_balance = next(
            row for row in sent_plan['installments']
            if row['invoiceId'] == balance['id']
        )
        self.assertEqual(sent_balance['amount'], expected_balance)

        invoice_source = Path('static/js/invoices.js').read_text(encoding='utf-8')
        status_handler = invoice_source.split(
            'async function invoiceRequestDocumentStatus', 1
        )[1].split('async function invoiceConfirmSent', 1)[0]
        self.assertLess(
            status_handler.index('invoiceFlushPendingSave()'),
            status_handler.index('invoiceFindDocument(invoiceId)'),
        )

    def test_quotation_status_choices_stop_before_invoice_workflow(self):
        source = Path('static/js/finance.js').read_text(encoding='utf-8')
        first_line = source.splitlines()[0]
        self.assertIn("['draft', 'sent', 'accepted', 'cancelled']", first_line)
        self.assertNotIn("'invoiced'", first_line)
        self.assertNotIn("'overdue'", first_line)
        self.assertNotIn("'paid'", first_line)


if __name__ == '__main__':
    unittest.main()
