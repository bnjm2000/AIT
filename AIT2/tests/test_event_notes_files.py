import io
import os
import tempfile
import unittest
from urllib.parse import quote

import app as app_module
from data_manager import DataManager
from models import Event, User, hash_password


class EventNotesFilesTests(unittest.TestCase):
    def setUp(self):
        self.original_data_manager = app_module.data_manager
        self.original_signature = app_module._data_snapshot_signature
        self.tempdir = tempfile.TemporaryDirectory()

        self.data_manager = DataManager(self.tempdir.name)
        self.data_manager.setup_data_folder()
        self.data_manager.users = {
            'normal': User('normal', hash_password('pw', 'salt'), 'salt', False, True),
            'admin': User('admin', hash_password('pw', 'salt'), 'salt', True, True),
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
        )
        self.data_manager.events[1] = event
        self.data_manager.save_event(event)

        app_module.data_manager = self.data_manager
        app_module.mark_data_snapshot_current()
        app_module.app.config['TESTING'] = True
        self.client = app_module.app.test_client()

    def tearDown(self):
        app_module.data_manager = self.original_data_manager
        app_module._data_snapshot_signature = self.original_signature
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
