import copy
import tempfile
import unittest
from datetime import datetime

import app as app_module
from data_manager import DataManager
from maintenance_logs import normalize_maintenance_log
from models import Event, InventoryItem, User, hash_password


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

    def test_asset_check_routes_require_authentication(self):
        with self.client.session_transaction() as session:
            session.clear()
        for operation in ('group', 'sighting', 'mark-untagged', 'mark-missing'):
            response = self.client.post(f'/api/asset-check/{operation}', json={})
            self.assertEqual(response.status_code, 401, operation)

    def test_asset_check_sighting_is_idempotent_and_can_be_undone(self):
        payload = {'assetId': 'TEST#01', 'checkId': 'sighting-1'}
        for _ in range(2):
            response = self.client.post('/api/asset-check/sighting', json=payload)
            self.assertEqual(response.status_code, 200)
        self.assertEqual(len(self.data_manager.inventory['TEST#01'].maintenance_logs), 1)
        response = self.client.post('/api/asset-check/sighting', json={**payload, 'checked': False})
        self.assertTrue(response.get_json()['data']['removed'])
        reloaded = DataManager(self.tempdir.name)
        reloaded.load_inventory()
        self.assertEqual(reloaded.inventory['TEST#01'].maintenance_logs, [])

    def test_asset_check_excludes_deployed_and_away_items_from_missing_batch(self):
        for asset_id, location in [('OUT#01', 'Store'), ('AWAY#01', 'Workshop')]:
            asset = copy.deepcopy(self.data_manager.inventory['TEST#01'])
            asset.asset_id, asset.current_location = asset_id, location
            self.data_manager.inventory[asset_id] = asset
        event = Event(41, 'Deployment', '20260920', '20260921', [],
                      prepared_items=['OUT#01'], actually_prepared=['OUT#01'])
        self.data_manager.events[41] = event
        self.data_manager.save_inventory()
        self.data_manager.save_event(event)
        response = self.client.post('/api/asset-check/group', json={'identifier': 'TEST#01'})
        data = response.get_json()['data']
        self.assertEqual(data['summary']['checkable'], 1)
        self.assertEqual({row['id']: row['status'] for row in data['assets']}, {
            'TEST#01': 'unchecked', 'OUT#01': 'deployed', 'AWAY#01': 'away',
        })
        payload = {'assetIds': ['TEST#01', 'OUT#01', 'AWAY#01'], 'groupKey': data['group']['key']}
        self.assertEqual(self.client.post('/api/asset-check/mark-missing', json=payload).status_code, 400)
        response = self.client.post('/api/asset-check/mark-missing', json={**payload, 'confirm': True})
        self.assertEqual(response.get_json()['data']['marked'], ['TEST#01'])
        self.assertEqual(len(response.get_json()['data']['skipped']), 2)
        self.assertFalse(self.data_manager.inventory['OUT#01'].is_missing)
        self.assertFalse(self.data_manager.inventory['AWAY#01'].is_missing)

    def test_asset_check_registration_does_not_capture_a_company_manager(self):
        with tempfile.TemporaryDirectory() as other_folder:
            other = DataManager(other_folder)
            other.setup_data_folder()
            other.users = self.data_manager.users.copy()
            other.save_users()
            app_module.set_data_manager_for_testing(other)
            response = self.client.post('/api/asset-check/group', json={'identifier': 'TEST#01'})
            self.assertEqual(response.status_code, 404)
            app_module.set_data_manager_for_testing(self.data_manager)
            response = self.client.post('/api/asset-check/group', json={'identifier': 'TEST#01'})
            self.assertEqual(response.status_code, 200)

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
