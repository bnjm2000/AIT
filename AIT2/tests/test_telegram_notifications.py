import json
import os
import unittest
from unittest.mock import MagicMock, patch

from services import telegram_notifications


class TelegramNotificationTests(unittest.TestCase):
    def test_upload_message_contains_review_metadata_but_no_document_content(self):
        message = telegram_notifications.build_upload_notification(
            worker_name="Jordan Dela Cruz",
            event_id=143,
            event_name="Test Production",
            kind="claim",
            file_count=2,
        )

        self.assertIn("New claim uploaded", message)
        self.assertIn("Worker: Jordan Dela Cruz", message)
        self.assertIn("Event: Test Production (#143)", message)
        self.assertIn("Files: 2", message)
        self.assertIn("Status: Pending review", message)

    @patch("services.telegram_notifications.urlopen")
    def test_send_message_uses_configured_chat_and_requests_a_push(self, urlopen):
        response = MagicMock()
        response.read.return_value = b'{"ok": true}'
        urlopen.return_value.__enter__.return_value = response
        configured = {
            "TELEGRAM_NOTIFICATIONS_ENABLED": "1",
            "TELEGRAM_BOT_TOKEN": "12345:test-token",
            "TELEGRAM_CHAT_ID": "-987654",
            "TELEGRAM_REQUEST_TIMEOUT_SECONDS": "4",
        }

        with patch.dict(os.environ, configured, clear=False):
            sent = telegram_notifications.send_telegram_message("Upload ready")

        self.assertTrue(sent)
        request = urlopen.call_args.args[0]
        payload = json.loads(request.data.decode("utf-8"))
        self.assertEqual(payload["chat_id"], "-987654")
        self.assertEqual(payload["text"], "Upload ready")
        self.assertFalse(payload["disable_notification"])
        self.assertEqual(urlopen.call_args.kwargs["timeout"], 4.0)
        self.assertTrue(request.full_url.endswith("/sendMessage"))

    @patch("services.telegram_notifications._notification_executor.submit")
    def test_queue_is_disabled_when_configuration_is_incomplete(self, submit):
        configured = {
            "TELEGRAM_NOTIFICATIONS_ENABLED": "1",
            "TELEGRAM_BOT_TOKEN": "",
            "TELEGRAM_CHAT_ID": "",
        }
        with patch.dict(os.environ, configured, clear=False):
            queued = telegram_notifications.queue_upload_notification(
                worker_name="Jordan",
                event_id=143,
                event_name="Test Production",
                kind="invoice",
                file_count=1,
            )

        self.assertFalse(queued)
        submit.assert_not_called()

    @patch("services.telegram_notifications.urlopen", side_effect=OSError("offline"))
    def test_network_failure_is_non_fatal(self, _urlopen):
        configured = {
            "TELEGRAM_NOTIFICATIONS_ENABLED": "1",
            "TELEGRAM_BOT_TOKEN": "12345:test-token",
            "TELEGRAM_CHAT_ID": "987654",
        }
        with patch.dict(os.environ, configured, clear=False):
            sent = telegram_notifications.send_telegram_message("Upload ready")

        self.assertFalse(sent)


if __name__ == "__main__":
    unittest.main()
