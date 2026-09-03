"""Best-effort Telegram notifications for workforce documents."""

import json
import logging
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from urllib.request import Request, urlopen


logger = logging.getLogger(__name__)

_notification_executor = ThreadPoolExecutor(
    max_workers=1,
    thread_name_prefix="telegram-notifications",
)
_ENABLED_VALUES = {"1", "true", "yes", "on"}
_bot_username = ""
_bot_username_lock = threading.RLock()
_update_poller_thread = None
_update_poller_lock = threading.RLock()


def _configuration():
    enabled = (
        str(os.environ.get("TELEGRAM_NOTIFICATIONS_ENABLED", ""))
        .strip()
        .lower()
        in _ENABLED_VALUES
    )
    token = str(os.environ.get("TELEGRAM_BOT_TOKEN", "")).strip()
    chat_id = str(os.environ.get("TELEGRAM_CHAT_ID", "")).strip()
    return enabled, token, chat_id


def telegram_notifications_configured():
    """Return whether the shared Telegram provider is enabled and authenticated."""
    enabled, token, _chat_id = _configuration()
    return bool(enabled and token)


def _request_timeout_seconds():
    try:
        configured = float(os.environ.get("TELEGRAM_REQUEST_TIMEOUT_SECONDS", "5"))
    except (TypeError, ValueError):
        configured = 5.0
    return min(30.0, max(1.0, configured))


def _bot_api_request(method, payload=None, timeout_seconds=None):
    enabled, token, _chat_id = _configuration()
    if not (enabled and token):
        return None
    encoded_payload = json.dumps(payload or {}).encode("utf-8")
    telegram_request = Request(
        f"https://api.telegram.org/bot{token}/{method}",
        data=encoded_payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urlopen(
            telegram_request,
            timeout=(
                _request_timeout_seconds()
                if timeout_seconds is None
                else max(1.0, float(timeout_seconds))
            ),
        ) as response:
            result = json.loads(response.read().decode("utf-8"))
        if not result.get("ok"):
            logger.warning(
                "Telegram rejected %s: %s",
                method,
                str(result.get("description") or "unknown error"),
            )
            return None
        return result.get("result")
    except Exception as exc:
        logger.warning("Telegram %s request failed: %s", method, exc)
        return None


def telegram_bot_username():
    """Return the configured bot username, fetching and caching it when needed."""
    global _bot_username
    configured = str(os.environ.get("TELEGRAM_BOT_USERNAME", "")).strip().lstrip("@")
    if configured:
        return configured
    with _bot_username_lock:
        if _bot_username:
            return _bot_username
        result = _bot_api_request("getMe")
        if isinstance(result, dict):
            _bot_username = str(result.get("username") or "").strip().lstrip("@")
        return _bot_username


def configure_telegram_webhook(webhook_url, secret_token):
    """Point the shared bot at this app's secured Telegram update endpoint."""
    result = _bot_api_request("setWebhook", {
        "url": str(webhook_url or "").strip(),
        "secret_token": str(secret_token or "").strip(),
        "allowed_updates": ["message"],
        "drop_pending_updates": False,
    })
    return result is True


def _telegram_update_poll_loop(update_handler):
    """Receive bot updates without requiring a public inbound webhook port."""
    webhook_cleared = False
    offset = None
    while True:
        if not telegram_notifications_configured():
            time.sleep(10)
            continue
        if not webhook_cleared:
            webhook_cleared = _bot_api_request(
                "deleteWebhook",
                {"drop_pending_updates": False},
            ) is True
            if not webhook_cleared:
                time.sleep(5)
                continue

        payload = {"timeout": 20, "allowed_updates": ["message"]}
        if offset is not None:
            payload["offset"] = offset
        updates = _bot_api_request(
            "getUpdates",
            payload,
            timeout_seconds=25,
        )
        if not isinstance(updates, list):
            time.sleep(3)
            continue
        for update in updates:
            if not isinstance(update, dict):
                continue
            try:
                update_handler(update)
            except Exception:
                logger.exception("Telegram update handler failed")
            try:
                offset = max(int(update.get("update_id")) + 1, offset or 0)
            except (TypeError, ValueError):
                continue


def start_telegram_update_poller(update_handler):
    """Start the single daemon responsible for self-service connection links."""
    global _update_poller_thread
    if not telegram_notifications_configured():
        return False
    with _update_poller_lock:
        if _update_poller_thread and _update_poller_thread.is_alive():
            return True
        _update_poller_thread = threading.Thread(
            target=_telegram_update_poll_loop,
            args=(update_handler,),
            name="telegram-update-poller",
            daemon=True,
        )
        _update_poller_thread.start()
        return True


def send_telegram_message(message, chat_id=None):
    """Send one message without allowing Telegram failures to reach the caller."""
    enabled, _token, default_chat_id = _configuration()
    destination = str(chat_id if chat_id is not None else default_chat_id).strip()
    if not (enabled and destination):
        return False
    result = _bot_api_request("sendMessage", {
        "chat_id": destination,
        "text": str(message or "")[:4000],
        "disable_notification": False,
    })
    return result is not None


def queue_telegram_message(message, chat_id):
    """Queue one arbitrary bot message to an explicit destination."""
    if not telegram_notifications_configured() or not str(chat_id or "").strip():
        return False
    try:
        _notification_executor.submit(send_telegram_message, message, str(chat_id))
        return True
    except RuntimeError as exc:
        logger.warning("Could not queue Telegram message: %s", exc)
        return False


def build_upload_notification(
    *, worker_name, event_id, event_name, kind, file_count
):
    """Build a plain-text upload alert without including document contents."""
    normalized_kind = "invoice" if str(kind).lower() == "invoice" else "claim"
    try:
        normalized_count = max(1, int(file_count))
    except (TypeError, ValueError):
        normalized_count = 1
    icon = "📄" if normalized_kind == "invoice" else "🧾"
    event_label = str(event_name or f"Event {event_id}").strip()
    worker_label = str(worker_name or "Unknown worker").strip()
    return (
        f"{icon} New {normalized_kind} uploaded\n\n"
        f"Worker: {worker_label}\n"
        f"Event: {event_label} (#{event_id})\n"
        f"Files: {normalized_count}\n"
        "Status: Pending review"
    )


def queue_upload_notification(
    *, worker_name, event_id, event_name, kind, file_count, chat_ids=None
):
    """Queue an upload alert and return immediately."""
    if not telegram_notifications_configured():
        return False
    message = build_upload_notification(
        worker_name=worker_name,
        event_id=event_id,
        event_name=event_name,
        kind=kind,
        file_count=file_count,
    )
    if chat_ids is None:
        _enabled, _token, default_chat_id = _configuration()
        destinations = [default_chat_id] if default_chat_id else []
    else:
        destinations = []
        for chat_id in chat_ids:
            clean_chat_id = str(chat_id or "").strip()
            if clean_chat_id and clean_chat_id not in destinations:
                destinations.append(clean_chat_id)
    queued = 0
    for chat_id in destinations:
        if queue_telegram_message(message, chat_id):
            queued += 1
    return queued


def build_status_change_notification(
    *, worker_name, event_id, event_name, kind, previous_status, new_status,
    changed_by=""
):
    """Build a business-state alert without including document contents."""
    normalized_kind = "invoice" if str(kind).lower() == "invoice" else "claim"
    icon = "📄" if normalized_kind == "invoice" else "🧾"
    event_label = str(event_name or f"Event {event_id}").strip()
    worker_label = str(worker_name or "Unknown worker").strip()
    previous_label = str(previous_status or "Pending Review").strip()
    new_label = str(new_status or "Pending Review").strip()
    actor_label = str(changed_by or "").strip()
    actor_line = f"\nUpdated by: {actor_label}" if actor_label else ""
    return (
        f"{icon} {normalized_kind.title()} status changed\n\n"
        f"Worker: {worker_label}\n"
        f"Event: {event_label} (#{event_id})\n"
        f"Previous: {previous_label}\n"
        f"New: {new_label}"
        f"{actor_line}"
    )


def queue_status_change_notification(
    *, worker_name, event_id, event_name, kind, previous_status, new_status,
    changed_by="", chat_ids=None
):
    """Queue one status-change alert per subscribed destination."""
    if not telegram_notifications_configured():
        return False
    message = build_status_change_notification(
        worker_name=worker_name,
        event_id=event_id,
        event_name=event_name,
        kind=kind,
        previous_status=previous_status,
        new_status=new_status,
        changed_by=changed_by,
    )
    if chat_ids is None:
        _enabled, _token, default_chat_id = _configuration()
        destinations = [default_chat_id] if default_chat_id else []
    else:
        destinations = []
        for chat_id in chat_ids:
            clean_chat_id = str(chat_id or "").strip()
            if clean_chat_id and clean_chat_id not in destinations:
                destinations.append(clean_chat_id)
    queued = 0
    for chat_id in destinations:
        if queue_telegram_message(message, chat_id):
            queued += 1
    return queued


def build_event_state_notification(
    *, event_id, event_name, previous_state, new_state, changed_by=""
):
    event_label = str(event_name or f"Event {event_id}").strip()
    actor_label = str(changed_by or "").strip()
    actor_line = f"\nUpdated by: {actor_label}" if actor_label else ""
    return (
        "📅 Event state changed\n\n"
        f"Event: {event_label} (#{event_id})\n"
        f"Previous: {str(previous_state or 'New').strip()}\n"
        f"New: {str(new_state or 'New').strip()}"
        f"{actor_line}"
    )


def build_assigned_event_notification(*, event_id, event_name, event_date=""):
    event_label = str(event_name or f"Event {event_id}").strip()
    date_label = str(event_date or "").strip()
    date_line = f"\nDate: {date_label}" if date_label else ""
    return (
        "📅 New event assigned to you\n\n"
        f"Event: {event_label} (#{event_id})"
        f"{date_line}"
    )


def build_asset_status_notification(
    *, asset_id, asset_name, previous_status, new_status, changed_by=""
):
    asset_label = str(asset_name or f"Asset {asset_id}").strip()
    actor_label = str(changed_by or "").strip()
    actor_line = f"\nUpdated by: {actor_label}" if actor_label else ""
    return (
        "🧰 Asset status changed\n\n"
        f"Asset: {asset_label} (#{asset_id})\n"
        f"Previous: {str(previous_status or 'Unknown').strip()}\n"
        f"New: {str(new_status or 'Unknown').strip()}"
        f"{actor_line}"
    )


def build_access_control_notification(*, action, target_user, changed_by="", detail=""):
    actor_label = str(changed_by or "").strip()
    actor_line = f"\nUpdated by: {actor_label}" if actor_label else ""
    detail_label = str(detail or "").strip()
    detail_line = f"\nDetails: {detail_label}" if detail_label else ""
    return (
        "🔐 Access control changed\n\n"
        f"Action: {str(action or 'User account updated').strip()}\n"
        f"User: {str(target_user or 'Unknown user').strip()}"
        f"{detail_line}"
        f"{actor_line}"
    )


def build_quotation_status_notification(
    *, quotation_number, project_name, previous_status, new_status,
    changed_by=""
):
    number_label = str(quotation_number or "Quotation").strip()
    project_label = str(project_name or "").strip()
    project_line = f"\nProject: {project_label}" if project_label else ""
    actor_label = str(changed_by or "").strip()
    actor_line = f"\nUpdated by: {actor_label}" if actor_label else ""
    return (
        "📑 Quotation status changed\n\n"
        f"Quotation: {number_label}"
        f"{project_line}\n"
        f"Previous: {str(previous_status or 'draft').strip().title()}\n"
        f"New: {str(new_status or 'draft').strip().title()}"
        f"{actor_line}"
    )


def _queue_message_for_destinations(message, chat_ids):
    if not telegram_notifications_configured():
        return False
    destinations = []
    for chat_id in chat_ids or []:
        clean_chat_id = str(chat_id or "").strip()
        if clean_chat_id and clean_chat_id not in destinations:
            destinations.append(clean_chat_id)
    queued = 0
    for chat_id in destinations:
        if queue_telegram_message(message, chat_id):
            queued += 1
    return queued


def queue_event_state_notification(
    *, event_id, event_name, previous_state, new_state, changed_by="",
    chat_ids=None
):
    return _queue_message_for_destinations(
        build_event_state_notification(
            event_id=event_id,
            event_name=event_name,
            previous_state=previous_state,
            new_state=new_state,
            changed_by=changed_by,
        ),
        chat_ids,
    )


def queue_assigned_event_notification(
    *, event_id, event_name, event_date="", chat_ids=None
):
    return _queue_message_for_destinations(
        build_assigned_event_notification(
            event_id=event_id,
            event_name=event_name,
            event_date=event_date,
        ),
        chat_ids,
    )


def queue_asset_status_notification(
    *, asset_id, asset_name, previous_status, new_status, changed_by="",
    chat_ids=None
):
    return _queue_message_for_destinations(
        build_asset_status_notification(
            asset_id=asset_id,
            asset_name=asset_name,
            previous_status=previous_status,
            new_status=new_status,
            changed_by=changed_by,
        ),
        chat_ids,
    )


def queue_access_control_notification(
    *, action, target_user, changed_by="", detail="", chat_ids=None
):
    return _queue_message_for_destinations(
        build_access_control_notification(
            action=action,
            target_user=target_user,
            changed_by=changed_by,
            detail=detail,
        ),
        chat_ids,
    )


def queue_quotation_status_notification(
    *, quotation_number, project_name, previous_status, new_status,
    changed_by="", chat_ids=None
):
    return _queue_message_for_destinations(
        build_quotation_status_notification(
            quotation_number=quotation_number,
            project_name=project_name,
            previous_status=previous_status,
            new_status=new_status,
            changed_by=changed_by,
        ),
        chat_ids,
    )
