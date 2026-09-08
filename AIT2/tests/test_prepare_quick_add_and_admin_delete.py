import tempfile
import unittest
import os
from urllib.parse import quote
from unittest.mock import patch

import app as app_module
from data_manager import DataManager
from models import Container, Event, InventoryItem, User, hash_password
from tests.static_source import APP_BUNDLE_SOURCE


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

    def test_workspace_views_omit_unrelated_event_and_inventory_fields(self):
        event = self.make_event()
        self.login_as('admin', is_admin=True)

        plan_assets = self.client.get('/api/assets/available?view=plan')
        self.assertEqual(plan_assets.status_code, 200, plan_assets.get_data(as_text=True))
        plan_asset = plan_assets.get_json()['data'][0]
        self.assertIn('description', plan_asset)
        self.assertIn('tags', plan_asset)
        self.assertNotIn('changeHistory', plan_asset)
        self.assertNotIn('dateOfPurchase', plan_asset)
        self.assertNotIn('location', plan_asset)

        prepare_assets = self.client.get(
            f'/api/assets/available-for-event/{event.event_id}?view=prepare'
        )
        self.assertEqual(
            prepare_assets.status_code,
            200,
            prepare_assets.get_data(as_text=True),
        )
        prepare_asset = prepare_assets.get_json()['data'][0]
        self.assertIn('serial', prepare_asset)
        self.assertIn('status', prepare_asset)
        self.assertNotIn('changeHistory', prepare_asset)
        self.assertNotIn('purchaseBatches', prepare_asset)
        self.assertNotIn('dateModified', prepare_asset)

        plan_event = self.client.get(f'/api/events/{event.event_id}?view=plan')
        self.assertEqual(plan_event.status_code, 200, plan_event.get_data(as_text=True))
        plan_data = plan_event.get_json()['data']
        self.assertIn('modelGroups', plan_data)
        self.assertIn('vendorManagement', plan_data)
        self.assertNotIn('files', plan_data)
        self.assertNotIn('eventLogs', plan_data)
        self.assertNotIn('workflowProgress', plan_data)
        self.assertNotIn('returnedAssets', plan_data)

        return_event = self.client.get(f'/api/events/{event.event_id}?view=return')
        self.assertEqual(return_event.status_code, 200, return_event.get_data(as_text=True))
        return_data = return_event.get_json()['data']
        self.assertIn('assetsByDepartment', return_data)
        self.assertIn('returnableCount', return_data)
        self.assertNotIn('files', return_data)
        self.assertNotIn('vendorManagement', return_data)
        self.assertNotIn('workflowProgress', return_data)

        plan_availability = self.client.get(
            f'/api/events/{event.event_id}/availability?view=plan'
        )
        self.assertEqual(
            plan_availability.status_code,
            200,
            plan_availability.get_data(as_text=True),
        )
        availability_row = plan_availability.get_json()['data'][0]
        self.assertIn('available', availability_row)
        self.assertIn('degradedDetails', availability_row)
        self.assertNotIn('physicalGlobal', availability_row)
        self.assertNotIn('adjustedGlobal', availability_row)

        compact_options = self.client.get(
            '/api/events?view=options&includeReturnable=0&limit=100'
        )
        self.assertEqual(
            compact_options.status_code,
            200,
            compact_options.get_data(as_text=True),
        )
        option = compact_options.get_json()['data'][0]
        self.assertNotIn('returnableCount', option)
        self.assertNotIn('returnableTotalCount', option)

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

    def test_scanned_assignment_persists_event_and_audit_log_in_one_write(self):
        event = self.make_event(event_id=126, actual=[])

        with patch.object(
            self.data_manager,
            'save_event',
            wraps=self.data_manager.save_event,
        ) as save_event:
            response = self.post_assign(event.event_id, asset_id='A#01')

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertEqual(save_event.call_count, 1)
        self.assertEqual(len(event.event_logs), 1)
        self.data_manager.load_events()
        self.assertEqual(len(self.data_manager.events[event.event_id].event_logs), 1)

    def test_prepare_scan_reuses_loaded_state_and_debounces_reconciliation(self):
        project_root = os.path.dirname(app_module.__file__)
        with open(
            os.path.join(project_root, 'static', 'js', 'app.js'),
            encoding='utf-8',
        ) as app_file:
            app_source = app_file.read()
        with open(
            os.path.join(project_root, 'static', 'js', 'events-overview.js'),
            encoding='utf-8',
        ) as overview_file:
            overview_source = overview_file.read()

        scan_source = app_source.split(
            'async function processUniversalAsset(eventId)', 1
        )[1].split('async function assignAndPrepareAsset', 1)[0]
        self.assertNotIn("apiCall('/api/assets/available')", scan_source)
        self.assertNotIn("apiCall(`/api/events/${eventId}`)", scan_source)
        self.assertIn('getContainerForPrepareScan(assetId)', scan_source)
        self.assertIn('if (__containersCache)', app_source)
        self.assertIn('if (!force && __containersCachePromise)', app_source)
        self.assertIn('processUniversalContainer(eventId, container, scannedValue)', scan_source)
        self.assertIn('refreshPrepareUiAfterAssetChange(eventId, delay = 800)', app_source)

        container_source = overview_source.split(
            'async function processUniversalContainer(', 1
        )[1].split('(function initialisePatchedEventViews', 1)[0]
        self.assertNotIn("apiCall(`/api/events/${eventId}`)", container_source)
        self.assertIn("typeof containerOrId === 'object'", container_source)

        sync_source = overview_source.split(
            'function schedulePrepareUiSync(', 1
        )[1].split('async function prepareSpecificAsset', 1)[0]
        self.assertIn('await refreshPrepareNewSelectedEvent({ preserve: true })', sync_source)
        self.assertEqual(sync_source.count("apiCall(`/api/events/${eventId}`)"), 1)

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
        source = APP_BUNDLE_SOURCE
        self.assertIn('const canAssignExactAssets = !isBulk;', source)
        self.assertIn('if (canAssignExactAssets && isOpen) {', source)
        self.assertIn('available.map(asset => prepareNewAssetCard(asset, { canAssign: true }))', source)

    def test_completed_exact_asset_line_hides_primary_assign_but_keeps_extra_assignment(self):
        source = APP_BUNDLE_SOURCE
        section = source.split('function prepareNewModelSection(group)', 1)[1].split(
            'function prepareNewDirectAssetCard(', 1
        )[0]

        self.assertIn(": (complete\n      ? ''", section)
        self.assertIn('available.map(asset => prepareNewAssetCard(asset, { canAssign: true }))', section)
        self.assertIn('onclick="event.stopPropagation();prepareNewAssignAsset(', source)

    def test_prepare_ui_preserves_container_results_and_open_asset_chooser(self):
        project_root = os.path.dirname(app_module.__file__)
        source = APP_BUNDLE_SOURCE
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
            "if(this.open&&!this.querySelector('.prepare-new-model-assets'))",
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
        self.assertIn('expandedCustomGroups: new Set()', source)
        self.assertIn('function prepareNewSetCustomGroupExpanded(', source)
        self.assertIn("const groupKey = section.loan ? `loan:${section.label}` : 'misc';", source)
        self.assertIn('prepareNewPageState.expandedCustomGroups.has(groupKey)', source)
        self.assertIn('function prepareNewRenderCustomMutation()', source)
        self.assertIn('customList.innerHTML = renderPrepareNewCustomList(customAssets);', source)
        self.assertIn('skipUiSync: isCustom', source)
        self.assertIn('if (!skipUiSync) schedulePrepareUiSync(eventId);', source)
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

    def test_prepare_uses_plan_style_event_aside_and_vendor_management(self):
        source = APP_BUNDLE_SOURCE
        page = source.split('function renderPrepareNewPage()', 1)[1].split(
            'function prepareNewCaptureViewState()', 1
        )[0]

        self.assertIn('class="prepare-new-layout"', page)
        self.assertIn('class="prepare-new-primary"', page)
        self.assertIn('class="prepare-new-aside"', page)
        self.assertLess(
            page.index('class="prepare-new-top"'),
            page.index('class="prepare-new-workspace"'),
        )
        self.assertIn('${renderPrepareNewEventDetails()}', page)
        self.assertIn('${renderPrepareNewVendorManagementCard()}', page)
        self.assertIn('function prepareNewVendorManagementDialogMarkup()', source)
        self.assertIn('function prepareNewOpenVendorManagement()', source)
        self.assertIn('function prepareNewSetVendorManagement(encodedKey, mode)', source)
        self.assertIn(
            '`/api/events/${prepareNewPageState.eventId}/vendor-management`',
            source,
        )
        self.assertIn('Delivered items go directly to the venue and are excluded from Prepare.', source)

    def test_prepare_scans_are_captured_immediately_and_processed_fifo(self):
        source = APP_BUNDLE_SOURCE
        enqueue = source.split('function prepareNewEnqueueScan(', 1)[1].split(
            'function prepareNewHandleScanKeydown(', 1
        )[0]
        drain = source.split('async function prepareNewDrainScanQueue()', 1)[1].split(
            'function prepareNewModelKey(', 1
        )[0]
        scan = source.split('async function processUniversalAsset(eventId)', 1)[1].split(
            'async function assignAndPrepareAsset', 1
        )[0]

        self.assertLess(
            enqueue.index("if (input) input.value = '';"),
            enqueue.index('prepareScanQueueState.queue.push'),
        )
        self.assertIn('if (prepareScanQueueState.processing) return;', drain)
        self.assertIn('while (prepareScanQueueState.queue.length)', drain)
        self.assertIn('const job = prepareScanQueueState.queue.shift();', drain)
        self.assertIn('await processUniversalAsset(job.eventId);', drain)
        self.assertIn("['Enter', 'Tab'].includes(event.key)", source)
        self.assertIn('window.__activePrepareQueuedScan = job;', source)
        self.assertIn("queuedScan?.value || input?.value || ''", scan)
        self.assertIn('if (!queuedScan && input) input.value = assetId;', scan)
        self.assertIn('prepareNewEnqueueScan(eventId, identifier);', source)
        self.assertIn('prepareScanQueueState.processing', source)
        self.assertIn('schedulePrepareUiSync(eventId, 300);', source)

    def test_grouped_misc_prepare_targets_the_next_unprepared_record(self):
        source = APP_BUNDLE_SOURCE
        custom_list = source.split('function renderPrepareNewCustomList(', 1)[1].split(
            'function renderPrepareNewEventDetails()', 1
        )[0]

        self.assertIn('const nextPrepareId = ids.find(assetId => (', custom_list)
        self.assertIn('!prepared.has(assetId)', custom_list)
        self.assertIn('!returned.has(assetId)', custom_list)
        self.assertIn('const encodedPrepareId = planEncode(nextPrepareId);', custom_list)
        self.assertIn("'${encodedPrepareId}', this)", custom_list)
        self.assertIn('`${preparedCount} / ${ids.length} prepared`', custom_list)

    def test_misc_loan_card_reports_pending_action_quantities(self):
        source = APP_BUNDLE_SOURCE
        custom_list = source.split('function prepareNewCustomMemberQuantity(', 1)[1].split(
            'function renderPrepareNewEventDetails()', 1
        )[0]
        page = source.split('function renderPrepareNewPage()', 1)[1].split(
            'function prepareNewCaptureViewState()', 1
        )[0]
        mutation = source.split('function prepareNewRenderCustomMutation()', 1)[1].split(
            'async function prepareNewPrepareAsset(', 1
        )[0]

        self.assertIn('function prepareNewCustomPendingCounts(', source)
        self.assertIn('if (prepared.has(assetId) || returned.has(assetId)) return;', custom_list)
        self.assertIn('counts.collection += quantity;', custom_list)
        self.assertIn('counts.preparation += quantity;', custom_list)
        self.assertIn("parts.push(`${counts.collection} to collect`)", custom_list)
        self.assertIn("parts.push(`${counts.preparation} to prepare`)", custom_list)
        self.assertIn('prepareNewCustomPendingCounts(section.rows, event)', custom_list)
        self.assertIn('id="prepareNewCustomPendingBadge"', page)
        self.assertNotIn('${prepareNewCustomAssets().length} items', page)
        self.assertIn("pendingBadge.textContent = prepareNewCustomPendingLabel(", mutation)

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

    def test_removing_prepared_bulk_room_model_keeps_deployment_as_extra(self):
        self.data_manager.inventory['BULK-0001'] = self.make_asset(
            'BULK-0001',
            department='STG',
            is_bulk=True,
            quantity=10,
        )
        marker = app_module._bulk_marker('BULK-0001', 5, 'main')
        event = self.make_event(
            event_id=119,
            prepared=['[MODEL]STG|TestBrand|TestModel|5|Matching item'],
            actual=[marker],
            extra=[],
        )
        event.subprojects = [{
            'id': 'main',
            'name': 'Main Room',
            'items': [{
                'lineId': 'plan_bulk',
                'department': 'STG',
                'departmentCode': 'STG',
                'brand': 'TestBrand',
                'model': 'TestModel',
                'description': 'Matching item',
                'quantity': 5,
                'preparedQuantity': 0,
                'isCustom': False,
                'assetRefs': [marker],
            }],
            'extraRefs': [],
        }]

        self.login_as('admin', True)
        response = self.client.delete(
            f'/api/events/{event.event_id}/models',
            json={
                'department': 'STG',
                'brand': 'TestBrand',
                'model': 'TestModel',
                'description': 'Matching item',
                'subprojectId': 'main',
            },
        )

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertEqual(event.actually_prepared, [marker])
        self.assertEqual(event.extra_assets, [marker])
        self.assertEqual(event.subprojects[0]['extraRefs'], [marker])
        self.assertEqual(event.subprojects[0]['items'][0]['assetRefs'], [])
        self.assertEqual(response.get_json()['data']['unpreparedQuantity'], 0)
        self.assertEqual(response.get_json()['data']['extraQuantity'], 5)

        details = self.client.get(f'/api/events/{event.event_id}').get_json()['data']
        group = next(iter(details['modelGroups'].values()))
        self.assertEqual(group['requiredQuantity'], 0)
        self.assertEqual(group['preparedQuantity'], 5)
        self.assertEqual(group['extraPreparedQuantity'], 5)
        self.assertTrue(group['assignedAssets'][0]['isExtra'])

    def test_removing_bulk_room_requirement_reclassifies_unowned_prepared_marker(self):
        self.data_manager.inventory['BULK-0001'] = self.make_asset(
            'BULK-0001',
            department='STG',
            is_bulk=True,
            quantity=10,
        )
        marker = app_module._bulk_marker('BULK-0001', 5)
        event = self.make_event(
            event_id=120,
            prepared=['[MODEL]STG|TestBrand|TestModel|5|Matching item'],
            actual=[marker],
            extra=[],
        )
        event.subprojects = [{
            'id': 'main',
            'name': 'Main Room',
            'items': [{
                'lineId': 'plan_bulk_legacy',
                'department': 'STG',
                'departmentCode': 'STG',
                'brand': 'TestBrand',
                'model': 'TestModel',
                'description': 'Matching item',
                'quantity': 5,
                'preparedQuantity': 0,
                'isCustom': False,
                'assetRefs': [],
            }],
            'extraRefs': [],
        }]

        self.login_as('admin', True)
        response = self.client.delete(
            f'/api/events/{event.event_id}/models',
            json={
                'department': 'STG',
                'brand': 'TestBrand',
                'model': 'TestModel',
                'description': 'Matching item',
                'subprojectId': 'main',
            },
        )

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertEqual(event.actually_prepared, [marker])
        self.assertEqual(event.extra_assets, [marker])
        self.assertEqual(response.get_json()['data']['unpreparedQuantity'], 0)
        self.assertEqual(response.get_json()['data']['extraQuantity'], 5)
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

    def test_remove_custom_asset_cleans_finance_room_line_without_asset_refs(self):
        marker = app_module._make_custom_marker(
            'MISC',
            'Panasonic PT-DZ13K 3-chip FHD DLP projector 12000 ANSI lumens',
            1,
            'VX',
            uid='finance_line_1784015304143_337c4de8ec12e8',
        )
        event = self.make_event(
            event_id=160,
            prepared=[marker],
            actual=[marker],
        )
        event.subprojects = [{
            'id': 'main',
            'name': 'Main Room',
            'items': [
                {
                    'lineId': 'line_1784015304143_337c4de8ec12e8',
                    'isCustom': True,
                    'description': 'Panasonic PT-DZ13K 3-chip FHD DLP projector 12000 ANSI lumens',
                    'quantity': 1,
                    'assetRefs': [],
                },
                {
                    'lineId': 'plan_8661a6898b4cf293',
                    'isCustom': False,
                    'brand': 'Panasonic',
                    'model': 'PT-DZ13K',
                    'description': '3-chip FHD DLP projector 12000 ANSI lumens',
                    'quantity': 1,
                    'assetRefs': ['A#01'],
                },
            ],
            'extraRefs': [marker],
        }]

        self.login_as('admin', True)
        response = self.client.post(
            '/api/events/160/custom-assets/remove',
            json={'assetId': marker},
        )

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertNotIn(marker, event.prepared_items)
        self.assertNotIn(marker, event.actually_prepared)
        self.assertEqual(event.subprojects[0]['extraRefs'], [])
        self.assertEqual(
            [line['lineId'] for line in event.subprojects[0]['items']],
            ['plan_8661a6898b4cf293'],
        )


if __name__ == '__main__':
    unittest.main()
