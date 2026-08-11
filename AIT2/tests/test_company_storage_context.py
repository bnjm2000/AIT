from pathlib import Path
from types import SimpleNamespace

from services.company_storage import storage_category
from services.company_storage_context import (
    attach_company_storage_contexts,
    build_company_storage_contexts,
)


def test_storage_context_identifies_container_photo_and_maintenance_owner():
    shared_media = {
        "id": "media-1",
        "name": "speaker fault.jpg",
        "path": "maintenance_media/log-1/file-1.jpg",
        "kind": "image",
    }
    manager = SimpleNamespace(
        containers={
            "AD Rack #01": SimpleNamespace(
                photo_filename="container-photo.jpg",
                photo_original_name="AD Rack front.jpg",
                maintenance_logs=[],
            )
        },
        inventory={
            "ULXD2#03": SimpleNamespace(
                asset_id="ULXD2#03",
                maintenance_logs=[{
                    "id": "log-1",
                    "date": "2026-08-10",
                    "type": "fault",
                    "description": "Intermittent RF output",
                    "media": [shared_media],
                }],
            )
        },
    )
    storage = {
        "largestFiles": [
            {
                "name": "container-photo.jpg",
                "relativePath": "media/ContainerMedia/container-photo.jpg",
                "category": "inventory",
                "categoryLabel": "Inventory & asset data",
            },
            {
                "name": "file-1.jpg",
                "relativePath": "media/maintenance_media/log-1/file-1.jpg",
                "category": "maintenance",
                "categoryLabel": "Maintenance files",
            },
        ]
    }

    result = attach_company_storage_contexts(
        storage,
        build_company_storage_contexts(manager),
    )

    container_photo, maintenance_media = result["largestFiles"]
    assert container_photo["displayName"] == "AD Rack front.jpg"
    assert container_photo["contextLabel"] == "Container AD Rack #01"
    assert container_photo["contextDetail"] == "Container photo"
    assert maintenance_media["displayName"] == "speaker fault.jpg"
    assert maintenance_media["contextLabel"] == "Maintenance log for asset ULXD2#03"
    assert "2026-08-10" in maintenance_media["contextDetail"]
    assert "Intermittent RF output" in maintenance_media["contextDetail"]
    assert "contextLabel" not in storage["largestFiles"][0]


def test_container_media_counts_as_inventory_storage():
    assert storage_category("media", "ContainerMedia/photo.jpg") == "inventory"


def test_company_details_storage_ui_uses_tabs_and_hides_paths():
    source = Path("static/js/admin-settings.js").read_text(encoding="utf-8")

    assert 'data-company-details-tab="details"' in source
    assert 'data-company-details-tab="storage"' in source
    storage_renderer = source[source.index("function renderCompanyStorageUsage"):]
    storage_renderer = storage_renderer[:storage_renderer.index("async function loadCompanyStorageUsage")]
    assert "file.contextLabel" in storage_renderer
    assert "file.contextDetail" in storage_renderer
    assert "file.relativePath" not in storage_renderer
