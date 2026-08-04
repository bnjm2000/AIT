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
            'technician': User(
                'technician',
                hash_password('pw', 'salt'),
                'salt',
                False,
                True,
                name='Technician Lee',
            ),
            'inactive': User('inactive', hash_password('pw', 'salt'), 'salt', False, False),
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
        self.assertTrue(log['createdAt'])
        created_at = log['createdAt']
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
        self.assertEqual(edited_log['createdAt'], created_at)
        self.assertEqual(edited_log['media'][0]['id'], media['id'])
        self.assertTrue(os.path.exists(media_path))

        self.login_as('admin', is_admin=True)
        response = self.client.delete(f'/api/assets/{encoded_asset_id}/maintenance-log/0')

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertFalse(os.path.exists(media_path))
        self.assertEqual(self.data_manager.inventory[self.asset_id].maintenance_logs, [])

    def test_maintenance_log_accepts_multiple_media_in_one_submission(self):
        self.login_as('normal')
        encoded_asset_id = quote(self.asset_id, safe='')
        response = self.client.post(
            f'/api/assets/{encoded_asset_id}/maintain',
            data={
                'logEntry': 'Captured the fault from two angles',
                'maintenanceDate': datetime.now().strftime('%Y-%m-%d'),
                'logType': 'Fault',
                'assetStatus': 'nochange',
                'media': [
                    (io.BytesIO(b'first-photo'), 'angle one.png'),
                    (io.BytesIO(b'second-photo'), 'angle two.png'),
                ],
            },
            content_type='multipart/form-data',
        )

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        log = normalize_maintenance_log(
            self.data_manager.inventory[self.asset_id].maintenance_logs[0]
        )
        self.assertEqual(
            [media['name'] for media in log['media']],
            ['angle one.png', 'angle two.png'],
        )
        self.assertTrue(all(
            os.path.isfile(os.path.join(self.tempdir.name, media['path']))
            for media in log['media']
        ))

    def test_editing_update_log_detects_and_applies_confirmed_version(self):
        self.login_as('normal')
        encoded_asset_id = quote(self.asset_id, safe='')
        maintenance_date = datetime.now().strftime('%Y-%m-%d')
        self.data_manager.inventory[self.asset_id].version = 'v1.0'
        self.data_manager.save_inventory()

        created = self.client.post(
            f'/api/assets/{encoded_asset_id}/maintain',
            json={
                'logEntry': 'Initial inspection',
                'maintenanceDate': maintenance_date,
                'logType': 'General',
                'assetStatus': 'nochange',
            },
        )
        self.assertEqual(created.status_code, 200, created.get_data(as_text=True))

        response = self.client.put(
            f'/api/assets/{encoded_asset_id}/maintenance-log-enhanced/0',
            json={
                'date': maintenance_date,
                'user': 'normal',
                'description': 'Updated from v1.0 to v1.2',
                'logType': 'Update',
                'confirmVersionUpdate': True,
                'assetStatus': 'nochange',
            },
        )

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        asset = self.data_manager.inventory[self.asset_id]
        self.assertEqual(asset.version, 'v1.2')
        edited_log = normalize_maintenance_log(asset.maintenance_logs[0])
        self.assertIn({'kind': 'version', 'value': 'v1.2'}, edited_log['changes'])

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

    def test_user_can_record_maintenance_on_behalf_of_active_company_user(self):
        self.login_as('normal')
        options_response = self.client.get('/api/maintenance/users')

        self.assertEqual(options_response.status_code, 200)
        options = options_response.get_json()['data']
        usernames = {option['username'] for option in options}
        self.assertTrue({'normal', 'technician'}.issubset(usernames))
        self.assertNotIn('inactive', usernames)

        encoded_asset_id = quote(self.asset_id, safe='')
        maintenance_date = datetime.now().strftime('%Y-%m-%d')
        response = self.client.post(
            f'/api/assets/{encoded_asset_id}/maintain',
            json={
                'logEntry': 'Inspected on behalf of technician',
                'maintenanceDate': maintenance_date,
                'logType': 'General',
                'assetStatus': 'nochange',
                'maintenanceUser': 'technician',
            },
        )

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        payload = response.get_json()['maintenanceLog']
        self.assertEqual(payload['user'], 'technician')
        self.assertEqual(payload['userDisplayName'], 'Technician Lee')
        log = normalize_maintenance_log(
            self.data_manager.inventory[self.asset_id].maintenance_logs[0]
        )
        self.assertEqual(log['source']['recordedBy'], 'normal')

        edit_response = self.client.put(
            f'/api/assets/{encoded_asset_id}/maintenance-log-enhanced/0',
            json={
                'date': maintenance_date,
                'user': 'normal',
                'description': 'Inspection completed on behalf of technician',
                'logType': 'General',
                'assetStatus': 'nochange',
            },
        )
        self.assertEqual(edit_response.status_code, 200, edit_response.get_data(as_text=True))
        edited_log = normalize_maintenance_log(
            self.data_manager.inventory[self.asset_id].maintenance_logs[0]
        )
        self.assertEqual(edited_log['user'], 'technician')
        self.assertEqual(edited_log['source']['recordedBy'], 'normal')

    def test_maintenance_rejects_unknown_or_inactive_attribution(self):
        self.login_as('normal')
        encoded_asset_id = quote(self.asset_id, safe='')
        maintenance_date = datetime.now().strftime('%Y-%m-%d')

        for username in ('unknown', 'inactive'):
            response = self.client.post(
                f'/api/assets/{encoded_asset_id}/maintain',
                json={
                    'logEntry': 'Invalid attribution attempt',
                    'maintenanceDate': maintenance_date,
                    'logType': 'General',
                    'assetStatus': 'nochange',
                    'maintenanceUser': username,
                },
            )
            self.assertEqual(response.status_code, 400, response.get_data(as_text=True))
            self.assertIn('active user from your company', response.get_json()['error'])

        self.assertEqual(self.data_manager.inventory[self.asset_id].maintenance_logs, [])

    def test_bulk_maintenance_can_be_recorded_on_behalf_of_another_user(self):
        bulk_id = 'BULK-01'
        self.data_manager.inventory[bulk_id] = InventoryItem(
            asset_id=bulk_id,
            brand='Test',
            model_number='Bulk Model',
            serial_number='',
            description='Bulk maintenance item',
            is_missing=False,
            maintenance_logs=[],
            department_code='AX',
            default_location='Store',
            current_location='Store',
            is_bulk=True,
            quantity=3,
        )
        self.data_manager.save_inventory()
        self.login_as('normal')

        response = self.client.post(
            f'/api/assets/{bulk_id}/maintain',
            json={
                'logEntry': 'Two units require repair',
                'maintenanceDate': datetime.now().strftime('%Y-%m-%d'),
                'logType': 'Fault',
                'assetStatus': 'ooc',
                'affectedQuantity': 2,
                'maintenanceUser': 'technician',
            },
        )

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        logs = [
            normalize_maintenance_log(log)
            for log in self.data_manager.inventory[bulk_id].maintenance_logs
        ]
        self.assertEqual(len(logs), 2)
        self.assertTrue(all(log['user'] == 'technician' for log in logs))
        self.assertTrue(all(log['source']['recordedBy'] == 'normal' for log in logs))


if __name__ == '__main__':
    unittest.main()
