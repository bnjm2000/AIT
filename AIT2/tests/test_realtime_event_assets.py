import unittest
from unittest.mock import patch

from flask import g

import app as app_module


class EventAssetRealtimeTests(unittest.TestCase):
    def test_prepare_and_return_requests_include_event_scoped_details(self):
        cases = (
            ('/api/events/42/prepare', 'prepare'),
            ('/api/events/42/unprepare', 'unprepare'),
            ('/api/events/42/assign-specific', 'prepare'),
            ('/api/events/42/return', 'return'),
            ('/api/events/42/return-department', 'return-department'),
        )

        for path, expected_action in cases:
            with self.subTest(path=path), app_module.app.test_request_context(
                path,
                method='POST',
                json={'assetId': 'ASSET-1', 'department': 'LX'},
            ):
                details = app_module._event_asset_realtime_change_for_request()

                self.assertEqual(details['eventId'], 42)
                self.assertEqual(details['action'], expected_action)

    def test_successful_prepare_publishes_event_assets_change(self):
        with app_module.app.test_request_context(
            '/api/events/7/prepare',
            method='POST',
            json={'assetId': 'ASSET-7'},
            headers={'X-Client-Id': 'browser-1'},
        ):
            g.realtime_changes = [{'topic': 'inventory-data', 'details': {}}]
            response = app_module.app.make_response(('{}', 200))

            with patch.object(app_module, '_publish_realtime_update_now') as publish:
                app_module.publish_marked_realtime_changes(response)

            publish.assert_called_once()
            topic, details, origin_client_id = publish.call_args.args
            self.assertEqual(topic, 'data-changed')
            self.assertEqual(origin_client_id, 'browser-1')
            self.assertIn('event-assets', details['topics'])
            self.assertEqual(
                details['changes'][-1],
                {
                    'topic': 'event-assets',
                    'details': {
                        'eventId': 7,
                        'action': 'prepare',
                        'assetId': 'ASSET-7',
                    },
                },
            )

    def test_failed_prepare_does_not_publish_event_assets_change(self):
        with app_module.app.test_request_context(
            '/api/events/7/prepare',
            method='POST',
            json={'assetId': 'ASSET-7'},
        ):
            response = app_module.app.make_response(('{}', 400))

            with patch.object(app_module, '_publish_realtime_update_now') as publish:
                app_module.publish_marked_realtime_changes(response)

            publish.assert_not_called()


if __name__ == '__main__':
    unittest.main()
