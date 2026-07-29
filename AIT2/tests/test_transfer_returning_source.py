import tempfile
import unittest
from datetime import date, timedelta

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

        for asset_id in ('TEST#01', 'TEST#02', 'TEST#03'):
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
                current_location='Source Event' if asset_id != 'TEST#03' else 'Store',
            )

        requirement = '[MODEL]AX|Test Brand|Test Model|2|Test asset'
        source_date = (date.today() - timedelta(days=1)).strftime('%Y%m%d')
        destination_date = (date.today() + timedelta(days=2)).strftime('%Y%m%d')
        self.data_manager.events = {
            1: Event(
                1,
                'Source Event',
                source_date,
                source_date,
                [],
                prepared_items=[requirement],
                state='Ongoing',
                returned_items=[],
                actually_prepared=['TEST#01', 'TEST#02'],
                assigned_users=['normal'],
            ),
            2: Event(
                2,
                'Destination Event',
                destination_date,
                destination_date,
                [],
                prepared_items=[requirement],
                state='Planning',
                returned_items=[],
                actually_prepared=[],
                assigned_users=['normal'],
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

    def test_transfer_options_allow_any_event_on_either_side(self):
        options = self.client.get('/api/transfers/options')
        self.assertEqual(options.status_code, 200, options.get_data(as_text=True))
        data = options.get_json()['data']

        self.assertEqual([event['id'] for event in data['events']], [1, 2])
        self.assertIn(2, [event['id'] for event in data['sourceEvents']])
        self.assertIn(1, [event['id'] for event in data['targetEvents']])

    def test_candidates_expose_exact_asset_ids_and_destination_requirements(self):
        response = self.client.get('/api/transfers/candidates?fromEventId=1&toEventId=2')
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))

        data = response.get_json()['data']
        self.assertEqual(
            [candidate['assetId'] for candidate in data['candidates']],
            ['TEST#01', 'TEST#02'],
        )
        self.assertEqual(data['destinationRequirements'], [{
            'department': 'AX',
            'brand': 'Test Brand',
            'model': 'Test Model',
            'description': 'Test asset',
            'required': 2,
            'prepared': 0,
            'remaining': 2,
        }])

    def test_bulk_transfer_moves_only_selected_asset_ids(self):
        response = self.client.post('/api/transfers/execute', json={
            'fromEventId': 1,
            'toEventId': 2,
            'assetIds': ['TEST#02'],
        })
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertEqual(self.data_manager.events[2].actually_prepared, ['TEST#02'])
        self.assertIn('TEST#01', self.data_manager.events[1].actually_prepared)
        self.assertNotIn('TEST#02', self.data_manager.events[1].actually_prepared)

    def test_needed_from_office_exposes_available_asset_ids_for_prepare(self):
        self.data_manager.events[2].prepared_items = [
            '[MODEL]AX|Test Brand|Test Model|3|Test asset'
        ]
        self.data_manager.save_event(self.data_manager.events[2])

        response = self.client.get('/api/transfers/candidates?fromEventId=1&toEventId=2')
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        needed = response.get_json()['data']['neededFromOffice']

        self.assertEqual(len(needed), 1)
        self.assertEqual(needed[0]['officeQuantity'], 1)
        self.assertEqual(
            [asset['assetId'] for asset in needed[0]['officeCandidates']],
            ['TEST#03'],
        )

        prepare = self.client.post('/api/events/2/prepare', json={'assetId': 'TEST#03'})
        self.assertEqual(prepare.status_code, 200, prepare.get_data(as_text=True))
        self.assertIn('TEST#03', self.data_manager.events[2].actually_prepared)

        after = self.client.get('/api/transfers/candidates?fromEventId=1&toEventId=2')
        self.assertEqual(after.status_code, 200, after.get_data(as_text=True))
        self.assertEqual(after.get_json()['data']['neededFromOffice'], [])

    def test_transfer_targets_one_destination_subproject(self):
        destination = self.data_manager.events[2]
        destination.subprojects = [
            {
                'id': 'main',
                'name': 'Main Room',
                'items': [{
                    'lineId': 'main-model',
                    'departmentCode': 'AX',
                    'department': 'Audio Department',
                    'brand': 'Test Brand',
                    'model': 'Test Model',
                    'description': 'Test asset',
                    'quantity': 1,
                    'isCustom': False,
                    'assetRefs': [],
                }],
            },
            {
                'id': 'breakout',
                'name': 'Breakout Room',
                'items': [{
                    'lineId': 'breakout-model',
                    'departmentCode': 'AX',
                    'department': 'Audio Department',
                    'brand': 'Test Brand',
                    'model': 'Test Model',
                    'description': 'Test asset',
                    'quantity': 1,
                    'isCustom': False,
                    'assetRefs': [],
                }],
            },
        ]
        self.data_manager.save_event(destination)

        options = self.client.get('/api/transfers/options')
        target = next(
            row for row in options.get_json()['data']['targetEvents']
            if row['id'] == destination.event_id
        )
        self.assertEqual(
            target['subprojects'],
            [
                {'id': 'main', 'name': 'Main Room'},
                {'id': 'breakout', 'name': 'Breakout Room'},
            ],
        )

        missing_room = self.client.get(
            '/api/transfers/candidates?fromEventId=1&toEventId=2'
        )
        self.assertEqual(missing_room.status_code, 400)
        self.assertIn('destination sub-project', missing_room.get_json()['error'])

        candidates = self.client.get(
            '/api/transfers/candidates?fromEventId=1&toEventId=2&toSubprojectId=breakout'
        )
        self.assertEqual(candidates.status_code, 200, candidates.get_data(as_text=True))
        payload = candidates.get_json()['data']
        self.assertEqual(payload['targetSubproject']['name'], 'Breakout Room')
        self.assertEqual(payload['destinationRequirements'][0]['required'], 1)

        transferred = self.client.post('/api/transfers/execute', json={
            'fromEventId': 1,
            'toEventId': 2,
            'toSubprojectId': 'breakout',
            'assetIds': ['TEST#01'],
        })
        self.assertEqual(transferred.status_code, 200, transferred.get_data(as_text=True))
        self.assertEqual(destination.subprojects[0]['items'][0]['assetRefs'], [])
        self.assertEqual(
            destination.subprojects[1]['items'][0]['assetRefs'],
            ['TEST#01'],
        )
        self.assertIn('TEST#01', destination.actually_prepared)

        main_candidates = self.client.get(
            '/api/transfers/candidates?fromEventId=1&toEventId=2&toSubprojectId=main'
        )
        self.assertEqual(main_candidates.status_code, 200)
        self.assertEqual(
            [row['assetId'] for row in main_candidates.get_json()['data']['candidates']],
            ['TEST#02'],
        )

        undone = self.client.post('/api/transfers/undo', json={
            'fromEventId': 1,
            'toEventId': 2,
            'assetIds': ['TEST#01'],
        })
        self.assertEqual(undone.status_code, 200, undone.get_data(as_text=True))
        self.assertEqual(destination.subprojects[1]['items'][0]['assetRefs'], [])


if __name__ == '__main__':
    unittest.main()
