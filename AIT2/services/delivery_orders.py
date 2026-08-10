"""Delivery Order workspace validation."""

from __future__ import annotations

import json


MAX_DELIVERY_ORDER_WORKSPACE_BYTES = 1_000_000


class DeliveryOrderWorkspaceTooLarge(ValueError):
    """Raised when a Delivery Order workspace exceeds its storage limit."""


def normalize_delivery_order_workspace(payload, max_bytes=None) -> dict:
    if not isinstance(payload, dict):
        raise TypeError("Delivery Order workspace must be an object")
    encoded = json.dumps(payload, ensure_ascii=False)
    byte_limit = max_bytes or MAX_DELIVERY_ORDER_WORKSPACE_BYTES
    if len(encoded.encode("utf-8")) > byte_limit:
        raise DeliveryOrderWorkspaceTooLarge("Delivery Order workspace is too large")
    return json.loads(encoded)
