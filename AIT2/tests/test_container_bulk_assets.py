import os
import tempfile
import unittest
from unittest.mock import patch

import app as app_module
from data_manager import DataManager
from models import Container, Event, InventoryItem, User, hash_password
from tests.static_source import APP_BUNDLE_SOURCE


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

    def test_inventory_payload_lists_every_container_membership(self):
        first = self.create_container('CASE-01', 4, ['A#01'])
        second = self.create_container('ALL-GEAR', 2, ['A#01'])
        self.assertEqual(first.status_code, 201, first.get_data(as_text=True))
        self.assertEqual(second.status_code, 201, second.get_data(as_text=True))

        response = self.client.get('/api/assets?view=summary')
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        by_id = {
            item['internalId']: item
            for item in response.get_json()['data']
        }
        self.assertEqual(by_id['A#01']['containers'], [
            {'id': 'ALL-GEAR', 'quantity': 1},
            {'id': 'CASE-01', 'quantity': 1},
        ])
        self.assertEqual(by_id['BULK-0001']['containers'], [
            {'id': 'ALL-GEAR', 'quantity': 2},
            {'id': 'CASE-01', 'quantity': 4},
        ])

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
        self.assertEqual(len(event.container_groups), 1)
        group = event.container_groups[0]
        self.assertEqual(group['containerId'], 'PLAN-CASE')
        self.assertEqual(group['quantity'], 1)
        self.assertEqual(group['items'][0]['quantity'], 4)

        detail = self.client.get(
            f'/api/events/{event.event_id}?view=prepare'
        )
        self.assertEqual(detail.status_code, 200, detail.get_data(as_text=True))
        self.assertEqual(
            detail.get_json()['data']['containerGroups'][0]['containerId'],
            'PLAN-CASE',
        )

        reloaded = DataManager(self.tempdir.name)
        reloaded.load_events()
        self.assertEqual(
            reloaded.events[event.event_id].container_groups[0]['containerId'],
            'PLAN-CASE',
        )

    def test_breaking_container_group_keeps_individual_requirements(self):
        self.assertEqual(self.create_container('BREAK-CASE', 3).status_code, 201)
        event = Event(
            event_id=503,
            name='Break Container Event',
            start_date='20260810',
            end_date='20260810',
            asset_models=[],
            prepared_items=[],
            assigned_users=['admin', 'normal'],
        )
        self.data_manager.events[event.event_id] = event
        self.login('admin', True)
        added = self.client.post(
            f'/api/events/{event.event_id}/container-models',
            json={'containerId': 'BREAK-CASE'},
        )
        group_id = added.get_json()['data']['containerGroup']['id']
        linked_document = {
            'type': 'quotation',
            'eventId': event.event_id,
            'eventManagedByQuotation': True,
            'eventSyncFingerprint': app_module._finance_event_asset_fingerprint(event),
        }

        protected = self.client.delete(
            f'/api/events/{event.event_id}/models',
            json={
                'department': 'AX',
                'brand': 'Showbase',
                'model': 'Bulk Cable',
                'description': 'Cable stock',
            },
        )
        self.assertEqual(protected.status_code, 409)
        self.assertIn('Break the container group', protected.get_json()['error'])

        self.login('normal')
        finance_data = {'documents': [linked_document]}
        with (
            patch.object(app_module, '_load_finance_data', return_value=finance_data),
            patch.object(app_module, '_save_finance_data') as save_finance,
        ):
            response = self.client.post(
                f'/api/events/{event.event_id}/container-groups/{group_id}/break',
                json={},
            )

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertEqual(event.container_groups, [])
        marker = app_module._parse_model_marker(event.prepared_items[0])
        self.assertEqual(int(marker['quantity']), 3)
        save_finance.assert_called_once_with(finance_data)
        self.assertFalse(linked_document['eventManagedByQuotation'])
        self.assertEqual(linked_document['eventSyncFingerprint'], '')
        self.assertEqual(event.container_groups, [])

    def test_quotation_container_metadata_round_trips_to_event_group(self):
        document = {
            'subprojects': [{'id': 'main', 'name': 'Main Room'}],
            'lineItems': [
                {
                    'id': 'speaker-line',
                    'groupId': 'container-group',
                    'groupTitle': 'QUOTE-CASE',
                    'isContainerGroup': True,
                    'containerId': 'QUOTE-CASE',
                    'subprojectId': 'main',
                    'department': 'Audio',
                    'departmentCode': 'AX',
                    'brand': 'Showbase',
                    'model': 'Speaker',
                    'description': 'Test speaker',
                    'catalogKey': 'AX|Showbase|Speaker|Test speaker',
                    'quantity': 2,
                    'groupHeaderQuantity': 2,
                    'groupItemQuantity': 3,
                },
            ],
        }

        groups = app_module._finance_event_container_groups(document)
        self.assertEqual(len(groups), 1)
        self.assertEqual(groups[0]['containerId'], 'QUOTE-CASE')
        self.assertEqual(groups[0]['quantity'], 2)
        self.assertEqual(groups[0]['items'][0]['quantity'], 3)

        event = Event(
            event_id=504,
            name='Quotation Container Event',
            start_date='20260810',
            end_date='20260810',
            asset_models=[],
            prepared_items=['[MODEL]AX|Showbase|Speaker|6|Test speaker'],
            assigned_users=['admin'],
            container_groups=groups,
        )
        compared = app_module._finance_compare_event_items(event)
        self.assertEqual(len(compared), 1)
        row = next(iter(compared.values()))
        self.assertEqual(row['identity']['kind'], 'container')
        self.assertEqual(row['quantity'], 2)

        quotation = {'lineItems': [], 'subprojects': [{'id': 'main', 'name': 'Main Room'}]}
        compare_row = {
            'eventItem': app_module._finance_compare_display_item(row),
            'quotationItem': app_module._finance_compare_display_item(None),
        }
        app_module._finance_compare_apply_to_quotation(
            {'priceBook': {}, 'documents': []},
            quotation,
            event,
            compare_row,
            'main',
        )
        self.assertEqual(len(quotation['lineItems']), 1)
        quote_line = quotation['lineItems'][0]
        self.assertTrue(quote_line['isContainerGroup'])
        self.assertEqual(quote_line['containerId'], 'QUOTE-CASE')
        self.assertEqual(quote_line['groupItemQuantity'], 3)
        self.assertEqual(quote_line['groupHeaderQuantity'], 2)

        blank_event = Event(
            event_id=505,
            name='Compare Target Event',
            start_date='20260810',
            end_date='20260810',
            asset_models=[],
            prepared_items=[],
            assigned_users=['admin'],
        )
        rows, _counts, _quote_items, _event_items = app_module._finance_compare_rows(
            blank_event,
            quotation,
        )
        app_module._finance_compare_add_to_event(blank_event, rows[0], 'main')
        self.assertEqual(blank_event.container_groups[0]['containerId'], 'QUOTE-CASE')
        self.assertEqual(blank_event.container_groups[0]['quantity'], 2)
        self.assertEqual(blank_event.subprojects[0]['items'][0]['quantity'], 6)

    def test_compare_container_reduction_preserves_other_legacy_requirements(self):
        event = Event(
            event_id=506,
            name='Legacy Container Compare Event',
            start_date='20260810',
            end_date='20260810',
            asset_models=[],
            prepared_items=[
                '[MODEL]AX|Showbase|Speaker|2|Test speaker',
                '[MODEL]LX|Showbase|Lamp|1|Test lamp',
            ],
            assigned_users=['admin'],
            container_groups=[{
                'id': 'legacy-case',
                'containerId': 'LEGACY-CASE',
                'title': 'LEGACY-CASE',
                'quantity': 1,
                'subprojectId': 'main',
                'items': [{
                    'department': 'AX',
                    'brand': 'Showbase',
                    'model': 'Speaker',
                    'description': 'Test speaker',
                    'quantity': 2,
                }],
            }],
        )

        app_module._finance_compare_set_event_quantity(
            event,
            {'kind': 'container', 'containerId': 'LEGACY-CASE'},
            0,
        )

        self.assertEqual(event.container_groups, [])
        markers = [
            app_module._parse_model_marker(item)
            for item in event.prepared_items
            if app_module._parse_model_marker(item)
        ]
        self.assertEqual(len(markers), 1)
        self.assertEqual(markers[0]['model'], 'Lamp')
        self.assertEqual(int(markers[0]['quantity']), 1)

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
        script = APP_BUNDLE_SOURCE

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
            script.index('function inventoryAssetFlagsPdfHtml')
        ]
        self.assertNotIn('containerBulkItems(container)', inventory_status_counter)
        self.assertIn(
            'const activeContainerQuantity = Math.max(0, item.quantity - returnedFromContainer)',
            script,
        )


if __name__ == '__main__':
    unittest.main()
