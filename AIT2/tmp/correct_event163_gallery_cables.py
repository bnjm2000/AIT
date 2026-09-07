"""Link the user-confirmed 2x 30m cables without changing preparation status."""
import json
import os
import sys
from pathlib import Path

import psycopg
from psycopg.types.json import Jsonb
from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parents[1] / '.env')
apply = '--apply' in sys.argv
with psycopg.connect(os.environ['DATABASE_URL'], connect_timeout=10) as connection:
    if not apply:
        connection.execute('SET TRANSACTION READ ONLY')
    revision = connection.execute(
        'SELECT revision FROM aim_company_revisions WHERE company_code=%s'
        + (' FOR UPDATE' if apply else ''), ('AVPL',),
    ).fetchone()
    assert revision is not None, 'Missing company revision'
    data, version = connection.execute(
        'SELECT data, version FROM aim_events WHERE company_code=%s AND event_id=%s'
        + (' FOR UPDATE' if apply else ''), ('AVPL', 163),
    ).fetchone()
    targets = [(room, item) for room in data.get('subprojects', [])
               for item in room.get('items', [])
               if item.get('lineId') == 'plan_ea36c09311b88493']
    assert len(targets) == 1, 'Target line changed'
    room, item = targets[0]
    assert room.get('name') == 'Gallery Theatre'
    assert item.get('isCustom') and item.get('quantity') == 2
    refs = [ref for ref in data.get('preparedItems', [])
            if ref.startswith('[CUSTOM]')
            and json.loads(ref[8:]).get('uid') == '1bc06ac0196297e5']
    assert len(refs) == 1, 'Target marker changed'
    marker = refs[0]
    custom = json.loads(marker[8:])
    assert custom['name'] == '63A 3P cable - 30m' and custom['quantity'] == 2
    assert custom['department'] == 'ELEC'
    assert marker not in data.get('actuallyPrepared', [])
    assert marker not in data.get('returnedItems', [])
    already_correct = item.get('description') == custom['name'] and item.get('assetRefs') == refs
    if not already_correct:
        assert item.get('description') == '63A 3P cable - 20m' and not item.get('assetRefs')
        assert not any(marker in other.get('assetRefs', [])
                       for other_room in data['subprojects'] for other in other_room['items'])
        item['description'] = custom['name']
        item['assetRefs'] = refs
        if apply:
            result = connection.execute(
                'UPDATE aim_events SET data=%s, version=version+1, updated_at=CURRENT_TIMESTAMP '
                'WHERE company_code=%s AND event_id=%s AND version=%s RETURNING version',
                (Jsonb(data), 'AVPL', 163, version),
            ).fetchone()
            assert result, 'Concurrent update; correction not saved'
            connection.execute(
                'UPDATE aim_company_revisions SET revision=revision+1, updated_at=CURRENT_TIMESTAMP '
                'WHERE company_code=%s', ('AVPL',),
            )
    print(json.dumps({'applied': apply, 'alreadyCorrect': already_correct,
                      'room': room['name'], 'item': item, 'prepared': False}, indent=2))
