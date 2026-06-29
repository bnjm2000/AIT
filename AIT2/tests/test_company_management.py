import os
import tempfile
import unittest

import app as app_module
from data_manager import DataManager
from models import User, hash_password


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


if __name__ == '__main__':
    unittest.main()
