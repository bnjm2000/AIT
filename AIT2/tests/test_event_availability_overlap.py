import tempfile
import unittest

import app as app_module
from data_manager import DataManager
from models import Event, InventoryItem, User, hash_password


class EventAvailabilityOverlapTests(unittest.TestCase):
    def setUp(self):
        self.original_data_manager = app_module.data_manager
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

        self.data_manager.inventory = {}
        for i in range(1, 7):
            self.data_manager.inventory[f'A#{i:02d}'] = self.make_asset(
                f'A#{i:02d}',
                brand='TestBrand',
                model='RegularModel',
                description='Regular item',
            )
        self.data_manager.inventory['BULK-0001'] = self.make_asset(
            'BULK-0001',
            brand='TestBrand',
            model='BulkModel',
            description='Bulk item',
            is_bulk=True,
            quantity=6,
        )
        self.data_manager.save_inventory()

        app_module.data_manager = self.data_manager
        app_module.invalidate_cache()
        app_module.mark_data_snapshot_current()
        app_module.app.config['TESTING'] = True
        self.client = app_module.app.test_client()

    def tearDown(self):
        app_module.data_manager = self.original_data_manager
        app_module._data_snapshot_signature = self.original_signature
        app_module.app.config['TESTING'] = self.original_testing
        self.tempdir.cleanup()

    def make_asset(
        self,
        asset_id,
        brand='TestBrand',
        model='RegularModel',
        description='Regular item',
        is_bulk=False,
        quantity=1,
    ):
        return InventoryItem(
            asset_id=asset_id,
            brand=brand,
            model_number=model,
            serial_number=f'SN-{asset_id}',
            description=description,
            is_missing=False,
            maintenance_logs=[],
            department_code='AX',
            default_location='Store',
            current_location='',
            is_bulk=is_bulk,
            quantity=quantity,
        )

    def login_as(self, username='normal', is_admin=False):
        with self.client.session_transaction() as session:
            session['user'] = username
            session['is_admin'] = is_admin

    def make_event(self, event_id, start='20260520', end='20260520', prepared=None, actual=None, returned=None):
        event = Event(
            event_id=event_id,
            name=f'Event {event_id}',
            start_date=start,
            end_date=end,
            asset_models=[],
            prepared_items=prepared if prepared is not None else [],
            returned_items=returned if returned is not None else [],
            actually_prepared=actual if actual is not None else [],
            extra_assets=[],
            tag='events',
        )
        self.data_manager.events[event_id] = event
        return event

    def availability_entry(self, event_id, model, description):
        self.login_as()
        response = self.client.get(f'/api/events/{event_id}/availability')
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        data = response.get_json()['data']
        return next(
            item for item in data
            if item['model'] == model and item['description'] == description
        )

    def test_model_availability_counts_overlapping_regular_and_bulk_usage(self):
        self.make_event(100)
        self.make_event(
            101,
            prepared=['[MODEL]AX|TestBrand|RegularModel|4|Regular item'],
        )
        self.make_event(
            102,
            actual=[app_module._bulk_marker('BULK-0001', 4)],
        )

        regular = self.availability_entry(100, 'RegularModel', 'Regular item')
        bulk = self.availability_entry(100, 'BulkModel', 'Bulk item')

        self.assertEqual(regular['physical'], 6)
        self.assertEqual(regular['overlappingDemand'], 4)
        self.assertEqual(regular['available'], 2)
        self.assertEqual(bulk['physical'], 6)
        self.assertEqual(bulk['overlappingDemand'], 4)
        self.assertEqual(bulk['available'], 2)

    def test_prepare_dropdown_hides_assets_assigned_to_overlapping_events_only(self):
        self.make_event(100)
        self.make_event(101, prepared=['A#01'])
        self.make_event(102, start='20260601', end='20260601', prepared=['A#02'])
        self.make_event(103, prepared=['A#03'], returned=['A#03'])

        self.login_as()
        response = self.client.get('/api/assets/available-for-event/100')

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        ids = {item['id'] or item.get('bulkId') for item in response.get_json()['data']}
        self.assertNotIn('A#01', ids)
        self.assertIn('A#02', ids)
        self.assertIn('A#03', ids)

    def test_bulk_prepare_is_capped_by_overlapping_event_availability(self):
        target = self.make_event(
            100,
            prepared=['[MODEL]AX|TestBrand|BulkModel|4|Bulk item'],
        )
        self.make_event(
            101,
            actual=[app_module._bulk_marker('BULK-0001', 4)],
        )

        self.login_as()
        response = self.client.post(
            '/api/events/100/assign-specific',
            json={'assetId': 'BULK-0001'},
        )

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        marker = app_module._bulk_marker('BULK-0001', 2)
        self.assertEqual(response.get_json()['data']['assetId'], marker)
        self.assertIn(marker, target.actually_prepared)

    def test_normal_user_can_return_individual_bulk_marker(self):
        marker = app_module._bulk_marker('BULK-0001', 2)
        event = self.make_event(
            100,
            prepared=['[MODEL]AX|TestBrand|BulkModel|2|Bulk item'],
            actual=[marker],
        )

        self.login_as()
        response = self.client.post('/api/events/100/return', json={'assetId': marker})

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertIn(marker, event.returned_items)


if __name__ == '__main__':
    unittest.main()
