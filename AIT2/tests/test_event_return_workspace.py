import tempfile
import unittest

import app as app_module
from data_manager import DataManager
from models import Event, InventoryItem, User, hash_password


class EventReturnWorkspaceTests(unittest.TestCase):
    def setUp(self):
        self.original_data_manager = app_module.get_default_data_manager()
        self.original_signature = app_module._data_snapshot_signature
        self.original_testing = app_module.app.config.get('TESTING')
        self.tempdir = tempfile.TemporaryDirectory()

        self.data_manager = DataManager(self.tempdir.name)
        self.data_manager.setup_data_folder()
        self.data_manager.users = {
            'operator': User(
                'operator',
                hash_password('pw', 'salt'),
                'salt',
                False,
                True,
            ),
        }
        self.data_manager.save_users()
        self.data_manager.logs = []
        self.data_manager.save_logs()
        self.data_manager.inventory = {
            'A-001': self.make_asset('A-001'),
            'BULK-001': self.make_asset('BULK-001', is_bulk=True, quantity=10),
        }
        self.data_manager.save_inventory()

        app_module.app.config['TESTING'] = True
        app_module.set_data_manager_for_testing(self.data_manager)
        self.client = app_module.app.test_client()
        with self.client.session_transaction() as session:
            session['user'] = 'operator'
            session['is_admin'] = False

    def tearDown(self):
        app_module.clear_test_data_manager(self.original_data_manager)
        app_module._data_snapshot_signature = self.original_signature
        app_module.app.config['TESTING'] = self.original_testing
        self.tempdir.cleanup()

    def make_asset(self, asset_id, is_bulk=False, quantity=1):
        return InventoryItem(
            asset_id=asset_id,
            brand='TestBrand',
            model_number='TestModel',
            serial_number=f'SN-{asset_id}',
            description='Return test item',
            is_missing=False,
            maintenance_logs=[],
            department_code='AX',
            default_location='Store',
            current_location='Store',
            is_bulk=is_bulk,
            quantity=quantity,
        )

    def make_event(
        self,
        event_id=1,
        prepared_items=None,
        actually_prepared=None,
        returned_items=None,
    ):
        event = Event(
            event_id=event_id,
            name=f'Event {event_id}',
            start_date='20260701',
            end_date='20260701',
            asset_models=[],
            prepared_items=prepared_items or [
                '[MODEL]AX|TestBrand|TestModel|1|Return test item'
            ],
            actually_prepared=actually_prepared or [],
            returned_items=returned_items or [],
            state='Closed' if returned_items else 'Overdue',
            assigned_users=['operator'],
        )
        self.data_manager.events[event_id] = event
        self.data_manager.save_event(event)
        return event

    def test_unreturn_restores_regular_asset_to_event(self):
        event = self.make_event(returned_items=['A-001'])

        details = self.client.get(f'/api/events/{event.event_id}')
        self.assertEqual(details.status_code, 200, details.get_data(as_text=True))
        returned_rows = [
            asset
            for assets in details.get_json()['data']['assetsByDepartment'].values()
            for asset in assets
            if asset.get('id') == 'A-001'
        ]
        self.assertEqual(len(returned_rows), 1)
        self.assertEqual(returned_rows[0]['status'], 'returned')

        response = self.client.post(
            f'/api/events/{event.event_id}/unreturn',
            json={'assetId': 'A-001'},
        )

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        event = self.data_manager.events[event.event_id]
        self.assertNotIn('A-001', event.returned_items)
        self.assertIn('A-001', event.actually_prepared)
        self.assertEqual(
            self.data_manager.inventory['A-001'].current_location,
            event.name,
        )
        self.assertNotEqual(event.state, 'Closed')

    def test_unreturn_rejects_asset_now_used_by_another_event(self):
        event = self.make_event(returned_items=['A-001'])
        self.make_event(
            event_id=2,
            prepared_items=['A-001'],
            actually_prepared=['A-001'],
        )

        response = self.client.post(
            f'/api/events/{event.event_id}/unreturn',
            json={'assetId': 'A-001'},
        )

        self.assertEqual(response.status_code, 409, response.get_data(as_text=True))
        self.assertIn('now assigned', response.get_json()['error'])
        event = self.data_manager.events[event.event_id]
        self.assertIn('A-001', event.returned_items)
        self.assertNotIn('A-001', event.actually_prepared)

    def test_unreturn_supports_bulk_and_custom_markers(self):
        bulk_marker = app_module._bulk_marker('BULK-001', 3)
        custom_marker = app_module._make_custom_marker(
            'MISC',
            'Cable ties',
            2,
            'AX',
            '',
        )
        event = self.make_event(
            prepared_items=[bulk_marker, custom_marker],
            actually_prepared=[bulk_marker, custom_marker],
            returned_items=[bulk_marker, custom_marker],
        )

        bulk_response = self.client.post(
            f'/api/events/{event.event_id}/unreturn',
            json={'assetId': bulk_marker},
        )
        custom_response = self.client.post(
            f'/api/events/{event.event_id}/unreturn',
            json={'assetId': custom_marker},
        )

        self.assertEqual(bulk_response.status_code, 200)
        self.assertEqual(custom_response.status_code, 200)
        event = self.data_manager.events[event.event_id]
        self.assertEqual(event.returned_items, [])
        self.assertIn(bulk_marker, event.actually_prepared)
        self.assertIn(custom_marker, event.actually_prepared)

    def test_close_return_requires_every_asset_to_be_returned(self):
        event = self.make_event(
            actually_prepared=['A-001'],
            returned_items=[],
        )

        blocked = self.client.post(
            f'/api/events/{event.event_id}/close-return',
            json={},
        )

        self.assertEqual(blocked.status_code, 409, blocked.get_data(as_text=True))
        self.assertIn('still need', blocked.get_json()['error'])

        event = self.data_manager.events[event.event_id]
        event.actually_prepared = []
        event.returned_items = ['A-001']
        self.data_manager.save_event(event)
        completed = self.client.post(
            f'/api/events/{event.event_id}/close-return',
            json={},
        )

        self.assertEqual(completed.status_code, 200, completed.get_data(as_text=True))
        event = self.data_manager.events[event.event_id]
        self.assertEqual(event.state, 'Closed')
        self.assertFalse(event.force_state_override)

    def test_anonymous_prepared_quantity_supports_partial_return_and_unreturn(self):
        group = {
            'department': 'AX',
            'brand': 'TestBrand',
            'model': 'TestModel',
            'description': 'Return test item',
        }
        event = self.make_event(
            prepared_items=['[MODEL]AX|TestBrand|TestModel|5|Return test item'],
            actually_prepared=[app_module._prepared_model_marker(group, 5)],
        )

        returned = self.client.post(
            f'/api/events/{event.event_id}/return-prepared-quantity',
            json={**group, 'quantity': 2},
        )

        self.assertEqual(returned.status_code, 200, returned.get_data(as_text=True))
        event = self.data_manager.events[event.event_id]
        self.assertEqual(app_module._event_prepared_slot_quantity(event, group), 3)
        self.assertEqual(app_module._event_returned_prepared_slot_quantity(event, group), 2)
        self.assertEqual(app_module._event_returnable_counts(event)['returnable'], 3)
        self.assertEqual(app_module._event_returnable_counts(event)['total'], 5)

        details = self.client.get(f'/api/events/{event.event_id}').get_json()['data']
        model_group = next(iter(details['modelGroups'].values()))
        self.assertEqual(model_group['preparedSlotQuantity'], 3)
        self.assertEqual(model_group['returnedPreparedSlotQuantity'], 2)
        self.assertEqual(model_group['returnedQuantity'], 2)

        restored = self.client.post(
            f'/api/events/{event.event_id}/unreturn-prepared-quantity',
            json={**group, 'quantity': 1},
        )
        self.assertEqual(restored.status_code, 200, restored.get_data(as_text=True))
        event = self.data_manager.events[event.event_id]
        self.assertEqual(app_module._event_prepared_slot_quantity(event, group), 4)
        self.assertEqual(app_module._event_returned_prepared_slot_quantity(event, group), 1)

        too_many = self.client.post(
            f'/api/events/{event.event_id}/unreturn-prepared-quantity',
            json={**group, 'quantity': 2},
        )
        self.assertEqual(too_many.status_code, 409)

    def test_specific_asset_can_reconcile_anonymous_slot_after_return(self):
        group = {
            'department': 'AX',
            'brand': 'TestBrand',
            'model': 'TestModel',
            'description': 'Return test item',
        }
        event = self.make_event(
            prepared_items=['[MODEL]AX|TestBrand|TestModel|1|Return test item'],
            actually_prepared=[app_module._prepared_model_marker(group, 1)],
        )
        returned = self.client.post(
            f'/api/events/{event.event_id}/return-prepared-quantity',
            json={**group, 'quantity': 1},
        )
        self.assertEqual(returned.status_code, 200, returned.get_data(as_text=True))

        # A later deployment must not prevent recording which asset had already
        # returned from this event.
        self.make_event(
            event_id=2,
            prepared_items=['A-001'],
            actually_prepared=['A-001'],
        )
        available = self.client.get(
            f'/api/assets/available-for-event/{event.event_id}'
        )
        self.assertEqual(available.status_code, 200, available.get_data(as_text=True))
        self.assertIn('A-001', [row['id'] for row in available.get_json()['data']])

        assigned = self.client.post(
            f'/api/events/{event.event_id}/assign-specific',
            json={'assetId': 'A-001'},
        )

        self.assertEqual(assigned.status_code, 200, assigned.get_data(as_text=True))
        event = self.data_manager.events[event.event_id]
        self.assertEqual(app_module._event_returned_prepared_slot_quantity(event, group), 0)
        self.assertNotIn('A-001', event.actually_prepared)
        self.assertIn('A-001', event.returned_items)
        self.assertEqual(self.data_manager.inventory['A-001'].current_location, 'Store')
        self.assertEqual(app_module._event_returnable_counts(event)['returnable'], 0)
        self.assertEqual(app_module._event_returnable_counts(event)['returned'], 1)


if __name__ == '__main__':
    unittest.main()
