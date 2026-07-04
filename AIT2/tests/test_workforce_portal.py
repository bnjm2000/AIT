import io
import json
import os
import tempfile
import unittest

import app as app_module
from data_manager import DataManager
from models import Event, User, hash_password
from workforce import load_workforce


PDF_BYTES = b"%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF"
PNG_BYTES = b"\x89PNG\r\n\x1a\n" + b"test-image"


class WorkforcePortalTests(unittest.TestCase):
    def setUp(self):
        self.original_data_manager = app_module.get_default_data_manager()
        self.original_testing = app_module.app.config.get("TESTING")
        self.original_secret = app_module.app.secret_key
        self.tempdir = tempfile.TemporaryDirectory()

        self.manager = DataManager(self.tempdir.name)
        self.manager.setup_data_folder()
        self.manager.users = {
            "normal": User(
                "normal", hash_password("pw", "salt"), "salt", False, True
            ),
            "admin": User(
                "admin", hash_password("pw", "salt"), "salt", True, True
            ),
        }
        self.manager.save_users()
        self.manager.logs = []
        self.manager.save_logs()
        self.manager.departments = {
            "AU": {"name": "Audio"},
            "LI": {"name": "Lighting"},
        }
        event = Event(
            143,
            "Test Production",
            "20260710",
            "20260712",
            [],
            prepared_items=[],
            returned_items=[],
            actually_prepared=[],
            extra_assets=[],
            tag="events",
            location="Test Venue",
        )
        self.manager.events[event.event_id] = event
        self.manager.save_event(event)

        app_module.app.config["TESTING"] = True
        app_module.app.secret_key = "workforce-test-secret"
        app_module.set_data_manager_for_testing(self.manager)
        self.client = app_module.app.test_client()

    def tearDown(self):
        app_module.clear_test_data_manager(self.original_data_manager)
        app_module.app.config["TESTING"] = self.original_testing
        app_module.app.secret_key = self.original_secret
        self.tempdir.cleanup()

    def login(self, username, is_admin):
        with self.client.session_transaction() as session:
            session["user"] = username
            session["is_admin"] = is_admin
            session["company_code"] = "AVPL"

    def create_worker_assignment(self):
        self.login("admin", True)
        response = self.client.post(
            "/api/workforce/freelancers",
            json={"name": "Jordan Dela Cruz", "phone": "9123 4567"},
        )
        self.assertEqual(response.status_code, 200)
        freelancer_id = response.get_json()["data"]["id"]

        response = self.client.post(
            "/api/events/143/workforce/assignments",
            json={
                "freelancerId": freelancer_id,
                "department": "AU",
                "customRole": "Audio Engineer",
                "days": 2,
                "dailyRate": 280,
            },
        )
        self.assertEqual(response.status_code, 200)
        return freelancer_id

    def worker_token(self):
        with self.client.session_transaction() as session:
            session.clear()
        response = self.client.post(
            "/api/worker/lookup", json={"phone": "+65 9123 4567"}
        )
        self.assertEqual(response.status_code, 200)
        company = response.get_json()["data"]["companies"][0]
        self.assertEqual(company["events"][0]["id"], 143)
        return company["token"]

    def test_only_admins_can_open_event_workforce(self):
        self.login("normal", False)
        response = self.client.get("/api/events/143/workforce")
        self.assertEqual(response.status_code, 403)

        self.login("admin", True)
        response = self.client.get("/api/events/143/workforce")
        self.assertEqual(response.status_code, 200)

    def test_worker_upload_review_denial_and_replacement(self):
        freelancer_id = self.create_worker_assignment()
        token = self.worker_token()

        response = self.client.post(
            "/api/worker/submissions",
            data={
                "token": token,
                "eventId": "143",
                "kind": "invoice",
                "warningAcknowledged": "true",
                "file": (io.BytesIO(PDF_BYTES), "invoice.pdf"),
            },
            content_type="multipart/form-data",
        )
        self.assertEqual(response.status_code, 200)

        workforce = load_workforce(self.tempdir.name)
        invoice = workforce["submissions"]["143"][freelancer_id]["invoices"][0]
        self.assertEqual(invoice["status"], "Pending Review")

        self.login("admin", True)
        response = self.client.put(
            f"/api/workforce/submissions/{invoice['id']}",
            json={
                "amount": 1240,
                "status": "Denied",
                "denialReason": "Wrong billing company",
                "allocations": [{"department": "AU", "amount": 1240}],
            },
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["data"]["totals"]["invoice"], 0)

        token = self.worker_token()
        response = self.client.post(
            "/api/worker/submissions",
            data={
                "token": token,
                "eventId": "143",
                "kind": "invoice",
                "warningAcknowledged": "true",
                "file": (io.BytesIO(PDF_BYTES), "replacement.pdf"),
            },
            content_type="multipart/form-data",
        )
        self.assertEqual(response.status_code, 200)
        public_event = response.get_json()["data"]["events"][0]
        self.assertFalse(public_event["canUploadInvoice"])
        self.assertEqual(len(public_event["submissions"]["invoices"]), 2)
        self.assertNotIn("originalName", public_event["submissions"]["invoices"][0])
        self.assertNotIn("amount", public_event["submissions"]["invoices"][0])

    def test_claim_validation_totals_and_realtime_notice(self):
        self.create_worker_assignment()
        token = self.worker_token()

        response = self.client.post(
            "/api/worker/submissions",
            data={
                "token": token,
                "eventId": "143",
                "kind": "claim",
                "warningAcknowledged": "true",
                "amount": "28.50",
                "claimDate": "2026-07-10",
                "category": "Cab",
                "description": "Trip to venue",
                "department": "AU",
                "file": (io.BytesIO(PNG_BYTES), "receipt.png"),
            },
            content_type="multipart/form-data",
        )
        self.assertEqual(response.status_code, 200)

        self.login("admin", True)
        response = self.client.get("/api/events/143/workforce")
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()["data"]
        self.assertEqual(payload["totals"]["claims"], 28.5)
        self.assertEqual(payload["totals"]["departments"]["AU"]["claims"], 28.5)

        realtime_path = os.path.join(self.tempdir.name, "RealtimeState.json")
        self.assertTrue(os.path.exists(realtime_path))
        with open(realtime_path, "r", encoding="utf-8") as handle:
            notice = json.load(handle)
        self.assertIn("workforce", notice["details"]["topics"])

    def test_file_type_and_warning_are_enforced(self):
        self.create_worker_assignment()
        token = self.worker_token()

        response = self.client.post(
            "/api/worker/submissions",
            data={
                "token": token,
                "eventId": "143",
                "kind": "invoice",
                "file": (io.BytesIO(PDF_BYTES), "invoice.pdf"),
            },
            content_type="multipart/form-data",
        )
        self.assertEqual(response.status_code, 400)

        response = self.client.post(
            "/api/worker/submissions",
            data={
                "token": token,
                "eventId": "143",
                "kind": "invoice",
                "warningAcknowledged": "true",
                "file": (io.BytesIO(b"not a pdf"), "invoice.pdf"),
            },
            content_type="multipart/form-data",
        )
        self.assertEqual(response.status_code, 400)

    def test_transport_booking_remembers_vendor_and_tracks_cost(self):
        self.login("admin", True)
        response = self.client.post(
            "/api/events/143/workforce/transport",
            json={
                "vehicleType": "24ft Lorry (Tail Lift)",
                "purpose": "Depart",
                "loadType": "Equipment",
                "companyDriver": "JM Express / Alan Tan",
                "contactNumber": "8122 6547",
                "vehicleNumber": "GBF 1234Z",
                "locationFrom": "Warehouse",
                "locationTo": "Test Venue",
                "departDate": "2026-07-10",
                "departTime": "08:00",
                "twoWay": True,
                "returnDate": "2026-07-12",
                "returnTime": "22:00",
                "cost": 560,
                "status": "Pending Review",
                "rememberVendor": True,
            },
        )
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()["data"]
        self.assertEqual(payload["totals"]["transport"], 560)
        self.assertEqual(len(payload["transportVendors"]), 1)
        self.assertEqual(
            payload["transportVendors"][0]["vehicleType"],
            "24ft Lorry (Tail Lift)",
        )

        booking = payload["transportBookings"][0]
        response = self.client.put(
            f"/api/events/143/workforce/transport/{booking['id']}",
            json={**booking, "status": "Approved"},
        )
        self.assertEqual(response.status_code, 200)
        approved = response.get_json()["data"]["transportBookings"][0]
        self.assertEqual(approved["status"], "Approved")


if __name__ == "__main__":
    unittest.main()
