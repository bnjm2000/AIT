import tempfile
import unittest
from urllib.parse import quote

import app as app_module
from data_manager import DataManager
from models import Container, Event, InventoryItem, User, hash_password


class AssetUpdateEventPropagationTests(unittest.TestCase):
    def setUp(self):
        self.original_data_manager = app_module.get_default_data_manager()
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

        app_module.app.config['TESTING'] = True
        app_module.set_data_manager_for_testing(self.data_manager)
        app_module.invalidate_cache()
        self.client = app_module.app.test_client()

    def tearDown(self):
        app_module.clear_test_data_manager(self.original_data_manager)
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

    def test_asset_edit_system_log_lists_exact_field_changes(self):
        response = self.put_asset(
            'A#01',
            model='NewModel',
            description='Updated description',
            notes='Keep with receiver rack',
        )

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        action = self.data_manager.logs[-1].action
        self.assertIn('Edited asset inventory: A#01', action)
        self.assertIn('Model: OldModel -> NewModel', action)
        self.assertIn('Description: Old desc -> Updated description', action)
        self.assertIn('Notes: - -> Keep with receiver rack', action)

    def test_asset_edit_warns_before_reusing_serial_in_same_asset_group(self):
        response = self.put_asset('A#02', serial='sn-a#01')

        self.assertEqual(response.status_code, 409, response.get_data(as_text=True))
        body = response.get_json()
        self.assertTrue(body['requiresDuplicateSerialConfirmation'])
        self.assertEqual(body['duplicateSerials'][0]['existingAssetIds'], ['A#01'])
        self.assertEqual(self.data_manager.inventory['A#02'].serial_number, 'SN-A#02')

        confirmed = self.put_asset(
            'A#02',
            serial='sn-a#01',
            confirmDuplicateSerial=True,
        )

        self.assertEqual(confirmed.status_code, 200, confirmed.get_data(as_text=True))
        self.assertEqual(self.data_manager.inventory['A#02'].serial_number, 'sn-a#01')

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

    def test_unassigned_room_requirement_follows_single_asset_rename(self):
        event = self.make_event(
            103,
            prepared=['[MODEL]AX|TestBrand|OldModel|1|Old desc'],
        )
        event.subprojects = [{
            'id': 'main',
            'name': 'Main Room',
            'items': [{
                'lineId': 'quote-line-1',
                'department': 'AX',
                'departmentCode': 'AX',
                'brand': 'TestBrand',
                'model': 'OldModel',
                'description': 'Old desc',
                'quantity': 1,
                'isCustom': False,
                'assetRefs': [],
            }],
            'extraRefs': [],
        }]

        response = self.put_asset(
            'A#01',
            model='NewModel',
            description='New desc',
        )

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        item = event.subprojects[0]['items'][0]
        self.assertEqual(item['lineId'], 'quote-line-1')
        self.assertEqual(item['model'], 'NewModel')
        self.assertEqual(item['description'], 'New desc')
        self.assertEqual(
            event.prepared_items,
            ['[MODEL]AX|TestBrand|NewModel|1|New desc'],
        )

    def test_future_rename_updates_full_quotation_display_room_row(self):
        event = self.make_event(
            111,
            prepared=['[MODEL]AX|TestBrand|OldModel|3|Old desc'],
        )
        event.subprojects = [{
            'id': 'main',
            'name': 'Main Room',
            'items': [{
                'lineId': 'quotation-display-line',
                'department': 'Audio Department',
                'departmentCode': 'AX',
                'brand': 'TestBrand',
                'model': 'OldModel',
                'description': 'TestBrand OldModel Old desc',
                'quantity': 3,
                'isCustom': False,
                'assetRefs': [],
            }],
            'extraRefs': [],
        }]

        response = self.put_asset(
            'A#01',
            model='NewModel',
            description='New desc',
        )

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        item = event.subprojects[0]['items'][0]
        self.assertEqual(item['lineId'], 'quotation-display-line')
        self.assertEqual(item['model'], 'NewModel')
        self.assertEqual(item['description'], 'New desc')
        self.assertEqual(item['quantity'], 3)
        self.assertEqual(
            event.prepared_items,
            ['[MODEL]AX|TestBrand|NewModel|3|New desc'],
        )

    def test_assigned_room_requirement_splits_when_one_asset_is_renamed(self):
        event = self.make_event(
            104,
            prepared=['[MODEL]AX|TestBrand|OldModel|2|Old desc'],
            actual=['A#01'],
        )
        event.subprojects = [{
            'id': 'main',
            'name': 'Main Room',
            'items': [{
                'lineId': 'quote-line-1',
                'department': 'AX',
                'departmentCode': 'AX',
                'brand': 'TestBrand',
                'model': 'OldModel',
                'description': 'Old desc',
                'quantity': 2,
                'isCustom': False,
                'assetRefs': ['A#01'],
            }],
            'extraRefs': [],
        }]

        response = self.put_asset(
            'A#01',
            model='NewModel',
            description='New desc',
        )

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        old_items = app_module._event_subproject_group_items(
            event.subprojects[0],
            {'department': 'AX', 'brand': 'TestBrand', 'model': 'OldModel', 'description': 'Old desc'},
        )
        new_items = app_module._event_subproject_group_items(
            event.subprojects[0],
            {'department': 'AX', 'brand': 'TestBrand', 'model': 'NewModel', 'description': 'New desc'},
        )
        self.assertEqual(old_items[0]['quantity'], 1)
        self.assertEqual(new_items[0]['quantity'], 1)
        self.assertEqual(new_items[0]['assetRefs'], ['A#01'])
        self.assertCountEqual(
            event.prepared_items,
            [
                '[MODEL]AX|TestBrand|OldModel|1|Old desc',
                '[MODEL]AX|TestBrand|NewModel|1|New desc',
            ],
        )

    def test_all_similar_description_rename_keeps_prepared_room_asset_linked(self):
        event = self.make_event(
            105,
            prepared=['[MODEL]AX|TestBrand|OldModel|2|Old desc'],
            actual=['A#01', 'A#02'],
        )
        event.subprojects = [{
            'id': 'main',
            'name': 'Main Room',
            'items': [{
                'lineId': 'quote-line-1',
                'department': 'AX',
                'departmentCode': 'AX',
                'brand': 'TestBrand',
                'model': 'OldModel',
                'description': 'Old desc',
                'quantity': 2,
                'isCustom': False,
                'assetRefs': ['A#01', 'A#02'],
            }],
            'extraRefs': [],
        }]

        response = self.put_asset(
            'A#01',
            description='New desc',
            applyTo='allSimilar',
        )

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        item = event.subprojects[0]['items'][0]
        self.assertEqual(item['description'], 'New desc')
        self.assertEqual(item['quantity'], 2)
        self.assertCountEqual(item['assetRefs'], ['A#01', 'A#02'])
        self.assertEqual(
            event.prepared_items,
            ['[MODEL]AX|TestBrand|OldModel|2|New desc'],
        )

    def test_all_similar_rename_preserves_other_description_variant_event_links(self):
        self.data_manager.inventory['A#02'].description = 'Legacy capitalisation'
        event = self.make_event(
            106,
            prepared=['[MODEL]AX|TestBrand|OldModel|1|Legacy capitalisation'],
            actual=['A#02'],
        )
        event.subprojects = [{
            'id': 'main',
            'name': 'Main Room',
            'items': [{
                'lineId': 'quote-line-legacy',
                'department': 'AX',
                'departmentCode': 'AX',
                'brand': 'TestBrand',
                'model': 'OldModel',
                'description': 'Legacy capitalisation',
                'quantity': 1,
                'isCustom': False,
                'assetRefs': ['A#02'],
            }],
            'extraRefs': [],
        }]

        response = self.put_asset(
            'A#01',
            description='Canonical description',
            applyTo='allSimilar',
        )

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        item = event.subprojects[0]['items'][0]
        self.assertEqual(item['description'], 'Legacy capitalisation')
        self.assertEqual(item['assetRefs'], ['A#02'])
        self.assertEqual(
            event.prepared_items,
            ['[MODEL]AX|TestBrand|OldModel|1|Legacy capitalisation'],
        )

    def test_integrity_repair_uses_prepared_id_when_room_asset_refs_are_legacy_missing(self):
        asset = self.data_manager.inventory['A#01']
        asset.description = 'New desc'
        asset.change_history = [{
            'date': '2026-08-13T10:00:00',
            'user': 'admin',
            'action': 'updated',
            'changes': [{
                'field': 'description',
                'label': 'Description',
                'old': 'Old desc',
                'new': 'New desc',
            }],
        }]
        event = self.make_event(
            107,
            prepared=['[MODEL]AX|TestBrand|OldModel|1|Old desc'],
            actual=['A#01'],
        )
        event.subprojects = [{
            'id': 'main',
            'name': 'Main Room',
            'items': [{
                'lineId': 'quote-line-legacy',
                'department': 'AX',
                'departmentCode': 'AX',
                'brand': 'TestBrand',
                'model': 'OldModel',
                'description': 'Old desc',
                'quantity': 1,
                'isCustom': False,
                'assetRefs': [],
            }],
            'extraRefs': [],
        }]

        changes = app_module._repair_prepared_event_asset_group_links(
            event,
            self.data_manager.inventory,
        )

        self.assertGreater(changes, 0)
        item = event.subprojects[0]['items'][0]
        self.assertEqual(item['description'], 'New desc')
        self.assertEqual(
            event.prepared_items,
            ['[MODEL]AX|TestBrand|OldModel|1|New desc'],
        )

    def test_integrity_repair_updates_unassigned_historical_room_group(self):
        asset = self.data_manager.inventory['A#01']
        asset.description = 'new canonical description'
        asset.change_history = [{
            'date': '2026-08-13T10:00:00',
            'user': 'admin',
            'action': 'updated',
            'changes': [{
                'field': 'description',
                'label': 'Description',
                'old': 'Legacy Description',
                'new': 'new canonical description',
            }],
        }]
        event = self.make_event(
            108,
            prepared=['[MODEL]AX|TestBrand|OldModel|2|Legacy Description'],
        )
        event.subprojects = [{
            'id': 'main',
            'name': 'Main Room',
            'items': [{
                'lineId': 'legacy-unassigned-line',
                'departmentCode': 'AX',
                'brand': 'TestBrand',
                'model': 'OldModel',
                'description': 'TestBrand OldModel Legacy Description',
                'quantity': 2,
                'preparedQuantity': 0,
                'assetRefs': [],
            }],
            'extraRefs': [],
        }]

        changes = app_module._repair_prepared_event_asset_group_links(
            event,
            self.data_manager.inventory,
        )

        self.assertGreater(changes, 0)
        item = event.subprojects[0]['items'][0]
        self.assertEqual(item['description'], 'new canonical description')
        self.assertEqual(item['quantity'], 2)
        self.assertEqual(item['assetRefs'], [])
        self.assertEqual(
            event.prepared_items,
            ['[MODEL]AX|TestBrand|OldModel|2|new canonical description'],
        )

    def test_integrity_repair_resyncs_stale_marker_from_current_room_group(self):
        self.data_manager.inventory['A#01'].change_history = [{
            'date': '2026-08-13T10:00:00',
            'user': 'admin',
            'action': 'updated',
            'changes': [{
                'field': 'description',
                'label': 'Description',
                'old': 'Legacy casing',
                'new': 'Old desc',
            }],
        }]
        event = self.make_event(
            109,
            prepared=['[MODEL]AX|TestBrand|OldModel|1|Legacy casing'],
        )
        event.subprojects = [{
            'id': 'main',
            'name': 'Main Room',
            'items': [{
                'lineId': 'current-room-line',
                'departmentCode': 'AX',
                'brand': 'TestBrand',
                'model': 'OldModel',
                'description': 'Old desc',
                'quantity': 1,
                'preparedQuantity': 0,
                'assetRefs': [],
            }],
            'extraRefs': [],
        }]

        changes = app_module._repair_prepared_event_asset_group_links(
            event,
            self.data_manager.inventory,
        )

        self.assertGreater(changes, 0)
        self.assertEqual(
            event.prepared_items,
            ['[MODEL]AX|TestBrand|OldModel|1|Old desc'],
        )

    def test_historical_label_repair_preserves_event_level_spare_quantity(self):
        asset = self.data_manager.inventory['A#01']
        asset.description = 'New desc'
        asset.change_history = [{
            'date': '2026-08-13T10:00:00',
            'user': 'admin',
            'action': 'updated',
            'changes': [{
                'field': 'description',
                'label': 'Description',
                'old': 'Legacy desc',
                'new': 'New desc',
            }],
        }]
        event = self.make_event(
            110,
            prepared=['[MODEL]AX|TestBrand|OldModel|2|Legacy desc'],
        )
        event.subprojects = [{
            'id': 'main',
            'name': 'Main Room',
            'items': [{
                'lineId': 'legacy-line-with-event-spare',
                'departmentCode': 'AX',
                'brand': 'TestBrand',
                'model': 'OldModel',
                'description': 'TestBrand OldModel Legacy desc',
                'quantity': 1,
                'preparedQuantity': 0,
                'assetRefs': [],
            }],
            'extraRefs': [],
        }]

        changes = app_module._repair_prepared_event_asset_group_links(
            event,
            self.data_manager.inventory,
        )

        self.assertGreater(changes, 0)
        self.assertEqual(event.subprojects[0]['items'][0]['quantity'], 1)
        self.assertEqual(
            event.prepared_items,
            ['[MODEL]AX|TestBrand|OldModel|2|New desc'],
        )

    def test_rename_repair_promotes_matching_spare_into_plan_requirement(self):
        asset = self.data_manager.inventory['A#01']
        asset.description = 'New desc'
        asset.change_history = [{
            'date': '2026-08-13T10:00:00',
            'user': 'admin',
            'action': 'updated',
            'changes': [{
                'field': 'description',
                'label': 'Description',
                'old': 'Legacy desc',
                'new': 'New desc',
            }],
        }]
        event = self.make_event(
            112,
            prepared=[
                '[MODEL]AX|TestBrand|OldModel|1|Legacy desc',
                'A#01',
            ],
            actual=['A#01'],
            extra=['A#01'],
        )
        event.subprojects = [{
            'id': 'main',
            'name': 'Main Room',
            'items': [{
                'lineId': 'legacy-required-line',
                'departmentCode': 'AX',
                'brand': 'TestBrand',
                'model': 'OldModel',
                'description': 'Legacy desc',
                'quantity': 1,
                'preparedQuantity': 0,
                'assetRefs': [],
            }],
            'extraRefs': ['A#01'],
        }]

        changes = app_module._repair_prepared_event_asset_group_links(
            event,
            self.data_manager.inventory,
        )

        self.assertGreater(changes, 0)
        item = event.subprojects[0]['items'][0]
        self.assertEqual(item['description'], 'New desc')
        self.assertEqual(item['assetRefs'], ['A#01'])
        self.assertEqual(event.subprojects[0]['extraRefs'], [])
        self.assertEqual(event.extra_assets, [])
        self.assertEqual(event.actually_prepared, ['A#01'])
        self.assertEqual(
            event.prepared_items,
            ['[MODEL]AX|TestBrand|OldModel|1|New desc'],
        )

    def test_future_inventory_rename_promotes_matching_prepared_spare(self):
        event = self.make_event(
            113,
            prepared=[
                '[MODEL]AX|TestBrand|OldModel|1|Old desc',
                'A#01',
            ],
            actual=['A#01'],
            extra=['A#01'],
        )
        event.subprojects = [{
            'id': 'main',
            'name': 'Main Room',
            'items': [{
                'lineId': 'required-line-before-rename',
                'departmentCode': 'AX',
                'brand': 'TestBrand',
                'model': 'OldModel',
                'description': 'Old desc',
                'quantity': 1,
                'preparedQuantity': 0,
                'assetRefs': [],
            }],
            'extraRefs': ['A#01'],
        }]

        response = self.put_asset('A#01', description='New desc')

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        current_items = app_module._event_subproject_group_items(
            event.subprojects[0],
            {
                'department': 'AX',
                'brand': 'TestBrand',
                'model': 'OldModel',
                'description': 'New desc',
            },
        )
        self.assertEqual(len(current_items), 1)
        self.assertEqual(current_items[0]['assetRefs'], ['A#01'])
        self.assertEqual(event.subprojects[0]['extraRefs'], [])
        self.assertEqual(event.extra_assets, [])
        self.assertEqual(event.actually_prepared, ['A#01'])
        self.assertEqual(
            event.prepared_items,
            ['[MODEL]AX|TestBrand|OldModel|1|New desc'],
        )

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

    def test_all_similar_asset_detail_change_updates_linked_quotation_lines(self):
        old_key = app_module._finance_catalog_key('AX', 'TestBrand', 'OldModel', 'Old desc')
        finance_document = {
            'id': 'quote-asset-rename',
            'type': 'quotation',
            'number': 'QT-2026-001-01',
            'baseSequence': 1,
            'revision': 1,
            'status': 'draft',
            'createdBy': 'admin',
            'updatedBy': 'admin',
            'projectName': 'Rename Quote',
            'title': 'Rename Quote',
            'lineItems': [{
                'id': 'line-1',
                'catalogKey': old_key,
                'sourceAssetIds': ['A#01', 'A#02'],
                'brand': 'TestBrand',
                'model': 'OldModel',
                'description': 'TestBrand OldModel Old desc',
                'department': 'Audio Department',
                'departmentCode': 'AX',
                'days': 1,
                'quantity': 2,
                'uom': 'units',
                'unitPrice': 100,
                'discountPercent': 0,
                'total': 200,
                'isCustom': False,
            }],
            'adjustments': [],
            'departments': ['Audio Department'],
        }
        app_module._save_finance_data({
            'version': app_module.FINANCE_VERSION,
            'documents': [finance_document],
            'priceBook': {
                f'admin::{old_key}': {
                    'description': 'TestBrand OldModel Old desc',
                    'unitPrice': 100,
                    'department': 'Audio Department',
                    'uom': 'units',
                    'owner': 'admin',
                },
            },
        })

        response = self.put_asset(
            'A#01',
            model='NewModel',
            description='New desc',
            applyTo='allSimilar',
        )

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertTrue(response.get_json()['data']['financeDocumentsUpdated'])
        stored = app_module._load_finance_data()['documents'][0]
        line = stored['lineItems'][0]
        self.assertEqual(line['model'], 'NewModel')
        self.assertEqual(line['description'], 'TestBrand NewModel New desc')
        self.assertEqual(line['sourceAssetIds'], ['A#01', 'A#02'])
        new_key = app_module._finance_catalog_key('AX', 'TestBrand', 'NewModel', 'New desc')
        self.assertEqual(line['catalogKey'], new_key)
        self.assertIn(f'admin::{new_key}', app_module._load_finance_data()['priceBook'])

    def test_asset_rename_only_updates_live_draft_quotation_content(self):
        old_key = app_module._finance_catalog_key(
            'AX', 'TestBrand', 'OldModel', 'Old desc',
        )

        def quotation_line(line_id):
            return {
                'id': line_id,
                'catalogKey': old_key,
                'sourceAssetIds': ['A#01', 'A#02'],
                'brand': 'TestBrand',
                'model': 'OldModel',
                'description': 'TestBrand OldModel Old desc',
                'department': 'Audio Department',
                'departmentCode': 'AX',
                'days': 1,
                'quantity': 2,
                'uom': 'units',
                'unitPrice': 100,
                'discountPercent': 0,
                'total': 200,
                'isCustom': False,
            }

        protected_statuses = (
            'sent', 'accepted', 'expired', 'cancelled',
            'invoiced', 'overdue', 'paid',
        )
        documents = [
            {
                'id': 'draft-quotation',
                'type': 'quotation',
                'number': 'QT-2026-001-02',
                'status': 'draft',
                'lineItems': [quotation_line('draft-current')],
                'adjustments': [],
                'revisions': [{
                    'revision': 1,
                    'status': 'sent',
                    'snapshot': {
                        'lineItems': [quotation_line('draft-snapshot')],
                    },
                }],
            },
            *[{
                'id': f'{status}-quotation',
                'type': 'quotation',
                'number': f'QT-2026-{index:03d}-01',
                'status': status,
                'lineItems': [quotation_line(f'{status}-current')],
                'adjustments': [],
                'revisions': [{
                    'revision': 1,
                    'status': status,
                    'snapshot': {
                        'lineItems': [quotation_line(f'{status}-snapshot')],
                    },
                }],
            } for index, status in enumerate(protected_statuses, start=2)],
            {
                'id': 'draft-invoice',
                'type': 'invoice',
                'number': 'INV-2026-0001',
                'status': 'draft',
                'lineItems': [quotation_line('invoice-current')],
                'adjustments': [],
            },
        ]
        app_module._save_finance_data({
            'version': app_module.FINANCE_VERSION,
            'documents': documents,
            'priceBook': {},
        })

        response = self.put_asset(
            'A#01',
            model='NewModel',
            description='New desc',
            applyTo='allSimilar',
        )

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        stored = {
            row['id']: row
            for row in app_module._load_finance_data()['documents']
        }
        self.assertEqual(
            stored['draft-quotation']['lineItems'][0]['model'],
            'NewModel',
        )
        self.assertEqual(
            stored['draft-quotation']['revisions'][0]['snapshot']['lineItems'][0]['model'],
            'OldModel',
        )
        for status in protected_statuses:
            protected = stored[f'{status}-quotation']
            self.assertEqual(protected['lineItems'][0]['model'], 'OldModel')
            self.assertEqual(
                protected['revisions'][0]['snapshot']['lineItems'][0]['model'],
                'OldModel',
            )
        self.assertEqual(
            stored['draft-invoice']['lineItems'][0]['model'],
            'OldModel',
        )

    def test_asset_rename_preserves_manually_edited_draft_quotation_name(self):
        old_key = app_module._finance_catalog_key(
            'AX', 'TestBrand', 'OldModel', 'Old desc',
        )
        app_module._save_finance_data({
            'version': app_module.FINANCE_VERSION,
            'documents': [{
                'id': 'draft-custom-name',
                'type': 'quotation',
                'number': 'QT-2026-099-01',
                'status': 'draft',
                'lineItems': [{
                    'id': 'custom-name-line',
                    'catalogKey': old_key,
                    'sourceAssetIds': ['A#01'],
                    'brand': 'TestBrand',
                    'model': 'OldModel',
                    'description': 'Client-facing custom package name',
                    'department': 'Audio Department',
                    'departmentCode': 'AX',
                    'days': 1,
                    'quantity': 1,
                    'uom': 'units',
                    'unitPrice': 100,
                    'discountPercent': 0,
                    'total': 100,
                    'isCustom': False,
                }],
                'adjustments': [],
            }],
            'priceBook': {},
        })

        response = self.put_asset(
            'A#01',
            model='NewModel',
            description='New desc',
            applyTo='allSimilar',
        )

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        line = app_module._load_finance_data()['documents'][0]['lineItems'][0]
        self.assertEqual(line['model'], 'NewModel')
        self.assertEqual(line['description'], 'Client-facing custom package name')
        self.assertEqual(line['inventoryNameMode'], 'custom')

    def test_single_asset_model_group_rename_updates_only_draft_content(self):
        del self.data_manager.inventory['A#02']
        self.data_manager.save_inventory(drop_asset_ids=['A#02'])
        old_key = app_module._finance_catalog_key(
            'AX', 'TestBrand', 'OldModel', 'Old desc',
        )

        def quotation_line(line_id):
            return {
                'id': line_id,
                'catalogKey': old_key,
                'sourceAssetIds': ['A#01'],
                'brand': 'TestBrand',
                'model': 'OldModel',
                'description': 'TestBrand OldModel Old desc',
                'department': 'Audio Department',
                'departmentCode': 'AX',
                'days': 1,
                'quantity': 1,
                'uom': 'units',
                'unitPrice': 100,
                'discountPercent': 0,
                'total': 100,
                'isCustom': False,
            }

        documents = [
            {
                'id': 'single-group-draft',
                'type': 'quotation',
                'number': 'QT-2026-010-02',
                'status': 'draft',
                'lineItems': [quotation_line('draft-current')],
                'adjustments': [],
                'revisions': [{
                    'revision': 1,
                    'status': 'sent',
                    'snapshot': {
                        'lineItems': [quotation_line('draft-snapshot')],
                    },
                }],
            },
            {
                'id': 'single-group-sent',
                'type': 'quotation',
                'number': 'QT-2026-011-01',
                'status': 'sent',
                'lineItems': [quotation_line('sent-current')],
                'adjustments': [],
                'revisions': [{
                    'revision': 1,
                    'status': 'sent',
                    'snapshot': {
                        'lineItems': [quotation_line('sent-snapshot')],
                    },
                }],
            },
        ]
        app_module._save_finance_data({
            'version': app_module.FINANCE_VERSION,
            'documents': documents,
            'priceBook': {},
        })

        response = self.put_asset(
            'A#01',
            model='NewModel',
            description='New desc',
        )

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertTrue(response.get_json()['data']['financeDocumentsUpdated'])
        stored = {
            row['id']: row
            for row in app_module._load_finance_data()['documents']
        }
        draft = stored['single-group-draft']
        self.assertEqual(draft['lineItems'][0]['model'], 'NewModel')
        self.assertEqual(
            draft['lineItems'][0]['description'],
            'TestBrand NewModel New desc',
        )
        self.assertEqual(
            draft['revisions'][0]['snapshot']['lineItems'][0]['model'],
            'OldModel',
        )
        sent = stored['single-group-sent']
        self.assertEqual(sent['lineItems'][0]['model'], 'OldModel')
        self.assertEqual(
            sent['revisions'][0]['snapshot']['lineItems'][0]['model'],
            'OldModel',
        )

    def test_asset_model_group_merge_requires_explicit_confirmation(self):
        self.data_manager.inventory['DEST#01'] = self.make_asset(
            'DEST#01',
            model='DestinationModel',
            description='Destination description',
        )

        response = self.put_asset(
            'A#01',
            model='DestinationModel',
            description='Destination description',
            applyTo='allSimilar',
        )

        self.assertEqual(response.status_code, 409, response.get_data(as_text=True))
        body = response.get_json()
        self.assertTrue(body['requiresModelGroupMergeConfirmation'])
        self.assertEqual(body['mergeDetails']['sourceCount'], 2)
        self.assertEqual(body['mergeDetails']['existingCount'], 1)
        self.assertEqual(self.data_manager.inventory['A#01'].model_number, 'OldModel')
        self.assertEqual(self.data_manager.inventory['A#02'].model_number, 'OldModel')

    def test_asset_model_group_merge_proceeds_after_confirmation(self):
        self.data_manager.inventory['DEST#01'] = self.make_asset(
            'DEST#01',
            model='DestinationModel',
            description='Destination description',
        )

        response = self.put_asset(
            'A#01',
            model='DestinationModel',
            description='Destination description',
            applyTo='allSimilar',
            confirmModelGroupMerge=True,
        )

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertEqual(self.data_manager.inventory['A#01'].model_number, 'DestinationModel')
        self.assertEqual(self.data_manager.inventory['A#02'].model_number, 'DestinationModel')
        self.assertEqual(self.data_manager.inventory['DEST#01'].model_number, 'DestinationModel')

    def test_description_only_change_does_not_require_group_merge_confirmation(self):
        response = self.put_asset(
            'A#01',
            description='Updated description',
            applyTo='single',
        )

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertEqual(self.data_manager.inventory['A#01'].description, 'Updated description')

    def test_all_similar_update_excludes_same_model_with_different_description(self):
        self.data_manager.inventory['A#02'].description = 'Different desc'
        self.data_manager.save_inventory()

        response = self.put_asset(
            'A#01',
            model='NewModel',
            description='Updated description',
            applyTo='allSimilar',
        )

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertEqual(self.data_manager.inventory['A#01'].model_number, 'NewModel')
        self.assertEqual(self.data_manager.inventory['A#01'].description, 'Updated description')
        self.assertEqual(self.data_manager.inventory['A#02'].model_number, 'OldModel')
        self.assertEqual(self.data_manager.inventory['A#02'].description, 'Different desc')

    def test_regular_asset_id_change_uses_edited_id_and_updates_event_references(self):
        asset = self.data_manager.inventory['A#01']
        asset.change_history = [{
            'date': '2026-05-01T09:00:00',
            'user': 'admin',
            'action': 'created',
            'changes': [{
                'field': 'asset_id',
                'label': 'Asset ID',
                'old': '',
                'new': 'A#01',
            }],
        }]
        asset.maintenance_logs = [app_module.make_maintenance_log(
            '2026/05/02',
            'admin',
            'Inspected before deployment',
            log_id='maintenance-before-rename',
        )]
        self.data_manager.save_inventory()
        self.data_manager.containers = {
            'CASE-1': Container('CASE-1', ['A#01']),
        }
        self.data_manager.save_containers()
        event = self.make_event(
            300,
            prepared=['A#01'],
            actual=['A#01'],
            returned=['A#01'],
            extra=['A#01'],
        )
        event.subprojects = [{
            'id': 'main',
            'name': 'Main Room',
            'items': [{
                'departmentCode': 'AX',
                'brand': 'TestBrand',
                'model': 'OldModel',
                'description': 'Old desc',
                'quantity': 1,
                'assetRefs': ['A#01'],
            }],
            'extraRefs': ['A#01'],
        }]

        response = self.put_asset('A#01', id='A#99', internalId='A#01')

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertNotIn('A#01', self.data_manager.inventory)
        self.assertIn('A#99', self.data_manager.inventory)
        self.assertEqual(event.prepared_items, ['A#99'])
        self.assertEqual(event.actually_prepared, ['A#99'])
        self.assertEqual(event.returned_items, ['A#99'])
        self.assertEqual(event.extra_assets, ['A#99'])
        self.assertEqual(event.subprojects[0]['items'][0]['assetRefs'], ['A#99'])
        self.assertEqual(event.subprojects[0]['extraRefs'], ['A#99'])
        self.assertEqual(self.data_manager.containers['CASE-1'].asset_ids, ['A#99'])

        renamed = self.data_manager.inventory['A#99']
        self.assertEqual(
            renamed.maintenance_logs[0]['id'],
            'maintenance-before-rename',
        )
        self.assertEqual(len(renamed.change_history), 2)
        rename_changes = {
            change['field']: change
            for change in renamed.change_history[-1]['changes']
        }
        self.assertEqual(rename_changes['asset_id']['old'], 'A#01')
        self.assertEqual(rename_changes['asset_id']['new'], 'A#99')

        history_response = self.client.get('/api/assets/A%2399/event-history')
        self.assertEqual(
            history_response.status_code,
            200,
            history_response.get_data(as_text=True),
        )
        self.assertEqual(history_response.get_json()['data'][0]['id'], 300)

        reloaded = DataManager(self.tempdir.name)
        reloaded.load_inventory()
        reloaded.load_events()
        reloaded.load_containers()
        self.assertNotIn('A#01', reloaded.inventory)
        self.assertEqual(
            reloaded.inventory['A#99'].maintenance_logs[0]['id'],
            'maintenance-before-rename',
        )
        self.assertEqual(len(reloaded.inventory['A#99'].change_history), 2)
        self.assertEqual(reloaded.events[300].actually_prepared, ['A#99'])
        self.assertEqual(reloaded.containers['CASE-1'].asset_ids, ['A#99'])

    def test_future_asset_id_rename_repairs_retired_id_references(self):
        asset = self.data_manager.inventory.pop('A#01')
        asset.asset_id = 'A#10'
        asset.change_history = [{
            'date': '2026-05-01T09:00:00',
            'user': 'admin',
            'action': 'updated',
            'changes': [{
                'field': 'asset_id',
                'label': 'Asset ID',
                'old': 'A#01',
                'new': 'A#10',
            }],
        }]
        self.data_manager.inventory['A#10'] = asset
        self.data_manager.save_inventory(drop_asset_ids=['A#01'])
        self.data_manager.containers = {
            'CASE-LEGACY': Container('CASE-LEGACY', ['A#01']),
        }
        self.data_manager.save_containers()
        event = self.make_event(
            301,
            prepared=['A#01'],
            actual=['A#01'],
            returned=['A#01'],
        )
        event.subprojects = [{
            'id': 'main',
            'name': 'Main Room',
            'items': [{
                'departmentCode': 'AX',
                'brand': 'TestBrand',
                'model': 'OldModel',
                'description': 'Old desc',
                'quantity': 1,
                'assetRefs': ['A#01'],
            }],
            'extraRefs': ['A#01'],
        }]

        response = self.put_asset('A#10', id='A#11', internalId='A#10')

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertEqual(event.prepared_items, ['A#11'])
        self.assertEqual(event.actually_prepared, ['A#11'])
        self.assertEqual(event.returned_items, ['A#11'])
        self.assertEqual(event.subprojects[0]['items'][0]['assetRefs'], ['A#11'])
        self.assertEqual(event.subprojects[0]['extraRefs'], ['A#11'])
        self.assertEqual(
            self.data_manager.containers['CASE-LEGACY'].asset_ids,
            ['A#11'],
        )

    def test_bulk_asset_id_change_updates_bulk_event_markers(self):
        marker = app_module._bulk_marker('BULK-0001', 2)
        bulk_asset = self.data_manager.inventory['BULK-0001']
        bulk_asset.maintenance_logs = [app_module.make_maintenance_log(
            '2026/05/03',
            'admin',
            'Bulk cable inspection',
            log_id='bulk-maintenance-before-rename',
        )]
        self.data_manager.save_inventory()
        self.data_manager.containers = {
            'CABLE-CASE': Container(
                'CABLE-CASE',
                [],
                bulk_items={'BULK-0001': 2},
            ),
        }
        self.data_manager.save_containers()
        event = self.make_event(
            400,
            prepared=[marker],
            actual=[marker],
            returned=[marker],
            extra=[marker],
        )
        event.subprojects = [{
            'id': 'main',
            'name': 'Main Room',
            'items': [{
                'departmentCode': 'AX',
                'brand': 'TestBrand',
                'model': 'BulkModel',
                'description': 'Bulk item',
                'quantity': 2,
                'assetRefs': [marker],
            }],
            'extraRefs': [marker],
        }]

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
        self.assertEqual(event.subprojects[0]['items'][0]['assetRefs'], [new_marker])
        self.assertEqual(event.subprojects[0]['extraRefs'], [new_marker])
        self.assertEqual(
            self.data_manager.containers['CABLE-CASE'].bulk_items,
            {'BULK-0099': 2},
        )
        self.assertEqual(
            self.data_manager.inventory['BULK-0099'].maintenance_logs[0]['id'],
            'bulk-maintenance-before-rename',
        )

    def test_bulk_renumber_handles_overlapping_ids_and_updates_references(self):
        for asset_id in ('A#01', 'A#02'):
            self.data_manager.inventory[asset_id].maintenance_logs = [
                app_module.make_maintenance_log(
                    '2026/05/04',
                    'admin',
                    f'Inspection for {asset_id}',
                    log_id=f'log-{asset_id}',
                )
            ]
        self.data_manager.save_inventory()
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
        event.subprojects = [{
            'id': 'main',
            'name': 'Main Room',
            'items': [{
                'departmentCode': 'AX',
                'brand': 'TestBrand',
                'model': 'OldModel',
                'description': 'Old desc',
                'quantity': 2,
                'assetRefs': ['A#01', 'A#02'],
            }],
            'extraRefs': [],
        }]
        catalog_key = app_module._finance_catalog_key(
            'AX', 'TestBrand', 'OldModel', 'Old desc',
        )
        app_module._save_finance_data({
            'version': app_module.FINANCE_VERSION,
            'documents': [{
                'id': 'renumber-draft',
                'type': 'quotation',
                'number': 'QT-2026-450-01',
                'status': 'draft',
                'lineItems': [{
                    'id': 'line-1',
                    'catalogKey': catalog_key,
                    'sourceAssetIds': ['A#01', 'A#02'],
                    'brand': 'TestBrand',
                    'model': 'OldModel',
                    'description': 'TestBrand OldModel Old desc',
                    'department': 'Audio Department',
                    'departmentCode': 'AX',
                    'quantity': 2,
                    'days': 1,
                    'unitPrice': 100,
                    'total': 200,
                    'isCustom': False,
                }],
                'adjustments': [],
            }],
            'priceBook': {
                f'admin::{catalog_key}::asset:a#01': {'unitPrice': 100},
                f'admin::{catalog_key}::asset:a#02': {'unitPrice': 200},
            },
        })
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
            event.subprojects[0]['items'][0]['assetRefs'],
            ['A#02', 'A#03'],
        )
        self.assertEqual(
            self.data_manager.containers['CASE-1'].asset_ids,
            ['A#02', 'A#03'],
        )
        self.assertTrue(body['financeDocumentsUpdated'])
        finance_data = app_module._load_finance_data()
        self.assertEqual(
            finance_data['documents'][0]['lineItems'][0]['sourceAssetIds'],
            ['A#02', 'A#03'],
        )
        self.assertNotIn(
            f'admin::{catalog_key}::asset:a#01',
            finance_data['priceBook'],
        )
        self.assertIn(
            f'admin::{catalog_key}::asset:a#02',
            finance_data['priceBook'],
        )
        self.assertIn(
            f'admin::{catalog_key}::asset:a#03',
            finance_data['priceBook'],
        )
        self.assertEqual(
            self.data_manager.inventory['A#02'].maintenance_logs[0]['id'],
            'log-A#01',
        )
        self.assertEqual(
            self.data_manager.inventory['A#03'].maintenance_logs[0]['id'],
            'log-A#02',
        )

        reloaded = DataManager(self.tempdir.name)
        reloaded.load_inventory()
        self.assertNotIn('A#01', reloaded.inventory)
        self.assertIn('A#02', reloaded.inventory)
        self.assertIn('A#03', reloaded.inventory)
        self.assertEqual(reloaded.inventory['A#02'].maintenance_logs[0]['id'], 'log-A#01')
        self.assertEqual(reloaded.inventory['A#03'].maintenance_logs[0]['id'], 'log-A#02')
        self.assertEqual(
            reloaded.inventory['A#02'].change_history[-1]['changes'][0]['old'],
            'A#01',
        )
        self.assertEqual(
            reloaded.inventory['A#03'].change_history[-1]['changes'][0]['old'],
            'A#02',
        )

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

    def test_asset_update_saves_and_audits_tags(self):
        response = self.put_asset('A#01', tags=['RF', 'spare', 'rf'])

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        asset = self.data_manager.inventory['A#01']
        self.assertEqual(asset.tags, ['RF', 'spare'])

        reloaded = DataManager(self.tempdir.name)
        reloaded.load_inventory()
        self.assertEqual(reloaded.inventory['A#01'].tags, ['RF', 'spare'])

        changes = {change['field']: change for change in asset.change_history[0]['changes']}
        self.assertIn('tags', changes)
        self.assertEqual(changes['tags']['old'], '[]')
        self.assertEqual(changes['tags']['new'], "['RF', 'spare']")

        assets_response = self.client.get('/api/assets')
        asset_payload = next(item for item in assets_response.get_json()['data'] if item['internalId'] == 'A#01')
        self.assertEqual(asset_payload['tags'], ['RF', 'spare'])

    def test_asset_update_can_add_new_tags_to_all_matching_models(self):
        self.data_manager.inventory['A#01'].tags = ['selected-only']
        self.data_manager.inventory['A#02'].tags = ['keep-me']
        self.data_manager.save_inventory()

        response = self.put_asset(
            'A#01',
            tags=['selected-only', 'Wireless'],
            tagsToApplyToSimilar=['Wireless'],
        )

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertEqual(response.get_json()['data']['taggedAssets'], 2)
        self.assertEqual(self.data_manager.inventory['A#01'].tags, ['selected-only', 'Wireless'])
        self.assertEqual(self.data_manager.inventory['A#02'].tags, ['keep-me', 'Wireless'])
        self.assertTrue(any(
            change.get('field') == 'tags'
            for change in self.data_manager.inventory['A#02'].change_history[-1]['changes']
        ))

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

    def test_asset_update_saves_and_audits_second_serial(self):
        response = self.put_asset('A#01', serial2='SN-SECONDARY')

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        asset = self.data_manager.inventory['A#01']
        self.assertEqual(asset.secondary_serial_number, 'SN-SECONDARY')

        reloaded = DataManager(self.tempdir.name)
        reloaded.load_inventory()
        self.assertEqual(
            reloaded.inventory['A#01'].secondary_serial_number,
            'SN-SECONDARY',
        )

        changes = {change['field']: change for change in asset.change_history[0]['changes']}
        self.assertEqual(changes['secondary_serial']['old'], '')
        self.assertEqual(changes['secondary_serial']['new'], 'SN-SECONDARY')

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
