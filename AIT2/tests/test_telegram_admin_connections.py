import os
import tempfile
import unittest
from urllib.parse import parse_qs, urlparse
from unittest.mock import patch

import app as app_module
from data_manager import DataManager
from models import User, hash_password
from services.notification_settings import connect_admin_telegram
from services.telegram_link_store import clear_telegram_links


class TelegramAdminConnectionTests(unittest.TestCase):
    def setUp(self):
        self.original_manager = app_module.get_default_data_manager()
        self.original_testing = app_module.app.config.get("TESTING")
        self.original_secret = app_module.app.secret_key
        self.tempdir = tempfile.TemporaryDirectory()
        self.manager = DataManager(self.tempdir.name)
        self.manager.setup_data_folder()
        self.manager.users = {
            "admin": User(
                "admin", hash_password("pw", "salt"), "salt", True, True,
                role="admin",
            ),
            "normal": User(
                "normal", hash_password("pw", "salt"), "salt", False, True,
                role="user",
            ),
        }
        self.manager.save_users()
        app_module.app.config["TESTING"] = True
        app_module.app.secret_key = "telegram-admin-test-secret"
        app_module.set_data_manager_for_testing(self.manager)
        self.client = app_module.app.test_client()
        clear_telegram_links(app_module._telegram_link_store_path())

    def tearDown(self):
        clear_telegram_links(app_module._telegram_link_store_path())
        app_module.clear_test_data_manager(self.original_manager)
        app_module.app.config["TESTING"] = self.original_testing
        app_module.app.secret_key = self.original_secret
        self.tempdir.cleanup()

    def login(self, username, is_admin):
        with self.client.session_transaction() as session:
            session["user"] = username
            session["is_admin"] = is_admin
            session["company_code"] = "AVPL"

    def test_standard_user_cannot_access_notification_settings(self):
        self.login("normal", False)
        self.assertEqual(self.client.get("/api/notification-settings").status_code, 403)
        self.assertEqual(
            self.client.post(
                "/api/notification-settings/telegram/connect",
                json={},
            ).status_code,
            403,
        )

    def test_admin_connects_updates_tests_and_disconnects_own_account(self):
        self.login("admin", True)
        environment = {
            "TELEGRAM_NOTIFICATIONS_ENABLED": "1",
            "TELEGRAM_BOT_TOKEN": "12345:test-token",
            "TELEGRAM_UPDATE_MODE": "polling",
        }
        with patch.dict(os.environ, environment, clear=False), patch.object(
            app_module, "telegram_bot_username", return_value="ShowbaseAlertsBot"
        ), patch.object(
            app_module, "configure_telegram_webhook", return_value=True
        ) as configure:
            started = self.client.post(
                "/api/notification-settings/telegram/connect",
                json={},
            )

        self.assertEqual(started.status_code, 200, started.get_data(as_text=True))
        connect_url = started.get_json()["data"]["connectUrl"]
        self.assertEqual(urlparse(connect_url).netloc, "t.me")
        token = parse_qs(urlparse(connect_url).query)["start"][0]
        self.assertLessEqual(len(token), 64)
        configure.assert_not_called()

        telegram_update = {
            "update_id": 1,
            "message": {
                "message_id": 9,
                "text": f"/start {token}",
                "chat": {"id": 778899, "type": "private"},
                "from": {
                    "id": 778899,
                    "first_name": "Avery",
                    "last_name": "Admin",
                    "username": "avery_admin",
                },
            },
        }
        with patch.dict(os.environ, environment, clear=False), patch.object(
            app_module, "queue_telegram_message"
        ) as queue_message:
            webhook = self.client.post(
                "/api/integrations/telegram/webhook",
                json=telegram_update,
                headers={
                    "X-Telegram-Bot-Api-Secret-Token": app_module._telegram_webhook_secret()
                },
            )

        self.assertEqual(webhook.status_code, 200, webhook.get_data(as_text=True))
        queue_message.assert_called_once()
        settings = self.client.get("/api/notification-settings").get_json()["data"]
        self.assertTrue(settings["connected"])
        self.assertEqual(settings["displayName"], "Avery Admin")
        self.assertEqual(settings["telegramUsername"], "avery_admin")
        self.assertNotIn("chatId", settings)

        updated = self.client.put(
            "/api/notification-settings/telegram",
            json={
                "enabled": True,
                "invoiceUploads": False,
                "claimUploads": True,
                "invoiceStatusChanges": False,
                "claimStatusChanges": True,
            },
        )
        self.assertEqual(updated.status_code, 200)
        self.assertFalse(updated.get_json()["data"]["invoiceUploads"])
        self.assertFalse(updated.get_json()["data"]["invoiceStatusChanges"])

        with patch.object(app_module, "send_telegram_message", return_value=True) as send:
            tested = self.client.post(
                "/api/notification-settings/telegram/test",
                json={},
            )
        self.assertEqual(tested.status_code, 200)
        self.assertEqual(send.call_args.kwargs["chat_id"], "778899")

        disconnected = self.client.delete("/api/notification-settings/telegram")
        self.assertEqual(disconnected.status_code, 200)
        self.assertFalse(disconnected.get_json()["data"]["connected"])

    def test_webhook_rejects_an_invalid_secret(self):
        response = self.client.post(
            "/api/integrations/telegram/webhook",
            json={"message": {"text": "/start invalidtokenvalue"}},
            headers={"X-Telegram-Bot-Api-Secret-Token": "wrong"},
        )
        self.assertEqual(response.status_code, 403)

    def test_upload_queue_targets_only_connected_company_admins(self):
        connect_admin_telegram(
            self.manager,
            "admin",
            chat_id="778899",
            display_name="Avery Admin",
        )
        with patch.object(
            app_module, "queue_telegram_upload_notification", return_value=1
        ) as queue_upload:
            app_module.app.config["TESTING"] = False
            try:
                queued = app_module._queue_workforce_upload_notification(
                    manager=self.manager,
                    worker_name="Jordan Dela Cruz",
                    event_id=143,
                    event_name="Test Production",
                    kind="invoice",
                    file_count=1,
                )
            finally:
                app_module.app.config["TESTING"] = True

        self.assertEqual(queued, 1)
        self.assertEqual(queue_upload.call_args.kwargs["chat_ids"], ["778899"])

    def test_notification_settings_ui_is_admin_personal_and_self_service(self):
        root = os.path.dirname(os.path.dirname(__file__))
        with open(
            os.path.join(root, "static", "js", "admin-settings.js"),
            encoding="utf-8",
        ) as source_file:
            source = source_file.read()
        self.assertIn("Connect my Telegram", source)
        self.assertIn("Connections and preferences are separate for every administrator", source)
        self.assertIn("/api/notification-settings/telegram/connect", source)
        self.assertIn("Invoice uploads", source)
        self.assertIn("Claim uploads", source)
        self.assertIn("Invoice status changes", source)
        self.assertIn("Claim status changes", source)

    def test_pending_connection_link_survives_an_in_memory_restart(self):
        self.login("admin", True)
        environment = {
            "TELEGRAM_NOTIFICATIONS_ENABLED": "1",
            "TELEGRAM_BOT_TOKEN": "12345:test-token",
            "TELEGRAM_UPDATE_MODE": "polling",
        }
        with patch.dict(os.environ, environment, clear=False), patch.object(
            app_module, "telegram_bot_username", return_value="ShowbaseAlertsBot"
        ):
            started = self.client.post(
                "/api/notification-settings/telegram/connect",
                json={},
            )
        token = parse_qs(
            urlparse(started.get_json()["data"]["connectUrl"]).query
        )["start"][0]

        self.assertTrue(os.path.isfile(app_module._telegram_link_store_path()))
        self.assertEqual(
            app_module._telegram_link_record(token)["username"],
            "admin",
        )


if __name__ == "__main__":
    unittest.main()
