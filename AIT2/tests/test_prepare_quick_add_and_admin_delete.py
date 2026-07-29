import tempfile
import unittest
import os
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
            'A#03': self.make_asset('A#03'),
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

    def post_prepare_quantity(self, event_id, quantity=1, all_quantity=False):
        self.login_as('normal')
        return self.client.post(
            f'/api/events/{event_id}/prepare-model-quantity',
            json={
                'department': 'AX',
                'brand': 'TestBrand',
                'model': 'TestModel',
                'description': 'Matching item',
                'quantity': quantity,
                'all': all_quantity,
                'action': 'prepare',
            },
        )

    def test_quick_add_disabled_tracks_surplus_as_extra(self):
        event = self.make_event()

        prepare_response = self.post_prepare_quantity(event.event_id)
        self.assertEqual(prepare_response.status_code, 200, prepare_response.get_data(as_text=True))

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

    def test_quick_add_creates_room_requirement_without_consuming_matching_extras(self):
        event = self.make_event(
            event_id=124,
            prepared=[
                '[MODEL]AX|TestBrand|TestModel|1|Matching item',
                'A#01',
                'A#02',
            ],
            actual=['A#01', 'A#02'],
            extra=['A#01', 'A#02'],
        )
        event.subprojects = [
            {
                'id': 'main',
                'name': 'Main Room',
                'items': [{
                    'lineId': 'main-model',
                    'departmentCode': 'AX',
                    'brand': 'TestBrand',
                    'model': 'TestModel',
                    'description': 'Matching item',
                    'quantity': 1,
                    'isCustom': False,
                    'assetRefs': [],
                }],
                'extraRefs': [],
            },
            {
                'id': 'room-2',
                'name': 'Room 2',
                'items': [],
                'extraRefs': ['A#01', 'A#02'],
            },
        ]

        response = self.post_assign(
            event.event_id,
            asset_id='A#03',
            quickAdd=True,
            subprojectId='room-2',
        )

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertEqual(response.get_json()['data']['addedRequirementUnits'], 1)
        self.assertFalse(response.get_json()['data']['isExtra'])
        self.assertEqual(event.extra_assets, ['A#01', 'A#02'])
        self.assertIn(
            '[MODEL]AX|TestBrand|TestModel|2|Matching item',
            event.prepared_items,
        )
        room = event.subprojects[1]
        self.assertEqual(room['extraRefs'], ['A#01', 'A#02'])
        self.assertEqual(len(room['items']), 1)
        self.assertEqual(room['items'][0]['quantity'], 1)
        self.assertEqual(room['items'][0]['assetRefs'], ['A#03'])

        detail_response = self.client.get(f'/api/events/{event.event_id}')
        self.assertEqual(
            detail_response.status_code,
            200,
            detail_response.get_data(as_text=True),
        )
        group = next(iter(detail_response.get_json()['data']['modelGroups'].values()))
        assets = {asset['id']: asset for asset in group['assignedAssets']}
        self.assertFalse(assets['A#03']['isExtra'])
        self.assertTrue(assets['A#01']['isExtra'])
        self.assertTrue(assets['A#02']['isExtra'])

    def test_consecutive_assignments_are_grouped_with_item_details(self):
        event = self.make_event(
            event_id=115,
            prepared=['[MODEL]AX|TestBrand|TestModel|2|Matching item'],
            actual=[],
            extra=[],
        )

        first = self.post_assign(event.event_id, asset_id='A#01')
        second = self.post_assign(event.event_id, asset_id='A#02')

        self.assertEqual(first.status_code, 200, first.get_data(as_text=True))
        self.assertEqual(second.status_code, 200, second.get_data(as_text=True))
        self.assertEqual(len(event.event_logs), 1)
        grouped = event.event_logs[0]
        self.assertEqual(grouped['groupCount'], 2)
        self.assertEqual(grouped['groupKey'], 'event-asset:115:assign')
        self.assertEqual(
            {item['assetId'] for item in grouped['items']},
            {'A#01', 'A#02'},
        )
        self.assertIn('A#01', grouped['action'])
        self.assertIn('A#02', grouped['action'])
        self.assertNotIn('1x A#01', grouped['action'])
        self.assertNotIn('1x A#02', grouped['action'])
        self.assertNotIn('TestBrand', grouped['action'])
        self.assertNotIn('[A#01]', grouped['action'])
        self.assertNotIn('[A#02]', grouped['action'])

        self.data_manager.load_events()
        persisted = self.data_manager.events[115].event_logs[0]
        self.assertEqual(persisted['groupCount'], 2)
        self.assertEqual(
            {item['assetId'] for item in persisted['items']},
            {'A#01', 'A#02'},
        )

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

        prepare_response = self.post_prepare_quantity(event.event_id, all_quantity=True)
        self.assertEqual(prepare_response.status_code, 200, prepare_response.get_data(as_text=True))

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
        self.assertEqual(asset['availableQuantity'], 0)
        self.assertEqual(asset['deployedQuantity'], 1)

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

    def test_specific_asset_assignment_prepares_without_prepared_quantity(self):
        event = self.make_event(
            event_id=120,
            prepared=['[MODEL]AX|TestBrand|TestModel|1|Matching item'],
            actual=[],
            extra=[],
        )

        response = self.post_assign(event.event_id, asset_id='A#01')

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertFalse(response.get_json()['data']['isExtra'])
        self.assertIn('A#01', event.actually_prepared)
        self.assertNotIn('A#01', event.extra_assets)
        details = self.client.get(f'/api/events/{event.event_id}').get_json()['data']
        group = next(iter(details['modelGroups'].values()))
        self.assertEqual(group['preparedQuantity'], 1)
        self.assertEqual(group['countablePreparedQuantity'], 1)

    def test_scanned_or_container_specific_asset_prepares_without_quantity_slot(self):
        event = self.make_event(
            event_id=123,
            prepared=['[MODEL]AX|TestBrand|TestModel|1|Matching item'],
            actual=[],
            extra=[],
        )

        scanned = self.post_assign(event.event_id, asset_id='SN-A#01')
        self.assertEqual(scanned.status_code, 200, scanned.get_data(as_text=True))
        self.assertIn('A#01', event.actually_prepared)

        event.actually_prepared = []
        self.data_manager.inventory['A#01'].current_location = 'Store'
        container = self.post_assign(
            event.event_id,
            asset_id='B#01',
            fromContainer=True,
            source='container',
            quickAdd=False,
        )
        self.assertEqual(container.status_code, 200, container.get_data(as_text=True))
        self.assertTrue(container.get_json()['data']['isExtra'])
        self.assertIn('B#01', event.actually_prepared)
        self.assertIn('B#01', event.extra_assets)

    def test_prepare_ui_exposes_specific_assets_before_quantity_is_prepared(self):
        script_path = os.path.join(
            os.path.dirname(app_module.__file__), 'static', 'js', 'app.js'
        )
        with open(script_path, encoding='utf-8') as script_file:
            source = script_file.read()
        self.assertIn('const canAssignExactAssets = !isBulk;', source)
        self.assertIn('const showExactAssetPanel = !isBulk;', source)
        self.assertIn('available.map(asset => prepareNewAssetCard(asset, { canAssign: true }))', source)

    def test_prepare_ui_preserves_container_results_and_open_asset_chooser(self):
        project_root = os.path.dirname(app_module.__file__)
        script_path = os.path.join(
            project_root, 'static', 'js', 'app.js'
        )
        with open(script_path, encoding='utf-8') as script_file:
            source = script_file.read()
        with open(
            os.path.join(project_root, 'templates', 'index.html'),
            encoding='utf-8',
        ) as template_file:
            template = template_file.read()

        self.assertIn(
            "scanFeedbackHtml: document.getElementById('universal-asset-feedback')?.innerHTML || ''",
            source,
        )
        self.assertIn('scanRevision: prepareNewPageState.scanRevision,', source)
        self.assertIn(
            'state.scanRevision === prepareNewPageState.scanRevision',
            source,
        )
        self.assertIn("feedback.innerHTML = state.scanFeedbackHtml || '';", source)
        self.assertIn(
            "ontoggle=\"prepareNewSetModelExpanded('${encodedKey}', this.open, this)\"",
            source,
        )
        self.assertIn('data-prepare-render-version=', source)
        self.assertIn('prepareNewPageState.renderVersion += 1;', source)
        self.assertIn(
            "prepareNewUnassignAsset(${eventId}, '${encodedId}', "
            "'${escapeHtmlAttr(options.modelKey || '')}')",
            source,
        )
        self.assertIn('if (modelKey) prepareNewPageState.expandedModels.add(modelKey);', source)
        self.assertIn("const panelKey = 'standalone-extra-assets';", source)
        self.assertIn('modelKey: encodedPanelKey', source)
        self.assertIn(
            'No extra assets remain assigned to this event.',
            source,
        )
        self.assertIn('class="prepare-new-container-detail-scroll"', source)
        self.assertIn("<details class=\"prepare-new-container-details\" ${failed ? 'open' : ''}>", source)
        self.assertIn("scanTop: root?.querySelector('.prepare-new-left')?.scrollTop || 0", source)
        self.assertIn("feedbackDiv.scrollIntoView({", source)
        self.assertIn('.prepare-new-container-detail-scroll {', template)
        self.assertIn('.prepare-new-left {', template)
        self.assertIn('overflow-y: auto;', template)
        self.assertIn('overflow-wrap: anywhere;', template)

    def test_unprepare_quantity_cannot_remove_assigned_specific_asset(self):
        event = self.make_event(
            event_id=121,
            prepared=['[MODEL]AX|TestBrand|TestModel|1|Matching item'],
            actual=[],
            extra=[],
        )
        prepare_response = self.post_prepare_quantity(event.event_id, all_quantity=True)
        self.assertEqual(prepare_response.status_code, 200, prepare_response.get_data(as_text=True))
        assign_response = self.post_assign(event.event_id, asset_id='A#01')
        self.assertEqual(assign_response.status_code, 200, assign_response.get_data(as_text=True))

        self.login_as('normal')
        response = self.client.post(
            f'/api/events/{event.event_id}/prepare-model-quantity',
            json={
                'department': 'AX',
                'brand': 'TestBrand',
                'model': 'TestModel',
                'description': 'Matching item',
                'quantity': 1,
                'action': 'unprepare',
            },
        )

        self.assertEqual(response.status_code, 400)
        self.assertIn('Unassign specific assets', response.get_json()['error'])
        self.assertIn('A#01', event.actually_prepared)

    def test_unassign_specific_asset_unprepares_it_and_logs_action(self):
        event = self.make_event(
            event_id=122,
            prepared=['[MODEL]AX|TestBrand|TestModel|1|Matching item'],
            actual=[],
            extra=[],
        )
        prepare_response = self.post_prepare_quantity(event.event_id, all_quantity=True)
        self.assertEqual(prepare_response.status_code, 200, prepare_response.get_data(as_text=True))
        assign_response = self.post_assign(event.event_id, asset_id='A#01')
        self.assertEqual(assign_response.status_code, 200, assign_response.get_data(as_text=True))

        self.login_as('normal')
        response = self.client.post(
            f'/api/events/{event.event_id}/unassign-specific',
            json={'assetId': 'A#01'},
        )

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertNotIn('A#01', event.actually_prepared)
        self.assertEqual(self.data_manager.inventory['A#01'].current_location, 'Store')
        self.assertTrue(any(
            'Unassigned and unprepared from event 122' in record.get('action', '')
            and record.get('action', '').endswith('A#01')
            and '1x A#01' not in record.get('action', '')
            and 'TestBrand' not in record.get('action', '')
            for record in event.event_logs
        ))

    def test_unassign_specific_asset_promotes_matching_extra(self):
        event = self.make_event(
            event_id=123,
            prepared=['[MODEL]AX|TestBrand|TestModel|1|Matching item', 'A#02'],
            actual=['A#01', 'A#02'],
            extra=['A#02'],
        )

        self.login_as('normal')
        response = self.client.post(
            f'/api/events/{event.event_id}/unassign-specific',
            json={'assetId': 'A#01'},
        )

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertNotIn('A#01', event.actually_prepared)
        self.assertIn('A#02', event.actually_prepared)
        self.assertNotIn('A#02', event.extra_assets)
        self.assertNotIn('A#02', event.prepared_items)
        self.assertEqual(
            event.prepared_items,
            ['[MODEL]AX|TestBrand|TestModel|1|Matching item'],
        )

    def test_bulk_unprepare_log_uses_name_without_internal_asset_id(self):
        bulk_id = 'BULK-INTERNAL-001'
        self.data_manager.inventory[bulk_id] = self.make_asset(
            bulk_id,
            is_bulk=True,
            quantity=5,
        )
        marker = app_module._bulk_marker(bulk_id, 3)
        event = self.make_event(
            event_id=123,
            prepared=['[MODEL]AX|TestBrand|TestModel|3|Matching item'],
            actual=[marker],
            extra=[],
        )
        self.login_as('normal')

        response = self.client.post(
            f'/api/events/{event.event_id}/unprepare',
            json={'assetId': marker},
        )

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        action = event.event_logs[-1]['action']
        self.assertIn('Unprepared from event 123: 3x TestBrand - TestModel - Matching item', action)
        self.assertNotIn(bulk_id, action)
        self.assertEqual(event.event_logs[-1]['items'][0]['assetId'], '')

    def test_specific_prepare_log_uses_only_visible_asset_id(self):
        event = self.make_event(
            event_id=124,
            prepared=['A#01'],
            actual=[],
            extra=[],
        )
        self.login_as('normal')

        response = self.client.post(
            f'/api/events/{event.event_id}/prepare',
            json={'assetId': 'A#01'},
        )

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        action = event.event_logs[-1]['action']
        self.assertEqual(action, 'Prepared for event 124: A#01')
        self.assertNotIn('TestBrand', action)

    def test_specific_return_log_omits_single_item_quantity(self):
        event = self.make_event(
            event_id=125,
            prepared=['[MODEL]AX|TestBrand|TestModel|1|Matching item'],
            actual=['A#01'],
            extra=[],
        )
        self.login_as('normal')

        response = self.client.post(
            f'/api/events/{event.event_id}/return',
            json={'assetId': 'A#01'},
        )

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertEqual(event.event_logs[-1]['action'], 'Returned from event 125: A#01')

    def test_bulk_return_log_retains_quantity(self):
        bulk_id = 'BULK-INTERNAL-RETURN'
        self.data_manager.inventory[bulk_id] = self.make_asset(
            bulk_id,
            is_bulk=True,
            quantity=5,
        )
        marker = app_module._bulk_marker(bulk_id, 3)
        event = self.make_event(
            event_id=126,
            prepared=[marker],
            actual=[marker],
            extra=[],
        )
        self.login_as('normal')

        response = self.client.post(
            f'/api/events/{event.event_id}/return',
            json={'assetId': marker},
        )

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertEqual(
            event.event_logs[-1]['action'],
            'Returned from event 126: 3x TestBrand - TestModel - Matching item',
        )
        self.assertNotIn(bulk_id, event.event_logs[-1]['action'])

    def test_non_bulk_assignment_does_not_show_quantity(self):
        action = self.data_manager.format_event_asset_log_action({
            'actionLabel': 'Assigned',
            'preposition': 'to',
            'eventId': 127,
            'items': [{
                'assetId': '',
                'label': 'Custom cable loom',
                'quantity': 4,
                'itemType': 'custom',
            }],
        })

        self.assertEqual(action, 'Assigned to event 127: Custom cable loom')

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

    def test_removing_prepared_bulk_model_keeps_deployment_as_extra(self):
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
        self.assertEqual(response.get_json()['data']['unpreparedQuantity'], 0)
        self.assertEqual(response.get_json()['data']['extraQuantity'], 5)
        self.assertEqual(event.prepared_items, [])
        self.assertEqual(event.actually_prepared, [marker])
        self.assertEqual(event.extra_assets, [marker])
        self.assertEqual(
            app_module._bulk_deployments_for_asset('BULK-0001')[0]['quantity'],
            5,
        )

        details = self.client.get(f'/api/events/{event.event_id}').get_json()['data']
        group = next(iter(details['modelGroups'].values()))
        self.assertEqual(group['requiredQuantity'], 0)
        self.assertEqual(group['preparedQuantity'], 5)
        self.assertEqual(group['extraPreparedQuantity'], 5)
        self.assertTrue(group['assignedAssets'][0]['isExtra'])

    def test_removing_prepared_model_keeps_specific_asset_as_extra(self):
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
        self.assertEqual(event.actually_prepared, ['A#01'])
        self.assertEqual(event.returned_items, ['A#01'])
        self.assertEqual(event.extra_assets, ['A#01'])
        self.assertEqual(self.data_manager.inventory['A#01'].current_location, event.name)

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
        self.assertEqual(event.extra_assets, ['A#02'])

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
        self.assertEqual(model_group['countablePreparedQuantity'], 1)
        self.assertEqual(model_group['extraPreparedQuantity'], 1)
        self.assertTrue(
            next(
                asset for asset in model_group['assignedAssets']
                if asset['id'] == 'A#02'
            )['isExtra']
        )

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
        self.assertEqual(event.extra_assets, [])
        self.assertEqual(
            app_module._bulk_deployments_for_asset('BULK-0001')[0]['quantity'],
            5,
        )

        details = self.client.get(f'/api/events/{event.event_id}').get_json()['data']
        group = next(iter(details['modelGroups'].values()))
        self.assertEqual(group['requiredQuantity'], 3)
        self.assertEqual(group['preparedQuantity'], 5)
        self.assertEqual(group['countablePreparedQuantity'], 3)
        self.assertEqual(group['extraPreparedQuantity'], 2)

    def test_reducing_model_quantity_marks_anonymous_prepared_slots_extra(self):
        prepared_marker = app_module._prepared_model_marker({
            'department': 'AX',
            'brand': 'TestBrand',
            'model': 'TestModel',
            'description': 'Matching item',
        }, 2)
        event = self.make_event(
            event_id=116,
            prepared=['[MODEL]AX|TestBrand|TestModel|2|Matching item'],
            actual=[prepared_marker],
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
        self.assertEqual(event.actually_prepared, [prepared_marker])
        self.assertEqual(event.extra_assets, [])

        details = self.client.get(f'/api/events/{event.event_id}').get_json()['data']
        group = next(iter(details['modelGroups'].values()))
        self.assertEqual(group['requiredQuantity'], 1)
        self.assertEqual(group['preparedQuantity'], 2)
        self.assertEqual(group['countablePreparedQuantity'], 1)
        self.assertEqual(group['extraPreparedQuantity'], 1)

    def test_removing_room_requirement_retains_prepared_room_row_as_extra(self):
        event = self.make_event(
            event_id=114,
            prepared=['[MODEL]AX|TestBrand|TestModel|1|Matching item'],
            actual=['A#01'],
            extra=[],
        )
        event.subprojects = [{
            'id': 'main',
            'name': 'Main Room',
            'items': [{
                'lineId': 'plan_1',
                'department': 'AX',
                'departmentCode': 'AX',
                'brand': 'TestBrand',
                'model': 'TestModel',
                'description': 'Matching item',
                'quantity': 1,
                'preparedQuantity': 0,
                'assetRefs': ['A#01'],
            }],
        }]

        self.login_as('admin', True)
        response = self.client.delete(
            f'/api/events/{event.event_id}/models',
            json={
                'department': 'AX',
                'brand': 'TestBrand',
                'model': 'TestModel',
                'description': 'Matching item',
                'subprojectId': 'main',
            },
        )

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        room_item = event.subprojects[0]['items'][0]
        self.assertEqual(room_item['quantity'], 0)
        self.assertEqual(room_item['assetRefs'], [])
        self.assertEqual(event.subprojects[0]['extraRefs'], ['A#01'])
        self.assertEqual(event.actually_prepared, ['A#01'])
        self.assertEqual(event.extra_assets, ['A#01'])
        self.assertEqual(response.get_json()['data']['unpreparedQuantity'], 0)

    def test_room_reconciliation_repairs_stale_global_extra_classification(self):
        event = self.make_event(
            event_id=117,
            prepared=['[MODEL]AX|TestBrand|TestModel|2|Matching item', 'A#02'],
            actual=['A#01', 'A#02'],
            extra=['A#02'],
        )
        event.subprojects = [{
            'id': 'main',
            'name': 'Main Room',
            'items': [{
                'lineId': 'plan_1',
                'department': 'AX',
                'departmentCode': 'AX',
                'brand': 'TestBrand',
                'model': 'TestModel',
                'description': 'Matching item',
                'quantity': 2,
                'preparedQuantity': 0,
                'assetRefs': ['A#01', 'A#02'],
            }],
            'extraRefs': [],
        }]

        result = app_module._reconcile_event_subproject_extras(event)

        self.assertTrue(result['changed'])
        self.assertEqual(event.subprojects[0]['items'][0]['assetRefs'], ['A#01', 'A#02'])
        self.assertEqual(event.subprojects[0]['extraRefs'], [])
        self.assertEqual(event.extra_assets, [])
        self.assertNotIn('A#02', event.prepared_items)

    def test_partial_bulk_room_surplus_stays_attached_and_rebalances(self):
        self.data_manager.inventory['BULK-0001'] = self.make_asset(
            'BULK-0001',
            department='STG',
            is_bulk=True,
            quantity=10,
        )
        marker = app_module._bulk_marker('BULK-0001', 2, 'main')
        event = self.make_event(
            event_id=118,
            prepared=['[MODEL]STG|TestBrand|TestModel|1|Matching item'],
            actual=[marker],
            extra=[],
        )
        event.subprojects = [{
            'id': 'main',
            'name': 'Main Room',
            'items': [{
                'lineId': 'plan_1',
                'department': 'STG',
                'departmentCode': 'STG',
                'brand': 'TestBrand',
                'model': 'TestModel',
                'description': 'Matching item',
                'quantity': 1,
                'preparedQuantity': 0,
                'assetRefs': [marker],
            }],
            'extraRefs': [],
        }]

        app_module._reconcile_event_subproject_extras(event)
        room = event.subprojects[0]
        self.assertEqual(room['items'][0]['assetRefs'], [marker])
        self.assertEqual(room['extraRefs'], [])
        self.assertEqual(event.extra_assets, [])

        room['items'][0]['quantity'] = 0
        app_module._reconcile_event_subproject_extras(event)
        self.assertEqual(room['items'][0]['assetRefs'], [])
        self.assertEqual(room['extraRefs'], [marker])
        self.assertEqual(event.extra_assets, [marker])

        room['items'][0]['quantity'] = 1
        app_module._reconcile_event_subproject_extras(event)
        self.assertEqual(room['items'][0]['assetRefs'], [marker])
        self.assertEqual(room['extraRefs'], [])
        self.assertEqual(event.extra_assets, [])

    def test_quick_add_false_overrides_container_auto_add(self):
        event = self.make_event(event_id=104)

        prepare_response = self.post_prepare_quantity(event.event_id)
        self.assertEqual(prepare_response.status_code, 200, prepare_response.get_data(as_text=True))

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
