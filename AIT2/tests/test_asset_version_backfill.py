import unittest

from backfill_asset_versions import plan_manager_backfill
from maintenance_logs import latest_detected_maintenance_version
from models import InventoryItem


def asset_with_logs(asset_id, logs, version=''):
    return InventoryItem(
        asset_id=asset_id,
        brand='Test',
        model_number='Model',
        version=version,
        serial_number='',
        description='',
        is_missing=False,
        maintenance_logs=logs,
        department_code='AX',
    )


class AssetVersionBackfillTests(unittest.TestCase):
    def test_latest_dated_detected_version_wins_over_list_order(self):
        detected = latest_detected_maintenance_version([
            {
                'date': '2026/05/22',
                'type': 'Update',
                'description': 'Updated to v1.3.3',
            },
            {
                'date': '2026/04/20',
                'type': 'Update',
                'description': 'Updated to v1.3.0',
            },
            {
                'date': '2026/07/20',
                'type': 'Update',
                'description': 'Updated from v1.3.3 to v1.4.1',
            },
        ])

        self.assertEqual(detected['version'], 'v1.4.1')
        self.assertEqual(detected['logIndex'], 2)

    def test_plan_fills_blanks_and_does_not_overwrite_existing_versions(self):
        class Manager:
            inventory = {
                'A#01': asset_with_logs(
                    'A#01',
                    [{'date': '2026/01/01', 'type': 'General', 'description': 'Firmware updated to v2.0'}],
                ),
                'A#02': asset_with_logs(
                    'A#02',
                    [{'date': '2026/01/01', 'type': 'Update', 'description': 'Updated to v2.0'}],
                    version='v3.0',
                ),
                'A#03': asset_with_logs(
                    'A#03',
                    [{'date': '2026/01/01', 'type': 'Repair', 'description': 'Updated to v2.0'}],
                    version='V2.0',
                ),
            }

        plan = plan_manager_backfill(Manager())

        self.assertEqual([row['assetId'] for row in plan['updates']], ['A#01'])
        self.assertEqual([row['assetId'] for row in plan['conflicts']], ['A#02'])
        self.assertEqual([row['assetId'] for row in plan['alreadyCurrent']], ['A#03'])


if __name__ == '__main__':
    unittest.main()
