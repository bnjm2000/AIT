import json
import os
import tempfile
import unittest

import app as app_module
from data_manager import DataManager
from models import Container, Event, InventoryItem, User, hash_password


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
        response = self.client.get('/')
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
        script_path = os.path.join(
            os.path.dirname(os.path.dirname(__file__)),
            'static',
            'js',
            'app.js',
        )
        with open(script_path, encoding='utf-8') as script_file:
            script = script_file.read()

        self.assertIn(
            "planPageState.eventId = Number(eventId) || null;\n"
            "  showSection('plan');",
            script,
        )
        self.assertNotIn('Manage Assets', script)

    def test_prepare_trial_and_legacy_workspaces_are_both_available(self):
        self.login('admin')
        response = self.client.get('/')
        page = response.get_data(as_text=True)

        self.assertEqual(response.status_code, 200)
        self.assertIn("showSection('prepare-new')", page)
        self.assertIn('id="prepare-new-section" class="content-section"', page)
        self.assertIn('id="prepare-new-page-root"', page)
        self.assertIn("showSection('prepare')", page)
        self.assertIn('Prepare (Legacy)', page)

        script_path = os.path.join(
            os.path.dirname(os.path.dirname(__file__)),
            'static',
            'js',
            'app.js',
        )
        with open(script_path, encoding='utf-8') as script_file:
            script = script_file.read()

        self.assertIn('async function loadPrepareNewPage()', script)
        self.assertIn('async function prepareNewApplyRealtimeEvent(event)', script)
        self.assertIn("case \"prepare-new\":", script)
        self.assertIn("planOpenEventChooser('prepare-new')", script)
        self.assertIn("'prepare (legacy)': 'prepare'", script)
        self.assertIn("'prepare': 'prepare-new'", script)
        self.assertIn('function openPrepareWorkspaceForEvent(eventId)', script)
        self.assertIn('function openReturnWorkspaceForEvent(eventId)', script)
        self.assertIn(
            "returnPageState.eventId = Number(eventId) || null;\n"
            "  showSection('return');",
            script,
        )
        self.assertNotIn('openReturnAssetsModalWithEvent', script)
        self.assertNotIn('function renderReturnEventsTable', script)
        self.assertNotIn('function renderReturnEventsCards', script)
        self.assertNotIn('id="returnAssetsModalNew"', page)
        self.assertNotIn('id="returnAssetModal"', page)
        self.assertNotIn('id="returnAssetsModal"', page)
        self.assertNotIn("switchEditTab('assets')", script)

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


if __name__ == '__main__':
    unittest.main()
