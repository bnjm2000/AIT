import tempfile
import unittest
from urllib.parse import quote

import app as app_module
from data_manager import DataManager
from maintenance_logs import make_maintenance_log, normalize_maintenance_log
from models import Container, Event, InventoryItem, LogEntry, User, hash_password


class UserRenameHistoryTests(unittest.TestCase):
    def setUp(self):
        self.original_data_manager = app_module.get_default_data_manager()
        self.original_signature = app_module._data_snapshot_signature
        self.original_testing = app_module.app.config.get('TESTING')
        self.tempdir = tempfile.TemporaryDirectory()

        self.data_manager = DataManager(self.tempdir.name)
        self.data_manager.setup_data_folder()
        self.data_manager.users = {
            'admin': User('admin', hash_password('pw', 'salt'), 'salt', True, True),
            'tech-old': User('tech-old', hash_password('pw', 'salt'), 'salt', False, True),
        }
        self.data_manager.save_users()

        self.data_manager.logs = [
            LogEntry('2026/05/01 09:00:00', 'tech-old', 'User tech-old logged in via web interface'),
            LogEntry('2026/05/01 09:05:00', 'admin', 'Reset password for user tech-old'),
            LogEntry('2026/05/01 09:10:00', 'admin', 'Manual note mentions tech-old'),
        ]
        self.data_manager.save_logs()

        event = Event(
            1,
            'Rename Test',
            '20260501',
            '20260501',
            [],
            prepared_items=[],
            returned_items=[],
            actually_prepared=[],
            extra_assets=[],
            tag='events',
            event_logs=[
                {
                    'timestamp': '2026/05/01 10:00:00',
                    'user': 'tech-old',
                    'action': 'User tech-old forced event 1 (Rename Test) state from Planning to Closed',
                },
                {
                    'timestamp': '2026/05/01 10:05:00',
                    'user': 'admin',
                    'action': 'Manual event note mentions tech-old',
                },
            ],
        )
        self.data_manager.events[1] = event
        self.data_manager.save_event(event)

        self.asset_id = 'A#01'
        self.data_manager.inventory[self.asset_id] = InventoryItem(
            asset_id=self.asset_id,
            brand='Test',
            model_number='Model',
            serial_number='SN123',
            description='Rename history asset',
            is_missing=False,
            maintenance_logs=[
                make_maintenance_log('2026/05/01', 'tech-old', 'Tightened clamp'),
                make_maintenance_log(
                    '2026/05/01',
                    'tech-old',
                    'Asset sighted by tech-old during Asset Check',
                    log_type='Asset check',
                    source={'kind': 'asset_check_sighting', 'checkId': 'check-1'},
                ),
                make_maintenance_log('2026/05/01', 'admin', 'Manual note mentions tech-old'),
            ],
            department_code='AX',
            default_location='Store',
            current_location='Store',
        )
        self.data_manager.save_inventory()

        self.data_manager.containers['CASE-1'] = Container(
            'CASE-1',
            [self.asset_id],
            maintenance_logs=[
                make_maintenance_log('2026/05/01', 'tech-old', 'Checked case wheels'),
            ],
        )
        self.data_manager.save_containers()

        app_module.app.config['TESTING'] = True
        app_module.set_data_manager_for_testing(self.data_manager)
        self.client = app_module.app.test_client()

    def tearDown(self):
        app_module.clear_test_data_manager(self.original_data_manager)
        app_module._data_snapshot_signature = self.original_signature
        app_module.app.config['TESTING'] = self.original_testing
        self.tempdir.cleanup()

    def login_as_admin(self):
        with self.client.session_transaction() as session:
            session['user'] = 'admin'
            session['is_admin'] = True

    def test_renaming_user_updates_logs_and_maintenance_records(self):
        self.login_as_admin()

        response = self.client.put(
            f'/api/users/{quote("tech-old", safe="")}',
            json={'username': 'tech-new'},
        )

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertEqual(response.get_json()['data']['username'], 'tech-new')

        self.data_manager.load_all_data()

        self.assertNotIn('tech-old', self.data_manager.users)
        self.assertIn('tech-new', self.data_manager.users)

        self.assertEqual(self.data_manager.logs[0].user, 'tech-new')
        self.assertEqual(self.data_manager.logs[0].action, 'User tech-new logged in via web interface')
        self.assertEqual(self.data_manager.logs[1].action, 'Reset password for user tech-new')
        self.assertEqual(self.data_manager.logs[2].action, 'Manual note mentions tech-old')
        self.assertIn('Renamed user tech-old -> tech-new', self.data_manager.logs[-1].action)

        event_logs = self.data_manager.events[1].event_logs
        self.assertEqual(event_logs[0]['user'], 'tech-new')
        self.assertIn('User tech-new forced event 1', event_logs[0]['action'])
        self.assertEqual(event_logs[1]['action'], 'Manual event note mentions tech-old')

        maintenance_logs = [
            normalize_maintenance_log(log)
            for log in self.data_manager.inventory[self.asset_id].maintenance_logs
        ]
        self.assertEqual(maintenance_logs[0]['user'], 'tech-new')
        self.assertEqual(maintenance_logs[0]['description'], 'Tightened clamp')
        self.assertEqual(maintenance_logs[1]['user'], 'tech-new')
        self.assertEqual(
            maintenance_logs[1]['description'],
            'Asset sighted by tech-new during Asset Check'
        )
        self.assertEqual(maintenance_logs[2]['user'], 'admin')
        self.assertEqual(maintenance_logs[2]['description'], 'Manual note mentions tech-old')

        container_log = normalize_maintenance_log(
            self.data_manager.containers['CASE-1'].maintenance_logs[0]
        )
        self.assertEqual(container_log['user'], 'tech-new')
        self.assertEqual(container_log['description'], 'Checked case wheels')


if __name__ == '__main__':
    unittest.main()
