"""Delivery Order workspace validation."""

from __future__ import annotations

import json
from datetime import datetime, timezone


MAX_DELIVERY_ORDER_WORKSPACE_BYTES = 1_000_000


class DeliveryOrderWorkspaceTooLarge(ValueError):
    """Raised when a Delivery Order workspace exceeds its storage limit."""


def delivery_order_workspace_version(payload) -> int:
    try:
        return max(0, int((payload or {}).get("documentVersion") or 0))
    except (TypeError, ValueError):
        return 0


def normalize_delivery_order_workspace(payload, max_bytes=None) -> dict:
    if not isinstance(payload, dict):
        raise TypeError("Delivery Order workspace must be an object")
    encoded = json.dumps(payload, ensure_ascii=False)
    byte_limit = max_bytes or MAX_DELIVERY_ORDER_WORKSPACE_BYTES
    if len(encoded.encode("utf-8")) > byte_limit:
        raise DeliveryOrderWorkspaceTooLarge("Delivery Order workspace is too large")
    return json.loads(encoded)


def version_delivery_order_workspace(payload, current_version: int) -> dict:
    workspace = normalize_delivery_order_workspace(payload)
    workspace.pop("expectedVersion", None)
    workspace["documentVersion"] = max(0, int(current_version)) + 1
    workspace["updatedAt"] = datetime.now(timezone.utc).isoformat(timespec="milliseconds")
    return normalize_delivery_order_workspace(workspace)
