from datetime import datetime
import tempfile
import unittest

import app as app_module
from data_manager import DataManager
from models import User, hash_password


class ChangePasswordTests(unittest.TestCase):
    def setUp(self):
        self.original_data_manager = app_module.get_default_data_manager()
        self.original_signature = app_module._data_snapshot_signature
        self.original_testing = app_module.app.config.get('TESTING')
        self.tempdir = tempfile.TemporaryDirectory()

        self.data_manager = DataManager(self.tempdir.name)
        self.data_manager.setup_data_folder()
        self.data_manager.users = {
            'normal': User('normal', hash_password('old-password', 'salt'), 'salt', False, True),
            'admin': User('admin', hash_password('admin-password', 'admin-salt'), 'admin-salt', True, True),
            'manager': User(
                'manager',
                hash_password('manager-password', 'manager-salt'),
                'manager-salt',
                True,
                True,
                role='manager',
            ),
        }
        self.data_manager.save_users()
        self.data_manager.logs = []
        self.data_manager.save_logs()

        app_module.app.config['TESTING'] = True
        app_module.set_data_manager_for_testing(self.data_manager)
        self.client = app_module.app.test_client()

    def tearDown(self):
        app_module.clear_test_data_manager(self.original_data_manager)
        app_module._data_snapshot_signature = self.original_signature
        app_module.app.config['TESTING'] = self.original_testing
        self.tempdir.cleanup()

    def login(self):
        with self.client.session_transaction() as session:
            session['user'] = 'normal'
            session['is_admin'] = False

    def test_current_user_can_change_own_password(self):
        self.login()

        response = self.client.put('/api/current-user/password', json={
            'currentPassword': 'old-password',
            'newPassword': 'new-password',
        })

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))

        user = self.data_manager.users['normal']
        self.assertEqual(hash_password('new-password', user.salt), user.password_hash)
        self.assertNotEqual(hash_password('old-password', user.salt), user.password_hash)
        self.assertEqual(self.data_manager.logs[-1].action, 'Changed own password')

    def test_wrong_current_password_does_not_change_password(self):
        self.login()

        response = self.client.put('/api/current-user/password', json={
            'currentPassword': 'wrong-password',
            'newPassword': 'new-password',
        })

        self.assertEqual(response.status_code, 403, response.get_data(as_text=True))

        user = self.data_manager.users['normal']
        self.assertEqual(hash_password('old-password', user.salt), user.password_hash)
        self.assertEqual(self.data_manager.logs, [])

    def test_successful_login_records_and_persists_last_online(self):
        self.assertEqual(self.data_manager.users['normal'].last_online, '-')

        response = self.client.post('/login', json={
            'username': 'normal',
            'password': 'old-password',
        })

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        last_online = self.data_manager.users['normal'].last_online
        self.assertNotEqual(last_online, '-')
        datetime.fromisoformat(last_online)

        reloaded_manager = DataManager(self.tempdir.name)
        reloaded_manager.load_users()
        self.assertEqual(reloaded_manager.users['normal'].last_online, last_online)

    def test_failed_login_leaves_last_online_unchanged(self):
        response = self.client.post('/login', json={
            'username': 'normal',
            'password': 'wrong-password',
        })

        self.assertEqual(response.status_code, 401, response.get_data(as_text=True))
        self.assertEqual(self.data_manager.users['normal'].last_online, '-')

    def test_users_api_exposes_default_last_online_value(self):
        with self.client.session_transaction() as session:
            session['user'] = 'admin'
            session['is_admin'] = True
            session['is_active'] = True

        response = self.client.get('/api/users')

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        users = {user['username']: user for user in response.get_json()['data']}
        self.assertEqual(users['normal']['lastOnline'], '-')
        self.assertEqual(users['normal']['name'], '')
        self.assertEqual(users['admin']['role'], 'admin')
        self.assertEqual(users['manager']['role'], 'manager')

    def test_admin_can_update_user_name(self):
        with self.client.session_transaction() as session:
            session['user'] = 'admin'
            session['is_admin'] = True
            session['is_active'] = True

        response = self.client.put('/api/users/normal', json={
            'username': 'normal',
            'name': 'Normal User',
            'isActive': True,
        })

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertEqual(self.data_manager.users['normal'].name, 'Normal User')

        reloaded_manager = DataManager(self.tempdir.name)
        reloaded_manager.load_users()
        self.assertEqual(reloaded_manager.users['normal'].name, 'Normal User')

        response = self.client.get('/api/users')
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        users = {user['username']: user for user in response.get_json()['data']}
        self.assertEqual(users['normal']['name'], 'Normal User')

    def test_admin_can_change_roles_but_manager_cannot(self):
        with self.client.session_transaction() as session:
            session['user'] = 'admin'
            session['is_admin'] = True
            session['is_active'] = True

        response = self.client.put('/api/users/normal', json={
            'role': 'manager',
            'hasSalesAccess': True,
        })

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertEqual(self.data_manager.users['normal'].role, 'manager')
        self.assertTrue(self.data_manager.users['normal'].has_sales_access)

        with self.client.session_transaction() as session:
            session['user'] = 'manager'
            session['is_admin'] = True
            session['is_active'] = True

        response = self.client.put('/api/users/normal', json={
            'role': 'admin',
            'hasSalesAccess': False,
        })

        self.assertEqual(response.status_code, 403, response.get_data(as_text=True))
        self.assertEqual(self.data_manager.users['normal'].role, 'manager')
        self.assertTrue(self.data_manager.users['normal'].has_sales_access)


if __name__ == '__main__':
    unittest.main()
