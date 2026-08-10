import json
import os
import tempfile
import unittest
from unittest import mock

from data_manager import DataManager
from migrate_storage import migrate
from workforce import upload_absolute_path


class StorageLayoutTests(unittest.TestCase):
    def _write(self, path, content=b"test-file"):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        mode = "wb" if isinstance(content, bytes) else "w"
        kwargs = {} if mode == "wb" else {"encoding": "utf-8"}
        with open(path, mode, **kwargs) as handle:
            handle.write(content)

    def test_migration_segregates_company_files_without_changing_logical_paths(self):
        with tempfile.TemporaryDirectory() as source, tempfile.TemporaryDirectory() as target:
            registry = {
                "defaultCompany": "ACME",
                "companies": {
                    "ACME": {
                        "code": "ACME",
                        "name": "Acme Events",
                        "backendFolder": "companies/ACME/backend",
                        "frontendFolder": "companies/ACME/frontend",
                    }
                },
                "userCompanies": {},
                "superAdmins": [],
            }
            self._write(
                os.path.join(source, "app_data", "Companies.json"),
                json.dumps(registry),
            )
            self._write(os.path.join(source, "app_data", "Users.csv"), "")
            backend = os.path.join(source, "companies", "ACME", "backend")
            self._write(os.path.join(backend, "Inventory.csv"), "asset-row")
            self._write(os.path.join(backend, "events", "7. event.csv"), "event-row")
            self._write(
                os.path.join(backend, "events", "7. event", "brief.pdf"),
                b"event-document",
            )
            workforce_path = os.path.join(
                backend,
                "workforce_uploads",
                "7",
                "worker-1",
                "invoice.pdf",
            )
            self._write(workforce_path, b"invoice-document")
            self._write(
                os.path.join(backend, "maintenance_media", "log-1", "photo.jpg"),
                b"maintenance-media",
            )
            self._write(
                os.path.join(backend, "ContainerMedia", "container.jpg"),
                b"container-media",
            )
            self._write(
                os.path.join(source, "companies", "ACME", "frontend", "logo.png"),
                b"branding-image",
            )

            result = migrate(source, target)

            self.assertEqual(result["companyCount"], 1)
            company_root = os.path.join(target, "companies", "ACME")
            expected = (
                os.path.join(company_root, "data", "Inventory.csv"),
                os.path.join(company_root, "data", "events", "7. event.csv"),
                os.path.join(company_root, "documents", "events", "7. event", "brief.pdf"),
                os.path.join(
                    company_root,
                    "documents",
                    "workforce_uploads",
                    "7",
                    "worker-1",
                    "invoice.pdf",
                ),
                os.path.join(company_root, "media", "maintenance_media", "log-1", "photo.jpg"),
                os.path.join(company_root, "media", "ContainerMedia", "container.jpg"),
                os.path.join(company_root, "branding", "logo.png"),
            )
            for path in expected:
                self.assertTrue(os.path.isfile(path), path)

            with open(os.path.join(target, "config", "Companies.json"), encoding="utf-8") as handle:
                migrated_record = json.load(handle)["companies"]["ACME"]
            self.assertEqual(migrated_record["dataFolder"], "companies/ACME/data")
            self.assertEqual(migrated_record["documentsFolder"], "companies/ACME/documents")
            self.assertEqual(migrated_record["mediaFolder"], "companies/ACME/media")

            with mock.patch.dict(os.environ, {"SHOWBASE_STORAGE_ROOT": target}):
                manager = DataManager(
                    os.path.join(company_root, "data"),
                    documents_folder=os.path.join(company_root, "documents"),
                    media_folder=os.path.join(company_root, "media"),
                )
                manager.event_file_map[7] = "7. event.csv"
                self.assertEqual(
                    manager.get_event_folder(7),
                    os.path.join(company_root, "documents", "events", "7. event"),
                )
                self.assertEqual(
                    upload_absolute_path(
                        manager.data_folder,
                        "workforce_uploads/7/worker-1/invoice.pdf",
                    ),
                    expected[3],
                )

            with self.assertRaises(FileExistsError):
                migrate(source, target)

    def test_canonical_managers_can_read_legacy_event_documents_as_fallback(self):
        with tempfile.TemporaryDirectory() as root:
            data = os.path.join(root, "data")
            documents = os.path.join(root, "documents")
            legacy = os.path.join(data, "events", "3. legacy event")
            self._write(os.path.join(legacy, "brief.pdf"), b"legacy")
            manager = DataManager(data, documents_folder=documents)
            manager.event_file_map[3] = "3. legacy event.csv"

            self.assertEqual(manager.get_event_folder(3), legacy)

    def test_event_documents_remain_available_after_event_name_changes(self):
        with tempfile.TemporaryDirectory() as root:
            data = os.path.join(root, "data")
            documents = os.path.join(root, "documents")
            historical = os.path.join(
                documents,
                "events",
                "131. [20260522] Original event name",
            )
            self._write(os.path.join(historical, "brief.pdf"), b"brief")
            manager = DataManager(data, documents_folder=documents)
            manager.event_file_map[131] = "131. [20260522] Renamed event.csv"

            self.assertEqual(manager.get_event_folder(131), historical)


if __name__ == "__main__":
    unittest.main()
