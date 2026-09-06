"""Correct the confirmed company for five AVPL event 163 bookings only."""
import json
import os
import sys
from datetime import datetime
from pathlib import Path

import psycopg
from psycopg.types.json import Jsonb
from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parents[1] / '.env')
expected = {
    'transport_ddcb0c6c495f17fd': 'vendor_85e590be636dc47e',
    'transport_20b5fc361b3d9c47': 'vendor_7674c2d118481ef9',
    'transport_bdade9cf7b88467a': 'vendor_85e590be636dc47e',
    'transport_504f0dec1d528011': 'vendor_7674c2d118481ef9',
    'transport_5101cb4eecb03944': 'vendor_7674c2d118481ef9',
}
apply = '--apply' in sys.argv
with psycopg.connect(os.environ['DATABASE_URL'], connect_timeout=10) as connection:
    if not apply:
        connection.execute('SET TRANSACTION READ ONLY')
    row = connection.execute(
        'SELECT data, version FROM aim_company_documents WHERE company_code=%s AND document_key=%s'
        + (' FOR UPDATE' if apply else ''), ('AVPL', 'workforce'),
    ).fetchone()
    data, version = row
    profiles = {row['id']: row for row in data.get('transportVendors', [])}
    bookings = data.get('transportBookings', {}).get('163', [])
    targets = [row for row in bookings if row.get('id') in expected]
    assert len(targets) == 5, 'Target bookings changed; recheck before editing'
    assert sum(bool(row.get('companyInvoice')) for row in targets) <= 1, 'Review existing company invoices before combining'
    changes = []
    for booking in targets:
        assert booking.get('vendorId') == expected[booking['id']]
        assert profiles[booking['vendorId']].get('company') == 'Ang Guo Cai'
        assert booking.get('sourceType') == 'external'
        assert booking.get('company') in ('', None, 'Ang Guo Cai')
        if booking.get('company') != 'Ang Guo Cai':
            changes.append({'id': booking['id'], 'vehicleType': booking.get('vehicleType'),
                            'oldCompany': booking.get('company'), 'company': 'Ang Guo Cai'})
            booking['company'] = 'Ang Guo Cai'
            booking['updatedAt'] = datetime.now().isoformat(timespec='seconds')
    if apply and changes:
        data['updatedAt'] = datetime.now().isoformat(timespec='seconds')
        updated = connection.execute(
            'UPDATE aim_company_documents SET data=%s, version=version+1, updated_at=CURRENT_TIMESTAMP '
            'WHERE company_code=%s AND document_key=%s AND version=%s RETURNING version',
            (Jsonb(data), 'AVPL', 'workforce', version),
        ).fetchone()
        assert updated, 'Concurrent update; no correction saved'
    print(json.dumps({'applied': apply, 'changes': changes}, indent=2))
