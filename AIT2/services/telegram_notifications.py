"""Best-effort Telegram notifications for workforce document uploads."""

import json
import logging
import os
from concurrent.futures import ThreadPoolExecutor
from urllib.request import Request, urlopen


logger = logging.getLogger(__name__)

_notification_executor = ThreadPoolExecutor(
    max_workers=1,
    thread_name_prefix="telegram-notifications",
)
_ENABLED_VALUES = {"1", "true", "yes", "on"}


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
    """Return whether all settings required to send a message are present."""
    enabled, token, chat_id = _configuration()
    return bool(enabled and token and chat_id)


def _request_timeout_seconds():
    try:
        configured = float(os.environ.get("TELEGRAM_REQUEST_TIMEOUT_SECONDS", "5"))
    except (TypeError, ValueError):
        configured = 5.0
    return min(30.0, max(1.0, configured))


def send_telegram_message(message):
    """Send one message without allowing Telegram failures to reach the caller."""
    enabled, token, chat_id = _configuration()
    if not (enabled and token and chat_id):
        return False

    payload = json.dumps({
        "chat_id": chat_id,
        "text": str(message or "")[:4000],
        "disable_notification": False,
    }).encode("utf-8")
    telegram_request = Request(
        f"https://api.telegram.org/bot{token}/sendMessage",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with urlopen(
            telegram_request,
            timeout=_request_timeout_seconds(),
        ) as response:
            result = json.loads(response.read().decode("utf-8"))
        if not result.get("ok"):
            logger.warning(
                "Telegram rejected an upload notification: %s",
                str(result.get("description") or "unknown error"),
            )
            return False
        return True
    except Exception as exc:
        # Notifications are deliberately best effort: an external service outage
        # must never fail or delay the worker's upload request.
        logger.warning("Telegram upload notification failed: %s", exc)
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
    *, worker_name, event_id, event_name, kind, file_count
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
    try:
        _notification_executor.submit(send_telegram_message, message)
        return True
    except RuntimeError as exc:
        logger.warning("Could not queue Telegram upload notification: %s", exc)
        return False
