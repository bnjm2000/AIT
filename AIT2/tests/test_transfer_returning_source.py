import tempfile
import unittest

import app as app_module
from data_manager import DataManager
from models import Event, InventoryItem, User, hash_password


class ReturningSourceTransferTests(unittest.TestCase):
    def setUp(self):
        self.original_data_manager = app_module.get_default_data_manager()
        self.original_signature = app_module._data_snapshot_signature
        self.original_testing = app_module.app.config.get('TESTING')
        self.tempdir = tempfile.TemporaryDirectory()

        self.data_manager = DataManager(self.tempdir.name)
        self.data_manager.setup_data_folder()
        self.data_manager.users = {
            'normal': User('normal', hash_password('pw', 'salt'), 'salt', False, True),
        }
        self.data_manager.save_users()
        self.data_manager.logs = []
        self.data_manager.save_logs()

        for asset_id in ('TEST#01', 'TEST#02'):
            self.data_manager.inventory[asset_id] = InventoryItem(
                asset_id=asset_id,
                brand='Test Brand',
                model_number='Test Model',
                serial_number='',
                description='Test asset',
                is_missing=False,
                maintenance_logs=[],
                department_code='AX',
                default_location='Store',
                current_location='Source Event',
            )

        requirement = '[MODEL]AX|Test Brand|Test Model|2|Test asset'
        self.data_manager.events = {
            1: Event(
                1,
                'Source Event',
                '20260628',
                '20260628',
                [],
                prepared_items=[requirement],
                state='Ongoing',
                returned_items=[],
                actually_prepared=['TEST#01', 'TEST#02'],
            ),
            2: Event(
                2,
                'Destination Event',
                '20260701',
                '20260701',
                [],
                prepared_items=[requirement],
                state='Planning',
                returned_items=[],
                actually_prepared=[],
            ),
        }
        self.data_manager.save_inventory()
        for event in self.data_manager.events.values():
            self.data_manager.save_event(event)

        app_module.app.config['TESTING'] = True
        app_module.set_data_manager_for_testing(self.data_manager)
        self.client = app_module.app.test_client()
        with self.client.session_transaction() as session:
            session['user'] = 'normal'
            session['is_admin'] = False

    def tearDown(self):
        app_module.clear_test_data_manager(self.original_data_manager)
        app_module._data_snapshot_signature = self.original_signature
        app_module.app.config['TESTING'] = self.original_testing
        self.tempdir.cleanup()

    def transfer(self, asset_id):
        return self.client.post('/api/transfers/execute', json={
            'fromEventId': 1,
            'toEventId': 2,
            'assetIds': [asset_id],
        })

    def test_returning_event_stays_eligible_for_followup_transfers(self):
        first = self.transfer('TEST#01')
        self.assertEqual(first.status_code, 200, first.get_data(as_text=True))
        self.assertEqual(self.data_manager.events[1].state, 'Returning')

        options = self.client.get('/api/transfers/options')
        self.assertEqual(options.status_code, 200, options.get_data(as_text=True))
        source_ids = [event['id'] for event in options.get_json()['data']['sourceEvents']]
        self.assertIn(1, source_ids)

        second = self.transfer('TEST#02')
        self.assertEqual(second.status_code, 200, second.get_data(as_text=True))
        self.assertEqual(
            self.data_manager.events[2].actually_prepared,
            ['TEST#01', 'TEST#02'],
        )


if __name__ == '__main__':
    unittest.main()
