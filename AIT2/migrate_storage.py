"""Copy legacy Showbase data into the segregated storage layout.

The migration is intentionally non-destructive. It never removes the source
folders, so the old installation remains available until the new layout has
been verified in production.
"""

from __future__ import annotations

import argparse
import filecmp
import json
import os
import shutil
import tempfile
from datetime import datetime, timezone

from storage_paths import LAYOUT_VERSION, company_storage_paths, storage_root


SKIPPED_FILENAMES = {".DS_Store", "Thumbs.db"}
DOCUMENT_DIRECTORIES = {"workforce_uploads"}
MEDIA_DIRECTORIES = {"maintenance_media", "ContainerMedia"}


def _copy_file(source: str, target: str) -> None:
    if os.path.basename(source) in SKIPPED_FILENAMES or source.endswith(".tmp"):
        return
    os.makedirs(os.path.dirname(target), exist_ok=True)
    shutil.copy2(source, target)
    if not filecmp.cmp(source, target, shallow=False):
        raise OSError(f"Copied file failed verification: {source}")


def _copy_tree(source: str, target: str) -> None:
    if not os.path.isdir(source):
        return
    for current_root, dirnames, filenames in os.walk(source):
        dirnames[:] = [name for name in dirnames if name not in SKIPPED_FILENAMES]
        relative = os.path.relpath(current_root, source)
        target_root = target if relative == "." else os.path.join(target, relative)
        for filename in filenames:
            _copy_file(
                os.path.join(current_root, filename),
                os.path.join(target_root, filename),
            )


def _source_path(source_root: str, configured_path: object) -> str:
    value = str(configured_path or "").strip()
    if not value:
        return ""
    return os.path.abspath(value if os.path.isabs(value) else os.path.join(source_root, value))


def _canonical_record(record: dict, code: str) -> dict:
    paths = company_storage_paths(code)
    relative = lambda path: os.path.relpath(path, storage_root()).replace(os.sep, "/")
    updated = dict(record or {})
    updated.update({
        "code": code,
        "backendFolder": relative(paths.data),
        "dataFolder": relative(paths.data),
        "documentsFolder": relative(paths.documents),
        "mediaFolder": relative(paths.media),
        "frontendFolder": relative(paths.branding),
        "brandingFolder": relative(paths.branding),
        "exportsFolder": relative(paths.exports),
    })
    return updated


def _migrate_company(source_root: str, code: str, record: dict) -> dict:
    paths = company_storage_paths(code)
    for folder in (paths.data, paths.documents, paths.media, paths.branding, paths.exports):
        os.makedirs(folder, exist_ok=True)

    backend = _source_path(source_root, record.get("backendFolder"))
    frontend = _source_path(source_root, record.get("frontendFolder"))

    if os.path.isdir(backend):
        for entry in os.scandir(backend):
            if entry.is_file(follow_symlinks=False):
                _copy_file(entry.path, os.path.join(paths.data, entry.name))
                continue
            if not entry.is_dir(follow_symlinks=False):
                continue
            if entry.name == "events":
                for event_entry in os.scandir(entry.path):
                    if event_entry.is_file(follow_symlinks=False):
                        _copy_file(
                            event_entry.path,
                            os.path.join(paths.data, "events", event_entry.name),
                        )
                    elif event_entry.is_dir(follow_symlinks=False):
                        _copy_tree(
                            event_entry.path,
                            os.path.join(paths.documents, "events", event_entry.name),
                        )
            elif entry.name in DOCUMENT_DIRECTORIES:
                _copy_tree(entry.path, os.path.join(paths.documents, entry.name))
            elif entry.name in MEDIA_DIRECTORIES:
                _copy_tree(entry.path, os.path.join(paths.media, entry.name))
            else:
                _copy_tree(entry.path, os.path.join(paths.data, entry.name))

    _copy_tree(frontend, paths.branding)
    return _canonical_record(record, code)


def migrate(source_root: str, target_root: str, *, overwrite: bool = False) -> dict:
    source_root = os.path.abspath(source_root)
    target_root = os.path.abspath(target_root)
    if os.path.normcase(source_root) == os.path.normcase(target_root):
        raise ValueError("Source and target storage roots must be different")
    manifest_path = os.path.join(target_root, "storage-layout.json")
    if os.path.exists(manifest_path) and not overwrite:
        raise FileExistsError(
            "The target already contains migrated storage. Use --force only "
            "after confirming the source is still authoritative."
        )

    source_config = os.path.join(source_root, "app_data")
    registry_path = os.path.join(source_config, "Companies.json")
    if not os.path.isfile(registry_path):
        raise FileNotFoundError(f"Company registry not found: {registry_path}")

    previous_storage_root = os.environ.get("SHOWBASE_STORAGE_ROOT")
    os.environ["SHOWBASE_STORAGE_ROOT"] = target_root
    try:
        return _migrate_with_configured_root(source_root, target_root, source_config, registry_path)
    finally:
        if previous_storage_root is None:
            os.environ.pop("SHOWBASE_STORAGE_ROOT", None)
        else:
            os.environ["SHOWBASE_STORAGE_ROOT"] = previous_storage_root


def _migrate_with_configured_root(
    source_root: str,
    target_root: str,
    source_config: str,
    registry_path: str,
) -> dict:
    with open(registry_path, "r", encoding="utf-8") as handle:
        registry = json.load(handle)
    companies = registry.get("companies") if isinstance(registry, dict) else None
    if not isinstance(companies, dict):
        raise ValueError("Companies.json does not contain a company registry")

    migrated_companies = {}
    for raw_code, record in companies.items():
        code = str(raw_code or "").strip().upper()
        if code and isinstance(record, dict):
            migrated_companies[code] = _migrate_company(source_root, code, record)

    target_config = os.path.join(target_root, "config")
    os.makedirs(target_config, exist_ok=True)
    for filename in os.listdir(source_config):
        source = os.path.join(source_config, filename)
        if os.path.isfile(source) and filename != "Companies.json":
            _copy_file(source, os.path.join(target_config, filename))
    _copy_tree(os.path.join(source_config, "system"), os.path.join(target_root, "system", "data"))
    _copy_tree(os.path.join(source_root, "logs"), os.path.join(target_root, "runtime", "logs"))

    registry["companies"] = migrated_companies
    registry["storageLayoutVersion"] = LAYOUT_VERSION
    registry["storageMigratedAt"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    target_registry = os.path.join(target_config, "Companies.json")
    descriptor, temporary = tempfile.mkstemp(prefix="Companies.", suffix=".tmp", dir=target_config)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(registry, handle, ensure_ascii=False, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, target_registry)
    finally:
        if os.path.exists(temporary):
            os.remove(temporary)

    manifest = {
        "layoutVersion": LAYOUT_VERSION,
        "migratedAt": registry["storageMigratedAt"],
        "sourceRoot": source_root,
        "companyCount": len(migrated_companies),
    }
    with open(os.path.join(target_root, "storage-layout.json"), "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, ensure_ascii=False, indent=2)
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", default=os.path.dirname(os.path.abspath(__file__)))
    parser.add_argument("--target", default=storage_root())
    parser.add_argument(
        "--force",
        action="store_true",
        help="overwrite an existing migrated target after manual verification",
    )
    arguments = parser.parse_args()
    result = migrate(arguments.source, arguments.target, overwrite=arguments.force)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
