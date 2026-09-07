"""Durable, narrowly scoped actions initiated from Telegram messages."""

import copy
import json
import os
import secrets
import threading
import time


_store_lock = threading.RLock()


def _empty_store():
    return {"version": 1, "actions": {}}


def _normalise_record(source):
    if not isinstance(source, dict):
        return None
    record = {
        "companyCode": str(source.get("companyCode") or "").strip(),
        "workerId": str(source.get("workerId") or "").strip(),
        "subjectId": str(source.get("subjectId") or "").strip(),
        "submissionId": str(source.get("submissionId") or "").strip(),
        "chatId": str(source.get("chatId") or "").strip(),
        "telegramUserId": str(source.get("telegramUserId") or "").strip(),
    }
    try:
        record["expiresAt"] = float(source.get("expiresAt") or 0)
    except (TypeError, ValueError):
        return None
    if not all(record.get(key) for key in (
        "companyCode", "workerId", "subjectId", "submissionId", "chatId"
    )) or record["expiresAt"] <= 0:
        return None
    return record


def _load_unlocked(path):
    if not path or not os.path.isfile(path):
        return _empty_store()
    try:
        with open(path, "r", encoding="utf-8") as action_file:
            source = json.load(action_file)
    except (OSError, ValueError, TypeError):
        return _empty_store()
    result = _empty_store()
    actions = source.get("actions") if isinstance(source, dict) else None
    if not isinstance(actions, dict):
        return result
    for token, source_record in actions.items():
        clean_token = str(token or "").strip()
        record = _normalise_record(source_record)
        if clean_token and record:
            result["actions"][clean_token] = record
    return result


def _save_unlocked(path, store):
    if not path:
        raise ValueError("A Telegram action store path is required")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    temporary_path = f"{path}.{secrets.token_hex(6)}.tmp"
    try:
        with open(temporary_path, "w", encoding="utf-8") as action_file:
            json.dump(store, action_file, ensure_ascii=False, indent=2)
        os.replace(temporary_path, path)
    finally:
        if os.path.exists(temporary_path):
            os.remove(temporary_path)


def _prune(store, now=None):
    cutoff = float(time.time() if now is None else now)
    expired = [
        token for token, record in store["actions"].items()
        if float(record.get("expiresAt") or 0) <= cutoff
    ]
    for token in expired:
        store["actions"].pop(token, None)
    return bool(expired)


def create_telegram_payment_action(
    path,
    *,
    company_code,
    worker_id,
    subject_id,
    submission_id,
    chat_id,
    telegram_user_id="",
    max_age_seconds,
    now=None,
):
    """Create an opaque Telegram callback bound to one account and submission."""
    created_at = float(time.time() if now is None else now)
    record = _normalise_record({
        "companyCode": company_code,
        "workerId": worker_id,
        "subjectId": subject_id,
        "submissionId": submission_id,
        "chatId": chat_id,
        "telegramUserId": telegram_user_id,
        "expiresAt": created_at + max(1, int(max_age_seconds)),
    })
    if not record:
        raise ValueError("A company, worker, submission and Telegram chat are required")
    token = secrets.token_urlsafe(18)
    with _store_lock:
        store = _load_unlocked(path)
        _prune(store, created_at)
        for existing_token, existing in list(store["actions"].items()):
            if (
                existing.get("companyCode") == record["companyCode"]
                and existing.get("submissionId") == record["submissionId"]
                and existing.get("chatId") == record["chatId"]
            ):
                store["actions"].pop(existing_token, None)
        store["actions"][token] = record
        _save_unlocked(path, store)
    return token, record["expiresAt"]


def telegram_payment_action_record(path, token, consume=False, now=None):
    """Read or atomically consume a valid payment-confirmation action."""
    clean_token = str(token or "").strip()
    if not clean_token:
        return None
    with _store_lock:
        store = _load_unlocked(path)
        changed = _prune(store, now)
        record = store["actions"].get(clean_token)
        if record and consume:
            store["actions"].pop(clean_token, None)
            changed = True
        if changed:
            _save_unlocked(path, store)
        return copy.deepcopy(record) if record else None


def clear_telegram_payment_actions(path):
    """Remove pending actions. Intended for cleanup and isolated tests."""
    with _store_lock:
        _save_unlocked(path, _empty_store())
