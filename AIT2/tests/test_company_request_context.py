import os
import tempfile
import threading
import unittest

import app as app_module
from data_manager import DataManager


class CompanyRequestContextTests(unittest.TestCase):
    def test_concurrent_contexts_keep_company_managers_separate(self):
        with tempfile.TemporaryDirectory() as root:
            managers = {
                'A': DataManager(os.path.join(root, 'company-a')),
                'B': DataManager(os.path.join(root, 'company-b')),
            }
            barrier = threading.Barrier(2)
            observed = {}

            def read_bound_manager(company_code):
                token = app_module._request_data_manager.set(managers[company_code])
                try:
                    barrier.wait(timeout=5)
                    app_module.data_manager.inventory = {'owner': company_code}
                    barrier.wait(timeout=5)
                    observed[company_code] = (
                        app_module.data_manager.data_folder,
                        app_module.data_manager.inventory['owner'],
                    )
                finally:
                    app_module._request_data_manager.reset(token)

            threads = [
                threading.Thread(target=read_bound_manager, args=(company_code,))
                for company_code in ('A', 'B')
            ]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(timeout=5)

            self.assertEqual(observed['A'], (managers['A'].data_folder, 'A'))
            self.assertEqual(observed['B'], (managers['B'].data_folder, 'B'))

    def test_test_manager_rejects_live_company_folder(self):
        original_testing = app_module.app.config.get('TESTING')
        original_manager = app_module.get_default_data_manager()
        app_module.app.config['TESTING'] = True
        try:
            manager = DataManager(
                os.path.join(app_module.LIVE_COMPANIES_FOLDER, 'AVPL', 'backend')
            )
            with self.assertRaisesRegex(RuntimeError, 'live companies folder'):
                app_module.set_data_manager_for_testing(manager)
        finally:
            app_module.clear_test_data_manager(original_manager)
            app_module.app.config['TESTING'] = original_testing

    def test_company_manager_rejects_live_company_folder_in_tests(self):
        original_testing = app_module.app.config.get('TESTING')
        original_managers = dict(app_module._company_data_managers)
        try:
            app_module.app.config['TESTING'] = True
            app_module._company_data_managers.clear()
            with self.assertRaisesRegex(RuntimeError, 'live companies folder'):
                app_module._get_company_data_manager('AVPL')
        finally:
            app_module._company_data_managers.clear()
            app_module._company_data_managers.update(original_managers)
            app_module.app.config['TESTING'] = original_testing

    def test_app_tests_use_temp_csv_manager_even_when_database_url_is_set(self):
        original_base_dir = app_module.BASE_DIR
        original_app_config_folder = app_module.APP_CONFIG_FOLDER
        original_company_registry_file = app_module.COMPANY_REGISTRY_FILE
        original_global_users_file = app_module.GLOBAL_USERS_FILE
        original_company_registry_cache = app_module._company_registry_cache
        original_managers = dict(app_module._company_data_managers)
        original_testing = app_module.app.config.get('TESTING')
        original_database_url = app_module.DATABASE_URL
        original_manager = app_module.get_default_data_manager()

        with tempfile.TemporaryDirectory() as root:
            try:
                app_module.BASE_DIR = root
                app_module.APP_CONFIG_FOLDER = os.path.join(root, 'app_data')
                app_module.COMPANY_REGISTRY_FILE = os.path.join(
                    app_module.APP_CONFIG_FOLDER,
                    'Companies.json',
                )
                app_module.GLOBAL_USERS_FILE = os.path.join(
                    app_module.APP_CONFIG_FOLDER,
                    'Users.csv',
                )
                app_module._company_registry_cache = None
                app_module._company_data_managers.clear()
                app_module.DATABASE_URL = 'postgresql://example.invalid/test'
                app_module.app.config['TESTING'] = True
                os.makedirs(app_module.APP_CONFIG_FOLDER, exist_ok=True)

                record = app_module._new_company_record('TMP', 'Temporary Company')
                app_module._save_company_registry({
                    'defaultCompany': 'TMP',
                    'companies': {'TMP': record},
                    'userCompanies': {},
                    'superAdmins': ['bnjm2000'],
                })

                manager = app_module._get_company_data_manager('TMP')

                self.assertIsInstance(manager, DataManager)
                self.assertEqual(manager.__class__.__name__, 'DataManager')
            finally:
                app_module.clear_test_data_manager(original_manager)
                app_module.BASE_DIR = original_base_dir
                app_module.APP_CONFIG_FOLDER = original_app_config_folder
                app_module.COMPANY_REGISTRY_FILE = original_company_registry_file
                app_module.GLOBAL_USERS_FILE = original_global_users_file
                app_module._company_registry_cache = original_company_registry_cache
                app_module._company_data_managers.clear()
                app_module._company_data_managers.update(original_managers)
                app_module.DATABASE_URL = original_database_url
                app_module.app.config['TESTING'] = original_testing


if __name__ == '__main__':
    unittest.main()
