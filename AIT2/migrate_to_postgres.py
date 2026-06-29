#!/usr/bin/env python3
"""Copy and verify AIM CSV data in PostgreSQL without switching the live app."""

import argparse
import csv
import hashlib
import json
import os
import sys

try:
    from dotenv import load_dotenv
except ImportError:  # pragma: no cover - optional convenience dependency
    load_dotenv = None

if load_dotenv:
    load_dotenv()

from data_manager import DataManager
from postgres_data_manager import PostgresDataManager


BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_REGISTRY = os.path.join(BASE_DIR, 'app_data', 'Companies.json')
DEFAULT_USERS = os.path.join(BASE_DIR, 'app_data', 'Users.csv')


def _absolute_config_path(path):
    if os.path.isabs(path):
        return path
    return os.path.join(BASE_DIR, path)


def _load_registry(path):
    with open(path, 'r', encoding='utf-8') as registry_file:
        return json.load(registry_file)


def _load_csv_manager(data_folder, users_file):
    manager = DataManager(data_folder, users_file=users_file)
    manager.load_users()
    manager.load_inventory()
    manager.load_containers()
    manager.load_events()
    manager.load_logs()
    manager.load_clients()
    return manager


def _load_departments(data_folder):
    path = os.path.join(data_folder, 'Departments.csv')
    departments = {}
    if not os.path.exists(path):
        return departments
    with open(path, 'r', newline='', encoding='utf-8-sig') as department_file:
        for row in csv.DictReader(department_file):
            code = str(row.get('Code') or row.get('code') or '').strip().upper()
            if not code:
                continue
            departments[code] = {
                'code': code,
                'name': str(row.get('Name') or row.get('name') or code).strip(),
                'color': str(row.get('Color') or row.get('color') or '#E2E3E5').strip(),
                'textColor': str(
                    row.get('TextColor')
                    or row.get('textColor')
                    or '#111827'
                ).strip(),
            }
    return departments


def _source_fingerprint(data_folder, users_file):
    digest = hashlib.sha256()
    paths = [
        users_file,
        *[
            os.path.join(data_folder, filename)
            for filename in (
                'Inventory.csv',
                'Containers.csv',
                'Logs.csv',
                'Clients.csv',
                'Departments.csv',
            )
        ],
    ]
    events_folder = os.path.join(data_folder, 'events')
    if os.path.isdir(events_folder):
        paths.extend(
            os.path.join(events_folder, filename)
            for filename in sorted(os.listdir(events_folder))
            if filename.lower().endswith('.csv')
        )
    for path in sorted(paths):
        relative = os.path.relpath(path, BASE_DIR).replace('\\', '/')
        digest.update(relative.encode('utf-8'))
        if not os.path.exists(path):
            digest.update(b'<missing>')
            continue
        with open(path, 'rb') as source_file:
            for chunk in iter(lambda: source_file.read(1024 * 1024), b''):
                digest.update(chunk)
    return digest.hexdigest()


def _expected_counts(manager, departments):
    return {
        'inventory': len(manager.inventory),
        'containers': len(manager.containers),
        'events': len(manager.events),
        'logs': min(1000, len(manager.logs)),
        'clients': len(manager.clients),
        'departments': len(departments),
        'users': len(manager.users),
    }


def migrate_company(dsn, code, record, users_file, apply_changes):
    data_folder = _absolute_config_path(record.get('backendFolder') or '')
    csv_manager = _load_csv_manager(data_folder, users_file)
    departments = _load_departments(data_folder)
    expected = _expected_counts(csv_manager, departments)
    fingerprint = _source_fingerprint(data_folder, users_file)

    result = {
        'company': code,
        'sourceFolder': data_folder,
        'sourceFingerprint': fingerprint,
        'expected': expected,
        'applied': False,
        'verified': False,
    }
    if not apply_changes:
        return result

    postgres_manager = PostgresDataManager(
        dsn,
        company_code=code,
        company_name=record.get('name') or code,
        data_folder=data_folder,
        users_file=users_file,
    )
    postgres_manager.setup_data_folder()
    postgres_manager.check_and_initialize_files()
    postgres_manager.replace_from_csv(csv_manager, departments)
    actual = postgres_manager.database_counts()
    verified = actual == expected
    postgres_manager.record_migration(
        data_folder,
        fingerprint,
        actual,
        verified,
    )
    result.update({
        'actual': actual,
        'applied': True,
        'verified': verified,
    })
    return result


def main():
    parser = argparse.ArgumentParser(
        description='Copy AIM CSV data to PostgreSQL and verify row counts.'
    )
    parser.add_argument(
        '--database-url',
        default=os.environ.get('DATABASE_URL', ''),
        help='PostgreSQL connection URL (or set DATABASE_URL).',
    )
    parser.add_argument('--registry', default=DEFAULT_REGISTRY)
    parser.add_argument('--users-file', default=DEFAULT_USERS)
    parser.add_argument(
        '--company',
        action='append',
        dest='companies',
        help='Only migrate this company code; may be repeated.',
    )
    parser.add_argument(
        '--apply',
        action='store_true',
        help='Write to PostgreSQL. Without this flag the command is read-only.',
    )
    args = parser.parse_args()

    if not args.database_url:
        parser.error('DATABASE_URL or --database-url is required')

    registry = _load_registry(os.path.abspath(args.registry))
    requested = {
        str(code).strip().upper()
        for code in (args.companies or registry.get('companies', {}).keys())
    }
    unknown = requested - set(registry.get('companies', {}))
    if unknown:
        parser.error(f"Unknown company code(s): {', '.join(sorted(unknown))}")

    results = []
    for code in sorted(requested):
        results.append(
            migrate_company(
                args.database_url,
                code,
                registry['companies'][code],
                os.path.abspath(args.users_file),
                args.apply,
            )
        )

    print(json.dumps(results, ensure_ascii=False, indent=2))
    if args.apply and not all(result['verified'] for result in results):
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
