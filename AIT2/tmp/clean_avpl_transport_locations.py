"""Remove four reviewed duplicate AVPL saved transport locations only."""
import json
import os
import sys
from datetime import datetime
from pathlib import Path

import psycopg
from psycopg.types.json import Jsonb
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / '.env')

# Keep the existing canonical records and IDs. The library's earlier address
# is missing its leading 1; the remainder, including unit and postcode, matches.
MERGES = [
    ('location_458d45cf8df401f2', 'location_a7c389976b6a8aa5', 'Office',
     '601 Sims Drive, Pan-I Complex, Singapore 387382', None),
    ('location_e999e56b48ffb842', 'location_f1d03477bcccb5a6', '*SCAPE Loading Bay',
     '2 Orchard Link, Singapore 237978', None),
    ('location_f5e8ddd605db16d3', 'location_4a5698679e5ec64a', 'Capella Loading Bay',
     '1 The Knolls, Sentosa Island, Singapore 098297', None),
    ('location_41060ae039731854', 'location_f5a6f941471e2f75', 'National Library',
     '100 Victoria St, #03-01 National Library, 100 Victoria St, Building, Singapore 188064',
     '00 Victoria St, #03-01 National Library, 100 Victoria St, Building, Singapore 188064'),
]

apply = '--apply' in sys.argv
backup_path = None
with psycopg.connect(os.environ['DATABASE_URL'], connect_timeout=10) as connection:
    if not apply:
        connection.execute('SET TRANSACTION READ ONLY')
    original, version = connection.execute(
        'SELECT data, version FROM aim_company_documents '
        'WHERE company_code=%s AND document_key=%s' + (' FOR UPDATE' if apply else ''),
        ('AVPL', 'workforce'),
    ).fetchone()
    locations = original.get('transportLocations', [])
    by_id = {row['id']: row for row in locations}
    assert len(by_id) == len(locations), 'Repeated IDs need manual review'
    changes = []
    remove_ids = set()
    for keep_id, remove_id, name, address, old_address in MERGES:
        keeper = by_id.get(keep_id)
        assert keeper and keeper.get('name') == name and keeper.get('address') == address, \
            f'Canonical location changed: {name}'
        duplicate = by_id.get(remove_id)
        if duplicate is None:
            continue  # Already cleaned; reruns are safe.
        assert duplicate.get('name') == name and duplicate.get('address') == (old_address or address), \
            f'Duplicate location changed: {name}'
        remove_ids.add(remove_id)
        changes.append({'name': name, 'keepId': keep_id, 'removeId': remove_id})
    cleaned = [row for row in locations if row['id'] not in remove_ids]
    if apply and changes:
        timestamp = datetime.now().astimezone().isoformat(timespec='seconds')
        backup_dir = ROOT / 'tmp' / 'backups'
        backup_dir.mkdir(parents=True, exist_ok=True)
        backup_path = backup_dir / f'avpl-transport-locations-{datetime.now():%Y%m%d-%H%M%S-%f}.json'
        with backup_path.open('x', encoding='utf-8') as handle:
            json.dump({'companyCode': 'AVPL', 'documentKey': 'workforce',
                       'versionBefore': version, 'backedUpAt': timestamp,
                       'transportLocationsBefore': locations,
                       'transportLocationsAfter': cleaned, 'changes': changes},
                      handle, ensure_ascii=False, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        updated, updated_version = connection.execute(
            "UPDATE aim_company_documents SET data=jsonb_set(jsonb_set(data, "
            "'{transportLocations}', %s), '{updatedAt}', %s), "
            'version=version+1, updated_at=CURRENT_TIMESTAMP '
            'WHERE company_code=%s AND document_key=%s AND version=%s RETURNING data, version',
            (Jsonb(cleaned), Jsonb(timestamp), 'AVPL', 'workforce', version),
        ).fetchone()
        assert updated['transportLocations'] == cleaned
        assert updated_version == version + 1
        untouched = lambda data: {key: value for key, value in data.items()
                                  if key not in {'transportLocations', 'updatedAt'}}
        assert untouched(updated) == untouched(original), 'Unexpected change outside saved locations'

if apply:
    with psycopg.connect(os.environ['DATABASE_URL'], connect_timeout=10) as connection:
        connection.execute('SET TRANSACTION READ ONLY')
        saved = connection.execute(
            "SELECT data->'transportLocations' FROM aim_company_documents "
            'WHERE company_code=%s AND document_key=%s', ('AVPL', 'workforce'),
        ).fetchone()[0]
        assert saved == cleaned, 'Saved locations differ; review concurrent activity'

print(json.dumps({'applied': apply, 'before': len(locations), 'after': len(cleaned),
                  'changes': changes, 'backup': str(backup_path) if backup_path else None}, indent=2))
