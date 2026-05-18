import json
import re
import secrets
from datetime import datetime
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP


STATUS_CHANGE_KINDS = ('ooc', 'missing', 'degraded', 'disposed')
DEFAULT_MAINTENANCE_LOG_TYPE = 'General'
ASSET_CHECK_LOG_TYPE = 'Asset check'
USER_MAINTENANCE_LOG_TYPES = (
    DEFAULT_MAINTENANCE_LOG_TYPE,
    'Preventative maintenance',
    'Fault',
    'Update',
    'Repair',
)
MAINTENANCE_LOG_TYPES = USER_MAINTENANCE_LOG_TYPES + (ASSET_CHECK_LOG_TYPE,)


OOC_MARKED = {
    'marked ooc',
    'mark ooc',
    'marked out of commission',
    'mark out of commission',
}

OOC_CLEARED = {
    'cleared ooc',
    'clear ooc',
    'removed ooc',
    'unmarked ooc',
    'unmark ooc',
    'cleared out of commission',
    'removed out of commission',
}

MISSING_MARKED = {
    'marked missing',
    'mark missing',
}

MISSING_CLEARED = {
    'cleared missing',
    'clear missing',
    'removed missing',
    'unmarked missing',
    'unmark missing',
}

DEGRADED_MARKED = {
    'marked degraded',
    'mark degraded',
}

DEGRADED_CLEARED = {
    'cleared degraded',
    'clear degraded',
    'removed degraded',
    'unmarked degraded',
    'unmark degraded',
}

DISPOSED_MARKED = {
    'marked disposed',
    'mark disposed',
    'disposed',
}

DISPOSED_CLEARED = {
    'cleared disposed',
    'clear disposed',
    'removed disposed',
    'unmarked disposed',
    'unmark disposed',
}


def _text(value):
    return '' if value is None else str(value)


def format_maintenance_cost(value):
    raw = _text(value).strip()
    if not raw:
        return ''

    cleaned = raw.replace(',', '')
    if cleaned.startswith('$'):
        cleaned = cleaned[1:].strip()

    try:
        amount = Decimal(cleaned)
    except (InvalidOperation, ValueError):
        return raw

    if not amount.is_finite():
        return raw

    return str(amount.quantize(Decimal('0.01'), rounding=ROUND_HALF_UP))


def normalize_maintenance_log_type(value, allow_asset_check=True):
    raw = _text(value).strip()
    if not raw:
        return DEFAULT_MAINTENANCE_LOG_TYPE

    lookup = {log_type.lower(): log_type for log_type in MAINTENANCE_LOG_TYPES}
    normalized = lookup.get(raw.lower())
    if not normalized:
        return None
    if normalized == ASSET_CHECK_LOG_TYPE and not allow_asset_check:
        return None
    return normalized


def normalize_maintenance_log_source(source):
    if not isinstance(source, dict):
        return {}

    clean_source = {}
    for key, value in source.items():
        clean_key = _text(key).strip()
        if not clean_key:
            continue
        if isinstance(value, (str, int, float, bool)) or value is None:
            clean_source[clean_key] = _text(value).strip()
    return clean_source


def make_maintenance_log_id():
    return secrets.token_hex(12)


def normalize_maintenance_media(media):
    if not media:
        return []

    if isinstance(media, dict):
        media = [media]

    if not isinstance(media, list):
        return []

    records = []
    for item in media:
        if not isinstance(item, dict):
            continue

        media_id = _text(item.get('id') or item.get('mediaId')).strip()
        path = _text(item.get('path') or item.get('storedPath')).strip().replace('\\', '/')
        name = _text(item.get('name') or item.get('filename') or item.get('originalName')).strip()
        kind = _text(item.get('kind') or item.get('type')).strip().lower()
        mime_type = _text(item.get('mimeType') or item.get('contentType')).strip()

        if not media_id or not path:
            continue

        path_parts = [part for part in path.split('/') if part]
        if path.startswith('/') or '..' in path_parts:
            continue

        if kind not in ('image', 'video'):
            extension = path.rsplit('.', 1)[-1].lower() if '.' in path else ''
            kind = 'video' if extension in ('mp4', 'mov') else 'image'

        try:
            size = int(item.get('size') or 0)
        except (TypeError, ValueError):
            size = 0

        records.append({
            'id': media_id,
            'name': name or media_id,
            'path': '/'.join(path_parts),
            'kind': kind,
            'mimeType': mime_type,
            'size': max(0, size),
        })

    return records


def normalize_change(change):
    if not isinstance(change, dict):
        return None

    kind = _text(change.get('kind') or change.get('type')).strip().lower()
    if kind in ('location', 'serial'):
        value = _text(change.get('value')).strip()
        return {'kind': kind, 'value': value} if value else None

    if kind in STATUS_CHANGE_KINDS:
        action = _text(change.get('action')).strip().lower()
        if action in ('mark', 'marked'):
            return {'kind': kind, 'action': 'marked'}
        if action in ('clear', 'cleared', 'remove', 'removed', 'unmark', 'unmarked'):
            return {'kind': kind, 'action': 'cleared'}

    return None


def make_change(kind, value=None, action=None):
    change = {'kind': kind}
    if value is not None:
        change['value'] = value
    if action is not None:
        change['action'] = action
    return normalize_change(change)


def normalize_changes(changes):
    if not changes:
        return []

    if isinstance(changes, dict):
        normalized = []
        for kind in ('location', 'serial'):
            if changes.get(kind):
                normalized.append(make_change(kind, value=changes.get(kind)))
        for kind in STATUS_CHANGE_KINDS:
            if changes.get(kind):
                normalized.append(make_change(kind, action=changes.get(kind)))
        return [change for change in normalized if change]

    normalized = []
    if isinstance(changes, list):
        for change in changes:
            clean_change = normalize_change(change)
            if clean_change:
                normalized.append(clean_change)
    return normalized


def _legacy_change_from_part(part):
    part = _text(part).strip()
    part_lower = part.lower()

    if part_lower.startswith('location:'):
        return make_change('location', value=part.split(':', 1)[1].strip())
    if part_lower.startswith('serial:'):
        return make_change('serial', value=part.split(':', 1)[1].strip())
    if part_lower in OOC_MARKED:
        return make_change('ooc', action='marked')
    if part_lower in OOC_CLEARED:
        return make_change('ooc', action='cleared')
    if part_lower in MISSING_MARKED:
        return make_change('missing', action='marked')
    if part_lower in MISSING_CLEARED:
        return make_change('missing', action='cleared')
    if part_lower in DEGRADED_MARKED:
        return make_change('degraded', action='marked')
    if part_lower in DEGRADED_CLEARED:
        return make_change('degraded', action='cleared')
    if part_lower in DISPOSED_MARKED:
        return make_change('disposed', action='marked')
    if part_lower in DISPOSED_CLEARED:
        return make_change('disposed', action='cleared')

    return None


def split_legacy_status_suffix(description):
    """Return (description, changes) for old logs with a final [status] suffix."""
    description = _text(description)
    match = re.match(r'^(.*?)(?:\s*\[([^\]]*)\]\s*)$', description, re.S)
    if not match:
        return description, []

    status_text = match.group(2)
    changes = []
    for part in status_text.split(','):
        change = _legacy_change_from_part(part)
        if change:
            changes.append(change)

    if not changes:
        return description, []

    return match.group(1).rstrip(), changes


def normalize_maintenance_log(log):
    if isinstance(log, dict):
        if not any(key in log for key in ('date', 'user', 'description', 'changes')):
            entry = log.get('entry') or log.get('log')
            if entry:
                return normalize_maintenance_log(entry)

        return {
            'id': _text(log.get('id') or log.get('logId')).strip(),
            'date': _text(log.get('date')).strip(),
            'user': _text(log.get('user')).strip(),
            'description': _text(log.get('description')),
            'type': (
                normalize_maintenance_log_type(
                    log.get('type') or log.get('logType') or log.get('maintenanceType')
                ) or DEFAULT_MAINTENANCE_LOG_TYPE
            ),
            'cost': format_maintenance_cost(log.get('cost')),
            'changes': normalize_changes(log.get('changes') or log.get('statusChanges')),
            'source': normalize_maintenance_log_source(log.get('source')),
            'media': normalize_maintenance_media(log.get('media') or log.get('attachments')),
        }

    raw = _text(log)
    stripped = raw.strip()
    if stripped.startswith('{') and stripped.endswith('}'):
        try:
            decoded = json.loads(stripped)
            if isinstance(decoded, dict):
                return normalize_maintenance_log(decoded)
        except (TypeError, ValueError):
            pass

    parts = raw.split('\t')
    if len(parts) >= 3:
        date = parts[0].strip()
        user = parts[1].strip()
        description = '\t'.join(parts[2:])
    else:
        date = ''
        user = ''
        description = raw

    description, changes = split_legacy_status_suffix(description)
    return {
        'id': '',
        'date': date,
        'user': user,
        'description': description,
        'type': DEFAULT_MAINTENANCE_LOG_TYPE,
        'cost': '',
        'changes': changes,
        'source': {},
        'media': [],
    }


def make_maintenance_log(date, user, description, changes=None, cost='', log_type=DEFAULT_MAINTENANCE_LOG_TYPE, source=None, log_id=None, media=None):
    return normalize_maintenance_log({
        'id': log_id or make_maintenance_log_id(),
        'date': date,
        'user': user,
        'description': description,
        'type': log_type,
        'cost': cost,
        'changes': changes or [],
        'source': source or {},
        'media': media or [],
    })


def load_maintenance_logs(value):
    raw = _text(value).strip()
    if not raw:
        return []

    try:
        decoded = json.loads(raw)
        if isinstance(decoded, list):
            return [normalize_maintenance_log(log) for log in decoded]
        if isinstance(decoded, dict):
            return [normalize_maintenance_log(decoded)]
    except (TypeError, ValueError):
        pass

    return [normalize_maintenance_log(log) for log in raw.split('|') if log]


def dump_maintenance_logs(logs):
    records = [normalize_maintenance_log(log) for log in (logs or [])]
    if not records:
        return ''
    for record in records:
        if not record.get('id'):
            record.pop('id', None)
        if not record.get('media'):
            record.pop('media', None)
    return json.dumps(records, ensure_ascii=False, separators=(',', ':'))


def parse_maintenance_log_date(log):
    raw_date = normalize_maintenance_log(log).get('date', '')
    for fmt in ("%Y/%m/%d", "%Y-%m-%d", "%Y%m%d"):
        try:
            return datetime.strptime(raw_date, fmt).date()
        except ValueError:
            pass
    return None


def status_change_labels(log_or_changes):
    changes = (
        normalize_maintenance_log(log_or_changes).get('changes', [])
        if not isinstance(log_or_changes, list)
        else normalize_changes(log_or_changes)
    )
    labels = []

    status_clear_kinds = {
        change.get('kind')
        for change in changes
        if change.get('kind') in STATUS_CHANGE_KINDS and change.get('action') == 'cleared'
    }
    status_marked = [
        change.get('kind')
        for change in changes
        if change.get('kind') in STATUS_CHANGE_KINDS and change.get('action') == 'marked'
    ]

    # A log that clears every status is shown as one clean "Marked OK" label.
    # This keeps the maintenance table readable even though the stored log keeps
    # explicit clear actions for backward-compatible recalculation.
    all_statuses_cleared = set(STATUS_CHANGE_KINDS).issubset(status_clear_kinds)

    for change in changes:
        kind = change.get('kind')
        if kind == 'location':
            labels.append(f"Location: {change.get('value', '')}")
        elif kind == 'serial':
            labels.append(f"Serial: {change.get('value', '')}")
        elif kind in STATUS_CHANGE_KINDS:
            if all_statuses_cleared and change.get('action') == 'cleared':
                continue
            if change.get('action') == 'marked':
                labels.append({
                    'ooc': 'Marked OOC',
                    'missing': 'Marked Missing',
                    'degraded': 'Marked Degraded',
                    'disposed': 'Marked Disposed',
                }.get(kind, f"Marked {kind.title()}"))
            else:
                labels.append({
                    'ooc': 'Cleared OOC',
                    'missing': 'Cleared Missing',
                    'degraded': 'Cleared Degraded',
                    'disposed': 'Cleared Disposed',
                }.get(kind, f"Cleared {kind.title()}"))

    if all_statuses_cleared and not status_marked:
        labels.append('Marked OK')

    return labels


def maintenance_log_to_display_string(log, include_changes=False):
    record = normalize_maintenance_log(log)
    base = f"{record['date']}\t{record['user']}\t{record['description']}"
    if record.get('cost'):
        base = f"{base} (Cost: ${record.get('cost')})"
    if include_changes:
        labels = status_change_labels(record)
        if labels:
            base = f"{base} (Status changes: {', '.join(labels)})"
    return base


def _set_exclusive_asset_status(asset, status):
    """Apply one mutually-exclusive asset condition status."""
    for attr in ('is_ooc', 'is_missing', 'is_degraded', 'is_disposed'):
        setattr(asset, attr, False)

    if status == 'ooc':
        asset.is_ooc = True
    elif status == 'missing':
        asset.is_missing = True
    elif status == 'degraded':
        asset.is_degraded = True
    elif status == 'disposed':
        asset.is_disposed = True


def apply_maintenance_log_changes(asset, log):
    for change in normalize_maintenance_log(log).get('changes', []):
        kind = change.get('kind')
        if kind == 'location':
            asset.current_location = change.get('value', '').strip()
        elif kind == 'serial':
            asset.serial_number = change.get('value', '').strip()
        elif kind in STATUS_CHANGE_KINDS:
            if change.get('action') == 'marked':
                # Statuses are mutually exclusive. Marking any one of these
                # clears the others, so an item cannot be OOC and Missing, etc.
                _set_exclusive_asset_status(asset, kind)
            else:
                setattr(asset, {
                    'ooc': 'is_ooc',
                    'missing': 'is_missing',
                    'degraded': 'is_degraded',
                    'disposed': 'is_disposed',
                }[kind], False)
