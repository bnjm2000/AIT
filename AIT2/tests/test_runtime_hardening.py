import io
import tempfile
import unittest

import app as app_module
from data_manager import DataManager
from models import Event, InventoryItem, User, hash_password


class RuntimeHardeningTests(unittest.TestCase):
    def setUp(self):
        self.original_manager = app_module.get_default_data_manager()
        self.original_testing = app_module.app.config.get('TESTING')
        self.original_event_limit = app_module.EVENT_FILE_MAX_BYTES
        self.tempdir = tempfile.TemporaryDirectory()

        self.manager = DataManager(self.tempdir.name)
        self.manager.setup_data_folder()
        self.manager.check_and_initialize_files()
        self.manager.users = {
            'admin': User(
                'admin',
                hash_password('admin', 'salt'),
                'salt',
                True,
                True,
            ),
        }
        self.manager.inventory = {
            'AX#01': InventoryItem(
                'AX#01',
                'Brand',
                'Model',
                'SERIAL',
                'Description',
                False,
                [],
                'AX',
                'Store',
                'Store',
            ),
        }
        self.manager.events = {
            1: Event(
                1,
                'Future Event',
                '20990101',
                '20990102',
                [],
                prepared_items=['AX#01'],
                notes='private detail',
                location='Test Venue',
            ),
        }
        self.manager.save_users()
        self.manager.save_inventory()
        self.manager.save_event(self.manager.events[1])

        app_module.app.config['TESTING'] = True
        app_module.set_data_manager_for_testing(self.manager)
        self.client = app_module.app.test_client()
        with self.client.session_transaction() as session:
            session['user'] = 'admin'
            session['is_admin'] = True

    def tearDown(self):
        app_module.EVENT_FILE_MAX_BYTES = self.original_event_limit
        app_module.clear_test_data_manager(self.original_manager)
        app_module.app.config['TESTING'] = self.original_testing
        self.tempdir.cleanup()

    def test_health_and_readiness_are_available(self):
        self.assertEqual(self.client.get('/health').status_code, 200)
        self.assertEqual(self.client.get('/readiness').status_code, 200)

    def test_summary_views_omit_heavy_detail_and_support_etag(self):
        event_response = self.client.get('/api/events?view=summary')
        self.assertEqual(event_response.status_code, 200)
        event = event_response.get_json()['data'][0]
        self.assertNotIn('preparedItems', event)
        self.assertNotIn('modelGroups', event)

        # The first request may create the default department settings file.
        self.client.get('/api/assets?view=summary')
        asset_response = self.client.get('/api/assets?view=summary')
        self.assertEqual(asset_response.status_code, 200)
        asset = asset_response.get_json()['data'][0]
        self.assertNotIn('maintenanceLogRecords', asset)
        self.assertNotIn('changeHistory', asset)

        unchanged = self.client.get(
            '/api/assets?view=summary',
            headers={'If-None-Match': asset_response.headers['ETag']},
        )
        self.assertEqual(unchanged.status_code, 304)

    def test_event_upload_rejects_a_file_above_its_limit(self):
        app_module.EVENT_FILE_MAX_BYTES = 10
        response = self.client.post(
            '/api/events/1/files',
            data={'files': (io.BytesIO(b'12345678901'), 'too-large.txt')},
            content_type='multipart/form-data',
        )

        self.assertEqual(response.status_code, 400)
        self.assertIn('larger than', response.get_json()['error'])


if __name__ == '__main__':
    unittest.main()
