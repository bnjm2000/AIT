"""Three-way merge helpers for concurrently edited finance documents."""

from __future__ import annotations

import copy


_MISSING = object()
_SERVER_OWNED_FIELDS = frozenset({
    'documentVersion',
    'updatedAt',
    'updatedBy',
    'updatedByName',
    'totals',
    'vendorDiscrepancies',
    'checksum',
    'quotationLineCount',
    'costingLineCount',
})


class FinanceMergeConflict(ValueError):
    """Raised when two editors changed the same finance value differently."""

    def __init__(self, path):
        self.path = tuple(str(part) for part in path)
        label = '.'.join(self.path) or 'document'
        super().__init__(f'Conflicting concurrent change at {label}')


def _row_identity(row, list_path):
    if not isinstance(row, dict):
        return ''
    row_id = str(row.get('id') or '').strip()
    if row_id:
        return f'id:{row_id}'
    if list_path and list_path[-1] == 'revisions':
        revision = str(row.get('revision') or '').strip()
        if revision:
            return f'revision:{revision}'
    return ''


def _is_keyed_row_list(values, path):
    rows = [row for value in values for row in value]
    return bool(rows) and all(_row_identity(row, path) for row in rows)


def _changed(value, base):
    return value != base


def _merge_keyed_rows(base, local, remote, path):
    base_by_id = {_row_identity(row, path): row for row in base}
    local_by_id = {_row_identity(row, path): row for row in local}
    remote_by_id = {_row_identity(row, path): row for row in remote}
    all_ids = set(base_by_id) | set(local_by_id) | set(remote_by_id)
    merged_by_id = {}

    for row_id in all_ids:
        base_row = base_by_id.get(row_id, _MISSING)
        local_row = local_by_id.get(row_id, _MISSING)
        remote_row = remote_by_id.get(row_id, _MISSING)

        if local_row is _MISSING:
            if base_row is _MISSING:
                merged_by_id[row_id] = copy.deepcopy(remote_row)
            elif remote_row is _MISSING or remote_row == base_row:
                continue
            else:
                raise FinanceMergeConflict((*path, row_id, 'deleted'))
            continue
        if remote_row is _MISSING:
            if base_row is _MISSING:
                merged_by_id[row_id] = copy.deepcopy(local_row)
            elif local_row == base_row:
                continue
            else:
                raise FinanceMergeConflict((*path, row_id, 'deleted'))
            continue
        if base_row is _MISSING:
            if local_row != remote_row:
                raise FinanceMergeConflict((*path, row_id))
            merged_by_id[row_id] = copy.deepcopy(local_row)
            continue
        merged_by_id[row_id] = three_way_merge(
            base_row,
            local_row,
            remote_row,
            (*path, row_id),
        )

    base_ids = [_row_identity(row, path) for row in base]
    local_ids = [_row_identity(row, path) for row in local]
    remote_ids = [_row_identity(row, path) for row in remote]
    common_ids = set(base_ids) & set(local_ids) & set(remote_ids)
    base_common = [row_id for row_id in base_ids if row_id in common_ids]
    local_common = [row_id for row_id in local_ids if row_id in common_ids]
    remote_common = [row_id for row_id in remote_ids if row_id in common_ids]
    local_reordered = local_common != base_common
    remote_reordered = remote_common != base_common
    if local_reordered and remote_reordered and local_common != remote_common:
        raise FinanceMergeConflict((*path, 'order'))

    preferred_order = local_ids if local_reordered or not remote_reordered else remote_ids
    secondary_order = remote_ids if preferred_order is local_ids else local_ids
    ordered_ids = []
    for row_id in [*preferred_order, *secondary_order]:
        if row_id in merged_by_id and row_id not in ordered_ids:
            ordered_ids.append(row_id)
    return [merged_by_id[row_id] for row_id in ordered_ids]


def three_way_merge(base, local, remote, path=()):
    """Merge non-overlapping changes and reject ambiguous same-value edits."""
    if local == base:
        return copy.deepcopy(remote)
    if remote == base or local == remote:
        return copy.deepcopy(local)

    if isinstance(base, dict) and isinstance(local, dict) and isinstance(remote, dict):
        merged = {}
        for key in set(base) | set(local) | set(remote):
            if key.startswith('_'):
                continue
            base_value = base.get(key, _MISSING)
            local_value = local.get(key, _MISSING)
            remote_value = remote.get(key, _MISSING)
            key_path = (*path, key)

            if key in _SERVER_OWNED_FIELDS:
                if remote_value is not _MISSING:
                    merged[key] = copy.deepcopy(remote_value)
                elif local_value is not _MISSING:
                    merged[key] = copy.deepcopy(local_value)
                continue
            if local_value is _MISSING:
                if remote_value is _MISSING or remote_value == base_value:
                    continue
                raise FinanceMergeConflict((*key_path, 'deleted'))
            if remote_value is _MISSING:
                if local_value == base_value:
                    continue
                raise FinanceMergeConflict((*key_path, 'deleted'))
            if base_value is _MISSING:
                if local_value != remote_value:
                    raise FinanceMergeConflict(key_path)
                merged[key] = copy.deepcopy(local_value)
                continue
            merged[key] = three_way_merge(
                base_value,
                local_value,
                remote_value,
                key_path,
            )
        return merged

    if isinstance(base, list) and isinstance(local, list) and isinstance(remote, list):
        if _is_keyed_row_list((base, local, remote), path):
            return _merge_keyed_rows(base, local, remote, path)
        raise FinanceMergeConflict(path)

    raise FinanceMergeConflict(path)


def changed_document_ids(base_payload, changed_payload):
    """Return document IDs whose metadata or canonical line record changed."""
    base_documents = {
        str(row.get('id') or ''): row
        for row in (base_payload or {}).get('documents') or []
        if isinstance(row, dict) and row.get('id')
    }
    changed_documents = {
        str(row.get('id') or ''): row
        for row in (changed_payload or {}).get('documents') or []
        if isinstance(row, dict) and row.get('id')
    }
    changed_ids = {
        document_id
        for document_id in set(base_documents) | set(changed_documents)
        if base_documents.get(document_id) != changed_documents.get(document_id)
    }

    base_lines = (base_payload or {}).get('linkedLineItems') or {}
    changed_lines = (changed_payload or {}).get('linkedLineItems') or {}
    for quotation_id in set(base_lines) | set(changed_lines):
        if base_lines.get(quotation_id) == changed_lines.get(quotation_id):
            continue
        changed_ids.add(str(quotation_id))
        for record in (base_lines.get(quotation_id), changed_lines.get(quotation_id)):
            if isinstance(record, dict) and record.get('costingId'):
                changed_ids.add(str(record['costingId']))
    return changed_ids
