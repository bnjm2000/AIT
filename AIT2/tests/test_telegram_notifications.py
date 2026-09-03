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
    telegram_recipients_for_access_control_change,
    telegram_recipients_for_asset_status_change,
    telegram_recipients_for_assigned_event,
    telegram_recipients_for_event_state_change,
    telegram_recipients_for_quotation_status_change,
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

    def test_event_and_quotation_messages_contain_the_transition(self):
        event_message = telegram_notifications.build_event_state_notification(
            event_id=143,
            event_name="Test Production",
            previous_state="Preparing",
            new_state="Ready",
            changed_by="Avery Admin",
        )
        quotation_message = (
            telegram_notifications.build_quotation_status_notification(
                quotation_number="QT-2026-001-01",
                project_name="Test Production",
                previous_status="draft",
                new_status="sent",
                changed_by="Avery Admin",
            )
        )

        self.assertIn("Event state changed", event_message)
        self.assertIn("Previous: Preparing", event_message)
        self.assertIn("New: Ready", event_message)
        self.assertIn("Quotation status changed", quotation_message)
        self.assertIn("Quotation: QT-2026-001-01", quotation_message)
        self.assertIn("Previous: Draft", quotation_message)
        self.assertIn("New: Sent", quotation_message)

    def test_assigned_event_asset_and_access_messages_are_clear(self):
        assigned = telegram_notifications.build_assigned_event_notification(
            event_id=143,
            event_name="Test Production",
            event_date="18 May 2026",
        )
        asset = telegram_notifications.build_asset_status_notification(
            asset_id="LX-001",
            asset_name="Lighting console",
            previous_status="ok",
            new_status="ooc",
            changed_by="Avery Admin",
        )
        access = telegram_notifications.build_access_control_notification(
            action="User account updated",
            target_user="crew-one",
            detail="Access level: user → manager",
            changed_by="Avery Admin",
        )
        self.assertIn("New event assigned to you", assigned)
        self.assertIn("Asset status changed", asset)
        self.assertIn("Previous: ok", asset)
        self.assertIn("Access control changed", access)
        self.assertIn("User: crew-one", access)

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
                "manager": User(
                    "manager", hash_password("pw", "salt"), "salt", True, True,
                    role="manager",
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
            connect_admin_telegram(
                manager,
                "manager",
                chat_id="404",
                display_name="Manager",
            )
            update_admin_telegram_preferences(
                manager,
                "admin-two",
                invoice_uploads=False,
                claim_uploads=True,
                invoice_status_changes=True,
                claim_status_changes=False,
                event_state_changes=False,
                quotation_status_changes=True,
            )

            self.assertEqual(telegram_recipients_for_upload(manager, "invoice"), ["101", "404"])
            self.assertEqual(
                telegram_recipients_for_upload(manager, "claim"),
                ["101", "202", "404"],
            )
            self.assertEqual(
                telegram_recipients_for_status_change(manager, "invoice"),
                ["101", "202", "404"],
            )
            self.assertEqual(
                telegram_recipients_for_status_change(manager, "claim"),
                ["101", "404"],
            )
            self.assertEqual(
                telegram_recipients_for_event_state_change(manager),
                ["101"],
            )
            self.assertEqual(
                telegram_recipients_for_quotation_status_change(manager),
                ["101", "202"],
            )
            self.assertEqual(
                telegram_recipients_for_assigned_event(manager, ["worker", "manager"]),
                ["303", "404"],
            )
            self.assertEqual(
                telegram_recipients_for_event_state_change(manager, ["worker", "manager"]),
                ["101", "303", "404"],
            )
            self.assertEqual(
                telegram_recipients_for_asset_status_change(manager),
                ["101", "202", "404"],
            )
            self.assertEqual(
                telegram_recipients_for_access_control_change(manager),
                ["101", "202"],
            )

            reloaded_manager = DataManager(data_folder)
            reloaded_profile = public_admin_telegram_profile(
                reloaded_manager, "admin-two"
            )
            self.assertTrue(reloaded_profile["connected"])
            self.assertFalse(reloaded_profile["invoiceUploads"])
            self.assertFalse(reloaded_profile["claimStatusChanges"])
            self.assertFalse(reloaded_profile["eventStateChanges"])
            self.assertTrue(reloaded_profile["quotationStatusChanges"])

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
