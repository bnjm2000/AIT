import tempfile
import unittest
from urllib.parse import quote

import app as app_module
from data_manager import DataManager
from models import Container, Event, InventoryItem, User, hash_password


class PrepareQuickAddAndAdminDeleteTests(unittest.TestCase):
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

        app_module.app.config['TESTING'] = True
        app_module.set_data_manager_for_testing(self.data_manager)
        self.client = app_module.app.test_client()

    def tearDown(self):
        app_module.clear_test_data_manager(self.original_data_manager)
        app_module._data_snapshot_signature = self.original_signature
        app_module.app.config['TESTING'] = self.original_testing
        self.tempdir.cleanup()

    def make_asset(self, asset_id, department='AX', is_disposed=False, is_bulk=False, quantity=1):
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
            is_bulk=is_bulk,
            quantity=quantity,
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
            assigned_users=['normal'],
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

    def test_model_prepare_does_not_delete_or_duplicate_inventory_asset(self):
        event = self.make_event(
            event_id=103,
            prepared=['[MODEL]AX|TestBrand|TestModel|1|Matching item'],
            actual=[],
            extra=[],
        )

        response = self.post_assign(event.event_id, asset_id='A#01')

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertIn('A#01', self.data_manager.inventory)
        self.assertIn('A#01', event.actually_prepared)
        self.assertNotIn('A#01', event.prepared_items)
        self.assertEqual(event.prepared_items, ['[MODEL]AX|TestBrand|TestModel|1|Matching item'])

        response = self.client.get('/api/assets')
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        asset = next(item for item in response.get_json()['data'] if item['internalId'] == 'A#01')
        self.assertEqual(asset['status'], 'deployed')

        response = self.client.get(f'/api/events/{event.event_id}')
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        event_data = response.get_json()['data']
        model_assets = [
            assigned
            for group in event_data['modelGroups'].values()
            for assigned in group.get('assignedAssets', [])
        ]
        self.assertEqual(model_assets[0]['id'], 'A#01')
        self.assertFalse(model_assets[0].get('isExtra'))

        department_assets = [
            asset
            for assets in event_data['assetsByDepartment'].values()
            for asset in assets
        ]
        detail_asset = next(asset for asset in department_assets if asset['id'] == 'A#01')
        self.assertFalse(detail_asset.get('isExtra'))

    def test_event_progress_totals_include_misc_quantity_with_model_requirements(self):
        misc_marker = app_module._make_custom_marker(
            'MISC',
            'Cable ties',
            3,
            'AX',
            '',
        )
        event = self.make_event(
            event_id=111,
            prepared=[
                '[MODEL]AX|TestBrand|TestModel|1|Matching item',
                misc_marker,
            ],
            actual=['A#01', misc_marker],
            extra=[],
        )
        self.login_as('normal')

        response = self.client.get('/api/events')

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        event_summary = next(
            item for item in response.get_json()['data']
            if item['id'] == event.event_id
        )
        self.assertEqual(event_summary['assetCount'], 4)
        self.assertEqual(event_summary['preparedCount'], 4)

        response = self.client.get(f'/api/events/{event.event_id}')

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        event_details = response.get_json()['data']
        self.assertEqual(event_details['totalAssets'], 4)
        self.assertEqual(event_details['totalPrepared'], 4)

    def test_removing_prepared_bulk_model_unprepares_deployment(self):
        self.data_manager.inventory['BULK-0001'] = self.make_asset(
            'BULK-0001',
            department='STG',
            is_bulk=True,
            quantity=10,
        )
        marker = app_module._bulk_marker('BULK-0001', 5)
        event = self.make_event(
            event_id=109,
            prepared=['[MODEL]STG|TestBrand|TestModel|5|Matching item'],
            actual=[marker],
            extra=[],
        )

        self.login_as('admin', True)
        response = self.client.delete(
            f'/api/events/{event.event_id}/models',
            json={
                'department': 'STG',
                'brand': 'TestBrand',
                'model': 'TestModel',
                'description': 'Matching item',
            },
        )

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertEqual(response.get_json()['data']['unpreparedQuantity'], 5)
        self.assertEqual(event.prepared_items, [])
        self.assertEqual(event.actually_prepared, [])
        self.assertEqual(app_module._bulk_deployments_for_asset('BULK-0001'), [])

    def test_removing_prepared_model_releases_specific_asset(self):
        event = self.make_event(
            event_id=110,
            prepared=['[MODEL]AX|TestBrand|TestModel|1|Matching item'],
            actual=['A#01'],
            extra=[],
        )
        event.returned_items = ['A#01']
        self.data_manager.inventory['A#01'].current_location = event.name

        self.login_as('admin', True)
        response = self.client.delete(
            f'/api/events/{event.event_id}/models',
            json={
                'department': 'AX',
                'brand': 'TestBrand',
                'model': 'TestModel',
                'description': 'Matching item',
            },
        )

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertEqual(event.prepared_items, [])
        self.assertEqual(event.actually_prepared, [])
        self.assertEqual(event.returned_items, [])
        self.assertEqual(self.data_manager.inventory['A#01'].current_location, 'Store')

    def test_reducing_model_quantity_keeps_prepared_specific_assets(self):
        event = self.make_event(
            event_id=112,
            prepared=['[MODEL]AX|TestBrand|TestModel|2|Matching item'],
            actual=['A#01', 'A#02'],
            extra=[],
        )

        self.login_as('admin', True)
        response = self.client.put(
            f'/api/events/{event.event_id}/models',
            json={
                'department': 'AX',
                'brand': 'TestBrand',
                'model': 'TestModel',
                'description': 'Matching item',
                'quantity': 1,
            },
        )

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertEqual(
            event.prepared_items,
            ['[MODEL]AX|TestBrand|TestModel|1|Matching item'],
        )
        self.assertEqual(event.actually_prepared, ['A#01', 'A#02'])
        self.assertEqual(event.returned_items, [])
        self.assertEqual(event.extra_assets, [])

        details_response = self.client.get(f'/api/events/{event.event_id}')
        self.assertEqual(
            details_response.status_code,
            200,
            details_response.get_data(as_text=True),
        )
        model_group = next(
            iter(details_response.get_json()['data']['modelGroups'].values())
        )
        self.assertEqual(model_group['requiredQuantity'], 1)
        self.assertEqual(model_group['preparedQuantity'], 2)
        self.assertEqual(model_group['extraPreparedQuantity'], 0)

    def test_reducing_model_quantity_keeps_prepared_bulk_quantity(self):
        self.data_manager.inventory['BULK-0001'] = self.make_asset(
            'BULK-0001',
            department='STG',
            is_bulk=True,
            quantity=10,
        )
        prepared_marker = app_module._bulk_marker('BULK-0001', 5)
        event = self.make_event(
            event_id=113,
            prepared=['[MODEL]STG|TestBrand|TestModel|5|Matching item'],
            actual=[prepared_marker],
            extra=[],
        )

        self.login_as('admin', True)
        response = self.client.put(
            f'/api/events/{event.event_id}/models',
            json={
                'department': 'STG',
                'brand': 'TestBrand',
                'model': 'TestModel',
                'description': 'Matching item',
                'quantity': 3,
            },
        )

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertEqual(
            event.prepared_items,
            ['[MODEL]STG|TestBrand|TestModel|3|Matching item'],
        )
        self.assertEqual(event.actually_prepared, [prepared_marker])
        self.assertEqual(
            app_module._bulk_deployments_for_asset('BULK-0001')[0]['quantity'],
            5,
        )

    def test_quick_add_false_overrides_container_auto_add(self):
        event = self.make_event(event_id=104)

        response = self.post_assign(event.event_id, quickAdd=False, fromContainer=True, source='container')

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertTrue(response.get_json()['data']['isExtra'])
        self.assertIn('A#02', event.extra_assets)

    def test_unprepare_clears_stale_returned_marker_for_model_asset(self):
        event = self.make_event(
            event_id=105,
            prepared=['[MODEL]AX|TestBrand|TestModel|1|Matching item'],
            actual=[],
            extra=[],
        )
        event.returned_items = ['A#01']
        event.state = 'Returning'

        self.login_as('normal')
        response = self.client.post(f'/api/events/{event.event_id}/unprepare', json={'assetId': 'A#01'})

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertNotIn('A#01', event.returned_items)
        self.assertNotEqual(event.state, 'Returning')

    def test_inventory_save_preserves_rows_unknown_to_stale_process(self):
        disk_manager = DataManager(self.tempdir.name)
        disk_manager.inventory = {
            'A#01': self.make_asset('A#01'),
            'Z#99': self.make_asset('Z#99'),
        }
        disk_manager.save_inventory()

        stale_manager = DataManager(self.tempdir.name)
        stale_manager.inventory = {
            'A#01': self.make_asset('A#01'),
        }
        stale_manager.inventory['A#01'].current_location = 'Event 1'
        stale_manager.save_inventory()

        reloaded = DataManager(self.tempdir.name)
        reloaded.load_inventory()
        self.assertIn('A#01', reloaded.inventory)
        self.assertIn('Z#99', reloaded.inventory)
        self.assertEqual(reloaded.inventory['A#01'].current_location, 'Event 1')

    def test_inventory_save_can_drop_one_explicit_asset_without_losing_unknown_rows(self):
        disk_manager = DataManager(self.tempdir.name)
        disk_manager.inventory = {
            'A#01': self.make_asset('A#01'),
            'B#01': self.make_asset('B#01'),
            'Z#99': self.make_asset('Z#99'),
        }
        disk_manager.save_inventory()

        stale_manager = DataManager(self.tempdir.name)
        stale_manager.inventory = {
            'A#01': self.make_asset('A#01'),
        }
        stale_manager.save_inventory(drop_asset_ids=['B#01'])

        reloaded = DataManager(self.tempdir.name)
        reloaded.load_inventory()
        self.assertIn('A#01', reloaded.inventory)
        self.assertNotIn('B#01', reloaded.inventory)
        self.assertIn('Z#99', reloaded.inventory)

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

    def test_asset_delete_removes_asset_from_tagged_event(self):
        event = self.make_event(
            event_id=106,
            prepared=['[MODEL]AX|TestBrand|TestModel|1|Matching item', 'A#01'],
            actual=['A#01'],
            extra=['A#01'],
        )
        event.returned_items = ['A#01']

        self.login_as('admin', True)
        response = self.client.delete(
            f'/api/assets/{quote("A#01", safe="")}',
            json={'password': 'pw'},
        )

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        body = response.get_json()
        self.assertEqual(body['data']['eventsUpdated'], 1)
        self.assertNotIn('A#01', self.data_manager.inventory)
        self.assertNotIn('A#01', event.prepared_items)
        self.assertNotIn('A#01', event.actually_prepared)
        self.assertNotIn('A#01', event.returned_items)
        self.assertNotIn('A#01', event.extra_assets)

    def test_event_remove_asset_uses_complete_admin_route(self):
        event = self.make_event(
            event_id=107,
            prepared=['[MODEL]AX|TestBrand|TestModel|1|Matching item'],
            actual=['A#02'],
            extra=['A#02'],
        )

        self.login_as('normal')
        forbidden = self.client.post(
            '/api/events/107/remove-asset',
            json={'assetId': 'A#02'},
        )
        self.assertEqual(forbidden.status_code, 403)

        self.login_as('admin', True)
        response = self.client.post(
            '/api/events/107/remove-asset',
            json={'assetId': 'A#02'},
        )

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertNotIn('A#02', event.actually_prepared)
        self.assertNotIn('A#02', event.extra_assets)
        self.assertEqual(self.data_manager.inventory['A#02'].current_location, 'Store')

    def test_bulk_asset_delete_requires_password_and_cleans_events_and_containers(self):
        event = self.make_event(
            event_id=107,
            prepared=['A#01', 'B#01'],
            actual=['A#01', 'B#01'],
            extra=['B#01'],
        )

        self.login_as('normal')
        response = self.client.delete('/api/assets/bulk-delete', json={
            'assetIds': ['A#01', 'B#01'],
            'password': 'pw',
        })
        self.assertEqual(response.status_code, 403)

        self.login_as('admin', True)
        response = self.client.delete('/api/assets/bulk-delete', json={'assetIds': ['A#01', 'B#01']})
        self.assertEqual(response.status_code, 400)

        response = self.client.delete('/api/assets/bulk-delete', json={
            'assetIds': ['A#01', 'B#01'],
            'password': 'wrong',
        })
        self.assertEqual(response.status_code, 403)

        response = self.client.delete('/api/assets/bulk-delete', json={
            'assetIds': ['A#01', 'B#01'],
            'password': 'pw',
        })

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        body = response.get_json()
        self.assertEqual(set(body['data']['deletedAssets']), {'A#01', 'B#01'})
        self.assertEqual(body['data']['eventsUpdated'], 1)
        self.assertNotIn('A#01', self.data_manager.inventory)
        self.assertNotIn('B#01', self.data_manager.inventory)
        self.assertEqual(self.data_manager.containers['CASE-1'].asset_ids, [])
        self.assertEqual(event.prepared_items, [])
        self.assertEqual(event.actually_prepared, [])
        self.assertEqual(event.extra_assets, [])

    def test_bulk_asset_delete_removes_bulk_event_markers(self):
        self.data_manager.inventory['BULK-0001'] = self.make_asset(
            'BULK-0001',
            is_bulk=True,
            quantity=5,
        )
        marker = app_module._bulk_marker('BULK-0001', 2)
        event = self.make_event(
            event_id=108,
            prepared=[],
            actual=[marker],
            extra=[marker],
        )
        event.returned_items = [marker]

        self.login_as('admin', True)
        response = self.client.delete('/api/assets/bulk-delete', json={
            'assetIds': ['BULK-0001'],
            'password': 'pw',
        })

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertNotIn('BULK-0001', self.data_manager.inventory)
        self.assertEqual(event.actually_prepared, [])
        self.assertEqual(event.returned_items, [])
        self.assertEqual(event.extra_assets, [])


if __name__ == '__main__':
    unittest.main()
