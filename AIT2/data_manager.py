import os
import csv
import json
from models import User, InventoryItem, Container, Event, LogEntry, hash_password
from utils import sanitize_filename

# Constants
MAX_LOG_LINES = 1000

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

    def setup_data_folder(self):
        if not os.path.exists(self.events_folder):
            os.makedirs(self.events_folder)

    def check_and_initialize_files(self):
        required_files = ['Inventory.csv', 'Logs.csv', 'Users.csv', 'Containers.csv']
        missing_files = []
        for filename in required_files:
            filepath = os.path.join(self.data_folder, filename)
            if not os.path.exists(filepath):
                missing_files.append(filename)
        if missing_files:
            print(f"The following required files are missing and will be created: {', '.join(missing_files)}")
            self.initialize_files()
        else:
            print("All required files are present.")

    def initialize_files(self):
        required_files = ['Inventory.csv', 'Logs.csv', 'Users.csv', 'Containers.csv']
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
            self.users['admin'] = User('admin', password_hash, salt, True)
            self.save_users()
            print("Default admin user created.")
        print("Required files have been initialized.")

    def load_all_data(self):
        self.load_users()
        self.load_inventory()
        self.load_containers()
        self.load_events()
        self.load_logs()

    def load_users(self):
        filepath = os.path.join(self.data_folder, 'Users.csv')
        if not os.path.exists(filepath):
            return
        with open(filepath, 'r', newline='') as f:
            reader = csv.reader(f)
            for row in reader:
                if row:
                    username, password_hash, salt, is_admin = row
                    self.users[username] = User(username, password_hash, salt, is_admin == 'True')

    def save_users(self):
        filepath = os.path.join(self.data_folder, 'Users.csv')
        with open(filepath, 'w', newline='') as f:
            writer = csv.writer(f)
            for user in self.users.values():
                writer.writerow([user.username, user.password_hash, user.salt, user.is_admin])

    def load_inventory(self):
        filepath = os.path.join(self.data_folder, 'Inventory.csv')
        if not os.path.exists(filepath):
            return
        with open(filepath, 'r', newline='', encoding='utf-8') as f:
            reader = csv.DictReader(f)
            for row in reader:
                if row:
                    maintenance_logs = row['MaintenanceLogs'].split('|') if row['MaintenanceLogs'] else []
                    department_code = row.get('DepartmentCode', 'UN')
                    is_ooc = row.get('IsOOC', 'False') == 'True'
                    item = InventoryItem(
                        asset_id=row['AssetID'],
                        brand=row['Brand'],
                        model_number=row['ModelNumber'],
                        serial_number=row['SerialNumber'],
                        description=row.get('Description',''),  # This should be the full description
                        is_missing=row['IsMissing'] == 'True',
                        is_ooc=is_ooc,
                        maintenance_logs=maintenance_logs,
                        department_code=department_code,
                        default_location=row.get('DefaultLocation', 'Store'),
                        current_location=row.get('CurrentLocation', '')
                    )
                    self.inventory[item.asset_id] = item
    def save_inventory(self):
        filepath = os.path.join(self.data_folder, 'Inventory.csv')
        with open(filepath, 'w', newline='') as f:
            fieldnames = [
                'AssetID', 'Brand', 'ModelNumber', 'SerialNumber', 'Description',
                'IsMissing', 'IsOOC', 'MaintenanceLogs', 'DepartmentCode', 'DefaultLocation', 'CurrentLocation'
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
                    'MaintenanceLogs': '|'.join(item.maintenance_logs),
                    'DepartmentCode': item.department_code,
                    'DefaultLocation': item.default_location,
                    'CurrentLocation': item.current_location
                })

    def load_containers(self):
        filepath = os.path.join(self.data_folder, 'Containers.csv')
        if not os.path.exists(filepath):
            return
        with open(filepath, 'r', newline='') as f:
            reader = csv.reader(f)
            for row in reader:
                if row:
                    container_id = row[0]
                    asset_ids = row[1].split('|') if len(row) > 1 and row[1] else []
                    self.containers[container_id] = Container(container_id, asset_ids)

    def save_containers(self):
        filepath = os.path.join(self.data_folder, 'Containers.csv')
        with open(filepath, 'w', newline='') as f:
            writer = csv.writer(f)
            for container in self.containers.values():
                writer.writerow([container.container_id, '|'.join(container.asset_ids)])

    def load_events(self):
        self.events = {}
        self.event_file_map = {}
        if not os.path.exists(self.events_folder):
            return
        for filename in os.listdir(self.events_folder):
            if filename.endswith('.csv'):
                filepath = os.path.join(self.events_folder, filename)
                with open(filepath, 'r', newline='') as f:
                    reader = csv.DictReader(f)
                    event_data = next(reader, None)
                    if not event_data:
                        print(f"Warning: Event file {filename} is empty or corrupted.")
                        continue
                    event_id = int(event_data['EventID'])
                    name = event_data['Name']
                    start_date = event_data.get('StartDate', event_data.get('Date', ''))
                    end_date = event_data.get('EndDate', start_date)
                    asset_models = []
                    if event_data.get('AssetModels'):
                        try:
                            asset_models = eval(event_data['AssetModels'])
                        except Exception as e:
                            print(f"Error parsing 'AssetModels' in event file {filename}: {e}. Skipping...")
                            continue
                    
                    prepared_items = []
                    returned_items = []
                    actually_prepared = []
                    extra_assets = []
                    
                    # IMPROVED PARSING WITH BETTER ERROR HANDLING
                    if event_data.get('PreparedItems'):
                        try:
                            prepared_items_raw = event_data['PreparedItems']
                            print(f"DEBUG: Parsing PreparedItems for {filename}: '{prepared_items_raw[:100]}...'")
                            prepared_items = json.loads(prepared_items_raw)
                            print(f"DEBUG: Successfully parsed {len(prepared_items)} prepared items for {filename}")
                        except json.JSONDecodeError as e:
                            print(f"ERROR: Failed to parse 'PreparedItems' in event file {filename}")
                            print(f"ERROR: JSON Error: {e}")
                            print(f"ERROR: Raw data: '{event_data['PreparedItems'][:200]}...'")
                            # DO NOT SET TO EMPTY - TRY TO RECOVER THE DATA
                            print(f"ERROR: KEEPING EXISTING prepared_items to prevent data loss!")
                            # Try to load the previous version from memory if exists
                            if event_id in self.events:
                                prepared_items = self.events[event_id].prepared_items
                                print(f"ERROR: Recovered {len(prepared_items)} items from memory")
                            else:
                                prepared_items = []
                                print(f"ERROR: No previous data to recover - initializing as empty")
                            
                    if event_data.get('ReturnedItems'):
                        try:
                            returned_items_raw = event_data['ReturnedItems']
                            returned_items = json.loads(returned_items_raw)
                        except json.JSONDecodeError as e:
                            print(f"ERROR: Failed to parse 'ReturnedItems' in event file {filename}: {e}")
                            print(f"ERROR: Raw data: '{event_data['ReturnedItems'][:200]}...'")
                            if event_id in self.events:
                                returned_items = self.events[event_id].returned_items
                                print(f"ERROR: Recovered returned_items from memory")
                            else:
                                returned_items = []
                            
                    # Handle ActuallyPrepared field (might not exist in older files)
                    if event_data.get('ActuallyPrepared'):
                        try:
                            actually_prepared_raw = event_data['ActuallyPrepared']
                            actually_prepared = json.loads(actually_prepared_raw)
                        except json.JSONDecodeError as e:
                            print(f"ERROR: Failed to parse 'ActuallyPrepared' in event file {filename}: {e}")
                            print(f"ERROR: Raw data: '{event_data['ActuallyPrepared'][:200]}...'")
                            if event_id in self.events:
                                actually_prepared = self.events[event_id].actually_prepared
                                print(f"ERROR: Recovered actually_prepared from memory")
                            else:
                                actually_prepared = []
                    else:
                        # For backward compatibility - if field doesn't exist, initialize empty
                        actually_prepared = []
                            
                    # Handle ExtraAssets field (might not exist in older files)
                    if event_data.get('ExtraAssets'):
                        try:
                            extra_assets_raw = event_data['ExtraAssets']
                            extra_assets = json.loads(extra_assets_raw)
                        except json.JSONDecodeError as e:
                            print(f"ERROR: Failed to parse 'ExtraAssets' in event file {filename}: {e}")
                            if event_id in self.events:
                                extra_assets = self.events[event_id].extra_assets
                            else:
                                extra_assets = []
                    else:
                        # For backward compatibility - if field doesn't exist, initialize empty
                        extra_assets = []
                            
                    state = event_data.get('State', 'Added')
                    # Get tag from CSV, default to 'events' for backward compatibility
                    tag = event_data.get('Tag', 'events')
                    
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
                        tag=tag
                    )
                    
                    # Ensure the attributes are set (in case the Event constructor doesn't handle them properly)
                    event.actually_prepared = actually_prepared
                    event.extra_assets = extra_assets
                    event.tag = tag
                    
                    print(f"DEBUG: Successfully loaded event {event_id} with {len(prepared_items)} prepared items")
                    
                    self.events[event_id] = event
                    self.event_file_map[event_id] = filename

    def save_event(self, event):
        # Create backup before saving
        if hasattr(self, 'event_file_map') and event.event_id in self.event_file_map:
            self.backup_event_file(event.event_id)
        
        sanitized_name = sanitize_filename(event.name)
        filename = f"{event.event_id}. [{event.start_date}] {sanitized_name}.csv"
        filepath = os.path.join(self.events_folder, filename)
        
        # Ensure attributes exist
        actually_prepared = getattr(event, 'actually_prepared', [])
        extra_assets = getattr(event, 'extra_assets', [])
        tag = getattr(event, 'tag', 'events')
        
        # VALIDATION: Don't save if critical data is missing
        if not hasattr(event, 'prepared_items'):
            print(f"ERROR: Event {event.event_id} missing prepared_items - NOT SAVING to prevent data loss!")
            return
        
        print(f"DEBUG: Saving event {event.event_id}")
        print(f"DEBUG: prepared_items: {event.prepared_items}")
        print(f"DEBUG: actually_prepared: {actually_prepared}")
        print(f"DEBUG: extra_assets: {extra_assets}")
        print(f"DEBUG: tag: {tag}")
        
        # Validate JSON serialization before writing
        try:
            prepared_items_json = json.dumps(event.prepared_items)
            returned_items_json = json.dumps(event.returned_items)
            actually_prepared_json = json.dumps(actually_prepared)
            extra_assets_json = json.dumps(extra_assets)
        except (TypeError, ValueError) as e:
            print(f"ERROR: Cannot serialize event {event.event_id} data to JSON: {e}")
            print(f"ERROR: prepared_items: {event.prepared_items}")
            print(f"ERROR: NOT SAVING to prevent corruption!")
            return
        
        with open(filepath, 'w', newline='') as f:
            fieldnames = ['EventID', 'Name', 'StartDate', 'EndDate', 'AssetModels', 'PreparedItems', 'ReturnedItems', 'State', 'ActuallyPrepared', 'ExtraAssets', 'Tag']
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
                'Tag': tag
            }
            
            print(f"DEBUG: Row data being written: {row_data}")
            writer.writerow(row_data)

        old_filename = self.event_file_map.get(event.event_id)
        if old_filename and old_filename != filename:
            old_filepath = os.path.join(self.events_folder, old_filename)
            if os.path.exists(old_filepath):
                os.remove(old_filepath)
        
        self.event_file_map[event.event_id] = filename
        print(f"DEBUG: Event {event.event_id} saved successfully to {filename}")
        
    def delete_event_file(self, event_id):
        if event_id in self.event_file_map:
            filename = self.event_file_map[event_id]
            filepath = os.path.join(self.events_folder, filename)
            if os.path.exists(filepath):
                os.remove(filepath)
            del self.event_file_map[event_id]

    def load_logs(self):
        filepath = os.path.join(self.data_folder, 'Logs.csv')
        if not os.path.exists(filepath):
            return
        with open(filepath, 'r', newline='') as f:
            reader = csv.reader(f)
            for row in reader:
                if row:
                    timestamp, user, action = row
                    self.logs.append(LogEntry(timestamp, user, action))

    def save_logs(self):
        filepath = os.path.join(self.data_folder, 'Logs.csv')
        with open(filepath, 'w', newline='') as f:
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
                with open(filepath, 'r') as original, open(backup_path, 'w') as backup:
                    backup.write(original.read())
                print(f"Backup created at {backup_path}.")
            else:
                print(f"Event file {filename} does not exist. No backup created.")
        else:
            print(f"No file mapping found for Event ID {event_id}. Cannot create backup.")