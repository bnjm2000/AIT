from flask import Flask, render_template, request, jsonify, session, redirect, url_for, jsonify
import csv
from urllib.parse import unquote_plus
import os
import re
from flask_cors import CORS
from functools import wraps
import os
import json
from datetime import datetime, timedelta
from collections import defaultdict
import logging
import threading
import time
import secrets

# Import your existing modules
from models import User, InventoryItem, Container, Event, LogEntry, hash_password, format_date_output, dates_overlap
from data_manager import DataManager
from utils import get_state_color
from urllib.parse import unquote_plus

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = Flask(__name__)
app.secret_key = os.environ.get('SECRET_KEY', 'AVEC')
CORS(app)

# Global data manager instance
data_manager = None

# Caching for performance
_cache = {
    'assigned_assets': None,
    'available_assets': None,
    'cache_timestamp': None
}

# Serialise transfer/return mutations so multiple users on different devices
# cannot transfer and return the same physical asset at the same time.
_transfer_action_lock = threading.RLock()

def with_transfer_action_lock(f):
    @wraps(f)
    def locked_function(*args, **kwargs):
        with _transfer_action_lock:
            return f(*args, **kwargs)
    return locked_function

from datetime import datetime as _dt
from flask import request, jsonify

def _parse_any_date(_s):
    if not _s:
        return None
    s = str(_s).strip()
    for fmt in ("%Y%m%d", "%Y/%m/%d", "%Y-%m-%d"):
        try:
            return _dt.strptime(s, fmt).date()
        except Exception:
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
    global _cache
    _cache = {'assigned_assets': None,
              'available_assets': None, 'cache_timestamp': None}


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

    if os.path.exists(filepath) and os.path.getsize(filepath) > 0:
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

    if changed or not os.path.exists(filepath):
        _save_departments(departments)

    return departments


def _department_payload(code, departments=None):
    departments = departments or _load_departments()
    code = _normalise_department_code(code) or 'UN'
    return departments.get(code) or _department_record(code)


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
    Exact model group key.

    This intentionally includes description so variants like:
    - Shure ULXD4D Dual Channel Receiver [L50]
    - Shure ULXD4D Dual Channel Receiver [G52]

    are counted separately.
    """
    return (
        _clean_group_value(getattr(asset, 'department_code', ''), True),
        _clean_group_value(getattr(asset, 'brand', '')),
        _clean_group_value(getattr(asset, 'model_number', '')),
        _clean_group_value(getattr(asset, 'description', ''))
    )




def _is_bulk_asset(asset):
    return bool(getattr(asset, 'is_bulk', False))


def _safe_int(value, default=0):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


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

    # Very old CLI markers sometimes used loan|... or misc|...
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
    return f"{qty}x {name}" if qty > 1 else name


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
    """Counts non-model, non-custom, non-bulk direct asset rows for legacy/direct workflows."""
    _ensure_event_custom_lists(event)
    required = 0
    prepared_active = 0
    prepared_ever = 0
    returned = 0

    for item in event.prepared_items:
        if not isinstance(item, str):
            continue
        if item.startswith('[MODEL]') or _is_bulk_ref(item) or _is_custom_ref(item):
            continue
        required += 1

    all_seen = set(event.actually_prepared or []) | set(event.returned_items or [])
    for item in all_seen:
        if not isinstance(item, str):
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


def _is_bulk_ref(value):
    return _parse_bulk_marker(value) is not None


def _model_key_from_parts(dept, brand, model, description=''):
    return (
        _clean_group_value(dept, True),
        _clean_group_value(brand),
        _clean_group_value(model),
        _clean_group_value(description)
    )


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


def _sum_assigned_quantity(model_group):
    total = 0
    for asset in model_group.get('assignedAssets', []) or []:
        total += max(1, _safe_int(asset.get('quantity', 1), 1))
    return total


def _sum_returned_quantity(model_group):
    total = 0
    for asset in model_group.get('assignedAssets', []) or []:
        if asset.get('status') == 'returned':
            total += max(1, _safe_int(asset.get('quantity', 1), 1))
    return total


def _refresh_model_group_statuses(model_groups):
    for group in (model_groups or {}).values():
        required = max(0, _safe_int(group.get('requiredQuantity', 0), 0))
        assigned = _sum_assigned_quantity(group)
        returned = _sum_returned_quantity(group)
        prepared = max(assigned - returned, 0)

        group['assignedQuantity'] = assigned
        group['returnedQuantity'] = returned
        group['preparedQuantity'] = prepared

        if returned >= required and assigned > 0:
            group['status'] = 'returned'
        elif prepared >= required and required > 0:
            group['status'] = 'ready'
        elif prepared > 0:
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


def _bulk_remaining_for_event_group(event, bulk_asset):
    group_key = _asset_group_key(bulk_asset)
    required = 0
    for item in getattr(event, 'prepared_items', []) or []:
        key, quantity = _parse_model_assignment_key(item)
        if key == group_key:
            required += quantity

    prepared = _bulk_quantity_in_values_for_key(getattr(event, 'actually_prepared', []) or [], group_key)
    return max(required - prepared, 0)


def _bulk_available_quantity_for_event(bulk_asset, target_event):
    if not bulk_asset or not _is_bulk_asset(bulk_asset):
        return 0

    total = max(1, _safe_int(getattr(bulk_asset, 'quantity', 1), 1))
    if getattr(bulk_asset, 'is_missing', False):
        return 0

    busy = 0
    my_start = getattr(target_event, 'start_date', '')
    my_end = getattr(target_event, 'end_date', '')

    for other in data_manager.events.values():
        if not other or other.event_id == target_event.event_id:
            continue
        if not _ranges_overlap(my_start, my_end, getattr(other, 'start_date', ''), getattr(other, 'end_date', '')):
            continue

        prepared_qty = _bulk_quantity_for_asset_in_values(getattr(other, 'actually_prepared', []) or [], bulk_asset.asset_id)
        returned_qty = _bulk_quantity_for_asset_in_values(getattr(other, 'returned_items', []) or [], bulk_asset.asset_id)
        busy += max(prepared_qty - returned_qty, 0)

    return max(total - busy, 0)


def _bulk_asset_to_available_dict(asset, target_event=None):
    status = 'available'
    if getattr(asset, 'is_missing', False):
        status = 'missing'
    elif getattr(asset, 'is_ooc', False):
        status = 'ooc'

    available_quantity = (
        _bulk_available_quantity_for_event(asset, target_event)
        if target_event is not None else max(1, _safe_int(getattr(asset, 'quantity', 1), 1))
    )

    return {
        'id': asset.asset_id,
        'bulkId': asset.asset_id,
        'displayId': '',
        'brand': asset.brand,
        'model': asset.model_number,
        'description': asset.description or '',
        'serial': '',
        'department': asset.department_code,
        'location': asset.current_location or asset.default_location,
        'status': status,
        'isMissing': getattr(asset, 'is_missing', False),
        'isOOC': getattr(asset, 'is_ooc', False),
        'isBulk': True,
        'quantity': max(1, _safe_int(getattr(asset, 'quantity', 1), 1)),
        'availableQuantity': available_quantity
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

    description = parts[4] if len(parts) > 4 else ''

    key = (
        _clean_group_value(parts[0], True),
        _clean_group_value(parts[1]),
        _clean_group_value(parts[2]),
        _clean_group_value(description)
    )

    return key, quantity


def _asset_to_available_dict(asset):
    if _is_bulk_asset(asset):
        return _bulk_asset_to_available_dict(asset)

    status = 'available'

    if getattr(asset, 'is_missing', False):
        status = 'missing'
    elif getattr(asset, 'is_ooc', False):
        status = 'ooc'

    return {
        'id': asset.asset_id,
        'brand': asset.brand,
        'model': asset.model_number,
        'description': asset.description or '',
        'serial': asset.serial_number,
        'department': asset.department_code,
        'location': asset.current_location or asset.default_location,
        'status': status,
        'isMissing': getattr(asset, 'is_missing', False),
        'isOOC': getattr(asset, 'is_ooc', False),
        'isBulk': False,
        'quantity': 1,
        'availableQuantity': 1
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

        # If the user was deleted or deactivated after login, force logout
        if not user or not getattr(user, 'is_active', True):
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
      - not out of commission
      - not already prepared/assigned to this same event
      - not specifically out for another overlapping event and not returned

    It does NOT reserve/hide assets simply because another overlapping event has
    an unprepared [MODEL] requirement.  Model requirements are planning demand;
    only a specific prepared asset ID means the physical unit is unavailable.
    """
    try:
        event = data_manager.events.get(event_id)
        if not event:
            return jsonify({'error': 'Event not found'}), 404

        my_start = getattr(event, 'start_date', '')
        my_end = getattr(event, 'end_date', '')

        def is_physical_asset_ref(value):
            """True only for real inventory asset IDs, not model/custom/bulk markers."""
            if not isinstance(value, str) or not value:
                return False
            return not (
                value.startswith('[MODEL]') or
                value.startswith('[BULK]') or
                _is_custom_ref(value)
            )

        def active_physical_refs_for_event(source_event):
            """Specific physical asset IDs attached/prepared for an event and not returned."""
            returned = set(getattr(source_event, 'returned_items', []) or [])
            refs = set()

            # Legacy/direct workflows can store real asset IDs in prepared_items.
            for ref in getattr(source_event, 'prepared_items', []) or []:
                if is_physical_asset_ref(ref) and ref not in returned:
                    refs.add(ref)

            # Model workflow stores scanned/prepared physical IDs here.
            for ref in getattr(source_event, 'actually_prepared', []) or []:
                if is_physical_asset_ref(ref) and ref not in returned:
                    refs.add(ref)

            return refs

        current_event_refs = active_physical_refs_for_event(event)
        busy_elsewhere = set()

        for other in data_manager.events.values():
            if not other or other.event_id == event_id:
                continue
            if not _ranges_overlap(my_start, my_end, getattr(other, 'start_date', ''), getattr(other, 'end_date', '')):
                continue

            busy_elsewhere.update(active_physical_refs_for_event(other))

        final_list = []

        for asset_id, asset in sorted(data_manager.inventory.items(), key=lambda pair: pair[0]):
            if not asset:
                continue

            if _is_bulk_asset(asset):
                # Bulk assets have quantity-based availability.  Keep this branch
                # separate so partially available bulk items can still appear.
                if getattr(asset, 'is_missing', False) or getattr(asset, 'is_ooc', False):
                    continue

                available_quantity = _bulk_available_quantity_for_event(asset, event)
                if available_quantity <= 0:
                    continue

                final_list.append(_bulk_asset_to_available_dict(asset, event))
                continue

            if getattr(asset, 'is_missing', False) or getattr(asset, 'is_ooc', False):
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
                'location': asset.current_location or asset.default_location or '',
                'status': 'available',
                'isMissing': False,
                'isOOC': False,
                'isBulk': False,
                'quantity': 1,
                'availableQuantity': 1
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

        if not user or not getattr(user, 'is_active', True):
            session.clear()
            return jsonify({'error': 'Account inactive'}), 401

        if not getattr(user, 'is_admin', False):
            return jsonify({'error': 'Admin privileges required'}), 403

        # Keep the session value updated too
        session['is_admin'] = user.is_admin

        return f(*args, **kwargs)

    return decorated_function


def _current_user_obj():
    """Return the logged-in User object, or None if the session is stale."""
    username = session.get('user')
    if not username or not data_manager:
        return None
    return data_manager.users.get(username)


def _current_user_is_admin():
    user = _current_user_obj()
    return bool(user and getattr(user, 'is_admin', False))


def _parse_maintenance_log_date(log_entry):
    """Parse the date at the start of a maintenance log entry."""
    parts = str(log_entry or '').split('\t')
    raw_date = parts[0].strip() if parts else ''
    for fmt in ("%Y/%m/%d", "%Y-%m-%d", "%Y%m%d"):
        try:
            return datetime.strptime(raw_date, fmt).date()
        except ValueError:
            pass
    return None


def _maintenance_log_permission(asset, log_index, allow_admin=True):
    """Return (allowed, message) for editing/deleting a maintenance log.

    Normal users may only edit logs they wrote, and only within 7 days of the
    log date. Admins may edit/delete any maintenance log.
    """
    if allow_admin and _current_user_is_admin():
        return True, ''

    username = session.get('user')
    if not username:
        return False, 'Not authenticated'

    logs = getattr(asset, 'maintenance_logs', []) or []
    if log_index < 0 or log_index >= len(logs):
        return False, 'Invalid log index'

    original_log = logs[log_index]
    parts = original_log.split('\t')
    original_user = parts[1].strip() if len(parts) >= 2 else ''

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
    """Helper function to log actions"""
    try:
        log_entry = LogEntry(
            timestamp=datetime.now().strftime("%Y/%m/%d %H:%M:%S"),
            user=session.get('user', 'system'),
            action=action
        )
        data_manager.logs.append(log_entry)
        data_manager.save_logs()
        logger.info(f"Action logged: {action}")
    except Exception as e:
        logger.error(f"Failed to log action: {e}")

def log_asset_change(event_id, asset_id, action, details=""):
    """Log all asset changes for debugging"""
    timestamp = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    log_message = f"[ASSET_CHANGE] {timestamp} - Event {event_id}: {action} asset {asset_id} {details}"
    logger.warning(log_message)
    print(log_message)

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
        (asset.model_number or '').strip() == group['model'] and
        (asset.description or '').strip() == group['description']
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
        marker['model'] == group['model'] and
        marker['description'] == group['description']
    )


def _update_event_model_group_references(event, old_group, new_group):
    """
    Updates event-level model requirement rows when admin chooses
    to update all assets of the same model/description group.
    """
    changed = 0

    # Newer web workflow: [MODEL]DEPT|BRAND|MODEL|QTY|DESCRIPTION
    if hasattr(event, 'prepared_items') and isinstance(event.prepared_items, list):
        for index, item in enumerate(event.prepared_items):
            marker = _parse_model_marker(item)

            if _model_marker_matches_group(marker, old_group):
                event.prepared_items[index] = _make_model_marker(new_group, marker['quantity'])
                changed += 1

    # Older/CLI workflow: asset_models list with model_description
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

    lists_to_check = (
        getattr(event, 'prepared_items', []) or [],
        getattr(event, 'actually_prepared', []) or [],
        getattr(event, 'returned_items', []) or [],
        getattr(event, 'extra_assets', []) or []
    )

    return any(asset_id in values for values in lists_to_check if isinstance(values, list))


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
    Add quantity to an existing old CLI-style asset_models row if it already exists.
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
    """Count real physical assets from this exact group already tied to the event.

    Includes active prepared assets and returned assets so an event's model
    requirement stays large enough for the physical units that have passed
    through it.
    """
    if not event or not group:
        return 0

    seen = set()
    for values in (
        getattr(event, 'actually_prepared', []) or [],
        getattr(event, 'returned_items', []) or [],
    ):
        for asset_id in values:
            if not _is_real_asset_ref(asset_id):
                continue
            if asset_id in seen:
                continue
            asset = data_manager.inventory.get(asset_id) if data_manager else None
            if asset and _asset_matches_group(asset, group):
                seen.add(asset_id)

    return len(seen)


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
    changed = _add_or_increment_model_marker(event.prepared_items, group, delta)
    changed += _add_or_increment_asset_model_row(event.asset_models, group, delta)
    return changed

def _update_single_asset_event_model_references(event, old_group, new_group):
    """
    For a single asset edit, update only one unit of the old model/description
    requirement inside events where that exact asset was prepared/returned before.

    Example:
    Old event has:
        [MODEL]AX|Yamaha|QL5|2|Console

    One prepared asset later changes to:
        Yamaha DM7 Compact

    Event becomes:
        [MODEL]AX|Yamaha|QL5|1|Console
        [MODEL]AX|Yamaha|DM7 Compact|1|Console

    This preserves total quantity and does not affect return logic.
    """
    changed = 0

    # Newer web workflow: prepared_items contains [MODEL] rows.
    prepared_items = getattr(event, 'prepared_items', []) or []

    if isinstance(prepared_items, list):
        for index, item in enumerate(list(prepared_items)):
            marker = _parse_model_marker(item)

            if not _model_marker_matches_group(marker, old_group):
                continue

            try:
                old_qty = int(marker['quantity'])
            except Exception:
                old_qty = 1

            if old_qty <= 1:
                prepared_items[index] = _make_model_marker(new_group, 1)
                changed += 1
            else:
                prepared_items[index] = _make_model_marker(old_group, old_qty - 1)
                changed += 1
                changed += _add_or_increment_model_marker(prepared_items, new_group, 1)

            # Only move ONE unit because only ONE asset was edited.
            break

    # Older/CLI workflow: asset_models contains display rows.
    asset_models = getattr(event, 'asset_models', []) or []
    old_display = _display_model_description(old_group)

    if isinstance(asset_models, list):
        for index, row in enumerate(list(asset_models)):
            if not isinstance(row, dict):
                continue

            if str(row.get('model_description', '')).strip() != old_display:
                continue

            try:
                old_qty = int(row.get('quantity', 1))
            except Exception:
                old_qty = 1

            if old_qty <= 1:
                row['model_description'] = _display_model_description(new_group)
                row['quantity'] = 1
                changed += 1
            else:
                row['quantity'] = old_qty - 1
                changed += 1
                changed += _add_or_increment_asset_model_row(asset_models, new_group, 1)

            # Only move ONE unit because only ONE asset was edited.
            break

    return changed

def validate_event_data(data):
    """Validate event data"""
    errors = []

    if not data.get('name', '').strip():
        errors.append('Event name is required')

    if len(data.get('name', '')) > 100:
        errors.append('Event name must be less than 100 characters')

    try:
        start_date = datetime.strptime(data['startDate'], '%Y-%m-%d')
        end_date = datetime.strptime(data['endDate'], '%Y-%m-%d')
        if end_date < start_date:
            errors.append('End date must be after start date')
    except (KeyError, ValueError):
        errors.append('Invalid date format')

    return errors

def get_assigned_assets():
    """Get all assets currently assigned to events (with caching)"""
    global _cache

    try:
        # Add validation checks
        if data_manager is None:
            logger.error("get_assigned_assets: data_manager is None")
            return set()
            
        if not hasattr(data_manager, 'events') or data_manager.events is None:
            logger.error("get_assigned_assets: data_manager.events is None")
            return set()

        # Cache for 30 seconds
        now = datetime.now().timestamp()
        if (_cache['assigned_assets'] is not None and
            _cache['cache_timestamp'] is not None and
                now - _cache['cache_timestamp'] < 30):
            logger.debug("get_assigned_assets: returning cached result")
            return _cache['assigned_assets']

        logger.debug(f"get_assigned_assets: processing {len(data_manager.events)} events")
        
        assigned_assets = set()
        for event in data_manager.events.values():
            try:
                # Ensure event has prepared_items attribute
                if not hasattr(event, 'prepared_items'):
                    logger.warning(f"Event {getattr(event, 'event_id', 'unknown')} missing prepared_items")
                    continue
                    
                # Ensure event has returned_items attribute
                if not hasattr(event, 'returned_items'):
                    event.returned_items = []
                    
                for asset_id in event.prepared_items:
                    if (asset_id not in event.returned_items and
                            not (asset_id.startswith('[MODEL]') or asset_id.startswith('[BULK]') or _is_custom_ref(asset_id))):
                        assigned_assets.add(asset_id)
                        
            except Exception as e:
                logger.error(f"Error processing event {getattr(event, 'event_id', 'unknown')}: {e}")
                continue

        logger.debug(f"get_assigned_assets: found {len(assigned_assets)} assigned assets")
        
        _cache['assigned_assets'] = assigned_assets
        _cache['cache_timestamp'] = now
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
                        if _is_bulk_ref(specific_asset_id) or _is_custom_ref(specific_asset_id):
                            continue

                        specific_asset = data_manager.inventory.get(specific_asset_id)
                        if (specific_asset and
                            specific_asset.brand == brand and
                            specific_asset.model_number == model and
                            specific_asset.department_code == dept and
                            (specific_asset.description or '') == (description or '')):

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

        # 1. All required items have been prepared at some point and all prepared items are returned.
        if required_total > 0 and prepared_ever_total >= required_total and returned_total >= prepared_ever_total:
            event.state = 'Closed'

        # 2. Last day should take visual priority while the event is still active.
        elif is_last_day:
            event.state = 'Last Day'

        # 3. Overdue: event ended with prepared, unreturned items.
        elif prepared_ever_total > returned_total and current_date > event.end_date:
            event.state = 'Overdue'

        # 4. No requirements at all.
        elif required_total == 0:
            event.state = 'Added'

        # 5. Requirements exist, but nothing has been collected/prepared yet.
        elif started_total == 0:
            event.state = 'Planning'

        # 6. Some collection/preparation happened, but requirements are not fully prepared.
        elif prepared_active_total < required_total and returned_total == 0:
            event.state = 'Preparing'

        # 7. Required quantity is fully prepared and none returned yet.
        elif prepared_active_total >= required_total and returned_total == 0:
            if event.start_date <= current_date <= event.end_date:
                event.state = 'Ongoing'
            else:
                event.state = 'Ready'

        # 8. Some items have been returned, but not all.
        elif returned_total > 0 and returned_total < prepared_ever_total:
            event.state = 'Returning'

        else:
            logger.warning(f"Event {event.event_id} fell through state calculation; keeping {event.state}")

    except Exception as e:
        logger.error(f"Error updating event state for event {event.event_id}: {e}")
        import traceback
        logger.error(f"Traceback: {traceback.format_exc()}")

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
    
    # Wait for data_manager to be initialized
    while data_manager is None:
        logger.info("Background thread: Waiting for data_manager to be initialized...")
        time.sleep(5)
    
    logger.info("Background thread: data_manager is ready, starting checks")
    
    while True:
        try:
            if data_manager is not None and hasattr(data_manager, 'events'):
                logger.info("Background thread: Starting scheduled event state check")
                check_and_update_ongoing_events()
                logger.info("Background thread: Completed scheduled event state check")
            else:
                logger.warning("Background thread: data_manager.events not available, skipping check")
            
            time.sleep(300)  # Check every 5 minutes for testing (change to 3600 for production)
        except Exception as e:
            logger.error(f"Background thread error: {e}")
            import traceback
            logger.error(f"Background thread traceback: {traceback.format_exc()}")
            time.sleep(300)  # Continue running even if there's an error

def start_background_thread():
    """Start the background thread for event checking"""
    try:
        ongoing_thread = threading.Thread(target=schedule_ongoing_check, daemon=True)
        ongoing_thread.start()
        logger.info("Background thread for event checking started successfully")
        return True
    except Exception as e:
        logger.error(f"Failed to start background thread: {e}")
        return False

def init_data_manager():
    """Initialize the data manager with the configured data folder"""
    global data_manager

    try:
        # Try to read data folder from config file
        if os.path.exists('data_folder.txt'):
            with open('data_folder.txt', 'r') as f:
                data_folder = f.read().strip()
        else:
            # Default data folder
            data_folder = './data'
            if not os.path.exists(data_folder):
                os.makedirs(data_folder)
            with open('data_folder.txt', 'w') as f:
                f.write(data_folder)

        data_manager = DataManager(data_folder)
        data_manager.setup_data_folder()
        data_manager.check_and_initialize_files()
        data_manager.load_all_data()
        logger.info(f"Data manager initialized with folder: {data_folder}")
        
        # Start the background thread AFTER data_manager is initialized
        background_started = start_background_thread()
        if not background_started:
            logger.warning("Background thread failed to start - automatic event updates disabled")
        else:
            logger.info("Background thread started successfully after data_manager initialization")
            
    except Exception as e:
        logger.error(f"Failed to initialize data manager: {e}")
        raise

    def _client_to_dict(c):
        return {
            'name': c.name, 'company': c.company,
            'address1': c.address1, 'address2': c.address2, 'address3': c.address3,
            'postalCode': c.postal_code, 'phone': c.phone
        }

# Routes

@app.route('/')
@require_auth
def index():
    """Serve the main web interface"""
    return render_template('index.html')


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
                session['is_admin'] = user.is_admin

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
            'isAdmin': user.is_admin,
            'isActive': getattr(user, 'is_active', True)
        }
    })



@app.route('/api/departments', methods=['GET'])
@require_auth
def get_departments():
    """Return the configurable department list used by filters and badges."""
    try:
        departments = _load_departments()
        usage_counts = defaultdict(int)

        for asset in data_manager.inventory.values():
            code = _normalise_department_code(getattr(asset, 'department_code', 'UN')) or 'UN'
            usage_counts[code] += 1

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


@app.route('/api/users', methods=['GET'])
@require_admin
def get_users():
    """Admin: list users"""
    users_data = []

    for user in sorted(data_manager.users.values(), key=lambda u: u.username.lower()):
        users_data.append({
            'username': user.username,
            'isAdmin': user.is_admin,
            'isActive': getattr(user, 'is_active', True)
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
        is_active = bool(data.get('isActive', True))

        if not username:
            return jsonify({'error': 'Username is required'}), 400

        if not password:
            return jsonify({'error': 'Password is required'}), 400

        if username in data_manager.users:
            return jsonify({'error': 'User already exists'}), 409

        salt = secrets.token_hex(16)
        password_hash = hash_password(password, salt)

        data_manager.users[username] = User(
            username=username,
            password_hash=password_hash,
            salt=salt,
            is_admin=is_admin,
            is_active=is_active
        )

        data_manager.save_users()
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

        user = data_manager.users.get(old_username)
        if not user:
            return jsonify({'error': 'User not found'}), 404

        data = request.get_json() or {}

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

                # If admin renamed themselves, keep session valid
                if session.get('user') == old_username:
                    session['user'] = new_username

        # Update admin privilege
        if 'isAdmin' in data:
            new_is_admin = bool(data.get('isAdmin'))

            # Prevent locking yourself out of admin access
            if user.username == session.get('user') and not new_is_admin:
                return jsonify({'error': 'You cannot remove your own admin privilege'}), 400

            user.is_admin = new_is_admin
            session['is_admin'] = user.is_admin if user.username == session.get('user') else session.get('is_admin', False)

        # Update active state
        if 'isActive' in data:
            new_is_active = bool(data.get('isActive'))

            # Prevent deactivating yourself
            if user.username == session.get('user') and not new_is_active:
                return jsonify({'error': 'You cannot deactivate your own account'}), 400

            user.is_active = new_is_active

        data_manager.save_users()
        log_action(f"Updated user {user.username}")

        return jsonify({
            'success': True,
            'message': 'User updated successfully',
            'data': {
                'username': user.username,
                'isAdmin': user.is_admin,
                'isActive': getattr(user, 'is_active', True)
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

        data = request.get_json() or {}
        new_password = data.get('password') or ''

        if not new_password:
            return jsonify({'error': 'New password is required'}), 400

        user.salt = secrets.token_hex(16)
        user.password_hash = hash_password(new_password, user.salt)

        data_manager.save_users()
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

        del data_manager.users[username]
        data_manager.save_users()

        log_action(f"Deleted user {username}")

        return jsonify({
            'success': True,
            'message': 'User deleted successfully'
        })

    except Exception as e:
        logger.error(f"Error deleting user {username}: {e}")
        return jsonify({'error': 'Failed to delete user'}), 500

@app.route('/api/events', methods=['GET'])
@require_auth
def get_events():
    """Get all events"""
    try:
        events_data = []
        for event in data_manager.events.values():
            # Initialize actually_prepared if missing
            if not hasattr(event, 'actually_prepared'):
                event.actually_prepared = []

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
                            
                            model_key = f"{dept}|{brand}|{model}|{description}"
                            
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
                            
                            # Find assigned specific assets for this model
                            for specific_asset_id in event.actually_prepared:
                                specific_asset = data_manager.inventory.get(specific_asset_id)
                                if (specific_asset and 
                                    specific_asset.brand == brand and 
                                    specific_asset.model_number == model and
                                    specific_asset.department_code == dept):
                                    
                                    asset_status = 'returned' if specific_asset_id in event.returned_items else 'prepared'
                                    
                                    model_groups[model_key]['assignedAssets'].append({
                                        'id': specific_asset_id,
                                        'serial': specific_asset.serial_number,
                                        'status': asset_status,
                                        'location': specific_asset.current_location
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
            _refresh_model_group_statuses(model_groups)

            # Calculate totals including custom item quantities.
            custom_counts = _custom_counts_for_event(event)
            if has_model_assignments:
                total_required = 0
                total_prepared = 0
                total_returned = 0

                for model_group in model_groups.values():
                    total_required += model_group['requiredQuantity']
                    total_prepared += max(_sum_assigned_quantity(model_group) - _sum_returned_quantity(model_group), 0)
                    total_returned += _sum_returned_quantity(model_group)

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
                'startDate': format_date_output(event.start_date),
                'endDate': format_date_output(event.end_date),
                'state': event.state,  # Keep original state, don't force update
                'tag': getattr(event, 'tag', 'events'), 
                'assetCount': total_required,
                'preparedCount': total_prepared,
                'returnedCount': total_returned,
                'assetModels': event.asset_models,
                'preparedItems': event.prepared_items,
                'returnedItems': event.returned_items,
                'customCollected': getattr(event, 'custom_collected', []),
                'returnableCount': returnable_counts['returnable'],
                'returnableTotalCount': returnable_counts['total'],
                'returnableRefs': returnable_counts['refs'],
                'modelGroups': model_groups,
                'hasModelAssignments': has_model_assignments,  # Flag to know which logic to use
                'forceStateOverride': getattr(event, 'force_state_override', False)
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

        # Initialize lists if they don't exist
        if not hasattr(event, 'actually_prepared'):
            event.actually_prepared = []
        if not hasattr(event, 'extra_assets'):
            event.extra_assets = []

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

                    # Check if this is an extra asset
                    is_extra = asset_id in event.extra_assets
                    
                    # However, if this asset fulfills a model requirement, it should NOT be extra
                    # regardless of what's in the extra_assets list
                    if is_extra:
                        for model_assignment in event.prepared_items:
                            if model_assignment.startswith('[MODEL]'):
                                try:
                                    parts = model_assignment[7:].split('|')
                                    if len(parts) >= 4:
                                        req_dept = parts[0]
                                        req_brand = parts[1]
                                        req_model = parts[2]
                                        req_description = parts[4] if len(parts) > 4 else ''
                                        
                                        if (asset.department_code == req_dept and 
                                            asset.brand == req_brand and 
                                            asset.model_number == req_model and
                                            asset.description == req_description):
                                            is_extra = False
                                            # Also clean up the extra_assets list
                                            if asset_id in event.extra_assets:
                                                event.extra_assets.remove(asset_id)
                                            break
                                except Exception as e:
                                    logger.error(f"Error checking model fulfillment: {e}")
                                    continue

                    asset_info = {
                        'id': asset.asset_id,
                        'name': f"{asset.brand} {asset.model_number} - {asset.description}",
                        'brand': asset.brand,
                        'model': asset.model_number,
                        'description': asset.description,
                        'serial': asset.serial_number,
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

        # Also process any assets that are in actually_prepared but not in prepared_items
        for asset_id in event.actually_prepared:
            # Check if this asset was already processed above
            already_processed = False
            for dept_assets in assets_by_department.values():
                if any(existing_asset['id'] == asset_id for existing_asset in dept_assets):
                    already_processed = True
                    break

            if not already_processed:
                # This is an asset in actually_prepared but not in prepared_items (truly extra)
                asset = data_manager.inventory.get(asset_id)
                if asset:
                    dept = asset.department_code

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
                        'status': status,
                        'location': asset.current_location,
                        'isMissing': asset.is_missing,
                        'isOOC': asset.is_ooc,
                        'isLoanOrMisc': False,
                        'isExtra': True  # Always extra if in actually_prepared but not prepared_items
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

                        model_key = f"{dept}|{brand}|{model}|{description}"

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

                        # Find assigned specific assets for this model
                        # Check both actually_prepared and all inventory assets
                        all_potential_assets = set()
                        if hasattr(event, 'actually_prepared'):
                            all_potential_assets.update(event.actually_prepared)
                        
                        # Also check returned items as they might have been assigned to this model
                        all_potential_assets.update(event.returned_items)
                        
                        logger.info(f"Checking assets for model {brand} {model}: {all_potential_assets}")
                        
                        for specific_asset_id in all_potential_assets:
                            specific_asset = data_manager.inventory.get(specific_asset_id)
                            
                            if specific_asset:
                                logger.info(f"Asset {specific_asset_id}: brand={specific_asset.brand}, model={specific_asset.model_number}, dept={specific_asset.department_code}")
                                logger.info(f"Looking for: brand={brand}, model={model}, dept={dept}")
                                
                                description = parts[4] if len(parts) > 4 else ''
                                if (specific_asset and 
                                    specific_asset.brand == brand and 
                                    specific_asset.model_number == model and
                                    specific_asset.department_code == dept and
                                    (specific_asset.description or '') == (description or '')):

                                    # Check if this asset is returned
                                    asset_status = 'returned' if specific_asset_id in event.returned_items else 'prepared'
                                    logger.info(f"Asset {specific_asset_id} matches model and has status: {asset_status}")

                                    model_groups[model_key]['assignedAssets'].append({
                                        'id': specific_asset_id,
                                        'serial': specific_asset.serial_number,
                                        'status': asset_status,
                                        'location': specific_asset.current_location
                                    })

                        # Determine overall model status - FIXED LOGIC
                        assigned_count = len(model_groups[model_key]['assignedAssets'])
                        returned_count = len([a for a in model_groups[model_key]['assignedAssets'] if a['status'] == 'returned'])
                        prepared_count = assigned_count - returned_count

                        logger.info(f"Model {brand} {model}: assigned={assigned_count}, returned={returned_count}, prepared={prepared_count}, required={quantity}")

                        if returned_count == assigned_count and assigned_count > 0:
                            model_groups[model_key]['status'] = 'returned'
                        elif prepared_count >= quantity:
                            model_groups[model_key]['status'] = 'ready'
                        elif prepared_count > 0:
                            model_groups[model_key]['status'] = 'partial'
                        else:
                            model_groups[model_key]['status'] = 'pending'

                        logger.info(f"Model {brand} {model} final status: {model_groups[model_key]['status']}")

                except Exception as e:
                    logger.error(f"Error parsing model assignment {asset_id}: {e}")

        _append_bulk_assignments_to_model_groups(model_groups, event)
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
                total_required += model_group['requiredQuantity']
                prepared_assets_count = max(_sum_assigned_quantity(model_group) - _sum_returned_quantity(model_group), 0)
                returned_assets_count = _sum_returned_quantity(model_group)
                total_prepared += prepared_assets_count
                total_returned += returned_assets_count

            total_required += custom_counts['required']
            total_prepared += custom_counts['preparedActive']
            total_returned += custom_counts['returned']
        else:
            specific_counts = _event_specific_counts(event)
            total_required = specific_counts['required'] + custom_counts['required']
            total_prepared = specific_counts['preparedActive'] + custom_counts['preparedActive']
            total_returned = specific_counts['returned'] + custom_counts['returned']

        logger.info(f"Event {event_id} final asset counts - Required: {total_required}, Prepared: {total_prepared}, Returned: {total_returned}, Extra assets in list: {len(event.extra_assets)}")
            
        returnable_counts = _event_returnable_counts(event)

        event_data = {
            'id': event.event_id,
            'name': event.name,
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
            'modelGroups': model_groups,
            'forceStateOverride': getattr(event, 'force_state_override', False)
        }

        return jsonify({'success': True, 'data': event_data})

    except Exception as e:
        logger.error(f"Error getting event {event_id}: {e}")
        return jsonify({'error': 'Failed to retrieve event'}), 500

@app.route('/api/events/<int:event_id>/availability', methods=['GET'])
@require_auth
def get_event_model_availability(event_id):
    """
    Compute model availability for an event.

    Rules:
    - Group by department + brand + model + description.
    - Exclude Missing assets.
    - Include OOC assets as inventory because they may be fixed by event day.
    - Subtract current event's requested quantity.
    - Subtract overlapping events' requested quantity.
    - Still return rows with 0 availability so the frontend can show them.
    """
    try:
        event = data_manager.events.get(event_id)
        if not event:
            return jsonify({'error': 'Event not found'}), 404

        physical_by_key = defaultdict(int)

        # Physical inventory: exclude Missing only, include OOC
        for asset in data_manager.inventory.values():
            if not asset:
                continue

            if getattr(asset, 'is_missing', False):
                continue

            key = _asset_group_key(asset)
            physical_by_key[key] += max(1, _safe_int(getattr(asset, 'quantity', 1), 1)) if _is_bulk_asset(asset) else 1

        # Quantity already requested in this same event
        used_here_by_key = defaultdict(int)

        for item in getattr(event, 'prepared_items', []) or []:
            key, quantity = _parse_model_assignment_key(item)

            if key:
                used_here_by_key[key] += quantity

        # Demand from overlapping events
        overlap_by_key = defaultdict(int)

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

            other_model_qty_by_key = defaultdict(int)
            other_specific_by_key = defaultdict(int)
            returned_other = set(getattr(other, 'returned_items', []) or [])

            for item in getattr(other, 'prepared_items', []) or []:
                key, quantity = _parse_model_assignment_key(item)

                if key:
                    other_model_qty_by_key[key] += quantity
                    continue

                if not isinstance(item, str):
                    continue

                if _is_custom_ref(item):
                    continue

                if item in returned_other:
                    continue

                asset = data_manager.inventory.get(item)

                if not asset:
                    continue

                # Missing assets should not count as usable inventory.
                if getattr(asset, 'is_missing', False):
                    continue

                other_specific_by_key[_asset_group_key(asset)] += 1

            for key in set(other_model_qty_by_key.keys()) | set(other_specific_by_key.keys()):
                overlap_by_key[key] += max(
                    other_model_qty_by_key.get(key, 0),
                    other_specific_by_key.get(key, 0)
                )

        result = []

        for key, physical in physical_by_key.items():
            department, brand, model, description = key

            used_here = used_here_by_key.get(key, 0)
            overlap = overlap_by_key.get(key, 0)
            available = max(physical - used_here - overlap, 0)

            result.append({
                'department': department,
                'brand': brand,
                'model': model,
                'description': description,
                'physical': physical,
                'physicalGlobal': physical,
                'usedInThisEvent': used_here,
                'overlappingDemand': overlap,
                'available': available,
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
        errors = validate_event_data(data)
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
            start_date=start_date,
            end_date=end_date,
            asset_models=[],
            prepared_items=[],
            state='Added',
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
        
        # URL decode the asset_id in case it has special characters
        from urllib.parse import unquote
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
        deleted_log = asset.maintenance_logs[log_index]
        log_parts = deleted_log.split('\t')
        deleted_description = '\t'.join(log_parts[2:]) if len(log_parts) >= 3 else deleted_log
        
        # Remove the log entry
        asset.maintenance_logs.pop(log_index)
        
        # Recalculate asset status based on remaining logs
        recalculate_asset_status_from_logs(asset)
        
        # Save changes
        data_manager.save_inventory()
        
        # Log the action
        log_action(f"Deleted maintenance log for asset {asset_id}: '{deleted_description}' (deleted by {session['user']})")
        
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
        asset.current_location = ''

        sorted_logs = []
        for i, log_entry in enumerate(asset.maintenance_logs):
            parts = log_entry.split('\t')
            if len(parts) >= 3:
                date_str = parts[0]
                try:
                    date_obj = datetime.strptime(date_str, "%Y/%m/%d")
                except ValueError:
                    logger.warning(f"Invalid date format in log: {date_str}")
                    date_obj = datetime.min

                sorted_logs.append((date_obj, i, log_entry))

        sorted_logs.sort(key=lambda x: (x[0], x[1]))

        for date_obj, log_index, log_entry in sorted_logs:
            parts = log_entry.split('\t')
            if len(parts) < 3:
                continue

            description = '\t'.join(parts[2:])

            if '[' not in description or ']' not in description:
                continue

            import re
            status_match = re.search(r'\[(.*?)\]', description)
            if not status_match:
                continue

            status_info = status_match.group(1)
            status_parts = [part.strip() for part in status_info.split(',')]

            for part in status_parts:
                part_lower = part.lower()

                if part_lower.startswith('location:'):
                    asset.current_location = part.split(':', 1)[1].strip()

                elif part_lower.startswith('serial:'):
                    asset.serial_number = part.split(':', 1)[1].strip()

                elif part_lower in (
                    'cleared ooc',
                    'clear ooc',
                    'removed ooc',
                    'unmarked ooc',
                    'unmark ooc',
                    'cleared out of commission',
                    'removed out of commission'
                ):
                    asset.is_ooc = False

                elif part_lower in (
                    'marked ooc',
                    'mark ooc',
                    'marked out of commission',
                    'mark out of commission'
                ):
                    asset.is_ooc = True

                elif part_lower in (
                    'cleared missing',
                    'clear missing',
                    'removed missing',
                    'unmarked missing',
                    'unmark missing'
                ):
                    asset.is_missing = False

                elif part_lower in (
                    'marked missing',
                    'mark missing'
                ):
                    asset.is_missing = True

        logger.info(
            f"Final status for {asset.asset_id}: "
            f"OOC={asset.is_ooc}, Missing={asset.is_missing}, Location='{asset.current_location}'"
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
                    log_action(f"Reset location for asset {asset_id} due to deletion of Event {event_id}")

        # Reset assets from actually_prepared (in case there are any not in prepared_items)
        if hasattr(event, 'actually_prepared'):
            for asset_id in event.actually_prepared.copy():
                if not _is_custom_ref(asset_id):
                    asset = data_manager.inventory.get(asset_id)
                    if asset and asset_id not in event.prepared_items:
                        old_location = asset.current_location
                        asset.current_location = asset.default_location or ""
                        assets_reset.append(f"{asset_id} (from '{old_location}' to '{asset.current_location or 'Store'}')")
                        log_action(f"Reset location for asset {asset_id} due to deletion of Event {event_id}")

        # Save inventory changes
        data_manager.save_inventory()

        # Delete event
        del data_manager.events[event_id]
        data_manager.delete_event_file(event_id)

        # Delete related logs
        logs_deleted = 0
        logs_to_keep = []
        
        for log in data_manager.logs:
            # Check if this log is related to the deleted event
            if (f"event {event_id}" in log.action.lower() or 
                f"Event {event_id}" in log.action or
                f"to event {event_id}" in log.action.lower() or
                f"from event {event_id}" in log.action.lower()):
                logs_deleted += 1
            else:
                logs_to_keep.append(log)
        
        # Update the logs list
        data_manager.logs = logs_to_keep
        
        # Save the updated logs
        data_manager.save_logs()

        # Invalidate cache
        invalidate_cache()

        # Log the deletion with details of reset assets and deleted logs
        if assets_reset:
            log_action(f"Deleted event {event_id}: {event_name} via web interface. Reset {len(assets_reset)} asset locations: {', '.join(assets_reset[:5])}{'...' if len(assets_reset) > 5 else ''}. Removed {logs_deleted} related log entries.")
        else:
            log_action(f"Deleted event {event_id}: {event_name} via web interface. No asset locations to reset. Removed {logs_deleted} related log entries.")

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

        data = request.get_json()
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

            if asset.is_missing:
                return jsonify({'error': 'Cannot assign missing asset'}), 400

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


@app.route('/api/events/<int:event_id>/models', methods=['POST', 'DELETE'])
@require_admin
def manage_event_models(event_id):
    """Add or remove model assignments to/from events"""
    try:
        event = data_manager.events.get(event_id)
        if not event:
            return jsonify({'error': 'Event not found'}), 404

        data = request.get_json()

        # In the POST section of manage_event_models function, around line 620:

        if request.method == 'POST':
            # Add model assignment
            brand = data.get('brand', '').strip()
            model = data.get('model', '').strip()
            department = data.get('department', '').strip().upper()
            provided_description = data.get('description', '').strip()
            quantity = max(1, int(data.get('quantity', 1)))

            logger.info(f"=== ADD MODEL REQUEST ===")
            logger.info(f"Brand: '{brand}', Model: '{model}', Dept: '{department}'")
            logger.info(f"Provided description: '{provided_description}'")
            logger.info(f"Raw data: {data}")  # Add this line to see what's being sent
            logger.info(f"Quantity: {quantity}")

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

            group_key = (
                _clean_group_value(department, True),
                _clean_group_value(brand),
                _clean_group_value(model),
                _clean_group_value(full_description)
            )

            # Server-side hard cap:
            # Users may overbook against clashing events, but they may not request
            # more than the physical inventory for this exact model/description group.
            # Missing assets are excluded. OOC assets are included.
            inv_count = sum(
                (max(1, _safe_int(getattr(asset, 'quantity', 1), 1)) if _is_bulk_asset(asset) else 1)
                for asset in data_manager.inventory.values()
                if asset
                and not getattr(asset, 'is_missing', False)
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

            # Check if this model already exists in the event (including description)
            existing_model_id = None
            existing_quantity = 0

            for item in event.prepared_items:
                logger.info(f"Checking item: '{item}'")
                if item.startswith('[MODEL]'):
                    parts = item[7:].split('|')
                    logger.info(f"Item parts: {parts}")
                    if len(parts) >= 5:  # dept|brand|model|qty|description
                        item_dept = parts[0]
                        item_brand = parts[1]
                        item_model = parts[2]
                        item_description = parts[4] if len(parts) > 4 else ''
                        
                        logger.info(f"Item details - Dept: '{item_dept}', Brand: '{item_brand}', Model: '{item_model}', Desc: '{item_description}'")
                        
                        # Match on department, brand, model, AND description
                        if (item_dept == department and 
                            item_brand == brand and 
                            item_model == model and
                            item_description == full_description):
                            existing_model_id = item
                            existing_quantity = int(parts[3])
                            logger.info(f"FOUND EXISTING MODEL: '{existing_model_id}' with quantity {existing_quantity}")
                            break
                        else:
                            logger.info(f"No match - descriptions differ: '{item_description}' vs '{full_description}'")

            if existing_model_id:
                logger.info(f"Updating existing model, removing: '{existing_model_id}'")
                event.prepared_items.remove(existing_model_id)
                new_quantity = existing_quantity + quantity
            else:
                logger.info("Creating new model assignment")
                new_quantity = quantity

            # Create consolidated model assignment identifier with FULL description
            model_id = f"[MODEL]{department}|{brand}|{model}|{new_quantity}|{full_description}"
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

            items_to_remove = []
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

            # If description is not provided, only allow delete when unambiguous
            if not description_to_match:
                if len(candidates) == 1:
                    items_to_remove = [candidates[0][0]]
                else:
                    return jsonify({
                        'error': 'Multiple variants exist for this model. Description is required to remove a specific one.'
                    }), 400
            else:
                items_to_remove = [it for (it, desc) in candidates if desc == description_to_match]
                if not items_to_remove:
                    return jsonify({'error': 'Model assignment not found'}), 404

            # Remove the items
            for item in items_to_remove:
                event.prepared_items.remove(item)
                if item in event.returned_items:
                    event.returned_items.remove(item)
                # Initialize actually_prepared if it doesn't exist
                if not hasattr(event, 'actually_prepared'):
                    event.actually_prepared = []
                if item in event.actually_prepared:
                    event.actually_prepared.remove(item)

            # Update event state
            update_event_state(event)

            # Save changes
            data_manager.save_event(event)

            # Invalidate cache
            invalidate_cache()

            log_action(f"Removed {brand} {model} model from event {event_id}")

            return jsonify({'success': True, 'message': f'Removed {brand} {model} from event'})

    except Exception as e:
        logger.error(f"Error managing event models: {e}")
        return jsonify({'error': 'Failed to manage event models'}), 500

@app.route('/api/events/<int:event_id>/prepare', methods=['POST'])
@require_auth
def prepare_event_asset(event_id):
    """Mark an asset as prepared for an event"""
    try:
        event = data_manager.events.get(event_id)
        if not event:
            return jsonify({'error': 'Event not found'}), 404

        data = request.get_json()
        asset_id = data.get('assetId', '').strip()

        if not asset_id:
            return jsonify({'error': 'Asset ID is required'}), 400

        # Initialize lists if they don't exist
        if not hasattr(event, 'actually_prepared'):
            event.actually_prepared = []
        if not hasattr(event, 'extra_assets'):
            event.extra_assets = []

        # Check if already prepared
        if asset_id in event.actually_prepared:
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

            if asset.is_missing:
                return jsonify({'error': 'Asset is marked as missing'}), 400

            if asset.is_ooc:
                return jsonify({'error': 'Asset is out of commission'}), 400

            # Check if this asset fulfills a model requirement
            fulfills_model_requirement = False
            
            # Check if this asset fulfills any model requirement
            for prepared_item in event.prepared_items:
                if prepared_item.startswith('[MODEL]'):
                    try:
                        parts = prepared_item[7:].split('|')
                        if len(parts) >= 4:
                            dept = parts[0]
                            brand = parts[1]
                            model = parts[2]
                            description = parts[4]

                            # Check if this asset matches the model requirement
                            if (asset.department_code == dept and 
                                asset.brand == brand and 
                                asset.model_number == model and
                                asset.description == description):
                                fulfills_model_requirement = True
                                logger.info(f"Asset {asset_id} fulfills model requirement {prepared_item}")
                                break
                    except Exception as e:
                        logger.error(f"Error parsing model assignment: {e}")
                        continue
            
            # Add to prepared_items if not already there
            if asset_id not in event.prepared_items:
                event.prepared_items.append(asset_id)
            
            # Handle extra_assets logic based on whether it fulfills a model requirement
            if fulfills_model_requirement:
                # If it fulfills a requirement, ensure it's NOT marked as extra
                if asset_id in event.extra_assets:
                    event.extra_assets.remove(asset_id)
                    logger.info(f"Removed {asset_id} from extra_assets (fulfills model requirement). Extra assets: {event.extra_assets}")
            else:
                # Only add to extra_assets if it doesn't fulfill any model requirement
                if asset_id not in event.extra_assets:
                    event.extra_assets.append(asset_id)
                    logger.info(f"Added extra asset {asset_id} to event {event_id}. Extra assets: {event.extra_assets}")

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

        return jsonify({'success': True, 'message': f'Asset {asset_id} prepared for event'})
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
def unprepare_event_asset(event_id):
    """Remove a specific asset completely from the event"""
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

        # Initialize actually_prepared if it doesn't exist
        if not hasattr(event, 'actually_prepared'):
            event.actually_prepared = []

        # Check if asset is assigned to this event first
        if asset_id not in event.prepared_items:
            return jsonify({'error': 'Asset is not assigned to this event'}), 400

        # LOG THE UNPREPARE ACTION
        log_asset_change(event_id, asset_id, "UNPREPARING", "completely removing asset from event [unprepare_event_asset]")

        # Remove from prepared list (completely unassign the asset)
        event.prepared_items.remove(asset_id)
        
        # Remove from actually_prepared if it's there
        if asset_id in event.actually_prepared:
            event.actually_prepared.remove(asset_id)
        
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

        # Check if asset is prepared for this event
        if asset_id not in event.prepared_items:
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
def assign_specific_asset_to_model(event_id):
    """Assign a specific asset to fulfill a model requirement"""
    try:
        event = data_manager.events.get(event_id)
        if not event:
            return jsonify({'error': 'Event not found'}), 404

        data = request.get_json()
        asset_id = data.get('assetId', '').strip()

        if not asset_id:
            return jsonify({'error': 'Asset ID is required'}), 400

        bulk_asset = data_manager.inventory.get(asset_id)
        if bulk_asset and _is_bulk_asset(bulk_asset):
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
            quantity = min(quantity, max(1, _safe_int(getattr(bulk_asset, 'quantity', 1), 1)))

            marker = _bulk_marker(asset_id, quantity)
            if marker in event.actually_prepared and marker not in event.returned_items:
                return jsonify({'error': 'Bulk asset is already prepared for this event'}), 400

            if marker in event.returned_items:
                event.returned_items.remove(marker)
            if marker not in event.actually_prepared:
                event.actually_prepared.append(marker)

            update_event_state(event)
            data_manager.save_event(event)
            invalidate_cache()
            log_action(f"Prepared {quantity}x bulk asset {bulk_asset.brand} {bulk_asset.model_number} for event {event_id}")
            return jsonify({'success': True, 'message': f'Prepared {quantity}x {bulk_asset.brand} {bulk_asset.model_number}'})

        # Initialize lists if they don't exist
        if not hasattr(event, 'actually_prepared'):
            event.actually_prepared = []
        if not hasattr(event, 'extra_assets'):
            event.extra_assets = []

        # Check if asset is already assigned
        if asset_id in event.actually_prepared:
            return jsonify({'error': 'Asset is already assigned to this event'}), 400

        # For regular assets, perform checks
        if not _is_custom_ref(asset_id):
            asset = data_manager.inventory.get(asset_id)
            if not asset:
                return jsonify({'error': 'Asset not found'}), 404

            logger.info(f"Assigning asset {asset_id} - Brand: {asset.brand}, Model: {asset.model_number}, Dept: {asset.department_code}")

            if asset.is_missing:
                return jsonify({'error': 'Asset is marked as missing'}), 400

            if asset.is_ooc:
                return jsonify({'error': 'Asset is out of commission'}), 400

            # Check if asset is assigned to another active event
            assigned_assets = get_assigned_assets()
            if asset_id in assigned_assets:
                for other_event_id, other_event in data_manager.events.items():
                    if (asset_id in other_event.prepared_items and 
                        asset_id not in other_event.returned_items):
                        return jsonify({'error': f'Asset is already assigned to event {other_event_id}: {other_event.name}'}), 400

            # Ensure the event's model requirement quantity covers this physical asset.
            # This is intentionally done for every scanned/prepared asset, not only
            # the first item of a new type. Container contents are processed one
            # asset at a time, so a container with 6 of the same new model must
            # increase the model requirement to 6 rather than leaving the last 5
            # displayed as extras.
            added_requirement_units = _ensure_event_model_requirement_covers_asset(event, asset, 1)
            fulfills_model_requirement = True

            if added_requirement_units:
                logger.info(
                    f"Added {added_requirement_units} model requirement unit(s) for container/manual asset {asset_id}: "
                    f"[{asset.department_code}] {asset.brand} {asset.model_number} {asset.description}"
                )

            logger.info(f"Asset {asset_id} fulfills model requirement: {fulfills_model_requirement}; addedUnits={added_requirement_units}")
            
            # Keep the specific asset linked to the event. Model rows track the
            # requested type/quantity; this direct reference keeps the prepared
            # physical unit visible in the All Assets section.
            if asset_id not in event.prepared_items:
                event.prepared_items.append(asset_id)
                logger.info(f"Added {asset_id} to prepared_items")
            
            # A specific asset that now has a matching model requirement should
            # not be shown as an unrelated extra item.
            if asset_id in event.extra_assets:
                event.extra_assets.remove(asset_id)
                logger.info(f"Removed {asset_id} from extra_assets. Extra assets: {event.extra_assets}")

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

        return jsonify({'success': True, 'message': f'Asset {asset_id} assigned to event'})

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
def remove_asset_from_event_body(event_id):
    """Remove an asset from an event (with asset ID in request body)"""
    try:
        data = request.get_json()
        asset_id = data.get('assetId', '').strip()
        
        if not asset_id:
            return jsonify({'error': 'Asset ID is required'}), 400
        
        logger.info(f"Removing asset '{asset_id}' from event {event_id}")
        
        event = data_manager.events.get(event_id)
        if not event:
            return jsonify({'error': 'Event not found'}), 404

        # Check if asset is in this event
        if asset_id not in event.prepared_items:
            return jsonify({'error': 'Asset is not assigned to this event'}), 400

        # LOG THE REMOVAL
        log_asset_change(event_id, asset_id, "REMOVING", "from prepared_items via POST remove-asset endpoint", "remove_asset_from_event_body")

        # Remove the asset
        event.prepared_items.remove(asset_id)

        # Also remove from returned items if it was there
        if asset_id in event.returned_items:
            event.returned_items.remove(asset_id)
            log_asset_change(event_id, asset_id, "REMOVING", "from returned_items", "remove_asset_from_event_body")

        # Initialize actually_prepared if it doesn't exist
        if not hasattr(event, 'actually_prepared'):
            event.actually_prepared = []

        # Remove from actually_prepared if it was there
        if asset_id in event.actually_prepared:
            event.actually_prepared.remove(asset_id)
            log_asset_change(event_id, asset_id, "REMOVING", "from actually_prepared", "remove_asset_from_event_body")

        # Remove from extra_assets if it exists
        if hasattr(event, 'extra_assets') and asset_id in event.extra_assets:
            event.extra_assets.remove(asset_id)
            log_asset_change(event_id, asset_id, "REMOVING", "from extra_assets", "remove_asset_from_event_body")

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

        log_action(f"Removed asset {asset_id} from event {event_id}")

        return jsonify({'success': True, 'message': f'Asset {asset_id} removed from event'})
    except Exception as e:
        logger.error(f"Error removing asset from event {event_id}: {e}")
        return jsonify({'error': 'Failed to remove asset from event'}), 500

@app.route('/api/events/<int:event_id>/remove-asset', methods=['POST'])
@require_admin
def remove_asset_from_event_post(event_id):
    """Remove an asset from an event - uses POST body to avoid URL encoding issues"""
    try:
        data = request.get_json()
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

TRANSFER_SOURCE_STATES = {'ongoing', 'last day', 'overdue', 'ready'}
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
        _norm(getattr(asset, 'description', '')),
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
            _norm(parsed.get('description', '')),
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
            if getattr(asset, 'is_missing', False) or getattr(asset, 'is_ooc', False):
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

    if asset_id not in to_event.prepared_items:
        to_event.prepared_items.append(asset_id)
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
    }


@app.route('/api/transfers/options', methods=['GET'])
@require_auth
def get_transfer_options():
    """Return valid source and destination events for the Transfer Assets page."""
    try:
        # Make sure Ready/Ongoing/Overdue states are current before filtering.
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
            return jsonify({'error': 'Source event must be Ongoing, Last Day, or Overdue'}), 400
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
    if asset_id not in from_event.prepared_items:
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
    if asset_id not in from_event.prepared_items:
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
            # Determine current status
            status = 'available'
            if asset.is_missing:
                status = 'missing'
            elif asset.is_ooc:
                status = 'ooc'
            elif _is_bulk_asset(asset):
                out_qty = 0
                for ev in data_manager.events.values():
                    out_qty += max(
                        _bulk_quantity_for_asset_in_values(getattr(ev, 'actually_prepared', []) or [], asset.asset_id) -
                        _bulk_quantity_for_asset_in_values(getattr(ev, 'returned_items', []) or [], asset.asset_id),
                        0
                    )
                status = 'deployed' if out_qty > 0 else 'available'
            elif asset.asset_id in assigned_assets:
                status = 'deployed'

            assets_data.append({
                'id': '' if _is_bulk_asset(asset) else asset.asset_id,
                'internalId': asset.asset_id,
                'bulkId': asset.asset_id if _is_bulk_asset(asset) else '',
                'displayId': '' if _is_bulk_asset(asset) else asset.asset_id,
                'brand': asset.brand,
                'model': asset.model_number,
                'serial': asset.serial_number,
                'description': asset.description,
                'department': asset.department_code,
                'departmentName': _department_payload(asset.department_code, departments)['name'],
                'departmentColor': _department_payload(asset.department_code, departments)['color'],
                'departmentTextColor': _department_payload(asset.department_code, departments)['textColor'],
                'status': status,
                'location': asset.current_location or asset.default_location,
                'isMissing': asset.is_missing,
                'isOOC': asset.is_ooc,
                'defaultLocation': asset.default_location,
                'currentLocation': asset.current_location,
                'maintenanceLogs': [] if _is_bulk_asset(asset) else asset.maintenance_logs,
                'isBulk': _is_bulk_asset(asset),
                'quantity': max(1, _safe_int(getattr(asset, 'quantity', 1), 1)) if _is_bulk_asset(asset) else 1,
                'availableQuantity': max(0, max(1, _safe_int(getattr(asset, 'quantity', 1), 1)) - sum(max(_bulk_quantity_for_asset_in_values(getattr(ev, 'actually_prepared', []) or [], asset.asset_id) - _bulk_quantity_for_asset_in_values(getattr(ev, 'returned_items', []) or [], asset.asset_id), 0) for ev in data_manager.events.values())) if _is_bulk_asset(asset) else 1
            })

        return jsonify({'success': True, 'data': assets_data})
    except Exception as e:
        logger.error(f"Error getting assets: {e}")
        return jsonify({'error': 'Failed to retrieve assets'}), 500


def _asset_check_find_asset(identifier):
    """Find an asset by Asset ID or Serial Number for Asset Check."""
    identifier = str(identifier or '').strip()
    if not identifier:
        return None

    # Exact asset ID match first.
    if identifier in data_manager.inventory:
        return data_manager.inventory[identifier]

    identifier_lower = identifier.lower()

    # Case-insensitive Asset ID / Serial Number fallback for scanner inconsistencies.
    for asset in data_manager.inventory.values():
        if not asset:
            continue
        if str(getattr(asset, 'asset_id', '') or '').lower() == identifier_lower:
            return asset
        serial = str(getattr(asset, 'serial_number', '') or '').strip()
        if serial and serial.lower() == identifier_lower:
            return asset

    return None


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

    return {
        'id': '' if _is_bulk_asset(asset) else asset.asset_id,
        'internalId': asset.asset_id,
        'brand': asset.brand,
        'model': asset.model_number,
        'description': asset.description or '',
        'serial': asset.serial_number or '',
        'department': asset.department_code,
        'location': location,
        'defaultLocation': getattr(asset, 'default_location', '') or 'Store',
        'currentLocation': getattr(asset, 'current_location', '') or '',
        'isMissing': bool(getattr(asset, 'is_missing', False)),
        'isOOC': bool(getattr(asset, 'is_ooc', False)),
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
        bool(getattr(a, 'is_missing', False)),
        str(getattr(a, 'asset_id', '') or '').lower()
    ))

    assets_payload = [_asset_check_asset_to_dict(asset, group_key) for asset in group_assets]

    summary = {
        'total': len(assets_payload),
        'checkable': len([a for a in assets_payload if a['checkEligible']]),
        'excluded': len([a for a in assets_payload if a['excluded'] and not a['isMissing']]),
        'missing': len([a for a in assets_payload if a['isMissing']]),
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
            asset.maintenance_logs.append(
                f"{today}\t{username}\tAsset Check - marked missing because this item was not checked [Marked Missing]"
            )
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
    - Exclude Missing assets.
    - Include OOC assets because they may be repaired before the event date.
    - Do not subtract clashing events here; event-date availability is handled by
      /api/events/<event_id>/availability.
    """
    try:
        available_assets = []

        for asset in data_manager.inventory.values():
            if not asset:
                continue

            if getattr(asset, 'is_missing', False):
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

    event_assets = []
    for asset_id in event.prepared_items:
        if not _is_custom_ref(asset_id):
            asset = data_manager.inventory.get(asset_id)
            if asset:
                event_assets.append({
                    'id': asset.asset_id,
                    'brand': asset.brand,
                    'model': asset.model_number,
                    'description': asset.description,
                    'serial': asset.serial_number,
                    'department': asset.department_code,
                    'status': 'returned' if asset_id in event.returned_items else 'prepared',
                    'location': asset.current_location,
                    'isMissing': asset.is_missing,
                    'isOOC': asset.is_ooc
                })

    return jsonify({'success': True, 'data': event_assets})


@app.route('/api/assets', methods=['POST'])
@require_auth
def create_asset():
    """Create a new asset"""
    try:
        data = request.get_json()

        # Validate required fields
        required_fields = ['brand', 'model']
        missing_fields = [
            field for field in required_fields if not data.get(field, '').strip()]
        if missing_fields:
            return jsonify({'error': f'Missing required fields: {", ".join(missing_fields)}'}), 400

        # Generate asset ID. Bulk assets use an internal ID only; it is not shown as an asset ID in the UI.
        model_number = data['model'].strip()
        is_bulk = bool(data.get('isBulk', False))

        if is_bulk:
            existing_bulk_numbers = []
            for item_id in data_manager.inventory.keys():
                if str(item_id).startswith('BULK-'):
                    existing_bulk_numbers.append(_safe_int(str(item_id).replace('BULK-', ''), 0))
            asset_id = f"BULK-{(max(existing_bulk_numbers, default=0) + 1):04d}"
            quantity = max(1, _safe_int(data.get('quantity', 1), 1))
            serial_number = ''
        else:
            existing_items = [
                item for item in data_manager.inventory.values()
                if not _is_bulk_asset(item) and item.model_number.lower() == model_number.lower()
            ]
            next_number = len(existing_items) + 1
            asset_id = f"{model_number}#{next_number:02d}"
            quantity = 1
            serial_number = data.get('serial', '').strip()

        # Create new asset
        asset = InventoryItem(
            asset_id=asset_id,
            brand=data['brand'].strip(),
            model_number=model_number,
            serial_number=serial_number,
            description=data.get('description', '').strip(),
            is_missing=False,
            is_ooc=False,
            maintenance_logs=[],
            department_code=data.get('department', 'UN').strip(),
            default_location='Store',
            current_location='',
            is_bulk=is_bulk,
            quantity=quantity
        )

        # Save asset
        data_manager.inventory[asset_id] = asset
        data_manager.save_inventory()

        # Auto-register the asset's department if it is new.
        departments = _load_departments()
        dept_code = _normalise_department_code(asset.department_code) or 'UN'
        if dept_code not in departments:
            departments[dept_code] = _department_record(dept_code)
            _save_departments(departments)

        # Invalidate cache
        invalidate_cache()

        log_action(f"Added asset {asset_id} via web interface")

        return jsonify({'success': True, 'message': 'Asset created successfully', 'assetId': asset_id})
    except Exception as e:
        logger.error(f"Error creating asset: {e}")
        return jsonify({'error': 'Failed to create asset'}), 500


@app.route('/api/assets/<path:asset_id>', methods=['PUT'])
@require_admin
def update_asset(asset_id):
    """
    Admin-only asset edit.

    Supports:
    - renaming Asset ID and cascading it through all event files and containers
    - editing one asset only
    - editing all assets that originally shared the same department/brand/model/description group
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
            data.get('internalId') or
            data.get('id') or
            data.get('assetId') or
            data.get('newId') or
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

        # Which inventory rows should receive the shared model/description change?
        if apply_to == 'allSimilar':
            target_assets = [
                item for item in data_manager.inventory.values()
                if _asset_matches_group(item, old_group)
            ]
        else:
            target_assets = [asset]

        # For single-asset model/description edits, remember which events this
        # exact asset appeared in BEFORE changing the inventory object.
        #
        # This lets old prepared/returned events follow the edited asset,
        # similar to how an Asset ID rename already follows the same asset.
        single_asset_event_ids_to_rewrite = set()

        if apply_to == 'single' and group_changed:
            for event in data_manager.events.values():
                if _event_has_asset_reference(event, old_asset_id):
                    single_asset_event_ids_to_rewrite.add(event.event_id)

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

        if 'defaultLocation' in data:
            asset.default_location = (data.get('defaultLocation') or '').strip()

        if 'currentLocation' in data:
            asset.current_location = (data.get('currentLocation') or '').strip()

        if 'isMissing' in data:
            asset.is_missing = bool(data.get('isMissing'))

        if 'isOOC' in data:
            asset.is_ooc = bool(data.get('isOOC'))

        if _is_bulk_asset(asset) and 'quantity' in data:
            asset.quantity = max(1, _safe_int(data.get('quantity'), getattr(asset, 'quantity', 1)))
            asset.serial_number = ''
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
                event_changed += _replace_asset_id_in_list(
                    getattr(event, 'returned_items', []),
                    old_asset_id,
                    new_asset_id
                )
                event_changed += _replace_asset_id_in_list(
                    getattr(event, 'actually_prepared', []),
                    old_asset_id,
                    new_asset_id
                )
                event_changed += _replace_asset_id_in_list(
                    getattr(event, 'extra_assets', []),
                    old_asset_id,
                    new_asset_id
                )

            # Only rewrite model requirement rows if admin chose to update all
            # assets of the old model/description group.
            # Rewrite model requirement rows when model/description changes.
            #
            # allSimilar:
            #   Rewrite the whole old model/description group everywhere.
            #
            # single:
            #   Rewrite only ONE unit in events where this exact asset was
            #   previously prepared/returned/assigned.
            if group_changed:
                if apply_to == 'allSimilar':
                    model_changes = _update_event_model_group_references(
                        event,
                        old_group,
                        new_group
                    )
                elif event.event_id in single_asset_event_ids_to_rewrite:
                    model_changes = _update_single_asset_event_model_references(
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

        data_manager.save_inventory()

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
                'modelReferencesChanged': model_references_changed
            }
        })

    except Exception as e:
        logger.error(f"Error updating asset {asset_id}: {e}", exc_info=True)
        return jsonify({'error': 'Failed to update asset'}), 500
    
@app.route('/api/assets/<asset_id>/maintain', methods=['POST'])
@require_auth
def maintain_asset(asset_id):
    """Add maintenance log to an asset"""
    try:
        logger.info(f"Received maintenance request for asset: '{asset_id}'")
        
        # URL decode the asset_id in case it has special characters
        from urllib.parse import unquote
        asset_id = unquote_plus(asset_id)
        logger.info(f"Decoded asset ID: '{asset_id}'")
        
        asset = data_manager.inventory.get(asset_id)
        if not asset:
            logger.error(f"Asset not found: '{asset_id}'. Available assets: {list(data_manager.inventory.keys())[:10]}")
            return jsonify({'error': 'Asset not found'}), 404

        if _is_bulk_asset(asset):
            return jsonify({'error': 'Bulk quantity assets do not support maintenance logs'}), 400

        data = request.get_json()
        logger.info(f"Received data: {data}")
        
        if not data:
            return jsonify({'error': 'No data provided'}), 400
            
        # Safely handle potentially None values
        log_entry_text = data.get('logEntry')
        if log_entry_text is None:
            return jsonify({'error': 'Log entry is required'}), 400
        log_entry_text = log_entry_text.strip()
        
        new_location = data.get('newLocation')
        if new_location is not None:
            new_location = new_location.strip()
            # Treat empty string as None
            if not new_location:
                new_location = None
        
        new_serial = data.get('newSerial')
        if new_serial is not None:
            new_serial = new_serial.strip()
            # Treat empty string as None
            if not new_serial:
                new_serial = None
        
        mark_ooc = data.get('markOOC', False)
        unmark_ooc = data.get('unmarkOOC', False)
        mark_missing = data.get('markMissing', False)
        unmark_missing = data.get('unmarkMissing', False)

        if not log_entry_text:
            return jsonify({'error': 'Log entry is required'}), 400

        # Add maintenance log
        # Get maintenance date from request or use current date as fallback
        maintenance_date = data.get('maintenanceDate')
        if maintenance_date:
            try:
                # Parse the date from frontend (YYYY-MM-DD format) and convert to our format (YYYY/MM/DD)
                parsed_date = datetime.strptime(maintenance_date, '%Y-%m-%d')
                formatted_date = parsed_date.strftime("%Y/%m/%d")
            except ValueError:
                # If date parsing fails, use current date
                formatted_date = datetime.now().strftime("%Y/%m/%d")
                logger.warning(f"Invalid maintenance date format: {maintenance_date}, using current date")
        else:
            # If no date provided, use current date
            formatted_date = datetime.now().strftime("%Y/%m/%d")

        # Build status changes information - INITIALIZE HERE
        status_changes = []
        
        if new_location:
            status_changes.append(f"Location: {new_location}")
        if new_serial:
            status_changes.append(f"Serial: {new_serial}")
        if mark_ooc:
            status_changes.append("Marked OOC")
        elif unmark_ooc:
            status_changes.append("Cleared OOC")
        if mark_missing:
            status_changes.append("Marked Missing")
        elif unmark_missing:
            status_changes.append("Cleared Missing")
        
        # Create enhanced log entry with status changes
        status_text = f" [{', '.join(status_changes)}]" if status_changes else ""
        entry = f"{formatted_date}\t{session['user']}\t{log_entry_text}{status_text}"
        
        asset.maintenance_logs.append(entry)

        # Update location if provided
        if new_location:
            old_location = asset.current_location or ''
            asset.current_location = new_location
            log_action(f"Updated location for asset {asset_id} from '{old_location}' to '{new_location}'")

        # Update serial number if provided
        if new_serial:
            old_serial = asset.serial_number or 'None'
            asset.serial_number = new_serial
            log_action(f"Updated serial number for asset {asset_id} from '{old_serial}' to '{new_serial}'")

        # Update OOC status
        if mark_ooc and not asset.is_ooc:
            asset.is_ooc = True
            log_action(f"Marked asset {asset_id} as Out of Commission")
        elif unmark_ooc and asset.is_ooc:
            asset.is_ooc = False
            log_action(f"Removed Out of Commission status from asset {asset_id}")

        # Update Missing status
        if mark_missing and not asset.is_missing:
            asset.is_missing = True
            log_action(f"Marked asset {asset_id} as Missing")
        elif unmark_missing and asset.is_missing:
            asset.is_missing = False
            log_action(f"Removed Missing status from asset {asset_id}")

        # Save changes
        data_manager.save_inventory()

        # Invalidate cache
        invalidate_cache()

        log_action(f"Maintenance logged for asset {asset_id}: {log_entry_text}")

        logger.info(f"Successfully logged maintenance for asset {asset_id}")
        return jsonify({'success': True, 'message': 'Maintenance logged successfully'})
        
    except Exception as e:
        logger.error(f"Error maintaining asset {asset_id}: {e}")
        import traceback
        logger.error(f"Traceback: {traceback.format_exc()}")
        return jsonify({'error': f'Failed to log maintenance: {str(e)}'}), 500

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
                    'startDate': safe_fmt(raw_start),
                    'endDate': safe_fmt(raw_end),
                    'state': getattr(event, 'state', 'Added'),
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
        
        # URL decode the asset_id in case it has special characters
        from urllib.parse import unquote
        asset_id = unquote_plus(asset_id)
        
        asset = data_manager.inventory.get(asset_id)
        if not asset:
            return jsonify({'error': 'Asset not found'}), 404

        data = request.get_json()
        if not data:
            return jsonify({'error': 'No data provided'}), 400
        
        logger.info(f"Enhanced update data: {data}")
        
        # Validate required fields
        new_date = data.get('date')
        new_user = data.get('user')
        new_description = data.get('description')
        
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
        original_log = asset.maintenance_logs[log_index]
        original_parts = original_log.split('\t')
        original_description = '\t'.join(original_parts[2:]) if len(original_parts) >= 3 else original_log
        
        # Handle additional updates - INITIALIZE changes_made HERE
        changes_made = []
        
        # Handle location changes - preserve original log's location if not explicitly changed
        new_location = data.get('newLocation')

        # First, check what location change was originally in this specific log
        original_log_location_change = None
        original_log = asset.maintenance_logs[log_index]
        if original_log:
            original_parts = original_log.split('\t')
            original_description = '\t'.join(original_parts[2:]) if len(original_parts) >= 3 else ''
            if '[' in original_description and ']' in original_description:
                import re
                location_match = re.search(r'Location:\s*([^,\]]+)', original_description)
                if location_match:
                    original_log_location_change = location_match.group(1).strip()

        if new_location is not None and new_location.strip():
            # Only update location if the user actually typed one
            new_location_clean = new_location.strip()
            changes_made.append(f"Location: {new_location_clean}")
            logger.info(f"User set location to: '{new_location_clean}'")
        elif original_log_location_change is not None:
            # User didn't provide location, but original log had a location change - preserve it
            changes_made.append(f"Location: {original_log_location_change}")
            logger.info(f"Preserved original location change: '{original_log_location_change}'")
        # If neither condition is met, no location change is added to the log

        # Update serial ONLY if provided and different
        new_serial = data.get('newSerial')
        if new_serial is not None and new_serial.strip():
            old_serial = asset.serial_number or ''
            new_serial_clean = new_serial.strip()
            if new_serial_clean != old_serial:
                asset.serial_number = new_serial_clean
                changes_made.append(f"Serial: {asset.serial_number}")
                logger.info(f"Updated serial from '{old_serial}' to '{new_serial_clean}'")
        
        # Handle status changes
        mark_ooc = data.get('markOOC', False)
        unmark_ooc = data.get('unmarkOOC', False)
        mark_missing = data.get('markMissing', False)
        unmark_missing = data.get('unmarkMissing', False)
        
        logger.info(f"Status change flags: markOOC={mark_ooc}, unmarkOOC={unmark_ooc}, markMissing={mark_missing}, unmarkMissing={unmark_missing}")
        logger.info(f"Current asset status: OOC={asset.is_ooc}, Missing={asset.is_missing}")
        
        # Apply OOC status changes
        # Store the selected status action in the log, regardless of current asset status.
        # The final asset status is recalculated from all logs below.
        if mark_ooc:
            changes_made.append("Marked OOC")
        elif unmark_ooc:
            changes_made.append("Cleared OOC")

        if mark_missing:
            changes_made.append("Marked Missing")
        elif unmark_missing:
            changes_made.append("Cleared Missing")
            
        logger.info(f"Final changes made: {changes_made}")
        logger.info(f"Final asset status: OOC={asset.is_ooc}, Missing={asset.is_missing}")
        
        # Create updated log entry with status changes
        status_text = f" [{', '.join(changes_made)}]" if changes_made else ""
        updated_log = f"{formatted_date}\t{new_user}\t{new_description}{status_text}"
        
        logger.info(f"Updated log entry: {updated_log}")
        
        asset.maintenance_logs[log_index] = updated_log

        recalculate_asset_status_from_logs(asset)

        # Save changes
        data_manager.save_inventory()

        # Log the action
        changes_text = f" (also: {', '.join(changes_made)})" if changes_made else ""
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
            searchable_text = f"{asset.brand} {asset.model_number} {asset.description} {asset.serial_number}".lower(
            )
            if any(keyword in searchable_text for keyword in keywords):
                # Determine current status
                status = 'available'
                if asset.is_missing:
                    status = 'missing'
                elif asset.is_ooc:
                    status = 'ooc'
                elif asset.asset_id in assigned_assets:
                    status = 'deployed'

                results.append({
                    'id': asset.asset_id,
                    'brand': asset.brand,
                    'model': asset.model_number,
                    'serial': asset.serial_number,
                    'description': asset.description,
                    'department': asset.department_code,
                    'status': status,
                    'location': asset.current_location or asset.default_location,
                    'isMissing': asset.is_missing,
                    'isOOC': asset.is_ooc
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

@app.route('/api/containers', methods=['GET', 'POST'])
@require_auth
def containers_collection():
    """List containers (GET) or create container (POST)"""
    try:
        if request.method == 'GET':
            containers_data = []
            for container in data_manager.containers.values():
                containers_data.append({
                    'id': container.container_id,
                    'assetIds': container.asset_ids,
                    'assetCount': len(container.asset_ids)
                })
            return jsonify({'success': True, 'data': containers_data})

        # POST (create)
        data = request.get_json(silent=True) or {}
        container_id = (data.get('id') or data.get('containerId') or '').strip()
        raw_asset_ids = data.get('assetIds') if 'assetIds' in data else data.get('asset_ids')

        if not container_id:
            return jsonify({'error': 'Container id is required'}), 400

        if container_id in data_manager.containers:
            return jsonify({'error': f"Container '{container_id}' already exists"}), 409

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

        new_container = Container(container_id, cleaned)
        data_manager.containers[container_id] = new_container
        data_manager.save_containers()
        invalidate_cache()
        log_action(f"Created container {container_id} ({len(cleaned)} assets)")

        return jsonify({
            'success': True,
            'data': {'id': new_container.container_id, 'assetIds': new_container.asset_ids, 'assetCount': len(new_container.asset_ids)}
        }), 201

    except Exception as e:
        logger.error(f"Error in containers_collection: {e}")
        return jsonify({'error': 'Failed to process containers request'}), 500

@app.route('/api/containers/<path:container_id>', methods=['GET', 'PUT', 'DELETE'])
@require_auth
def container_resource(container_id):
    """Get one container (GET), update (PUT), delete (DELETE)"""
    try:
        container_id = unquote_plus(container_id).strip()
        container = data_manager.containers.get(container_id)

        if not container:
            return jsonify({'error': 'Container not found'}), 404

        if request.method == 'GET':
            return jsonify({
                'success': True,
                'data': {'id': container.container_id, 'assetIds': container.asset_ids, 'assetCount': len(container.asset_ids)}
            })

        if request.method == 'PUT':
            data = request.get_json(silent=True) or {}

            # optional rename support
            requested_new_id = (data.get('newId') or data.get('new_id') or data.get('id') or '').strip()

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

            # rename (if requested)
            if requested_new_id and requested_new_id != container_id:
                if requested_new_id in data_manager.containers:
                    return jsonify({'error': f"Container '{requested_new_id}' already exists"}), 409

                # re-key the dict and update object
                del data_manager.containers[container_id]
                container.container_id = requested_new_id
                data_manager.containers[requested_new_id] = container
                container_id = requested_new_id

            # update asset list
            container.asset_ids = cleaned
            data_manager.save_containers()
            invalidate_cache()

            if old_id != container_id:
                log_action(f"Renamed container {old_id} -> {container_id} ({len(cleaned)} assets)")
            else:
                log_action(f"Updated container {container_id} ({len(cleaned)} assets)")

            return jsonify({
                'success': True,
                'data': {
                    'id': container.container_id,
                    'assetIds': container.asset_ids,
                    'assetCount': len(container.asset_ids)
                }
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
    """Get activity logs"""
    try:
        # Get all logs (not just last 100) for event activity tracking
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
        if data_manager is None:
            logger.error("Data manager is not initialized")
            return jsonify({'error': 'Data manager not initialized'}), 500
            
        if not hasattr(data_manager, 'events') or data_manager.events is None:
            logger.error("Data manager events not initialized")
            return jsonify({'error': 'Events data not available'}), 500
            
        if not hasattr(data_manager, 'inventory') or data_manager.inventory is None:
            logger.error("Data manager inventory not initialized")
            return jsonify({'error': 'Inventory data not available'}), 500

        logger.info(f"Getting stats - Events: {len(data_manager.events)}, Inventory: {len(data_manager.inventory)}")
        
        total_events = len(data_manager.events)
        active_events = len(
            [e for e in data_manager.events.values() if e.state not in ['Closed']])
        total_assets = len(data_manager.inventory)
        
        # Add error handling for get_assigned_assets
        try:
            assigned_assets = get_assigned_assets()
            deployed_assets = len(assigned_assets)
            logger.info(f"Successfully got assigned assets count: {deployed_assets}")
        except Exception as e:
            logger.error(f"Error getting assigned assets: {e}")
            deployed_assets = 0
            
        missing_assets = len(
            [a for a in data_manager.inventory.values() if a.is_missing])
        ooc_assets = len(
            [a for a in data_manager.inventory.values() if a.is_ooc])

        stats_data = {
            'totalEvents': total_events,
            'activeEvents': active_events,
            'totalAssets': total_assets,
            'deployedAssets': deployed_assets,
            'missingAssets': missing_assets,
            'oocAssets': ooc_assets
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
        current_date = datetime.now().strftime('%Y%m%d')
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
        valid_states = ['Added', 'Planning', 'Preparing', 'Ready', 'Ongoing', 'Last Day', 'Returning', 'Closed', 'Overdue']
        if new_state not in valid_states:
            return jsonify({'error': f'Invalid state. Must be one of: {valid_states}'}), 400
            
        # Get the event
        event = data_manager.events.get(event_id)
        if not event:
            return jsonify({'error': 'Event not found'}), 404
            
        # Store old state for logging
        old_state = event.state
        
        # Force the new state and set override flag
        event.state = new_state
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


@app.errorhandler(Exception)
def handle_exception(e):
    logger.error(f"Unhandled exception: {e}")
    return jsonify({'error': 'An unexpected error occurred'}), 500

def check_and_update_ongoing_events():
    """Periodically check if ready events should become ongoing or overdue"""
    try:
        if data_manager is None:
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
            
            # Log event details for debugging overdue detection
            has_unreturned = len(getattr(event, 'actually_prepared', [])) > len(getattr(event, 'returned_items', []))
            is_past_end = current_date > event.end_date
            
            # (DEBUG)
            # logger.info(f"Event {event.event_id}: {event.name}")
            # logger.info(f"  State: {old_state}, End: {event.end_date}, Current: {current_date}")
            # logger.info(f"  Past end date: {is_past_end}, Has unreturned assets: {has_unreturned}")
            # logger.info(f"  Actually prepared: {len(getattr(event, 'actually_prepared', []))}, Returned: {len(getattr(event, 'returned_items', []))}")
            
            # Always call update_event_state to check for state changes
            update_event_state(event)
            
            if event.state != old_state:
                data_manager.save_event(event)
                updated_count += 1
                ##logger.info(f"  *** STATE CHANGED: {old_state} → {event.state} ***")

                ##DEBUG
            # else:
            #     logger.info(f"  No state change (remains {event.state})")
        
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
    # Handles both model instances and plain dicts defensively
    get = (lambda k, d='': getattr(c, k, getattr(c, k.replace('postalCode', 'postal_code'), d)))
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

    from models import Client
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
        # Initialize data manager
        init_data_manager()
        
        # Start the background thread AFTER data_manager is initialized
        background_started = start_background_thread()
        if not background_started:
            logger.warning("Background thread failed to start - automatic event updates disabled")
        else:
            logger.info("Background thread started successfully after data_manager initialization")

        # Run the Flask app
        app.run(
            debug=False,
            host='127.0.0.1',
            port=5443,
            #ssl_context='adhoc'
        )
        logger.info("app starteded")
    except Exception as e:
        logger.error(f"Failed to start application: {e}")
        raise
