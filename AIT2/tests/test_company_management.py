import os
import tempfile
import unittest

import app as app_module
from data_manager import DataManager
from models import LogEntry, User, hash_password


class CompanyManagementTests(unittest.TestCase):
    def setUp(self):
        self.original_base_dir = app_module.BASE_DIR
        self.original_app_config_folder = app_module.APP_CONFIG_FOLDER
        self.original_company_registry_file = app_module.COMPANY_REGISTRY_FILE
        self.original_global_users_file = app_module.GLOBAL_USERS_FILE
        self.original_company_registry_cache = app_module._company_registry_cache
        self.original_company_data_managers = dict(app_module._company_data_managers)
        self.original_active_company_code = app_module._active_company_code
        self.original_data_manager = app_module.get_default_data_manager()
        self.original_signature = app_module._data_snapshot_signature
        self.original_testing = app_module.app.config.get('TESTING')

        self.tempdir = tempfile.TemporaryDirectory()
        app_module.BASE_DIR = self.tempdir.name
        app_module.APP_CONFIG_FOLDER = os.path.join(self.tempdir.name, 'app_data')
        app_module.COMPANY_REGISTRY_FILE = os.path.join(app_module.APP_CONFIG_FOLDER, 'Companies.json')
        app_module.GLOBAL_USERS_FILE = os.path.join(app_module.APP_CONFIG_FOLDER, 'Users.csv')
        app_module._company_registry_cache = None
        app_module._company_data_managers.clear()
        os.makedirs(app_module.APP_CONFIG_FOLDER, exist_ok=True)

        avpl_record = app_module._new_company_record('AVPL', 'Avec')
        tsc_record = app_module._new_company_record('TSC', 'The Show Company')
        registry = {
            'defaultCompany': 'AVPL',
            'companies': {
                'AVPL': avpl_record,
                'TSC': tsc_record,
            },
            'userCompanies': {
                'bnjm2000': 'AVPL',
                'chief': 'TSC',
                'tech': 'TSC',
            },
            'superAdmins': ['bnjm2000', 'chief'],
        }
        app_module._save_company_registry(registry)

        for record in (avpl_record, tsc_record):
            app_module._ensure_company_folders(record)

        tsc_backend = app_module._company_record_backend_folder(tsc_record)
        with open(os.path.join(tsc_backend, 'AssetList.csv'), 'w', encoding='utf-8') as f:
            f.write('Internal ID,Brand,Model\nT#01,Test,Asset\n')

        self.data_manager = DataManager(
            app_module._company_record_backend_folder(avpl_record),
            users_file=app_module.GLOBAL_USERS_FILE,
        )
        self.data_manager.setup_data_folder()
        self.data_manager.users = {
            'bnjm2000': User('bnjm2000', hash_password('pw', 'salt'), 'salt', True, True),
            'chief': User('chief', hash_password('pw', 'chiefsalt'), 'chiefsalt', True, True),
            'tech': User('tech', hash_password('pw', 'techsalt'), 'techsalt', False, True),
        }
        self.data_manager.save_users()
        self.data_manager.logs = []
        self.data_manager.save_logs()

        app_module._active_company_code = 'AVPL'
        app_module.app.config['TESTING'] = True
        app_module.set_data_manager_for_testing(self.data_manager)
        self.client = app_module.app.test_client()

    def tearDown(self):
        app_module.clear_test_data_manager(self.original_data_manager)
        app_module.BASE_DIR = self.original_base_dir
        app_module.APP_CONFIG_FOLDER = self.original_app_config_folder
        app_module.COMPANY_REGISTRY_FILE = self.original_company_registry_file
        app_module.GLOBAL_USERS_FILE = self.original_global_users_file
        app_module._company_registry_cache = self.original_company_registry_cache
        app_module._company_data_managers.clear()
        app_module._company_data_managers.update(self.original_company_data_managers)
        app_module._active_company_code = self.original_active_company_code
        app_module._data_snapshot_signature = self.original_signature
        app_module.app.config['TESTING'] = self.original_testing
        self.tempdir.cleanup()

    def login_super_admin(self):
        with self.client.session_transaction() as session:
            session['user'] = 'bnjm2000'
            session['is_admin'] = True
            session['is_super_admin'] = True
            session['company_code'] = 'AVPL'

    def test_super_admin_can_delete_company_folder_and_assigned_users(self):
        self.login_super_admin()
        target_folder = os.path.join(self.tempdir.name, 'companies', 'TSC')
        self.assertTrue(os.path.exists(target_folder))

        response = self.client.delete('/api/companies/TSC')

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertFalse(os.path.exists(target_folder))
        self.assertNotIn('tech', self.data_manager.users)
        self.assertIn('chief', self.data_manager.users)

        registry = app_module._load_company_registry()
        self.assertNotIn('TSC', registry['companies'])
        self.assertEqual(registry['userCompanies']['chief'], 'AVPL')
        self.assertNotIn('tech', registry['userCompanies'])

    def test_super_admin_cannot_delete_active_company(self):
        self.login_super_admin()

        response = self.client.delete('/api/companies/AVPL')

        self.assertEqual(response.status_code, 400, response.get_data(as_text=True))
        self.assertIn('active company', response.get_json()['error'])
        self.assertTrue(os.path.exists(os.path.join(self.tempdir.name, 'companies', 'AVPL')))

    def test_super_admin_can_edit_company_name_without_changing_code_or_folders(self):
        self.login_super_admin()
        original_folder = os.path.join(self.tempdir.name, 'companies', 'TSC')

        response = self.client.put('/api/companies/TSC', json={'name': 'TSC Events'})

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertEqual(response.get_json()['data']['code'], 'TSC')
        self.assertEqual(response.get_json()['data']['name'], 'TSC Events')
        self.assertTrue(os.path.exists(original_folder))
        registry = app_module._load_company_registry()
        self.assertEqual(registry['companies']['TSC']['name'], 'TSC Events')

    def test_super_admin_can_edit_company_code_without_breaking_references(self):
        self.login_super_admin()
        original_folder = os.path.join(self.tempdir.name, 'companies', 'TSC')
        renamed_folder = os.path.join(self.tempdir.name, 'companies', 'EVT')
        self.assertTrue(os.path.exists(os.path.join(original_folder, 'backend', 'AssetList.csv')))

        response = self.client.put('/api/companies/TSC', json={
            'code': 'EVT',
            'name': 'Events Team',
        })

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        payload = response.get_json()['data']
        self.assertEqual(payload['code'], 'EVT')
        self.assertEqual(payload['previousCode'], 'TSC')
        self.assertEqual(payload['name'], 'Events Team')
        self.assertFalse(os.path.exists(original_folder))
        self.assertTrue(os.path.exists(os.path.join(renamed_folder, 'backend', 'AssetList.csv')))

        registry = app_module._load_company_registry()
        self.assertNotIn('TSC', registry['companies'])
        self.assertIn('EVT', registry['companies'])
        self.assertEqual(registry['companies']['EVT']['name'], 'Events Team')
        self.assertEqual(registry['userCompanies']['chief'], 'EVT')
        self.assertEqual(registry['userCompanies']['tech'], 'EVT')
        self.assertEqual(registry['defaultCompany'], 'AVPL')
        self.assertNotIn('TSC', app_module._company_data_managers)

    def test_super_admin_can_rename_active_company_reference(self):
        self.login_super_admin()
        original_folder = os.path.join(self.tempdir.name, 'companies', 'AVPL')
        renamed_folder = os.path.join(self.tempdir.name, 'companies', 'AVEC')

        response = self.client.put('/api/companies/AVPL', json={
            'code': 'AVEC',
            'name': 'Avec Events',
        })

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertFalse(os.path.exists(original_folder))
        self.assertTrue(os.path.exists(renamed_folder))
        self.assertEqual(app_module._active_company_code, 'AVEC')
        with self.client.session_transaction() as session:
            self.assertEqual(session['company_code'], 'AVEC')

        registry = app_module._load_company_registry()
        self.assertEqual(registry['defaultCompany'], 'AVEC')
        self.assertEqual(registry['userCompanies']['bnjm2000'], 'AVEC')
        self.assertIn('AVEC', registry['companies'])
        self.assertNotIn('AVPL', registry['companies'])

        persisted_registry = app_module._company_registry_cache
        app_module._company_registry_cache = None
        try:
            reloaded = app_module._load_company_registry()
            self.assertIn('AVEC', reloaded['companies'])
            self.assertNotIn('AVPL', reloaded['companies'])
            self.assertEqual(reloaded['userCompanies']['bnjm2000'], 'AVEC')
        finally:
            app_module._company_registry_cache = persisted_registry

    def test_owner_actions_do_not_create_system_or_event_logs(self):
        self.data_manager.logs = []
        self.data_manager.save_logs()

        with app_module.app.test_request_context('/'):
            app_module.session['user'] = 'bnjm2000'
            app_module.session['is_super_admin'] = True
            app_module.session['company_code'] = 'AVPL'
            app_module.log_action('Updated company details')
            app_module.log_action('Updated event 999', user='bnjm2000')

        self.assertEqual(self.data_manager.logs, [])

    def test_owner_renaming_user_updates_the_users_assigned_company_history(self):
        self.login_super_admin()
        tsc_manager = app_module._get_company_data_manager('TSC')
        tsc_manager.logs = [
            LogEntry(
                '2026/07/13 20:00:00',
                'tech',
                'User tech updated an assigned event',
            )
        ]
        tsc_manager.save_logs()

        response = self.client.put('/api/users/tech', json={'username': 'tech-renamed'})

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        tsc_manager.load_logs()
        self.assertEqual(tsc_manager.logs[0].user, 'tech-renamed')
        self.assertIn('User tech-renamed', tsc_manager.logs[0].action)
        registry = app_module._load_company_registry()
        self.assertEqual(registry['userCompanies']['tech-renamed'], 'TSC')
        self.assertNotIn('tech', registry['userCompanies'])

    def test_user_management_hides_owners_from_non_owners(self):
        self.data_manager.users['admin-avpl'] = User(
            'admin-avpl', hash_password('pw', 'adminsalt'), 'adminsalt', True, True
        )
        self.data_manager.save_users()
        registry = app_module._load_company_registry()
        registry['userCompanies']['admin-avpl'] = 'AVPL'
        app_module._save_company_registry(registry)

        with self.client.session_transaction() as session:
            session['user'] = 'admin-avpl'
            session['is_admin'] = True
            session['is_super_admin'] = False
            session['company_code'] = 'AVPL'

        admin_response = self.client.get('/api/users')
        self.assertEqual(admin_response.status_code, 200, admin_response.get_data(as_text=True))
        admin_usernames = {row['username'] for row in admin_response.get_json()['data']}
        self.assertIn('admin-avpl', admin_usernames)
        self.assertNotIn('bnjm2000', admin_usernames)
        self.assertNotIn('chief', admin_usernames)

        self.login_super_admin()
        owner_response = self.client.get('/api/users')
        self.assertEqual(owner_response.status_code, 200, owner_response.get_data(as_text=True))
        owner_usernames = {row['username'] for row in owner_response.get_json()['data']}
        self.assertIn('bnjm2000', owner_usernames)
        self.assertIn('chief', owner_usernames)

    def test_company_name_cannot_be_blank(self):
        self.login_super_admin()

        response = self.client.put('/api/companies/TSC', json={'name': '   '})

        self.assertEqual(response.status_code, 400, response.get_data(as_text=True))
        self.assertEqual(response.get_json()['error'], 'Company name is required')

    def test_company_code_cannot_collide(self):
        self.login_super_admin()

        response = self.client.put('/api/companies/TSC', json={
            'code': 'AVPL',
            'name': 'Duplicate',
        })

        self.assertEqual(response.status_code, 409, response.get_data(as_text=True))
        self.assertEqual(response.get_json()['error'], 'Company AVPL already exists')


if __name__ == '__main__':
    unittest.main()
