"""Authenticated application page routes and their permission policy."""

from __future__ import annotations

from flask import abort, redirect, request


APP_PAGE_SECTIONS = {
    "/dashboard": "dashboard",
    "/events": "events",
    "/plan": "plan",
    "/manpower": "workforce",
    "/transport": "transport",
    "/invoice-claims": "invoice-claims",
    "/my-claims": "my-claims",
    "/prepare": "prepare-new",
    "/return": "return",
    "/transfer": "transfer",
    "/inventory": "inventory",
    "/vehicles": "vehicles",
    "/containers": "containers",
    "/maintenance": "maintenance",
    "/asset-check": "asset-check",
    "/maintenance-report": "maintenance-report",
    "/logs": "logs",
    "/costing": "costing",
    "/quotations": "quotations",
    "/invoices": "invoices",
    "/profit-loss": "profit-loss",
    "/accounting": "accounting",
    "/compare": "compare",
    "/users": "users",
    "/company-details": "pdf-settings",
    "/companies": "companies",
    "/change-password": "change-password",
    "/delivery-order": "delivery-order",
}

APP_ADMIN_PAGE_SECTIONS = {
    "plan",
    "compare",
    "workforce",
    "transport",
    "invoice-claims",
    "vehicles",
    "logs",
    "maintenance-report",
    "users",
    "pdf-settings",
}
APP_OWNER_PAGE_SECTIONS = {"companies", "accounting"}
APP_SALES_PAGE_SECTIONS = {
    "quotations",
    "invoices",
    "costing",
    "profit-loss",
    "accounting",
}


def register_app_page_routes(
    app,
    *,
    data_manager,
    render_page,
    require_auth,
    can_access_event,
    can_view_all_invoice_claims,
    can_view_logs,
    is_admin,
    is_owner,
    has_sales_access,
):
    """Register named workspace and document deep-link routes."""

    @app.route("/")
    @require_auth
    def index():
        return redirect("/events")

    @app.route("/dashboard")
    @app.route("/events")
    @app.route("/plan")
    @app.route("/manpower")
    @app.route("/transport")
    @app.route("/invoice-claims")
    @app.route("/my-claims")
    @app.route("/prepare")
    @app.route("/return")
    @app.route("/transfer")
    @app.route("/inventory")
    @app.route("/vehicles")
    @app.route("/containers")
    @app.route("/maintenance")
    @app.route("/asset-check")
    @app.route("/maintenance-report")
    @app.route("/logs")
    @app.route("/costing")
    @app.route("/quotations")
    @app.route("/invoices")
    @app.route("/profit-loss")
    @app.route("/accounting")
    @app.route("/compare")
    @app.route("/users")
    @app.route("/company-details")
    @app.route("/companies")
    @app.route("/change-password")
    @app.route("/delivery-order")
    @require_auth
    def app_page():
        section = APP_PAGE_SECTIONS.get(request.path)
        if not section:
            abort(404)
        if section == "invoice-claims" and not can_view_all_invoice_claims():
            return fallback_event_redirect()
        if section == "logs" and not can_view_logs():
            return fallback_event_redirect()
        if section in APP_ADMIN_PAGE_SECTIONS and not is_admin():
            return fallback_event_redirect()
        if section == "my-claims" and is_admin():
            return fallback_event_redirect()
        if section in APP_OWNER_PAGE_SECTIONS and not is_owner():
            return fallback_event_redirect()
        if section in APP_SALES_PAGE_SECTIONS and not has_sales_access():
            return fallback_event_redirect()
        return render_page(section)

    @app.route("/quotations/<document_id>")
    @require_auth
    def quotation_detail_page(document_id):
        if not has_sales_access():
            return fallback_event_redirect()
        return render_page("quotations")

    @app.route("/invoices/<quotation_id>")
    @require_auth
    def invoice_plan_detail_page(quotation_id):
        if not has_sales_access():
            return fallback_event_redirect()
        return render_page("invoices")

    @app.route("/costing/<costing_id>")
    @require_auth
    def costing_detail_page(costing_id):
        if not has_sales_access():
            return fallback_event_redirect()
        return render_page("costing")

    def next_accessible_event_id():
        accessible_ids = (
            int(event_id)
            for event_id, event in data_manager.events.items()
            if can_access_event(event)
        )
        return max(accessible_ids, default=None)

    def fallback_event_redirect(path_builder=None):
        event_id = next_accessible_event_id()
        if event_id is None:
            return redirect("/events")
        path = path_builder(event_id) if path_builder else f"/events/{event_id}"
        return redirect(path)

    def event_page(event_id, section, fallback_path_builder=None):
        event = data_manager.events.get(event_id)
        if not event or not can_access_event(event):
            return fallback_event_redirect(fallback_path_builder)
        return render_page(section)

    @app.route("/events/<int:event_id>")
    @require_auth
    def event_overview_page(event_id):
        return event_page(event_id, "events")

    @app.route("/manpower/<int:event_id>")
    @app.route("/manpower/<int:event_id>/<view_mode>")
    @require_auth
    def manpower_detail_page(event_id, view_mode="by-department"):
        if not is_admin():
            return fallback_event_redirect()
        if view_mode not in {"by-department", "by-day"}:
            event = data_manager.events.get(event_id)
            if event and can_access_event(event):
                return redirect(f"/manpower/{event_id}/by-department")
            return fallback_event_redirect(
                lambda available_id: f"/manpower/{available_id}/by-department"
            )
        return event_page(
            event_id,
            "workforce",
            lambda available_id: f"/manpower/{available_id}/{view_mode}",
        )

    @app.route("/delivery-order/<int:event_id>")
    @require_auth
    def delivery_order_detail_page(event_id):
        return event_page(
            event_id,
            "delivery-order",
            lambda available_id: f"/delivery-order/{available_id}",
        )

    @app.route("/packing-list/<int:event_id>")
    @require_auth
    def packing_list_detail_page(event_id):
        return event_page(
            event_id,
            "events",
            lambda available_id: f"/packing-list/{available_id}",
        )
