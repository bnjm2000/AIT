"""Flask application for Avec Inventory Management."""

import csv
import json
import logging
import mimetypes
import os
import queue
import re
import secrets
import shutil
import subprocess
import tempfile
import threading
import time
from collections import defaultdict
from contextvars import ContextVar
from datetime import datetime, timedelta
from functools import wraps
from types import SimpleNamespace
from urllib.parse import quote, unquote_plus

from flask import (
    Flask,
    Response,
    g,
    has_request_context,
    jsonify,
    redirect,
    render_template,
    request,
    send_file,
    session,
    stream_with_context,
    url_for,
)
from flask_cors import CORS

from data_manager import ConcurrentDataChangeError, DataManager
from maintenance_logs import (
    ASSET_CHECK_LOG_TYPE,
    DEFAULT_MAINTENANCE_LOG_TYPE,
    USER_MAINTENANCE_LOG_TYPES,
    apply_maintenance_log_changes,
    make_change,
    make_maintenance_log,
    make_maintenance_log_id,
    maintenance_log_to_display_string,
    normalize_maintenance_log,
    normalize_maintenance_log_type,
    parse_maintenance_log_date,
    status_change_labels,
)
from models import (
    Client,
    Container,
    Event,
    InventoryItem,
    LogEntry,
    User,
    format_date_output,
    hash_password,
    normalize_event_state,
)
from utils import sanitize_filename


def _load_local_env_file():
    """Load simple KEY=VALUE lines from .env when python-dotenv is unavailable."""
    env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.env')
    if not os.path.exists(env_path):
        return

    try:
        with open(env_path, 'r', encoding='utf-8') as env_file:
            for raw_line in env_file:
                line = raw_line.strip()
                if not line or line.startswith('#') or '=' not in line:
                    continue
                key, value = line.split('=', 1)
                key = key.strip()
                if not key or key in os.environ:
                    continue
                value = value.strip().strip('"').strip("'")
                os.environ[key] = value
    except OSError:
        # Environment variables still work if the local file cannot be read.
        return


try:
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:
    _load_local_env_file()


# ---------------- Application setup ----------------

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = Flask(__name__)
app.secret_key = os.environ.get('SECRET_KEY', 'AVEC')
CORS(app)

_default_data_manager = None
_request_data_manager = ContextVar('request_data_manager', default=None)
_data_manager_init_lock = threading.RLock()
_data_reload_lock = threading.RLock()
_company_manager_lock = threading.RLock()
_data_snapshot_signature = None  # Compatibility mirror for the default manager.
_data_snapshot_signatures = {}
_background_thread_started = False
_active_company_code = 'AVPL'
_company_data_managers = {}
_company_registry_cache = None

_manager_caches = {}

# Cross-device actions can otherwise race on the same physical asset.
_transfer_action_lock = threading.RLock()
_prepare_action_lock = threading.RLock()
_inventory_action_lock = threading.RLock()
_planning_templates_lock = threading.RLock()

# Server-sent events notify logged-in browsers when shared CSV data changes.
_realtime_subscribers = {}
_realtime_subscribers_lock = threading.RLock()
_realtime_sequence = 0

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
LIVE_COMPANIES_FOLDER = os.path.abspath(os.path.join(BASE_DIR, 'companies'))
DATABASE_URL = os.environ.get('DATABASE_URL', '').strip()
DEFAULT_COMPANY_CODE = 'AVPL'
DEFAULT_COMPANY_NAME = 'AVEC Vision Private Limited'
SUPER_ADMIN_USERNAME = 'bnjm2000'
APP_CONFIG_FOLDER = os.path.join(BASE_DIR, 'app_data')
COMPANY_REGISTRY_FILE = os.environ.get(
    'COMPANY_REGISTRY_FILE',
    os.path.join(APP_CONFIG_FOLDER, 'Companies.json')
)
GLOBAL_USERS_FILE = os.environ.get(
    'GLOBAL_USERS_FILE',
    os.path.join(APP_CONFIG_FOLDER, 'Users.csv')
)


def _current_data_manager_object():
    """Return the manager bound to this request/task, or the default manager."""
    manager = _request_data_manager.get()
    return manager if manager is not None else _default_data_manager


class _DataManagerProxy:
    """Delegate legacy ``data_manager`` access to the current local manager."""

    def __bool__(self):
        return _current_data_manager_object() is not None

    def __getattr__(self, name):
        manager = _current_data_manager_object()
        if manager is None:
            raise AttributeError(f"Data manager is not initialized; cannot access {name!r}")
        return getattr(manager, name)

    def __setattr__(self, name, value):
        manager = _current_data_manager_object()
        if manager is None:
            raise AttributeError(f"Data manager is not initialized; cannot set {name!r}")
        setattr(manager, name, value)

    def __repr__(self):
        return repr(_current_data_manager_object())


data_manager = _DataManagerProxy()


def get_default_data_manager():
    """Return the process default manager used outside request contexts."""
    return _default_data_manager


def _set_default_data_manager(manager, company_code=None):
    global _default_data_manager, _active_company_code
    _default_data_manager = manager
    if company_code:
        _active_company_code = _normalise_company_code(company_code, DEFAULT_COMPANY_CODE)
    return manager


def set_data_manager_for_testing(manager):
    """Install an isolated test manager and prevent requests from selecting live data."""
    if not app.config.get('TESTING'):
        raise RuntimeError('TESTING must be enabled before installing a test data manager')

    _request_data_manager.set(None)
    data_folder = os.path.abspath(getattr(manager, 'data_folder', '') or '')
    live_companies_folder = LIVE_COMPANIES_FOLDER
    if data_folder:
        try:
            if os.path.commonpath([live_companies_folder, data_folder]) == live_companies_folder:
                raise RuntimeError('Tests may not use a manager inside the live companies folder')
        except ValueError:
            pass

    app.config['TEST_DATA_MANAGER'] = manager
    _set_default_data_manager(manager)
    mark_data_snapshot_current(manager)
    return manager


def clear_test_data_manager(restore_manager=None):
    """Remove the test override and optionally restore the previous default manager."""
    _request_data_manager.set(None)
    test_manager = app.config.pop('TEST_DATA_MANAGER', None)
    if test_manager is not None:
        _manager_caches.pop(id(test_manager), None)
        _data_snapshot_signatures.pop(id(test_manager), None)
    _set_default_data_manager(restore_manager)


def _app_tests_allow_postgres():
    """Return whether app-level tests may use the configured PostgreSQL database."""
    return bool(app.config.get('ALLOW_POSTGRES_IN_TESTS'))


def _database_url_for_runtime():
    """Return the PostgreSQL URL for this runtime, excluding normal app tests."""
    if app.config.get('TESTING') and not _app_tests_allow_postgres():
        return ''
    return DATABASE_URL


def _assert_safe_test_company_folder(data_folder):
    """Prevent app tests from accidentally selecting live company folders."""
    if not app.config.get('TESTING') or app.config.get('ALLOW_LIVE_COMPANY_DATA_IN_TESTS'):
        return

    data_folder = os.path.abspath(data_folder or '')
    if not data_folder:
        return

    try:
        if os.path.commonpath([LIVE_COMPANIES_FOLDER, data_folder]) == LIVE_COMPANIES_FOLDER:
            raise RuntimeError(
                'Tests may not use a manager inside the live companies folder. '
                'Install a TEST_DATA_MANAGER or point COMPANY_REGISTRY_FILE at temporary data.'
            )
    except ValueError:
        return


def _workspace_path(*parts):
    return os.path.join(BASE_DIR, *parts)


def _path_from_config(path):
    path = str(path or '').strip()
    if not path:
        return ''
    if os.path.isabs(path):
        return path
    return os.path.join(BASE_DIR, path)


def _path_for_config(path):
    try:
        rel = os.path.relpath(os.path.abspath(path), BASE_DIR)
        if not rel.startswith('..'):
            return rel.replace('\\', '/')
    except ValueError:
        pass
    return os.path.abspath(path)


def _normalise_company_code(value, fallback=''):
    code = str(value or '').strip().upper()
    code = re.sub(r'[^A-Z0-9_-]+', '', code)
    return code or fallback


def _company_base_folder_for_code(code):
    code = _normalise_company_code(code, DEFAULT_COMPANY_CODE)
    return os.path.join('companies', code)


def _new_company_record(code, name, created_by='', requires_branding_setup=False):
    code = _normalise_company_code(code, DEFAULT_COMPANY_CODE)
    base_folder = _company_base_folder_for_code(code)
    return {
        'code': code,
        'name': str(name or code).strip() or code,
        'backendFolder': os.path.join(base_folder, 'backend').replace('\\', '/'),
        'frontendFolder': os.path.join(base_folder, 'frontend').replace('\\', '/'),
        'createdAt': datetime.now().isoformat(timespec='seconds'),
        'createdBy': str(created_by or '').strip(),
        'brandingSetupRequired': bool(requires_branding_setup),
    }


def _company_record_backend_folder(record):
    return _path_from_config((record or {}).get('backendFolder'))


def _company_record_frontend_folder(record):
    return _path_from_config((record or {}).get('frontendFolder'))


def _fallback_company_code(registry):
    companies = (registry or {}).get('companies') or {}
    default_company = _normalise_company_code((registry or {}).get('defaultCompany'))
    if default_company in companies:
        return default_company
    if DEFAULT_COMPANY_CODE in companies:
        return DEFAULT_COMPANY_CODE
    return sorted(companies.keys())[0] if companies else DEFAULT_COMPANY_CODE


def _standard_company_folder_for_code(code):
    return os.path.abspath(_path_from_config(_company_base_folder_for_code(code)))


def _safe_company_delete_folder(code, record):
    code = _normalise_company_code(code)
    company_root = os.path.abspath(os.path.join(BASE_DIR, 'companies'))
    target_folder = _standard_company_folder_for_code(code)

    if not code:
        raise ValueError('Company code is required')

    try:
        if os.path.commonpath([company_root, target_folder]) != company_root:
            raise ValueError('Company folder is outside the companies folder')
    except ValueError:
        raise ValueError('Company folder is outside the companies folder')

    if target_folder == company_root:
        raise ValueError('Refusing to delete the companies folder')

    for folder in (_company_record_backend_folder(record), _company_record_frontend_folder(record)):
        if not folder:
            continue
        folder = os.path.abspath(folder)
        try:
            if os.path.commonpath([target_folder, folder]) != target_folder:
                raise ValueError('Company assets must be inside the standard company folder before deletion')
        except ValueError:
            raise ValueError('Company assets must be inside the standard company folder before deletion')

    return target_folder


def _normalise_company_registry(registry):
    if not isinstance(registry, dict):
        registry = {}

    companies = registry.get('companies') if isinstance(registry.get('companies'), dict) else {}
    user_companies = registry.get('userCompanies') if isinstance(registry.get('userCompanies'), dict) else {}
    raw_super_admins = registry.get('superAdmins')

    default_record = _new_company_record(DEFAULT_COMPANY_CODE, DEFAULT_COMPANY_NAME)
    existing_default = companies.get(DEFAULT_COMPANY_CODE) if isinstance(companies.get(DEFAULT_COMPANY_CODE), dict) else {}
    default_record.update({k: v for k, v in existing_default.items() if v not in (None, '')})
    default_record['code'] = DEFAULT_COMPANY_CODE
    default_record['name'] = default_record.get('name') or DEFAULT_COMPANY_NAME
    if str(default_record.get('backendFolder') or '').replace('\\', '/') == 'AVPL/backend':
        default_record['backendFolder'] = 'companies/AVPL/backend'
    if str(default_record.get('frontendFolder') or '').replace('\\', '/') == 'AVPL/frontend':
        default_record['frontendFolder'] = 'companies/AVPL/frontend'
    default_record['backendFolder'] = default_record.get('backendFolder') or 'companies/AVPL/backend'
    default_record['frontendFolder'] = default_record.get('frontendFolder') or 'companies/AVPL/frontend'
    default_record['brandingSetupRequired'] = bool(default_record.get('brandingSetupRequired', False))

    normalised_companies = {}
    if DEFAULT_COMPANY_CODE in companies or not companies:
        normalised_companies[DEFAULT_COMPANY_CODE] = default_record

    for raw_code, record in companies.items():
        code = _normalise_company_code(raw_code)
        if not code or code == DEFAULT_COMPANY_CODE or not isinstance(record, dict):
            continue
        company = _new_company_record(code, record.get('name') or code)
        company.update({k: v for k, v in record.items() if v not in (None, '')})
        company['code'] = code
        company['backendFolder'] = company.get('backendFolder') or os.path.join('companies', code, 'backend').replace('\\', '/')
        company['frontendFolder'] = company.get('frontendFolder') or os.path.join('companies', code, 'frontend').replace('\\', '/')
        company['brandingSetupRequired'] = bool(company.get('brandingSetupRequired', False))
        normalised_companies[code] = company

    if not normalised_companies:
        normalised_companies[DEFAULT_COMPANY_CODE] = default_record

    normalised_users = {}
    for username, raw_code in user_companies.items():
        username = str(username or '').strip()
        code = _normalise_company_code(raw_code, DEFAULT_COMPANY_CODE)
        if username and code in normalised_companies:
            normalised_users[username] = code

    if isinstance(raw_super_admins, list):
        super_admins = [
            str(username or '').strip()
            for username in raw_super_admins
            if str(username or '').strip()
        ]
    else:
        super_admins = [SUPER_ADMIN_USERNAME]

    if not super_admins:
        super_admins = [SUPER_ADMIN_USERNAME]

    deduped_super_admins = []
    seen_super_admins = set()
    for username in super_admins:
        key = username.lower()
        if key in seen_super_admins:
            continue
        seen_super_admins.add(key)
        deduped_super_admins.append(username)

    default_company = _normalise_company_code(registry.get('defaultCompany'))
    if default_company not in normalised_companies:
        default_company = DEFAULT_COMPANY_CODE if DEFAULT_COMPANY_CODE in normalised_companies else sorted(normalised_companies.keys())[0]

    if normalised_users.get(SUPER_ADMIN_USERNAME) not in normalised_companies:
        normalised_users[SUPER_ADMIN_USERNAME] = default_company

    return {
        'defaultCompany': default_company,
        'companies': normalised_companies,
        'userCompanies': normalised_users,
        'superAdmins': deduped_super_admins,
        'updatedAt': str(registry.get('updatedAt') or '').strip(),
    }


def _load_company_registry():
    global _company_registry_cache
    if _company_registry_cache is not None:
        return _company_registry_cache

    registry = {}
    if os.path.exists(COMPANY_REGISTRY_FILE) and os.path.getsize(COMPANY_REGISTRY_FILE) > 0:
        try:
            with open(COMPANY_REGISTRY_FILE, 'r', encoding='utf-8') as f:
                registry = json.load(f)
        except Exception as e:
            logger.warning("Failed to read Companies.json, rebuilding default registry: %s", e)

    _company_registry_cache = _normalise_company_registry(registry)
    return _company_registry_cache


def _save_company_registry(registry):
    global _company_registry_cache
    registry = _normalise_company_registry(registry)
    registry['updatedAt'] = datetime.now().isoformat(timespec='seconds')
    folder = os.path.dirname(COMPANY_REGISTRY_FILE)
    if folder and not os.path.exists(folder):
        os.makedirs(folder)
    with open(COMPANY_REGISTRY_FILE, 'w', encoding='utf-8') as f:
        json.dump(registry, f, ensure_ascii=False, indent=2)
    _company_registry_cache = registry
    return registry


def _current_company_code():
    if has_request_context():
        code = session.get('company_code')
        if code:
            return _normalise_company_code(code, DEFAULT_COMPANY_CODE)
    return _active_company_code or DEFAULT_COMPANY_CODE


def _company_record_for_code(code=None):
    registry = _load_company_registry()
    code = _normalise_company_code(code or _current_company_code(), registry.get('defaultCompany', DEFAULT_COMPANY_CODE))
    return registry['companies'].get(code) or registry['companies'][_fallback_company_code(registry)]


def _all_company_records():
    return _load_company_registry()['companies']


def _user_assigned_company_code(username):
    registry = _load_company_registry()
    username = str(username or '').strip()
    return registry.get('userCompanies', {}).get(username) or registry.get('defaultCompany', DEFAULT_COMPANY_CODE)


def _assign_user_to_company(username, company_code):
    registry = _load_company_registry()
    username = str(username or '').strip()
    code = _normalise_company_code(company_code, DEFAULT_COMPANY_CODE)
    if not username:
        return registry
    if code not in registry['companies']:
        raise ValueError('Company not found')
    registry['userCompanies'][username] = code
    return _save_company_registry(registry)


def _user_is_assigned_to_current_company(username):
    current_company = _normalise_company_code(_current_company_code(), DEFAULT_COMPANY_CODE)
    user_company = _normalise_company_code(_user_assigned_company_code(username), DEFAULT_COMPANY_CODE)
    return user_company == current_company


def _current_admin_can_manage_user(username):
    if _current_user_is_super_admin():
        return True
    return _user_is_assigned_to_current_company(username)


def _is_super_admin_username(username):
    username = str(username or '').strip()
    if not username:
        return False

    registry = _load_company_registry()
    super_admins = registry.get('superAdmins', [SUPER_ADMIN_USERNAME])
    return username.lower() in {
        str(super_admin or '').strip().lower()
        for super_admin in super_admins
        if str(super_admin or '').strip()
    }


def _current_user_is_super_admin():
    if not has_request_context():
        return False
    if session.get('self_user_changes_pending'):
        return bool(session.get('is_super_admin'))
    return _is_super_admin_username(session.get('user'))


def _set_user_super_admin(username, enabled):
    registry = _load_company_registry()
    username = str(username or '').strip()
    if not username:
        return registry

    existing = [
        str(super_admin or '').strip()
        for super_admin in registry.get('superAdmins', [])
        if str(super_admin or '').strip()
    ]
    existing_lower = {super_admin.lower() for super_admin in existing}

    if enabled:
        if username.lower() not in existing_lower:
            existing.append(username)
    else:
        existing = [super_admin for super_admin in existing if super_admin.lower() != username.lower()]
        if not existing:
            raise ValueError('At least one super admin is required')

    registry['superAdmins'] = existing
    return _save_company_registry(registry)


def _rename_super_admin_reference(old_username, new_username):
    registry = _load_company_registry()
    old_key = str(old_username or '').strip().lower()
    new_username = str(new_username or '').strip()
    if not old_key or not new_username:
        return registry

    changed = False
    updated = []
    for username in registry.get('superAdmins', []):
        if str(username or '').strip().lower() == old_key:
            updated.append(new_username)
            changed = True
        else:
            updated.append(username)

    if changed:
        registry['superAdmins'] = updated
        return _save_company_registry(registry)

    return registry


def _current_user_effective_is_admin():
    if not has_request_context():
        return False
    if session.get('self_user_changes_pending'):
        return bool(session.get('is_admin'))
    user = _current_user_obj()
    return bool(user and getattr(user, 'is_admin', False))


def _current_user_effective_is_active():
    if not has_request_context():
        return False
    if session.get('self_user_changes_pending'):
        return bool(session.get('is_active', True))
    user = _current_user_obj()
    return bool(user and getattr(user, 'is_active', True))


def _ensure_company_folders(record):
    backend_folder = _company_record_backend_folder(record)
    frontend_folder = _company_record_frontend_folder(record)
    if backend_folder and not os.path.exists(backend_folder):
        os.makedirs(backend_folder)
    if frontend_folder and not os.path.exists(frontend_folder):
        os.makedirs(frontend_folder)

    logo_path = os.path.join(frontend_folder, 'logo.png') if frontend_folder else ''
    default_logo_path = os.path.join(BASE_DIR, 'companies', DEFAULT_COMPANY_CODE, 'frontend', 'logo.png')
    legacy_logo_path = os.path.join(app.static_folder or os.path.join(BASE_DIR, 'static'), 'images', 'logo.png')

    if logo_path and not os.path.exists(logo_path):
        source = default_logo_path if os.path.exists(default_logo_path) else legacy_logo_path
        if source and os.path.exists(source):
            try:
                shutil.copy2(source, logo_path)
            except OSError as e:
                logger.warning("Failed to copy default company logo to %s: %s", logo_path, e)


def _ensure_super_admin_users(manager):
    if not manager:
        return
    changed = False
    registry = _load_company_registry()
    for username in registry.get('superAdmins', [SUPER_ADMIN_USERNAME]):
        user = manager.users.get(username)
        if not user:
            continue
        if not getattr(user, 'is_admin', False):
            user.is_admin = True
            changed = True
    if changed:
        manager.save_users()


def _reload_users_for_all_company_managers():
    for manager in list(_company_data_managers.values()):
        try:
            manager.load_users()
            _ensure_super_admin_users(manager)
        except Exception as e:
            logger.warning("Failed to reload users for company manager %s: %s", getattr(manager, 'data_folder', ''), e)


def _get_company_data_manager(company_code=None):
    code = _normalise_company_code(company_code, DEFAULT_COMPANY_CODE)
    registry = _load_company_registry()
    if code not in registry['companies']:
        code = registry.get('defaultCompany', DEFAULT_COMPANY_CODE)

    with _company_manager_lock:
        cached = _company_data_managers.get(code)
        if cached is not None:
            return cached

        record = registry['companies'][code]
        backend_folder = _company_record_backend_folder(record)
        _assert_safe_test_company_folder(backend_folder)
        _ensure_company_folders(record)
        database_url = _database_url_for_runtime()

        if database_url:
            from postgres_data_manager import PostgresDataManager

            logger.info("Using PostgreSQL data manager for company %s", code)
            manager = PostgresDataManager(
                database_url,
                company_code=code,
                company_name=record.get('name') or code,
                data_folder=backend_folder,
                users_file=GLOBAL_USERS_FILE,
            )
        else:
            manager = DataManager(
                backend_folder,
                users_file=GLOBAL_USERS_FILE,
            )
        manager.setup_data_folder()
        manager.check_and_initialize_files()
        manager.load_all_data()
        migrated_locations = manager.migrate_legacy_event_locations()
        if migrated_locations:
            logger.info(
                "Migrated %s legacy event location(s) for company %s",
                migrated_locations,
                code,
            )
        _ensure_super_admin_users(manager)
        _company_data_managers[code] = manager
        return manager


def _activate_company(company_code=None):
    code = _normalise_company_code(company_code, DEFAULT_COMPANY_CODE)
    manager = _get_company_data_manager(code)
    try:
        manager.load_all_data()
        _ensure_super_admin_users(manager)
    except Exception as e:
        logger.warning("Failed to reload active company %s: %s", code, e)
    _set_default_data_manager(manager, code)
    mark_data_snapshot_current(manager)
    return manager


def _activate_company_for_session():
    test_manager = app.config.get('TEST_DATA_MANAGER')
    if app.config.get('TESTING') and test_manager is not None:
        return test_manager

    if not has_request_context() or 'user' not in session:
        return get_default_data_manager()

    username = session.get('user')
    code = session.get('company_code') if _current_user_is_super_admin() else None
    if not code:
        code = _user_assigned_company_code(username)
        session['company_code'] = code
    return _get_company_data_manager(code)


def _bind_request_data_manager(manager):
    tokens = getattr(g, 'data_manager_tokens', None)
    if tokens is None:
        tokens = []
        g.data_manager_tokens = tokens
    tokens.append(_request_data_manager.set(manager))
    return manager


def _company_payload(code=None):
    registry = _load_company_registry()
    code = _normalise_company_code(code or _current_company_code(), registry.get('defaultCompany', DEFAULT_COMPANY_CODE))
    record = registry['companies'].get(code) or registry['companies'][_fallback_company_code(registry)]
    return {
        'code': record.get('code') or code,
        'name': record.get('name') or code,
        'brandingSetupRequired': bool(record.get('brandingSetupRequired', False)),
        'backendFolder': record.get('backendFolder') or '',
        'frontendFolder': record.get('frontendFolder') or '',
    }


def _mark_company_branding_setup_complete(company_code=None):
    registry = _load_company_registry()
    code = _normalise_company_code(company_code or _current_company_code(), DEFAULT_COMPANY_CODE)
    record = registry['companies'].get(code)
    if not record:
        return registry
    if record.get('brandingSetupRequired'):
        record['brandingSetupRequired'] = False
        registry['companies'][code] = record
        registry = _save_company_registry(registry)
    return registry


def _truthy_env(name, default=False):
    value = os.environ.get(name)
    if value is None:
        return default
    return str(value).strip().lower() in ('1', 'true', 'yes', 'y', 'on')


def _local_lan_ip():
    """Best-effort local IP for the development HTTPS certificate SAN list."""
    import socket

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        # No packets are actually sent; this only lets the OS pick the LAN iface.
        sock.connect(('8.8.8.8', 80))
        return sock.getsockname()[0]
    except OSError:
        return None
    finally:
        sock.close()


def _certificate_hosts():
    hosts = {'localhost', '127.0.0.1', '::1'}

    lan_ip = _local_lan_ip()
    if lan_ip:
        hosts.add(lan_ip)

    configured_hosts = os.environ.get('SSL_HOSTS', '')
    for host in configured_hosts.split(','):
        host = host.strip()
        if host:
            hosts.add(host)

    return sorted(hosts)


def _generate_self_signed_certificate(cert_file, key_file):
    """Create a persistent self-signed certificate for local/LAN HTTPS."""
    import ipaddress
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import NameOID

    os.makedirs(os.path.dirname(cert_file), exist_ok=True)
    hosts = _certificate_hosts()

    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    subject = issuer = x509.Name([
        x509.NameAttribute(NameOID.COUNTRY_NAME, 'SG'),
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, 'Avec Inventory Management'),
        x509.NameAttribute(NameOID.COMMON_NAME, hosts[0] if hosts else 'localhost'),
    ])

    san_entries = []
    for host in hosts:
        try:
            san_entries.append(x509.IPAddress(ipaddress.ip_address(host)))
        except ValueError:
            san_entries.append(x509.DNSName(host))

    certificate = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(issuer)
        .public_key(private_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(datetime.utcnow() - timedelta(minutes=5))
        .not_valid_after(datetime.utcnow() + timedelta(days=825))
        .add_extension(x509.SubjectAlternativeName(san_entries), critical=False)
        .sign(private_key, hashes.SHA256())
    )

    with open(key_file, 'wb') as f:
        f.write(private_key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.TraditionalOpenSSL,
            encryption_algorithm=serialization.NoEncryption(),
        ))

    with open(cert_file, 'wb') as f:
        f.write(certificate.public_bytes(serialization.Encoding.PEM))

    logger.info('Generated HTTPS self-signed certificate at %s', cert_file)


def get_ssl_context():
    """
    Return the Flask ssl_context.

    HTTPS is enabled by default and uses the standard HTTPS port (443). To run
    plain HTTP on the standard HTTP port (80), start with ENABLE_HTTPS=0.

    Optional production/LAN certificate paths:
      SSL_CERT_FILE=/path/fullchain.pem
      SSL_KEY_FILE=/path/privkey.pem
    """
    if not _truthy_env('ENABLE_HTTPS', True):
        return None

    cert_file = os.environ.get('SSL_CERT_FILE') or os.environ.get('SSL_CERT')
    key_file = os.environ.get('SSL_KEY_FILE') or os.environ.get('SSL_KEY')

    if cert_file and key_file:
        if not os.path.exists(cert_file):
            raise FileNotFoundError(f'SSL certificate file not found: {cert_file}')
        if not os.path.exists(key_file):
            raise FileNotFoundError(f'SSL key file not found: {key_file}')
        return (cert_file, key_file)

    cert_dir = os.environ.get('CERT_DIR') or os.path.join(os.path.dirname(os.path.abspath(__file__)), 'certs')
    cert_file = os.path.join(cert_dir, 'avec_inventory_selfsigned.crt')
    key_file = os.path.join(cert_dir, 'avec_inventory_selfsigned.key')

    if not os.path.exists(cert_file) or not os.path.exists(key_file):
        _generate_self_signed_certificate(cert_file, key_file)

    return (cert_file, key_file)


def run_https_app(flask_app):
    host = os.environ.get('HOST', '0.0.0.0')
    ssl_context = get_ssl_context()
    scheme = 'https' if ssl_context else 'http'
    default_port = '443' if ssl_context else '80'
    port = int(os.environ.get('PORT', default_port))

    flask_app.config['PREFERRED_URL_SCHEME'] = scheme
    flask_app.config['SESSION_COOKIE_SECURE'] = bool(ssl_context)
    flask_app.config.setdefault('SESSION_COOKIE_SAMESITE', 'Lax')
    logger.info('Starting Avec Inventory Management at %s://%s:%s', scheme, host, port)

    flask_app.run(
        debug=os.environ.get('FLASK_DEBUG') == '1',
        host=host,
        port=port,
        ssl_context=ssl_context,
    )


def _realtime_state_path():
    if not data_manager or not getattr(data_manager, 'data_folder', ''):
        return None
    return os.path.join(data_manager.data_folder, 'RealtimeState.json')


def _write_realtime_state(payload):
    path = _realtime_state_path()
    if not path:
        return

    try:
        folder = os.path.dirname(path)
        if folder and not os.path.exists(folder):
            os.makedirs(folder)
        tmp_path = f"{path}.{secrets.token_hex(6)}.tmp"
        with open(tmp_path, 'w', encoding='utf-8') as f:
            json.dump(payload, f, ensure_ascii=False)
        os.replace(tmp_path, path)
    except Exception as e:
        logger.warning("Failed to write realtime state: %s", e)


def _read_realtime_state():
    path = _realtime_state_path()
    if not path or not os.path.exists(path):
        return None

    try:
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception as e:
        logger.debug("Failed to read realtime state: %s", e)
        return None


def _client_id_from_request():
    if not has_request_context():
        return ''
    return (
        request.headers.get('X-Client-Id')
        or request.args.get('clientId')
        or ''
    )[:120]


def _current_actor_for_realtime():
    if not has_request_context():
        return 'system'
    return session.get('user', 'system')


def _publish_realtime_update_now(topic='data-changed', details=None, origin_client_id=None):
    """Push a compact change notice to every connected browser."""
    global _realtime_sequence

    with _realtime_subscribers_lock:
        _realtime_sequence += 1
        event_id = f"{int(time.time() * 1000)}-{_realtime_sequence}-{secrets.token_hex(4)}"

    payload = {
        'id': event_id,
        'topic': topic,
        'details': details or {},
        'actor': _current_actor_for_realtime(),
        'originClientId': origin_client_id or _client_id_from_request(),
        'timestamp': datetime.now().isoformat(timespec='seconds')
    }

    # The file stamp lets separate WSGI workers observe the same change without
    # adding Redis or another service to this CSV-backed app.
    _write_realtime_state(payload)

    with _realtime_subscribers_lock:
        if not _realtime_subscribers:
            return

        dead_subscribers = []
        for subscriber_id, subscriber_queue in _realtime_subscribers.items():
            try:
                subscriber_queue.put_nowait(payload)
            except queue.Full:
                dead_subscribers.append(subscriber_id)

        for subscriber_id in dead_subscribers:
            _realtime_subscribers.pop(subscriber_id, None)


def mark_realtime_change(topic='data-changed', details=None):
    """Mark this request as having changed shared data.

    The actual publish happens after the response succeeds, so failed writes do
    not trigger other browsers to refresh. Background jobs publish immediately.
    """
    if has_request_context():
        changes = getattr(g, 'realtime_changes', [])
        changes.append({'topic': topic, 'details': details or {}})
        g.realtime_changes = changes
        return

    _publish_realtime_update_now(topic, details or {}, '')


def _event_asset_realtime_change_for_request():
    """Describe prepare/return mutations so browsers can refresh one event only."""
    action_by_endpoint = {
        'prepare_event_asset': 'prepare',
        'unprepare_event_asset': 'unprepare',
        'assign_specific_asset_to_model': 'prepare',
        'unassign_specific_asset_from_model': 'unprepare',
        'return_event_asset': 'return',
        'return_department_assets': 'return-department',
    }
    action = action_by_endpoint.get(request.endpoint)
    event_id = (request.view_args or {}).get('event_id')
    if not action or event_id is None:
        return None

    request_data = request.get_json(silent=True) or {}
    details = {
        'eventId': int(event_id),
        'action': action,
    }
    if request_data.get('assetId'):
        details['assetId'] = str(request_data['assetId'])
    if request_data.get('department'):
        details['department'] = str(request_data['department'])
    return details


@app.after_request
def publish_marked_realtime_changes(response):
    if response.status_code < 400:
        event_asset_change = _event_asset_realtime_change_for_request()
        if event_asset_change:
            changes = getattr(g, 'realtime_changes', [])
            changes.append({'topic': 'event-assets', 'details': event_asset_change})
            g.realtime_changes = changes

    changes = getattr(g, 'realtime_changes', None)
    if changes and response.status_code < 400:
        topics = sorted({change.get('topic', 'data-changed') for change in changes})
        _publish_realtime_update_now(
            'data-changed',
            {
                'topics': topics,
                'changes': changes[-10:],
                'path': request.path,
                'method': request.method
            },
            _client_id_from_request()
        )
    return response

def _with_action_lock(lock):
    """Build a route decorator that serializes operations using the given lock."""
    def decorator(function):
        @wraps(function)
        def locked_function(*args, **kwargs):
            with lock:
                return function(*args, **kwargs)

        return locked_function

    return decorator


with_transfer_action_lock = _with_action_lock(_transfer_action_lock)
with_prepare_action_lock = _with_action_lock(_prepare_action_lock)
with_inventory_action_lock = _with_action_lock(_inventory_action_lock)


def _parse_any_date(value):
    if not value:
        return None

    value = str(value).strip()
    for fmt in ("%Y%m%d", "%Y/%m/%d", "%Y-%m-%d"):
        try:
            return datetime.strptime(value, fmt).date()
        except ValueError:
            pass
    return None


def _ranges_overlap(a_start, a_end, b_start, b_end):
    ad1, ad2 = _parse_any_date(a_start), _parse_any_date(a_end)
    bd1, bd2 = _parse_any_date(b_start), _parse_any_date(b_end)
    if not all([ad1, ad2, bd1, bd2]):
        return False
    return ad1 <= bd2 and bd1 <= ad2

def invalidate_cache():
    """Invalidate the asset cache when data changes"""
    reset_cache()
    # The current process made this change, so its in-memory manager is already
    # authoritative. Recording the new file signature prevents the next request
    # from mistaking our own write for an external update and reloading all CSVs.
    mark_data_snapshot_current()
    mark_realtime_change('inventory-data')


def reset_cache():
    """Clear in-process derived data without publishing a realtime event."""
    manager = _current_data_manager_object()
    if manager is not None:
        _manager_caches.pop(id(manager), None)


def _current_manager_cache():
    manager = _current_data_manager_object()
    if manager is None:
        return {
            'assigned_assets': None,
            'available_assets': None,
            'cache_timestamp': None,
        }
    return _manager_caches.setdefault(id(manager), {
        'assigned_assets': None,
        'available_assets': None,
        'cache_timestamp': None,
    })


def _shared_data_signature(manager=None):
    """Fingerprint CSV-backed files so separate workers can detect fresh data."""
    manager = manager or _current_data_manager_object()
    if manager is None:
        return None
    if hasattr(manager, 'shared_data_signature'):
        return manager.shared_data_signature()

    entries = []
    data_folder = getattr(manager, 'data_folder', '') or ''
    events_folder = getattr(manager, 'events_folder', '') or ''

    def add_file(label, path):
        try:
            stat = os.stat(path)
            entries.append((label, stat.st_mtime_ns, stat.st_size))
        except FileNotFoundError:
            entries.append((label, 0, 0))
        except OSError as e:
            logger.debug("Unable to stat %s for data refresh: %s", path, e)
            entries.append((label, -1, -1))

    for filename in ('Inventory.csv', 'Logs.csv', 'Users.csv', 'Containers.csv', 'Clients.csv'):
        if hasattr(manager, '_data_path'):
            add_file(filename, manager._data_path(filename))
        else:
            add_file(filename, os.path.join(data_folder, filename))

    try:
        with os.scandir(events_folder) as event_files:
            for entry in event_files:
                if not entry.is_file() or not entry.name.endswith('.csv'):
                    continue
                try:
                    stat = entry.stat()
                    entries.append((f"events/{entry.name}", stat.st_mtime_ns, stat.st_size))
                except OSError as e:
                    logger.debug("Unable to stat event file %s: %s", entry.path, e)
                    entries.append((f"events/{entry.name}", -1, -1))
    except FileNotFoundError:
        entries.append(('events/', 0, 0))
    except OSError as e:
        logger.debug("Unable to scan events folder for data refresh: %s", e)
        entries.append(('events/', -1, -1))

    return tuple(sorted(entries))


def mark_data_snapshot_current(manager=None):
    """Record that this process has loaded the latest CSV-backed data."""
    global _data_snapshot_signature
    manager = manager or _current_data_manager_object()
    if manager is None:
        return
    signature = _shared_data_signature(manager)
    _data_snapshot_signatures[id(manager)] = signature
    if manager is get_default_data_manager():
        _data_snapshot_signature = signature


def refresh_shared_data_if_changed(force=False):
    """Reload CSV data when another process or user has changed the files."""
    global _data_snapshot_signature

    manager = _current_data_manager_object()
    if manager is None:
        return False

    with _data_reload_lock:
        current_signature = _shared_data_signature(manager)
        previous_signature = _data_snapshot_signatures.get(id(manager))
        if not force and previous_signature == current_signature:
            return False

        manager.load_all_data()
        reset_cache()
        new_signature = _shared_data_signature(manager)
        _data_snapshot_signatures[id(manager)] = new_signature
        if manager is get_default_data_manager():
            _data_snapshot_signature = new_signature
        logger.info("Reloaded shared CSV data after external change")
        return True


# ---------------- Department configuration helpers ----------------
# Departments used to be hard-coded in CSS and in dropdowns.  These helpers keep
# the existing DepartmentCode value as the stable key, while allowing admins to
# add/rename department codes and change badge colours without editing code.
DEFAULT_DEPARTMENTS = {
    'AX':   {'code': 'AX',   'name': 'Audio',    'color': '#cce5ff', 'textColor': '#004085'},
    'LX':   {'code': 'LX',   'name': 'Lighting', 'color': '#d4edda', 'textColor': '#155724'},
    'VX':   {'code': 'VX',   'name': 'Video',    'color': '#e2d9f3', 'textColor': '#44297a'},
    'LOAN': {'code': 'LOAN', 'name': 'Loan',     'color': '#f8d7da', 'textColor': '#721c24'},
    'MISC': {'code': 'MISC', 'name': 'Misc',     'color': '#fff3cd', 'textColor': '#856404'},
    'UN':   {'code': 'UN',   'name': 'Unknown',  'color': '#e2e3e5', 'textColor': '#383d41'},
}


def _normalise_department_code(code):
    code = str(code or '').strip().upper()
    code = re.sub(r'[^A-Z0-9_-]+', '', code)
    return code


def _normalise_hex_colour(value, fallback='#e2e3e5'):
    value = str(value or '').strip()
    if re.match(r'^#[0-9a-fA-F]{6}$', value):
        return value.upper()
    if re.match(r'^[0-9a-fA-F]{6}$', value):
        return f'#{value.upper()}'
    return fallback


def _best_text_colour(background):
    colour = _normalise_hex_colour(background)
    try:
        r = int(colour[1:3], 16)
        g = int(colour[3:5], 16)
        b = int(colour[5:7], 16)
        # Perceived brightness. Light backgrounds get dark text; dark backgrounds get white text.
        brightness = (r * 299 + g * 587 + b * 114) / 1000
        return '#111827' if brightness > 150 else '#FFFFFF'
    except Exception:
        return '#111827'


def _departments_csv_path():
    if not data_manager:
        return os.path.join('.', 'Departments.csv')
    return os.path.join(data_manager.data_folder, 'Departments.csv')


def _department_record(code, name=None, colour=None, text_colour=None):
    code = _normalise_department_code(code) or 'UN'
    defaults = DEFAULT_DEPARTMENTS.get(code, {})
    colour = _normalise_hex_colour(colour or defaults.get('color', '#e2e3e5'))
    return {
        'code': code,
        'name': str(name if name is not None else defaults.get('name', code)).strip() or code,
        'color': colour,
        'textColor': _normalise_hex_colour(text_colour or defaults.get('textColor') or _best_text_colour(colour), _best_text_colour(colour))
    }


def _save_departments(departments):
    manager = _current_data_manager_object()
    if manager is not None and hasattr(manager, 'save_departments'):
        manager.save_departments(departments)
        return

    filepath = _departments_csv_path()
    folder = os.path.dirname(filepath)
    if folder and not os.path.exists(folder):
        os.makedirs(folder)

    with open(filepath, 'w', newline='', encoding='utf-8') as f:
        writer = csv.DictWriter(f, fieldnames=['Code', 'Name', 'Color', 'TextColor'])
        writer.writeheader()
        for code in sorted(departments.keys()):
            dept = _department_record(
                code,
                departments[code].get('name'),
                departments[code].get('color'),
                departments[code].get('textColor')
            )
            writer.writerow({
                'Code': dept['code'],
                'Name': dept['name'],
                'Color': dept['color'],
                'TextColor': dept['textColor']
            })


def _load_departments():
    filepath = _departments_csv_path()
    departments = {}
    changed = False
    manager = _current_data_manager_object()
    database_backed = manager is not None and hasattr(manager, 'load_departments')

    if database_backed:
        departments = manager.load_departments()
    elif os.path.exists(filepath) and os.path.getsize(filepath) > 0:
        try:
            with open(filepath, 'r', newline='', encoding='utf-8-sig') as f:
                reader = csv.DictReader(f)
                for row in reader:
                    code = _normalise_department_code(row.get('Code') or row.get('code'))
                    if not code:
                        continue
                    departments[code] = _department_record(
                        code,
                        row.get('Name') or row.get('name') or code,
                        row.get('Color') or row.get('color'),
                        row.get('TextColor') or row.get('textColor')
                    )
        except Exception as e:
            logger.warning(f"Failed to read Departments.csv, rebuilding defaults: {e}")
            departments = {}
            changed = True

    # Always keep the defaults available, unless the admin has already changed them.
    for code, dept in DEFAULT_DEPARTMENTS.items():
        if code not in departments:
            departments[code] = dept.copy()
            changed = True

    # Auto-register any existing inventory department codes so old CSVs keep working.
    if data_manager and getattr(data_manager, 'inventory', None):
        for asset in data_manager.inventory.values():
            code = _normalise_department_code(getattr(asset, 'department_code', 'UN')) or 'UN'
            if code not in departments:
                departments[code] = _department_record(code)
                changed = True

    if changed or (not database_backed and not os.path.exists(filepath)):
        _save_departments(departments)

    return departments


def _department_payload(code, departments=None):
    departments = departments or _load_departments()
    code = _normalise_department_code(code) or 'UN'
    return departments.get(code) or _department_record(code)


# ---------------- PDF branding settings helpers ----------------
DEFAULT_PDF_FOOTER_TEXT = (
    "AVEC VISION PRIVATE LIMITED\n"
    "601 SIMS DRIVE PAN-I COMPLEX #04-10 SINGAPORE 387382 TEL 65.9743.3660 CO REG 202122775G"
)

ALLOWED_PDF_LOGO_MIMES = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
}

ALLOWED_PDF_LOGO_EXTENSIONS = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
}


def _pdf_settings_defaults():
    return {
        'footerText': DEFAULT_PDF_FOOTER_TEXT,
        'logoFilename': '',
        'logoOriginalName': '',
        'logoMimeType': '',
        'updatedAt': '',
    }


def _pdf_settings_path():
    folder = data_manager.data_folder if data_manager else './data'
    return os.path.join(folder, 'PdfSettings.json')


def _company_frontend_folder(company_code=None):
    record = _company_record_for_code(company_code)
    folder = _company_record_frontend_folder(record)
    if folder and not os.path.exists(folder):
        os.makedirs(folder)
    return folder or os.path.join(BASE_DIR, DEFAULT_COMPANY_CODE, 'frontend')


def _default_pdf_logo_path(company_code=None):
    current_logo = os.path.join(_company_frontend_folder(company_code), 'logo.png')
    if os.path.exists(current_logo):
        return current_logo

    avec_logo = os.path.join(BASE_DIR, 'companies', DEFAULT_COMPANY_CODE, 'frontend', 'logo.png')
    if os.path.exists(avec_logo):
        return avec_logo

    legacy_logo = os.path.join(app.static_folder, 'images', 'logo.png')
    if os.path.exists(legacy_logo):
        return legacy_logo

    return ''


def _pdf_assets_folder():
    return os.path.join(_company_frontend_folder(), 'pdf_assets')


def _pdf_logo_path(settings=None):
    settings = settings or _load_pdf_settings()
    logo_filename = str(settings.get('logoFilename') or '').strip()
    if not logo_filename:
        return ''
    return os.path.join(_pdf_assets_folder(), os.path.basename(logo_filename))


def _normalise_pdf_settings(settings):
    defaults = _pdf_settings_defaults()
    merged = defaults.copy()
    if isinstance(settings, dict):
        for key in merged.keys():
            if key in settings:
                merged[key] = settings[key]

    merged['footerText'] = str(merged.get('footerText', DEFAULT_PDF_FOOTER_TEXT))
    merged['logoFilename'] = os.path.basename(str(merged.get('logoFilename') or '').strip())
    merged['logoOriginalName'] = str(merged.get('logoOriginalName') or '').strip()
    merged['logoMimeType'] = str(merged.get('logoMimeType') or '').strip()
    merged['updatedAt'] = str(merged.get('updatedAt') or '').strip()

    logo_path = _pdf_logo_path(merged) if merged['logoFilename'] else ''
    if logo_path and not os.path.exists(logo_path):
        merged['logoFilename'] = ''
        merged['logoOriginalName'] = ''
        merged['logoMimeType'] = ''

    return merged


def _load_pdf_settings():
    filepath = _pdf_settings_path()
    settings = _pdf_settings_defaults()

    if os.path.exists(filepath) and os.path.getsize(filepath) > 0:
        try:
            with open(filepath, 'r', encoding='utf-8') as f:
                loaded = json.load(f)
                if isinstance(loaded, dict):
                    settings.update(loaded)
        except Exception as e:
            logger.warning(f"Failed to read PdfSettings.json, using defaults: {e}")

    return _normalise_pdf_settings(settings)


def _save_pdf_settings(settings):
    settings = _normalise_pdf_settings(settings)
    filepath = _pdf_settings_path()
    folder = os.path.dirname(filepath)
    if folder and not os.path.exists(folder):
        os.makedirs(folder)

    with open(filepath, 'w', encoding='utf-8') as f:
        json.dump(settings, f, ensure_ascii=False, indent=2)

    return settings


def _pdf_settings_payload(settings=None):
    settings = _normalise_pdf_settings(settings or _load_pdf_settings())
    logo_path = _pdf_logo_path(settings) if settings.get('logoFilename') else ''
    has_custom_logo = bool(logo_path and os.path.exists(logo_path))
    default_logo_path = _default_pdf_logo_path()
    logo_url = '/api/pdf-settings/logo'

    if has_custom_logo:
        version = int(os.path.getmtime(logo_path))
        logo_url = f'/api/pdf-settings/logo?v={version}'
    elif default_logo_path and os.path.exists(default_logo_path):
        version = int(os.path.getmtime(default_logo_path))
        logo_url = f'/api/pdf-settings/logo?v={version}'

    return {
        'footerText': settings.get('footerText', DEFAULT_PDF_FOOTER_TEXT),
        'logoUrl': logo_url,
        'hasCustomLogo': has_custom_logo,
        'logoOriginalName': settings.get('logoOriginalName', ''),
        'updatedAt': settings.get('updatedAt', ''),
    }


def _remove_custom_pdf_logos():
    folder = _pdf_assets_folder()
    if not os.path.isdir(folder):
        return

    for filename in os.listdir(folder):
        if filename.startswith('logo.'):
            try:
                os.remove(os.path.join(folder, filename))
            except OSError as e:
                logger.warning(f"Failed to remove old PDF logo {filename}: {e}")


def _replace_department_in_model_marker(value, old_code, new_code):
    if not isinstance(value, str) or not value.startswith('[MODEL]'):
        return value, False

    parts = value[7:].split('|', 4)
    if not parts or _normalise_department_code(parts[0]) != old_code:
        return value, False

    parts[0] = new_code
    return '[MODEL]' + '|'.join(parts), True


def _replace_department_in_model_description(value, old_code, new_code):
    if not isinstance(value, str):
        return value, False

    prefix = f'[{old_code}]'
    if value.startswith(prefix):
        return f'[{new_code}]' + value[len(prefix):], True

    return value, False


def _replace_department_in_custom_marker(value, old_code, new_code):
    custom = _parse_custom_marker(value) if isinstance(value, str) else None
    if not custom or custom.get('legacy'):
        return value, False
    if _normalise_department_code(custom.get('department')) != old_code:
        return value, False
    return _make_custom_marker(
        custom.get('type'),
        custom.get('name'),
        custom.get('quantity'),
        new_code,
        custom.get('company'),
        uid=custom.get('uid') or None
    ), True

def _clean_group_value(value, uppercase=False):
    cleaned = str(value or '').strip()
    return cleaned.upper() if uppercase else cleaned


def _asset_group_key(asset):
    """
    Asset model type key.

    Model types are identified by department, brand, and model number only.
    Description is display/detail text and must not split availability,
    preparation, transfer, or asset-check groups.
    """
    return (
        _clean_group_value(getattr(asset, 'department_code', ''), True),
        _clean_group_value(getattr(asset, 'brand', '')),
        _clean_group_value(getattr(asset, 'model_number', '')),
        ''
    )


def _asset_family_key_from_values(brand, model):
    return (
        _clean_group_value(brand).lower(),
        _clean_group_value(model).lower()
    )


def _asset_family_key(asset):
    return _asset_family_key_from_values(
        getattr(asset, 'brand', ''),
        getattr(asset, 'model_number', '')
    )


def _asset_id_parts(asset_id):
    match = re.match(r'^(.*?)#(\d+)$', str(asset_id or '').strip())
    if not match:
        return None, None, 0

    number_text = match.group(2)
    return match.group(1), int(number_text), len(number_text)


def _normalise_asset_id_prefix(value):
    prefix = str(value or '').strip().upper()
    prefix = re.sub(r'\s+', ' ', prefix)
    prefix = prefix.replace('#', '')
    return prefix.strip()


def _prefix_fragment(value):
    return re.sub(r'[^A-Z0-9]+', '', str(value or '').upper())


def _brand_prefix_fragment(brand):
    words = re.findall(r'[A-Z0-9]+', str(brand or '').upper())
    if not words:
        return ''

    if len(words) > 1:
        return ''.join(word[0] for word in words if word)[:4]

    word = words[0]
    if len(word) <= 3:
        return word

    # Short brand mark that keeps prefixes readable while still separating
    # common same-model collisions such as L-Acoustics P1 -> LAP1.
    return word[:3]


def _default_asset_id_prefix(brand, model, used_prefixes=None, existing_model_brand_collision=False):
    model_fragment = _prefix_fragment(model)
    brand_fragment = _brand_prefix_fragment(brand)

    if not model_fragment:
        model_fragment = brand_fragment or 'ASSET'

    candidate = model_fragment
    used_prefixes = used_prefixes or {}

    if existing_model_brand_collision or candidate in used_prefixes:
        candidate = f"{brand_fragment}{model_fragment}" if brand_fragment else model_fragment

    base_candidate = candidate or 'ASSET'
    counter = 2
    while candidate in used_prefixes:
        candidate = f"{base_candidate}{counter}"
        counter += 1

    return candidate


def _prefix_usage_summary():
    summary = defaultdict(lambda: {
        'count': 0,
        'maxNumber': 0,
        'width': 2,
        'families': defaultdict(int),
        'familyLabels': {}
    })

    for item in data_manager.inventory.values():
        if not item or _is_bulk_asset(item):
            continue

        prefix, number, width = _asset_id_parts(getattr(item, 'asset_id', ''))
        if not prefix:
            continue

        normalised_prefix = _normalise_asset_id_prefix(prefix)
        if not normalised_prefix:
            continue

        family = _asset_family_key(item)
        entry = summary[normalised_prefix]
        entry['count'] += 1
        entry['maxNumber'] = max(entry['maxNumber'], number)
        entry['width'] = max(entry['width'], width or 2)
        entry['families'][family] += 1
        entry['familyLabels'].setdefault(family, (
            _clean_group_value(getattr(item, 'brand', '')),
            _clean_group_value(getattr(item, 'model_number', ''))
        ))

    return summary


def _best_existing_prefix_for_family(family_key, usage):
    candidates = []

    for prefix, entry in usage.items():
        family_count = entry['families'].get(family_key, 0)
        if family_count <= 0:
            continue

        candidates.append((
            -family_count,
            -entry['maxNumber'],
            prefix
        ))

    if not candidates:
        return None

    candidates.sort()
    return candidates[0][2]


def _asset_id_plan_for_request(data):
    data = data or {}

    brand = str(data.get('brand', '') or '').strip()
    model_number = str(data.get('model', '') or '').strip()
    description = str(data.get('description', '') or '').strip()
    department = _normalise_department_code(data.get('department', 'UN')) or 'UN'
    is_bulk = _request_bool(data.get('isBulk'), default=False)

    if not brand:
        raise ValueError('Brand is required')

    if not model_number:
        raise ValueError('Model number is required')

    if is_bulk:
        quantity = max(1, _safe_int(data.get('quantity', 1), 1))
        return {
            'isBulk': True,
            'brand': brand,
            'model': model_number,
            'description': description,
            'department': department,
            'quantity': quantity,
            'prefix': '',
            'startNumber': None,
            'nextNumber': None,
            'ids': [],
            'serials': [],
            'secondarySerials': [],
            'existingCount': 0,
            'message': ''
        }

    quantity = max(1, _safe_int(data.get('quantity', 1), 1))
    quantity = min(quantity, 500)
    family_key = _asset_family_key_from_values(brand, model_number)
    usage = _prefix_usage_summary()
    custom_prefix = _normalise_asset_id_prefix(data.get('assetIdPrefix'))

    if custom_prefix:
        prefix = custom_prefix
    else:
        existing_prefix = _best_existing_prefix_for_family(family_key, usage)

        if existing_prefix:
            prefix = existing_prefix
        else:
            model_key = _clean_group_value(model_number).lower()
            has_model_brand_collision = any(
                _clean_group_value(getattr(item, 'model_number', '')).lower() == model_key and
                _asset_family_key(item) != family_key
                for item in data_manager.inventory.values()
                if item and not _is_bulk_asset(item)
            )

            used_by_other_families = {
                used_prefix: entry
                for used_prefix, entry in usage.items()
                if family_key not in entry['families']
            }
            prefix = _default_asset_id_prefix(
                brand,
                model_number,
                used_by_other_families,
                existing_model_brand_collision=has_model_brand_collision
            )

    if not prefix:
        raise ValueError('Asset ID prefix is required')

    prefix_entry = usage.get(prefix)
    next_number = (prefix_entry or {}).get('maxNumber', 0) + 1
    width = max(2, (prefix_entry or {}).get('width', 2), len(str(next_number + quantity - 1)))
    ids = [f"{prefix}#{number:0{width}d}" for number in range(next_number, next_number + quantity)]

    collisions = [asset_id for asset_id in ids if asset_id in data_manager.inventory]
    if collisions:
        raise ValueError(f'Generated Asset ID already exists: {collisions[0]}')

    raw_serials = data.get('serials')
    if isinstance(raw_serials, list):
        serials = [str(serial or '').strip() for serial in raw_serials]
    else:
        serial = str(data.get('serial', '') or '').strip()
        serials = [serial] if serial else []

    serials = (serials + [''] * quantity)[:quantity]

    raw_secondary_serials = data.get('secondarySerials')
    if isinstance(raw_secondary_serials, list):
        secondary_serials = [str(serial or '').strip() for serial in raw_secondary_serials]
    else:
        secondary_serial = str(
            data.get('secondarySerial', data.get('serial2', '')) or ''
        ).strip()
        secondary_serials = [secondary_serial] if secondary_serial else []

    secondary_serials = (secondary_serials + [''] * quantity)[:quantity]

    existing_count = 0
    if prefix_entry:
        existing_count = prefix_entry['families'].get(family_key, 0)

    return {
        'isBulk': False,
        'brand': brand,
        'model': model_number,
        'description': description,
        'department': department,
        'quantity': quantity,
        'prefix': prefix,
        'startNumber': next_number,
        'nextNumber': next_number + quantity,
        'ids': ids,
        'serials': serials,
        'secondarySerials': secondary_serials,
        'existingCount': existing_count,
        'message': f"{prefix} continues from #{next_number:0{width}d}"
    }




def _is_bulk_asset(asset):
    return bool(getattr(asset, 'is_bulk', False))


def _safe_int(value, default=0):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _normalise_asset_purchase_date(value):
    raw = str(value or '').strip()
    if not raw:
        return ''

    for fmt in ('%Y-%m-%d', '%Y/%m/%d', '%Y%m%d'):
        try:
            return datetime.strptime(raw, fmt).strftime('%Y-%m-%d')
        except ValueError:
            continue

    raise ValueError('Date of purchase must be YYYY-MM-DD')


ASSET_AUDIT_FIELD_LABELS = {
    'asset_id': 'Asset ID',
    'department': 'Department',
    'brand': 'Brand',
    'model': 'Model',
    'description': 'Description',
    'serial': 'Serial Number',
    'secondary_serial': 'Second Serial Number',
    'date_of_purchase': 'Date of Purchase',
    'default_location': 'Default Location',
    'current_location': 'Current Location',
    'status': 'Asset Status',
    'quantity': 'Quantity',
    'notes': 'Notes',
}


def _asset_audit_timestamp():
    return datetime.now().isoformat(timespec='seconds')


def _asset_audit_user():
    return session.get('user', 'system') if has_request_context() else 'system'


def _asset_audit_snapshot(asset):
    return {
        'asset_id': getattr(asset, 'asset_id', ''),
        'department': getattr(asset, 'department_code', ''),
        'brand': getattr(asset, 'brand', ''),
        'model': getattr(asset, 'model_number', ''),
        'description': getattr(asset, 'description', ''),
        'serial': getattr(asset, 'serial_number', ''),
        'secondary_serial': getattr(asset, 'secondary_serial_number', ''),
        'date_of_purchase': getattr(asset, 'date_of_purchase', ''),
        'default_location': getattr(asset, 'default_location', ''),
        'current_location': getattr(asset, 'current_location', ''),
        'status': _asset_condition_status(asset),
        'quantity': max(1, _safe_int(getattr(asset, 'quantity', 1), 1)) if _is_bulk_asset(asset) else 1,
        'notes': getattr(asset, 'notes', ''),
    }


def _asset_audit_value(value):
    if isinstance(value, bool):
        return value
    if isinstance(value, int):
        return value
    if value is None:
        return ''
    return str(value)


def _asset_audit_changes(before, after, fields=None):
    fields = fields or ASSET_AUDIT_FIELD_LABELS.keys()
    changes = []

    for field in fields:
        old_value = _asset_audit_value(before.get(field, ''))
        new_value = _asset_audit_value(after.get(field, ''))
        if old_value == new_value:
            continue

        changes.append({
            'field': field,
            'label': ASSET_AUDIT_FIELD_LABELS.get(field, field),
            'old': old_value,
            'new': new_value,
        })

    return changes


def _append_asset_change_history(asset, changes, timestamp=None, user=None, action='updated'):
    changes = [change for change in (changes or []) if change]
    if not changes:
        return False

    timestamp = timestamp or _asset_audit_timestamp()
    user = user if user is not None else _asset_audit_user()
    history = list(getattr(asset, 'change_history', []) or [])
    history.append({
        'date': timestamp,
        'user': user,
        'action': action,
        'changes': changes,
    })
    asset.change_history = history
    asset.date_modified = timestamp
    return True


def _mark_asset_created(asset, timestamp=None, user=None):
    timestamp = timestamp or _asset_audit_timestamp()
    user = user if user is not None else _asset_audit_user()
    asset.date_added = getattr(asset, 'date_added', '') or timestamp
    asset.date_modified = getattr(asset, 'date_modified', '') or timestamp

    after = _asset_audit_snapshot(asset)
    changes = [
        {
            'field': field,
            'label': ASSET_AUDIT_FIELD_LABELS.get(field, field),
            'old': '',
            'new': _asset_audit_value(value),
        }
        for field, value in after.items()
        if _asset_audit_value(value) not in ('', 0)
    ]
    _append_asset_change_history(asset, changes, timestamp=timestamp, user=user, action='created')


def _is_degraded(asset):
    return bool(getattr(asset, 'is_degraded', False))


def _is_disposed(asset):
    return bool(getattr(asset, 'is_disposed', False))


def _normalise_asset_status_name(value):
    status = str(value or '').strip().lower()
    return 'decommissioned' if status == 'disposed' else status


def _asset_inventory_quantity(asset):
    if not asset or _is_disposed(asset):
        return 0
    return max(1, _safe_int(getattr(asset, 'quantity', 1), 1)) if _is_bulk_asset(asset) else 1


def _asset_status_value(asset, assigned_assets=None):
    if not asset:
        return 'unknown'
    if _is_disposed(asset):
        return 'decommissioned'
    if getattr(asset, 'is_missing', False):
        return 'missing'
    if getattr(asset, 'is_ooc', False):
        return 'ooc'
    if assigned_assets is not None and not _is_bulk_asset(asset) and asset.asset_id in assigned_assets:
        return 'deployed'
    if _is_degraded(asset):
        return 'degraded'
    return 'available'


ASSET_CONDITION_STATUSES = ('ooc', 'missing', 'degraded', 'decommissioned')
BULK_MAINTENANCE_FAULT_SOURCE = 'bulk_maintenance_fault'
BULK_MAINTENANCE_RESOLUTION_SOURCE = 'bulk_maintenance_resolution'
CONTAINER_MAINTENANCE_SOURCE = 'container'
BULK_MAINTENANCE_STATUSES = ('ooc', 'missing', 'degraded')
BULK_MAINTENANCE_UNAVAILABLE_STATUSES = ('ooc', 'missing')


def _asset_condition_status(asset):
    """Return the asset's mutually-exclusive condition status, excluding deployment."""
    if not asset:
        return 'unknown'
    if _is_disposed(asset):
        return 'decommissioned'
    if getattr(asset, 'is_missing', False):
        return 'missing'
    if getattr(asset, 'is_ooc', False):
        return 'ooc'
    if _is_degraded(asset):
        return 'degraded'
    return 'ok'


def _bulk_maintenance_log_key(record, index):
    log_id = str((record or {}).get('id') or '').strip()
    return log_id or f'index:{index}'


def _bulk_maintenance_source_kind(record):
    source = (record or {}).get('source') or {}
    return str(source.get('kind') or '').strip()


def _bulk_maintenance_fault_entries(asset):
    """Return paired bulk maintenance fault/resolution entries for one bulk row."""
    faults = []
    lookup = {}

    for index, log_entry in enumerate(getattr(asset, 'maintenance_logs', []) or []):
        record = normalize_maintenance_log(log_entry)
        source = record.get('source') or {}
        kind = _bulk_maintenance_source_kind(record)

        if kind == BULK_MAINTENANCE_FAULT_SOURCE:
            status = str(source.get('bulkStatus') or '').strip().lower()
            if status not in BULK_MAINTENANCE_STATUSES:
                continue

            key = _bulk_maintenance_log_key(record, index)
            log_number = max(1, _safe_int(source.get('bulkLogNumber'), len(faults) + 1))
            quantity = max(1, _safe_int(source.get('bulkQuantity'), 1))
            entry = {
                'key': key,
                'id': str(record.get('id') or '').strip(),
                'index': index,
                'logNumber': log_number,
                'status': status,
                'quantity': quantity,
                'fault': record,
                'resolution': None,
                'resolutionIndex': None,
            }
            faults.append(entry)
            lookup[key] = entry
            if entry['id']:
                lookup[entry['id']] = entry

        elif kind == BULK_MAINTENANCE_RESOLUTION_SOURCE:
            target = str(
                source.get('bulkResolves') or
                source.get('bulkFaultLogId') or
                source.get('faultLogId') or
                ''
            ).strip()
            if not target:
                continue
            fault = lookup.get(target)
            if fault:
                fault['resolution'] = record
                fault['resolutionIndex'] = index

    return faults


def _bulk_maintenance_open_faults(asset):
    return [
        entry for entry in _bulk_maintenance_fault_entries(asset)
        if not entry.get('resolution')
    ]


def _bulk_maintenance_quantity_counts(asset):
    total = max(1, _safe_int(getattr(asset, 'quantity', 1), 1)) if _is_bulk_asset(asset) else 1
    raw_counts = {'ooc': 0, 'missing': 0, 'degraded': 0}

    for entry in _bulk_maintenance_open_faults(asset):
        status = entry.get('status')
        if status in raw_counts:
            raw_counts[status] += max(1, _safe_int(entry.get('quantity'), 1))

    remaining_quantity = total
    ooc_quantity = min(remaining_quantity, raw_counts['ooc'])
    remaining_quantity = max(remaining_quantity - ooc_quantity, 0)
    missing_quantity = min(remaining_quantity, raw_counts['missing'])
    remaining_quantity = max(remaining_quantity - missing_quantity, 0)
    degraded_quantity = min(remaining_quantity, raw_counts['degraded'])
    capped_counts = {
        'ooc': ooc_quantity,
        'missing': missing_quantity,
        'degraded': degraded_quantity,
    }
    unavailable_quantity = sum(capped_counts[status] for status in BULK_MAINTENANCE_UNAVAILABLE_STATUSES)
    return {
        'ooc': capped_counts['ooc'],
        'missing': capped_counts['missing'],
        'degraded': capped_counts['degraded'],
        'unavailable': unavailable_quantity,
        'total': unavailable_quantity + degraded_quantity,
        'rawOOC': raw_counts['ooc'],
        'rawMissing': raw_counts['missing'],
        'rawDegraded': raw_counts['degraded'],
    }


def _next_bulk_maintenance_log_number(asset):
    existing_numbers = [
        max(0, _safe_int(entry.get('logNumber'), 0))
        for entry in _bulk_maintenance_fault_entries(asset)
    ]
    return max(existing_numbers, default=0) + 1


def _bulk_maintenance_logbook_for_response(asset):
    rows = []
    for entry in _bulk_maintenance_fault_entries(asset):
        rows.append({
            'key': entry['key'],
            'id': entry['id'],
            'logNumber': entry['logNumber'],
            'status': entry['status'],
            'quantity': entry['quantity'],
            'faultIndex': entry['index'],
            'resolutionIndex': entry.get('resolutionIndex'),
            'isResolved': bool(entry.get('resolution')),
            'fault': _maintenance_log_for_response(entry.get('fault')),
            'resolution': (
                _maintenance_log_for_response(entry.get('resolution'))
                if entry.get('resolution') else None
            ),
        })
    return rows


def _maintenance_log_marks_status(record, status, action='marked'):
    target_status = str(status or '').strip().lower()
    target_action = str(action or '').strip().lower()
    for change in normalize_maintenance_log(record).get('changes', []) or []:
        kind = str(change.get('kind') or '').strip().lower()
        change_action = str(change.get('action') or '').strip().lower()
        if kind == target_status and change_action == target_action:
            return True
    return False


def _clean_warning_reason(value, max_length=240):
    reason = str(value or '').strip()
    if not reason:
        return ''
    reason = re.sub(r'\s+', ' ', reason)
    if len(reason) > max_length:
        return reason[:max_length - 1].rstrip() + '...'
    return reason


def _asset_degraded_reasons(asset, limit=3):
    if not asset:
        return []

    active_reason = ''
    for log_entry in getattr(asset, 'maintenance_logs', []) or []:
        record = normalize_maintenance_log(log_entry)
        if _maintenance_log_marks_status(record, 'degraded', 'marked'):
            active_reason = _clean_warning_reason(record.get('description'))
        if _maintenance_log_marks_status(record, 'degraded', 'cleared'):
            active_reason = ''

    return [active_reason] if active_reason else []


def _bulk_degraded_reasons(asset, limit=3):
    reasons = []

    if _is_degraded(asset):
        reasons.extend(_asset_degraded_reasons(asset, limit=limit))

    for entry in _bulk_maintenance_open_faults(asset):
        if entry.get('status') != 'degraded':
            continue
        reason = _clean_warning_reason((entry.get('fault') or {}).get('description'))
        if reason:
            reasons.append(reason)
        if len(reasons) >= limit:
            break

    return reasons[:limit]


def _warning_reason_text(reasons):
    clean_reasons = [_clean_warning_reason(reason) for reason in (reasons or [])]
    clean_reasons = [reason for reason in clean_reasons if reason]
    if not clean_reasons:
        return ''
    if len(clean_reasons) == 1:
        return f" Reason: {clean_reasons[0]}"
    return " Reasons: " + "; ".join(clean_reasons)


def _degraded_asset_warning(asset, asset_id):
    reasons = _asset_degraded_reasons(asset)
    return (
        f"Asset {asset_id} is marked as Degraded."
        f"{_warning_reason_text(reasons)} "
        "It can be used, but please verify the limitation before show."
    )


def _apply_exclusive_asset_status(asset, target_status):
    """Set one condition status on an asset. target_status='ok' clears all."""
    for attr in ('is_ooc', 'is_missing', 'is_degraded', 'is_disposed'):
        setattr(asset, attr, False)

    if target_status == 'ooc':
        asset.is_ooc = True
    elif target_status == 'missing':
        asset.is_missing = True
    elif target_status == 'degraded':
        asset.is_degraded = True
    elif target_status in ('disposed', 'decommissioned'):
        asset.is_disposed = True


def _normalise_asset_status_flags(asset):
    """Repair any legacy/conflicting flags to one status only."""
    _apply_exclusive_asset_status(asset, _asset_condition_status(asset))


def _status_changes_for_request(data, current_status=None):
    """Return (target_status, changes, error).

    target_status is one of: None, 'ok', 'ooc', 'missing', 'degraded', 'decommissioned'.
    None means no status change requested.
    """
    data = data or {}
    current_status = _normalise_asset_status_name(current_status)
    if current_status == 'available':
        current_status = 'ok'

    def clear_current_status_change():
        if current_status in ASSET_CONDITION_STATUSES:
            return 'ok', [make_change(current_status, action='cleared')]
        return None, []

    explicit = (
        data.get('assetStatus') or
        data.get('editAssetStatus') or
        data.get('statusValue') or
        data.get('statusChange') or
        data.get('targetStatus')
    )

    if explicit is not None:
        value = str(explicit).strip().lower()
        aliases = {
            '': None,
            'none': None,
            'nochange': None,
            'no-change': None,
            'ok': 'ok',
            'okay': 'ok',
            'available': 'ok',
            'clear': 'ok',
            'cleared': 'ok',
            'normal': 'ok',
            'ooc': 'ooc',
            'out-of-commission': 'ooc',
            'out_of_commission': 'ooc',
            'missing': 'missing',
            'degraded': 'degraded',
            'decommissioned': 'decommissioned',
            'disposed': 'decommissioned',
        }
        if value not in aliases:
            return None, [], f'Invalid asset status: {explicit}'
        target = aliases[value]
        if target is None:
            return None, [], None
        if target == 'ok':
            target, changes = clear_current_status_change()
            return target, changes, None
        return target, [make_change(target, action='marked')], None

    mark_flags = {
        'ooc': bool(data.get('markOOC', False)),
        'missing': bool(data.get('markMissing', False)),
        'degraded': bool(data.get('markDegraded', False)),
        'decommissioned': bool(data.get('markDecommissioned', False) or data.get('markDisposed', False)),
    }
    marked = [kind for kind, enabled in mark_flags.items() if enabled]
    if len(marked) > 1:
        return None, [], 'Choose only one asset status at a time'
    if marked:
        target = marked[0]
        return target, [make_change(target, action='marked')], None

    clear_flags = {
        'ooc': bool(data.get('unmarkOOC', False)),
        'missing': bool(data.get('unmarkMissing', False)),
        'degraded': bool(data.get('unmarkDegraded', False)),
        'decommissioned': bool(data.get('unmarkDecommissioned', False) or data.get('unmarkDisposed', False)),
    }
    cleared = [kind for kind, enabled in clear_flags.items() if enabled]
    if cleared:
        if set(cleared) == set(ASSET_CONDITION_STATUSES):
            target, changes = clear_current_status_change()
            return target, changes, None
        target = 'ok' if current_status in cleared else None
        return target, [make_change(kind, action='cleared') for kind in cleared], None

    return None, [], None


def _maintenance_log_type_for_request(data, default_type=DEFAULT_MAINTENANCE_LOG_TYPE, allow_asset_check=False):
    """Return (log_type, error) for a maintenance log type submitted by the UI."""
    data = data or {}
    raw_type = None
    for key in ('logType', 'maintenanceType', 'type'):
        if key in data:
            raw_type = data.get(key)
            break

    if raw_type is None or str(raw_type).strip() == '':
        return default_type or DEFAULT_MAINTENANCE_LOG_TYPE, None

    log_type = normalize_maintenance_log_type(raw_type, allow_asset_check=allow_asset_check)
    if not log_type:
        user_options = ', '.join(USER_MAINTENANCE_LOG_TYPES)
        if str(raw_type).strip().lower() == ASSET_CHECK_LOG_TYPE.lower():
            return None, 'Asset check logs can only be created by the Asset Check function'
        return None, f'Invalid maintenance log type. Choose one of: {user_options}'

    return log_type, None


def _request_bool(value, default=False):
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    return str(value).strip().lower() in ('1', 'true', 'yes', 'y', 'on')


def _validate_status_transition(asset, target_status, current_status=None):
    """Validate a requested condition status.

    Condition statuses are mutually exclusive, and applying a new one clears
    the previous one. Direct transitions such as OOC to Missing are valid.
    """
    return None


def _condition_status_before_log(asset, exclude_index, selected_date=None):
    """Calculate an asset's condition status immediately before one selected log."""
    scratch = SimpleNamespace(
        asset_id=getattr(asset, 'asset_id', ''),
        is_ooc=False,
        is_missing=False,
        is_degraded=False,
        is_disposed=False,
        serial_number=getattr(asset, 'serial_number', ''),
        current_location='',
    )

    logs = getattr(asset, 'maintenance_logs', []) or []
    if exclude_index < 0 or exclude_index >= len(logs):
        return _asset_condition_status(scratch)

    def log_sort_date(record):
        try:
            return datetime.strptime(record.get('date', ''), "%Y/%m/%d")
        except ValueError:
            return datetime.min

    selected_record = normalize_maintenance_log(logs[exclude_index])
    selected_sort_key = (
        log_sort_date({**selected_record, 'date': selected_date or selected_record.get('date', '')}),
        exclude_index
    )

    sorted_logs = []
    for i, log_entry in enumerate(logs):
        if i == exclude_index:
            continue
        record = normalize_maintenance_log(log_entry)
        sorted_logs.append((log_sort_date(record), i, record))

    sorted_logs.sort(key=lambda x: (x[0], x[1]))
    for date_obj, index, record in sorted_logs:
        if (date_obj, index) >= selected_sort_key:
            break
        apply_maintenance_log_changes(scratch, record)

    return _asset_condition_status(scratch)


def _status_action_label(target_status):
    return {
        'ok': 'OK',
        'ooc': 'OOC',
        'missing': 'Missing',
        'degraded': 'Degraded',
        'decommissioned': 'Decommissioned',
    }.get(target_status or '', '')


def _asset_prepare_block_reason(asset):
    if not asset:
        return 'Asset not found'
    if _is_disposed(asset):
        return 'Asset is decommissioned and cannot be prepared'
    if getattr(asset, 'is_missing', False):
        return 'Asset is marked as missing'
    if getattr(asset, 'is_ooc', False):
        return 'Asset is out of commission'
    return ''


def _payload_bool(data, keys, default=None):
    for key in keys:
        if key in data:
            return _request_bool(data.get(key), False)
    return default


def _prepare_scan_options(data):
    """Return options that control whether scanned extras become event demand."""
    data = data or {}
    prepare_source = str(data.get('source') or data.get('prepareSource') or '').strip().lower()
    from_container = bool(
        data.get('fromContainer') or
        data.get('isContainerBatch') or
        prepare_source in ('container', 'quick-add-container')
    )
    explicit_quick_add = _payload_bool(
        data,
        ('quickAdd', 'quick_add', 'addScannedAssetsToEvent', 'addToEvent'),
        default=None
    )

    return {
        'source': prepare_source,
        'fromContainer': from_container,
        'quickAddSpecified': explicit_quick_add is not None,
        # Existing container scans historically became part of the event. An
        # explicit quickAdd=false from the UI now overrides that legacy default.
        'addScannedAssetsToEvent': bool(from_container if explicit_quick_add is None else explicit_quick_add),
    }


def _verify_current_admin_password(password):
    username = session.get('user')
    user = data_manager.users.get(username) if data_manager else None

    if not user or not getattr(user, 'is_admin', False):
        return False, 'Admin privileges required'

    if not password:
        return False, 'Admin password is required'

    if hash_password(str(password), user.salt) != user.password_hash:
        return False, 'Admin password is incorrect'

    return True, ''


def _find_inventory_asset_by_identifier(identifier):
    """Find an inventory item from a scanned Asset ID or either Serial Number."""
    identifier = str(identifier or '').strip()
    if not identifier:
        return None

    if identifier in data_manager.inventory:
        return data_manager.inventory[identifier]

    identifier_lower = identifier.lower()
    for asset in data_manager.inventory.values():
        if not asset:
            continue
        if str(getattr(asset, 'asset_id', '') or '').strip().lower() == identifier_lower:
            return asset
        for serial in (
            getattr(asset, 'serial_number', ''),
            getattr(asset, 'secondary_serial_number', ''),
        ):
            serial = str(serial or '').strip()
            if serial and serial.lower() == identifier_lower:
                return asset

    return None


def _bulk_marker(bulk_id, quantity):
    return f"[BULK]{bulk_id}|{max(1, _safe_int(quantity, 1))}"


def _parse_bulk_marker(value):
    if not isinstance(value, str) or not value.startswith('[BULK]'):
        return None

    raw = value[6:]
    if '|' in raw:
        bulk_id, quantity = raw.split('|', 1)
    else:
        bulk_id, quantity = raw, '1'

    bulk_id = bulk_id.strip()
    quantity = max(1, _safe_int(quantity, 1))

    if not bulk_id:
        return None

    return {'bulkId': bulk_id, 'quantity': quantity}


CUSTOM_ASSET_PREFIX = '[CUSTOM]'


def _ensure_event_custom_lists(event):
    if not hasattr(event, 'prepared_items') or event.prepared_items is None:
        event.prepared_items = []
    if not hasattr(event, 'actually_prepared') or event.actually_prepared is None:
        event.actually_prepared = []
    if not hasattr(event, 'returned_items') or event.returned_items is None:
        event.returned_items = []
    if not hasattr(event, 'extra_assets') or event.extra_assets is None:
        event.extra_assets = []
    if not hasattr(event, 'custom_collected') or event.custom_collected is None:
        event.custom_collected = []


def _remove_direct_asset_ref_from_prepared_items(event, asset_id):
    """Remove duplicated physical refs when a model row owns the requirement."""
    if not event or not asset_id:
        return 0
    if not hasattr(event, 'prepared_items') or event.prepared_items is None:
        event.prepared_items = []
        return 0

    before = len(event.prepared_items)
    event.prepared_items[:] = [ref for ref in event.prepared_items if ref != asset_id]
    return before - len(event.prepared_items)


def _normalise_custom_type(asset_type):
    value = str(asset_type or 'MISC').strip().upper()
    return 'LOAN' if value in ('LOAN', 'RENTAL', 'LOAN/RENTAL', 'RENT') else 'MISC'


def _make_custom_marker(asset_type, name, quantity=1, department='UN', company='', uid=None):
    payload = {
        'uid': str(uid or secrets.token_hex(8)),
        'type': _normalise_custom_type(asset_type),
        'name': str(name or '').strip(),
        'quantity': max(1, _safe_int(quantity, 1)),
        'department': _normalise_department_code(department) or 'UN',
        'company': str(company or '').strip(),
        'version': 2
    }
    return CUSTOM_ASSET_PREFIX + json.dumps(payload, separators=(',', ':'), sort_keys=True)


def _parse_legacy_custom_marker(value):
    if not isinstance(value, str):
        return None

    raw_value = value.strip()
    lowered = raw_value.lower()

    # Very old data markers sometimes used loan|... or misc|...
    if lowered.startswith('loan|') or lowered.startswith('misc|'):
        fallback_type, remainder = raw_value.split('|', 1)
        parsed = _parse_legacy_custom_marker(remainder)
        if parsed:
            parsed['type'] = _normalise_custom_type(fallback_type)
            return parsed

    if raw_value.startswith('[MISC]'):
        asset_type = 'MISC'
        raw = raw_value[len('[MISC]'):]
    elif raw_value.startswith('[LOAN]'):
        asset_type = 'LOAN'
        raw = raw_value[len('[LOAN]'):]
    else:
        return None

    name = raw.strip()
    quantity = 1
    if ';' in raw:
        maybe_name, maybe_quantity = raw.rsplit(';', 1)
        parsed_quantity = _safe_int(maybe_quantity, 0)
        if parsed_quantity > 0:
            name = maybe_name.strip()
            quantity = parsed_quantity

    return {
        'id': value,
        'uid': '',
        'type': asset_type,
        'name': name or ('Loan/Rental Item' if asset_type == 'LOAN' else 'Misc Item'),
        'quantity': max(1, quantity),
        'department': 'UN',
        'company': '',
        'version': 1,
        'legacy': True
    }


def _parse_custom_marker(value):
    if not isinstance(value, str):
        return None

    if value.startswith(CUSTOM_ASSET_PREFIX):
        try:
            payload = json.loads(value[len(CUSTOM_ASSET_PREFIX):])
        except Exception:
            return None

        asset_type = _normalise_custom_type(payload.get('type'))
        name = str(payload.get('name') or '').strip() or ('Loan/Rental Item' if asset_type == 'LOAN' else 'Misc Item')
        quantity = max(1, _safe_int(payload.get('quantity'), 1))
        department = _normalise_department_code(payload.get('department')) or 'UN'
        company = str(payload.get('company') or '').strip()

        return {
            'id': value,
            'uid': str(payload.get('uid') or ''),
            'type': asset_type,
            'name': name,
            'quantity': quantity,
            'department': department,
            'company': company,
            'version': _safe_int(payload.get('version'), 2),
            'legacy': False
        }

    return _parse_legacy_custom_marker(value)


def _is_custom_ref(value):
    return _parse_custom_marker(value) is not None


def _custom_display_name(custom):
    qty = max(1, _safe_int(custom.get('quantity'), 1))
    name = str(custom.get('name') or '').strip()
    return f"{qty}x {name}"


def _custom_status(event, marker):
    _ensure_event_custom_lists(event)
    custom = _parse_custom_marker(marker)
    if not custom:
        return 'assigned'

    if marker in event.returned_items:
        return 'returned'
    if marker in event.actually_prepared:
        return 'prepared'
    if custom['type'] == 'LOAN' and marker in event.custom_collected:
        return 'collected'
    return 'assigned'


def _custom_counts_for_event(event):
    _ensure_event_custom_lists(event)
    required = 0
    prepared_active = 0
    prepared_ever = 0
    returned = 0
    started = 0
    collected = 0

    for marker in event.prepared_items:
        custom = _parse_custom_marker(marker)
        if not custom:
            continue

        qty = max(1, _safe_int(custom.get('quantity'), 1))
        required += qty
        is_returned = marker in event.returned_items
        is_prepared = marker in event.actually_prepared
        is_collected = custom['type'] == 'LOAN' and marker in event.custom_collected

        if is_collected:
            collected += qty
            started += qty
        if is_prepared or is_returned:
            prepared_ever += qty
            started += qty
        if is_prepared and not is_returned:
            prepared_active += qty
        if is_returned:
            returned += qty

    return {
        'required': required,
        'preparedActive': prepared_active,
        'preparedEver': prepared_ever,
        'returned': returned,
        'started': started,
        'collected': collected
    }


PLANNING_TEMPLATES_FILENAME = 'PlanningTemplates.json'


def _planning_templates_path():
    folder = data_manager.data_folder if data_manager else './data'
    return os.path.join(folder, PLANNING_TEMPLATES_FILENAME)


def _normalise_planning_template_model(value):
    value = value if isinstance(value, dict) else {}
    department = _normalise_department_code(value.get('department')) or 'UN'
    brand = str(value.get('brand') or '').strip()
    model = str(value.get('model') or '').strip()
    description = str(value.get('description') or '').strip()
    quantity = max(1, _safe_int(value.get('quantity'), 1))
    if not brand or not model:
        return None
    return {
        'department': department,
        'brand': brand,
        'model': model,
        'description': description,
        'quantity': quantity,
    }


def _normalise_planning_template_custom(value):
    value = value if isinstance(value, dict) else {}
    asset_type = _normalise_custom_type(value.get('type'))
    name = str(value.get('name') or '').strip()
    if not name:
        return None
    return {
        'type': asset_type,
        'name': name,
        'quantity': max(1, _safe_int(value.get('quantity'), 1)),
        'department': _normalise_department_code(value.get('department')) or 'UN',
        'company': str(value.get('company') or '').strip(),
    }


def _normalise_planning_template(value):
    value = value if isinstance(value, dict) else {}
    template_id = re.sub(
        r'[^a-zA-Z0-9_-]+',
        '',
        str(value.get('id') or ''),
    )[:80] or secrets.token_hex(8)
    name = str(value.get('name') or '').strip()[:120]
    models = []
    custom_assets = []

    for row in value.get('models') or []:
        normalised = _normalise_planning_template_model(row)
        if normalised:
            models.append(normalised)

    for row in value.get('customAssets') or value.get('custom_assets') or []:
        normalised = _normalise_planning_template_custom(row)
        if normalised:
            custom_assets.append(normalised)

    return {
        'id': template_id,
        'name': name or 'Untitled Template',
        'models': models,
        'customAssets': custom_assets,
        'createdAt': str(value.get('createdAt') or value.get('created_at') or ''),
        'updatedAt': str(value.get('updatedAt') or value.get('updated_at') or ''),
    }


def _load_planning_templates():
    filepath = _planning_templates_path()
    if not os.path.exists(filepath) or os.path.getsize(filepath) == 0:
        return []

    try:
        with open(filepath, 'r', encoding='utf-8') as template_file:
            payload = json.load(template_file)
    except Exception as exc:
        logger.warning("Failed to read %s: %s", PLANNING_TEMPLATES_FILENAME, exc)
        return []

    rows = payload.get('templates', []) if isinstance(payload, dict) else payload
    if not isinstance(rows, list):
        return []

    templates = [_normalise_planning_template(row) for row in rows]
    templates.sort(key=lambda item: item['name'].lower())
    return templates


def _save_planning_templates(templates):
    filepath = _planning_templates_path()
    folder = os.path.dirname(filepath)
    if folder and not os.path.exists(folder):
        os.makedirs(folder)

    payload = {
        'version': 1,
        'templates': [_normalise_planning_template(row) for row in templates],
    }
    tmp_path = f"{filepath}.{secrets.token_hex(6)}.tmp"
    with open(tmp_path, 'w', encoding='utf-8') as template_file:
        json.dump(payload, template_file, ensure_ascii=False, indent=2)
    os.replace(tmp_path, filepath)
    return payload['templates']


def _event_planning_template_contents(event):
    model_groups = {}
    custom_groups = {}

    for ref in getattr(event, 'prepared_items', []) or []:
        marker = _parse_model_marker(ref)
        if marker:
            key = _model_key_from_parts(
                marker['department'],
                marker['brand'],
                marker['model'],
            )
            if key not in model_groups:
                model_groups[key] = {
                    'department': marker['department'],
                    'brand': marker['brand'],
                    'model': marker['model'],
                    'description': marker.get('description') or '',
                    'quantity': 0,
                }
            model_groups[key]['quantity'] += max(1, _safe_int(marker.get('quantity'), 1))
            if not model_groups[key]['description'] and marker.get('description'):
                model_groups[key]['description'] = marker['description']
            continue

        custom = _parse_custom_marker(ref)
        if not custom:
            continue
        key = (
            custom['type'],
            custom['name'].strip().lower(),
            custom['department'],
            custom.get('company', '').strip().lower(),
        )
        if key not in custom_groups:
            custom_groups[key] = {
                'type': custom['type'],
                'name': custom['name'],
                'quantity': 0,
                'department': custom['department'],
                'company': custom.get('company') or '',
            }
        custom_groups[key]['quantity'] += max(1, _safe_int(custom.get('quantity'), 1))

    models = sorted(
        model_groups.values(),
        key=lambda row: (
            row['department'],
            row['brand'].lower(),
            row['model'].lower(),
        ),
    )
    custom_assets = sorted(
        custom_groups.values(),
        key=lambda row: (
            row['department'],
            row['name'].lower(),
            row['type'],
        ),
    )
    return {'models': models, 'customAssets': custom_assets}


def _planning_model_inventory_quantity(row):
    group_key = _model_key_from_parts(
        row['department'],
        row['brand'],
        row['model'],
    )
    return sum(
        _asset_inventory_quantity(asset)
        for asset in data_manager.inventory.values()
        if asset
        and not getattr(asset, 'is_missing', False)
        and not _is_disposed(asset)
        and _asset_group_key(asset) == group_key
    )


def _apply_planning_template_to_event(event, template, mode):
    replace = mode == 'replace'
    current_models = {}

    if not replace:
        for ref in getattr(event, 'prepared_items', []) or []:
            marker = _parse_model_marker(ref)
            if not marker:
                continue
            key = _model_key_from_parts(
                marker['department'],
                marker['brand'],
                marker['model'],
            )
            if key not in current_models:
                current_models[key] = {
                    'department': marker['department'],
                    'brand': marker['brand'],
                    'model': marker['model'],
                    'description': marker.get('description') or '',
                    'quantity': 0,
                }
            current_models[key]['quantity'] += max(
                1,
                _safe_int(marker.get('quantity'), 1),
            )

    for source_row in template.get('models') or []:
        row = _normalise_planning_template_model(source_row)
        if not row:
            continue
        key = _model_key_from_parts(
            row['department'],
            row['brand'],
            row['model'],
        )
        if key in current_models:
            current_models[key]['quantity'] += row['quantity']
            if not current_models[key]['description'] and row['description']:
                current_models[key]['description'] = row['description']
        else:
            current_models[key] = dict(row)

    for row in current_models.values():
        physical = _planning_model_inventory_quantity(row)
        if row['quantity'] > physical:
            raise ValueError(
                f"{row['brand']} {row['model']} would require "
                f"{row['quantity']} unit(s), but only {physical} are in inventory"
            )

    prepared_items = []
    for ref in getattr(event, 'prepared_items', []) or []:
        if _parse_model_marker(ref):
            continue
        if replace and _parse_custom_marker(ref):
            continue
        prepared_items.append(ref)

    for row in sorted(
        current_models.values(),
        key=lambda item: (
            item['department'],
            item['brand'].lower(),
            item['model'].lower(),
        ),
    ):
        prepared_items.append(_make_model_marker(row, row['quantity']))

    added_custom_markers = []
    for source_row in template.get('customAssets') or []:
        row = _normalise_planning_template_custom(source_row)
        if not row:
            continue
        marker = _make_custom_marker(
            row['type'],
            row['name'],
            row['quantity'],
            row['department'],
            row['company'],
        )
        prepared_items.append(marker)
        added_custom_markers.append(marker)

    event.prepared_items = prepared_items
    _ensure_event_custom_lists(event)

    if replace:
        event.actually_prepared = [
            ref for ref in event.actually_prepared
            if not _parse_custom_marker(ref)
        ]
        event.returned_items = [
            ref for ref in event.returned_items
            if not _parse_custom_marker(ref)
        ]
        event.extra_assets = [
            ref for ref in event.extra_assets
            if not _parse_custom_marker(ref)
        ]
        event.custom_collected = [
            ref for ref in event.custom_collected
            if not _parse_custom_marker(ref)
        ]

    update_event_state(event)
    data_manager.save_event(event)
    invalidate_cache()

    return {
        'mode': mode,
        'modelCount': len(current_models),
        'customAssetCount': len(added_custom_markers),
    }


def _event_returnable_counts(event):
    """Return quantity counts for items that can currently be returned.

    This intentionally treats collected loan/rental items as returnable even if
    they were never finally prepared, because once they are collected from a
    rental company, they may still need to be returned.
    """
    _ensure_event_custom_lists(event)

    returned_values = set(getattr(event, 'returned_items', []) or [])
    active_refs = []
    seen_active = set()

    def add_active(ref):
        if not isinstance(ref, str) or not ref or ref in returned_values or ref in seen_active:
            return
        active_refs.append(ref)
        seen_active.add(ref)

    # Anything actually prepared is returnable unless already returned.
    for ref in getattr(event, 'actually_prepared', []) or []:
        add_active(ref)

    # Loan/rental items become returnable as soon as they are collected.
    for ref in getattr(event, 'prepared_items', []) or []:
        custom = _parse_custom_marker(ref)
        if not custom:
            continue
        if custom.get('type') == 'LOAN' and ref in getattr(event, 'custom_collected', []):
            add_active(ref)

    def ref_quantity(ref):
        custom = _parse_custom_marker(ref)
        if custom:
            return max(1, _safe_int(custom.get('quantity'), 1))

        bulk = _parse_bulk_marker(ref)
        if bulk:
            return max(1, _safe_int(bulk.get('quantity'), 1))

        return 1

    active_quantity = sum(ref_quantity(ref) for ref in active_refs)
    returned_quantity = sum(ref_quantity(ref) for ref in returned_values)

    return {
        'returnable': active_quantity,
        'returned': returned_quantity,
        'total': active_quantity + returned_quantity,
        'refs': active_refs
    }


def _event_specific_counts(event):
    """Counts non-model, non-custom, non-bulk direct asset rows for legacy/direct workflows.

    Assets explicitly marked as extra are deliberately excluded from these totals.
    This keeps manually over-prepared assets visible without letting them raise
    the event's required count or complete an otherwise incomplete event.
    """
    _ensure_event_custom_lists(event)
    extra_assets = set(getattr(event, 'extra_assets', []) or [])
    required = 0
    prepared_active = 0
    prepared_ever = 0
    returned = 0

    for item in event.prepared_items:
        if not isinstance(item, str):
            continue
        if item in extra_assets:
            continue
        if item.startswith('[MODEL]') or _is_bulk_ref(item) or _is_custom_ref(item):
            continue
        required += 1

    all_seen = set(event.actually_prepared or []) | set(event.returned_items or [])
    for item in all_seen:
        if not isinstance(item, str):
            continue
        if item in extra_assets:
            continue
        if item.startswith('[MODEL]') or _is_bulk_ref(item) or _is_custom_ref(item):
            continue
        if item in event.returned_items:
            returned += 1
            prepared_ever += 1
        elif item in event.actually_prepared:
            prepared_active += 1
            prepared_ever += 1

    return {
        'required': required,
        'preparedActive': prepared_active,
        'preparedEver': prepared_ever,
        'returned': returned
    }


def _event_extra_asset_quantity(event):
    """Active manual extras for the Event Summary card.

    Returned extras are no longer active extras. Custom and bulk quantities are
    respected if they are ever marked extra. Regular physical assets count as 1.
    """
    _ensure_event_custom_lists(event)
    returned_values = set(getattr(event, 'returned_items', []) or [])
    active_values = set(getattr(event, 'actually_prepared', []) or []) | set(getattr(event, 'prepared_items', []) or [])
    total = 0

    for ref in getattr(event, 'extra_assets', []) or []:
        if ref in returned_values:
            continue
        if ref not in active_values:
            continue

        custom = _parse_custom_marker(ref)
        if custom:
            total += max(1, _safe_int(custom.get('quantity'), 1))
            continue

        bulk = _parse_bulk_marker(ref)
        if bulk:
            total += max(1, _safe_int(bulk.get('quantity'), 1))
            continue

        total += 1

    return total


def _is_bulk_ref(value):
    return _parse_bulk_marker(value) is not None


def _model_key_from_parts(dept, brand, model, description=''):
    return (
        _clean_group_value(dept, True),
        _clean_group_value(brand),
        _clean_group_value(model),
        ''
    )


def _event_physical_ref_group_key(value):
    """Return the inventory model key represented by an event physical ref."""
    marker = _parse_bulk_marker(value)
    asset_id = marker['bulkId'] if marker else value
    asset = data_manager.inventory.get(asset_id) if data_manager else None
    if not asset:
        return None
    return _asset_group_key(asset)


def _unprepare_event_model_group(event, group_key):
    """Detach all prepared/returned physical refs for one model from an event."""
    _ensure_event_custom_lists(event)

    prepared_units = 0
    references_removed = 0
    inventory_changed = False

    for ref in getattr(event, 'actually_prepared', []) or []:
        if _event_physical_ref_group_key(ref) != group_key:
            continue
        marker = _parse_bulk_marker(ref)
        prepared_units += marker['quantity'] if marker else 1

    for list_name in ('prepared_items', 'actually_prepared', 'returned_items', 'extra_assets'):
        values = getattr(event, list_name, []) or []
        kept = []
        for ref in values:
            # Model requirement rows are removed separately, after their physical
            # assets have been unprepared.
            if list_name == 'prepared_items' and isinstance(ref, str) and ref.startswith('[MODEL]'):
                kept.append(ref)
                continue

            if _event_physical_ref_group_key(ref) != group_key:
                kept.append(ref)
                continue

            references_removed += 1
            marker = _parse_bulk_marker(ref)
            if marker:
                continue

            asset = data_manager.inventory.get(ref)
            if asset and not _is_bulk_asset(asset):
                default_location = asset.default_location or ''
                if asset.current_location != default_location:
                    asset.current_location = default_location
                    inventory_changed = True

        setattr(event, list_name, kept)

    if inventory_changed:
        data_manager.save_inventory()

    return {
        'preparedUnits': prepared_units,
        'referencesRemoved': references_removed,
    }


def _bulk_quantity_in_values_for_key(values, group_key):
    total = 0
    for value in values or []:
        marker = _parse_bulk_marker(value)
        if not marker:
            continue

        bulk_asset = data_manager.inventory.get(marker['bulkId']) if data_manager else None
        if not bulk_asset or not _is_bulk_asset(bulk_asset):
            continue

        if _asset_group_key(bulk_asset) == group_key:
            total += marker['quantity']

    return total


def _bulk_quantity_for_asset_in_values(values, bulk_id):
    total = 0
    for value in values or []:
        marker = _parse_bulk_marker(value)
        if marker and marker['bulkId'] == bulk_id:
            total += marker['quantity']
    return total


def _format_event_date_for_response(date_value):
    if not date_value:
        return ''
    try:
        return format_date_output(date_value)
    except Exception:
        return str(date_value)


def _bulk_deployments_for_asset(bulk_id):
    deployments = []
    if not bulk_id or not data_manager:
        return deployments

    for event in data_manager.events.values():
        prepared_qty = _bulk_quantity_for_asset_in_values(
            getattr(event, 'actually_prepared', []) or [],
            bulk_id
        )
        returned_qty = _bulk_quantity_for_asset_in_values(
            getattr(event, 'returned_items', []) or [],
            bulk_id
        )
        deployed_qty = max(prepared_qty - returned_qty, 0)
        if deployed_qty <= 0:
            continue

        deployments.append({
            'eventId': event.event_id,
            'eventName': getattr(event, 'name', '') or f"Event {event.event_id}",
            'startDate': _format_event_date_for_response(getattr(event, 'start_date', '')),
            'endDate': _format_event_date_for_response(getattr(event, 'end_date', '')),
            'quantity': deployed_qty,
            '_sortStartDate': getattr(event, 'start_date', '') or '',
            '_sortEndDate': getattr(event, 'end_date', '') or '',
        })

    deployments.sort(key=lambda row: (row['_sortStartDate'], row['_sortEndDate'], row['eventId']))
    for row in deployments:
        row.pop('_sortStartDate', None)
        row.pop('_sortEndDate', None)

    return deployments


def _event_model_quantities_by_key(event):
    totals = defaultdict(int)
    for item in getattr(event, 'prepared_items', []) or []:
        key, quantity = _parse_model_assignment_key(item)
        if key:
            totals[key] += quantity
    return totals


def _event_active_specific_quantities_by_key(event):
    """Count specific inventory assets still tied up by one event.

    Regular asset IDs count as one unit. Bulk markers count their marker
    quantity. Returned references are ignored because those units are back in
    stock for overlapping-date availability.
    """
    totals = defaultdict(int)
    if not event:
        return totals

    returned = set(getattr(event, 'returned_items', []) or [])
    seen_regular_assets = set()
    seen_bulk_markers = set()

    for values in (
        getattr(event, 'prepared_items', []) or [],
        getattr(event, 'actually_prepared', []) or [],
    ):
        for ref in values:
            if not isinstance(ref, str) or not ref or ref in returned:
                continue

            marker = _parse_bulk_marker(ref)
            if marker:
                marker_key = (marker['bulkId'], marker['quantity'], ref)
                if marker_key in seen_bulk_markers:
                    continue
                seen_bulk_markers.add(marker_key)

                bulk_asset = data_manager.inventory.get(marker['bulkId']) if data_manager else None
                if not bulk_asset or not _is_bulk_asset(bulk_asset):
                    continue
                if getattr(bulk_asset, 'is_missing', False) or _is_disposed(bulk_asset):
                    continue
                totals[_asset_group_key(bulk_asset)] += marker['quantity']
                continue

            if ref.startswith('[MODEL]') or _is_custom_ref(ref):
                continue

            if ref in seen_regular_assets:
                continue
            seen_regular_assets.add(ref)

            asset = data_manager.inventory.get(ref) if data_manager else None
            if not asset or _is_bulk_asset(asset):
                continue
            if getattr(asset, 'is_missing', False) or _is_disposed(asset):
                continue
            totals[_asset_group_key(asset)] += 1

    return totals


def _event_reserved_quantities_by_key(event):
    model_quantities = _event_model_quantities_by_key(event)
    specific_quantities = _event_active_specific_quantities_by_key(event)
    reserved = defaultdict(int)

    for key in set(model_quantities.keys()) | set(specific_quantities.keys()):
        reserved[key] = max(model_quantities.get(key, 0), specific_quantities.get(key, 0))

    return reserved


def _active_physical_asset_refs_for_event(event):
    """Specific non-bulk asset IDs assigned/prepared for an event and not returned."""
    refs = set()
    if not event:
        return refs

    returned = set(getattr(event, 'returned_items', []) or [])
    for values in (
        getattr(event, 'prepared_items', []) or [],
        getattr(event, 'actually_prepared', []) or [],
    ):
        for ref in values:
            if not isinstance(ref, str) or not ref or ref in returned:
                continue
            if ref.startswith('[MODEL]') or _is_bulk_ref(ref) or _is_custom_ref(ref):
                continue
            if ref in data_manager.inventory:
                refs.add(ref)

    return refs


def _find_event_using_asset(asset_id, target_event, require_overlap=False):
    if not asset_id or not target_event:
        return None

    my_start = getattr(target_event, 'start_date', '')
    my_end = getattr(target_event, 'end_date', '')

    for other in data_manager.events.values():
        if not other or other.event_id == target_event.event_id:
            continue
        if require_overlap and not _ranges_overlap(my_start, my_end, getattr(other, 'start_date', ''), getattr(other, 'end_date', '')):
            continue
        if asset_id in _active_physical_asset_refs_for_event(other):
            return other

    return None


def _sum_assigned_quantity(model_group, include_extra=True):
    """Quantity assigned to a model group.

    include_extra=True is used for the model card itself, so it can show
    values such as 5/3 assigned (+2 extra). include_extra=False is used for
    event/department readiness totals, where manual extras must not complete
    missing required assets.
    """
    total = 0
    for asset in model_group.get('assignedAssets', []) or []:
        if not include_extra and asset.get('isExtra'):
            continue
        total += max(1, _safe_int(asset.get('quantity', 1), 1))
    return total


def _sum_returned_quantity(model_group, include_extra=True):
    total = 0
    for asset in model_group.get('assignedAssets', []) or []:
        if not include_extra and asset.get('isExtra'):
            continue
        if asset.get('status') == 'returned':
            total += max(1, _safe_int(asset.get('quantity', 1), 1))
    return total


def _sum_prepared_quantity(model_group, include_extra=True):
    assigned = _sum_assigned_quantity(model_group, include_extra=include_extra)
    returned = _sum_returned_quantity(model_group, include_extra=include_extra)
    return max(assigned - returned, 0)


def _sum_extra_prepared_quantity(model_group):
    total = 0
    for asset in model_group.get('assignedAssets', []) or []:
        if not asset.get('isExtra'):
            continue
        if asset.get('status') == 'returned':
            continue
        total += max(1, _safe_int(asset.get('quantity', 1), 1))
    return total


def _refresh_model_group_statuses(model_groups):
    for group in (model_groups or {}).values():
        required = max(0, _safe_int(group.get('requiredQuantity', 0), 0))

        # Display quantities include extras so each model section can show
        # "5/3 assigned (+2 extra)" and list the extra assets under Assigned Assets.
        assigned = _sum_assigned_quantity(group, include_extra=True)
        returned = _sum_returned_quantity(group, include_extra=True)
        prepared = max(assigned - returned, 0)

        # Countable quantities exclude manual extras. These drive readiness,
        # event totals, and department progress totals.
        countable_assigned = _sum_assigned_quantity(group, include_extra=False)
        countable_returned = _sum_returned_quantity(group, include_extra=False)
        countable_prepared = max(countable_assigned - countable_returned, 0)

        group['assignedQuantity'] = assigned
        group['returnedQuantity'] = returned
        group['preparedQuantity'] = prepared
        group['countableAssignedQuantity'] = countable_assigned
        group['countableReturnedQuantity'] = countable_returned
        group['countablePreparedQuantity'] = min(countable_prepared, required) if required > 0 else countable_prepared
        group['extraPreparedQuantity'] = _sum_extra_prepared_quantity(group)

        # Status must be based only on required/countable assets. Extras should
        # never make an incomplete requirement look ready.
        if required > 0 and countable_returned >= required and countable_assigned > 0:
            group['status'] = 'returned'
        elif required > 0 and countable_prepared >= required:
            group['status'] = 'ready'
        elif countable_prepared > 0:
            group['status'] = 'partial'
        else:
            group['status'] = 'pending'


def _append_bulk_assignments_to_model_groups(model_groups, event):
    if not model_groups:
        return

    returned_values = set(getattr(event, 'returned_items', []) or [])
    seen = set()

    for value in getattr(event, 'actually_prepared', []) or []:
        marker = _parse_bulk_marker(value)
        if not marker:
            continue

        bulk_asset = data_manager.inventory.get(marker['bulkId']) if data_manager else None
        if not bulk_asset or not _is_bulk_asset(bulk_asset):
            continue

        group_key = '|'.join(_asset_group_key(bulk_asset))
        if group_key not in model_groups:
            continue

        unique_key = (value, group_key)
        if unique_key in seen:
            continue
        seen.add(unique_key)

        model_groups[group_key]['assignedAssets'].append({
            'id': value,
            'bulkId': marker['bulkId'],
            'serial': '',
            'status': 'returned' if value in returned_values else 'prepared',
            'location': bulk_asset.current_location or bulk_asset.default_location or '',
            'quantity': marker['quantity'],
            'isBulk': True,
            'displayId': '',
            'name': f"{bulk_asset.brand} {bulk_asset.model_number} {bulk_asset.description}".strip()
        })


def _append_orphan_extra_assignments_to_model_groups(model_groups, event):
    """Show manual extra assets in the model requirement area.

    Manual extras should not raise the event's required quantity, but they should
    still sit beside matching model rows in the prepare modal. If the event did
    not request that model at all, create a 0-required model group so the UI can
    show values such as "1/0 assigned (+1 extra)".
    """
    if model_groups is None:
        return

    _ensure_event_custom_lists(event)
    extra_asset_ids = set(getattr(event, 'extra_assets', []) or [])
    if not extra_asset_ids:
        return

    returned_values = set(getattr(event, 'returned_items', []) or [])
    prepared_or_returned = list(getattr(event, 'actually_prepared', []) or [])
    prepared_or_returned.extend(getattr(event, 'returned_items', []) or [])

    already_grouped = set()
    for group in model_groups.values():
        for assigned in group.get('assignedAssets', []) or []:
            assigned_id = assigned.get('id') if isinstance(assigned, dict) else assigned
            if assigned_id:
                already_grouped.add(assigned_id)

    seen = set()
    for asset_id in prepared_or_returned:
        if asset_id in seen or asset_id in already_grouped:
            continue
        seen.add(asset_id)

        if asset_id not in extra_asset_ids:
            continue
        if not _is_real_asset_ref(asset_id) or _is_bulk_ref(asset_id):
            continue

        asset = data_manager.inventory.get(asset_id) if data_manager else None
        if not asset or _is_bulk_asset(asset):
            continue

        dept, brand, model, description = _asset_group_key(asset)
        model_key = f"{dept}|{brand}|{model}|{description}"

        if model_key not in model_groups:
            model_groups[model_key] = {
                'department': dept,
                'brand': brand,
                'model': model,
                'description': description,
                'requiredQuantity': 0,
                'assignedAssets': [],
                'status': 'pending'
            }

        model_groups[model_key]['assignedAssets'].append({
            'id': asset_id,
            'serial': asset.serial_number,
            'serial2': getattr(asset, 'secondary_serial_number', ''),
            'status': 'returned' if asset_id in returned_values else 'prepared',
            'location': asset.current_location,
            'quantity': 1,
            'isExtra': True
        })


def _bulk_remaining_for_event_group(event, bulk_asset):
    group_key = _asset_group_key(bulk_asset)
    required = 0
    for item in getattr(event, 'prepared_items', []) or []:
        key, quantity = _parse_model_assignment_key(item)
        if key == group_key:
            required += quantity

    prepared = _bulk_quantity_in_values_for_key(getattr(event, 'actually_prepared', []) or [], group_key)
    return max(required - prepared, 0)


def _bulk_available_quantity_for_event(bulk_asset, target_event, require_overlap=False, include_degraded=True):
    if not bulk_asset or not _is_bulk_asset(bulk_asset):
        return 0

    total = max(1, _safe_int(getattr(bulk_asset, 'quantity', 1), 1))
    if getattr(bulk_asset, 'is_missing', False) or getattr(bulk_asset, 'is_ooc', False) or _is_disposed(bulk_asset):
        return 0

    busy = 0
    my_start = getattr(target_event, 'start_date', '')
    my_end = getattr(target_event, 'end_date', '')

    for other in data_manager.events.values():
        if not other or other.event_id == target_event.event_id:
            continue
        if require_overlap and not _ranges_overlap(my_start, my_end, getattr(other, 'start_date', ''), getattr(other, 'end_date', '')):
            continue

        prepared_qty = _bulk_quantity_for_asset_in_values(getattr(other, 'actually_prepared', []) or [], bulk_asset.asset_id)
        returned_qty = _bulk_quantity_for_asset_in_values(getattr(other, 'returned_items', []) or [], bulk_asset.asset_id)
        busy += max(prepared_qty - returned_qty, 0)

    fault_counts = _bulk_maintenance_quantity_counts(bulk_asset)
    unavailable_faults = fault_counts['ooc'] + fault_counts['missing']
    if not include_degraded and _is_degraded(bulk_asset):
        return 0
    if not include_degraded:
        unavailable_faults += fault_counts['degraded']

    return max(total - busy - unavailable_faults, 0)


def _bulk_asset_to_available_dict(asset, target_event=None):
    status = _asset_status_value(asset)
    fault_counts = _bulk_maintenance_quantity_counts(asset)

    if target_event is not None:
        healthy_available_quantity = _bulk_available_quantity_for_event(
            asset,
            target_event,
            include_degraded=False
        )
        preparable_quantity = _bulk_available_quantity_for_event(
            asset,
            target_event,
            include_degraded=True
        )
    else:
        total_quantity = max(1, _safe_int(getattr(asset, 'quantity', 1), 1))
        if getattr(asset, 'is_missing', False) or getattr(asset, 'is_ooc', False) or _is_disposed(asset):
            healthy_available_quantity = 0
            preparable_quantity = 0
        else:
            unavailable_quantity = fault_counts['ooc'] + fault_counts['missing']
            preparable_quantity = max(0, total_quantity - unavailable_quantity)
            healthy_available_quantity = (
                0 if _is_degraded(asset)
                else max(0, total_quantity - unavailable_quantity - fault_counts['degraded'])
            )

    if status not in ('decommissioned', 'missing', 'ooc'):
        if fault_counts['missing'] > 0:
            status = 'missing'
        elif fault_counts['ooc'] > 0:
            status = 'ooc'
        elif fault_counts['degraded'] > 0 or _is_degraded(asset):
            status = 'degraded'

    return {
        'id': asset.asset_id,
        'bulkId': asset.asset_id,
        'displayId': '',
        'brand': asset.brand,
        'model': asset.model_number,
        'description': asset.description or '',
        'serial': '',
        'dateOfPurchase': getattr(asset, 'date_of_purchase', ''),
        'purchaseDate': getattr(asset, 'date_of_purchase', ''),
        'dateAdded': getattr(asset, 'date_added', ''),
        'dateModified': getattr(asset, 'date_modified', ''),
        'changeHistory': getattr(asset, 'change_history', []),
        'department': asset.department_code,
        'location': asset.current_location or asset.default_location,
        'status': status,
        'isMissing': getattr(asset, 'is_missing', False),
        'isOOC': getattr(asset, 'is_ooc', False),
        'isDegraded': _is_degraded(asset),
        'isDisposed': _is_disposed(asset),
        'isBulk': True,
        'quantity': max(1, _safe_int(getattr(asset, 'quantity', 1), 1)),
        'availableQuantity': preparable_quantity,
        'preparableQuantity': preparable_quantity,
        'healthyQuantity': healthy_available_quantity,
        'bulkOOCQuantity': fault_counts['ooc'],
        'bulkMissingQuantity': fault_counts['missing'],
        'bulkDegradedQuantity': fault_counts['degraded'],
        'bulkFaultQuantity': fault_counts['total'],
        'degradedReasons': _asset_degraded_reasons(asset),
        'bulkDegradedReasons': _bulk_degraded_reasons(asset),
    }

def _parse_model_assignment_key(value):
    """
    Parses:
    [MODEL]DEPT|BRAND|MODEL|QTY|DESCRIPTION

    Returns:
    (key, quantity)
    """
    if not isinstance(value, str) or not value.startswith('[MODEL]'):
        return None, 0

    parts = value[7:].split('|', 4)

    if len(parts) < 4:
        return None, 0

    try:
        quantity = int(parts[3])
    except Exception:
        quantity = 0

    key = (
        _clean_group_value(parts[0], True),
        _clean_group_value(parts[1]),
        _clean_group_value(parts[2]),
        ''
    )

    return key, quantity


def _asset_to_available_dict(asset):
    if _is_bulk_asset(asset):
        return _bulk_asset_to_available_dict(asset)

    status = _asset_status_value(asset)

    return {
        'id': asset.asset_id,
        'brand': asset.brand,
        'model': asset.model_number,
        'description': asset.description or '',
        'serial': asset.serial_number,
        'serial2': getattr(asset, 'secondary_serial_number', ''),
        'dateOfPurchase': getattr(asset, 'date_of_purchase', ''),
        'purchaseDate': getattr(asset, 'date_of_purchase', ''),
        'dateAdded': getattr(asset, 'date_added', ''),
        'dateModified': getattr(asset, 'date_modified', ''),
        'changeHistory': getattr(asset, 'change_history', []),
        'department': asset.department_code,
        'location': asset.current_location or asset.default_location,
        'status': status,
        'isMissing': getattr(asset, 'is_missing', False),
        'isOOC': getattr(asset, 'is_ooc', False),
        'isDegraded': _is_degraded(asset),
        'isDisposed': _is_disposed(asset),
        'isBulk': False,
        'quantity': 1,
        'availableQuantity': 1,
        'degradedReasons': _asset_degraded_reasons(asset),
    }

def require_auth(f):
    """Decorator to require authentication"""
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if 'user' not in session:
            if request.path.startswith('/api/'):
                return jsonify({'error': 'Not authenticated'}), 401
            return redirect(url_for('login'))

        username = session.get('user')
        user = data_manager.users.get(username) if data_manager else None

        # If the user was deleted or deactivated after login by someone else,
        # force logout. Self-deactivation waits until the next login.
        if not user or not _current_user_effective_is_active():
            session.clear()
            if request.path.startswith('/api/'):
                return jsonify({'error': 'Account inactive'}), 401
            return redirect(url_for('login'))

        return f(*args, **kwargs)

    return decorated_function

@app.route('/api/assets/available-for-event/<int:event_id>', methods=['GET'])
@require_auth
def get_available_assets_for_event(event_id):
    """
    Return event-aware assets for the prepare dropdown.

    This endpoint intentionally shows only assets that can actually be prepared
    for this event:
      - not missing
      - not decommissioned
      - not out of commission
      - not already prepared/assigned to this same event
      - not specifically out for any other event and not returned

    It does NOT reserve/hide assets simply because another overlapping event has
    an unprepared [MODEL] requirement.  Model requirements are planning demand;
    only a specific prepared asset ID means the physical unit is unavailable.
    """
    try:
        event = data_manager.events.get(event_id)
        if not event:
            return jsonify({'error': 'Event not found'}), 404

        current_event_refs = _active_physical_asset_refs_for_event(event)
        busy_elsewhere = set()

        for other in data_manager.events.values():
            if not other or other.event_id == event_id:
                continue

            busy_elsewhere.update(_active_physical_asset_refs_for_event(other))

        final_list = []

        for asset_id, asset in sorted(data_manager.inventory.items(), key=lambda pair: pair[0]):
            if not asset:
                continue

            if _is_bulk_asset(asset):
                # Bulk assets have quantity-based availability.  Keep this branch
                # separate so partially available bulk items can still appear.
                if getattr(asset, 'is_missing', False) or getattr(asset, 'is_ooc', False) or _is_disposed(asset):
                    continue

                available_quantity = _bulk_available_quantity_for_event(asset, event)
                if available_quantity <= 0:
                    continue

                final_list.append(_bulk_asset_to_available_dict(asset, event))
                continue

            if getattr(asset, 'is_missing', False) or getattr(asset, 'is_ooc', False) or _is_disposed(asset):
                continue

            if asset_id in current_event_refs:
                continue

            if asset_id in busy_elsewhere:
                continue

            final_list.append({
                'id': asset_id,
                'brand': asset.brand,
                'model': asset.model_number,
                'description': getattr(asset, 'description', '') or '',
                'department': asset.department_code,
                'serial': (getattr(asset, 'serial_number', None) or getattr(asset, 'serial', None) or ''),
                'serial2': getattr(asset, 'secondary_serial_number', ''),
                'dateOfPurchase': getattr(asset, 'date_of_purchase', ''),
                'purchaseDate': getattr(asset, 'date_of_purchase', ''),
                'dateAdded': getattr(asset, 'date_added', ''),
                'dateModified': getattr(asset, 'date_modified', ''),
                'changeHistory': getattr(asset, 'change_history', []),
                'location': asset.current_location or asset.default_location or '',
                'status': _asset_status_value(asset),
                'isMissing': getattr(asset, 'is_missing', False),
                'isOOC': getattr(asset, 'is_ooc', False),
                'isDegraded': _is_degraded(asset),
                'isDisposed': _is_disposed(asset),
                'isBulk': False,
                'quantity': 1,
                'availableQuantity': 1,
                'degradedReasons': _asset_degraded_reasons(asset),
            })

        return jsonify({'success': True, 'data': final_list})
    except Exception as e:
        logger.error(f"Error computing available-for-event({event_id}): {e}", exc_info=True)
        return jsonify({'error': 'Failed to compute event-aware availability'}), 500
    
def require_admin(f):
    """Decorator to require admin privileges"""
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if 'user' not in session:
            return jsonify({'error': 'Not authenticated'}), 401

        username = session.get('user')
        user = data_manager.users.get(username) if data_manager else None

        if not user or not _current_user_effective_is_active():
            session.clear()
            return jsonify({'error': 'Account inactive'}), 401

        if not _current_user_effective_is_admin():
            return jsonify({'error': 'Admin privileges required'}), 403

        return f(*args, **kwargs)

    return decorated_function


def require_super_admin(f):
    """Decorator for global company-management actions."""
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if 'user' not in session:
            return jsonify({'error': 'Not authenticated'}), 401

        username = session.get('user')
        user = data_manager.users.get(username) if data_manager else None

        if not user or not _current_user_effective_is_active():
            session.clear()
            return jsonify({'error': 'Account inactive'}), 401

        if not _current_user_is_super_admin():
            return jsonify({'error': 'Super admin privileges required'}), 403

        return f(*args, **kwargs)

    return decorated_function


def _current_user_obj():
    """Return the logged-in User object, or None if the session is stale."""
    username = session.get('user')
    if not username or not data_manager:
        return None
    return data_manager.users.get(username)


def _current_user_is_admin():
    return _current_user_effective_is_admin()


def _parse_maintenance_log_date(log_entry):
    """Parse the date at the start of a maintenance log entry."""
    return parse_maintenance_log_date(log_entry)


def _maintenance_log_permission(asset, log_index, allow_admin=True):
    """Return (allowed, message) for editing/deleting a maintenance log.

    Normal users may only edit logs they wrote, and only within 7 days of the
    log date. Admins may edit/delete any maintenance log.
    """
    username = session.get('user')
    if not username:
        return False, 'Not authenticated'

    logs = getattr(asset, 'maintenance_logs', []) or []
    if log_index < 0 or log_index >= len(logs):
        return False, 'Invalid log index'

    original_log = normalize_maintenance_log(logs[log_index])
    if (original_log.get('source') or {}).get('kind') == CONTAINER_MAINTENANCE_SOURCE:
        return False, 'Container maintenance logs are managed from the container history'

    if allow_admin and _current_user_is_admin():
        return True, ''

    original_user = original_log.get('user', '').strip()

    if original_user != username:
        return False, 'You can only modify maintenance logs that you wrote'

    log_date = _parse_maintenance_log_date(original_log)
    if not log_date:
        return False, 'This maintenance log has an invalid date and cannot be modified by a normal user'

    today = datetime.now().date()
    age_days = (today - log_date).days
    if age_days < 0 or age_days > 7:
        return False, 'Normal users can only modify their own maintenance logs within 7 days'

    return True, ''

def log_action(action):
    """Helper function to log actions."""
    try:
        log_entry = LogEntry(
            timestamp=datetime.now().strftime("%Y/%m/%d %H:%M:%S"),
            user=session.get('user', 'system'),
            action=action
        )

        event_ids = []
        if data_manager and hasattr(data_manager, 'event_ids_from_log_action'):
            event_ids = [
                event_id
                for event_id in data_manager.event_ids_from_log_action(action)
                if event_id in data_manager.events
            ]

        if event_ids:
            for event_id in event_ids:
                event = data_manager.events[event_id]
                data_manager.append_event_log(event, log_entry)
                data_manager.save_event(event)
            mark_realtime_change('event-log', {'eventIds': event_ids, 'action': action})
        else:
            data_manager.logs.append(log_entry)
            data_manager.save_logs()
            mark_realtime_change('activity-log', {'action': action})

        mark_data_snapshot_current()
        logger.info(f"Action logged: {action}")
    except Exception as e:
        logger.error(f"Failed to log action: {e}")

def log_asset_change(event_id, asset_id, action, details=""):
    """Log all asset changes for debugging"""
    timestamp = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    log_message = f"[ASSET_CHANGE] {timestamp} - Event {event_id}: {action} asset {asset_id} {details}"
    logger.warning(log_message)

def _asset_group_from_item(asset):
    return {
        'department': (asset.department_code or '').strip().upper(),
        'brand': (asset.brand or '').strip(),
        'model': (asset.model_number or '').strip(),
        'description': (asset.description or '').strip()
    }


def _asset_matches_group(asset, group):
    return (
        (asset.department_code or '').strip().upper() == group['department'] and
        (asset.brand or '').strip() == group['brand'] and
        (asset.model_number or '').strip() == group['model']
    )


def _is_real_asset_ref(value):
    if not isinstance(value, str):
        return False

    blocked_prefixes = (
        '[MODEL]',
        '[CUSTOM]',
        '[LOAN]',
        '[MISC]',
        'loan|',
        'misc|'
    )

    return not value.startswith(blocked_prefixes)


def _replace_asset_id_in_list(values, old_asset_id, new_asset_id):
    if not isinstance(values, list):
        return 0

    changed = 0

    for index, value in enumerate(values):
        if value == old_asset_id:
            values[index] = new_asset_id
            changed += 1

    return changed


def _replace_bulk_asset_id_in_list(values, old_asset_id, new_asset_id):
    if not isinstance(values, list):
        return 0

    changed = 0

    for index, value in enumerate(values):
        marker = _parse_bulk_marker(value)

        if marker and marker.get('bulkId') == old_asset_id:
            values[index] = _bulk_marker(new_asset_id, marker.get('quantity', 1))
            changed += 1

    return changed


def _replace_asset_ids_in_list(values, asset_id_mapping):
    """Replace several asset IDs in one pass so overlapping renames stay safe."""
    if not isinstance(values, list) or not asset_id_mapping:
        return 0

    changed = 0

    for index, value in enumerate(values):
        replacement = asset_id_mapping.get(value)
        if replacement is not None and replacement != value:
            values[index] = replacement
            changed += 1
            continue

        marker = _parse_bulk_marker(value)
        if not marker:
            continue

        replacement = asset_id_mapping.get(marker.get('bulkId'))
        if replacement is not None and replacement != marker.get('bulkId'):
            values[index] = _bulk_marker(replacement, marker.get('quantity', 1))
            changed += 1

    return changed


def _parse_model_marker(value):
    if not isinstance(value, str) or not value.startswith('[MODEL]'):
        return None

    parts = value[7:].split('|')

    if len(parts) < 4:
        return None

    return {
        'department': parts[0].strip().upper(),
        'brand': parts[1].strip(),
        'model': parts[2].strip(),
        'quantity': parts[3].strip(),
        'description': '|'.join(parts[4:]).strip() if len(parts) > 4 else ''
    }


def _make_model_marker(group, quantity):
    return (
        f"[MODEL]{group['department']}|"
        f"{group['brand']}|"
        f"{group['model']}|"
        f"{quantity}|"
        f"{group['description']}"
    )


def _display_model_description(group):
    return f"[{group['department']}] {group['brand']} {group['model']} {group['description']}".strip()


def _model_marker_matches_group(marker, group):
    return (
        marker and
        marker['department'] == group['department'] and
        marker['brand'] == group['brand'] and
        marker['model'] == group['model']
    )


def _update_event_model_group_references(event, old_group, new_group):
    """
    Updates event-level model requirement rows when admin chooses
    to update all assets of the same model type.
    """
    changed = 0

    # Newer web workflow: [MODEL]DEPT|BRAND|MODEL|QTY|DESCRIPTION
    if hasattr(event, 'prepared_items') and isinstance(event.prepared_items, list):
        for index, item in enumerate(event.prepared_items):
            marker = _parse_model_marker(item)

            if _model_marker_matches_group(marker, old_group):
                event.prepared_items[index] = _make_model_marker(new_group, marker['quantity'])
                changed += 1

    # Older saved events may still use asset_models rows with model_description.
    old_display = _display_model_description(old_group)
    new_display = _display_model_description(new_group)

    if hasattr(event, 'asset_models') and isinstance(event.asset_models, list):
        for model_row in event.asset_models:
            if not isinstance(model_row, dict):
                continue

            current_description = str(model_row.get('model_description', '')).strip()

            if current_description == old_display:
                model_row['model_description'] = new_display
                changed += 1

    return changed

def _event_has_asset_reference(event, asset_id):
    """
    True if this specific asset appears anywhere in the event history.

    This covers:
    - prepared_items: assigned / directly attached assets
    - actually_prepared: assets that were physically prepared
    - returned_items: assets that were returned later
    - extra_assets: assets marked as extra
    """
    if not asset_id:
        return False

    return _event_asset_reference_quantity(event, asset_id) > 0


def _event_reference_lists(event):
    return (
        getattr(event, 'prepared_items', []) or [],
        getattr(event, 'actually_prepared', []) or [],
        getattr(event, 'returned_items', []) or [],
        getattr(event, 'extra_assets', []) or []
    )


def _event_asset_reference_quantity(event, asset_id):
    if not event or not asset_id:
        return 0

    asset = data_manager.inventory.get(asset_id) if data_manager else None

    if asset and _is_bulk_asset(asset):
        quantity = 0
        seen_markers = set()
        has_direct_reference = False

        for values in _event_reference_lists(event):
            if not isinstance(values, list):
                continue

            for value in values:
                if value == asset_id:
                    has_direct_reference = True
                    continue

                marker = _parse_bulk_marker(value)
                if not marker or marker.get('bulkId') != asset_id:
                    continue

                if value in seen_markers:
                    continue

                seen_markers.add(value)
                quantity += max(1, _safe_int(marker.get('quantity'), 1))

        return quantity or (1 if has_direct_reference else 0)

    lists_to_check = (
        getattr(event, 'prepared_items', []) or [],
        getattr(event, 'actually_prepared', []) or [],
        getattr(event, 'returned_items', []) or [],
        getattr(event, 'extra_assets', []) or []
    )

    return 1 if any(asset_id in values for values in lists_to_check if isinstance(values, list)) else 0


def _event_has_model_group_reference(event, group):
    if not event or not group:
        return False

    for item in getattr(event, 'prepared_items', []) or []:
        if _model_marker_matches_group(_parse_model_marker(item), group):
            return True

    old_display = _display_model_description(group)

    for row in getattr(event, 'asset_models', []) or []:
        if not isinstance(row, dict):
            continue

        if str(row.get('model_description', '')).strip() == old_display:
            return True

    return False


def _event_has_specific_group_asset_reference(event, group):
    if not event or not group:
        return False

    seen = set()

    for values in _event_reference_lists(event):
        if not isinstance(values, list):
            continue

        for value in values:
            if not isinstance(value, str) or value in seen:
                continue
            seen.add(value)

            marker = _parse_bulk_marker(value)
            if marker:
                asset = data_manager.inventory.get(marker.get('bulkId')) if data_manager else None
            elif value.startswith('[MODEL]') or _is_custom_ref(value):
                continue
            else:
                asset = data_manager.inventory.get(value) if data_manager else None

            if asset and _asset_matches_group(asset, group):
                return True

    return False


def _add_or_increment_model_marker(prepared_items, group, quantity_to_add=1):
    """
    Add quantity to an existing [MODEL] marker if it already exists.
    Otherwise append a new [MODEL] marker.
    """
    for index, item in enumerate(prepared_items):
        marker = _parse_model_marker(item)

        if _model_marker_matches_group(marker, group):
            try:
                current_qty = int(marker['quantity'])
            except Exception:
                current_qty = 0

            prepared_items[index] = _make_model_marker(group, current_qty + quantity_to_add)
            return 1

    prepared_items.append(_make_model_marker(group, quantity_to_add))
    return 1


def _add_or_increment_asset_model_row(asset_models, group, quantity_to_add=1):
    """
    Add quantity to an existing legacy asset_models row if it already exists.
    Otherwise append a new row.
    """
    new_display = _display_model_description(group)

    for row in asset_models:
        if not isinstance(row, dict):
            continue

        if str(row.get('model_description', '')).strip() == new_display:
            try:
                row['quantity'] = int(row.get('quantity', 0)) + quantity_to_add
            except Exception:
                row['quantity'] = quantity_to_add
            return 1

    asset_models.append({
        'model_description': new_display,
        'quantity': quantity_to_add
    })
    return 1




def _ensure_event_has_model_requirement_for_asset(event, asset, quantity_to_add=1):
    """Ensure the event has a [MODEL] requirement row for this asset's type.

    This is used when preparing/scanning a container: if a container contains an
    asset type that was not originally requested for the event, the event should
    gain a real model requirement row instead of only showing the asset as an
    unrelated extra item.
    """
    if not event or not asset:
        return 0

    if not hasattr(event, 'prepared_items') or event.prepared_items is None:
        event.prepared_items = []
    if not hasattr(event, 'asset_models') or event.asset_models is None:
        event.asset_models = []

    group = _asset_group_from_item(asset)
    changed = _add_or_increment_model_marker(event.prepared_items, group, quantity_to_add)
    changed += _add_or_increment_asset_model_row(event.asset_models, group, quantity_to_add)
    return changed


def _event_model_requirement_quantity_for_group(event, group):
    """Return the required [MODEL] quantity for one exact asset group."""
    if not event or not group:
        return 0

    total = 0
    for item in getattr(event, 'prepared_items', []) or []:
        marker = _parse_model_marker(item)
        if not _model_marker_matches_group(marker, group):
            continue
        try:
            total += int(marker.get('quantity') or 0)
        except Exception:
            continue
    return max(0, total)


def _event_real_asset_count_for_group(event, group):
    """Count non-extra real physical assets from this exact group already tied to the event.

    Manual over-prepared assets stay in event.extra_assets and should not make a
    later container scan raise the model requirement for those earlier manual
    extras. Container scans still raise the requirement for the container asset
    currently being processed.
    """
    if not event or not group:
        return 0

    extra_assets = set(getattr(event, 'extra_assets', []) or [])
    seen = set()
    for values in (
        getattr(event, 'actually_prepared', []) or [],
        getattr(event, 'returned_items', []) or [],
    ):
        for asset_id in values:
            if asset_id in extra_assets:
                continue
            if not _is_real_asset_ref(asset_id):
                continue
            if asset_id in seen:
                continue
            asset = data_manager.inventory.get(asset_id) if data_manager else None
            if asset and _asset_matches_group(asset, group):
                seen.add(asset_id)

    return len(seen)


def _event_model_requirement_remaining_for_asset(event, asset):
    """Return open requirement slots for this exact asset model group.

    This deliberately excludes event.extra_assets so a manual over-prepared
    asset does not consume a required slot or cause the requirement to grow.
    """
    if not event or not asset:
        return 0

    group = _asset_group_from_item(asset)
    required = _event_model_requirement_quantity_for_group(event, group)
    if required <= 0:
        return 0

    non_extra_prepared_or_returned = _event_real_asset_count_for_group(event, group)
    return max(required - non_extra_prepared_or_returned, 0)


def _ensure_event_model_requirement_covers_asset(event, asset, additional_quantity=1):
    """Top up the event's model requirement so prepared container contents do not show as extra.

    When scanning a container, each asset is processed one at a time. The old
    logic only added 1x for the first new model type, then stopped increasing
    the requirement because the type already existed. This helper compares the
    model requirement against the number of prepared/returned physical assets of
    that same type, then increments the [MODEL] row only by the missing amount.
    """
    if not event or not asset:
        return 0

    if not hasattr(event, 'prepared_items') or event.prepared_items is None:
        event.prepared_items = []
    if not hasattr(event, 'asset_models') or event.asset_models is None:
        event.asset_models = []

    group = _asset_group_from_item(asset)
    current_required = _event_model_requirement_quantity_for_group(event, group)
    existing_physical_count = _event_real_asset_count_for_group(event, group)
    minimum_required = existing_physical_count + max(1, _safe_int(additional_quantity, 1))

    if current_required >= minimum_required:
        return 0

    delta = minimum_required - current_required
    _add_or_increment_model_marker(event.prepared_items, group, delta)
    _add_or_increment_asset_model_row(event.asset_models, group, delta)
    return delta


def _move_model_marker_quantity(prepared_items, old_group, new_group, quantity_to_move=1):
    if not isinstance(prepared_items, list):
        return 0

    remaining = max(1, _safe_int(quantity_to_move, 1))
    moved = 0
    changed = 0
    rebuilt_items = []

    for item in prepared_items:
        marker = _parse_model_marker(item)

        if remaining <= 0 or not _model_marker_matches_group(marker, old_group):
            rebuilt_items.append(item)
            continue

        old_qty = max(0, _safe_int(marker.get('quantity'), 1))
        move_qty = min(old_qty, remaining)

        if move_qty <= 0:
            rebuilt_items.append(item)
            continue

        leftover_qty = old_qty - move_qty
        if leftover_qty > 0:
            rebuilt_items.append(_make_model_marker(old_group, leftover_qty))

        moved += move_qty
        remaining -= move_qty
        changed += 1

    if moved:
        prepared_items[:] = rebuilt_items
        changed += _add_or_increment_model_marker(prepared_items, new_group, moved)

    return changed


def _move_asset_model_row_quantity(asset_models, old_group, new_group, quantity_to_move=1):
    if not isinstance(asset_models, list):
        return 0

    old_display = _display_model_description(old_group)
    remaining = max(1, _safe_int(quantity_to_move, 1))
    moved = 0
    changed = 0

    for row in list(asset_models):
        if remaining <= 0:
            break

        if not isinstance(row, dict):
            continue

        if str(row.get('model_description', '')).strip() != old_display:
            continue

        old_qty = max(0, _safe_int(row.get('quantity'), 1))
        move_qty = min(old_qty, remaining)

        if move_qty <= 0:
            continue

        leftover_qty = old_qty - move_qty
        if leftover_qty > 0:
            row['quantity'] = leftover_qty
        else:
            asset_models.remove(row)

        moved += move_qty
        remaining -= move_qty
        changed += 1

    if moved:
        changed += _add_or_increment_asset_model_row(asset_models, new_group, moved)

    return changed


def _update_single_asset_event_model_references(event, old_group, new_group, quantity_to_move=1):
    """
    For a single asset edit, update only the referenced quantity of the old
    model requirement inside events where that exact asset was
    assigned, prepared, or returned before.

    Example:
    Old event has:
        [MODEL]AX|Yamaha|QL5|2|Console

    One prepared asset later changes to:
        Yamaha DM7 Compact

    Event becomes:
        [MODEL]AX|Yamaha|QL5|1|Console
        [MODEL]AX|Yamaha|DM7 Compact|1|Console

    Bulk quantity assets may move more than one unit. This preserves total
    requirement quantity and does not affect return logic.
    """
    changed = 0

    # Newer web workflow: prepared_items contains [MODEL] rows.
    prepared_items = getattr(event, 'prepared_items', []) or []
    changed += _move_model_marker_quantity(prepared_items, old_group, new_group, quantity_to_move)

    # Older saved events may still contain display rows in asset_models.
    asset_models = getattr(event, 'asset_models', []) or []
    changed += _move_asset_model_row_quantity(asset_models, old_group, new_group, quantity_to_move)

    return changed

def validate_event_data(data, require_location=False):
    """Validate event data"""
    errors = []

    if not data.get('name', '').strip():
        errors.append('Event name is required')

    if len(data.get('name', '')) > 100:
        errors.append('Event name must be less than 100 characters')

    location = str(data.get('location') or '').strip()
    tag = str(data.get('tag') or 'events').strip().lower()
    if require_location and tag != 'dry hire' and not location:
        errors.append('Location is required for events')
    if len(location) > 200:
        errors.append('Location must be less than 200 characters')

    try:
        start_date = datetime.strptime(data['startDate'], '%Y-%m-%d')
        end_date = datetime.strptime(data['endDate'], '%Y-%m-%d')
        if end_date < start_date:
            errors.append('End date must be after start date')
    except (KeyError, ValueError):
        errors.append('Invalid date format')

    return errors


def get_deployed_asset_quantity():
    """Physical inventory prepared for events and not yet returned.

    Regular assets are de-duplicated across events, bulk markers contribute
    their prepared quantity, and custom/misc/loan rows are deliberately
    excluded from this operational statistic.
    """
    manager = _current_data_manager_object()
    if manager is None or not getattr(manager, 'events', None):
        return 0

    regular_asset_ids = set()
    bulk_quantity = 0

    for event in manager.events.values():
        returned = set(getattr(event, 'returned_items', []) or [])
        seen_bulk_refs = set()
        for ref in getattr(event, 'actually_prepared', []) or []:
            if not isinstance(ref, str) or not ref or ref in returned:
                continue
            if _is_custom_ref(ref) or ref.startswith('[MODEL]'):
                continue

            bulk = _parse_bulk_marker(ref)
            if bulk:
                if ref not in seen_bulk_refs:
                    bulk_quantity += max(1, _safe_int(bulk.get('quantity'), 1))
                    seen_bulk_refs.add(ref)
                continue

            if ref in getattr(manager, 'inventory', {}):
                regular_asset_ids.add(ref)

    return len(regular_asset_ids) + bulk_quantity

def get_assigned_assets():
    """Get all assets currently assigned to events (with caching)"""
    try:
        manager = _current_data_manager_object()
        if manager is None:
            logger.error("get_assigned_assets: data_manager is None")
            return set()
            
        if not hasattr(manager, 'events') or manager.events is None:
            logger.error("get_assigned_assets: data_manager.events is None")
            return set()

        cache = _current_manager_cache()

        # Cache for 30 seconds
        now = datetime.now().timestamp()
        if (cache['assigned_assets'] is not None and
            cache['cache_timestamp'] is not None and
                now - cache['cache_timestamp'] < 30):
            logger.debug("get_assigned_assets: returning cached result")
            return cache['assigned_assets']

        logger.debug(f"get_assigned_assets: processing {len(manager.events)} events")
        
        assigned_assets = set()
        for event in manager.events.values():
            try:
                assigned_assets.update(_active_physical_asset_refs_for_event(event))
                        
            except Exception as e:
                logger.error(f"Error processing event {getattr(event, 'event_id', 'unknown')}: {e}")
                continue

        logger.debug(f"get_assigned_assets: found {len(assigned_assets)} assigned assets")
        
        cache['assigned_assets'] = assigned_assets
        cache['cache_timestamp'] = now
        return assigned_assets
        
    except Exception as e:
        logger.error(f"Error in get_assigned_assets: {e}")
        import traceback
        logger.error(f"get_assigned_assets traceback: {traceback.format_exc()}")
        return set()  # Return empty set on error

def update_event_state(event):
    """Update the state of an event based on model, bulk, regular, and custom preparation."""
    try:
        if getattr(event, 'force_state_override', False):
            logger.debug(f"Event {event.event_id} has forced state override, skipping automatic update")
            return

        _ensure_event_custom_lists(event)

        current_date = datetime.now().strftime('%Y%m%d')
        is_last_day = str(getattr(event, 'end_date', '')) == current_date

        has_model_assignments = any(
            isinstance(item, str) and item.startswith('[MODEL]')
            for item in event.prepared_items
        )

        required_total = 0
        prepared_active_total = 0
        prepared_ever_total = 0
        returned_total = 0
        started_total = 0

        extra_asset_ids = set(getattr(event, 'extra_assets', []) or [])

        if has_model_assignments:
            for item_id in event.prepared_items:
                if not (isinstance(item_id, str) and item_id.startswith('[MODEL]')):
                    continue

                try:
                    parts = item_id[7:].split('|')
                    if len(parts) < 4:
                        continue

                    dept = parts[0]
                    brand = parts[1]
                    model = parts[2]
                    required_quantity = max(0, _safe_int(parts[3], 0))
                    description = parts[4] if len(parts) > 4 else ''
                    group_key = _model_key_from_parts(dept, brand, model, description)

                    required_total += required_quantity

                    assigned_to_this_model = _bulk_quantity_in_values_for_key(event.actually_prepared, group_key)
                    returned_for_this_model = _bulk_quantity_in_values_for_key(event.returned_items, group_key)

                    all_assigned_assets = set(event.actually_prepared + event.returned_items)
                    for specific_asset_id in all_assigned_assets:
                        if specific_asset_id in extra_asset_ids:
                            continue
                        if _is_bulk_ref(specific_asset_id) or _is_custom_ref(specific_asset_id):
                            continue

                        specific_asset = data_manager.inventory.get(specific_asset_id)
                        if (specific_asset and
                            specific_asset.brand == brand and
                            specific_asset.model_number == model and
                            specific_asset.department_code == dept):

                            assigned_to_this_model += 1
                            if specific_asset_id in event.returned_items:
                                returned_for_this_model += 1

                    prepared_ever_total += assigned_to_this_model
                    returned_total += returned_for_this_model
                    prepared_active_total += max(assigned_to_this_model - returned_for_this_model, 0)
                    if assigned_to_this_model > 0:
                        started_total += assigned_to_this_model

                except Exception as e:
                    logger.error(f"Error parsing model assignment {item_id}: {e}")
                    continue
        else:
            specific_counts = _event_specific_counts(event)
            required_total += specific_counts['required']
            prepared_active_total += specific_counts['preparedActive']
            prepared_ever_total += specific_counts['preparedEver']
            returned_total += specific_counts['returned']
            started_total += specific_counts['preparedEver']

        custom_counts = _custom_counts_for_event(event)
        required_total += custom_counts['required']
        prepared_active_total += custom_counts['preparedActive']
        prepared_ever_total += custom_counts['preparedEver']
        returned_total += custom_counts['returned']
        started_total += custom_counts['started']

        logger.debug(
            f"Event {event.event_id} state calculation - "
            f"required={required_total}, activePrepared={prepared_active_total}, "
            f"everPrepared={prepared_ever_total}, returned={returned_total}, started={started_total}"
        )

        returnable_counts = _event_returnable_counts(event)
        returned_any = returnable_counts['returned'] > 0
        all_required_prepared_ever = required_total == 0 or prepared_ever_total >= required_total
        all_returnable_assets_returned = (
            returned_any and
            all_required_prepared_ever and
            returnable_counts['returnable'] == 0
        )
        is_ready = required_total > 0 and prepared_active_total >= required_total
        is_active_event_day = event.start_date <= current_date <= event.end_date

        # 1. Every returnable asset is back, and required items were fully prepared.
        if all_returnable_assets_returned:
            event.state = 'Closed'

        # 2. Once any asset has been returned, the event is in the return flow.
        elif returned_any:
            event.state = 'Returning'

        # 3. Last Day is only the final-day version of an otherwise ongoing event.
        elif is_last_day and is_active_event_day and is_ready:
            event.state = 'Last Day'

        # 4. Overdue: event ended with prepared, unreturned items.
        elif prepared_ever_total > returned_total and current_date > event.end_date:
            event.state = 'Overdue'

        # 5. No requirements at all.
        elif required_total == 0:
            event.state = 'New'

        # 6. Requirements exist, but nothing has been collected/prepared yet.
        elif started_total == 0:
            event.state = 'Planning'

        # 7. Some collection/preparation happened, but requirements are not fully prepared.
        elif prepared_active_total < required_total and returned_total == 0:
            event.state = 'Preparing'

        # 8. Required quantity is fully prepared and none returned yet.
        elif is_ready and returned_total == 0:
            if is_active_event_day:
                event.state = 'Ongoing'
            else:
                event.state = 'Ready'

        else:
            logger.debug(f"Event {event.event_id} fell through state calculation; keeping {event.state}")

    except Exception as e:
        logger.error(f"Error updating event state for event {event.event_id}: {e}")
        import traceback
        logger.error(f"Traceback: {traceback.format_exc()}")


def refresh_event_states_for_read(events_to_check=None):
    """Keep automatically calculated event states current before read responses."""
    if _current_data_manager_object() is None:
        return []

    updated_events = []
    source_events = events_to_check if events_to_check is not None else data_manager.events.values()

    for event in list(source_events):
        if not event:
            continue

        old_state = normalize_event_state(getattr(event, 'state', 'New'))
        event.state = old_state
        update_event_state(event)

        if getattr(event, 'state', 'New') == old_state:
            continue

        data_manager.save_event(event)
        updated_events.append({
            'eventId': event.event_id,
            'name': event.name,
            'oldState': old_state,
            'newState': event.state
        })
        logger.info("Event %s state refreshed for read: %s -> %s", event.event_id, old_state, event.state)

    if updated_events:
        reset_cache()
        mark_data_snapshot_current()
        mark_realtime_change('event-state', {'updatedEvents': updated_events[-20:]})

    return updated_events

def cleanup_extra_assets(event):
    """Clean up the extra_assets list - ONLY call this when explicitly needed, not on every view"""
    if not hasattr(event, 'extra_assets'):
        event.extra_assets = []
        return
    
    # SAFETY CHECK: Only run if explicitly called for maintenance
    logger.warning(f"CLEANUP: Manual cleanup requested for event {event.event_id}")
    logger.warning(f"CLEANUP: Before cleanup - Extra assets: {event.extra_assets}")
    logger.warning(f"CLEANUP: Before cleanup - Prepared items: {event.prepared_items}")
    
    # Don't auto-cleanup unless there are real issues
    if not event.extra_assets:
        return
    
    assets_to_remove = []
    
    for asset_id in event.extra_assets:
        # Check if this asset fulfills any model requirement
        fulfills_requirement = False
        
        for item in event.prepared_items:
            if item.startswith('[MODEL]'):
                try:
                    parts = item.split('|')
                    if len(parts) >= 4:
                        dept = parts[0][7:]  # Remove '[MODEL]' prefix
                        brand = parts[1]
                        model = parts[2]
                        
                        # Check if this specific asset matches this model requirement
                        asset = data_manager.inventory.get(asset_id)
                        if (asset and 
                            asset.brand == brand and 
                            asset.model_number == model and
                            asset.department_code == dept):
                            fulfills_requirement = True
                            logger.warning(f"CLEANUP: Asset {asset_id} fulfills {brand} {model} requirement")
                            break
                except Exception as e:
                    logger.error(f"CLEANUP: Error checking model requirement for {item}: {e}")
                    continue
        
        if fulfills_requirement:
            assets_to_remove.append(asset_id)
    
    # Remove assets that fulfill requirements
    for asset_id in assets_to_remove:
        event.extra_assets.remove(asset_id)
        logger.warning(f"CLEANUP: Removed {asset_id} from extra_assets (fulfills requirement)")
    
    logger.warning(f"CLEANUP: After cleanup - Extra assets: {event.extra_assets}")

def schedule_ongoing_check():
    """Run the ongoing event check in a background thread"""
    logger.info("Background thread started - checking events every 5 minutes")
    
    while get_default_data_manager() is None:
        logger.info("Background thread: Waiting for data_manager to be initialized...")
        time.sleep(5)
    
    logger.info("Background thread: data_manager is ready, starting checks")
    
    while True:
        try:
            managers = []
            seen_manager_ids = set()
            for company_code in _all_company_records():
                manager = _get_company_data_manager(company_code)
                if id(manager) in seen_manager_ids:
                    continue
                seen_manager_ids.add(id(manager))
                managers.append((company_code, manager))

            for company_code, manager in managers:
                token = _request_data_manager.set(manager)
                try:
                    refresh_shared_data_if_changed()
                    logger.info(
                        "Background thread: checking event states for company %s",
                        company_code,
                    )
                    check_and_update_ongoing_events()
                finally:
                    _request_data_manager.reset(token)
            
            time.sleep(300)
        except Exception as e:
            logger.error(f"Background thread error: {e}")
            import traceback
            logger.error(f"Background thread traceback: {traceback.format_exc()}")
            time.sleep(300)

def start_background_thread():
    """Start the background thread for event checking"""
    global _background_thread_started
    if _background_thread_started:
        logger.info("Background event checker already running")
        return True

    try:
        ongoing_thread = threading.Thread(target=schedule_ongoing_check, daemon=True)
        ongoing_thread.start()
        _background_thread_started = True
        logger.info("Background thread for event checking started successfully")
        return True
    except Exception as e:
        logger.error(f"Failed to start background thread: {e}")
        return False

def init_data_manager():
    """Initialize the data manager with the configured data folder"""
    manager = get_default_data_manager()
    if manager is not None:
        return manager

    with _data_manager_init_lock:
        manager = get_default_data_manager()
        if manager is not None:
            return manager

        try:
            registry = _load_company_registry()
            company_code = registry.get('defaultCompany', DEFAULT_COMPANY_CODE)
            manager = _activate_company(company_code)
            logger.info(
                "Data manager initialized for company %s with folder: %s",
                _active_company_code,
                getattr(manager, 'data_folder', '')
            )
            
            # Start the background thread AFTER data_manager is initialized
            background_started = start_background_thread()
            if not background_started:
                logger.warning("Background thread failed to start - automatic event updates disabled")
            else:
                logger.info("Background thread started successfully after data_manager initialization")
                
        except Exception as e:
            logger.error(f"Failed to initialize data manager: {e}")
            raise

    return manager


@app.before_request
def ensure_web_runtime_ready():
    """Lazy init for hosted WSGI imports where __main__ is never executed."""
    if get_default_data_manager() is None:
        init_data_manager()
    if request.endpoint != 'static':
        manager = _activate_company_for_session()
        _bind_request_data_manager(manager)
        if (
            request.method in {'POST', 'PUT', 'PATCH', 'DELETE'}
            and hasattr(manager, 'acquire_write_request')
        ):
            manager.acquire_write_request()
            locks = getattr(g, 'data_manager_write_locks', None)
            if locks is None:
                locks = []
                g.data_manager_write_locks = locks
            locks.append(manager)
        refresh_shared_data_if_changed()


@app.teardown_request
def release_request_data_manager(_error=None):
    """Restore context-local manager bindings after every request."""
    for manager in reversed(getattr(g, 'data_manager_write_locks', [])):
        manager.release_write_request()
    for token in reversed(getattr(g, 'data_manager_tokens', [])):
        _request_data_manager.reset(token)

# Routes

def _static_asset_version(filename):
    try:
        return int(os.path.getmtime(os.path.join(app.static_folder, filename.replace('/', os.sep))))
    except OSError:
        return int(time.time())


@app.route('/')
@require_auth
def index():
    """Serve the main web interface"""
    return render_template('index.html', app_js_version=_static_asset_version('js/app.js'))


@app.route('/login', methods=['GET', 'POST'])
def login():
    """Handle user authentication"""
    if request.method == 'GET':
        if 'user' in session:
            return redirect(url_for('index'))
        return render_template('login.html')

    try:
        data = request.get_json()
        username = data.get('username', '').strip()
        password = data.get('password', '')

        if not username or not password:
            return jsonify({'success': False, 'message': 'Username and password required'}), 400

        if username in data_manager.users:
            user = data_manager.users[username]

            if not getattr(user, 'is_active', True):
                log_action(f"Inactive login attempt for username: {username}")
                return jsonify({
                    'success': False,
                    'message': 'This account is inactive. Please contact an admin.'
                }), 403

            hashed_input = hash_password(password, user.salt)

            if hashed_input == user.password_hash:
                session['user'] = username
                if _is_super_admin_username(username) and not getattr(user, 'is_admin', False):
                    user.is_admin = True
                user.last_online = datetime.now().astimezone().isoformat(timespec='seconds')
                data_manager.save_users()
                if not app.config.get('TESTING'):
                    _reload_users_for_all_company_managers()
                session['is_admin'] = user.is_admin
                session['is_super_admin'] = _is_super_admin_username(username)
                session['is_active'] = getattr(user, 'is_active', True)
                session.pop('self_user_changes_pending', None)
                session['company_code'] = _user_assigned_company_code(username)
                _activate_company_for_session()

                log_action(f"User {username} logged in via web interface")
                return jsonify({
                    'success': True,
                    'message': 'Login successful',
                    'redirect': url_for('index')
                })

        log_action(f"Failed login attempt for username: {username}")
        return jsonify({'success': False, 'message': 'Invalid credentials'}), 401

    except Exception as e:
        logger.error(f"Login error: {e}")
        return jsonify({'success': False, 'message': 'Login failed'}), 500

@app.route('/logout')
def logout():
    """Handle user logout"""
    if 'user' in session:
        username = session['user']
        log_action(f"User {username} logged out from web interface")
        session.clear()

    return redirect(url_for('login'))


@app.route('/api/realtime/stream', methods=['GET'])
@require_auth
def realtime_stream():
    """Stream shared-data change notices to the logged-in browser."""
    subscriber_id = secrets.token_urlsafe(16)
    subscriber_queue = queue.Queue(maxsize=100)
    client_id = _client_id_from_request()

    with _realtime_subscribers_lock:
        _realtime_subscribers[subscriber_id] = subscriber_queue

    def sse_message(event_name, payload):
        payload = payload or {}
        data = json.dumps(payload, ensure_ascii=False)
        event_id = payload.get('id', '')
        id_line = f"id: {event_id}\n" if event_id else ""
        return f"{id_line}event: {event_name}\ndata: {data}\n\n"

    @stream_with_context
    def event_stream():
        last_seen_realtime_id = request.headers.get('Last-Event-ID') or ''
        last_heartbeat_at = time.time()

        try:
            yield sse_message('connected', {
                'topic': 'connected',
                'clientId': client_id,
                'timestamp': datetime.now().isoformat(timespec='seconds')
            })

            while True:
                payload = None
                try:
                    payload = subscriber_queue.get(timeout=1)
                except queue.Empty:
                    payload = None

                if payload:
                    last_seen_realtime_id = str(payload.get('id') or last_seen_realtime_id)
                    yield sse_message('inventory-update', payload)
                    continue

                shared_payload = _read_realtime_state()
                shared_payload_id = str((shared_payload or {}).get('id') or '')
                if shared_payload and shared_payload_id and shared_payload_id != last_seen_realtime_id:
                    last_seen_realtime_id = shared_payload_id
                    yield sse_message('inventory-update', shared_payload)
                    continue

                if time.time() - last_heartbeat_at >= 25:
                    last_heartbeat_at = time.time()
                    yield ": heartbeat\n\n"
        finally:
            with _realtime_subscribers_lock:
                _realtime_subscribers.pop(subscriber_id, None)

    return Response(
        event_stream(),
        mimetype='text/event-stream',
        headers={
            'Cache-Control': 'no-cache',
            'X-Accel-Buffering': 'no',
            'Connection': 'keep-alive'
        }
    )


@app.route('/api/current-user', methods=['GET'])
@require_auth
def get_current_user():
    """Get the currently logged-in user"""
    username = session.get('user')
    user = data_manager.users.get(username)

    if not user:
        return jsonify({'error': 'User not found'}), 404

    return jsonify({
        'success': True,
        'data': {
            'username': user.username,
            'isAdmin': _current_user_effective_is_admin(),
            'isSuperAdmin': _current_user_is_super_admin(),
            'isActive': _current_user_effective_is_active(),
            'company': _company_payload(_current_company_code()),
            'assignedCompanyCode': _user_assigned_company_code(user.username),
            'hasPendingSelfChanges': bool(session.get('self_user_changes_pending')),
        }
    })


@app.route('/api/current-user/password', methods=['PUT'])
@require_auth
def change_current_user_password():
    """Allow the signed-in user to change their own password."""
    try:
        username = session.get('user')
        user = data_manager.users.get(username)

        if not user:
            return jsonify({'error': 'User not found'}), 404

        data = request.get_json() or {}
        current_password = data.get('currentPassword') or ''
        new_password = data.get('newPassword') or ''

        if not current_password:
            return jsonify({'error': 'Current password is required'}), 400

        if not new_password:
            return jsonify({'error': 'New password is required'}), 400

        if hash_password(current_password, user.salt) != user.password_hash:
            return jsonify({'error': 'Current password is incorrect'}), 403

        user.salt = secrets.token_hex(16)
        user.password_hash = hash_password(new_password, user.salt)

        data_manager.save_users()
        _reload_users_for_all_company_managers()
        log_action("Changed own password")

        return jsonify({'success': True, 'message': 'Password changed successfully'})

    except Exception as e:
        logger.error(f"Error changing password for current user: {e}")
        return jsonify({'error': 'Failed to change password'}), 500


@app.route('/api/companies', methods=['GET'])
@require_super_admin
def list_companies():
    """Super admin: list companies and user assignments."""
    try:
        registry = _load_company_registry()
        companies = []
        users_by_company = defaultdict(list)

        for username in data_manager.users.keys():
            code = registry.get('userCompanies', {}).get(username) or registry.get('defaultCompany', DEFAULT_COMPANY_CODE)
            users_by_company[code].append(username)

        for code, record in sorted(registry['companies'].items(), key=lambda item: item[0]):
            payload = _company_payload(code)
            payload['userCount'] = len(users_by_company.get(code, []))
            payload['users'] = sorted(users_by_company.get(code, []), key=lambda value: value.lower())
            payload['isActive'] = code == _current_company_code()
            companies.append(payload)

        return jsonify({'success': True, 'data': companies})
    except Exception as e:
        logger.error(f"Error listing companies: {e}", exc_info=True)
        return jsonify({'error': 'Failed to list companies'}), 500


@app.route('/api/companies', methods=['POST'])
@require_super_admin
def create_company():
    """Super admin: create a segregated company folder and optional first admin."""
    try:
        data = request.get_json() or {}
        name = str(data.get('name') or '').strip()
        raw_code = data.get('code') or name
        code = _normalise_company_code(raw_code)
        first_admin_username = str(data.get('firstAdminUsername') or '').strip()
        first_admin_password = data.get('firstAdminPassword') or ''

        if not code:
            return jsonify({'error': 'Company code is required'}), 400

        if not name:
            name = code

        registry = _load_company_registry()
        if code in registry['companies']:
            return jsonify({'error': f'Company {code} already exists'}), 409

        if first_admin_username and first_admin_username not in data_manager.users and not first_admin_password:
            return jsonify({'error': 'First admin user does not exist. Provide a password to create it.'}), 400

        record = _new_company_record(
            code,
            name,
            created_by=session.get('user', ''),
            requires_branding_setup=True
        )
        registry['companies'][code] = record
        registry = _save_company_registry(registry)

        _get_company_data_manager(code)
        settings_path = os.path.join(_company_record_backend_folder(record), 'PdfSettings.json')
        if not os.path.exists(settings_path):
            with open(settings_path, 'w', encoding='utf-8') as f:
                json.dump(_pdf_settings_defaults(), f, ensure_ascii=False, indent=2)

        if first_admin_username:
            user = data_manager.users.get(first_admin_username)
            if not user:
                salt = secrets.token_hex(16)
                user = User(
                    username=first_admin_username,
                    password_hash=hash_password(first_admin_password, salt),
                    salt=salt,
                    is_admin=True,
                    is_active=True
                )
                data_manager.users[first_admin_username] = user

            user.is_admin = True
            user.is_active = True
            data_manager.save_users()
            _reload_users_for_all_company_managers()
            _assign_user_to_company(first_admin_username, code)

        mark_realtime_change('company-management', {'companyCode': code})
        log_action(f"Created company {code} ({name})")

        return jsonify({
            'success': True,
            'message': 'Company created successfully',
            'data': _company_payload(code)
        })
    except Exception as e:
        logger.error(f"Error creating company: {e}", exc_info=True)
        return jsonify({'error': 'Failed to create company'}), 500


@app.route('/api/companies/<path:company_code>', methods=['PUT'])
@require_super_admin
def update_company(company_code):
    """Super admin: update a company's display name."""
    try:
        code = _normalise_company_code(unquote_plus(company_code))
        data = request.get_json() or {}
        name = str(data.get('name') or '').strip()
        registry = _load_company_registry()

        if not code or code not in registry['companies']:
            return jsonify({'error': 'Company not found'}), 404

        if not name:
            return jsonify({'error': 'Company name is required'}), 400

        record = registry['companies'][code]
        old_name = record.get('name') or code
        record['name'] = name
        registry['companies'][code] = record
        _save_company_registry(registry)

        mark_realtime_change('company-management', {'companyCode': code, 'updated': True})
        log_action(f"Updated company {code} name from {old_name} to {name}")

        return jsonify({
            'success': True,
            'message': 'Company updated successfully',
            'data': _company_payload(code)
        })
    except Exception as e:
        logger.error(f"Error updating company {company_code}: {e}", exc_info=True)
        return jsonify({'error': 'Failed to update company'}), 500


@app.route('/api/companies/<path:company_code>', methods=['DELETE'])
@require_super_admin
def delete_company(company_code):
    """Super admin: delete a company and its segregated company assets."""
    try:
        code = _normalise_company_code(unquote_plus(company_code))
        registry = _load_company_registry()

        if not code or code not in registry['companies']:
            return jsonify({'error': 'Company not found'}), 404

        if len(registry['companies']) <= 1:
            return jsonify({'error': 'At least one company must remain'}), 400

        if code == _normalise_company_code(_current_company_code(), DEFAULT_COMPANY_CODE):
            return jsonify({'error': 'Switch to another company before deleting the active company'}), 400

        record = registry['companies'][code]
        company_folder = _safe_company_delete_folder(code, record)
        remaining_codes = sorted(company_code for company_code in registry['companies'] if company_code != code)
        new_default_company = registry.get('defaultCompany')
        if new_default_company == code or new_default_company not in remaining_codes:
            new_default_company = remaining_codes[0]

        removed_users = []
        reassigned_super_admins = []
        users_changed = False
        for username, assigned_company in list(registry.get('userCompanies', {}).items()):
            if _normalise_company_code(assigned_company, DEFAULT_COMPANY_CODE) != code:
                continue

            if _is_super_admin_username(username):
                registry['userCompanies'][username] = new_default_company
                reassigned_super_admins.append(username)
            else:
                registry['userCompanies'].pop(username, None)
                if username in data_manager.users:
                    data_manager.users.pop(username, None)
                    removed_users.append(username)
                    users_changed = True

        company_manager = _company_data_managers.get(code)
        database_url = _database_url_for_runtime()
        if company_manager is None and database_url:
            company_manager = _get_company_data_manager(code)
        if (
            company_manager is not None
            and hasattr(company_manager, 'delete_company_data')
            and database_url
        ):
            company_manager.delete_company_data()
        _company_data_managers.pop(code, None)
        if os.path.exists(company_folder):
            shutil.rmtree(company_folder)

        registry['companies'].pop(code, None)
        registry['defaultCompany'] = new_default_company
        registry = _save_company_registry(registry)

        if users_changed:
            data_manager.save_users()
            _reload_users_for_all_company_managers()

        mark_realtime_change('company-management', {'companyCode': code, 'deleted': True})
        log_action(f"Deleted company {code} ({record.get('name') or code})")

        return jsonify({
            'success': True,
            'message': 'Company deleted successfully',
            'data': {
                'deletedCompanyCode': code,
                'newDefaultCompany': new_default_company,
                'removedUsers': sorted(removed_users, key=lambda value: value.lower()),
                'reassignedSuperAdmins': sorted(reassigned_super_admins, key=lambda value: value.lower()),
            }
        })
    except ValueError as e:
        return jsonify({'error': str(e)}), 400
    except Exception as e:
        logger.error(f"Error deleting company {company_code}: {e}", exc_info=True)
        return jsonify({'error': 'Failed to delete company'}), 500


@app.route('/api/current-company', methods=['PUT'])
@require_super_admin
def switch_current_company():
    """Super admin: switch the active company for this browser session."""
    try:
        data = request.get_json() or {}
        code = _normalise_company_code(data.get('companyCode') or data.get('code'))
        registry = _load_company_registry()

        if not code or code not in registry['companies']:
            return jsonify({'error': 'Company not found'}), 404

        session['company_code'] = code
        manager = _get_company_data_manager(code)
        _bind_request_data_manager(manager)
        refresh_shared_data_if_changed()

        return jsonify({
            'success': True,
            'data': {
                'company': _company_payload(code)
            }
        })
    except Exception as e:
        logger.error(f"Error switching company: {e}", exc_info=True)
        return jsonify({'error': 'Failed to switch company'}), 500


@app.route('/api/company/branding-setup-complete', methods=['POST'])
@require_admin
def complete_company_branding_setup():
    """Admin: keep current branding/defaults and dismiss the first-admin prompt."""
    try:
        _mark_company_branding_setup_complete()
        return jsonify({'success': True, 'data': _company_payload(_current_company_code())})
    except Exception as e:
        logger.error(f"Error completing company branding setup: {e}", exc_info=True)
        return jsonify({'error': 'Failed to complete branding setup'}), 500


@app.route('/api/pdf-settings', methods=['GET'])
@require_auth
def get_pdf_settings():
    """Return logo and footer settings used by generated PDFs."""
    try:
        return jsonify({'success': True, 'data': _pdf_settings_payload()})
    except Exception as e:
        logger.error(f"Error loading PDF settings: {e}", exc_info=True)
        return jsonify({'error': 'Failed to load PDF settings'}), 500


@app.route('/api/pdf-settings', methods=['PUT'])
@require_admin
def update_pdf_settings():
    """Update configurable PDF footer text."""
    try:
        data = request.get_json() or {}
        footer_text = data.get('footerText')

        if footer_text is None:
            return jsonify({'error': 'Footer text is required'}), 400

        footer_text = str(footer_text)
        if len(footer_text) > 2000:
            return jsonify({'error': 'Footer text is too long'}), 400

        settings = _load_pdf_settings()
        settings['footerText'] = footer_text
        settings['updatedAt'] = datetime.now().isoformat(timespec='seconds')
        saved = _save_pdf_settings(settings)
        _mark_company_branding_setup_complete()

        log_action("Updated PDF footer settings")

        return jsonify({'success': True, 'data': _pdf_settings_payload(saved)})
    except Exception as e:
        logger.error(f"Error updating PDF settings: {e}", exc_info=True)
        return jsonify({'error': 'Failed to update PDF settings'}), 500


@app.route('/api/pdf-settings/logo', methods=['GET'])
@require_auth
def get_pdf_logo():
    """Serve the configured PDF logo, falling back to the bundled logo."""
    try:
        settings = _load_pdf_settings()
        logo_path = _pdf_logo_path(settings)

        if logo_path and os.path.exists(logo_path):
            return send_file(
                logo_path,
                mimetype=settings.get('logoMimeType') or None,
                max_age=3600
            )

        default_logo = _default_pdf_logo_path()
        if default_logo and os.path.exists(default_logo):
            return send_file(
                default_logo,
                mimetype=mimetypes.guess_type(default_logo)[0] or 'image/png',
                max_age=3600
            )

        return jsonify({'error': 'Logo not found'}), 404
    except Exception as e:
        logger.error(f"Error serving PDF logo: {e}", exc_info=True)
        return jsonify({'error': 'Failed to load PDF logo'}), 500


@app.route('/api/pdf-settings/logo', methods=['POST'])
@require_admin
def upload_pdf_logo():
    """Upload the custom logo used by generated PDFs."""
    try:
        if request.content_length and request.content_length > 5 * 1024 * 1024:
            return jsonify({'error': 'Logo must be smaller than 5 MB'}), 400

        file = request.files.get('logo')
        if not file or not file.filename:
            return jsonify({'error': 'Logo file is required'}), 400

        mime_type = (file.mimetype or '').lower()
        extension = ALLOWED_PDF_LOGO_MIMES.get(mime_type)

        if not extension:
            original_extension = os.path.splitext(file.filename)[1].lower()
            mime_type = ALLOWED_PDF_LOGO_EXTENSIONS.get(original_extension, '')
            extension = ALLOWED_PDF_LOGO_MIMES.get(mime_type)

        if not extension:
            return jsonify({'error': 'Logo must be a PNG, JPG, WebP, or GIF image'}), 400

        folder = _pdf_assets_folder()
        if not os.path.exists(folder):
            os.makedirs(folder)

        _remove_custom_pdf_logos()

        logo_filename = f'logo{extension}'
        logo_path = os.path.join(folder, logo_filename)
        file.save(logo_path)

        settings = _load_pdf_settings()
        settings['logoFilename'] = logo_filename
        settings['logoOriginalName'] = os.path.basename(file.filename)
        settings['logoMimeType'] = mime_type
        settings['updatedAt'] = datetime.now().isoformat(timespec='seconds')
        saved = _save_pdf_settings(settings)
        _mark_company_branding_setup_complete()

        log_action(f"Updated PDF logo ({settings['logoOriginalName']})")

        return jsonify({'success': True, 'data': _pdf_settings_payload(saved)})
    except Exception as e:
        logger.error(f"Error uploading PDF logo: {e}", exc_info=True)
        return jsonify({'error': 'Failed to upload PDF logo'}), 500


@app.route('/api/pdf-settings/logo', methods=['DELETE'])
@require_admin
def reset_pdf_logo():
    """Reset PDFs to the bundled logo."""
    try:
        _remove_custom_pdf_logos()
        settings = _load_pdf_settings()
        settings['logoFilename'] = ''
        settings['logoOriginalName'] = ''
        settings['logoMimeType'] = ''
        settings['updatedAt'] = datetime.now().isoformat(timespec='seconds')
        saved = _save_pdf_settings(settings)

        log_action("Reset PDF logo")

        return jsonify({'success': True, 'data': _pdf_settings_payload(saved)})
    except Exception as e:
        logger.error(f"Error resetting PDF logo: {e}", exc_info=True)
        return jsonify({'error': 'Failed to reset PDF logo'}), 500



@app.route('/api/departments', methods=['GET'])
@require_auth
def get_departments():
    """Return the configurable department list used by filters and badges."""
    try:
        departments = _load_departments()
        usage_counts = defaultdict(int)

        for asset in data_manager.inventory.values():
            if _is_disposed(asset):
                continue
            code = _normalise_department_code(getattr(asset, 'department_code', 'UN')) or 'UN'
            usage_counts[code] += _asset_inventory_quantity(asset)

        data = []
        for code in sorted(departments.keys()):
            dept = _department_payload(code, departments)
            data.append({
                'code': dept['code'],
                'name': dept['name'],
                'color': dept['color'],
                'textColor': dept['textColor'],
                'assetCount': usage_counts.get(code, 0)
            })

        return jsonify({'success': True, 'data': data})
    except Exception as e:
        logger.error(f"Error loading departments: {e}", exc_info=True)
        return jsonify({'error': 'Failed to load departments'}), 500


@app.route('/api/departments', methods=['POST'])
@require_admin
def create_department():
    """Admin: create a new department code/name/colour."""
    try:
        data = request.get_json() or {}
        code = _normalise_department_code(data.get('code'))
        name = str(data.get('name') or '').strip()
        colour = _normalise_hex_colour(data.get('color'))

        if not code:
            return jsonify({'error': 'Department code is required'}), 400

        departments = _load_departments()
        if code in departments:
            return jsonify({'error': f'Department {code} already exists'}), 409

        departments[code] = _department_record(code, name or code, colour)
        _save_departments(departments)

        log_action(f"Created department {code} ({name or code})")

        return jsonify({'success': True, 'message': 'Department created successfully', 'data': departments[code]})
    except Exception as e:
        logger.error(f"Error creating department: {e}", exc_info=True)
        return jsonify({'error': 'Failed to create department'}), 500


@app.route('/api/departments/<path:department_code>', methods=['PUT'])
@require_admin
def update_department(department_code):
    """Admin: rename a department code, change display name, or change colour.

    If the code changes, all inventory rows and model requirement markers in event
    CSV files are updated so old events remain linked correctly.
    """
    try:
        old_code = _normalise_department_code(unquote_plus(department_code))
        data = request.get_json() or {}
        new_code = _normalise_department_code(data.get('code') or old_code)
        raw_name = data.get('name')
        raw_colour = data.get('color')

        if not old_code:
            return jsonify({'error': 'Department code is required'}), 400

        if not new_code:
            return jsonify({'error': 'New department code is required'}), 400

        departments = _load_departments()
        if old_code not in departments:
            # Allow repair of legacy codes that exist in inventory but not in Departments.csv.
            if not any(_normalise_department_code(getattr(a, 'department_code', '')) == old_code for a in data_manager.inventory.values()):
                return jsonify({'error': f'Department {old_code} not found'}), 404
            departments[old_code] = _department_record(old_code)

        if new_code != old_code and new_code in departments:
            return jsonify({'error': f'Department {new_code} already exists'}), 409

        previous = departments.pop(old_code)
        name = str(raw_name if raw_name is not None else previous.get('name', new_code)).strip() or new_code
        colour = _normalise_hex_colour(raw_colour, previous.get('color', '#e2e3e5'))
        departments[new_code] = _department_record(new_code, name, colour, _best_text_colour(colour))
        _save_departments(departments)

        assets_updated = 0
        events_updated = 0
        model_markers_updated = 0
        asset_model_rows_updated = 0

        if new_code != old_code:
            for asset in data_manager.inventory.values():
                if _normalise_department_code(getattr(asset, 'department_code', '')) == old_code:
                    asset.department_code = new_code
                    assets_updated += 1

            for event in data_manager.events.values():
                changed = 0

                custom_replacements = {}

                if isinstance(getattr(event, 'prepared_items', None), list):
                    for index, item in enumerate(list(event.prepared_items)):
                        replacement, did_change = _replace_department_in_model_marker(item, old_code, new_code)
                        if did_change:
                            event.prepared_items[index] = replacement
                            changed += 1
                            model_markers_updated += 1
                            continue

                        replacement, did_change = _replace_department_in_custom_marker(item, old_code, new_code)
                        if did_change:
                            event.prepared_items[index] = replacement
                            custom_replacements[item] = replacement
                            changed += 1

                if custom_replacements:
                    for list_name in ('actually_prepared', 'returned_items', 'extra_assets', 'custom_collected'):
                        values = getattr(event, list_name, None)
                        if not isinstance(values, list):
                            continue
                        for i, value in enumerate(list(values)):
                            if value in custom_replacements:
                                values[i] = custom_replacements[value]

                if isinstance(getattr(event, 'asset_models', None), list):
                    for row in event.asset_models:
                        if not isinstance(row, dict):
                            continue
                        replacement, did_change = _replace_department_in_model_description(
                            str(row.get('model_description', '')),
                            old_code,
                            new_code
                        )
                        if did_change:
                            row['model_description'] = replacement
                            changed += 1
                            asset_model_rows_updated += 1

                if changed:
                    update_event_state(event)
                    data_manager.save_event(event)
                    events_updated += 1

            if assets_updated:
                data_manager.save_inventory()

        invalidate_cache()

        log_action(
            f"Updated department {old_code} -> {new_code}; "
            f"name='{previous.get('name')}' -> '{name}'; "
            f"assetsUpdated={assets_updated}; eventsUpdated={events_updated}"
        )

        return jsonify({
            'success': True,
            'message': 'Department updated successfully',
            'data': {
                'department': departments[new_code],
                'assetsUpdated': assets_updated,
                'eventsUpdated': events_updated,
                'modelMarkersUpdated': model_markers_updated,
                'assetModelRowsUpdated': asset_model_rows_updated
            }
        })
    except Exception as e:
        logger.error(f"Error updating department {department_code}: {e}", exc_info=True)
        return jsonify({'error': 'Failed to update department'}), 500


@app.route('/api/departments/<path:department_code>', methods=['DELETE'])
@require_admin
def delete_department(department_code):
    """Admin: delete an unused department tag."""
    try:
        code = _normalise_department_code(unquote_plus(department_code))
        if not code:
            return jsonify({'error': 'Department code is required'}), 400

        departments = _load_departments()
        if code not in departments:
            return jsonify({'error': f'Department {code} not found'}), 404

        asset_count = 0
        for asset in data_manager.inventory.values():
            if _normalise_department_code(getattr(asset, 'department_code', '')) != code:
                continue
            asset_count += max(1, _safe_int(getattr(asset, 'quantity', 1), 1)) if _is_bulk_asset(asset) else 1

        if asset_count:
            return jsonify({
                'error': f'Department {code} cannot be deleted because it still has {asset_count} asset(s). Move or delete those assets first.',
                'assetCount': asset_count,
            }), 409

        removed = departments.pop(code)
        _save_departments(departments)
        invalidate_cache()
        log_action(f"Deleted department {code} ({removed.get('name') or code})")

        return jsonify({'success': True, 'message': 'Department deleted successfully'})
    except Exception as e:
        logger.error(f"Error deleting department {department_code}: {e}", exc_info=True)
        return jsonify({'error': 'Failed to delete department'}), 500


@app.route('/api/users', methods=['GET'])
@require_admin
def get_users():
    """Admin: list users"""
    users_data = []
    can_see_all_companies = _current_user_is_super_admin()
    current_company_code = _normalise_company_code(_current_company_code(), DEFAULT_COMPANY_CODE)

    for user in sorted(data_manager.users.values(), key=lambda u: u.username.lower()):
        company_code = _user_assigned_company_code(user.username)
        if not can_see_all_companies and _normalise_company_code(company_code, DEFAULT_COMPANY_CODE) != current_company_code:
            continue

        company = _company_payload(company_code)
        users_data.append({
            'username': user.username,
            'isAdmin': user.is_admin,
            'isSuperAdmin': _is_super_admin_username(user.username),
            'isActive': getattr(user, 'is_active', True),
            'lastOnline': getattr(user, 'last_online', '-') or '-',
            'companyCode': company.get('code'),
            'companyName': company.get('name'),
        })

    return jsonify({'success': True, 'data': users_data})


@app.route('/api/users', methods=['POST'])
@require_admin
def create_user():
    """Admin: create user"""
    try:
        data = request.get_json() or {}

        username = (data.get('username') or '').strip()
        password = data.get('password') or ''
        is_admin = bool(data.get('isAdmin', False))
        is_super_admin = bool(data.get('isSuperAdmin', False))
        is_active = bool(data.get('isActive', True))
        requested_company = _normalise_company_code(data.get('companyCode') or _current_company_code(), DEFAULT_COMPANY_CODE)

        if not username:
            return jsonify({'error': 'Username is required'}), 400

        if not password:
            return jsonify({'error': 'Password is required'}), 400

        if username in data_manager.users:
            return jsonify({'error': 'User already exists'}), 409

        if data.get('companyCode') and not _current_user_is_super_admin():
            return jsonify({'error': 'Only the super admin can assign users to companies'}), 403

        if is_super_admin and not _current_user_is_super_admin():
            return jsonify({'error': 'Only the super admin can grant super admin access'}), 403

        if requested_company not in _all_company_records():
            return jsonify({'error': 'Company not found'}), 404

        salt = secrets.token_hex(16)
        password_hash = hash_password(password, salt)

        data_manager.users[username] = User(
            username=username,
            password_hash=password_hash,
            salt=salt,
            is_admin=is_admin or is_super_admin,
            is_active=is_active
        )

        data_manager.save_users()
        if is_super_admin:
            _set_user_super_admin(username, True)
        _reload_users_for_all_company_managers()
        _assign_user_to_company(username, requested_company)
        log_action(f"Created user {username}")

        return jsonify({'success': True, 'message': 'User created successfully'})

    except Exception as e:
        logger.error(f"Error creating user: {e}")
        return jsonify({'error': 'Failed to create user'}), 500


@app.route('/api/users/<username>', methods=['PUT'])
@require_admin
def update_user(username):
    """Admin: update username, privilege, and active state"""
    try:
        old_username = unquote_plus(username)
        was_self_update = old_username == session.get('user')

        user = data_manager.users.get(old_username)
        if not user:
            return jsonify({'error': 'User not found'}), 404

        if not _current_admin_can_manage_user(old_username):
            return jsonify({'error': 'You can only manage users assigned to your company'}), 403

        if (
            _is_super_admin_username(old_username)
            and not _current_user_is_super_admin()
            and old_username != session.get('user')
        ):
            return jsonify({'error': 'Only a super admin can change another super admin'}), 403

        data = request.get_json() or {}
        username_changed = False
        renamed_from = old_username
        renamed_to = old_username
        rename_counts = None
        requested_company = None
        requested_super_admin = None

        if 'companyCode' in data:
            if not _current_user_is_super_admin():
                return jsonify({'error': 'Only the super admin can assign users to companies'}), 403
            requested_company = _normalise_company_code(data.get('companyCode'), DEFAULT_COMPANY_CODE)
            if requested_company not in _all_company_records():
                return jsonify({'error': 'Company not found'}), 404

        if 'isSuperAdmin' in data:
            if not _current_user_is_super_admin():
                return jsonify({'error': 'Only the super admin can change super admin access'}), 403
            requested_super_admin = bool(data.get('isSuperAdmin'))

        # Rename user
        if 'username' in data:
            new_username = (data.get('username') or '').strip()

            if not new_username:
                return jsonify({'error': 'Username cannot be empty'}), 400

            if new_username != old_username and new_username in data_manager.users:
                return jsonify({'error': 'Username already exists'}), 409

            if new_username != old_username:
                del data_manager.users[old_username]
                user.username = new_username
                data_manager.users[new_username] = user
                username_changed = True
                renamed_to = new_username

                # If admin renamed themselves, keep session valid
                if session.get('user') == old_username:
                    session['user'] = new_username

                rename_counts = data_manager.update_username_references(old_username, new_username)

        # Update admin privilege
        if 'isAdmin' in data:
            new_is_admin = bool(data.get('isAdmin'))

            if not new_is_admin and (
                requested_super_admin is True or
                (_is_super_admin_username(user.username) and requested_super_admin is not False)
            ):
                return jsonify({'error': 'The super admin must remain an admin'}), 400

            user.is_admin = new_is_admin

        # Update active state
        if 'isActive' in data:
            new_is_active = bool(data.get('isActive'))

            user.is_active = new_is_active

        if requested_super_admin is True:
            user.is_admin = True

        if username_changed:
            registry = _load_company_registry()
            assigned_company = registry.get('userCompanies', {}).pop(renamed_from, None)
            if assigned_company:
                registry['userCompanies'][renamed_to] = assigned_company
                _save_company_registry(registry)
            _rename_super_admin_reference(renamed_from, renamed_to)

        if requested_company:
            _assign_user_to_company(user.username, requested_company)

        try:
            if requested_super_admin is not None:
                _set_user_super_admin(user.username, requested_super_admin)
        except ValueError as e:
            return jsonify({'error': str(e)}), 400

        data_manager.save_users()
        _reload_users_for_all_company_managers()

        if was_self_update:
            session['self_user_changes_pending'] = True

        if username_changed:
            if rename_counts is None:
                rename_counts = {}
            maintenance_reference_count = (
                rename_counts.get('maintenanceLogs', 0)
                + rename_counts.get('containerMaintenanceLogs', 0)
            )
            log_action(
                f"Renamed user {renamed_from} -> {renamed_to}; "
                f"updated {rename_counts.get('systemLogs', 0)} system log(s), "
                f"{rename_counts.get('eventLogs', 0)} event log(s), "
                f"{maintenance_reference_count} maintenance record(s)"
            )
            if maintenance_reference_count:
                invalidate_cache()
        else:
            log_action(f"Updated user {user.username}")

        return jsonify({
            'success': True,
            'message': 'User updated successfully',
            'data': {
                'username': user.username,
                'isAdmin': user.is_admin,
                'isSuperAdmin': _is_super_admin_username(user.username),
                'isActive': getattr(user, 'is_active', True),
                'companyCode': _user_assigned_company_code(user.username),
                'selfChangesPending': was_self_update,
            }
        })

    except Exception as e:
        logger.error(f"Error updating user {username}: {e}")
        return jsonify({'error': 'Failed to update user'}), 500


@app.route('/api/users/<username>/password', methods=['PUT'])
@require_admin
def reset_user_password(username):
    """Admin: reset user password"""
    try:
        username = unquote_plus(username)

        user = data_manager.users.get(username)
        if not user:
            return jsonify({'error': 'User not found'}), 404

        if not _current_admin_can_manage_user(username):
            return jsonify({'error': 'You can only manage users assigned to your company'}), 403

        if _is_super_admin_username(username) and not _current_user_is_super_admin():
            return jsonify({'error': 'Only a super admin can reset another super admin password'}), 403

        data = request.get_json() or {}
        new_password = data.get('password') or ''

        if not new_password:
            return jsonify({'error': 'New password is required'}), 400

        user.salt = secrets.token_hex(16)
        user.password_hash = hash_password(new_password, user.salt)

        data_manager.save_users()
        _reload_users_for_all_company_managers()
        log_action(f"Reset password for user {username}")

        return jsonify({'success': True, 'message': 'Password reset successfully'})

    except Exception as e:
        logger.error(f"Error resetting password for user {username}: {e}")
        return jsonify({'error': 'Failed to reset password'}), 500
# API Routes

@app.route('/api/users/<username>', methods=['DELETE'])
@require_admin
def delete_user(username):
    """Admin: delete user"""
    try:
        username = unquote_plus(username)

        if username == session.get('user'):
            return jsonify({'error': 'You cannot delete your own account'}), 400

        user = data_manager.users.get(username)
        if not user:
            return jsonify({'error': 'User not found'}), 404

        if not _current_admin_can_manage_user(username):
            return jsonify({'error': 'You can only manage users assigned to your company'}), 403

        if _is_super_admin_username(username) and not _current_user_is_super_admin():
            return jsonify({'error': 'Only a super admin can delete another super admin'}), 403

        try:
            if _is_super_admin_username(username):
                _set_user_super_admin(username, False)
        except ValueError as e:
            return jsonify({'error': str(e)}), 400

        del data_manager.users[username]
        data_manager.save_users()
        _reload_users_for_all_company_managers()
        registry = _load_company_registry()
        if username in registry.get('userCompanies', {}):
            registry['userCompanies'].pop(username, None)
            _save_company_registry(registry)

        log_action(f"Deleted user {username}")

        return jsonify({
            'success': True,
            'message': 'User deleted successfully'
        })

    except Exception as e:
        logger.error(f"Error deleting user {username}: {e}")
        return jsonify({'error': 'Failed to delete user'}), 500


def _safe_event_upload_filename(filename):
    raw_name = str(filename or '').replace('\\', '/')
    basename = os.path.basename(raw_name).strip()
    cleaned = sanitize_filename(basename)
    cleaned = re.sub(r'\s+', ' ', cleaned).strip().strip('.')

    if not cleaned:
        cleaned = f"upload-{secrets.token_hex(6)}"

    if len(cleaned) > 180:
        base, ext = os.path.splitext(cleaned)
        ext = ext[:20]
        cleaned = f"{base[:180 - len(ext)]}{ext}"

    return cleaned


def _unique_event_upload_path(folder, filename):
    base, ext = os.path.splitext(filename)
    candidate = os.path.join(folder, filename)
    counter = 2

    while os.path.exists(candidate):
        candidate = os.path.join(folder, f"{base}_{counter}{ext}")
        counter += 1

    return candidate


def _event_files_for_response(event_id):
    folder = data_manager.get_event_folder(event_id) if data_manager else None
    if not folder or not os.path.isdir(folder):
        return []

    files = []
    try:
        with os.scandir(folder) as entries:
            for entry in entries:
                if not entry.is_file():
                    continue
                try:
                    stat = entry.stat()
                except OSError:
                    continue

                files.append({
                    'name': entry.name,
                    'size': stat.st_size,
                    'modifiedAt': datetime.fromtimestamp(stat.st_mtime).isoformat(timespec='seconds'),
                    'downloadUrl': f"/api/events/{event_id}/files/{quote(entry.name)}"
                })
    except OSError as e:
        logger.warning("Failed to list files for event %s: %s", event_id, e)
        return []

    files.sort(key=lambda item: item['name'].lower())
    return files


def _event_file_path(event_id, filename):
    if not filename or '/' in filename or '\\' in filename:
        return None

    folder = data_manager.get_event_folder(event_id) if data_manager else None
    if not folder:
        return None

    base = os.path.abspath(folder)
    target = os.path.abspath(os.path.join(base, filename))

    if not target.startswith(base + os.sep):
        return None

    return target


MAINTENANCE_IMAGE_EXTENSIONS = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
}
MAINTENANCE_VIDEO_EXTENSIONS = {
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
}
CONVERTIBLE_IMAGE_EXTENSIONS = {
    '.bmp', '.gif', '.heic', '.heif', '.tif', '.tiff', '.webp'
}
CONVERTIBLE_VIDEO_EXTENSIONS = {
    '.3gp', '.avi', '.m4v', '.mkv', '.mpeg', '.mpg', '.webm', '.wmv'
}


def _maintenance_request_payload():
    if request.form:
        return request.form.to_dict(flat=True)
    data = request.get_json(silent=True)
    return data if isinstance(data, dict) else {}


def _uploaded_maintenance_media_files():
    files = []
    for key in ('media', 'maintenanceMedia', 'maintenanceMediaFiles', 'files', 'file', 'photos', 'videos'):
        files.extend(request.files.getlist(key))
    return [file for file in files if file and file.filename]


def _maintenance_media_root(create=False):
    if not data_manager or not getattr(data_manager, 'data_folder', ''):
        return None
    folder = os.path.join(data_manager.data_folder, 'maintenance_media')
    if create:
        os.makedirs(folder, exist_ok=True)
    return folder


def _safe_maintenance_media_name(filename, target_ext):
    raw_name = str(filename or '').replace('\\', '/')
    basename = os.path.basename(raw_name).strip()
    base, _ = os.path.splitext(basename)
    cleaned = sanitize_filename(base)
    cleaned = re.sub(r'\s+', ' ', cleaned).strip().strip('.')
    if not cleaned:
        cleaned = 'maintenance-media'

    target_ext = target_ext if target_ext.startswith('.') else f'.{target_ext}'
    if len(cleaned) + len(target_ext) > 180:
        cleaned = cleaned[:180 - len(target_ext)].rstrip()

    return f"{cleaned}{target_ext}"


def _maintenance_upload_target(uploaded_file):
    filename = str(uploaded_file.filename or '')
    _, ext = os.path.splitext(filename)
    ext = ext.lower()
    mime_type = (uploaded_file.mimetype or '').lower()

    if ext in MAINTENANCE_IMAGE_EXTENSIONS:
        target_ext = '.jpg' if ext == '.jpeg' else ext
        return 'image', target_ext, False, MAINTENANCE_IMAGE_EXTENSIONS[ext]
    if mime_type in ('image/jpeg', 'image/jpg'):
        return 'image', '.jpg', False, 'image/jpeg'
    if mime_type == 'image/png':
        return 'image', '.png', False, 'image/png'
    if mime_type.startswith('image/') or ext in CONVERTIBLE_IMAGE_EXTENSIONS:
        return 'image', '.png', True, 'image/png'

    if ext in MAINTENANCE_VIDEO_EXTENSIONS:
        return 'video', ext, False, MAINTENANCE_VIDEO_EXTENSIONS[ext]
    if mime_type == 'video/mp4':
        return 'video', '.mp4', False, 'video/mp4'
    if mime_type in ('video/quicktime', 'video/mov'):
        return 'video', '.mov', False, 'video/quicktime'
    if mime_type.startswith('video/') or ext in CONVERTIBLE_VIDEO_EXTENSIONS:
        return 'video', '.mp4', True, 'video/mp4'

    raise ValueError(f"Unsupported media file: {filename or 'unnamed file'}")


def _convert_image_upload(uploaded_file, target_path):
    try:
        from PIL import Image, ImageOps
    except ImportError:
        return False

    try:
        uploaded_file.stream.seek(0)
        with Image.open(uploaded_file.stream) as image:
            image = ImageOps.exif_transpose(image)
            if getattr(image, 'is_animated', False):
                image.seek(0)
            if image.mode not in ('RGB', 'RGBA', 'L', 'LA'):
                image = image.convert('RGBA')
            elif image.mode in ('L', 'LA'):
                image = image.convert('RGBA')
            image.save(target_path, format='PNG')
        return True
    except Exception as e:
        logger.warning("Failed to convert image upload %s: %s", uploaded_file.filename, e)
        return False


def _convert_video_upload(uploaded_file, target_path):
    ffmpeg = shutil.which('ffmpeg')
    if not ffmpeg:
        return False

    _, ext = os.path.splitext(str(uploaded_file.filename or ''))
    ext = ext if ext else '.upload'

    try:
        with tempfile.TemporaryDirectory() as temp_dir:
            input_path = os.path.join(temp_dir, f"input{ext}")
            uploaded_file.stream.seek(0)
            uploaded_file.save(input_path)
            result = subprocess.run(
                [
                    ffmpeg,
                    '-y',
                    '-i',
                    input_path,
                    '-c:v',
                    'libx264',
                    '-c:a',
                    'aac',
                    '-movflags',
                    '+faststart',
                    target_path,
                ],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=180,
                check=False,
            )
            if result.returncode != 0:
                logger.warning(
                    "ffmpeg could not convert maintenance video %s: %s",
                    uploaded_file.filename,
                    result.stderr.decode('utf-8', errors='ignore')[-1000:],
                )
                return False
        return os.path.exists(target_path) and os.path.getsize(target_path) > 0
    except Exception as e:
        logger.warning("Failed to convert video upload %s: %s", uploaded_file.filename, e)
        return False


def _maintenance_media_abs_path(media):
    root = _maintenance_media_root(create=False)
    if not root:
        return None

    relative_path = str((media or {}).get('path') or '').strip().replace('\\', '/')
    if not relative_path:
        return None

    parts = [part for part in relative_path.split('/') if part]
    if relative_path.startswith('/') or '..' in parts:
        return None

    target = os.path.abspath(os.path.join(data_manager.data_folder, *parts))
    base = os.path.abspath(root)
    if not target.startswith(base + os.sep):
        return None
    return target


def _cleanup_empty_maintenance_media_folder(path):
    root = _maintenance_media_root(create=False)
    if not root or not path:
        return

    folder = os.path.abspath(os.path.dirname(path))
    root = os.path.abspath(root)
    if folder == root or not folder.startswith(root + os.sep):
        return

    try:
        if os.path.isdir(folder) and not os.listdir(folder):
            os.rmdir(folder)
    except OSError:
        pass


def _delete_maintenance_media_files(log_entry):
    deleted = 0
    record = normalize_maintenance_log(log_entry)
    if (record.get('source') or {}).get('kind') == CONTAINER_MAINTENANCE_SOURCE:
        # Container media can be referenced by the container record and several
        # propagated asset records. Deleting one asset must not break the rest.
        return 0
    for media in record.get('media', []) or []:
        target_path = _maintenance_media_abs_path(media)
        if not target_path:
            continue
        try:
            if os.path.isfile(target_path):
                os.remove(target_path)
                deleted += 1
            _cleanup_empty_maintenance_media_folder(target_path)
        except OSError as e:
            logger.warning("Failed to delete maintenance media %s: %s", target_path, e)
    return deleted


def _remove_maintenance_media_references(media_id):
    """Remove one media record everywhere it is referenced.

    Container maintenance records are copied into each member asset's history,
    so deleting by media ID must update both the source container and every
    durable asset copy.
    """
    media_id = str(media_id or '').strip()
    result = {
        'media': None,
        'referenceCount': 0,
        'inventoryChanged': False,
        'containersChanged': False,
    }
    if not media_id or not data_manager:
        return result

    owner_groups = (
        (data_manager.inventory.values(), 'inventoryChanged'),
        (data_manager.containers.values(), 'containersChanged'),
    )
    for owners, changed_key in owner_groups:
        for owner in owners:
            logs = getattr(owner, 'maintenance_logs', []) or []
            for index, log_entry in enumerate(logs):
                record = normalize_maintenance_log(log_entry)
                retained_media = []
                removed_from_log = 0
                for media in record.get('media', []) or []:
                    if str(media.get('id') or '').strip() == media_id:
                        if result['media'] is None:
                            result['media'] = dict(media)
                        removed_from_log += 1
                    else:
                        retained_media.append(media)

                if removed_from_log:
                    record['media'] = retained_media
                    logs[index] = record
                    result['referenceCount'] += removed_from_log
                    result[changed_key] = True

    return result


def _save_maintenance_media_files(log_entry, uploaded_files):
    incoming_files = [file for file in (uploaded_files or []) if file and file.filename]
    if not incoming_files:
        return []

    root = _maintenance_media_root(create=True)
    if not root:
        raise ValueError('Maintenance media folder could not be created')

    log_id = (log_entry.get('id') or '').strip()
    if not log_id:
        log_id = make_maintenance_log_id()
        log_entry['id'] = log_id

    log_folder = os.path.join(root, log_id)
    os.makedirs(log_folder, exist_ok=True)

    media_records = []
    saved_paths = []
    try:
        for uploaded_file in incoming_files:
            kind, target_ext, should_convert, mime_type = _maintenance_upload_target(uploaded_file)
            media_id = secrets.token_hex(10)
            target_path = os.path.join(log_folder, f"{media_id}{target_ext}")
            display_name = _safe_maintenance_media_name(uploaded_file.filename, target_ext)

            if should_convert:
                converted = (
                    _convert_image_upload(uploaded_file, target_path)
                    if kind == 'image'
                    else _convert_video_upload(uploaded_file, target_path)
                )
                if not converted:
                    if kind == 'image':
                        raise ValueError(f"Could not convert {uploaded_file.filename} to PNG")
                    raise ValueError(f"Could not convert {uploaded_file.filename} to MP4")
            else:
                uploaded_file.stream.seek(0)
                uploaded_file.save(target_path)

            if not os.path.isfile(target_path):
                raise ValueError(f"Could not save {uploaded_file.filename}")

            saved_paths.append(target_path)
            relative_path = os.path.relpath(target_path, data_manager.data_folder).replace(os.sep, '/')
            media_records.append({
                'id': media_id,
                'name': display_name,
                'path': relative_path,
                'kind': kind,
                'mimeType': mime_type or mimetypes.guess_type(display_name)[0] or '',
                'size': os.path.getsize(target_path),
            })
    except Exception:
        for path in saved_paths:
            try:
                if os.path.isfile(path):
                    os.remove(path)
                _cleanup_empty_maintenance_media_folder(path)
            except OSError:
                pass
        raise

    return media_records


def _maintenance_media_for_response(media):
    item = dict(media or {})
    media_id = str(item.get('id') or '').strip()
    if media_id:
        item['url'] = f"/api/maintenance-media/{quote(media_id)}"
    return item


def _maintenance_log_for_response(log_entry):
    record = normalize_maintenance_log(log_entry)
    record['media'] = [
        _maintenance_media_for_response(media)
        for media in (record.get('media') or [])
    ]
    return record


def _find_maintenance_media(media_id):
    media_id = str(media_id or '').strip()
    if not media_id:
        return None, None, None

    for asset in (data_manager.inventory.values() if data_manager else []):
        for log_entry in getattr(asset, 'maintenance_logs', []) or []:
            record = normalize_maintenance_log(log_entry)
            for media in record.get('media', []) or []:
                if str(media.get('id') or '').strip() == media_id:
                    return asset, record, media

    for container in (data_manager.containers.values() if data_manager else []):
        for log_entry in getattr(container, 'maintenance_logs', []) or []:
            record = normalize_maintenance_log(log_entry)
            for media in record.get('media', []) or []:
                if str(media.get('id') or '').strip() == media_id:
                    return container, record, media

    return None, None, None


@app.route('/api/maintenance-media/<media_id>', methods=['GET'])
@require_auth
def download_maintenance_media(media_id):
    """View media attached to a maintenance log."""
    try:
        asset, record, media = _find_maintenance_media(media_id)
        if not asset or not record or not media:
            return jsonify({'error': 'Media not found'}), 404

        target_path = _maintenance_media_abs_path(media)
        if not target_path or not os.path.isfile(target_path):
            return jsonify({'error': 'Media file not found'}), 404

        return send_file(
            target_path,
            as_attachment=False,
            download_name=media.get('name') or os.path.basename(target_path),
            mimetype=media.get('mimeType') or mimetypes.guess_type(target_path)[0] or 'application/octet-stream'
        )
    except Exception as e:
        logger.error(f"Error downloading maintenance media {media_id}: {e}")
        return jsonify({'error': 'Failed to load maintenance media'}), 500


@app.route('/api/maintenance-media/<media_id>', methods=['DELETE'])
@require_auth
@with_inventory_action_lock
def delete_maintenance_media(media_id):
    """Permanently remove one maintenance attachment and all of its references."""
    try:
        if not _current_user_is_admin():
            return jsonify({'error': 'Admin privileges required to remove maintenance media'}), 403

        media_id = unquote_plus(str(media_id or '')).strip()
        removal = _remove_maintenance_media_references(media_id)
        media = removal.get('media')
        if not media:
            return jsonify({'error': 'Media not found'}), 404

        if removal['inventoryChanged']:
            data_manager.save_inventory()
        if removal['containersChanged']:
            data_manager.save_containers()

        target_path = _maintenance_media_abs_path(media)
        file_deleted = False
        if target_path:
            try:
                if os.path.isfile(target_path):
                    os.remove(target_path)
                    file_deleted = True
                _cleanup_empty_maintenance_media_folder(target_path)
            except OSError as exc:
                logger.error("Failed to permanently delete maintenance media %s: %s", target_path, exc)
                return jsonify({
                    'error': 'Media was removed from maintenance logs, but its stored file could not be deleted'
                }), 500

        invalidate_cache()
        log_action(
            f"Removed maintenance media {media.get('name') or media_id} "
            f"from {removal['referenceCount']} record(s) (deleted by {session['user']})"
        )
        return jsonify({
            'success': True,
            'message': 'Maintenance media permanently deleted',
            'deletedReferenceCount': removal['referenceCount'],
            'fileDeleted': file_deleted,
        })
    except Exception as exc:
        logger.error("Error deleting maintenance media %s: %s", media_id, exc, exc_info=True)
        return jsonify({'error': f'Failed to delete maintenance media: {str(exc)}'}), 500


@app.route('/api/events', methods=['GET'])
@require_auth
def get_events():
    """Get all events"""
    try:
        refresh_event_states_for_read()

        events_data = []
        for event in data_manager.events.values():
            # Initialize actually_prepared if missing
            if not hasattr(event, 'actually_prepared'):
                event.actually_prepared = []
            if not hasattr(event, 'extra_assets'):
                event.extra_assets = []
            extra_asset_ids = set(getattr(event, 'extra_assets', []) or [])

            # Build model groups for this event
            model_groups = {}
            has_model_assignments = False
            
            for asset_id in event.prepared_items:
                if asset_id.startswith('[MODEL]'):
                    has_model_assignments = True
                    try:
                        parts = asset_id[7:].split('|')
                        if len(parts) >= 4:
                            dept = parts[0]
                            brand = parts[1]
                            model = parts[2]
                            quantity = int(parts[3])
                            description = parts[4] if len(parts) > 4 else ''
                            
                            model_key = '|'.join(_model_key_from_parts(dept, brand, model))
                            
                            if model_key not in model_groups:
                                model_groups[model_key] = {
                                    'department': dept,
                                    'brand': brand,
                                    'model': model,
                                    'description': description,
                                    'requiredQuantity': quantity,
                                    'assignedAssets': [],
                                    'status': 'pending'
                                }
                            else:
                                model_groups[model_key]['requiredQuantity'] += quantity
                            
                            # Find assigned specific assets for this model.
                            # Extras are included in assignedAssets so model cards can show
                            # values like 5/3 assigned (+2 extra), but they are flagged and
                            # excluded later from event/department readiness totals.
                            all_model_asset_ids = set(event.actually_prepared or []) | set(event.returned_items or [])
                            for specific_asset_id in all_model_asset_ids:
                                is_extra_asset = specific_asset_id in extra_asset_ids
                                specific_asset = data_manager.inventory.get(specific_asset_id)
                                if (specific_asset and 
                                    specific_asset.brand == brand and 
                                    specific_asset.model_number == model and
                                    specific_asset.department_code == dept):
                                    
                                    asset_status = 'returned' if specific_asset_id in event.returned_items else 'prepared'
                                    
                                    model_groups[model_key]['assignedAssets'].append({
                                        'id': specific_asset_id,
                                        'serial': specific_asset.serial_number,
                                        'serial2': getattr(specific_asset, 'secondary_serial_number', ''),
                                        'status': asset_status,
                                        'location': specific_asset.current_location,
                                        'quantity': 1,
                                        'isExtra': is_extra_asset
                                    })
                            
                            # Determine overall model status - FIXED LOGIC
                            assigned_count = len(model_groups[model_key]['assignedAssets'])
                            returned_count = len([a for a in model_groups[model_key]['assignedAssets'] if a['status'] == 'returned'])
                            
                            if returned_count == assigned_count and returned_count == quantity:
                                model_groups[model_key]['status'] = 'returned'
                            elif assigned_count >= quantity:
                                model_groups[model_key]['status'] = 'ready'
                            elif assigned_count > 0:
                                model_groups[model_key]['status'] = 'partial'
                            else:
                                model_groups[model_key]['status'] = 'pending'
                                
                    except Exception as e:
                        logger.error(f"Error parsing model assignment {asset_id}: {e}")
                        continue

            _append_bulk_assignments_to_model_groups(model_groups, event)
            _append_orphan_extra_assignments_to_model_groups(model_groups, event)
            _refresh_model_group_statuses(model_groups)

            # Calculate totals including custom item quantities.
            custom_counts = _custom_counts_for_event(event)
            if has_model_assignments:
                total_required = 0
                total_prepared = 0
                total_returned = 0

                for model_group in model_groups.values():
                    required_quantity = max(0, _safe_int(model_group.get('requiredQuantity', 0), 0))
                    total_required += required_quantity

                    prepared_assets_count = max(0, _safe_int(model_group.get('countablePreparedQuantity', 0), 0))
                    returned_assets_count = max(0, _safe_int(model_group.get('countableReturnedQuantity', 0), 0))

                    total_prepared += min(prepared_assets_count, required_quantity) if required_quantity > 0 else prepared_assets_count
                    total_returned += min(returned_assets_count, required_quantity) if required_quantity > 0 else returned_assets_count

                total_required += custom_counts['required']
                total_prepared += custom_counts['preparedActive']
                total_returned += custom_counts['returned']
            else:
                specific_counts = _event_specific_counts(event)
                total_required = specific_counts['required'] + custom_counts['required']
                total_prepared = specific_counts['preparedActive'] + custom_counts['preparedActive']
                total_returned = specific_counts['returned'] + custom_counts['returned']

            returnable_counts = _event_returnable_counts(event)

            events_data.append({
                'id': event.event_id,
                'name': event.name,
                'location': getattr(event, 'location', '') or '',
                'startDate': format_date_output(event.start_date),
                'endDate': format_date_output(event.end_date),
                'state': event.state,  # Keep original state, don't force update
                'tag': getattr(event, 'tag', 'events'), 
                'assetCount': total_required,
                'preparedCount': total_prepared,
                'returnedCount': total_returned,
                'extraCount': _event_extra_asset_quantity(event),
                'assetModels': event.asset_models,
                'preparedItems': event.prepared_items,
                'actuallyPrepared': event.actually_prepared,
                'returnedItems': event.returned_items,
                'customCollected': getattr(event, 'custom_collected', []),
                'returnableCount': returnable_counts['returnable'],
                'returnableTotalCount': returnable_counts['total'],
                'returnableRefs': returnable_counts['refs'],
                'modelGroups': model_groups,
                'hasModelAssignments': has_model_assignments,  # Flag to know which logic to use
                'forceStateOverride': getattr(event, 'force_state_override', False),
                'hasNotes': bool((getattr(event, 'notes', '') or '').strip()),
                'fileCount': len(_event_files_for_response(event.event_id))
            })

        # Sort by event ID descending
        events_data.sort(key=lambda x: x['id'], reverse=True)

        return jsonify({'success': True, 'data': events_data})
    except Exception as e:
        logger.error(f"Error getting events: {e}")
        return jsonify({'error': 'Failed to retrieve events'}), 500

@app.route('/api/events/<int:event_id>', methods=['GET'])
@require_auth
def get_event(event_id):
    """Get a specific event with detailed asset information"""
    try:
        event = data_manager.events.get(event_id)
        if not event:
            return jsonify({'error': 'Event not found'}), 404

        refresh_event_states_for_read([event])

        # Initialize lists if they don't exist
        if not hasattr(event, 'actually_prepared'):
            event.actually_prepared = []
        if not hasattr(event, 'extra_assets'):
            event.extra_assets = []
        extra_asset_ids = set(getattr(event, 'extra_assets', []) or [])

        # Get detailed asset information grouped by department
        assets_by_department = defaultdict(list)
        assigned_assets = []
        prepared_assets = []
        returned_assets = []

        # Process ALL items in prepared_items (including model assignments)
        for asset_id in event.prepared_items:
            asset_info = None

            custom = _parse_custom_marker(asset_id)
            if custom:
                # Structured or legacy custom item. Legacy [LOAN]/[MISC] rows default to UN.
                dept = custom.get('department') or 'UN'
                status = _custom_status(event, asset_id)
                is_collected = asset_id in getattr(event, 'custom_collected', [])
                asset_info = {
                    'id': asset_id,
                    'name': _custom_display_name(custom),
                    'displayName': _custom_display_name(custom),
                    'brand': '',
                    'model': custom.get('name', ''),
                    'description': custom.get('company', '') if custom.get('type') == 'LOAN' else '',
                    'serial': '',
                    'department': dept,
                    'company': custom.get('company', ''),
                    'quantity': custom.get('quantity', 1),
                    'status': status,
                    'customType': custom.get('type'),
                    'isCustom': True,
                    'isLoanOrMisc': True,
                    'isCollected': is_collected,
                    'needsCollection': custom.get('type') == 'LOAN',
                    'isExtra': asset_id in event.extra_assets
                }
            elif asset_id.startswith('[MODEL]'):
                    continue
            else:
                # Handle regular assets
                asset = data_manager.inventory.get(asset_id)
                if asset:
                    dept = asset.department_code

                    # Determine status
                    if asset_id in event.returned_items:
                        status = 'returned'
                    elif asset_id in event.actually_prepared:
                        status = 'prepared'
                    else:
                        status = 'assigned'

                    # Keep the explicit extra marker. A manual over-prepared asset
                    # may match an existing model row, but it should still display
                    # as extra unless a container scan intentionally raised the
                    # requirement and removed it from event.extra_assets.
                    is_extra = asset_id in event.extra_assets

                    asset_info = {
                        'id': asset.asset_id,
                        'name': f"{asset.brand} {asset.model_number} - {asset.description}",
                        'brand': asset.brand,
                        'model': asset.model_number,
                        'description': asset.description,
                        'serial': asset.serial_number,
                        'serial2': getattr(asset, 'secondary_serial_number', ''),
                        'status': status,
                        'location': asset.current_location,
                        'isMissing': asset.is_missing,
                        'isOOC': asset.is_ooc,
                        'isLoanOrMisc': False,
                        'isExtra': is_extra
                    }

            if asset_info:
                assets_by_department[dept].append(asset_info)

                # Categorize assets
                if asset_info['status'] == 'returned':
                    returned_assets.append(asset_info)
                elif asset_info['status'] == 'prepared':
                    prepared_assets.append(asset_info)
                else:
                    assigned_assets.append(asset_info)

        # Also process any assets that are in actually_prepared but not in prepared_items.
        # Model-fulfilled assets live here; only explicit extra_assets are extras.
        for asset_id in event.actually_prepared:
            # Check if this asset was already processed above
            already_processed = False
            for dept_assets in assets_by_department.values():
                if any(existing_asset['id'] == asset_id for existing_asset in dept_assets):
                    already_processed = True
                    break

            if not already_processed:
                asset = data_manager.inventory.get(asset_id)
                if asset:
                    dept = asset.department_code
                    is_extra = asset_id in extra_asset_ids

                    # Determine status
                    if asset_id in event.returned_items:
                        status = 'returned'
                    else:
                        status = 'prepared'

                    asset_info = {
                        'id': asset.asset_id,
                        'name': f"{asset.brand} {asset.model_number} - {asset.description}",
                        'brand': asset.brand,
                        'model': asset.model_number,
                        'description': asset.description,
                        'serial': asset.serial_number,
                        'serial2': getattr(asset, 'secondary_serial_number', ''),
                        'status': status,
                        'location': asset.current_location,
                        'isMissing': asset.is_missing,
                        'isOOC': asset.is_ooc,
                        'isLoanOrMisc': False,
                        'isExtra': is_extra
                    }

                    assets_by_department[dept].append(asset_info)

                    # Categorize assets
                    if asset_info['status'] == 'returned':
                        returned_assets.append(asset_info)
                    else:
                        prepared_assets.append(asset_info)

        # Sort departments and assets within each department
        sorted_departments = {}
        for dept in sorted(assets_by_department.keys()):
            sorted_departments[dept] = sorted(
                assets_by_department[dept], key=lambda x: x['id'])

        # Group assets by model for cleaner display
        model_groups = {}
        for asset_id in event.prepared_items:
            if asset_id.startswith('[MODEL]'):
                # Parse model assignment
                try:
                    parts = asset_id[7:].split('|')
                    if len(parts) >= 4:
                        dept = parts[0]
                        brand = parts[1]
                        model = parts[2]
                        quantity = int(parts[3])
                        description = parts[4] if len(parts) > 4 else ''

                        model_key = '|'.join(_model_key_from_parts(dept, brand, model))

                        if model_key not in model_groups:
                            model_groups[model_key] = {
                                'department': dept,
                                'brand': brand,
                                'model': model,
                                'description': description,
                                'requiredQuantity': quantity,
                                'assignedAssets': [],
                                'status': 'pending'
                            }
                        else:
                            model_groups[model_key]['requiredQuantity'] += quantity

                        # Find assigned specific assets for this model
                        # Check both actually_prepared and all inventory assets
                        all_potential_assets = set()
                        if hasattr(event, 'actually_prepared'):
                            all_potential_assets.update(event.actually_prepared)
                        
                        # Also check returned items as they might have been assigned to this model
                        all_potential_assets.update(event.returned_items)
                        
                        logger.debug(f"Checking assets for model {brand} {model}: {all_potential_assets}")
                        
                        extra_asset_ids = set(getattr(event, 'extra_assets', []) or [])
                        for specific_asset_id in all_potential_assets:
                            is_extra_asset = specific_asset_id in extra_asset_ids
                            specific_asset = data_manager.inventory.get(specific_asset_id)
                            
                            if specific_asset:
                                logger.debug(f"Asset {specific_asset_id}: brand={specific_asset.brand}, model={specific_asset.model_number}, dept={specific_asset.department_code}")
                                logger.debug(f"Looking for: brand={brand}, model={model}, dept={dept}")
                                
                                description = parts[4] if len(parts) > 4 else ''
                                if (specific_asset and 
                                    specific_asset.brand == brand and 
                                    specific_asset.model_number == model and
                                    specific_asset.department_code == dept):

                                    # Check if this asset is returned
                                    asset_status = 'returned' if specific_asset_id in event.returned_items else 'prepared'
                                    logger.debug(f"Asset {specific_asset_id} matches model and has status: {asset_status}")

                                    model_groups[model_key]['assignedAssets'].append({
                                        'id': specific_asset_id,
                                        'serial': specific_asset.serial_number,
                                        'serial2': getattr(specific_asset, 'secondary_serial_number', ''),
                                        'status': asset_status,
                                        'location': specific_asset.current_location,
                                        'quantity': 1,
                                        'isExtra': is_extra_asset
                                    })

                        # Determine overall model status - FIXED LOGIC
                        assigned_count = len(model_groups[model_key]['assignedAssets'])
                        returned_count = len([a for a in model_groups[model_key]['assignedAssets'] if a['status'] == 'returned'])
                        prepared_count = assigned_count - returned_count

                        logger.debug(f"Model {brand} {model}: assigned={assigned_count}, returned={returned_count}, prepared={prepared_count}, required={quantity}")

                        if returned_count == assigned_count and assigned_count > 0:
                            model_groups[model_key]['status'] = 'returned'
                        elif prepared_count >= quantity:
                            model_groups[model_key]['status'] = 'ready'
                        elif prepared_count > 0:
                            model_groups[model_key]['status'] = 'partial'
                        else:
                            model_groups[model_key]['status'] = 'pending'

                        logger.debug(f"Model {brand} {model} final status: {model_groups[model_key]['status']}")

                except Exception as e:
                    logger.error(f"Error parsing model assignment {asset_id}: {e}")

        _append_bulk_assignments_to_model_groups(model_groups, event)
        _append_orphan_extra_assignments_to_model_groups(model_groups, event)
        _refresh_model_group_statuses(model_groups)

        # Add prepared/returned bulk quantity markers to the department asset lists.
        for bulk_value in getattr(event, 'actually_prepared', []) or []:
            marker = _parse_bulk_marker(bulk_value)
            if not marker:
                continue
            bulk_asset = data_manager.inventory.get(marker['bulkId'])
            if not bulk_asset or not _is_bulk_asset(bulk_asset):
                continue
            status = 'returned' if bulk_value in getattr(event, 'returned_items', []) else 'prepared'
            bulk_info = {
                'id': bulk_value,
                'bulkId': marker['bulkId'],
                'displayId': '',
                'name': f"{bulk_asset.brand} {bulk_asset.model_number} - {bulk_asset.description} (Qty: {marker['quantity']})",
                'brand': bulk_asset.brand,
                'model': bulk_asset.model_number,
                'description': bulk_asset.description,
                'serial': '',
                'status': status,
                'location': bulk_asset.current_location or bulk_asset.default_location,
                'isMissing': bulk_asset.is_missing,
                'isOOC': bulk_asset.is_ooc,
                'isLoanOrMisc': False,
                'isExtra': False,
                'isBulk': True,
                'quantity': marker['quantity']
            }
            assets_by_department[bulk_asset.department_code].append(bulk_info)
            if status == 'returned':
                returned_assets.append(bulk_info)
            else:
                prepared_assets.append(bulk_info)

        # Re-sort departments after adding bulk markers.
        sorted_departments = {}
        for dept in sorted(assets_by_department.keys()):
            sorted_departments[dept] = sorted(
                assets_by_department[dept], key=lambda x: x.get('id', ''))

        # Calculate totals based on model requirements, direct assets, and custom item quantities.
        has_model_assignments = len(model_groups) > 0
        custom_counts = _custom_counts_for_event(event)

        if has_model_assignments:
            total_required = 0
            total_prepared = 0
            total_returned = 0

            for model_group in model_groups.values():
                required_quantity = max(0, _safe_int(model_group.get('requiredQuantity', 0), 0))
                total_required += required_quantity

                # Event/department totals must not include manual extras.
                prepared_assets_count = max(0, _safe_int(model_group.get('countablePreparedQuantity', 0), 0))
                returned_assets_count = max(0, _safe_int(model_group.get('countableReturnedQuantity', 0), 0))

                total_prepared += min(prepared_assets_count, required_quantity) if required_quantity > 0 else prepared_assets_count
                total_returned += min(returned_assets_count, required_quantity) if required_quantity > 0 else returned_assets_count

            total_required += custom_counts['required']
            total_prepared += custom_counts['preparedActive']
            total_returned += custom_counts['returned']
        else:
            specific_counts = _event_specific_counts(event)
            total_required = specific_counts['required'] + custom_counts['required']
            total_prepared = specific_counts['preparedActive'] + custom_counts['preparedActive']
            total_returned = specific_counts['returned'] + custom_counts['returned']

        total_extra_assets = _event_extra_asset_quantity(event)

        logger.debug(
            f"Event {event_id} final asset counts - Required: {total_required}, "
            f"Prepared: {total_prepared}, Returned: {total_returned}, "
            f"Active extras: {total_extra_assets}, Extra assets in list: {len(event.extra_assets)}"
        )
            
        returnable_counts = _event_returnable_counts(event)

        event_data = {
            'id': event.event_id,
            'name': event.name,
            'location': getattr(event, 'location', '') or '',
            'startDate': format_date_output(event.start_date),
            'endDate': format_date_output(event.end_date),    
            'state': event.state,
            'tag': getattr(event, 'tag', 'events'), 
            'assetModels': event.asset_models,
            'preparedItems': event.prepared_items,
            'actuallyPrepared': event.actually_prepared,
            'returnedItems': event.returned_items,
            'extraAssets': event.extra_assets,
            'customCollected': getattr(event, 'custom_collected', []),
            'returnableCount': returnable_counts['returnable'],
            'returnableTotalCount': returnable_counts['total'],
            'returnableRefs': returnable_counts['refs'],
            'assetsByDepartment': sorted_departments,
            'assignedAssets': assigned_assets,
            'preparedAssets': prepared_assets,
            'returnedAssets': returned_assets,
            'totalAssets': total_required,
            'totalPrepared': total_prepared,
            'totalReturned': total_returned,
            'totalExtraAssets': total_extra_assets,
            'modelGroups': model_groups,
            'forceStateOverride': getattr(event, 'force_state_override', False),
            'notes': getattr(event, 'notes', '') or '',
            'files': _event_files_for_response(event.event_id),
            'canDeleteFiles': _current_user_is_admin(),
            'eventLogs': data_manager.normalize_event_logs(getattr(event, 'event_logs', []))
        }

        return jsonify({'success': True, 'data': event_data})

    except Exception as e:
        logger.error(f"Error getting event {event_id}: {e}")
        return jsonify({'error': 'Failed to retrieve event'}), 500


@app.route('/api/events/<int:event_id>/notes', methods=['PUT'])
@require_auth
def update_event_notes(event_id):
    """Update the plaintext notes attached to an event."""
    try:
        event = data_manager.events.get(event_id)
        if not event:
            return jsonify({'error': 'Event not found'}), 404

        data = request.get_json(silent=True) or {}
        notes = str(data.get('notes', ''))
        if len(notes) > 50000:
            return jsonify({'error': 'Notes cannot exceed 50,000 characters'}), 400

        event.notes = notes
        data_manager.events[event_id] = event
        data_manager.save_event(event)

        log_action(f"Updated notes for event {event_id}: {event.name}")
        mark_realtime_change('event-notes', {'eventId': event_id})

        return jsonify({'success': True, 'message': 'Event notes updated', 'data': {'notes': event.notes}})
    except Exception as e:
        logger.error(f"Error updating notes for event {event_id}: {e}")
        return jsonify({'error': 'Failed to update event notes'}), 500


@app.route('/api/events/<int:event_id>/files', methods=['POST'])
@require_auth
def upload_event_files(event_id):
    """Upload one or more files into the event-specific folder."""
    try:
        event = data_manager.events.get(event_id)
        if not event:
            return jsonify({'error': 'Event not found'}), 404

        incoming_files = request.files.getlist('files')
        if not incoming_files and 'file' in request.files:
            incoming_files = request.files.getlist('file')

        if not incoming_files:
            return jsonify({'error': 'Choose at least one file to upload'}), 400

        folder = data_manager.get_event_folder(event_id, create=True)
        if not folder:
            return jsonify({'error': 'Event folder could not be created'}), 500

        saved_files = []
        for uploaded_file in incoming_files:
            if not uploaded_file or not uploaded_file.filename:
                continue

            filename = _safe_event_upload_filename(uploaded_file.filename)
            target_path = _unique_event_upload_path(folder, filename)
            uploaded_file.save(target_path)
            saved_files.append(os.path.basename(target_path))

        if not saved_files:
            return jsonify({'error': 'No valid files were uploaded'}), 400

        log_action(f"Uploaded {len(saved_files)} file(s) to event {event_id}: {event.name}")
        mark_realtime_change('event-files', {'eventId': event_id})

        return jsonify({
            'success': True,
            'message': 'File upload complete',
            'data': _event_files_for_response(event_id)
        })
    except Exception as e:
        logger.error(f"Error uploading files for event {event_id}: {e}")
        return jsonify({'error': 'Failed to upload event files'}), 500


@app.route('/api/events/<int:event_id>/files/<path:filename>', methods=['GET'])
@require_auth
def download_event_file(event_id, filename):
    """Download a file attached to an event."""
    try:
        if event_id not in data_manager.events:
            return jsonify({'error': 'Event not found'}), 404

        target_path = _event_file_path(event_id, filename)
        if not target_path or not os.path.exists(target_path) or not os.path.isfile(target_path):
            return jsonify({'error': 'File not found'}), 404

        return send_file(
            target_path,
            as_attachment=True,
            download_name=os.path.basename(target_path)
        )
    except Exception as e:
        logger.error(f"Error downloading file {filename} for event {event_id}: {e}")
        return jsonify({'error': 'Failed to download event file'}), 500


@app.route('/api/events/<int:event_id>/files/<path:filename>', methods=['DELETE'])
@require_admin
def delete_event_file_upload(event_id, filename):
    """Delete a file attached to an event. Admin only."""
    try:
        event = data_manager.events.get(event_id)
        if not event:
            return jsonify({'error': 'Event not found'}), 404

        target_path = _event_file_path(event_id, filename)
        if not target_path or not os.path.exists(target_path) or not os.path.isfile(target_path):
            return jsonify({'error': 'File not found'}), 404

        os.remove(target_path)

        log_action(f"Deleted file '{os.path.basename(target_path)}' from event {event_id}: {event.name}")
        mark_realtime_change('event-files', {'eventId': event_id})

        return jsonify({
            'success': True,
            'message': 'Event file deleted',
            'data': _event_files_for_response(event_id)
        })
    except Exception as e:
        logger.error(f"Error deleting file {filename} for event {event_id}: {e}")
        return jsonify({'error': 'Failed to delete event file'}), 500


@app.route('/api/events/<int:event_id>/availability', methods=['GET'])
@require_auth
def get_event_model_availability(event_id):
    """
    Compute model availability for an event.

    Rules:
    - Group by department + brand + model. Description is display text only.
    - Exclude decommissioned assets.
    - Keep OOC and Missing assets in the physical total, but do not count them as available.
    - Include Degraded assets as available because they can still be prepared with a warning.
    - Subtract current event's requested quantity.
    - Subtract overlapping events' requested quantity.
    - Still return rows with 0 availability so the frontend can show them.
    """
    try:
        event = data_manager.events.get(event_id)
        if not event:
            return jsonify({'error': 'Event not found'}), 404

        physical_by_key = defaultdict(int)
        asset_ooc_by_key = defaultdict(int)
        asset_missing_by_key = defaultdict(int)
        maintenance_ooc_by_key = defaultdict(int)
        maintenance_missing_by_key = defaultdict(int)
        maintenance_degraded_by_key = defaultdict(int)

        # Physical inventory: exclude decommissioned assets. Missing and OOC
        # units stay in the denominator so the UI can explain why the available
        # count is lower than the total.
        for asset in data_manager.inventory.values():
            if not asset:
                continue

            if _is_disposed(asset):
                continue

            key = _asset_group_key(asset)
            inventory_quantity = _asset_inventory_quantity(asset)
            physical_by_key[key] += inventory_quantity

            if getattr(asset, 'is_missing', False):
                asset_missing_by_key[key] += inventory_quantity
                # A whole-asset Missing flag already makes every bulk unit
                # unavailable, so do not count its per-unit fault logs twice.
                continue

            if getattr(asset, 'is_ooc', False):
                asset_ooc_by_key[key] += inventory_quantity
                # A whole-asset OOC flag already makes every bulk unit
                # unavailable, so do not count its per-unit fault logs twice.
                continue

            if _is_bulk_asset(asset):
                counts = _bulk_maintenance_quantity_counts(asset)
                maintenance_ooc_by_key[key] += counts['ooc']
                maintenance_missing_by_key[key] += counts['missing']
                degraded_quantity = counts['degraded']
                if _is_degraded(asset):
                    degraded_quantity = max(
                        degraded_quantity,
                        max(_asset_inventory_quantity(asset) - counts['ooc'] - counts['missing'], 0)
                    )
                maintenance_degraded_by_key[key] += degraded_quantity

        # Quantity already reserved/requested in this same event.  This includes
        # normal model rows plus any specific prepared bulk/individual assets.
        used_here_by_key = _event_reserved_quantities_by_key(event)

        # Demand from overlapping events
        overlap_by_key = defaultdict(int)
        overlap_events_by_key = defaultdict(list)

        my_start = getattr(event, 'start_date', '')
        my_end = getattr(event, 'end_date', '')

        for other in data_manager.events.values():
            if not other or other.event_id == event_id:
                continue

            if not _ranges_overlap(
                my_start,
                my_end,
                getattr(other, 'start_date', ''),
                getattr(other, 'end_date', '')
            ):
                continue

            for key, quantity in _event_reserved_quantities_by_key(other).items():
                if quantity <= 0:
                    continue
                overlap_by_key[key] += quantity
                overlap_events_by_key[key].append({
                    'eventId': other.event_id,
                    'eventName': getattr(other, 'name', '') or f'Event {other.event_id}',
                    'startDate': _format_event_date_for_response(getattr(other, 'start_date', '')),
                    'endDate': _format_event_date_for_response(getattr(other, 'end_date', '')),
                    'quantity': quantity,
                })

        result = []

        for key, physical in physical_by_key.items():
            department, brand, model, description = key

            used_here = used_here_by_key.get(key, 0)
            overlap = overlap_by_key.get(key, 0)
            asset_ooc = asset_ooc_by_key.get(key, 0)
            asset_missing = asset_missing_by_key.get(key, 0)
            maintenance_ooc = maintenance_ooc_by_key.get(key, 0)
            maintenance_missing = maintenance_missing_by_key.get(key, 0)
            maintenance_degraded = maintenance_degraded_by_key.get(key, 0)
            available = max(
                physical - used_here - overlap - asset_ooc - asset_missing -
                maintenance_ooc - maintenance_missing,
                0
            )
            healthy = max(available - maintenance_degraded, 0)
            preparable = available

            result.append({
                'department': department,
                'brand': brand,
                'model': model,
                'description': description,
                'physical': physical,
                'physicalGlobal': physical,
                'usedInThisEvent': used_here,
                'overlappingDemand': overlap,
                'overlappingEvents': overlap_events_by_key.get(key, []),
                'unavailable': (
                    used_here + overlap + asset_ooc + asset_missing +
                    maintenance_ooc + maintenance_missing
                ),
                'available': available,
                'healthy': healthy,
                'preparable': preparable,
                'assetOOC': asset_ooc,
                'assetMissing': asset_missing,
                'bulkMaintenanceOOC': maintenance_ooc,
                'bulkMaintenanceMissing': maintenance_missing,
                'bulkMaintenanceDegraded': maintenance_degraded,
                'adjustedGlobal': available
            })

        result.sort(key=lambda x: (
            x['department'],
            x['brand'].lower(),
            x['model'].lower(),
            x['description'].lower()
        ))

        return jsonify({'success': True, 'data': result})

    except Exception as e:
        logger.error(f"Error computing model availability for event {event_id}: {e}")
        return jsonify({'error': 'Failed to compute availability'}), 500
    
@app.route('/api/events', methods=['POST'])
@require_admin
def create_event():
    """Create a new event"""
    try:
        data = request.get_json()

        # Validate input data
        errors = validate_event_data(data, require_location=True)
        if errors:
            return jsonify({'success': False, 'errors': errors}), 400

        # Generate new event ID
        event_id = max(data_manager.events.keys(), default=0) + 1

        # Convert dates to internal format
        start_date = datetime.strptime(
            data['startDate'], '%Y-%m-%d').strftime('%Y%m%d')
        end_date = datetime.strptime(
            data['endDate'], '%Y-%m-%d').strftime('%Y%m%d')

        # Create new event
        event = Event(
            event_id=event_id,
            name=data['name'].strip(),
            location=str(data.get('location') or '').strip(),
            start_date=start_date,
            end_date=end_date,
            asset_models=[],
            prepared_items=[],
            state='New',
            returned_items=[],
            tag=data.get('tag', 'event')
        )
        event.actually_prepared = []

        # Save event
        data_manager.events[event_id] = event
        data_manager.save_event(event)

        # Invalidate cache
        invalidate_cache()

        log_action(
            f"Created event {event_id}: {data['name']} via web interface")

        return jsonify({'success': True, 'message': 'Event created successfully', 'eventId': event_id})
    except Exception as e:
        logger.error(f"Error creating event: {e}")
        return jsonify({'error': 'Failed to create event'}), 500


@app.route('/api/events/<int:event_id>', methods=['PUT'])
@require_admin
def update_event(event_id):
    """Update an existing event"""
    try:
        event = data_manager.events.get(event_id)
        if not event:
            return jsonify({'error': 'Event not found'}), 404

        data = request.get_json()

        # Validate input data
        errors = validate_event_data(data)
        if errors:
            return jsonify({'success': False, 'errors': errors}), 400

        # Update event properties
        old_name = event.name
        if 'name' in data:
            event.name = data['name'].strip()
        if 'location' in data:
            event.location = str(data.get('location') or '').strip()
        if 'startDate' in data:
            event.start_date = datetime.strptime(
                data['startDate'], '%Y-%m-%d').strftime('%Y%m%d')
        if 'endDate' in data:
            event.end_date = datetime.strptime(
                data['endDate'], '%Y-%m-%d').strftime('%Y%m%d')
        if 'tag' in data:
            event.tag = data['tag']

        # Update asset locations if event name changed
        if old_name != event.name:
            for asset_id in event.prepared_items:
                if asset_id not in event.returned_items:
                    asset = data_manager.inventory.get(asset_id)
                    if asset and asset.current_location == old_name:
                        asset.current_location = event.name
            data_manager.save_inventory()

        # Save event
        data_manager.events[event_id] = event
        data_manager.save_event(event)

        # Invalidate cache
        invalidate_cache()

        log_action(f"Updated event {event_id}: {event.name} via web interface")

        return jsonify({'success': True, 'message': 'Event updated successfully'})
    except Exception as e:
        logger.error(f"Error updating event: {e}")
        return jsonify({'error': 'Failed to update event'}), 500

@app.route('/api/assets/<asset_id>/maintenance-log/<int:log_index>', methods=['DELETE'])
@require_auth
def delete_maintenance_log(asset_id, log_index):
    """Delete a specific maintenance log entry and recalculate asset status"""
    try:
        logger.info(f"Received maintenance log delete request for asset: '{asset_id}', log index: {log_index}")
        
        asset_id = unquote_plus(asset_id)
        
        asset = data_manager.inventory.get(asset_id)
        if not asset:
            return jsonify({'error': 'Asset not found'}), 404
        
        # Check if log index is valid
        if not asset.maintenance_logs or log_index < 0 or log_index >= len(asset.maintenance_logs):
            return jsonify({'error': 'Invalid log index'}), 400
        
        # Only admins may delete maintenance logs. Normal users may edit their
        # own recent logs, but deletion is intentionally admin-only.
        if not _current_user_is_admin():
            return jsonify({'error': 'Admin privileges required to delete maintenance logs'}), 403

        # Get the log entry that will be deleted for logging purposes
        deleted_log = normalize_maintenance_log(asset.maintenance_logs[log_index])
        if (deleted_log.get('source') or {}).get('kind') == CONTAINER_MAINTENANCE_SOURCE:
            return jsonify({
                'error': 'Container maintenance logs are retained as historical records and cannot be deleted from an individual asset'
            }), 409
        deleted_description = deleted_log.get('description', '')
        
        # Remove the log entry
        asset.maintenance_logs.pop(log_index)
        deleted_media_count = _delete_maintenance_media_files(deleted_log)
        
        # Recalculate asset status based on remaining logs
        recalculate_asset_status_from_logs(asset)
        
        # Save changes
        data_manager.save_inventory()
        
        # Log the action
        media_text = f" and {deleted_media_count} media file(s)" if deleted_media_count else ""
        log_action(f"Deleted maintenance log{media_text} for asset {asset_id}: '{deleted_description}' (deleted by {session['user']})")
        
        logger.info(f"Successfully deleted maintenance log for asset {asset_id}")
        return jsonify({'success': True, 'message': 'Maintenance log deleted successfully'})
        
    except Exception as e:
        logger.error(f"Error deleting maintenance log for asset {asset_id}: {e}")
        import traceback
        logger.error(f"Traceback: {traceback.format_exc()}")
        return jsonify({'error': f'Failed to delete maintenance log: {str(e)}'}), 500

def recalculate_asset_status_from_logs(asset):
    """Recalculate asset OOC, Missing status, serial, and location based on maintenance logs."""
    try:
        asset.is_ooc = False
        asset.is_missing = False
        asset.is_degraded = False
        asset.is_disposed = False
        asset.current_location = ''

        sorted_logs = []
        for i, log_entry in enumerate(asset.maintenance_logs):
            record = normalize_maintenance_log(log_entry)
            date_str = record.get('date', '')
            try:
                date_obj = datetime.strptime(date_str, "%Y/%m/%d")
            except ValueError:
                logger.warning(f"Invalid date format in log: {date_str}")
                date_obj = datetime.min

            sorted_logs.append((date_obj, i, record))

        sorted_logs.sort(key=lambda x: (x[0], x[1]))

        for date_obj, log_index, log_entry in sorted_logs:
            apply_maintenance_log_changes(asset, log_entry)

        logger.info(
            f"Final status for {asset.asset_id}: "
            f"OOC={asset.is_ooc}, Missing={asset.is_missing}, Degraded={_is_degraded(asset)}, Decommissioned={_is_disposed(asset)}, Location='{asset.current_location}'"
        )

    except Exception as e:
        logger.error(f"Error recalculating asset status from logs for {asset.asset_id}: {e}")
        import traceback
        logger.error(f"Traceback: {traceback.format_exc()}")

@app.route('/api/events/<int:event_id>', methods=['DELETE'])
@require_admin
def delete_event(event_id):
    """Delete an event"""
    try:
        event = data_manager.events.get(event_id)
        if not event:
            return jsonify({'error': 'Event not found'}), 404

        event_name = event.name

        # Backup event file
        data_manager.backup_event_file(event_id)

        # Return all assets to their default locations
        assets_reset = []
        
        # Reset assets from prepared_items
        for asset_id in event.prepared_items.copy():
            if not (_is_custom_ref(asset_id) or asset_id.startswith('[MODEL]')):
                asset = data_manager.inventory.get(asset_id)
                if asset:
                    old_location = asset.current_location
                    asset.current_location = asset.default_location or ""
                    assets_reset.append(f"{asset_id} (from '{old_location}' to '{asset.current_location or 'Store'}')")

        # Reset assets from actually_prepared (in case there are any not in prepared_items)
        if hasattr(event, 'actually_prepared'):
            for asset_id in event.actually_prepared.copy():
                if not _is_custom_ref(asset_id):
                    asset = data_manager.inventory.get(asset_id)
                    if asset and asset_id not in event.prepared_items:
                        old_location = asset.current_location
                        asset.current_location = asset.default_location or ""
                        assets_reset.append(f"{asset_id} (from '{old_location}' to '{asset.current_location or 'Store'}')")

        # Save inventory changes
        data_manager.save_inventory()

        # Delete event
        del data_manager.events[event_id]
        data_manager.delete_event_file(event_id)

        # Invalidate cache
        invalidate_cache()

        # Log the deletion with details of reset assets. Event-specific logs were
        # stored inside the deleted event file, so they are removed with the event.
        if assets_reset:
            log_action(f"Deleted event {event_id}: {event_name} via web interface. Reset {len(assets_reset)} asset locations: {', '.join(assets_reset[:5])}{'...' if len(assets_reset) > 5 else ''}.")
        else:
            log_action(f"Deleted event {event_id}: {event_name} via web interface. No asset locations to reset.")

        return jsonify({'success': True, 'message': 'Event deleted successfully', 'assetsReset': len(assets_reset)})
    except Exception as e:
        logger.error(f"Error deleting event {event_id}: {e}")
        return jsonify({'error': f'Failed to delete event: {str(e)}'}), 500

@app.route('/api/events/<int:event_id>/assets', methods=['POST'])
@require_admin
def add_asset_to_event(event_id):
    """Add an asset to an event (unprepared by default)"""
    try:
        event = data_manager.events.get(event_id)
        if not event:
            return jsonify({'error': 'Event not found'}), 404

        data = request.get_json() or {}
        asset_id = data.get('assetId', '').strip()

        if not asset_id:
            return jsonify({'error': 'Asset ID is required'}), 400

        # Initialize actually_prepared if it doesn't exist
        if not hasattr(event, 'actually_prepared'):
            event.actually_prepared = []

        # Check if asset is already in this event
        if asset_id in event.prepared_items:
            return jsonify({'error': 'Asset is already assigned to this event'}), 400

        # Structured/legacy custom assets are assigned only; they are not automatically prepared.
        if _is_custom_ref(asset_id):
            _ensure_event_custom_lists(event)
            if asset_id not in event.prepared_items:
                event.prepared_items.append(asset_id)
            if asset_id in event.returned_items:
                event.returned_items.remove(asset_id)
            update_event_state(event)
            data_manager.save_event(event)
            invalidate_cache()
            log_action(f"Assigned custom asset {_custom_display_name(_parse_custom_marker(asset_id))} to event {event_id}")
            return jsonify({'success': True, 'message': 'Custom asset assigned to event'})

        # For regular assets, perform additional checks
        if not _is_custom_ref(asset_id):
            asset = data_manager.inventory.get(asset_id)
            if not asset:
                return jsonify({'error': 'Asset not found'}), 404

            if _is_disposed(asset):
                return jsonify({'error': 'Cannot assign decommissioned asset'}), 400

            if asset.is_missing:
                return jsonify({'error': 'Cannot assign missing asset'}), 400

            busy_event = _find_event_using_asset(asset_id, event)
            if busy_event:
                return jsonify({
                    'error': f'Asset is already assigned to another event {busy_event.event_id}: {busy_event.name}'
                }), 400

        # Add the asset as UNPREPARED (just assigned to event)
        event.prepared_items.append(asset_id)

        # Remove from returned items if it was there
        if asset_id in event.returned_items:
            event.returned_items.remove(asset_id)

        # Update event state
        update_event_state(event)

        # Save changes
        data_manager.save_event(event)

        # Invalidate cache
        invalidate_cache()

        log_action(
            f"Assigned asset {asset_id} to event {event_id} (unprepared)")

        return jsonify({'success': True, 'message': f'Asset {asset_id} assigned to event (unprepared)'})
    except Exception as e:
        logger.error(f"Error adding asset to event {event_id}: {e}")
        return jsonify({'error': 'Failed to add asset to event'}), 500


@app.route('/api/events/<int:event_id>/models', methods=['POST', 'PUT', 'DELETE'])
@require_admin
@with_prepare_action_lock
def manage_event_models(event_id):
    """Add, update, or remove model assignments on events."""
    try:
        event = data_manager.events.get(event_id)
        if not event:
            return jsonify({'error': 'Event not found'}), 404

        data = request.get_json()

        if request.method == 'PUT':
            # Set the planning quantity without touching any prepared, returned,
            # or extra physical references for this model. In particular, a
            # reduction may leave more units prepared than are now required;
            # those units remain deliberately attached to the event.
            brand = data.get('brand', '').strip()
            model = data.get('model', '').strip()
            department = data.get('department', '').strip().upper()
            provided_description = data.get('description', '').strip()
            new_quantity = max(1, int(data.get('quantity', 1)))

            if not brand or not model or not department:
                return jsonify({'error': 'Brand, model, and department are required'}), 400

            group_key = _model_key_from_parts(department, brand, model)
            inv_count = sum(
                _asset_inventory_quantity(asset)
                for asset in data_manager.inventory.values()
                if asset
                and not getattr(asset, 'is_missing', False)
                and not _is_disposed(asset)
                and _asset_group_key(asset) == group_key
            )

            if new_quantity > inv_count:
                return jsonify({
                    'error': (
                        f"Quantity exceeds inventory for {brand} {model}: "
                        f"you have {inv_count} unit(s), requested: {new_quantity}."
                    )
                }), 400

            matching_indexes = []
            existing_quantity = 0
            display_description = provided_description

            for index, item in enumerate(getattr(event, 'prepared_items', []) or []):
                marker = _parse_model_marker(item)
                if not marker:
                    continue
                marker_key = _model_key_from_parts(
                    marker['department'],
                    marker['brand'],
                    marker['model'],
                )
                if marker_key != group_key:
                    continue
                matching_indexes.append(index)
                existing_quantity += max(0, _safe_int(marker.get('quantity'), 0))
                if not display_description and marker.get('description'):
                    display_description = marker['description']

            if not matching_indexes:
                return jsonify({'error': 'Model assignment not found'}), 404

            updated_marker = _make_model_marker({
                'department': department,
                'brand': brand,
                'model': model,
                'description': display_description,
            }, new_quantity)
            first_index = matching_indexes[0]
            matching_index_set = set(matching_indexes)
            event.prepared_items = [
                updated_marker if index == first_index else item
                for index, item in enumerate(event.prepared_items)
                if index not in matching_index_set or index == first_index
            ]

            update_event_state(event)
            data_manager.save_event(event)
            invalidate_cache()

            log_action(
                f"Updated {brand} {model} model quantity for event {event_id}: "
                f"{existing_quantity} -> {new_quantity}"
            )

            return jsonify({
                'success': True,
                'message': f'Updated {brand} {model} quantity to {new_quantity}',
                'data': {
                    'oldQuantity': existing_quantity,
                    'newQuantity': new_quantity,
                },
            })

        elif request.method == 'POST':
            # Add model assignment
            brand = data.get('brand', '').strip()
            model = data.get('model', '').strip()
            department = data.get('department', '').strip().upper()
            provided_description = data.get('description', '').strip()
            quantity = max(1, int(data.get('quantity', 1)))

            logger.debug(
                "Add model request: brand=%r, model=%r, department=%r, "
                "description=%r, quantity=%s",
                brand,
                model,
                department,
                provided_description,
                quantity,
            )

            if not brand or not model or not department:
                return jsonify({'error': 'Brand, model, and department are required'}), 400

            # Get the FULL description from the actual asset, not from the request if none provided
            full_description = provided_description

            # Only try to get description from inventory if none was provided
            if not full_description:
                for asset in data_manager.inventory.values():
                    if (asset.brand == brand and 
                        asset.model_number == model and 
                        asset.department_code == department):
                        full_description = asset.description
                        logger.info(f"No description provided, using from asset {asset.asset_id}: '{full_description}'")
                        break

            logger.info(f"Final description for {brand} {model}: '{full_description}' (length: {len(full_description)})")

            group_key = _model_key_from_parts(department, brand, model)

            # Server-side hard cap:
            # Users may overbook against clashing events, but they may not request
            # more than the physical inventory for this model type.
            # Missing and decommissioned assets are excluded. OOC and Degraded assets are included.
            inv_count = sum(
                _asset_inventory_quantity(asset)
                for asset in data_manager.inventory.values()
                if asset
                and not getattr(asset, 'is_missing', False)
                and not _is_disposed(asset)
                and _asset_group_key(asset) == group_key
            )

            current_total = 0

            for item in getattr(event, 'prepared_items', []) or []:
                existing_key, existing_quantity = _parse_model_assignment_key(item)

                if existing_key == group_key:
                    current_total += existing_quantity

            requested_total = current_total + quantity

            if requested_total > inv_count:
                return jsonify({
                    'error': (
                        f"Quantity exceeds inventory for {brand} {model}"
                        f"{f' ({full_description})' if full_description else ''}: "
                        f"you have {inv_count} unit(s), already requested here: {current_total}, "
                        f"requested additional: {quantity}."
                    )
                }), 400
            
            # Log current prepared_items
            logger.info(f"Current prepared_items: {event.prepared_items}")

            # Check if this model already exists in the event. Description is
            # display text only and does not split model type quantities.
            existing_model_ids = []
            existing_quantity = 0
            display_description = full_description

            for item in event.prepared_items:
                logger.info(f"Checking item: '{item}'")
                if item.startswith('[MODEL]'):
                    parts = item[7:].split('|')
                    logger.info(f"Item parts: {parts}")
                    if len(parts) >= 4:  # dept|brand|model|qty|description
                        item_dept = parts[0]
                        item_brand = parts[1]
                        item_model = parts[2]
                        item_description = parts[4] if len(parts) > 4 else ''
                        
                        logger.info(f"Item details - Dept: '{item_dept}', Brand: '{item_brand}', Model: '{item_model}', Desc: '{item_description}'")
                        
                        if (item_dept == department and 
                            item_brand == brand and 
                            item_model == model):
                            existing_model_ids.append(item)
                            existing_quantity += _safe_int(parts[3], 0)
                            if not display_description and item_description:
                                display_description = item_description
                            logger.info(f"FOUND EXISTING MODEL: '{item}'")

            if existing_model_ids:
                logger.info(f"Updating existing model rows, removing: {existing_model_ids}")
                for existing_model_id in existing_model_ids:
                    event.prepared_items.remove(existing_model_id)
                new_quantity = existing_quantity + quantity
            else:
                logger.info("Creating new model assignment")
                new_quantity = quantity

            # Create consolidated model assignment identifier. The description
            # remains for display only; identity is department + brand + model.
            model_id = f"[MODEL]{department}|{brand}|{model}|{new_quantity}|{display_description}"
            logger.info(f"Creating model assignment: '{model_id}'")
            event.prepared_items.append(model_id)
            
            logger.info(f"Updated prepared_items: {event.prepared_items}")

            # Initialize actually_prepared if it doesn't exist
            if not hasattr(event, 'actually_prepared'):
                event.actually_prepared = []

            # Update event state if needed
            update_event_state(event)

            # Save changes
            data_manager.save_event(event)

            # Invalidate cache
            invalidate_cache()

            log_action(
                f"Added {quantity}x {brand} {model} model to event {event_id} (total: {new_quantity})")

            return jsonify({'success': True, 'message': f'Added {quantity}x {brand} {model} to event (total: {new_quantity})'})

        elif request.method == 'DELETE':
            # Remove model assignment completely
            brand = data.get('brand', '').strip()
            model = data.get('model', '').strip()
            department = data.get('department', '').strip()

            if not brand or not model or not department:
                return jsonify({'error': 'Brand, model, and department are required'}), 400

            # Find matching model assignments for this dept/brand/model
            description_to_match = (data.get('description') or '').strip()

            candidates = []
            for item in event.prepared_items:
                if not item.startswith('[MODEL]'):
                    continue

                parts = item[7:].split('|')  # [MODEL]DEPT|BRAND|MODEL|QUANTITY|DESCRIPTION
                if len(parts) < 4:
                    continue

                item_dept = parts[0]
                item_brand = parts[1]
                item_model = parts[2]
                item_description = parts[4] if len(parts) > 4 else ''

                if item_dept == department and item_brand == brand and item_model == model:
                    candidates.append((item, item_description))

            if not candidates:
                return jsonify({'error': 'Model assignment not found'}), 404

            if description_to_match:
                items_to_remove = [it for (it, desc) in candidates if desc == description_to_match]
                if not items_to_remove:
                    items_to_remove = [it for (it, _desc) in candidates]
            else:
                items_to_remove = [it for (it, _desc) in candidates]

            # A prepared physical item must be released before its planning row is
            # removed. Otherwise bulk markers and specific asset IDs remain in
            # actually_prepared and continue to appear deployed for this show.
            group_key = _model_key_from_parts(department, brand, model)
            unprepared = _unprepare_event_model_group(event, group_key)

            # Remove the model requirement only after its physical refs are clear.
            for item in items_to_remove:
                event.prepared_items.remove(item)

            # Update event state
            update_event_state(event)

            # Save changes
            data_manager.save_event(event)

            # Invalidate cache
            invalidate_cache()

            log_action(
                f"Unprepared {unprepared['preparedUnits']}x and removed "
                f"{brand} {model} model from event {event_id}"
            )

            return jsonify({
                'success': True,
                'message': f'Removed {brand} {model} from event',
                'data': {
                    'unpreparedQuantity': unprepared['preparedUnits'],
                    'referencesRemoved': unprepared['referencesRemoved'],
                },
            })

    except Exception as e:
        logger.error(f"Error managing event models: {e}")
        return jsonify({'error': 'Failed to manage event models'}), 500


@app.route('/api/planning-templates', methods=['GET', 'POST'])
@require_admin
def planning_templates_collection():
    """List or create company-wide event planning templates."""
    try:
        with _planning_templates_lock:
            templates = _load_planning_templates()
            if request.method == 'GET':
                return jsonify({'success': True, 'data': templates})

            data = request.get_json(silent=True) or {}
            name = str(data.get('name') or '').strip()
            if not name:
                return jsonify({'error': 'Template name is required'}), 400

            source = {
                'id': secrets.token_hex(8),
                'name': name,
                'models': data.get('models') or [],
                'customAssets': data.get('customAssets') or [],
                'createdAt': datetime.now().isoformat(timespec='seconds'),
                'updatedAt': datetime.now().isoformat(timespec='seconds'),
            }
            template = _normalise_planning_template(source)
            templates.append(template)
            templates = _save_planning_templates(templates)
            template = next(
                item for item in templates
                if item['id'] == template['id']
            )

        log_action(f"Created planning template '{template['name']}'")
        mark_realtime_change('planning-templates', {'templateId': template['id']})
        return jsonify({'success': True, 'data': template}), 201
    except Exception as exc:
        logger.error("Failed to process planning templates: %s", exc, exc_info=True)
        return jsonify({'error': 'Failed to process planning templates'}), 500


@app.route('/api/planning-templates/<template_id>', methods=['PUT', 'DELETE'])
@require_admin
def planning_template_resource(template_id):
    """Edit or delete one company-wide planning template."""
    try:
        clean_id = re.sub(r'[^a-zA-Z0-9_-]+', '', str(template_id or ''))[:80]
        with _planning_templates_lock:
            templates = _load_planning_templates()
            index = next(
                (
                    position
                    for position, item in enumerate(templates)
                    if item['id'] == clean_id
                ),
                None,
            )
            if index is None:
                return jsonify({'error': 'Planning template not found'}), 404

            existing = templates[index]
            if request.method == 'DELETE':
                templates.pop(index)
                _save_planning_templates(templates)
                deleted_name = existing['name']
            else:
                data = request.get_json(silent=True) or {}
                name = str(data.get('name') or existing['name']).strip()
                if not name:
                    return jsonify({'error': 'Template name is required'}), 400
                updated = _normalise_planning_template({
                    **existing,
                    'name': name,
                    'models': data.get('models', existing['models']),
                    'customAssets': data.get(
                        'customAssets',
                        existing['customAssets'],
                    ),
                    'updatedAt': datetime.now().isoformat(timespec='seconds'),
                })
                templates[index] = updated
                templates = _save_planning_templates(templates)
                updated = next(
                    item for item in templates
                    if item['id'] == clean_id
                )

        if request.method == 'DELETE':
            log_action(f"Deleted planning template '{deleted_name}'")
            mark_realtime_change('planning-templates', {'templateId': clean_id})
            return jsonify({'success': True})

        log_action(f"Updated planning template '{updated['name']}'")
        mark_realtime_change('planning-templates', {'templateId': clean_id})
        return jsonify({'success': True, 'data': updated})
    except Exception as exc:
        logger.error(
            "Failed to update planning template %s: %s",
            template_id,
            exc,
            exc_info=True,
        )
        return jsonify({'error': 'Failed to update planning template'}), 500


@app.route('/api/events/<int:event_id>/apply-planning-template', methods=['POST'])
@require_admin
@with_prepare_action_lock
def apply_planning_template(event_id):
    """Merge or replace an event's model/custom requirements from a template."""
    try:
        event = data_manager.events.get(event_id)
        if not event:
            return jsonify({'error': 'Event not found'}), 404

        data = request.get_json(silent=True) or {}
        template_id = str(data.get('templateId') or '').strip()
        mode = str(data.get('mode') or 'merge').strip().lower()
        if mode not in {'merge', 'replace'}:
            return jsonify({'error': 'Mode must be merge or replace'}), 400

        with _planning_templates_lock:
            template = next(
                (
                    item for item in _load_planning_templates()
                    if item['id'] == template_id
                ),
                None,
            )
        if not template:
            return jsonify({'error': 'Planning template not found'}), 404

        result = _apply_planning_template_to_event(event, template, mode)
        log_action(
            f"{mode.title()}d planning template '{template['name']}' "
            f"for event {event_id}"
        )
        mark_realtime_change(
            'event-assets',
            {'eventId': event_id, 'action': f'template-{mode}'},
        )
        return jsonify({
            'success': True,
            'data': result,
            'message': f"Template '{template['name']}' applied",
        })
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400
    except Exception as exc:
        logger.error(
            "Failed to apply planning template to event %s: %s",
            event_id,
            exc,
            exc_info=True,
        )
        return jsonify({'error': 'Failed to apply planning template'}), 500


@app.route('/api/events/<int:event_id>/container-models', methods=['POST'])
@require_admin
@with_prepare_action_lock
def add_container_models_to_event(event_id):
    """Add a container's model quantities without assigning its physical IDs."""
    try:
        event = data_manager.events.get(event_id)
        if not event:
            return jsonify({'error': 'Event not found'}), 404

        data = request.get_json(silent=True) or {}
        container_id = str(data.get('containerId') or '').strip()
        container = _find_container_by_lookup(container_id)
        if not container:
            return jsonify({'error': 'Container not found'}), 404

        grouped = {}
        skipped = []
        for asset_id in getattr(container, 'asset_ids', []) or []:
            asset = data_manager.inventory.get(asset_id)
            if (
                not asset
                or getattr(asset, 'is_missing', False)
                or _is_disposed(asset)
                or _is_bulk_asset(asset)
            ):
                skipped.append(asset_id)
                continue

            key = _asset_group_key(asset)
            if key not in grouped:
                grouped[key] = {
                    'department': asset.department_code,
                    'brand': asset.brand,
                    'model': asset.model_number,
                    'description': asset.description or '',
                    'quantity': 0,
                }
            grouped[key]['quantity'] += 1

        if not grouped:
            return jsonify({
                'error': 'Container has no available model contents to add'
            }), 400

        current = _event_planning_template_contents(event)['models']
        current_by_key = {
            _model_key_from_parts(
                row['department'],
                row['brand'],
                row['model'],
            ): row
            for row in current
        }
        for key, row in grouped.items():
            final_quantity = (
                current_by_key.get(key, {}).get('quantity', 0)
                + row['quantity']
            )
            physical = _planning_model_inventory_quantity(row)
            if final_quantity > physical:
                return jsonify({
                    'error': (
                        f"{row['brand']} {row['model']} would require "
                        f"{final_quantity} unit(s), but only {physical} "
                        "are in inventory"
                    )
                }), 400

        for row in grouped.values():
            existing_refs = []
            existing_quantity = 0
            key = _model_key_from_parts(
                row['department'],
                row['brand'],
                row['model'],
            )
            for ref in list(event.prepared_items):
                marker = _parse_model_marker(ref)
                if not marker:
                    continue
                marker_key = _model_key_from_parts(
                    marker['department'],
                    marker['brand'],
                    marker['model'],
                )
                if marker_key == key:
                    existing_refs.append(ref)
                    existing_quantity += max(
                        1,
                        _safe_int(marker.get('quantity'), 1),
                    )
                    if not row['description'] and marker.get('description'):
                        row['description'] = marker['description']

            for ref in existing_refs:
                event.prepared_items.remove(ref)
            event.prepared_items.append(
                _make_model_marker(
                    row,
                    existing_quantity + row['quantity'],
                )
            )

        update_event_state(event)
        data_manager.save_event(event)
        invalidate_cache()
        log_action(
            f"Added model contents of container {container.container_id} "
            f"to event {event_id}"
        )
        mark_realtime_change(
            'event-assets',
            {'eventId': event_id, 'action': 'add-container-models'},
        )
        return jsonify({
            'success': True,
            'data': {
                'containerId': container.container_id,
                'modelCount': len(grouped),
                'assetCount': sum(
                    row['quantity'] for row in grouped.values()
                ),
                'skippedCount': len(skipped),
            },
        })
    except Exception as exc:
        logger.error(
            "Failed to add container models to event %s: %s",
            event_id,
            exc,
            exc_info=True,
        )
        return jsonify({'error': 'Failed to add container contents'}), 500


@app.route('/api/events/<int:event_id>/prepare', methods=['POST'])
@require_auth
@with_prepare_action_lock
def prepare_event_asset(event_id):
    """Mark an asset as prepared for an event"""
    try:
        event = data_manager.events.get(event_id)
        if not event:
            return jsonify({'error': 'Event not found'}), 404

        data = request.get_json() or {}
        asset_id = data.get('assetId', '').strip()
        scan_options = _prepare_scan_options(data)
        add_scanned_assets_to_event = scan_options['addScannedAssetsToEvent']

        if not asset_id:
            return jsonify({'error': 'Asset ID is required'}), 400

        scanned_asset = _find_inventory_asset_by_identifier(asset_id)
        if scanned_asset:
            asset_id = scanned_asset.asset_id

        # Initialize lists if they don't exist
        if not hasattr(event, 'actually_prepared'):
            event.actually_prepared = []
        if not hasattr(event, 'extra_assets'):
            event.extra_assets = []

        # Check if already prepared
        if asset_id in event.actually_prepared:
            if add_scanned_assets_to_event and asset_id in event.extra_assets:
                asset = data_manager.inventory.get(asset_id)
                if asset:
                    added_requirement_units = _ensure_event_model_requirement_covers_asset(event, asset, 1)
                    _remove_direct_asset_ref_from_prepared_items(event, asset_id)
                    event.extra_assets.remove(asset_id)
                    update_event_state(event)
                    data_manager.save_event(event)
                    invalidate_cache()
                    log_action(f"Promoted prepared extra asset {asset_id} into event {event_id}")
                    return jsonify({
                        'success': True,
                        'message': f'Asset {asset_id} added into event requirements',
                        'data': {
                            'assetId': asset_id,
                            'isExtra': False,
                            'addedToEvent': True,
                            'addedRequirementUnits': added_requirement_units,
                        }
                    })
            return jsonify({'error': 'Asset is already prepared'}), 400

        custom = _parse_custom_marker(asset_id)
        if custom:
            _ensure_event_custom_lists(event)
            if asset_id not in event.prepared_items:
                return jsonify({'error': 'Custom asset is not assigned to this event'}), 400
            if asset_id in event.returned_items:
                event.returned_items.remove(asset_id)
            if custom['type'] == 'LOAN' and asset_id not in event.custom_collected:
                return jsonify({'error': 'Loan/Rental item must be collected before it can be prepared'}), 400
            event.actually_prepared.append(asset_id)
            update_event_state(event)
            data_manager.save_event(event)
            invalidate_cache()
            log_action(f"Prepared custom item {_custom_display_name(custom)} for event {event_id}")
            return jsonify({'success': True, 'message': f"{_custom_display_name(custom)} prepared for event"})

        # For regular assets, perform additional checks
        if not _is_custom_ref(asset_id):
            asset = data_manager.inventory.get(asset_id)
            if not asset:
                return jsonify({'error': 'Asset not found'}), 404

            block_reason = _asset_prepare_block_reason(asset)
            if block_reason:
                return jsonify({'error': block_reason}), 400

            busy_event = _find_event_using_asset(asset_id, event)
            if busy_event:
                return jsonify({
                    'error': f'Asset is already assigned to another event {busy_event.event_id}: {busy_event.name}'
                }), 400

            if add_scanned_assets_to_event:
                added_requirement_units = _ensure_event_model_requirement_covers_asset(event, asset, 1)
                fulfills_model_requirement = True
            else:
                # A manual/individual prepare only fills an existing open model slot.
                # If the matching model requirement is already full, or if this asset
                # was not originally required, keep it as an extra asset instead of
                # increasing the event requirement.
                added_requirement_units = 0
                fulfills_model_requirement = _event_model_requirement_remaining_for_asset(event, asset) > 0
            logger.info(
                f"Manual prepare {asset_id}: addToEvent={add_scanned_assets_to_event}; "
                f"fillsExistingRequirement={fulfills_model_requirement}; addedUnits={added_requirement_units}"
            )
            
            if fulfills_model_requirement:
                removed_refs = _remove_direct_asset_ref_from_prepared_items(event, asset_id)
                if removed_refs:
                    logger.info(f"Removed {asset_id} from prepared_items because it fulfills a model requirement")
                if asset_id in event.extra_assets:
                    event.extra_assets.remove(asset_id)
                    logger.info(f"Removed {asset_id} from extra_assets (fills open model requirement). Extra assets: {event.extra_assets}")
            else:
                # Loose extras and direct specific-asset events still need an
                # explicit prepared_items row so they remain part of the packing list.
                if asset_id not in event.prepared_items:
                    event.prepared_items.append(asset_id)
                if asset_id not in event.extra_assets:
                    event.extra_assets.append(asset_id)
                    logger.info(f"Added manual extra asset {asset_id} to event {event_id}. Extra assets: {event.extra_assets}")

            # Update asset location now that it's prepared
            asset.current_location = event.name
            data_manager.save_inventory()

        # Mark as prepared
        event.actually_prepared.append(asset_id)

        # Update event state
        update_event_state(event)

        # Save changes
        data_manager.save_event(event)

        # Invalidate cache
        invalidate_cache()

        log_action(f"Prepared asset {asset_id} for event {event_id}")

        response_payload = {
            'success': True,
            'message': f'Asset {asset_id} prepared for event',
            'data': {
                'assetId': asset_id,
                'isExtra': asset_id in getattr(event, 'extra_assets', []),
                'addedToEvent': add_scanned_assets_to_event,
                'addedRequirementUnits': locals().get('added_requirement_units', 0),
            }
        }
        prepared_asset = data_manager.inventory.get(asset_id)
        if prepared_asset and _is_degraded(prepared_asset):
            response_payload['warning'] = _degraded_asset_warning(prepared_asset, asset_id)
        return jsonify(response_payload)
    except Exception as e:
        logger.error(f"Error preparing asset for event {event_id}: {e}")
        return jsonify({'error': 'Failed to prepare asset'}), 500
@app.route('/api/events/<int:event_id>/custom-assets', methods=['POST'])
@require_admin
def add_custom_asset_to_event(event_id):
    """Add a structured custom asset (LOAN/MISC) to an event without auto-preparing it."""
    try:
        event = data_manager.events.get(event_id)
        if not event:
            return jsonify({'error': 'Event not found'}), 404

        data = request.get_json() or {}
        name = str(data.get('name', '')).strip()
        quantity = max(1, _safe_int(data.get('quantity'), 1))
        asset_type = _normalise_custom_type(data.get('type', 'MISC'))
        department = _normalise_department_code(data.get('department')) or 'UN'
        company = str(data.get('company') or '').strip()

        if not name:
            return jsonify({'error': 'Asset name is required'}), 400
        if asset_type == 'LOAN' and not company:
            # Keep this as a warning-level validation so the data remains useful on the DO and prep screen.
            return jsonify({'error': 'Loan/Rental company is required'}), 400

        _ensure_event_custom_lists(event)
        custom_asset_id = _make_custom_marker(asset_type, name, quantity, department, company)

        event.prepared_items.append(custom_asset_id)

        update_event_state(event)
        data_manager.save_event(event)
        invalidate_cache()

        log_action(f"Added {asset_type} custom asset '{name}' ({quantity}x, dept {department}) to event {event_id}")

        return jsonify({
            'success': True,
            'message': f'Custom asset "{name}" added to event',
            'data': {'assetId': custom_asset_id}
        })

    except Exception as e:
        logger.error(f"Error adding custom asset to event {event_id}: {e}", exc_info=True)
        return jsonify({'error': 'Failed to add custom asset'}), 500

@app.route('/api/events/<int:event_id>/custom-assets/collect', methods=['POST'])
@require_auth
@with_prepare_action_lock
def collect_custom_asset(event_id):
    """Mark a loan/rental custom item as collected."""
    try:
        event = data_manager.events.get(event_id)
        if not event:
            return jsonify({'error': 'Event not found'}), 404

        data = request.get_json() or {}
        asset_id = str(data.get('assetId', '')).strip()
        custom = _parse_custom_marker(asset_id)
        if not custom:
            return jsonify({'error': 'Custom asset not found'}), 400
        if custom['type'] != 'LOAN':
            return jsonify({'error': 'Only loan/rental items can be collected'}), 400

        _ensure_event_custom_lists(event)
        if asset_id not in event.prepared_items:
            return jsonify({'error': 'Custom asset is not assigned to this event'}), 400
        if asset_id in event.returned_items:
            return jsonify({'error': 'Returned items cannot be collected'}), 400
        if asset_id not in event.custom_collected:
            event.custom_collected.append(asset_id)

        update_event_state(event)
        data_manager.save_event(event)
        invalidate_cache()
        log_action(f"Collected loan/rental item {_custom_display_name(custom)} for event {event_id}")
        return jsonify({'success': True, 'message': 'Loan/Rental item collected'})
    except Exception as e:
        logger.error(f"Error collecting custom asset for event {event_id}: {e}", exc_info=True)
        return jsonify({'error': 'Failed to collect custom asset'}), 500

@app.route('/api/events/<int:event_id>/custom-assets/uncollect', methods=['POST'])
@require_auth
@with_prepare_action_lock
def uncollect_custom_asset(event_id):
    """Undo collection for a loan/rental custom item. This also unprepares it."""
    try:
        event = data_manager.events.get(event_id)
        if not event:
            return jsonify({'error': 'Event not found'}), 404

        data = request.get_json() or {}
        asset_id = str(data.get('assetId', '')).strip()
        custom = _parse_custom_marker(asset_id)
        if not custom:
            return jsonify({'error': 'Custom asset not found'}), 400
        if custom['type'] != 'LOAN':
            return jsonify({'error': 'Only loan/rental items can be uncollected'}), 400

        _ensure_event_custom_lists(event)
        if asset_id in event.custom_collected:
            event.custom_collected.remove(asset_id)
        if asset_id in event.actually_prepared:
            event.actually_prepared.remove(asset_id)
        if asset_id in event.returned_items:
            event.returned_items.remove(asset_id)

        update_event_state(event)
        data_manager.save_event(event)
        invalidate_cache()
        log_action(f"Uncollected loan/rental item {_custom_display_name(custom)} for event {event_id}")
        return jsonify({'success': True, 'message': 'Loan/Rental item uncollected'})
    except Exception as e:
        logger.error(f"Error uncollecting custom asset for event {event_id}: {e}", exc_info=True)
        return jsonify({'error': 'Failed to uncollect custom asset'}), 500

@app.route('/api/events/<int:event_id>/unprepare', methods=['POST'])
@require_auth
@with_prepare_action_lock
def unprepare_event_asset(event_id):
    """Remove a specific asset completely from the event"""
    try:
        event = data_manager.events.get(event_id)
        if not event:
            return jsonify({'error': 'Event not found'}), 404

        data = request.get_json() or {}
        asset_id = data.get('assetId', '').strip()

        if not asset_id:
            return jsonify({'error': 'Asset ID is required'}), 400

        if _is_bulk_ref(asset_id):
            if not hasattr(event, 'actually_prepared'):
                event.actually_prepared = []
            if asset_id in event.actually_prepared:
                event.actually_prepared.remove(asset_id)
            if asset_id in event.returned_items:
                event.returned_items.remove(asset_id)
            if hasattr(event, 'extra_assets') and asset_id in event.extra_assets:
                event.extra_assets.remove(asset_id)
            update_event_state(event)
            data_manager.save_event(event)
            invalidate_cache()
            log_action(f"Unprepared bulk asset marker {asset_id} from event {event_id}")
            return jsonify({'success': True, 'message': 'Bulk quantity asset unprepared'})

        custom = _parse_custom_marker(asset_id)
        if custom:
            _ensure_event_custom_lists(event)
            if asset_id not in event.prepared_items:
                return jsonify({'error': 'Custom asset is not assigned to this event'}), 400
            if asset_id in event.actually_prepared:
                event.actually_prepared.remove(asset_id)
            if asset_id in event.returned_items:
                event.returned_items.remove(asset_id)
            update_event_state(event)
            data_manager.save_event(event)
            invalidate_cache()
            log_action(f"Unprepared custom item {_custom_display_name(custom)} from event {event_id}")
            return jsonify({'success': True, 'message': 'Custom item unprepared'})

        _ensure_event_custom_lists(event)

        asset_is_attached = (
            asset_id in event.prepared_items or
            asset_id in event.actually_prepared or
            asset_id in event.returned_items or
            asset_id in event.extra_assets
        )

        # Check if asset is attached to this event first
        if not asset_is_attached:
            return jsonify({'error': 'Asset is not assigned to this event'}), 400

        # LOG THE UNPREPARE ACTION
        log_asset_change(event_id, asset_id, "UNPREPARING", "completely removing asset from event [unprepare_event_asset]")

        # Remove from prepared list if this was a loose extra/direct asset. Model-
        # fulfilled physical assets may now live only in actually_prepared.
        if asset_id in event.prepared_items:
            event.prepared_items.remove(asset_id)
        
        # Remove from actually_prepared if it's there
        if asset_id in event.actually_prepared:
            event.actually_prepared.remove(asset_id)

        # Remove from returned_items if it's there. Leaving this behind forces the
        # event into Returning even after the asset was removed from the event.
        if asset_id in event.returned_items:
            event.returned_items.remove(asset_id)
        
        # Remove from extra_assets if it's there
        if hasattr(event, 'extra_assets') and asset_id in event.extra_assets:
            event.extra_assets.remove(asset_id)

        # For regular assets, reset location to default
        if not _is_custom_ref(asset_id):
            asset = data_manager.inventory.get(asset_id)
            if asset:
                asset.current_location = asset.default_location or ''
                data_manager.save_inventory()

        # Update event state
        update_event_state(event)

        # Save changes
        data_manager.save_event(event)

        # Invalidate cache
        invalidate_cache()

        log_action(f"Completely removed asset {asset_id} from event {event_id}")

        return jsonify({'success': True, 'message': f'Asset {asset_id} removed from event'})
    except Exception as e:
        logger.error(f"Error removing asset from event {event_id}: {e}")
        return jsonify({'error': 'Failed to remove asset'}), 500

@app.route('/api/events/<int:event_id>/return', methods=['POST'])
@require_auth
def return_event_asset(event_id):
    """Return an asset from an event"""
    try:
        event = data_manager.events.get(event_id)
        if not event:
            return jsonify({'error': 'Event not found'}), 404

        data = request.get_json()
        asset_id = data.get('assetId', '').strip()

        if not asset_id:
            return jsonify({'error': 'Asset ID is required'}), 400

        scanned_asset = _find_inventory_asset_by_identifier(asset_id)
        if scanned_asset:
            asset_id = scanned_asset.asset_id

        if _is_bulk_ref(asset_id):
            if asset_id not in getattr(event, 'actually_prepared', []) and asset_id not in getattr(event, 'prepared_items', []):
                return jsonify({'error': 'Bulk asset is not prepared for this event'}), 400
            if asset_id in event.returned_items:
                return jsonify({'error': 'Asset is already returned'}), 400
            event.returned_items.append(asset_id)
            update_event_state(event)
            data_manager.save_event(event)
            invalidate_cache()
            log_action(f"Returned bulk asset marker {asset_id} from event {event_id}")
            return jsonify({'success': True, 'message': 'Bulk quantity asset returned successfully'})

        custom = _parse_custom_marker(asset_id)
        if custom:
            _ensure_event_custom_lists(event)
            if asset_id not in event.prepared_items:
                return jsonify({'error': 'Custom asset is not assigned to this event'}), 400
            if asset_id in event.returned_items:
                return jsonify({'error': 'Asset is already returned'}), 400
            is_prepared = asset_id in event.actually_prepared
            is_collected_loan = custom.get('type') == 'LOAN' and asset_id in getattr(event, 'custom_collected', [])
            if not (is_prepared or is_collected_loan):
                return jsonify({'error': 'Custom asset must be prepared before it can be returned'}), 400

            event.returned_items.append(asset_id)
            update_event_state(event)
            data_manager.save_event(event)
            invalidate_cache()
            log_action(f"Returned custom item {_custom_display_name(custom)} from event {event_id}")
            return jsonify({'success': True, 'message': f"{_custom_display_name(custom)} returned successfully"})

        _ensure_event_custom_lists(event)

        # Check if asset is prepared/assigned for this event. Model-fulfilled
        # physical assets are tracked in actually_prepared, not prepared_items.
        if asset_id not in event.prepared_items and asset_id not in event.actually_prepared:
            return jsonify({'error': 'Asset is not assigned to this event'}), 400

        # Check if asset is already returned
        if asset_id in event.returned_items:
            return jsonify({'error': 'Asset is already returned'}), 400

        # Return the asset
        event.returned_items.append(asset_id)

        # Initialize actually_prepared if it doesn't exist
        if not hasattr(event, 'actually_prepared'):
            event.actually_prepared = []

        # For regular assets, remove from actually_prepared when returned
        if asset_id in event.actually_prepared:
            event.actually_prepared.remove(asset_id)

        # For regular assets, update location
        if not _is_custom_ref(asset_id):
            asset = data_manager.inventory.get(asset_id)
            if asset:
                asset.current_location = asset.default_location or ''
                data_manager.save_inventory()

        # Update event state
        update_event_state(event)

        # Save changes
        data_manager.save_event(event)

        # Invalidate cache
        invalidate_cache()

        log_action(f"Returned asset {asset_id} from event {event_id}")

        return jsonify({'success': True, 'message': f'Asset {asset_id} returned successfully'})
    except Exception as e:
        logger.error(f"Error returning asset from event {event_id}: {e}")
        import traceback
        logger.error(f"Traceback: {traceback.format_exc()}")
        return jsonify({'error': 'Failed to return asset'}), 500
    
@app.route('/api/events/<int:event_id>/return-department', methods=['POST'])
@require_admin
def return_department_assets(event_id):
    """Return all unreturned assets for a given department in this event.
    Includes regular inventory assets from actually_prepared that match the department,
    any specifically prepared assets from prepared_items in that department,
    and custom assets ([LOAN]/[MISC]) if department is LOAN or MISC.
    """
    try:
        event = data_manager.events.get(event_id)
        if not event:
            return jsonify({'error': 'Event not found'}), 404

        data = request.get_json() or {}
        department = (data.get('department') or '').strip()
        if not department:
            return jsonify({'error': 'Department is required'}), 400

        # Ensure lists exist
        if not hasattr(event, 'actually_prepared'):
            event.actually_prepared = []
        if not hasattr(event, 'extra_assets'):
            event.extra_assets = []

        already_returned = set(event.returned_items or [])
        targets = []

        # 1) Regular inventory assets (match department)
        specific_ids_in_prepared = [
            aid for aid in event.prepared_items
            if not (_is_custom_ref(aid) or aid.startswith('[MODEL]'))
        ]
        for asset_id in set(event.actually_prepared + specific_ids_in_prepared):
            if asset_id in already_returned:
                continue

            if _is_bulk_ref(asset_id):
                marker = _parse_bulk_marker(asset_id)
                bulk_asset = data_manager.inventory.get(marker['bulkId']) if marker else None
                if bulk_asset and _is_bulk_asset(bulk_asset) and bulk_asset.department_code == department:
                    targets.append(asset_id)
                continue

            asset = data_manager.inventory.get(asset_id)
            if not asset:
                continue
            if asset.department_code == department:
                targets.append(asset_id)

        # 2) Custom assets now belong to their tagged department.
        for item in event.prepared_items:
            custom = _parse_custom_marker(item)
            if not custom or item in already_returned:
                continue
            is_prepared = item in event.actually_prepared
            is_collected_loan = custom.get('type') == 'LOAN' and item in getattr(event, 'custom_collected', [])
            if custom.get('department') == department and (is_prepared or is_collected_loan):
                targets.append(item)

        if not targets:
            return jsonify({'success': True, 'message': f'No pending items for department {department}', 'returned': []})

        returned_now = []

        for asset_id in targets:
            if asset_id in event.returned_items:
                continue

            # Mark returned
            event.returned_items.append(asset_id)
            returned_now.append(asset_id)

            # Bulk quantity assets: keep the prepared marker for history/state math.
            if _is_bulk_ref(asset_id):
                continue

            # Regular assets: remove from actually_prepared + reset location
            if not _is_custom_ref(asset_id):
                if asset_id in event.actually_prepared:
                    event.actually_prepared.remove(asset_id)
                asset = data_manager.inventory.get(asset_id)
                if asset:
                    asset.current_location = asset.default_location or ''

            # For custom assets, DO NOT remove from actually_prepared (to match single-return semantics)

        # Persist
        data_manager.save_inventory()
        update_event_state(event)
        data_manager.save_event(event)
        invalidate_cache()

        log_action(f"Returned all assets for department {department} in event {event_id}: {len(returned_now)} items")

        return jsonify({'success': True, 'message': f'Returned {len(returned_now)} items for {department}', 'returned': returned_now})
    except Exception as e:
        logger.error(f"Error returning all assets for department {department} in event {event_id}: {e}")
        return jsonify({'error': 'Failed to return department assets'}), 500


@app.route('/api/events/<int:event_id>/assign-specific', methods=['POST'])
@require_auth
@with_prepare_action_lock
def assign_specific_asset_to_model(event_id):
    """Assign a specific asset to fulfill a model requirement"""
    try:
        event = data_manager.events.get(event_id)
        if not event:
            return jsonify({'error': 'Event not found'}), 404

        data = request.get_json() or {}
        asset_id = data.get('assetId', '').strip()
        scan_options = _prepare_scan_options(data)
        add_scanned_assets_to_event = scan_options['addScannedAssetsToEvent']

        if not asset_id:
            return jsonify({'error': 'Asset ID is required'}), 400

        scanned_asset = _find_inventory_asset_by_identifier(asset_id)
        if scanned_asset:
            asset_id = scanned_asset.asset_id

        bulk_asset = data_manager.inventory.get(asset_id)
        if bulk_asset and _is_bulk_asset(bulk_asset):
            if _is_disposed(bulk_asset):
                return jsonify({'error': 'Bulk asset is decommissioned and cannot be prepared'}), 400

            if getattr(bulk_asset, 'is_ooc', False):
                return jsonify({'error': 'Bulk asset is out of commission'}), 400

            if getattr(bulk_asset, 'is_missing', False):
                return jsonify({'error': 'Bulk asset is marked as missing'}), 400

            if not hasattr(event, 'actually_prepared'):
                event.actually_prepared = []
            if not hasattr(event, 'extra_assets'):
                event.extra_assets = []

            quantity = _safe_int(data.get('quantity'), 0)
            if quantity <= 0:
                quantity = _bulk_remaining_for_event_group(event, bulk_asset)
            if quantity <= 0:
                quantity = 1

            healthy_quantity = _bulk_available_quantity_for_event(
                bulk_asset,
                event,
                include_degraded=False
            )
            available_quantity = _bulk_available_quantity_for_event(
                bulk_asset,
                event,
                include_degraded=True
            )
            if available_quantity <= 0:
                return jsonify({'error': 'No quantity is available for this event date range'}), 400

            quantity = min(
                quantity,
                max(1, _safe_int(getattr(bulk_asset, 'quantity', 1), 1)),
                available_quantity
            )

            marker = _bulk_marker(asset_id, quantity)
            if marker in event.actually_prepared and marker not in event.returned_items:
                return jsonify({'error': 'Bulk asset is already prepared for this event'}), 400

            if marker in event.returned_items:
                event.returned_items.remove(marker)
            if marker not in event.actually_prepared:
                event.actually_prepared.append(marker)

            added_requirement_units = 0
            if add_scanned_assets_to_event:
                added_requirement_units = _ensure_event_model_requirement_covers_asset(event, bulk_asset, quantity)

            update_event_state(event)
            data_manager.save_event(event)
            invalidate_cache()
            log_action(f"Prepared {quantity}x bulk asset {bulk_asset.brand} {bulk_asset.model_number} for event {event_id}")
            response_payload = {
                'success': True,
                'message': f'Prepared {quantity}x {bulk_asset.brand} {bulk_asset.model_number}',
                'data': {
                    'assetId': marker,
                    'isExtra': False,
                    'addedToEvent': add_scanned_assets_to_event,
                    'addedRequirementUnits': added_requirement_units,
                    'healthyQuantityUsed': min(quantity, healthy_quantity),
                    'degradedQuantityUsed': max(quantity - healthy_quantity, 0),
                }
            }
            degraded_quantity_used = max(quantity - healthy_quantity, 0)
            if degraded_quantity_used > 0:
                reasons = _bulk_degraded_reasons(bulk_asset, limit=degraded_quantity_used)
                response_payload['warning'] = (
                    f"There are not enough fully working {bulk_asset.brand} {bulk_asset.model_number} assets for this preparation. "
                    f"{degraded_quantity_used} degraded unit{'s' if degraded_quantity_used != 1 else ''} will be used."
                    f"{_warning_reason_text(reasons)} "
                    "Please verify the limitation before show."
                )
            return jsonify(response_payload)

        # Initialize lists if they don't exist
        if not hasattr(event, 'actually_prepared'):
            event.actually_prepared = []
        if not hasattr(event, 'extra_assets'):
            event.extra_assets = []

        # Check if asset is already assigned
        if asset_id in event.actually_prepared:
            if add_scanned_assets_to_event and asset_id in event.extra_assets:
                asset = data_manager.inventory.get(asset_id)
                if asset:
                    added_requirement_units = _ensure_event_model_requirement_covers_asset(event, asset, 1)
                    _remove_direct_asset_ref_from_prepared_items(event, asset_id)
                    event.extra_assets.remove(asset_id)
                    update_event_state(event)
                    data_manager.save_event(event)
                    invalidate_cache()
                    log_action(f"Promoted prepared extra asset {asset_id} into event {event_id}")
                    return jsonify({
                        'success': True,
                        'message': f'Asset {asset_id} added into event requirements',
                        'data': {
                            'assetId': asset_id,
                            'isExtra': False,
                            'addedToEvent': True,
                            'addedRequirementUnits': added_requirement_units,
                        }
                    })
            return jsonify({'error': 'Asset is already assigned to this event'}), 400

        # For regular assets, perform checks
        if not _is_custom_ref(asset_id):
            asset = data_manager.inventory.get(asset_id)
            if not asset:
                return jsonify({'error': 'Asset not found'}), 404

            logger.info(f"Assigning asset {asset_id} - Brand: {asset.brand}, Model: {asset.model_number}, Dept: {asset.department_code}")

            block_reason = _asset_prepare_block_reason(asset)
            if block_reason:
                return jsonify({'error': block_reason}), 400

            busy_event = _find_event_using_asset(asset_id, event)
            if busy_event:
                return jsonify({
                    'error': f'Asset is already assigned to another event {busy_event.event_id}: {busy_event.name}'
                }), 400

            if add_scanned_assets_to_event:
                # Quick-add prepares are allowed to raise the requirement so the
                # scanned asset becomes part of the event packing list.
                added_requirement_units = _ensure_event_model_requirement_covers_asset(event, asset, 1)
                fills_existing_requirement = True

                if added_requirement_units:
                    logger.info(
                        f"Added {added_requirement_units} model requirement unit(s) for scanned asset {asset_id}: "
                        f"[{asset.department_code}] {asset.brand} {asset.model_number} {asset.description}"
                    )
            else:
                # Individual/manual prepares do NOT raise requirements. They only
                # fill an open slot; if the event already has enough of that model,
                # the physical asset is tracked as extra.
                added_requirement_units = 0
                fills_existing_requirement = _event_model_requirement_remaining_for_asset(event, asset) > 0

            logger.info(
                f"Asset {asset_id}: fromContainer={scan_options['fromContainer']}; "
                f"addToEvent={add_scanned_assets_to_event}; "
                f"fillsExistingRequirement={fills_existing_requirement}; addedUnits={added_requirement_units}"
            )
            
            if fills_existing_requirement:
                removed_refs = _remove_direct_asset_ref_from_prepared_items(event, asset_id)
                if removed_refs:
                    logger.info(f"Removed {asset_id} from prepared_items because it fulfills a model requirement")
                if asset_id in event.extra_assets:
                    event.extra_assets.remove(asset_id)
                    logger.info(f"Removed {asset_id} from extra_assets. Extra assets: {event.extra_assets}")
            else:
                # Loose extras and direct specific-asset events still need an
                # explicit prepared_items row so they remain part of the packing list.
                if asset_id not in event.prepared_items:
                    event.prepared_items.append(asset_id)
                    logger.info(f"Added {asset_id} to prepared_items")
                if asset_id not in event.extra_assets:
                    event.extra_assets.append(asset_id)
                    logger.info(f"Added individual extra asset {asset_id}. Extra assets: {event.extra_assets}")

            asset.current_location = event.name
            data_manager.save_inventory()

        # Add to actually_prepared if not already there
        if asset_id not in event.actually_prepared:
            event.actually_prepared.append(asset_id)
            logger.info(f"Added {asset_id} to actually_prepared. List now: {event.actually_prepared}")

        # Update event state
        update_event_state(event)
        
        # Save changes
        data_manager.save_event(event)
        
        # Invalidate cache
        invalidate_cache()

        log_action(f"Assigned specific asset {asset_id} to event {event_id}")

        response_payload = {
            'success': True,
            'message': f'Asset {asset_id} assigned to event',
            'data': {
                'assetId': asset_id,
                'isExtra': asset_id in getattr(event, 'extra_assets', []),
                'addedToEvent': add_scanned_assets_to_event,
                'addedRequirementUnits': locals().get('added_requirement_units', 0),
            }
        }
        assigned_asset = data_manager.inventory.get(asset_id)
        if assigned_asset and _is_degraded(assigned_asset):
            response_payload['warning'] = _degraded_asset_warning(assigned_asset, asset_id)
        return jsonify(response_payload)

    except Exception as e:
        logger.error(f"Error assigning specific asset to event {event_id}: {e}")
        return jsonify({'error': 'Failed to assign asset'}), 500

@app.route('/api/events/<int:event_id>/unassign-specific', methods=['POST'])
@require_auth
def unassign_specific_asset_from_model(event_id):
    """Unassign a specific asset from a model requirement"""
    try:
        event = data_manager.events.get(event_id)
        if not event:
            return jsonify({'error': 'Event not found'}), 404

        data = request.get_json()
        asset_id = data.get('assetId', '').strip()

        if not asset_id:
            return jsonify({'error': 'Asset ID is required'}), 400

        if _is_bulk_ref(asset_id):
            if not hasattr(event, 'actually_prepared'):
                event.actually_prepared = []
            if asset_id in event.actually_prepared:
                event.actually_prepared.remove(asset_id)
            if asset_id in event.returned_items:
                event.returned_items.remove(asset_id)
            if hasattr(event, 'extra_assets') and asset_id in event.extra_assets:
                event.extra_assets.remove(asset_id)
            update_event_state(event)
            data_manager.save_event(event)
            invalidate_cache()
            log_action(f"Unassigned bulk asset marker {asset_id} from event {event_id}")
            return jsonify({'success': True, 'message': 'Bulk quantity asset unassigned from event'})

        # Initialize actually_prepared if it doesn't exist
        if not hasattr(event, 'actually_prepared'):
            event.actually_prepared = []

        # Check if asset is assigned
        if asset_id not in event.actually_prepared:
            return jsonify({'error': 'Asset is not currently prepared for this event'}), 400

        # Remove from actually_prepared
        event.actually_prepared.remove(asset_id)

        # For regular assets, reset location
        if not _is_custom_ref(asset_id):
            asset = data_manager.inventory.get(asset_id)
            if asset:
                asset.current_location = asset.default_location or ''
                data_manager.save_inventory()

        # Update event state
        update_event_state(event)

        # Save changes
        data_manager.save_event(event)

        # Invalidate cache
        invalidate_cache()

        log_action(
            f"Unassigned specific asset {asset_id} from event {event_id}")

        return jsonify({'success': True, 'message': f'Asset {asset_id} unassigned from event'})

    except Exception as e:
        logger.error(
            f"Error unassigning specific asset from event {event_id}: {e}")
        return jsonify({'error': 'Failed to unassign asset'}), 500
    
@app.route('/api/events/<int:event_id>/remove-asset', methods=['POST'])
@require_admin
def remove_asset_from_event(event_id):
    """Remove an asset from every assignment list associated with an event."""
    try:
        data = request.get_json(silent=True) or {}
        asset_id = data.get('assetId', '').strip()
        
        if not asset_id:
            return jsonify({'error': 'Asset ID is required'}), 400
        
        logger.info(f"Remove asset request: Event {event_id}, Asset: '{asset_id}'")
        
        event = data_manager.events.get(event_id)
        if not event:
            return jsonify({'error': 'Event not found'}), 404

        # Initialize lists if they don't exist
        if not hasattr(event, 'actually_prepared'):
            event.actually_prepared = []
        if not hasattr(event, 'extra_assets'):
            event.extra_assets = []

        # Check if asset is in this event (check ALL possible locations)
        asset_is_assigned = (asset_id in event.prepared_items or 
                            asset_id in event.actually_prepared or
                            asset_id in event.extra_assets)

        if not asset_is_assigned:
            logger.warning(f"Asset '{asset_id}' not found in event {event_id}")
            logger.info(f"  prepared_items: {event.prepared_items}")
            logger.info(f"  actually_prepared: {event.actually_prepared}")
            logger.info(f"  extra_assets: {event.extra_assets}")
            return jsonify({'error': 'Asset is not assigned to this event'}), 400

        # Remove the asset from ALL possible locations
        if asset_id in event.prepared_items:
            event.prepared_items.remove(asset_id)
            logger.info(f"Removed '{asset_id}' from prepared_items")

        if asset_id in event.returned_items:
            event.returned_items.remove(asset_id)
            logger.info(f"Removed '{asset_id}' from returned_items")

        if asset_id in event.actually_prepared:
            event.actually_prepared.remove(asset_id)
            logger.info(f"Removed '{asset_id}' from actually_prepared")

        if asset_id in event.extra_assets:
            event.extra_assets.remove(asset_id)
            logger.info(f"Removed '{asset_id}' from extra_assets")

        # For regular assets, update location
        if not _is_custom_ref(asset_id):
            asset = data_manager.inventory.get(asset_id)
            if asset:
                asset.current_location = asset.default_location or ''
                data_manager.save_inventory()
                logger.info(f"Reset location for asset '{asset_id}'")

        # Update event state
        update_event_state(event)

        # Save changes
        data_manager.save_event(event)

        # Invalidate cache
        invalidate_cache()

        log_action(f"Removed asset {asset_id} from event {event_id}")

        return jsonify({'success': True, 'message': f'Asset {asset_id} removed from event'})
    except Exception as e:
        logger.error(f"Error removing asset from event {event_id}: {e}")
        return jsonify({'error': 'Failed to remove asset from event'}), 500

# ---------------- Transfer Assets helpers and routes ----------------

TRANSFER_SOURCE_STATES = {'ongoing', 'last day', 'returning', 'overdue', 'ready'}
TRANSFER_TARGET_STATES = {'planning', 'preparing'}


def _ensure_event_lists(event):
    """Make old event files safe to work with."""
    if not hasattr(event, 'prepared_items') or event.prepared_items is None:
        event.prepared_items = []
    if not hasattr(event, 'returned_items') or event.returned_items is None:
        event.returned_items = []
    if not hasattr(event, 'actually_prepared') or event.actually_prepared is None:
        event.actually_prepared = []
    if not hasattr(event, 'extra_assets') or event.extra_assets is None:
        event.extra_assets = []


def _event_summary_for_transfer(event):
    _ensure_event_lists(event)
    unreturned_count = len(_get_unreturned_real_asset_ids(event))
    return {
        'id': event.event_id,
        'name': event.name,
        'startDate': format_date_output(event.start_date),
        'endDate': format_date_output(event.end_date),
        'state': event.state,
        'tag': getattr(event, 'tag', 'events'),
        'unreturnedCount': unreturned_count,
        'assetCount': len([x for x in event.prepared_items if isinstance(x, str) and not x.startswith('[MODEL]')])
    }


def _norm(value, uppercase=False):
    value = str(value or '').strip()
    return value.upper() if uppercase else value.casefold()


def _asset_match_key(asset):
    return (
        _norm(getattr(asset, 'department_code', ''), True),
        _norm(getattr(asset, 'brand', '')),
        _norm(getattr(asset, 'model_number', '')),
        '',
    )


def _model_marker_to_requirement(marker):
    parsed = _parse_model_marker(marker)
    if not parsed:
        return None

    try:
        quantity = int(parsed.get('quantity') or 0)
    except Exception:
        quantity = 0

    if quantity <= 0:
        return None

    return {
        'department': parsed['department'],
        'brand': parsed['brand'],
        'model': parsed['model'],
        'description': parsed.get('description', ''),
        'quantity': quantity,
        'key': (
            _norm(parsed['department'], True),
            _norm(parsed['brand']),
            _norm(parsed['model']),
            '',
        )
    }


def _get_unreturned_real_asset_ids(event):
    """Return real inventory asset IDs that are still physically out for an event."""
    _ensure_event_lists(event)
    returned = set(event.returned_items)

    # Most current web workflows put prepared physical assets in actually_prepared.
    # Keep prepared_items as a fallback for older event files.
    candidates = []
    for asset_id in list(event.actually_prepared) + list(event.prepared_items):
        if not _is_real_asset_ref(asset_id):
            continue
        if asset_id in returned:
            continue
        if asset_id not in data_manager.inventory:
            continue
        if asset_id not in candidates:
            candidates.append(asset_id)

    return candidates


def _target_model_requirements(event):
    """Return target [MODEL] requirements with already-prepared counts and remaining counts."""
    _ensure_event_lists(event)

    requirements = {}
    for item in event.prepared_items:
        requirement = _model_marker_to_requirement(item)
        if not requirement:
            continue

        key = requirement['key']
        if key not in requirements:
            requirements[key] = {
                'department': requirement['department'],
                'brand': requirement['brand'],
                'model': requirement['model'],
                'description': requirement['description'],
                'required': 0,
                'prepared': 0,
                'remaining': 0,
            }
        requirements[key]['required'] += requirement['quantity']

    # Count real assets that are already prepared for the target and not returned.
    for asset_id in _get_unreturned_real_asset_ids(event):
        asset = data_manager.inventory.get(asset_id)
        if not asset:
            continue
        key = _asset_match_key(asset)
        if key in requirements:
            requirements[key]['prepared'] += 1

    for requirement in requirements.values():
        requirement['remaining'] = max(requirement['required'] - requirement['prepared'], 0)

    return requirements


def _asset_fulfills_event_model_requirement(event, asset):
    requirements = _target_model_requirements(event)
    return _asset_match_key(asset) in requirements


def _transfer_asset_payload(asset, state='', from_event=None, to_event=None, reason='', requirement=None, source_quantity=0, return_quantity=0):
    """Build a transfer-page asset payload.

    state is intentionally server-side so multiple browser/device sessions see
    the same action result after refreshing the comparison.
    """
    requirement = requirement or {}
    target_remaining = int(requirement.get('remaining', 0) or 0)
    return {
        'assetId': asset.asset_id,
        'department': asset.department_code,
        'brand': asset.brand,
        'model': asset.model_number,
        'description': asset.description,
        'serial': asset.serial_number,
        'serial2': getattr(asset, 'secondary_serial_number', ''),
        'status': _asset_status_value(asset),
        'isDegraded': _is_degraded(asset),
        'isDisposed': _is_disposed(asset),
        'currentLocation': asset.current_location or (getattr(from_event, 'name', '') if from_event else ''),
        'matchLabel': f"[{asset.department_code}] {asset.brand} {asset.model_number} {asset.description}".strip(),
        'targetRequired': int(requirement.get('required', 0) or 0),
        'targetPrepared': int(requirement.get('prepared', 0) or 0),
        'targetRemainingBeforeThisAsset': target_remaining,
        'targetRemaining': target_remaining,
        'sourceQuantity': int(source_quantity or 0),
        'returnQuantity': int(return_quantity or 0),
        'reason': reason,
        'transferState': state,
    }


def _real_source_asset_ids_including_returned(event):
    """Return real inventory asset IDs connected to a source event.

    Unlike _get_unreturned_real_asset_ids(), this intentionally keeps returned
    IDs so the transfer page can keep showing already-transferred / returned-to-
    office assets with an Undo button after the server-side refresh.
    """
    _ensure_event_lists(event)
    ids = []
    for asset_id in list(event.actually_prepared) + list(event.prepared_items):
        if not _is_real_asset_ref(asset_id):
            continue
        if asset_id not in data_manager.inventory:
            continue
        if asset_id not in ids:
            ids.append(asset_id)
    return ids


def _asset_is_active_on_destination(asset_id, to_event):
    _ensure_event_lists(to_event)
    return (
        asset_id in (getattr(to_event, 'actually_prepared', []) or [])
        and asset_id not in (getattr(to_event, 'returned_items', []) or [])
    )


def _get_transfer_candidates(from_event, to_event):
    """
    Find source assets that can fill the destination event's remaining model
    requirements. Already-transferred assets are included too, marked with
    transferState='transferred', so every device can show them with Undo instead
    of disappearing after refresh.
    """
    _ensure_event_lists(from_event)
    _ensure_event_lists(to_event)

    source_state = str(from_event.state or '').strip().lower()
    target_state = str(to_event.state or '').strip().lower()

    # Keep normal source/target validation for new transfers, but still allow
    # already-transferred assets to be surfaced for undo in this comparison.
    allow_new_transfers = source_state in TRANSFER_SOURCE_STATES and target_state in TRANSFER_TARGET_STATES

    requirements = _target_model_requirements(to_event)
    remaining_by_key = {key: req['remaining'] for key, req in requirements.items() if req['remaining'] > 0}

    candidates = []
    seen = set()

    # 1) Active source assets that may still be transferred.
    if allow_new_transfers and remaining_by_key:
        for asset_id in _get_unreturned_real_asset_ids(from_event):
            asset = data_manager.inventory.get(asset_id)
            if not asset:
                continue
            if getattr(asset, 'is_missing', False) or getattr(asset, 'is_ooc', False) or _is_disposed(asset):
                continue

            key = _asset_match_key(asset)
            if remaining_by_key.get(key, 0) <= 0:
                continue

            req = requirements[key]
            candidates.append(_transfer_asset_payload(
                asset,
                state='',
                from_event=from_event,
                to_event=to_event,
                requirement=req,
            ))
            seen.add(asset.asset_id)

    # 2) Assets already moved from this source to this destination. These must
    # stay visible in Common / Transferable with an Undo button, and must not be
    # available in Return to Office.
    for asset_id in _real_source_asset_ids_including_returned(from_event):
        if asset_id in seen:
            continue
        if asset_id not in (getattr(from_event, 'returned_items', []) or []):
            continue
        if not _asset_is_active_on_destination(asset_id, to_event):
            continue

        asset = data_manager.inventory.get(asset_id)
        if not asset:
            continue

        key = _asset_match_key(asset)
        req = requirements.get(key, {
            'required': 0,
            'prepared': 0,
            'remaining': 0,
        })
        candidates.append(_transfer_asset_payload(
            asset,
            state='transferred',
            from_event=from_event,
            to_event=to_event,
            requirement=req,
            reason='Already transferred to destination event',
        ))
        seen.add(asset.asset_id)

    candidates.sort(key=lambda x: (x['department'], x['brand'], x['model'], x['description'], x['assetId']))
    return candidates



def _get_transfer_needed_from_office_assets(from_event, to_event):
    """Return destination event model quantities that still need to be packed from office.

    This compares the destination event's remaining model requirements against
    the source event's currently unreturned, transferable matching assets. If
    the destination still needs 12 of a type and the source event can provide 9,
    this view returns 3x for that type as still needed from office.
    """
    _ensure_event_lists(from_event)
    _ensure_event_lists(to_event)

    requirements = _target_model_requirements(to_event)

    # Count how many active, transferable source assets can still satisfy each
    # destination requirement. Already-transferred assets are not in this list,
    # and they are already counted as prepared in _target_model_requirements().
    source_available_by_key = defaultdict(int)
    for asset_id in _get_unreturned_real_asset_ids(from_event):
        asset = data_manager.inventory.get(asset_id)
        if not asset:
            continue
        if getattr(asset, 'is_missing', False) or getattr(asset, 'is_ooc', False):
            continue
        source_available_by_key[_asset_match_key(asset)] += 1

    needed = []
    for key, req in requirements.items():
        target_remaining = max(0, int(req.get('remaining', 0) or 0))
        if target_remaining <= 0:
            continue

        source_available = max(0, int(source_available_by_key.get(key, 0) or 0))
        office_quantity = max(0, target_remaining - source_available)
        if office_quantity <= 0:
            continue

        needed.append({
            'assetId': '',
            'department': req.get('department', ''),
            'brand': req.get('brand', ''),
            'model': req.get('model', ''),
            'description': req.get('description', ''),
            'serial': '',
            'currentLocation': 'Office',
            'matchLabel': f"[{req.get('department', '')}] {req.get('brand', '')} {req.get('model', '')} {req.get('description', '')}".strip(),
            'targetRequired': int(req.get('required', 0) or 0),
            'targetPrepared': int(req.get('prepared', 0) or 0),
            'targetRemainingBeforeThisAsset': target_remaining,
            'targetRemaining': target_remaining,
            'sourceQuantity': source_available,
            'officeQuantity': office_quantity,
            'returnQuantity': 0,
            'reason': (
                f"Destination still needs {target_remaining}; "
                f"source can provide {source_available}; {office_quantity} should be packed from office"
            ),
            'transferState': 'neededFromOffice',
        })

    needed.sort(key=lambda x: (x['department'], x['brand'], x['model'], x['description']))
    return needed


def _get_transfer_return_to_office_assets(from_event, to_event):
    """Return source assets that should go back to office.

    This is quantity-based by asset type and server-state aware:
    - transferred assets are excluded from this view
    - already-returned-to-office assets remain visible with transferState
      'returnedOffice' so users can Undo from any device
    - the grouped quantity remains the true excess count, e.g. source has 15
      and destination only needs 12 => 3x should go back, even after one of the
      three has already been marked returned.
    """
    _ensure_event_lists(from_event)
    _ensure_event_lists(to_event)

    target_requirements = _target_model_requirements(to_event)

    source_groups = defaultdict(list)
    for asset_id in _real_source_asset_ids_including_returned(from_event):
        asset = data_manager.inventory.get(asset_id)
        if not asset:
            continue
        # If this exact unit was transferred to the destination, it belongs only
        # in Common / Transferable with Undo, not in Return to Office.
        if _asset_is_active_on_destination(asset_id, to_event):
            continue
        source_groups[_asset_match_key(asset)].append(asset)

    going_back = []

    for key, group_assets in source_groups.items():
        group_assets.sort(key=lambda asset: asset.asset_id)
        source_quantity = len(group_assets)
        requirement = target_requirements.get(key)

        if requirement:
            target_remaining = max(0, int(requirement.get('remaining', 0) or 0))
            return_quantity = max(0, source_quantity - target_remaining)
            if return_quantity <= 0:
                continue
            reason = (
                f"Destination needs {target_remaining}; "
                f"source has {source_quantity}; {return_quantity} should return to office"
            )
            target_required = int(requirement.get('required', 0) or 0)
            target_prepared = int(requirement.get('prepared', 0) or 0)
        else:
            target_remaining = 0
            return_quantity = source_quantity
            reason = 'Not required by destination event'
            target_required = 0
            target_prepared = 0

        req_payload = {
            'required': target_required,
            'prepared': target_prepared,
            'remaining': target_remaining,
        }

        for asset in group_assets:
            state = 'returnedOffice' if asset.asset_id in (getattr(from_event, 'returned_items', []) or []) else ''
            going_back.append(_transfer_asset_payload(
                asset,
                state=state,
                from_event=from_event,
                to_event=to_event,
                requirement=req_payload,
                reason=reason,
                source_quantity=source_quantity,
                return_quantity=return_quantity,
            ))

    going_back.sort(key=lambda x: (x['department'], x['brand'], x['model'], x['description'], x['assetId']))
    return going_back

def _transfer_one_asset(from_event, to_event, asset_id):
    _ensure_event_lists(from_event)
    _ensure_event_lists(to_event)

    if not _is_real_asset_ref(asset_id):
        raise ValueError('Only real inventory assets can be transferred here')

    asset = data_manager.inventory.get(asset_id)
    if not asset:
        raise ValueError(f'Asset {asset_id} not found')

    if asset_id in from_event.returned_items:
        raise ValueError(f'Asset {asset_id} has already been returned from the source event')

    if asset_id not in from_event.prepared_items and asset_id not in from_event.actually_prepared:
        raise ValueError(f'Asset {asset_id} is not currently prepared for the source event')

    # Return it from the source event.
    if asset_id not in from_event.returned_items:
        from_event.returned_items.append(asset_id)
    if asset_id in from_event.actually_prepared:
        from_event.actually_prepared.remove(asset_id)

    # Prepare it immediately for the destination event. If the destination did
    # not already have this asset type as a model requirement, add it so it shows
    # together with the rest of the event assets.
    if not _asset_fulfills_event_model_requirement(to_event, asset):
        _ensure_event_has_model_requirement_for_asset(to_event, asset, 1)

    _remove_direct_asset_ref_from_prepared_items(to_event, asset_id)
    if asset_id in to_event.returned_items:
        to_event.returned_items.remove(asset_id)
    if asset_id not in to_event.actually_prepared:
        to_event.actually_prepared.append(asset_id)

    # The asset has a model row now, so it should not be displayed as a loose extra.
    if asset_id in to_event.extra_assets:
        to_event.extra_assets.remove(asset_id)

    # The physical location should now show the destination event.
    asset.current_location = to_event.name

    return {
        'assetId': asset.asset_id,
        'brand': asset.brand,
        'model': asset.model_number,
        'description': asset.description,
        'department': asset.department_code,
        'serial': asset.serial_number,
        'serial2': getattr(asset, 'secondary_serial_number', ''),
    }


@app.route('/api/transfers/options', methods=['GET'])
@require_auth
def get_transfer_options():
    """Return valid source and destination events for the Transfer Assets page."""
    try:
        # Make sure source event states are current before filtering. Returning
        # events remain eligible while they still have assets physically out.
        for event in data_manager.events.values():
            old_state = event.state
            update_event_state(event)
            if event.state != old_state:
                data_manager.save_event(event)

        source_events = []
        target_events = []

        for event in data_manager.events.values():
            state = str(event.state or '').strip().lower()
            summary = _event_summary_for_transfer(event)

            if state in TRANSFER_SOURCE_STATES and summary['unreturnedCount'] > 0:
                source_events.append(summary)
            if state in TRANSFER_TARGET_STATES:
                target_events.append(summary)

        source_events.sort(key=lambda x: (x['state'] != 'Overdue', x['endDate'], x['id']))
        target_events.sort(key=lambda x: (x['startDate'], x['id']))

        return jsonify({
            'success': True,
            'data': {
                'sourceEvents': source_events,
                'targetEvents': target_events,
            }
        })
    except Exception as e:
        logger.error(f"Error getting transfer options: {e}")
        return jsonify({'error': 'Failed to load transfer options'}), 500


@app.route('/api/transfers/candidates', methods=['GET'])
@require_auth
def get_transfer_candidates():
    """Return assets from the source event that match the destination event's remaining requirements."""
    try:
        from_event_id = request.args.get('fromEventId', type=int)
        to_event_id = request.args.get('toEventId', type=int)

        if not from_event_id or not to_event_id:
            return jsonify({'error': 'Source and destination events are required'}), 400
        if from_event_id == to_event_id:
            return jsonify({'error': 'Source and destination events cannot be the same'}), 400

        from_event = data_manager.events.get(from_event_id)
        to_event = data_manager.events.get(to_event_id)

        if not from_event or not to_event:
            return jsonify({'error': 'Event not found'}), 404

        candidates = _get_transfer_candidates(from_event, to_event)
        return_to_office = _get_transfer_return_to_office_assets(from_event, to_event)
        needed_from_office = _get_transfer_needed_from_office_assets(from_event, to_event)

        return jsonify({
            'success': True,
            'data': {
                'fromEvent': _event_summary_for_transfer(from_event),
                'toEvent': _event_summary_for_transfer(to_event),
                'candidates': candidates,
                'candidateCount': len(candidates),
                'returnToOffice': return_to_office,
                'returnToOfficeCount': len(return_to_office),
                'neededFromOffice': needed_from_office,
                'neededFromOfficeCount': len(needed_from_office),
                'neededFromOfficeQuantity': sum(int(item.get('officeQuantity', 0) or 0) for item in needed_from_office),
            }
        })
    except Exception as e:
        logger.error(f"Error getting transfer candidates: {e}")
        return jsonify({'error': 'Failed to load transfer candidates'}), 500


@app.route('/api/transfers/execute', methods=['POST'])
@require_auth
@with_transfer_action_lock
def execute_transfer_assets():
    """Bulk transfer selected matching assets from one event to another."""
    try:
        data = request.get_json() or {}
        from_event_id = data.get('fromEventId')
        to_event_id = data.get('toEventId')
        asset_ids = data.get('assetIds') or []

        if not from_event_id or not to_event_id:
            return jsonify({'error': 'Source and destination events are required'}), 400
        if int(from_event_id) == int(to_event_id):
            return jsonify({'error': 'Source and destination events cannot be the same'}), 400
        if not isinstance(asset_ids, list) or not asset_ids:
            return jsonify({'error': 'Select at least one asset to transfer'}), 400

        from_event = data_manager.events.get(int(from_event_id))
        to_event = data_manager.events.get(int(to_event_id))

        if not from_event or not to_event:
            return jsonify({'error': 'Event not found'}), 404

        if str(from_event.state or '').strip().lower() not in TRANSFER_SOURCE_STATES:
            return jsonify({'error': 'Source event must be Ready, Ongoing, Last Day, Returning, or Overdue'}), 400
        if str(to_event.state or '').strip().lower() not in TRANSFER_TARGET_STATES:
            return jsonify({'error': 'Destination event must be Planning or Preparing'}), 400

        transferred = []
        skipped = []

        for raw_asset_id in asset_ids:
            asset_id = str(raw_asset_id or '').strip()
            if not asset_id:
                continue

            asset = data_manager.inventory.get(asset_id)
            if not asset:
                skipped.append({'assetId': asset_id, 'reason': 'Asset not found'})
                continue

            requirements = _target_model_requirements(to_event)
            requirement = requirements.get(_asset_match_key(asset))
            if not requirement or requirement.get('remaining', 0) <= 0:
                skipped.append({'assetId': asset_id, 'reason': 'Destination event no longer needs this asset type'})
                continue

            try:
                transferred.append(_transfer_one_asset(from_event, to_event, asset_id))
            except ValueError as e:
                skipped.append({'assetId': asset_id, 'reason': str(e)})

        if not transferred:
            return jsonify({'error': 'No assets were transferred', 'skipped': skipped}), 400

        data_manager.save_inventory()
        update_event_state(from_event)
        update_event_state(to_event)
        data_manager.save_event(from_event)
        data_manager.save_event(to_event)
        invalidate_cache()

        log_action(
            f"Transferred {len(transferred)} asset(s) from event {from_event.event_id} to event {to_event.event_id}: "
            f"{', '.join([item['assetId'] for item in transferred])}"
        )

        return jsonify({
            'success': True,
            'message': f"Transferred {len(transferred)} asset(s)",
            'data': {
                'transferred': transferred,
                'skipped': skipped,
                'fromEvent': _event_summary_for_transfer(from_event),
                'toEvent': _event_summary_for_transfer(to_event),
            }
        })
    except Exception as e:
        logger.error(f"Error executing transfer: {e}")
        import traceback
        logger.error(f"Transfer traceback: {traceback.format_exc()}")
        return jsonify({'error': 'Failed to transfer assets'}), 500


def _undo_transfer_one_asset(from_event, to_event, asset_id):
    _ensure_event_lists(from_event)
    _ensure_event_lists(to_event)

    if not _is_real_asset_ref(asset_id):
        raise ValueError('Only real inventory assets can be undone here')

    asset = data_manager.inventory.get(asset_id)
    if not asset:
        raise ValueError(f'Asset {asset_id} not found')

    if asset_id not in getattr(to_event, 'actually_prepared', []):
        raise ValueError(f'Asset {asset_id} is not currently prepared for the destination event')

    # Remove from destination event's active prepared assets.
    if asset_id in to_event.actually_prepared:
        to_event.actually_prepared.remove(asset_id)
    if asset_id in to_event.prepared_items:
        to_event.prepared_items.remove(asset_id)
    if asset_id in to_event.extra_assets:
        to_event.extra_assets.remove(asset_id)
    if asset_id in to_event.returned_items:
        to_event.returned_items.remove(asset_id)

    # Put it back as active on the source event.
    if asset_id in from_event.returned_items:
        from_event.returned_items.remove(asset_id)
    if not _asset_fulfills_event_model_requirement(from_event, asset) and asset_id not in from_event.prepared_items:
        from_event.prepared_items.append(asset_id)
    if asset_id not in from_event.actually_prepared:
        from_event.actually_prepared.append(asset_id)

    asset.current_location = from_event.name

    return {
        'assetId': asset.asset_id,
        'brand': asset.brand,
        'model': asset.model_number,
        'description': asset.description,
        'department': asset.department_code,
        'serial': asset.serial_number,
        'serial2': getattr(asset, 'secondary_serial_number', ''),
    }


def _return_source_asset_to_office(from_event, asset_id):
    _ensure_event_lists(from_event)

    if not _is_real_asset_ref(asset_id):
        raise ValueError('Only real inventory assets can be returned to office here')

    asset = data_manager.inventory.get(asset_id)
    if not asset:
        raise ValueError(f'Asset {asset_id} not found')

    if asset_id in from_event.returned_items:
        raise ValueError(f'Asset {asset_id} has already been returned from the source event')

    if asset_id not in from_event.prepared_items and asset_id not in from_event.actually_prepared:
        raise ValueError(f'Asset {asset_id} is not currently prepared for the source event')

    if asset_id in from_event.actually_prepared:
        from_event.actually_prepared.remove(asset_id)
    if asset_id not in from_event.returned_items:
        from_event.returned_items.append(asset_id)

    asset.current_location = asset.default_location or 'Store'

    return {
        'assetId': asset.asset_id,
        'brand': asset.brand,
        'model': asset.model_number,
        'description': asset.description,
        'department': asset.department_code,
        'serial': asset.serial_number,
        'serial2': getattr(asset, 'secondary_serial_number', ''),
    }


def _undo_return_source_asset_to_office(from_event, asset_id):
    _ensure_event_lists(from_event)

    if not _is_real_asset_ref(asset_id):
        raise ValueError('Only real inventory assets can be restored here')

    asset = data_manager.inventory.get(asset_id)
    if not asset:
        raise ValueError(f'Asset {asset_id} not found')

    if asset_id not in from_event.returned_items:
        raise ValueError(f'Asset {asset_id} is not marked as returned from the source event')

    from_event.returned_items.remove(asset_id)
    if not _asset_fulfills_event_model_requirement(from_event, asset) and asset_id not in from_event.prepared_items:
        from_event.prepared_items.append(asset_id)
    if asset_id not in from_event.actually_prepared:
        from_event.actually_prepared.append(asset_id)

    asset.current_location = from_event.name

    return {
        'assetId': asset.asset_id,
        'brand': asset.brand,
        'model': asset.model_number,
        'description': asset.description,
        'department': asset.department_code,
        'serial': asset.serial_number,
        'serial2': getattr(asset, 'secondary_serial_number', ''),
    }


@app.route('/api/transfers/undo', methods=['POST'])
@require_auth
@with_transfer_action_lock
def undo_transfer_assets():
    """Undo one or more direct transfers from a destination event back to the source event."""
    try:
        data = request.get_json() or {}
        from_event_id = data.get('fromEventId')
        to_event_id = data.get('toEventId')
        asset_ids = data.get('assetIds') or []

        if not from_event_id or not to_event_id:
            return jsonify({'error': 'Source and destination events are required'}), 400
        if not isinstance(asset_ids, list) or not asset_ids:
            return jsonify({'error': 'Select at least one asset to undo'}), 400

        from_event = data_manager.events.get(int(from_event_id))
        to_event = data_manager.events.get(int(to_event_id))
        if not from_event or not to_event:
            return jsonify({'error': 'Event not found'}), 404

        undone = []
        skipped = []
        for raw_asset_id in asset_ids:
            asset_id = str(raw_asset_id or '').strip()
            if not asset_id:
                continue
            try:
                undone.append(_undo_transfer_one_asset(from_event, to_event, asset_id))
            except ValueError as e:
                skipped.append({'assetId': asset_id, 'reason': str(e)})

        if not undone:
            return jsonify({'error': 'No transfers were undone', 'skipped': skipped}), 400

        data_manager.save_inventory()
        update_event_state(from_event)
        update_event_state(to_event)
        data_manager.save_event(from_event)
        data_manager.save_event(to_event)
        invalidate_cache()

        log_action(
            f"Undid {len(undone)} transfer(s) from event {to_event.event_id} back to event {from_event.event_id}: "
            f"{', '.join([item['assetId'] for item in undone])}"
        )

        return jsonify({'success': True, 'message': f"Undid {len(undone)} transfer(s)", 'data': {'undone': undone, 'skipped': skipped}})
    except Exception as e:
        logger.error(f"Error undoing transfer: {e}", exc_info=True)
        return jsonify({'error': 'Failed to undo transfer'}), 500


@app.route('/api/transfers/return-office', methods=['POST'])
@require_auth
@with_transfer_action_lock
def return_transfer_assets_to_office():
    """Mark selected source-event assets as returned to office."""
    try:
        data = request.get_json() or {}
        from_event_id = data.get('fromEventId')
        asset_ids = data.get('assetIds') or []

        if not from_event_id:
            return jsonify({'error': 'Source event is required'}), 400
        if not isinstance(asset_ids, list) or not asset_ids:
            return jsonify({'error': 'Select at least one asset to return to office'}), 400

        from_event = data_manager.events.get(int(from_event_id))
        if not from_event:
            return jsonify({'error': 'Source event not found'}), 404

        returned = []
        skipped = []
        for raw_asset_id in asset_ids:
            asset_id = str(raw_asset_id or '').strip()
            if not asset_id:
                continue
            try:
                returned.append(_return_source_asset_to_office(from_event, asset_id))
            except ValueError as e:
                skipped.append({'assetId': asset_id, 'reason': str(e)})

        if not returned:
            return jsonify({'error': 'No assets were returned to office', 'skipped': skipped}), 400

        data_manager.save_inventory()
        update_event_state(from_event)
        data_manager.save_event(from_event)
        invalidate_cache()

        log_action(
            f"Returned {len(returned)} asset(s) from event {from_event.event_id} to office: "
            f"{', '.join([item['assetId'] for item in returned])}"
        )

        return jsonify({'success': True, 'message': f"Returned {len(returned)} asset(s) to office", 'data': {'returned': returned, 'skipped': skipped}})
    except Exception as e:
        logger.error(f"Error returning transfer assets to office: {e}", exc_info=True)
        return jsonify({'error': 'Failed to return assets to office'}), 500


@app.route('/api/transfers/undo-return-office', methods=['POST'])
@require_auth
@with_transfer_action_lock
def undo_return_transfer_assets_to_office():
    """Undo return-to-office for selected source-event assets."""
    try:
        data = request.get_json() or {}
        from_event_id = data.get('fromEventId')
        asset_ids = data.get('assetIds') or []

        if not from_event_id:
            return jsonify({'error': 'Source event is required'}), 400
        if not isinstance(asset_ids, list) or not asset_ids:
            return jsonify({'error': 'Select at least one asset to restore'}), 400

        from_event = data_manager.events.get(int(from_event_id))
        if not from_event:
            return jsonify({'error': 'Source event not found'}), 404

        restored = []
        skipped = []
        for raw_asset_id in asset_ids:
            asset_id = str(raw_asset_id or '').strip()
            if not asset_id:
                continue
            try:
                restored.append(_undo_return_source_asset_to_office(from_event, asset_id))
            except ValueError as e:
                skipped.append({'assetId': asset_id, 'reason': str(e)})

        if not restored:
            return jsonify({'error': 'No return-to-office actions were undone', 'skipped': skipped}), 400

        data_manager.save_inventory()
        update_event_state(from_event)
        data_manager.save_event(from_event)
        invalidate_cache()

        log_action(
            f"Restored {len(restored)} asset(s) from office back to event {from_event.event_id}: "
            f"{', '.join([item['assetId'] for item in restored])}"
        )

        return jsonify({'success': True, 'message': f"Restored {len(restored)} asset(s)", 'data': {'restored': restored, 'skipped': skipped}})
    except Exception as e:
        logger.error(f"Error undoing return-to-office: {e}", exc_info=True)
        return jsonify({'error': 'Failed to undo return-to-office'}), 500


@app.route('/api/events/<int:event_id>/transfer', methods=['POST'])
@require_auth
@with_transfer_action_lock
def transfer_asset_between_events(event_id):
    """Transfer one asset from one event to another. Kept for the existing manual modal."""
    try:
        data = request.get_json() or {}
        from_event_id = data.get('fromEventId')
        asset_id = str(data.get('assetId', '')).strip()

        if not from_event_id or not asset_id:
            return jsonify({'error': 'From event ID and asset ID are required'}), 400

        from_event = data_manager.events.get(int(from_event_id))
        to_event = data_manager.events.get(event_id)

        if not from_event or not to_event:
            return jsonify({'error': 'Event not found'}), 404

        transferred = _transfer_one_asset(from_event, to_event, asset_id)

        data_manager.save_inventory()
        update_event_state(from_event)
        update_event_state(to_event)
        data_manager.save_event(from_event)
        data_manager.save_event(to_event)
        invalidate_cache()

        log_action(f"Transferred asset {asset_id} from event {from_event_id} to event {event_id}")

        return jsonify({
            'success': True,
            'message': f'Asset {asset_id} transferred successfully',
            'data': transferred
        })
    except ValueError as e:
        return jsonify({'error': str(e)}), 400
    except Exception as e:
        logger.error(f"Error transferring asset: {e}")
        import traceback
        logger.error(f"Transfer traceback: {traceback.format_exc()}")
        return jsonify({'error': 'Failed to transfer asset'}), 500


@app.route('/api/assets', methods=['GET'])
@require_auth
def get_assets():
    """Get all assets"""
    try:
        assets_data = []
        assigned_assets = get_assigned_assets()
        departments = _load_departments()

        for asset in data_manager.inventory.values():
            maintenance_records = [
                _maintenance_log_for_response(log)
                for log in (getattr(asset, 'maintenance_logs', []) or [])
            ]
            is_bulk = _is_bulk_asset(asset)
            total_quantity = max(1, _safe_int(getattr(asset, 'quantity', 1), 1)) if is_bulk else 1
            bulk_deployments = _bulk_deployments_for_asset(asset.asset_id) if is_bulk else []
            deployed_quantity = sum(item['quantity'] for item in bulk_deployments)
            bulk_fault_counts = _bulk_maintenance_quantity_counts(asset) if is_bulk else {
                'ooc': 0,
                'missing': 0,
                'degraded': 0,
                'unavailable': 0,
                'total': 0,
            }
            unavailable_fault_quantity = bulk_fault_counts['ooc'] + bulk_fault_counts['missing']
            available_quantity = (
                0 if (_is_disposed(asset) or getattr(asset, 'is_missing', False) or getattr(asset, 'is_ooc', False))
                else max(0, total_quantity - deployed_quantity - unavailable_fault_quantity) if is_bulk
                else 1
            )
            preparable_quantity = (
                0 if (_is_disposed(asset) or getattr(asset, 'is_missing', False) or getattr(asset, 'is_ooc', False))
                else max(0, total_quantity - deployed_quantity - unavailable_fault_quantity) if is_bulk
                else available_quantity
            )
            healthy_quantity = (
                0 if (is_bulk and _is_degraded(asset))
                else max(0, preparable_quantity - bulk_fault_counts['degraded'])
                if is_bulk else available_quantity
            )

            # Determine current status
            status = _asset_status_value(asset, assigned_assets)
            if is_bulk and status not in ('decommissioned', 'missing', 'ooc'):
                if deployed_quantity > 0:
                    status = 'deployed'
                elif bulk_fault_counts['missing'] > 0:
                    status = 'missing'
                elif bulk_fault_counts['ooc'] > 0:
                    status = 'ooc'
                elif bulk_fault_counts['degraded'] > 0 or _is_degraded(asset):
                    status = 'degraded'
                else:
                    status = 'available'

            assets_data.append({
                'id': '' if is_bulk else asset.asset_id,
                'internalId': asset.asset_id,
                'bulkId': asset.asset_id if is_bulk else '',
                'displayId': '' if is_bulk else asset.asset_id,
                'brand': asset.brand,
                'model': asset.model_number,
                'serial': asset.serial_number,
                'serial2': getattr(asset, 'secondary_serial_number', ''),
                'description': asset.description,
                'dateOfPurchase': getattr(asset, 'date_of_purchase', ''),
                'purchaseDate': getattr(asset, 'date_of_purchase', ''),
                'dateAdded': getattr(asset, 'date_added', ''),
                'dateModified': getattr(asset, 'date_modified', ''),
                'changeHistory': getattr(asset, 'change_history', []),
                'notes': getattr(asset, 'notes', ''),
                'department': asset.department_code,
                'departmentName': _department_payload(asset.department_code, departments)['name'],
                'departmentColor': _department_payload(asset.department_code, departments)['color'],
                'departmentTextColor': _department_payload(asset.department_code, departments)['textColor'],
                'status': status,
                'location': asset.current_location or asset.default_location,
                'isMissing': asset.is_missing,
                'isOOC': asset.is_ooc,
                'isDegraded': _is_degraded(asset),
                'isDisposed': _is_disposed(asset),
                'defaultLocation': asset.default_location,
                'currentLocation': asset.current_location,
                'maintenanceLogs': [
                    maintenance_log_to_display_string(log, include_changes=False)
                    for log in maintenance_records
                ],
                'maintenanceLogRecords': maintenance_records,
                'isBulk': is_bulk,
                'quantity': total_quantity,
                'availableQuantity': available_quantity,
                'preparableQuantity': preparable_quantity,
                'healthyQuantity': healthy_quantity,
                'deployedQuantity': deployed_quantity if is_bulk else 0,
                'bulkDeployments': bulk_deployments if is_bulk else [],
                'bulkOOCQuantity': bulk_fault_counts['ooc'] if is_bulk else 0,
                'bulkMissingQuantity': bulk_fault_counts['missing'] if is_bulk else 0,
                'bulkDegradedQuantity': bulk_fault_counts['degraded'] if is_bulk else 0,
                'bulkFaultQuantity': bulk_fault_counts['total'] if is_bulk else 0,
                'degradedReasons': _asset_degraded_reasons(asset),
                'bulkDegradedReasons': _bulk_degraded_reasons(asset) if is_bulk else [],
                'bulkMaintenanceLogbook': _bulk_maintenance_logbook_for_response(asset) if is_bulk else []
            })

        return jsonify({'success': True, 'data': assets_data})
    except Exception as e:
        logger.error(f"Error getting assets: {e}")
        return jsonify({'error': 'Failed to retrieve assets'}), 500


def _asset_check_find_asset(identifier):
    """Find an asset by Asset ID or Serial Number for Asset Check."""
    return _find_inventory_asset_by_identifier(identifier)


def _asset_check_is_store_location(asset):
    """Asset Check only counts items that are physically in Store."""
    location = str(
        getattr(asset, 'current_location', '') or
        getattr(asset, 'default_location', '') or
        'Store'
    ).strip()

    return not location or location.lower() == 'store'


def _asset_check_deployment(asset_id):
    """Return active event information if the asset is currently out on show/dry hire."""
    if not asset_id:
        return None

    for event in data_manager.events.values():
        returned_items = {str(x).strip() for x in (getattr(event, 'returned_items', []) or [])}

        active_refs = []
        for value in (getattr(event, 'actually_prepared', []) or []):
            if isinstance(value, str) and _is_real_asset_ref(value):
                active_refs.append(value.strip())

        # Older files may only have direct asset IDs in prepared_items.
        for value in (getattr(event, 'prepared_items', []) or []):
            if isinstance(value, str) and _is_real_asset_ref(value):
                active_refs.append(value.strip())

        if asset_id in active_refs and asset_id not in returned_items:
            return {
                'eventId': event.event_id,
                'eventName': getattr(event, 'name', ''),
                'eventState': getattr(event, 'state', ''),
                'eventTag': getattr(event, 'tag', 'event')
            }

    return None


def _asset_check_group_display_from_key(group_key):
    dept, brand, model, description = group_key
    return f"[{dept}] {brand} {model} {description}".strip()


def _asset_check_asset_to_dict(asset, group_key):
    location = str(
        getattr(asset, 'current_location', '') or
        getattr(asset, 'default_location', '') or
        'Store'
    ).strip() or 'Store'

    deployment = None if _is_bulk_asset(asset) else _asset_check_deployment(asset.asset_id)

    excluded = False
    exclusion_reason = ''
    status = 'unchecked'

    if _is_bulk_asset(asset):
        excluded = True
        exclusion_reason = 'Bulk quantity asset - no individual Asset ID to check'
        status = 'bulk'
    elif _is_disposed(asset):
        excluded = True
        exclusion_reason = 'Decommissioned asset - no longer in usable inventory'
        status = 'decommissioned'
    elif getattr(asset, 'is_missing', False):
        excluded = True
        exclusion_reason = 'Already marked Missing'
        status = 'missing'
    elif deployment:
        excluded = True
        tag = 'Dry Hire' if deployment.get('eventTag') == 'dry hire' else 'Event'
        exclusion_reason = f"Out on {tag} {deployment.get('eventId')}: {deployment.get('eventName')}"
        status = 'deployed'
    elif not _asset_check_is_store_location(asset):
        excluded = True
        exclusion_reason = f"Away from Store: {location}"
        status = 'away'
    elif getattr(asset, 'is_ooc', False):
        # OOC items that are still in Store can still be physically checked.
        status = 'ooc'
    elif _is_degraded(asset):
        status = 'degraded'

    return {
        'id': '' if _is_bulk_asset(asset) else asset.asset_id,
        'internalId': asset.asset_id,
        'brand': asset.brand,
        'model': asset.model_number,
        'description': asset.description or '',
        'serial': asset.serial_number or '',
        'serial2': getattr(asset, 'secondary_serial_number', '') or '',
        'department': asset.department_code,
        'location': location,
        'defaultLocation': getattr(asset, 'default_location', '') or 'Store',
        'currentLocation': getattr(asset, 'current_location', '') or '',
        'isMissing': bool(getattr(asset, 'is_missing', False)),
        'isOOC': bool(getattr(asset, 'is_ooc', False)),
        'isDegraded': _is_degraded(asset),
        'isDisposed': _is_disposed(asset),
        'isBulk': bool(_is_bulk_asset(asset)),
        'deployment': deployment,
        'status': status,
        'checkEligible': not excluded,
        'excluded': excluded,
        'exclusionReason': exclusion_reason,
        'groupKey': '|'.join(group_key),
        'groupDisplay': _asset_check_group_display_from_key(group_key)
    }


def _asset_check_build_group(seed_asset):
    if not seed_asset:
        raise ValueError('Asset not found')

    group_key = _asset_group_key(seed_asset)
    group_assets = [
        asset for asset in data_manager.inventory.values()
        if asset and _asset_group_key(asset) == group_key
    ]

    group_assets.sort(key=lambda a: (
        bool(_is_disposed(a)),
        bool(getattr(a, 'is_missing', False)),
        str(getattr(a, 'asset_id', '') or '').lower()
    ))

    assets_payload = [_asset_check_asset_to_dict(asset, group_key) for asset in group_assets]

    summary = {
        'total': len(assets_payload),
        'checkable': len([a for a in assets_payload if a['checkEligible']]),
        'excluded': len([a for a in assets_payload if a['excluded'] and not a['isMissing'] and not a.get('isDisposed')]),
        'missing': len([a for a in assets_payload if a['isMissing']]),
        'decommissioned': len([a for a in assets_payload if a.get('isDisposed')]),
        'disposed': len([a for a in assets_payload if a.get('isDisposed')]),
    }

    dept, brand, model, description = group_key

    return {
        'group': {
            'key': '|'.join(group_key),
            'department': dept,
            'brand': brand,
            'model': model,
            'description': description,
            'displayName': _asset_check_group_display_from_key(group_key)
        },
        'assets': assets_payload,
        'summary': summary,
        'scannedAsset': _asset_check_asset_to_dict(seed_asset, group_key)
    }


@app.route('/api/asset-check/group', methods=['POST'])
@require_auth
def asset_check_group():
    """Start/refresh an asset check group from a scanned Asset ID or Serial Number."""
    try:
        data = request.get_json() or {}
        identifier = str(data.get('identifier', '')).strip()

        if not identifier:
            return jsonify({'error': 'Asset ID or Serial Number is required'}), 400

        seed_asset = _asset_check_find_asset(identifier)
        if not seed_asset:
            return jsonify({'error': f'Asset or serial number not found: {identifier}'}), 404

        if _is_bulk_asset(seed_asset):
            return jsonify({'error': 'Bulk quantity assets cannot start an Asset Check because they do not have individual Asset IDs'}), 400

        return jsonify({'success': True, 'data': _asset_check_build_group(seed_asset)})

    except Exception as e:
        logger.error(f"Error starting asset check: {e}")
        import traceback
        logger.error(f"Asset check traceback: {traceback.format_exc()}")
        return jsonify({'error': 'Failed to start Asset Check'}), 500


def _asset_check_sighting_description(username):
    username = str(username or 'user').strip() or 'user'
    return f"Asset sighted by {username} during Asset Check"


def _asset_check_log_matches_source(log_entry, check_id):
    record = normalize_maintenance_log(log_entry)
    source = record.get('source') or {}
    return (
        record.get('type') == ASSET_CHECK_LOG_TYPE and
        source.get('kind') == 'asset_check_sighting' and
        check_id and
        source.get('checkId') == check_id
    )


def _asset_check_fallback_sighting_index(asset, username):
    """Find the latest same-day sighting log when an older client has no check id."""
    today = datetime.now().strftime("%Y/%m/%d")
    expected_description = _asset_check_sighting_description(username)

    for index in range(len(getattr(asset, 'maintenance_logs', []) or []) - 1, -1, -1):
        record = normalize_maintenance_log(asset.maintenance_logs[index])
        if (
            record.get('type') == ASSET_CHECK_LOG_TYPE and
            record.get('date') == today and
            record.get('user') == username and
            record.get('description') == expected_description
        ):
            return index

    return None


@app.route('/api/asset-check/sighting', methods=['POST'])
@require_auth
def asset_check_sighting():
    """Add or remove the automatic Asset Check sighting maintenance log."""
    try:
        data = request.get_json() or {}
        asset_id = str(data.get('assetId') or data.get('identifier') or '').strip()
        group_key = str(data.get('groupKey') or '').strip()
        check_id = str(data.get('checkId') or '').strip()[:160]
        checked = _request_bool(data.get('checked'), default=True)

        if not asset_id:
            return jsonify({'error': 'Asset ID is required'}), 400

        asset = _asset_check_find_asset(asset_id)
        if not asset:
            return jsonify({'error': 'Asset not found'}), 404

        if _is_bulk_asset(asset):
            return jsonify({'error': 'Bulk quantity assets cannot be checked individually'}), 400

        actual_group_key = '|'.join(_asset_group_key(asset))
        if group_key and group_key != actual_group_key:
            return jsonify({'error': 'Asset no longer matches this Asset Check group'}), 400

        asset_payload = _asset_check_asset_to_dict(asset, _asset_group_key(asset))
        if not asset_payload.get('checkEligible'):
            return jsonify({'error': asset_payload.get('exclusionReason') or 'Asset is not eligible for this Asset Check'}), 400

        username = session.get('user', 'system')

        if checked:
            for existing_log in getattr(asset, 'maintenance_logs', []) or []:
                if _asset_check_log_matches_source(existing_log, check_id):
                    return jsonify({
                        'success': True,
                        'message': 'Asset Check sighting already logged',
                        'data': {'assetId': asset.asset_id, 'checkId': check_id}
                    })

            if not check_id:
                check_id = f"asset-check-{int(time.time() * 1000)}-{secrets.token_hex(6)}"

            today = datetime.now().strftime("%Y/%m/%d")
            source = {
                'kind': 'asset_check_sighting',
                'checkId': check_id,
                'groupKey': group_key or actual_group_key,
                'createdAt': datetime.now().isoformat(timespec='seconds')
            }
            asset.maintenance_logs.append(make_maintenance_log(
                today,
                username,
                _asset_check_sighting_description(username),
                [],
                log_type=ASSET_CHECK_LOG_TYPE,
                source=source
            ))
            data_manager.save_inventory()
            invalidate_cache()
            log_action(f"Asset Check sighted asset {asset.asset_id}")

            return jsonify({
                'success': True,
                'message': 'Asset Check sighting logged',
                'data': {'assetId': asset.asset_id, 'checkId': check_id}
            })

        remove_index = None
        if check_id:
            for index in range(len(getattr(asset, 'maintenance_logs', []) or []) - 1, -1, -1):
                if _asset_check_log_matches_source(asset.maintenance_logs[index], check_id):
                    remove_index = index
                    break

        if remove_index is None:
            remove_index = _asset_check_fallback_sighting_index(asset, username)

        if remove_index is not None:
            asset.maintenance_logs.pop(remove_index)
            data_manager.save_inventory()
            invalidate_cache()
            log_action(f"Asset Check sighting removed for asset {asset.asset_id}")

        return jsonify({
            'success': True,
            'message': 'Asset Check sighting removed',
            'data': {
                'assetId': asset.asset_id,
                'checkId': check_id,
                'removed': remove_index is not None
            }
        })

    except Exception as e:
        logger.error(f"Error updating Asset Check sighting: {e}", exc_info=True)
        return jsonify({'error': 'Failed to update Asset Check sighting'}), 500


@app.route('/api/asset-check/mark-missing', methods=['POST'])
@require_auth
def asset_check_mark_missing():
    """Mark unchecked, eligible Asset Check items as Missing after frontend confirmation."""
    try:
        data = request.get_json() or {}

        if not data.get('confirm'):
            return jsonify({'error': 'Confirmation is required before marking assets as missing'}), 400

        asset_ids = data.get('assetIds') or []
        group_key = str(data.get('groupKey', '') or '').strip()

        if not isinstance(asset_ids, list):
            return jsonify({'error': 'assetIds must be a list'}), 400

        asset_ids = [str(asset_id or '').strip() for asset_id in asset_ids if str(asset_id or '').strip()]
        if not asset_ids:
            return jsonify({'success': True, 'message': 'No unchecked assets to mark as missing', 'data': {'marked': [], 'skipped': []}})

        marked = []
        skipped = []
        today = datetime.now().strftime("%Y/%m/%d")
        username = session.get('user', 'system')

        for asset_id in asset_ids:
            asset = data_manager.inventory.get(asset_id)

            if not asset:
                skipped.append({'assetId': asset_id, 'reason': 'Asset not found'})
                continue

            if _is_bulk_asset(asset):
                skipped.append({'assetId': asset_id, 'reason': 'Bulk quantity asset cannot be marked missing by Asset Check'})
                continue

            if group_key and '|'.join(_asset_group_key(asset)) != group_key:
                skipped.append({'assetId': asset_id, 'reason': 'Asset no longer matches this Asset Check group'})
                continue

            if getattr(asset, 'is_missing', False):
                skipped.append({'assetId': asset_id, 'reason': 'Already marked Missing'})
                continue

            deployment = _asset_check_deployment(asset.asset_id)
            if deployment:
                skipped.append({'assetId': asset_id, 'reason': f"Currently out on Event {deployment.get('eventId')}"})
                continue

            if not _asset_check_is_store_location(asset):
                location = str(getattr(asset, 'current_location', '') or getattr(asset, 'default_location', '') or 'Store').strip() or 'Store'
                skipped.append({'assetId': asset_id, 'reason': f'Away from Store: {location}'})
                continue

            asset.is_missing = True
            asset.maintenance_logs.append(make_maintenance_log(
                today,
                username,
                "Asset Check - marked missing because this item was not checked",
                [make_change('missing', action='marked')],
                log_type=ASSET_CHECK_LOG_TYPE,
                source={
                    'kind': 'asset_check_missing',
                    'groupKey': group_key,
                    'createdAt': datetime.now().isoformat(timespec='seconds')
                }
            ))
            marked.append(asset_id)

        if marked:
            data_manager.save_inventory()
            invalidate_cache()
            log_action(f"Asset Check marked {len(marked)} asset(s) as Missing: {', '.join(marked)}")

        return jsonify({
            'success': True,
            'message': f"Marked {len(marked)} asset(s) as Missing",
            'data': {
                'marked': marked,
                'skipped': skipped
            }
        })

    except Exception as e:
        logger.error(f"Error marking Asset Check missing assets: {e}")
        import traceback
        logger.error(f"Asset check mark missing traceback: {traceback.format_exc()}")
        return jsonify({'error': 'Failed to mark unchecked assets as Missing'}), 500


@app.route('/api/assets/available', methods=['GET'])
@require_auth
def get_available_assets():
    """
    Get assets that can be requested for future events.

    Rules:
    - Exclude Missing and decommissioned assets.
    - Include OOC and Degraded assets because they may be repaired/usable before the event date.
    - Do not subtract clashing events here; event-date availability is handled by
      /api/events/<event_id>/availability.
    """
    try:
        available_assets = []

        for asset in data_manager.inventory.values():
            if not asset:
                continue

            if getattr(asset, 'is_missing', False) or _is_disposed(asset):
                continue

            available_assets.append(_asset_to_available_dict(asset))

        available_assets.sort(key=lambda x: (
            x['department'],
            x['brand'].lower(),
            x['model'].lower(),
            x['description'].lower(),
            x['id']
        ))

        return jsonify({'success': True, 'data': available_assets})

    except Exception as e:
        logger.error(f"Error getting available assets: {e}")
        return jsonify({'error': 'Failed to retrieve available assets'}), 500

@app.route('/api/events/<int:event_id>/assets', methods=['GET'])
def get_event_assets(event_id):
    """Get all assets assigned to an event with their details"""
    if 'user' not in session:
        return jsonify({'error': 'Not authenticated'}), 401

    event = data_manager.events.get(event_id)
    if not event:
        return jsonify({'error': 'Event not found'}), 404

    _ensure_event_custom_lists(event)
    event_assets = []
    seen_asset_ids = set()
    asset_refs = (
        list(getattr(event, 'prepared_items', []) or []) +
        list(getattr(event, 'actually_prepared', []) or []) +
        list(getattr(event, 'returned_items', []) or [])
    )
    for asset_id in asset_refs:
        if (
            asset_id in seen_asset_ids or
            not _is_real_asset_ref(asset_id) or
            _is_bulk_ref(asset_id) or
            _is_custom_ref(asset_id)
        ):
            continue

        asset = data_manager.inventory.get(asset_id)
        if asset:
            seen_asset_ids.add(asset_id)
            if asset_id in event.returned_items:
                status = 'returned'
            elif asset_id in event.actually_prepared:
                status = 'prepared'
            else:
                status = 'assigned'

            event_assets.append({
                'id': asset.asset_id,
                'brand': asset.brand,
                'model': asset.model_number,
                'description': asset.description,
                'serial': asset.serial_number,
                'serial2': getattr(asset, 'secondary_serial_number', ''),
                'department': asset.department_code,
                'status': status,
                'location': asset.current_location,
                'isMissing': asset.is_missing,
                'isOOC': asset.is_ooc,
                'isDegraded': _is_degraded(asset),
                'isDisposed': _is_disposed(asset)
            })

    return jsonify({'success': True, 'data': event_assets})


@app.route('/api/assets', methods=['POST'])
@require_admin
def create_asset():
    """Create one or more assets."""
    try:
        data = request.get_json() or {}
        purchase_date = _normalise_asset_purchase_date(
            data.get('dateOfPurchase', data.get('purchaseDate', ''))
        )
        notes = str(data.get('notes', '') or '').strip()

        with _inventory_action_lock:
            plan = _asset_id_plan_for_request(data)
            audit_timestamp = _asset_audit_timestamp()
            audit_user = _asset_audit_user()

            if plan['isBulk']:
                existing_bulk_numbers = []
                for item_id in data_manager.inventory.keys():
                    if str(item_id).startswith('BULK-'):
                        existing_bulk_numbers.append(_safe_int(str(item_id).replace('BULK-', ''), 0))
                created_asset_ids = [f"BULK-{(max(existing_bulk_numbers, default=0) + 1):04d}"]
                asset = InventoryItem(
                    asset_id=created_asset_ids[0],
                    brand=plan['brand'],
                    model_number=plan['model'],
                    serial_number='',
                    secondary_serial_number='',
                    description=plan['description'],
                    is_missing=False,
                    is_ooc=False,
                    is_degraded=bool(data.get('isDegraded', False)),
                    is_disposed=bool(data.get('isDisposed', False) or data.get('isDecommissioned', False)),
                    maintenance_logs=[],
                    department_code=plan['department'],
                    default_location='Store',
                    current_location='',
                    is_bulk=True,
                    quantity=plan['quantity'],
                    date_of_purchase=purchase_date,
                    notes=notes
                )
                _mark_asset_created(asset, timestamp=audit_timestamp, user=audit_user)
                data_manager.inventory[created_asset_ids[0]] = asset
            else:
                created_asset_ids = []
                for index, asset_id in enumerate(plan['ids']):
                    asset = InventoryItem(
                        asset_id=asset_id,
                        brand=plan['brand'],
                        model_number=plan['model'],
                        serial_number=plan['serials'][index],
                        secondary_serial_number=plan['secondarySerials'][index],
                        description=plan['description'],
                        is_missing=False,
                        is_ooc=False,
                        is_degraded=bool(data.get('isDegraded', False)),
                        is_disposed=bool(data.get('isDisposed', False) or data.get('isDecommissioned', False)),
                        maintenance_logs=[],
                        department_code=plan['department'],
                        default_location='Store',
                        current_location='',
                        is_bulk=False,
                        quantity=1,
                        date_of_purchase=purchase_date,
                        notes=notes
                    )
                    _mark_asset_created(asset, timestamp=audit_timestamp, user=audit_user)
                    data_manager.inventory[asset_id] = asset
                    created_asset_ids.append(asset_id)

            data_manager.save_inventory()

        # Auto-register the asset's department if it is new.
        departments = _load_departments()
        dept_code = _normalise_department_code(plan['department']) or 'UN'
        if dept_code not in departments:
            departments[dept_code] = _department_record(dept_code)
            _save_departments(departments)

        # Invalidate cache
        invalidate_cache()

        if len(created_asset_ids) == 1:
            log_action(f"Added asset {created_asset_ids[0]} via web interface")
            message = 'Asset created successfully'
        else:
            log_action(f"Added assets {created_asset_ids[0]} to {created_asset_ids[-1]} via web interface")
            message = f'{len(created_asset_ids)} assets created successfully'

        return jsonify({
            'success': True,
            'message': message,
            'assetId': created_asset_ids[0],
            'assetIds': created_asset_ids,
            'prefix': plan.get('prefix', ''),
            'count': len(created_asset_ids)
        })
    except ValueError as e:
        return jsonify({'error': str(e)}), 400
    except Exception as e:
        logger.error(f"Error creating asset: {e}", exc_info=True)
        return jsonify({'error': 'Failed to create asset'}), 500


@app.route('/api/assets/serial-preview', methods=['POST'])
@require_auth
def preview_asset_serial_ids():
    """Preview the Asset IDs that the Add Assets workflow will create."""
    try:
        data = request.get_json() or {}
        plan = _asset_id_plan_for_request(data)
        return jsonify({
            'success': True,
            'data': {
                'isBulk': plan['isBulk'],
                'prefix': plan['prefix'],
                'startNumber': plan['startNumber'],
                'nextNumber': plan['nextNumber'],
                'ids': plan['ids'],
                'count': plan['quantity'],
                'existingCount': plan['existingCount'],
                'message': plan['message']
            }
        })
    except ValueError as e:
        return jsonify({'error': str(e)}), 400
    except Exception as e:
        logger.error(f"Error previewing asset IDs: {e}", exc_info=True)
        return jsonify({'error': 'Failed to preview asset IDs'}), 500


def _active_event_usage_for_asset(asset_id):
    """Return active event references that should block deleting an inventory item."""
    usage = []
    for event in data_manager.events.values():
        returned = set(getattr(event, 'returned_items', []) or [])
        active = False

        for ref in (getattr(event, 'prepared_items', []) or []) + (getattr(event, 'actually_prepared', []) or []):
            if ref in returned:
                continue

            if ref == asset_id:
                active = True
                break

            marker = _parse_bulk_marker(ref)
            if marker and marker.get('bulkId') == asset_id:
                active = True
                break

        if active:
            usage.append({
                'eventId': getattr(event, 'event_id', None),
                'eventName': getattr(event, 'name', ''),
            })

    return usage


def _normalise_asset_ids_for_delete(values):
    if isinstance(values, str):
        values = [values]

    asset_ids = []
    seen = set()
    for value in values or []:
        asset_id = str(value or '').strip()
        if asset_id and asset_id not in seen:
            asset_ids.append(asset_id)
            seen.add(asset_id)
    return asset_ids


def _event_ref_targets_deleted_asset(ref, deleted_asset_ids):
    if ref in deleted_asset_ids:
        return True

    marker = _parse_bulk_marker(ref)
    return bool(marker and marker.get('bulkId') in deleted_asset_ids)


def _remove_deleted_asset_refs(values, deleted_asset_ids):
    kept = []
    removed = []

    for value in values or []:
        if _event_ref_targets_deleted_asset(value, deleted_asset_ids):
            removed.append(value)
        else:
            kept.append(value)

    return kept, removed


def _detach_deleted_assets_from_events(deleted_asset_ids):
    events_updated = 0
    event_refs_removed = 0
    event_details = []

    for event in data_manager.events.values():
        changed = False
        refs_removed_for_event = 0

        for attr in ('prepared_items', 'actually_prepared', 'returned_items', 'extra_assets'):
            current_values = list(getattr(event, attr, []) or [])
            kept, removed = _remove_deleted_asset_refs(current_values, deleted_asset_ids)
            if removed:
                setattr(event, attr, kept)
                changed = True
                refs_removed_for_event += len(removed)

        if changed:
            update_event_state(event)
            data_manager.save_event(event)
            events_updated += 1
            event_refs_removed += refs_removed_for_event
            event_details.append({
                'eventId': getattr(event, 'event_id', None),
                'eventName': getattr(event, 'name', ''),
                'refsRemoved': refs_removed_for_event,
            })

    return events_updated, event_refs_removed, event_details


def _delete_inventory_assets(asset_ids):
    result = {
        'deletedAssets': [],
        'missingAssetIds': [],
        'containersUpdated': 0,
        'containerRefsRemoved': 0,
        'eventsUpdated': 0,
        'eventRefsRemoved': 0,
        'mediaDeleted': 0,
        'eventDetails': [],
    }

    delete_asset_ids = []
    for asset_id in _normalise_asset_ids_for_delete(asset_ids):
        asset = data_manager.inventory.get(asset_id)
        if not asset:
            result['missingAssetIds'].append(asset_id)
            continue

        for log_entry in getattr(asset, 'maintenance_logs', []) or []:
            result['mediaDeleted'] += _delete_maintenance_media_files(log_entry)

        delete_asset_ids.append(asset_id)

    if not delete_asset_ids:
        return result

    deleted_asset_ids = set(delete_asset_ids)
    (
        result['eventsUpdated'],
        result['eventRefsRemoved'],
        result['eventDetails'],
    ) = _detach_deleted_assets_from_events(deleted_asset_ids)

    for container in data_manager.containers.values():
        before = len(container.asset_ids)
        container.asset_ids = [ref for ref in container.asset_ids if ref not in deleted_asset_ids]
        removed = before - len(container.asset_ids)
        if removed:
            result['containersUpdated'] += 1
            result['containerRefsRemoved'] += removed

    for asset_id in delete_asset_ids:
        del data_manager.inventory[asset_id]
        result['deletedAssets'].append(asset_id)

    data_manager.save_inventory(drop_asset_ids=delete_asset_ids)
    if result['containersUpdated']:
        data_manager.save_containers()

    return result


@app.route('/api/assets/bulk-delete', methods=['DELETE'])
@require_admin
def bulk_delete_assets():
    """Admin-only selected asset deletion with password reconfirmation."""
    try:
        data = request.get_json(silent=True) or {}

        verified, password_error = _verify_current_admin_password(data.get('password'))
        if not verified:
            return jsonify({'error': password_error}), 400 if password_error == 'Admin password is required' else 403

        asset_ids = _normalise_asset_ids_for_delete(data.get('assetIds'))
        if not asset_ids:
            return jsonify({'error': 'Select at least one asset to delete'}), 400

        with _inventory_action_lock:
            delete_result = _delete_inventory_assets(asset_ids)

        if not delete_result['deletedAssets']:
            return jsonify({
                'error': 'No matching assets found',
                'data': delete_result,
            }), 404

        invalidate_cache()
        log_action(
            f"Bulk deleted {len(delete_result['deletedAssets'])} assets; "
            f"eventsUpdated={delete_result['eventsUpdated']}; "
            f"eventRefsRemoved={delete_result['eventRefsRemoved']}; "
            f"containersUpdated={delete_result['containersUpdated']}; "
            f"containerRefsRemoved={delete_result['containerRefsRemoved']}; "
            f"mediaDeleted={delete_result['mediaDeleted']}"
        )

        return jsonify({
            'success': True,
            'message': f"Deleted {len(delete_result['deletedAssets'])} asset(s)",
            'data': delete_result,
        })

    except Exception as e:
        logger.error(f"Error bulk deleting assets: {e}", exc_info=True)
        return jsonify({'error': 'Failed to delete selected assets'}), 500


@app.route('/api/assets/bulk-renumber', methods=['POST'])
@require_admin
def bulk_renumber_assets():
    """Rename selected assets to an ascending ID sequence in one safe mapping."""
    try:
        data = request.get_json(silent=True) or {}
        asset_ids = _normalise_asset_ids_for_delete(data.get('assetIds'))

        if len(asset_ids) < 2:
            return jsonify({'error': 'Select at least two assets to enumerate'}), 400

        starting_asset_id = str(data.get('startingAssetId') or '').strip()
        match = re.match(r'^(.*?)(\d+)$', starting_asset_id)
        if not match:
            return jsonify({
                'error': 'Starting Asset ID must end with a number (for example, MIC#01)'
            }), 400

        prefix, number_text = match.groups()
        starting_number = int(number_text)
        number_width = len(number_text)
        new_asset_ids = [
            f'{prefix}{number:0{number_width}d}'
            for number in range(starting_number, starting_number + len(asset_ids))
        ]

        with _inventory_action_lock:
            missing_asset_ids = [
                asset_id for asset_id in asset_ids
                if asset_id not in data_manager.inventory
            ]
            if missing_asset_ids:
                return jsonify({
                    'error': f"Asset not found: {missing_asset_ids[0]}"
                }), 404

            selected_id_set = set(asset_ids)
            conflicting_ids = [
                asset_id for asset_id in new_asset_ids
                if asset_id in data_manager.inventory and asset_id not in selected_id_set
            ]
            if conflicting_ids:
                return jsonify({
                    'error': f'Asset ID {conflicting_ids[0]} already exists'
                }), 409

            asset_id_mapping = dict(zip(asset_ids, new_asset_ids))
            changed_mapping = {
                old_id: new_id
                for old_id, new_id in asset_id_mapping.items()
                if old_id != new_id
            }

            if not changed_mapping:
                return jsonify({
                    'success': True,
                    'message': 'Asset IDs already match the requested sequence',
                    'data': {
                        'mapping': asset_id_mapping,
                        'renamedAssets': 0,
                        'eventsUpdated': 0,
                        'containersUpdated': 0,
                        'idReferencesChanged': 0,
                    },
                })

            audit_timestamp = _asset_audit_timestamp()
            audit_user = _asset_audit_user()
            renamed_assets = [
                (
                    data_manager.inventory[old_id],
                    _asset_audit_snapshot(data_manager.inventory[old_id])
                )
                for old_id in asset_ids
            ]

            renamed_inventory = {}
            for current_id, item in data_manager.inventory.items():
                new_id = asset_id_mapping.get(current_id, current_id)
                item.asset_id = new_id
                renamed_inventory[new_id] = item
            data_manager.inventory = renamed_inventory

            containers_updated = 0
            id_references_changed = 0
            for container in data_manager.containers.values():
                changed = _replace_asset_ids_in_list(
                    container.asset_ids,
                    changed_mapping
                )
                if changed:
                    containers_updated += 1
                    id_references_changed += changed

            if containers_updated:
                data_manager.save_containers()

            events_updated = 0
            for event in data_manager.events.values():
                event_changed = 0
                for attr in (
                    'prepared_items',
                    'returned_items',
                    'actually_prepared',
                    'extra_assets',
                ):
                    event_changed += _replace_asset_ids_in_list(
                        getattr(event, attr, []),
                        changed_mapping
                    )

                if event_changed:
                    id_references_changed += event_changed
                    update_event_state(event)
                    data_manager.save_event(event)
                    events_updated += 1

            for item, before_snapshot in renamed_assets:
                _append_asset_change_history(
                    item,
                    _asset_audit_changes(
                        before_snapshot,
                        _asset_audit_snapshot(item),
                        fields=('asset_id',),
                    ),
                    timestamp=audit_timestamp,
                    user=audit_user,
                    action='updated',
                )

            stale_ids = set(asset_ids) - set(new_asset_ids)
            data_manager.save_inventory(drop_asset_ids=stale_ids)

        invalidate_cache()
        log_action(
            f"Enumerated {len(changed_mapping)} selected asset IDs starting at "
            f"{starting_asset_id}; eventsUpdated={events_updated}; "
            f"containersUpdated={containers_updated}"
        )

        return jsonify({
            'success': True,
            'message': f'Renumbered {len(changed_mapping)} asset(s)',
            'data': {
                'mapping': asset_id_mapping,
                'renamedAssets': len(changed_mapping),
                'eventsUpdated': events_updated,
                'containersUpdated': containers_updated,
                'idReferencesChanged': id_references_changed,
            },
        })

    except Exception as e:
        logger.error(f"Error bulk renumbering assets: {e}", exc_info=True)
        return jsonify({'error': 'Failed to enumerate selected asset IDs'}), 500


@app.route('/api/assets/<path:asset_id>', methods=['DELETE'])
@require_admin
def delete_asset(asset_id):
    """Admin-only asset deletion with password reconfirmation."""
    try:
        decoded_asset_id = unquote_plus(asset_id)
        data = request.get_json(silent=True) or {}

        verified, password_error = _verify_current_admin_password(data.get('password'))
        if not verified:
            return jsonify({'error': password_error}), 400 if password_error == 'Admin password is required' else 403

        with _inventory_action_lock:
            delete_result = _delete_inventory_assets([decoded_asset_id])
            if not delete_result['deletedAssets']:
                return jsonify({'error': 'Asset not found'}), 404

        invalidate_cache()
        log_action(
            f"Deleted asset {decoded_asset_id}; eventsUpdated={delete_result['eventsUpdated']}; "
            f"eventRefsRemoved={delete_result['eventRefsRemoved']}; "
            f"containersUpdated={delete_result['containersUpdated']}; "
            f"containerRefsRemoved={delete_result['containerRefsRemoved']}; "
            f"mediaDeleted={delete_result['mediaDeleted']}"
        )

        return jsonify({
            'success': True,
            'message': 'Asset deleted successfully',
            'data': {
                'assetId': decoded_asset_id,
                'containersUpdated': delete_result['containersUpdated'],
                'containerRefsRemoved': delete_result['containerRefsRemoved'],
                'eventsUpdated': delete_result['eventsUpdated'],
                'eventRefsRemoved': delete_result['eventRefsRemoved'],
                'mediaDeleted': delete_result['mediaDeleted'],
                'eventDetails': delete_result['eventDetails'],
            }
        })

    except Exception as e:
        logger.error(f"Error deleting asset {asset_id}: {e}", exc_info=True)
        return jsonify({'error': 'Failed to delete asset'}), 500


@app.route('/api/assets/<path:asset_id>', methods=['PUT'])
@require_admin
def update_asset(asset_id):
    """
    Admin-only asset edit.

    Supports:
    - renaming Asset ID and cascading it through all event files and containers
    - editing one asset only
    - editing all assets that originally shared the same department/brand/model type
    """
    try:
        old_asset_id = unquote_plus(asset_id)
        asset = data_manager.inventory.get(old_asset_id)

        if not asset:
            return jsonify({'error': 'Asset not found'}), 404

        data = request.get_json() or {}
        apply_to = (data.get('applyTo') or 'single').strip()

        if apply_to not in ('single', 'allSimilar'):
            return jsonify({'error': 'Invalid applyTo value'}), 400

        old_group = _asset_group_from_item(asset)

        new_asset_id = (
            data.get('id') or
            data.get('assetId') or
            data.get('newId') or
            data.get('internalId') or
            old_asset_id
        ).strip()

        if not new_asset_id:
            return jsonify({'error': 'Asset ID cannot be empty'}), 400

        if new_asset_id != old_asset_id and new_asset_id in data_manager.inventory:
            return jsonify({'error': f'Asset ID {new_asset_id} already exists'}), 409

        new_group = {
            'department': (data.get('department', old_group['department']) or '').strip().upper(),
            'brand': (data.get('brand', old_group['brand']) or '').strip(),
            'model': (data.get('model', old_group['model']) or '').strip(),
            'description': (data.get('description', old_group['description']) or '').strip()
        }

        if not new_group['brand']:
            return jsonify({'error': 'Brand is required'}), 400

        if not new_group['model']:
            return jsonify({'error': 'Model is required'}), 400

        if not new_group['department']:
            return jsonify({'error': 'Department is required'}), 400

        group_changed = new_group != old_group

        # Which inventory rows should receive the shared model-type change?
        if apply_to == 'allSimilar':
            target_assets = [
                item for item in data_manager.inventory.values()
                if _asset_matches_group(item, old_group)
            ]
        else:
            target_assets = [asset]

        audit_timestamp = _asset_audit_timestamp()
        audit_user = _asset_audit_user()
        audit_before = [
            (target, _asset_audit_snapshot(target))
            for target in target_assets
        ]

        # For single-asset model-type edits, remember event references
        # BEFORE changing the inventory object. Assigned/prepared events move
        # only the referenced quantity. Model-only rows with no physical assets
        # assigned yet can safely move as a whole planning row.
        #
        # This lets old prepared/returned events follow the edited asset,
        # similar to how an Asset ID rename already follows the same asset.
        single_asset_event_quantities_to_rewrite = {}
        unassigned_model_event_ids_to_rewrite = set()

        if apply_to == 'single' and group_changed:
            for event in data_manager.events.values():
                referenced_quantity = _event_asset_reference_quantity(event, old_asset_id)

                if referenced_quantity > 0:
                    single_asset_event_quantities_to_rewrite[event.event_id] = referenced_quantity
                    continue

                if (
                    _event_has_model_group_reference(event, old_group)
                    and not _event_has_specific_group_asset_reference(event, old_group)
                ):
                    unassigned_model_event_ids_to_rewrite.add(event.event_id)

        # Apply shared fields.
        # These are safe to apply to all same-type assets when admin chooses "all".
        for target in target_assets:
            target.department_code = new_group['department']
            target.brand = new_group['brand']
            target.model_number = new_group['model']
            target.description = new_group['description']

        # Apply unique fields only to the selected asset.
        if 'serial' in data:
            asset.serial_number = (data.get('serial') or '').strip()

        if 'serial2' in data or 'secondarySerial' in data:
            asset.secondary_serial_number = (
                data.get('serial2', data.get('secondarySerial', '')) or ''
            ).strip()

        if 'defaultLocation' in data:
            asset.default_location = (data.get('defaultLocation') or '').strip()

        if 'currentLocation' in data:
            asset.current_location = (data.get('currentLocation') or '').strip()

        if 'dateOfPurchase' in data or 'purchaseDate' in data:
            asset.date_of_purchase = _normalise_asset_purchase_date(
                data.get('dateOfPurchase', data.get('purchaseDate', ''))
            )

        if 'notes' in data:
            asset.notes = str(data.get('notes', '') or '').strip()

        if 'isMissing' in data:
            asset.is_missing = bool(data.get('isMissing'))

        if 'isOOC' in data:
            asset.is_ooc = bool(data.get('isOOC'))

        if 'isDegraded' in data:
            asset.is_degraded = bool(data.get('isDegraded'))

        if 'isDisposed' in data or 'isDecommissioned' in data:
            asset.is_disposed = bool(data.get('isDisposed') or data.get('isDecommissioned'))

        _normalise_asset_status_flags(asset)

        if _is_bulk_asset(asset) and 'quantity' in data:
            asset.quantity = max(1, _safe_int(data.get('quantity'), getattr(asset, 'quantity', 1)))
            asset.serial_number = ''
            asset.secondary_serial_number = ''
            asset.maintenance_logs = []

        # Rename selected asset ID if needed.
        id_references_changed = 0
        containers_updated = 0

        if new_asset_id != old_asset_id:
            del data_manager.inventory[old_asset_id]
            asset.asset_id = new_asset_id
            data_manager.inventory[new_asset_id] = asset

            # Cascade asset ID through containers.
            for container in data_manager.containers.values():
                container_changed = _replace_asset_id_in_list(
                    container.asset_ids,
                    old_asset_id,
                    new_asset_id
                )

                if container_changed:
                    id_references_changed += container_changed
                    containers_updated += 1

            if containers_updated:
                data_manager.save_containers()

        # Cascade through every event file.
        events_updated = 0
        model_references_changed = 0

        for event in data_manager.events.values():
            event_changed = 0

            if new_asset_id != old_asset_id:
                event_changed += _replace_asset_id_in_list(
                    getattr(event, 'prepared_items', []),
                    old_asset_id,
                    new_asset_id
                )
                event_changed += _replace_bulk_asset_id_in_list(
                    getattr(event, 'prepared_items', []),
                    old_asset_id,
                    new_asset_id
                )
                event_changed += _replace_asset_id_in_list(
                    getattr(event, 'returned_items', []),
                    old_asset_id,
                    new_asset_id
                )
                event_changed += _replace_bulk_asset_id_in_list(
                    getattr(event, 'returned_items', []),
                    old_asset_id,
                    new_asset_id
                )
                event_changed += _replace_asset_id_in_list(
                    getattr(event, 'actually_prepared', []),
                    old_asset_id,
                    new_asset_id
                )
                event_changed += _replace_bulk_asset_id_in_list(
                    getattr(event, 'actually_prepared', []),
                    old_asset_id,
                    new_asset_id
                )
                event_changed += _replace_asset_id_in_list(
                    getattr(event, 'extra_assets', []),
                    old_asset_id,
                    new_asset_id
                )
                event_changed += _replace_bulk_asset_id_in_list(
                    getattr(event, 'extra_assets', []),
                    old_asset_id,
                    new_asset_id
                )

            # Rewrite model requirement rows when model-type fields change.
            #
            # allSimilar:
            #   Rewrite the whole old model type everywhere.
            #
            # single:
            #   Rewrite the referenced quantity in events where this exact
            #   asset was previously assigned/prepared/returned. If a matching
            #   model row exists but no physical assets are assigned yet, move
            #   that whole planning row so unstarted events stay current too.
            if group_changed:
                if apply_to == 'allSimilar':
                    model_changes = _update_event_model_group_references(
                        event,
                        old_group,
                        new_group
                    )
                elif event.event_id in single_asset_event_quantities_to_rewrite:
                    model_changes = _update_single_asset_event_model_references(
                        event,
                        old_group,
                        new_group,
                        single_asset_event_quantities_to_rewrite[event.event_id]
                    )
                elif event.event_id in unassigned_model_event_ids_to_rewrite:
                    model_changes = _update_event_model_group_references(
                        event,
                        old_group,
                        new_group
                    )
                else:
                    model_changes = 0

                event_changed += model_changes
                model_references_changed += model_changes

            if event_changed:
                id_references_changed += event_changed
                update_event_state(event)
                data_manager.save_event(event)
                events_updated += 1

        audit_updates = 0
        for target, before_snapshot in audit_before:
            changes = _asset_audit_changes(before_snapshot, _asset_audit_snapshot(target))
            if _append_asset_change_history(
                target,
                changes,
                timestamp=audit_timestamp,
                user=audit_user,
                action='updated'
            ):
                audit_updates += 1

        data_manager.save_inventory(drop_asset_ids=[old_asset_id] if new_asset_id != old_asset_id else None)

        # Auto-register the new/edited department so filters and badges can use it immediately.
        departments = _load_departments()
        dept_code = _normalise_department_code(new_group['department']) or 'UN'
        if dept_code not in departments:
            departments[dept_code] = _department_record(dept_code)
            _save_departments(departments)

        invalidate_cache()

        log_action(
            f"Updated asset {old_asset_id}"
            f"{' -> ' + new_asset_id if new_asset_id != old_asset_id else ''}; "
            f"applyTo={apply_to}; updatedAssets={len(target_assets)}; "
            f"eventsUpdated={events_updated}; containersUpdated={containers_updated}"
        )

        return jsonify({
            'success': True,
            'message': 'Asset updated successfully',
            'data': {
                'assetId': new_asset_id,
                'updatedAssets': len(target_assets),
                'eventsUpdated': events_updated,
                'containersUpdated': containers_updated,
                'idReferencesChanged': id_references_changed,
                'modelReferencesChanged': model_references_changed,
                'auditUpdates': audit_updates
            }
        })

    except Exception as e:
        logger.error(f"Error updating asset {asset_id}: {e}", exc_info=True)
        return jsonify({'error': 'Failed to update asset'}), 500
    
def _maintenance_date_from_request(data, *keys):
    for key in keys:
        raw_date = (data or {}).get(key)
        if not raw_date:
            continue
        try:
            return datetime.strptime(raw_date, '%Y-%m-%d').strftime("%Y/%m/%d")
        except ValueError:
            logger.warning(f"Invalid maintenance date format: {raw_date}, using current date")
            return datetime.now().strftime("%Y/%m/%d")
    return datetime.now().strftime("%Y/%m/%d")


def _bulk_maintenance_quantity_from_request(data):
    for key in ('affectedQuantity', 'bulkAffectedQuantity', 'quantity', 'bulkQuantity', 'affectedQty'):
        if key in (data or {}):
            quantity = _safe_int(data.get(key), 0)
            if quantity > 0:
                return quantity
    return 1


def _bulk_asset_fault_capacity_remaining(asset):
    total = max(1, _safe_int(getattr(asset, 'quantity', 1), 1))
    open_fault_quantity = _bulk_maintenance_quantity_counts(asset)['total']
    return max(total - open_fault_quantity, 0)


def _maintenance_client_request_id(data):
    for key in ('requestId', 'clientRequestId', 'submissionId'):
        value = str((data or {}).get(key) or '').strip()
        if value:
            return value[:160]
    return ''


def _maintenance_request_was_applied(asset, request_id):
    if not request_id:
        return False
    for log_entry in getattr(asset, 'maintenance_logs', []) or []:
        source = normalize_maintenance_log(log_entry).get('source') or {}
        if source.get('clientRequestId') == request_id:
            return True
    return False


def _maintain_bulk_asset(asset_id, asset, data):
    if getattr(asset, 'is_missing', False) or _is_disposed(asset):
        return jsonify({'error': 'Bulk asset is missing or decommissioned'}), 400

    log_entry_text = (data.get('logEntry') or '').strip()
    if not log_entry_text:
        return jsonify({'error': 'Log entry is required'}), 400
    request_id = _maintenance_client_request_id(data)
    if _maintenance_request_was_applied(asset, request_id):
        return jsonify({
            'success': True,
            'duplicate': True,
            'message': 'This maintenance submission was already saved'
        })

    target_status, requested_status_changes, status_error = _status_changes_for_request(
        data,
        current_status=_asset_condition_status(asset)
    )
    if status_error:
        return jsonify({'error': status_error}), 400

    if target_status == 'decommissioned':
        return jsonify({
            'error': 'Bulk maintenance logs cannot decommission a whole bulk item. Edit the asset status to decommission it.'
        }), 400

    if target_status == 'ok':
        if _bulk_maintenance_quantity_counts(asset)['total'] > 0:
            return jsonify({
                'error': 'Resolve a specific bulk maintenance log from the logbook to restore that unit.'
            }), 400

        new_serial = (data.get('newSerial') or '').strip()
        if new_serial:
            return jsonify({'error': 'Bulk quantity assets do not have individual serial numbers'}), 400

        new_location = (data.get('newLocation') or '').strip()
        repair_cost = str(data.get('cost') or data.get('maintenanceCost') or '').strip()
        log_type, log_type_error = _maintenance_log_type_for_request(data)
        if log_type_error:
            return jsonify({'error': log_type_error}), 400

        formatted_date = _maintenance_date_from_request(data, 'maintenanceDate')
        changes = []
        if new_location:
            changes.append(make_change('location', value=new_location))
        changes.extend(requested_status_changes)

        entry = make_maintenance_log(
            formatted_date,
            session['user'],
            log_entry_text,
            [change for change in changes if change],
            cost=repair_cost,
            log_type=log_type,
            source={'clientRequestId': request_id} if request_id else None
        )

        try:
            media_records = _save_maintenance_media_files(entry, _uploaded_maintenance_media_files())
        except ValueError as e:
            return jsonify({'error': str(e)}), 400
        if media_records:
            entry['media'] = media_records

        asset.maintenance_logs.append(entry)
        apply_maintenance_log_changes(asset, entry)

        data_manager.save_inventory()
        invalidate_cache()
        log_action(f"Cleared bulk asset status for asset {asset_id}: {log_entry_text}")

        return jsonify({'success': True, 'message': 'Bulk asset status cleared successfully'})

    if not target_status:
        return jsonify({'error': 'Asset status is required for bulk maintenance logs'}), 400

    if target_status and target_status not in BULK_MAINTENANCE_STATUSES:
        return jsonify({'error': 'Invalid bulk maintenance status'}), 400

    new_serial = (data.get('newSerial') or '').strip()
    if new_serial:
        return jsonify({'error': 'Bulk quantity assets do not have individual serial numbers'}), 400

    affected_quantity = _bulk_maintenance_quantity_from_request(data)
    capacity_remaining = _bulk_asset_fault_capacity_remaining(asset)
    if affected_quantity > capacity_remaining:
        return jsonify({
            'error': f'Only {capacity_remaining} unit{" is" if capacity_remaining == 1 else "s are"} available for new bulk maintenance logs'
        }), 400

    log_type, log_type_error = _maintenance_log_type_for_request(data, default_type='Fault')
    if log_type_error:
        return jsonify({'error': log_type_error}), 400

    formatted_date = _maintenance_date_from_request(data, 'maintenanceDate')
    uploaded_files = _uploaded_maintenance_media_files()
    first_log_number = _next_bulk_maintenance_log_number(asset)
    created_entries = []
    try:
        for offset in range(affected_quantity):
            source = {
                'kind': BULK_MAINTENANCE_FAULT_SOURCE,
                'bulkLogNumber': str(first_log_number + offset),
                'bulkStatus': target_status,
                'bulkQuantity': '1',
            }
            if request_id:
                source['clientRequestId'] = request_id
            entry = make_maintenance_log(
                formatted_date,
                session['user'],
                log_entry_text,
                [],
                cost='',
                log_type=log_type,
                source=source
            )
            media_records = _save_maintenance_media_files(entry, uploaded_files)
            if media_records:
                entry['media'] = media_records
            created_entries.append(entry)
    except ValueError as e:
        for entry in created_entries:
            _delete_maintenance_media_files(entry)
        return jsonify({'error': str(e)}), 400

    asset.maintenance_logs.extend(created_entries)

    data_manager.save_inventory()
    invalidate_cache()

    log_action(
        f"Logged {affected_quantity} bulk maintenance {target_status.upper()} "
        f"unit{'s' if affected_quantity != 1 else ''} for asset {asset_id}: {log_entry_text}"
    )

    return jsonify({
        'success': True,
        'message': 'Bulk maintenance logged successfully',
        'data': {
            'createdCount': affected_quantity,
            'assetId': asset_id,
        }
    })


def _apply_standard_maintenance_request(asset_id, asset, data, uploaded_files=None):
    """Validate and apply one standard-asset maintenance entry without saving the CSV."""
    request_id = _maintenance_client_request_id(data)
    if _maintenance_request_was_applied(asset, request_id):
        return {
            'success': True,
            'duplicate': True,
            'assetId': asset_id,
            'message': 'This maintenance submission was already saved'
        }, 200, False

    log_entry_text = str(data.get('logEntry') or '').strip()
    if not log_entry_text:
        return {'error': 'Log entry is required'}, 400, False

    new_location = str(data.get('newLocation') or '').strip() or None
    new_serial = str(data.get('newSerial') or '').strip() or None
    target_status, requested_status_changes, status_error = _status_changes_for_request(
        data,
        current_status=_asset_condition_status(asset)
    )
    if status_error:
        return {'error': status_error}, 400, False

    transition_error = _validate_status_transition(asset, target_status)
    if transition_error:
        return {'error': transition_error}, 400, False

    repair_cost = str(data.get('cost') or data.get('maintenanceCost') or '').strip()
    log_type, log_type_error = _maintenance_log_type_for_request(data)
    if log_type_error:
        return {'error': log_type_error}, 400, False

    status_changes = []
    if new_location:
        status_changes.append(make_change('location', value=new_location))
    if new_serial:
        status_changes.append(make_change('serial', value=new_serial))
    status_changes.extend(requested_status_changes)

    entry = make_maintenance_log(
        _maintenance_date_from_request(data, 'maintenanceDate'),
        session['user'],
        log_entry_text,
        [change for change in status_changes if change],
        cost=repair_cost,
        log_type=log_type,
        source={'clientRequestId': request_id} if request_id else None
    )

    try:
        media_records = _save_maintenance_media_files(
            entry,
            uploaded_files if uploaded_files is not None else _uploaded_maintenance_media_files()
        )
    except ValueError as exc:
        return {'error': str(exc)}, 400, False
    if media_records:
        entry['media'] = media_records

    asset.maintenance_logs.append(entry)
    apply_maintenance_log_changes(asset, entry)
    return {
        'success': True,
        'assetId': asset_id,
        'message': 'Maintenance logged successfully',
        'maintenanceLog': _maintenance_log_for_response(entry)
    }, 200, True


def _maintenance_asset_ids_from_request(data):
    raw_ids = (data or {}).get('assetIds')
    if isinstance(raw_ids, list):
        values = raw_ids
    else:
        try:
            decoded = json.loads(str(raw_ids or '[]'))
            values = decoded if isinstance(decoded, list) else []
        except (TypeError, ValueError):
            values = []

    unique_ids = []
    seen = set()
    for value in values:
        asset_id = unquote_plus(str(value or '')).strip()
        if asset_id and asset_id not in seen:
            seen.add(asset_id)
            unique_ids.append(asset_id)
    return unique_ids


@app.route('/api/assets/maintenance/batch', methods=['POST'])
@require_auth
@with_inventory_action_lock
def maintain_assets_batch():
    """Add one maintenance entry to several standard assets with a single inventory save."""
    try:
        data = _maintenance_request_payload()
        asset_ids = _maintenance_asset_ids_from_request(data)
        if not asset_ids:
            return jsonify({'error': 'Select at least one asset'}), 400

        uploaded_files = _uploaded_maintenance_media_files()
        successes = []
        errors = []
        changed_count = 0

        for requested_id in asset_ids:
            scanned_asset = _find_inventory_asset_by_identifier(requested_id)
            asset_id = scanned_asset.asset_id if scanned_asset else requested_id
            asset = data_manager.inventory.get(asset_id)
            if not asset:
                errors.append({'assetId': requested_id, 'error': 'Asset not found'})
                continue
            if _is_bulk_asset(asset):
                errors.append({
                    'assetId': asset_id,
                    'error': 'Bulk assets must be logged separately'
                })
                continue

            result, status_code, changed = _apply_standard_maintenance_request(
                asset_id,
                asset,
                data,
                uploaded_files=uploaded_files
            )
            if status_code >= 400:
                errors.append({'assetId': asset_id, 'error': result.get('error', 'Failed to log maintenance')})
                continue
            successes.append({
                'assetId': asset_id,
                'duplicate': bool(result.get('duplicate'))
            })
            if changed:
                changed_count += 1

        if changed_count:
            data_manager.save_inventory()
            invalidate_cache()
            log_action(
                f"Maintenance logged for {changed_count} asset"
                f"{'s' if changed_count != 1 else ''}: {str(data.get('logEntry') or '').strip()}"
            )

        response = {
            'success': bool(successes),
            'successCount': len(successes),
            'savedCount': changed_count,
            'duplicateCount': sum(1 for item in successes if item['duplicate']),
            'errorCount': len(errors),
            'results': successes,
            'errors': errors,
        }
        if not successes:
            response['error'] = errors[0]['error'] if errors else 'Failed to log maintenance'
            return jsonify(response), 400
        return jsonify(response)
    except Exception as exc:
        logger.error("Error logging batch maintenance: %s", exc, exc_info=True)
        return jsonify({'error': f'Failed to log maintenance: {str(exc)}'}), 500


@app.route('/api/assets/<asset_id>/maintain', methods=['POST'])
@require_auth
@with_inventory_action_lock
def maintain_asset(asset_id):
    """Add maintenance log to an asset"""
    try:
        logger.info(f"Received maintenance request for asset: '{asset_id}'")
        
        asset_id = unquote_plus(asset_id)
        logger.info(f"Decoded asset ID: '{asset_id}'")

        scanned_asset = _find_inventory_asset_by_identifier(asset_id)
        if scanned_asset:
            asset_id = scanned_asset.asset_id
        
        asset = data_manager.inventory.get(asset_id)
        if not asset:
            logger.error(f"Asset not found: '{asset_id}'. Available assets: {list(data_manager.inventory.keys())[:10]}")
            return jsonify({'error': 'Asset not found'}), 404

        data = _maintenance_request_payload()
        logger.info(f"Received data: {data}")
        
        if not data:
            return jsonify({'error': 'No data provided'}), 400

        if _is_bulk_asset(asset):
            return _maintain_bulk_asset(asset_id, asset, data)

        result, status_code, changed = _apply_standard_maintenance_request(asset_id, asset, data)
        if status_code >= 400 or not changed:
            return jsonify(result), status_code

        data_manager.save_inventory()
        invalidate_cache()
        target_status, _, _ = _status_changes_for_request(
            data,
            current_status=None
        )
        if target_status:
            log_action(f"Set asset {asset_id} status to {_status_action_label(target_status)}")
        log_action(f"Maintenance logged for asset {asset_id}: {str(data.get('logEntry') or '').strip()}")
        logger.info("Successfully logged maintenance for asset %s", asset_id)
        return jsonify(result), status_code
        
    except Exception as e:
        logger.error(f"Error maintaining asset {asset_id}: {e}")
        import traceback
        logger.error(f"Traceback: {traceback.format_exc()}")
        return jsonify({'error': f'Failed to log maintenance: {str(e)}'}), 500


@app.route('/api/assets/<asset_id>/bulk-maintenance/<fault_log_id>', methods=['PUT'])
@require_auth
def update_bulk_maintenance_fault_log(asset_id, fault_log_id):
    """Update the fault report for one quantity-level bulk maintenance entry."""
    try:
        asset_id = unquote_plus(asset_id)
        fault_log_id = unquote_plus(fault_log_id).strip()

        asset = data_manager.inventory.get(asset_id)
        if not asset:
            return jsonify({'error': 'Asset not found'}), 404
        if not _is_bulk_asset(asset):
            return jsonify({'error': 'Asset is not a bulk quantity asset'}), 400

        fault_entry = None
        for entry in _bulk_maintenance_fault_entries(asset):
            if entry.get('key') == fault_log_id or entry.get('id') == fault_log_id:
                fault_entry = entry
                break

        if not fault_entry:
            return jsonify({'error': 'Bulk maintenance log not found'}), 404

        log_index = fault_entry.get('index')
        if log_index is None or log_index < 0 or log_index >= len(getattr(asset, 'maintenance_logs', []) or []):
            return jsonify({'error': 'Invalid bulk maintenance log'}), 400

        allowed, permission_error = _maintenance_log_permission(asset, log_index, allow_admin=True)
        if not allowed:
            return jsonify({'error': permission_error}), 403

        data = _maintenance_request_payload()
        if not data:
            return jsonify({'error': 'No data provided'}), 400

        log_entry_text = (data.get('logEntry') or data.get('description') or '').strip()
        if not log_entry_text:
            return jsonify({'error': 'Maintenance log entry is required'}), 400

        target_status, _, status_error = _status_changes_for_request(
            data,
            current_status=fault_entry.get('status') or 'ok'
        )
        if status_error:
            return jsonify({'error': status_error}), 400
        if target_status == 'ok' or not target_status:
            return jsonify({'error': 'Asset status is required for bulk maintenance logs'}), 400
        if target_status not in BULK_MAINTENANCE_STATUSES:
            return jsonify({'error': 'Invalid bulk maintenance status'}), 400

        raw_date = data.get('maintenanceDate') or data.get('date')
        if not raw_date:
            return jsonify({'error': 'Maintenance date is required'}), 400
        try:
            parsed_date = datetime.strptime(raw_date, '%Y-%m-%d')
        except ValueError:
            return jsonify({'error': 'Invalid date format'}), 400
        if not _current_user_is_admin():
            age_days = (datetime.now().date() - parsed_date.date()).days
            if age_days < 0 or age_days > 7:
                return jsonify({'error': 'Normal users can only set maintenance log dates within the last 7 days'}), 403

        original_log = normalize_maintenance_log(asset.maintenance_logs[log_index])
        source = dict(original_log.get('source') or {})
        source.update({
            'kind': BULK_MAINTENANCE_FAULT_SOURCE,
            'bulkStatus': target_status,
            'bulkQuantity': str(max(1, _safe_int(source.get('bulkQuantity'), fault_entry.get('quantity') or 1))),
            'bulkLogNumber': str(fault_entry.get('logNumber') or source.get('bulkLogNumber') or ''),
        })

        updated_log = make_maintenance_log(
            parsed_date.strftime("%Y/%m/%d"),
            original_log.get('user') or session.get('user', ''),
            log_entry_text,
            [],
            cost=original_log.get('cost') or '',
            log_type=original_log.get('type') or 'Fault',
            source=source,
            log_id=original_log.get('id') or None,
            media=original_log.get('media') or []
        )

        try:
            new_media_records = _save_maintenance_media_files(updated_log, _uploaded_maintenance_media_files())
        except ValueError as e:
            return jsonify({'error': str(e)}), 400
        if new_media_records:
            updated_log['media'] = (updated_log.get('media') or []) + new_media_records

        asset.maintenance_logs[log_index] = updated_log

        data_manager.save_inventory()
        invalidate_cache()
        log_action(
            f"Updated bulk maintenance log #{fault_entry.get('logNumber')} "
            f"for asset {asset_id}: {log_entry_text}"
        )

        return jsonify({'success': True, 'message': 'Bulk maintenance log updated successfully'})

    except Exception as e:
        logger.error(f"Error updating bulk maintenance log for {asset_id}: {e}", exc_info=True)
        return jsonify({'error': f'Failed to update bulk maintenance log: {str(e)}'}), 500


@app.route('/api/assets/<asset_id>/bulk-maintenance/<fault_log_id>/resolve', methods=['POST'])
@require_auth
def resolve_bulk_maintenance_log(asset_id, fault_log_id):
    """Resolve one open quantity-level maintenance entry for a bulk asset."""
    try:
        asset_id = unquote_plus(asset_id)
        fault_log_id = unquote_plus(fault_log_id).strip()

        asset = data_manager.inventory.get(asset_id)
        if not asset:
            return jsonify({'error': 'Asset not found'}), 404
        if not _is_bulk_asset(asset):
            return jsonify({'error': 'Asset is not a bulk quantity asset'}), 400

        fault_entry = None
        for entry in _bulk_maintenance_fault_entries(asset):
            if entry.get('key') == fault_log_id or entry.get('id') == fault_log_id:
                fault_entry = entry
                break

        if not fault_entry:
            return jsonify({'error': 'Bulk maintenance log not found'}), 404
        if fault_entry.get('resolution'):
            return jsonify({'error': 'Bulk maintenance log is already resolved'}), 400

        data = _maintenance_request_payload()
        if not data:
            return jsonify({'error': 'No data provided'}), 400

        log_entry_text = (data.get('logEntry') or data.get('description') or '').strip()
        if not log_entry_text:
            return jsonify({'error': 'Resolution report is required'}), 400

        new_location = (data.get('newLocation') or '').strip()
        new_serial = (data.get('newSerial') or '').strip()
        if new_serial:
            return jsonify({'error': 'Bulk quantity assets do not have individual serial numbers'}), 400

        repair_cost = str(data.get('cost') or data.get('maintenanceCost') or '0.00').strip() or '0.00'
        log_type, log_type_error = _maintenance_log_type_for_request(data, default_type='Repair')
        if log_type_error:
            return jsonify({'error': log_type_error}), 400

        formatted_date = _maintenance_date_from_request(data, 'maintenanceDate', 'date')
        changes = []
        if new_location:
            changes.append(make_change('location', value=new_location))

        source = {
            'kind': BULK_MAINTENANCE_RESOLUTION_SOURCE,
            'bulkResolves': fault_entry.get('key') or fault_entry.get('id') or '',
            'bulkLogNumber': str(fault_entry.get('logNumber') or ''),
            'bulkStatus': fault_entry.get('status') or '',
            'bulkQuantity': str(fault_entry.get('quantity') or 1),
        }
        if fault_entry.get('id'):
            source['bulkFaultLogId'] = fault_entry['id']

        entry = make_maintenance_log(
            formatted_date,
            session['user'],
            log_entry_text,
            [change for change in changes if change],
            cost=repair_cost,
            log_type=log_type,
            source=source
        )

        try:
            media_records = _save_maintenance_media_files(entry, _uploaded_maintenance_media_files())
        except ValueError as e:
            return jsonify({'error': str(e)}), 400
        if media_records:
            entry['media'] = media_records

        asset.maintenance_logs.append(entry)
        apply_maintenance_log_changes(asset, entry)

        data_manager.save_inventory()
        invalidate_cache()
        log_action(
            f"Resolved bulk maintenance log #{fault_entry.get('logNumber')} for asset {asset_id}: {log_entry_text}"
        )

        return jsonify({'success': True, 'message': 'Bulk maintenance log resolved successfully'})

    except Exception as e:
        logger.error(f"Error resolving bulk maintenance log for {asset_id}: {e}", exc_info=True)
        return jsonify({'error': f'Failed to resolve bulk maintenance log: {str(e)}'}), 500

@app.route('/api/assets/<asset_id>/event-history', methods=['GET'])
@require_auth
def get_asset_event_history(asset_id):
    """Return events/dry hires where this asset was ACTUALLY out (prepared and/or returned)."""
    try:
        asset_id = unquote_plus(asset_id).strip()

        if asset_id not in data_manager.inventory:
            return jsonify({'error': 'Asset not found'}), 404

        if _is_bulk_asset(data_manager.inventory[asset_id]):
            return jsonify({'error': 'Bulk quantity assets do not have individual event history'}), 400

        def safe_fmt(d):
            try:
                return format_date_output(d)
            except Exception:
                return d or ''

        history = []

        for event in data_manager.events.values():
            # Ensure lists exist (backward compatibility)
            ap = getattr(event, 'actually_prepared', []) or []
            ri = getattr(event, 'returned_items', []) or []

            # Normalize (strip) in case older data has whitespace
            ap_set = {str(x).strip() for x in ap}
            ri_set = {str(x).strip() for x in ri}

            # ✅ "Ever went out" = currently out OR returned
            ever_out_set = ap_set | ri_set

            if asset_id in ever_out_set:
                raw_start = getattr(event, 'start_date', '') or ''
                raw_end = getattr(event, 'end_date', raw_start) or raw_start

                history.append({
                    'id': event.event_id,
                    'name': event.name,
                    'location': getattr(event, 'location', '') or '',
                    'startDate': safe_fmt(raw_start),
                    'endDate': safe_fmt(raw_end),
                    'state': normalize_event_state(getattr(event, 'state', 'New')),
                    'tag': getattr(event, 'tag', 'events'),
                    'returned': asset_id in ri_set,
                    '_sortEnd': raw_end,
                    '_sortStart': raw_start
                })

        history.sort(
            key=lambda x: (x.get('_sortEnd', ''), x.get('_sortStart', ''), x.get('id', 0)),
            reverse=True
        )
        for h in history:
            h.pop('_sortEnd', None)
            h.pop('_sortStart', None)

        return jsonify({'success': True, 'data': history})

    except Exception as e:
        logger.error(f"Error getting event history for asset {asset_id}: {e}")
        return jsonify({'error': 'Failed to retrieve asset event history'}), 500

@app.route('/api/assets/<asset_id>/maintenance-log-enhanced/<int:log_index>', methods=['PUT'])
@require_auth
def update_maintenance_log_enhanced(asset_id, log_index):
    """Update a maintenance log entry with enhanced options"""
    try:
        logger.info(f"Received enhanced maintenance log update request for asset: '{asset_id}', log index: {log_index}")
        
        asset_id = unquote_plus(asset_id)
        
        asset = data_manager.inventory.get(asset_id)
        if not asset:
            return jsonify({'error': 'Asset not found'}), 404

        data = _maintenance_request_payload()
        if not data:
            return jsonify({'error': 'No data provided'}), 400
        
        logger.info(f"Enhanced update data: {data}")
        
        # Validate required fields
        new_date = data.get('date')
        new_user = data.get('user')
        new_description = data.get('description')
        repair_cost = str(data.get('cost') or data.get('maintenanceCost') or '').strip()
        
        if not all([new_date, new_user, new_description]):
            return jsonify({'error': 'Date, user, and description are required'}), 400
        
        new_description = new_description.strip()
        new_user = new_user.strip()
        
        # Check if log index is valid
        if not asset.maintenance_logs or log_index < 0 or log_index >= len(asset.maintenance_logs):
            return jsonify({'error': 'Invalid log index'}), 400
        
        # Normal users may only edit logs they wrote within 7 days.
        allowed, permission_error = _maintenance_log_permission(asset, log_index, allow_admin=True)
        if not allowed:
            return jsonify({'error': permission_error}), 403

        if not _current_user_is_admin():
            # Do not let normal users reassign authorship.
            new_user = session.get('user', '').strip()

        # Convert date format from YYYY-MM-DD to YYYY/MM/DD
        try:
            parsed_date = datetime.strptime(new_date, '%Y-%m-%d')
            formatted_date = parsed_date.strftime("%Y/%m/%d")
        except ValueError:
            return jsonify({'error': 'Invalid date format'}), 400

        if not _current_user_is_admin():
            # The edited date must also remain inside the same 7-day window.
            age_days = (datetime.now().date() - parsed_date.date()).days
            if age_days < 0 or age_days > 7:
                return jsonify({'error': 'Normal users can only set maintenance log dates within the last 7 days'}), 403
        
        # Get original log for logging purposes
        original_log = normalize_maintenance_log(asset.maintenance_logs[log_index])
        original_description = original_log.get('description', '')
        original_log_type = original_log.get('type') or DEFAULT_MAINTENANCE_LOG_TYPE

        if original_log_type == ASSET_CHECK_LOG_TYPE:
            # Keep automatic Asset Check records in their system-only category.
            log_type = ASSET_CHECK_LOG_TYPE
        else:
            log_type, log_type_error = _maintenance_log_type_for_request(data, default_type=original_log_type)
            if log_type_error:
                return jsonify({'error': log_type_error}), 400
        
        # Handle additional updates - INITIALIZE changes_made HERE
        changes_made = []
        
        # Handle location changes - preserve original log's location if not explicitly changed
        new_location = data.get('newLocation')

        # First, check what location change was originally in this specific log
        original_log_location_change = None
        original_log_serial_change = None
        for change in original_log.get('changes', []):
            if change.get('kind') == 'location':
                original_log_location_change = change.get('value', '').strip()
            elif change.get('kind') == 'serial':
                original_log_serial_change = change.get('value', '').strip()

        if new_location is not None and new_location.strip():
            # Only update location if the user actually typed one
            new_location_clean = new_location.strip()
            changes_made.append(make_change('location', value=new_location_clean))
            logger.info(f"User set location to: '{new_location_clean}'")
        elif original_log_location_change is not None:
            # User didn't provide location, but original log had a location change - preserve it
            changes_made.append(make_change('location', value=original_log_location_change))
            logger.info(f"Preserved original location change: '{original_log_location_change}'")
        # If neither condition is met, no location change is added to the log

        # Update serial ONLY if provided and different
        new_serial = data.get('newSerial')
        if new_serial is not None and new_serial.strip():
            old_serial = asset.serial_number or ''
            new_serial_clean = new_serial.strip()
            if new_serial_clean != old_serial:
                asset.serial_number = new_serial_clean
                changes_made.append(make_change('serial', value=asset.serial_number))
                logger.info(f"Updated serial from '{old_serial}' to '{new_serial_clean}'")
        elif original_log_serial_change is not None:
            changes_made.append(make_change('serial', value=original_log_serial_change))
            logger.info(f"Preserved original serial change: '{original_log_serial_change}'")
        
        # Handle status changes. These now use one clean target status,
        # while still accepting the old boolean flags for backward compatibility.
        status_before_this_log = _condition_status_before_log(asset, log_index, selected_date=formatted_date)
        target_status, requested_status_changes, status_error = _status_changes_for_request(
            data,
            current_status=status_before_this_log
        )
        if status_error:
            return jsonify({'error': status_error}), 400

        transition_error = _validate_status_transition(asset, target_status, current_status=status_before_this_log)
        if transition_error:
            return jsonify({'error': transition_error}), 400

        logger.info(f"Requested target status: {target_status}; status before edited log: {status_before_this_log}")
        changes_made.extend(requested_status_changes)
            
        changes_made = [change for change in changes_made if change]
        change_labels = status_change_labels(changes_made)
        logger.info(f"Final changes made: {change_labels}")
        logger.info(f"Final asset status: OOC={asset.is_ooc}, Missing={asset.is_missing}")
        
        # Create updated log entry with structured status changes
        updated_log = make_maintenance_log(
            formatted_date,
            new_user,
            new_description,
            changes_made,
            cost=repair_cost,
            log_type=log_type,
            source=original_log.get('source') or {},
            log_id=original_log.get('id') or None,
            media=original_log.get('media') or []
        )

        try:
            new_media_records = _save_maintenance_media_files(updated_log, _uploaded_maintenance_media_files())
        except ValueError as e:
            return jsonify({'error': str(e)}), 400
        if new_media_records:
            updated_log['media'] = (updated_log.get('media') or []) + new_media_records
        
        logger.info(f"Updated log entry: {updated_log}")
        
        asset.maintenance_logs[log_index] = updated_log

        recalculate_asset_status_from_logs(asset)

        # Save changes
        data_manager.save_inventory()

        # Log the action
        changes_text = f" (also: {', '.join(change_labels)})" if change_labels else ""
        log_action(f"Updated maintenance log for asset {asset_id}: '{original_description}' -> '{new_description}'{changes_text} (edited by {session['user']})")
        
        logger.info(f"Successfully updated enhanced maintenance log for asset {asset_id}")
        return jsonify({'success': True, 'message': 'Maintenance log updated successfully'})
        
    except Exception as e:
        logger.error(f"Error updating enhanced maintenance log for asset {asset_id}: {e}")
        import traceback
        logger.error(f"Traceback: {traceback.format_exc()}")
        return jsonify({'error': f'Failed to update maintenance log: {str(e)}'}), 500

@app.route('/api/search', methods=['GET'])
@require_auth
def search_assets():
    """Search assets by keywords"""
    try:
        query = request.args.get('q', '').lower().strip()
        if not query:
            return jsonify({'success': True, 'data': []})

        keywords = query.split()
        results = []
        assigned_assets = get_assigned_assets()

        for asset in data_manager.inventory.values():
            searchable_text = (
                f"{asset.brand} {asset.model_number} {asset.description} "
                f"{asset.serial_number} {getattr(asset, 'secondary_serial_number', '')}"
            ).lower()
            if any(keyword in searchable_text for keyword in keywords):
                # Determine current status
                status = _asset_status_value(asset, assigned_assets)

                results.append({
                    'id': asset.asset_id,
                    'brand': asset.brand,
                    'model': asset.model_number,
                    'serial': asset.serial_number,
                    'serial2': getattr(asset, 'secondary_serial_number', ''),
                    'description': asset.description,
                    'department': asset.department_code,
                    'status': status,
                    'location': asset.current_location or asset.default_location,
                    'isMissing': asset.is_missing,
                    'isOOC': asset.is_ooc,
                    'isDegraded': _is_degraded(asset),
                    'isDisposed': _is_disposed(asset)
                })

        # Sort by relevance (exact matches first, then partial)
        results.sort(key=lambda x: (
            not any(keyword == x['model'].lower()
                    for keyword in keywords),  # Exact model matches first
            not any(keyword in x['brand'].lower()
                    for keyword in keywords),  # Brand matches second
            x['id']  # Then by asset ID
        ))

        return jsonify({'success': True, 'data': results})
    except Exception as e:
        logger.error(f"Error searching assets: {e}")
        return jsonify({'error': 'Failed to search assets'}), 500

def _container_serial_number(container):
    return str(getattr(container, 'serial_number', '') or '').strip()


def _container_response(container):
    serial_number = _container_serial_number(container)
    maintenance_records = [
        _maintenance_log_for_response(log)
        for log in (getattr(container, 'maintenance_logs', []) or [])
    ]
    return {
        'id': container.container_id,
        'serialNumber': serial_number,
        'serial': serial_number,
        'assetIds': container.asset_ids,
        'assetCount': len(container.asset_ids),
        'maintenanceLogs': [
            maintenance_log_to_display_string(log, include_changes=False)
            for log in maintenance_records
        ],
        'maintenanceLogRecords': maintenance_records,
        'maintenanceLogCount': len(maintenance_records),
    }


def _request_container_serial(data):
    data = data or {}
    for key in ('serialNumber', 'serial_number', 'serial'):
        if key in data:
            return str(data.get(key) or '').strip()
    return ''


def _find_container_by_lookup(value):
    lookup = str(value or '').strip()
    if not lookup:
        return None

    container = data_manager.containers.get(lookup)
    if container:
        return container

    lookup_lower = lookup.lower()
    for item in data_manager.containers.values():
        serial_number = _container_serial_number(item)
        if serial_number and serial_number.lower() == lookup_lower:
            return item

    return None


def _container_lookup_conflict(value, exclude_container_id=None):
    lookup = str(value or '').strip()
    if not lookup:
        return None

    lookup_lower = lookup.lower()
    exclude_id = str(exclude_container_id or '')

    for container_id, container in data_manager.containers.items():
        if str(container_id) == exclude_id:
            continue

        if str(container_id).strip().lower() == lookup_lower:
            return f"container ID '{container_id}'"

        serial_number = _container_serial_number(container)
        if serial_number and serial_number.lower() == lookup_lower:
            return f"serial number on container '{container_id}'"

    return None


@app.route('/api/containers', methods=['GET', 'POST'])
@require_auth
def containers_collection():
    """List containers (GET) or create container (POST)"""
    try:
        if request.method == 'GET':
            containers_data = []
            for container in data_manager.containers.values():
                containers_data.append(_container_response(container))
            return jsonify({'success': True, 'data': containers_data})

        # POST (create)
        data = request.get_json(silent=True) or {}
        container_id = (data.get('id') or data.get('containerId') or '').strip()
        serial_number = _request_container_serial(data)
        raw_asset_ids = data.get('assetIds') if 'assetIds' in data else data.get('asset_ids')

        if not container_id:
            return jsonify({'error': 'Container id is required'}), 400

        if container_id in data_manager.containers:
            return jsonify({'error': f"Container '{container_id}' already exists"}), 409

        id_conflict = _container_lookup_conflict(container_id)
        if id_conflict:
            return jsonify({'error': f"Container ID conflicts with existing {id_conflict}"}), 409

        if serial_number:
            conflict = _container_lookup_conflict(serial_number)
            if conflict:
                return jsonify({'error': f"Container serial number conflicts with existing {conflict}"}), 409

        # normalize asset IDs (accept list OR newline/comma separated string)
        asset_ids_in = []
        if isinstance(raw_asset_ids, list):
            asset_ids_in = [str(x).strip() for x in raw_asset_ids]
        elif isinstance(raw_asset_ids, str):
            asset_ids_in = [x.strip() for x in raw_asset_ids.replace(',', '\n').splitlines()]
        elif raw_asset_ids is None:
            asset_ids_in = []
        else:
            return jsonify({'error': 'assetIds must be a list or string'}), 400

        # de-dupe (preserve order)
        cleaned = []
        seen = set()
        for aid in asset_ids_in:
            if not aid:
                continue
            if aid in seen:
                continue
            cleaned.append(aid)
            seen.add(aid)

        if not cleaned:
            return jsonify({'error': 'Container must include at least 1 asset ID'}), 400

        # validate assets exist
        missing = [aid for aid in cleaned if aid not in data_manager.inventory]
        if missing:
            preview = ", ".join(missing[:15])
            more = "" if len(missing) <= 15 else f" (+{len(missing)-15} more)"
            return jsonify({'error': f"Unknown asset IDs in container: {preview}{more}"}), 400

        new_container = Container(container_id, cleaned, serial_number)
        data_manager.containers[container_id] = new_container
        data_manager.save_containers()
        invalidate_cache()
        log_action(f"Created container {container_id} ({len(cleaned)} assets)")

        return jsonify({
            'success': True,
            'data': _container_response(new_container)
        }), 201

    except Exception as e:
        logger.error(f"Error in containers_collection: {e}")
        return jsonify({'error': 'Failed to process containers request'}), 500

@app.route('/api/containers/<path:container_id>/maintain', methods=['POST'])
@require_auth
@with_inventory_action_lock
def maintain_container(container_id):
    """Create one container history record and copy it to every current asset."""
    try:
        lookup = unquote_plus(container_id).strip()
        container = _find_container_by_lookup(lookup)
        if not container:
            return jsonify({'error': 'Container not found'}), 404

        data = _maintenance_request_payload()
        description = str(data.get('logEntry') or data.get('description') or '').strip()
        if not description:
            return jsonify({'error': 'Log entry is required'}), 400

        log_type, log_type_error = _maintenance_log_type_for_request(data)
        if log_type_error:
            return jsonify({'error': log_type_error}), 400

        current_assets = []
        seen_asset_ids = set()
        for asset_id in getattr(container, 'asset_ids', []) or []:
            asset_id = str(asset_id or '').strip()
            if asset_id and asset_id not in seen_asset_ids and asset_id in data_manager.inventory:
                seen_asset_ids.add(asset_id)
                current_assets.append(data_manager.inventory[asset_id])

        if not current_assets:
            return jsonify({'error': 'Container has no current assets to receive this maintenance log'}), 400

        request_id = _maintenance_client_request_id(data)
        if request_id:
            for existing_log in getattr(container, 'maintenance_logs', []) or []:
                existing_source = normalize_maintenance_log(existing_log).get('source') or {}
                if existing_source.get('clientRequestId') == request_id:
                    return jsonify({
                        'success': True,
                        'duplicate': True,
                        'savedCount': 0,
                        'assetCount': len(current_assets),
                        'message': 'This container maintenance submission was already saved',
                    })

        log_id = make_maintenance_log_id()
        source = {
            'kind': CONTAINER_MAINTENANCE_SOURCE,
            'containerId': container.container_id,
            'containerLogId': log_id,
            'assetCount': len(current_assets),
        }
        if request_id:
            source['clientRequestId'] = request_id

        entry = make_maintenance_log(
            _maintenance_date_from_request(data, 'maintenanceDate', 'date'),
            session['user'],
            description,
            [],
            cost=str(data.get('cost') or data.get('maintenanceCost') or '').strip(),
            log_type=log_type,
            source=source,
            log_id=log_id,
        )

        try:
            media_records = _save_maintenance_media_files(
                entry,
                _uploaded_maintenance_media_files(),
            )
        except ValueError as exc:
            return jsonify({'error': str(exc)}), 400
        if media_records:
            entry['media'] = media_records

        container.maintenance_logs.append(normalize_maintenance_log(entry))
        for asset in current_assets:
            # Each asset owns a durable copy, so later membership changes do not
            # alter its historical maintenance record.
            asset.maintenance_logs.append(normalize_maintenance_log(entry))

        data_manager.save_inventory()
        data_manager.save_containers()
        invalidate_cache()
        log_action(
            f"Maintenance logged through container {container.container_id} "
            f"for {len(current_assets)} asset{'s' if len(current_assets) != 1 else ''}: {description}"
        )

        return jsonify({
            'success': True,
            'savedCount': 1,
            'assetCount': len(current_assets),
            'containerId': container.container_id,
            'maintenanceLog': _maintenance_log_for_response(entry),
        })
    except Exception as exc:
        logger.error(
            "Error logging maintenance for container %s: %s",
            container_id,
            exc,
            exc_info=True,
        )
        return jsonify({'error': f'Failed to log container maintenance: {str(exc)}'}), 500


@app.route('/api/containers/<path:container_id>', methods=['GET', 'PUT', 'DELETE'])
@require_auth
def container_resource(container_id):
    """Get one container (GET), update (PUT), delete (DELETE)"""
    try:
        container_id = unquote_plus(container_id).strip()
        container = _find_container_by_lookup(container_id)

        if not container:
            return jsonify({'error': 'Container not found'}), 404

        container_id = container.container_id

        if request.method == 'GET':
            return jsonify({
                'success': True,
                'data': _container_response(container)
            })

        if request.method == 'PUT':
            data = request.get_json(silent=True) or {}

            # optional rename support
            requested_new_id = (data.get('newId') or data.get('new_id') or data.get('id') or '').strip()
            serial_provided = any(key in data for key in ('serialNumber', 'serial_number', 'serial'))
            serial_number = _request_container_serial(data) if serial_provided else _container_serial_number(container)

            raw_asset_ids = data.get('assetIds') if 'assetIds' in data else data.get('asset_ids')

            # normalize asset IDs only if provided; otherwise keep existing
            if raw_asset_ids is None:
                cleaned = list(container.asset_ids)
            else:
                asset_ids_in = []
                if isinstance(raw_asset_ids, list):
                    asset_ids_in = [str(x).strip() for x in raw_asset_ids]
                elif isinstance(raw_asset_ids, str):
                    asset_ids_in = [x.strip() for x in raw_asset_ids.replace(',', '\n').splitlines()]
                else:
                    return jsonify({'error': 'assetIds must be a list or string'}), 400

                cleaned = []
                seen = set()
                for aid in asset_ids_in:
                    if not aid:
                        continue
                    if aid in seen:
                        continue
                    cleaned.append(aid)
                    seen.add(aid)

            if not cleaned:
                return jsonify({'error': 'Container must include at least 1 asset ID'}), 400

            # validate assets exist
            missing = [aid for aid in cleaned if aid not in data_manager.inventory]
            if missing:
                preview = ", ".join(missing[:15])
                more = "" if len(missing) <= 15 else f" (+{len(missing)-15} more)"
                return jsonify({'error': f"Unknown asset IDs in container: {preview}{more}"}), 400

            old_id = container.container_id

            if serial_number:
                conflict = _container_lookup_conflict(serial_number, exclude_container_id=container_id)
                if conflict:
                    return jsonify({'error': f"Container serial number conflicts with existing {conflict}"}), 409

            # rename (if requested)
            if requested_new_id and requested_new_id != container_id:
                conflict = _container_lookup_conflict(requested_new_id, exclude_container_id=container_id)
                if conflict:
                    return jsonify({'error': f"Container ID conflicts with existing {conflict}"}), 409

                # re-key the dict and update object
                del data_manager.containers[container_id]
                container.container_id = requested_new_id
                data_manager.containers[requested_new_id] = container
                container_id = requested_new_id

            # update asset list
            container.asset_ids = cleaned
            container.serial_number = serial_number
            data_manager.save_containers()
            invalidate_cache()

            if old_id != container_id:
                log_action(f"Renamed container {old_id} -> {container_id} ({len(cleaned)} assets)")
            else:
                log_action(f"Updated container {container_id} ({len(cleaned)} assets)")

            return jsonify({
                'success': True,
                'data': _container_response(container)
            })

        # DELETE
        if not session.get('is_admin', False):
            return jsonify({'error': 'Admin privileges required'}), 403

        del data_manager.containers[container_id]
        data_manager.save_containers()
        invalidate_cache()
        log_action(f"Deleted container {container_id}")

        return jsonify({'success': True})

    except Exception as e:
        logger.error(f"Error in container_resource: {e}")
        return jsonify({'error': 'Failed to process container request'}), 500

@app.route('/api/logs', methods=['GET'])
@require_auth
def get_logs():
    """Get system activity logs."""
    try:
        logs_data = []
        for log in data_manager.logs:
            logs_data.append({
                'timestamp': log.timestamp,
                'user': log.user,
                'action': log.action
            })

        # Reverse to show most recent first
        logs_data.reverse()

        return jsonify({'success': True, 'data': logs_data})
    except Exception as e:
        logger.error(f"Error getting logs: {e}")
        return jsonify({'error': 'Failed to retrieve logs'}), 500

@app.route('/api/stats', methods=['GET'])
@require_auth
def get_stats():
    """Get dashboard statistics"""
    try:
        # Add validation checks
        if _current_data_manager_object() is None:
            logger.error("Data manager is not initialized")
            return jsonify({'error': 'Data manager not initialized'}), 500
            
        if not hasattr(data_manager, 'events') or data_manager.events is None:
            logger.error("Data manager events not initialized")
            return jsonify({'error': 'Events data not available'}), 500
            
        if not hasattr(data_manager, 'inventory') or data_manager.inventory is None:
            logger.error("Data manager inventory not initialized")
            return jsonify({'error': 'Inventory data not available'}), 500

        refresh_event_states_for_read()

        logger.info(f"Getting stats - Events: {len(data_manager.events)}, Inventory: {len(data_manager.inventory)}")
        
        total_events = len(data_manager.events)
        active_events = len(
            [e for e in data_manager.events.values() if e.state not in ['Closed']])
        total_assets = sum(_asset_inventory_quantity(a) for a in data_manager.inventory.values())
        
        # Add error handling for get_assigned_assets
        try:
            deployed_assets = get_deployed_asset_quantity()
            logger.info("Successfully got deployed physical asset quantity: %s", deployed_assets)
        except Exception as e:
            logger.error("Error getting deployed physical asset quantity: %s", e)
            deployed_assets = 0
            
        missing_assets = sum(
            _asset_inventory_quantity(a)
            for a in data_manager.inventory.values()
            if getattr(a, 'is_missing', False) and not _is_disposed(a)
        )
        ooc_assets = 0
        degraded_assets = 0
        decommissioned_assets = sum(
            _asset_inventory_quantity(a)
            for a in data_manager.inventory.values()
            if _is_disposed(a)
        )

        for asset in data_manager.inventory.values():
            if not asset or _is_disposed(asset):
                continue
            if _is_bulk_asset(asset):
                counts = _bulk_maintenance_quantity_counts(asset)
                if getattr(asset, 'is_ooc', False):
                    ooc_assets += _asset_inventory_quantity(asset)
                else:
                    ooc_assets += counts['ooc']
                if _is_degraded(asset):
                    degraded_assets += _asset_inventory_quantity(asset)
                else:
                    degraded_assets += counts['degraded']
                continue
            if getattr(asset, 'is_ooc', False):
                ooc_assets += 1
            if _is_degraded(asset):
                degraded_assets += 1

        stats_data = {
            'totalEvents': total_events,
            'activeEvents': active_events,
            'overdueEvents': len(
                [e for e in data_manager.events.values() if e.state == 'Overdue']
            ),
            'totalAssets': total_assets,
            'deployedAssets': deployed_assets,
            'missingAssets': missing_assets,
            'oocAssets': ooc_assets,
            'degradedAssets': degraded_assets,
            'decommissionedAssets': decommissioned_assets,
            'disposedAssets': decommissioned_assets
        }
        
        logger.info(f"Returning stats: {stats_data}")

        return jsonify({
            'success': True,
            'data': stats_data
        })
    except Exception as e:
        logger.error(f"Error getting stats: {e}")
        import traceback
        logger.error(f"Stats error traceback: {traceback.format_exc()}")
        return jsonify({'error': 'Failed to retrieve statistics'}), 500
    
@app.route('/api/events/<int:event_id>/custom-assets/update-quantity', methods=['PUT'])
@require_admin
def update_custom_asset_quantity(event_id):
    """Update the quantity of a custom asset in an event while preserving department/company metadata."""
    try:
        data = request.get_json() or {}
        old_asset_id = str(data.get('assetId') or '').strip()
        new_quantity = max(1, _safe_int(data.get('newQuantity'), 1))

        event = data_manager.events.get(event_id)
        if not event:
            return jsonify({'success': False, 'error': 'Event not found'}), 404

        _ensure_event_custom_lists(event)
        custom = _parse_custom_marker(old_asset_id)
        if not custom:
            return jsonify({'success': False, 'error': 'Unsupported custom asset format'}), 400
        if old_asset_id not in event.prepared_items:
            return jsonify({'success': False, 'error': 'Custom asset not found in event'}), 404

        new_asset_id = _make_custom_marker(
            custom['type'],
            custom['name'],
            new_quantity,
            custom.get('department') or 'UN',
            custom.get('company') or '',
            uid=custom.get('uid') or None
        )

        def replace_in_list(values):
            for i, value in enumerate(list(values)):
                if value == old_asset_id:
                    values[i] = new_asset_id

        replace_in_list(event.prepared_items)
        replace_in_list(event.actually_prepared)
        replace_in_list(event.returned_items)
        replace_in_list(event.extra_assets)
        replace_in_list(event.custom_collected)

        update_event_state(event)
        data_manager.save_event(event)
        invalidate_cache()
        log_action(f"Updated custom asset quantity: {_custom_display_name(custom)} -> {new_quantity}x for event {event_id}")

        return jsonify({
            'success': True,
            'message': 'Custom asset quantity updated',
            'oldAssetId': old_asset_id,
            'newAssetId': new_asset_id,
            'newQuantity': new_quantity
        })
    except Exception as e:
        logger.error(f"Error updating custom asset quantity: {e}", exc_info=True)
        return jsonify({'success': False, 'error': 'An unexpected error occurred'}), 500

@app.route('/api/events/<int:event_id>/custom-assets/remove', methods=['POST'])
@require_admin
def remove_custom_asset_from_event(event_id):
    """Remove a custom asset (LOAN/MISC) from an event"""
    try:
        data = request.get_json()
        asset_id = data.get('assetId', '').strip()
        
        if not asset_id:
            return jsonify({'error': 'Asset ID is required'}), 400
        
        logger.info(f"Removing custom asset '{asset_id}' from event {event_id}")
        
        event = data_manager.events.get(event_id)
        if not event:
            return jsonify({'error': 'Event not found'}), 404

        # Verify this is a custom asset
        if not _is_custom_ref(asset_id):
            return jsonify({'error': 'This endpoint is only for custom assets'}), 400

        # Check if asset is in this event
        if asset_id not in event.prepared_items:
            return jsonify({'error': 'Custom asset is not assigned to this event'}), 400

        # Remove the asset from prepared_items
        event.prepared_items.remove(asset_id)
        logger.info(f"Removed {asset_id} from prepared_items")

        # Initialize lists if they don't exist
        if not hasattr(event, 'actually_prepared'):
            event.actually_prepared = []
        if not hasattr(event, 'extra_assets'):
            event.extra_assets = []

        # Remove from actually_prepared if it was there
        if asset_id in event.actually_prepared:
            event.actually_prepared.remove(asset_id)
            logger.info(f"Removed {asset_id} from actually_prepared")

        # Remove from returned_items if it was there
        if asset_id in event.returned_items:
            event.returned_items.remove(asset_id)
            logger.info(f"Removed {asset_id} from returned_items")

        # Remove from extra_assets if it was there
        if asset_id in event.extra_assets:
            event.extra_assets.remove(asset_id)
            logger.info(f"Removed {asset_id} from extra_assets")

        # Remove from custom collected list if it was there
        if hasattr(event, 'custom_collected') and asset_id in event.custom_collected:
            event.custom_collected.remove(asset_id)
            logger.info(f"Removed {asset_id} from custom_collected")

        # Update event state
        update_event_state(event)

        # Save changes
        data_manager.save_event(event)

        # Invalidate cache
        invalidate_cache()

        log_action(f"Removed custom asset {asset_id} from event {event_id}")

        return jsonify({'success': True, 'message': f'Custom asset {asset_id} removed from event'})
        
    except Exception as e:
        logger.error(f"Error removing custom asset from event {event_id}: {e}")
        import traceback
        logger.error(f"Traceback: {traceback.format_exc()}")
        return jsonify({'error': 'Failed to remove custom asset from event'}), 500

@app.route('/api/events/update-states', methods=['POST'])
@require_auth
def update_all_event_states():
    """Manually trigger state updates for all events"""
    try:
        updated_events = []
        
        for event in data_manager.events.values():
            old_state = event.state
            update_event_state(event)
            
            if event.state != old_state:
                data_manager.save_event(event)
                updated_events.append({
                    'eventId': event.event_id,
                    'name': event.name,
                    'oldState': old_state,
                    'newState': event.state
                })
                logger.info(f"Event {event.event_id} state changed from {old_state} to {event.state}")
        
        if updated_events:
            invalidate_cache()
        
        return jsonify({
            'success': True, 
            'message': f'Updated {len(updated_events)} events',
            'updatedEvents': updated_events
        })
        
    except Exception as e:
        logger.error(f"Error updating event states: {e}")
        return jsonify({'error': 'Failed to update event states'}), 500

@app.route('/api/events/<int:event_id>/force-state', methods=['POST'])
@require_admin
def force_event_state(event_id):
    """Force an event to a specific state"""
    try:
        data = request.get_json()
        new_state = data.get('state')
        
        # Validate state
        valid_states = ['New', 'Planning', 'Preparing', 'Ready', 'Ongoing', 'Last Day', 'Returning', 'Closed', 'Overdue']
        if new_state not in valid_states:
            return jsonify({'error': f'Invalid state. Must be one of: {valid_states}'}), 400
            
        # Get the event
        event = data_manager.events.get(event_id)
        if not event:
            return jsonify({'error': 'Event not found'}), 404
            
        # Store old state for logging
        old_state = event.state
        
        # Force the new state and set override flag
        event.state = normalize_event_state(new_state)
        event.force_state_override = True
        
        # Save the event
        data_manager.save_event(event)
        
        # Log the action
        username = session.get('user', 'Unknown')
        log_action(f"User {username} forced event {event_id} ({event.name}) state from {old_state} to {new_state}")
        
        # Invalidate cache
        invalidate_cache()
        
        return jsonify({
            'success': True,
            'message': f'Event {event_id} state forced to {new_state}',
            'eventId': event_id,
            'oldState': old_state,
            'newState': new_state
        })
        
    except Exception as e:
        logger.error(f"Error forcing event state: {e}")
        import traceback
        logger.error(f"Traceback: {traceback.format_exc()}")
        return jsonify({'error': 'Failed to force event state'}), 500

@app.route('/api/events/<int:event_id>/remove-force-state', methods=['POST'])
@require_admin
def remove_force_state(event_id):
    """Remove forced state override and return to automatic state management"""
    try:
        # Get the event
        event = data_manager.events.get(event_id)
        if not event:
            return jsonify({'error': 'Event not found'}), 404
            
        # Store old state for logging
        old_state = event.state
        
        # Remove the override flag
        event.force_state_override = False
        
        # Update state automatically
        update_event_state(event)
        
        # Save the event
        data_manager.save_event(event)
        
        # Log the action
        username = session.get('user', 'Unknown')
        log_action(f"User {username} removed forced state override for event {event_id} ({event.name}): {old_state} -> {event.state}")
        
        # Invalidate cache
        invalidate_cache()
        
        return jsonify({
            'success': True,
            'message': f'Event {event_id} returned to automatic state management',
            'eventId': event_id,
            'oldState': old_state,
            'newState': event.state
        })
        
    except Exception as e:
        logger.error(f"Error removing forced state: {e}")
        import traceback
        logger.error(f"Traceback: {traceback.format_exc()}")
        return jsonify({'error': 'Failed to remove forced state'}), 500

# Error handlers


@app.errorhandler(404)
def not_found(error):
    return jsonify({'error': 'Not found'}), 404


@app.errorhandler(500)
def internal_error(error):
    logger.error(f"Internal server error: {error}")
    return jsonify({'error': 'Internal server error'}), 500


@app.errorhandler(ConcurrentDataChangeError)
def concurrent_data_change(error):
    logger.warning("Rejected stale database write: %s", error)
    return jsonify({
        'error': 'This data changed in another session. Reload and try again.'
    }), 409


@app.errorhandler(Exception)
def handle_exception(e):
    logger.error(f"Unhandled exception: {e}")
    return jsonify({'error': 'An unexpected error occurred'}), 500

def check_and_update_ongoing_events():
    """Periodically check if ready events should become ongoing or overdue"""
    try:
        if _current_data_manager_object() is None:
            logger.warning("data_manager is None, cannot check events")
            return
            
        if not hasattr(data_manager, 'events') or data_manager.events is None:
            logger.warning("data_manager.events is None or missing, cannot check events")
            return
            
        current_date = datetime.now().strftime('%Y%m%d')
        updated_count = 0
        
        logger.info(f"Checking {len(data_manager.events)} events for state updates (current date: {current_date})")
        
        for event in data_manager.events.values():
            old_state = event.state
            
            update_event_state(event)
            
            if event.state != old_state:
                data_manager.save_event(event)
                updated_count += 1

        
        if updated_count > 0:
            invalidate_cache()
            logger.info(f"Updated {updated_count} events (ongoing/overdue status)")
        else:
            logger.info("No events required state updates")
            
    except Exception as e:
        logger.error(f"Error checking ongoing/overdue events: {e}")
        import traceback
        logger.error(f"Traceback: {traceback.format_exc()}")

def _client_to_dict(c):
    def get(attribute, default=''):
        snake_case_attribute = attribute.replace('postalCode', 'postal_code')
        return getattr(c, attribute, getattr(c, snake_case_attribute, default))

    return {
        'name': get('name'),
        'company': get('company'),
        'address1': get('address1'),
        'address2': get('address2'),
        'address3': get('address3'),
        'postalCode': getattr(c, 'postal_code', getattr(c, 'postalCode', '')),
        'phone': get('phone'),
    }


@app.route('/api/clients', methods=['GET', 'POST'])
@require_auth
def clients_collection():
    if request.method == 'GET':
        query = (request.args.get('query') or '').strip().lower()
        data = []
        for c in data_manager.clients.values():
            name = (getattr(c, 'name', '') or '').strip().lower()
            company = (getattr(c, 'company', '') or '').strip().lower()
            if not query or (query in name) or (query in company):
                data.append(_client_to_dict(c))
        return jsonify({'success': True, 'data': data})


    # POST (create or upsert)
    data = request.get_json(force=True) or {}
    name = (data.get('name') or '').strip()
    if not name:
        return jsonify({'success': False, 'message': 'Client name is required'}), 400

    c = Client(
        name=name,
        company=(data.get('company') or '').strip(),
        address1=(data.get('address1') or '').strip(),
        address2=(data.get('address2') or '').strip(),
        address3=(data.get('address3') or '').strip(),
        postal_code=(data.get('postalCode') or '').strip(),
        phone=(data.get('phone') or '').strip(),
    )
    data_manager.clients[name] = c
    data_manager.save_clients()
    log_action(f"Saved client {name}")
    return jsonify({'success': True, 'data': _client_to_dict(c)})

@app.route('/api/clients/<name>', methods=['GET', 'PUT', 'DELETE'])
@require_auth
def client_item(name):
    key = unquote_plus(name)
    c = data_manager.clients.get(key)
    if request.method == 'GET':
        if not c:
            return jsonify({'success': False, 'message': 'Not found'}), 404
        return jsonify({'success': True, 'data': _client_to_dict(c)})

    if request.method == 'PUT':
        if not c:
            return jsonify({'success': False, 'message': 'Not found'}), 404
        data = request.get_json(force=True) or {}
        c.company = (data.get('company') or c.company).strip()
        c.address1 = (data.get('address1') or c.address1).strip()
        c.address2 = (data.get('address2') or c.address2).strip()
        c.address3 = (data.get('address3') or c.address3).strip()
        c.postal_code = (data.get('postalCode') or c.postal_code).strip()
        c.phone = (data.get('phone') or c.phone).strip()
        data_manager.save_clients()
        log_action(f"Updated client {key}")
        return jsonify({'success': True, 'data': _client_to_dict(c)})

    # DELETE (admin)
    if not c:
        return jsonify({'success': False, 'message': 'Not found'}), 404
    if not session.get('is_admin', False):
        return jsonify({'error': 'Admin privileges required'}), 403
    del data_manager.clients[key]
    data_manager.save_clients()
    log_action(f"Deleted client {key}")
    return jsonify({'success': True})

if __name__ == '__main__':
    try:
        init_data_manager()
        run_https_app(app)
    except Exception as e:
        logger.error(f"Failed to start application: {e}")
        raise
