# Application Architecture

The application is being migrated incrementally from two legacy entry-point
files into feature-oriented modules. Existing runtime behavior remains based on
Flask and ordered classic browser scripts, so modules can be extracted without
rewriting the whole application at once.

## Backend

- `app.py` owns application creation, shared configuration, authentication,
  realtime coordination, and legacy routes that have not yet been extracted.
- `routes/` owns HTTP request/response handling. Route modules should receive
  their dependencies through a registration function instead of importing
  mutable application state from `app.py`.
- `services/` owns validation, calculation, persistence coordination, and other
  logic that does not require a Flask request context.
- Existing domain modules such as `workforce.py`, `quotation_pdf.py`, and
  `profit_loss_pdf.py` remain the owners of their established behavior.

New backend work should put business rules in a service or domain module and
keep route handlers limited to authorization, input/output translation, and
calling that logic.

## Frontend

`static/js/app.js` remains the browser shell and compatibility layer. Extracted
feature modules currently include:

- `plan.js`: planning workspace state, rendering, and actions.
- `prepare.js`: preparation workspace state, rendering, and actions.
- `admin-settings.js`: company, user, and settings administration.
- `packing-list.js`: packing-list workspace and export behavior.
- `delivery-order.js`: Delivery Order workspace and export behavior.
- `events-overview.js`: event overview and event list presentation.
- `inventory-export.js`: inventory reporting and export behavior.
- `transfer.js`: asset-transfer workspace and exports.

The scripts are intentionally loaded as classic scripts in dependency order.
Shared shell helpers load first, followed by feature modules, followed by the
already separate finance, costing, workforce, and vehicle modules. Do not copy
shared state into a feature module; pass data explicitly where practical and
leave true cross-feature helpers in the shell until they can be moved into a
small shared module.

## Tests

Source-level frontend tests use `tests/static_source.py` to inspect the assembled
application bundle. Behavioral tests should continue to use Flask's test client
and public API routes rather than reaching into route-registration closures.

When extracting another feature:

1. Move a complete state-and-function boundary rather than splitting a workflow.
2. Preserve script order and add cache-busting version data in `_render_app_page`.
3. Run JavaScript and Python syntax checks, the focused feature tests, and the
   full regression suite.
4. Verify the affected page and a direct URL refresh in a browser.
