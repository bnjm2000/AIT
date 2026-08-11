"""Human-readable ownership details for files in company storage reports."""

from __future__ import annotations

from copy import deepcopy
import os
import re

from maintenance_logs import normalize_maintenance_log


_STORAGE_AREAS = {"branding", "data", "documents", "exports", "frontend", "media"}


def _normalise_storage_path(value: str) -> str:
    return str(value or "").strip().replace("\\", "/").strip("/").lower()


def _context_keys(value: str) -> tuple[str, ...]:
    path = _normalise_storage_path(value)
    if not path:
        return ()
    keys = [path]
    first, separator, remainder = path.partition("/")
    if separator and first in _STORAGE_AREAS:
        keys.append(remainder)
    return tuple(dict.fromkeys(keys))


def _clean_text(value, limit: int = 120) -> str:
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    if len(text) <= limit:
        return text
    return f"{text[: max(1, limit - 3)].rstrip()}..."


def _maintenance_context(owner_label: str, record: dict, display_name: str = "") -> dict:
    log_type = _clean_text(record.get("type")).replace("_", " ").title()
    details = [
        _clean_text(record.get("date")),
        log_type,
        _clean_text(record.get("description")),
    ]
    return {
        "displayName": _clean_text(display_name) or "Maintenance attachment",
        "contextType": "maintenance_log",
        "contextLabel": f"Maintenance log for {owner_label}",
        "contextDetail": " · ".join(value for value in details if value),
    }


def _add_context(index: dict, path: str, context: dict, *, overwrite: bool = False) -> None:
    for key in _context_keys(path):
        if overwrite:
            index[key] = context
        else:
            index.setdefault(key, context)


def build_company_storage_contexts(manager) -> dict:
    """Index stored media by the record it belongs to.

    Container records are indexed before inventory records because container
    maintenance logs are also copied to their member assets.
    """
    contexts = {}

    containers = getattr(manager, "containers", {}) or {}
    for container_id, container in containers.items():
        owner_label = f"container {container_id}"
        photo_filename = os.path.basename(
            str(getattr(container, "photo_filename", "") or "")
        )
        if photo_filename:
            _add_context(
                contexts,
                f"ContainerMedia/{photo_filename}",
                {
                    "displayName": (
                        _clean_text(getattr(container, "photo_original_name", ""))
                        or photo_filename
                    ),
                    "contextType": "container_photo",
                    "contextLabel": f"Container {container_id}",
                    "contextDetail": "Container photo",
                },
            )

        for log_entry in getattr(container, "maintenance_logs", []) or []:
            record = normalize_maintenance_log(log_entry)
            for media in record.get("media", []) or []:
                _add_context(
                    contexts,
                    media.get("path"),
                    _maintenance_context(owner_label, record, media.get("name")),
                )

    inventory = getattr(manager, "inventory", {}) or {}
    for asset_id, asset in inventory.items():
        owner_label = f"asset {getattr(asset, 'asset_id', '') or asset_id}"
        for log_entry in getattr(asset, "maintenance_logs", []) or []:
            record = normalize_maintenance_log(log_entry)
            for media in record.get("media", []) or []:
                _add_context(
                    contexts,
                    media.get("path"),
                    _maintenance_context(owner_label, record, media.get("name")),
                )

    return contexts


def attach_company_storage_contexts(storage: dict, contexts: dict) -> dict:
    """Return a response copy with human-readable file ownership attached."""
    result = deepcopy(storage or {})
    for item in result.get("largestFiles", []) or []:
        context = None
        for key in _context_keys(item.get("relativePath")):
            context = contexts.get(key)
            if context:
                break
        if context:
            item.update(context)
        else:
            item.setdefault("displayName", item.get("name") or "Stored file")
            item.setdefault("contextType", item.get("category") or "other")
            item.setdefault("contextLabel", item.get("categoryLabel") or "Company file")
            item.setdefault("contextDetail", "")
    return result
