import os
import csv
import json
import logging
import re
import shutil
from models import User, InventoryItem, Container, Event, LogEntry, hash_password
from utils import sanitize_filename, open_csv_robust, clean_csv_cell
from maintenance_logs import dump_maintenance_logs, load_maintenance_logs

# Constants
MAX_LOG_LINES = 1000
logger = logging.getLogger(__name__)
EVENT_LOG_EVENT_ID_RE = re.compile(r'\bevent\s+(\d+)\b', re.IGNORECASE)

class DataManager:
    def __init__(self, data_folder):
        self.data_folder = data_folder
        self.events_folder = os.path.join(data_folder, 'events')
        self.users = {}
        self.inventory = {}
        self.containers = {}
        self.events = {}
        self.event_file_map = {}
        self.logs = []
        self.clients = {}

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

    def setup_data_folder(self):
        if not os.path.exists(self.events_folder):
            os.makedirs(self.events_folder)

    def check_and_initialize_files(self):
        required_files = ['Inventory.csv', 'Logs.csv', 'Users.csv', 'Containers.csv', 'Clients.csv']
        missing_files = []
        for filename in required_files:
            filepath = os.path.join(self.data_folder, filename)
            if not os.path.exists(filepath):
                missing_files.append(filename)
        if missing_files:
            logger.info("The following required files are missing and will be created: %s", ', '.join(missing_files))
            self.initialize_files()
        else:
            logger.info("All required files are present.")

    def initialize_files(self):
        required_files = ['Inventory.csv', 'Logs.csv', 'Users.csv', 'Containers.csv', 'Clients.csv']
        for filename in required_files:
            filepath = os.path.join(self.data_folder, filename)
            if not os.path.exists(filepath):
                with open(filepath, 'w', newline='') as f:
                    pass  # Create empty file
        
        # Add default admin user if Users.csv was missing or empty
        users_file = os.path.join(self.data_folder, 'Users.csv')
        if os.path.getsize(users_file) == 0:
            salt = 'admin'
            password_hash = hash_password('admin', salt)
            self.users['admin'] = User('admin', password_hash, salt, True, True)
            self.save_users()
            logger.info("Default admin user created.")
        logger.info("Required files have been initialized.")

    def load_all_data(self):
        self.load_users()
        self.load_inventory()
        self.load_containers()
        self.load_events()
        self.load_logs()
        self.migrate_event_logs_from_system_logs()
        self.load_clients()

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

    def load_users(self):
        self.users = {}
        filepath = os.path.join(self.data_folder, 'Users.csv')
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
                if len(row) < 4:
                    continue

                username = row[0].strip()
                password_hash = row[1]
                salt = row[2]

                def parse_bool(value, default=False):
                    if value is None:
                        return default
                    return str(value).strip().lower() in ('true', '1', 'yes', 'y', 'admin')

                is_admin = parse_bool(row[3], False)

                if len(row) >= 5:
                    is_active = parse_bool(row[4], True)
                else:
                    # Backward compatibility: old existing users stay active
                    is_active = True
                    needs_save = True

                self.users[username] = User(username, password_hash, salt, is_admin, is_active)

        # Auto-upgrade Users.csv from 4 columns to 5 columns
        if needs_save:
            self.save_users()

    def save_users(self):
        filepath = os.path.join(self.data_folder, 'Users.csv')
        with open(filepath, 'w', newline='') as f:
            writer = csv.writer(f)
            for user in self.users.values():
                writer.writerow([
                    user.username,
                    user.password_hash,
                    user.salt,
                    user.is_admin,
                    getattr(user, 'is_active', True)
                ])

    def load_inventory(self):
        self.inventory = {}
        filepath = os.path.join(self.data_folder, 'Inventory.csv')
        if not os.path.exists(filepath):
            return

        f, enc = open_csv_robust(filepath)
        try:
            if enc not in ("utf-8", "utf-8-sig"):
                logger.warning("Inventory.csv decoded using %s. Consider re-saving as UTF-8.", enc)
            reader = csv.DictReader(f)
            for row in reader:
                if not row:
                    continue

                # clean all values
                row = {k: clean_csv_cell(v) for k, v in row.items()}

                maintenance_logs = load_maintenance_logs(row.get('MaintenanceLogs', ''))
                department_code = row.get('DepartmentCode', 'UN')
                is_ooc = row.get('IsOOC', 'False') == 'True'
                is_degraded = row.get('IsDegraded', 'False') == 'True'
                is_disposed = row.get('IsDisposed', 'False') == 'True'
                is_bulk = row.get('IsBulk', 'False') == 'True'
                try:
                    quantity = int(row.get('Quantity', '1') or '1')
                except ValueError:
                    quantity = 1

                item = InventoryItem(
                    asset_id=row.get('AssetID', ''),
                    brand=row.get('Brand', ''),
                    model_number=row.get('ModelNumber', ''),
                    serial_number=row.get('SerialNumber', ''),
                    description=row.get('Description', ''),
                    is_missing=row.get('IsMissing', 'False') == 'True',
                    is_ooc=is_ooc,
                    is_degraded=is_degraded,
                    is_disposed=is_disposed,
                    maintenance_logs=maintenance_logs,
                    department_code=department_code,
                    default_location=row.get('DefaultLocation', 'Store'),
                    current_location=row.get('CurrentLocation', ''),
                    is_bulk=is_bulk,
                    quantity=quantity
                )

                if item.asset_id:
                    self.inventory[item.asset_id] = item
        finally:
            f.close()

    def save_inventory(self):
        filepath = os.path.join(self.data_folder, 'Inventory.csv')
        with open(filepath, 'w', newline='', encoding='utf-8') as f:
            fieldnames = [
                'AssetID', 'Brand', 'ModelNumber', 'SerialNumber', 'Description',
                'IsMissing', 'IsOOC', 'IsDegraded', 'IsDisposed', 'IsBulk', 'Quantity', 'MaintenanceLogs', 'DepartmentCode', 'DefaultLocation', 'CurrentLocation'
            ]
            writer = csv.DictWriter(f, fieldnames=fieldnames)
            writer.writeheader()
            for item in self.inventory.values():
                writer.writerow({
                    'AssetID': item.asset_id,
                    'Brand': item.brand,
                    'ModelNumber': item.model_number,
                    'SerialNumber': item.serial_number,
                    'Description': item.description,
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


    def load_containers(self):
        self.containers = {}
        filepath = os.path.join(self.data_folder, 'Containers.csv')
        if not os.path.exists(filepath):
            return

        f, enc = open_csv_robust(filepath)
        try:
            if enc not in ("utf-8", "utf-8-sig"):
                logger.warning("Containers.csv decoded using %s. Consider re-saving as UTF-8.", enc)
            reader = csv.reader(f)
            for row in reader:
                if not row:
                    continue
                row = [clean_csv_cell(c) for c in row]
                container_id = row[0]
                asset_ids = row[1].split('|') if len(row) > 1 and row[1] else []
                asset_ids = [clean_csv_cell(a) for a in asset_ids if clean_csv_cell(a)]
                if container_id:
                    self.containers[container_id] = Container(container_id, asset_ids)
        finally:
            f.close()

    def save_containers(self):
        filepath = os.path.join(self.data_folder, 'Containers.csv')
        with open(filepath, 'w', newline='', encoding='utf-8') as f:
            writer = csv.writer(f)
            for container in self.containers.values():
                writer.writerow([container.container_id, '|'.join(container.asset_ids)])

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
                if enc not in ("utf-8", "utf-8-sig"):
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
                    try:
                        prepared_items = json.loads(event_data['PreparedItems'])
                    except json.JSONDecodeError as e:
                        logger.error("Error parsing 'PreparedItems' in event file %s: %s. Setting to empty list.", filename, e)
                        prepared_items = []

                returned_items = []
                if event_data.get('ReturnedItems'):
                    try:
                        returned_items = json.loads(event_data['ReturnedItems'])
                    except json.JSONDecodeError as e:
                        logger.error("Error parsing 'ReturnedItems' in event file %s: %s. Setting to empty list.", filename, e)
                        returned_items = []

                actually_prepared = []
                if event_data.get('ActuallyPrepared'):
                    try:
                        actually_prepared = json.loads(event_data['ActuallyPrepared'])
                    except json.JSONDecodeError as e:
                        logger.error("Error parsing 'ActuallyPrepared' in event file %s: %s. Setting to empty list.", filename, e)
                        actually_prepared = []

                extra_assets = []
                if event_data.get('ExtraAssets'):
                    try:
                        extra_assets = json.loads(event_data['ExtraAssets'])
                    except json.JSONDecodeError as e:
                        logger.error("Error parsing 'ExtraAssets' in event file %s: %s. Setting to empty list.", filename, e)
                        extra_assets = []

                custom_collected = []
                if event_data.get('CustomCollected'):
                    try:
                        custom_collected = json.loads(event_data['CustomCollected'])
                    except json.JSONDecodeError as e:
                        logger.error("Error parsing 'CustomCollected' in event file %s: %s. Setting to empty list.", filename, e)
                        custom_collected = []

                event_logs = []
                if event_data.get('EventLogs'):
                    try:
                        event_logs = self.normalize_event_logs(json.loads(event_data['EventLogs']))
                    except json.JSONDecodeError as e:
                        logger.error("Error parsing 'EventLogs' in event file %s: %s. Setting to empty list.", filename, e)
                        event_logs = []

                state = event_data.get('State', 'Added')
                tag = event_data.get('Tag', 'events')
                force_state_override = event_data.get('ForceStateOverride', 'False') == 'True'

                event = Event(
                    event_id=event_id,
                    name=name,
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

                self.events[event_id] = event
                self.event_file_map[event_id] = filename
            finally:
                f.close()

    def save_event(self, event):
        # Create backup before saving
        if hasattr(self, 'event_file_map') and event.event_id in self.event_file_map:
            self.backup_event_file(event.event_id)
        
        filename = self._event_filename(event)
        filepath = os.path.join(self.events_folder, filename)
        old_filename = self.event_file_map.get(event.event_id)
        
        # Ensure attributes exist
        actually_prepared = getattr(event, 'actually_prepared', [])
        extra_assets = getattr(event, 'extra_assets', [])
        tag = getattr(event, 'tag', 'events')
        force_state_override = getattr(event, 'force_state_override', False)
        custom_collected = getattr(event, 'custom_collected', [])
        notes = getattr(event, 'notes', '')
        event_logs = self.normalize_event_logs(getattr(event, 'event_logs', []))
        
        # VALIDATION: Don't save if critical data is missing
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
            fieldnames = ['EventID', 'Name', 'StartDate', 'EndDate', 'AssetModels', 'PreparedItems', 'ReturnedItems', 'State', 'ActuallyPrepared', 'ExtraAssets', 'CustomCollected', 'Tag', 'ForceStateOverride', 'EventLogs', 'Notes']
            writer = csv.DictWriter(f, fieldnames=fieldnames)
            writer.writeheader()
            
            row_data = {
                'EventID': event.event_id,
                'Name': event.name,
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
        logger.debug("Event %s saved successfully to %s", event.event_id, filename)

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

    def load_logs(self):
        self.logs = []
        filepath = os.path.join(self.data_folder, 'Logs.csv')
        if not os.path.exists(filepath):
            return

        f, enc = open_csv_robust(filepath)
        try:
            if enc not in ("utf-8", "utf-8-sig"):
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
        filepath = os.path.join(self.data_folder, 'Logs.csv')
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
    
    def load_clients(self):
        import csv, os
        self.clients = {}
        filepath = os.path.join(self.data_folder, 'Clients.csv')
        if not os.path.exists(filepath):
            # when creating Clients.csv from scratch
            with open(os.path.join(self.data_folder, 'Clients.csv'), 'w', newline='', encoding='utf-8') as f:
                writer = csv.writer(f)
                writer.writerow(['Name','Company','Address1','Address2','Address3','PostalCode','Phone'])
        from models import Client
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
        import csv, os
        filepath = os.path.join(self.data_folder, 'Clients.csv')
        fieldnames = ['Name', 'Company', 'Address1', 'Address2', 'Address3', 'PostalCode', 'Phone']
        with open(filepath, 'w', newline='', encoding='utf-8') as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames)
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
