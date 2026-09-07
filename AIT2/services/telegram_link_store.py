"""Durable, short-lived Telegram account connection links."""

import copy
import json
import os
import secrets
import threading
import time


_store_lock = threading.RLock()


def _empty_store():
    return {"version": 2, "links": {}}


def _normalise_record(source):
    if not isinstance(source, dict):
        return None
    company_code = str(source.get("companyCode") or "").strip()
    principal_type = str(source.get("principalType") or "user").strip().lower()
    if principal_type not in {"user", "worker"}:
        return None
    principal_id = str(
        source.get("principalId")
        or source.get("workerId")
        or source.get("username")
        or ""
    ).strip()
    try:
        expires_at = float(source.get("expiresAt") or 0)
    except (TypeError, ValueError):
        return None
    if not company_code or not principal_id or expires_at <= 0:
        return None
    record = {
        "companyCode": company_code,
        "principalType": principal_type,
        "principalId": principal_id,
        "expiresAt": expires_at,
    }
    if principal_type == "worker":
        record["workerId"] = principal_id
        targets = []
        for raw_target in source.get("workerTargets") or []:
            if not isinstance(raw_target, dict):
                continue
            target_company = str(raw_target.get("companyCode") or "").strip()
            target_worker = str(raw_target.get("workerId") or "").strip()
            if target_company and target_worker:
                target = {
                    "companyCode": target_company,
                    "workerId": target_worker,
                }
                if target not in targets:
                    targets.append(target)
        record["workerTargets"] = targets or [{
            "companyCode": company_code,
            "workerId": principal_id,
        }]
    else:
        record["username"] = principal_id
    return record


def _load_unlocked(path):
    if not path or not os.path.isfile(path):
        return _empty_store()
    try:
        with open(path, "r", encoding="utf-8") as link_file:
            source = json.load(link_file)
    except (OSError, ValueError, TypeError):
        return _empty_store()
    links = source.get("links") if isinstance(source, dict) else None
    result = _empty_store()
    if not isinstance(links, dict):
        return result
    for token, source_record in links.items():
        clean_token = str(token or "").strip()
        record = _normalise_record(source_record)
        if clean_token and record:
            result["links"][clean_token] = record
    return result


def _save_unlocked(path, store):
    if not path:
        raise ValueError("A Telegram link store path is required")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    temporary_path = f"{path}.{secrets.token_hex(6)}.tmp"
    try:
        with open(temporary_path, "w", encoding="utf-8") as link_file:
            json.dump(store, link_file, ensure_ascii=False, indent=2)
        os.replace(temporary_path, path)
    finally:
        if os.path.exists(temporary_path):
            os.remove(temporary_path)


def _prune(store, now=None):
    cutoff = float(time.time() if now is None else now)
    expired = [
        token
        for token, record in store["links"].items()
        if float(record.get("expiresAt") or 0) <= cutoff
    ]
    for token in expired:
        store["links"].pop(token, None)
    return bool(expired)


def create_telegram_link(
    path,
    company_code,
    principal_id,
    max_age_seconds,
    now=None,
    *,
    principal_type="user",
    worker_targets=None,
):
    """Create a one-time link for an app user or worker identity."""
    created_at = float(time.time() if now is None else now)
    expires_at = created_at + max(1, int(max_age_seconds))
    company_code = str(company_code or "").strip()
    principal_id = str(principal_id or "").strip()
    principal_type = str(principal_type or "user").strip().lower()
    if principal_type not in {"user", "worker"}:
        raise ValueError("Unsupported Telegram connection identity")
    if not company_code or not principal_id:
        raise ValueError("A company and account identity are required")
    token = secrets.token_urlsafe(24)
    with _store_lock:
        store = _load_unlocked(path)
        _prune(store, created_at)
        for existing_token, record in list(store["links"].items()):
            if (
                record.get("companyCode") == company_code
                and record.get("principalType", "user") == principal_type
                and (
                    record.get("principalId")
                    or record.get("workerId")
                    or record.get("username")
                ) == principal_id
            ):
                store["links"].pop(existing_token, None)
        record = {
            "companyCode": company_code,
            "principalType": principal_type,
            "principalId": principal_id,
            "expiresAt": expires_at,
        }
        if principal_type == "worker":
            record["workerId"] = principal_id
            record["workerTargets"] = list(worker_targets or [{
                "companyCode": company_code,
                "workerId": principal_id,
            }])
        else:
            record["username"] = principal_id
        store["links"][token] = record
        _save_unlocked(path, store)
    return token, expires_at


def telegram_link_record(path, token, consume=False, now=None):
    """Read or atomically consume a valid one-time connection link."""
    clean_token = str(token or "").strip()
    if not clean_token:
        return None
    with _store_lock:
        store = _load_unlocked(path)
        changed = _prune(store, now)
        record = store["links"].get(clean_token)
        if record and consume:
            store["links"].pop(clean_token, None)
            changed = True
        if changed:
            _save_unlocked(path, store)
        return copy.deepcopy(record) if record else None


def clear_telegram_links(path):
    """Remove pending links. Intended for cleanup and isolated tests."""
    with _store_lock:
        _save_unlocked(path, _empty_store())
