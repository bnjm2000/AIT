import io
import threading
import json
import os
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

from pypdf import PdfReader

import app as app_module
from data_manager import DataManager
from models import Event, InventoryItem, User, hash_password
from workforce import (
    _amount_from_text,
    _date_from_text,
    _ocr_result_text,
    load_workforce,
    mutate_workforce,
    now_iso,
)
from workforce_schedule import build_workforce_schedule_pdf


PDF_BYTES = b"%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF"
PNG_BYTES = b"\x89PNG\r\n\x1a\n" + b"test-image"
XLS_BYTES = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + b"test-workbook"


def _xlsx_bytes():
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as workbook:
        workbook.writestr("[Content_Types].xml", "<Types />")
        workbook.writestr("xl/workbook.xml", "<workbook />")
    return output.getvalue()


XLSX_BYTES = _xlsx_bytes()


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
            "AU": {
                "name": "Audio",
                "color": "#CDEBFF",
                "textColor": "#174A67",
            },
            "LI": {
                "name": "Lighting",
                "color": "#DDF5DF",
                "textColor": "#275B2D",
            },
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

        result = _amount_from_text(
            """
            Engineer 01 400 1 400 -
            Total amount payable: 400 -
            Payment is to be made within three(3) months upon receipt of this invoice.
            Late fees are charged at zero point five (0.5) percent (%) of the
            Total amount payable after three(3) months of no payment.
            """
        )
        self.assertEqual(result["amount"], 400.00)
        self.assertEqual(result["confidence"], "High")
        self.assertEqual(result["matchedText"], "Total amount payable: 400 -")

        result = _amount_from_text(
            """
            Subtotal 46.00
            MDS Surcharge 4.80
            Other Total (incl GST) 50.80
            MOP McDelivery 50.80
            Change 0.00
            TOTAL INCLUDES GST OF 4.19
            """
        )
        self.assertEqual(result["amount"], 50.80)
        self.assertNotEqual(result["matchedText"], "TOTAL INCLUDES GST OF 4.19")

    def test_admin_submission_queue_defaults_to_attention_and_sorts_by_event_then_name(self):
        later_event = Event(
            144,
            "Later Production",
            "20260720",
            "20260720",
            [],
            location="Later Venue",
        )
        self.manager.events[later_event.event_id] = later_event
        self.manager.save_event(later_event)
        with mutate_workforce(self.manager.data_folder) as workforce:
            workforce["freelancers"] = [
                {"id": "worker-z", "name": "Zoe Crew", "company": "Zed Co"},
                {"id": "worker-a", "name": "Amy Crew", "company": "Alpha Co", "phone": "+65 9123 4567"},
                {"id": "worker-b", "name": "Ben Crew", "company": "Beta Co"},
            ]
            workforce["assignments"] = {
                "143": [{
                    "id": "assignment-b",
                    "freelancerId": "worker-b",
                    "department": "AU",
                    "roleName": "Audio Assistant",
                    "dailyRate": 180,
                    "days": 1,
                }],
                "144": [{
                    "id": "assignment-a",
                    "freelancerId": "worker-a",
                    "department": "AU",
                    "roleName": "Audio Technician",
                }],
            }
            workforce["submissions"] = {
                "143": {
                    "worker-z": {
                        "invoices": [{
                            "id": "invoice-z",
                            "originalName": "zoe-invoice.pdf",
                            "submittedAt": "2026-07-10T10:00:00+08:00",
                            "status": "Pending Review",
                            "amount": 120,
                        }],
                        "claims": [{
                            "id": "claim-paid",
                            "originalName": "paid-claim.pdf",
                            "submittedAt": "2026-07-10T11:00:00+08:00",
                            "status": "Paid",
                            "amount": 20,
                        }],
                    },
                    "worker-a": {
                        "invoices": [],
                        "claims": [{
                            "id": "claim-a",
                            "originalName": "amy-claim.pdf",
                            "submittedAt": "2026-07-10T09:00:00+08:00",
                            "status": "Approved",
                            "amount": 30,
                        }],
                    },
                },
                "144": {
                    "worker-a": {
                        "invoices": [{
                            "id": "invoice-later",
                            "originalName": "later-invoice.pdf",
                            "submittedAt": "2026-07-20T09:00:00+08:00",
                            "status": "Pending Review",
                            "amount": 200,
                        }],
                        "claims": [],
                    },
                },
            }

        self.login("admin", True)
        response = self.client.get("/api/workforce/submissions")

        self.assertEqual(response.status_code, 200)
        data = response.get_json()["data"]
        self.assertEqual(
            [row["id"] for row in data["rows"]],
            ["invoice-later", "claim-a", "invoice-z"],
        )
        self.assertEqual(
            [row["statusKey"] for row in data["rows"]],
            ["to-review", "to-pay", "to-review"],
        )
        self.assertEqual(
            [row["statusLabel"] for row in data["rows"]],
            ["Pending Review", "Approved", "Pending Review"],
        )
        self.assertEqual(data["totalUploads"], 4)
        self.assertEqual(data["totalItems"], 5)
        self.assertEqual(data["attentionTotal"], 3)
        self.assertEqual(data["statusCounts"]["awaiting-upload"], 1)
        self.assertEqual(data["statusCounts"]["awaiting-confirmation"], 1)
        self.assertEqual(data["statusCounts"]["paid"], 1)
        self.assertEqual(data["rows"][0]["event"]["startDateValue"], "2026-07-20")
        self.assertEqual(data["rows"][0]["event"]["state"], "New")
        self.assertEqual(data["rows"][0]["departmentDetails"][0]["code"], "AU")
        self.assertEqual(data["rows"][0]["departmentDetails"][0]["color"], "#CDEBFF")
        self.assertEqual(data["rows"][0]["departmentDetails"][0]["roles"], ["Audio Technician"])
        self.assertEqual(data["rows"][0]["subject"]["phone"], "+6591234567")
        self.assertTrue(data["rows"][0]["downloadUrl"].endswith("?download=1"))

        claims = self.client.get(
            "/api/workforce/submissions?status=all&kind=claim"
        ).get_json()["data"]
        self.assertEqual(
            [row["id"] for row in claims["rows"]],
            ["claim-a", "claim-paid"],
        )

        awaiting = self.client.get(
            "/api/workforce/submissions?status=awaiting-upload"
        ).get_json()["data"]
        self.assertEqual(len(awaiting["rows"]), 1)
        self.assertEqual(awaiting["rows"][0]["eventId"], 143)
        self.assertEqual(awaiting["rows"][0]["freelancerId"], "worker-b")
        self.assertEqual(awaiting["rows"][0]["statusKey"], "awaiting-upload")
        self.assertTrue(awaiting["rows"][0]["isAwaitingUpload"])
        self.assertNotIn("downloadUrl", awaiting["rows"][0])

        paid = self.client.get(
            "/api/workforce/submissions?status=paid"
        ).get_json()["data"]
        self.assertEqual(
            [row["id"] for row in paid["rows"]],
            ["claim-paid"],
        )

        self.login("normal", False)
        self.assertEqual(
            self.client.get("/api/workforce/submissions").status_code,
            403,
        )

    def test_submission_queue_uses_status_filters_and_delete_confirmation(self):
        source_path = os.path.join(
            os.path.dirname(app_module.__file__),
            "static",
            "js",
            "workforce-admin.js",
        )
        with open(source_path, encoding="utf-8") as source_file:
            source = source_file.read()

        filter_source = source.split(
            "const WF_DOCUMENT_STATUS_FILTERS", 1
        )[1].split("function wfDocumentStatusClass", 1)[0]
        for label in (
            "Pending Review",
            "Awaiting upload",
            "Approved / To pay",
            "Paid",
            "Awaiting confirmation",
            "Confirmed",
            "Denied",
        ):
            self.assertIn(label, filter_source)
        self.assertIn(
            "statuses: new Set(['to-review', 'to-pay'])",
            source,
        )
        self.assertIn(
            "active ? `${wfDocumentStatusClass(key)} active` : ''",
            source,
        )
        self.assertLess(
            filter_source.index("Awaiting upload"),
            filter_source.index("Pending Review"),
        )
        self.assertIn(
            "'to-review': 'status-pending-review'",
            source,
        )
        self.assertIn(
            "confirmWorkforceSubmissionDeletion(submissionId)",
            source,
        )
        self.assertIn(
            "confirmWorkforceSubmissionDeletion(id)",
            source,
        )
        self.assertIn("This action cannot be undone.", source)
        self.assertIn('wfDocumentClaimGroup', source)
        self.assertIn('wfClaimGroupStatusControl', source)
        self.assertIn('wfClaimTotalMarkup', source)
        self.assertIn('toggleWorkforceDocumentClaimGroup', source)
        self.assertIn('wfDocumentDepartmentRoles', source)
        self.assertIn('const subjectPhone = wfFormatPhone(subject.phone);', source)
        self.assertNotIn("subject.company || 'Worker'", source)
        self.assertIn('wfReviewClaimDateCheckHtml', source)
        self.assertIn('wfReviewDateRangesLabel', source)
        self.assertIn('wfReviewHiredDateCheck', source)
        self.assertIn('wfReviewEventDateCheck', source)
        self.assertIn('wfSetClaimDateCheckState', source)
        self.assertIn(
            "kind === 'invoice' ? wfReviewExpectedAmountHtml(record)",
            source,
        )
        self.assertIn('/api/workforce/submissions/bulk-status', source)

    def test_same_event_claims_are_grouped_and_bulk_status_requires_review(self):
        with mutate_workforce(self.manager.data_folder) as workforce:
            workforce['freelancers'] = [{
                'id': 'worker-grouped',
                'name': 'Grouped Worker',
                'company': 'Crew Company',
            }]
            workforce['assignments'] = {'143': [{
                'id': 'assignment-grouped',
                'freelancerId': 'worker-grouped',
                'department': 'AU',
                'roleName': 'Crew',
                'days': 2,
                'workDates': ['2026-07-10', '2026-07-11'],
            }]}
            workforce['submissions'] = {
                '143': {
                    'worker-grouped': {
                        'invoices': [],
                        'claims': [
                            {
                                'id': 'claim-group-a',
                                'originalName': 'meal.pdf',
                                'submittedAt': '2026-07-10T09:00:00+08:00',
                                'status': 'Approved',
                                'amount': 25,
                                'claimDate': '2026-07-10',
                                'category': 'Meal',
                                'verifiedAt': '2026-07-10T10:00:00+08:00',
                            },
                            {
                                'id': 'claim-group-b',
                                'originalName': 'transport.pdf',
                                'submittedAt': '2026-07-10T09:05:00+08:00',
                                'status': 'Paid',
                                'amount': 35,
                                'claimDate': '2026-07-10',
                                'category': 'Transport',
                            },
                        ],
                    },
                },
            }

        self.login('admin', True)
        grouped = self.client.get(
            '/api/workforce/submissions?status=all&kind=claim'
        ).get_json()['data']
        self.assertEqual(grouped['total'], 1)
        self.assertEqual(len(grouped['rows']), 1)
        claim_group = grouped['rows'][0]
        self.assertTrue(claim_group['isClaimGroup'])
        self.assertEqual(claim_group['claimCount'], 2)
        self.assertEqual(claim_group['claimTotal'], 60)
        self.assertTrue(claim_group['claimAmountsComplete'])
        self.assertFalse(claim_group['allClaimsReviewed'])
        self.assertEqual(
            claim_group['assignmentWorkDates'],
            ['2026-07-10', '2026-07-11'],
        )
        self.assertEqual(
            {row['id'] for row in claim_group['claims']},
            {'claim-group-a', 'claim-group-b'},
        )

        approved_filter = self.client.get(
            '/api/workforce/submissions?status=to-pay&kind=claim'
        ).get_json()['data']
        self.assertEqual(len(approved_filter['rows'][0]['claims']), 2)

        blocked = self.client.put(
            '/api/workforce/submissions/bulk-status',
            json={
                'submissionIds': ['claim-group-a', 'claim-group-b'],
                'status': 'Paid',
            },
        )
        self.assertEqual(blocked.status_code, 409)
        self.assertIn('Review every claim individually', blocked.get_json()['error'])

        with mutate_workforce(self.manager.data_folder) as workforce:
            workforce['submissions']['143']['worker-grouped']['claims'][1][
                'verifiedAt'
            ] = '2026-07-10T10:05:00+08:00'

        updated = self.client.put(
            '/api/workforce/submissions/bulk-status',
            json={
                'submissionIds': ['claim-group-a', 'claim-group-b'],
                'status': 'Payment Confirmed',
            },
        )
        self.assertEqual(updated.status_code, 200, updated.get_data(as_text=True))
        self.assertEqual(updated.get_json()['updatedCount'], 2)
        claims = updated.get_json()['data']['submissions']['worker-grouped']['claims']
        self.assertTrue(all(row['status'] == 'Paid' for row in claims))
        self.assertTrue(all(row.get('paymentConfirmedAt') for row in claims))
        self.assertTrue(all(row['reviewHistory'][-1]['groupUpdate'] for row in claims))

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

        self.assertEqual(response.status_code, 200)
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
        assignment = portal["companies"][0]["events"][0]["assignments"][0]
        self.assertEqual(assignment["departmentColor"], "#CDEBFF")
        self.assertEqual(assignment["departmentTextColor"], "#174A67")
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

    def test_manpower_only_event_closes_when_every_invoice_is_paid(self):
        freelancer_id = self.create_worker_assignment()
        event = self.manager.events[143]
        event.prepared_items = []
        event.actually_prepared = []
        event.returned_items = []
        event.extra_assets = []
        event.start_date = "20260701"
        event.end_date = "20260702"

        app_module.update_event_state(event)
        self.assertEqual(event.state, "Pending Closure")

        with mutate_workforce(self.manager.data_folder) as workforce:
            workforce.setdefault("submissions", {}).setdefault(
                "143", {}
            )[freelancer_id] = {
                "invoices": [{
                    "id": "invoice-paid",
                    "status": "Paid",
                }],
                "claims": [],
            }

        app_module.update_event_state(event)
        self.assertEqual(event.state, "Closed")

    def test_worker_assignment_allows_role_and_rate_to_be_added_later(self):
        self.login("admin", True)
        worker_response = self.client.post(
            "/api/workforce/freelancers",
            json={"name": "Unrated Worker", "phone": "9333 2211"},
        )
        self.assertEqual(worker_response.status_code, 200)
        freelancer_id = worker_response.get_json()["data"]["id"]

        response = self.client.post(
            "/api/events/143/workforce/assignments",
            json={
                "freelancerId": freelancer_id,
                "department": "AU",
                "days": 1,
            },
        )
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        assignment = response.get_json()["data"]["assignments"][0]
        self.assertEqual(assignment["roleName"], "")
        self.assertIsNone(assignment["dailyRate"])

        expectation = app_module._workforce_submission_expectation(
            load_workforce(self.manager.data_folder),
            143,
            freelancer_id,
        )
        self.assertIsNone(expectation["expectedAmount"])
        self.assertEqual(
            expectation["expectedAmountBreakdown"][0]["calculation"],
            "Rate not set",
        )

        response = self.client.put(
            f"/api/events/143/workforce/assignments/{assignment['id']}",
            json={
                "department": "AU",
                "days": 1,
                "customRole": "",
                "dailyRate": "",
            },
        )
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))

    def test_undefined_role_dates_merge_into_one_assignment(self):
        self.login("admin", True)
        worker = self.client.post(
            "/api/workforce/freelancers",
            json={"name": "Flexible Crew", "phone": "9333 1188"},
        ).get_json()["data"]

        for work_date in ("2026-07-10", "2026-07-12"):
            response = self.client.post(
                "/api/events/143/workforce/assignments",
                json={
                    "freelancerId": worker["id"],
                    "department": "AU",
                    "customRole": "",
                    "workDates": [work_date],
                    "dailyRate": 250,
                },
            )
            self.assertEqual(response.status_code, 200, response.get_data(as_text=True))

        assignments = [
            row for row in response.get_json()["data"]["assignments"]
            if row.get("freelancerId") == worker["id"]
        ]
        self.assertEqual(len(assignments), 1)
        self.assertEqual(
            assignments[0]["workDates"],
            ["2026-07-10", "2026-07-12"],
        )
        self.assertEqual(assignments[0]["roleName"], "")

    def test_workforce_event_picker_refreshes_options_when_opened(self):
        static_root = os.path.join(
            os.path.dirname(os.path.dirname(__file__)), "static"
        )
        with open(
            os.path.join(static_root, "js", "workforce-admin.js"),
            encoding="utf-8",
        ) as source_file:
            source = source_file.read()

        chooser_start = source.index("function openWorkforceEventChooser()")
        chooser_end = source.index("function wfDirectorySummaryBadges")
        chooser = source[chooser_start:chooser_end]
        self.assertIn("planOpenEventChooser('workforce')", chooser)
        self.assertIn("refreshWorkforceEventChooserOptions()", chooser)
        self.assertIn("startProgressiveEventOptions(", chooser)

    def test_event_departments_come_from_assets_and_allow_manual_additions(self):
        self.login("admin", True)
        self.manager.departments.update({
            "LOAN": {"name": "Loan"},
            "MISC": {"name": "Misc"},
            "UN": {"name": "Unknown"},
        })
        event = self.manager.events[143]
        event.prepared_items.extend([
            "[MODEL]LOAN|Support|Loan|1|Support only",
            "[MODEL]MISC|Support|Misc|1|Support only",
            "[MODEL]UN|Support|Unknown|1|Support only",
        ])
        self.manager.save_event(event)
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
        self.assertEqual(payload["departments"][0]["color"], "#CDEBFF")
        self.assertEqual(payload["departments"][0]["textColor"], "#174A67")
        self.assertTrue({"LOAN", "MISC", "UN"}.isdisjoint(
            row["code"] for row in payload["allDepartments"]
        ))

        for reserved_code in ("LOAN", "MISC", "UN"):
            blocked = self.client.post(
                "/api/events/143/workforce/departments",
                json={"code": reserved_code},
            )
            self.assertEqual(blocked.status_code, 400)

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
        self.assertEqual(lighting["color"], "#DDF5DF")

        source = (
            Path(__file__).resolve().parents[1]
            / "static" / "js" / "workforce-admin.js"
        ).read_text(encoding="utf-8")
        self.assertIn('.filter(isSelectableCompanyDepartment).map(row => {', source)
        self.assertIn(
            '(workforcePageState.data.allDepartments || []).filter(isSelectableCompanyDepartment)',
            source,
        )

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

    def test_admin_and_worker_invoice_uploads_accept_excel_files(self):
        freelancer_id = self.create_worker_assignment()
        token = self.worker_token()

        response = self.client.post(
            "/api/worker/submissions",
            data={
                "token": token,
                "eventId": "143",
                "kind": "invoice",
                "warningAcknowledged": "true",
                "file": (io.BytesIO(b"not a workbook"), "disguised.xlsx"),
            },
            content_type="multipart/form-data",
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("contents do not match", response.get_json()["error"])

        response = self.client.post(
            "/api/worker/submissions",
            data={
                "token": token,
                "eventId": "143",
                "kind": "invoice",
                "warningAcknowledged": "true",
                "file": (io.BytesIO(XLSX_BYTES), "worker-invoice.xlsx"),
            },
            content_type="multipart/form-data",
        )
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        worker_invoice = response.get_json()["data"]["events"][0]["submissions"][
            "invoices"
        ][0]
        self.assertEqual(worker_invoice["originalName"], "worker-invoice.xlsx")
        self.assertEqual(worker_invoice["processingState"], "Complete")

        self.login("admin", True)
        response = self.client.delete(
            f"/api/workforce/submissions/{worker_invoice['id']}"
        )
        self.assertEqual(response.status_code, 200)
        response = self.client.post(
            f"/api/events/143/workforce/submissions/{freelancer_id}",
            data={
                "kind": "invoice",
                "file": (io.BytesIO(XLSX_BYTES), "admin-invoice.xlsx"),
            },
            content_type="multipart/form-data",
        )
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        invoice = response.get_json()["data"]["submissions"][freelancer_id][
            "invoices"
        ][0]
        self.assertEqual(invoice["originalName"], "admin-invoice.xlsx")
        self.assertEqual(
            invoice["contentType"],
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        )
        self.assertEqual(invoice["processingState"], "Complete")

        response = self.client.post(
            f"/api/events/143/workforce/allowances/{freelancer_id}",
            json={"kind": "invoice", "delta": 1},
        )
        self.assertEqual(response.status_code, 200)
        response = self.client.post(
            f"/api/events/143/workforce/submissions/{freelancer_id}",
            data={
                "kind": "invoice",
                "file": (io.BytesIO(XLS_BYTES), "legacy-invoice.xls"),
            },
            content_type="multipart/form-data",
        )
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        invoices = response.get_json()["data"]["submissions"][freelancer_id][
            "invoices"
        ]
        self.assertEqual(invoices[-1]["contentType"], "application/vnd.ms-excel")

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
        saved_profile = next(
            row for row in payload["transportVendors"]
            if row["id"] == profile_id
        )
        self.assertEqual(saved_profile["lastCost"], 450)
        self.assertEqual(
            {row["name"] for row in payload["transportLocations"]},
            {"Main Warehouse", "Test Venue"},
        )

    def test_fleet_vehicles_support_timeline_bookings_and_event_trips(self):
        self.login("admin", True)
        vehicle_response = self.client.post(
            "/api/vehicles",
            json={
                "registrationNumber": "GBD 7788K",
                "vehicleType": "14ft Lorry",
                "name": "Lorry 1",
            },
        )
        self.assertEqual(vehicle_response.status_code, 201)
        vehicle = vehicle_response.get_json()["data"]
        vehicle_id = vehicle["id"]
        self.assertNotIn("capacity", vehicle)

        standalone = self.client.post(
            "/api/vehicles/bookings",
            json={
                "vehicleId": vehicle_id,
                "purpose": "Warehouse collection",
                "date": "2026-07-10",
                "startTime": "09:00",
                "endDate": "2026-07-10",
                "endTime": "11:00",
            },
        )
        self.assertEqual(standalone.status_code, 201)

        availability = self.client.get(
            "/api/vehicles/availability",
            query_string={
                "date": "2026-07-10",
                "startTime": "10:00",
                "endDate": "2026-07-10",
                "endTime": "12:00",
            },
        )
        self.assertEqual(availability.status_code, 200)
        availability_row = availability.get_json()["data"]["vehicles"][0]
        self.assertFalse(availability_row["available"])
        self.assertIn("Warehouse collection", availability_row["conflict"])

        conflict = self.client.post(
            "/api/events/143/workforce/transport",
            json={
                "sourceType": "fleet",
                "tripType": "depart",
                "vehicleId": vehicle_id,
                "driver": "Alicia",
                "driverContact": "+65 9123 4567",
                "locationFrom": "Warehouse",
                "locationTo": "Test Venue",
                "departDate": "2026-07-10",
                "departTime": "10:00",
                "useEndDate": "2026-07-10",
                "useEndTime": "12:00",
            },
        )
        self.assertEqual(conflict.status_code, 409)
        self.assertIn("already booked", conflict.get_json()["error"])

        depart = self.client.post(
            "/api/events/143/workforce/transport",
            json={
                "sourceType": "fleet",
                "tripType": "depart",
                "vehicleId": vehicle_id,
                "driver": "Alicia",
                "driverContact": "+65 9123 4567",
                "locationFrom": "Warehouse",
                "locationTo": "Test Venue",
                "departDate": "2026-07-10",
                "departTime": "12:00",
                "useEndDate": "2026-07-10",
                "useEndTime": "14:00",
            },
        )
        self.assertEqual(depart.status_code, 200)
        trip = depart.get_json()["data"]["transportBookings"][0]
        self.assertEqual(trip["sourceType"], "fleet")
        self.assertEqual(trip["tripType"], "depart")
        self.assertEqual(trip["driver"], "Alicia")
        self.assertEqual(trip["vehicleNumber"], "GBD 7788K")

        returned = self.client.post(
            "/api/events/143/workforce/transport",
            json={
                "sourceType": "fleet",
                "tripType": "return",
                "vehicleId": vehicle_id,
                "driver": "Bryan",
                "locationFrom": "Test Venue",
                "locationTo": "Warehouse",
                "departDate": "2026-07-10",
                "departTime": "14:00",
                "useEndDate": "2026-07-10",
                "useEndTime": "16:00",
            },
        )
        self.assertEqual(returned.status_code, 200)
        trips = returned.get_json()["data"]["transportBookings"]
        self.assertEqual([row["driver"] for row in trips], ["Alicia", "Bryan"])

        timeline = self.client.get("/api/vehicles?date=2026-07-10")
        self.assertEqual(timeline.status_code, 200)
        timeline_data = timeline.get_json()["data"]
        self.assertEqual(len(timeline_data["vehicles"]), 1)
        self.assertEqual(len(timeline_data["bookings"]), 3)
        self.assertEqual(
            {row["kind"] for row in timeline_data["bookings"]},
            {"standalone", "event"},
        )
        event_rows = [
            row for row in timeline_data["bookings"]
            if row["kind"] == "event"
        ]
        self.assertTrue(event_rows)
        self.assertEqual(
            {row["eventState"] for row in event_rows},
            {self.manager.events[143].state},
        )

    def test_vehicle_booking_ui_is_details_first_and_status_coloured(self):
        root = os.path.dirname(os.path.dirname(__file__))
        with open(
            os.path.join(root, "static", "js", "vehicles.js"),
            encoding="utf-8",
        ) as script_file:
            script = script_file.read()
        with open(
            os.path.join(root, "static", "css", "vehicles.css"),
            encoding="utf-8",
        ) as css_file:
            stylesheet = css_file.read()

        self.assertLess(
            script.index('id="vehicleBookingPurpose"'),
            script.index('id="vehicleBookingChoices"'),
        )
        self.assertIn("/api/vehicles/availability?${params}", script)
        self.assertIn("renderVehicleBookingChoices(vehicles, true", script)
        self.assertIn("event-status-${vehicleEventStateSlug(booking.eventState)}", script)
        self.assertIn('aria-label="Previous day"', script)
        self.assertIn('aria-label="Next day"', script)
        self.assertIn("function shiftVehicleTimelineDate(days)", script)
        self.assertIn('onclick="showVehicleTimelineToday()"', script)
        self.assertIn("function showVehicleTimelineToday()", script)
        self.assertIn(
            "viewEvent(Number(booking.eventId), { updateHistory: false })",
            script,
        )
        self.assertIn(".vehicle-modal {", stylesheet)
        self.assertIn(".vehicle-date-step", stylesheet)
        self.assertIn(".vehicle-date-today", stylesheet)
        self.assertIn(".vehicle-booking.event-status-planning", stylesheet)
        self.assertIn(".vehicle-booking.event-status-preparing", stylesheet)
        self.assertIn(".vehicle-booking.event-status-ready", stylesheet)
        self.assertIn(".vehicle-booking.event-status-ongoing", stylesheet)
        self.assertIn(".vehicle-booking.event-status-returning", stylesheet)
        self.assertIn(".vehicle-booking.event-status-pending-closure", stylesheet)
        self.assertIn(".vehicle-booking.event-status-overdue", stylesheet)
        self.assertIn(".vehicle-booking.event-status-closed", stylesheet)

    def test_successful_mutation_without_endpoint_log_gets_a_system_audit_entry(self):
        self.login("admin", True)

        response = self.client.post(
            "/api/workforce/roles",
            json={"name": "RF Technician", "department": "AX"},
        )

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertEqual(
            self.manager.logs[-1].action,
            "Created a workforce role",
        )

    def test_external_trip_does_not_require_a_vehicle_return_time(self):
        self.login("admin", True)
        profile = self.client.post(
            "/api/workforce/transport-profiles",
            json={
                "vehicleType": "10ft Lorry",
                "company": "External Logistics",
                "vehicleNumber": "GBB 1234X",
            },
        ).get_json()["data"]
        response = self.client.post(
            "/api/events/143/workforce/transport",
            json={
                "sourceType": "external",
                "tripType": "return",
                "vendorId": profile["id"],
                "driver": "Different Driver",
                "locationFrom": "Test Venue",
                "locationTo": "Warehouse",
                "departDate": "2026-07-12",
                "departTime": "22:00",
            },
        )
        self.assertEqual(response.status_code, 200)
        booking = response.get_json()["data"]["transportBookings"][0]
        self.assertEqual(booking["driver"], "Different Driver")
        self.assertEqual(booking["tripType"], "return")
        self.assertFalse(booking["useEndTime"])

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

    def test_admin_can_complete_and_review_claim_details_for_worker(self):
        freelancer_id = self.create_worker_assignment()
        with mutate_workforce(self.tempdir.name) as workforce:
            workforce["submissions"] = {
                "143": {
                    freelancer_id: {
                        "invoices": [],
                        "claims": [{
                            "id": "claim-details-required",
                            "originalName": "taxi-receipt.png",
                            "storedPath": "placeholder/taxi-receipt.png",
                            "contentType": "image/png",
                            "submittedAt": now_iso(),
                            "status": "Pending Review",
                            "amount": 18.75,
                            "claimDate": "",
                            "category": "",
                            "description": "",
                            "notes": "",
                            "department": "AU",
                            "detailsComplete": False,
                            "submissionStage": "Details Required",
                            "processingState": "Complete",
                            "reviewHistory": [],
                        }],
                    }
                }
            }

        self.login("admin", True)
        incomplete = self.client.put(
            "/api/workforce/submissions/claim-details-required",
            json={
                "amount": "18.75",
                "status": "Pending Review",
                "claimDate": "2026-07-10",
                "category": "",
                "confirmReview": True,
            },
        )
        self.assertEqual(incomplete.status_code, 400)
        self.assertIn("date and category", incomplete.get_json()["error"])

        completed = self.client.put(
            "/api/workforce/submissions/claim-details-required",
            json={
                "amount": "18.75",
                "status": "Pending Review",
                "claimDate": "2026-07-10",
                "category": "Transport",
                "notes": "Taxi to the event venue",
                "confirmReview": True,
            },
        )
        self.assertEqual(
            completed.status_code, 200, completed.get_data(as_text=True)
        )
        payload = completed.get_json()["data"]
        claim = payload["submissions"][freelancer_id]["claims"][0]
        self.assertTrue(claim["detailsComplete"])
        self.assertEqual(claim["submissionStage"], "Submitted")
        self.assertEqual(claim["claimDate"], "2026-07-10")
        self.assertEqual(claim["category"], "Transport")
        self.assertEqual(claim["notes"], "Taxi to the event venue")
        self.assertEqual(claim["detailsCompletedByAdmin"], "admin")
        self.assertEqual(payload["totals"]["claims"], 18.75)

    def test_admin_review_ui_opens_details_required_claims(self):
        source_path = os.path.join(
            os.path.dirname(app_module.__file__),
            "static",
            "js",
            "workforce-admin.js",
        )
        with open(source_path, encoding="utf-8") as source_file:
            source = source_file.read()
        css_path = os.path.join(
            os.path.dirname(app_module.__file__),
            "static",
            "css",
            "workforce-admin.css",
        )
        with open(css_path, encoding="utf-8") as css_file:
            css = css_file.read()

        review_source = source.split(
            "async function openWorkforceReview", 1
        )[1].split("function updateAllocationProgress", 1)[0]
        document_source = source.split(
            "async function openWorkforceDocumentSubmission", 1
        )[1].split("function toggleWorkforceDocumentStatusMenu", 1)[0]
        self.assertNotIn("worker still needs to complete", review_source)
        self.assertIn("Claim details required", review_source)
        self.assertIn('id="wfReviewClaimNotes"', review_source)
        self.assertIn('id="wfReviewOtherCategoryField"', source)
        self.assertIn('<option value="Purchase"', source)
        self.assertIn('.wf-review-form .wf-field[hidden]', css)
        self.assertIn('function openEventWorkforceReview(eventId, submissionId)', source)
        self.assertIn("workforcePageState.focusTarget.startsWith('review-claim:')", source)
        self.assertIn('openWorkforceReview(submissionId)', source)
        self.assertNotIn(
            "'details-required'].includes(statusKey)", document_source
        )

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

    def test_reviewed_submission_can_be_corrected_during_later_review(self):
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

        response = self.client.put(
            f"/api/workforce/submissions/{claim['id']}",
            json={
                "amount": 99,
                "status": "Pending Review",
                "department": "LI",
                "claimDate": "2026-07-12",
                "category": "Meal",
                "confirmReview": True,
            },
        )
        corrected = response.get_json()["data"]["submissions"][freelancer_id][
            "claims"
        ][0]
        self.assertEqual(corrected["amount"], 99)
        self.assertEqual(corrected["department"], "LI")
        self.assertEqual(corrected["claimDate"], "2026-07-12")
        self.assertEqual(corrected["category"], "Meal")
        self.assertEqual(corrected["expectedAmount"], 560)
        self.assertEqual(
            corrected["expectedAmountBreakdown"][0]["calculation"],
            "2 day(s) x $280.00",
        )

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
        self.assertEqual(invoice["expectedAmount"], 560)
        self.assertEqual(invoice["expectedAmountBreakdown"][0]["role"], "Audio Engineer")

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

    def test_return_transport_defaults_reverse_departure_and_use_event_end_date(self):
        static_root = os.path.join(os.path.dirname(app_module.__file__), "static")
        with open(
            os.path.join(static_root, "js", "workforce-admin.js"),
            encoding="utf-8",
        ) as source_file:
            source = source_file.read()
        with open(
            os.path.join(static_root, "css", "workforce-admin.css"),
            encoding="utf-8",
        ) as source_file:
            styles = source_file.read()

        self.assertIn("function applyTransportReturnDefaults()", source)
        self.assertIn("tripDate.value = eventEndDate", source)
        self.assertIn("departure.locationTo", source)
        self.assertIn("departure.locationFrom", source)
        self.assertIn("setTransportTripType(tripType, false)", source)
        self.assertIn('class="wf-route-arrow"', source)
        self.assertIn(".wf-location-direction", styles)
        self.assertIn(".wf-route-arrow", styles)
        self.assertIn(".wf-transport-meta > div > span", styles)
        self.assertIn("function wfSelectedTransportVehicles()", source)
        self.assertIn("Choose one or more vehicles", source)
        self.assertIn("for (const selection of selections)", source)
        self.assertIn("Assign a driver to every selected vehicle", source)
        self.assertNotIn("duplicate driver", source.lower())
        self.assertIn(".wf-booking-driver-row", styles)

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
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        updated = response.get_json()["data"]["assignments"][0]
        self.assertEqual(updated["workDates"], ["2026-07-13"])

    def test_schedule_can_remove_one_assignment_date_and_reports_conflicts(self):
        self.login("admin", True)
        worker = self.client.post(
            "/api/workforce/freelancers",
            json={"name": "Clashing Crew", "phone": "9555 1122"},
        ).get_json()["data"]
        response = self.client.post(
            "/api/events/143/workforce/assignments",
            json={
                "freelancerId": worker["id"],
                "department": "AU",
                "customRole": "Audio Engineer",
                "workDates": ["2026-07-10", "2026-07-11"],
                "dailyRate": 280,
            },
        )
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        assignment = response.get_json()["data"]["assignments"][0]

        other_event = Event(
            144,
            "Clashing Production",
            "20260711",
            "20260711",
            [],
            prepared_items=[
                "[MODEL]AU|Test Brand|Test Console|1|Audio requirement"
            ],
            location="Other Venue",
        )
        self.manager.events[other_event.event_id] = other_event
        self.manager.save_event(other_event)
        response = self.client.post(
            "/api/events/144/workforce/assignments",
            json={
                "freelancerId": worker["id"],
                "department": "AU",
                "customRole": "Audio Engineer",
                "workDates": ["2026-07-11"],
                "dailyRate": 280,
            },
        )
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))

        payload = self.client.get("/api/events/143/workforce").get_json()["data"]
        current = next(row for row in payload["assignments"] if row["id"] == assignment["id"])
        self.assertEqual(current["dateConflicts"][0]["eventId"], 144)
        self.assertEqual(current["dateConflicts"][0]["date"], "2026-07-11")

        response = self.client.delete(
            f"/api/events/143/workforce/assignments/{assignment['id']}"
            "?date=2026-07-10"
        )
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        current = next(
            row for row in response.get_json()["data"]["assignments"]
            if row["id"] == assignment["id"]
        )
        self.assertEqual(current["workDates"], ["2026-07-11"])
        self.assertEqual(current["days"], 1)

    def test_schedule_can_change_department_and_role_for_one_day(self):
        freelancer_id = self.create_worker_assignment()
        response = self.client.post(
            "/api/events/143/workforce/departments",
            json={"code": "LI", "name": "Lighting"},
        )
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        assignment = next(
            row for row in response.get_json()["data"]["assignments"]
            if row["freelancerId"] == freelancer_id
        )

        response = self.client.patch(
            "/api/events/143/workforce/schedule/call-times",
            json={"updates": [{
                "assignmentId": assignment["id"],
                "date": "2026-07-11",
                "callTime": "09:15",
            }]},
        )
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))

        response = self.client.patch(
            f"/api/events/143/workforce/assignments/{assignment['id']}/schedule-day",
            json={
                "date": "2026-07-11",
                "department": "LI",
                "roleName": "Lighting Operator",
            },
        )
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        update = response.get_json()["data"]
        self.assertTrue(update["structureChanged"])
        self.assertEqual(update["dateDepartments"], {})
        self.assertEqual(update["dateRoles"], {})
        split_assignments = [
            row for row in update["workforce"]["assignments"]
            if row["freelancerId"] == freelancer_id
        ]
        self.assertEqual(len(split_assignments), 2)
        audio_assignment = next(
            row for row in split_assignments
            if row["roleName"] == "Audio Engineer"
        )
        lighting_assignment = next(
            row for row in split_assignments
            if row["roleName"] == "Lighting Operator"
        )
        self.assertEqual(audio_assignment["department"], "AU")
        self.assertEqual(audio_assignment["workDates"], ["2026-07-10"])
        self.assertEqual(lighting_assignment["department"], "LI")
        self.assertEqual(lighting_assignment["workDates"], ["2026-07-11"])
        self.assertEqual(lighting_assignment["callTimes"], {"2026-07-11": "09:15"})
        lighting_role = next(
            row for row in update["workforce"]["roles"]
            if row["name"] == "Lighting Operator" and row["department"] == "LI"
        )
        self.assertEqual(lighting_role["type"], "worker")

        payload = self.client.get("/api/events/143/workforce").get_json()["data"]
        current_rows = [
            row for row in payload["assignments"]
            if row["freelancerId"] == freelancer_id
        ]
        self.assertEqual(
            {(row["department"], row["roleName"]) for row in current_rows},
            {("AU", "Audio Engineer"), ("LI", "Lighting Operator")},
        )

        pdf_response = self.client.get(
            "/api/events/143/workforce/schedule.pdf?scope=worker"
            f"&subjectId={freelancer_id}"
        )
        self.assertEqual(pdf_response.status_code, 200)
        pdf_text = "\n".join(
            page.extract_text() or ""
            for page in PdfReader(io.BytesIO(pdf_response.data)).pages
        )
        self.assertIn("Audio Engineer", pdf_text)
        self.assertIn("Lighting Operator", pdf_text)
        self.assertIn("Audio", pdf_text)
        self.assertIn("Lighting", pdf_text)

        response = self.client.patch(
            f"/api/events/143/workforce/assignments/{lighting_assignment['id']}/schedule-day",
            json={
                "date": "2026-07-11",
                "department": "AU",
                "roleName": "Audio Engineer",
            },
        )
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        update = response.get_json()["data"]
        self.assertTrue(update["structureChanged"])
        self.assertEqual(update["dateDepartments"], {})
        self.assertEqual(update["dateRoles"], {})
        merged_assignments = [
            row for row in update["workforce"]["assignments"]
            if row["freelancerId"] == freelancer_id
        ]
        self.assertEqual(len(merged_assignments), 1)
        self.assertEqual(merged_assignments[0]["department"], "AU")
        self.assertEqual(merged_assignments[0]["roleName"], "Audio Engineer")
        self.assertEqual(
            merged_assignments[0]["workDates"],
            ["2026-07-10", "2026-07-11"],
        )
        self.assertEqual(
            merged_assignments[0]["callTimes"],
            {"2026-07-11": "09:15"},
        )

    def test_worker_period_schedule_pdf_includes_all_events_rooms_and_optional_rates(self):
        self.login("admin", True)
        second_event = Event(
            144, "第二场活动", "20260715", "20260715", [],
            location="Room Venue",
            subprojects=[
                {"id": "room-a", "name": "Hall A", "items": []},
                {"id": "room-b", "name": "Hall B", "items": []},
            ],
        )
        self.manager.events[144] = second_event
        self.manager.save_event(second_event)
        with mutate_workforce(self.manager.data_folder) as workforce:
            workforce["freelancers"] = [{
                "id": "worker-period", "name": "陈伟 Chen Wei", "active": True,
            }]
            workforce["vendors"] = [{
                "id": "vendor-period", "name": "Northstar Productions",
                "memberIds": ["worker-period"], "active": True,
            }]
            workforce["assignments"] = {
                "143": [{
                    "id": "period-one", "freelancerId": "worker-period",
                    "department": "AU", "roleName": "Audio Engineer",
                    "dailyRate": 280, "workDates": ["2026-07-10"],
                    "callTimes": {"2026-07-10": "08:15"},
                }, {
                    "id": "period-vendor-service", "vendorId": "vendor-period",
                    "freelancerId": "vendor-period", "subjectType": "vendor",
                    "providerType": "service", "department": "AU",
                    "serviceName": "Backline support", "serviceCost": 1500,
                    "workDates": ["2026-07-12"],
                    "callTimes": {"2026-07-12": "10:00"},
                }],
                "144": [{
                    "id": "period-two", "freelancerId": "worker-period",
                    "department": "LI", "roleName": "Lighting Operator",
                    "dailyRate": 320, "workDates": ["2026-07-15"],
                    "callTimes": {"2026-07-15": "09:30"},
                    "subprojectId": "room-b",
                }, {
                    "id": "period-vendor-manpower", "vendorId": "vendor-period",
                    "freelancerId": "vendor-period", "subjectType": "vendor",
                    "providerType": "manpower", "department": "LI",
                    "pax": 3, "ratePerPax": 180, "roleName": "3 pax manpower",
                    "workDates": ["2026-07-16"],
                    "callTimes": {"2026-07-16": "07:30"},
                }],
            }

        response = self.client.get(
            "/api/workforce/subjects/worker-period/schedule.pdf"
            "?startDate=2026-07-01&endDate=2026-07-31&showRates=1&showVendor=1"
        )

        self.assertEqual(response.status_code, 200)
        text = "\n".join(
            page.extract_text() or ""
            for page in PdfReader(io.BytesIO(response.data)).pages
        )
        for expected in (
            "WORKER SCHEDULE", "陈伟 Chen Wei", "#143 - Test Production", "2026-07-10",
            "Test Venue", "#144 - 第二场活动", "Room Venue (Hall B)", "Audio Engineer",
            "Lighting Operator", "08:15", "09:30", "$280.00/day",
            "Vendor", "Northstar Productions", "Generated by", "admin",
            "2026-07-12", "Backline support", "Service", "$1,500.00/service",
            "2026-07-16", "3 pax manpower", "Manpower", "$180.00/pax/day",
        ):
            self.assertIn(expected, text)
        vendor_hidden = self.client.get(
            "/api/workforce/subjects/worker-period/schedule.pdf"
            "?startDate=2026-07-01&endDate=2026-07-31"
        )
        vendor_hidden_text = "\n".join(
            page.extract_text() or ""
            for page in PdfReader(io.BytesIO(vendor_hidden.data)).pages
        )
        self.assertNotIn("Northstar Productions", vendor_hidden_text)
        self.assertNotIn("Backline support", vendor_hidden_text)
        self.assertNotIn("3 pax manpower", vendor_hidden_text)
        excluded = self.client.get(
            "/api/workforce/subjects/worker-period/schedule.pdf"
            "?startDate=2026-07-11&endDate=2026-07-14"
        )
        excluded_text = "\n".join(
            page.extract_text() or ""
            for page in PdfReader(io.BytesIO(excluded.data)).pages
        )
        self.assertIn("No assignments fall within this date range", excluded_text)

    def test_event_report_pdf_contains_assets_manpower_vendor_services_and_transport(self):
        self.login("admin", True)
        event = self.manager.events[143]
        event.actually_prepared = ["AU#01"]
        event.notes = "客户要求安静进场"
        self.manager.inventory["AU#01"] = InventoryItem(
            asset_id="AU#01", brand="Test Brand", model_number="Test Console",
            serial_number="SN-AU-1", description="Audio requirement",
            is_missing=False, maintenance_logs=[], department_code="AU",
        )
        self.manager.save_inventory()
        self.manager.save_event(event)
        with mutate_workforce(self.manager.data_folder) as workforce:
            workforce["freelancers"] = [{"id": "crew-1", "name": "Jordan Crew"}]
            workforce["vendors"] = [{"id": "vendor-1", "name": "Sound Services"}]
            workforce["assignments"] = {"143": [
                {
                    "id": "crew-assignment", "freelancerId": "crew-1",
                    "department": "AU", "roleName": "A1",
                    "workDates": ["2026-07-10"],
                    "callTimes": {"2026-07-10": "07:00"},
                },
                {
                    "id": "service-assignment", "vendorId": "vendor-1",
                    "subjectType": "vendor", "providerType": "service",
                    "department": "AU", "serviceName": "Audio tuning",
                    "serviceCost": 500, "workDates": ["2026-07-10"],
                },
            ]}
            workforce["transportBookings"] = {"143": [{
                "id": "trip-report", "company": "Mover Pte Ltd",
                "driver": "Alex Driver", "driverContact": "91234567",
                "vehicleType": "24ft Truck", "vehicleNumber": "GBD1234A",
                "locationFrom": "Store", "locationTo": "Test Venue",
                "departDate": "2026-07-10", "departTime": "06:00",
            }]}

        response = self.client.get("/api/events/143/report.pdf")

        self.assertEqual(response.status_code, 200)
        text = "\n".join(
            page.extract_text() or ""
            for page in PdfReader(io.BytesIO(response.data)).pages
        )
        for expected in (
            "EVENT OPERATIONS REPORT", "Test Production", "#143", "Test Venue",
            "Test Brand Test Console Audio requirement", "AU#01",
            "Jordan Crew", "A1", "07:00", "VENDOR SERVICES",
            "Sound Services", "Audio tuning", "TRANSPORT", "Mover Pte Ltd",
            "24ft Truck", "GBD1234A", "Alex Driver", "+65 9123 4567",
            "客户要求安静进场",
        ):
            self.assertIn(expected, text)
        self.assertIn("Asset IDs:", text)
        self.assertNotIn("Asset IDs / status", text)

        event.assigned_users = ["normal"]
        self.manager.save_event(event)
        self.login("normal", False)
        self.assertEqual(self.client.get("/api/events/143/report.pdf").status_code, 200)

    def test_event_report_reconciles_bulk_preparation_with_model_requirement(self):
        event = self.manager.events[143]
        event.prepared_items = [
            "[MODEL]AU|DPA|4061|5|Lavalier microphone",
        ]
        event.actually_prepared = ["[BULK]AU-BULK|5"]
        self.manager.inventory["AU-BULK"] = InventoryItem(
            asset_id="AU-BULK", brand="DPA", model_number="4061",
            serial_number="", description="Lavalier microphone",
            is_missing=False, maintenance_logs=[], department_code="AU",
            is_bulk=True, quantity=20,
        )

        rows = app_module._event_report_assets(event, self.manager)

        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["required"], 5)
        self.assertEqual(rows[0]["prepared"], 5)
        self.assertEqual(rows[0]["returned"], 0)
        self.assertIn("AU-BULK × 5", rows[0]["assetIds"])
        self.assertNotIn("(prepared)", rows[0]["assetIds"])

    def test_schedule_shows_linked_quotation_date_labels(self):
        self.login("admin", True)
        with open(
            os.path.join(self.manager.data_folder, app_module.FINANCE_FILENAME),
            "w",
            encoding="utf-8",
        ) as finance_file:
            json.dump({
                "version": app_module.FINANCE_VERSION,
                "documents": [{
                    "id": "quote_schedule_labels",
                    "type": "quotation",
                    "number": "QT-2026-143-01",
                    "revision": 1,
                    "eventId": 143,
                    "scheduleMode": "event",
                    "setupDate": "2026-07-10",
                    "rehearsalDate": "2026-07-11",
                    "showDate": "2026-07-12",
                    "additionalShows": [{"date": "2026-07-11", "time": ""}],
                    "teardownDate": "2026-07-13",
                    "customScheduleGroups": [{
                        "id": "handover",
                        "label": "Client handover",
                        "dates": [{"date": "2026-07-11", "time": ""}],
                    }],
                    "scheduleOrder": [
                        "setup", "rehearsal", "custom:handover", "show",
                        "teardown",
                    ],
                    "lineItems": [],
                    "subprojects": [{"id": "main", "name": "Main Room"}],
                }],
            }, finance_file)

        response = self.client.get("/api/events/143/workforce")
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        labels = response.get_json()["data"]["event"]["quotationScheduleLabels"]
        self.assertEqual(labels["2026-07-10"], ["Setup"])
        self.assertEqual(
            labels["2026-07-11"],
            ["Rehearsal", "Client handover", "Show"],
        )
        self.assertEqual(labels["2026-07-12"], ["Show"])
        self.assertEqual(labels["2026-07-13"], ["Teardown"])
        self.assertNotIn("2026-07-14", labels)

    def test_workforce_assignments_support_the_same_person_in_multiple_rooms(self):
        event = self.manager.events[143]
        event.subprojects = [
            {"id": "room-main", "name": "Main Room", "items": []},
            {"id": "room-breakout", "name": "Breakout Room", "items": []},
        ]
        self.manager.save_event(event)
        self.login("admin", True)
        worker = self.client.post(
            "/api/workforce/freelancers",
            json={"name": "Alex Multiroom", "phone": "9888 1122"},
        ).get_json()["data"]

        for room_id, role in (
            ("room-main", "Audio Engineer"),
            ("room-breakout", "Breakout Technician"),
        ):
            work_dates = (
                ["2026-07-10", "2026-07-11"]
                if room_id == "room-main"
                else ["2026-07-10"]
            )
            response = self.client.post(
                "/api/events/143/workforce/assignments",
                json={
                    "freelancerId": worker["id"],
                    "subprojectId": room_id,
                    "department": "AU",
                    "customRole": role,
                    "workDates": work_dates,
                    "dailyRate": 280,
                },
            )
            self.assertEqual(
                response.status_code, 200, response.get_data(as_text=True)
            )

        payload = self.client.get(
            "/api/events/143/workforce"
        ).get_json()["data"]
        assignments = [
            row for row in payload["assignments"]
            if row["freelancerId"] == worker["id"]
        ]
        self.assertEqual(len(assignments), 2)
        self.assertEqual(
            {row["subprojectId"] for row in assignments},
            {"room-main", "room-breakout"},
        )
        self.assertEqual(
            {row["subprojectName"] for row in assignments},
            {"Main Room", "Breakout Room"},
        )
        self.assertEqual(
            [row["name"] for row in payload["subprojects"]],
            ["Main Room", "Breakout Room"],
        )

        main_assignment = next(
            row for row in assignments if row["subprojectId"] == "room-main"
        )
        response = self.client.patch(
            f"/api/events/143/workforce/assignments/{main_assignment['id']}/schedule-day",
            json={
                "date": "2026-07-11",
                "department": "AU",
                "roleName": "Audio Engineer",
                "subprojectId": "room-breakout",
            },
        )
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        updated_assignments = [
            row
            for row in response.get_json()["data"]["workforce"]["assignments"]
            if row["freelancerId"] == worker["id"]
        ]
        main_audio = next(
            row for row in updated_assignments
            if row["roleName"] == "Audio Engineer"
            and row["subprojectId"] == "room-main"
        )
        breakout_audio = next(
            row for row in updated_assignments
            if row["roleName"] == "Audio Engineer"
            and row["subprojectId"] == "room-breakout"
        )
        self.assertEqual(main_audio["workDates"], ["2026-07-10"])
        self.assertEqual(breakout_audio["workDates"], ["2026-07-11"])
        self.assertEqual(breakout_audio["subprojectName"], "Breakout Room")
        self.assertTrue(response.get_json()["data"]["structureChanged"])

        invalid_update = self.client.patch(
            f"/api/events/143/workforce/assignments/{main_audio['id']}/schedule-day",
            json={
                "date": "2026-07-10",
                "department": "AU",
                "roleName": "Audio Engineer",
                "subprojectId": "missing-room",
            },
        )
        self.assertEqual(invalid_update.status_code, 400)

        invalid = self.client.post(
            "/api/events/143/workforce/assignments",
            json={
                "freelancerId": worker["id"],
                "subprojectId": "missing-room",
                "department": "AU",
                "customRole": "Invalid",
                "workDates": ["2026-07-10"],
                "dailyRate": 100,
            },
        )
        self.assertEqual(invalid.status_code, 400)
        self.assertIn("valid event room", invalid.get_json()["error"])

    def test_fleet_vehicle_conflicts_remain_global_across_event_rooms(self):
        event = self.manager.events[143]
        event.subprojects = [
            {"id": "room-main", "name": "Main Room", "items": []},
            {"id": "room-breakout", "name": "Breakout Room", "items": []},
        ]
        self.manager.save_event(event)
        self.login("admin", True)

        vehicle_ids = []
        for registration in ("GBD 1001A", "GBD 1002B"):
            response = self.client.post(
                "/api/vehicles",
                json={
                    "registrationNumber": registration,
                    "vehicleType": "14ft Lorry",
                    "name": registration,
                },
            )
            self.assertEqual(response.status_code, 201)
            vehicle_ids.append(response.get_json()["data"]["id"])

        def book(vehicle_id, room_id, start_time, end_time):
            return self.client.post(
                "/api/events/143/workforce/transport",
                json={
                    "sourceType": "fleet",
                    "tripType": "depart",
                    "subprojectId": room_id,
                    "vehicleId": vehicle_id,
                    "driver": "Test Driver",
                    "locationFrom": "Warehouse",
                    "locationTo": "Test Venue",
                    "departDate": "2026-07-10",
                    "departTime": start_time,
                    "useEndDate": "2026-07-10",
                    "useEndTime": end_time,
                },
            )

        main_booking = book(
            vehicle_ids[0], "room-main", "09:00", "12:00"
        )
        self.assertEqual(main_booking.status_code, 200)
        self.assertEqual(
            main_booking.get_json()["data"]["transportBookings"][0][
                "subprojectName"
            ],
            "Main Room",
        )

        conflict = book(
            vehicle_ids[0], "room-breakout", "10:00", "11:00"
        )
        self.assertEqual(conflict.status_code, 409)
        self.assertIn("already booked", conflict.get_json()["error"])

        breakout_booking = book(
            vehicle_ids[1], "room-breakout", "10:00", "11:00"
        )
        self.assertEqual(breakout_booking.status_code, 200)
        bookings = breakout_booking.get_json()["data"]["transportBookings"]
        self.assertEqual(
            {row["subprojectId"] for row in bookings},
            {"room-main", "room-breakout"},
        )

    def test_workforce_page_exposes_room_tabs_and_room_selectors(self):
        source_path = os.path.join(
            os.path.dirname(app_module.__file__),
            "static",
            "js",
            "workforce-admin.js",
        )
        with open(source_path, encoding="utf-8") as source_file:
            source = source_file.read()

        self.assertIn("function wfSubprojectTabsHtml()", source)
        self.assertIn("All Rooms", source)
        self.assertIn('id="wfAssignmentSubproject"', source)
        self.assertIn('id="wfVendorAssignmentSubproject"', source)
        self.assertIn('id="wfTransportSubproject"', source)
        self.assertIn("subprojectId: document.getElementById", source)

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
        audio_department = next(
            row for row in history["departments"] if row["code"] == "AU"
        )
        self.assertEqual(audio_department["color"], "#CDEBFF")
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

        manpower_assignment = next(
            row for row in vendor_assignments
            if row["providerType"] == "manpower"
        )
        response = self.client.patch(
            f"/api/events/143/workforce/assignments/{manpower_assignment['id']}/schedule-day",
            json={
                "date": "2026-07-10",
                "department": "AU",
                "roleName": "Vendor Crew Lead",
            },
        )
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        worker_role_names = {
            row["name"] for row in response.get_json()["data"]["workforce"]["roles"]
        }
        self.assertNotIn("Vendor Crew Lead", worker_role_names)

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

    def test_vendor_assignment_accepts_dates_outside_event(self):
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
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        assignment = response.get_json()["data"]["assignments"][0]
        self.assertEqual(assignment["workDates"], ["2026-08-01"])

    def test_admin_and_worker_upload_surfaces_support_drag_and_drop(self):
        static_folder = os.path.join(os.path.dirname(app_module.__file__), "static", "js")
        with open(os.path.join(static_folder, "workforce-admin.js"), encoding="utf-8") as source_file:
            admin_source = source_file.read()
        with open(os.path.join(static_folder, "worker.js"), encoding="utf-8") as source_file:
            worker_source = source_file.read()
        self.assertIn("wfAdminUploadDropzone", admin_source)
        self.assertIn("event.dataTransfer?.files", admin_source)
        self.assertIn("new DataTransfer()", admin_source)
        self.assertIn("ADMIN_INVOICE_FILE_ACCEPT", admin_source)
        self.assertIn("'.xlsx'", admin_source)
        self.assertIn("'.xls'", admin_source)
        self.assertIn('pendingUploads: new Map()', admin_source)
        self.assertIn('function wfPendingSubmissionRows(', admin_source)
        self.assertIn('for (let index = 0; index < pendingRows.length; index += 1)', admin_source)
        self.assertIn("formData.append('files', row.file)", admin_source)
        self.assertIn("closeWorkforceModal('wfAdminUploadModal')", admin_source)
        self.assertNotIn('wfAdminUploadProgressBar', admin_source)
        self.assertIn("document.getElementById('wfAdminUploadForm')?.requestSubmit()", admin_source)
        self.assertIn("event-dropzone", worker_source)
        self.assertIn("dataTransfer.files", worker_source)
        self.assertIn('const workerUploadState = {', worker_source)
        self.assertIn('async function processWorkerUploadQueue()', worker_source)
        self.assertIn("form.append('files', row.file, row.file.name)", worker_source)
        self.assertIn('data-upload-progress', worker_source)
        self.assertIn(".xlsx", worker_source)
        self.assertIn(".xls", worker_source)

    def test_event_workforce_quick_action_keeps_the_clicked_event(self):
        static_folder = os.path.join(os.path.dirname(app_module.__file__), "static", "js")
        with open(os.path.join(static_folder, "workforce-admin.js"), encoding="utf-8") as source_file:
            source = source_file.read()
        action = source.split('function openEventWorkforce(eventId', 1)[1].split(
            'async function loadWorkforcePage', 1
        )[0]
        self.assertIn('workflowRememberEvent(id)', action)
        self.assertIn("showSection(focus === 'transport' ? 'transport' : 'workforce', { eventId: id })", action)

    def test_department_assignment_actions_are_in_the_collapsed_header(self):
        static_root = os.path.join(
            os.path.dirname(app_module.__file__),
            "static",
        )
        with open(
            os.path.join(static_root, "js", "workforce-admin.js"),
            encoding="utf-8",
        ) as source_file:
            source = source_file.read()
        with open(
            os.path.join(static_root, "css", "workforce-admin.css"),
            encoding="utf-8",
        ) as source_file:
            styles = source_file.read()

        department_renderer = source.split(
            "function wfDepartmentHtml", 1
        )[1].split("function wfTransportTripCard", 1)[0]
        summary = department_renderer.split("<summary>", 1)[1].split(
            "</summary>", 1
        )[0]
        for label in ("+ Add worker/vendor", "Remove department"):
            self.assertIn(label, summary)
        self.assertIn("openWorkforceDayStaffPicker", summary)
        self.assertNotIn("openVendorDirectory", summary)
        self.assertIn("wf-department-header-actions", summary)
        self.assertIn("event.preventDefault();event.stopPropagation()", summary)
        self.assertNotIn("wf-department-actions", department_renderer)
        self.assertIn(".wf-department-header-actions", styles)

    def test_manage_vendor_card_opens_history_and_keeps_edit_separate(self):
        source_path = os.path.join(
            os.path.dirname(app_module.__file__),
            "static",
            "js",
            "workforce-admin.js",
        )
        with open(source_path, encoding="utf-8") as source_file:
            source = source_file.read()
        vendor_branch = source.split("if (type === 'vendor')", 1)[1].split(
            "const loginBadge",
            1,
        )[0]

        self.assertIn(
            'onclick="openFreelancerHistory(\'${wfAttr(row.id)}\')"',
            vendor_branch,
        )
        self.assertIn(
            'onclick="event.stopPropagation();openVendorProfile(\'${wfAttr(row.id)}\')"',
            vendor_branch,
        )
        self.assertIn('row.workerLastLoginAt', vendor_branch)
        self.assertIn('row.workerLastLoginBy', vendor_branch)
        self.assertIn('Last login:', vendor_branch)

    def test_vendor_payload_reports_latest_member_login(self):
        payload = app_module._admin_vendor_payload(
            {
                "id": "vendor_latest_login",
                "name": "Latest Login Vendor",
                "memberIds": ["member_earlier", "member_latest"],
            },
            {
                "freelancers": [
                    {
                        "id": "member_earlier",
                        "name": "Earlier Member",
                        "workerLastLoginAt": "2026-07-20T09:00:00+08:00",
                    },
                    {
                        "id": "member_latest",
                        "name": "Latest Member",
                        "workerLastLoginAt": "2026-07-21T15:30:00+08:00",
                    },
                ],
                "assignments": {},
                "submissions": {},
            },
        )

        self.assertEqual(
            payload["workerLastLoginAt"],
            "2026-07-21T15:30:00+08:00",
        )
        self.assertEqual(payload["workerLastLoginBy"], "Latest Member")
        self.assertEqual(payload["workerLastLoginById"], "member_latest")

    def test_manage_directory_badges_have_stable_status_colours_and_full_labels(self):
        static_root = os.path.join(os.path.dirname(app_module.__file__), "static")
        with open(
            os.path.join(static_root, "js", "workforce-admin.js"),
            encoding="utf-8",
        ) as source_file:
            source = source_file.read()
        with open(
            os.path.join(static_root, "css", "workforce-admin.css"),
            encoding="utf-8",
        ) as source_file:
            styles = source_file.read()
        badge_source = source.split("function wfDirectorySummaryBadges", 1)[1].split(
            "function openFreelancerDirectory",
            1,
        )[0]

        self.assertIn("awaiting invoice', 'invoice'", badge_source)
        self.assertIn("awaiting confirmation', 'confirmation'", badge_source)
        self.assertIn('class="wf-summary-badge is-${tone}"', badge_source)
        self.assertNotIn("wf-worker-summary small:nth-child", styles)
        self.assertIn(".wf-summary-badge.is-invoice", styles)
        self.assertIn(".wf-summary-badge.is-confirmation", styles)
        self.assertIn("flex-wrap: wrap;", styles)

    def test_worker_submissions_uses_the_manage_worker_vendor_directory(self):
        source_path = os.path.join(
            os.path.dirname(app_module.__file__),
            "static",
            "js",
            "workforce-admin.js",
        )
        with open(source_path, encoding="utf-8") as source_file:
            source = source_file.read()
        workspace = source.split("function renderFreelancerWorkspace()", 1)[1].split(
            "function renderFreelancerWorkspaceEvents",
            1,
        )[0]
        directory = source.split("function renderFreelancerDirectory", 1)[1].split(
            "function openVendorDirectory",
            1,
        )[0]

        self.assertIn("onclick=\"openFreelancerDirectory('manage')\"", workspace)
        self.assertIn("wfDirectoryFreelancers()", directory)
        self.assertIn("wfDirectoryVendors()", directory)
        self.assertIn("freelancerWorkspaceData?.subjects", source)
        self.assertNotIn("wfWorkerSelectorModal", source)
        self.assertNotIn("openFreelancerWorkspaceSelector", source)

    def test_workforce_views_use_configured_department_colours(self):
        static_root = os.path.join(os.path.dirname(app_module.__file__), "static")
        with open(
            os.path.join(static_root, "js", "workforce-admin.js"),
            encoding="utf-8",
        ) as source_file:
            admin_source = source_file.read()
        with open(
            os.path.join(static_root, "css", "workforce-admin.css"),
            encoding="utf-8",
        ) as source_file:
            admin_styles = source_file.read()
        with open(
            os.path.join(static_root, "js", "worker.js"),
            encoding="utf-8",
        ) as source_file:
            worker_source = source_file.read()

        self.assertIn("function wfDepartmentMeta", admin_source)
        self.assertIn("wfDepartmentStyle(row.department)", admin_source)
        self.assertNotIn("function wfDepartmentHue", admin_source)
        self.assertIn("function departmentBadge", worker_source)
        self.assertIn("assignment.departmentColor", worker_source)
        self.assertIn("color-mix(in srgb, var(--wf-dept-color", admin_styles)

        self.login("admin", True)
        response = self.client.post(
            "/api/departments",
            json={"code": "AU", "name": "Audio", "color": "#cdebff"},
        )
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        response = self.client.put(
            "/api/departments/AU",
            json={"code": "AU", "name": "Audio", "color": "#126b58"},
        )
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        payload = self.client.get("/api/events/143/workforce").get_json()["data"]
        department = next(row for row in payload["departments"] if row["code"] == "AU")
        self.assertEqual(department["color"].lower(), "#126b58")

    def test_full_time_app_user_schedule_and_upload_limits(self):
        self.manager.users["normal"].name = "Taylor Fulltime"
        self.manager.users["normal"].phone = "91239876"
        self.manager.save_users()
        self.login("admin", True)

        response = self.client.post(
            "/api/events/143/workforce/staff-assignments",
            json={
                "username": "normal",
                "department": "",
                "roleName": "Operations",
                "workDates": ["2026-07-10", "2026-07-11"],
                "dailyRate": 180,
                "callTime": "08:30",
            },
        )
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        payload = response.get_json()["data"]
        assignment = payload["assignments"][0]
        self.assertEqual(assignment["subjectType"], "app-user")
        self.assertEqual(assignment["userUsername"], "normal")
        self.assertEqual(assignment["department"], "FT")
        self.assertEqual(assignment["callTimes"]["2026-07-10"], "08:30")
        app_user = next(
            row for row in payload["appUsers"] if row["username"] == "normal"
        )
        self.assertEqual(app_user["name"], "Taylor Fulltime")

        limits = payload["uploadAllowances"]["user:normal"]
        self.assertEqual(limits["invoiceLimit"], 1)
        self.assertEqual(limits["claimLimit"], 5)

        response = self.client.patch(
            "/api/events/143/workforce/schedule/call-times",
            json={"updates": [{
                "assignmentId": assignment["id"],
                "date": "2026-07-11",
                "callTime": "09:15",
            }]},
        )
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        refreshed = self.client.get("/api/events/143/workforce").get_json()["data"]
        self.assertEqual(refreshed["assignments"][0]["callTimes"]["2026-07-11"], "09:15")

        response = self.client.post(
            "/api/events/143/workforce/allowances/user%3Anormal",
            json={"kind": "invoice", "delta": 1},
        )
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertEqual(
            response.get_json()["data"]["uploadAllowances"]["user:normal"]["invoiceLimit"],
            2,
        )

        with patch.object(app_module, "_queue_worker_submission_processing"):
            response = self.client.post(
                "/api/events/143/workforce/submissions/user%3Anormal",
                data={
                    "kind": "claim",
                    "claimDate": "2026-07-10",
                    "category": "Meal",
                    "file": (io.BytesIO(PNG_BYTES), "staff-claim.png"),
                },
                content_type="multipart/form-data",
            )
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        claim = response.get_json()["data"]["submissions"]["user:normal"]["claims"][0]
        self.assertNotIn(":", claim["storedPath"])

        response = self.client.get(
            "/api/events/143/workforce/schedule.pdf"
            "?scope=worker&subjectId=user%3Anormal&showRates=1"
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.mimetype, "application/pdf")
        self.assertTrue(
            response.headers.get("Content-Disposition", "").startswith("inline;")
        )
        self.assertTrue(response.data.startswith(b"%PDF"))
        pdf_text = "\n".join(
            page.extract_text() or "" for page in PdfReader(io.BytesIO(response.data)).pages
        )
        self.assertNotIn("PERSONAL MANPOWER SCHEDULE", pdf_text)
        self.assertIn("Taylor Fulltime", pdf_text)
        self.assertIn("Event ID", pdf_text)
        self.assertNotIn("Schedule type", pdf_text)

        self.assertIn("Generated by", pdf_text)
        self.assertIn("Generated on", pdf_text)
        self.assertIn("10 July 2026", pdf_text)
        self.assertIn("11 July 2026", pdf_text)
        self.assertNotIn("12 July 2026", pdf_text)
        self.assertNotIn("No manpower assigned", pdf_text)
        self.assertNotIn("Person-days", pdf_text)
        self.assertNotIn("Pax", pdf_text)
        self.assertNotIn("+65 9123 9876", pdf_text)

        response = self.client.get(
            "/api/events/143/workforce/schedule.pdf"
            "?scope=worker&subjectId=user%3Anormal&showPhones=1"
        )
        self.assertEqual(response.status_code, 200)
        phone_pdf_text = "\n".join(
            page.extract_text() or ""
            for page in PdfReader(io.BytesIO(response.data)).pages
        )
        self.assertIn("+65 9123 9876", phone_pdf_text)

    def test_standard_user_can_submit_claim_only_for_assigned_event(self):
        self.manager.users["normal"].role = "user"
        self.login("admin", True)
        assigned = self.client.post(
            "/api/events/143/workforce/staff-assignments",
            json={"username": "normal", "department": "AU",
                  "roleName": "Audio Technician", "workDates": ["2026-07-10"]},
        )
        self.assertEqual(assigned.status_code, 200, assigned.get_data(as_text=True))

        self.login("normal", False)
        page = self.client.get("/my-claims")
        self.assertEqual(page.status_code, 200)
        self.assertIn("My Claims", page.get_data(as_text=True))
        payload = self.client.get("/api/my-claims")
        self.assertEqual(payload.status_code, 200)
        self.assertEqual(payload.get_json()["data"]["events"][0]["id"], 143)

        with patch.object(app_module, "_queue_worker_submission_processing"):
            submitted = self.client.post(
                "/api/my-claims",
                data={"eventId": "143", "amount": "24.50",
                      "claimDate": "2026-07-10", "category": "Transport",
                      "notes": "Taxi to venue",
                      "file": (io.BytesIO(PNG_BYTES), "taxi.png")},
                content_type="multipart/form-data",
            )
        self.assertEqual(submitted.status_code, 200, submitted.get_data(as_text=True))
        claim = submitted.get_json()["data"]["events"][0]["claims"][0]
        self.assertEqual(claim["amount"], 24.5)
        self.assertEqual(claim["category"], "Transport")

        with patch.object(app_module, "_queue_worker_submission_processing") as queue:
            multiple = self.client.post(
                "/api/my-claims",
                data={
                    "eventId": "143",
                    "files": [
                        (io.BytesIO(PNG_BYTES), "meal.png"),
                        (io.BytesIO(PDF_BYTES), "transport.pdf"),
                    ],
                },
                content_type="multipart/form-data",
            )
        self.assertEqual(multiple.status_code, 200, multiple.get_data(as_text=True))
        uploaded_claims = multiple.get_json()["data"]["events"][0]["claims"]
        self.assertEqual(len(uploaded_claims), 3)
        self.assertTrue(all(row["processingState"] == "Queued" for row in uploaded_claims[1:]))
        self.assertEqual(queue.call_count, 2)

        with patch.object(app_module, "_queue_worker_submission_processing") as queue:
            invoice_response = self.client.post(
                "/api/my-claims",
                data={
                    "eventId": "143",
                    "kind": "invoice",
                    "files": [(io.BytesIO(PDF_BYTES), "staff-invoice.pdf")],
                },
                content_type="multipart/form-data",
            )
        self.assertEqual(
            invoice_response.status_code, 200, invoice_response.get_data(as_text=True)
        )
        invoice_event = invoice_response.get_json()["data"]["events"][0]
        self.assertEqual(invoice_event["invoices"][0]["originalName"], "staff-invoice.pdf")
        self.assertEqual(invoice_event["invoiceSlotsRemaining"], 0)
        self.assertEqual(queue.call_count, 1)
        invoice_id = invoice_event["invoices"][0]["id"]

        with mutate_workforce(self.tempdir.name) as workforce:
            invoice = workforce["submissions"]["143"]["user:normal"]["invoices"][0]
            invoice["processingState"] = "Complete"
            invoice["submissionStage"] = "Submitted"
        details = self.client.put(
            f"/api/my-claims/{invoice_id}",
            json={"amount": "180.50", "notes": "Event services invoice"},
        )
        self.assertEqual(details.status_code, 200, details.get_data(as_text=True))
        updated_invoice = details.get_json()["data"]["events"][0]["invoices"][0]
        self.assertEqual(updated_invoice["amount"], 180.5)
        self.assertEqual(updated_invoice["submissionStage"], "Submitted")
        preview = self.client.get(f"/api/my-claims/{invoice_id}/file")
        self.assertEqual(preview.status_code, 200)
        self.assertEqual(preview.mimetype, "application/pdf")
        self.assertTrue(preview.data.startswith(b"%PDF"))
        preview.close()

        deleted_invoice = self.client.delete(f"/api/my-claims/{invoice_id}")
        self.assertEqual(
            deleted_invoice.status_code, 200, deleted_invoice.get_data(as_text=True)
        )
        self.assertEqual(deleted_invoice.get_json()["data"]["events"][0]["invoices"], [])

        denied = self.client.post(
            "/api/my-claims",
            data={"eventId": "999", "amount": "5", "claimDate": "2026-07-10",
                  "category": "Meal", "file": (io.BytesIO(PNG_BYTES), "meal.png")},
            content_type="multipart/form-data",
        )
        self.assertEqual(denied.status_code, 403)

        self.login("admin", True)
        self.assertEqual(self.client.get("/my-claims").status_code, 302)
        self.assertEqual(self.client.get("/api/my-claims").status_code, 403)

    def test_schedule_pdf_only_shows_room_for_multi_room_events(self):
        base_payload = {
            "event": {
                "id": 143,
                "name": "Room-aware schedule",
                "location": "Showbase",
                "startDateValue": "2026-07-10",
                "endDateValue": "2026-07-10",
            },
            "freelancers": [{
                "id": "worker-1",
                "name": "Taylor Crew",
                "phone": "91239876",
            }],
            "vendors": [],
            "appUsers": [],
            "allDepartments": [{"code": "AX", "name": "Audio", "color": "#dbeafe"}],
            "departments": [],
            "assignments": [{
                "id": "assignment-1",
                "freelancerId": "worker-1",
                "department": "AX",
                "roleName": "Audio Engineer",
                "subprojectId": "main",
                "subprojectName": "Main Room",
                "workDates": ["2026-07-10"],
                "callTimes": {"2026-07-10": "08:00"},
            }],
        }

        single_room_payload = {
            **base_payload,
            "subprojects": [{"id": "main", "name": "Main Room"}],
        }
        single_pdf = build_workforce_schedule_pdf(
            single_room_payload,
            company={"companyName": "Showbase", "phone": "61234567"},
            show_phones=True,
        )
        single_text = "\n".join(
            page.extract_text() or ""
            for page in PdfReader(io.BytesIO(single_pdf)).pages
        )
        self.assertNotIn("Room\n", single_text)
        self.assertIn("+65 9123 9876", single_text)
        self.assertIn("+65 6123 4567", single_text)

        multi_room_payload = {
            **base_payload,
            "subprojects": [
                {"id": "main", "name": "Main Room"},
                {"id": "breakout", "name": "Breakout Room"},
            ],
        }
        multi_pdf = build_workforce_schedule_pdf(multi_room_payload)
        multi_reader = PdfReader(io.BytesIO(multi_pdf))
        multi_text = "\n".join(page.extract_text() or "" for page in multi_reader.pages)
        first_page = multi_reader.pages[0]
        self.assertGreater(
            float(first_page.mediabox.height),
            float(first_page.mediabox.width),
        )
        self.assertIn("Room", multi_text)
        self.assertIn("Main Room", multi_text)
        self.assertNotIn("person-days", multi_text)
        self.assertNotIn("workers |", multi_text)
        self.assertLess(multi_text.index("Room"), multi_text.index("Department"))
        self.assertLess(multi_text.index("Department"), multi_text.index("Role / Assignment"))
        self.assertLess(multi_text.index("Role / Assignment"), multi_text.index("Call time"))

    def test_workforce_schedule_pdf_keeps_phone_number_on_one_line(self):
        payload = {
            "event": {
                "id": 143,
                "name": "Phone wrapping schedule",
                "location": "Showbase",
                "startDateValue": "2026-07-10",
                "endDateValue": "2026-07-10",
            },
            "freelancers": [{
                "id": "worker-phone-wrap",
                "name": "Alexandra Benjamin Crew",
                "phone": "91239876",
            }],
            "vendors": [],
            "appUsers": [],
            "allDepartments": [{"code": "AX", "name": "Audio"}],
            "departments": [],
            "assignments": [{
                "id": "assignment-phone-wrap",
                "freelancerId": "worker-phone-wrap",
                "department": "AX",
                "roleName": "Audio Engineer",
                "workDates": ["2026-07-10"],
                "callTimes": {"2026-07-10": "08:00"},
            }],
        }

        pdf_bytes = build_workforce_schedule_pdf(payload, show_phones=True)
        pdf_text = "\n".join(
            page.extract_text() or ""
            for page in PdfReader(io.BytesIO(pdf_bytes)).pages
        ).replace("\u00a0", " ")

        self.assertIn("+65 9123 9876", pdf_text)
        self.assertNotIn("+65 9123\n9876", pdf_text)

    def test_workforce_schedule_pdf_preserves_chinese_text(self):
        payload = {
            "event": {
                "id": 168,
                "name": "新春晚宴",
                "location": "滨海湾宴会厅",
                "startDateValue": "2026-08-18",
                "endDateValue": "2026-08-18",
            },
            "freelancers": [{
                "id": "worker-cn",
                "name": "陈小明",
                "phone": "91239876",
            }],
            "vendors": [],
            "appUsers": [],
            "allDepartments": [{
                "code": "LX",
                "name": "灯光部",
                "color": "#dbeafe",
            }],
            "departments": [],
            "subprojects": [
                {"id": "main", "name": "主宴会厅"},
                {"id": "foyer", "name": "迎宾厅"},
            ],
            "assignments": [{
                "id": "assignment-cn",
                "freelancerId": "worker-cn",
                "department": "LX",
                "roleName": "灯光操作员",
                "subprojectId": "main",
                "subprojectName": "主宴会厅",
                "workDates": ["2026-08-18"],
                "callTimes": {"2026-08-18": "08:00"},
            }],
        }
        pdf_bytes = build_workforce_schedule_pdf(
            payload,
            company={
                "companyName": "演出制作有限公司",
                "footerText": "感谢您的支持",
            },
            show_phones=True,
        )
        pdf_text = "\n".join(
            page.extract_text() or ""
            for page in PdfReader(io.BytesIO(pdf_bytes)).pages
        )

        for expected in (
            "演出制作有限公司",
            "新春晚宴",
            "滨海湾宴会厅",
            "陈小明",
            "主宴会厅",
            "灯光部",
            "灯光操作员",
            "感谢您的支持",
        ):
            self.assertIn(expected, pdf_text)

    def test_every_pdf_export_uses_chinese_capable_fonts(self):
        static_root = os.path.join(os.path.dirname(app_module.__file__), "static", "js")
        with open(os.path.join(static_root, "app.js"), encoding="utf-8") as source_file:
            app_source = source_file.read()
        self.assertIn("const PDF_EXPORT_FONT_FAMILY", app_source)
        self.assertIn("'Microsoft YaHei'", app_source)
        self.assertIn("'PingFang SC'", app_source)
        self.assertIn("'Noto Sans CJK SC'", app_source)

        for filename in (
            "delivery-order.js",
            "inventory-export.js",
            "packing-list.js",
            "transfer.js",
        ):
            with self.subTest(filename=filename):
                with open(os.path.join(static_root, filename), encoding="utf-8") as source_file:
                    source = source_file.read()
                self.assertIn("PDF_EXPORT_FONT_FAMILY", source)
                self.assertIn('<meta charset="UTF-8">', source)

        project_root = os.path.dirname(app_module.__file__)
        for filename in ("costing_pdf.py", "profit_loss_pdf.py", "workforce_schedule.py"):
            with self.subTest(filename=filename):
                with open(os.path.join(project_root, filename), encoding="utf-8") as source_file:
                    source = source_file.read()
                self.assertIn("_paragraph", source)
                self.assertIn("_canvas_font", source)

    def test_workforce_schedule_frontend_is_responsive_and_granular(self):
        static_root = os.path.join(os.path.dirname(app_module.__file__), "static")
        with open(
            os.path.join(static_root, "js", "workforce-schedule.js"),
            encoding="utf-8",
        ) as source_file:
            source = source_file.read()
        with open(
            os.path.join(static_root, "css", "workforce-schedule.css"),
            encoding="utf-8",
        ) as source_file:
            styles = source_file.read()
        with open(
            os.path.join(static_root, "js", "workforce-admin.js"),
            encoding="utf-8",
        ) as source_file:
            admin_source = source_file.read()
        with open(
            os.path.join(static_root, "css", "workforce-admin.css"),
            encoding="utf-8",
        ) as source_file:
            admin_styles = source_file.read()

        self.assertIn("schedule/call-times", source)
        self.assertIn('onclick="applyWorkforceBulkCallTime()">Apply</button>', source)
        self.assertNotIn("Apply to All Staff", source)
        self.assertNotIn("Apply to Department", source)
        self.assertNotIn("departmentOnly", source)
        self.assertIn(
            "department !== 'all' && wfScheduleDepartment(row, date) !== department",
            source,
        )
        self.assertIn("wfScheduleCustomSelectHtml", source)
        self.assertIn("chooseWorkforceScheduleSelect", source)
        self.assertNotIn('<select id="wfScheduleBulkDay"', source)
        self.assertNotIn('<select id="wfScheduleBulkDepartment"', source)
        self.assertIn(".wf-schedule-select-menu", styles)
        self.assertNotIn('onclick="openFullTimeStaffAssignment()"', source)
        self.assertNotIn("printWorkforceSchedule", source)
        self.assertIn("...appUsers.map(row => ({ type: 'app-user', row }))", admin_source)
        self.assertIn("Add Worker or Full-time Staff", admin_source)
        self.assertIn("coverageMode", source)
        self.assertIn("wfScheduleCoverageTotal", source)
        self.assertIn("wf-schedule-filter-options", source)
        self.assertIn("Manage Workers/Vendors", source)
        self.assertIn("openFreelancerDirectory('manage')", source)
        self.assertIn(".wf-schedule-manage-directory", styles)
        self.assertIn(
            "font-weight: 400;",
            styles.split(".wf-schedule-role {", 1)[1].split("}", 1)[0],
        )
        self.assertIn(
            "font-weight: 500;",
            styles.split(".wf-schedule-filter-options > button {", 1)[1].split("}", 1)[0],
        )
        self.assertIn(
            "font-weight: 500;",
            admin_styles.split(".wf-assignment-chip {", 1)[1].split("}", 1)[0],
        )
        self.assertIn(
            "font-weight: 400;",
            admin_styles.split(".wf-transport-meta strong {", 1)[1].split("}", 1)[0],
        )
        self.assertIn('class="wf-trip-cost"', admin_source)
        self.assertIn("wfConflictTooltipText(dateConflicts)", source)
        self.assertIn('data-wf-tooltip="${wfAttr(conflictTitle)}"', source)
        self.assertNotIn('class="wf-schedule-conflict" title=', source)
        self.assertIn("function wfConflictTooltipText", admin_source)
        self.assertIn("function showWorkforceInstantTooltip", admin_source)
        self.assertIn('data-wf-tooltip="${wfAttr(conflictTitle)}"', admin_source)
        self.assertNotIn('class="wf-worker-conflict" title=', admin_source)
        self.assertIn(".wf-instant-tooltip-popup", admin_styles)
        self.assertIn("<th>Event Total</th>", source)
        self.assertIn("By department", source)
        self.assertIn("By day", source)
        self.assertIn(
            'class="plan-page-heading wf-manpower-page-heading wf-schedule-heading"',
            source,
        )
        self.assertIn("wfManpowerEventPickerHtml(data", source)
        self.assertIn("function wfManpowerEventPickerHtml", admin_source)
        self.assertIn("wf-event-picker-content", admin_source)
        self.assertNotIn("By Worker", source)
        self.assertIn("window.open(", source)
        self.assertIn("ensureWorkforceScheduleExportModal", source)
        self.assertIn("wfScheduleExportPhones", source)
        self.assertIn("wfScheduleExportRates", source)
        self.assertIn("showPhones", source)
        self.assertIn("wfWorkerVendorMemberships", admin_source)
        self.assertIn("wfWorkerScheduleIncludeVendor", admin_source)
        self.assertIn("params.set('showVendor', '1')", admin_source)
        self.assertIn("removeWorkforceScheduleDate", source)
        self.assertIn("wf-schedule-person-remove", source)
        self.assertNotIn("openWorkforceScheduleDayEditor", source)
        self.assertNotIn("saveWorkforceScheduleDayAssignment", source)
        self.assertNotIn("Edit day assignment", source)
        self.assertNotIn("wfScheduleDayEditorModal", source)
        self.assertIn("wf-schedule-dept-edit", source)
        self.assertIn("wf-schedule-role", source)
        self.assertIn("openWorkforceScheduleRoleEditor", source)
        self.assertIn("saveWorkforceScheduleRole", source)
        self.assertIn("wfScheduleRoleSuggestions", source)
        self.assertIn("wfScheduleRoleUsageKeys", source)
        self.assertIn("renderWorkforceScheduleRoleSuggestions", source)
        self.assertIn("chooseWorkforceScheduleRoleSuggestion", source)
        suggestion_handler = source.split(
            "function chooseWorkforceScheduleRoleSuggestion", 1
        )[1].split("\n}", 1)[0]
        self.assertIn("requestSubmit()", suggestion_handler)
        self.assertNotIn("input.focus()", suggestion_handler)
        self.assertIn("roleType === 'vendor'", source)
        self.assertIn("vendorRoleKeys.has(roleKey)", source)
        self.assertIn(">Suggested</span>", source)
        self.assertIn(".wf-schedule-role-popover", styles)
        self.assertIn(".wf-schedule-role-suggestions", styles)
        tag_menu_css = styles.split(".wf-schedule-tag-menu {", 1)[1].split("}", 1)[0]
        save_button_css = styles.split(
            ".wf-schedule-role-actions > button.primary {", 1
        )[1].split("}", 1)[0]
        self.assertIn("--schedule-green: var(--wf-brand, #0f766e);", tag_menu_css)
        self.assertIn("--schedule-green-dark: var(--wf-brand-dark, #0b5f58);", tag_menu_css)
        self.assertIn("background: var(--schedule-green, #0f766e);", save_button_css)
        self.assertIn("color: #fff;", save_button_css)
        self.assertIn(
            ".wf-schedule-role-actions > button.primary:focus-visible",
            styles,
        )
        self.assertIn("wfScheduleRoomSelectHtml", source)
        room_selector = source.split(
            "function wfScheduleRoomSelectHtml", 1
        )[1].split("\n}", 1)[0]
        self.assertIn("if (rooms.length <= 1) return '';", room_selector)
        self.assertNotIn("is-static", room_selector)
        self.assertNotIn(".wf-schedule-room.is-static", styles)
        self.assertIn("toggleWorkforceScheduleRoomMenu", source)
        self.assertIn("toggleWorkforceScheduleDepartmentMenu", source)
        self.assertIn("updateWorkforceScheduleDepartment", source)
        self.assertIn("wfScheduleTagMenu", source)
        self.assertIn("updateWorkforceAssignmentSubproject", source)
        self.assertNotIn("/subproject`,", source)
        self.assertIn("roleName: role === 'Role not set' ? '' : role", source)
        self.assertIn("subprojectId", source)
        self.assertIn("const previousChip =", source)
        self.assertIn("trigger.textContent = label", source)
        self.assertIn("wfRoomChipStyle({ ...assignment, subprojectId })", source)
        self.assertIn("trigger.textContent = previousChip.label", source)
        self.assertNotIn("<select class=\"wf-schedule-room", source)
        self.assertNotIn(
            "openWorkforceScheduledAssignment('${wfAttr(row.id)}')\">${wfEscape(roomLabel)}",
            source,
        )
        self.assertIn("const subprojectOrder = roomOrder(a) - roomOrder(b);", source)
        self.assertLess(
            source.index("const subprojectOrder = roomOrder(a) - roomOrder(b);"),
            source.index("const aDepartment = wfScheduleDepartment(a, date);"),
        )
        self.assertIn(".wf-schedule-tag-menu", styles)
        self.assertIn(".wf-schedule-tag-menu-badge", styles)
        self.assertNotIn(".wf-schedule-day-departments", styles)
        self.assertIn("wfScheduleQuotationLabelHtml", source)
        self.assertIn("quotationScheduleLabels", source)
        self.assertIn(".wf-schedule-day-purpose", styles)
        self.assertIn("dateConflicts", source)
        self.assertIn("dateConflicts.length ? 'has-conflict'", source)
        self.assertIn(".wf-schedule-person.has-conflict", styles)
        self.assertIn("document.getElementById('wfScheduleExportPhones').checked = false", source)
        self.assertIn("document.getElementById('wfScheduleExportRates').checked = false", source)
        self.assertNotIn("window.location.assign", source)
        self.assertIn("wfCalendarExtraDateChipHtml", admin_source)
        self.assertIn("adjacentDates", admin_source)
        self.assertIn("adjacent-date", admin_source)
        self.assertIn("button.wf-calendar-day.adjacent-date", admin_styles)
        calendar_cells = admin_styles.split(
            ".wf-calendar-day,\n.wf-calendar-blank", 1
        )[1].split("}", 1)[0]
        self.assertIn("width: 100%;", calendar_cells)
        self.assertIn("height: 31px;", calendar_cells)
        self.assertIn("padding: 0;", calendar_cells)
        self.assertIn("button.wf-calendar-day.selected:hover", admin_styles)
        self.assertIn("button.wf-calendar-day.selected.has-conflict:hover", admin_styles)
        self.assertIn("grid-auto-columns: minmax(238px, 1fr)", styles)
        self.assertIn("container-type: inline-size", styles)
        self.assertIn("@container (min-width: 340px)", styles)
        self.assertNotIn("wfScheduleDates().length <=", source)
        self.assertIn("@media (max-width: 720px)", styles)


if __name__ == "__main__":
    unittest.main()
