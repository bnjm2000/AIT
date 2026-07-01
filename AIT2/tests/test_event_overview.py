import os
import tempfile
import unittest

import app as app_module
from data_manager import DataManager
from models import Event, split_legacy_event_name_location


class EventLocationTests(unittest.TestCase):
    def test_legacy_name_splits_at_final_separator(self):
        name, location, changed = split_legacy_event_name_location(
            'Awards @ Sunset @ Marina Bay Sands'
        )

        self.assertEqual(name, 'Awards @ Sunset')
        self.assertEqual(location, 'Marina Bay Sands')
        self.assertTrue(changed)

    def test_explicit_location_prevents_legacy_split(self):
        event = Event(
            7,
            'Show @ Client',
            '20260701',
            '20260701',
            [],
            location='Expo Hall 1',
        )

        self.assertEqual(event.name, 'Show @ Client')
        self.assertEqual(event.location, 'Expo Hall 1')
        self.assertFalse(event._legacy_location_extracted)

    def test_csv_round_trip_persists_extracted_location(self):
        with tempfile.TemporaryDirectory() as root:
            manager = DataManager(root)
            manager.setup_data_folder()
            manager.check_and_initialize_files()
            event = Event(
                1,
                'Launch @ National Gallery',
                '20260701',
                '20260702',
                [],
            )
            manager.events[event.event_id] = event
            manager.save_event(event)

            reloaded = DataManager(root)
            reloaded.load_events()

            self.assertEqual(reloaded.events[1].name, 'Launch')
            self.assertEqual(reloaded.events[1].location, 'National Gallery')
            self.assertFalse(reloaded.events[1]._legacy_location_extracted)
            self.assertTrue(os.path.exists(reloaded.event_file_map[1] if os.path.isabs(reloaded.event_file_map[1]) else os.path.join(reloaded.events_folder, reloaded.event_file_map[1])))

    def test_new_event_requires_location_but_dry_hire_does_not(self):
        base = {
            'name': 'Test',
            'startDate': '2026-07-01',
            'endDate': '2026-07-01',
        }

        event_errors = app_module.validate_event_data(
            {**base, 'tag': 'events', 'location': ''},
            require_location=True,
        )
        dry_hire_errors = app_module.validate_event_data(
            {**base, 'tag': 'dry hire', 'location': ''},
            require_location=True,
        )

        self.assertIn('Location is required for events', event_errors)
        self.assertNotIn('Location is required for events', dry_hire_errors)


class AssetsDeployedTests(unittest.TestCase):
    def test_counts_prepared_physical_and_bulk_but_not_custom_or_returned(self):
        manager = DataManager(tempfile.mkdtemp())
        manager.inventory = {'A': object(), 'B': object()}
        manager.events = {
            1: Event(
                1,
                'One',
                '20260701',
                '20260701',
                [],
                actually_prepared=['A', '[BULK]BULK-1|3', '[LOAN]Camera;2'],
            ),
            2: Event(
                2,
                'Two',
                '20260701',
                '20260701',
                [],
                actually_prepared=['A', 'B', '[BULK]BULK-2|4'],
                returned_items=['B', '[BULK]BULK-2|4'],
            ),
        }
        token = app_module._request_data_manager.set(manager)
        try:
            self.assertEqual(app_module.get_deployed_asset_quantity(), 4)
        finally:
            app_module._request_data_manager.reset(token)


if __name__ == '__main__':
    unittest.main()
