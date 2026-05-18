import tempfile
import unittest

import app as app_module
from data_manager import DataManager
from models import InventoryItem, User, hash_password


class AssetCreationTests(unittest.TestCase):
    def setUp(self):
        self.original_data_manager = app_module.data_manager
        self.original_signature = app_module._data_snapshot_signature
        self.tempdir = tempfile.TemporaryDirectory()

        self.data_manager = DataManager(self.tempdir.name)
        self.data_manager.setup_data_folder()
        self.data_manager.users = {
            'normal': User('normal', hash_password('pw', 'salt'), 'salt', False, True),
        }
        self.data_manager.save_users()
        self.data_manager.logs = []
        self.data_manager.save_logs()

        app_module.data_manager = self.data_manager
        app_module.mark_data_snapshot_current()
        app_module.app.config['TESTING'] = True
        self.client = app_module.app.test_client()

    def tearDown(self):
        app_module.data_manager = self.original_data_manager
        app_module._data_snapshot_signature = self.original_signature
        self.tempdir.cleanup()

    def login(self):
        with self.client.session_transaction() as session:
            session['user'] = 'normal'
            session['is_admin'] = False

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
            **payload,
        })

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

    def test_custom_prefix_cannot_be_shared_with_different_brand_model(self):
        self.add_existing_asset('P1#01', 'Behringher', 'P1', 'Wired IEM beltpack')

        response = self.post_asset({
            'brand': 'L-Acoustics',
            'description': 'Processor',
            'assetIdPrefix': 'P1',
        })

        self.assertEqual(response.status_code, 400)
        self.assertIn('already used', response.get_json()['error'])

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


if __name__ == '__main__':
    unittest.main()
