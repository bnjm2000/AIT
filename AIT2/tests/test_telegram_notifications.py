import json
import os
import tempfile
import unittest
from unittest.mock import MagicMock, patch

from data_manager import DataManager
from models import User, hash_password
from services.notification_settings import (
    connect_admin_telegram,
    public_admin_telegram_profile,
    rename_admin_telegram,
    telegram_recipients_for_status_change,
    telegram_recipients_for_upload,
    update_admin_telegram_preferences,
)
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

    def test_status_message_contains_the_business_transition(self):
        message = telegram_notifications.build_status_change_notification(
            worker_name="Jordan Dela Cruz",
            event_id=143,
            event_name="Test Production",
            kind="invoice",
            previous_status="Approved",
            new_status="Paid",
            changed_by="Avery Admin",
        )

        self.assertIn("Invoice status changed", message)
        self.assertIn("Previous: Approved", message)
        self.assertIn("New: Paid", message)
        self.assertIn("Updated by: Avery Admin", message)

    @patch("services.telegram_notifications.urlopen")
    def test_send_message_uses_configured_chat_and_requests_a_push(self, urlopen):
        response = MagicMock()
        response.read.return_value = b'{"ok": true, "result": {"message_id": 1}}'
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

    @patch("services.telegram_notifications.threading.Thread")
    def test_update_poller_starts_as_a_daemon(self, thread):
        configured = {
            "TELEGRAM_NOTIFICATIONS_ENABLED": "1",
            "TELEGRAM_BOT_TOKEN": "12345:test-token",
        }
        existing = telegram_notifications._update_poller_thread
        telegram_notifications._update_poller_thread = None
        try:
            with patch.dict(os.environ, configured, clear=False):
                started = telegram_notifications.start_telegram_update_poller(
                    lambda _update: None
                )
        finally:
            telegram_notifications._update_poller_thread = existing

        self.assertTrue(started)
        self.assertTrue(thread.call_args.kwargs["daemon"])
        thread.return_value.start.assert_called_once()

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

    def test_upload_recipients_are_scoped_to_active_admin_preferences(self):
        with tempfile.TemporaryDirectory() as data_folder:
            manager = DataManager(data_folder)
            manager.setup_data_folder()
            manager.users = {
                "admin-one": User(
                    "admin-one", hash_password("pw", "salt"), "salt", True, True
                ),
                "admin-two": User(
                    "admin-two", hash_password("pw", "salt"), "salt", True, True
                ),
                "worker": User(
                    "worker", hash_password("pw", "salt"), "salt", False, True
                ),
            }
            connect_admin_telegram(
                manager,
                "admin-one",
                chat_id="101",
                display_name="Admin One",
            )
            connect_admin_telegram(
                manager,
                "admin-two",
                chat_id="202",
                display_name="Admin Two",
            )
            connect_admin_telegram(
                manager,
                "worker",
                chat_id="303",
                display_name="Worker",
            )
            update_admin_telegram_preferences(
                manager,
                "admin-two",
                invoice_uploads=False,
                claim_uploads=True,
                invoice_status_changes=True,
                claim_status_changes=False,
            )

            self.assertEqual(telegram_recipients_for_upload(manager, "invoice"), ["101"])
            self.assertEqual(
                telegram_recipients_for_upload(manager, "claim"),
                ["101", "202"],
            )
            self.assertEqual(
                telegram_recipients_for_status_change(manager, "invoice"),
                ["101", "202"],
            )
            self.assertEqual(
                telegram_recipients_for_status_change(manager, "claim"),
                ["101"],
            )

            reloaded_manager = DataManager(data_folder)
            reloaded_profile = public_admin_telegram_profile(
                reloaded_manager, "admin-two"
            )
            self.assertTrue(reloaded_profile["connected"])
            self.assertFalse(reloaded_profile["invoiceUploads"])
            self.assertFalse(reloaded_profile["claimStatusChanges"])

            self.assertTrue(
                rename_admin_telegram(manager, "admin-one", "admin-renamed")
            )
            manager.users["admin-renamed"] = manager.users.pop("admin-one")
            self.assertTrue(
                public_admin_telegram_profile(manager, "admin-renamed")["connected"]
            )
            self.assertFalse(
                public_admin_telegram_profile(manager, "admin-one")["connected"]
            )


if __name__ == "__main__":
    unittest.main()
