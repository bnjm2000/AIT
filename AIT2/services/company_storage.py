"""Company storage accounting and short-lived usage caching."""

from __future__ import annotations

import os
import threading
import time
from bisect import insort
from datetime import datetime


STORAGE_CATEGORIES = (
    ("uploads", "Invoices, claims & expense uploads"),
    ("events", "Events & event files"),
    ("maintenance", "Maintenance files"),
    ("inventory", "Inventory & asset data"),
    ("workforce", "Manpower & transport data"),
    ("finance", "Quotations & finance data"),
    ("branding", "Branding & PDF settings"),
    ("logs", "Logs & live state"),
    ("company_data", "Company settings & users"),
    ("other", "Other company files"),
)


def storage_category(root_kind: str, relative_path: str) -> str:
    relative_path = str(relative_path or "").replace("\\", "/").lower()
    filename = os.path.basename(relative_path)
    stem = os.path.splitext(filename)[0]

    if root_kind in {"branding", "frontend"}:
        return "branding"
    if relative_path.startswith("workforce_uploads/"):
        return "uploads"
    if relative_path.startswith("containermedia/"):
        return "inventory"
    if (
        root_kind == "media"
        or relative_path.startswith("maintenance_media/")
        or stem.startswith("maintenance")
    ):
        return "maintenance"
    if relative_path.startswith("events/"):
        return "events"
    if stem.startswith("finance"):
        return "finance"
    if stem.startswith("workforce"):
        return "workforce"
    if stem in {"assetlist", "inventory", "containers", "clients", "departments"}:
        return "inventory"
    if stem in {"logs", "realtimestate"}:
        return "logs"
    if stem.startswith("pdfsettings"):
        return "branding"
    if stem in {"users", "company", "companies"}:
        return "company_data"
    return "other"


class CompanyStorageUsageService:
    """Calculate company storage without coupling filesystem traversal to Flask."""

    def __init__(self, cache_seconds: float = 30.0, logger=None):
        self.cache_seconds = max(5.0, float(cache_seconds))
        self.logger = logger
        self._cache = {}
        self._lock = threading.RLock()

    def invalidate(self, *company_codes: str) -> None:
        with self._lock:
            if not company_codes:
                self._cache.clear()
                return
            for company_code in company_codes:
                self._cache.pop(str(company_code or "").strip().upper(), None)

    def calculate(
        self,
        company_code: str,
        roots,
        *,
        database_url: str = "",
        force: bool = False,
    ) -> dict:
        code = str(company_code or "").strip().upper()
        now = time.monotonic()
        with self._lock:
            cached = self._cache.get(code)
            if cached and not force and now - cached["cachedAt"] < self.cache_seconds:
                return cached["data"]

        totals = {
            key: {
                "key": key,
                "label": label,
                "bytes": 0,
                "fileCount": 0,
                "recordCount": 0,
            }
            for key, label in STORAGE_CATEGORIES
        }
        seen_paths = set()
        largest_files = []
        file_order = 0
        category_labels = dict(STORAGE_CATEGORIES)

        for root_kind, configured_root in roots:
            if not configured_root or not os.path.isdir(configured_root):
                continue
            root_path = os.path.abspath(configured_root)
            for current_root, dirnames, filenames in os.walk(root_path, followlinks=False):
                dirnames[:] = [
                    dirname
                    for dirname in dirnames
                    if not os.path.islink(os.path.join(current_root, dirname))
                ]
                for filename in filenames:
                    absolute_path = os.path.abspath(os.path.join(current_root, filename))
                    normalized_path = os.path.normcase(absolute_path)
                    if normalized_path in seen_paths or os.path.islink(absolute_path):
                        continue
                    try:
                        file_size = max(0, int(os.path.getsize(absolute_path)))
                    except OSError:
                        continue
                    seen_paths.add(normalized_path)
                    relative_path = os.path.relpath(absolute_path, root_path)
                    category = storage_category(root_kind, relative_path)
                    totals[category]["bytes"] += file_size
                    totals[category]["fileCount"] += 1
                    try:
                        modified_at = datetime.fromtimestamp(
                            os.path.getmtime(absolute_path)
                        ).astimezone().isoformat(timespec="seconds")
                    except OSError:
                        modified_at = None
                    safe_relative_path = relative_path.replace("\\", "/")
                    file_record = {
                        "name": os.path.basename(absolute_path),
                        "relativePath": f"{root_kind}/{safe_relative_path}",
                        "area": root_kind,
                        "category": category,
                        "categoryLabel": category_labels.get(category, "Other"),
                        "bytes": file_size,
                        "modifiedAt": modified_at,
                    }
                    insort(
                        largest_files,
                        (
                            (
                                -file_size,
                                file_record["relativePath"].lower(),
                                file_order,
                            ),
                            file_record,
                        ),
                    )
                    file_order += 1
                    if len(largest_files) > 20:
                        largest_files.pop()

        self._add_database_usage(totals, database_url, code)
        breakdown = list(totals.values())
        total_bytes = sum(item["bytes"] for item in breakdown)
        for item in breakdown:
            item["percent"] = round(item["bytes"] / total_bytes * 100, 1) if total_bytes else 0
        breakdown.sort(key=lambda item: (-item["bytes"], item["label"]))

        result = {
            "companyCode": code,
            "totalBytes": total_bytes,
            "fileCount": sum(item["fileCount"] for item in breakdown),
            "recordCount": sum(item["recordCount"] for item in breakdown),
            "breakdown": breakdown,
            "largestFiles": [item for _sort_key, item in largest_files],
            "calculatedAt": datetime.now().isoformat(timespec="seconds"),
        }
        with self._lock:
            self._cache[code] = {"cachedAt": now, "data": result}
        return result

    def _add_database_usage(self, totals: dict, database_url: str, code: str) -> None:
        if not database_url:
            return
        try:
            from postgres_data_manager import company_storage_breakdown

            for category, usage in company_storage_breakdown(database_url, code).items():
                target = category if category in totals else "other"
                totals[target]["bytes"] += max(0, int(usage.get("bytes") or 0))
                totals[target]["recordCount"] += max(
                    0, int(usage.get("recordCount") or 0)
                )
        except Exception as error:
            if self.logger:
                self.logger.warning(
                    "Unable to calculate PostgreSQL storage for company %s: %s",
                    code,
                    error,
                )
