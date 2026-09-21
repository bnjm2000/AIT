# Application architecture

Showbase is a Flask application with incremental feature extraction. Much of the
backend still lives in `app.py`, and the browser shell in `static/js/app.js`.
These files remain substantial maintenance work; extracted modules below are the
preferred starting points when changing their features. Setup and test commands
are in the [README](../README.md).

## Where behavior lives

| Concern | Backend | Browser |
| --- | --- | --- |
| Startup, authentication, company selection | `app.py`; `main.py` and `server_supervisor.py` for deployment | `app.js`, `templates/index.html` |
| Page URLs and section permissions | `routes/pages.py` (`APP_PAGE_SECTIONS`) | Shell navigation in `app.js` |
| Inventory and maintenance | `app.py`, `models.py`, `maintenance_logs.py` | `app.js`, `inventory-export.js` |
| Asset Check | `routes/asset_check.py`; shared inventory policies supplied by `app.py` | `asset-check.js` |
| Asset template import | `routes/asset_import.py` (file parsing, signed previews, validation, and saves) | `asset-import.js` |
| Transfers between events and Store | `routes/transfers.py`; shared preparation and locking policies supplied by `app.py` | `transfer.js` |
| Events, planning, preparation, returns | `app.py`, `models.py`, `event_concurrency.py` | `events-overview.js`, `plan.js`, `prepare.js`, `return.js`, `packing-list.js` |
| Delivery orders | `routes/delivery_orders.py`, `services/delivery_orders.py` | `delivery-order.js` |
| Quotations, invoices, costing | `app.py`, `finance_concurrency.py`, corresponding `*_pdf.py` files | `finance.js`, `invoices.js`, `costing.js` |
| Client directory | `routes/clients.py`, `services/clients.py` (also used by quotations) | `clients.js`, including the Delivery Order client picker |
| Accounting | `routes/accounting.py`, `services/accounting_*.py` | `accounting*.js` |
| Workforce and claims | `app.py`, `workforce.py`, `workforce_schedule.py` | `workforce-admin.js`, `workforce-schedule.js`, `my-claims.js` |
| Company administration and storage | `app.py`, `storage_paths.py`, `services/company_storage*.py` | `admin-settings.js` |
| Telegram | `services/notification_settings.py`, `services/telegram_tokens.py`, `services/telegram_notifications.py`; HTTP/update wiring in `app.py` | Connection settings in `admin-settings.js` and worker portal templates |

Browser filenames in the table are under `static/js/`. Persistence is shared:
`data_manager.py` owns CSV/filesystem storage, `postgres_data_manager.py` implements
PostgreSQL storage, and `models.py` defines the core record shapes. Uploads remain
on disk in either mode. See [storage](STORAGE.md) before changing paths or formats.

## Following a request

For example, a Delivery Order edit starts in `delivery-order.js`, calls
`/api/events/<event_id>/delivery-order`, reaches the handler registered by
`register_delivery_order_routes`, and uses `services/delivery_orders.py` to
normalise and version the workspace. The handler saves the event through the
current data manager and publishes a realtime change. Its authorization and
version-conflict responses belong to this same flow.

Route registration functions receive dependencies from `app.py`. Keep that
direction: route and service modules should not import mutable application state
back from `app.py`. A service owns domain rules or persistence policy; a route
owns authorization and HTTP input/output. A small single-use operation can stay
with its caller when separating it adds no useful boundary.

## Boundaries to preserve

- **Company context:** `app.data_manager` is a proxy backed by a `ContextVar`.
  `ensure_web_runtime_ready` binds it for a request; teardown releases write
  locks and restores context. Never cache its resolved manager at module import
  or share it across companies. Background jobs must bind their company too.
- **Writes:** preserve domain-specific concurrency checks, atomic file writes,
  and realtime notifications when moving code. Event and finance merge policies
  differ and should remain separate. Telegram token stores share file mechanics
  but retain distinct identity rules and JSON formats; their locks coordinate
  threads within one process.
- **Browser globals:** `templates/index.html` loads classic scripts in dependency
  order. State is shared across scripts, and inline handlers can call globals.
  `line-workspace.js` also constructs handler names from prefixes; a text search
  with no literal caller does not prove a handler is unused.
  `clients.js` loads after `finance.js` and reuses its formatters and document
  cache; quotation-specific client editing remains with quotations.
  `asset-import.js` owns import review state and loads after `app.js`, which
  retains the inventory lookup and positional serial helpers shared with Add Asset.
- **Asset loading:** `_render_app_page` supplies static version values. Update
  it, the template, and `tests/static_source.py` when changing the shell's script
  list. That test helper assembles selected source files, not a runtime bundle.
- **Active workspaces:** Return uses `return-page-root` and `returnPage*`.
  `return.js` owns its state, notes, scanner entry, rendering, and actions;
  the shell retains navigation/realtime integration and shared event display
  helpers. It loads after `plan.js`, which owns shared subproject helpers.
  My Claims styles belong to `my-claims.css`. Extend those owners instead of
  adding another renderer or override stylesheet for the same behavior.

## Making changes reviewable

Keep a feature's state, rendering, and actions together. Extract a complete
workflow when its dependencies are understood; moving arbitrary helpers into a
generic utilities file makes the call chain harder to follow. Share an operation
when its callers really have the same rules, and retain separate functions when
they express distinct domain policies. Do not compress statements just to lower
the line count.

Before deleting a function, inspect Python registrations/decorators, template
handlers, JavaScript globals, generated handler names, and tests. After moving a
feature, run its behavior tests and the regression suite, then exercise the page
and a direct URL refresh if browser wiring changed. Remove the superseded path
in the same change so subsequent fixes have one owner.

App tests should enable `TESTING`, install a temporary manager with
`set_data_manager_for_testing`, and restore it with `clear_test_data_manager`.
Follow `tests/test_company_request_context.py` for isolation and the existing
feature API tests for request fixtures. Source-text tests help detect wiring
changes but do not establish runtime correctness.

## Remaining structural work

1. Extract cohesive backend features from `app.py`, following Delivery Orders
   and accounting. Move validation and persistence together with their routes;
   avoid keeping forwarding wrappers for every removed helper.
2. Isolate remaining inventory state in `app.js` and reduce direct cross-feature
   state access. Return is extracted; its shared subproject rules still live in
   `plan.js` and should be understood before moving them further.
3. Consolidate component styles and replace brittle source-string assertions
   with behavior checks as those components change. Resolve known failing
   event-state, finance, and frontend assertions before making the full suite a
   required green CI gate.

Report production-code reductions separately from added tests and documentation.
File moves alone do not reduce code or prove that a feature is simpler.
