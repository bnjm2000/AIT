"""Persistent Telegram connection links and payment-confirmation tokens.

Both token types share expiry, replacement, atomic writes and consumption.
Their identity validation and existing JSON file formats remain separate.
"""

import json
import os
import secrets
import threading
import time


class _TokenStore:
    def __init__(self, key, version, normalise, *, token_bytes, identity_fields):
        self.key = key
        self.version = version
        self.normalise = normalise
        self.token_bytes = token_bytes
        self.identity_fields = identity_fields
        # Serialises callers within this process; it is not a cross-process lock.
        self.lock = threading.RLock()

    def _load(self, path):
        if not path or not os.path.isfile(path):
            return {}
        try:
            with open(path, encoding="utf-8") as token_file:
                source = json.load(token_file)
        except (OSError, ValueError, TypeError):
            return {}
        rows = source.get(self.key) if isinstance(source, dict) else None
        if not isinstance(rows, dict):
            return {}
        records = {}
        for token, value in rows.items():
            token = str(token or "").strip()
            record = self.normalise(value)
            if token and record:
                records[token] = record
        return records

    def _save(self, path, records):
        if not path:
            raise ValueError(f"A Telegram {self.key[:-1]} store path is required")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        temporary_path = f"{path}.{secrets.token_hex(6)}.tmp"
        try:
            with open(temporary_path, "w", encoding="utf-8") as token_file:
                json.dump({"version": self.version, self.key: records}, token_file,
                          ensure_ascii=False, indent=2)
            os.replace(temporary_path, path)
        finally:
            if os.path.exists(temporary_path):
                os.remove(temporary_path)

    def create(self, path, record, now):
        token = secrets.token_urlsafe(self.token_bytes)
        with self.lock:
            records = {
                key: existing for key, existing in self._load(path).items()
                if not (
                    existing["expiresAt"] <= now
                    or all(existing.get(field) == record[field]
                           for field in self.identity_fields)
                )
            }
            records[token] = record
            self._save(path, records)
        return token, record["expiresAt"]

    def read(self, path, token, consume=False, now=None):
        token = str(token or "").strip()
        if not token:
            return None
        with self.lock:
            records = self._load(path)
            cutoff = float(time.time() if now is None else now)
            active = {key: row for key, row in records.items()
                      if not row["expiresAt"] <= cutoff}
            record = active.pop(token, None) if consume else active.get(token)
            if len(active) != len(records):
                self._save(path, active)
            # Each read loads fresh JSON, so callers own the returned record.
            return record

    def clear(self, path):
        with self.lock:
            self._save(path, {})


def _normalise_link_record(source):
    if not isinstance(source, dict):
        return None
    company_code = str(source.get("companyCode") or "").strip()
    principal_type = str(source.get("principalType") or "user").strip().lower()
    if principal_type not in {"user", "worker"}:
        return None
    principal_id = str(
        source.get("principalId") or source.get("workerId") or source.get("username") or ""
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
                target = {"companyCode": target_company, "workerId": target_worker}
                if target not in targets:
                    targets.append(target)
        record["workerTargets"] = targets or [{
            "companyCode": company_code, "workerId": principal_id,
        }]
    else:
        record["username"] = principal_id
    return record


def _normalise_payment_record(source):
    if not isinstance(source, dict):
        return None
    record = {key: str(source.get(key) or "").strip() for key in (
        "companyCode", "workerId", "subjectId", "submissionId", "chatId", "telegramUserId",
    )}
    try:
        record["expiresAt"] = float(source.get("expiresAt") or 0)
    except (TypeError, ValueError):
        return None
    if not all(record.get(key) for key in (
        "companyCode", "workerId", "subjectId", "submissionId", "chatId",
    )) or record["expiresAt"] <= 0:
        return None
    return record


_links = _TokenStore(
    "links", 2, _normalise_link_record, token_bytes=24,
    identity_fields=("companyCode", "principalType", "principalId"),
)
_payments = _TokenStore(
    "actions", 1, _normalise_payment_record, token_bytes=18,
    identity_fields=("companyCode", "submissionId", "chatId"),
)


def create_telegram_link(path, company_code, principal_id, max_age_seconds, now=None,
                         *, principal_type="user", worker_targets=None):
    """Create a one-time link, replacing pending links for the same identity."""
    created_at = float(time.time() if now is None else now)
    company_code = str(company_code or "").strip()
    principal_id = str(principal_id or "").strip()
    principal_type = str(principal_type or "user").strip().lower()
    if principal_type not in {"user", "worker"}:
        raise ValueError("Unsupported Telegram connection identity")
    if not company_code or not principal_id:
        raise ValueError("A company and account identity are required")
    record = {
        "companyCode": company_code,
        "principalType": principal_type,
        "principalId": principal_id,
        "expiresAt": created_at + max(1, int(max_age_seconds)),
    }
    if principal_type == "worker":
        record["workerId"] = principal_id
        record["workerTargets"] = list(worker_targets or [{
            "companyCode": company_code, "workerId": principal_id,
        }])
    else:
        record["username"] = principal_id
    return _links.create(path, record, created_at)


def create_telegram_payment_action(path, *, company_code, worker_id, subject_id,
                                   submission_id, chat_id, telegram_user_id="",
                                   max_age_seconds, now=None):
    """Create a callback bound to one account, submission and Telegram chat."""
    created_at = float(time.time() if now is None else now)
    record = _normalise_payment_record({
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
    return _payments.create(path, record, created_at)


def telegram_link_record(path, token, consume=False, now=None):
    """Read or consume a connection link under the store's process lock."""
    return _links.read(path, token, consume, now)


def telegram_payment_action_record(path, token, consume=False, now=None):
    """Read or consume a payment action under the store's process lock."""
    return _payments.read(path, token, consume, now)


def clear_telegram_links(path):
    """Remove pending connection links for cleanup and isolated tests."""
    _links.clear(path)
