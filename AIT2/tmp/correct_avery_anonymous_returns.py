"""Remove uncertain Avery asset identities, retaining prepared/returned quantities.

Dry run by default. --apply writes only the reviewed event fields in one
version-checked transaction after validating with the app in an isolated clone.
"""
import copy
import datetime as dt
import json
import os
import sys
import tempfile
from pathlib import Path

import psycopg
from dotenv import load_dotenv
from psycopg.types.json import Jsonb

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
load_dotenv(ROOT / '.env')
COMPANY = 'AVERY'
FIELDS = {
    'preparedItems': 'prepared_items',
    'actuallyPrepared': 'actually_prepared',
    'returnedItems': 'returned_items',
    'extraAssets': 'extra_assets',
    'subprojects': 'subprojects',
}


def specific_refs(data):
    refs = [ref for field in FIELDS if field != 'subprojects'
            for ref in data.get(field, [])]
    for room in data.get('subprojects', []):
        refs.extend(room.get('extraRefs', []))
        for item in room.get('items', []):
            refs.extend(item.get('assetRefs', []))
    return {ref for ref in refs if isinstance(ref, str) and not ref.startswith('[')}


def load_event(data):
    return Event(
        event_id=data['eventId'], name=data['name'],
        start_date=data['startDate'], end_date=data['endDate'],
        asset_models=copy.deepcopy(data.get('assetModels') or []),
        location=data.get('location', ''), state=data['state'],
        prepared_items=copy.deepcopy(data.get('preparedItems') or []),
        actually_prepared=copy.deepcopy(data.get('actuallyPrepared') or []),
        returned_items=copy.deepcopy(data.get('returnedItems') or []),
        extra_assets=copy.deepcopy(data.get('extraAssets') or []),
        custom_collected=copy.deepcopy(data.get('customCollected') or []),
        subprojects=copy.deepcopy(data.get('subprojects') or []),
        notes=data.get('notes', ''), event_logs=copy.deepcopy(data.get('eventLogs') or []),
        tag=data.get('tag', 'events'), force_state_override=data.get('forceStateOverride', False),
        assigned_users=data.get('assignedUsers') or [],
        delivery_order=copy.deepcopy(data.get('deliveryOrder') or {}),
        vendor_management=copy.deepcopy(data.get('vendorManagement') or []),
    )


def details(client, eid):
    response = client.get(f'/api/events/{eid}')
    assert response.status_code == 200, response.get_data(as_text=True)
    return response.get_json()['data']


def totals(data):
    keys = ['totalAssets', 'totalPrepared', 'totalReturned', 'totalExtraAssets',
            'totalExtraPrepared', 'returnableCount', 'returnableTotalCount']
    return {key: data[key] for key in keys}


def group_totals(data):
    keys = ['requiredQuantity', 'preparedEverQuantity', 'returnedQuantity',
            'countablePreparedEverQuantity', 'extraPreparedEverQuantity']
    return {key: {field: group[field] for field in keys}
            for key, group in data['modelGroups'].items()}


def main():
    apply = '--apply' in sys.argv
    with psycopg.connect(os.environ['DATABASE_URL'], connect_timeout=10,
                         options='-c default_transaction_read_only=on') as connection:
        rows = connection.execute(
            'SELECT event_id, version, data FROM aim_events WHERE company_code=%s ORDER BY event_id',
            (COMPANY,),
        ).fetchall()
        inventory = connection.execute(
            'SELECT asset_id, data FROM aim_inventory WHERE company_code=%s', (COMPANY,),
        ).fetchall()
    assert len(rows) == 5, 'Avery event scope changed; review before proceeding'
    assert [eid for eid, _, data in rows if specific_refs(data)] in ([1, 3, 4], []), 'Target scope changed'

    changes = []
    reports = []
    with tempfile.TemporaryDirectory(prefix='avery-anonymous-') as folder:
        manager = DataManager(folder)
        manager.setup_data_folder()
        manager.users = {'correction-audit': User('correction-audit', hash_password('local-only', 'audit'),
                                                'audit', True, True, role='owner')}
        manager.save_users()
        manager.inventory = {asset_id: InventoryItem(
            asset_id=asset_id, brand=data.get('brand', ''), model_number=data.get('modelNumber', ''),
            serial_number=data.get('serialNumber', ''), description=data.get('description', ''),
            is_missing=data.get('isMissing', False), maintenance_logs=[],
            department_code=data.get('departmentCode', 'UN'),
            default_location=data.get('defaultLocation', ''), current_location=data.get('currentLocation', ''),
            is_bulk=data.get('isBulk', False), quantity=data.get('quantity', 1),
            is_untagged=data.get('isUntagged', False), version=data.get('version', ''),
        ) for asset_id, data in inventory}
        manager.save_inventory()
        manager.events = {eid: load_event(data) for eid, _, data in rows}
        for event in manager.events.values():
            manager.save_event(event)
        app_module.app.config['TESTING'] = True
        app_module.set_data_manager_for_testing(manager)
        client = app_module.app.test_client()
        with client.session_transaction() as session:
            session.update(user='correction-audit', is_admin=True, role='owner', company_code=COMPANY)

        for eid, version, original in rows:
            ids = specific_refs(original)
            before = details(client, eid)
            if not ids:
                assert before['totalPrepared'] == before['totalAssets'] == before['totalReturned']
                assert before['returnableCount'] == 0
                reports.append({'eventId': eid, 'name': original['name'], 'removedAssetLinks': 0,
                                'verified': True, **totals(before)})
                continue

            # Start from the exact database payload, not GET-induced normalization.
            event = load_event(original)
            manager.events[eid] = event
            assert ids <= set(original['returnedItems']), 'Unexpected unreturned specific asset'
            assert not (ids & set(original['actuallyPrepared'])), 'Unexpected active specific asset'
            for asset_id in sorted(ids):
                asset = manager.inventory[asset_id]
                assert not asset.is_bulk
                assert asset.current_location == (asset.default_location or ''), 'Unexpected current asset location'
                group = {'department': asset.department_code, 'brand': asset.brand,
                         'model': asset.model_number, 'description': asset.description}
                # Undo return, unassign, prepare anonymously, and return, as one
                # final-state correction so no asset is temporarily redeployed.
                for attr in ('prepared_items', 'actually_prepared', 'returned_items', 'extra_assets'):
                    setattr(event, attr, [ref for ref in getattr(event, attr) if ref != asset_id])
                app_module._event_subproject_remove_ref(event, asset_id)
                app_module._increment_returned_prepared_model_slot(event, group, 1)
            app_module._reconcile_event_subproject_prepared_slots(event)
            app_module._reconcile_event_subproject_extras(event)

            corrected = copy.deepcopy(original)
            for field, attr in FIELDS.items():
                corrected[field] = copy.deepcopy(getattr(event, attr))
            assert not specific_refs(corrected)
            # Requirement lines, quantities, finance and nonphysical items stay intact.
            assert corrected['preparedItems'] == [ref for ref in original['preparedItems'] if ref not in ids]
            for old_room, new_room in zip(original['subprojects'], corrected['subprojects']):
                assert len(old_room['items']) == len(new_room['items'])
                for old_item, new_item in zip(old_room['items'], new_room['items']):
                    allowed = {'assetRefs', 'preparedQuantity', 'returnedPreparedQuantity'}
                    assert {k:v for k,v in old_item.items() if k not in allowed} == {k:v for k,v in new_item.items() if k not in allowed}

            manager.save_event(event)
            app_module.invalidate_cache()
            after = details(client, eid)
            assert totals(before) == totals(after), (eid, totals(before), totals(after))
            assert group_totals(before) == group_totals(after), (eid, group_totals(before), group_totals(after))
            assert after['totalPrepared'] == after['totalAssets'] == after['totalReturned']
            assert after['returnableCount'] == 0
            for group in after['modelGroups'].values():
                assert all(asset.get('isBulk') for asset in group['assignedAssets']), (eid, group)
            assert not specific_refs({field: getattr(manager.events[eid], attr) for field, attr in FIELDS.items()})
            for stage in ('prepare', 'return'):
                assert after['workflowProgress'][stage]['status'] == 'green', (eid, stage)

            action = (f'Corrected uncertain historical asset identities at user request: removed {len(ids)} '
                      f'specific asset ID link(s); recorded the same quantities as prepared and returned '
                      f'without assignment. Required quantities and returned extras preserved.')
            stamp = dt.datetime.now().strftime('%Y/%m/%d %H:%M:%S')
            corrected.setdefault('eventLogs', []).append({'timestamp': stamp, 'user': 'Codex', 'action': action})
            changes.append({'eventId': eid, 'version': version, 'before': original, 'after': corrected,
                            'removedAssetIds': sorted(ids), 'action': action, 'timestamp': stamp})
            reports.append({'eventId': eid, 'name': original['name'], 'removedAssetLinks': len(ids),
                            'verified': True, **totals(after)})

    backup_path = None
    if apply and changes:
        backup_path = ROOT / 'output' / ('avery-anonymous-returns-backup-' + dt.datetime.now().strftime('%Y%m%d-%H%M%S') + '.json')
        backup_path.parent.mkdir(parents=True, exist_ok=True)
        backup_path.write_text(json.dumps({'company': COMPANY, 'changes': changes, 'verification': reports}, indent=2), encoding='utf-8')
        with psycopg.connect(os.environ['DATABASE_URL'], connect_timeout=10) as connection:
            connection.execute("SET LOCAL lock_timeout = '10s'")
            connection.execute("SET LOCAL statement_timeout = '30s'")
            revision = connection.execute('SELECT revision FROM aim_company_revisions WHERE company_code=%s FOR UPDATE', (COMPANY,)).fetchone()
            assert revision is not None
            current = connection.execute('SELECT event_id,version,data FROM aim_events WHERE company_code=%s ORDER BY event_id FOR UPDATE', (COMPANY,)).fetchall()
            assert current == rows, 'Concurrent event update: no changes saved; rerun review'
            for change in changes:
                result = connection.execute(
                    'UPDATE aim_events SET data=%s, version=version+1, updated_at=CURRENT_TIMESTAMP '
                    'WHERE company_code=%s AND event_id=%s AND version=%s RETURNING version',
                    (Jsonb(change['after']), COMPANY, change['eventId'], change['version']),
                ).fetchone()
                assert result == (change['version'] + 1,)
                connection.execute('INSERT INTO aim_system_logs(company_code,timestamp_text,username,action) VALUES (%s,%s,%s,%s)',
                                   (COMPANY, change['timestamp'], 'Codex', f"Event {change['eventId']}: {change['action']}"))
            connection.execute('UPDATE aim_company_revisions SET revision=revision+1,updated_at=CURRENT_TIMESTAMP WHERE company_code=%s', (COMPANY,))
        with psycopg.connect(os.environ['DATABASE_URL'], connect_timeout=10,
                             options='-c default_transaction_read_only=on') as connection:
            saved = connection.execute('SELECT event_id,version,data FROM aim_events WHERE company_code=%s ORDER BY event_id', (COMPANY,)).fetchall()
            expected = {change['eventId']: change['after'] for change in changes}
            for eid, version, data in saved:
                assert not specific_refs(data)
                if eid in expected:
                    assert data == expected[eid]
                else:
                    assert (eid, version, data) in rows
    print(json.dumps({'applied': apply, 'changedEvents': len(changes),
                      'removedAssetLinks': sum(len(change['removedAssetIds']) for change in changes),
                      'backup': str(backup_path) if backup_path else None, 'verification': reports}, indent=2))


if __name__ == '__main__':
    import app as app_module
    from data_manager import DataManager
    from models import Event, InventoryItem, User, hash_password
    main()
