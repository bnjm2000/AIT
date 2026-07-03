import io
import os
import tempfile
import unittest
from datetime import datetime

import app as app_module
from data_manager import DataManager
from maintenance_logs import normalize_maintenance_log
from models import Container, InventoryItem, User, hash_password


class ContainerMaintenanceTests(unittest.TestCase):
    def setUp(self):
        self.original_data_manager = app_module.get_default_data_manager()
        self.original_signature = app_module._data_snapshot_signature
        self.original_testing = app_module.app.config.get('TESTING')
        self.tempdir = tempfile.TemporaryDirectory()

        self.data_manager = DataManager(self.tempdir.name)
        self.data_manager.setup_data_folder()
        self.data_manager.users = {
            'normal': User('normal', hash_password('pw', 'salt'), 'salt', False, True),
            'admin': User('admin', hash_password('pw', 'salt2'), 'salt2', True, True),
        }
        self.data_manager.save_users()
        self.data_manager.logs = []
        self.data_manager.save_logs()
        self.data_manager.inventory = {
            asset_id: InventoryItem(
                asset_id=asset_id,
                brand='Test',
                model_number='Model',
                serial_number=f'SN-{asset_id}',
                description='Container maintenance test asset',
                is_missing=False,
                maintenance_logs=[],
                department_code='AX',
                default_location='Store',
                current_location='Store',
            )
            for asset_id in ('A#01', 'A#02')
        }
        self.data_manager.containers = {
            'CASE-1': Container('CASE-1', ['A#01', 'A#02'], 'CASE-SN'),
        }
        self.data_manager.save_inventory()
        self.data_manager.save_containers()

        app_module.app.config['TESTING'] = True
        app_module.set_data_manager_for_testing(self.data_manager)
        app_module.invalidate_cache()
        self.client = app_module.app.test_client()
        self.login('normal', False)

    def tearDown(self):
        app_module.clear_test_data_manager(self.original_data_manager)
        app_module._data_snapshot_signature = self.original_signature
        app_module.app.config['TESTING'] = self.original_testing
        self.tempdir.cleanup()

    def login(self, username, is_admin):
        with self.client.session_transaction() as session:
            session['user'] = username
            session['is_admin'] = is_admin

    def payload(self, request_id='container-maintenance-request-1'):
        return {
            'logEntry': 'Cleaned case and tested all contents',
            'logType': 'Preventative maintenance',
            'maintenanceDate': datetime.now().strftime('%Y-%m-%d'),
            'cost': '25',
            'requestId': request_id,
        }

    def test_container_log_is_stored_and_propagated_to_current_assets(self):
        response = self.client.post('/api/containers/CASE-1/maintain', json=self.payload())

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertEqual(response.get_json()['assetCount'], 2)
        self.assertEqual(len(self.data_manager.containers['CASE-1'].maintenance_logs), 1)

        container_log = normalize_maintenance_log(
            self.data_manager.containers['CASE-1'].maintenance_logs[0]
        )
        self.assertEqual(container_log['source']['kind'], 'container')
        self.assertEqual(container_log['source']['containerId'], 'CASE-1')
        self.assertEqual(container_log['cost'], '25.00')

        for asset_id in ('A#01', 'A#02'):
            asset_log = normalize_maintenance_log(
                self.data_manager.inventory[asset_id].maintenance_logs[0]
            )
            self.assertEqual(asset_log['id'], container_log['id'])
            self.assertEqual(asset_log['source']['containerId'], 'CASE-1')

        container_response = self.client.get('/api/containers/CASE-1').get_json()['data']
        self.assertEqual(container_response['maintenanceLogCount'], 1)
        self.assertEqual(
            container_response['maintenanceLogRecords'][0]['source']['kind'],
            'container',
        )

    def test_asset_keeps_log_after_it_is_removed_from_container(self):
        create_response = self.client.post(
            '/api/containers/CASE-1/maintain',
            json=self.payload(),
        )
        self.assertEqual(create_response.status_code, 200)

        update_response = self.client.put('/api/containers/CASE-1', json={
            'assetIds': ['A#02'],
        })

        self.assertEqual(update_response.status_code, 200, update_response.get_data(as_text=True))
        self.assertEqual(self.data_manager.containers['CASE-1'].asset_ids, ['A#02'])
        retained_log = normalize_maintenance_log(
            self.data_manager.inventory['A#01'].maintenance_logs[0]
        )
        self.assertEqual(retained_log['source']['containerId'], 'CASE-1')

    def test_repeated_request_is_idempotent(self):
        first = self.client.post('/api/containers/CASE-1/maintain', json=self.payload())
        second = self.client.post('/api/containers/CASE-1/maintain', json=self.payload())

        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 200)
        self.assertTrue(second.get_json()['duplicate'])
        self.assertEqual(len(self.data_manager.containers['CASE-1'].maintenance_logs), 1)
        self.assertEqual(len(self.data_manager.inventory['A#01'].maintenance_logs), 1)

    def test_propagated_log_cannot_be_changed_or_deleted_from_one_asset(self):
        response = self.client.post('/api/containers/CASE-1/maintain', json=self.payload())
        self.assertEqual(response.status_code, 200)

        update_response = self.client.put(
            '/api/assets/A%2301/maintenance-log-enhanced/0',
            json={
                'date': datetime.now().strftime('%Y-%m-%d'),
                'user': 'normal',
                'description': 'Changed only here',
            },
        )
        self.assertEqual(update_response.status_code, 403)

        self.login('admin', True)
        delete_response = self.client.delete('/api/assets/A%2301/maintenance-log/0')
        self.assertEqual(delete_response.status_code, 409)
        self.assertEqual(len(self.data_manager.inventory['A#01'].maintenance_logs), 1)

    def test_container_maintenance_history_round_trips_csv(self):
        response = self.client.post('/api/containers/CASE-1/maintain', json=self.payload())
        self.assertEqual(response.status_code, 200)

        reloaded = DataManager(self.tempdir.name)
        reloaded.load_containers()

        self.assertEqual(len(reloaded.containers['CASE-1'].maintenance_logs), 1)
        reloaded_log = normalize_maintenance_log(
            reloaded.containers['CASE-1'].maintenance_logs[0]
        )
        self.assertEqual(reloaded_log['source']['containerId'], 'CASE-1')

    def test_admin_media_removal_clears_container_and_all_asset_copies(self):
        payload = self.payload('container-media-request')
        payload['media'] = (io.BytesIO(b'container-photo'), 'case photo.png')
        response = self.client.post(
            '/api/containers/CASE-1/maintain',
            data=payload,
            content_type='multipart/form-data',
        )
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))

        container_log = normalize_maintenance_log(
            self.data_manager.containers['CASE-1'].maintenance_logs[0]
        )
        media = container_log['media'][0]
        media_path = os.path.join(self.tempdir.name, media['path'])
        self.assertTrue(os.path.exists(media_path))

        self.login('admin', True)
        delete_response = self.client.delete(
            f"/api/maintenance-media/{media['id']}"
        )

        self.assertEqual(delete_response.status_code, 200, delete_response.get_data(as_text=True))
        self.assertEqual(delete_response.get_json()['deletedReferenceCount'], 3)
        self.assertFalse(os.path.exists(media_path))
        self.assertEqual(
            normalize_maintenance_log(
                self.data_manager.containers['CASE-1'].maintenance_logs[0]
            )['media'],
            [],
        )
        for asset_id in ('A#01', 'A#02'):
            self.assertEqual(
                normalize_maintenance_log(
                    self.data_manager.inventory[asset_id].maintenance_logs[0]
                )['media'],
                [],
            )

        reloaded = DataManager(self.tempdir.name)
        reloaded.load_inventory()
        reloaded.load_containers()
        self.assertEqual(
            normalize_maintenance_log(
                reloaded.containers['CASE-1'].maintenance_logs[0]
            )['media'],
            [],
        )
        for asset_id in ('A#01', 'A#02'):
            self.assertEqual(
                normalize_maintenance_log(
                    reloaded.inventory[asset_id].maintenance_logs[0]
                )['media'],
                [],
            )


if __name__ == '__main__':
    unittest.main()
