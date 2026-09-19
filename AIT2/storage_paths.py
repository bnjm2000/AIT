"""Canonical filesystem layout for mutable Showbase data.

Application code is deployable and replaceable. Company data, uploaded documents,
and media are durable and therefore live under a configurable storage root.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass


CODE_ROOT = os.path.dirname(os.path.abspath(__file__))
DEFAULT_STORAGE_ROOT = os.path.abspath(
    os.path.join(os.path.dirname(CODE_ROOT), "showbase-storage")
)
LAYOUT_VERSION = 1


def storage_root() -> str:
    configured = os.path.expandvars(
        os.path.expanduser(os.environ.get("SHOWBASE_STORAGE_ROOT", "").strip())
    )
    return os.path.abspath(configured or DEFAULT_STORAGE_ROOT)


def normalise_company_code(value: object, fallback: str = "") -> str:
    code = re.sub(r"[^A-Z0-9_-]+", "", str(value or "").strip().upper())
    return code or fallback


def companies_root() -> str:
    return os.path.join(storage_root(), "companies")


@dataclass(frozen=True)
class CompanyStoragePaths:
    code: str
    root: str
    data: str
    documents: str
    media: str
    branding: str
    exports: str


def company_storage_paths(company_code: object) -> CompanyStoragePaths:
    code = normalise_company_code(company_code)
    if not code:
        raise ValueError("Company code is required")
    root = os.path.join(companies_root(), code)
    return CompanyStoragePaths(
        code=code,
        root=root,
        data=os.path.join(root, "data"),
        documents=os.path.join(root, "documents"),
        media=os.path.join(root, "media"),
        branding=os.path.join(root, "branding"),
        exports=os.path.join(root, "exports"),
    )


def _is_within(candidate: str, root: str) -> bool:
    try:
        return os.path.commonpath(
            [os.path.abspath(candidate), os.path.abspath(root)]
        ) == os.path.abspath(root)
    except ValueError:
        return False


def company_area_for_data_folder(data_folder: str, area: str) -> str:
    """Resolve a sibling company area for canonical data folders.

    Temporary and legacy managers retain their historical all-in-one folder,
    which keeps tests and pre-migration installs backward compatible.
    """
    data_folder = os.path.abspath(str(data_folder or ""))
    if (
        data_folder
        and os.path.basename(data_folder).lower() == "data"
        and _is_within(data_folder, companies_root())
    ):
        company_root = os.path.dirname(data_folder)
        return os.path.join(company_root, area)
    return data_folder


def documents_root_for_data_folder(data_folder: str) -> str:
    return company_area_for_data_folder(data_folder, "documents")
