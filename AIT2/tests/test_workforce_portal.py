import io
import threading
import json
import os
import tempfile
import unittest
from unittest.mock import patch

import app as app_module
from data_manager import DataManager
from models import Event, User, hash_password
from workforce import (
    _amount_from_text,
    _date_from_text,
    _ocr_result_text,
    load_workforce,
    mutate_workforce,
    now_iso,
)


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

        result = _amount_from_text("TotaI (SGD) INCL.GST 11.85")
        self.assertEqual(result["amount"], 11.85)

    def test_event_overview_exposes_operations_without_financial_data(self):
        event = self.manager.events[143]
        event.assigned_users = ['normal']
        with mutate_workforce(self.manager.data_folder) as workforce:
            workforce['freelancers'] = [{
                'id': 'worker-1', 'name': 'Alex Crew', 'phone': '+65 9000 0000'
            }]
            workforce['assignments'] = {'143': [{
                'id': 'assignment-1',
                'freelancerId': 'worker-1',
                'subjectType': 'worker',
                'department': 'AU',
                'roleName': 'Audio Technician',
                'days': 2,
                'workDates': ['2026-07-10', '2026-07-11'],
                'dailyRate': 450,
            }]}
            workforce['transportBookings'] = {'143': [{
                'id': 'transport-1',
                'company': 'Move Co',
                'driver': 'Sam',
                'contactNumber': '+65 8111 2222',
                'vehicleType': 'Lorry',
                'vehicleNumber': 'GBX1234A',
                'locationFrom': 'Warehouse',
                'locationTo': 'Test Venue',
                'departDate': '2026-07-10',
                'departTime': '08:00',
                'cost': 900,
                'status': 'Paid',
                'invoice': {'amount': 900},
            }]}
            workforce['submissions'] = {'143': {'worker-1': {
                'claims': [{'amount': 25}], 'invoices': [{'amount': 900}]
            }}}

        self.login('normal', False)
        response = self.client.get('/api/events/143/overview')

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()['data']
        self.assertEqual(payload['crew'][0]['name'], 'Alex Crew')
        self.assertEqual(payload['transport'][0]['vehicleNumber'], 'GBX1234A')
        serialized = json.dumps(payload).lower()
        for restricted in (
            'dailyrate', 'rateperpax', 'servicecost', 'cost', 'claim',
            'invoice', 'submission', 'payment', 'amount',
        ):
            self.assertNotIn(restricted, serialized)

    def test_claim_date_detection_prefers_receipt_date(self):
        result = _date_from_text(
            """
            RECEIPT
            Receipt Date: 04/07/2026
            Card expires 08/2029
            """
        )
        self.assertEqual(result["date"], "2026-07-04")

        result = _date_from_text("Transaction Date 5 July 2026")
        self.assertEqual(result["date"], "2026-07-05")

        result = _date_from_text("DATE\n05 JUL'26 18:42")
        self.assertEqual(result["date"], "2026-07-05")

        result = _date_from_text("30MAY202612:44")
        self.assertEqual(result["date"], "2026-05-30")

    def test_receipt_ocr_tokens_are_reassembled_by_line(self):
        result = _ocr_result_text([
            ([[10, 10], [40, 10], [40, 20], [10, 20]], "DATE", 0.99),
            ([[50, 10], [75, 10], [75, 20], [50, 20]], "05", 0.99),
            ([[80, 10], [95, 10], [95, 20], [80, 20]], "JUL", 0.99),
            ([[100, 10], [120, 10], [120, 20], [100, 20]], "'26", 0.99),
        ])
        self.assertEqual(result, "DATE 05 JUL '26")
        self.assertEqual(_date_from_text(result)["date"], "2026-07-05")

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

    def test_background_ocr_does_not_hold_the_workforce_store_lock(self):
        freelancer_id = self.create_worker_assignment()
        store_was_readable = []

        def extraction_while_checking_store(_path):
            finished = threading.Event()

            def read_store():
                app_module.load_workforce(app_module._workforce_folder())
                finished.set()

            reader = threading.Thread(target=read_store, daemon=True)
            reader.start()
            reader.join(timeout=1)
            store_was_readable.append(finished.is_set())
            return {
                "amount": 250,
                "confidence": "High",
                "source": "PDF text",
                "matchedText": "Total $250.00",
                "ocrUsed": False,
            }

        with patch.object(
            app_module,
            "extract_invoice_amount",
            side_effect=extraction_while_checking_store,
        ):
            response = self.client.post(
                f"/api/events/143/workforce/submissions/{freelancer_id}",
                data={
                    "kind": "invoice",
                    "file": (io.BytesIO(PDF_BYTES), "non-blocking.pdf"),
                },
                content_type="multipart/form-data",
            )

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertEqual(store_was_readable, [True])
        invoice = response.get_json()["data"]["submissions"][freelancer_id]["invoices"][0]
        self.assertEqual(invoice["processingState"], "Complete")

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

    def worker_access(self, password="1234"):
        with self.client.session_transaction() as session:
            session.clear()
        response = self.client.post(
            "/api/worker/lookup", json={"phone": "+65 9123 4567"}
        )
        self.assertEqual(response.status_code, 200)
        discovery = response.get_json()["data"]
        self.assertNotIn("companies", discovery)
        if discovery["requiresSetup"]:
            response = self.client.post(
                "/api/worker/setup-credentials",
                json={
                    "phone": "+65 9123 4567",
                    "password": password,
                    "confirmation": password,
                    "credentialType": "pin",
                },
            )
        else:
            response = self.client.post(
                "/api/worker/access",
                json={
                    "phone": "+65 9123 4567",
                    "password": password,
                },
            )
        self.assertEqual(response.status_code, 200)
        return response.get_json()["data"]

    def worker_token(self):
        company = self.worker_access()["companies"][0]
        self.assertEqual(company["events"][0]["id"], 143)
        return company["token"]

    def test_only_admins_can_open_event_workforce(self):
        self.login("normal", False)
        response = self.client.get("/api/events/143/workforce")
        self.assertEqual(response.status_code, 403)

        self.login("admin", True)
        response = self.client.get("/api/events/143/workforce")
        self.assertEqual(response.status_code, 200)

    def test_worker_first_access_requires_credentials(self):
        self.create_worker_assignment()
        with self.client.session_transaction() as session:
            session.clear()

        discovery = self.client.post(
            "/api/worker/lookup", json={"phone": "9123 4567"}
        )
        self.assertEqual(discovery.status_code, 200)
        self.assertTrue(discovery.get_json()["data"]["requiresSetup"])
        self.assertNotIn("companies", discovery.get_json()["data"])

        weak_pin = self.client.post(
            "/api/worker/setup-credentials",
            json={
                "phone": "9123 4567",
                "password": "12",
                "confirmation": "12",
                "credentialType": "pin",
            },
        )
        self.assertEqual(weak_pin.status_code, 400)

        portal = self.worker_access()
        self.assertEqual(portal["companies"][0]["freelancer"]["name"], "Jordan Dela Cruz")
        self.assertIn(
            "/api/company-branding/AVPL/logo",
            portal["companies"][0]["logoUrl"],
        )
        workforce = load_workforce(self.manager.data_folder)
        saved_worker = next(
            row for row in workforce["freelancers"]
            if row["name"] == "Jordan Dela Cruz"
        )
        self.assertTrue(saved_worker["workerLastLoginAt"])

        denied = self.client.post(
            "/api/worker/access",
            json={"phone": "9123 4567", "password": "9999"},
        )
        self.assertEqual(denied.status_code, 401)
        allowed = self.client.post(
            "/api/worker/access",
            json={"phone": "9123 4567", "password": "1234"},
        )
        self.assertEqual(allowed.status_code, 200)

    def test_unknown_worker_phone_returns_helpful_message(self):
        response = self.client.post(
            "/api/worker/lookup", json={"phone": "9000 0000"}
        )
        self.assertEqual(response.status_code, 404)
        self.assertEqual(
            response.get_json()["error"],
            (
                "Phone number not found. If you think this is a mistake, "
                "please contact the company administrator."
            ),
        )

    def test_worker_can_change_phone_and_credentials(self):
        self.create_worker_assignment()
        self.worker_access()
        response = self.client.post(
            "/api/worker/profile",
            json={
                "phone": "9123 4567",
                "newPhone": "9888 7766",
                "currentPassword": "1234",
                "newPassword": "new-worker-password",
                "confirmation": "new-worker-password",
                "credentialType": "password",
            },
        )
        self.assertEqual(response.status_code, 200)
        worker = response.get_json()["data"]["companies"][0]["freelancer"]
        self.assertEqual(worker["phone"], "+6598887766")
        self.assertEqual(worker["credentialType"], "password")

        old_access = self.client.post(
            "/api/worker/access",
            json={"phone": "9123 4567", "password": "1234"},
        )
        self.assertEqual(old_access.status_code, 401)
        new_access = self.client.post(
            "/api/worker/access",
            json={
                "phone": "9888 7766",
                "password": "new-worker-password",
            },
        )
        self.assertEqual(new_access.status_code, 200)

    def test_admin_can_reset_worker_login_and_revoke_existing_session(self):
        freelancer_id = self.create_worker_assignment()
        portal = self.worker_access()
        old_token = portal["companies"][0]["token"]

        self.login("admin", True)
        admin_payload = self.client.get(
            "/api/events/143/workforce"
        ).get_json()["data"]
        freelancer = next(
            row for row in admin_payload["freelancers"]
            if row["id"] == freelancer_id
        )
        self.assertTrue(freelancer["workerLoginConfigured"])
        self.assertNotIn("workerPasswordHash", freelancer)
        self.assertNotIn("workerPasswordSalt", freelancer)

        response = self.client.post(
            f"/api/workforce/freelancers/{freelancer_id}/reset-login"
        )
        self.assertEqual(response.status_code, 200)

        revoked = self.client.post(
            "/api/worker/company", json={"token": old_token}
        )
        self.assertEqual(revoked.status_code, 401)
        old_login = self.client.post(
            "/api/worker/access",
            json={"phone": "9123 4567", "password": "1234"},
        )
        self.assertEqual(old_login.status_code, 401)
        discovery = self.client.post(
            "/api/worker/lookup", json={"phone": "9123 4567"}
        )
        self.assertTrue(discovery.get_json()["data"]["requiresSetup"])

        new_login = self.client.post(
            "/api/worker/setup-credentials",
            json={
                "phone": "9123 4567",
                "password": "5678",
                "confirmation": "5678",
                "credentialType": "pin",
            },
        )
        self.assertEqual(new_login.status_code, 200)

    def test_calendar_date_alone_does_not_move_worker_event_to_past(self):
        self.create_worker_assignment()
        event = self.manager.events[143]
        event.start_date = "20200101"
        event.end_date = "20200102"
        self.manager.save_event(event)

        portal = self.worker_access()
        worker_event = portal["companies"][0]["events"][0]
        self.assertFalse(worker_event["paymentComplete"])
        self.assertFalse(worker_event["isPast"])

    def test_returned_event_waits_for_worker_receipt_confirmation(self):
        freelancer_id = self.create_worker_assignment()
        event = self.manager.events[143]
        event.prepared_items = ["A-001"]
        event.actually_prepared = []
        event.returned_items = ["A-001"]

        app_module.update_event_state(event)
        self.assertEqual(event.state, "Pending Closure")

        with mutate_workforce(self.manager.data_folder) as workforce:
            workforce.setdefault("submissions", {}).setdefault(
                "143", {}
            )[freelancer_id] = {
                "invoices": [{
                    "id": "invoice-paid",
                    "status": "Paid",
                    "paymentConfirmedAt": now_iso(),
                }],
                "claims": [],
            }

        app_module.update_event_state(event)
        self.assertEqual(event.state, "Closed")

        with mutate_workforce(self.manager.data_folder) as workforce:
            invoice = workforce["submissions"]["143"][freelancer_id][
                "invoices"
            ][0]
            invoice.pop("paymentConfirmedAt")
            invoice["status"] = "Approved"

        app_module.update_event_state(event)
        self.assertEqual(event.state, "Pending Closure")

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

    def test_first_invoice_review_defaults_single_department_allocation(self):
        freelancer_id = self.create_worker_assignment()
        response = self.client.post(
            f"/api/events/143/workforce/submissions/{freelancer_id}",
            data={
                "kind": "invoice",
                "file": (io.BytesIO(PDF_BYTES), "invoice.pdf"),
            },
            content_type="multipart/form-data",
        )
        invoice = response.get_json()["data"]["submissions"][freelancer_id][
            "invoices"
        ][0]

        blocked = self.client.put(
            f"/api/workforce/submissions/{invoice['id']}",
            json={"amount": 100, "status": "Paid"},
        )
        self.assertEqual(blocked.status_code, 409)

        response = self.client.put(
            f"/api/workforce/submissions/{invoice['id']}",
            json={
                "amount": 100,
                "status": "Paid",
                "allocations": [],
                "confirmReview": True,
            },
        )
        self.assertEqual(response.status_code, 200)
        reviewed = response.get_json()["data"]["submissions"][freelancer_id][
            "invoices"
        ][0]
        self.assertEqual(reviewed["status"], "Paid")
        self.assertEqual(
            reviewed["allocations"],
            [{"department": "AU", "amount": 100.0}],
        )

    def test_first_invoice_review_evenly_splits_multiple_departments(self):
        freelancer_id = self.create_worker_assignment()
        response = self.client.post(
            "/api/events/143/workforce/departments",
            json={"code": "LI"},
        )
        self.assertEqual(response.status_code, 200)
        response = self.client.post(
            "/api/events/143/workforce/assignments",
            json={
                "freelancerId": freelancer_id,
                "department": "LI",
                "customRole": "Lighting Technician",
                "days": 1,
                "dailyRate": 250,
            },
        )
        self.assertEqual(response.status_code, 200)
        response = self.client.post(
            f"/api/events/143/workforce/submissions/{freelancer_id}",
            data={
                "kind": "invoice",
                "file": (io.BytesIO(PDF_BYTES), "invoice.pdf"),
            },
            content_type="multipart/form-data",
        )
        invoice = response.get_json()["data"]["submissions"][freelancer_id][
            "invoices"
        ][0]

        response = self.client.put(
            f"/api/workforce/submissions/{invoice['id']}",
            json={
                "amount": 100.01,
                "status": "Approved",
                "allocations": [],
                "confirmReview": True,
            },
        )
        self.assertEqual(response.status_code, 200)
        reviewed = response.get_json()["data"]["submissions"][freelancer_id][
            "invoices"
        ][0]
        self.assertEqual(
            reviewed["allocations"],
            [
                {"department": "AU", "amount": 50.01},
                {"department": "LI", "amount": 50.0},
            ],
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
                "confirmReview": True,
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
        submitted = public_event["submissions"]["invoices"][0]
        self.assertEqual(submitted["originalName"], "invoice.pdf")
        self.assertTrue(submitted["canEdit"])

    def test_worker_can_view_remove_and_confirm_paid_submissions(self):
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
        submitted = response.get_json()["data"]["events"][0]["submissions"]["invoices"][0]
        upload_log = self.manager.events[143].event_logs[-1]
        self.assertEqual(upload_log["user"], "Jordan Dela Cruz")
        self.assertIn("uploaded 1 invoice", upload_log["action"])

        file_response = self.client.get(submitted["fileUrl"])
        self.assertEqual(file_response.status_code, 200)
        file_response.close()
        removed = self.client.delete(
            f"/api/worker/submissions/{submitted['id']}",
            json={"token": token},
        )
        self.assertEqual(removed.status_code, 200)
        self.assertEqual(
            removed.get_json()["data"]["events"][0]["invoiceSlotsRemaining"], 1
        )

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
        invoice_id = response.get_json()["data"]["events"][0]["submissions"]["invoices"][0]["id"]
        self.login("admin", True)
        approved = self.client.put(
            f"/api/workforce/submissions/{invoice_id}",
            json={
                "amount": 500,
                "status": "Approved",
                "department": "AU",
                "confirmReview": True,
            },
        )
        self.assertEqual(approved.status_code, 200)
        paid = self.client.put(
            f"/api/workforce/submissions/{invoice_id}",
            json={"amount": 500, "status": "Paid", "department": "AU"},
        )
        self.assertEqual(paid.status_code, 200)

        portal = self.worker_access()
        company = portal["companies"][0]
        paid_row = company["events"][0]["submissions"]["invoices"][0]
        self.assertTrue(paid_row["canConfirmPayment"])
        confirmed = self.client.post(
            f"/api/worker/submissions/{invoice_id}/confirm-payment",
            json={"token": company["token"]},
        )
        self.assertEqual(confirmed.status_code, 200)
        event = confirmed.get_json()["data"]["events"][0]
        self.assertTrue(event["paymentComplete"])
        self.assertTrue(event["isPast"])
        received_log = self.manager.events[143].event_logs[-1]
        self.assertEqual(received_log["user"], "Jordan Dela Cruz")
        self.assertIn("marked invoice", received_log["action"])
        self.assertIn("as received", received_log["action"])

        self.login("admin", True)
        admin_payload = self.client.get(
            "/api/events/143/workforce"
        ).get_json()["data"]
        admin_invoice = admin_payload["submissions"][freelancer_id]["invoices"][0]
        self.assertTrue(admin_invoice["paymentConfirmedAt"])

        response = self.client.put(
            f"/api/workforce/submissions/{invoice_id}",
            json={
                "status": "Paid",
                "clearPaymentConfirmation": True,
            },
        )
        self.assertEqual(response.status_code, 200)
        reopened_as_paid = response.get_json()["data"]["submissions"][
            freelancer_id
        ]["invoices"][0]
        self.assertEqual(reopened_as_paid["status"], "Paid")
        self.assertNotIn("paymentConfirmedAt", reopened_as_paid)

        portal = self.worker_access()
        company = portal["companies"][0]
        paid_row = company["events"][0]["submissions"]["invoices"][0]
        self.assertTrue(paid_row["canConfirmPayment"])
        response = self.client.post(
            f"/api/worker/submissions/{invoice_id}/confirm-payment",
            json={"token": company["token"]},
        )
        self.assertEqual(response.status_code, 200)

        self.login("admin", True)
        response = self.client.put(
            f"/api/workforce/submissions/{invoice_id}",
            json={
                "status": "Denied",
                "denialReason": "The invoice is addressed to the wrong company",
            },
        )
        self.assertEqual(response.status_code, 200)
        reopened = response.get_json()["data"]["submissions"][freelancer_id][
            "invoices"
        ][0]
        self.assertEqual(reopened["status"], "Denied")
        self.assertNotIn("paymentConfirmedAt", reopened)

        portal = self.worker_access()
        worker_event = portal["companies"][0]["events"][0]
        self.assertFalse(worker_event["isPast"])
        denied = worker_event["submissions"]["invoices"][0]
        self.assertEqual(
            denied["denialReason"],
            "The invoice is addressed to the wrong company",
        )

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

    def test_claim_files_can_be_uploaded_together_then_completed(self):
        freelancer_id = self.create_worker_assignment()
        token = self.worker_token()
        detected = {
            "amount": 12.40,
            "date": "2026-07-09",
            "dateMatchedText": "Receipt Date: 09/07/2026",
            "confidence": "High",
            "source": "Receipt image OCR",
            "matchedText": "TOTAL 12.40",
            "ocrUsed": True,
        }
        with patch.object(
            app_module, "extract_claim_amount", return_value=detected
        ):
            response = self.client.post(
                "/api/worker/submissions",
                data={
                    "token": token,
                    "eventId": "143",
                    "kind": "claim",
                    "warningAcknowledged": "true",
                    "files": [
                        (io.BytesIO(PNG_BYTES), "cab.png"),
                        (io.BytesIO(PNG_BYTES), "meal.png"),
                    ],
                },
                content_type="multipart/form-data",
            )
        self.assertEqual(response.status_code, 200)
        event = response.get_json()["data"]["events"][0]
        claims = event["submissions"]["claims"]
        self.assertEqual(len(claims), 2)
        self.assertTrue(all(row["status"] == "Details Required" for row in claims))
        self.assertTrue(all(row["amount"] == 12.4 for row in claims))
        self.assertTrue(all(row["claimDate"] == "2026-07-09" for row in claims))
        self.assertEqual(event["claimTotal"], 0)

        completed = self.client.post(
            f"/api/worker/submissions/{claims[0]['id']}/details",
            json={
                "token": token,
                "amount": "12.40",
                "claimDate": "2026-07-10",
                "category": "Cab",
                "notes": "Ride to the venue",
            },
        )
        self.assertEqual(completed.status_code, 200)
        completed_event = completed.get_json()["data"]["events"][0]
        completed_claim = completed_event["submissions"]["claims"][0]
        self.assertEqual(completed_claim["status"], "Pending Review")
        self.assertEqual(completed_claim["notes"], "Ride to the venue")
        self.assertEqual(completed_event["claimTotal"], 12.4)

        saved = load_workforce(self.tempdir.name)
        saved_claim = saved["submissions"]["143"][freelancer_id]["claims"][0]
        self.assertTrue(saved_claim["detailsComplete"])

    def test_admin_can_confirm_payment_for_worker(self):
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
        invoice_id = response.get_json()["data"]["events"][0][
            "submissions"
        ]["invoices"][0]["id"]

        self.login("admin", True)
        reviewed = self.client.put(
            f"/api/workforce/submissions/{invoice_id}",
            json={
                "amount": 500,
                "status": "Paid",
                "confirmReview": True,
                "allocations": [{"department": "AU", "amount": 500}],
            },
        )
        self.assertEqual(reviewed.status_code, 200)
        confirmed = self.client.put(
            f"/api/workforce/submissions/{invoice_id}",
            json={
                "status": "Paid",
                "adminConfirmPayment": True,
            },
        )
        self.assertEqual(confirmed.status_code, 200)
        row = confirmed.get_json()["data"]["submissions"][freelancer_id][
            "invoices"
        ][0]
        self.assertTrue(row["paymentConfirmedAt"])
        self.assertEqual(row["paymentConfirmedByAdmin"], "admin")
        self.assertFalse(row["paymentConfirmedByWorker"])

        portal = self.worker_access()
        worker_event = portal["companies"][0]["events"][0]
        self.assertTrue(worker_event["isPast"])
        self.assertEqual(
            worker_event["submissions"]["invoices"][0]["status"],
            "Payment Confirmed",
        )

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
            json={
                "amount": 42,
                "status": "Approved",
                "claimDate": "2026-07-11",
                "category": "Transport",
                "confirmReview": True,
            },
        )
        approved = response.get_json()["data"]["submissions"][freelancer_id][
            "claims"
        ][0]
        verified_at = approved["verifiedAt"]
        self.assertEqual(approved["claimDate"], "2026-07-11")
        self.assertEqual(approved["category"], "Transport")

        response = self.client.put(
            f"/api/workforce/submissions/{claim['id']}",
            json={"amount": 99, "status": "Pending Review", "department": "LI"},
        )
        pending = response.get_json()["data"]["submissions"][freelancer_id][
            "claims"
        ][0]
        self.assertEqual(pending["verifiedAt"], verified_at)
        self.assertEqual(pending["amount"], 42)
        self.assertEqual(pending["department"], "AU")

    def test_save_and_close_verifies_invoice_without_approving(self):
        freelancer_id = self.create_worker_assignment()
        response = self.client.post(
            f"/api/events/143/workforce/submissions/{freelancer_id}",
            data={
                "kind": "invoice",
                "amount": "120.00",
                "file": (io.BytesIO(PDF_BYTES), "save-close.pdf"),
            },
            content_type="multipart/form-data",
        )
        invoice = response.get_json()["data"]["submissions"][freelancer_id][
            "invoices"
        ][0]

        response = self.client.put(
            f"/api/workforce/submissions/{invoice['id']}",
            json={
                "amount": 120,
                "status": "Pending Review",
                "allocations": [{"department": "AU", "amount": 120}],
                "confirmReview": True,
            },
        )
        self.assertEqual(response.status_code, 200)
        saved = response.get_json()["data"]["submissions"][freelancer_id][
            "invoices"
        ][0]
        self.assertEqual(saved["status"], "Pending Review")
        self.assertTrue(saved["verifiedAt"])
        self.assertEqual(saved["allocations"][0]["amount"], 120)

        response = self.client.put(
            f"/api/workforce/submissions/{invoice['id']}",
            json={"status": "Approved", "amount": 999},
        )
        self.assertEqual(response.status_code, 200)
        approved = response.get_json()["data"]["submissions"][freelancer_id][
            "invoices"
        ][0]
        self.assertEqual(approved["status"], "Approved")
        self.assertEqual(approved["amount"], 120)

    def test_worker_directory_submission_summary(self):
        freelancer_id = self.create_worker_assignment()
        payload = self.client.get(
            "/api/events/143/workforce"
        ).get_json()["data"]
        worker = next(
            row for row in payload["freelancers"]
            if row["id"] == freelancer_id
        )
        self.assertEqual(worker["submissionSummary"]["needsInvoice"], 1)

        response = self.client.post(
            f"/api/events/143/workforce/submissions/{freelancer_id}",
            data={
                "kind": "invoice",
                "amount": "120.00",
                "file": (io.BytesIO(PDF_BYTES), "pending.pdf"),
            },
            content_type="multipart/form-data",
        )
        worker = next(
            row for row in response.get_json()["data"]["freelancers"]
            if row["id"] == freelancer_id
        )
        self.assertEqual(worker["submissionSummary"]["needsInvoice"], 0)
        self.assertEqual(worker["submissionSummary"]["needsReview"], 1)

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
        self.assertEqual(payload["totals"]["transport"], 1120)
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

    def test_saved_transport_locations_keep_venue_and_address(self):
        self.login("admin", True)
        response = self.client.post(
            "/api/workforce/transport-locations",
            json={
                "name": "Suntec Convention Centre",
                "address": "1 Raffles Boulevard, Singapore 039593",
            },
        )
        self.assertEqual(response.status_code, 200)
        location = response.get_json()["data"]
        self.assertEqual(location["name"], "Suntec Convention Centre")
        self.assertEqual(
            location["address"], "1 Raffles Boulevard, Singapore 039593"
        )

    def test_assignment_work_dates_can_be_created_and_edited(self):
        freelancer_id = self.create_worker_assignment()
        payload = self.client.get(
            "/api/events/143/workforce"
        ).get_json()["data"]
        assignment = payload["assignments"][0]

        response = self.client.put(
            f"/api/events/143/workforce/assignments/{assignment['id']}",
            json={
                "department": "AU",
                "customRole": "Lead Audio Engineer",
                "workDates": ["2026-07-10", "2026-07-12"],
                "dailyRate": 350,
            },
        )
        self.assertEqual(response.status_code, 200)
        updated = response.get_json()["data"]["assignments"][0]
        self.assertEqual(updated["freelancerId"], freelancer_id)
        self.assertEqual(updated["days"], 2)
        self.assertEqual(
            updated["workDates"], ["2026-07-10", "2026-07-12"]
        )
        self.assertEqual(updated["roleName"], "Lead Audio Engineer")

        response = self.client.put(
            f"/api/events/143/workforce/assignments/{assignment['id']}",
            json={
                "department": "AU",
                "customRole": "Lead Audio Engineer",
                "workDates": ["2026-07-13"],
                "dailyRate": 350,
            },
        )
        self.assertEqual(response.status_code, 400)

    def test_admin_can_upload_multiple_claims_in_one_request(self):
        freelancer_id = self.create_worker_assignment()
        extraction = {
            "amount": 12.50,
            "date": "2026-07-10",
            "confidence": "High",
            "source": "Test OCR",
            "matchedText": "TOTAL 12.50",
            "dateMatchedText": "10/07/2026",
            "ocrUsed": True,
        }
        with patch.object(
            app_module, "extract_claim_amount", return_value=extraction
        ):
            response = self.client.post(
                f"/api/events/143/workforce/submissions/{freelancer_id}",
                data={
                    "kind": "claim",
                    "files": [
                        (io.BytesIO(PNG_BYTES), "meal.png"),
                        (io.BytesIO(PNG_BYTES), "parking.png"),
                    ],
                },
                content_type="multipart/form-data",
            )
        self.assertEqual(response.status_code, 200)
        claims = response.get_json()["data"]["submissions"][freelancer_id][
            "claims"
        ]
        self.assertEqual(len(claims), 2)
        self.assertTrue(all(row["amount"] == 12.50 for row in claims))
        self.assertTrue(
            all(row["claimDate"] == "2026-07-10" for row in claims)
        )
        self.assertTrue(
            all(row["submissionStage"] == "Submitted" for row in claims)
        )

    def test_freelancer_history_includes_event_and_submission_statuses(self):
        freelancer_id = self.create_worker_assignment()
        response = self.client.post(
            f"/api/events/143/workforce/submissions/{freelancer_id}",
            data={
                "kind": "invoice",
                "amount": "450.00",
                "file": (io.BytesIO(PDF_BYTES), "history-invoice.pdf"),
            },
            content_type="multipart/form-data",
        )
        self.assertEqual(response.status_code, 200)

        later_event = Event(
            144,
            "Later Production",
            "20260715",
            "20260716",
            [],
            prepared_items=[
                "[MODEL]AU|Test Brand|Test Console|1|Audio requirement"
            ],
            returned_items=[],
            actually_prepared=[],
            extra_assets=[],
            tag="events",
            location="Later Venue",
        )
        self.manager.events[later_event.event_id] = later_event
        self.manager.save_event(later_event)
        response = self.client.post(
            "/api/events/144/workforce/assignments",
            json={
                "freelancerId": freelancer_id,
                "department": "AU",
                "customRole": "Audio Engineer",
                "workDates": ["2026-07-15"],
                "dailyRate": 280,
            },
        )
        self.assertEqual(response.status_code, 200)

        response = self.client.get(
            f"/api/workforce/freelancers/{freelancer_id}/history"
        )
        self.assertEqual(response.status_code, 200)
        history = response.get_json()["data"]
        self.assertEqual(history["company"]["code"], "AVPL")
        self.assertEqual(history["freelancer"]["id"], freelancer_id)
        self.assertEqual(
            [event["id"] for event in history["events"]], [144, 143]
        )
        submitted_event = next(
            event for event in history["events"] if event["id"] == 143
        )
        self.assertEqual(
            submitted_event["invoices"][0]["status"], "Pending Review"
        )
        self.assertIn(
            "/api/workforce/submissions/",
            submitted_event["invoices"][0]["previewUrl"],
        )
        self.assertEqual(submitted_event["invoiceLimit"], 1)
        self.assertEqual(submitted_event["claimLimit"], 5)
        self.assertTrue(history["events"][0]["roles"][0]["id"])

    def test_worker_login_log_is_visible_only_to_super_admins(self):
        freelancer_id = self.create_worker_assignment()
        self.worker_access()
        self.worker_access()

        self.login("admin", True)
        response = self.client.get("/api/logs")
        self.assertEqual(response.status_code, 200)
        self.assertFalse(any(
            "logged in" in row["action"]
            for row in response.get_json()["data"]
        ))

        with patch.object(
            app_module, "_current_user_is_super_admin", return_value=True
        ):
            response = self.client.get("/api/logs")
        self.assertEqual(response.status_code, 200)
        self.assertTrue(any(
            "Worker Jordan Dela Cruz logged in" == row["action"]
            for row in response.get_json()["data"]
        ))

        workforce = load_workforce(self.manager.data_folder)
        freelancer = next(
            row for row in workforce["freelancers"]
            if row["id"] == freelancer_id
        )
        self.assertTrue(freelancer["workerLastLoginAt"])

    def test_vendor_assignments_share_one_invoice_across_departments(self):
        self.login("admin", True)
        member_ids = []
        for name, phone in (
            ("Morgan Lee", "8222 1100"),
            ("Sam Tan", "8333 2200"),
        ):
            response = self.client.post(
                "/api/workforce/freelancers",
                json={"name": name, "phone": phone},
            )
            self.assertEqual(response.status_code, 200)
            member_ids.append(response.get_json()["data"]["id"])

        response = self.client.post(
            "/api/workforce/vendors",
            json={
                "name": "HighCrew Resources",
                "memberIds": member_ids,
            },
        )
        self.assertEqual(response.status_code, 200)
        vendor_id = response.get_json()["data"]["id"]

        response = self.client.post(
            "/api/events/143/workforce/departments",
            json={"code": "LI", "name": "Lighting"},
        )
        self.assertEqual(response.status_code, 200)

        response = self.client.post(
            "/api/events/143/workforce/assignments",
            json={
                "vendorId": vendor_id,
                "department": "AU",
                "providerType": "manpower",
                "workDates": ["2026-07-10", "2026-07-11"],
                "pax": 5,
                "ratePerPax": 200,
            },
        )
        self.assertEqual(response.status_code, 200)
        response = self.client.post(
            "/api/events/143/workforce/assignments",
            json={
                "vendorId": vendor_id,
                "department": "LI",
                "providerType": "service",
                "workDates": ["2026-07-12"],
                "serviceName": "Backline support",
                "serviceCost": 3000,
            },
        )
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()["data"]
        vendor = next(row for row in payload["vendors"] if row["id"] == vendor_id)
        self.assertEqual(
            {row["id"] for row in vendor["members"]},
            set(member_ids),
        )
        vendor_assignments = [
            row for row in payload["assignments"]
            if row.get("vendorId") == vendor_id
        ]
        self.assertEqual(len(vendor_assignments), 2)
        self.assertEqual(
            {row["providerType"] for row in vendor_assignments},
            {"manpower", "service"},
        )

        response = self.client.post(
            f"/api/events/143/workforce/submissions/{vendor_id}",
            data={
                "kind": "invoice",
                "file": (io.BytesIO(PDF_BYTES), "highcrew.pdf"),
            },
            content_type="multipart/form-data",
        )
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()["data"]
        self.assertEqual(
            len(payload["submissions"][vendor_id]["invoices"]), 1
        )
        self.assertEqual(
            payload["uploadAllowances"][vendor_id]["invoiceLimit"], 1
        )
        response = self.client.post(
            f"/api/events/143/workforce/submissions/{vendor_id}",
            data={
                "kind": "claim",
                "file": (io.BytesIO(PDF_BYTES), "vendor-claim.pdf"),
            },
            content_type="multipart/form-data",
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            len(
                response.get_json()["data"]["submissions"][vendor_id][
                    "claims"
                ]
            ),
            1,
        )

        with self.client.session_transaction() as session:
            session.clear()
        response = self.client.post(
            "/api/worker/lookup", json={"phone": "8222 1100"}
        )
        self.assertEqual(response.status_code, 200)
        response = self.client.post(
            "/api/worker/setup-credentials",
            json={
                "phone": "8222 1100",
                "password": "1234",
                "confirmation": "1234",
                "credentialType": "pin",
            },
        )
        self.assertEqual(response.status_code, 200)
        portal_event = response.get_json()["data"]["companies"][0]["events"][0]
        self.assertEqual(portal_event["subjectType"], "vendor")
        self.assertEqual(portal_event["subjectName"], "HighCrew Resources")
        self.assertEqual(
            set(portal_event["departments"]), {"AU", "LI"}
        )
        self.assertEqual(
            len(portal_event["submissions"]["invoices"]), 1
        )
        self.assertEqual(
            len(portal_event["submissions"]["claims"]), 1
        )
        self.assertEqual(portal_event["claimLimit"], 5)

        with self.client.session_transaction() as session:
            session.clear()
        response = self.client.post(
            "/api/worker/lookup", json={"phone": "8333 2200"}
        )
        self.assertEqual(response.status_code, 200)
        response = self.client.post(
            "/api/worker/setup-credentials",
            json={
                "phone": "8333 2200",
                "password": "5678",
                "confirmation": "5678",
                "credentialType": "pin",
            },
        )
        self.assertEqual(response.status_code, 200)
        second_member_event = (
            response.get_json()["data"]["companies"][0]["events"][0]
        )
        self.assertEqual(second_member_event["subjectId"], vendor_id)
        self.assertEqual(
            second_member_event["submissions"]["invoices"][0]["originalName"],
            "highcrew.pdf",
        )
        self.assertEqual(
            second_member_event["submissions"]["claims"][0]["originalName"],
            "vendor-claim.pdf",
        )

    def test_vendor_profile_persists_after_disk_reload(self):
        self.login("admin", True)
        response = self.client.post(
            "/api/workforce/vendors",
            json={"name": "Durable Backline Vendor"},
        )
        self.assertEqual(response.status_code, 200)
        vendor_id = response.get_json()["data"]["id"]

        saved = load_workforce(self.manager.data_folder)
        saved_vendor = next(
            row for row in saved["vendors"]
            if row["id"] == vendor_id
        )
        self.assertEqual(saved_vendor["name"], "Durable Backline Vendor")

        response = self.client.put(
            f"/api/workforce/vendors/{vendor_id}",
            json={"name": "Durable Backline Vendor Updated"},
        )
        self.assertEqual(response.status_code, 200)

        reloaded = load_workforce(self.manager.data_folder)
        reloaded_vendor = next(
            row for row in reloaded["vendors"]
            if row["id"] == vendor_id
        )
        self.assertEqual(
            reloaded_vendor["name"],
            "Durable Backline Vendor Updated",
        )

    def test_vendor_opens_the_same_full_event_history_as_a_worker(self):
        self.login("admin", True)
        response = self.client.post(
            "/api/workforce/vendors",
            json={"name": "History Backline Vendor"},
        )
        self.assertEqual(response.status_code, 200)
        vendor_id = response.get_json()["data"]["id"]

        response = self.client.post(
            "/api/events/143/workforce/assignments",
            json={
                "vendorId": vendor_id,
                "department": "AU",
                "providerType": "service",
                "workDates": ["2026-07-10"],
                "serviceName": "Backline support",
                "serviceCost": 1200,
            },
        )
        self.assertEqual(response.status_code, 200)

        response = self.client.get(
            f"/api/workforce/subjects/{vendor_id}/history"
        )
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()["data"]
        self.assertEqual(payload["subjectType"], "vendor")
        self.assertEqual(payload["subject"]["name"], "History Backline Vendor")
        self.assertEqual(payload["events"][0]["id"], 143)
        self.assertEqual(
            payload["events"][0]["roles"][0]["role"],
            "Backline support",
        )

    def test_vendor_personnel_can_be_added_without_becoming_a_worker(self):
        self.login("admin", True)
        response = self.client.post(
            "/api/workforce/personnel",
            json={
                "name": "Vendor Accounts",
                "phone": "8444 3300",
                "email": "accounts@example.test",
            },
        )
        self.assertEqual(response.status_code, 200)
        person = response.get_json()["data"]
        self.assertTrue(person["personnelOnly"])

        response = self.client.post(
            "/api/workforce/vendors",
            json={
                "name": "Backline Vendor",
                "memberIds": [person["id"]],
            },
        )
        self.assertEqual(response.status_code, 200)
        vendor_id = response.get_json()["data"]["id"]
        response = self.client.post(
            "/api/events/143/workforce/assignments",
            json={
                "vendorId": vendor_id,
                "department": "AU",
                "providerType": "service",
                "workDates": ["2026-07-10"],
                "serviceName": "Backline support",
                "serviceCost": 1500,
            },
        )
        self.assertEqual(response.status_code, 200)

        with self.client.session_transaction() as session:
            session.clear()
        response = self.client.post(
            "/api/worker/lookup", json={"phone": "8444 3300"}
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.get_json()["data"]["name"], "Vendor Accounts"
        )

        self.login("admin", True)
        response = self.client.post(
            "/api/workforce/freelancers",
            json={"name": "Vendor Accounts", "phone": "8444 3300"},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["data"]["id"], person["id"])
        self.assertFalse(response.get_json()["data"]["personnelOnly"])

    def test_vendor_assignment_rejects_dates_outside_event(self):
        self.login("admin", True)
        response = self.client.post(
            "/api/workforce/vendors",
            json={"name": "Month Span Crew"},
        )
        vendor_id = response.get_json()["data"]["id"]
        response = self.client.post(
            "/api/events/143/workforce/assignments",
            json={
                "vendorId": vendor_id,
                "department": "AU",
                "providerType": "manpower",
                "workDates": ["2026-08-01"],
                "pax": 2,
                "ratePerPax": 180,
            },
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("within the event", response.get_json()["error"])

    def test_admin_and_worker_upload_surfaces_support_drag_and_drop(self):
        static_folder = os.path.join(os.path.dirname(app_module.__file__), "static", "js")
        with open(os.path.join(static_folder, "workforce-admin.js"), encoding="utf-8") as source_file:
            admin_source = source_file.read()
        with open(os.path.join(static_folder, "worker.js"), encoding="utf-8") as source_file:
            worker_source = source_file.read()
        self.assertIn("wfAdminUploadDropzone", admin_source)
        self.assertIn("event.dataTransfer?.files", admin_source)
        self.assertIn("new DataTransfer()", admin_source)
        self.assertIn("event-dropzone", worker_source)
        self.assertIn("dataTransfer.files", worker_source)


if __name__ == "__main__":
    unittest.main()
