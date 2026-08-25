import json
import os
import tempfile
import unittest
from pathlib import Path

import app as app_module
from data_manager import DataManager
from models import Container, Event, InventoryItem, User, hash_password
from tests.static_source import APP_BUNDLE_SOURCE


class PlanningTemplateTests(unittest.TestCase):
    def setUp(self):
        self.original_data_manager = app_module.get_default_data_manager()
        self.original_signature = app_module._data_snapshot_signature
        self.original_testing = app_module.app.config.get('TESTING')
        self.tempdir = tempfile.TemporaryDirectory()

        self.data_manager = DataManager(self.tempdir.name)
        self.data_manager.setup_data_folder()
        self.data_manager.users = {
            'normal': User(
                'normal',
                hash_password('pw', 'normal-salt'),
                'normal-salt',
                False,
                True,
            ),
            'admin': User(
                'admin',
                hash_password('pw', 'admin-salt'),
                'admin-salt',
                True,
                True,
            ),
        }
        self.data_manager.save_users()
        self.data_manager.logs = []
        self.data_manager.save_logs()
        self.data_manager.inventory = {
            f'A#{index:02d}': self.make_asset(f'A#{index:02d}')
            for index in range(1, 7)
        }
        self.data_manager.inventory['B#01'] = self.make_asset(
            'B#01',
            department='LX',
            model='ModelB',
        )
        self.data_manager.containers = {
            'CASE #01': Container('CASE #01', ['A#01', 'A#02', 'B#01'])
        }
        self.data_manager.save_inventory()
        self.data_manager.save_containers()

        self.event = Event(
            event_id=10,
            name='Template Test',
            start_date='20260710',
            end_date='20260711',
            asset_models=[],
            prepared_items=[],
            returned_items=[],
            actually_prepared=[],
            extra_assets=[],
        )
        self.data_manager.events[self.event.event_id] = self.event
        self.data_manager.save_event(self.event)

        app_module.app.config['TESTING'] = True
        app_module.set_data_manager_for_testing(self.data_manager)
        self.client = app_module.app.test_client()

    def tearDown(self):
        app_module.clear_test_data_manager(self.original_data_manager)
        app_module._data_snapshot_signature = self.original_signature
        app_module.app.config['TESTING'] = self.original_testing
        self.tempdir.cleanup()

    def make_asset(self, asset_id, department='AX', model='ModelA'):
        return InventoryItem(
            asset_id=asset_id,
            brand='TestBrand',
            model_number=model,
            serial_number=f'SN-{asset_id}',
            description=f'{model} description',
            is_missing=False,
            maintenance_logs=[],
            department_code=department,
            default_location='Store',
            current_location='',
        )

    def login(self, username):
        with self.client.session_transaction() as session:
            session['user'] = username
            session['is_admin'] = username == 'admin'

    def create_template(self, name='Standard'):
        response = self.client.post(
            '/api/planning-templates',
            json={
                'name': name,
                'models': [{
                    'department': 'AX',
                    'brand': 'TestBrand',
                    'model': 'ModelA',
                    'description': 'ModelA description',
                    'quantity': 2,
                }],
                'customAssets': [{
                    'type': 'LOAN',
                    'name': 'Rental Receiver',
                    'quantity': 1,
                    'department': 'AX',
                    'company': 'Rental Co',
                }],
            },
        )
        self.assertEqual(response.status_code, 201, response.get_data(as_text=True))
        return response.get_json()['data']

    def test_planning_templates_are_admin_only(self):
        self.login('normal')
        response = self.client.get('/api/planning-templates')
        self.assertEqual(response.status_code, 403)

    def test_index_contains_admin_plan_navigation_and_workspace(self):
        self.login('admin')
        response = self.client.get('/events')
        page = response.get_data(as_text=True)

        self.assertEqual(response.status_code, 200)
        self.assertIn("showSection('plan')", page)
        self.assertIn('id="plan-section" class="content-section"', page)
        self.assertNotIn(
            'id="plan-section" class="content-section admin-only"',
            page,
        )
        self.assertIn('id="plan-page-root"', page)

    def test_event_plan_actions_open_new_workspace(self):
        script = APP_BUNDLE_SOURCE

        plan_action = script.split('async function openEventPlanning(eventId)', 1)[1].split(
            'function openPrepareWorkspaceForEvent', 1
        )[0]
        self.assertIn('planPageState.eventId = id;', plan_action)
        self.assertIn('planPageState.event = null;', plan_action)
        self.assertIn('workflowRememberEvent(id)', plan_action)
        self.assertIn("showSection('plan', { eventId: id });", plan_action)
        self.assertIn(
            'workflowApplyRememberedEvent(sectionName, options.eventId);',
            script,
        )
        self.assertIn(
            'const explicitEventId = Number(preferredEventId || 0);',
            script,
        )
        self.assertNotIn('Manage Assets', script)

    def test_plan_action_identifiers_escape_apostrophes(self):
        script = APP_BUNDLE_SOURCE

        self.assertIn(".replace(/'/g, '%27')", script)
        self.assertIn(
            'departmentInput.add(new Option(customDepartment, customDepartment))',
            script,
        )

    def test_custom_item_departments_exclude_asset_support_buckets(self):
        script = APP_BUNDLE_SOURCE
        options = script.split('function customDepartmentOptionsHtml(', 1)[1].split(
            'function departmentCodeToDoName(', 1
        )[0]
        custom_card = script.split('function renderPlanCustomItemCard()', 1)[1].split(
            'function renderPlanTemplateLibrary()', 1
        )[0]

        self.assertIn('configured.filter(isSelectableCompanyDepartment)', options)
        self.assertNotIn("{ code: 'UN', name: 'Unknown' }", options)
        self.assertIn("customDepartmentOptionsHtml('AX')", custom_card)
        self.assertIn('isSelectableCompanyDepartment(customDepartment)', script)

    def test_plan_asset_search_includes_each_asset_description(self):
        script = APP_BUNDLE_SOURCE

        self.assertIn('function planAvailableModelSearchText(group)', script)
        self.assertIn("String(asset?.description || '').trim()", script)
        self.assertIn(
            'planAvailableModelSearchText(group).includes(search)',
            script,
        )
        self.assertNotIn(
            'max="${Math.max(1, availability.physical)}"',
            script,
        )
        self.assertIn(
            'above the total inventory of ${availability.physical}',
            script,
        )

    def test_event_workspaces_offer_consolidated_room_drag_and_delete_controls(self):
        script = APP_BUNDLE_SOURCE

        self.assertIn("EVENT_CONSOLIDATED_SUBPROJECT_ID = '__all__'", script)
        self.assertIn('All requirements', script)
        self.assertIn('function eventSubprojectDragStart(', script)
        self.assertIn("if (eventSubprojects(event).length <= 1) return '';", script)
        self.assertIn("event.target?.closest?.('button, input, select, textarea, a, label')", script)
        self.assertIn('function eventSubprojectDrop(', script)
        self.assertIn("/subprojects/move`,", script)
        self.assertIn('function planOpenDeleteSubproject(', script)
        self.assertIn("mode: state.mode", script)
        self.assertIn('allowReorder: true', script)
        self.assertIn('showImplicitMain: true', script)
        self.assertIn("name: 'Main Room', items: [], isImplicit: true", script)
        self.assertIn('allowRename && !room.isImplicit', script)
        self.assertIn('function eventSubprojectOrderDragStart(', script)
        self.assertIn('function eventSubprojectOrderDrop(', script)
        self.assertIn('/subprojects/reorder`', script)
        self.assertIn('function planRenameSubproject(', script)
        self.assertIn("'PATCH',\n      { name: cleanName }", script)
        self.assertIn('function planSubprojectHasAssignedAssets(', script)
        self.assertIn('if (!planSubprojectHasAssignedAssets(room))', script)
        self.assertIn('class="plan-qty-total"', script)
        self.assertIn('eventConsolidatedNotice({ interactive: true })', script)
        self.assertIn(
            'Return assets and log faults directly from this view.',
            script,
        )
        self.assertIn("kind: 'requirement'", script)
        self.assertIn("kind: 'asset', assetRef: id", script)
        self.assertIn("`Event #${event.id || ''}: ${event.name || 'Unnamed event'}`", script)
        self.assertIn("room ? `Room: ${room.name || 'Unnamed room'}`", script)
        self.assertIn('function prepareNewSubprojectNeedsAttention(', script)
        self.assertIn('function returnSubprojectNeedsAttention(', script)
        self.assertIn(
            'roomNeedsAttention: prepareNewSubprojectNeedsAttention',
            script,
        )
        self.assertIn(
            'roomNeedsAttention: returnSubprojectNeedsAttention',
            script,
        )
        self.assertIn('event-subproject-attention', script)

    def test_plan_quantities_are_optimistic_and_debounced_without_page_refresh(self):
        script = APP_BUNDLE_SOURCE

        self.assertIn('var planQuantitySaveTimers = new Map();', script)
        self.assertIn('var planQuantitySaveChains = new Map();', script)
        self.assertIn('var planCustomQuantityAssetIds = new Map();', script)
        self.assertIn('function planScheduleQuantitySave(key, save)', script)
        self.assertIn('}, 450));', script)
        self.assertIn('const previous = planQuantitySaveChains.get(key) || Promise.resolve();', script)
        self.assertIn('function planAdjustModelQuantity(', script)
        self.assertIn('function planAdjustCustomQuantity(', script)
        self.assertIn("input.setAttribute('aria-busy', 'true');", script)
        model_setter = script.split('function planSetModelQuantity(', 1)[1].split(
            'async function planRemoveModel', 1
        )[0]
        custom_setter = script.split('function planSetCustomQuantity(', 1)[1].split(
            'function planShouldSuppressRealtime', 1
        )[0]
        self.assertIn('planScheduleQuantitySave(key, async () => {', model_setter)
        self.assertIn('renderPlanRealtimeAssets()', model_setter)
        self.assertIn('planScheduleQuantitySave(key, async () => {', custom_setter)
        self.assertIn('planReplaceLocalAssetReference(', custom_setter)
        self.assertIn("[custom?.uid || assetId]", custom_setter)
        self.assertIn('const currentAssetId = planCustomQuantityAssetIds.get(key) || assetId;', custom_setter)
        local_replacer = script.split('function planReplaceLocalAssetReference(', 1)[1].split(
            'function planAdjustCustomQuantity(', 1
        )[0]
        self.assertIn('Object.values(event.assetsByDepartment || {})', local_replacer)
        self.assertIn('asset.id = newAssetId;', local_replacer)
        self.assertIn('asset.quantity = quantity;', local_replacer)
        self.assertIn('asset.displayName = displayName;', local_replacer)
        self.assertIn('function planRequirementRoomAllocations(', script)
        self.assertIn("'Assigned to sub-projects:'", script)
        self.assertIn('allocatedRequired', script)
        self.assertIn('function planShowAvailabilityReason(', script)
        self.assertIn('function planAvailabilityDetail(', script)
        self.assertIn('class="plan-availability-count"', script)
        self.assertIn('Used by overlapping events', script)
        self.assertIn('`#${eventId}: ${eventName}`', script)
        self.assertIn('viewEvent(eventId, { updateHistory: false })', script)
        self.assertIn('function planSubprojectWarning(', script)
        self.assertIn('roomWarning: planSubprojectWarning', script)
        self.assertIn('function eventScopedCustomAssets(', script)
        self.assertIn('function groupEventCustomAssets(', script)
        self.assertIn('function prepareNewCollectCustomMany(', script)
        self.assertIn('function prepareNewUncollectCustomMany(', script)
        self.assertIn('prepare-new-consolidated-loan-action', script)
        self.assertIn('>Collect</button>', script)
        self.assertIn('>Uncollect</button>', script)
        self.assertIn('>Unprepare</button>', script)
        self.assertNotIn('>Prepared</button>', script)

    def test_matching_loans_remain_owned_by_their_rooms_and_collect_together(self):
        self.login('admin')
        source_item = {
            'departmentCode': 'AX',
            'department': 'Audio Department',
            'brand': 'TestBrand',
            'model': 'ModelA',
            'description': 'ModelA description',
            'quantity': 1,
            'isCustom': False,
        }
        self.event.subprojects = [
            {
                'id': 'main',
                'name': 'Main Room',
                'items': [{**source_item, 'lineId': 'main-a'}],
            },
            {
                'id': 'breakout',
                'name': 'Breakout',
                'items': [{**source_item, 'lineId': 'breakout-a'}],
            },
        ]
        self.event.prepared_items = [
            '[MODEL]AX|TestBrand|ModelA|2|ModelA description'
        ]

        for room_id in ('main', 'breakout'):
            response = self.client.post(
                f'/api/events/{self.event.event_id}/models/loan',
                json={
                    'source': {
                        'department': 'AX',
                        'brand': 'TestBrand',
                        'model': 'ModelA',
                        'description': 'ModelA description',
                    },
                    'quantity': 1,
                    'company': 'Rental Co',
                    'subprojectId': room_id,
                },
            )
            self.assertEqual(response.status_code, 200, response.get_data(as_text=True))

        loan_ids = [
            ref for ref in self.event.prepared_items
            if (app_module._parse_custom_marker(ref) or {}).get('type') == 'LOAN'
        ]
        self.assertEqual(len(loan_ids), 2)
        self.assertNotEqual(loan_ids[0], loan_ids[1])
        self.assertEqual(self.event.subprojects[0]['items'][0]['assetRefs'], [loan_ids[0]])
        self.assertEqual(self.event.subprojects[1]['items'][0]['assetRefs'], [loan_ids[1]])

        collected = self.client.post(
            f'/api/events/{self.event.event_id}/custom-assets/collect',
            json={'assetIds': loan_ids},
        )
        self.assertEqual(collected.status_code, 200, collected.get_data(as_text=True))
        self.assertEqual(collected.get_json()['data']['collectedCount'], 2)
        self.assertEqual(set(self.event.custom_collected), set(loan_ids))

    def test_loan_collection_and_preparation_are_separate_reversible_steps(self):
        self.login('admin')
        loan_id = app_module._make_custom_marker(
            'LOAN',
            'Rental Receiver',
            1,
            'AX',
            company='Rental Co',
        )
        self.event.prepared_items = [loan_id]
        self.data_manager.save_event(self.event)

        collected = self.client.post(
            f'/api/events/{self.event.event_id}/custom-assets/collect',
            json={'assetId': loan_id},
        )
        self.assertEqual(collected.status_code, 200, collected.get_data(as_text=True))
        self.assertIn(loan_id, self.event.custom_collected)
        self.assertNotIn(loan_id, self.event.actually_prepared)

        prepared = self.client.post(
            f'/api/events/{self.event.event_id}/prepare',
            json={'assetId': loan_id},
        )
        self.assertEqual(prepared.status_code, 200, prepared.get_data(as_text=True))
        self.assertIn(loan_id, self.event.custom_collected)
        self.assertIn(loan_id, self.event.actually_prepared)

        blocked_uncollect = self.client.post(
            f'/api/events/{self.event.event_id}/custom-assets/uncollect',
            json={'assetId': loan_id},
        )
        self.assertEqual(blocked_uncollect.status_code, 400)
        self.assertIn('Unprepare', blocked_uncollect.get_json()['error'])
        self.assertIn(loan_id, self.event.custom_collected)
        self.assertIn(loan_id, self.event.actually_prepared)

        unprepared = self.client.post(
            f'/api/events/{self.event.event_id}/unprepare',
            json={'assetId': loan_id},
        )
        self.assertEqual(unprepared.status_code, 200, unprepared.get_data(as_text=True))
        self.assertIn(loan_id, self.event.custom_collected)
        self.assertNotIn(loan_id, self.event.actually_prepared)

        uncollected = self.client.post(
            f'/api/events/{self.event.event_id}/custom-assets/uncollect',
            json={'assetId': loan_id},
        )
        self.assertEqual(uncollected.status_code, 200, uncollected.get_data(as_text=True))
        self.assertNotIn(loan_id, self.event.custom_collected)
        self.assertNotIn(loan_id, self.event.actually_prepared)

    def test_event_asset_rows_use_visible_neutral_dividers(self):
        project_root = os.path.dirname(os.path.dirname(__file__))
        with open(
            os.path.join(project_root, 'templates', 'index.html'),
            encoding='utf-8',
        ) as template_file:
            template = template_file.read()

        plan_rows = template.split('.plan-result-row,', 1)[1].split('}', 1)[0]
        prepare_custom = template.split('.prepare-new-custom-row {', 1)[1].split('}', 1)[0]
        prepare_models = template.split('.prepare-new-model {', 1)[1].split('}', 1)[0]
        return_rows = template.split('.return-asset-row {', 2)[2].split('}', 1)[0]

        for row_style in (plan_rows, prepare_custom, prepare_models, return_rows):
            self.assertIn('2px solid #dce2ea', row_style)

    def test_plan_can_add_first_subproject_without_losing_existing_items(self):
        self.login('admin')
        custom = app_module._make_custom_marker(
            'MISC',
            'Lectern',
            1,
            'AX',
        )
        self.event.prepared_items = [
            '[MODEL]AX|TestBrand|ModelA|3|ModelA description',
            custom,
            'A#01',
        ]
        self.event.actually_prepared = [
            '[PREPARED]AX|TestBrand|ModelA|1|ModelA description',
            'A#01',
        ]
        self.event.subprojects = []
        self.data_manager.save_event(self.event)

        response = self.client.post(
            f'/api/events/{self.event.event_id}/subprojects',
            json={'name': 'Breakout Room'},
        )

        self.assertEqual(response.status_code, 201, response.get_data(as_text=True))
        rooms = response.get_json()['data']['subprojects']
        self.assertEqual([room['name'] for room in rooms], ['Main Room', 'Breakout Room'])
        self.assertEqual(rooms[0]['items'][0]['quantity'], 3)
        self.assertEqual(rooms[0]['items'][0]['brand'], 'TestBrand')
        self.assertEqual(rooms[0]['items'][0]['preparedQuantity'], 1)
        self.assertIn('A#01', rooms[0]['items'][0]['assetRefs'])
        self.assertTrue(any(item.get('isCustom') for item in rooms[0]['items']))
        self.assertEqual(rooms[1]['items'], [])
        self.assertEqual(self.event.prepared_items[0], '[MODEL]AX|TestBrand|ModelA|3|ModelA description')

    def test_plan_subproject_names_are_required_and_unique(self):
        self.login('admin')
        created = self.client.post(
            f'/api/events/{self.event.event_id}/subprojects',
            json={'name': 'Breakout Room'},
        )
        self.assertEqual(created.status_code, 201, created.get_data(as_text=True))

        duplicate = self.client.post(
            f'/api/events/{self.event.event_id}/subprojects',
            json={'name': ' breakout room '},
        )
        missing = self.client.post(
            f'/api/events/{self.event.event_id}/subprojects',
            json={'name': '   '},
        )
        self.assertEqual(duplicate.status_code, 409)
        self.assertEqual(missing.status_code, 400)

    def test_plan_subproject_can_be_renamed_but_not_duplicated(self):
        self.login('admin')
        self.event.subprojects = [
            {'id': 'main', 'name': 'Main Room', 'items': []},
            {'id': 'breakout', 'name': 'Breakout', 'items': []},
        ]

        renamed = self.client.patch(
            f'/api/events/{self.event.event_id}/subprojects/breakout',
            json={'name': 'Ballroom'},
        )
        duplicate = self.client.patch(
            f'/api/events/{self.event.event_id}/subprojects/breakout',
            json={'name': ' main room '},
        )

        self.assertEqual(renamed.status_code, 200, renamed.get_data(as_text=True))
        self.assertEqual(self.event.subprojects[1]['name'], 'Ballroom')
        self.assertEqual(duplicate.status_code, 409)
        self.assertEqual(self.event.subprojects[1]['name'], 'Ballroom')

    def test_plan_subprojects_can_be_reordered(self):
        self.login('admin')
        self.event.subprojects = [
            {'id': 'main', 'name': 'Main Room', 'items': []},
            {'id': 'breakout', 'name': 'Breakout', 'items': []},
            {'id': 'stage', 'name': 'Stage', 'items': []},
        ]

        reordered = self.client.post(
            f'/api/events/{self.event.event_id}/subprojects/reorder',
            json={
                'orderedSubprojectIds': ['stage', 'main', 'breakout'],
            },
        )

        self.assertEqual(reordered.status_code, 200, reordered.get_data(as_text=True))
        self.assertEqual(
            [room['id'] for room in self.event.subprojects],
            ['stage', 'main', 'breakout'],
        )

    def test_plan_subproject_reorder_requires_every_room_once(self):
        self.login('admin')
        self.event.subprojects = [
            {'id': 'main', 'name': 'Main Room', 'items': []},
            {'id': 'breakout', 'name': 'Breakout', 'items': []},
        ]

        missing = self.client.post(
            f'/api/events/{self.event.event_id}/subprojects/reorder',
            json={'orderedSubprojectIds': ['main']},
        )
        duplicate = self.client.post(
            f'/api/events/{self.event.event_id}/subprojects/reorder',
            json={'orderedSubprojectIds': ['main', 'main']},
        )

        self.assertEqual(missing.status_code, 400)
        self.assertEqual(duplicate.status_code, 400)
        self.assertEqual(
            [room['id'] for room in self.event.subprojects],
            ['main', 'breakout'],
        )

    def test_subproject_delete_can_merge_requirements_and_assignments(self):
        self.login('admin')
        self.event.subprojects = [
            {
                'id': 'main',
                'name': 'Main Room',
                'items': [{
                    'departmentCode': 'AX',
                    'brand': 'TestBrand',
                    'model': 'ModelA',
                    'description': 'ModelA description',
                    'quantity': 2,
                    'preparedQuantity': 0,
                    'assetRefs': [],
                }],
            },
            {
                'id': 'breakout',
                'name': 'Breakout',
                'items': [{
                    'departmentCode': 'AX',
                    'brand': 'TestBrand',
                    'model': 'ModelA',
                    'description': 'ModelA description',
                    'quantity': 1,
                    'preparedQuantity': 1,
                    'assetRefs': ['A#01'],
                }],
            },
        ]
        self.event.prepared_items = [
            '[MODEL]AX|TestBrand|ModelA|3|ModelA description'
        ]
        self.event.actually_prepared = ['A#01']

        response = self.client.delete(
            f'/api/events/{self.event.event_id}/subprojects/breakout',
            json={'mode': 'merge', 'targetSubprojectId': 'main'},
        )

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertEqual(len(self.event.subprojects), 1)
        main_item = self.event.subprojects[0]['items'][0]
        self.assertEqual(main_item['quantity'], 3)
        self.assertEqual(main_item['preparedQuantity'], 1)
        self.assertEqual(main_item['assetRefs'], ['A#01'])
        self.assertIn('A#01', self.event.actually_prepared)

    def test_subproject_delete_can_remove_its_assets_from_event(self):
        self.login('admin')
        self.event.subprojects = [
            {
                'id': 'main',
                'name': 'Main Room',
                'items': [{
                    'departmentCode': 'AX',
                    'brand': 'TestBrand',
                    'model': 'ModelA',
                    'description': 'ModelA description',
                    'quantity': 2,
                }],
            },
            {
                'id': 'breakout',
                'name': 'Breakout',
                'items': [{
                    'departmentCode': 'AX',
                    'brand': 'TestBrand',
                    'model': 'ModelA',
                    'description': 'ModelA description',
                    'quantity': 1,
                    'assetRefs': ['A#01'],
                }],
            },
        ]
        self.event.prepared_items = [
            '[MODEL]AX|TestBrand|ModelA|3|ModelA description'
        ]
        self.event.actually_prepared = ['A#01']
        self.data_manager.inventory['A#01'].current_location = self.event.name

        response = self.client.delete(
            f'/api/events/{self.event.event_id}/subprojects/breakout',
            json={'mode': 'remove'},
        )

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertNotIn('A#01', self.event.actually_prepared)
        self.assertEqual(
            self.data_manager.inventory['A#01'].current_location,
            'Store',
        )
        self.assertIn(
            '[MODEL]AX|TestBrand|ModelA|2|ModelA description',
            self.event.prepared_items,
        )

    def test_subproject_content_can_move_to_the_viewed_room(self):
        self.login('admin')
        self.event.subprojects = [
            {
                'id': 'main',
                'name': 'Main Room',
                'items': [{
                    'departmentCode': 'AX',
                    'brand': 'TestBrand',
                    'model': 'ModelA',
                    'description': 'ModelA description',
                    'quantity': 1,
                    'assetRefs': ['A#01'],
                }],
            },
            {
                'id': 'breakout',
                'name': 'Breakout',
                'items': [{
                    'departmentCode': 'AX',
                    'brand': 'TestBrand',
                    'model': 'ModelA',
                    'description': 'ModelA description',
                    'quantity': 2,
                    'assetRefs': [],
                }],
            },
        ]
        self.event.prepared_items = [
            '[MODEL]AX|TestBrand|ModelA|3|ModelA description'
        ]
        self.event.actually_prepared = ['A#01']

        moved = self.client.post(
            f'/api/events/{self.event.event_id}/subprojects/move',
            json={
                'sourceSubprojectId': 'main',
                'targetSubprojectId': 'breakout',
                'kind': 'asset',
                'assetRef': 'A#01',
            },
        )
        self.assertEqual(moved.status_code, 200, moved.get_data(as_text=True))
        self.assertEqual(self.event.subprojects[0]['items'][0]['assetRefs'], [])
        self.assertEqual(
            self.event.subprojects[1]['items'][0]['assetRefs'],
            ['A#01'],
        )

        requirement = self.client.post(
            f'/api/events/{self.event.event_id}/subprojects/move',
            json={
                'sourceSubprojectId': 'main',
                'targetSubprojectId': 'breakout',
                'kind': 'requirement',
                'group': {
                    'department': 'AX',
                    'brand': 'TestBrand',
                    'model': 'ModelA',
                    'description': 'ModelA description',
                },
            },
        )
        self.assertEqual(requirement.status_code, 200, requirement.get_data(as_text=True))
        self.assertEqual(self.event.subprojects[0]['items'], [])
        self.assertEqual(self.event.subprojects[1]['items'][0]['quantity'], 3)

    def test_plan_resolution_assignees_and_company_onboarding_controls_exist(self):
        project_root = os.path.dirname(os.path.dirname(__file__))
        script = APP_BUNDLE_SOURCE

        self.assertIn("/models/replace`, 'POST'", script)
        self.assertIn("/models/loan`, 'POST'", script)
        self.assertIn('function planOpenResolution(', script)
        self.assertIn("planSetResolutionMode('replace')", script)
        self.assertIn("planSetResolutionMode('loan')", script)
        self.assertIn('id="planLoanCompany"', script)
        self.assertIn('function planConvertRequirementToLoan(event)', script)
        self.assertIn("planUseReplacementQuantity('short')", script)
        self.assertIn("planUseReplacementQuantity('all')", script)
        self.assertIn('function planAdjustReplacementQuantity(delta)', script)
        self.assertIn('sourceQuantity: maxQuantity', script)
        self.assertIn('function planRequirementWarning(group)', script)
        self.assertIn("warning.type === 'degraded' ? 'requires-degraded' : 'has-shortage'", script)
        self.assertIn('class="plan-shortage-info ${', script)
        self.assertIn('class="plan-replace-slot"', script)
        self.assertIn('>Resolve</button>', script)
        self.assertIn("planShowRequirementWarning(", script)
        self.assertIn("planEncode(JSON.stringify(warning))", script)
        self.assertIn("Already used by overlapping events", script)
        self.assertIn("plan-warning-event-quantity", script)
        self.assertIn("'Total inventory'", script)
        self.assertIn("healthyCapacityForThisEvent", script)
        self.assertIn('capacityForThisEvent', script)
        self.assertIn('function planDegradedReasonDetail(availability)', script)
        self.assertIn('Why the degraded assets are degraded:', script)
        self.assertIn('Math.max(0, usable)', script)
        self.assertIn("onclick=\"assignAllEventAssignees('${context}')\"", script)
        self.assertIn('user?.isActive !== false', script)
        self.assertNotIn('await showCompanyBrandingPromptIfNeeded();', script)
        self.assertIn("initialSection = 'pdf-settings'", script)
        self.assertIn('class="inventory-onboarding-empty"', script)

        with open(
            os.path.join(project_root, 'templates', 'index.html'),
            encoding='utf-8',
        ) as template_file:
            template = template_file.read()

        self.assertIn('.plan-requirement-row.requires-degraded', template)
        self.assertIn('background:var(--theme-primary,var(--brand-main,#0f766e));', template)
        self.assertIn('.plan-resolution-mode button[aria-checked="false"] { color:#334155; }', template)
        self.assertNotIn('var(--plan-primary)', template)
        self.assertIn('grid-template-columns: minmax(150px, 1.05fr) minmax(130px, 1fr) 66px auto auto;', template)
        self.assertIn('.plan-qty-control input[type="number"]::-webkit-inner-spin-button', template)
        self.assertIn('-webkit-appearance: none;', template)

    def test_event_detail_actions_are_shared_by_all_workspaces(self):
        project_root = os.path.dirname(os.path.dirname(__file__))
        script = APP_BUNDLE_SOURCE
        with open(
            os.path.join(project_root, 'templates', 'index.html'),
            encoding='utf-8',
        ) as template_file:
            template = template_file.read()

        self.assertEqual(
            script.count('${eventDetailsActionsHtml(event.id)}'),
            3,
        )
        self.assertIn('async function openEventActivityLog(eventId)', script)
        for category in ('details', 'prepare', 'return', 'manpower'):
            self.assertIn(f'.event-activity-{category}', template)

    def test_sidebar_navigation_has_one_logout_and_clean_finance_labels(self):
        project_root = os.path.dirname(os.path.dirname(__file__))
        with open(
            os.path.join(project_root, 'templates', 'index.html'),
            encoding='utf-8',
        ) as template_file:
            template = template_file.read()
        with open(
            os.path.join(project_root, 'static', 'js', 'finance.js'),
            encoding='utf-8',
        ) as finance_file:
            finance_source = finance_file.read()
        app_source = APP_BUNDLE_SOURCE

        self.assertEqual(
            template.count('<button type="button" class="nav-item" onclick="logout()">'),
            1,
        )
        self.assertNotIn('data-mark="LO"', template)
        self.assertNotIn('data-label="Logout"', template)
        self.assertIn('data-section="quotations">Quotations', finance_source)
        self.assertIn('data-section="profit-loss">Profit &amp; Loss', finance_source)
        self.assertNotIn('>▤ Quotations', finance_source)
        self.assertNotIn('>◉ Profit &amp; Loss', finance_source)
        self.assertIn("quotations: '<path", app_source)
        self.assertIn("'profit-loss': '<path", app_source)
        self.assertIn("companiesTab.dataset.label = 'Companies'", app_source)

    def test_only_current_prepare_workspace_is_rendered(self):
        self.login('admin')
        response = self.client.get('/events')
        page = response.get_data(as_text=True)

        self.assertEqual(response.status_code, 200)
        self.assertIn("showSection('prepare-new')", page)
        self.assertIn('id="prepare-new-section" class="content-section"', page)
        self.assertIn('id="prepare-new-page-root"', page)
        self.assertNotIn("showSection('prepare')", page)
        self.assertNotIn('Prepare (Legacy)', page)
        self.assertNotIn('id="prepare-section"', page)

        script = APP_BUNDLE_SOURCE

        self.assertIn('async function loadPrepareNewPage()', script)
        self.assertIn('async function prepareNewApplyRealtimeEvent(event)', script)
        self.assertIn("case \"prepare-new\":", script)
        self.assertIn("planOpenEventChooser('prepare-new')", script)
        self.assertIn("'prepare': 'prepare-new'", script)
        self.assertIn("if (sectionName === 'prepare') sectionName = 'prepare-new'", script)
        self.assertIn('function openPrepareWorkspaceForEvent(eventId)', script)
        self.assertIn('function openReturnWorkspaceForEvent(eventId)', script)
        return_action = script.split('function openReturnWorkspaceForEvent(eventId)', 1)[1].split(
            'function closeEventCardMenus', 1
        )[0]
        self.assertIn('returnPageState.eventId = id;', return_action)
        self.assertIn('returnPageState.loaded = false;', return_action)
        self.assertIn("showSection('return', { eventId: id });", return_action)
        self.assertNotIn('openReturnAssetsModalWithEvent', script)
        self.assertNotIn('function renderReturnEventsTable', script)
        self.assertNotIn('function renderReturnEventsCards', script)
        self.assertNotIn('id="returnAssetsModalNew"', page)
        self.assertNotIn('id="returnAssetModal"', page)
        self.assertNotIn('id="returnAssetsModal"', page)
        self.assertNotIn("switchEditTab('assets')", script)

    def test_shared_event_chooser_expands_for_a_full_ten_event_page(self):
        project_root = os.path.dirname(app_module.__file__)
        template = Path(project_root, 'templates', 'index.html').read_text(encoding='utf-8')
        script = APP_BUNDLE_SOURCE

        self.assertIn('pageSize: 10', script)
        self.assertIn(
            'max-height: min(940px, calc(var(--scaled-dvh, 100dvh) - 24px));',
            template,
        )
        self.assertNotIn('.modal-content.plan-event-chooser-full-page', template)
        self.assertNotIn("'plan-event-chooser-full-page'", script)
        self.assertIn('.filter(filter => Number(counts[filter.key] || 0) > 0)', script)
        self.assertIn("planEventChooserState.filter !== 'ALL'", script)
        chooser = script.split('function ensurePlanEventChooserModal()', 1)[1].split(
            'function planOpenEventChooser', 1
        )[0]
        relative_date = script.split('function planEventChooserRelativeDate(event)', 1)[1].split(
            'function planEventChooserSourceEvents()', 1
        )[0]
        self.assertIn('class="plan-badge plan-event-option-id', chooser)
        self.assertIn("'plan-badge-type-dry-hire' : 'plan-badge-type-event'", chooser)
        self.assertIn('class="plan-event-option-location-line"', chooser)
        self.assertNotIn('${planEventTypeBadgeHtml(event)}', chooser)
        self.assertNotIn('<span>Location</span>', chooser)
        self.assertIn("['ongoing', 'last-day'].includes(state)", relative_date)
        self.assertIn('day${daysLeft === 1', relative_date)

    def test_return_inventory_rows_offer_fault_logging_but_custom_rows_do_not(self):
        script = APP_BUNDLE_SOURCE

        can_log_fault = script.split('function returnPageCanLogFault', 1)[1].split(
            'async function returnPageLogFault', 1
        )[0]
        log_fault = script.split('async function returnPageLogFault', 1)[1].split(
            'function returnPageAssetRowHtml', 1
        )[0]
        return_row = script.split('function returnPageAssetRowHtml', 1)[1].split(
            'function returnPageRenderFilteredAssets', 1
        )[0]

        self.assertIn('!custom && !asset?.isLoanOrMisc', can_log_fault)
        self.assertIn('openBulkMaintenanceFaultModal(inventoryId)', log_fault)
        self.assertIn('openMaintenanceModalForAsset(inventoryId)', log_fault)
        self.assertIn("logType.value = 'Fault'", log_fault)
        self.assertIn('returnPageCanLogFault(asset)', return_row)
        self.assertIn('returnPageLogFault(', return_row)
        self.assertIn('Log fault', return_row)

    def test_return_page_encodes_apostrophes_used_in_inline_asset_actions(self):
        script = APP_BUNDLE_SOURCE
        encoder = script.split('function returnPageEncode(value)', 1)[1].split(
            'function returnPageDecode(value)', 1
        )[0]
        return_workspace = script.split('function returnPageEncode(value)', 1)[1].split(
            'function initializeReturnPage()', 1
        )[0]

        self.assertIn(".replace(/'/g, '%27')", encoder)
        self.assertIn('const encodedId = returnPageEncode(asset.id)', return_workspace)
        self.assertIn("returnPageReturnAsset('${escapeHtmlAttr(encodedId)}', this)", return_workspace)
        self.assertIn("returnPageUnreturnAsset('${escapeHtmlAttr(encodedId)}', this)", return_workspace)

    def test_prepare_workspace_keeps_returned_requirements_in_prepared_progress(self):
        script = APP_BUNDLE_SOURCE
        prepare_totals = script.split('function prepareNewTotals', 1)[1].split(
            'function prepareNewSubprojectNeedsAttention', 1
        )[0]
        prepare_model = script.split('function prepareNewModelSection', 1)[1].split(
            'function prepareNewDirectAssetCard', 1
        )[0]

        self.assertIn('function prepareNewPreparedEverQuantity(group)', script)
        self.assertIn('function prepareNewCountablePreparedEverQuantity(group)', script)
        self.assertIn('prepareNewCountablePreparedEverQuantity(row)', prepare_totals)
        self.assertIn('prepareNewPreparedEverQuantity(group)', prepare_model)
        self.assertIn('prepareNewCountablePreparedEverQuantity(group)', prepare_model)
        self.assertIn('preparedEverQuantity: assigned', script)
        self.assertIn('countablePreparedEverQuantity: Math.min(required, countableAssigned)', script)

    def test_delivery_order_editor_uses_catalog_departments_and_stable_deletes(self):
        self.login('admin')
        response = self.client.get('/delivery-order')
        page = response.get_data(as_text=True)

        self.assertEqual(response.status_code, 200)
        self.assertIn('class="form-container do-details-panel"', page)
        self.assertIn('id="deliveryItemsPreview"', page)
        self.assertIn('class="do-document-grid"', page)
        self.assertIn('class="do-recipient-grid"', page)
        self.assertIn('id="doEventContext"', page)
        self.assertIn('id="btnKnownClients"', page)
        self.assertIn('id="generatePdfBtn">Export PDF</button>', page)
        self.assertNotIn('generateExcelBtn', page)
        self.assertNotIn("generateDeliveryOrder('excel')", page)

        script = APP_BUNDLE_SOURCE

        self.assertIn('function getDeliveryOrderAssetCatalog()', script)
        self.assertIn("id: 'doCatalogSearch'", script)
        self.assertIn('function deliveryOrderAddItemKeydown(event)', script)
        self.assertIn("showbaseLineWorkspace.selectFirstSuggestion('doCatalogResults')", script)
        self.assertIn(
            "onkeydown: \"showbaseLineWorkspace.suggestionKeydown(event,'doCatalogDepartmentResults')\"",
            script,
        )
        self.assertIn(
            "onkeydown=\"showbaseLineWorkspace.suggestionKeydown(event,this.closest('.do-line-category-combobox')?.querySelector('.do-line-category-suggestions'))\"",
            script,
        )
        self.assertIn('showbaseLineWorkspace.addRowMarkup({', script)
        self.assertIn('groupAction: "financeOpenLineGroupEditor(\'delivery-order\')"', script)
        self.assertIn('class="finance-lines-table do-line-table showbase-category-table"', script)
        self.assertIn('class="finance-line-row finance-line-group-header finance-group-commercial-row do-line-group-header"', script)
        self.assertIn('function deliveryOrderGroupWorkingLines()', script)
        self.assertIn('function deliveryOrderNewGroupedLine(selected, category, subprojectId)', script)
        self.assertIn('function deliveryOrderCommitLineGroup(groupId, subprojectId, groupedLines)', script)
        finance_script = Path('static/js/finance.js').read_text(encoding='utf-8')
        self.assertIn(
            "deliveryOrderCommitLineGroup(groupId, groupSubprojectId, grouped);",
            finance_script
        )
        self.assertIn('deliveryOrderSubprojectTabsMarkup(event)', script)
        self.assertIn("<th>Item</th>", script)
        self.assertIn("<th>Quantity</th>", script)
        self.assertIn('class="finance-line-input do-dept"', script)
        self.assertIn('function deliveryOrderDepartmentControlMarkup(', script)
        self.assertIn('function deliveryOrderRenderLineDepartmentSuggestions(control)', script)
        self.assertIn('function deliveryOrderCommitLineDepartment(control)', script)
        self.assertNotIn('<select class="finance-line-input do-dept"', script)
        self.assertIn('data-custom-id=', script)
        self.assertIn('function removeDeliveryOrderItem(eventId, { key, kind, customId })', script)
        self.assertIn('function removeDeliveryOrderRow(button)', script)
        self.assertIn('function normaliseDoOrdering(items, storedOrdering = [])', script)
        self.assertIn('function deliveryOrderAlphabeticalItems(items)', script)
        self.assertIn('function deliveryOrderAssetsBeforeMiscellaneous(items)', script)
        self.assertIn('function deliveryOrderItemIsMiscellaneous(item)', script)
        self.assertIn(': deliveryOrderAlphabeticalItems(items);', script)
        self.assertIn('const hasStoredOrdering = Array.isArray(storedOrdering) && storedOrdering.length > 0;', script)
        self.assertIn('return hasStoredOrdering\n    ? orderedItems\n    : deliveryOrderAssetsBeforeMiscellaneous(orderedItems);', script)
        self.assertIn("catalogKey: `inventory|${key}`", script)
        self.assertIn('sourceAssetIds: [...(selected?.sourceAssetIds || [])]', script)
        self.assertIn('async function deliveryOrderAddCatalogItem()', script)
        self.assertIn('state.custom[department].push({', script)
        self.assertIn('await populateDeliveryItemsPreview(event);', script)
        self.assertIn('deliveryOrderEditorState.pendingRevealKey = rowKey;', script)
        self.assertIn('visibleRow.scrollIntoView({', script)
        self.assertIn('could not be displayed in ${department}', script)
        self.assertIn("results.classList.add('open');", script)
        self.assertIn("results.classList.remove('open');", script)
        self.assertIn('function deliveryOrderCatalogDisplayName(item)', script)
        self.assertIn('Press Add to create this as a custom item.', script)
        self.assertIn('function mergeDoWorkspaceConflict(', script)
        self.assertIn('onclick="return removeDeliveryOrderRow(this)"', script)
        self.assertIn('state.deleted[key] = true;', script)
        self.assertIn('item.id || `legacy-${dept}-${index}`', script)
        self.assertIn('function deliveryOrderAutosaveLine(control)', script)
        self.assertIn('onchange="deliveryOrderAutosaveLine(this)"', script)
        self.assertIn('function saveDoEdits(eventId, data, options = {})', script)
        self.assertIn('if (options.immediate === true)', script)
        self.assertGreaterEqual(script.count('saveDoEdits(eventId, state, { immediate: true })'), 5)
        self.assertIn('flushDoEdits(eventId).catch(() => {});', script)
        self.assertIn('id="doResetEdits"', script)
        delivery_preview = script.split('async function populateDeliveryItemsPreview(event)', 1)[1].split(
            'function groupItemsByDepartment(event', 1
        )[0]
        self.assertLess(
            delivery_preview.index('<div class="do-category-list showbase-category-stack">'),
            delivery_preview.index('<div class="do-composer-toolbar">')
        )
        self.assertNotIn('class="btn do-save"', script)
        self.assertNotIn('id="doEditToggle"', script)
        self.assertIn('class="do-dept-count"', script)
        self.assertIn('function generateDeliveryOrder()', script)
        self.assertIn('function renderDeliveryOrderLetterheadHtml()', script)
        self.assertIn('function renderDeliveryOrderDocumentHeaderHtml(data, formattedDate, options = {})', script)
        self.assertIn('const continuation = options.continuation === true;', script)
        self.assertIn('const continuationHeaderHtml = renderDeliveryOrderDocumentHeaderHtml(', script)
        self.assertIn("{ continuation: true }", script)
        self.assertIn('function deliveryOrderDepartmentHeaderLabel(department)', script)
        self.assertIn('class="do-recipient-panel"', script)
        self.assertIn('class="do-job-band"', script)
        self.assertIn('class="asset-id-line"', script)
        self.assertIn('class="do-pdf-category-heading"', script)
        self.assertIn('class="do-pdf-group-row${record.item.isContinuation', script)
        self.assertIn('class="do-pdf-group-child-row', script)
        self.assertIn('class="quantity-col do-pdf-group-child-quantity-cell"', script)
        self.assertIn("' is-custom-text' : ''}\">${quantity}${description}${renderAssetIdsLine(record.item.assetIds)}</div>", script)
        self.assertIn('.items-table .do-pdf-group-row .quantity-col {', script)
        self.assertIn('.do-pdf-group-child-quantity {\n            font-weight: 400;', script)
        self.assertIn("String(item.description || 'Item').trim()", script)
        self.assertIn('groupDisplayEntries = (items, groupId)', script)
        self.assertIn('groupCustomText: customText', script)
        self.assertIn("do-pdf-group-child-description${record.item.groupCustomText ? ' is-custom-text' : ''}", script)
        self.assertIn("description: item.groupTitle || 'Group'", script)
        self.assertIn('const groupQuantity = Math.max(1, Number(item.groupHeaderQuantity) || 1)', script)
        self.assertIn('quantity: entry.quantity * groupQuantity', script)
        self.assertIn('function deliveryOrderGroupQuantityChange(encodedGroupId, value)', script)
        self.assertIn('groupHeaderQuantity: Math.max(1, Number(ci.groupHeaderQuantity) || 1)', script)
        self.assertIn('function continuationGroupRecord(startIndex)', script)
        self.assertIn("record.item.isContinuation ? ' (continued)' : ''", script)
        self.assertIn("record.item.isBeforeCustomText ? ' is-before-custom-text' : ''", script)
        self.assertIn('function getAssetIdsByItem(event, item, department, options = {})', script)
        self.assertIn('const allocatedAssetIds = new Set();', script)
        self.assertIn('excludedIds: allocatedAssetIds', script)
        self.assertIn('ids.forEach(id => allocatedAssetIds.add(String(id)))', script)
        self.assertIn('.filter(id => !excludedIds.has(String(id)))', script)
        self.assertIn('(line.assetRefs || []).map(String)', script)
        self.assertIn('const linkedIds = withinDeliveryOrderQuantity(item.assetRefs);', script)
        self.assertIn('(item.sourceAssetIds || []).filter(id => recordsById.has(String(id)))', script)
        self.assertIn('.slice(0, deliveryOrderQuantity);', script)
        self.assertIn("id.startsWith('[BULK]')", script)
        self.assertIn("id.startsWith('[MODEL]')", script)
        self.assertIn('border-left: 0.5pt solid #cbd5e1 !important;', script)
        self.assertIn('<col><col class="quantity-column">', script)
        self.assertIn("audio: 'Audio Department'", script)
        self.assertIn('Date of delivery/collection', script)
        self.assertIn('Phone no.', script)
        self.assertIn('Page ${pageNumber} of ${totalPages}', script)
        self.assertIn('const COMMENTS_BOTTOM_MM = 43;', script)
        self.assertIn('const finalSectionHeight = normaliseMeasuredHeight(', script)
        self.assertIn('while (index < records.length)', script)
        self.assertIn('if (canFitRemaining(index, finalBudget))', script)
        self.assertIn('let result = fillPage(index, normalBudget);', script)
        self.assertIn('if (result.nextIndex >= records.length)', script)
        self.assertNotIn('let lastPageStart = records.length - 1;', script)
        self.assertIn("pageIndex === 0 ? firstPageHeaderHtml : continuationHeaderHtml", script)
        self.assertIn('class="signature-space"', script)
        self.assertIn('class="signature-label">Company\'s Stamp &amp; Signature', script)
        self.assertIn('padding: 0.9mm 2.7mm;', script)
        self.assertIn('.items-table tr {\n            page-break-inside: avoid;', script)
        self.assertIn('.do-pdf-category {\n                page-break-inside: auto;', script)
        self.assertIn('font-size: 12pt;\n            font-weight: 700;', script)
        self.assertIn('deliveryOrderSubprojects(event).forEach(room => {', script)
        self.assertIn('applyDoOrdering(roomItems, d, eventId, roomId)', script)
        self.assertIn('class="do-drag-handle" draggable="true"', script)
        self.assertIn('<colgroup><col><col class="do-category-column"><col class="do-quantity-column"><col class="do-action-column"></colgroup>', script)
        self.assertNotIn('do-item-row${groupChild ? \' finance-group-child-row\' : \'\'}${deliveryOrderEditorState.pendingRevealKey === item.key ? \' is-new\' : \'\'}" draggable="true"', script)
        self.assertIn('const roomSpareQuantity = (room, line) => {', script)
        self.assertIn('Math.max(0, Number(line.quantity || 0)) + roomSpareQuantity(room, line)', script)
        self.assertIn("Math.max(0, Number(mg.extraPreparedQuantity || 0))", script)
        self.assertNotIn('function generateExcelDO(', script)
        self.assertNotIn('xlsx.full.min.js', script)
        self.assertNotIn('do-item-price', script)

        export_source = script.split('async function generateDeliveryOrder()', 1)[1].split(
            'function generatePdfDO(data, doWindow)', 1
        )[0]
        self.assertNotIn('deliveryOrderCaptureDocument(', export_source)
        self.assertIn('await flushDoEdits(', export_source)
        self.assertLess(export_source.index("window.open('', '_blank')"), export_source.index('await flushDoEdits('))
        self.assertIn('function doWorkspaceContentEqual(left, right)', script)
        self.assertIn('const localHasPendingChanges = !!localWorkspace && (', script)
        self.assertIn('localVersion === serverVersion', script)
        self.assertIn('!doWorkspaceContentEqual(localWorkspace, serverWorkspace)', script)
        self.assertIn('--do-category-width:110px;--do-quantity-width:54px;--do-action-width:34px;', page)
        self.assertIn('.do-item-row td { padding:1px 2px;color:#2d433d;vertical-align:middle; }', page)
        self.assertIn('.do-line-category-suggestions { top:calc(100% + 3px);bottom:auto;max-height:210px; }', page)
        self.assertIn('.finance-group-child-row .showbase-group-custom-text { width:100%;text-align:left; }', page)
        self.assertIn('.finance-group-child-row:has(+ .do-group-custom-text-row) td { padding-bottom:0; }', page)
        self.assertIn('.do-group-custom-text-row td { padding-top:0; }', page)
        self.assertNotIn('.do-item-row .finance-line-input {', page)
        self.assertIn('.do-action-cell .do-del { width:22px;height:22px;padding:0; }', page)
        self.assertIn("value: '',\n      placeholder: 'Category'", script)
        self.assertIn("document.getElementById('doCatalogDepartment')?.value||''", script)
        self.assertIn('id="financeLineGroupQuantityField" hidden', finance_script)
        self.assertIn("mode === 'delivery-order' ? { groupHeaderQuantity: groupQuantity } : {}", finance_script)
        self.assertIn("showNotification('warning', 'Choose a category before adding the item')", script)
        self.assertNotIn("selected?.department || 'MISC'", script)

    def test_delivery_order_workspace_persists_without_changing_event_requirements(self):
        self.login('admin')
        self.event.asset_models = [{
            'department': 'AX',
            'brand': 'TestBrand',
            'model': 'ModelA',
            'description': 'ModelA description',
            'requiredQuantity': 3,
        }]
        self.event.subprojects = [{
            'id': 'main',
            'name': 'Main Room',
            'items': [{
                'lineId': 'main-model-a',
                'departmentCode': 'AX',
                'brand': 'TestBrand',
                'model': 'ModelA',
                'description': 'ModelA description',
                'quantity': 3,
                'isCustom': False,
            }],
        }]
        self.data_manager.save_event(self.event)
        original_models = json.loads(json.dumps(self.event.asset_models))
        original_rooms = json.loads(json.dumps(self.event.subprojects))
        workspace = {
            'document': {'doNumber': 'DO-TEST-01', 'clientName': 'Client'},
            'overrides': {
                'ROOM|main|main-model-a': {
                    'description': 'Client-facing item name',
                    'quantity': 2,
                    'department': 'Audio',
                },
            },
            'custom': {
                'Audio': [{
                    'id': 'do-line-1',
                    'description': 'DO-only cable loom',
                    'quantity': 1,
                    'subprojectId': 'main',
                    'groupId': 'group-1',
                    'groupTitle': 'Cable package',
                    'groupHeaderQuantity': 4,
                }],
            },
            'ordering': {'main::Audio': ['DOCUSTOM|do-line-1', 'ROOM|main|main-model-a']},
            'subprojectOrder': ['main'],
        }

        saved = self.client.put(
            f'/api/events/{self.event.event_id}/delivery-order',
            json=workspace,
        )
        self.assertEqual(saved.status_code, 200, saved.get_data(as_text=True))
        saved_workspace = saved.get_json()['data']
        self.assertEqual(saved_workspace['document']['doNumber'], 'DO-TEST-01')
        self.assertEqual(saved_workspace['documentVersion'], 1)

        stale = self.client.put(
            f'/api/events/{self.event.event_id}/delivery-order',
            json={**workspace, 'expectedVersion': 0},
        )
        self.assertEqual(stale.status_code, 409, stale.get_data(as_text=True))
        self.assertEqual(stale.get_json()['code'], 'document_version_conflict')
        self.assertEqual(stale.get_json()['data']['document']['doNumber'], 'DO-TEST-01')
        self.assertEqual(self.event.asset_models, original_models)
        self.assertEqual(self.event.subprojects, original_rooms)

        reloaded = DataManager(self.tempdir.name)
        reloaded.load_events()
        self.assertEqual(
            reloaded.events[self.event.event_id].delivery_order['custom']['Audio'][0]['description'],
            'DO-only cable loom',
        )
        self.assertEqual(
            reloaded.events[self.event.event_id].delivery_order['custom']['Audio'][0]['groupHeaderQuantity'],
            4,
        )
        self.assertEqual(reloaded.events[self.event.event_id].asset_models, original_models)
        self.assertEqual(reloaded.events[self.event.event_id].subprojects, original_rooms)

        cleared = self.client.delete(
            f'/api/events/{self.event.event_id}/delivery-order?expectedVersion=1'
        )
        self.assertEqual(cleared.status_code, 200, cleared.get_data(as_text=True))
        cleared_workspace = cleared.get_json()['data']
        self.assertEqual(cleared_workspace['documentVersion'], 2)
        self.assertNotIn('document', cleared_workspace)
        self.assertNotIn('custom', cleared_workspace)

    def test_template_crud_is_company_local(self):
        self.login('admin')
        template = self.create_template()

        filepath = os.path.join(
            self.tempdir.name,
            app_module.PLANNING_TEMPLATES_FILENAME,
        )
        self.assertTrue(os.path.exists(filepath))
        with open(filepath, 'r', encoding='utf-8') as template_file:
            saved = json.load(template_file)
        self.assertEqual(saved['templates'][0]['name'], 'Standard')

        updated = self.client.put(
            f"/api/planning-templates/{template['id']}",
            json={
                'name': 'Updated Standard',
                'models': template['models'],
                'customAssets': template['customAssets'],
            },
        )
        self.assertEqual(updated.status_code, 200, updated.get_data(as_text=True))
        self.assertEqual(updated.get_json()['data']['name'], 'Updated Standard')

        deleted = self.client.delete(
            f"/api/planning-templates/{template['id']}"
        )
        self.assertEqual(deleted.status_code, 200, deleted.get_data(as_text=True))
        listed = self.client.get('/api/planning-templates')
        self.assertEqual(listed.get_json()['data'], [])

    def test_apply_without_requirements_adds_template_contents(self):
        self.login('admin')
        template = self.create_template()

        response = self.client.post(
            f'/api/events/{self.event.event_id}/apply-planning-template',
            json={'templateId': template['id'], 'mode': 'merge'},
        )

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertTrue(any(
            ref.startswith('[MODEL]AX|TestBrand|ModelA|2|')
            for ref in self.event.prepared_items
        ))
        custom = [
            app_module._parse_custom_marker(ref)
            for ref in self.event.prepared_items
        ]
        custom = [item for item in custom if item]
        self.assertEqual(custom[0]['name'], 'Rental Receiver')
        self.assertEqual(custom[0]['company'], 'Rental Co')

    def test_template_can_take_plan_beyond_physical_inventory(self):
        self.login('admin')
        self.event.prepared_items = [
            '[MODEL]AX|TestBrand|ModelA|6|ModelA description',
        ]
        template = self.create_template()

        response = self.client.post(
            f'/api/events/{self.event.event_id}/apply-planning-template',
            json={'templateId': template['id'], 'mode': 'merge'},
        )

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertTrue(any(
            ref.startswith('[MODEL]AX|TestBrand|ModelA|8|')
            for ref in self.event.prepared_items
        ))

    def test_custom_item_description_round_trips_and_can_be_edited(self):
        self.login('admin')
        created = self.client.post(
            f'/api/events/{self.event.event_id}/custom-assets',
            json={
                'name': 'Printed backdrop',
                'quantity': 2,
                'type': 'MISC',
                'department': 'LX',
                'description': 'Black fabric with client artwork',
            },
        )
        self.assertEqual(created.status_code, 200, created.get_data(as_text=True))
        old_marker = created.get_json()['data']['assetId']
        parsed = app_module._parse_custom_marker(old_marker)
        self.assertEqual(parsed['description'], 'Black fabric with client artwork')
        self.assertEqual(parsed['version'], 3)

        updated = self.client.put(
            f'/api/events/{self.event.event_id}/custom-assets/update-quantity',
            json={
                'assetId': old_marker,
                'newQuantity': 3,
                'name': 'Printed stage backdrop',
                'type': 'LOAN',
                'department': 'AX',
                'company': 'Backdrop Rental Co',
                'description': '',
            },
        )
        self.assertEqual(updated.status_code, 200, updated.get_data(as_text=True))
        new_marker = updated.get_json()['newAssetId']
        parsed = app_module._parse_custom_marker(new_marker)
        self.assertEqual(parsed['name'], 'Printed stage backdrop')
        self.assertEqual(parsed['quantity'], 3)
        self.assertEqual(parsed['type'], 'LOAN')
        self.assertEqual(parsed['department'], 'AX')
        self.assertEqual(parsed['company'], 'Backdrop Rental Co')
        self.assertNotIn(old_marker, self.event.prepared_items)
        self.assertIn(new_marker, self.event.prepared_items)
        action = self.event.event_logs[-1]['action']
        self.assertNotIn('[CUSTOM]', action)
        self.assertIn('Printed backdrop (Black fabric with client artwork)', action)
        self.assertIn('Name: Printed backdrop -> Printed stage backdrop', action)
        self.assertIn('Company / source: - -> Backdrop Rental Co', action)

    def test_merge_adds_quantities_and_replace_preserves_physical_assets(self):
        self.login('admin')
        existing_custom = app_module._make_custom_marker(
            'MISC',
            'Old Custom',
            2,
            'LX',
        )
        self.event.prepared_items = [
            '[MODEL]AX|TestBrand|ModelA|1|ModelA description',
            existing_custom,
            'A#06',
        ]
        self.event.actually_prepared = [existing_custom, 'A#06']
        template = self.create_template()

        merged = self.client.post(
            f'/api/events/{self.event.event_id}/apply-planning-template',
            json={'templateId': template['id'], 'mode': 'merge'},
        )
        self.assertEqual(merged.status_code, 200, merged.get_data(as_text=True))
        self.assertTrue(any(
            ref.startswith('[MODEL]AX|TestBrand|ModelA|3|')
            for ref in self.event.prepared_items
        ))
        self.assertIn(existing_custom, self.event.prepared_items)

        replaced = self.client.post(
            f'/api/events/{self.event.event_id}/apply-planning-template',
            json={'templateId': template['id'], 'mode': 'replace'},
        )
        self.assertEqual(replaced.status_code, 200, replaced.get_data(as_text=True))
        self.assertTrue(any(
            ref.startswith('[MODEL]AX|TestBrand|ModelA|2|')
            for ref in self.event.prepared_items
        ))
        self.assertNotIn(existing_custom, self.event.prepared_items)
        self.assertNotIn(existing_custom, self.event.actually_prepared)
        self.assertIn('A#06', self.event.prepared_items)
        self.assertIn('A#06', self.event.actually_prepared)

    def test_container_adds_model_counts_without_assigning_asset_ids(self):
        self.login('admin')

        response = self.client.post(
            f'/api/events/{self.event.event_id}/container-models',
            json={'containerId': 'CASE #01'},
        )

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        body = response.get_json()['data']
        self.assertEqual(body['assetCount'], 3)
        self.assertEqual(body['modelCount'], 2)
        self.assertTrue(any(
            ref.startswith('[MODEL]AX|TestBrand|ModelA|2|')
            for ref in self.event.prepared_items
        ))
        self.assertTrue(any(
            ref.startswith('[MODEL]LX|TestBrand|ModelB|1|')
            for ref in self.event.prepared_items
        ))
        self.assertNotIn('A#01', self.event.prepared_items)
        self.assertNotIn('A#02', self.event.prepared_items)
        self.assertNotIn('B#01', self.event.prepared_items)

    def test_subproject_planning_updates_only_the_selected_room_and_aggregate(self):
        self.login('admin')
        self.event.subprojects = [
            {
                'id': 'main',
                'name': 'Main Room',
                'items': [{
                    'lineId': 'main-a',
                    'departmentCode': 'AX',
                    'department': 'Audio Department',
                    'brand': 'TestBrand',
                    'model': 'ModelA',
                    'description': 'ModelA description',
                    'quantity': 2,
                    'isCustom': False,
                }],
            },
            {
                'id': 'breakout',
                'name': 'Breakout',
                'items': [{
                    'lineId': 'breakout-a',
                    'departmentCode': 'AX',
                    'department': 'Audio Department',
                    'brand': 'TestBrand',
                    'model': 'ModelA',
                    'description': 'ModelA description',
                    'quantity': 1,
                    'isCustom': False,
                }],
            },
        ]
        self.event.prepared_items = [
            '[MODEL]AX|TestBrand|ModelA|3|ModelA description'
        ]

        response = self.client.put(
            f'/api/events/{self.event.event_id}/models',
            json={
                'department': 'AX',
                'brand': 'TestBrand',
                'model': 'ModelA',
                'description': 'ModelA description',
                'quantity': 3,
                'subprojectId': 'breakout',
            },
        )

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertEqual(self.event.subprojects[0]['items'][0]['quantity'], 2)
        self.assertEqual(self.event.subprojects[1]['items'][0]['quantity'], 3)
        self.assertIn(
            '[MODEL]AX|TestBrand|ModelA|5|ModelA description',
            self.event.prepared_items,
        )

    def test_subproject_prepare_quantity_tracks_the_selected_room(self):
        self.login('admin')
        self.event.subprojects = [
            {
                'id': 'main',
                'name': 'Main Room',
                'items': [{
                    'lineId': 'main-a',
                    'departmentCode': 'AX',
                    'brand': 'TestBrand',
                    'model': 'ModelA',
                    'description': 'ModelA description',
                    'quantity': 2,
                    'isCustom': False,
                }],
            },
            {
                'id': 'breakout',
                'name': 'Breakout',
                'items': [{
                    'lineId': 'breakout-a',
                    'departmentCode': 'AX',
                    'brand': 'TestBrand',
                    'model': 'ModelA',
                    'description': 'ModelA description',
                    'quantity': 2,
                    'isCustom': False,
                }],
            },
        ]
        self.event.prepared_items = [
            '[MODEL]AX|TestBrand|ModelA|4|ModelA description'
        ]

        response = self.client.post(
            f'/api/events/{self.event.event_id}/prepare-model-quantity',
            json={
                'department': 'AX',
                'brand': 'TestBrand',
                'model': 'ModelA',
                'description': 'ModelA description',
                'action': 'prepare',
                'all': True,
                'subprojectId': 'breakout',
            },
        )

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertNotIn('preparedQuantity', self.event.subprojects[0]['items'][0])
        self.assertEqual(
            self.event.subprojects[1]['items'][0]['preparedQuantity'],
            2,
        )
        prepared_marker = next(
            app_module._parse_prepared_model_marker(ref)
            for ref in self.event.actually_prepared
            if app_module._parse_prepared_model_marker(ref)
        )
        self.assertEqual(prepared_marker['quantity'], 2)

    def test_subproject_exact_assignment_replaces_only_its_prepared_slot(self):
        self.login('admin')
        self.event.subprojects = [
            {
                'id': 'main',
                'name': 'Main Room',
                'items': [{
                    'lineId': 'main-a',
                    'departmentCode': 'AX',
                    'brand': 'TestBrand',
                    'model': 'ModelA',
                    'description': 'ModelA description',
                    'quantity': 1,
                    'isCustom': False,
                }],
            },
            {
                'id': 'breakout',
                'name': 'Breakout',
                'items': [{
                    'lineId': 'breakout-a',
                    'departmentCode': 'AX',
                    'brand': 'TestBrand',
                    'model': 'ModelA',
                    'description': 'ModelA description',
                    'quantity': 1,
                    'isCustom': False,
                }],
            },
        ]
        self.event.prepared_items = [
            '[MODEL]AX|TestBrand|ModelA|2|ModelA description'
        ]

        prepared = self.client.post(
            f'/api/events/{self.event.event_id}/prepare-model-quantity',
            json={
                'department': 'AX',
                'brand': 'TestBrand',
                'model': 'ModelA',
                'description': 'ModelA description',
                'action': 'prepare',
                'all': True,
                'subprojectId': 'breakout',
            },
        )
        self.assertEqual(prepared.status_code, 200, prepared.get_data(as_text=True))

        assigned = self.client.post(
            f'/api/events/{self.event.event_id}/assign-specific',
            json={'assetId': 'A#01', 'subprojectId': 'breakout'},
        )
        self.assertEqual(assigned.status_code, 200, assigned.get_data(as_text=True))
        breakout_item = self.event.subprojects[1]['items'][0]
        self.assertEqual(breakout_item['preparedQuantity'], 0)
        self.assertEqual(breakout_item['assetRefs'], ['A#01'])
        self.assertIn('A#01', self.event.actually_prepared)
        self.assertFalse(any(
            app_module._parse_prepared_model_marker(ref)
            for ref in self.event.actually_prepared
        ))

    def test_room_extras_are_scoped_and_promoted_when_requirement_increases(self):
        self.login('admin')
        self.event.subprojects = [
            {
                'id': 'main',
                'name': 'Main Room',
                'items': [{
                    'lineId': 'main-a',
                    'departmentCode': 'AX',
                    'brand': 'TestBrand',
                    'model': 'ModelA',
                    'description': 'ModelA description',
                    'quantity': 2,
                    'isCustom': False,
                    'assetRefs': [],
                }],
                'extraRefs': [],
            },
            {
                'id': 'room-2',
                'name': 'Room 2',
                'items': [{
                    'lineId': 'room-b',
                    'departmentCode': 'LX',
                    'brand': 'TestBrand',
                    'model': 'ModelB',
                    'description': 'ModelB description',
                    'quantity': 1,
                    'isCustom': False,
                    'assetRefs': [],
                }],
                'extraRefs': [],
            },
        ]
        self.event.prepared_items = [
            '[MODEL]AX|TestBrand|ModelA|2|ModelA description',
            '[MODEL]LX|TestBrand|ModelB|1|ModelB description',
        ]

        for asset_id in ('A#01', 'A#02'):
            response = self.client.post(
                f'/api/events/{self.event.event_id}/assign-specific',
                json={'assetId': asset_id, 'subprojectId': 'room-2'},
            )
            self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
            self.assertTrue(response.get_json()['data']['isExtra'])

        main_item = self.event.subprojects[0]['items'][0]
        room_two = self.event.subprojects[1]
        self.assertEqual(main_item['assetRefs'], [])
        self.assertEqual(room_two['extraRefs'], ['A#01', 'A#02'])
        self.assertEqual(self.event.extra_assets, ['A#01', 'A#02'])

        add_requirement = self.client.post(
            f'/api/events/{self.event.event_id}/models',
            json={
                'department': 'AX',
                'brand': 'TestBrand',
                'model': 'ModelA',
                'description': 'ModelA description',
                'quantity': 1,
                'subprojectId': 'room-2',
            },
        )
        self.assertEqual(
            add_requirement.status_code,
            200,
            add_requirement.get_data(as_text=True),
        )
        room_model = next(
            item for item in room_two['items']
            if item.get('model') == 'ModelA'
        )
        self.assertEqual(room_model['assetRefs'], ['A#01'])
        self.assertEqual(room_two['extraRefs'], ['A#02'])
        self.assertEqual(self.event.extra_assets, ['A#02'])
        self.assertNotIn('A#01', self.event.prepared_items)

        increase_requirement = self.client.put(
            f'/api/events/{self.event.event_id}/models',
            json={
                'department': 'AX',
                'brand': 'TestBrand',
                'model': 'ModelA',
                'description': 'ModelA description',
                'quantity': 2,
                'subprojectId': 'room-2',
            },
        )
        self.assertEqual(
            increase_requirement.status_code,
            200,
            increase_requirement.get_data(as_text=True),
        )
        self.assertEqual(room_model['assetRefs'], ['A#01', 'A#02'])
        self.assertEqual(room_two['extraRefs'], [])
        self.assertEqual(self.event.extra_assets, [])
        self.assertNotIn('A#02', self.event.prepared_items)
        self.assertEqual(main_item['assetRefs'], [])

        reduce_requirement = self.client.put(
            f'/api/events/{self.event.event_id}/models',
            json={
                'department': 'AX',
                'brand': 'TestBrand',
                'model': 'ModelA',
                'description': 'ModelA description',
                'quantity': 1,
                'subprojectId': 'room-2',
            },
        )
        self.assertEqual(
            reduce_requirement.status_code,
            200,
            reduce_requirement.get_data(as_text=True),
        )
        self.assertEqual(room_model['assetRefs'], ['A#01'])
        self.assertEqual(room_two['extraRefs'], ['A#02'])
        self.assertEqual(self.event.extra_assets, ['A#02'])
        self.assertEqual(main_item['assetRefs'], [])


if __name__ == '__main__':
    unittest.main()
