import csv
import io
import os
import tempfile
import unittest

import app as app_module
from data_manager import DataManager
from models import Container, InventoryItem, User, hash_password


class ContainerSerialNumberTests(unittest.TestCase):
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
        self.data_manager.inventory = {
            'A#01': self.make_asset('A#01'),
            'A#02': self.make_asset('A#02'),
        }
        self.data_manager.containers = {
            'CASE-OLD': Container('CASE-OLD', ['A#01']),
            'AD Rack #01': Container('AD Rack #01', ['A#02']),
        }
        self.data_manager.save_inventory()
        self.data_manager.save_containers()

        app_module.app.config['TESTING'] = True
        app_module.set_data_manager_for_testing(self.data_manager)
        app_module.invalidate_cache()
        self.client = app_module.app.test_client()

    def tearDown(self):
        app_module.clear_test_data_manager(self.original_data_manager)
        app_module._data_snapshot_signature = self.original_signature
        app_module.app.config['TESTING'] = self.original_testing
        self.tempdir.cleanup()

    def make_asset(self, asset_id):
        return InventoryItem(
            asset_id=asset_id,
            brand='TestBrand',
            model_number='TestModel',
            serial_number=f'SN-{asset_id}',
            description='Test item',
            is_missing=False,
            maintenance_logs=[],
            department_code='AX',
            default_location='Store',
            current_location='',
        )

    def login(self):
        with self.client.session_transaction() as session:
            session['user'] = 'normal'
            session['is_admin'] = False

    def test_container_csv_round_trips_optional_serial_and_old_rows(self):
        filepath = os.path.join(self.tempdir.name, 'Containers.csv')
        with open(filepath, 'w', newline='', encoding='utf-8') as f:
            writer = csv.writer(f)
            writer.writerow(['OLD-ROW', 'A#01'])
            writer.writerow(['NEW-ROW', 'A#02', 'SN-NEW-ROW'])

        self.data_manager.load_containers()

        self.assertEqual(self.data_manager.containers['OLD-ROW'].serial_number, '')
        self.assertEqual(self.data_manager.containers['NEW-ROW'].serial_number, 'SN-NEW-ROW')

        self.data_manager.save_containers()
        reloaded = DataManager(self.tempdir.name)
        reloaded.load_containers()

        self.assertEqual(reloaded.containers['OLD-ROW'].serial_number, '')
        self.assertEqual(reloaded.containers['NEW-ROW'].serial_number, 'SN-NEW-ROW')

    def test_serial_can_be_added_to_existing_container_and_used_for_lookup(self):
        self.login()

        response = self.client.put('/api/containers/CASE-OLD', json={
            'assetIds': ['A#01'],
            'serialNumber': 'SN-CASE-OLD',
        })

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertEqual(response.get_json()['data']['serialNumber'], 'SN-CASE-OLD')
        self.assertEqual(self.data_manager.containers['CASE-OLD'].serial_number, 'SN-CASE-OLD')

        response = self.client.get('/api/containers/SN-CASE-OLD')

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertEqual(response.get_json()['data']['id'], 'CASE-OLD')

        response = self.client.get('/api/containers/case-old')

        self.assertEqual(response.status_code, 404, response.get_data(as_text=True))

        response = self.client.get('/api/containers/AD%20Rack%20%2301')

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertEqual(response.get_json()['data']['id'], 'AD Rack #01')

        response = self.client.put('/api/containers/CASE-OLD', json={
            'assetIds': ['A#01'],
            'serialNumber': '',
        })

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertEqual(response.get_json()['data']['serialNumber'], '')
        self.assertEqual(self.data_manager.containers['CASE-OLD'].serial_number, '')

    def test_container_serial_is_optional_and_conflicts_are_rejected(self):
        self.login()

        response = self.client.post('/api/containers', json={
            'id': 'CASE-NO-SN',
            'assetIds': ['A#02'],
        })

        self.assertEqual(response.status_code, 201, response.get_data(as_text=True))
        self.assertEqual(response.get_json()['data']['serialNumber'], '')

        response = self.client.post('/api/containers', json={
            'id': 'CASE-WITH-SN',
            'serialNumber': 'SN-CASE-WITH',
            'assetIds': ['A#02'],
        })

        self.assertEqual(response.status_code, 201, response.get_data(as_text=True))
        self.assertEqual(response.get_json()['data']['serialNumber'], 'SN-CASE-WITH')

        response = self.client.post('/api/containers', json={
            'id': 'CASE-DUP-SN',
            'serialNumber': 'SN-CASE-WITH',
            'assetIds': ['A#02'],
        })

        self.assertEqual(response.status_code, 409)

        response = self.client.post('/api/containers', json={
            'id': 'SN-CASE-WITH',
            'assetIds': ['A#02'],
        })

        self.assertEqual(response.status_code, 409)

    def test_container_photo_upload_is_limited_and_persisted(self):
        self.login()
        response = self.client.post(
            '/api/containers/CASE-OLD/photo',
            data={'photo': (io.BytesIO(b'container-image'), 'case.png')},
            content_type='multipart/form-data',
        )

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        payload = response.get_json()['data']
        self.assertEqual(payload['photoOriginalName'], 'case.png')
        self.assertTrue(payload['photoUrl'].endswith('/api/containers/CASE-OLD/photo'))
        fetched = self.client.get('/api/containers/CASE-OLD/photo')
        self.assertEqual(fetched.status_code, 200)
        self.assertEqual(fetched.data, b'container-image')

        too_large = self.client.post(
            '/api/containers/CASE-OLD/photo',
            data={'photo': (io.BytesIO(b'x' * (5 * 1024 * 1024 + 1)), 'large.png')},
            content_type='multipart/form-data',
        )
        self.assertEqual(too_large.status_code, 400)


if __name__ == '__main__':
    unittest.main()
