"""PostgreSQL persistence with optimistic concurrency protection.

The application still works with its existing in-memory domain objects. This
adapter persists those objects as versioned PostgreSQL rows and rejects a stale
write instead of silently overwriting another worker's changes.
"""

import hashlib
import json
import logging
import os
import shutil
import threading
from contextlib import contextmanager

from psycopg import sql
from psycopg.errors import UniqueViolation
from psycopg.types.json import Jsonb
from psycopg_pool import ConnectionPool

from data_manager import (
    ConcurrentDataChangeError,
    DataManager,
    normalize_asset_change_history,
)
from maintenance_logs import normalize_maintenance_log
from models import (
    Client,
    Container,
    Event,
    InventoryItem,
    LogEntry,
    User,
    normalize_event_state,
)


logger = logging.getLogger(__name__)

_POOLS = {}
_POOLS_LOCK = threading.RLock()
_SCHEMA_READY = set()
_SCHEMA_LOCK = threading.RLock()


def _pool_for(dsn):
    with _POOLS_LOCK:
        pool = _POOLS.get(dsn)
        if pool is None:
            pool = ConnectionPool(
                conninfo=dsn,
                min_size=1,
                max_size=max(2, int(os.environ.get('DATABASE_POOL_SIZE', '10'))),
                timeout=10,
                open=True,
                name='aim-postgresql',
            )
            _POOLS[dsn] = pool
        return pool


def close_postgres_pool(dsn):
    """Close one connection pool, primarily for isolated integration tests."""
    with _POOLS_LOCK:
        pool = _POOLS.pop(dsn, None)
    if pool is not None:
        pool.close()
    with _SCHEMA_LOCK:
        _SCHEMA_READY.discard(dsn)


def _fingerprint(value):
    encoded = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(',', ':'),
        default=str,
    ).encode('utf-8')
    return hashlib.sha256(encoded).hexdigest()


class PostgresDataManager(DataManager):
    """DataManager-compatible PostgreSQL adapter for one company."""

    backend = 'postgresql'

    def __init__(self, dsn, company_code, data_folder, company_name='', users_file=None):
        super().__init__(data_folder, users_file=users_file)
        self.dsn = dsn
        self.company_code = str(company_code or '').strip().upper()
        self.company_name = str(company_name or self.company_code).strip()
        self.pool = _pool_for(dsn)
        self._write_request_lock = threading.RLock()
        self._loaded_revision = None
        self._loaded_users_revision = None
        self._inventory_snapshots = {}
        self._inventory_versions = {}
        self._container_snapshots = {}
        self._container_versions = {}
        self._event_snapshots = {}
        self._event_versions = {}
        self._client_snapshots = {}
        self._client_versions = {}
        self._user_snapshots = {}
        self._user_versions = {}
        self._department_snapshots = {}
        self._department_versions = {}
        self._log_snapshot = []

    def acquire_write_request(self):
        """Serialize mutations sharing this in-process company manager."""
        self._write_request_lock.acquire()

    def release_write_request(self):
        self._write_request_lock.release()

    @contextmanager
    def _connection(self):
        with self.pool.connection() as connection:
            yield connection

    def ensure_schema(self):
        schema_key = self.dsn
        with _SCHEMA_LOCK:
            if schema_key in _SCHEMA_READY:
                return
            schema_path = os.path.join(
                os.path.dirname(os.path.abspath(__file__)),
                'sql',
                'postgresql_schema.sql',
            )
            with open(schema_path, 'r', encoding='utf-8') as schema_file:
                schema_sql = schema_file.read()
            with self._connection() as connection:
                connection.execute(schema_sql)
            _SCHEMA_READY.add(schema_key)

    def ensure_company(self):
        self.ensure_schema()
        with self._connection() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    INSERT INTO aim_companies (company_code, company_name)
                    VALUES (%s, %s)
                    ON CONFLICT (company_code) DO UPDATE
                    SET company_name = EXCLUDED.company_name,
                        updated_at = CURRENT_TIMESTAMP
                    """,
                    (self.company_code, self.company_name),
                )
                cursor.execute(
                    """
                    INSERT INTO aim_company_revisions (company_code, revision)
                    VALUES (%s, 0)
                    ON CONFLICT (company_code) DO NOTHING
                    """,
                    (self.company_code,),
                )

    def setup_data_folder(self):
        # Media and event attachments remain on disk; structured records do not.
        os.makedirs(self.data_folder, exist_ok=True)
        os.makedirs(self.events_folder, exist_ok=True)

    def check_and_initialize_files(self):
        self.ensure_company()

    def _revision(self, cursor):
        cursor.execute(
            "SELECT revision FROM aim_company_revisions WHERE company_code = %s",
            (self.company_code,),
        )
        row = cursor.fetchone()
        return int(row[0]) if row else 0

    def _users_revision(self, cursor):
        cursor.execute(
            "SELECT revision FROM aim_global_state WHERE state_key = 'users'"
        )
        row = cursor.fetchone()
        return int(row[0]) if row else 0

    def shared_data_signature(self):
        with self._connection() as connection:
            with connection.cursor() as cursor:
                return ('postgresql', self._revision(cursor), self._users_revision(cursor))

    def _lock_company_revision(self, cursor):
        cursor.execute(
            """
            SELECT revision
            FROM aim_company_revisions
            WHERE company_code = %s
            FOR UPDATE
            """,
            (self.company_code,),
        )
        row = cursor.fetchone()
        database_revision = int(row[0]) if row else 0
        if (
            self._loaded_revision is not None
            and database_revision != self._loaded_revision
        ):
            raise ConcurrentDataChangeError(
                f'Company {self.company_code} changed in another request; reload and retry'
            )
        return database_revision

    def _bump_company_revision(self, cursor, current_revision):
        next_revision = current_revision + 1
        cursor.execute(
            """
            UPDATE aim_company_revisions
            SET revision = %s, updated_at = CURRENT_TIMESTAMP
            WHERE company_code = %s
            """,
            (next_revision, self.company_code),
        )
        return next_revision

    def _lock_users_revision(self, cursor):
        cursor.execute(
            """
            SELECT revision
            FROM aim_global_state
            WHERE state_key = 'users'
            FOR UPDATE
            """
        )
        row = cursor.fetchone()
        database_revision = int(row[0]) if row else 0
        if (
            self._loaded_users_revision is not None
            and database_revision != self._loaded_users_revision
        ):
            raise ConcurrentDataChangeError(
                'User accounts changed in another request; reload and retry'
            )
        return database_revision

    def _bump_users_revision(self, cursor, current_revision):
        next_revision = current_revision + 1
        cursor.execute(
            """
            UPDATE aim_global_state
            SET revision = %s, updated_at = CURRENT_TIMESTAMP
            WHERE state_key = 'users'
            """,
            (next_revision,),
        )
        return next_revision

    # ---------------- Serialization ----------------

    def _user_data(self, user):
        return {
            'username': user.username,
            'passwordHash': user.password_hash,
            'salt': user.salt,
            'isAdmin': bool(user.is_admin),
            'isActive': bool(getattr(user, 'is_active', True)),
            'lastOnline': str(getattr(user, 'last_online', '-') or '-'),
        }

    def _inventory_data(self, item):
        return {
            'assetId': item.asset_id,
            'brand': item.brand,
            'modelNumber': item.model_number,
            'serialNumber': item.serial_number,
            'secondarySerialNumber': getattr(item, 'secondary_serial_number', ''),
            'description': item.description,
            'dateOfPurchase': getattr(item, 'date_of_purchase', ''),
            'dateAdded': getattr(item, 'date_added', ''),
            'dateModified': getattr(item, 'date_modified', ''),
            'changeHistory': normalize_asset_change_history(
                getattr(item, 'change_history', [])
            ),
            'notes': getattr(item, 'notes', ''),
            'isMissing': bool(item.is_missing),
            'isOOC': bool(item.is_ooc),
            'isDegraded': bool(getattr(item, 'is_degraded', False)),
            'isDisposed': bool(getattr(item, 'is_disposed', False)),
            'isBulk': bool(getattr(item, 'is_bulk', False)),
            'quantity': int(getattr(item, 'quantity', 1) or 1),
            'maintenanceLogs': [
                normalize_maintenance_log(log)
                for log in (getattr(item, 'maintenance_logs', []) or [])
            ],
            'departmentCode': item.department_code,
            'defaultLocation': item.default_location,
            'currentLocation': item.current_location,
        }

    def _container_data(self, container):
        return {
            'containerId': container.container_id,
            'assetIds': list(container.asset_ids or []),
            'serialNumber': getattr(container, 'serial_number', '') or '',
            'maintenanceLogs': [
                normalize_maintenance_log(log)
                for log in (getattr(container, 'maintenance_logs', []) or [])
            ],
        }

    def _event_data(self, event):
        return {
            'eventId': int(event.event_id),
            'name': event.name,
            'location': getattr(event, 'location', '') or '',
            'startDate': event.start_date,
            'endDate': event.end_date,
            'assetModels': list(event.asset_models or []),
            'preparedItems': list(getattr(event, 'prepared_items', []) or []),
            'returnedItems': list(getattr(event, 'returned_items', []) or []),
            'state': event.state,
            'actuallyPrepared': list(getattr(event, 'actually_prepared', []) or []),
            'extraAssets': list(getattr(event, 'extra_assets', []) or []),
            'customCollected': list(getattr(event, 'custom_collected', []) or []),
            'tag': getattr(event, 'tag', 'events'),
            'forceStateOverride': bool(
                getattr(event, 'force_state_override', False)
            ),
            'notes': getattr(event, 'notes', '') or '',
            'eventLogs': self.normalize_event_logs(
                getattr(event, 'event_logs', [])
            ),
        }

    def _client_data(self, client):
        return {
            'name': client.name,
            'company': client.company,
            'address1': client.address1,
            'address2': client.address2,
            'address3': client.address3,
            'postalCode': client.postal_code,
            'phone': client.phone,
        }

    # ---------------- Loading ----------------

    def load_all_data(self):
        self.ensure_company()
        self.load_users()
        self.load_inventory()
        self.load_containers()
        self.load_events()
        self.migrate_legacy_event_states()
        self.load_logs()
        self.migrate_event_logs_from_system_logs()
        self.load_clients()
        with self._connection() as connection:
            with connection.cursor() as cursor:
                self._loaded_revision = self._revision(cursor)
                self._loaded_users_revision = self._users_revision(cursor)

    def load_users(self):
        users = {}
        snapshots = {}
        versions = {}
        with self._connection() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT username, data, version FROM aim_users ORDER BY username"
                )
                for username, data, version in cursor.fetchall():
                    user = User(
                        username=username,
                        password_hash=data.get('passwordHash', ''),
                        salt=data.get('salt', ''),
                        is_admin=bool(data.get('isAdmin', False)),
                        is_active=bool(data.get('isActive', True)),
                        last_online=data.get('lastOnline', '-'),
                    )
                    users[username] = user
                    snapshots[username] = _fingerprint(self._user_data(user))
                    versions[username] = int(version)
                self._loaded_users_revision = self._users_revision(cursor)
        self.users = users
        self._user_snapshots = snapshots
        self._user_versions = versions

    def load_inventory(self):
        inventory = {}
        snapshots = {}
        versions = {}
        with self._connection() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT asset_id, data, version
                    FROM aim_inventory
                    WHERE company_code = %s
                    ORDER BY asset_id
                    """,
                    (self.company_code,),
                )
                for asset_id, data, version in cursor.fetchall():
                    item = InventoryItem(
                        asset_id=asset_id,
                        brand=data.get('brand', ''),
                        model_number=data.get('modelNumber', ''),
                        serial_number=data.get('serialNumber', ''),
                        secondary_serial_number=data.get('secondarySerialNumber', ''),
                        description=data.get('description', ''),
                        date_of_purchase=data.get('dateOfPurchase', ''),
                        date_added=data.get('dateAdded', ''),
                        date_modified=data.get('dateModified', ''),
                        change_history=data.get('changeHistory') or [],
                        notes=data.get('notes', ''),
                        is_missing=bool(data.get('isMissing', False)),
                        is_ooc=bool(data.get('isOOC', False)),
                        is_degraded=bool(data.get('isDegraded', False)),
                        is_disposed=bool(data.get('isDisposed', False)),
                        is_bulk=bool(data.get('isBulk', False)),
                        quantity=data.get('quantity', 1),
                        maintenance_logs=data.get('maintenanceLogs') or [],
                        department_code=data.get('departmentCode', 'UN'),
                        default_location=data.get('defaultLocation', ''),
                        current_location=data.get('currentLocation', ''),
                    )
                    inventory[asset_id] = item
                    snapshots[asset_id] = _fingerprint(self._inventory_data(item))
                    versions[asset_id] = int(version)
        self.inventory = inventory
        self._inventory_snapshots = snapshots
        self._inventory_versions = versions

    def load_containers(self):
        containers = {}
        snapshots = {}
        versions = {}
        with self._connection() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT container_id, data, version
                    FROM aim_containers
                    WHERE company_code = %s
                    ORDER BY container_id
                    """,
                    (self.company_code,),
                )
                for container_id, data, version in cursor.fetchall():
                    container = Container(
                        container_id,
                        list(data.get('assetIds') or []),
                        data.get('serialNumber', ''),
                        data.get('maintenanceLogs') or [],
                    )
                    containers[container_id] = container
                    snapshots[container_id] = _fingerprint(
                        self._container_data(container)
                    )
                    versions[container_id] = int(version)
        self.containers = containers
        self._container_snapshots = snapshots
        self._container_versions = versions

    def load_events(self):
        events = {}
        file_map = {}
        snapshots = {}
        versions = {}
        with self._connection() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT event_id, source_filename, data, version
                    FROM aim_events
                    WHERE company_code = %s
                    ORDER BY event_id
                    """,
                    (self.company_code,),
                )
                for event_id, source_filename, data, version in cursor.fetchall():
                    raw_state = data.get('state', 'New')
                    event = Event(
                        event_id=int(event_id),
                        name=data.get('name', ''),
                        location=data.get('location', ''),
                        start_date=data.get('startDate', ''),
                        end_date=data.get('endDate', ''),
                        asset_models=data.get('assetModels') or [],
                        prepared_items=data.get('preparedItems') or [],
                        returned_items=data.get('returnedItems') or [],
                        state=normalize_event_state(raw_state),
                        actually_prepared=data.get('actuallyPrepared') or [],
                        extra_assets=data.get('extraAssets') or [],
                        custom_collected=data.get('customCollected') or [],
                        tag=data.get('tag', 'events'),
                        force_state_override=bool(
                            data.get('forceStateOverride', False)
                        ),
                        notes=data.get('notes', ''),
                        event_logs=data.get('eventLogs') or [],
                    )
                    event._legacy_state_migrated = str(raw_state or '').strip() != event.state
                    events[int(event_id)] = event
                    file_map[int(event_id)] = (
                        source_filename or self._event_filename(event)
                    )
                    # Keep the fingerprint of what is actually stored. Event()
                    # normalises legacy names/states while loading; fingerprinting
                    # the normalised object here would make the migration save
                    # look like a no-op and repeat on every process start.
                    snapshots[int(event_id)] = _fingerprint(data)
                    versions[int(event_id)] = int(version)
        self.events = events
        self.event_file_map = file_map
        self._event_snapshots = snapshots
        self._event_versions = versions

    def load_logs(self):
        logs = []
        with self._connection() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT timestamp_text, username, action
                    FROM aim_system_logs
                    WHERE company_code = %s
                    ORDER BY log_id
                    """,
                    (self.company_code,),
                )
                logs = [
                    LogEntry(timestamp, username, action)
                    for timestamp, username, action in cursor.fetchall()
                ]
        self.logs = logs
        self._log_snapshot = [
            (log.timestamp, log.user, log.action) for log in logs
        ]

    def load_clients(self):
        clients = {}
        snapshots = {}
        versions = {}
        with self._connection() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT client_name, data, version
                    FROM aim_clients
                    WHERE company_code = %s
                    ORDER BY LOWER(client_name)
                    """,
                    (self.company_code,),
                )
                for client_name, data, version in cursor.fetchall():
                    client = Client(
                        name=client_name,
                        company=data.get('company', ''),
                        address1=data.get('address1', ''),
                        address2=data.get('address2', ''),
                        address3=data.get('address3', ''),
                        postal_code=data.get('postalCode', ''),
                        phone=data.get('phone', ''),
                    )
                    clients[client_name] = client
                    snapshots[client_name] = _fingerprint(
                        self._client_data(client)
                    )
                    versions[client_name] = int(version)
        self.clients = clients
        self._client_snapshots = snapshots
        self._client_versions = versions

    # ---------------- Versioned mapping persistence ----------------

    def _save_company_mapping(
        self,
        table,
        key_column,
        current,
        snapshots,
        versions,
        serializer,
        drop_keys=None,
    ):
        payloads = {key: serializer(value) for key, value in current.items()}
        current_fingerprints = {
            key: _fingerprint(payload) for key, payload in payloads.items()
        }
        changed = {
            key
            for key, fingerprint in current_fingerprints.items()
            if snapshots.get(key) != fingerprint
        }
        removed = (set(snapshots) - set(current)) | set(drop_keys or [])
        if not changed and not removed:
            return

        next_revision = None
        next_versions = dict(versions)
        try:
            with self._connection() as connection:
                with connection.cursor() as cursor:
                    revision = self._lock_company_revision(cursor)
                    table_id = sql.Identifier(table)
                    key_id = sql.Identifier(key_column)

                    for key in removed:
                        expected_version = versions.get(key)
                        if expected_version is None:
                            continue
                        cursor.execute(
                            sql.SQL(
                                """
                                DELETE FROM {table}
                                WHERE company_code = %s
                                  AND {key_column} = %s
                                  AND version = %s
                                """
                            ).format(table=table_id, key_column=key_id),
                            (self.company_code, key, expected_version),
                        )
                        if cursor.rowcount != 1:
                            raise ConcurrentDataChangeError(
                                f'{table} row {key!r} changed before deletion'
                            )
                        next_versions.pop(key, None)

                    for key in changed:
                        payload = payloads[key]
                        expected_version = versions.get(key)
                        if expected_version is None:
                            try:
                                cursor.execute(
                                    sql.SQL(
                                        """
                                        INSERT INTO {table}
                                            (company_code, {key_column}, data, version)
                                        VALUES (%s, %s, %s, 1)
                                        """
                                    ).format(table=table_id, key_column=key_id),
                                    (self.company_code, key, Jsonb(payload)),
                                )
                            except UniqueViolation as exc:
                                raise ConcurrentDataChangeError(
                                    f'{table} row {key!r} was created concurrently'
                                ) from exc
                            next_versions[key] = 1
                        else:
                            cursor.execute(
                                sql.SQL(
                                    """
                                    UPDATE {table}
                                    SET data = %s,
                                        version = version + 1,
                                        updated_at = CURRENT_TIMESTAMP
                                    WHERE company_code = %s
                                      AND {key_column} = %s
                                      AND version = %s
                                    RETURNING version
                                    """
                                ).format(table=table_id, key_column=key_id),
                                (
                                    Jsonb(payload),
                                    self.company_code,
                                    key,
                                    expected_version,
                                ),
                            )
                            row = cursor.fetchone()
                            if not row:
                                raise ConcurrentDataChangeError(
                                    f'{table} row {key!r} changed concurrently'
                                )
                            next_versions[key] = int(row[0])

                    next_revision = self._bump_company_revision(cursor, revision)
        except ConcurrentDataChangeError:
            self.load_all_data()
            raise

        self._loaded_revision = next_revision
        snapshots.clear()
        snapshots.update(current_fingerprints)
        versions.clear()
        versions.update(next_versions)

    def save_inventory(self, preserve_unknown=True, drop_asset_ids=None):
        drop_asset_ids = {
            str(asset_id)
            for asset_id in (drop_asset_ids or [])
            if str(asset_id)
        }
        self._save_company_mapping(
            'aim_inventory',
            'asset_id',
            self.inventory,
            self._inventory_snapshots,
            self._inventory_versions,
            self._inventory_data,
            drop_keys=drop_asset_ids,
        )

    def save_containers(self):
        self._save_company_mapping(
            'aim_containers',
            'container_id',
            self.containers,
            self._container_snapshots,
            self._container_versions,
            self._container_data,
        )

    def save_clients(self):
        self._save_company_mapping(
            'aim_clients',
            'client_name',
            self.clients,
            self._client_snapshots,
            self._client_versions,
            self._client_data,
        )

    def save_users(self):
        payloads = {
            username: self._user_data(user)
            for username, user in self.users.items()
        }
        fingerprints = {
            username: _fingerprint(payload)
            for username, payload in payloads.items()
        }
        changed = {
            username
            for username, fingerprint in fingerprints.items()
            if self._user_snapshots.get(username) != fingerprint
        }
        removed = set(self._user_snapshots) - set(self.users)
        if not changed and not removed:
            return

        next_versions = dict(self._user_versions)
        next_revision = None
        try:
            with self._connection() as connection:
                with connection.cursor() as cursor:
                    revision = self._lock_users_revision(cursor)
                    for username in removed:
                        expected_version = self._user_versions[username]
                        cursor.execute(
                            """
                            DELETE FROM aim_users
                            WHERE username = %s AND version = %s
                            """,
                            (username, expected_version),
                        )
                        if cursor.rowcount != 1:
                            raise ConcurrentDataChangeError(
                                f'User {username!r} changed before deletion'
                            )
                        next_versions.pop(username, None)

                    for username in changed:
                        expected_version = self._user_versions.get(username)
                        if expected_version is None:
                            try:
                                cursor.execute(
                                    """
                                    INSERT INTO aim_users (username, data, version)
                                    VALUES (%s, %s, 1)
                                    """,
                                    (username, Jsonb(payloads[username])),
                                )
                            except UniqueViolation as exc:
                                raise ConcurrentDataChangeError(
                                    f'User {username!r} was created concurrently'
                                ) from exc
                            next_versions[username] = 1
                        else:
                            cursor.execute(
                                """
                                UPDATE aim_users
                                SET data = %s,
                                    version = version + 1,
                                    updated_at = CURRENT_TIMESTAMP
                                WHERE username = %s AND version = %s
                                RETURNING version
                                """,
                                (
                                    Jsonb(payloads[username]),
                                    username,
                                    expected_version,
                                ),
                            )
                            row = cursor.fetchone()
                            if not row:
                                raise ConcurrentDataChangeError(
                                    f'User {username!r} changed concurrently'
                                )
                            next_versions[username] = int(row[0])
                    next_revision = self._bump_users_revision(cursor, revision)
        except ConcurrentDataChangeError:
            self.load_users()
            raise

        self._loaded_users_revision = next_revision
        self._user_snapshots = fingerprints
        self._user_versions = next_versions

    # ---------------- Events and logs ----------------

    def save_event(self, event):
        event.state = normalize_event_state(getattr(event, 'state', 'New'))
        event_id = int(event.event_id)
        payload = self._event_data(event)
        fingerprint = _fingerprint(payload)
        if self._event_snapshots.get(event_id) == fingerprint:
            return

        filename = self._event_filename(event)
        expected_version = self._event_versions.get(event_id)
        next_version = 1
        next_revision = None
        try:
            with self._connection() as connection:
                with connection.cursor() as cursor:
                    revision = self._lock_company_revision(cursor)
                    if expected_version is None:
                        try:
                            cursor.execute(
                                """
                                INSERT INTO aim_events (
                                    company_code, event_id, event_name,
                                    start_date, end_date, state,
                                    source_filename, data, version
                                )
                                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, 1)
                                """,
                                (
                                    self.company_code,
                                    event_id,
                                    event.name,
                                    event.start_date,
                                    event.end_date,
                                    event.state,
                                    filename,
                                    Jsonb(payload),
                                ),
                            )
                        except UniqueViolation as exc:
                            raise ConcurrentDataChangeError(
                                f'Event {event_id} was created concurrently'
                            ) from exc
                    else:
                        cursor.execute(
                            """
                            INSERT INTO aim_event_history (
                                company_code, event_id, event_name,
                                source_filename, data, source_version
                            )
                            SELECT company_code, event_id, event_name,
                                   source_filename, data, version
                            FROM aim_events
                            WHERE company_code = %s
                              AND event_id = %s
                              AND version = %s
                            """,
                            (self.company_code, event_id, expected_version),
                        )
                        cursor.execute(
                            """
                            UPDATE aim_events
                            SET event_name = %s,
                                start_date = %s,
                                end_date = %s,
                                state = %s,
                                source_filename = %s,
                                data = %s,
                                version = version + 1,
                                updated_at = CURRENT_TIMESTAMP
                            WHERE company_code = %s
                              AND event_id = %s
                              AND version = %s
                            RETURNING version
                            """,
                            (
                                event.name,
                                event.start_date,
                                event.end_date,
                                event.state,
                                filename,
                                Jsonb(payload),
                                self.company_code,
                                event_id,
                                expected_version,
                            ),
                        )
                        row = cursor.fetchone()
                        if not row:
                            raise ConcurrentDataChangeError(
                                f'Event {event_id} changed concurrently'
                            )
                        next_version = int(row[0])
                    next_revision = self._bump_company_revision(cursor, revision)
        except ConcurrentDataChangeError:
            self.load_all_data()
            raise

        self._loaded_revision = next_revision
        self._event_snapshots[event_id] = fingerprint
        self._event_versions[event_id] = next_version
        self.event_file_map[event_id] = filename
        event._legacy_location_extracted = False

    def backup_event_file(self, event_id):
        event_id = int(event_id)
        with self._connection() as connection:
            connection.execute(
                """
                INSERT INTO aim_event_history (
                    company_code, event_id, event_name,
                    source_filename, data, source_version
                )
                SELECT company_code, event_id, event_name,
                       source_filename, data, version
                FROM aim_events
                WHERE company_code = %s AND event_id = %s
                """,
                (self.company_code, event_id),
            )

    def delete_event_file(self, event_id):
        event_id = int(event_id)
        folder = self.get_event_folder(event_id)
        expected_version = self._event_versions.get(event_id)
        next_revision = None
        try:
            with self._connection() as connection:
                with connection.cursor() as cursor:
                    revision = self._lock_company_revision(cursor)
                    cursor.execute(
                        """
                        INSERT INTO aim_event_history (
                            company_code, event_id, event_name,
                            source_filename, data, source_version
                        )
                        SELECT company_code, event_id, event_name,
                               source_filename, data, version
                        FROM aim_events
                        WHERE company_code = %s
                          AND event_id = %s
                          AND version = %s
                        """,
                        (self.company_code, event_id, expected_version),
                    )
                    cursor.execute(
                        """
                        DELETE FROM aim_events
                        WHERE company_code = %s
                          AND event_id = %s
                          AND version = %s
                        """,
                        (self.company_code, event_id, expected_version),
                    )
                    if cursor.rowcount != 1:
                        raise ConcurrentDataChangeError(
                            f'Event {event_id} changed before deletion'
                        )
                    next_revision = self._bump_company_revision(cursor, revision)
        except ConcurrentDataChangeError:
            self.load_all_data()
            raise

        self._loaded_revision = next_revision
        self._event_snapshots.pop(event_id, None)
        self._event_versions.pop(event_id, None)
        self.event_file_map.pop(event_id, None)
        if folder and os.path.isdir(folder):
            shutil.rmtree(folder)

    def save_logs(self):
        current = [
            (log.timestamp, log.user, log.action)
            for log in self.logs[-1000:]
        ]
        if current == self._log_snapshot:
            return

        next_revision = None
        try:
            with self._connection() as connection:
                with connection.cursor() as cursor:
                    revision = self._lock_company_revision(cursor)
                    if (
                        len(current) >= len(self._log_snapshot)
                        and current[:len(self._log_snapshot)] == self._log_snapshot
                    ):
                        new_rows = current[len(self._log_snapshot):]
                        cursor.executemany(
                            """
                            INSERT INTO aim_system_logs (
                                company_code, timestamp_text, username, action
                            )
                            VALUES (%s, %s, %s, %s)
                            """,
                            [
                                (self.company_code, timestamp, username, action)
                                for timestamp, username, action in new_rows
                            ],
                        )
                        cursor.execute(
                            """
                            DELETE FROM aim_system_logs
                            WHERE log_id IN (
                                SELECT log_id
                                FROM aim_system_logs
                                WHERE company_code = %s
                                ORDER BY log_id DESC
                                OFFSET 1000
                            )
                            """,
                            (self.company_code,),
                        )
                    else:
                        cursor.execute(
                            "DELETE FROM aim_system_logs WHERE company_code = %s",
                            (self.company_code,),
                        )
                        cursor.executemany(
                            """
                            INSERT INTO aim_system_logs (
                                company_code, timestamp_text, username, action
                            )
                            VALUES (%s, %s, %s, %s)
                            """,
                            [
                                (self.company_code, timestamp, username, action)
                                for timestamp, username, action in current
                            ],
                        )
                    next_revision = self._bump_company_revision(cursor, revision)
        except ConcurrentDataChangeError:
            self.load_all_data()
            raise

        self._loaded_revision = next_revision
        self._log_snapshot = current

    # ---------------- Departments ----------------

    def load_departments(self):
        departments = {}
        snapshots = {}
        versions = {}
        with self._connection() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT department_code, data, version
                    FROM aim_departments
                    WHERE company_code = %s
                    ORDER BY department_code
                    """,
                    (self.company_code,),
                )
                for code, data, version in cursor.fetchall():
                    departments[code] = data
                    snapshots[code] = _fingerprint(data)
                    versions[code] = int(version)
        self._department_snapshots = snapshots
        self._department_versions = versions
        return departments

    def save_departments(self, departments):
        normalized = {
            code: dict(value)
            for code, value in departments.items()
        }
        self._save_company_mapping(
            'aim_departments',
            'department_code',
            normalized,
            self._department_snapshots,
            self._department_versions,
            lambda value: value,
        )

    # ---------------- Migration and administration ----------------

    def replace_from_csv(self, csv_manager, departments=None):
        """Atomically replace one company's PostgreSQL rows from a CSV snapshot."""
        departments = departments or {}
        inventory_rows = [
            (self.company_code, asset_id, Jsonb(self._inventory_data(item)))
            for asset_id, item in csv_manager.inventory.items()
        ]
        container_rows = [
            (self.company_code, container_id, Jsonb(self._container_data(container)))
            for container_id, container in csv_manager.containers.items()
        ]
        event_rows = []
        for event_id, event in csv_manager.events.items():
            event_rows.append((
                self.company_code,
                int(event_id),
                event.name,
                event.start_date,
                event.end_date,
                event.state,
                csv_manager.event_file_map.get(event_id, self._event_filename(event)),
                Jsonb(self._event_data(event)),
            ))
        log_rows = [
            (self.company_code, log.timestamp, log.user, log.action)
            for log in csv_manager.logs[-1000:]
        ]
        client_rows = [
            (self.company_code, name, Jsonb(self._client_data(client)))
            for name, client in csv_manager.clients.items()
        ]
        department_rows = [
            (self.company_code, code, Jsonb(value))
            for code, value in departments.items()
        ]
        user_rows = [
            (username, Jsonb(self._user_data(user)))
            for username, user in csv_manager.users.items()
        ]

        with self._connection() as connection:
            with connection.cursor() as cursor:
                revision = self._lock_company_revision(cursor)
                cursor.execute(
                    """
                    SELECT revision
                    FROM aim_global_state
                    WHERE state_key = 'users'
                    FOR UPDATE
                    """
                )
                users_revision = int(cursor.fetchone()[0])

                for table in (
                    'aim_inventory',
                    'aim_containers',
                    'aim_events',
                    'aim_system_logs',
                    'aim_clients',
                    'aim_departments',
                ):
                    cursor.execute(
                        sql.SQL("DELETE FROM {} WHERE company_code = %s").format(
                            sql.Identifier(table)
                        ),
                        (self.company_code,),
                    )

                cursor.executemany(
                    """
                    INSERT INTO aim_inventory (company_code, asset_id, data)
                    VALUES (%s, %s, %s)
                    """,
                    inventory_rows,
                )
                cursor.executemany(
                    """
                    INSERT INTO aim_containers (company_code, container_id, data)
                    VALUES (%s, %s, %s)
                    """,
                    container_rows,
                )
                cursor.executemany(
                    """
                    INSERT INTO aim_events (
                        company_code, event_id, event_name,
                        start_date, end_date, state, source_filename, data
                    )
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                    """,
                    event_rows,
                )
                cursor.executemany(
                    """
                    INSERT INTO aim_system_logs (
                        company_code, timestamp_text, username, action
                    )
                    VALUES (%s, %s, %s, %s)
                    """,
                    log_rows,
                )
                cursor.executemany(
                    """
                    INSERT INTO aim_clients (company_code, client_name, data)
                    VALUES (%s, %s, %s)
                    """,
                    client_rows,
                )
                cursor.executemany(
                    """
                    INSERT INTO aim_departments (
                        company_code, department_code, data
                    )
                    VALUES (%s, %s, %s)
                    """,
                    department_rows,
                )

                cursor.execute("DELETE FROM aim_users")
                cursor.executemany(
                    """
                    INSERT INTO aim_users (username, data)
                    VALUES (%s, %s)
                    """,
                    user_rows,
                )
                self._loaded_revision = self._bump_company_revision(
                    cursor,
                    revision,
                )
                self._loaded_users_revision = self._bump_users_revision(
                    cursor,
                    users_revision,
                )

        self.load_all_data()

    def database_counts(self):
        counts = {}
        table_keys = {
            'inventory': 'aim_inventory',
            'containers': 'aim_containers',
            'events': 'aim_events',
            'logs': 'aim_system_logs',
            'clients': 'aim_clients',
            'departments': 'aim_departments',
        }
        with self._connection() as connection:
            with connection.cursor() as cursor:
                for label, table in table_keys.items():
                    cursor.execute(
                        sql.SQL(
                            "SELECT COUNT(*) FROM {} WHERE company_code = %s"
                        ).format(sql.Identifier(table)),
                        (self.company_code,),
                    )
                    counts[label] = int(cursor.fetchone()[0])
                cursor.execute("SELECT COUNT(*) FROM aim_users")
                counts['users'] = int(cursor.fetchone()[0])
        return counts

    def record_migration(self, source_folder, source_fingerprint, counts, verified):
        with self._connection() as connection:
            connection.execute(
                """
                INSERT INTO aim_migration_runs (
                    company_code, source_folder, source_fingerprint,
                    imported_counts, verified
                )
                VALUES (%s, %s, %s, %s, %s)
                """,
                (
                    self.company_code,
                    os.path.abspath(source_folder),
                    source_fingerprint,
                    Jsonb(counts),
                    bool(verified),
                ),
            )

    def delete_company_data(self):
        with self._connection() as connection:
            connection.execute(
                "DELETE FROM aim_companies WHERE company_code = %s",
                (self.company_code,),
            )
