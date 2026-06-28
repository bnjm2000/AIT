import tempfile
import unittest
from urllib.parse import quote

import app as app_module
from data_manager import DataManager
from models import Container, Event, InventoryItem, User, hash_password


class AssetUpdateEventPropagationTests(unittest.TestCase):
    def setUp(self):
        self.original_data_manager = app_module.data_manager
        self.original_signature = app_module._data_snapshot_signature
        self.original_testing = app_module.app.config.get('TESTING')
        self.original_active_company_code = app_module._active_company_code
        self.tempdir = tempfile.TemporaryDirectory()

        self.data_manager = DataManager(self.tempdir.name)
        self.data_manager.setup_data_folder()
        self.data_manager.users = {
            'admin': User('admin', hash_password('pw', 'salt'), 'salt', True, True),
        }
        self.data_manager.save_users()
        self.data_manager.logs = []
        self.data_manager.save_logs()
        self.data_manager.containers = {}
        self.data_manager.save_containers()

        self.data_manager.inventory = {
            'A#01': self.make_asset('A#01'),
            'A#02': self.make_asset('A#02'),
            'BULK-0001': self.make_asset(
                'BULK-0001',
                model='BulkModel',
                description='Bulk item',
                is_bulk=True,
                quantity=6,
            ),
        }
        self.data_manager.save_inventory()

        app_module.data_manager = self.data_manager
        app_module._active_company_code = app_module._user_assigned_company_code('admin')
        app_module.invalidate_cache()
        app_module.mark_data_snapshot_current()
        app_module.app.config['TESTING'] = True
        self.client = app_module.app.test_client()

    def tearDown(self):
        app_module.data_manager = self.original_data_manager
        app_module._data_snapshot_signature = self.original_signature
        app_module._active_company_code = self.original_active_company_code
        app_module.app.config['TESTING'] = self.original_testing
        self.tempdir.cleanup()

    def make_asset(
        self,
        asset_id,
        brand='TestBrand',
        model='OldModel',
        description='Old desc',
        is_bulk=False,
        quantity=1,
    ):
        return InventoryItem(
            asset_id=asset_id,
            brand=brand,
            model_number=model,
            serial_number='' if is_bulk else f'SN-{asset_id}',
            description=description,
            is_missing=False,
            maintenance_logs=[],
            department_code='AX',
            default_location='Store',
            current_location='',
            is_bulk=is_bulk,
            quantity=quantity,
        )

    def make_event(self, event_id, prepared=None, actual=None, returned=None, extra=None):
        event = Event(
            event_id=event_id,
            name=f'Event {event_id}',
            start_date='20260520',
            end_date='20260520',
            asset_models=[],
            prepared_items=prepared if prepared is not None else [],
            returned_items=returned if returned is not None else [],
            actually_prepared=actual if actual is not None else [],
            extra_assets=extra if extra is not None else [],
            tag='events',
        )
        self.data_manager.events[event_id] = event
        return event

    def login_admin(self):
        with self.client.session_transaction() as session:
            session['user'] = 'admin'
            session['is_admin'] = True

    def put_asset(self, asset_id, **payload):
        self.login_admin()
        return self.client.put(
            f'/api/assets/{quote(asset_id, safe="")}',
            json={
                'id': asset_id,
                'brand': 'TestBrand',
                'model': 'OldModel',
                'description': 'Old desc',
                'department': 'AX',
                'applyTo': 'single',
                **payload,
            },
        )

    def test_single_asset_detail_change_updates_assigned_and_unassigned_model_events(self):
        assigned = self.make_event(
            100,
            prepared=['[MODEL]AX|TestBrand|OldModel|2|Old desc'],
            actual=['A#01'],
        )
        unassigned = self.make_event(
            101,
            prepared=['[MODEL]AX|TestBrand|OldModel|3|Old desc'],
        )
        other_asset_assigned = self.make_event(
            102,
            prepared=['[MODEL]AX|TestBrand|OldModel|1|Old desc'],
            actual=['A#02'],
        )

        response = self.put_asset(
            'A#01',
            model='NewModel',
            description='New desc',
        )

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertIn('[MODEL]AX|TestBrand|OldModel|1|Old desc', assigned.prepared_items)
        self.assertIn('[MODEL]AX|TestBrand|NewModel|1|New desc', assigned.prepared_items)
        self.assertEqual(unassigned.prepared_items, ['[MODEL]AX|TestBrand|NewModel|3|New desc'])
        self.assertEqual(other_asset_assigned.prepared_items, ['[MODEL]AX|TestBrand|OldModel|1|Old desc'])
        self.assertEqual(response.get_json()['data']['eventsUpdated'], 2)

    def test_bulk_asset_detail_change_updates_assigned_quantity_and_unassigned_model_events(self):
        marker = app_module._bulk_marker('BULK-0001', 4)
        assigned = self.make_event(
            200,
            prepared=['[MODEL]AX|TestBrand|BulkModel|4|Bulk item'],
            actual=[marker],
        )
        unassigned = self.make_event(
            201,
            prepared=['[MODEL]AX|TestBrand|BulkModel|3|Bulk item'],
        )

        response = self.put_asset(
            'BULK-0001',
            model='NewBulkModel',
            description='New bulk item',
            quantity=6,
        )

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertEqual(assigned.prepared_items, ['[MODEL]AX|TestBrand|NewBulkModel|4|New bulk item'])
        self.assertEqual(unassigned.prepared_items, ['[MODEL]AX|TestBrand|NewBulkModel|3|New bulk item'])
        self.assertEqual(response.get_json()['data']['eventsUpdated'], 2)

    def test_regular_asset_id_change_uses_edited_id_and_updates_event_references(self):
        event = self.make_event(300, prepared=['A#01'], actual=['A#01'], extra=['A#01'])

        response = self.put_asset('A#01', id='A#99', internalId='A#01')

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertNotIn('A#01', self.data_manager.inventory)
        self.assertIn('A#99', self.data_manager.inventory)
        self.assertEqual(event.prepared_items, ['A#99'])
        self.assertEqual(event.actually_prepared, ['A#99'])
        self.assertEqual(event.extra_assets, ['A#99'])

    def test_bulk_asset_id_change_updates_bulk_event_markers(self):
        marker = app_module._bulk_marker('BULK-0001', 2)
        event = self.make_event(
            400,
            prepared=[marker],
            actual=[marker],
            returned=[marker],
            extra=[marker],
        )

        response = self.put_asset(
            'BULK-0001',
            id='BULK-0099',
            internalId='BULK-0001',
            model='BulkModel',
            description='Bulk item',
            quantity=6,
        )

        new_marker = app_module._bulk_marker('BULK-0099', 2)
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertNotIn('BULK-0001', self.data_manager.inventory)
        self.assertIn('BULK-0099', self.data_manager.inventory)
        self.assertEqual(event.prepared_items, [new_marker])
        self.assertEqual(event.actually_prepared, [new_marker])
        self.assertEqual(event.returned_items, [new_marker])
        self.assertEqual(event.extra_assets, [new_marker])

    def test_bulk_renumber_handles_overlapping_ids_and_updates_references(self):
        self.data_manager.containers = {
            'CASE-1': Container('CASE-1', ['A#01', 'A#02']),
        }
        self.data_manager.save_containers()
        app_module.mark_data_snapshot_current()
        event = self.make_event(
            450,
            prepared=['A#01', 'A#02'],
            actual=['A#02'],
            returned=['A#01'],
            extra=['A#02'],
        )
        self.login_admin()

        response = self.client.post('/api/assets/bulk-renumber', json={
            'assetIds': ['A#01', 'A#02'],
            'startingAssetId': 'A#02',
        })

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        body = response.get_json()['data']
        self.assertEqual(body['mapping'], {'A#01': 'A#02', 'A#02': 'A#03'})
        self.assertNotIn('A#01', self.data_manager.inventory)
        self.assertEqual(self.data_manager.inventory['A#02'].serial_number, 'SN-A#01')
        self.assertEqual(self.data_manager.inventory['A#03'].serial_number, 'SN-A#02')
        self.assertEqual(event.prepared_items, ['A#02', 'A#03'])
        self.assertEqual(event.actually_prepared, ['A#03'])
        self.assertEqual(event.returned_items, ['A#02'])
        self.assertEqual(event.extra_assets, ['A#03'])
        self.assertEqual(
            self.data_manager.containers['CASE-1'].asset_ids,
            ['A#02', 'A#03'],
        )

        reloaded = DataManager(self.tempdir.name)
        reloaded.load_inventory()
        self.assertNotIn('A#01', reloaded.inventory)
        self.assertIn('A#02', reloaded.inventory)
        self.assertIn('A#03', reloaded.inventory)

    def test_bulk_renumber_rejects_ids_owned_by_unselected_assets(self):
        self.login_admin()

        response = self.client.post('/api/assets/bulk-renumber', json={
            'assetIds': ['A#01', 'A#02'],
            'startingAssetId': 'BULK-0001',
        })

        self.assertEqual(response.status_code, 409)
        self.assertIn('already exists', response.get_json()['error'])
        self.assertIn('A#01', self.data_manager.inventory)
        self.assertIn('A#02', self.data_manager.inventory)

    def test_asset_update_saves_date_of_purchase(self):
        response = self.put_asset('A#01', dateOfPurchase='2026/06/02')

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertEqual(self.data_manager.inventory['A#01'].date_of_purchase, '2026-06-02')

        assets_response = self.client.get('/api/assets')
        self.assertEqual(assets_response.status_code, 200, assets_response.get_data(as_text=True))
        asset_payload = next(item for item in assets_response.get_json()['data'] if item['internalId'] == 'A#01')
        self.assertEqual(asset_payload['dateOfPurchase'], '2026-06-02')

    def test_asset_update_saves_notes(self):
        notes = 'Keep with show kit A\nLens cap is loose'
        response = self.put_asset('A#01', notes=notes)

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        asset = self.data_manager.inventory['A#01']
        self.assertEqual(asset.notes, notes)

        reloaded = DataManager(self.tempdir.name)
        reloaded.load_inventory()
        self.assertEqual(reloaded.inventory['A#01'].notes, notes)

        changes = {change['field']: change for change in asset.change_history[0]['changes']}
        self.assertEqual(changes['notes']['new'], notes)

        assets_response = self.client.get('/api/assets')
        self.assertEqual(assets_response.status_code, 200, assets_response.get_data(as_text=True))
        asset_payload = next(item for item in assets_response.get_json()['data'] if item['internalId'] == 'A#01')
        self.assertEqual(asset_payload['notes'], notes)

    def test_asset_update_records_manual_change_history(self):
        response = self.put_asset(
            'A#01',
            model='NewModel',
            serial='SN-NEW',
            dateOfPurchase='2026-06-02',
        )

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        asset = self.data_manager.inventory['A#01']

        self.assertRegex(asset.date_modified, r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$')
        self.assertEqual(len(asset.change_history), 1)
        self.assertEqual(asset.change_history[0]['action'], 'updated')
        self.assertEqual(asset.change_history[0]['user'], 'admin')

        changes = {change['field']: change for change in asset.change_history[0]['changes']}
        self.assertEqual(changes['model']['old'], 'OldModel')
        self.assertEqual(changes['model']['new'], 'NewModel')
        self.assertEqual(changes['serial']['old'], 'SN-A#01')
        self.assertEqual(changes['serial']['new'], 'SN-NEW')
        self.assertEqual(changes['date_of_purchase']['new'], '2026-06-02')

        assets_response = self.client.get('/api/assets')
        self.assertEqual(assets_response.status_code, 200, assets_response.get_data(as_text=True))
        asset_payload = next(item for item in assets_response.get_json()['data'] if item['internalId'] == 'A#01')
        self.assertEqual(asset_payload['dateModified'], asset.date_modified)
        self.assertEqual(asset_payload['changeHistory'][0]['changes'][0]['field'], 'model')

    def test_maintenance_serial_and_location_change_do_not_update_manual_modified_date(self):
        asset = self.data_manager.inventory['A#01']
        asset.date_modified = '2026-06-01T10:00:00'
        asset.change_history = [{
            'date': '2026-06-01T10:00:00',
            'user': 'admin',
            'action': 'updated',
            'changes': [{
                'field': 'description',
                'label': 'Description',
                'old': 'Old',
                'new': 'Old desc',
            }],
        }]
        self.data_manager.save_inventory()
        app_module.mark_data_snapshot_current()

        self.login_admin()
        response = self.client.post(
            '/api/assets/A%2301/maintain',
            json={
                'logEntry': 'Swap during maintenance',
                'maintenanceDate': '2026-06-05',
                'newLocation': 'Workshop',
                'newSerial': 'SN-MAINT',
            },
        )

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        asset = self.data_manager.inventory['A#01']
        self.assertEqual(asset.current_location, 'Workshop')
        self.assertEqual(asset.serial_number, 'SN-MAINT')
        self.assertEqual(asset.date_modified, '2026-06-01T10:00:00')
        self.assertEqual(len(asset.change_history), 1)


if __name__ == '__main__':
    unittest.main()
