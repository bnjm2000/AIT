"""Delivery Order API routes."""

from __future__ import annotations

from flask import jsonify, request

from services.delivery_orders import (
    DeliveryOrderWorkspaceTooLarge,
    normalize_delivery_order_workspace,
)


def register_delivery_order_routes(
    app,
    *,
    data_manager,
    logger,
    mark_realtime_change,
    require_auth,
    require_event_access,
):
    @app.route("/api/events/<int:event_id>/delivery-order", methods=["GET", "PUT", "DELETE"])
    @require_auth
    @require_event_access
    def event_delivery_order(event_id):
        """Read or update the event's independent Delivery Order workspace."""
        try:
            event = data_manager.events.get(event_id)
            if not event:
                return jsonify({"error": "Event not found"}), 404

            if request.method == "GET":
                return jsonify(
                    {
                        "success": True,
                        "data": dict(getattr(event, "delivery_order", {}) or {}),
                    }
                )

            if request.method == "DELETE":
                event.delivery_order = {}
            else:
                try:
                    event.delivery_order = normalize_delivery_order_workspace(
                        request.get_json(silent=True) or {}
                    )
                except TypeError as error:
                    return jsonify({"error": str(error)}), 400
                except DeliveryOrderWorkspaceTooLarge as error:
                    return jsonify({"error": str(error)}), 413

            data_manager.events[event_id] = event
            data_manager.save_event(event)
            mark_realtime_change("delivery-order", {"eventId": event_id})
            return jsonify(
                {
                    "success": True,
                    "data": dict(getattr(event, "delivery_order", {}) or {}),
                }
            )
        except Exception as error:
            logger.error(
                "Error updating delivery order for event %s: %s", event_id, error
            )
            return jsonify({"error": "Failed to update delivery order"}), 500

    return event_delivery_order
