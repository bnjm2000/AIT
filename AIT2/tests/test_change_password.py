from datetime import datetime
import os
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
        self.original_company_registry_file = app_module.COMPANY_REGISTRY_FILE
        self.original_company_registry_cache = app_module._company_registry_cache
        self.tempdir = tempfile.TemporaryDirectory()

        registry = app_module._load_company_registry()
        app_module.COMPANY_REGISTRY_FILE = os.path.join(
            self.tempdir.name,
            'Companies.json',
        )
        app_module._company_registry_cache = None
        app_module._save_company_registry(registry)

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
        registry = app_module._load_company_registry()
        default_company = registry['defaultCompany']
        app_module._company_registry_cache = {
            **registry,
            'userCompanies': {
                **registry.get('userCompanies', {}),
                'normal': default_company,
                'admin': default_company,
                'manager': default_company,
            },
        }
        self.client = app_module.app.test_client()

    def tearDown(self):
        app_module.clear_test_data_manager(self.original_data_manager)
        app_module._data_snapshot_signature = self.original_signature
        app_module.app.config['TESTING'] = self.original_testing
        app_module.COMPANY_REGISTRY_FILE = self.original_company_registry_file
        app_module._company_registry_cache = self.original_company_registry_cache
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
        self.assertEqual(users['normal']['phone'], '')
        self.assertEqual(users['admin']['role'], 'admin')
        self.assertEqual(users['manager']['role'], 'manager')

    def test_admin_can_update_user_name_and_phone(self):
        with self.client.session_transaction() as session:
            session['user'] = 'admin'
            session['is_admin'] = True
            session['is_active'] = True

        response = self.client.put('/api/users/normal', json={
            'username': 'normal',
            'name': 'Normal User',
            'phone': '9123 4567',
            'isActive': True,
        })

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertEqual(self.data_manager.users['normal'].name, 'Normal User')
        self.assertEqual(self.data_manager.users['normal'].phone, '+65 9123 4567')

        reloaded_manager = DataManager(self.tempdir.name)
        reloaded_manager.load_users()
        self.assertEqual(reloaded_manager.users['normal'].name, 'Normal User')
        self.assertEqual(reloaded_manager.users['normal'].phone, '+65 9123 4567')

        response = self.client.get('/api/users')
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        users = {user['username']: user for user in response.get_json()['data']}
        self.assertEqual(users['normal']['name'], 'Normal User')
        self.assertEqual(users['normal']['phone'], '+65 9123 4567')

        invalid = self.client.put('/api/users/normal', json={'phone': '+65 123'})
        self.assertEqual(invalid.status_code, 400, invalid.get_data(as_text=True))
        self.assertEqual(self.data_manager.users['normal'].phone, '+65 9123 4567')

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

    def test_last_company_admin_cannot_demote_self_until_another_admin_exists(self):
        with self.client.session_transaction() as session:
            session['user'] = 'admin'
            session['is_admin'] = True
            session['role'] = 'admin'
            session['is_active'] = True

        blocked = self.client.put('/api/users/admin', json={'role': 'manager'})

        self.assertEqual(blocked.status_code, 409, blocked.get_data(as_text=True))
        self.assertIn('another admin', blocked.get_json()['error'])
        self.assertEqual(self.data_manager.users['admin'].role, 'admin')

        replacement = User(
            'replacement-admin',
            hash_password('pw', 'replacement-salt'),
            'replacement-salt',
            True,
            True,
            role='admin',
        )
        self.data_manager.users[replacement.username] = replacement
        self.data_manager.save_users()
        registry = app_module._load_company_registry()
        registry['userCompanies'][replacement.username] = registry['defaultCompany']
        app_module._company_registry_cache = registry

        allowed = self.client.put('/api/users/admin', json={'role': 'manager'})

        self.assertEqual(allowed.status_code, 200, allowed.get_data(as_text=True))
        self.assertEqual(self.data_manager.users['admin'].role, 'manager')

    def test_last_company_admin_cannot_deactivate_self(self):
        with self.client.session_transaction() as session:
            session['user'] = 'admin'
            session['is_admin'] = True
            session['role'] = 'admin'
            session['is_active'] = True

        response = self.client.put('/api/users/admin', json={'isActive': False})

        self.assertEqual(response.status_code, 409, response.get_data(as_text=True))
        self.assertTrue(self.data_manager.users['admin'].is_active)

    def test_owner_can_change_and_delete_a_company_last_admin(self):
        owner = User(
            'showbase-owner',
            hash_password('owner-password', 'owner-salt'),
            'owner-salt',
            True,
            True,
            role='owner',
        )
        self.data_manager.users[owner.username] = owner
        self.data_manager.save_users()
        registry = app_module._load_company_registry()
        default_company = registry['defaultCompany']
        registry['superAdmins'] = [owner.username]
        registry['userCompanies'][owner.username] = default_company
        app_module._company_registry_cache = registry

        with self.client.session_transaction() as session:
            session['user'] = owner.username
            session['is_admin'] = True
            session['role'] = 'owner'
            session['is_active'] = True
            session['is_super_admin'] = True
            session['company_code'] = default_company

        demoted = self.client.put('/api/users/admin', json={'role': 'manager'})
        self.assertEqual(demoted.status_code, 200, demoted.get_data(as_text=True))
        self.assertEqual(self.data_manager.users['admin'].role, 'manager')

        restored = self.client.put('/api/users/admin', json={'role': 'admin'})
        self.assertEqual(restored.status_code, 200, restored.get_data(as_text=True))
        deleted = self.client.delete('/api/users/admin')
        self.assertEqual(deleted.status_code, 200, deleted.get_data(as_text=True))
        self.assertNotIn('admin', self.data_manager.users)


if __name__ == '__main__':
    unittest.main()
