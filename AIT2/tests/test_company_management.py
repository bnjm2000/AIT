import os
import tempfile
import unittest
from unittest import mock

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
        self.original_company_storage_cache = dict(app_module._company_storage_cache)
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
        app_module._company_storage_cache.clear()
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
        app_module._company_storage_cache.clear()
        app_module._company_storage_cache.update(self.original_company_storage_cache)
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

    def test_login_request_selects_username_assigned_company(self):
        with app_module.app.test_request_context(
            '/login',
            method='POST',
            json={'username': 'tech', 'password': 'pw'},
        ):
            self.assertEqual(
                app_module._user_management_company_for_request('AVPL'),
                'TSC',
            )

    def test_login_request_routes_unknown_username_to_system_logs(self):
        with app_module.app.test_request_context(
            '/login',
            method='POST',
            json={'username': 'unknown-user', 'password': 'wrong'},
        ):
            self.assertEqual(
                app_module._user_management_company_for_request('AVPL'),
                app_module.SYSTEM_LOG_COMPANY_CODE,
            )

    def test_failed_login_logs_follow_username_company_or_system_scope(self):
        unknown_response = self.client.post(
            '/login',
            json={'username': 'unknown-user', 'password': 'wrong'},
        )
        known_response = self.client.post(
            '/login',
            json={'username': 'tech', 'password': 'wrong'},
        )

        self.assertEqual(unknown_response.status_code, 401)
        self.assertEqual(known_response.status_code, 401)

        system_manager = app_module._get_company_data_manager(
            app_module.SYSTEM_LOG_COMPANY_CODE
        )
        system_manager.load_logs()
        tsc_manager = app_module._get_company_data_manager('TSC')
        tsc_manager.load_logs()
        self.data_manager.load_logs()

        self.assertEqual(
            [log.action for log in system_manager.logs],
            ['Failed login attempt for username: unknown-user'],
        )
        self.assertEqual(
            [log.action for log in tsc_manager.logs],
            ['Failed login attempt for username: tech'],
        )
        self.assertNotIn(
            'Failed login attempt for username: unknown-user',
            {log.action for log in self.data_manager.logs},
        )

    def test_unmapped_account_cannot_fall_back_to_default_company(self):
        registry = app_module._load_company_registry()
        registry['userCompanies'].pop('tech')
        app_module._save_company_registry(registry)

        response = self.client.post(
            '/login',
            json={'username': 'tech', 'password': 'pw'},
        )

        self.assertEqual(response.status_code, 401)
        system_manager = app_module._get_company_data_manager(
            app_module.SYSTEM_LOG_COMPANY_CODE
        )
        system_manager.load_logs()
        self.assertEqual(
            [log.action for log in system_manager.logs],
            ['Failed login attempt for username: tech'],
        )
        with self.client.session_transaction() as session:
            self.assertNotIn('user', session)

    def test_system_login_logs_are_visible_only_to_owner(self):
        response = self.client.post(
            '/login',
            json={'username': 'unknown-user', 'password': 'wrong'},
        )
        self.assertEqual(response.status_code, 401)

        self.login_super_admin()
        owner_response = self.client.get('/api/logs')
        self.assertEqual(owner_response.status_code, 200)
        owner_logs = owner_response.get_json()['data']
        system_rows = [
            row for row in owner_logs
            if row['companyCode'] == app_module.SYSTEM_LOG_COMPANY_CODE
        ]
        self.assertEqual(len(system_rows), 1)
        self.assertEqual(system_rows[0]['companyName'], 'System')
        self.assertIn('unknown-user', system_rows[0]['action'])

        admin = User(
            'admin-avpl', hash_password('pw', 'admin-log-salt'), 'admin-log-salt',
            True, True, role='admin',
        )
        self.data_manager.users['admin-avpl'] = admin
        self.data_manager.save_users()
        registry = app_module._load_company_registry()
        registry['userCompanies']['admin-avpl'] = 'AVPL'
        app_module._save_company_registry(registry)
        with self.client.session_transaction() as session:
            session.clear()
            session['user'] = 'admin-avpl'
            session['is_admin'] = True
            session['is_super_admin'] = False
            session['company_code'] = 'AVPL'

        admin_response = self.client.get('/api/logs')
        self.assertEqual(admin_response.status_code, 200)
        self.assertNotIn(
            app_module.SYSTEM_LOG_COMPANY_CODE,
            {row['companyCode'] for row in admin_response.get_json()['data']},
        )

    def test_owner_company_change_moves_company_scoped_user_before_retagging(self):
        self.login_super_admin()
        movable = User(
            'movable', hash_password('pw', 'move-salt'), 'move-salt', False, True,
        )
        self.data_manager.users['movable'] = movable
        self.data_manager.save_users()
        registry = app_module._load_company_registry()
        registry['userCompanies']['movable'] = 'AVPL'
        app_module._save_company_registry(registry)
        mover = mock.Mock(return_value=True)
        self.data_manager.move_user_to_company = mover
        try:
            response = self.client.put(
                '/api/users/movable',
                json={'companyCode': 'TSC'},
            )
        finally:
            del self.data_manager.move_user_to_company

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        mover.assert_called_once_with('movable', 'TSC', movable)
        self.assertEqual(
            app_module._load_company_registry()['userCompanies']['movable'],
            'TSC',
        )

    def test_company_list_reads_members_from_each_scoped_manager(self):
        self.login_super_admin()
        tsc_manager = DataManager(
            app_module._company_record_backend_folder(
                app_module._load_company_registry()['companies']['TSC']
            ),
            users_file=app_module.GLOBAL_USERS_FILE,
        )
        tsc_manager.users = {
            'chief': self.data_manager.users['chief'],
            'tech': self.data_manager.users['tech'],
        }
        original_users = self.data_manager.users
        self.data_manager.users = {'bnjm2000': original_users['bnjm2000']}
        test_manager = app_module.app.config.pop('TEST_DATA_MANAGER', None)
        try:
            with mock.patch.object(
                app_module,
                '_get_company_data_manager',
                side_effect=lambda code: (
                    self.data_manager if code == 'AVPL' else tsc_manager
                ),
            ), mock.patch.object(
                app_module,
                '_company_storage_usage',
                return_value={'totalBytes': 0, 'fileCount': 0, 'recordCount': 0},
            ):
                response = self.client.get('/api/companies')
        finally:
            if test_manager is not None:
                app_module.app.config['TEST_DATA_MANAGER'] = test_manager
            self.data_manager.users = original_users

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        companies = {row['code']: row for row in response.get_json()['data']}
        self.assertEqual(companies['AVPL']['userCount'], 0)
        self.assertEqual(companies['TSC']['userCount'], 1)

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

    def test_company_list_includes_role_counts_and_storage_summary(self):
        self.login_super_admin()
        self.data_manager.users.update({
            'manager-tsc': User(
                'manager-tsc', hash_password('pw', 'managersalt'), 'managersalt',
                False, True, role='manager',
            ),
            'admin-tsc': User(
                'admin-tsc', hash_password('pw', 'adminsalt'), 'adminsalt',
                True, True, role='admin',
            ),
            'sales-tsc': User(
                'sales-tsc', hash_password('pw', 'salessalt'), 'salessalt',
                False, True, role='user', has_sales_access=True,
            ),
        })
        self.data_manager.save_users()
        registry = app_module._load_company_registry()
        registry['userCompanies'].update({
            'manager-tsc': 'TSC',
            'admin-tsc': 'TSC',
            'sales-tsc': 'TSC',
        })
        app_module._save_company_registry(registry)

        record = registry['companies']['TSC']
        backend_folder = app_module._company_record_backend_folder(record)
        frontend_folder = app_module._company_record_frontend_folder(record)
        uploads_folder = os.path.join(backend_folder, 'workforce_uploads', 'event-12')
        os.makedirs(uploads_folder, exist_ok=True)
        with open(os.path.join(uploads_folder, 'private-invoice.pdf'), 'wb') as upload_file:
            upload_file.write(b'x' * 37)
        with open(os.path.join(frontend_folder, 'logo.png'), 'wb') as logo_file:
            logo_file.write(b'y' * 19)
        maintenance_folder = os.path.join(backend_folder, 'maintenance_media', 'asset-1')
        os.makedirs(maintenance_folder, exist_ok=True)
        with open(os.path.join(maintenance_folder, 'inspection.jpg'), 'wb') as media_file:
            media_file.write(b'z' * 23)

        expected_bytes = 0
        expected_files = 0
        for folder in (backend_folder, frontend_folder):
            for current_root, _, filenames in os.walk(folder):
                for filename in filenames:
                    expected_files += 1
                    expected_bytes += os.path.getsize(os.path.join(current_root, filename))

        response = self.client.get('/api/companies')

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        companies = {company['code']: company for company in response.get_json()['data']}
        company = companies['TSC']
        self.assertEqual(company['userCount'], 4)
        self.assertEqual(company['activeUserCount'], 4)
        self.assertEqual(company['roleCounts'], {
            'admin': 1,
            'manager': 1,
            'user': 2,
        })
        self.assertEqual(company['salesPersonnelCount'], 1)
        self.assertEqual(company['storageBytes'], expected_bytes)
        self.assertEqual(company['storageFileCount'], expected_files)

        storage_response = self.client.get('/api/companies/TSC/storage?refresh=1')
        self.assertEqual(storage_response.status_code, 200, storage_response.get_data(as_text=True))
        storage = storage_response.get_json()['data']
        self.assertEqual(storage['totalBytes'], expected_bytes)
        self.assertEqual(storage['fileCount'], expected_files)
        self.assertEqual(sum(item['bytes'] for item in storage['breakdown']), expected_bytes)
        uploads = next(item for item in storage['breakdown'] if item['key'] == 'uploads')
        branding = next(item for item in storage['breakdown'] if item['key'] == 'branding')
        maintenance = next(item for item in storage['breakdown'] if item['key'] == 'maintenance')
        self.assertEqual(uploads['bytes'], 37)
        self.assertGreaterEqual(branding['bytes'], 19)
        self.assertEqual(maintenance['bytes'], 23)
        self.assertNotIn('private-invoice.pdf', storage_response.get_data(as_text=True))

    def test_company_storage_breakdown_is_owner_only(self):
        with self.client.session_transaction() as session:
            session['user'] = 'tech'
            session['is_admin'] = False
            session['is_super_admin'] = False
            session['company_code'] = 'TSC'

        response = self.client.get('/api/companies/TSC/storage')

        self.assertEqual(response.status_code, 403, response.get_data(as_text=True))

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

    def test_owner_sees_all_company_logs_while_admin_sees_own_company(self):
        self.data_manager.logs = [
            LogEntry('2026/07/16 09:00:00', 'avpl-user', 'Updated AVPL inventory'),
        ]
        self.data_manager.save_logs()
        tsc_manager = app_module._get_company_data_manager('TSC')
        tsc_manager.logs = [
            LogEntry('2026/07/16 10:00:00', 'tsc-user', 'Updated TSC inventory'),
        ]
        tsc_manager.save_logs()

        self.login_super_admin()
        owner_response = self.client.get('/api/logs')

        self.assertEqual(owner_response.status_code, 200, owner_response.get_data(as_text=True))
        owner_logs = owner_response.get_json()['data']
        self.assertEqual([row['companyCode'] for row in owner_logs], ['TSC', 'AVPL'])
        self.assertEqual(owner_logs[0]['companyName'], 'The Show Company')

        admin = User(
            'admin-avpl', hash_password('pw', 'admin-log-salt'), 'admin-log-salt',
            True, True, role='admin',
        )
        self.data_manager.users['admin-avpl'] = admin
        self.data_manager.save_users()
        registry = app_module._load_company_registry()
        registry['userCompanies']['admin-avpl'] = 'AVPL'
        app_module._save_company_registry(registry)
        with self.client.session_transaction() as session:
            session['user'] = 'admin-avpl'
            session['is_admin'] = True
            session['is_super_admin'] = False
            session['company_code'] = 'AVPL'

        admin_response = self.client.get('/api/logs')

        self.assertEqual(admin_response.status_code, 200, admin_response.get_data(as_text=True))
        admin_logs = admin_response.get_json()['data']
        self.assertEqual({row['companyCode'] for row in admin_logs}, {'AVPL'})
        self.assertNotIn('Updated TSC inventory', {row['action'] for row in admin_logs})

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

    def test_owner_user_management_aggregates_company_scoped_users(self):
        tsc_record = app_module._load_company_registry()['companies']['TSC']
        tsc_backend = app_module._company_record_backend_folder(tsc_record)
        tsc_manager = DataManager(
            tsc_backend,
            users_file=os.path.join(tsc_backend, 'Users.csv'),
        )
        tsc_manager.setup_data_folder()
        tsc_manager.users = {
            'bnjm2000': User(
                'bnjm2000', hash_password('pw', 'salt'), 'salt', True, True,
            ),
            'tsc-only': User(
                'tsc-only', hash_password('pw', 'tscsalt'), 'tscsalt', False, True,
            ),
        }
        tsc_manager.save_users()
        app_module._company_data_managers['TSC'] = tsc_manager

        registry = app_module._load_company_registry()
        registry['userCompanies']['tsc-only'] = 'TSC'
        app_module._save_company_registry(registry)

        self.login_super_admin()
        response = self.client.get('/api/users')

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        rows = response.get_json()['data']
        usernames = [row['username'] for row in rows]
        self.assertIn('tsc-only', usernames)
        self.assertEqual(usernames.count('bnjm2000'), 1)
        tsc_user = next(row for row in rows if row['username'] == 'tsc-only')
        self.assertEqual(tsc_user['companyCode'], 'TSC')
        self.assertEqual(tsc_user['companyName'], 'The Show Company')

        update_response = self.client.put(
            '/api/users/tsc-only',
            json={'name': 'TSC Updated User'},
        )
        self.assertEqual(
            update_response.status_code,
            200,
            update_response.get_data(as_text=True),
        )
        tsc_manager.load_users()
        self.assertEqual(tsc_manager.users['tsc-only'].name, 'TSC Updated User')

        reset_response = self.client.put(
            '/api/users/tsc-only/password',
            json={'password': 'new-password'},
        )
        self.assertEqual(
            reset_response.status_code,
            200,
            reset_response.get_data(as_text=True),
        )
        tsc_manager.load_users()
        updated_user = tsc_manager.users['tsc-only']
        self.assertEqual(
            updated_user.password_hash,
            hash_password('new-password', updated_user.salt),
        )

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
