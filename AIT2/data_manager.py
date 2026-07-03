"""CSV-backed persistence for users, inventory, events, logs, and clients."""

import csv
import json
import logging
import os
import re
import shutil

from maintenance_logs import dump_maintenance_logs, load_maintenance_logs, normalize_maintenance_log
from models import (
    Client,
    Container,
    Event,
    InventoryItem,
    LogEntry,
    User,
    hash_password,
    normalize_event_state,
)
from utils import clean_csv_cell, open_csv_robust, sanitize_filename


# File and CSV schema definitions
MAX_LOG_LINES = 1000
REQUIRED_DATA_FILES = ('Inventory.csv', 'Logs.csv', 'Users.csv', 'Containers.csv', 'Clients.csv')
UTF8_ENCODINGS = ('utf-8', 'utf-8-sig')
INVENTORY_FIELDNAMES = [
    'AssetID', 'Brand', 'ModelNumber', 'SerialNumber', 'SecondarySerialNumber', 'Description', 'DateOfPurchase',
    'DateAdded', 'DateModified', 'ChangeHistory', 'Notes',
    'IsMissing', 'IsOOC', 'IsDegraded', 'IsDisposed', 'IsBulk', 'Quantity',
    'MaintenanceLogs', 'DepartmentCode', 'DefaultLocation', 'CurrentLocation'
]
EVENT_FIELDNAMES = [
    'EventID', 'Name', 'Location', 'StartDate', 'EndDate', 'AssetModels', 'PreparedItems',
    'ReturnedItems', 'State', 'ActuallyPrepared', 'ExtraAssets', 'CustomCollected',
    'Tag', 'ForceStateOverride', 'EventLogs', 'Notes'
]
CLIENT_FIELDNAMES = ['Name', 'Company', 'Address1', 'Address2', 'Address3', 'PostalCode', 'Phone']

logger = logging.getLogger(__name__)
EVENT_LOG_EVENT_ID_RE = re.compile(r'\bevent\s+(\d+)\b', re.IGNORECASE)


class ConcurrentDataChangeError(RuntimeError):
    """A stale write was rejected to avoid overwriting newer persisted data."""


def _parse_bool(value, default=False):
    """Parse loose CSV boolean values while preserving old admin labels."""
    if value is None:
        return default
    return str(value).strip().lower() in ('true', '1', 'yes', 'y', 'admin')


def _is_csv_true(value):
    return value == 'True'


def normalize_asset_change_history(history):
    if not history:
        return []

    if isinstance(history, dict):
        history = [history]

    if not isinstance(history, list):
        return []

    records = []
    for item in history:
        if not isinstance(item, dict):
            continue

        raw_changes = item.get('changes') or []
        if isinstance(raw_changes, dict):
            raw_changes = [raw_changes]
        if not isinstance(raw_changes, list):
            raw_changes = []

        changes = []
        for change in raw_changes:
            if not isinstance(change, dict):
                continue

            field = str(change.get('field') or '').strip()
            label = str(change.get('label') or field).strip()
            if not field and not label:
                continue

            changes.append({
                'field': field,
                'label': label,
                'old': change.get('old', ''),
                'new': change.get('new', ''),
            })

        record = {
            'date': str(item.get('date') or item.get('timestamp') or '').strip(),
            'user': str(item.get('user') or '').strip(),
            'action': str(item.get('action') or 'updated').strip() or 'updated',
            'changes': changes,
        }

        if record['date'] or record['user'] or record['changes']:
            records.append(record)

    return records


def load_asset_change_history(value):
    raw = str(value or '').strip()
    if not raw:
        return []

    try:
        return normalize_asset_change_history(json.loads(raw))
    except (TypeError, ValueError):
        return []


def dump_asset_change_history(history):
    records = normalize_asset_change_history(history)
    if not records:
        return ''
    return json.dumps(records, ensure_ascii=False, separators=(',', ':'))


def _replace_generated_username_references(text, old_username, new_username):
    """Update app-generated username text without rewriting arbitrary notes."""
    if not text or not old_username or old_username == new_username:
        return text

    updated = str(text)
    replacements = (
        (f"Asset sighted by {old_username} during Asset Check", f"Asset sighted by {new_username} during Asset Check"),
        (f"username: {old_username}", f"username: {new_username}"),
        (f"User {old_username} ", f"User {new_username} "),
        (f"User {old_username}", f"User {new_username}"),
        (f"user {old_username}", f"user {new_username}"),
        (f"by {old_username}", f"by {new_username}"),
    )
    for old_text, new_text in replacements:
        updated = updated.replace(old_text, new_text)
    return updated


class DataManager:
    """Owns the in-memory data model and its CSV persistence format."""

    def __init__(self, data_folder, users_file=None):
        self.data_folder = data_folder
        self.events_folder = os.path.join(data_folder, 'events')
        self.users_file = users_file
        self.users = {}
        self.inventory = {}
        self.containers = {}
        self.events = {}
        self.event_file_map = {}
        self.logs = []
        self.clients = {}

    # ---------------- Path helpers ----------------

    def _data_path(self, filename):
        if filename == 'Users.csv' and self.users_file:
            return self.users_file
        return os.path.join(self.data_folder, filename)

    def _event_filename(self, event):
        sanitized_name = sanitize_filename(event.name)
        return f"{event.event_id}. [{event.start_date}] {sanitized_name}.csv"

    def _event_folder_for_filename(self, filename):
        if not filename:
            return None
        stem, _ = os.path.splitext(filename)
        return os.path.join(self.events_folder, stem)

    def get_event_folder(self, event_id, create=False):
        filename = self.event_file_map.get(event_id)
        if not filename and event_id in self.events:
            filename = self._event_filename(self.events[event_id])
        folder = self._event_folder_for_filename(filename)
        if create and folder:
            os.makedirs(folder, exist_ok=True)
        return folder

    def _unique_child_path(self, folder, filename):
        base, ext = os.path.splitext(filename)
        candidate = os.path.join(folder, filename)
        counter = 2
        while os.path.exists(candidate):
            candidate = os.path.join(folder, f"{base}_{counter}{ext}")
            counter += 1
        return candidate

    def _move_event_folder(self, old_filename, new_filename):
        old_folder = self._event_folder_for_filename(old_filename)
        new_folder = self._event_folder_for_filename(new_filename)
        if not old_folder or not new_folder or old_folder == new_folder:
            return
        if not os.path.isdir(old_folder):
            return
        if not os.path.exists(new_folder):
            os.rename(old_folder, new_folder)
            return

        for child in os.listdir(old_folder):
            source = os.path.join(old_folder, child)
            target = self._unique_child_path(new_folder, child)
            shutil.move(source, target)

        try:
            os.rmdir(old_folder)
        except OSError:
            logger.warning("Event folder %s was not empty after merge.", old_folder)

    # ---------------- Application bootstrap ----------------

    def setup_data_folder(self):
        if not os.path.exists(self.data_folder):
            os.makedirs(self.data_folder)
        if not os.path.exists(self.events_folder):
            os.makedirs(self.events_folder)

    def check_and_initialize_files(self):
        missing_files = []
        for filename in REQUIRED_DATA_FILES:
            filepath = self._data_path(filename)
            folder = os.path.dirname(filepath)
            if folder and not os.path.exists(folder):
                os.makedirs(folder)
            if not os.path.exists(filepath):
                missing_files.append(filename)
        if missing_files:
            logger.info("The following required files are missing and will be created: %s", ', '.join(missing_files))
            self.initialize_files()
        else:
            logger.info("All required files are present.")

    def initialize_files(self):
        for filename in REQUIRED_DATA_FILES:
            filepath = self._data_path(filename)
            if not os.path.exists(filepath):
                with open(filepath, 'w', newline=''):
                    pass
        
        users_file = self._data_path('Users.csv')
        if os.path.getsize(users_file) == 0:
            salt = 'admin'
            password_hash = hash_password('admin', salt)
            self.users['admin'] = User('admin', password_hash, salt, True, True)
            self.save_users()
            logger.info("Default admin user created.")
        logger.info("Required files have been initialized.")

    # ---------------- Bulk loading ----------------

    def load_all_data(self):
        self.load_users()
        self.load_inventory()
        self.load_containers()
        self.load_events()
        self.migrate_legacy_event_states()
        self.load_logs()
        self.migrate_event_logs_from_system_logs()
        self.load_clients()

    # ---------------- Event log normalization ----------------

    def event_ids_from_log_action(self, action):
        action_text = str(action or '')
        action_lower = action_text.lower()
        if re.match(r'\s*deleted event\s+\d+\b', action_lower):
            return []
        if 'due to deletion of event ' in action_lower:
            return []

        event_ids = []
        for match in EVENT_LOG_EVENT_ID_RE.finditer(action_text):
            try:
                event_id = int(match.group(1))
            except (TypeError, ValueError):
                continue
            if event_id not in event_ids:
                event_ids.append(event_id)
        return event_ids

    def event_log_to_dict(self, log):
        if isinstance(log, LogEntry):
            timestamp = log.timestamp
            user = log.user
            action = log.action
        elif isinstance(log, dict):
            timestamp = log.get('timestamp') or log.get('date') or ''
            user = log.get('user') or ''
            action = log.get('action') or log.get('description') or ''
        else:
            timestamp = ''
            user = ''
            action = str(log or '')

        return {
            'timestamp': str(timestamp or ''),
            'user': str(user or ''),
            'action': str(action or '')
        }

    def normalize_event_logs(self, logs):
        normalized = []
        for log in logs or []:
            record = self.event_log_to_dict(log)
            if record['timestamp'] or record['user'] or record['action']:
                normalized.append(record)
        return normalized

    def append_event_log(self, event, log):
        record = self.event_log_to_dict(log)
        logs = self.normalize_event_logs(getattr(event, 'event_logs', []))
        key = (record['timestamp'], record['user'], record['action'])
        if key not in {(item['timestamp'], item['user'], item['action']) for item in logs}:
            logs.append(record)
        event.event_logs = logs
        return record

    def migrate_event_logs_from_system_logs(self):
        if not self.logs or not self.events:
            return 0

        migrated = 0
        touched_event_ids = set()
        system_logs = []

        for log in self.logs:
            event_ids = [
                event_id
                for event_id in self.event_ids_from_log_action(getattr(log, 'action', ''))
                if event_id in self.events
            ]

            if not event_ids:
                system_logs.append(log)
                continue

            for event_id in event_ids:
                self.append_event_log(self.events[event_id], log)
                touched_event_ids.add(event_id)
            migrated += 1

        if not migrated:
            return 0

        for event_id in sorted(touched_event_ids):
            self.save_event(self.events[event_id])

        self.logs = system_logs
        self.save_logs()
        logger.info("Migrated %s event-related log entries into %s event file(s).", migrated, len(touched_event_ids))
        return migrated

    # ---------------- Users ----------------

    def load_users(self):
        self.users = {}
        filepath = self._data_path('Users.csv')
        if not os.path.exists(filepath):
            return

        needs_save = False

        with open(filepath, 'r', newline='') as f:
            reader = csv.reader(f)
            for row in reader:
                if not row:
                    continue

                # Optional: skip header row if one ever gets added manually
                if row[0].strip().lower() == 'username':
                    continue

                # Old format:
                # username,password_hash,salt,is_admin
                #
                # New format:
                # username,password_hash,salt,is_admin,is_active
                #
                # Current format:
                # username,password_hash,salt,is_admin,is_active,last_online
                if len(row) < 4:
                    continue

                username = row[0].strip()
                password_hash = row[1]
                salt = row[2]

                is_admin = _parse_bool(row[3], False)

                if len(row) >= 5:
                    is_active = _parse_bool(row[4], True)
                else:
                    # Older user rows did not store activity status.
                    is_active = True
                    needs_save = True

                if len(row) >= 6:
                    last_online = row[5].strip() or '-'
                else:
                    last_online = '-'
                    needs_save = True

                self.users[username] = User(
                    username,
                    password_hash,
                    salt,
                    is_admin,
                    is_active,
                    last_online,
                )

        if needs_save:
            self.save_users()

    def save_users(self):
        filepath = self._data_path('Users.csv')
        with open(filepath, 'w', newline='') as f:
            writer = csv.writer(f)
            for user in self.users.values():
                writer.writerow([
                    user.username,
                    user.password_hash,
                    user.salt,
                    user.is_admin,
                    getattr(user, 'is_active', True),
                    getattr(user, 'last_online', '-'),
                ])

    def update_username_references(self, old_username, new_username):
        """Rename historical user references owned by the live CSV data set."""
        old_username = str(old_username or '').strip()
        new_username = str(new_username or '').strip()
        counts = {
            'systemLogs': 0,
            'eventLogs': 0,
            'events': 0,
            'maintenanceLogs': 0,
            'containerMaintenanceLogs': 0,
            'assetChangeHistory': 0,
            'assets': 0,
        }
        if not old_username or not new_username or old_username == new_username:
            return counts

        logs_changed = False
        for log in self.logs:
            changed = False
            if getattr(log, 'user', '') == old_username:
                log.user = new_username
                changed = True

            action = getattr(log, 'action', '')
            updated_action = _replace_generated_username_references(action, old_username, new_username)
            if updated_action != action:
                log.action = updated_action
                changed = True

            if changed:
                logs_changed = True
                counts['systemLogs'] += 1

        if logs_changed:
            self.save_logs()

        for event in self.events.values():
            event_changed = False
            updated_logs = []
            for record in self.normalize_event_logs(getattr(event, 'event_logs', [])):
                changed = False
                if record.get('user', '') == old_username:
                    record['user'] = new_username
                    changed = True

                action = record.get('action', '')
                updated_action = _replace_generated_username_references(action, old_username, new_username)
                if updated_action != action:
                    record['action'] = updated_action
                    changed = True

                if changed:
                    event_changed = True
                    counts['eventLogs'] += 1
                updated_logs.append(record)

            if event_changed:
                event.event_logs = updated_logs
                self.save_event(event)
                counts['events'] += 1

        inventory_changed = False
        for item in self.inventory.values():
            item_changed = False
            updated_logs = []
            for log in getattr(item, 'maintenance_logs', []) or []:
                record = normalize_maintenance_log(log)
                changed = False

                if record.get('user', '') == old_username:
                    record['user'] = new_username
                    changed = True

                source = record.get('source') or {}
                if source.get('kind') == 'asset_check_sighting':
                    description = record.get('description', '')
                    updated_description = _replace_generated_username_references(
                        description,
                        old_username,
                        new_username
                    )
                    if updated_description != description:
                        record['description'] = updated_description
                        changed = True

                if changed:
                    item_changed = True
                    counts['maintenanceLogs'] += 1
                updated_logs.append(record)

            updated_history = []
            for history_record in normalize_asset_change_history(getattr(item, 'change_history', [])):
                if history_record.get('user', '') == old_username:
                    history_record['user'] = new_username
                    item_changed = True
                    counts['assetChangeHistory'] += 1
                updated_history.append(history_record)

            if item_changed:
                item.maintenance_logs = updated_logs
                item.change_history = updated_history
                inventory_changed = True
                counts['assets'] += 1

        if inventory_changed:
            self.save_inventory()

        containers_changed = False
        for container in self.containers.values():
            container_changed = False
            updated_logs = []
            for log in getattr(container, 'maintenance_logs', []) or []:
                record = normalize_maintenance_log(log)
                if record.get('user', '') == old_username:
                    record['user'] = new_username
                    container_changed = True
                    counts['containerMaintenanceLogs'] += 1
                updated_logs.append(record)
            if container_changed:
                container.maintenance_logs = updated_logs
                containers_changed = True

        if containers_changed:
            self.save_containers()

        return counts

    # ---------------- Inventory ----------------

    def _read_inventory_file(self, filepath):
        inventory = {}
        if not os.path.exists(filepath):
            return inventory

        f, enc = open_csv_robust(filepath)
        try:
            if enc not in UTF8_ENCODINGS:
                logger.warning("Inventory.csv decoded using %s. Consider re-saving as UTF-8.", enc)
            reader = csv.DictReader(f)
            for row in reader:
                if not row:
                    continue

                row = {k: clean_csv_cell(v) for k, v in row.items()}

                maintenance_logs = load_maintenance_logs(row.get('MaintenanceLogs', ''))
                department_code = row.get('DepartmentCode', 'UN')
                is_ooc = _is_csv_true(row.get('IsOOC'))
                is_degraded = _is_csv_true(row.get('IsDegraded'))
                is_disposed = _is_csv_true(row.get('IsDisposed'))
                is_bulk = _is_csv_true(row.get('IsBulk'))
                try:
                    quantity = int(row.get('Quantity', '1') or '1')
                except ValueError:
                    quantity = 1

                item = InventoryItem(
                    asset_id=row.get('AssetID', ''),
                    brand=row.get('Brand', ''),
                    model_number=row.get('ModelNumber', ''),
                    serial_number=row.get('SerialNumber', ''),
                    secondary_serial_number=row.get('SecondarySerialNumber', ''),
                    description=row.get('Description', ''),
                    date_of_purchase=row.get('DateOfPurchase', row.get('PurchaseDate', '')),
                    is_missing=_is_csv_true(row.get('IsMissing')),
                    is_ooc=is_ooc,
                    is_degraded=is_degraded,
                    is_disposed=is_disposed,
                    maintenance_logs=maintenance_logs,
                    department_code=department_code,
                    default_location=row.get('DefaultLocation', 'Store'),
                    current_location=row.get('CurrentLocation', ''),
                    is_bulk=is_bulk,
                    quantity=quantity,
                    date_added=row.get('DateAdded', ''),
                    date_modified=row.get('DateModified', ''),
                    change_history=load_asset_change_history(row.get('ChangeHistory', '')),
                    notes=row.get('Notes', '')
                )

                if item.asset_id:
                    inventory[item.asset_id] = item
        finally:
            f.close()

        return inventory

    def load_inventory(self):
        filepath = self._data_path('Inventory.csv')
        self.inventory = self._read_inventory_file(filepath)

    def save_inventory(self, preserve_unknown=True, drop_asset_ids=None):
        filepath = self._data_path('Inventory.csv')
        drop_asset_ids = {str(asset_id) for asset_id in (drop_asset_ids or []) if str(asset_id)}
        inventory_to_write = {
            asset_id: item
            for asset_id, item in self.inventory.items()
            if asset_id not in drop_asset_ids
        }

        if preserve_unknown:
            for asset_id, disk_item in self._read_inventory_file(filepath).items():
                if asset_id in drop_asset_ids:
                    continue
                if asset_id not in inventory_to_write:
                    inventory_to_write[asset_id] = disk_item

        with open(filepath, 'w', newline='', encoding='utf-8') as f:
            writer = csv.DictWriter(f, fieldnames=INVENTORY_FIELDNAMES)
            writer.writeheader()
            for item in inventory_to_write.values():
                writer.writerow({
                    'AssetID': item.asset_id,
                    'Brand': item.brand,
                    'ModelNumber': item.model_number,
                    'SerialNumber': item.serial_number,
                    'SecondarySerialNumber': getattr(item, 'secondary_serial_number', ''),
                    'Description': item.description,
                    'DateOfPurchase': getattr(item, 'date_of_purchase', ''),
                    'DateAdded': getattr(item, 'date_added', ''),
                    'DateModified': getattr(item, 'date_modified', ''),
                    'ChangeHistory': dump_asset_change_history(getattr(item, 'change_history', [])),
                    'Notes': getattr(item, 'notes', ''),
                    'IsMissing': item.is_missing,
                    'IsOOC': item.is_ooc,
                    'IsDegraded': getattr(item, 'is_degraded', False),
                    'IsDisposed': getattr(item, 'is_disposed', False),
                    'IsBulk': getattr(item, 'is_bulk', False),
                    'Quantity': getattr(item, 'quantity', 1),
                    'MaintenanceLogs': dump_maintenance_logs(item.maintenance_logs),
                    'DepartmentCode': item.department_code,
                    'DefaultLocation': item.default_location,
                    'CurrentLocation': item.current_location
                })
        self.inventory = inventory_to_write

    # ---------------- Containers ----------------

    def load_containers(self):
        self.containers = {}
        filepath = self._data_path('Containers.csv')
        if not os.path.exists(filepath):
            return

        f, enc = open_csv_robust(filepath)
        try:
            if enc not in UTF8_ENCODINGS:
                logger.warning("Containers.csv decoded using %s. Consider re-saving as UTF-8.", enc)
            reader = csv.reader(f)
            for row in reader:
                if not row:
                    continue
                row = [clean_csv_cell(c) for c in row]
                container_id = row[0]
                asset_ids = row[1].split('|') if len(row) > 1 and row[1] else []
                asset_ids = [clean_csv_cell(a) for a in asset_ids if clean_csv_cell(a)]
                serial_number = row[2] if len(row) > 2 else ''
                maintenance_logs = load_maintenance_logs(row[3] if len(row) > 3 else '')
                if container_id:
                    self.containers[container_id] = Container(
                        container_id,
                        asset_ids,
                        serial_number,
                        maintenance_logs,
                    )
        finally:
            f.close()

    def save_containers(self):
        filepath = self._data_path('Containers.csv')
        with open(filepath, 'w', newline='', encoding='utf-8') as f:
            writer = csv.writer(f)
            for container in self.containers.values():
                writer.writerow([
                    container.container_id,
                    '|'.join(container.asset_ids),
                    getattr(container, 'serial_number', ''),
                    dump_maintenance_logs(getattr(container, 'maintenance_logs', [])),
                ])

    # ---------------- Events ----------------

    def _load_event_json_list(self, event_data, fieldname, filename):
        value = event_data.get(fieldname)
        if not value:
            return []
        try:
            return json.loads(value)
        except json.JSONDecodeError as e:
            logger.error("Error parsing '%s' in event file %s: %s. Setting to empty list.", fieldname, filename, e)
            return []

    def load_events(self):
        self.events = {}
        self.event_file_map = {}
        if not os.path.exists(self.events_folder):
            return

        for filename in os.listdir(self.events_folder):
            if not filename.endswith('.csv'):
                continue

            filepath = os.path.join(self.events_folder, filename)
            f, enc = open_csv_robust(filepath)
            try:
                if enc not in UTF8_ENCODINGS:
                    logger.warning("Event file %s decoded using %s. Consider re-saving as UTF-8.", filename, enc)

                reader = csv.DictReader(f)
                event_data = next(reader, None)
                if not event_data:
                    logger.warning("Event file %s is empty or corrupted.", filename)
                    continue

                raw_notes = event_data.get('Notes', '') or ''
                event_data = {k: clean_csv_cell(v) for k, v in event_data.items()}

                try:
                    event_id = int(event_data.get('EventID', '0') or '0')
                except ValueError:
                    logger.warning("Event file %s has invalid EventID: %s", filename, event_data.get('EventID'))
                    continue

                name = event_data.get('Name', '')
                start_date = event_data.get('StartDate', event_data.get('Date', ''))
                end_date = event_data.get('EndDate', start_date)

                asset_models = []
                if event_data.get('AssetModels'):
                    try:
                        asset_models = eval(event_data['AssetModels'])
                    except Exception as e:
                        logger.error("Error parsing 'AssetModels' in event file %s: %s. Setting to empty list.", filename, e)
                        asset_models = []

                prepared_items = []
                if event_data.get('PreparedItems'):
                    prepared_items = self._load_event_json_list(event_data, 'PreparedItems', filename)

                returned_items = self._load_event_json_list(event_data, 'ReturnedItems', filename)
                actually_prepared = self._load_event_json_list(event_data, 'ActuallyPrepared', filename)
                extra_assets = self._load_event_json_list(event_data, 'ExtraAssets', filename)
                custom_collected = self._load_event_json_list(event_data, 'CustomCollected', filename)
                event_logs = []
                if event_data.get('EventLogs'):
                    event_logs = self.normalize_event_logs(self._load_event_json_list(event_data, 'EventLogs', filename))

                raw_state = event_data.get('State', 'New')
                state = normalize_event_state(raw_state)
                tag = event_data.get('Tag', 'events')
                force_state_override = _is_csv_true(event_data.get('ForceStateOverride'))

                event = Event(
                    event_id=event_id,
                    name=name,
                    location=event_data.get('Location', ''),
                    start_date=start_date,
                    end_date=end_date,
                    asset_models=asset_models,
                    prepared_items=prepared_items,
                    state=state,
                    returned_items=returned_items,
                    actually_prepared=actually_prepared,
                    extra_assets=extra_assets,
                    tag=tag,
                    force_state_override=force_state_override,
                    custom_collected=custom_collected,
                    notes=raw_notes,
                    event_logs=event_logs
                )

                event.actually_prepared = actually_prepared
                event.extra_assets = extra_assets
                event.tag = tag
                event.force_state_override = force_state_override
                event.custom_collected = custom_collected
                event.notes = raw_notes
                event.event_logs = event_logs
                event._legacy_state_migrated = str(raw_state or '').strip() != state

                self.events[event_id] = event
                self.event_file_map[event_id] = filename
            finally:
                f.close()

    def save_event(self, event):
        event.state = normalize_event_state(getattr(event, 'state', 'New'))
        if hasattr(self, 'event_file_map') and event.event_id in self.event_file_map:
            self.backup_event_file(event.event_id)
        
        filename = self._event_filename(event)
        filepath = os.path.join(self.events_folder, filename)
        old_filename = self.event_file_map.get(event.event_id)
        
        # Older Event instances may not have newer fields until they are saved once.
        actually_prepared = getattr(event, 'actually_prepared', [])
        extra_assets = getattr(event, 'extra_assets', [])
        tag = getattr(event, 'tag', 'events')
        force_state_override = getattr(event, 'force_state_override', False)
        custom_collected = getattr(event, 'custom_collected', [])
        notes = getattr(event, 'notes', '')
        location = getattr(event, 'location', '')
        event_logs = self.normalize_event_logs(getattr(event, 'event_logs', []))
        
        if not hasattr(event, 'prepared_items'):
            logger.error("Event %s missing prepared_items - NOT SAVING to prevent data loss!", event.event_id)
            return
        
        logger.debug("Saving event %s", event.event_id)
        logger.debug("prepared_items: %s", event.prepared_items)
        logger.debug("actually_prepared: %s", actually_prepared)
        logger.debug("extra_assets: %s", extra_assets)
        logger.debug("tag: %s", tag)
        logger.debug("force_state_override: %s", force_state_override)
        
        # Validate JSON serialization before writing
        try:
            prepared_items_json = json.dumps(event.prepared_items)
            returned_items_json = json.dumps(event.returned_items)
            actually_prepared_json = json.dumps(actually_prepared)
            extra_assets_json = json.dumps(extra_assets)
            custom_collected_json = json.dumps(custom_collected)
            event_logs_json = json.dumps(event_logs)
        except (TypeError, ValueError) as e:
            logger.error("Cannot serialize event %s data to JSON: %s", event.event_id, e)
            logger.error("prepared_items: %s", event.prepared_items)
            logger.error("NOT SAVING to prevent corruption!")
            return
        
        with open(filepath, 'w', newline='', encoding='utf-8') as f:
            writer = csv.DictWriter(f, fieldnames=EVENT_FIELDNAMES)
            writer.writeheader()
            
            row_data = {
                'EventID': event.event_id,
                'Name': event.name,
                'Location': location,
                'StartDate': event.start_date,
                'EndDate': event.end_date,
                'AssetModels': repr(event.asset_models),
                'PreparedItems': prepared_items_json,
                'ReturnedItems': returned_items_json,
                'State': event.state,
                'ActuallyPrepared': actually_prepared_json,
                'ExtraAssets': extra_assets_json,
                'CustomCollected': custom_collected_json,
                'Tag': tag,
                'ForceStateOverride': str(force_state_override),
                'EventLogs': event_logs_json,
                'Notes': notes
            }
            
            logger.debug("Row data being written: %s", row_data)
            writer.writerow(row_data)

        if old_filename and old_filename != filename:
            old_filepath = os.path.join(self.events_folder, old_filename)
            if os.path.exists(old_filepath):
                os.remove(old_filepath)
            self._move_event_folder(old_filename, filename)
        
        self.event_file_map[event.event_id] = filename
        event._legacy_location_extracted = False
        logger.debug("Event %s saved successfully to %s", event.event_id, filename)

    def migrate_legacy_event_locations(self):
        """Persist locations extracted from legacy ``Name @ Location`` values."""
        migrated = 0
        for event in list(self.events.values()):
            if not getattr(event, '_legacy_location_extracted', False):
                continue
            self.save_event(event)
            migrated += 1
        return migrated

    def migrate_legacy_event_states(self):
        """Persist the canonical New state for legacy Added event records."""
        migrated = 0
        for event in list(self.events.values()):
            if not getattr(event, '_legacy_state_migrated', False):
                continue
            event.state = 'New'
            snapshots = getattr(self, '_event_snapshots', None)
            if isinstance(snapshots, dict):
                snapshots.pop(int(event.event_id), None)
            self.save_event(event)
            event._legacy_state_migrated = False
            migrated += 1
        return migrated

    def delete_event_file(self, event_id):
        folder = self.get_event_folder(event_id)
        if event_id in self.event_file_map:
            filename = self.event_file_map[event_id]
            filepath = os.path.join(self.events_folder, filename)
            if os.path.exists(filepath):
                os.remove(filepath)
            del self.event_file_map[event_id]
        if folder and os.path.isdir(folder):
            shutil.rmtree(folder)

    # ---------------- System logs ----------------

    def load_logs(self):
        self.logs = []
        filepath = self._data_path('Logs.csv')
        if not os.path.exists(filepath):
            return

        f, enc = open_csv_robust(filepath)
        try:
            if enc not in UTF8_ENCODINGS:
                logger.warning("Logs.csv decoded using %s. Consider re-saving as UTF-8.", enc)
            reader = csv.reader(f)
            for row in reader:
                if row:
                    row = [clean_csv_cell(c) for c in row]
                    if len(row) < 3:
                        continue
                    timestamp, user, action = row[:3]
                    self.logs.append(LogEntry(timestamp, user, action))
        finally:
            f.close()

    def save_logs(self):
        filepath = self._data_path('Logs.csv')
        with open(filepath, 'w', newline='', encoding='utf-8') as f:
            writer = csv.writer(f)
            for log in self.logs[-MAX_LOG_LINES:]:
                writer.writerow([log.timestamp, log.user, log.action])

    def backup_event_file(self, event_id):
        if event_id in self.event_file_map:
            filename = self.event_file_map[event_id]
            filepath = os.path.join(self.events_folder, filename)
            if os.path.exists(filepath):
                backup_folder = os.path.join(self.data_folder, 'event_backups')
                if not os.path.exists(backup_folder):
                    os.makedirs(backup_folder)
                backup_path = os.path.join(backup_folder, f"backup_{filename}")

                # binary copy so encoding can never break backups
                with open(filepath, 'rb') as original, open(backup_path, 'wb') as backup:
                    backup.write(original.read())

                logger.info("Backup created at %s.", backup_path)
            else:
                logger.warning("Event file %s does not exist. No backup created.", filename)
        else:
            logger.warning("No file mapping found for Event ID %s. Cannot create backup.", event_id)

    # ---------------- Clients ----------------

    def load_clients(self):
        self.clients = {}
        filepath = self._data_path('Clients.csv')
        if not os.path.exists(filepath):
            with open(filepath, 'w', newline='', encoding='utf-8') as f:
                writer = csv.writer(f)
                writer.writerow(CLIENT_FIELDNAMES)

        with open(filepath, 'r', newline='', encoding='utf-8') as f:
            reader = csv.DictReader(f)
            for row in reader:
                if not row:
                    continue
                c = Client(
                    name=row.get('Name', '').strip(),
                    company=row.get('Company', '').strip(),
                    address1=row.get('Address1', '').strip(),
                    address2=row.get('Address2', '').strip(),
                    address3=row.get('Address3', '').strip(),
                    postal_code=row.get('PostalCode', '').strip(),
                    phone=row.get('Phone', '').strip(),
                )
                if c.name:
                    self.clients[c.name] = c

    def save_clients(self):
        filepath = self._data_path('Clients.csv')
        with open(filepath, 'w', newline='', encoding='utf-8') as f:
            writer = csv.DictWriter(f, fieldnames=CLIENT_FIELDNAMES)
            writer.writeheader()
            for c in sorted(self.clients.values(), key=lambda x: x.name.lower()):
                writer.writerow({
                    'Name': c.name,
                    'Company': c.company,
                    'Address1': c.address1,
                    'Address2': c.address2,
                    'Address3': c.address3,
                    'PostalCode': c.postal_code,
                    'Phone': c.phone,
                })
