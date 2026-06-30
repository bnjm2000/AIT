import tempfile
import unittest

import app as app_module
from data_manager import DataManager
from models import Event, InventoryItem, User, hash_password


class EventAvailabilityOverlapTests(unittest.TestCase):
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

        app_module.app.config['TESTING'] = True
        app_module.set_data_manager_for_testing(self.data_manager)
        app_module.invalidate_cache()
        self.client = app_module.app.test_client()

    def tearDown(self):
        app_module.clear_test_data_manager(self.original_data_manager)
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
        is_missing=False,
        is_ooc=False,
        is_degraded=False,
    ):
        return InventoryItem(
            asset_id=asset_id,
            brand=brand,
            model_number=model,
            serial_number=f'SN-{asset_id}',
            description=description,
            is_missing=is_missing,
            maintenance_logs=[],
            department_code='AX',
            default_location='Store',
            current_location='',
            is_ooc=is_ooc,
            is_bulk=is_bulk,
            quantity=quantity,
            is_degraded=is_degraded,
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
            if item['model'] == model
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
        self.assertEqual(regular['description'], '')
        self.assertEqual(regular['overlappingDemand'], 4)
        self.assertEqual(regular['available'], 2)
        self.assertEqual(regular['overlappingEvents'], [{
            'eventId': 101,
            'eventName': 'Event 101',
            'startDate': '2026/05/20',
            'endDate': '2026/05/20',
            'quantity': 4,
        }])
        self.assertEqual(bulk['physical'], 6)
        self.assertEqual(bulk['overlappingDemand'], 4)
        self.assertEqual(bulk['available'], 2)
        self.assertEqual(bulk['overlappingEvents'][0]['eventId'], 102)

    def test_regular_ooc_asset_stays_in_total_but_is_not_available(self):
        self.make_event(100)
        self.data_manager.inventory['A#01'].is_ooc = True

        regular = self.availability_entry(100, 'RegularModel', 'Regular item')

        self.assertEqual(regular['physical'], 6)
        self.assertEqual(regular['assetOOC'], 1)
        self.assertEqual(regular['available'], 5)
        self.assertEqual(regular['unavailable'], 1)

    def test_regular_missing_asset_stays_in_total_but_is_not_available(self):
        self.make_event(100)
        self.data_manager.inventory['A#01'].is_missing = True

        regular = self.availability_entry(100, 'RegularModel', 'Regular item')

        self.assertEqual(regular['physical'], 6)
        self.assertEqual(regular['assetMissing'], 1)
        self.assertEqual(regular['available'], 5)
        self.assertEqual(regular['unavailable'], 1)

    def test_prepare_dropdown_hides_assets_assigned_to_any_other_event(self):
        self.make_event(100)
        self.make_event(101, prepared=['A#01'])
        self.make_event(102, start='20260601', end='20260601', prepared=['A#02'])
        self.make_event(103, prepared=['A#03'], returned=['A#03'])

        self.login_as()
        response = self.client.get('/api/assets/available-for-event/100')

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        ids = {item['id'] or item.get('bulkId') for item in response.get_json()['data']}
        self.assertNotIn('A#01', ids)
        self.assertNotIn('A#02', ids)
        self.assertIn('A#03', ids)

    def test_prepare_dropdown_excludes_missing_and_ooc_but_includes_degraded(self):
        self.make_event(100)
        self.data_manager.inventory['MISS#01'] = self.make_asset('MISS#01', is_missing=True)
        self.data_manager.inventory['OOC#01'] = self.make_asset('OOC#01', is_ooc=True)
        self.data_manager.inventory['DEG#01'] = self.make_asset('DEG#01', is_degraded=True)

        self.login_as()
        response = self.client.get('/api/assets/available-for-event/100')

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        assets = response.get_json()['data']
        by_id = {item['id'] or item.get('bulkId'): item for item in assets}
        self.assertNotIn('MISS#01', by_id)
        self.assertNotIn('OOC#01', by_id)
        self.assertIn('DEG#01', by_id)
        self.assertTrue(by_id['DEG#01']['isDegraded'])

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

    def test_bulk_prepare_is_capped_by_any_other_event_availability(self):
        target = self.make_event(
            100,
            prepared=['[MODEL]AX|TestBrand|BulkModel|4|Bulk item'],
        )
        self.make_event(
            101,
            start='20260601',
            end='20260601',
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

    def test_bulk_ooc_maintenance_log_reduces_available_quantity_until_resolved(self):
        self.make_event(100)
        self.login_as()

        response = self.client.post('/api/assets/BULK-0001/maintain', json={
            'logEntry': 'One unit has a failed connector',
            'maintenanceDate': '2026-05-20',
            'logType': 'Fault',
            'assetStatus': 'ooc',
        })

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))

        assets_response = self.client.get('/api/assets')
        bulk_asset = next(item for item in assets_response.get_json()['data'] if item['bulkId'] == 'BULK-0001')
        self.assertEqual(bulk_asset['availableQuantity'], 5)
        self.assertEqual(bulk_asset['preparableQuantity'], 5)
        self.assertEqual(bulk_asset['bulkOOCQuantity'], 1)
        self.assertEqual(len(bulk_asset['bulkMaintenanceLogbook']), 1)
        self.assertFalse(bulk_asset['bulkMaintenanceLogbook'][0]['isResolved'])

        available_response = self.client.get('/api/assets/available-for-event/100')
        available_bulk = next(
            item for item in available_response.get_json()['data']
            if item.get('bulkId') == 'BULK-0001'
        )
        self.assertEqual(available_bulk['availableQuantity'], 5)
        self.assertEqual(available_bulk['preparableQuantity'], 5)

        fault = app_module._bulk_maintenance_fault_entries(self.data_manager.inventory['BULK-0001'])[0]
        response = self.client.post(
            f"/api/assets/BULK-0001/bulk-maintenance/{fault['id']}/resolve",
            json={
                'logEntry': 'Connector replaced and tested',
                'maintenanceDate': '2026-05-21',
                'logType': 'Repair',
            },
        )

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        assets_response = self.client.get('/api/assets')
        bulk_asset = next(item for item in assets_response.get_json()['data'] if item['bulkId'] == 'BULK-0001')
        self.assertEqual(bulk_asset['availableQuantity'], 6)
        self.assertEqual(bulk_asset['preparableQuantity'], 6)
        self.assertEqual(bulk_asset['bulkOOCQuantity'], 0)
        self.assertTrue(bulk_asset['bulkMaintenanceLogbook'][0]['isResolved'])
        self.assertEqual(bulk_asset['bulkMaintenanceLogbook'][0]['resolution']['cost'], '0.00')

    def test_bulk_missing_quantity_creates_individual_logs_and_reduces_available(self):
        self.make_event(100)
        self.login_as()

        response = self.client.post('/api/assets/BULK-0001/maintain', json={
            'affectedQuantity': 3,
            'logEntry': 'Three units are missing from the return',
            'maintenanceDate': '2026-05-20',
            'assetStatus': 'missing',
        })

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertEqual(response.get_json()['data']['createdCount'], 3)

        assets_response = self.client.get('/api/assets')
        bulk_asset = next(item for item in assets_response.get_json()['data'] if item['bulkId'] == 'BULK-0001')
        self.assertEqual(bulk_asset['availableQuantity'], 3)
        self.assertEqual(bulk_asset['preparableQuantity'], 3)
        self.assertEqual(bulk_asset['healthyQuantity'], 3)
        self.assertEqual(bulk_asset['bulkMissingQuantity'], 3)
        self.assertEqual(len(bulk_asset['bulkMaintenanceLogbook']), 3)
        self.assertEqual([row['logNumber'] for row in bulk_asset['bulkMaintenanceLogbook']], [1, 2, 3])

        self.login_as('admin', True)
        fault = app_module._bulk_maintenance_fault_entries(self.data_manager.inventory['BULK-0001'])[0]
        response = self.client.put(
            f"/api/assets/BULK-0001/bulk-maintenance/{fault['id']}",
            json={
                'logEntry': 'Unit found, grille is damaged',
                'maintenanceDate': '2026-05-21',
                'assetStatus': 'degraded',
            },
        )

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        assets_response = self.client.get('/api/assets')
        bulk_asset = next(item for item in assets_response.get_json()['data'] if item['bulkId'] == 'BULK-0001')
        self.assertEqual(bulk_asset['availableQuantity'], 4)
        self.assertEqual(bulk_asset['preparableQuantity'], 4)
        self.assertEqual(bulk_asset['healthyQuantity'], 3)
        self.assertEqual(bulk_asset['bulkMissingQuantity'], 2)
        self.assertEqual(bulk_asset['bulkDegradedQuantity'], 1)

    def test_degraded_bulk_quantity_can_prepare_with_warning(self):
        target = self.make_event(
            100,
            prepared=['[MODEL]AX|TestBrand|BulkModel|6|Bulk item'],
        )
        self.login_as()

        for unit_number in range(1, 7):
            response = self.client.post('/api/assets/BULK-0001/maintain', json={
                'logEntry': f'Unit {unit_number} has cosmetic grille damage',
                'maintenanceDate': '2026-05-20',
                'logType': 'Fault',
                'assetStatus': 'degraded',
            })
            self.assertEqual(response.status_code, 200, response.get_data(as_text=True))

        available_response = self.client.get('/api/assets/available-for-event/100')
        available_bulk = next(
            item for item in available_response.get_json()['data']
            if item.get('bulkId') == 'BULK-0001'
        )
        self.assertEqual(available_bulk['availableQuantity'], 6)
        self.assertEqual(available_bulk['preparableQuantity'], 6)
        self.assertEqual(available_bulk['healthyQuantity'], 0)
        self.assertEqual(available_bulk['bulkDegradedQuantity'], 6)

        response = self.client.post(
            '/api/events/100/assign-specific',
            json={'assetId': 'BULK-0001'},
        )

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertIn('warning', response.get_json())
        self.assertIn('not enough fully working', response.get_json()['warning'])
        self.assertIn('6 degraded units', response.get_json()['warning'])
        self.assertIn('Unit 1 has cosmetic grille damage', response.get_json()['warning'])
        self.assertIn(app_module._bulk_marker('BULK-0001', 6), target.actually_prepared)

    def test_bulk_prepare_uses_healthy_quantity_first_without_warning(self):
        target = self.make_event(
            100,
            prepared=['[MODEL]AX|TestBrand|BulkModel|4|Bulk item'],
        )
        self.login_as()

        for unit_number in range(1, 3):
            response = self.client.post('/api/assets/BULK-0001/maintain', json={
                'logEntry': f'Unit {unit_number} has cosmetic grille damage',
                'maintenanceDate': '2026-05-20',
                'assetStatus': 'degraded',
            })
            self.assertEqual(response.status_code, 200, response.get_data(as_text=True))

        response = self.client.post(
            '/api/events/100/assign-specific',
            json={'assetId': 'BULK-0001'},
        )

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertNotIn('warning', response.get_json())
        self.assertEqual(response.get_json()['data']['healthyQuantityUsed'], 4)
        self.assertEqual(response.get_json()['data']['degradedQuantityUsed'], 0)
        self.assertIn(app_module._bulk_marker('BULK-0001', 4), target.actually_prepared)

    def test_inventory_bulk_asset_includes_deployment_breakdown(self):
        returned_marker = app_module._bulk_marker('BULK-0001', 3)
        self.make_event(
            101,
            start='20260521',
            end='20260522',
            actual=[app_module._bulk_marker('BULK-0001', 4)],
        )
        self.make_event(
            102,
            start='20260523',
            end='20260523',
            actual=[app_module._bulk_marker('BULK-0001', 1)],
        )
        self.make_event(
            103,
            actual=[returned_marker],
            returned=[returned_marker],
        )

        self.login_as()
        response = self.client.get('/api/assets')

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        bulk_asset = next(item for item in response.get_json()['data'] if item['bulkId'] == 'BULK-0001')
        self.assertEqual(bulk_asset['status'], 'deployed')
        self.assertEqual(bulk_asset['availableQuantity'], 1)
        self.assertEqual(bulk_asset['deployedQuantity'], 5)

        deployments = bulk_asset['bulkDeployments']
        self.assertEqual([item['eventId'] for item in deployments], [101, 102])
        self.assertEqual([item['quantity'] for item in deployments], [4, 1])
        self.assertEqual(deployments[0]['eventName'], 'Event 101')
        self.assertEqual(deployments[0]['startDate'], '2026/05/21')
        self.assertEqual(deployments[0]['endDate'], '2026/05/22')

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

    def test_degraded_asset_can_prepare_with_warning(self):
        event = self.make_event(
            100,
            prepared=['[MODEL]AX|TestBrand|RegularModel|1|Regular item'],
        )
        asset = self.data_manager.inventory['A#01']
        asset.is_degraded = True
        asset.maintenance_logs.append(app_module.make_maintenance_log(
            '2026/05/20',
            'normal',
            'Intermittent audio dropout on channel A',
            [app_module.make_change('degraded', action='marked')],
            log_type='Fault',
        ))

        self.login_as()
        response = self.client.post('/api/events/100/assign-specific', json={'assetId': 'A#01'})

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertIn('warning', response.get_json())
        self.assertIn('Degraded', response.get_json()['warning'])
        self.assertIn('Intermittent audio dropout on channel A', response.get_json()['warning'])
        self.assertIn('A#01', event.actually_prepared)


if __name__ == '__main__':
    unittest.main()
