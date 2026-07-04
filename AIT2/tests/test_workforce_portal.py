import io
import json
import os
import tempfile
import unittest
from unittest.mock import patch

import app as app_module
from data_manager import DataManager
from models import Event, User, hash_password
from workforce import _amount_from_text, load_workforce


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
            prepared_items=[
                "[MODEL]AU|Test Brand|Test Console|1|Audio requirement"
            ],
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

    def test_invoice_total_detection_prefers_final_amount(self):
        result = _amount_from_text(
            """
            INVOICE
            Subtotal
            1,000.00
            GST 9%
            90.00
            TOTAL AMOUNT DUE
            SGD 1,090.00
            """
        )
        self.assertEqual(result["amount"], 1090.00)
        self.assertEqual(result["confidence"], "High")

        result = _amount_from_text(
            """
            Services 850.00
            Tax 76.50
            Grand Total S$ 926.50
            """
        )
        self.assertEqual(result["amount"], 926.50)

        result = _amount_from_text(
            """
            TOTAL PAYABLE
            SGD 1,250
            """
        )
        self.assertEqual(result["amount"], 1250.00)

    def test_admin_can_rerun_invoice_ocr_to_prefill_amount(self):
        freelancer_id = self.create_worker_assignment()
        response = self.client.post(
            f"/api/events/143/workforce/submissions/{freelancer_id}",
            data={
                "kind": "invoice",
                "file": (io.BytesIO(PDF_BYTES), "scan-me.pdf"),
            },
            content_type="multipart/form-data",
        )
        self.assertEqual(response.status_code, 200)
        invoice = response.get_json()["data"]["submissions"][freelancer_id][
            "invoices"
        ][0]

        with patch.object(
            app_module,
            "extract_invoice_amount",
            return_value={
                "amount": 1388.40,
                "confidence": "High",
                "source": "Scanned document OCR",
                "matchedText": "TOTAL AMOUNT DUE SGD 1,388.40",
                "ocrUsed": True,
            },
        ):
            response = self.client.post(
                f"/api/workforce/submissions/{invoice['id']}/extract"
            )
        self.assertEqual(response.status_code, 200)
        rescanned = response.get_json()["data"]["submissions"][freelancer_id][
            "invoices"
        ][0]
        self.assertEqual(rescanned["amount"], 1388.40)
        self.assertTrue(rescanned["ocrRetriedAt"])

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

    def test_event_departments_come_from_assets_and_allow_manual_additions(self):
        self.login("admin", True)
        response = self.client.get("/api/events/143/workforce")
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()["data"]
        self.assertEqual(payload["event"]["startDateValue"], "2026-07-10")
        self.assertEqual(payload["event"]["endDateValue"], "2026-07-12")
        self.assertEqual(
            [row["code"] for row in payload["departments"]],
            ["AU"],
        )
        self.assertEqual(payload["departments"][0]["source"], "event-assets")

        response = self.client.post(
            "/api/events/143/workforce/departments",
            json={"code": "LI"},
        )
        self.assertEqual(response.status_code, 200)
        departments = response.get_json()["data"]["departments"]
        self.assertEqual(
            {row["code"] for row in departments},
            {"AU", "LI"},
        )
        lighting = next(row for row in departments if row["code"] == "LI")
        self.assertEqual(lighting["source"], "manual")

    def test_admin_can_upload_and_allow_additional_slots(self):
        freelancer_id = self.create_worker_assignment()

        response = self.client.post(
            f"/api/events/143/workforce/submissions/{freelancer_id}",
            data={
                "kind": "invoice",
                "amount": "450.00",
                "file": (io.BytesIO(PDF_BYTES), "admin-invoice.pdf"),
            },
            content_type="multipart/form-data",
        )
        self.assertEqual(response.status_code, 200)
        limits = response.get_json()["data"]["uploadAllowances"][freelancer_id]
        self.assertEqual(limits["activeInvoices"], 1)
        self.assertEqual(limits["invoiceSlotsRemaining"], 0)

        response = self.client.post(
            f"/api/events/143/workforce/submissions/{freelancer_id}",
            data={
                "kind": "invoice",
                "file": (io.BytesIO(PDF_BYTES), "blocked.pdf"),
            },
            content_type="multipart/form-data",
        )
        self.assertEqual(response.status_code, 409)

        response = self.client.post(
            f"/api/events/143/workforce/allowances/{freelancer_id}",
            json={"kind": "invoice", "count": 1},
        )
        self.assertEqual(response.status_code, 200)
        limits = response.get_json()["data"]["uploadAllowances"][freelancer_id]
        self.assertEqual(limits["invoiceLimit"], 2)
        self.assertEqual(limits["invoiceSlotsRemaining"], 1)

        response = self.client.post(
            f"/api/events/143/workforce/submissions/{freelancer_id}",
            data={
                "kind": "invoice",
                "amount": "200.00",
                "file": (io.BytesIO(PDF_BYTES), "extra-invoice.pdf"),
            },
            content_type="multipart/form-data",
        )
        self.assertEqual(response.status_code, 200)
        limits = response.get_json()["data"]["uploadAllowances"][freelancer_id]
        self.assertEqual(limits["activeInvoices"], 2)

        response = self.client.post(
            f"/api/events/143/workforce/submissions/{freelancer_id}",
            data={
                "kind": "claim",
                "amount": "28.50",
                "claimDate": "2026-07-10",
                "category": "Cab",
                "description": "Crew transport",
                "department": "AU",
                "file": (io.BytesIO(PNG_BYTES), "admin-claim.png"),
            },
            content_type="multipart/form-data",
        )
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()["data"]
        self.assertEqual(
            payload["uploadAllowances"][freelancer_id]["activeClaims"],
            1,
        )

        response = self.client.post(
            f"/api/events/143/workforce/allowances/{freelancer_id}",
            json={"kind": "claim", "delta": 1},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.get_json()["data"]["uploadAllowances"][freelancer_id][
                "claimLimit"
            ],
            6,
        )
        response = self.client.post(
            f"/api/events/143/workforce/allowances/{freelancer_id}",
            json={"kind": "claim", "delta": -1},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.get_json()["data"]["uploadAllowances"][freelancer_id][
                "claimLimit"
            ],
            5,
        )

    def test_empty_asset_department_can_be_hidden_and_manually_restored(self):
        self.login("admin", True)
        response = self.client.delete(
            "/api/events/143/workforce/departments/AU"
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["data"]["departments"], [])

        response = self.client.post(
            "/api/events/143/workforce/departments",
            json={"code": "AU", "name": "Audio"},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            [row["code"] for row in response.get_json()["data"]["departments"]],
            ["AU"],
        )

    def test_transport_profile_location_and_event_booking_are_separate(self):
        self.login("admin", True)
        minimal_profile = self.client.post(
            "/api/workforce/transport-profiles",
            json={"vehicleType": "Passenger Van"},
        )
        self.assertEqual(minimal_profile.status_code, 200)
        self.assertEqual(
            minimal_profile.get_json()["data"]["vehicleType"],
            "Passenger Van",
        )

        profile_response = self.client.post(
            "/api/workforce/transport-profiles",
            json={
                "vehicleType": "14ft Lorry",
                "company": "Swift Logistics",
                "driver": "David Foo",
                "contactNumber": "9000 1122",
                "vehicleNumber": "GBD 4321A",
            },
        )
        self.assertEqual(profile_response.status_code, 200)
        profile_id = profile_response.get_json()["data"]["id"]

        location_response = self.client.post(
            "/api/workforce/transport-locations",
            json={"name": "Main Warehouse"},
        )
        self.assertEqual(location_response.status_code, 200)

        booking_response = self.client.post(
            "/api/events/143/workforce/transport",
            json={
                "vendorId": profile_id,
                "locationFrom": "Main Warehouse",
                "locationTo": "Test Venue",
                "departDate": "2026-07-10",
                "departTime": "08:30",
                "cost": 450,
                "twoWay": False,
                "saveLocations": True,
            },
        )
        self.assertEqual(booking_response.status_code, 200)
        payload = booking_response.get_json()["data"]
        self.assertEqual(payload["transportBookings"][0]["company"], "Swift Logistics")
        self.assertEqual(
            {row["name"] for row in payload["transportLocations"]},
            {"Main Warehouse", "Test Venue"},
        )

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

    def test_first_approval_records_verification_once(self):
        freelancer_id = self.create_worker_assignment()
        response = self.client.post(
            f"/api/events/143/workforce/submissions/{freelancer_id}",
            data={
                "kind": "claim",
                "amount": "42.00",
                "claimDate": "2026-07-10",
                "category": "Meal",
                "description": "Crew meal",
                "department": "AU",
                "file": (io.BytesIO(PNG_BYTES), "meal.png"),
            },
            content_type="multipart/form-data",
        )
        claim = response.get_json()["data"]["submissions"][freelancer_id][
            "claims"
        ][0]
        response = self.client.put(
            f"/api/workforce/submissions/{claim['id']}",
            json={"amount": 42, "status": "Approved", "department": "AU"},
        )
        approved = response.get_json()["data"]["submissions"][freelancer_id][
            "claims"
        ][0]
        verified_at = approved["verifiedAt"]

        response = self.client.put(
            f"/api/workforce/submissions/{claim['id']}",
            json={"amount": 42, "status": "Pending Review", "department": "AU"},
        )
        pending = response.get_json()["data"]["submissions"][freelancer_id][
            "claims"
        ][0]
        self.assertEqual(pending["verifiedAt"], verified_at)

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
