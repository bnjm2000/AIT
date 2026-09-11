"""Helpers for structural tests that inspect the classic-script application bundle."""

from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
APP_SCRIPT_FILES = (
    "app.js",
    "asset-check.js",
    "plan.js",
    "prepare.js",
    "admin-settings.js",
    "packing-list.js",
    "delivery-order.js",
    "events-overview.js",
    "inventory-export.js",
    "transfer.js",
)


def app_bundle_source() -> str:
    script_root = PROJECT_ROOT / "static" / "js"
    return "\n".join(
        (script_root / filename).read_text(encoding="utf-8")
        for filename in APP_SCRIPT_FILES
    )


APP_BUNDLE_SOURCE = app_bundle_source()
