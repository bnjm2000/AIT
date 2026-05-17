import unittest
from datetime import datetime as real_datetime

import app as app_module
from models import Event


class FixedDateTime:
    @staticmethod
    def now():
        return real_datetime.strptime('20260517', '%Y%m%d')


class EventStateTests(unittest.TestCase):
    def setUp(self):
        self.original_datetime = app_module.datetime
        app_module.datetime = FixedDateTime

    def tearDown(self):
        app_module.datetime = self.original_datetime

    def make_event(self, prepared_items, actually_prepared, returned_items, extra_assets=None):
        return Event(
            1,
            'Test Event',
            '20260517',
            '20260517',
            [],
            prepared_items=prepared_items,
            returned_items=returned_items,
            actually_prepared=actually_prepared,
            extra_assets=extra_assets or [],
        )

    def test_last_day_requires_ready_event(self):
        event = self.make_event(['A', 'B'], ['A'], [])

        app_module.update_event_state(event)

        self.assertEqual(event.state, 'Preparing')

    def test_ready_event_on_end_date_is_last_day(self):
        event = self.make_event(['A', 'B'], ['A', 'B'], [])

        app_module.update_event_state(event)

        self.assertEqual(event.state, 'Last Day')

    def test_returned_asset_takes_priority_over_last_day(self):
        event = self.make_event(['A', 'B'], ['B'], ['A'])

        app_module.update_event_state(event)

        self.assertEqual(event.state, 'Returning')

    def test_all_returned_assets_close_event(self):
        event = self.make_event(['A', 'B'], [], ['A', 'B'])

        app_module.update_event_state(event)

        self.assertEqual(event.state, 'Closed')

    def test_unreturned_extra_prevents_closed_state(self):
        event = self.make_event(['A', 'B', 'X'], ['B', 'X'], ['A'], extra_assets=['X'])

        app_module.update_event_state(event)

        self.assertEqual(event.state, 'Returning')


if __name__ == '__main__':
    unittest.main()
