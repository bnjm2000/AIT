"""Company-scoped notification destinations and per-user preferences."""

import copy
import json
import os
import secrets
import threading

from models import normalize_user_role


_SETTINGS_DOCUMENT_KEY = "notification_settings"
_SETTINGS_FILENAME = "NotificationSettings.json"
_settings_lock = threading.RLock()


def _default_settings():
    return {"version": 4, "telegramAdmins": {}}


_STANDARD_PREFERENCES = (
    "assignedEventCreated",
    "eventStateChanges",
)
_MANAGER_PREFERENCES = (
    "invoiceUploads",
    "claimUploads",
    "invoiceStatusChanges",
    "claimStatusChanges",
    "assetStatusChanges",
)
_ADMIN_PREFERENCES = (
    "quotationStatusChanges",
    "accessControlChanges",
)


def notification_preferences_for_role(role):
    """Return the preference keys that a company role is allowed to change."""
    clean_role = normalize_user_role(role)
    available = list(_STANDARD_PREFERENCES)
    if clean_role in {"manager", "admin", "owner"}:
        available.extend(_MANAGER_PREFERENCES)
    if clean_role in {"admin", "owner"}:
        available.extend(_ADMIN_PREFERENCES)
    return available


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
        "assignedEventCreated": bool(source.get("assignedEventCreated", False)),
        "eventStateChanges": bool(source.get("eventStateChanges", False)),
        "quotationStatusChanges": bool(source.get("quotationStatusChanges", False)),
        "assetStatusChanges": bool(source.get("assetStatusChanges", False)),
        "accessControlChanges": bool(source.get("accessControlChanges", False)),
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
            "assignedEventCreated": True,
            "eventStateChanges": True,
            "quotationStatusChanges": True,
            "assetStatusChanges": True,
            "accessControlChanges": True,
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
        "assignedEventCreated": profile["assignedEventCreated"],
        "eventStateChanges": profile["eventStateChanges"],
        "quotationStatusChanges": profile["quotationStatusChanges"],
        "assetStatusChanges": profile["assetStatusChanges"],
        "accessControlChanges": profile["accessControlChanges"],
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
            "assignedEventCreated": previous.get("assignedEventCreated", True),
            "eventStateChanges": previous.get("eventStateChanges", True),
            "quotationStatusChanges": previous.get("quotationStatusChanges", True),
            "assetStatusChanges": previous.get("assetStatusChanges", True),
            "accessControlChanges": previous.get("accessControlChanges", True),
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
    assigned_event_created=None,
    event_state_changes=None,
    quotation_status_changes=None,
    asset_status_changes=None,
    access_control_changes=None,
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
        if assigned_event_created is not None:
            profile["assignedEventCreated"] = bool(assigned_event_created)
        if event_state_changes is not None:
            profile["eventStateChanges"] = bool(event_state_changes)
        if quotation_status_changes is not None:
            profile["quotationStatusChanges"] = bool(quotation_status_changes)
        if asset_status_changes is not None:
            profile["assetStatusChanges"] = bool(asset_status_changes)
        if access_control_changes is not None:
            profile["accessControlChanges"] = bool(access_control_changes)
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
    preference = "invoiceUploads" if str(kind).lower() == "invoice" else "claimUploads"
    return _telegram_recipients_for_preference(
        manager,
        preference,
        roles={"owner", "admin", "manager"},
    )


def telegram_recipients_for_status_change(manager, kind):
    """Return active admin destinations subscribed to this document's state."""
    preference = (
        "invoiceStatusChanges"
        if str(kind).lower() == "invoice"
        else "claimStatusChanges"
    )
    return _telegram_recipients_for_preference(
        manager,
        preference,
        roles={"owner", "admin", "manager"},
    )


def _telegram_recipients_for_preference(
    manager,
    preference,
    *,
    roles=None,
    usernames=None,
):
    settings = load_notification_settings(manager)
    allowed_roles = set(roles or {"owner", "admin", "manager", "user"})
    allowed_usernames = (
        {str(value or "").strip().casefold() for value in usernames}
        if usernames is not None
        else None
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
        if role not in allowed_roles:
            continue
        if (
            allowed_usernames is not None
            and str(username or "").strip().casefold() not in allowed_usernames
        ):
            continue
        if not profile.get("enabled") or not profile.get(preference):
            continue
        chat_id = str(profile.get("chatId") or "").strip()
        if chat_id and chat_id not in recipients:
            recipients.append(chat_id)
    return recipients


def telegram_recipients_for_assigned_event(manager, assigned_usernames):
    return _telegram_recipients_for_preference(
        manager,
        "assignedEventCreated",
        usernames=assigned_usernames,
    )


def telegram_recipients_for_event_state_change(manager, assigned_usernames=None):
    """Notify admins globally and other roles only for their assigned events."""
    admin_recipients = _telegram_recipients_for_preference(
        manager,
        "eventStateChanges",
        roles={"owner", "admin"},
    )
    assigned_recipients = _telegram_recipients_for_preference(
        manager,
        "eventStateChanges",
        roles={"manager", "user"},
        usernames=assigned_usernames or (),
    )
    return list(dict.fromkeys(admin_recipients + assigned_recipients))


def telegram_recipients_for_quotation_status_change(manager):
    return _telegram_recipients_for_preference(
        manager,
        "quotationStatusChanges",
        roles={"owner", "admin"},
    )


def telegram_recipients_for_asset_status_change(manager):
    return _telegram_recipients_for_preference(
        manager,
        "assetStatusChanges",
        roles={"owner", "admin", "manager"},
    )


def telegram_recipients_for_access_control_change(manager):
    return _telegram_recipients_for_preference(
        manager,
        "accessControlChanges",
        roles={"owner", "admin"},
    )
