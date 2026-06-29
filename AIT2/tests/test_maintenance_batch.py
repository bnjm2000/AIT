import tempfile
import unittest
from datetime import datetime
from unittest.mock import patch

import app as app_module
from data_manager import DataManager
from maintenance_logs import normalize_maintenance_log
from models import InventoryItem, User, hash_password


class MaintenanceBatchTests(unittest.TestCase):
    def setUp(self):
        self.original_data_manager = app_module.get_default_data_manager()
        self.original_signature = app_module._data_snapshot_signature
        self.original_testing = app_module.app.config.get('TESTING')
        self.tempdir = tempfile.TemporaryDirectory()

        self.data_manager = DataManager(self.tempdir.name)
        self.data_manager.setup_data_folder()
        self.data_manager.users = {
            'normal': User('normal', hash_password('pw', 'salt'), 'salt', False, True),
        }
        self.data_manager.save_users()
        self.data_manager.logs = []
        self.data_manager.save_logs()

        for asset_id in ('TEST#01', 'TEST#02'):
            self.data_manager.inventory[asset_id] = InventoryItem(
                asset_id=asset_id,
                brand='Test',
                model_number='Model',
                serial_number='',
                description='Batch maintenance test asset',
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
        with self.client.session_transaction() as session:
            session['user'] = 'normal'
            session['is_admin'] = False

    def tearDown(self):
        app_module.clear_test_data_manager(self.original_data_manager)
        app_module._data_snapshot_signature = self.original_signature
        app_module.app.config['TESTING'] = self.original_testing
        self.tempdir.cleanup()

    def payload(self):
        return {
            'assetIds': ['TEST#01', 'TEST#02'],
            'logEntry': 'Cleaned and function tested',
            'logType': 'Preventative maintenance',
            'maintenanceDate': datetime.now().strftime('%Y-%m-%d'),
            'assetStatus': 'nochange',
            'requestId': 'maintenance-test-request-1',
        }

    def test_batch_saves_inventory_once_for_multiple_assets(self):
        with patch.object(
            self.data_manager,
            'save_inventory',
            wraps=self.data_manager.save_inventory
        ) as save_inventory:
            response = self.client.post('/api/assets/maintenance/batch', json=self.payload())

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertEqual(response.get_json()['savedCount'], 2)
        self.assertEqual(save_inventory.call_count, 1)
        for asset_id in ('TEST#01', 'TEST#02'):
            self.assertEqual(len(self.data_manager.inventory[asset_id].maintenance_logs), 1)

    def test_repeated_request_id_does_not_create_duplicate_logs(self):
        first = self.client.post('/api/assets/maintenance/batch', json=self.payload())
        second = self.client.post('/api/assets/maintenance/batch', json=self.payload())

        self.assertEqual(first.status_code, 200, first.get_data(as_text=True))
        self.assertEqual(second.status_code, 200, second.get_data(as_text=True))
        self.assertEqual(second.get_json()['savedCount'], 0)
        self.assertEqual(second.get_json()['duplicateCount'], 2)
        for asset_id in ('TEST#01', 'TEST#02'):
            logs = self.data_manager.inventory[asset_id].maintenance_logs
            self.assertEqual(len(logs), 1)
            source = normalize_maintenance_log(logs[0])['source']
            self.assertEqual(source['clientRequestId'], 'maintenance-test-request-1')


if __name__ == '__main__':
    unittest.main()
