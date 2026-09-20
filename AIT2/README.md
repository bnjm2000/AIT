# Showbase

Flask application for company inventory, event preparation and returns, quotations,
invoicing, workforce, and accounting. The browser uses ordered classic JavaScript
scripts; there is no frontend build step.

Start with the [architecture and feature map](docs/ARCHITECTURE.md). Operational
details live in [storage](docs/STORAGE.md), [PostgreSQL migration](POSTGRESQL_MIGRATION.md),
and the [role permissions matrix](docs/role_permissions_matrix.md).

## Development

Run commands from this directory. The cleanup checks use Python 3.12 and Node 24.
On Windows, create a virtual environment and install the dependencies:

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt pytest
```

Use a development checkout with its own `.env`, storage, and credentials. The
application reads `.env` automatically; `.env.example` describes production
settings. For local HTTP development, set `APP_ENV=development`,
`EXTERNAL_HTTPS=0`, `TELEGRAM_NOTIFICATIONS_ENABLED=0`, and an absolute
`SHOWBASE_STORAGE_ROOT` pointing to development data. Leave `DATABASE_URL` empty
for CSV storage, or point it to a development PostgreSQL database. Keep any
`COMPANY_REGISTRY_FILE` override within that development storage.

```powershell
.\.venv\Scripts\python.exe -m flask --app app run --host 127.0.0.1 --port 5056
```

`main.py` is the deployment entry point. On Windows it starts the supervisor and
Caddy stack; the Flask command above runs the development server directly.

## Tests

```powershell
.\.venv\Scripts\python.exe -m pytest -q
node --test tests/*.cjs tests/test_catalog_search_queue.js
```

`pytest.ini` limits discovery to `tests/`, excluding temporary dependency trees.
To target a feature, pass its test file to pytest or Node. PostgreSQL integration
tests require `TEST_DATABASE_URL` pointing to a disposable test database with
schema creation permissions; they create and drop an isolated test schema.
Ordinary app tests use temporary managers and do not opt into PostgreSQL.

Some frontend tests assert source text, so a behavior-preserving refactor can
require updating them. Prefer API or JavaScript behavior checks for new coverage;
see the architecture guide for extraction and regression checks.
