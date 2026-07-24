"""Backfill blank asset versions from historical maintenance descriptions."""

import argparse
import json
from datetime import datetime

import app
from maintenance_logs import latest_detected_maintenance_version


def plan_manager_backfill(manager):
    updates = []
    conflicts = []
    already_current = []
    for asset in manager.inventory.values():
        detected = latest_detected_maintenance_version(
            getattr(asset, 'maintenance_logs', []) or []
        )
        if not detected:
            continue

        current_version = str(getattr(asset, 'version', '') or '').strip()
        target_version = detected['version']
        row = {
            'assetId': asset.asset_id,
            'currentVersion': current_version,
            'detectedVersion': target_version,
            'logType': detected['log'].get('type', ''),
            'logDate': detected['log'].get('date', ''),
            'logDescription': detected['log'].get('description', ''),
            'logIndex': detected['logIndex'],
        }
        if not current_version:
            updates.append(row)
        elif current_version.casefold() == target_version.casefold():
            already_current.append(row)
        else:
            conflicts.append(row)
    return {
        'updates': updates,
        'conflicts': conflicts,
        'alreadyCurrent': already_current,
    }


def apply_manager_backfill(manager, plan):
    timestamp = datetime.now().replace(microsecond=0).isoformat()
    for row in plan['updates']:
        asset = manager.inventory[row['assetId']]
        old_version = str(getattr(asset, 'version', '') or '').strip()
        asset.version = row['detectedVersion']
        asset.date_modified = timestamp
        history = list(getattr(asset, 'change_history', []) or [])
        history.append({
            'date': timestamp,
            'user': 'SYSTEM',
            'action': 'maintenance-version-backfill',
            'changes': [{
                'field': 'version',
                'label': 'Version',
                'old': old_version,
                'new': row['detectedVersion'],
            }],
        })
        asset.change_history = history
    if plan['updates']:
        manager.save_inventory()


def run_backfill(apply=False):
    registry = app._load_company_registry()
    report = {
        'mode': 'apply' if apply else 'dry-run',
        'companies': {},
        'totalUpdates': 0,
        'totalConflicts': 0,
        'totalAlreadyCurrent': 0,
    }
    for company_code in sorted(registry.get('companies', {})):
        manager = app._get_company_data_manager(company_code)
        plan = plan_manager_backfill(manager)
        if apply:
            apply_manager_backfill(manager, plan)
        summary = {
            'assetCount': len(manager.inventory),
            'updates': len(plan['updates']),
            'conflicts': len(plan['conflicts']),
            'alreadyCurrent': len(plan['alreadyCurrent']),
            'changedAssets': plan['updates'],
            'conflictingAssets': plan['conflicts'],
        }
        report['companies'][company_code] = summary
        report['totalUpdates'] += summary['updates']
        report['totalConflicts'] += summary['conflicts']
        report['totalAlreadyCurrent'] += summary['alreadyCurrent']
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        '--apply',
        action='store_true',
        help='Persist the proposed changes. The default is a read-only dry run.',
    )
    parser.add_argument(
        '--summary',
        action='store_true',
        help='Omit individual asset rows from the printed report.',
    )
    args = parser.parse_args()
    report = run_backfill(apply=args.apply)
    if args.summary:
        for company in report['companies'].values():
            company.pop('changedAssets', None)
            company.pop('conflictingAssets', None)
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
