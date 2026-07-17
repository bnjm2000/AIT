import tempfile
import unittest

import app as app_module
from data_manager import DataManager
from models import InventoryItem, User, hash_password


class AssetCreationTests(unittest.TestCase):
    def setUp(self):
        self.original_data_manager = app_module.get_default_data_manager()
        self.original_signature = app_module._data_snapshot_signature
        self.original_testing = app_module.app.config.get('TESTING')
        self.tempdir = tempfile.TemporaryDirectory()

        self.data_manager = DataManager(self.tempdir.name)
        self.data_manager.setup_data_folder()
        self.data_manager.users = {
            'normal': User('normal', hash_password('pw', 'salt'), 'salt', False, True),
            'admin': User('admin', hash_password('pw', 'adminsalt'), 'adminsalt', True, True),
        }
        self.data_manager.save_users()
        self.data_manager.logs = []
        self.data_manager.save_logs()

        app_module.app.config['TESTING'] = True
        app_module.set_data_manager_for_testing(self.data_manager)
        self.client = app_module.app.test_client()

    def tearDown(self):
        app_module.clear_test_data_manager(self.original_data_manager)
        app_module._data_snapshot_signature = self.original_signature
        app_module.app.config['TESTING'] = self.original_testing
        self.tempdir.cleanup()

    def login(self, username='admin', is_admin=True):
        with self.client.session_transaction() as session:
            session['user'] = username
            session['is_admin'] = is_admin

    def add_existing_asset(self, asset_id, brand, model, description=''):
        self.data_manager.inventory[asset_id] = InventoryItem(
            asset_id=asset_id,
            brand=brand,
            model_number=model,
            serial_number='',
            description=description,
            is_missing=False,
            maintenance_logs=[],
            department_code='AX',
            default_location='Store',
            current_location='',
        )
        self.data_manager.save_inventory()
        app_module.mark_data_snapshot_current()

    def post_asset(self, payload):
        self.login()
        return self.client.post('/api/assets', json={
            'brand': 'Behringher',
            'model': 'P1',
            'description': 'Wired IEM beltpack',
            'department': 'AX',
            'quantity': 1,
            **payload,
        })

    def test_non_admin_cannot_create_asset(self):
        self.login('normal', False)

        response = self.client.post('/api/assets', json={
            'brand': 'Behringher',
            'model': 'P1',
            'description': 'Wired IEM beltpack',
            'department': 'AX',
            'quantity': 1,
        })

        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.get_json()['error'], 'Admin privileges required')
        self.assertEqual(self.data_manager.inventory, {})

    def test_batch_add_existing_brand_model_continues_numbering(self):
        self.add_existing_asset('P1#01', 'Behringher', 'P1', 'Wired IEM beltpack')
        self.add_existing_asset('P1#02', 'Behringher', 'P1', 'Wired IEM beltpack')
        self.add_existing_asset('LAP1#01', 'L-Acoustics', 'P1', 'Processor')

        response = self.post_asset({
            'quantity': 2,
            'serials': ['SN-003', 'SN-004'],
        })

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        body = response.get_json()
        self.assertEqual(body['assetIds'], ['P1#03', 'P1#04'])
        self.assertEqual(self.data_manager.inventory['P1#03'].serial_number, 'SN-003')
        self.assertEqual(self.data_manager.inventory['P1#04'].serial_number, 'SN-004')

    def test_create_asset_warns_when_serial_count_is_lower_than_quantity(self):
        response = self.post_asset({
            'quantity': 3,
            'serials': ['SN-001', 'SN-002'],
        })

        self.assertEqual(response.status_code, 409, response.get_data(as_text=True))
        body = response.get_json()
        self.assertTrue(body['requiresSerialMismatchConfirmation'])
        self.assertEqual(body['data']['mismatches'], [{
            'type': 'primary',
            'count': 2,
            'quantity': 3,
        }])
        self.assertEqual(self.data_manager.inventory, {})

        confirmed = self.post_asset({
            'quantity': 3,
            'serials': ['SN-001', 'SN-002'],
            'confirmSerialMismatch': True,
        })

        self.assertEqual(confirmed.status_code, 200, confirmed.get_data(as_text=True))
        created_ids = confirmed.get_json()['assetIds']
        self.assertEqual(len(created_ids), 3)
        self.assertEqual(self.data_manager.inventory[created_ids[2]].serial_number, '')

    def test_create_asset_warns_when_primary_serial_list_is_empty(self):
        response = self.post_asset({
            'quantity': 2,
            'serials': [],
            'secondarySerials': [],
        })

        self.assertEqual(response.status_code, 409, response.get_data(as_text=True))
        mismatch = response.get_json()['data']['mismatches']
        self.assertEqual(mismatch, [{
            'type': 'primary',
            'count': 0,
            'quantity': 2,
        }])

    def test_create_asset_warns_when_serial_count_exceeds_quantity(self):
        response = self.post_asset({
            'quantity': 2,
            'serials': ['SN-001', 'SN-002', 'SN-003'],
        })

        self.assertEqual(response.status_code, 409, response.get_data(as_text=True))
        body = response.get_json()
        self.assertTrue(body['requiresSerialMismatchConfirmation'])
        self.assertEqual(body['data']['mismatches'][0]['count'], 3)
        self.assertEqual(body['data']['mismatches'][0]['quantity'], 2)
        self.assertEqual(self.data_manager.inventory, {})

    def test_new_brand_with_same_model_gets_separate_prefix(self):
        self.add_existing_asset('P1#01', 'Behringher', 'P1', 'Wired IEM beltpack')

        response = self.post_asset({
            'brand': 'L-Acoustics',
            'description': 'Processor',
            'quantity': 1,
        })

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertEqual(response.get_json()['assetIds'], ['LAP1#01'])
        self.assertIn('LAP1#01', self.data_manager.inventory)
        self.assertNotIn('P1#02', self.data_manager.inventory)

    def test_custom_prefix_shared_with_different_brand_model_continues_numbering(self):
        self.add_existing_asset('P1#01', 'Behringher', 'P1', 'Wired IEM beltpack')
        self.add_existing_asset('P1#07', 'Another Brand', 'Another Model', 'Another asset type')

        response = self.post_asset({
            'brand': 'L-Acoustics',
            'description': 'Processor',
            'assetIdPrefix': 'P1',
            'quantity': 2,
        })

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertEqual(response.get_json()['assetIds'], ['P1#08', 'P1#09'])
        self.assertIn('P1#08', self.data_manager.inventory)
        self.assertIn('P1#09', self.data_manager.inventory)

    def test_custom_prefix_is_used_for_new_family(self):
        response = self.post_asset({
            'brand': 'DPA',
            'model': '6061',
            'description': 'Lavalier microphone',
            'assetIdPrefix': 'LAV',
            'quantity': 2,
        })

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertEqual(response.get_json()['assetIds'], ['LAV#01', 'LAV#02'])

    def test_create_asset_requires_department_and_quantity(self):
        response = self.post_asset({
            'department': '',
        })

        self.assertEqual(response.status_code, 400, response.get_data(as_text=True))
        self.assertEqual(response.get_json()['error'], 'Department is required')

        response = self.post_asset({
            'quantity': '',
        })

        self.assertEqual(response.status_code, 400, response.get_data(as_text=True))
        self.assertEqual(response.get_json()['error'], 'Quantity is required')

    def test_create_asset_saves_date_of_purchase(self):
        response = self.post_asset({
            'dateOfPurchase': '2026-06-02',
        })

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        asset_id = response.get_json()['assetIds'][0]
        self.assertEqual(self.data_manager.inventory[asset_id].date_of_purchase, '2026-06-02')

        assets_response = self.client.get('/api/assets')
        self.assertEqual(assets_response.status_code, 200, assets_response.get_data(as_text=True))
        payload = assets_response.get_json()['data']
        created_asset = next(item for item in payload if item['internalId'] == asset_id)
        self.assertEqual(created_asset['dateOfPurchase'], '2026-06-02')

    def test_create_asset_saves_notes(self):
        notes = 'Pack with short IEC cable\nCheck foam insert before hire'
        response = self.post_asset({
            'notes': notes,
        })

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        asset_id = response.get_json()['assetIds'][0]
        self.assertEqual(self.data_manager.inventory[asset_id].notes, notes)

        reloaded = DataManager(self.tempdir.name)
        reloaded.load_inventory()
        self.assertEqual(reloaded.inventory[asset_id].notes, notes)

        assets_response = self.client.get('/api/assets')
        self.assertEqual(assets_response.status_code, 200, assets_response.get_data(as_text=True))
        payload = assets_response.get_json()['data']
        created_asset = next(item for item in payload if item['internalId'] == asset_id)
        self.assertEqual(created_asset['notes'], notes)

    def test_create_asset_saves_normalized_tags_and_supports_tag_search(self):
        response = self.post_asset({
            'tags': ['Wireless', 'backup', 'wireless', 'quick setup'],
        })

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        asset_id = response.get_json()['assetIds'][0]
        self.assertEqual(
            self.data_manager.inventory[asset_id].tags,
            ['Wireless', 'backup', 'quick', 'setup'],
        )

        reloaded = DataManager(self.tempdir.name)
        reloaded.load_inventory()
        self.assertEqual(reloaded.inventory[asset_id].tags, ['Wireless', 'backup', 'quick', 'setup'])

        assets_response = self.client.get('/api/assets?query=backup')
        self.assertEqual(assets_response.status_code, 200, assets_response.get_data(as_text=True))
        matching_ids = [item['internalId'] for item in assets_response.get_json()['data']]
        self.assertEqual(matching_ids, [asset_id])
        self.assertEqual(assets_response.get_json()['data'][0]['tags'], ['Wireless', 'backup', 'quick', 'setup'])

    def test_create_asset_can_add_tags_to_existing_matching_models(self):
        self.add_existing_asset('P1#01', 'Behringher', 'P1', 'Wired IEM beltpack')
        self.data_manager.inventory['P1#01'].tags = ['legacy']
        self.data_manager.save_inventory()

        response = self.post_asset({
            'tags': ['Wireless'],
            'tagsToApplyToSimilar': ['Wireless'],
        })

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertEqual(response.get_json()['matchingAssetsTagged'], 1)
        self.assertEqual(self.data_manager.inventory['P1#01'].tags, ['legacy', 'Wireless'])
        created_id = response.get_json()['assetIds'][0]
        self.assertEqual(self.data_manager.inventory[created_id].tags, ['Wireless'])
        self.assertTrue(any(
            change.get('field') == 'tags'
            for change in self.data_manager.inventory['P1#01'].change_history[-1]['changes']
        ))

    def test_create_asset_saves_second_serial_and_resolves_it(self):
        response = self.post_asset({
            'serials': ['SN-PRIMARY'],
            'secondarySerials': ['SN-SECONDARY'],
        })

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        asset_id = response.get_json()['assetIds'][0]
        asset = self.data_manager.inventory[asset_id]
        self.assertEqual(asset.serial_number, 'SN-PRIMARY')
        self.assertEqual(asset.secondary_serial_number, 'SN-SECONDARY')

        reloaded = DataManager(self.tempdir.name)
        reloaded.load_inventory()
        self.assertEqual(
            reloaded.inventory[asset_id].secondary_serial_number,
            'SN-SECONDARY',
        )

        assets_response = self.client.get('/api/assets')
        asset_payload = next(
            item for item in assets_response.get_json()['data']
            if item['internalId'] == asset_id
        )
        self.assertEqual(asset_payload['serial2'], 'SN-SECONDARY')

        lookup_response = self.client.post(
            '/api/asset-check/group',
            json={'identifier': 'sn-secondary'},
        )
        self.assertEqual(
            lookup_response.status_code,
            200,
            lookup_response.get_data(as_text=True),
        )
        self.assertEqual(
            lookup_response.get_json()['data']['scannedAsset']['internalId'],
            asset_id,
        )

    def test_create_asset_sets_audit_metadata(self):
        response = self.post_asset({
            'serials': ['SN-AUDIT'],
        })

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        asset_id = response.get_json()['assetIds'][0]
        asset = self.data_manager.inventory[asset_id]

        self.assertRegex(asset.date_added, r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$')
        self.assertEqual(asset.date_modified, asset.date_added)
        self.assertEqual(len(asset.change_history), 1)
        self.assertEqual(asset.change_history[0]['action'], 'created')
        self.assertEqual(asset.change_history[0]['user'], 'admin')

        changed_fields = {change['field'] for change in asset.change_history[0]['changes']}
        self.assertIn('asset_id', changed_fields)
        self.assertIn('brand', changed_fields)
        self.assertIn('model', changed_fields)
        self.assertIn('serial', changed_fields)

        reloaded = DataManager(self.tempdir.name)
        reloaded.load_inventory()
        self.assertEqual(reloaded.inventory[asset_id].date_added, asset.date_added)
        self.assertEqual(reloaded.inventory[asset_id].change_history[0]['user'], 'admin')

        assets_response = self.client.get('/api/assets')
        self.assertEqual(assets_response.status_code, 200, assets_response.get_data(as_text=True))
        payload = assets_response.get_json()['data']
        created_asset = next(item for item in payload if item['internalId'] == asset_id)
        self.assertEqual(created_asset['dateAdded'], asset.date_added)
        self.assertEqual(created_asset['dateModified'], asset.date_modified)
        self.assertEqual(created_asset['changeHistory'][0]['action'], 'created')


if __name__ == '__main__':
    unittest.main()
