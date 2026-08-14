import unittest
import queue
from unittest.mock import patch

from flask import g

import app as app_module


class EventAssetRealtimeTests(unittest.TestCase):
    def tearDown(self):
        with app_module._realtime_subscribers_lock:
            app_module._realtime_subscribers.clear()

    def test_prepare_and_return_requests_include_event_scoped_details(self):
        cases = (
            ('/api/events/42/prepare', 'prepare'),
            ('/api/events/42/unprepare', 'unprepare'),
            ('/api/events/42/prepare-model-quantity', 'prepare'),
            ('/api/events/42/assign-specific', 'prepare'),
            ('/api/events/42/return', 'return'),
            ('/api/events/42/unreturn', 'unreturn'),
            ('/api/events/42/return-department', 'return-department'),
            ('/api/events/42/close-return', 'close-return'),
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

    def test_model_quantity_unprepare_has_unprepare_realtime_action(self):
        with app_module.app.test_request_context(
            '/api/events/42/prepare-model-quantity',
            method='POST',
            json={'action': 'unprepare', 'quantity': 1},
        ):
            details = app_module._event_asset_realtime_change_for_request()

        self.assertEqual(details['eventId'], 42)
        self.assertEqual(details['action'], 'unprepare')

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

    def test_login_logout_logs_are_classified_as_user_presence(self):
        login_details = app_module._user_presence_realtime_details_from_log_action(
            'User alice logged in via web interface'
        )
        logout_details = app_module._user_presence_realtime_details_from_log_action(
            'User bob logged out from web interface'
        )

        self.assertEqual(login_details['username'], 'alice')
        self.assertEqual(login_details['status'], 'login')
        self.assertEqual(logout_details['username'], 'bob')
        self.assertEqual(logout_details['status'], 'logout')
        self.assertIsNone(
            app_module._user_presence_realtime_details_from_log_action(
                'Created user alice'
            )
        )

    def test_realtime_state_uses_durable_outbox_cursor_when_available(self):
        class Manager:
            def latest_realtime_event(self):
                return {'id': 'durable-42', 'topic': 'events'}

            def load_company_document(self, *_args):
                raise AssertionError('legacy realtime document should not be read')

        with patch.object(
            app_module,
            '_current_data_manager_object',
            return_value=Manager(),
        ):
            payload = app_module._read_realtime_state()

        self.assertEqual(payload['id'], 'durable-42')

    def test_realtime_publish_only_notifies_matching_company_subscribers(self):
        company_a_queue = queue.Queue()
        company_b_queue = queue.Queue()
        with app_module._realtime_subscribers_lock:
            app_module._realtime_subscribers.update({
                'company-a-browser': {
                    'queue': company_a_queue,
                    'companyCode': 'COMPANY-A',
                },
                'company-b-browser': {
                    'queue': company_b_queue,
                    'companyCode': 'COMPANY-B',
                },
            })

        with patch.object(app_module, '_write_realtime_state'):
            app_module._publish_realtime_update_now(
                'data-changed',
                {
                    'companyCode': 'COMPANY-A',
                    'topics': ['inventory-data', 'activity-log'],
                },
                'editing-browser',
            )

        delivered = company_a_queue.get_nowait()
        self.assertEqual(delivered['details']['companyCode'], 'COMPANY-A')
        self.assertTrue(company_b_queue.empty())

    def test_unscoped_realtime_payload_does_not_cross_company_boundary(self):
        self.assertFalse(
            app_module._realtime_payload_matches_company(
                {'topic': 'inventory-data', 'details': {}},
                'COMPANY-A',
            )
        )
        self.assertTrue(
            app_module._realtime_payload_matches_company(
                {'details': {'companyCode': 'company-a'}},
                'COMPANY-A',
            )
        )


if __name__ == '__main__':
    unittest.main()
