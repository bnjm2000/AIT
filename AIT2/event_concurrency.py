"""Three-way merging for versioned event documents.

Events remain one PostgreSQL row, but their collections have stable logical
identities.  This lets independent edits merge without allowing two writers to
silently overwrite the same requirement, room, assignment, or operational ref.
"""

from __future__ import annotations

import copy
import json
from typing import Any


class EventMergeConflict(ValueError):
    """Raised when both writers changed the same logical event value."""


_MISSING = object()


def _custom_ref_key(value: str) -> str:
    try:
        payload = json.loads(value[len('[CUSTOM]'):])
    except (TypeError, ValueError, json.JSONDecodeError):
        return value
    return f"[CUSTOM]{payload.get('uid') or value}"


def _event_ref_key(value: Any) -> str:
    if not isinstance(value, str):
        return repr(value)
    if value.startswith('[MODEL]'):
        return '[MODEL]' + '|'.join(value[7:].split('|')[:3])
    if value.startswith('[PREPARED]'):
        return '[PREPARED]' + '|'.join(value[10:].split('|')[:3])
    if value.startswith('[BULK]'):
        parts = value[6:].split('|')
        return '[BULK]' + '|'.join((parts + ['', '', ''])[:1] + [(parts + ['', '', ''])[2]])
    if value.startswith('[CUSTOM]'):
        return _custom_ref_key(value)
    return value


def _dict_row_key(value: dict[str, Any], path: tuple[str, ...]) -> str | None:
    for key in ('id', 'lineId', 'uid', 'assignmentId', 'bookingId'):
        if value.get(key) not in (None, ''):
            return f'{key}:{value[key]}'
    if path and path[-1] == 'eventLogs':
        return '|'.join(str(value.get(key) or '') for key in ('timestamp', 'user', 'action'))
    if path and path[-1] == 'items':
        refs = value.get('assetRefs') or []
        if refs:
            return 'refs:' + '|'.join(sorted(_event_ref_key(ref) for ref in refs))
        return 'item:' + '|'.join(str(value.get(key) or '').casefold() for key in (
            'departmentCode', 'department', 'brand', 'model', 'description', 'isCustom'
        ))
    return None


def _list_key(value: Any, path: tuple[str, ...]) -> str:
    if isinstance(value, dict):
        key = _dict_row_key(value, path)
        if key:
            return key
    if isinstance(value, str):
        return _event_ref_key(value)
    return json.dumps(value, ensure_ascii=False, sort_keys=True, default=str)


def _merge_value(base: Any, current: Any, desired: Any, path: tuple[str, ...]) -> Any:
    if desired == base:
        return copy.deepcopy(current)
    if current == base:
        return copy.deepcopy(desired)
    if current == desired:
        return copy.deepcopy(current)

    if isinstance(base, dict) and isinstance(current, dict) and isinstance(desired, dict):
        result = {}
        for key in base.keys() | current.keys() | desired.keys():
            merged = _merge_value(
                base.get(key, _MISSING),
                current.get(key, _MISSING),
                desired.get(key, _MISSING),
                path + (str(key),),
            )
            if merged is not _MISSING:
                result[key] = merged
        return result

    if isinstance(base, list) and isinstance(current, list) and isinstance(desired, list):
        return _merge_list(base, current, desired, path)

    if base is _MISSING:
        if current is _MISSING:
            return copy.deepcopy(desired)
        if desired is _MISSING or current == desired:
            return copy.deepcopy(current)
    elif current is _MISSING or desired is _MISSING:
        # A deletion racing an edit is never safe to infer.
        raise EventMergeConflict(f"Concurrent delete and edit at {'.'.join(path)}")

    raise EventMergeConflict(f"Concurrent edits at {'.'.join(path)}")


def _merge_list(base: list[Any], current: list[Any], desired: list[Any], path: tuple[str, ...]) -> list[Any]:
    base_map = {_list_key(value, path): value for value in base}
    current_map = {_list_key(value, path): value for value in current}
    desired_map = {_list_key(value, path): value for value in desired}
    merged_map = {}
    for key in base_map.keys() | current_map.keys() | desired_map.keys():
        merged = _merge_value(
            base_map.get(key, _MISSING),
            current_map.get(key, _MISSING),
            desired_map.get(key, _MISSING),
            path + (key,),
        )
        if merged is not _MISSING:
            merged_map[key] = merged

    base_order = [_list_key(value, path) for value in base]
    current_order = [_list_key(value, path) for value in current]
    desired_order = [_list_key(value, path) for value in desired]

    base_keys = set(base_order)
    desired_existing_order = [key for key in desired_order if key in base_keys]
    base_retained_order = [key for key in base_order if key in set(desired_order)]
    desired_reordered_existing = desired_existing_order != base_retained_order
    preferred = desired_order if desired_reordered_existing else current_order
    order = list(dict.fromkeys(preferred + current_order + desired_order))
    return [copy.deepcopy(merged_map[key]) for key in order if key in merged_map]


def merge_event_payloads(base: dict, current: dict, desired: dict) -> dict:
    """Merge an event edit against the latest stored event payload."""
    merged = _merge_value(base or {}, current or {}, desired or {}, ('event',))
    if not isinstance(merged, dict):
        raise EventMergeConflict('Event payload is not an object')
    return merged
