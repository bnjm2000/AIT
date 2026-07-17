import io
import os
import tempfile
import unittest
from datetime import datetime
from urllib.parse import quote
from unittest.mock import patch

import app as app_module
from data_manager import DataManager
from maintenance_logs import normalize_maintenance_log
from models import InventoryItem, User, hash_password


class MaintenanceMediaTests(unittest.TestCase):
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

    def upload_media(self):
        encoded_asset_id = quote(self.asset_id, safe='')
        response = self.client.post(
            f'/api/assets/{encoded_asset_id}/maintain',
            data={
                'logEntry': 'Attached diagnostic photo',
                'maintenanceDate': datetime.now().strftime('%Y-%m-%d'),
                'logType': 'Repair',
                'assetStatus': 'nochange',
                'media': (io.BytesIO(b'png-bytes'), 'diagnostic photo.png'),
            },
            content_type='multipart/form-data',
        )
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        log = normalize_maintenance_log(
            self.data_manager.inventory[self.asset_id].maintenance_logs[0]
        )
        return log['media'][0]

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

    def test_only_admin_can_permanently_remove_individual_media(self):
        self.login_as('normal')
        media = self.upload_media()
        media_path = os.path.join(self.tempdir.name, media['path'])
        media_url = f"/api/maintenance-media/{quote(media['id'], safe='')}"

        forbidden = self.client.delete(media_url)

        self.assertEqual(forbidden.status_code, 403)
        self.assertTrue(os.path.exists(media_path))
        retained_log = normalize_maintenance_log(
            self.data_manager.inventory[self.asset_id].maintenance_logs[0]
        )
        self.assertEqual([item['id'] for item in retained_log['media']], [media['id']])

        self.login_as('admin', is_admin=True)
        deleted = self.client.delete(media_url)

        self.assertEqual(deleted.status_code, 200, deleted.get_data(as_text=True))
        self.assertEqual(deleted.get_json()['deletedReferenceCount'], 1)
        self.assertTrue(deleted.get_json()['fileDeleted'])
        self.assertFalse(os.path.exists(media_path))

        remaining_log = normalize_maintenance_log(
            self.data_manager.inventory[self.asset_id].maintenance_logs[0]
        )
        self.assertEqual(remaining_log['media'], [])
        self.assertEqual(self.client.get(media_url).status_code, 404)

        reloaded = DataManager(self.tempdir.name)
        reloaded.load_inventory()
        persisted_log = normalize_maintenance_log(
            reloaded.inventory[self.asset_id].maintenance_logs[0]
        )
        self.assertEqual(persisted_log['media'], [])

    def test_add_and_edit_publish_asset_scoped_inventory_updates(self):
        self.login_as('normal')
        encoded_asset_id = quote(self.asset_id, safe='')
        maintenance_date = datetime.now().strftime('%Y-%m-%d')

        with patch.object(app_module, '_publish_realtime_update_now') as publish:
            response = self.client.post(
                f'/api/assets/{encoded_asset_id}/maintain',
                json={
                    'logEntry': 'Initial inspection',
                    'maintenanceDate': maintenance_date,
                    'logType': 'General',
                    'assetStatus': 'nochange',
                },
            )

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        add_changes = publish.call_args.args[1]['changes']
        add_inventory = next(change for change in add_changes if change['topic'] == 'inventory-data')
        self.assertEqual(add_inventory['details']['assetIds'], [self.asset_id])
        self.assertEqual(add_inventory['details']['action'], 'maintenance-added')

        with patch.object(app_module, '_publish_realtime_update_now') as publish:
            response = self.client.put(
                f'/api/assets/{encoded_asset_id}/maintenance-log-enhanced/0',
                json={
                    'date': maintenance_date,
                    'user': 'normal',
                    'description': 'Inspection found a fault',
                    'logType': 'General',
                    'assetStatus': 'ooc',
                },
            )

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        edit_changes = publish.call_args.args[1]['changes']
        edit_inventory = next(change for change in edit_changes if change['topic'] == 'inventory-data')
        self.assertEqual(edit_inventory['details']['assetIds'], [self.asset_id])
        self.assertEqual(edit_inventory['details']['action'], 'maintenance-log-updated')


if __name__ == '__main__':
    unittest.main()
