import io
import os
import tempfile
import unittest
from urllib.parse import quote
from unittest.mock import patch

import app as app_module
from flask import session
from data_manager import DataManager
from models import Event, LogEntry, User, hash_password


class EventNotesFilesTests(unittest.TestCase):
    def setUp(self):
        self.original_data_manager = app_module.get_default_data_manager()
        self.original_signature = app_module._data_snapshot_signature
        self.original_testing = app_module.app.config.get('TESTING')
        self.tempdir = tempfile.TemporaryDirectory()

        self.data_manager = DataManager(self.tempdir.name)
        self.data_manager.setup_data_folder()
        self.data_manager.users = {
            'normal': User('normal', hash_password('pw', 'salt'), 'salt', False, True),
            'admin': User('admin', hash_password('pw', 'salt'), 'salt', True, True),
            'manager': User(
                'manager', hash_password('pw', 'managersalt'), 'managersalt',
                True, True, role='manager',
            ),
        }
        self.data_manager.save_users()
        self.data_manager.logs = []
        self.data_manager.save_logs()

        event = Event(
            1,
            'Test Event',
            '20260517',
            '20260517',
            [],
            prepared_items=[],
            returned_items=[],
            actually_prepared=[],
            extra_assets=[],
            tag='events',
            assigned_users=['normal'],
        )
        self.data_manager.events[1] = event
        self.data_manager.save_event(event)

        app_module.app.config['TESTING'] = True
        app_module.set_data_manager_for_testing(self.data_manager)
        self.client = app_module.app.test_client()

    def tearDown(self):
        app_module.clear_test_data_manager(self.original_data_manager)
        app_module._data_snapshot_signature = self.original_signature
        app_module.app.config['TESTING'] = self.original_testing
        self.tempdir.cleanup()

    def login_as(self, username, is_admin=False):
        with self.client.session_transaction() as session:
            session['user'] = username
            session['is_admin'] = is_admin

    def test_authenticated_user_can_update_event_notes(self):
        self.login_as('normal')

        response = self.client.put('/api/events/1/notes', json={
            'notes': 'Crew call: 10am\nBring backup adapters.'
        })

        self.assertEqual(response.status_code, 200)
        self.data_manager.load_events()
        self.assertEqual(
            self.data_manager.events[1].notes,
            'Crew call: 10am\nBring backup adapters.'
        )
        self.assertEqual(self.data_manager.logs, [])
        event_logs = self.data_manager.events[1].event_logs
        self.assertEqual(len(event_logs), 1)
        self.assertIn('Updated notes for event 1', event_logs[0]['action'])

        response = self.client.get('/api/events/1')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()['data']['eventLogs'], [])

        self.login_as('admin', is_admin=True)
        log_response = self.client.get('/api/events/1/logs')
        self.assertEqual(log_response.status_code, 200)
        self.assertEqual(log_response.get_json()['data']['logs'][0]['action'], event_logs[0]['action'])

    def test_existing_event_logs_migrate_out_of_system_log(self):
        self.data_manager.logs = [
            LogEntry('2026/05/28 10:00:00', 'admin', 'Prepared asset A#01 for event 1'),
            LogEntry('2026/05/28 10:01:00', 'admin', 'User admin logged in via web interface'),
        ]
        self.data_manager.save_logs()

        self.data_manager.load_all_data()

        self.assertEqual(len(self.data_manager.logs), 1)
        self.assertEqual(self.data_manager.logs[0].action, 'User admin logged in via web interface')
        event_logs = self.data_manager.events[1].event_logs
        self.assertEqual(len(event_logs), 1)
        self.assertEqual(event_logs[0]['action'], 'Prepared asset A#01 for event 1')

    def test_encoded_custom_asset_references_are_human_readable(self):
        marker = app_module._make_custom_marker(
            'LOAN',
            'Wireless microphone package',
            2,
            'AX',
            'Rental Company Pte Ltd',
        )
        records = self.data_manager.normalize_event_logs([{
            'timestamp': '2026/07/29 10:00:00',
            'user': 'admin',
            'action': f'Removed custom asset {marker} from event 1',
        }])

        self.assertEqual(len(records), 1)
        self.assertNotIn('[CUSTOM]', records[0]['action'])
        self.assertIn(
            'Wireless microphone package (loan from Rental Company Pte Ltd)',
            records[0]['action'],
        )

    def test_system_only_asset_log_does_not_become_an_event_log(self):
        event_log_count = len(self.data_manager.events[1].event_logs)

        with app_module.app.test_request_context('/api/assets/A-01/maintain'):
            session['user'] = 'admin'
            session['is_admin'] = True
            app_module.log_action(
                'Maintenance logged for asset A-01: Fault found after event 1',
                system_log_only=True,
            )

        self.assertEqual(len(self.data_manager.events[1].event_logs), event_log_count)
        self.assertEqual(len(self.data_manager.logs), 1)
        self.assertEqual(
            self.data_manager.logs[0].action,
            'Maintenance logged for asset A-01: Fault found after event 1',
        )

    def test_system_log_persistence_keeps_latest_3000_entries(self):
        self.data_manager.logs = [
            LogEntry(f'2026/07/16 10:{index // 60:02d}:{index % 60:02d}', 'admin', f'Action {index}')
            for index in range(3005)
        ]

        self.data_manager.save_logs()
        self.data_manager.load_logs()

        self.assertEqual(len(self.data_manager.logs), 3000)
        self.assertEqual(self.data_manager.logs[0].action, 'Action 5')
        self.assertEqual(self.data_manager.logs[-1].action, 'Action 3004')

    def test_event_activity_is_categorized_and_manpower_is_admin_only(self):
        event = self.data_manager.events[1]
        event.event_logs = [
            {
                'timestamp': '2026/07/06 09:00:00',
                'user': 'admin',
                'action': 'Updated event 1 details: Location: A → B',
            },
            {
                'timestamp': '2026/07/06 09:05:00',
                'user': 'worker',
                'action': 'Assigned specific asset A#01 to event 1',
            },
            {
                'timestamp': '2026/07/06 09:10:00',
                'user': 'worker',
                'action': 'Returned asset A#01 from event 1',
            },
            {
                'timestamp': '2026/07/06 09:15:00',
                'user': 'Jordan',
                'action': 'Worker Jordan uploaded 1 invoice file(s) for event 1',
            },
        ]
        self.data_manager.save_event(event)

        self.login_as('normal')
        normal_logs = self.client.get('/api/events/1').get_json()['data']['eventLogs']
        self.assertEqual(normal_logs, [])

        self.login_as('admin', is_admin=True)
        admin_logs = self.client.get('/api/events/1').get_json()['data']['eventLogs']
        self.assertEqual(
            [row['category'] for row in admin_logs],
            ['details', 'prepare', 'return', 'manpower'],
        )

        secured_logs = self.client.get('/api/events/1/logs')
        self.assertEqual(secured_logs.status_code, 200)
        self.assertEqual(len(secured_logs.get_json()['data']['logs']), 4)

    def test_managers_and_users_cannot_view_system_or_event_logs(self):
        for username in ('normal', 'manager'):
            self.login_as(username, is_admin=username == 'manager')
            system_response = self.client.get('/api/logs')
            event_response = self.client.get('/api/events/1/logs')
            page_response = self.client.get('/logs')

            self.assertEqual(system_response.status_code, 403)
            self.assertEqual(event_response.status_code, 403)
            self.assertEqual(page_response.status_code, 302)
            self.assertTrue(page_response.headers['Location'].endswith('/events'))

    def test_event_detail_update_log_lists_changed_fields(self):
        self.login_as('admin', is_admin=True)

        response = self.client.put('/api/events/1', json={
            'name': 'Updated Event',
            'location': 'Hall A',
            'startDate': '2026-05-17',
            'endDate': '2026-05-18',
            'tag': 'events',
        })

        self.assertEqual(response.status_code, 200)
        action = self.data_manager.events[1].event_logs[-1]['action']
        self.assertIn('Updated event 1 details:', action)
        self.assertIn('Name: Test Event → Updated Event', action)
        self.assertIn('Location: — → Hall A', action)
        self.assertIn('End date: 2026/05/17 → 2026/05/18', action)

    def test_users_can_upload_files_but_only_admins_can_delete_them(self):
        self.login_as('normal')

        response = self.client.post(
            '/api/events/1/files',
            data={'files': (io.BytesIO(b'hello'), 'Spec Sheet.txt')},
            content_type='multipart/form-data',
        )

        self.assertEqual(response.status_code, 200)
        uploaded = response.get_json()['data'][0]['name']
        upload_path = os.path.join(self.data_manager.get_event_folder(1), uploaded)
        self.assertTrue(os.path.exists(upload_path))

        response = self.client.delete(f'/api/events/1/files/{quote(uploaded)}')
        self.assertEqual(response.status_code, 403)
        self.assertTrue(os.path.exists(upload_path))

        self.login_as('admin', is_admin=True)
        response = self.client.delete(f'/api/events/1/files/{quote(uploaded)}')

        self.assertEqual(response.status_code, 200)
        self.assertFalse(os.path.exists(upload_path))

    def test_event_file_preview_is_inline_for_supported_types_only(self):
        self.login_as('normal')
        response = self.client.post(
            '/api/events/1/files',
            data={
                'files': [
                    (io.BytesIO(b'%PDF-1.4 preview'), 'Run Sheet.pdf'),
                    (io.BytesIO(b'<script>alert(1)</script>'), 'unsafe.html'),
                ],
            },
            content_type='multipart/form-data',
        )

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        files = {row['name']: row for row in response.get_json()['data']}
        self.assertEqual(files['Run Sheet.pdf']['previewKind'], 'pdf')
        self.assertTrue(files['Run Sheet.pdf']['previewUrl'].endswith('?preview=1'))
        self.assertEqual(files['unsafe.html']['previewKind'], '')
        self.assertEqual(files['unsafe.html']['previewUrl'], '')

        preview = self.client.get(files['Run Sheet.pdf']['previewUrl'])
        self.assertEqual(preview.status_code, 200)
        self.assertEqual(preview.mimetype, 'application/pdf')
        self.assertTrue(preview.headers['Content-Disposition'].startswith('inline;'))
        self.assertEqual(preview.headers['X-Content-Type-Options'], 'nosniff')

        blocked = self.client.get(
            f"/api/events/1/files/{quote('unsafe.html')}?preview=1"
        )
        self.assertEqual(blocked.status_code, 415)

    def test_event_upload_limit_applies_to_all_existing_and_new_files(self):
        self.login_as('normal')
        with patch.object(app_module, 'EVENT_FILE_MAX_BYTES', 10):
            first = self.client.post(
                '/api/events/1/files',
                data={'files': (io.BytesIO(b'123456'), 'first.txt')},
                content_type='multipart/form-data',
            )
            second = self.client.post(
                '/api/events/1/files',
                data={'files': (io.BytesIO(b'12345'), 'second.txt')},
                content_type='multipart/form-data',
            )

        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 400)
        self.assertIn('in total', second.get_json()['error'])
        folder_files = os.listdir(self.data_manager.get_event_folder(1))
        self.assertIn('first.txt', folder_files)
        self.assertNotIn('second.txt', folder_files)

    def test_saving_an_event_does_not_create_event_backups(self):
        event = self.data_manager.events[1]
        event.notes = 'Updated without a backup'
        self.data_manager.save_event(event)

        self.assertFalse(
            os.path.exists(os.path.join(self.data_manager.data_folder, 'event_backups'))
        )

    def test_event_file_ui_exposes_preview_and_total_limit(self):
        project_root = os.path.dirname(app_module.__file__)
        with open(
            os.path.join(project_root, 'static', 'js', 'app.js'),
            encoding='utf-8',
        ) as source:
            script = source.read()
        with open(
            os.path.join(project_root, 'templates', 'index.html'),
            encoding='utf-8',
        ) as source:
            template = source.read()

        self.assertIn('function previewEventFile(', script)
        self.assertIn('EVENT_FILES_TOTAL_LIMIT_BYTES = 20 * 1024 * 1024', script)
        self.assertIn('20 MB total', script)
        self.assertIn('id="eventFilePreviewModal"', template)

    def test_event_folder_moves_when_event_filename_changes(self):
        folder = self.data_manager.get_event_folder(1, create=True)
        old_file = os.path.join(folder, 'brief.txt')
        with open(old_file, 'wb') as f:
            f.write(b'brief')

        event = self.data_manager.events[1]
        event.name = 'Renamed Event'
        self.data_manager.save_event(event)

        new_folder = self.data_manager.get_event_folder(1)
        self.assertNotEqual(folder, new_folder)
        self.assertFalse(os.path.exists(folder))
        self.assertTrue(os.path.exists(os.path.join(new_folder, 'brief.txt')))


if __name__ == '__main__':
    unittest.main()
