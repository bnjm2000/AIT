import os
import tempfile
import unittest

import app as app_module
from data_manager import DataManager
from models import Container, Event, InventoryItem, User, hash_password


class ContainerBulkAssetTests(unittest.TestCase):
    def setUp(self):
        self.original_data_manager = app_module.get_default_data_manager()
        self.original_signature = app_module._data_snapshot_signature
        self.original_testing = app_module.app.config.get('TESTING')
        self.tempdir = tempfile.TemporaryDirectory()

        self.data_manager = DataManager(self.tempdir.name)
        self.data_manager.setup_data_folder()
        self.data_manager.users = {
            'normal': User('normal', hash_password('pw', 'salt'), 'salt', False, True),
            'admin': User('admin', hash_password('pw', 'admin-salt'), 'admin-salt', True, True),
        }
        self.data_manager.inventory = {
            'A#01': self.make_asset('A#01'),
            'BULK-0001': self.make_asset('BULK-0001', is_bulk=True, quantity=10),
        }
        self.data_manager.save_users()
        self.data_manager.save_inventory()
        self.data_manager.logs = []
        self.data_manager.save_logs()

        app_module.app.config['TESTING'] = True
        app_module.set_data_manager_for_testing(self.data_manager)
        app_module.invalidate_cache()
        self.client = app_module.app.test_client()

    def tearDown(self):
        app_module.clear_test_data_manager(self.original_data_manager)
        app_module._data_snapshot_signature = self.original_signature
        app_module.app.config['TESTING'] = self.original_testing
        self.tempdir.cleanup()

    @staticmethod
    def make_asset(asset_id, is_bulk=False, quantity=1):
        return InventoryItem(
            asset_id=asset_id,
            brand='Showbase',
            model_number='Bulk Cable' if is_bulk else 'Speaker',
            serial_number='' if is_bulk else f'SN-{asset_id}',
            description='Cable stock' if is_bulk else 'Test speaker',
            is_missing=False,
            maintenance_logs=[],
            department_code='AX',
            default_location='Store',
            current_location='',
            is_bulk=is_bulk,
            quantity=quantity,
        )

    def login(self, username='normal', is_admin=False):
        with self.client.session_transaction() as session:
            session['user'] = username
            session['is_admin'] = is_admin

    def create_container(self, container_id, quantity, asset_ids=None):
        self.login()
        return self.client.post('/api/containers', json={
            'id': container_id,
            'assetIds': asset_ids or [],
            'bulkItems': [{'assetId': 'BULK-0001', 'quantity': quantity}],
        })

    def test_bulk_quantities_round_trip_through_csv_and_api(self):
        response = self.create_container('CABLE-CASE', 4, ['A#01'])

        self.assertEqual(response.status_code, 201, response.get_data(as_text=True))
        payload = response.get_json()['data']
        self.assertEqual(payload['assetIds'], ['A#01'])
        self.assertEqual(payload['bulkItems'], [{'assetId': 'BULK-0001', 'quantity': 4}])
        self.assertEqual(payload['assetCount'], 5)
        self.assertEqual(payload['bulkQuantity'], 4)

        reloaded = DataManager(self.tempdir.name)
        reloaded.load_inventory()
        reloaded.load_containers()
        self.assertEqual(reloaded.containers['CABLE-CASE'].asset_ids, ['A#01'])
        self.assertEqual(reloaded.containers['CABLE-CASE'].bulk_items, {'BULK-0001': 4})

    def test_bulk_quantity_cannot_be_overallocated_across_containers(self):
        first = self.create_container('CASE-A', 7)
        second = self.create_container('CASE-B', 4)

        self.assertEqual(first.status_code, 201, first.get_data(as_text=True))
        self.assertEqual(second.status_code, 400, second.get_data(as_text=True))
        self.assertIn('Only 3 unit(s)', second.get_json()['error'])

        update = self.client.put('/api/containers/CASE-A', json={
            'assetIds': [],
            'bulkItems': [{'assetId': 'BULK-0001', 'quantity': 5}],
        })
        self.assertEqual(update.status_code, 200, update.get_data(as_text=True))
        self.assertEqual(self.create_container('CASE-B', 5).status_code, 201)

    def test_legacy_bulk_id_is_migrated_out_of_specific_asset_ids(self):
        self.login()
        response = self.client.post('/api/containers', json={
            'id': 'LEGACY-CASE',
            'assetIds': ['BULK-0001'],
        })

        self.assertEqual(response.status_code, 201, response.get_data(as_text=True))
        payload = response.get_json()['data']
        self.assertEqual(payload['assetIds'], [])
        self.assertEqual(payload['bulkItems'], [{'assetId': 'BULK-0001', 'quantity': 1}])

    def test_container_bulk_quantity_is_added_to_plan(self):
        self.assertEqual(self.create_container('PLAN-CASE', 4).status_code, 201)
        event = Event(
            event_id=501,
            name='Bulk Plan Event',
            start_date='20260810',
            end_date='20260810',
            asset_models=[],
            prepared_items=[],
            assigned_users=['admin'],
        )
        self.data_manager.events[event.event_id] = event
        self.login('admin', True)

        response = self.client.post(
            f'/api/events/{event.event_id}/container-models',
            json={'containerId': 'PLAN-CASE'},
        )

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertEqual(response.get_json()['data']['assetCount'], 4)
        marker = app_module._parse_model_marker(event.prepared_items[0])
        self.assertEqual(int(marker['quantity']), 4)

    def test_preparing_container_bulk_quantity_deploys_that_quantity(self):
        event = Event(
            event_id=502,
            name='Bulk Prepare Event',
            start_date='20260810',
            end_date='20260810',
            asset_models=[],
            prepared_items=[],
            assigned_users=['normal'],
        )
        self.data_manager.events[event.event_id] = event
        self.login()

        response = self.client.post(
            f'/api/events/{event.event_id}/assign-specific',
            json={
                'assetId': 'BULK-0001',
                'quantity': 4,
                'fromContainer': True,
                'quickAdd': True,
                'source': 'quick-add-container',
            },
        )

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertEqual(response.get_json()['data']['preparedQuantity'], 4)
        self.assertIn('[BULK]BULK-0001|4', event.actually_prepared)
        self.assertIn('[MODEL]AX|Showbase|Bulk Cable|4|Cable stock', event.prepared_items)
        self.assertNotIn('BULK-0001', event.event_logs[-1]['action'])
        self.assertIn('4x Showbase - Bulk Cable - Cable stock', event.event_logs[-1]['action'])

    def test_container_editor_and_scan_send_bulk_quantities(self):
        source = os.path.join(
            os.path.dirname(app_module.__file__),
            'static',
            'js',
            'app.js',
        )
        with open(source, encoding='utf-8') as script_file:
            script = script_file.read()

        self.assertIn("asset?.id || asset?.bulkId || asset?.internalId", script)
        self.assertIn("title: 'Add bulk quantity'", script)
        self.assertIn("selectedContainerBulkAssets.set(assetId, quantity)", script)
        self.assertIn("{ id, serialNumber, assetIds, bulkItems }", script)
        self.assertIn("assetId: item.assetId,\n          quantity,", script)
        container_handler = script[
            script.index('async function handleContainerAssetSearchKeypress'):
            script.index('function containerPhotoSelected')
        ]
        self.assertIn('for (const item of containerBulkItems(container))', container_handler)
        inventory_status_counter = script[
            script.index('function inventoryExportStatusCounts'):
            script.index('function inventoryAssetFlagsText')
        ]
        self.assertNotIn('containerBulkItems(container)', inventory_status_counter)
        self.assertIn(
            'const activeContainerQuantity = Math.max(0, item.quantity - returnedFromContainer)',
            script,
        )


if __name__ == '__main__':
    unittest.main()
