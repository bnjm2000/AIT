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


if __name__ == '__main__':
    unittest.main()
