import tempfile
import unittest
from urllib.parse import quote

import app as app_module
from data_manager import DataManager
from models import Container, Event, InventoryItem, User, hash_password


class PrepareQuickAddAndAdminDeleteTests(unittest.TestCase):
    def setUp(self):
        self.original_data_manager = app_module.data_manager
        self.original_signature = app_module._data_snapshot_signature
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

        self.data_manager.inventory = {
            'A#01': self.make_asset('A#01'),
            'A#02': self.make_asset('A#02'),
            'B#01': self.make_asset('B#01', department='LX'),
        }
        self.data_manager.containers = {
            'CASE-1': Container('CASE-1', ['B#01'])
        }
        self.data_manager.save_inventory()
        self.data_manager.save_containers()

        app_module.data_manager = self.data_manager
        app_module.mark_data_snapshot_current()
        app_module.app.config['TESTING'] = True
        self.client = app_module.app.test_client()

    def tearDown(self):
        app_module.data_manager = self.original_data_manager
        app_module._data_snapshot_signature = self.original_signature
        self.tempdir.cleanup()

    def make_asset(self, asset_id, department='AX', is_disposed=False):
        return InventoryItem(
            asset_id=asset_id,
            brand='TestBrand',
            model_number='TestModel',
            serial_number=f'SN-{asset_id}',
            description='Matching item',
            is_missing=False,
            maintenance_logs=[],
            department_code=department,
            default_location='Store',
            current_location='',
            is_disposed=is_disposed,
        )

    def login_as(self, username, is_admin=False):
        with self.client.session_transaction() as session:
            session['user'] = username
            session['is_admin'] = is_admin

    def make_event(self, event_id=100, prepared=None, actual=None, extra=None):
        event = Event(
            event_id=event_id,
            name=f'Event {event_id}',
            start_date='20260520',
            end_date='20260520',
            asset_models=[],
            prepared_items=prepared if prepared is not None else ['[MODEL]AX|TestBrand|TestModel|1|Matching item'],
            returned_items=[],
            actually_prepared=actual if actual is not None else ['A#01'],
            extra_assets=extra if extra is not None else [],
        )
        self.data_manager.events[event_id] = event
        return event

    def post_assign(self, event_id, asset_id='A#02', **payload):
        self.login_as('normal')
        return self.client.post(
            f'/api/events/{event_id}/assign-specific',
            json={'assetId': asset_id, **payload},
        )

    def test_quick_add_disabled_tracks_surplus_as_extra(self):
        event = self.make_event()

        response = self.post_assign(event.event_id, quickAdd=False)

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertTrue(response.get_json()['data']['isExtra'])
        self.assertIn('A#02', event.extra_assets)
        self.assertIn('[MODEL]AX|TestBrand|TestModel|1|Matching item', event.prepared_items)

    def test_quick_add_enabled_adds_surplus_into_event_requirement(self):
        event = self.make_event(event_id=101)

        response = self.post_assign(event.event_id, quickAdd=True)

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        body = response.get_json()
        self.assertFalse(body['data']['isExtra'])
        self.assertEqual(body['data']['addedRequirementUnits'], 1)
        self.assertNotIn('A#02', event.extra_assets)
        self.assertIn('[MODEL]AX|TestBrand|TestModel|2|Matching item', event.prepared_items)

    def test_quick_add_promotes_existing_extra_asset(self):
        event = self.make_event(
            event_id=102,
            prepared=['[MODEL]AX|TestBrand|TestModel|1|Matching item', 'A#02'],
            actual=['A#01', 'A#02'],
            extra=['A#02'],
        )

        response = self.post_assign(event.event_id, quickAdd=True)

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertFalse(response.get_json()['data']['isExtra'])
        self.assertNotIn('A#02', event.extra_assets)
        self.assertIn('[MODEL]AX|TestBrand|TestModel|2|Matching item', event.prepared_items)

    def test_quick_add_false_overrides_container_auto_add(self):
        event = self.make_event(event_id=103)

        response = self.post_assign(event.event_id, quickAdd=False, fromContainer=True, source='container')

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertTrue(response.get_json()['data']['isExtra'])
        self.assertIn('A#02', event.extra_assets)

    def test_decommissioned_status_is_exposed_with_new_name(self):
        self.data_manager.inventory['D#01'] = self.make_asset('D#01', is_disposed=True)
        self.login_as('normal')

        response = self.client.get('/api/assets')

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        asset = next(item for item in response.get_json()['data'] if item['internalId'] == 'D#01')
        self.assertEqual(asset['status'], 'decommissioned')

    def test_department_delete_is_admin_only_and_blocked_when_assets_exist(self):
        app_module._save_departments({
            'AX': app_module._department_record('AX', 'Audio'),
            'ZZ': app_module._department_record('ZZ', 'Empty'),
        })

        self.login_as('normal')
        response = self.client.delete('/api/departments/ZZ')
        self.assertEqual(response.status_code, 403)

        self.login_as('admin', True)
        response = self.client.delete('/api/departments/AX')
        self.assertEqual(response.status_code, 409)
        self.assertIn('still has', response.get_json()['error'])

        response = self.client.delete('/api/departments/ZZ')
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))

    def test_asset_delete_requires_admin_password_and_removes_container_reference(self):
        encoded_asset_id = quote('B#01', safe='')

        self.login_as('normal')
        response = self.client.delete(f'/api/assets/{encoded_asset_id}', json={'password': 'pw'})
        self.assertEqual(response.status_code, 403)

        self.login_as('admin', True)
        response = self.client.delete(f'/api/assets/{encoded_asset_id}', json={})
        self.assertEqual(response.status_code, 400)

        response = self.client.delete(f'/api/assets/{encoded_asset_id}', json={'password': 'wrong'})
        self.assertEqual(response.status_code, 403)

        response = self.client.delete(f'/api/assets/{encoded_asset_id}', json={'password': 'pw'})
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertNotIn('B#01', self.data_manager.inventory)
        self.assertEqual(self.data_manager.containers['CASE-1'].asset_ids, [])


if __name__ == '__main__':
    unittest.main()
