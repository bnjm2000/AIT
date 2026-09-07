import json
import os
import sys
import tempfile
from pathlib import Path
import psycopg
from dotenv import load_dotenv

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
load_dotenv(Path(__file__).resolve().parents[1] / '.env')
with psycopg.connect(os.environ['DATABASE_URL'], connect_timeout=10,
                     options='-c default_transaction_read_only=on') as connection:
    raw = connection.execute('SELECT data FROM aim_events WHERE company_code=%s AND event_id=%s', ('AVPL', 163)).fetchone()[0]
    inventory = connection.execute('SELECT asset_id, data FROM aim_inventory WHERE company_code=%s', ('AVPL',)).fetchall()

import app as app_module
from data_manager import DataManager
from models import Event, InventoryItem, User, hash_password

with tempfile.TemporaryDirectory() as folder:
    manager = DataManager(folder)
    manager.setup_data_folder()
    manager.users = {'audit': User('audit', hash_password('audit', 'audit'), 'audit', True, True, role='owner')}
    manager.save_users()
    manager.inventory = {asset_id: InventoryItem(
        asset_id=asset_id, brand=data.get('brand', ''), model_number=data.get('modelNumber', ''),
        description=data.get('description', ''), serial_number=data.get('serialNumber', ''),
        department_code=data.get('departmentCode', 'UN'), is_bulk=data.get('isBulk', False),
        quantity=data.get('quantity', 1), is_untagged=data.get('isUntagged', False),
        is_missing=data.get('isMissing', False), maintenance_logs=[],
    ) for asset_id, data in inventory}
    manager.save_inventory()
    event = Event(163, raw.get('name', ''), raw.get('startDate', ''), raw.get('endDate', ''),
        raw.get('assetModels') or [], location=raw.get('location', ''),
        prepared_items=raw.get('preparedItems') or [], returned_items=raw.get('returnedItems') or [],
        state=raw.get('state', 'New'), actually_prepared=raw.get('actuallyPrepared') or [],
        extra_assets=raw.get('extraAssets') or [], custom_collected=raw.get('customCollected') or [],
        subprojects=raw.get('subprojects') or [], vendor_management=raw.get('vendorManagement') or [],
        tag=raw.get('tag', 'events'), force_state_override=raw.get('forceStateOverride', False))
    manager.events = {163: event}
    manager.save_event(event)
    app_module.app.config['TESTING'] = True
    app_module.set_data_manager_for_testing(manager)
    client = app_module.app.test_client()
    with client.session_transaction() as session:
        session.update(user='audit', is_admin=True, role='owner', company_code='AVPL')
    summary = client.get('/api/events?view=summary&eventId=163').get_json()
    detail = client.get('/api/events/163').get_json()
    print('SUMMARY', json.dumps(summary, default=str))
    data = detail.get('data', {})
    print('DETAIL_KEYS', list(data))
    print('INCOMPLETE_MODELS', json.dumps({k:v for k,v in data.get('modelGroups',{}).items() if v.get('countablePreparedEverQuantity',0)<v.get('requiredQuantity',0)}))
    print('ELEC_REFS', json.dumps([{'ref':ref,'prepared':ref in event.actually_prepared} for ref in event.prepared_items if 'ELEC' in ref]))
    print('ELEC_ACTUAL', json.dumps([ref for ref in event.actually_prepared if 'ELEC' in ref]))
    print('CUSTOM', json.dumps(data.get('customAssets')))
    print('ROOM_ELEC', json.dumps([{'room':room.get('name'), 'keys':list(room), 'items':{key:[r for r in value if isinstance(r,dict) and r.get('department')=='ELEC'] for key,value in room.items() if isinstance(value,list)}} for room in data.get('subprojects',[])]))
    print('VENDORS', json.dumps(raw.get('vendorManagement')))
