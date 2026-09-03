"""Company-scoped notification destinations and admin preferences."""

import copy
import json
import os
import secrets
import threading

from models import normalize_user_role, user_role_is_adminish


_SETTINGS_DOCUMENT_KEY = "notification_settings"
_SETTINGS_FILENAME = "NotificationSettings.json"
_settings_lock = threading.RLock()


def _default_settings():
    return {"version": 2, "telegramAdmins": {}}


def _normalise_profile(source):
    if not isinstance(source, dict):
        return None
    chat_id = str(source.get("chatId") or "").strip()
    if not chat_id:
        return None
    return {
        "chatId": chat_id,
        "telegramUserId": str(source.get("telegramUserId") or "").strip(),
        "telegramUsername": str(source.get("telegramUsername") or "").strip()[:64],
        "displayName": str(source.get("displayName") or "Telegram account").strip()[:160],
        "linkedAt": str(source.get("linkedAt") or "").strip(),
        "enabled": source.get("enabled") is not False,
        "invoiceUploads": source.get("invoiceUploads") is not False,
        "claimUploads": source.get("claimUploads") is not False,
        # New alert categories are opt-in for profiles created before they existed.
        "invoiceStatusChanges": bool(source.get("invoiceStatusChanges", False)),
        "claimStatusChanges": bool(source.get("claimStatusChanges", False)),
    }


def _normalise_settings(source):
    result = _default_settings()
    if not isinstance(source, dict):
        return result
    profiles = source.get("telegramAdmins")
    if not isinstance(profiles, dict):
        return result
    for username, raw_profile in profiles.items():
        clean_username = str(username or "").strip()
        profile = _normalise_profile(raw_profile)
        if clean_username and profile:
            result["telegramAdmins"][clean_username] = profile
    return result


def _settings_path(manager):
    data_folder = str(getattr(manager, "data_folder", "") or "").strip()
    return os.path.join(data_folder, _SETTINGS_FILENAME) if data_folder else ""


def _load_unlocked(manager):
    if manager is None:
        return _default_settings()
    if hasattr(manager, "load_company_document"):
        return _normalise_settings(
            manager.load_company_document(_SETTINGS_DOCUMENT_KEY, None)
        )

    path = _settings_path(manager)
    if not path or not os.path.isfile(path):
        return _default_settings()
    try:
        with open(path, "r", encoding="utf-8") as settings_file:
            return _normalise_settings(json.load(settings_file))
    except (OSError, ValueError, TypeError):
        return _default_settings()


def load_notification_settings(manager):
    with _settings_lock:
        return copy.deepcopy(_load_unlocked(manager))


def _save_unlocked(manager, settings):
    normalised = _normalise_settings(settings)
    if hasattr(manager, "save_company_document"):
        manager.save_company_document(_SETTINGS_DOCUMENT_KEY, normalised)
        return normalised

    path = _settings_path(manager)
    if not path:
        raise ValueError("Notification settings require a company data folder")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    temporary_path = f"{path}.{secrets.token_hex(6)}.tmp"
    try:
        with open(temporary_path, "w", encoding="utf-8") as settings_file:
            json.dump(normalised, settings_file, ensure_ascii=False, indent=2)
        os.replace(temporary_path, path)
    finally:
        if os.path.exists(temporary_path):
            os.remove(temporary_path)
    return normalised


def public_admin_telegram_profile(manager, username):
    settings = load_notification_settings(manager)
    profile = settings["telegramAdmins"].get(str(username or "").strip())
    if not profile:
        return {
            "connected": False,
            "enabled": True,
            "invoiceUploads": True,
            "claimUploads": True,
            "invoiceStatusChanges": True,
            "claimStatusChanges": True,
        }
    return {
        "connected": True,
        "displayName": profile["displayName"],
        "telegramUsername": profile["telegramUsername"],
        "linkedAt": profile["linkedAt"],
        "enabled": profile["enabled"],
        "invoiceUploads": profile["invoiceUploads"],
        "claimUploads": profile["claimUploads"],
        "invoiceStatusChanges": profile["invoiceStatusChanges"],
        "claimStatusChanges": profile["claimStatusChanges"],
    }


def connect_admin_telegram(
    manager,
    username,
    *,
    chat_id,
    telegram_user_id="",
    telegram_username="",
    display_name="",
    linked_at="",
):
    username = str(username or "").strip()
    if not username:
        raise ValueError("An admin username is required")
    with _settings_lock:
        settings = _load_unlocked(manager)
        clean_chat_id = str(chat_id or "").strip()
        if not clean_chat_id:
            raise ValueError("A Telegram chat ID is required")
        for other_username, other_profile in list(
            settings["telegramAdmins"].items()
        ):
            if (
                other_username != username
                and str(other_profile.get("chatId") or "").strip() == clean_chat_id
            ):
                settings["telegramAdmins"].pop(other_username, None)
        previous = settings["telegramAdmins"].get(username, {})
        settings["telegramAdmins"][username] = _normalise_profile({
            "chatId": clean_chat_id,
            "telegramUserId": telegram_user_id,
            "telegramUsername": telegram_username,
            "displayName": display_name,
            "linkedAt": linked_at,
            "enabled": previous.get("enabled", True),
            "invoiceUploads": previous.get("invoiceUploads", True),
            "claimUploads": previous.get("claimUploads", True),
            "invoiceStatusChanges": previous.get("invoiceStatusChanges", True),
            "claimStatusChanges": previous.get("claimStatusChanges", True),
        })
        saved = _save_unlocked(manager, settings)
        return copy.deepcopy(saved["telegramAdmins"][username])


def update_admin_telegram_preferences(
    manager,
    username,
    *,
    enabled=None,
    invoice_uploads=None,
    claim_uploads=None,
    invoice_status_changes=None,
    claim_status_changes=None,
):
    username = str(username or "").strip()
    with _settings_lock:
        settings = _load_unlocked(manager)
        profile = settings["telegramAdmins"].get(username)
        if not profile:
            raise KeyError("Telegram account is not connected")
        if enabled is not None:
            profile["enabled"] = bool(enabled)
        if invoice_uploads is not None:
            profile["invoiceUploads"] = bool(invoice_uploads)
        if claim_uploads is not None:
            profile["claimUploads"] = bool(claim_uploads)
        if invoice_status_changes is not None:
            profile["invoiceStatusChanges"] = bool(invoice_status_changes)
        if claim_status_changes is not None:
            profile["claimStatusChanges"] = bool(claim_status_changes)
        _save_unlocked(manager, settings)
        return public_admin_telegram_profile(manager, username)


def disconnect_admin_telegram(manager, username):
    username = str(username or "").strip()
    with _settings_lock:
        settings = _load_unlocked(manager)
        removed = settings["telegramAdmins"].pop(username, None) is not None
        if removed:
            _save_unlocked(manager, settings)
        return removed


def rename_admin_telegram(manager, old_username, new_username):
    """Keep a personal connection attached when an admin username changes."""
    old_username = str(old_username or "").strip()
    new_username = str(new_username or "").strip()
    if not old_username or not new_username or old_username == new_username:
        return False
    with _settings_lock:
        settings = _load_unlocked(manager)
        profile = settings["telegramAdmins"].pop(old_username, None)
        if not profile:
            return False
        settings["telegramAdmins"][new_username] = profile
        _save_unlocked(manager, settings)
        return True


def admin_telegram_chat_id(manager, username):
    settings = load_notification_settings(manager)
    profile = settings["telegramAdmins"].get(str(username or "").strip())
    return str((profile or {}).get("chatId") or "").strip()


def telegram_recipients_for_upload(manager, kind):
    """Return destinations belonging to active admins in this company only."""
    settings = load_notification_settings(manager)
    preference = "invoiceUploads" if str(kind).lower() == "invoice" else "claimUploads"
    recipients = []
    for username, profile in settings["telegramAdmins"].items():
        user = (getattr(manager, "users", {}) or {}).get(username)
        if not user or not getattr(user, "is_active", True):
            continue
        role = normalize_user_role(
            getattr(user, "role", None),
            getattr(user, "is_admin", False),
        )
        if not user_role_is_adminish(role):
            continue
        if not profile.get("enabled") or not profile.get(preference):
            continue
        chat_id = str(profile.get("chatId") or "").strip()
        if chat_id and chat_id not in recipients:
            recipients.append(chat_id)
    return recipients


def telegram_recipients_for_status_change(manager, kind):
    """Return active admin destinations subscribed to this document's state."""
    settings = load_notification_settings(manager)
    preference = (
        "invoiceStatusChanges"
        if str(kind).lower() == "invoice"
        else "claimStatusChanges"
    )
    recipients = []
    for username, profile in settings["telegramAdmins"].items():
        user = (getattr(manager, "users", {}) or {}).get(username)
        if not user or not getattr(user, "is_active", True):
            continue
        role = normalize_user_role(
            getattr(user, "role", None),
            getattr(user, "is_admin", False),
        )
        if not user_role_is_adminish(role):
            continue
        if not profile.get("enabled") or not profile.get(preference):
            continue
        chat_id = str(profile.get("chatId") or "").strip()
        if chat_id and chat_id not in recipients:
            recipients.append(chat_id)
    return recipients
