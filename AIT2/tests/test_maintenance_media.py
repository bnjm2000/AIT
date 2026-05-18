import io
import os
import tempfile
import unittest
from datetime import datetime
from urllib.parse import quote

import app as app_module
from data_manager import DataManager
from maintenance_logs import normalize_maintenance_log
from models import InventoryItem, User, hash_password


class MaintenanceMediaTests(unittest.TestCase):
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

        self.asset_id = 'A#01'
        self.data_manager.inventory[self.asset_id] = InventoryItem(
            asset_id=self.asset_id,
            brand='Test',
            model_number='Model',
            serial_number='SN123',
            description='Asset with media',
            is_missing=False,
            maintenance_logs=[],
            department_code='AX',
            default_location='Store',
            current_location='Store',
        )
        self.data_manager.save_inventory()

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

    def test_maintenance_media_is_preserved_on_edit_and_deleted_with_log(self):
        self.login_as('normal')
        encoded_asset_id = quote(self.asset_id, safe='')
        maintenance_date = datetime.now().strftime('%Y-%m-%d')

        response = self.client.post(
            f'/api/assets/{encoded_asset_id}/maintain',
            data={
                'logEntry': 'Replaced cracked lens',
                'maintenanceDate': maintenance_date,
                'logType': 'Repair',
                'assetStatus': 'nochange',
                'media': (io.BytesIO(b'png-bytes'), 'lens photo.png'),
            },
            content_type='multipart/form-data',
        )

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        log = normalize_maintenance_log(self.data_manager.inventory[self.asset_id].maintenance_logs[0])
        self.assertEqual(len(log['media']), 1)
        media = log['media'][0]
        media_path = os.path.join(self.tempdir.name, media['path'])
        self.assertTrue(os.path.exists(media_path))

        assets_response = self.client.get('/api/assets')
        self.assertEqual(assets_response.status_code, 200)
        asset_payload = assets_response.get_json()['data'][0]
        response_media = asset_payload['maintenanceLogRecords'][0]['media'][0]
        self.assertIn('/api/maintenance-media/', response_media['url'])

        media_response = self.client.get(response_media['url'])
        self.assertEqual(media_response.status_code, 200)
        self.assertEqual(media_response.get_data(), b'png-bytes')
        media_response.close()

        response = self.client.put(
            f'/api/assets/{encoded_asset_id}/maintenance-log-enhanced/0',
            json={
                'date': maintenance_date,
                'user': 'normal',
                'description': 'Replaced cracked lens and retested',
                'logType': 'Repair',
                'assetStatus': 'nochange',
            },
        )

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        edited_log = normalize_maintenance_log(self.data_manager.inventory[self.asset_id].maintenance_logs[0])
        self.assertEqual(edited_log['media'][0]['id'], media['id'])
        self.assertTrue(os.path.exists(media_path))

        self.login_as('admin', is_admin=True)
        response = self.client.delete(f'/api/assets/{encoded_asset_id}/maintenance-log/0')

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertFalse(os.path.exists(media_path))
        self.assertEqual(self.data_manager.inventory[self.asset_id].maintenance_logs, [])


if __name__ == '__main__':
    unittest.main()
