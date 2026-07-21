import tempfile
import unittest
from datetime import datetime

import app as app_module
from data_manager import DataManager
from maintenance_logs import normalize_maintenance_log
from models import InventoryItem, User, hash_password


class AssetUntaggedTests(unittest.TestCase):
    def setUp(self):
        self.original_data_manager = app_module.get_default_data_manager()
        self.original_signature = app_module._data_snapshot_signature
        self.original_testing = app_module.app.config.get('TESTING')
        self.tempdir = tempfile.TemporaryDirectory()

        self.data_manager = DataManager(self.tempdir.name)
        self.data_manager.setup_data_folder()
        self.data_manager.users = {
            'tech': User('tech', hash_password('pw', 'salt'), 'salt', False, True),
        }
        self.data_manager.save_users()
        self.data_manager.logs = []
        self.data_manager.save_logs()
        self.data_manager.inventory['TEST#01'] = InventoryItem(
            asset_id='TEST#01',
            brand='Test Brand',
            model_number='Test Model',
            serial_number='SERIAL-001',
            description='Serial identified asset',
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
            session['user'] = 'tech'
            session['is_admin'] = False

    def tearDown(self):
        app_module.clear_test_data_manager(self.original_data_manager)
        app_module._data_snapshot_signature = self.original_signature
        app_module.app.config['TESTING'] = self.original_testing
        self.tempdir.cleanup()

    def test_csv_round_trip_preserves_untagged_condition(self):
        asset = self.data_manager.inventory['TEST#01']
        asset.is_untagged = True
        self.data_manager.save_inventory()

        reloaded = DataManager(self.tempdir.name)
        reloaded.load_inventory()

        self.assertTrue(reloaded.inventory['TEST#01'].is_untagged)
        self.assertFalse(reloaded.inventory['TEST#01'].is_degraded)

    def test_maintenance_can_mark_and_clear_untagged(self):
        payload = {
            'assetIds': ['TEST#01'],
            'logEntry': 'ID label was not present',
            'logType': 'Update',
            'maintenanceDate': datetime.now().strftime('%Y-%m-%d'),
            'assetStatus': 'untagged',
            'requestId': 'mark-untagged-test',
        }

        response = self.client.post('/api/assets/maintenance/batch', json=payload)

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        asset = self.data_manager.inventory['TEST#01']
        self.assertTrue(asset.is_untagged)
        self.assertIn(
            {'kind': 'untagged', 'action': 'marked'},
            normalize_maintenance_log(asset.maintenance_logs[-1])['changes'],
        )

        payload.update({
            'assetStatus': 'ok',
            'logEntry': 'Replacement ID tag fitted',
            'requestId': 'clear-untagged-test',
        })
        response = self.client.post('/api/assets/maintenance/batch', json=payload)

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertFalse(asset.is_untagged)
        self.assertIn(
            {'kind': 'untagged', 'action': 'cleared'},
            normalize_maintenance_log(asset.maintenance_logs[-1])['changes'],
        )

    def test_asset_check_marks_serial_identified_asset_untagged_and_sighted(self):
        group_response = self.client.post(
            '/api/asset-check/group',
            json={'identifier': 'serial-001'},
        )
        self.assertEqual(group_response.status_code, 200, group_response.get_data(as_text=True))
        group_key = group_response.get_json()['data']['group']['key']

        response = self.client.post('/api/asset-check/mark-untagged', json={
            'identifier': 'SERIAL-001',
            'groupKey': group_key,
            'checkId': 'asset-check-untagged-test',
        })

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        asset = self.data_manager.inventory['TEST#01']
        self.assertTrue(asset.is_untagged)
        records = [normalize_maintenance_log(log) for log in asset.maintenance_logs]
        source_kinds = [record.get('source', {}).get('kind') for record in records]
        self.assertEqual(source_kinds.count('asset_check_sighting'), 1)
        self.assertEqual(source_kinds.count('asset_check_untagged'), 1)

        repeated = self.client.post('/api/asset-check/mark-untagged', json={
            'assetId': 'TEST#01',
            'groupKey': group_key,
            'checkId': 'asset-check-untagged-test',
        })
        self.assertEqual(repeated.status_code, 200, repeated.get_data(as_text=True))
        records = [normalize_maintenance_log(log) for log in asset.maintenance_logs]
        source_kinds = [record.get('source', {}).get('kind') for record in records]
        self.assertEqual(source_kinds.count('asset_check_sighting'), 1)
        self.assertEqual(source_kinds.count('asset_check_untagged'), 1)

        asset_response = self.client.get('/api/assets')
        payload = next(item for item in asset_response.get_json()['data'] if item['internalId'] == 'TEST#01')
        self.assertEqual(payload['status'], 'untagged')
        self.assertTrue(payload['isUntagged'])
        self.assertEqual(payload['availableQuantity'], 1)


if __name__ == '__main__':
    unittest.main()
