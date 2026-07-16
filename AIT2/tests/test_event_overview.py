import csv
import os
import tempfile
import unittest

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

    def test_summary_includes_department_progress_without_full_model_groups(self):
        event = self.data_manager.events[1]
        event.prepared_items = ['[MODEL]AX|TestBrand|TestModel|2|Test asset']
        event.actually_prepared = ['A#01']
        event.start_date = '20260720'
        event.end_date = '20260721'
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
        bulk = next(item for item in response.get_json()['data'] if item.get('bulkId') == 'BULK-01')
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

        response = self.client.post('/api/events', json={
            'name': 'New assigned event',
            'location': 'Expo',
            'startDate': '2026-07-03',
            'endDate': '2026-07-03',
            'tag': 'events',
            'assignedUsers': ['alice', 'bob'],
        })
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        event_id = response.get_json()['eventId']
        self.assertEqual(self.data_manager.events[event_id].assigned_users, ['alice', 'bob'])

        response = self.client.put(f'/api/events/{event_id}', json={
            'name': 'New assigned event',
            'location': 'Expo',
            'startDate': '2026-07-03',
            'endDate': '2026-07-03',
            'tag': 'events',
            'assignedUsers': ['bob'],
        })
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertEqual(self.data_manager.events[event_id].assigned_users, ['bob'])

        reloaded = DataManager(self.tempdir.name)
        reloaded.load_events()
        self.assertEqual(reloaded.events[event_id].assigned_users, ['bob'])

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


if __name__ == '__main__':
    unittest.main()
