import csv
import os
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path

from tests.static_source import APP_BUNDLE_SOURCE
from unittest.mock import patch

import app as app_module
from data_manager import DataManager, EVENT_FIELDNAMES
from models import Event, InventoryItem, User, hash_password, split_legacy_event_name_location


class EventLocationTests(unittest.TestCase):
    def test_legacy_name_splits_at_final_separator(self):
        name, location, changed = split_legacy_event_name_location(
            'Awards @ Sunset @ Marina Bay Sands'
        )

        self.assertEqual(name, 'Awards @ Sunset')
        self.assertEqual(location, 'Marina Bay Sands')
        self.assertTrue(changed)

    def test_explicit_location_prevents_legacy_split(self):
        event = Event(
            7,
            'Show @ Client',
            '20260701',
            '20260701',
            [],
            location='Expo Hall 1',
        )

        self.assertEqual(event.name, 'Show @ Client')
        self.assertEqual(event.location, 'Expo Hall 1')
        self.assertFalse(event._legacy_location_extracted)

    def test_csv_round_trip_persists_extracted_location(self):
        with tempfile.TemporaryDirectory() as root:
            manager = DataManager(root)
            manager.setup_data_folder()
            manager.check_and_initialize_files()
            event = Event(
                1,
                'Launch @ National Gallery',
                '20260701',
                '20260702',
                [],
            )
            manager.events[event.event_id] = event
            manager.save_event(event)

            reloaded = DataManager(root)
            reloaded.load_events()

            self.assertEqual(reloaded.events[1].name, 'Launch')
            self.assertEqual(reloaded.events[1].location, 'National Gallery')
            self.assertFalse(reloaded.events[1]._legacy_location_extracted)
            self.assertTrue(os.path.exists(reloaded.event_file_map[1] if os.path.isabs(reloaded.event_file_map[1]) else os.path.join(reloaded.events_folder, reloaded.event_file_map[1])))

    def test_new_event_requires_location_but_dry_hire_does_not(self):
        base = {
            'name': 'Test',
            'startDate': '2026-07-01',
            'endDate': '2026-07-01',
        }

        event_errors = app_module.validate_event_data(
            {**base, 'tag': 'events', 'location': ''},
            require_location=True,
        )
        dry_hire_errors = app_module.validate_event_data(
            {**base, 'tag': 'dry hire', 'location': ''},
            require_location=True,
        )

        self.assertIn('Location is required for events', event_errors)
        self.assertNotIn('Location is required for events', dry_hire_errors)

    def test_legacy_added_state_is_migrated_and_persisted_as_new(self):
        with tempfile.TemporaryDirectory() as root:
            manager = DataManager(root)
            manager.setup_data_folder()
            manager.check_and_initialize_files()
            event = Event(1, 'Legacy', '20260701', '20260701', [])
            manager.events[1] = event
            manager.save_event(event)

            filepath = os.path.join(manager.events_folder, manager.event_file_map[1])
            with open(filepath, newline='', encoding='utf-8') as source:
                row = next(csv.DictReader(source))
            row['State'] = 'Added'
            with open(filepath, 'w', newline='', encoding='utf-8') as destination:
                writer = csv.DictWriter(destination, fieldnames=EVENT_FIELDNAMES)
                writer.writeheader()
                writer.writerow(row)

            reloaded = DataManager(root)
            reloaded.load_all_data()

            self.assertEqual(reloaded.events[1].state, 'New')
            with open(filepath, newline='', encoding='utf-8') as persisted:
                persisted_row = next(csv.DictReader(persisted))
            self.assertEqual(persisted_row['State'], 'New')

    def test_legacy_last_day_state_is_migrated_and_persisted_as_ongoing(self):
        with tempfile.TemporaryDirectory() as root:
            manager = DataManager(root)
            manager.setup_data_folder()
            manager.check_and_initialize_files()
            event = Event(1, 'Legacy', '20260701', '20260701', [])
            manager.events[1] = event
            manager.save_event(event)

            filepath = os.path.join(manager.events_folder, manager.event_file_map[1])
            with open(filepath, newline='', encoding='utf-8') as source:
                row = next(csv.DictReader(source))
            row['State'] = 'Last Day'
            with open(filepath, 'w', newline='', encoding='utf-8') as destination:
                writer = csv.DictWriter(destination, fieldnames=EVENT_FIELDNAMES)
                writer.writeheader()
                writer.writerow(row)

            reloaded = DataManager(root)
            reloaded.load_all_data()

            self.assertEqual(reloaded.events[1].state, 'Ongoing')
            with open(filepath, newline='', encoding='utf-8') as persisted:
                persisted_row = next(csv.DictReader(persisted))
            self.assertEqual(persisted_row['State'], 'Ongoing')


class AssetsDeployedTests(unittest.TestCase):
    def test_counts_prepared_physical_and_bulk_but_not_custom_or_returned(self):
        manager = DataManager(tempfile.mkdtemp())
        manager.inventory = {'A': object(), 'B': object()}
        manager.events = {
            1: Event(
                1,
                'One',
                '20260701',
                '20260701',
                [],
                actually_prepared=['A', '[BULK]BULK-1|3', '[LOAN]Camera;2'],
            ),
            2: Event(
                2,
                'Two',
                '20260701',
                '20260701',
                [],
                actually_prepared=['A', 'B', '[BULK]BULK-2|4'],
                returned_items=['B', '[BULK]BULK-2|4'],
            ),
        }
        token = app_module._request_data_manager.set(manager)
        try:
            self.assertEqual(app_module.get_deployed_asset_quantity(), 4)
        finally:
            app_module._request_data_manager.reset(token)


class AssetEventHistoryTests(unittest.TestCase):
    def setUp(self):
        self.original_data_manager = app_module.get_default_data_manager()
        self.original_testing = app_module.app.config.get('TESTING')
        self.tempdir = tempfile.TemporaryDirectory()
        self.data_manager = DataManager(self.tempdir.name)
        self.data_manager.inventory = {
            'A#01': InventoryItem(
                asset_id='A#01',
                brand='Test',
                model_number='Model',
                serial_number='SN-1',
                description='Test asset',
                is_missing=False,
                maintenance_logs=[],
                department_code='AX',
                default_location='Store',
            )
        }
        self.data_manager.events = {
            1: Event(
                1,
                'Launch',
                '20260701',
                '20260702',
                [],
                actually_prepared=['A#01'],
                location='Marina Bay Sands',
                assigned_users=['user'],
            )
        }
        self.data_manager.users = {
            'user': User('user', hash_password('pw', 'salt'), 'salt', False, True)
        }
        app_module.app.config['TESTING'] = True
        app_module.set_data_manager_for_testing(self.data_manager)
        self.client = app_module.app.test_client()
        with self.client.session_transaction() as session:
            session['user'] = 'user'
            session['is_admin'] = False

    def tearDown(self):
        app_module.clear_test_data_manager(self.original_data_manager)
        app_module.app.config['TESTING'] = self.original_testing
        self.tempdir.cleanup()

    def test_event_history_includes_location_separately_from_name(self):
        response = self.client.get('/api/assets/A%2301/event-history')

        self.assertEqual(response.status_code, 200)
        event = response.get_json()['data'][0]
        self.assertEqual(event['name'], 'Launch')
        self.assertEqual(event['location'], 'Marina Bay Sands')

    def test_asset_usage_days_count_unique_elapsed_deployment_dates(self):
        today = datetime.now().date()

        def storage_date(value):
            return value.strftime('%Y%m%d')

        self.data_manager.events = {
            1: Event(
                1,
                'First deployment',
                storage_date(today - timedelta(days=4)),
                storage_date(today - timedelta(days=2)),
                [],
                actually_prepared=['A#01'],
            ),
            2: Event(
                2,
                'Overlapping deployment',
                storage_date(today - timedelta(days=2)),
                storage_date(today),
                [],
                returned_items=['A#01'],
            ),
            3: Event(
                3,
                'Future deployment',
                storage_date(today + timedelta(days=1)),
                storage_date(today + timedelta(days=3)),
                [],
                actually_prepared=['A#01'],
            ),
            4: Event(
                4,
                'Cancelled deployment',
                storage_date(today - timedelta(days=10)),
                storage_date(today - timedelta(days=8)),
                [],
                state='Cancelled',
                actually_prepared=['A#01'],
            ),
            5: Event(
                5,
                'Planned only',
                storage_date(today - timedelta(days=20)),
                storage_date(today - timedelta(days=18)),
                [],
                prepared_items=['A#01'],
            ),
        }

        response = self.client.get('/api/assets/A%2301/usage-summary')

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertEqual(response.get_json()['data']['usageDays'], 5)

    def test_bulk_asset_usage_counts_event_days_when_any_quantity_was_deployed(self):
        today = datetime.now().date()
        self.data_manager.inventory['BULK-1'] = InventoryItem(
            asset_id='BULK-1',
            brand='Test',
            model_number='Cable',
            serial_number='',
            description='Bulk cable',
            is_missing=False,
            maintenance_logs=[],
            department_code='AX',
            is_bulk=True,
            quantity=20,
        )
        self.data_manager.events = {
            1: Event(
                1,
                'Bulk deployment',
                (today - timedelta(days=2)).strftime('%Y%m%d'),
                today.strftime('%Y%m%d'),
                [],
                actually_prepared=['[BULK]BULK-1|4'],
            ),
        }

        response = self.client.get('/api/assets/BULK-1/usage-summary')

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertEqual(response.get_json()['data']['usageDays'], 3)


class EventAssignmentAccessTests(unittest.TestCase):
    def setUp(self):
        self.original_data_manager = app_module.get_default_data_manager()
        self.original_testing = app_module.app.config.get('TESTING')
        self.tempdir = tempfile.TemporaryDirectory()

        self.data_manager = DataManager(self.tempdir.name)
        self.data_manager.setup_data_folder()
        self.data_manager.check_and_initialize_files()
        self.data_manager.users = {
            'admin': User('admin', hash_password('pw', 'admin-salt'), 'admin-salt', True, True, role='admin'),
            'manager': User('manager', hash_password('pw', 'manager-salt'), 'manager-salt', True, True, role='manager'),
            'alice': User('alice', hash_password('pw', 'alice-salt'), 'alice-salt', False, True, name='Alice Tan'),
            'bob': User('bob', hash_password('pw', 'bob-salt'), 'bob-salt', False, True, name='Bob Lim'),
        }
        self.data_manager.inventory = {
            'A#01': InventoryItem(
                'A#01',
                'TestBrand',
                'TestModel',
                'SN-A01',
                'Test asset',
                False,
                [],
                'AX',
                'Store',
                'Assigned',
            ),
            'BULK-01': InventoryItem(
                'BULK-01',
                'TestBrand',
                'BulkModel',
                'SN-B01',
                'Bulk asset',
                False,
                [],
                'AX',
                'Store',
                'Assigned',
                is_bulk=True,
                quantity=5,
            ),
        }
        self.data_manager.events = {
            1: Event(
                1,
                'Assigned',
                '20260701',
                '20260701',
                [],
                actually_prepared=['A#01', app_module._bulk_marker('BULK-01', 1)],
                assigned_users=['alice'],
            ),
            2: Event(
                2,
                'Unassigned',
                '20260702',
                '20260702',
                [],
                actually_prepared=['A#01', app_module._bulk_marker('BULK-01', 2)],
            ),
        }
        self.data_manager.save_users()
        self.data_manager.save_inventory()
        for event in self.data_manager.events.values():
            self.data_manager.save_event(event)

        app_module.app.config['TESTING'] = True
        app_module.set_data_manager_for_testing(self.data_manager)
        self.client = app_module.app.test_client()

    def tearDown(self):
        app_module.clear_test_data_manager(self.original_data_manager)
        app_module.app.config['TESTING'] = self.original_testing
        self.tempdir.cleanup()

    def login(self, username):
        user = self.data_manager.users[username]
        with self.client.session_transaction() as session:
            session['user'] = username
            session['is_admin'] = bool(user.is_admin)
            session['is_active'] = True

    def test_admin_and_manager_see_all_events(self):
        self.login('admin')
        response = self.client.get('/api/events?view=summary')
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertEqual({event['id'] for event in response.get_json()['data']}, {1, 2})

    def test_shared_workflow_progress_tracks_operations_and_finance_states(self):
        yesterday = (datetime.now() - timedelta(days=1)).strftime('%Y%m%d')
        event = Event(91, 'Progress Event', yesterday, yesterday, [])
        workforce = {
            'assignments': {'91': [{
                'id': 'assignment-1',
                'freelancerId': 'worker-1',
                'department': 'AX',
            }]},
            'transportBookings': {'91': [{
                'id': 'depart-1',
                'tripType': 'depart',
                'twoWay': False,
                'status': 'Approved',
            }]},
            'submissions': {'91': {
                'worker-1': {'invoices': [], 'claims': []},
            }},
            'uploadAllowances': {},
        }
        finance = {'documents': [{
            'id': 'quotation-91',
            'type': 'quotation',
            'eventId': 91,
            'salespersonUsername': 'admin',
        }]}
        self.data_manager.events[event.event_id] = event
        self.assertFalse(app_module._workforce_financial_closure_complete(
            event.event_id,
            manager=self.data_manager,
            event=event,
            workforce=workforce,
        ))

        with app_module.app.test_request_context('/'):
            app_module.session['user'] = 'admin'
            progress = app_module._event_workflow_progress_payload(
                event, 4, 2, 1, workforce, finance
            )
            self.assertEqual(progress['plan']['status'], 'green')
            self.assertEqual(progress['manpower']['status'], 'green')
            self.assertEqual(progress['transport']['status'], 'orange')
            self.assertEqual(progress['prepare']['status'], 'orange')
            self.assertEqual(progress['return']['status'], 'orange')
            self.assertEqual(progress['finance']['status'], 'blue')

            workforce['transportBookings']['91'].append({
                'id': 'return-1', 'tripType': 'return', 'status': 'Approved'
            })
            invoice = {'id': 'invoice-1', 'status': 'Pending Review'}
            workforce['submissions']['91']['worker-1']['invoices'] = [invoice]
            progress = app_module._event_workflow_progress_payload(
                event, 4, 4, 4, workforce, finance
            )
            self.assertEqual(progress['transport']['status'], 'green')
            self.assertEqual(progress['prepare']['status'], 'green')
            self.assertEqual(progress['return']['status'], 'green')
            self.assertEqual(progress['finance']['status'], 'orange')

            invoice['status'] = 'Approved'
            progress = app_module._event_workflow_progress_payload(
                event, 4, 4, 4, workforce, finance
            )
            self.assertEqual(progress['finance']['status'], 'red')

            invoice['status'] = 'Paid'
            progress = app_module._event_workflow_progress_payload(
                event, 4, 4, 4, workforce, finance
            )
            self.assertEqual(progress['finance']['status'], 'green')

            invoice['paymentConfirmedAt'] = '2026-08-22T10:00:00'
            progress = app_module._event_workflow_progress_payload(
                event, 4, 4, 4, workforce, finance
            )
            self.assertEqual(progress['finance']['status'], 'green')

            finance['documents'][0]['salespersonUsername'] = 'alice'
            progress = app_module._event_workflow_progress_payload(
                event, 4, 4, 4, workforce, finance
            )
            self.assertEqual(progress['finance']['status'], 'green')

            full_time_workforce = {
                'assignments': {'91': [{
                    'id': 'staff-1',
                    'subjectType': 'app-user',
                    'userUsername': 'admin',
                    'department': 'FT',
                }]},
                'transportBookings': {},
                'submissions': {'91': {'user:admin': {
                    'invoices': [], 'claims': [],
                }}},
                'uploadAllowances': {},
            }
            progress = app_module._event_workflow_progress_payload(
                event, 0, 0, 0, full_time_workforce, {'documents': []}
            )
            self.assertEqual(progress['finance']['status'], 'neutral')
            self.assertTrue(app_module._workforce_financial_closure_complete(
                event.event_id,
                manager=self.data_manager,
                event=event,
                workforce=full_time_workforce,
            ))
            event.state = 'New'
            app_module.update_event_state(event, workforce=full_time_workforce)
            self.assertEqual(event.state, 'Closed')

            full_time_workforce['submissions']['91']['user:admin']['claims'] = [{
                'id': 'staff-claim', 'status': 'Pending Review',
            }]
            progress = app_module._event_workflow_progress_payload(
                event, 0, 0, 0, full_time_workforce, {'documents': []}
            )
            self.assertEqual(progress['finance']['status'], 'neutral')
            self.assertTrue(app_module._workforce_financial_closure_complete(
                event.event_id,
                manager=self.data_manager,
                event=event,
                workforce=full_time_workforce,
            ))

    def test_finance_indicator_uses_next_unpaid_invoice_or_claim(self):
        tomorrow = (datetime.now() + timedelta(days=1)).strftime('%Y%m%d')
        event = Event(92, 'Mixed submissions', tomorrow, tomorrow, [])
        paid_invoice = {'id': 'paid-invoice', 'status': 'Paid'}
        workforce = {
            'assignments': {'92': [
                {'freelancerId': 'worker-1', 'department': 'AX'},
                {'freelancerId': 'worker-2', 'department': 'AX'},
            ]},
            'transportBookings': {},
            'submissions': {'92': {
                'worker-1': {'invoices': [paid_invoice], 'claims': []},
                'worker-2': {'invoices': [], 'claims': []},
            }},
            'uploadAllowances': {},
        }
        self.data_manager.events[event.event_id] = event

        with app_module.app.test_request_context('/'):
            app_module.session['user'] = 'admin'

            def finance_progress():
                return app_module._event_workflow_progress_payload(
                    event, 0, 0, 0, workforce, {}
                )['finance']

            self.assertEqual(finance_progress()['status'], 'blue')

            next_invoice = {'id': 'next-invoice', 'status': 'Pending Review'}
            workforce['submissions']['92']['worker-2']['invoices'] = [next_invoice]
            self.assertEqual(finance_progress()['status'], 'orange')

            next_invoice['status'] = 'Approved'
            self.assertEqual(finance_progress()['status'], 'red')

            next_invoice['status'] = 'Paid'
            self.assertEqual(finance_progress()['status'], 'green')

            claim = {'id': 'claim-1', 'status': 'Approved'}
            workforce['submissions']['92']['worker-1']['claims'] = [claim]
            self.assertEqual(finance_progress()['status'], 'red')

            next_invoice['status'] = 'Pending Review'
            self.assertEqual(finance_progress()['status'], 'red')

            claim['status'] = 'Paid'
            self.assertEqual(finance_progress()['status'], 'orange')

            next_invoice['status'] = 'Paid'
            self.assertEqual(finance_progress()['status'], 'green')

    def test_plan_workflow_icon_distinguishes_shortage_and_degraded_capacity(self):
        event = self.data_manager.events[1]
        event.prepared_items = [
            '[MODEL]AX|TestBrand|TestModel|2|Test asset'
        ]
        event.actually_prepared = []
        event.returned_items = []

        with app_module.app.test_request_context('/'):
            app_module.session['user'] = 'admin'
            app_module.reset_cache()
            progress = app_module._event_workflow_progress_payload(
                event, 2, 0, 0, {}, {}
            )
            self.assertEqual(progress['plan']['status'], 'red')
            self.assertEqual(
                progress['plan']['label'], 'Plan: shortage of 1 asset unit'
            )

            self.data_manager.inventory['A#02'] = InventoryItem(
                asset_id='A#02',
                brand='TestBrand',
                model_number='TestModel',
                serial_number='SN-A02',
                description='Test asset',
                is_missing=False,
                maintenance_logs=[],
                department_code='AX',
                default_location='Store',
                is_degraded=True,
            )
            app_module.reset_cache()
            progress = app_module._event_workflow_progress_payload(
                event, 2, 0, 0, {}, {}
            )
            self.assertEqual(progress['plan']['status'], 'orange')
            self.assertEqual(
                progress['plan']['label'],
                'Plan: 1 degraded asset unit required',
            )

            self.data_manager.inventory['A#02'].is_degraded = False
            app_module.reset_cache()
            progress = app_module._event_workflow_progress_payload(
                event, 2, 0, 0, {}, {}
            )
            self.assertEqual(progress['plan']['status'], 'green')

    def test_event_summary_pagination_enriches_only_the_requested_page(self):
        self.login('admin')

        with patch.object(app_module, '_event_files_for_response', return_value=[]) as files:
            first = self.client.get('/api/events?view=summary&limit=1&offset=0')

        self.assertEqual(first.status_code, 200, first.get_data(as_text=True))
        payload = first.get_json()
        self.assertEqual([event['id'] for event in payload['data']], [2])
        self.assertEqual(payload['meta']['total'], 2)
        self.assertTrue(payload['meta']['hasMore'])
        self.assertEqual(payload['meta']['nextOffset'], 1)
        self.assertEqual(files.call_count, 0)
        self.assertNotIn('fileCount', payload['data'][0])

        second = self.client.get('/api/events?view=summary&limit=1&offset=1')
        self.assertEqual([event['id'] for event in second.get_json()['data']], [1])
        self.assertFalse(second.get_json()['meta']['hasMore'])
        self.assertIsNone(second.get_json()['meta']['nextOffset'])

    def test_event_summary_active_scope_keeps_complete_filter_counts(self):
        self.login('admin')
        self.data_manager.events[1].state = 'Closed'
        self.data_manager.events[2].state = 'Ongoing'

        with patch.object(app_module, 'refresh_event_states_for_read', return_value=[]):
            response = self.client.get('/api/events?view=summary&scope=active')

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        payload = response.get_json()
        self.assertEqual([event['id'] for event in payload['data']], [2])
        self.assertEqual(payload['meta']['total'], 1)
        self.assertEqual(payload['meta']['scope'], 'active')
        self.assertEqual(payload['meta']['stateCounts']['Closed'], 1)
        self.assertEqual(payload['meta']['stateCounts']['Ongoing'], 1)
        self.assertEqual(
            payload['meta']['stateCountsByTag']['events']['Closed'],
            1,
        )

    def test_event_summary_skips_model_group_inventory_display_metadata(self):
        self.login('admin')
        self.data_manager.events[1].prepared_items = [
            '[MODEL]AX|TestBrand|TestModel|1|Test asset'
        ]

        with patch.object(app_module, '_event_group_is_bulk_quantity') as is_bulk:
            response = self.client.get('/api/events?view=summary')

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        is_bulk.assert_not_called()

    def test_event_options_are_lightweight_and_sortable(self):
        self.login('admin')
        response = self.client.get(
            '/api/events?view=options&sort=startDate&direction=asc'
        )

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        payload = response.get_json()
        self.assertEqual(payload['meta']['view'], 'options')
        self.assertEqual(len(payload['data']), 2)
        option = payload['data'][0]
        self.assertIn('returnableCount', option)
        self.assertNotIn('departmentProgress', option)
        self.assertNotIn('assignedUsers', option)
        self.assertNotIn('modelGroups', option)

    def test_calendar_view_returns_only_overlapping_lightweight_events(self):
        self.login('admin')

        with patch.object(app_module, '_event_files_for_response', return_value=[]) as files:
            response = self.client.get(
                '/api/events?view=calendar&rangeStart=2026-06-29&rangeEnd=2026-08-02'
            )

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        payload = response.get_json()
        self.assertEqual(payload['meta']['view'], 'calendar')
        self.assertEqual(payload['meta']['rangeStart'], '2026-06-29')
        self.assertEqual({row['id'] for row in payload['data']}, {1, 2})
        self.assertEqual(files.call_count, 0)
        self.assertEqual(
            set(payload['data'][0]),
            {'id', 'name', 'location', 'startDate', 'endDate', 'state', 'tag'},
        )
        self.assertIn('stateCounts', payload['meta'])
        self.assertIn('stateCountsByTag', payload['meta'])

        outside = self.client.get(
            '/api/events?view=calendar&rangeStart=2026-08-03&rangeEnd=2026-09-06'
        )
        self.assertEqual(outside.status_code, 200)
        self.assertEqual(outside.get_json()['data'], [])

    def test_calendar_view_requires_a_complete_valid_range(self):
        self.login('admin')

        missing_end = self.client.get(
            '/api/events?view=calendar&rangeStart=2026-07-01'
        )
        reversed_range = self.client.get(
            '/api/events?view=calendar&rangeStart=2026-07-31&rangeEnd=2026-07-01'
        )

        self.assertEqual(missing_end.status_code, 400)
        self.assertEqual(reversed_range.status_code, 400)

    def test_event_options_can_be_narrowed_by_event_number(self):
        self.login('admin')

        response = self.client.get('/api/events?view=options&query=2&limit=8')

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertEqual(
            [(event['id'], event['name']) for event in response.get_json()['data']],
            [(2, 'Unassigned')],
        )

    def test_inventory_onboarding_check_does_not_serialize_assets(self):
        self.login('admin')
        response = self.client.get('/api/assets/exists')

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertEqual(response.get_json()['data'], {'hasAssets': True})

    def test_transfer_options_support_progressive_pages(self):
        self.login('admin')
        first = self.client.get('/api/transfers/options?limit=1&offset=0')
        second = self.client.get('/api/transfers/options?limit=1&offset=1')

        self.assertEqual(first.status_code, 200, first.get_data(as_text=True))
        self.assertEqual(second.status_code, 200, second.get_data(as_text=True))
        self.assertEqual(len(first.get_json()['data']['events']), 1)
        self.assertTrue(first.get_json()['meta']['hasMore'])
        self.assertEqual(first.get_json()['meta']['nextOffset'], 1)
        self.assertEqual(len(second.get_json()['data']['events']), 1)
        self.assertFalse(second.get_json()['meta']['hasMore'])

    def test_summary_includes_department_progress_without_full_model_groups(self):
        event = self.data_manager.events[1]
        event.prepared_items = ['[MODEL]AX|TestBrand|TestModel|2|Test asset']
        event.actually_prepared = ['A#01']
        today = datetime.now().date()
        event.start_date = (today - timedelta(days=1)).strftime('%Y%m%d')
        event.end_date = (today + timedelta(days=1)).strftime('%Y%m%d')
        event.state = 'Preparing'
        self.login('admin')

        response = self.client.get('/api/events?view=summary')

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        payload = next(row for row in response.get_json()['data'] if row['id'] == 1)
        self.assertNotIn('modelGroups', payload)
        self.assertEqual(payload['departmentProgress'], [
            {'code': 'AX', 'done': 1, 'total': 2},
        ])

        self.login('manager')
        response = self.client.get('/api/events?view=summary')
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertEqual({event['id'] for event in response.get_json()['data']}, {1, 2})

    def test_summary_excludes_delivered_vendor_items_from_prepare_progress(self):
        event = self.data_manager.events[1]
        today = datetime.now().date()
        prepared_model = app_module._prepared_model_marker({
            'department': 'LX',
            'brand': 'TestBrand',
            'model': 'Fixture',
            'description': 'Lighting fixture',
        }, 12)
        delivered_loan = app_module._make_custom_marker(
            'LOAN',
            'Lighting console',
            1,
            'LX',
            'Avery Events and Exhibitions Pte Ltd',
        )
        event.prepared_items = [
            '[MODEL]LX|TestBrand|Fixture|12|Lighting fixture',
            delivered_loan,
        ]
        event.actually_prepared = [prepared_model]
        event.returned_items = []
        event.extra_assets = []
        event.vendor_management = [{
            'key': 'vendor:avery',
            'vendorId': 'avery',
            'vendorType': 'vendor',
            'vendorName': 'Avery Events and Exhibitions Pte Ltd',
            'mode': 'outsourced',
        }]
        event.start_date = (today - timedelta(days=1)).strftime('%Y%m%d')
        event.end_date = (today + timedelta(days=1)).strftime('%Y%m%d')
        event.state = 'Preparing'
        self.data_manager.save_event(event)
        app_module.reset_cache()
        self.login('admin')

        response = self.client.get('/api/events?view=summary')

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        payload = next(row for row in response.get_json()['data'] if row['id'] == 1)
        # The event still has 13 planned requirements; only preparation
        # progress excludes the vendor-delivered unit.
        self.assertEqual(payload['assetCount'], 13)
        self.assertEqual(payload['preparedCount'], 12)
        self.assertEqual(payload['preparationCount'], 12)
        self.assertEqual(payload['preparationTotal'], 12)
        self.assertEqual(payload['departmentProgress'], [
            {'code': 'LX', 'done': 12, 'total': 12},
        ])
        self.assertEqual(payload['workflowProgress']['prepare'], {
            'status': 'green',
            'label': 'Prepare: 12/12 assets prepared',
        })

        detail_response = self.client.get('/api/events/1')
        self.assertEqual(
            detail_response.status_code,
            200,
            detail_response.get_data(as_text=True),
        )
        detail = detail_response.get_json()['data']
        self.assertEqual(detail['totalAssets'], 13)
        self.assertEqual(detail['workflowProgress']['prepare'], {
            'status': 'green',
            'label': 'Prepare: 12/12 assets prepared',
        })

        # An old preparation record for a now-delivered vendor must not
        # substitute for any unprepared warehouse units in either endpoint.
        event.actually_prepared = [delivered_loan]
        self.data_manager.save_event(event)
        app_module.reset_cache()
        summary = self.client.get('/api/events?view=summary').get_json()
        payload = next(row for row in summary['data'] if row['id'] == 1)
        self.assertEqual(payload['preparationCount'], 0)
        self.assertEqual(payload['preparationTotal'], 12)
        self.assertEqual(payload['workflowProgress']['prepare']['label'],
                         'Prepare: 0/12 assets prepared')
        detail = self.client.get('/api/events/1').get_json()['data']
        self.assertEqual(detail['workflowProgress']['prepare']['label'],
                         'Prepare: 0/12 assets prepared')

    def test_summary_keeps_self_pickup_vendor_items_in_prepare_progress(self):
        event = self.data_manager.events[1]
        today = datetime.now().date()
        self_pickup_loan = app_module._make_custom_marker(
            'LOAN',
            'Lighting console',
            1,
            'LX',
            'Avery Events and Exhibitions Pte Ltd',
        )
        event.prepared_items = [self_pickup_loan]
        event.actually_prepared = []
        event.returned_items = []
        event.extra_assets = []
        event.vendor_management = [{
            'key': 'vendor:avery',
            'vendorId': 'avery',
            'vendorType': 'vendor',
            'vendorName': 'Avery Events and Exhibitions Pte Ltd',
            'mode': 'dry-hire',
        }]
        event.start_date = (today - timedelta(days=1)).strftime('%Y%m%d')
        event.end_date = (today + timedelta(days=1)).strftime('%Y%m%d')
        event.state = 'Preparing'
        self.data_manager.save_event(event)
        app_module.reset_cache()
        self.login('admin')

        response = self.client.get('/api/events?view=summary')

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        payload = next(row for row in response.get_json()['data'] if row['id'] == 1)
        self.assertEqual(payload['assetCount'], 1)
        self.assertEqual(payload['preparedCount'], 0)
        self.assertEqual(payload['departmentProgress'], [
            {'code': 'LX', 'done': 0, 'total': 1},
        ])

    def test_user_only_sees_and_modifies_assigned_events(self):
        self.login('alice')

        response = self.client.get('/api/events?view=summary')
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        payload = response.get_json()['data']
        self.assertEqual([event['id'] for event in payload], [1])
        self.assertEqual(payload[0]['assignedUsernames'], ['alice'])
        self.assertEqual(payload[0]['assignedUsers'][0]['name'], 'Alice Tan')

        assigned_detail = self.client.get('/api/events/1')
        self.assertEqual(assigned_detail.status_code, 200, assigned_detail.get_data(as_text=True))

        blocked_detail = self.client.get('/api/events/2')
        self.assertEqual(blocked_detail.status_code, 403, blocked_detail.get_data(as_text=True))

        notes_response = self.client.put('/api/events/1/notes', json={'notes': 'Packed by Alice'})
        self.assertEqual(notes_response.status_code, 200, notes_response.get_data(as_text=True))
        self.assertEqual(self.data_manager.events[1].notes, 'Packed by Alice')

        blocked_notes = self.client.put('/api/events/2/notes', json={'notes': 'No access'})
        self.assertEqual(blocked_notes.status_code, 403, blocked_notes.get_data(as_text=True))
        self.assertEqual(self.data_manager.events[2].notes, '')

    def test_user_transfer_helpers_only_include_assigned_events(self):
        self.login('alice')

        response = self.client.get('/api/transfers/options')
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        payload = response.get_json()['data']
        self.assertEqual([event['id'] for event in payload['events']], [1])
        self.assertEqual([event['id'] for event in payload['sourceEvents']], [1])
        self.assertEqual([event['id'] for event in payload['targetEvents']], [1])

        blocked = self.client.get('/api/transfers/candidates?fromEventId=1&toEventId=2')
        self.assertEqual(blocked.status_code, 403, blocked.get_data(as_text=True))

    def test_user_asset_event_history_only_includes_assigned_events(self):
        self.login('alice')

        response = self.client.get('/api/assets/A%2301/event-history')
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertEqual([event['id'] for event in response.get_json()['data']], [1])

        response = self.client.get('/api/assets')
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        asset_rows = response.get_json()['data']
        regular = next(item for item in asset_rows if item.get('id') == 'A#01')
        self.assertEqual([row['eventId'] for row in regular['deployments']], [1])
        self.assertEqual(regular['deployments'][0]['eventName'], 'Assigned')
        self.assertEqual(regular['deployments'][0]['quantity'], 1)
        bulk = next(item for item in asset_rows if item.get('bulkId') == 'BULK-01')
        self.assertEqual([row['eventId'] for row in bulk['bulkDeployments']], [1])

    def test_user_dashboard_stats_only_count_assigned_events(self):
        self.login('alice')

        response = self.client.get('/api/stats')
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        stats = response.get_json()['data']
        self.assertEqual(stats['totalEvents'], 1)
        self.assertEqual(stats['deployedAssets'], 2)

    def test_user_availability_counts_hidden_overlap_without_event_details(self):
        self.data_manager.events[2].start_date = '20260701'
        self.data_manager.events[2].end_date = '20260701'
        self.data_manager.events[2].prepared_items = [
            '[MODEL]AX|TestBrand|TestModel|1|Test asset'
        ]
        self.login('alice')

        response = self.client.get('/api/events/1/availability')
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        row = next(item for item in response.get_json()['data'] if item['model'] == 'TestModel')
        self.assertEqual(row['overlappingDemand'], 1)
        self.assertEqual(row['overlappingEvents'], [])

    def test_event_create_and_update_persist_assigned_users(self):
        self.login('admin')

        with patch.object(app_module, '_queue_assigned_event_notification') as queued:
            response = self.client.post('/api/events', json={
                'name': 'New assigned event',
                'location': 'Expo',
                'startDate': '2026-07-03',
                'endDate': '2026-07-03',
                'tag': 'events',
                'assignedUsers': ['alice', 'bob'],
            })
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertEqual(
            queued.call_args.kwargs['assigned_usernames'],
            ['alice', 'bob'],
        )
        event_id = response.get_json()['eventId']
        self.assertEqual(self.data_manager.events[event_id].assigned_users, ['alice', 'bob'])
        creation_action = next(
            log.action for log in self.data_manager.logs
            if log.action.startswith(f'Created event {event_id}:')
        )
        self.assertIn('location=Expo', creation_action)
        self.assertIn('assigned users=2', creation_action)
        self.assertTrue(any(
            row['action'] == creation_action
            for row in self.data_manager.events[event_id].event_logs
        ))

        self.data_manager.migrate_event_logs_from_system_logs()
        self.assertTrue(any(
            log.action == creation_action for log in self.data_manager.logs
        ))

        with patch.object(app_module, '_queue_assigned_event_notification') as queued:
            response = self.client.put(f'/api/events/{event_id}', json={
                'name': 'New assigned event',
                'location': 'Expo',
                'startDate': '2026-07-03',
                'endDate': '2026-07-03',
                'tag': 'events',
                'assignedUsers': ['bob'],
            })
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertEqual(queued.call_args.kwargs['assigned_usernames'], [])
        self.assertEqual(self.data_manager.events[event_id].assigned_users, ['bob'])

        reloaded = DataManager(self.tempdir.name)
        reloaded.load_events()
        self.assertEqual(reloaded.events[event_id].assigned_users, ['bob'])

    def test_repeated_event_creation_request_reuses_the_first_event(self):
        self.login('admin')
        initial_event_count = len(self.data_manager.events)
        payload = {
            'name': 'One event only',
            'location': 'Expo',
            'startDate': '2026-07-05',
            'endDate': '2026-07-05',
            'tag': 'events',
            'assignedUsers': ['alice'],
            'clientRequestId': 'create-event-test-request',
        }

        with patch.object(app_module, '_queue_assigned_event_notification') as queued:
            first = self.client.post('/api/events', json=payload)
            repeated = self.client.post('/api/events', json=payload)

        self.assertEqual(first.status_code, 200, first.get_data(as_text=True))
        self.assertEqual(repeated.status_code, 200, repeated.get_data(as_text=True))
        self.assertEqual(first.get_json()['eventId'], repeated.get_json()['eventId'])
        self.assertTrue(repeated.get_json()['reused'])
        self.assertEqual(len(self.data_manager.events), initial_event_count + 1)
        queued.assert_called_once()

        changed = self.client.post('/api/events', json={
            **payload,
            'name': 'Different event details',
        })
        self.assertEqual(changed.status_code, 409, changed.get_data(as_text=True))
        self.assertEqual(len(self.data_manager.events), initial_event_count + 1)

    def test_event_creation_uses_lowest_available_id(self):
        self.login('admin')
        later_event = Event(
            4,
            'Later event',
            '20260704',
            '20260704',
            [],
            location='Expo',
        )
        self.data_manager.events[4] = later_event
        self.data_manager.save_event(later_event)

        response = self.client.post('/api/events', json={
            'name': 'Fill the gap',
            'location': 'Studio',
            'startDate': '2026-07-03',
            'endDate': '2026-07-03',
            'tag': 'events',
            'assignedUsers': [],
        })

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertEqual(response.get_json()['eventId'], 3)
        self.assertEqual(self.data_manager.events[3].name, 'Fill the gap')


class TransferWorkspaceSourceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        root = Path(__file__).resolve().parents[1]
        cls.source = APP_BUNDLE_SOURCE
        cls.template = (root / 'templates' / 'index.html').read_text(
            encoding='utf-8'
        )

    def test_transfer_workspace_hides_event_counts_and_collapses_new_pair(self):
        self.assertEqual(self.source.count('function renderTransferWorkspace()'), 1)
        renderer = self.source.split('function renderTransferWorkspace()', 1)[1]
        renderer = renderer.split('async function transferChooseEvent', 1)[0]
        self.assertNotIn('events available', renderer)
        self.assertNotIn('eligible<br>events', renderer)

        loader = self.source.split('async function loadTransferCandidates', 1)[1]
        loader = loader.split('function transferModeMeta', 1)[0]
        self.assertIn('const openDropdowns = pairChanged\n    ? []', loader)

        group = self.source.split('function renderTransferDecisionGroup', 1)[1]
        group = group.split('function renderTransferDecisionSection', 1)[0]
        self.assertIn(
            '<details class="transfer-decision-group" id="${detailsId}">',
            group,
        )

    def test_transfer_pdf_has_selectable_sections_and_generation_metadata(self):
        options = self.source.split('function transferPdfExportOptions', 1)[1]
        options = options.split('function ensureTransferPdfExportDialog', 1)[0]
        self.assertIn("label: 'Common / Transferable'", options)
        self.assertIn("label: 'Uncommon / Return to Office'", options)
        self.assertIn("label: 'Needed From Office'", options)

        builder = self.source.split('function buildTransferPdfPagesV2', 1)[1]
        builder = builder.split('async function generateTransferPdf', 1)[0]
        self.assertIn('Generated by', builder)
        self.assertIn('Generated on', builder)
        self.assertIn('FROM EVENT', builder)
        self.assertIn('TO EVENT', builder)
        self.assertNotIn('transferNumber', builder)

        generator = self.source.split(
            "async function generateTransferPdf(selectedModes = ['common'])",
            1,
        )[1]
        self.assertIn('generatedAt: reportGeneratedAt()', generator)
        self.assertIn('generatedBy', generator)
        self.assertNotIn('transferNumber', generator)

    def test_transfer_workspace_has_export_dialog_and_responsive_route(self):
        self.assertIn('.transfer-export-options {', self.template)
        self.assertIn('.transfer-tool-button-primary {', self.template)
        self.assertIn(
            'grid-template-columns: minmax(0, 1fr) 84px minmax(0, 1fr);',
            self.template,
        )
        self.assertIn('function renderTransferTargetSubprojects(', self.source)
        self.assertIn('function transferChooseTargetSubproject(', self.source)
        self.assertIn('toSubprojectId: transferSelectedTargetSubproject()?.id', self.source)
        self.assertIn('subprojectId: transferSelectedTargetSubproject()?.id', self.source)
        self.assertIn('&toSubprojectId=${encodeURIComponent(toSubprojectId)}', self.source)
        self.assertIn('.transfer-target-subproject-tabs {', self.template)


if __name__ == '__main__':
    unittest.main()
