import ast
import os
import csv
import hashlib
import getpass
import datetime
import sys
import re
import subprocess
import json
from collections import defaultdict

# Constants
MAX_LOG_LINES = 1000
DATE_FORMAT = "%Y/%m/%d"  # Changed to include slashes

# Helper functions
def hash_password(password, salt):
    return hashlib.sha256((salt + password).encode()).hexdigest()

def get_current_date():
    return datetime.datetime.now().strftime(DATE_FORMAT)

def clear_screen():
    os.system('cls' if os.name == 'nt' else 'clear')

def pause():
    input("\nPress Enter to continue...")

def sanitize_filename(filename):
    return re.sub(r'[<>:"/\\|?*]', '_', filename)

def play_sound(success=True):
    if sys.platform == 'darwin':  # Check if the OS is macOS
        if success:
            subprocess.Popen(['afplay', '/System/Library/Sounds/Glass.aiff'])
        else:
            subprocess.Popen(['afplay', '/System/Library/Sounds/Sosumi.aiff'])

def parse_date_input(date_str):
    try:
        date_obj = datetime.datetime.strptime(date_str.strip(), DATE_FORMAT)
        return date_obj.strftime("%Y%m%d")  # Return date in 'YYYYMMDD' format for storage
    except ValueError:
        return None

def format_date_output(date_str):
    return datetime.datetime.strptime(date_str, "%Y%m%d").strftime(DATE_FORMAT)

def dates_overlap(start1, end1, start2, end2):
    start1 = datetime.datetime.strptime(start1, "%Y%m%d")
    end1 = datetime.datetime.strptime(end1, "%Y%m%d")
    start2 = datetime.datetime.strptime(start2, "%Y%m%d")
    end2 = datetime.datetime.strptime(end2, "%Y%m%d")
    return max(start1, start2) <= min(end1, end2)

# Classes for data management
class User:
    def __init__(self, username, password_hash, salt, is_admin):
        self.username = username
        self.password_hash = password_hash
        self.salt = salt
        self.is_admin = is_admin

class InventoryItem:
    def __init__(self, asset_id, brand, model_number, serial_number, description, is_missing, maintenance_logs, department_code, default_location='', current_location='', is_ooc=False):
        self.asset_id = asset_id
        self.brand = brand
        self.model_number = model_number
        self.serial_number = serial_number
        self.description = description
        self.is_missing = is_missing
        self.is_ooc = is_ooc  # Out of Commission
        self.maintenance_logs = maintenance_logs
        self.department_code = department_code.upper()
        self.default_location = default_location
        self.current_location = current_location

class Container:
    def __init__(self, container_id, asset_ids):
        self.container_id = container_id
        self.asset_ids = asset_ids  # List of asset IDs

class Event:
    def __init__(self, event_id, name, start_date, end_date, asset_models, prepared_items=None, state='Added', returned_items=None):
        self.event_id = event_id
        self.name = name
        self.start_date = start_date
        self.end_date = end_date
        self.asset_models = asset_models
        self.prepared_items = prepared_items if prepared_items is not None else []  # List of specific asset IDs or loan/misc items
        self.returned_items = returned_items if returned_items is not None else []  # List to track returned items
        self.state = state  # Event state
        

class LogEntry:
    def __init__(self, timestamp, user, action):
        self.timestamp = timestamp
        self.user = user
        self.action = action

# Main application class
class InventoryManagementApp:
    def __init__(self):
        self.data_folder = ''
        self.users = {}
        self.current_user = None
        self.inventory = {}
        self.containers = {}
        self.events = {}  # Key: event_id, Value: Event object
        self.event_file_map = {}  # Key: event_id, Value: filename
        self.logs = []

    def start(self):
        self.setup_data_folder()
        self.load_data()
        self.authenticate_user()
        self.main_menu()

    def setup_data_folder(self):
        if os.path.exists('data_folder.txt'):
            with open('data_folder.txt', 'r') as f:
                self.data_folder = f.read().strip()
            # Check if the data folder exists and is a directory
            if not os.path.isdir(self.data_folder):
                print("Data folder not found or inaccessible.")
                self.prompt_data_folder()
            else:
                # Check and initialize required CSV files
                self.check_and_initialize_files()
        else:
            # Prompt the user to specify the data folder
            self.prompt_data_folder()

        # Ensure 'events' folder exists within the data folder
        self.events_folder = os.path.join(self.data_folder, 'events')
        if not os.path.exists(self.events_folder):
            os.makedirs(self.events_folder)

    def prompt_data_folder(self):
        while True:
            folder = input("Please specify the data folder path: ").strip()
            if os.path.isdir(folder):
                self.data_folder = folder
                with open('data_folder.txt', 'w') as f:
                    f.write(self.data_folder)
                self.check_and_initialize_files()
                break
            else:
                print("Invalid folder path. Please try again.")

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
            # Only add default user if Users.csv is empty
            salt = 'admin'
            password_hash = hash_password('admin', salt)
            self.users['admin'] = User('admin', password_hash, salt, True)
            self.save_users()
            print("Default admin user created.")
        print("Required files have been initialized.")

    def load_data(self):
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
        with open(filepath, 'r', newline='') as f:
            reader = csv.DictReader(f)
            for row in reader:
                if row:
                    maintenance_logs = row['MaintenanceLogs'].split('|') if row['MaintenanceLogs'] else []
                    department_code = row.get('DepartmentCode', 'UN')  # Default to 'UN' if not present
                    is_ooc = row.get('IsOOC', 'False') == 'True'  # Handle backward compatibility
                    item = InventoryItem(
                        asset_id=row['AssetID'],
                        brand=row['Brand'],
                        model_number=row['ModelNumber'],
                        serial_number=row['SerialNumber'],
                        description=row['Description'],
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
                    if event_data['AssetModels']:
                        try:
                            asset_models = eval(event_data['AssetModels'])
                        except Exception as e:
                            print(f"Error parsing 'AssetModels' in event file {filename}: {e}. Skipping...")
                            continue
                    # Handle PreparedItems and ReturnedItems
                    prepared_items = []
                    returned_items = []
                    if event_data['PreparedItems']:
                        try:
                            prepared_items = json.loads(event_data['PreparedItems'])
                        except json.JSONDecodeError:
                            print(f"Error parsing 'PreparedItems' in event file {filename}. Skipping...")
                            prepared_items = []
                    if event_data.get('ReturnedItems'):
                        try:
                            returned_items = json.loads(event_data['ReturnedItems'])
                        except json.JSONDecodeError:
                            print(f"Error parsing 'ReturnedItems' in event file {filename}. Initializing as empty.")
                            returned_items = []
                    state = event_data.get('State', 'Added')
                    event = Event(
                        event_id=event_id,
                        name=name,
                        start_date=start_date,
                        end_date=end_date,
                        asset_models=asset_models,
                        prepared_items=prepared_items,
                        state=state,
                        returned_items=returned_items
                    )
                    self.events[event_id] = event
                    self.event_file_map[event_id] = filename

    def save_event(self, event):
        # Sanitize event name for filename to avoid invalid characters
        sanitized_name = sanitize_filename(event.name)
        
        # Construct the filename using event ID and sanitized name
        filename = f"{event.event_id}. [{event.start_date}] {sanitized_name}.csv"
        filepath = os.path.join(self.events_folder, filename)
        
        # Open the file in write mode
        with open(filepath, 'w', newline='') as f:
            # Define the CSV headers
            fieldnames = ['EventID', 'Name', 'StartDate', 'EndDate', 'AssetModels', 'PreparedItems', 'ReturnedItems', 'State']
            writer = csv.DictWriter(f, fieldnames=fieldnames)
            
            # Write the header row
            writer.writeheader()

            # Serialize `AssetModels` using repr and `PreparedItems` & `ReturnedItems` using JSON
            writer.writerow({
                'EventID': event.event_id,
                'Name': event.name,
                'StartDate': event.start_date,
                'EndDate': event.end_date,
                'AssetModels': repr(event.asset_models),
                'PreparedItems': json.dumps(event.prepared_items),
                'ReturnedItems': json.dumps(event.returned_items),
                'State': event.state
            })

        # Update event_file_map to keep track of the event file
        old_filename = self.event_file_map.get(event.event_id)
        
        # If the filename has changed, remove the old file to prevent duplicates
        if old_filename and old_filename != filename:
            old_filepath = os.path.join(self.events_folder, old_filename)
            if os.path.exists(old_filepath):
                os.remove(old_filepath)
        
        # Update the mapping with the new filename
        self.event_file_map[event.event_id] = filename

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

    def authenticate_user(self):
        clear_screen()
        print("Welcome to Avec Inventory Tracker.")
        while True:
            username = input("Username: ").strip()
            password = getpass.getpass("Password: ").strip()
            if username in self.users:
                user = self.users[username]
                hashed_input = hash_password(password, user.salt)
                if hashed_input == user.password_hash:
                    self.current_user = user
                    self.log_action(f"User {username} logged in.")
                    return
            print("Invalid username or password. Please try again.")

    def main_menu(self):
        while True:
            clear_screen()
            print("Welcome to Avec Inventory Tracker.")
            print("1. Add event")
            print("2. Edit <Event number>")
            print("3. Prepare <Event number>")
            print("4. Return <Event number>")
            print("5. Transfer")
            print("6. List events")
            print("7. View <Event number>")
            print("8. Find <Event keyword>")
            print("9. Maintain <Asset ID OR S/N>")
            print("10. Info <Asset ID OR S/N>")
            print("11. Asset Check")
            print("12. Delete <Event number>")
            print("13. Log")
            print("14. Exit")
            print("\nRecent Events:")

            event_list = sorted(self.events.values(), key=lambda e: e.event_id, reverse=True)
            for event in event_list[0:10]:
                state_color = self.get_state_color(event.state)
                date_range = f"{format_date_output(event.start_date)} to {format_date_output(event.end_date)}"
                print(f"{state_color}Event ID: {event.event_id} | [{date_range}] {event.name} | State: {event.state}\033[0m")
            choice = input("What would you like to do:").strip()

            if choice.lower() == 'config' and self.current_user.is_admin:
                self.config_menu()
            elif choice == '1' or choice.lower() == 'add event':
                self.add_event()
            elif choice.startswith('2') or choice.lower().startswith('edit'):
                parts = choice.split()
                if len(parts) == 2:
                    try:
                        self.edit_event(int(parts[1]))
                    except ValueError:
                        print("Invalid event number.")
                        pause()
                else:
                    print("Invalid command.")
                    pause()
            elif choice.startswith('3') or choice.lower().startswith('prepare'):
                parts = choice.split()
                if len(parts) == 2:
                    try:
                        self.prepare_event(int(parts[1]))
                    except ValueError:
                        print("Invalid event number.")
                        pause()
                else:
                    print("Invalid command.")
                    pause()
            elif choice.startswith('4') or choice.lower().startswith('return'):
                parts = choice.split()
                if len(parts) == 2:
                    try:
                        self.return_event(int(parts[1]))
                    except ValueError:
                        print("Invalid event number.")
                        pause()
                else:
                    print("Invalid command.")
                    pause()
            elif choice == '5' or choice.lower() == 'transfer':
                self.transfer_event()
            elif choice == '6' or choice.lower() == 'list events':
                self.list_events()
            elif choice.startswith('7') or choice.lower().startswith('view'):
                parts = choice.split()
                if len(parts) == 2:
                    try:
                        self.view_event(int(parts[1]))
                    except ValueError:
                        print("Invalid event number.")
                        pause()
                else:
                    print("Invalid command.")
                    pause()
            elif choice.startswith('8') or choice.lower().startswith('find'):
                parts = choice.split(maxsplit=1)
                if len(parts) == 2:
                    self.find_event(parts[1])
                else:
                    print("Invalid command.")
                    pause()
            elif choice.startswith('9') or choice.lower().startswith('maintain'):
                parts = choice.split(maxsplit=1)
                if len(parts) == 2:
                    self.maintain_asset(parts[1])
                else:
                    self.maintain_asset()
            elif choice.startswith('10') or choice.lower().startswith('info'):
                parts = choice.split(maxsplit=1)
                if len(parts) == 2:
                    self.show_info(parts[1])
                else:
                    print("Invalid command.")
                    pause()
            elif choice == '11' or choice.lower() == 'asset check':
                self.asset_check()
            elif choice.startswith('12') or choice.lower().startswith('delete'):
                parts = choice.split()
                if len(parts) == 2:
                    try:
                        self.delete_event(int(parts[1]))
                    except ValueError:
                        print("Invalid event number.")
                        pause()
                else:
                    print("Invalid command.")
                    pause()
            elif choice == '13' or choice.lower() == 'log':
                self.show_logs()
            elif choice == '14' or choice.lower() == 'exit':
                self.log_action(f"User {self.current_user.username} logged out.")
                print("Goodbye!")
                sys.exit()
            elif choice.lower().startswith('OOC'):
                parts = choice.split(maxsplit=1)
                if len(parts) == 2:
                    self.make_OOC(parts[1])
                else:
                    print("Invalid command.")
                    pause()
            else:
                print("Invalid option.")
                pause()
    def make_OOC(self, identifier):
            # Renamed from 'asset_info' to 'show_info'
            item = self.find_item_by_id_or_serial(identifier)
            if not item:
                print("Asset not found.")
                play_sound(success=False)
                pause()
                return
    def config_menu(self):
        while True:
            clear_screen()
            print("Configuration Menu:")
            print("1. Add Equipment/Assets")
            print("2. Add/Edit Container")
            print("3. Edit Equipment/Assets")
            print("4. Search Asset")
            print("5. Delete Asset or Container")
            print("6. Add/Edit User")
            print("7. View Asset History")
            print("8. Maintain Asset")
            print("9. Back to Main Menu")
            choice = input("Select an option: ").strip()
            if choice == '1':
                self.add_equipment()
            elif choice == '2':
                self.add_edit_container()
            elif choice == '3':
                self.edit_equipment()
            elif choice == '4':
                self.search_asset()
            elif choice == '5':
                self.delete_asset_or_container()
            elif choice == '6':
                self.add_edit_user()
            elif choice == '7':
                identifier = input("Enter Asset ID or Serial Number or Container ID: ").strip()
                self.show_history(identifier)
            elif choice == '8':
                identifier = input("Enter Asset ID or Serial Number: ").strip()
                self.maintain_asset(identifier)
            elif choice == '9':
                break
            else:
                print("Invalid option.")
                pause()

    def search_asset(self):
        keywords = input("Enter keywords to search: ").strip().lower().split()
        if not keywords:
            print("No keywords entered.")
            pause()
            return
        results = []
        for item in self.inventory.values():
            # Combine the searchable fields into a single string
            searchable_text = f"{item.brand} {item.model_number} {item.description}".lower()
            # Check if all keywords are present
            if all(keyword in searchable_text for keyword in keywords):
                results.append(item)
        if results:
            for item in results:
                print(f"{item.asset_id}: {item.brand} {item.model_number} {item.description}")
        else:
            print("No matching assets found.")
        pause()

    def add_equipment(self):
        while True:
            brand = input("Brand (type 'exit' to return): ").strip()
            if brand.lower() == 'exit':
                break
            model_number = input("Model number: ").strip().upper()
            description = input("Description (optional): ").strip()
            department_code = input("Department code (e.g., AX, LX): ").strip().upper()
            if not department_code:
                department_code = 'UN'  # Default to 'UN' (Unknown)
            quantity = input("How many items to add: ").strip()
            if not quantity.isdigit():
                print("Invalid quantity.")
                continue
            quantity = int(quantity)
            existing_items = [item for item in self.inventory.values() if item.model_number == model_number]
            next_number = len(existing_items) + 1
            for i in range(quantity):
                asset_id = f"{model_number}#{next_number:02d}"
                serial_number = input(f"Serial number for {asset_id} (optional): ").strip()
                is_missing = input(f"Is {asset_id} missing? (y/n): ").strip().lower() == 'y'
                item = InventoryItem(
                    asset_id=asset_id,
                    brand=brand,
                    model_number=model_number,
                    serial_number=serial_number,
                    description=description,
                    is_missing=is_missing,
                    is_ooc=False,
                    maintenance_logs=[],
                    department_code=department_code,
                    default_location="Store",
                    current_location=''
                )
                self.inventory[asset_id] = item
                self.log_action(f"Added equipment {asset_id}.")
                next_number += 1
            self.save_inventory()
            print(f"Added {quantity} items.")
            pause()
            break

    def add_edit_container(self):
        container_id = input("Container ID: ").strip()
        container = self.containers.get(container_id)

        # If the container doesn't exist, create a new one
        if container:
            print(f"Container '{container_id}' exists. Editing contents.")
        else:
            print(f"Creating new container '{container_id}'.")
            container = Container(container_id, [])
            self.containers[container_id] = container

        while True:
            clear_screen()
            print(f"Editing container '{container_id}'")

            # Display current items in the container
            if container.asset_ids:
                print("\nCurrent items in container:")
                for asset_id in container.asset_ids:
                    item = self.inventory.get(asset_id)
                    if item:
                        print(f"{asset_id}: {item.brand} {item.model_number} {item.description}")
            else:
                print("\nThe container is currently empty.")

            # Get user input for adding or removing items
            action = input("\nEnter Asset ID, Serial Number to add, 'remove <Asset ID or Serial Number>' to remove, or 'done' to finish: ").strip()

            if action.lower() == 'done':
                break
            elif action.lower().startswith('remove '):
                identifier = action[7:].strip()
                item = self.find_item_by_id_or_serial(identifier)
                if item:
                    asset_id = item.asset_id
                    if asset_id in container.asset_ids:
                        container.asset_ids.remove(asset_id)
                        print(f"Removed {asset_id} from container.")
                    else:
                        print(f"{asset_id} is not in the container.")
                else:
                    print("Asset ID or Serial Number not found.")
                pause()
            else:
                # Attempt to add the item to the container
                item = self.find_item_by_id_or_serial(action)
                if item:
                    asset_id = item.asset_id
                    if asset_id in container.asset_ids:
                        print(f"Asset {asset_id} is already in the container.")
                    else:
                        container.asset_ids.append(asset_id)
                        print(f"Added {asset_id} to container.")
                else:
                    print("Asset ID or Serial Number not found.")
                pause()

        # Save changes to the container
        self.save_containers()
        self.log_action(f"Edited container {container_id}.")
        print(f"Container '{container_id}' updated successfully.")
        pause()

    def edit_equipment(self):
        asset_id = input("Asset ID to edit: ").strip()
        if asset_id in self.inventory:
            item = self.inventory[asset_id]
            print(f"Editing {asset_id}: {item.brand} {item.model_number} {item.description}")
            new_asset_id = input(f"New Asset ID [{item.asset_id}]: ").strip()
            brand = input(f"Brand [{item.brand}]: ").strip()
            model_number = input(f"Model number [{item.model_number}]: ").strip().upper()
            description = input(f"Description [{item.description}]: ").strip()
            serial_number = input(f"Serial number [{item.serial_number}]: ").strip()
            department_code = input(f"Department code [{item.department_code}]: ").strip().upper()
            default_location = input(f"Default location [{item.default_location}]: ").strip()
            is_missing = input(f"Is missing? ({'y' if item.is_missing else 'n'}): ").strip().lower()
            is_ooc = input(f"Is Out of Commission (OOC)? ({'y' if item.is_ooc else 'n'}): ").strip().lower()

            if new_asset_id and new_asset_id != item.asset_id:
                old_asset_id = item.asset_id
                # Update inventory
                item.asset_id = new_asset_id
                self.inventory[new_asset_id] = item
                del self.inventory[old_asset_id]
                # Update references in events
                for event in self.events.values():
                    if old_asset_id in event.prepared_items:
                        event.prepared_items.remove(old_asset_id)
                        event.prepared_items.append(new_asset_id)
                        self.save_event(event)
                # Update references in containers
                for container in self.containers.values():
                    if old_asset_id in container.asset_ids:
                        container.asset_ids.remove(old_asset_id)
                        container.asset_ids.append(new_asset_id)
                self.save_containers()

            if brand:
                item.brand = brand
            if model_number:
                item.model_number = model_number
            if description:
                item.description = description
            if serial_number:
                item.serial_number = serial_number
            if department_code:
                item.department_code = department_code
            if default_location:
                item.default_location = default_location
            if is_missing in ['y', 'n']:
                item.is_missing = is_missing == 'y'
            if is_ooc in ['y', 'n']:
                item.is_ooc = is_ooc == 'y'
            self.save_inventory()
            self.log_action(f"Edited equipment {item.asset_id}.")
            print("Item updated.")
        else:
            print("Asset ID not found.")
        pause()


    def delete_asset_or_container(self):
        choice = input("Delete (1) Asset or (2) Container? ").strip()
        if choice == '1':
            asset_id = input("Asset ID to delete: ").strip()
            if asset_id in self.inventory:
                confirm = input(f"Confirm delete of {asset_id}? (y/n): ").strip().lower()
                if confirm == 'y':
                    del self.inventory[asset_id]
                    self.save_inventory()
                    self.log_action(f"Deleted asset {asset_id}.")
                    print("Asset deleted.")
                else:
                    print("Deletion cancelled.")
            else:
                print("Asset ID not found.")
        elif choice == '2':
            container_id = input("Container ID to delete: ").strip()
            if container_id in self.containers:
                confirm = input(f"Confirm delete of container {container_id}? (y/n): ").strip().lower()
                if confirm == 'y':
                    del self.containers[container_id]
                    self.save_containers()
                    self.log_action(f"Deleted container {container_id}.")
                    print("Container deleted.")
                else:
                    print("Deletion cancelled.")
            else:
                print("Container ID not found.")
        else:
            print("Invalid option.")
        pause()

    def add_edit_user(self):
        username = input("Enter username: ").strip()
        if username in self.users:
            print("Editing existing user.")
            user = self.users[username]
            password = getpass.getpass("Enter new password (leave blank to keep current): ").strip()
            is_admin = input(f"Is admin? ({'y' if user.is_admin else 'n'}): ").strip().lower()
            if password:
                salt = os.urandom(16).hex()
                password_hash = hash_password(password, salt)
                user.password_hash = password_hash
                user.salt = salt
            if is_admin in ['y', 'n']:
                user.is_admin = is_admin == 'y'
            self.save_users()
            self.log_action(f"Edited user {username}.")
            print("User updated.")
        else:
            print("Creating new user.")
            password = getpass.getpass("Enter password: ").strip()
            is_admin = input("Is admin? (y/n): ").strip().lower()
            salt = os.urandom(16).hex()
            password_hash = hash_password(password, salt)
            user = User(username, password_hash, salt, is_admin == 'y')
            self.users[username] = user
            self.save_users()
            self.log_action(f"Added user {username}.")
            print("User created.")
        pause()

    def add_event(self):
        name = input("What is the name of the show? ").strip()
        start_date_input = input("Enter the start date (YYYY/MM/DD): ").strip()
        end_date_input = input("Enter the end date (YYYY/MM/DD, leave blank if same as start date): ").strip() or start_date_input

        start_date = parse_date_input(start_date_input)
        end_date = parse_date_input(end_date_input)

        if not start_date or not end_date:
            print("Invalid date format.")
            pause()
            return

        event_id = max(self.events.keys(), default=0) + 1
        asset_models = []
        added_items = {}
        last_action = []

        event = Event(event_id, name, start_date, end_date, asset_models)
        self.add_edit_event(event_id, event, start_date, end_date, asset_models, added_items, last_action)

        self.events[event_id] = event
        self.save_event(event)
        self.log_action(f"Added event {event_id}: {name}.")
        print("Event added successfully.")
        pause()

    def edit_event(self, event_id):
        event = self.events.get(event_id)
        if not event:
            print("Event not found.")
            pause()
            return

        print(f"Editing Event {event_id}: [{format_date_output(event.start_date)} to {format_date_output(event.end_date)}] {event.name}")
        name = input(f"New name (leave blank to keep current): ").strip()
        start_date_input = input(f"New start date (YYYY/MM/DD, leave blank to keep current): ").strip()
        end_date_input = input(f"New end date (YYYY/MM/DD, leave blank to keep current): ").strip()

        if name:
            event.name = name
            for asset_id in event.prepared_items:
                item = self.inventory.get(asset_id)
                if item and not asset_id.startswith('loan|') and not asset_id.startswith('misc|'):
                    item.current_location = event.name
                    self.save_inventory()

        if start_date_input:
            new_start_date = parse_date_input(start_date_input)
            if new_start_date:
                event.start_date = new_start_date
            else:
                print("Invalid start date format.")
                pause()
                return
        if end_date_input:
            new_end_date = parse_date_input(end_date_input)
            if new_end_date:
                event.end_date = new_end_date
            else:
                print("Invalid end date format.")
                pause()
                return
        
        start_date = event.start_date
        end_date = event.end_date

        asset_models = event.asset_models
        added_items = {model['model_description']: model['quantity'] for model in asset_models}
        last_action = []

        self.add_edit_event(event_id, event, start_date, end_date, asset_models, added_items, last_action)

        self.events[event_id] = event
        self.save_event(event)
        self.log_action(f"Edited event {event_id}: {event.name}.")
        print("Event edited successfully.")
        pause()

    def add_or_update_asset_model(self, asset_models, model_description, quantity):
        for model in asset_models:
            if model['model_description'] == model_description:
                model['quantity'] += quantity
                return
        asset_models.append({'model_description': model_description, 'quantity': quantity})
        return

    def add_edit_event(self, event_id, event, start_date, end_date, asset_models, added_items, last_action):
        msg = ""
        while True:
            self.save_event(event)
            clear_screen()
            print(f"{'Editing' if event_id in self.events else 'Adding'} Event {event_id}: "
                f"[{format_date_output(event.start_date)} to {format_date_output(event.end_date)}] {event.name}")
            print("\nCurrent Event Summary:")
            if added_items:
                sorted_items = self.sort_items_for_display([
                    {'model_description': model, 'quantity': qty} for model, qty in added_items.items()
                ])
                for item in sorted_items:
                    if item['quantity'] > 0:
                        colored_description = self.get_colored_item_description(item['model_description'])
                        print(f"{item['quantity']}x\t{colored_description}")
            else:
                print("No items added yet.")
            print("\n"+msg)
            msg = ""
            entry = input("Enter model keywords, Asset ID, Serial Number, 'loan', 'misc', "
                        "'remove <model description> <quantity>', Container ID, or command "
                        "(type 'done' to finish, 'undo' to remove last item): ").strip()

            if entry.lower() == 'done':
                break
            elif entry.lower() == 'undo':
                if last_action:
                    action_type, items = last_action.pop()
                    if action_type == "add":
                        for model_description, quantity in items.items():
                            if model_description in added_items:
                                added_items[model_description] -= quantity
                                if added_items[model_description] <= 0:
                                    del added_items[model_description]
                            self.remove_or_update_asset_model(asset_models, model_description, quantity)
                        msg += "Undid the last addition.\n"
                        play_sound(success=True)
                    elif action_type == "remove":
                        for model_description, quantity in items.items():
                            if model_description in added_items:
                                added_items[model_description] += quantity
                            else:
                                added_items[model_description] = quantity
                            self.add_or_update_asset_model(asset_models, model_description, quantity)
                        msg += "Re-added the removed items.\n"
                        play_sound(success=True)
                else:
                    msg += "No actions to undo.\n"
                    play_sound(success=False)
            elif entry.lower().startswith('remove '):
                tokens = entry.split()
                if len(tokens) >= 2:
                    try:
                        quantity = int(tokens[-1])
                        model_to_remove = ' '.join(tokens[1:-1])
                    except ValueError:
                        quantity = None
                        model_to_remove = ' '.join(tokens[1:])
                    if model_to_remove in added_items:
                        current_quantity = added_items[model_to_remove]
                        if quantity is None or quantity >= current_quantity:
                            quantity_to_remove = added_items.pop(model_to_remove)
                            self.remove_or_update_asset_model(asset_models, model_to_remove, quantity_to_remove, remove=True)
                            msg += f"Removed all of {model_to_remove} from event.\n"
                        else:
                            added_items[model_to_remove] -= quantity
                            quantity_to_remove = quantity
                            self.remove_or_update_asset_model(asset_models, model_to_remove, quantity, remove=False)
                            msg += f"Removed {quantity}x {model_to_remove} from event.\n"
                        last_action.append(("remove", {model_to_remove: quantity_to_remove}))
                        play_sound(success=True)
                    else:
                        msg += f"No items matching '{model_to_remove}' found in the event summary.\n"
                        play_sound(success=False)
                else:
                    msg += "Invalid command.\n"
                    play_sound(success=False)
            elif entry.lower() == 'loan':
                loan_name = input("Enter the name of the loaned equipment: ").strip()
                try:
                    loan_quantity = int(input("Enter the quantity of the loaned equipment: ").strip())
                    if loan_quantity <= 0:
                        msg += "Quantity must be a positive number.\n"
                        continue
                except ValueError:
                    msg += "Invalid quantity. Please enter a number.\n"
                    continue

                model_description = f"[LOAN] {loan_name}"
                if model_description in added_items:
                    added_items[model_description] += loan_quantity
                else:
                    added_items[model_description] = loan_quantity
                self.add_or_update_asset_model(asset_models, model_description, loan_quantity)
                last_action.append(("add", {model_description: loan_quantity}))
                msg += f"Added {loan_quantity}x {model_description} to event.\n"
                play_sound(success=True)
            elif entry.lower() == 'misc':
                misc_name = input("Enter the name of the miscellaneous item: ").strip()
                try:
                    misc_quantity = int(input("Enter the quantity of the miscellaneous item: ").strip())
                    if misc_quantity <= 0:
                        msg += "Quantity must be a positive number.\n"
                        continue
                except ValueError:
                    msg += "Invalid quantity. Please enter a number.\n"
                    continue

                model_description = f"[MISC] {misc_name}"
                if model_description in added_items:
                    added_items[model_description] += misc_quantity
                else:
                    added_items[model_description] = misc_quantity
                self.add_or_update_asset_model(asset_models, model_description, misc_quantity)
                last_action.append(("add", {model_description: misc_quantity}))
                msg += f"Added {misc_quantity}x {model_description} to event.\n"
                play_sound(success=True)
            elif entry in self.containers:
                container = self.containers[entry]
                container_items = {}
                for asset_id in container.asset_ids:
                    item = self.inventory.get(asset_id)
                    if not item:
                        msg += f"Item {asset_id} in container not found in inventory.\n"
                        continue

                    model_description = f"[{item.department_code}] {item.brand} {item.model_number} {item.description}"
                    available_quantity, total_quantity = self.get_available_quantity(
                        model_description, start_date, end_date, exclude_event_id=event_id)
                    current_quantity = added_items.get(model_description, 0)
                    max_addable = total_quantity - current_quantity

                    if max_addable <= 0:
                        msg += f"Cannot add any more of {model_description}. Exceeds total inventory ({total_quantity}).\n"
                        clashing_events = self.get_clashing_events(model_description, event.start_date, event.end_date, exclude_event_id=event_id)
                        if clashing_events:
                            msg += "The following events are also using this asset type:\n"
                            for evt in clashing_events:
                                date_range = format_date_output(evt.start_date) if evt.start_date == evt.end_date else f"{format_date_output(evt.start_date)} to {format_date_output(evt.end_date)}"
                                msg += f"Event ID: {evt.event_id} | [{date_range}] {evt.name}\n"
                        input("Press Enter to continue...")

                    if model_description in container_items:
                        container_items[model_description] += 1
                    else:
                        container_items[model_description] = 1

                if container_items:
                    for model_description, quantity in container_items.items():
                        if model_description in added_items:
                            added_items[model_description] += quantity
                        else:
                            added_items[model_description] = quantity
                        self.add_or_update_asset_model(asset_models, model_description, quantity)
                    last_action.append(("add", container_items))
                    msg += f"Added items from container {entry}.\n"
                    play_sound(success=True)
                else:
                    msg += f"No items could be added from container {entry}.\n"
                    play_sound(success=False)
            else:
                item = self.find_item_by_id_or_serial(entry)
                if item:
                    model_description = f"[{item.department_code}] {item.brand} {item.model_number} {item.description}"
                    available_quantity, total_quantity = self.get_available_quantity(
                        model_description, start_date, end_date, exclude_event_id=event_id)
                    current_quantity = added_items.get(model_description, 0)
                    max_addable = total_quantity - current_quantity

                    if max_addable <= 0:
                        msg += f"Cannot add any more of {model_description}. Exceeds total inventory ({total_quantity}).\n"
                        play_sound(success=False)
                        continue

                    print(f"{max_addable}/{total_quantity} available for {model_description}. You have already added {current_quantity}.\n")

                    while True:
                        try:
                            quantity = int(input(f"How many would you like to add (max {max_addable})? "))
                            if quantity < 0 or quantity > max_addable:
                                print(f"Quantity must be between 1 and {max_addable}. Please try again.\n")
                            else:
                                break
                        except ValueError:
                            print("Invalid input. Please enter a number.\n")

                    # Use the add_or_update_asset_model function to increment the quantity
                    if quantity == 0:
                        msg += f"No items added.\n"
                        play_sound(success=False)
                        continue
                    self.add_or_update_asset_model(asset_models, model_description, quantity)
                    added_items[model_description] = added_items.get(model_description, 0) + quantity
                    last_action.append(("add", {model_description: quantity}))
                    msg += f"Added {quantity}x {model_description}.\n"
                    play_sound(success=True)
                else:
                    matching_items = self.search_items_by_keywords(entry)
                    if not matching_items:
                        msg += "No matching items found.\n"
                        play_sound(success=False)
                        continue

                    grouped_items = self.group_items_by_model(matching_items)

                    print("\nMultiple items found. Please select one:\n")
                    for idx, (model_description, count) in enumerate(grouped_items.items(), 1):
                        colored_description = self.get_colored_item_description(model_description)
                        print(f"{idx}. {colored_description}")

                    if len(grouped_items) > 1:
                        selected_group = self.prompt_user_to_select_group(grouped_items)
                        if selected_group == 'back':
                            continue
                    else:
                        selected_group = next(iter(grouped_items))

                    model_description = selected_group

                    available_quantity, total_quantity = self.get_available_quantity(
                        model_description, start_date, end_date, exclude_event_id=event_id)
                    current_quantity = added_items.get(model_description, 0)
                    max_addable = total_quantity - current_quantity

                    if max_addable <= 0:
                        msg += f"Cannot add any more of {model_description}. Exceeds total inventory ({total_quantity}).\n"
                        play_sound(success=False)
                        continue

                    print(f"{max_addable}/{total_quantity} available for {model_description}. You have already added {current_quantity}.\n")

                    while True:
                        try:
                            quantity = int(input(f"How many would you like to add (max {max_addable})? "))
                            if quantity < 0 or quantity > max_addable:
                                print(f"Quantity must be between 1 and {max_addable}. Please try again.\n")
                            else:
                                break
                        except ValueError:
                            print("Invalid input. Please enter a number.\n")

                    if quantity == 0:
                        msg += f"No items added.\n"
                        play_sound(success=False)
                        continue

                    if (current_quantity + quantity) > available_quantity:
                        msg += f"\nWarning: You are adding more than the available quantity ({available_quantity}/{total_quantity}).\n"
                        clashing_events = self.get_clashing_events(model_description, event.start_date, end_date, exclude_event_id=event_id)
                        if clashing_events:
                            msg += "The following events are also using this asset type:\n"
                            for evt in clashing_events:
                                date_range = format_date_output(evt.start_date) if evt.start_date == evt.end_date else f"{format_date_output(evt.start_date)} to {format_date_output(evt.end_date)}"
                                msg += f"Event ID: {evt.event_id} | [{date_range}] {evt.name}\n"
                        input("Press Enter to continue...")

                    self.add_or_update_asset_model(asset_models, model_description, quantity)
                    added_items[model_description] = current_quantity + quantity
                    last_action.append(("add", {model_description: quantity}))
                    msg += f"Added {quantity}x {model_description}.\n"
                    play_sound(success=True)

    def prepare_event(self, event_id):
        event = self.events.get(event_id)
        if not event:
            print("Event not found.")
            pause()
            return

        message = ""
        last_actions = []  # For undo functionality

        while True:
            clear_screen()
            print(f"Preparing items for Event {event.event_id}: {event.name}")
            print(f"Event Dates: {format_date_output(event.start_date)} to {format_date_output(event.end_date)}\n")

            # Calculate items to prepare based on asset_models and prepared_items
            items_to_prepare = self.calculate_items_to_prepare(event)

            if items_to_prepare:
                print("Items to be prepared:\n")
                for model in items_to_prepare:
                    model_description = model['model_description']
                    quantity = model['quantity']
                    colored_description = self.get_colored_item_description(model_description)
                    print(f"{quantity}x\t{colored_description}")
            else:
                print("All items have been prepared.")

            print("\n" + message)
            message = ""

            user_input = input("Enter Asset ID, Serial Number, 'loan', 'misc', Container ID, or command "
                            "(type 'done' to finish, 'undo' to remove last action): ").strip()

            if user_input.lower() == 'done':
                self.update_event_state(event)
                self.save_event(event)
                break
            elif user_input.lower() == 'undo':
                if last_actions:
                    action = last_actions.pop()
                    result = self.undo_prepare_action(event, action, last_actions)
                    message += result['message'] + "\n"
                    play_sound(success=True)
                else:
                    message += "No actions to undo.\n"
                    play_sound(success=False)
            elif user_input.lower().startswith('loan'):
                # Handle loan items
                tokens = user_input.split()
                if len(tokens) >= 2:
                    if tokens[1].lower() == 'all':
                        # Prepare all loan items
                        prepared = self.prepare_all_loan_or_misc_items(event, item_type='loan')
                        if prepared:
                            last_actions.append(('prepare_loan_all', prepared))
                            message += "Prepared all loan items.\n"
                            play_sound(success=True)
                        else:
                            message += "No loan items to prepare.\n"
                            play_sound(success=False)
                    else:
                        model_description = f"[LOAN] {' '.join(tokens[1:-1])}"
                        try:
                            quantity = int(tokens[-1])
                        except ValueError:
                            model_description = f"[LOAN] {' '.join(tokens[1:])}"
                            quantity = None
                        prepared = self.prepare_loan_or_misc_item(event, model_description, quantity, item_type='loan')
                        if prepared:
                            last_actions.append(('prepare_loan', prepared))
                            message += f"Prepared {prepared['quantity']}x {model_description}.\n"
                            play_sound(success=True)
                        else:
                            message += "Failed to prepare loan item.\n"
                            play_sound(success=False)
                else:
                    message += "Invalid command for loan items.\n"
                    play_sound(success=False)
            elif user_input.lower().startswith('misc'):
                # Handle misc items
                tokens = user_input.split()
                if len(tokens) >= 2:
                    if tokens[1].lower() == 'all':
                        # Prepare all misc items
                        prepared = self.prepare_all_loan_or_misc_items(event, item_type='misc')
                        if prepared:
                            last_actions.append(('prepare_misc_all', prepared))
                            message += "Prepared all miscellaneous items.\n"
                            play_sound(success=True)
                        else:
                            message += "No miscellaneous items to prepare.\n"
                            play_sound(success=False)
                    else:
                        model_description = f"[MISC] {' '.join(tokens[1:-1])}"
                        try:
                            quantity = int(tokens[-1])
                        except ValueError:
                            model_description = f"[MISC] {' '.join(tokens[1:])}"
                            quantity = None
                        prepared = self.prepare_loan_or_misc_item(event, model_description, quantity, item_type='misc')
                        if prepared:
                            last_actions.append(('prepare_misc', prepared))
                            message += f"Prepared {prepared['quantity']}x {model_description}.\n"
                            play_sound(success=True)
                        else:
                            message += "Failed to prepare miscellaneous item.\n"
                            play_sound(success=False)
                else:
                    message += "Invalid command for miscellaneous items.\n"
                    play_sound(success=False)
            elif user_input in self.containers:
                # Handle container
                container = self.containers[user_input]
                count = 0
                for asset_id in container.asset_ids:
                    result = self.prepare_asset(event, asset_id, last_actions, skip_confirm=False)
                    if not result['success']:
                        for _ in range(count):
                            action = last_actions.pop()
                            self.undo_prepare_action(event, action, last_actions)
                        print(f"Container {user_input} preparation cancelled")
                        continue
                    else:
                        count += 1
                if count > 0:
                    last_actions.append(('prepare_container', count))
                    message += f"Prepared {count} items in {user_input}.\n"
                    play_sound(success=True)
            else:
                # Handle asset ID or serial number
                result = self.prepare_asset(event, user_input, last_actions)
                if result['success']:
                    message += result['message'] + "\n"
                    play_sound(success=True)
                else:
                    message += result['message'] + "\n"
                    play_sound(success=False)
            self.save_event(event)
            self.save_inventory()

    def prepare_asset(self, event, asset_id_or_serial, last_actions, skip_confirm=False):
        item = self.find_item_by_id_or_serial(asset_id_or_serial)
        if not item:
            return {'success': False, 'message': "Asset not found."}
        if item.is_ooc:
            confirm = input(f"Item {item} is not prepared as it is marked as Out Of Commission. Mark item as fixed? (y/n)").strip().lower()
            if confirm != 'y':
                item.is_ooc = False
                self.save_inventory()
            else:
                return
        if item.is_missing:
            confirm = input(f"Item {item} is not prepared as it is marked as missing. Mark item as found? (y/n)").strip().lower()
            if confirm != 'y':
                item.is_missing = False
                self.save_inventory()
            else:
                return

        # Check if asset is assigned to another event
        other_event = self.get_event_by_asset(item.asset_id)
        if other_event and other_event.event_id != event.event_id:
            if not skip_confirm:
                confirm = input(f"Asset is assigned to Event {other_event.event_id}: {other_event.name}. "
                                "Would you like to prepare it anyway? (y/n): ").strip().lower()
                if confirm != 'y':
                    return {'success': False, 'message': "Asset preparation cancelled due to conflict."}

            # Check if asset type is in items to prepare
            model_description = f"[{item.department_code}] {item.brand} {item.model_number} {item.description}"
            items_to_prepare = self.calculate_items_to_prepare(event)
            model_descriptions_to_prepare = [m['model_description'] for m in items_to_prepare]

            if model_description in model_descriptions_to_prepare:
                # Return asset from other event and assign to current event
                if item.asset_id in event.prepared_items:
                    if item.asset_id in event.returned_items:
                        other_event.returned_items.append(item.asset_id)
                        self.save_event(other_event)
                        event.returned_items.remove(item.asset_id)
                        item.current_location = event.name
                        last_actions.append(('reprepare_asset', item.asset_id, other_event.event_id))
                        return {'success': True, 'message': f"Re-prepared asset {item.asset_id}."}
                    else:
                        other_event.returned_items.append(item.asset_id)
                        self.save_event(other_event)
                        item.current_location = event.name
                        return {'success': False, 'message': f"Asset {item.asset_id} is already prepared for this event."}
                else:
                    other_event.returned_items.append(item.asset_id)
                    self.save_event(other_event)
                    item.current_location = event.name
                    event.prepared_items.append(item.asset_id)
                    last_actions.append(('prepare_asset', item.asset_id, other_event.event_id))
                    return {'success': True, 'message': f"Prepared asset {item.asset_id}."}
            else:
                # Check for drought
                drought, clashing_events = self.get_clashing_events(model_description, event.start_date, event.end_date, exclude_event_id=event.event_id)
                if drought:
                    print(f"Warning: Drought detected for {item.asset_id}.")
                    print(f"The following events are also using {item.asset_id}:")
                    for evt in clashing_events:
                        date_range = format_date_output(evt.start_date) if evt.start_date == evt.end_date else f"{format_date_output(evt.start_date)} to {format_date_output(evt.end_date)}"
                        print(f"{state_color}Event ID: {evt.event_id} | [{date_range}] {evt.name} \t State: {event.state}\033[0m")
                    confirm = input("Would you like to prepare the asset anyway? (y/n): ").strip().lower()
                    if confirm != 'y':
                        return {'success': False, 'message': "Asset preparation cancelled due to drought."}
                # Return asset from other event and assign to current event
                if item.asset_id in event.prepared_items:
                    if item.asset_id in event.returned_items:
                        other_event.returned_items.append(item.asset_id)
                        self.save_event(other_event)
                        event.returned_items.remove(item.asset_id)
                        item.current_location = event.name
                        last_actions.append(('reprepare_asset', item.asset_id, other_event.event_id))
                        return {'success': True, 'message': f"Re-prepared asset {item.asset_id}."}
                    else:
                        other_event.returned_items.append(item.asset_id)
                        self.save_event(other_event)
                        item.current_location = event.name
                        return {'success': False, 'message': f"Asset {item.asset_id} is already prepared for this event."}
                else:
                    other_event.returned_items.append(item.asset_id)
                    self.save_event(other_event)
                    item.current_location = event.name
                    event.prepared_items.append(item.asset_id)
                    last_actions.append(('prepare_asset', item.asset_id, other_event.event_id))
                    return {'success': True, 'message': f"Prepared asset {item.asset_id}."}
        else:
            # Asset not assigned to another event
            model_description = f"[{item.department_code}] {item.brand} {item.model_number} {item.description}"
            items_to_prepare = self.calculate_items_to_prepare(event)
            model_descriptions_to_prepare = [m['model_description'] for m in items_to_prepare]

            if model_description in model_descriptions_to_prepare:
                # Prepare and assign item to current event
                if item.asset_id in event.prepared_items:
                    if item.asset_id in event.returned_items:
                        event.returned_items.remove(item.asset_id)
                        item.current_location = event.name
                        last_actions.append(('reprepare_asset', item.asset_id, None))
                        return {'success': True, 'message': f"Re-prepared asset {item.asset_id}."}
                    else:
                        item.current_location = event.name
                        return {'success': False, 'message': f"Asset {item.asset_id} is already prepared for this event."}
                else:
                    item.current_location = event.name
                    event.prepared_items.append(item.asset_id)
                    last_actions.append(('prepare_asset', item.asset_id, None))
                    return {'success': True, 'message': f"Prepared asset {item.asset_id}."}
            else:
                # Check for drought
                drought, clashing_events = self.get_clashing_events(model_description, event.start_date, event.end_date, exclude_event_id=event.event_id)
                if drought:
                    print(f"Warning: Drought detected for {item.asset_id}.")
                    print(f"The following events are also using {item.asset_id}:")
                    for evt in clashing_events:
                        state_color = self.get_state_color(evt.state)
                        date_range = format_date_output(evt.start_date) if evt.start_date == evt.end_date else f"{format_date_output(evt.start_date)} to {format_date_output(evt.end_date)}"
                        print(f"{state_color}Event ID: {evt.event_id} | [{date_range}] {evt.name} \t State: {evt.state}\033[0m")
                    confirm = input("Would you like to prepare the asset anyway? (y/n): ").strip().lower()
                    if confirm != 'y':
                        return {'success': False, 'message': "Asset preparation cancelled due to drought."}
                # Assign item to current event
                if item.asset_id in event.prepared_items:
                    if item.asset_id in event.returned_items:
                        event.returned_items.remove(item.asset_id)
                        item.current_location = event.name
                        last_actions.append(('reprepare_asset', item.asset_id, None))
                        return {'success': True, 'message': f"Re-prepared asset {item.asset_id}."}
                    else:
                        item.current_location = event.name
                        return {'success': False, 'message': f"Asset {item.asset_id} is already prepared for this event."}
                else:
                    item.current_location = event.name
                    event.prepared_items.append(item.asset_id)
                    last_actions.append(('prepare_asset', item.asset_id, None))
                    return {'success': True, 'message': f"Prepared asset {item.asset_id}."}

    def undo_prepare_action(self, event, action, last_actions):
        if action[0] == 'prepare_asset':
            asset_id = action[1]
            from_event_id = action[2]
            item = self.inventory.get(asset_id)
            if item:
                item.current_location = ''
                event.prepared_items.remove(asset_id)
                if from_event_id:
                    # Return asset to previous event
                    from_event = self.events.get(from_event_id)
                    if from_event:
                        from_event.returned_items.remove(asset_id)
                        item.current_location = from_event.name
                        self.save_inventory()
                        self.save_event(from_event)
                self.save_event(event)
                return {'success': True, 'message': f"Item {asset_id} unprepared."}
            else:
                return {'success': False, 'message': f"Asset {asset_id} not found in inventory."}
        elif action[0] == "reprepare_asset":
            asset_id = action[1]
            from_event_id = action[2]
            item = self.inventory.get(asset_id)
            if item:
                item.current_location = ''
                event.returned_items.append(asset_id)
                if from_event_id:
                    # Return asset to previous event
                    from_event = self.events.get(from_event_id)
                    if from_event:
                        from_event.returned_items.remove(asset_id)
                        item.current_location = from_event.name
                        self.save_event(from_event)
                self.save_inventory()
                self.save_event(event)
                return {'success': True, 'message': f"Item {asset_id} returned."}
            else:
                return {'success': False, 'message': f"Asset {asset_id} not found in inventory."}
        elif action[0] == 'prepare_container':
            count = action[1]
            for _ in range(count):
                if last_actions:
                    inner_action = last_actions.pop()
                    self.undo_prepare_action(event, inner_action, last_actions)
            self.save_event(event)
            return {'success': True, 'message': f"Undid preparation of {count} items."}
        elif action[0] == 'prepare_loan':
            prepared = action[1]
            entry = prepared['entry']
            if entry in event.prepared_items:
                event.prepared_items.remove(entry)
                self.save_event(event)
                return {'success': True, 'message': f"Unprepared {entry}."}
            else:
                return {'success': False, 'message': f"{entry} was not prepared."}
        elif action[0] == 'prepare_misc':
            prepared = action[1]
            entry = prepared['entry']
            if entry in event.prepared_items:
                event.prepared_items.remove(entry)
                self.save_event(event)
                return {'success': True, 'message': f"Unprepared {entry}."}
            else:
                return {'success': False, 'message': f"{entry} was not prepared."}
        elif action[0] == 'prepare_loan_all':
            entries = action[1]
            for prepared in entries:
                entry = prepared['entry']
                if entry in event.prepared_items:
                    event.prepared_items.remove(entry)
            self.save_event(event)
            return {'success': True, 'message': "All loan items unprepared."}
        elif action[0] == 'prepare_misc_all':
            entries = action[1]
            for prepared in entries:
                entry = prepared['entry']
                if entry in event.prepared_items:
                    event.prepared_items.remove(entry)
            self.save_event(event)
            return {'success': True, 'message': "All miscellaneous items unprepared."}
        else:
            return {'success': False, 'message': "Unknown action to undo."}


    def calculate_items_to_prepare(self, event):
        items_to_prepare = []
        # Count the quantities of each model already prepared
        prepared_counts = {}
        loan_prepared_counts = {}
        misc_prepared_counts = {}

        for item_id in event.prepared_items:
            if item_id.startswith('[LOAN]'):
                # Extract the model description and quantity
                match = re.match(r'^\[LOAN\]\s*(.*?)\s*;(\d+)$', item_id)
                if match:
                    model_description = f"[LOAN] {match.group(1).strip()}"
                    quantity = int(match.group(2))
                else:
                    # Handle entries without quantities
                    model_description = item_id.strip()
                    quantity = 1
                loan_prepared_counts[model_description] = loan_prepared_counts.get(model_description, 0) + quantity
            elif item_id.startswith('[MISC]'):
                # Extract the model description and quantity
                match = re.match(r'^\[MISC\]\s*(.*?)\s*;(\d+)$', item_id)
                if match:
                    model_description = f"[MISC] {match.group(1).strip()}"
                    quantity = int(match.group(2))
                else:
                    # Handle entries without quantities
                    model_description = item_id.strip()
                    quantity = 1
                misc_prepared_counts[model_description] = misc_prepared_counts.get(model_description, 0) + quantity
            else:
                item = self.inventory.get(item_id)
                if item:
                    model_description = f"[{item.department_code}] {item.brand} {item.model_number} {item.description}"
                    prepared_counts[model_description] = prepared_counts.get(model_description, 0) + 1

        # Subtract prepared quantities from asset_models
        for model in event.asset_models:
            model_description = model['model_description']
            total_quantity = model['quantity']
            if model_description.startswith('[LOAN]'):
                prepared_quantity = loan_prepared_counts.get(model_description, 0)
            elif model_description.startswith('[MISC]'):
                prepared_quantity = misc_prepared_counts.get(model_description, 0)
            else:
                prepared_quantity = prepared_counts.get(model_description, 0)
            remaining_quantity = total_quantity - prepared_quantity
            if remaining_quantity > 0:
                items_to_prepare.append({'model_description': model_description, 'quantity': remaining_quantity})

        # Sort items: Regular items first, then [MISC], then [LOAN]
        items_to_prepare = self.sort_items_for_display(items_to_prepare)
        return items_to_prepare


    def prepare_loan_or_misc_item(self, event, model_description, quantity, item_type):
        # item_type is 'loan' or 'misc'
        if item_type == 'loan':
            prefix = '[LOAN]'
        else:
            prefix = '[MISC]'
        if not model_description.startswith(prefix):
            model_description = f"{prefix} {model_description}"
        # Calculate remaining quantity to prepare
        total_quantity = 0
        for model in event.asset_models:
            if model['model_description'] == model_description:
                total_quantity = model['quantity']
                break
        prepared_quantity = 0
        for prepared_item in event.prepared_items:
            if prepared_item.startswith(model_description):
                parts = prepared_item.split(';')
                if len(parts) > 1:
                    prepared_quantity += int(parts[1])
                else:
                    prepared_quantity += 1
        remaining_quantity = total_quantity - prepared_quantity
        if quantity is None or quantity > remaining_quantity:
            quantity = remaining_quantity
        if quantity <= 0:
            return None
        entry = f"{model_description};{quantity}"
        event.prepared_items.append(entry)
        return {'entry': entry, 'quantity': quantity}


    def prepare_all_loan_or_misc_items(self, event, item_type):
        prepared_entries = []
        for model in event.asset_models:
            model_description = model['model_description']
            if item_type == 'loan' and model_description.startswith('[LOAN]'):
                quantity = model['quantity']
                entry = f"{model_description};{quantity}"
                event.prepared_items.append(entry)
                prepared_entries.append({'entry': entry, 'quantity': quantity})
            elif item_type == 'misc' and model_description.startswith('[MISC]'):
                quantity = model['quantity']
                entry = f"{model_description};{quantity}"
                event.prepared_items.append(entry)
                prepared_entries.append({'entry': entry, 'quantity': quantity})
        return prepared_entries

    def check_drought(self, model_description, event):
        total_needed = 0
        total_inventory = sum(
            1 for item in self.inventory.values()
            if not item.is_missing and not item.is_ooc and
            f"[{item.department_code}] {item.brand} {item.model_number} {item.description}" == model_description
        )
        for evt in self.events.values():
            if evt.event_id == event.event_id:
                continue
            if dates_overlap(evt.start_date, evt.end_date, event.start_date, event.end_date):
                for model in evt.asset_models:
                    if model['model_description'] == model_description:
                        total_needed += model['quantity']
        total_needed += 1  # Plus one for this event
        return total_needed > total_inventory

    def get_event_by_asset(self, asset_id):
        for event in self.events.values():
            if asset_id in event.prepared_items and asset_id not in event.returned_items:
                return event
        return None
    
    def get_clashing_events(self, model_description, start_date, end_date, exclude_event_id=None):
        clashing_events = []
        total_required = 0

        # Iterate through all events to find clashing ones
        for event in self.events.values():
            # Exclude the current event if specified
            if exclude_event_id and event.event_id == exclude_event_id:
                continue

            # Check if the event dates overlap with the current event
            if dates_overlap(event.start_date, event.end_date, start_date, end_date):
                # Check if the event requires the same asset model
                for model in event.asset_models:
                    if model['model_description'] == model_description:
                        clashing_events.append(event)
                        total_required += model['quantity']
                        break  # No need to check other models in this event

        # Calculate total inventory for the asset model
        total_inventory = sum(
            1 for item in self.inventory.values()
            if not item.is_missing and not item.is_ooc and
            f"[{item.department_code}] {item.brand} {item.model_number} {item.description}" == model_description
        )

        # Determine if a drought condition exists
        # Drought occurs if total_required + 1 > total_inventory
        drought = (total_required + 1) > total_inventory

        return drought, clashing_events


    def transfer_event(self):
        clear_screen()
        print("Transfer Assets Between Events\n")
        events_list = sorted(self.events.values(), key=lambda e: e.event_id, reverse=True)
        index = 0
        while True:
            for evt in events_list[index:index+5]:
                state_color = self.get_state_color(evt.state)
                date_range = format_date_output(evt.start_date) if evt.start_date == evt.end_date else f"{format_date_output(evt.start_date)} to {format_date_output(evt.end_date)}"
                print(f"{state_color}Event ID: {evt.event_id} | [{date_range}] {evt.name} | State: {evt.state}\033[0m")
            index += 5
            if index >= len(events_list):
                break
            more = input("Show more events? (y/n): ").strip().lower()
            if more != 'y':
                break
        try:
            from_event_id = int(input("Enter the Event ID to transfer assets FROM: ").strip())
            to_event_id = int(input("Enter the Event ID to transfer assets TO: ").strip())
        except ValueError:
            print("Invalid event ID.")
            pause()
            return

        from_event = self.events.get(from_event_id)
        to_event = self.events.get(to_event_id)
        if not from_event or not to_event:
            print("Event not found.")
            pause()
            return

        message = ""
        last_actions = []  # For undo functionality
    
        while True:
            clear_screen()
            print(f"Transferring assets from Event {from_event.event_id}: {from_event.name} to Event {to_event.event_id}: {to_event.name}\n")
            print("Assets that can be transferred:\n")
            assets_to_transfer = self.get_transferable_assets(from_event, to_event)
            if assets_to_transfer:
                for asset in assets_to_transfer:
                    colored_description = self.get_colored_item_description(
                        f"[{asset.department_code}] {asset.brand} {asset.model_number} {asset.description}"
                    )
                    print(f"{asset.asset_id}\t{colored_description}")
            else:
                print("No transferable assets available.")

            print("\n" + message)
            message = ""

            user_input = input("Enter Asset ID, Serial Number, Container ID to transfer (or 'done', 'undo'): ").strip()

            if user_input.lower() == 'done':
                self.update_event_state(from_event)
                self.save_event(from_event)
                self.update_event_state(to_event)
                self.save_event(to_event)
                break
            elif user_input.lower() == 'undo':
                if last_actions:
                    action = last_actions.pop()
                    self.undo_transfer_action(from_event, to_event, action, last_actions)
                    message += "Undid the last action.\n"
                    play_sound(success=True)
                else:
                    message += "No actions to undo.\n"
                    play_sound(success=False)
            elif user_input in self.containers:
                # Handle container
                container = self.containers[user_input]
                problematic_assets = []
                transferred_assets = []
                count = 0
                for asset_id in container.asset_ids:
                    result = self.transfer_asset(from_event, to_event, asset_id, last_actions, skip_confirm=True)
                    if not result['success']:
                        problematic_assets.append((asset_id, result['message']))
                    else:
                        transferred_assets.append(asset_id)
                        count += 1
                if problematic_assets:
                    for _ in range(count):
                        action = last_actions.pop()
                        self.undo_transfer_action(from_event, to_event, action)
                    continue
                last_actions.append('transfer_container', count)
                message += f"Transferred container {user_input}.\n"
                play_sound(success=True)
            else:
                # Handle asset ID or serial number
                result = self.transfer_asset(from_event, to_event, user_input, last_actions)
                if result['success']:
                    message += result['message'] + "\n"
                    play_sound(success=True)
                else:
                    message += result['message'] + "\n"
                    play_sound(success=False)

            self.save_event(from_event)
            self.save_event(to_event)
            self.save_inventory()

    def get_transferable_assets(self, from_event, to_event):
        transferable_assets = []
        # Assets prepared in from_event and needed but not prepared in to_event
        to_event_items_to_prepare = self.calculate_items_to_prepare(to_event)
        to_event_models_needed = [model['model_description'] for model in to_event_items_to_prepare]
        for asset_id in from_event.prepared_items:
            if asset_id.startswith('[LOAN]') or asset_id.startswith('[MISC]'):
                continue
            if asset_id in from_event.returned_items:
                continue
            item = self.inventory.get(asset_id)
            if item:
                model_description = f"[{item.department_code}] {item.brand} {item.model_number} {item.description}"
                if model_description in to_event_models_needed:
                    transferable_assets.append(item)
        return transferable_assets

    def transfer_asset(self, from_event, to_event, asset_id_or_serial, last_actions, skip_confirm=False):
        item = self.find_item_by_id_or_serial(asset_id_or_serial)
        other_event = self.get_event_by_asset(item.asset_id)
        if not item:
            return {'success': False, 'message': "Asset not found."}
        if item.asset_id in to_event.prepared_items and item.asset_id not in to_event.returned_items:
            return {'success': True, 'message': f"Asset already assigned to {to_event.name}"}
        if other_event != from_event:
            confirm = input(f"Asset type is not assigned to from-event. Transfer anyway? (y/n): ").strip().lower()
            if confirm != 'y':
                    return {'success': False, 'message': "Asset transfer cancelled as Asset is not assigned to from-event."}
        model_description = f"[{item.department_code}] {item.brand} {item.model_number} {item.description}"
        to_event_items_to_prepare = self.calculate_items_to_prepare(to_event)
        to_event_models_needed = [model['model_description'] for model in to_event_items_to_prepare]
        if model_description not in to_event_models_needed:
            confirm = input(f"Asset type is not needed in the to-event. Transfer anyway? (y/n): ").strip().lower()
            if confirm != 'y':
                return {'success': False, 'message': "Asset transfer cancelled."}
            drought, clashing_events = self.get_clashing_events(model_description, to_event.start_date, to_event.end_date, exclude_event_id=to_event.event_id)
            if drought:
                print(f"Warning: Drought detected for {item.asset_id}.")
                print(f"The following events are also using {item.asset_id}:")
                for evt in clashing_events:
                    state_color = self.get_state_color(evt.state)
                    date_range = format_date_output(evt.start_date) if evt.start_date == evt.end_date else f"{format_date_output(evt.start_date)} to {format_date_output(evt.end_date)}"
                    print(f"{state_color}Event ID: {evt.event_id} | [{date_range}] {evt.name} \t State: {evt.state}\033[0m")
                confirm = input("Would you like to prepare the asset anyway? (y/n): ").strip().lower()
                if confirm != 'y':
                    return {'success': False, 'message': "Asset preparation cancelled due to drought."}
        # Return asset from from_event and prepare it in to_event
        if other_event != from_event and other_event!= to_event:
            if other_event == None:
                to_event.prepared_items.append(item.asset_id)
                item.current_location = to_event.name
                last_actions.append(('prepare_asset', item.asset_id, None))
                return {'success': True, 'message': f"Prepared asset {item.asset_id} from Store to Event {to_event.name}."}
            else:
                other_event.returned_items.append(item.asset_id)
                to_event.prepared_items.append(item.asset_id)
                item.current_location = to_event.name
                last_actions.append(('transfer_asset', item.asset_id, other_event.event_id))
                return {'success': True, 'message': f"Transferred asset {item.asset_id} from Event {other_event.name} to Event {to_event.name}."}
        elif item.asset_id in to_event.prepared_items and item.asset_id in to_event.returned_items:
            to_event.returned_items.remove(item.asset_id)
            last_actions.append(('reprepare_asset', item.asset_id, None))
            return {'success': True, 'message': f"Item {item.asset_id} reprepared fro Event {to_event.name}."}
        if item.asset_id in from_event.prepared_items and item.asset_id not in from_event.returned_items:
            from_event.returned_items.append(item.asset_id)
        if item.asset_id not in to_event.prepared_items:
            to_event.prepared_items.append(item.asset_id)
            item.current_location = to_event.name
        last_actions.append(('transfer_asset', item.asset_id, None))
        return {'success': True, 'message': f"Transferred asset {item.asset_id} from Event {from_event.name} to Event {to_event.name}."}

    def undo_transfer_action(self, from_event, to_event, action, last_actions):
        if action[0] == 'prepare_asset':
            asset_id = action[1]
            from_event_id = action[2]
            item = self.inventory.get(asset_id)
            if item:
                item.current_location = ''
                to_event.prepared_items.remove(asset_id)
                if from_event_id:
                    # Return asset to previous event
                    from_event = self.events.get(from_event_id)
                    if from_event:
                        from_event.returned_items.remove(asset_id)
                        item.current_location = from_event.event_name
                        self.save_inventory()
                        self.save_event(from_event)
                        return {'success': True, 'message': f"Item {asset_id} unprepared and assigned back to {from_event.event_name}."}
                else:
                    self.save_inventory()
                    return {'success': True, 'message': f"Item {asset_id} unprepared."}
        elif action[0] == "reprepare_asset":
            asset_id = action[1]
            from_event_id = action[2]
            item = self.inventory.get(asset_id)
            if item:
                item.current_location = ''
                to_event.returned_items.append(asset_id)
                self.save_inventory()
                return {'success': True, 'message': f"Item {asset_id} returned."}
        elif action[0] == 'transfer_asset':
            asset_id = action[1]
            from_event_id = action[2]
            item = self.inventory.get(asset_id)
            if item:
                if from_event_id:
                    from_event = self.events.get(from_event_id)
                to_event.prepared_items.remove(asset_id)
                item.current_location = from_event.name
                from_event.returned_items.remove(asset_id)
        elif action[0] == 'transfer_container':
            count = action[1]
            for _ in range(count):
                action = last_actions.pop()
                self.undo_transfer_action(from_event, to_event, action, last_actions)
            return {'success': True, 'message': f"Undid preparation of {count} items"}

    def undo_transfer_asset(self, from_event, to_event, asset_id):
        item = self.inventory.get(asset_id)
        if item:
            to_event.prepared_items.remove(asset_id)
            item.current_location = from_event.name
            from_event.prepared_items.append(asset_id)
            from_event.returned_items.remove(asset_id)
        return

    def view_event(self, event_id):
        event = self.events.get(event_id)
        if not event:
            print("Event ID not found.")
            pause()
            return

        clear_screen()
        date_range = format_date_output(event.start_date) if event.start_date == event.end_date else f"{format_date_output(event.start_date)} to {format_date_output(event.end_date)}"
        print(f"[{date_range}] {event.name}\n")
        state_color = self.get_state_color(event.state)
        print(f"Event State: {state_color}{event.state}\033[0m\n")

        # Build a dictionary from asset_models
        planned_summary = {}
        for model in event.asset_models:
            planned_summary[model['model_description']] = model['quantity']

        # Build a dictionary from prepared_items
        prepared_summary = {}
        for prepared_item in event.prepared_items:
            if prepared_item.startswith('[LOAN]') or prepared_item.startswith('[MISC]'):
                # Format: "[LOAN] Something;3" or "[MISC] Something;2"
                parts = prepared_item.split(';')
                model_description = parts[0]  # e.g. '[LOAN] Something'
                quantity = int(parts[1]) if len(parts) > 1 else 1
                prepared_summary[model_description] = prepared_summary.get(model_description, 0) + quantity
            else:
                # It's an actual asset ID
                item = self.inventory.get(prepared_item)
                if item:
                    model_description = f"[{item.department_code}] {item.brand} {item.model_number} {item.description}"
                    prepared_summary[model_description] = prepared_summary.get(model_description, 0) + 1

        # Now combine planned_summary and prepared_summary
        # For items that appear in both, take the maximum of planned or prepared quantities
        # For items that appear only in prepared_summary, add them
        final_summary = dict(planned_summary)  # start with planned items
        for model_description, prepared_qty in prepared_summary.items():
            if model_description in final_summary:
                # Take the maximum of planned or prepared
                final_summary[model_description] = max(final_summary[model_description], prepared_qty)
            else:
                # Item was not in asset models, just add it
                final_summary[model_description] = prepared_qty

        # Prepare list for display
        display_items = [{'model_description': k, 'quantity': v} for k, v in final_summary.items()]
        display_items = self.sort_items_for_display(display_items)
        print("Item Summary:\n")
        for item in display_items:
            model_description = item['model_description']
            quantity = item['quantity']
            colored_description = self.get_colored_item_description(model_description)
            print(f"{quantity}x\t{colored_description}")
        pause()


    def show_info(self, identifier):
        # Renamed from 'asset_info' to 'show_info'
        item = self.find_item_by_id_or_serial(identifier)
        if not item:
            print("Asset not found.")
            play_sound(success=False)
            pause()
            return

        print(f"\nAsset ID: {item.asset_id}")
        print(f"Brand: {item.brand}")
        print(f"Model Number: {item.model_number}")
        print(f"Description: {item.description}")
        print(f"Serial Number: {item.serial_number}")
        print(f"Department Code: {item.department_code}")
        print(f"Default Location: {item.default_location}")
        print(f"Current Location: {item.current_location}")
        is_missing = 'Yes' if item.is_missing else 'No'
        is_ooc = 'Yes' if item.is_ooc else 'No'
        missing_color = '\033[91m' if item.is_missing else '\033[0m'
        ooc_color = '\033[91m' if item.is_ooc else '\033[0m'
        print(f"Is Missing: {missing_color}{is_missing}\033[0m")
        print(f"Is Out of Commission: {ooc_color}{is_ooc}\033[0m\n")

        print("Maintenance Logs:")
        if item.maintenance_logs:
            for log in item.maintenance_logs[-10:]:
                print(f"{log}")
        else:
            print("No maintenance logs available.")

        # Event History
        event_history = []
        for evt in sorted(self.events.values(), key=lambda e: e.event_id, reverse=True):
            if item.asset_id in evt.prepared_items:
                event_history.append(evt)
                if len(event_history) == 10:
                    break

        print("\nEvent History:")
        if event_history:
            for evt in event_history:
                state_color = self.get_state_color(evt.state)
                date_range = format_date_output(evt.start_date) if evt.start_date == evt.end_date else f"{format_date_output(evt.start_date)} to {format_date_output(evt.end_date)}"
                print(f"{state_color}Event ID: {evt.event_id} \t| [{date_range}] {evt.name} | State: {evt.state}\033[0m")
        else:
            print("No event history available.")
        pause()


    def return_event(self, event_id):
        event = self.events.get(event_id)
        if not event:
            print("Event not found.")
            pause()
            return

        if not hasattr(event, 'returned_items'):
            event.returned_items = []

        message = ""
        last_action = []  # For undo functionality

        while True:
            clear_screen()
            print(f"Returning items from Event {event.event_id}: {event.name}\n")

            # Separate prepared items into normal assets, loan items, and misc items for display
            assets_to_return = []
            loan_items = {}
            misc_items = {}
            
            # Only display items that are in prepared_items but NOT in returned_items
            for item_id in event.prepared_items:
                if item_id in event.returned_items:
                    # Skip items already returned
                    continue

                if item_id.startswith('[LOAN]'):
                    # Format: [LOAN] Name;Quantity
                    item_details = item_id[7:].strip()
                    parts = item_details.split(';')
                    model_description = f"[LOAN] {parts[0].strip()}"
                    quantity = int(parts[1]) if len(parts) > 1 else 1
                    loan_items[model_description] = loan_items.get(model_description, 0) + quantity
                elif item_id.startswith('[MISC]'):
                    # Format: [MISC] Name;Quantity
                    item_details = item_id[6:].strip()
                    parts = item_details.split(';')
                    model_description = f"[MISC] {parts[0].strip()}"
                    quantity = int(parts[1]) if len(parts) > 1 else 1
                    misc_items[model_description] = misc_items.get(model_description, 0) + quantity
                else:
                    asset = self.inventory.get(item_id)
                    if asset:
                        assets_to_return.append(asset)

            # Display items to return
            print("Items to be returned:\n")
            if not assets_to_return and not loan_items and not misc_items:
                print("No more items need to be returned.")
            
            if assets_to_return:
                for asset in assets_to_return:
                    model_description = f"[{asset.department_code}] {asset.brand} {asset.model_number} {asset.description}"
                    colored_description = self.get_colored_item_description(model_description)
                    print(f"{asset.asset_id}\t{colored_description}")
            if loan_items:
                for model_description, quantity in loan_items.items():
                    colored_description = self.get_colored_item_description(model_description)
                    print(f"Quantity: {quantity}\t{colored_description}")
            if misc_items:
                for model_description, quantity in misc_items.items():
                    colored_description = self.get_colored_item_description(model_description)
                    print(f"Quantity: {quantity}\t{colored_description}")

            if message:
                print("\n" + message)
                message = ""

            user_input = input("\nEnter Asset ID, Serial Number, 'return <item description> <quantity>', 'return all', Container ID to return (or 'done', 'undo'): ").strip()

            if user_input.lower() == 'done':
                self.update_event_state(event)
                self.save_event(event)
                break
            elif user_input.lower() == 'undo':
                if last_action:
                    action = last_action.pop()
                    if action['type'] == 'return_asset':
                        asset_id = action['asset_id']
                        item = self.inventory.get(asset_id)
                        if item:
                            # Undo returning this asset
                            item.current_location = event.name
                            if asset_id in event.returned_items:
                                event.returned_items.remove(asset_id)
                            message += f"Undo return of asset {asset_id}.\n"
                            play_sound(success=True)
                    elif action['type'] == 'return_container':
                        container_id = action['container_id']
                        assets = action['assets']
                        for asset_id in assets:
                            asset = self.inventory.get(asset_id)
                            if asset and asset_id in event.returned_items:
                                asset.current_location = event.name
                                event.returned_items.remove(asset_id)
                        message += f"Undo return of container {container_id}.\n"
                        play_sound(success=True)
                    elif action['type'] == 'return_all':
                        # Undo return all - restore all items to not returned
                        returned_assets = action['assets']
                        for item_id in returned_assets:
                            if item_id in event.returned_items:
                                event.returned_items.remove(item_id)
                            # Restore location for normal assets
                            if not (item_id.startswith('[LOAN]') or item_id.startswith('[MISC]')):
                                item = self.inventory.get(item_id)
                                if item:
                                    item.current_location = event.name
                        message += "Undo return of all items.\n"
                        play_sound(success=True)
                    else:
                        message += "Unknown action to undo.\n"
                        play_sound(success=False)
                else:
                    message += "No actions to undo.\n"
                    play_sound(success=False)
            elif user_input.lower() == 'return all':
                # Admin authentication required
                if not self.current_user.is_admin:
                    print("Admin privileges required to return all items.")
                    username = input("Admin Username: ").strip()
                    password = getpass.getpass("Admin Password: ").strip()
                    admin_user = self.users.get(username)
                    if not admin_user or not admin_user.is_admin:
                        print("Authentication failed.")
                        continue
                    hashed_input = hash_password(password, admin_user.salt)
                    if hashed_input != admin_user.password_hash:
                        print("Authentication failed.")
                        continue

                # Return all currently non-returned prepared items
                returned_assets = []
                for item_id in event.prepared_items:
                    if item_id not in event.returned_items:
                        # Normal assets
                        if not (item_id.startswith('[LOAN]') or item_id.startswith('[MISC]')):
                            asset = self.inventory.get(item_id)
                            if asset:
                                asset.current_location = ''
                        event.returned_items.append(item_id)
                        returned_assets.append(item_id)

                last_action.append({'type': 'return_all', 'assets': returned_assets})
                message += "Returned all items.\n"
                play_sound(success=True)
            elif user_input in self.containers:
                container = self.containers[user_input]
                returned_assets = []
                for asset_id in container.asset_ids:
                    if asset_id in event.prepared_items and asset_id not in event.returned_items:
                        asset = self.inventory.get(asset_id)
                        if asset:
                            asset.current_location = ''
                            event.returned_items.append(asset_id)
                            returned_assets.append(asset_id)
                if returned_assets:
                    last_action.append({'type': 'return_container', 'container_id': user_input, 'assets': returned_assets})
                    message += f"Returned assets from container {user_input}.\n"
                    play_sound(success=True)
                else:
                    message += f"No assets from container {user_input} are tagged to this event.\n"
                    play_sound(success=False)
            else:
                item = self.find_item_by_id_or_serial(user_input)
                if item:
                    if item.asset_id in event.prepared_items and item.asset_id not in event.returned_items:
                        item.current_location = ''
                        event.returned_items.append(item.asset_id)
                        last_action.append({'type': 'return_asset', 'asset_id': item.asset_id})
                        message += f"Returned asset {item.asset_id}.\n"
                        play_sound(success=True)
                    else:
                        other_event = self.get_event_by_asset(item.asset_id)
                        if other_event and other_event.event_id != event.event_id:
                            message += f"Asset {item.asset_id} is not tagged to this event but is tagged to Event {other_event.event_id}: {other_event.name}.\n"
                        elif item.asset_id in event.returned_items:
                            message += f"Asset {item.asset_id} is already returned.\n"
                        else:
                            message += f"Asset {item.asset_id} is not tagged to this event.\n"
                        play_sound(success=False)
                else:
                    message += "Asset not found.\n"
                    play_sound(success=False)

            self.update_event_state(event)
            self.save_event(event)
            self.save_inventory()


    def update_event_state(self, event):
        total_items_to_prepare = sum(model['quantity'] for model in event.asset_models)
        total_prepared_items = len([item for item in event.prepared_items if not item.startswith('[LOAN]') and not item.startswith('[MISC]')])
        total_loan_prepared = sum(1 for item in event.prepared_items if item.startswith('[LOAN]'))
        total_misc_prepared = sum(1 for item in event.prepared_items if item.startswith('[MISC]'))
        total_items_prepared = total_prepared_items + total_loan_prepared + total_misc_prepared

        # Determine if any items have been returned
        total_items_returned = len(event.returned_items)

        if total_items_prepared == 0 and total_items_returned == 0:
            event.state = 'Added'
        elif total_items_returned > 0 and total_items_returned < total_items_prepared:
            event.state = 'Returning'
        elif total_items_returned == total_items_prepared:
            event.state = 'Closed'
        elif total_items_prepared < total_items_to_prepare:
            event.state = 'Preparing'
        elif total_items_prepared == total_items_to_prepare:
            event.state = 'Ready'

        self.save_event(event)

    def delete_event(self, event_id):
        event = self.events.get(event_id)
        if not event:
            print("Event not found.")
            play_sound(success=False)
            pause()
            return

        if not self.current_user.is_admin:
            print("You do not have permission to delete events.")
            play_sound(success=False)
            pause()
            return

        confirm = input(f"Are you sure you want to delete Event {event_id}: {event.name}? (y/n): ").strip().lower()
        if confirm != 'y':
            print("Deletion cancelled.")
            play_sound(success=False)
            pause()
            return

        try:
            # Optional: Create a backup before deletion
            self.backup_event_file(event_id)

            # Iterate over all prepared items in the event
            for asset_id in event.prepared_items.copy():  # Use copy to avoid modification during iteration
                item = self.inventory.get(asset_id)
                if not item:
                    print(f"Warning: Asset {asset_id} not found in inventory. Skipping...")
                    continue

                # Reset current_location to default_location or 'Store' if not specified
                item.current_location = ""

                # Note: Do not remove from prepared_items as per user instruction
                
                # Log the return action
                # Since we are not tracking returns separately anymore in this context,
                # we might want to log this as a general return due to event deletion
                self.log_action(f"Asset {asset_id} returned due to deletion of Event {event_id}.")

            # Save the updated inventory
            self.save_inventory()

            # Remove the event from the events dictionary
            del self.events[event_id]

            # Delete the event's CSV file
            self.delete_event_file(event_id)

            # Log the deletion action
            self.log_action(f"Deleted Event {event_id}: {event.name}.")

            print(f"Event {event_id}: {event.name} has been deleted successfully.")
            play_sound(success=True)
        except Exception as e:
            print(f"An error occurred while deleting the event: {e}")
            self.log_action(f"Error deleting Event {event_id}: {e}")
            play_sound(success=False)
        finally:
            pause()

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


    def sort_transferable_items(self, transferable_items):
        # Sort primarily by department code, then alphabetically by description
        return sorted(transferable_items, key=lambda x: (x['department_code'], x['description']))


    def asset_check(self):
        clear_screen()
        print("Asset Check")
        initial_input = input("Enter an Asset ID or Serial Number to start (or 'exit' to cancel): ").strip()
        if initial_input.lower() == 'exit':
            return
        item = self.find_item_by_id_or_serial(initial_input)
        if not item:
            print("Asset ID or Serial Number not found.")
            pause()
            return
        brand = item.brand
        model_number = item.model_number

        # Get all items with the same brand and model number, including those marked as missing
        items_to_check = [i for i in self.inventory.values() if i.brand == brand and i.model_number == model_number]

        # Create a dictionary mapping asset_id to item
        items_dict = {i.asset_id: i for i in items_to_check}

        # Display the list
        print(f"\nChecking items for {brand} {model_number} {item.description}\n")
        self.display_items_list(items_dict.values())

        # Initialize a set to keep track of checked items
        checked_items = set()

        while True:
            user_input = input("\nEnter Asset ID or Serial Number (or 'done' to finish, 'exit' to cancel): ").strip()
            if user_input.lower() == 'done':
                break
            elif user_input.lower() == 'exit':
                print("Asset check cancelled.")
                pause()
                return
            found_item = self.find_item_by_id_or_serial(user_input)
            if not found_item:
                print("Asset ID or Serial Number not found.")
                continue
            if found_item.asset_id not in items_dict:
                print("Item does not match the items being checked.")
                continue
            if found_item.asset_id in checked_items:
                print("Item already checked.")
                continue
            checked_items.add(found_item.asset_id)
            # Remove item from the list
            del items_dict[found_item.asset_id]
            # Display remaining items
            print("\nRemaining items:")
            self.display_items_list(items_dict.values())

        # After done, process remaining items
        if items_dict:
            print("\nThe following items were not found:")
            self.display_items_list(items_dict.values())
            for item in items_dict.values():
                if not item.is_missing:
                    confirm = input(f"Mark {item.asset_id} as missing? (y/n): ").strip().lower()
                    if confirm == 'y':
                        item.is_missing = True
                        print(f"{item.asset_id} marked as missing.")
                    else:
                        print(f"{item.asset_id} not marked as missing.")
                else:
                    print(f"{item.asset_id} is already marked as missing.")
            self.save_inventory()
            print("\nInventory updated.")
        else:
            print("\nAll items accounted for.")
        pause()

    def display_items_list(self, items):
        if not items:
            print("No items to display.")
            return

        # Sort items with loan and misc at the end
        sorted_items = self.sort_items_for_display(items)

        print(f"{'Asset ID':<15}{'Serial Number':<20}{'Item Details'}")
        print("-" * 60)
        for item in sorted_items:
            colored_description = self.get_colored_item_description(item)
            print(f"{item.asset_id:<15}{item.serial_number:<20}{colored_description}")

    def display_event_summary(self, event):
        print(f"[{format_date_output(event.start_date)}] {event.name}")
        print("Item Summary:\n")

        sorted_asset_models = self.sort_items_for_display(event.asset_models)
        state_color = self.get_state_color(event.state)
        for model in sorted_asset_models:
            model_description = model['model_description']
            quantity = model['quantity']
            colored_description = self.get_colored_item_description(model_description)
            print(f"{quantity}x {colored_description}")

        print(f"\nEvent State: {state_color}{event.state}\033[0m")

    def list_events(self):
        # Sort events by event_id in descending order (more recently added first)
        event_list = sorted(self.events.values(), key=lambda e: e.event_id, reverse=True)
        index = 0
        while index < len(event_list):
            for event in event_list[index:index+10]:
                state_color = self.get_state_color(event.state)
                date_range = f"{format_date_output(event.start_date)} to {format_date_output(event.end_date)}"
                print(f"{state_color}Event ID: {event.event_id} | [{date_range}] {event.name} | State: {event.state}\033[0m")

            index += 10
            if index < len(event_list):
                cont = input("Show more? (y/n): ").strip().lower()
                if cont != 'y':
                    break
        pause()

    def get_state_color(self, state):
        if state == 'Added':
            return '\033[94m'  # Blue
        elif state == 'Preparing':
            return '\033[93m'  # Yellow
        elif state == 'Ready':
            return '\033[92m'  # Green
        elif state == 'Returning':
            return '\033[95m'  # Magenta
        elif state == 'Closed':
            return '\033[90m'  # Gray
        else:
            return '\033[0m'   # Default

    def find_item_by_id_or_serial(self, id_or_serial):
        if id_or_serial in self.inventory:
            return self.inventory[id_or_serial]
        else:
            for item in self.inventory.values():
                if item.serial_number and item.serial_number.lower() == id_or_serial.lower():
                    return item
        return None

    def show_info(self, identifier):
        item = self.find_item_by_id_or_serial(identifier)
        if not item:
            print("Asset not found.")
            play_sound(success=False)
            pause()
            return

        print(f"\nAsset ID: {item.asset_id}")
        print(f"Brand: {item.brand}")
        print(f"Model Number: {item.model_number}")
        print(f"Description: {item.description}")
        print(f"Serial Number: {item.serial_number}")
        print(f"Department Code: {item.department_code}")
        print(f"Default Location: {item.default_location}")
        print(f"Current Location: {item.current_location}")
        print(f"Is Missing: {'Yes' if item.is_missing else 'No'}")
        print(f"Is Out of Commission: {'Yes' if item.is_ooc else 'No'}\n")

        print("Maintenance Logs:")
        if item.maintenance_logs:
            for log in item.maintenance_logs[-10:]:
                print(f"{log}")
        else:
            print("No maintenance logs available.")

        # Event History
        event_history = []
        for evt in sorted(self.events.values(), key=lambda e: e.event_id, reverse=True):
            if item.asset_id in evt.prepared_items:
                event_history.append(evt)
                if len(event_history) == 10:
                    break

        print("\nEvent History:")
        if event_history:
            for evt in event_history:
                colored_state = self.get_state_color(evt.state)
                if evt.start_date == evt.end_date:
                    date_range = format_date_output(evt.start_date)
                else:
                    date_range = f"{format_date_output(evt.start_date)} to {format_date_output(evt.end_date)}"
                print(f"{colored_state}Event ID: {evt.event_id} | [{date_range}] {evt.name} | State: {evt.state}\033[0m")
        else:
            print("No event history available.")
        pause()

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


    def find_event(self, keyword):
        keyword = keyword.lower()
        results = [event for event in self.events.values() if keyword in event.name.lower()]
        if results:
            for event in results:
                if event.start_date == event.end_date:
                    date_range = format_date_output(event.start_date)
                else:
                    date_range = f"{format_date_output(event.start_date)} to {format_date_output(event.end_date)}"
                print(f"Event ID: {event.event_id} | [{date_range}] {event.name}")
        else:
            print("No matching events found.")
        pause()

    def show_logs(self):
        for log in self.logs[-MAX_LOG_LINES:]:
            print(f"{log.timestamp}\t{log.user}\t{log.action}")
        pause()

    def maintain_asset(self, identifier=None):
        maintenance_list = []  # List to track assets to maintain
        message = ""
        new_location = None  # Initialize new_location
        mark_ooc = 'n'       # Initialize mark_ooc
        unmark_ooc = 'n'     # Initialize unmark_ooc

        if identifier:
            item = self.find_item_by_id_or_serial(identifier)
            if item:
                maintenance_list.append(item.asset_id)
            else:
                print("Asset not found.")
                pause()
                return

        print("Enter Asset IDs, Serial Numbers, or Container IDs to add to maintenance (type 'done' when finished):")
        
        while True:
            clear_screen()
            
            print("Maintenance Preparation")
            if maintenance_list:
                print("\nAssets selected for maintenance:")
                for asset_id in maintenance_list:
                    item = self.inventory.get(asset_id)
                    if item:
                        print(f"{asset_id}: {item.brand} {item.model_number} {item.description}")
            
            if message:
                print(f"\n{message}")
            
            if identifier:
                user_input = 'done'
                identifier = None  # Reset after first use
            else:
                user_input = input("\nEnter Asset ID, Serial Number, or Container ID (or 'done' to finish): ").strip()

            if user_input.lower() == 'done':
                break
            elif user_input in self.containers:
                container = self.containers[user_input]
                for asset_id in container.asset_ids:
                    if asset_id in maintenance_list:
                        message = f"Asset {asset_id} is already in the maintenance list."
                        play_sound(success=False)  # Play error sound for duplicate
                        continue
                    item = self.inventory.get(asset_id)
                    if item:
                        maintenance_list.append(asset_id)
                        message = f"Added {asset_id} from container {user_input} for maintenance."
                        play_sound(success=True)  # Play success sound for valid asset
                    else:
                        message = f"Asset {asset_id} not found in inventory."
                        play_sound(success=False)  # Play error sound for invalid asset
            else:
                # Check if the input is an individual asset by Asset ID or Serial Number
                item = self.find_item_by_id_or_serial(user_input)
                if item:
                    if item.asset_id in maintenance_list:
                        message = f"Asset {item.asset_id} is already in the maintenance list."
                        play_sound(success=False)  # Play error sound for duplicate
                    else:
                        maintenance_list.append(item.asset_id)
                        message = f"Added {item.asset_id} for maintenance."
                        play_sound(success=True)  # Play success sound for valid asset
                else:
                    message = "Asset not found."
                    play_sound(success=False)  # Play error sound for invalid asset

        # Proceed if there are assets in the maintenance list
        if maintenance_list:
            log_entry = input("\nEnter maintenance log entry: ").strip()
            current_date = get_current_date()
            
            # Check for specific keywords and prompt location updates
            if any(keyword in log_entry.lower() for keyword in ["servicing", "repair", "spoilt", "faulty"]):
                update_location = input("Do you want to update the location of these assets? (y/n): ").strip().lower()
                if update_location == 'y':
                    new_location = input("Enter the new location: ").strip()

            # Check for OOC keywords
            if any(keyword in log_entry.lower() for keyword in ["spoilt", "faulty", "check"]):
                mark_ooc = input("Do you want to mark these items as Out of Commission (OOC)? (y/n): ").strip().lower()
            elif any(keyword in log_entry.lower() for keyword in ["fixed", "repaired", "replaced"]):
                unmark_ooc = input("Do you want to unmark these items from being Out of Commission (OOC)? (y/n): ").strip().lower()
            else:
                mark_ooc = 'n'
                unmark_ooc = 'n'

            # Apply maintenance log to each asset in the maintenance list
            for asset_id in maintenance_list:
                item = self.inventory.get(asset_id)
                if item:
                    entry = f"{current_date}\t{self.current_user.username}\t{log_entry}"
                    item.maintenance_logs.append(entry)
                    
                    # Update location based on user input
                    if new_location:
                        item.current_location = new_location

                    # Update OOC status
                    if mark_ooc == 'y':
                        item.is_ooc = True
                    if unmark_ooc == 'y':
                        item.is_ooc = False

                    self.save_inventory()
                    message = f"Maintenance logged for {item.asset_id}."
                    play_sound(success=True)  # Play success sound
                else:
                    message = f"Asset {asset_id} not found in inventory."
                    play_sound(success=False)  # Play error sound

            print("\nMaintenance completed for all selected assets.")
        else:
            print("\nNo assets selected for maintenance.")

        pause()

    def search_items_by_keywords(self, keywords):
        keywords = keywords.lower().split()
        results = []
        for item in self.inventory.values():
            # Decide whether to include missing or OOC items
            # If you want to include them, remove the next two lines
            if item.is_missing or item.is_ooc:
                continue
            searchable_text = f"{item.brand} {item.model_number} {item.description}".lower()
            if any(keyword in searchable_text for keyword in keywords):
                results.append(item)

        return results


    def add_or_update_asset_model(self, asset_models, model_description, quantity):
        for model in asset_models:
            if model['model_description'] == model_description:
                model['quantity'] += quantity
                return
        asset_models.append({'model_description': model_description, 'quantity': quantity})

    def remove_or_update_asset_model(self, asset_models, model_description, quantity, remove=False):
        for model in asset_models:
            if model['model_description'] == model_description:
                if remove or model['quantity'] <= quantity:
                    asset_models.remove(model)
                else:
                    model['quantity'] -= quantity
                return


    def group_items_by_model(self, items):
        groups = defaultdict(int)
        for item in items:
            if isinstance(item, InventoryItem):
                key = f"[{item.department_code}] {item.brand} {item.model_number} {item.description}"
            elif isinstance(item, str):
                key = item  # Assuming it's a model description string
            else:
                raise ValueError("Unexpected item type for grouping.")

            groups[key] += 1

        # Sort groups such that loan and misc items appear last
        sorted_keys = sorted(groups.keys(), key=lambda k: (not ("[LOAN]" in k or "[MISC]" in k), k.lower()))
        
        # Corrected return statement
        return {key: groups[key] for key in sorted_keys}

    def prompt_user_to_select_group(self, grouped_items):
        while True:
            choice = input("Enter number of your choice or 'back' to search again: ").strip()
            if choice.lower() == 'back':
                return 'back'
            if choice.isdigit():
                choice_num = int(choice)
                if 1 <= choice_num <= len(grouped_items):
                    selected_key = list(grouped_items.keys())[choice_num - 1]
                    return selected_key
            print("Invalid choice. Please try again.")

    def log_action(self, action):
        timestamp = get_current_date()
        log_entry = LogEntry(timestamp, self.current_user.username, action)
        self.logs.append(log_entry)
        self.save_logs()


    def log_asset_action(self, item, event_id, action, from_event_id=None):
        log_entry = {
            'event_id': event_id,
            'action': action,
            'timestamp': get_current_date(),
            'user': self.current_user.username
        }
        if from_event_id:
            log_entry['from_event'] = from_event_id
        item.asset_history.append(log_entry)
        self.save_inventory()

    def is_item_available(self, item, start_date, end_date, exclude_event_ids=None):
        if exclude_event_ids is None:
            exclude_event_ids = []
        elif isinstance(exclude_event_ids, int):
            exclude_event_ids = [exclude_event_ids]  # Convert single event ID to a list

        for event in self.events.values():
            if event.event_id in exclude_event_ids:
                continue
            if item.asset_id in event.prepared_items and dates_overlap(event.start_date, event.end_date, start_date, end_date):
                return False, event
        return True, None

    def dates_overlap(self, start1, end1, start2, end2):
        start1 = datetime.datetime.strptime(start1, "%Y%m%d")
        end1 = datetime.datetime.strptime(end1, "%Y%m%d")
        start2 = datetime.datetime.strptime(start2, "%Y%m%d")
        end2 = datetime.datetime.strptime(end2, "%Y%m%d")
        return max(start1, start2) <= min(end1, end2)


    def get_available_quantity(self, model_description, start_date, end_date, exclude_event_id=None):
        # Total quantity: count of all assets matching the model_description, not missing or OOC
        total_quantity = sum(
            1 for item in self.inventory.values()
            if not item.is_missing and not item.is_ooc and
            f"[{item.department_code}] {item.brand} {item.model_number} {item.description}" == model_description
        )

        # Allocated quantity: sum of quantities allocated to overlapping events
        allocated_quantity = 0
        for event in self.events.values():
            if exclude_event_id and event.event_id == exclude_event_id:
                for model in event.asset_models:
                    if model['model_description'] == model_description:
                        allocated_quantity += model['quantity']

        available_quantity = total_quantity - allocated_quantity
        return available_quantity, total_quantity

    def sort_items_for_display(self, items):
        def sort_key(item):
            if isinstance(item, dict):
                description = item.get('model_description', '')
            elif isinstance(item, InventoryItem):
                description = f"[{item.department_code}] {item.brand} {item.model_number} {item.description}"
            elif isinstance(item, str):
                description = item
            else:
                description = ''

            if '[LOAN]' in description:
                return (2, description.lower())  # Loan items come last
            elif '[MISC]' in description:
                return (1, description.lower())  # Misc items come second to last
            else:
                return (0, description.lower())  # Regular items first

        return sorted(items, key=sort_key)

    def get_colored_item_description(self, model_description):
        # Define color codes
        color_codes = {
            "AX": "\033[94m",    # Blue
            "LX": "\033[92m",    # Green
            "VX": "\033[95m",    # Purple
            "LOAN": "\033[91m",  # Red
            "MISC": "\033[93m",  # Yellow
            "DEFAULT": "\033[0m", # Reset
        }
        
        # Determine the department code from the model_description
        if model_description.startswith('[LOAN]'):
            color = color_codes["LOAN"]
            description = model_description[7:].strip()
        elif model_description.startswith('[MISC]'):
            color = color_codes["MISC"]
            description = model_description[6:].strip()
        elif model_description.startswith('[LX]'):
            color = color_codes["LX"]
            description = model_description[4:].strip()
        elif model_description.startswith('[AX]'):
            color = color_codes["AX"]
            description = model_description[4:].strip()
        elif model_description.startswith('[VX]'):
            color = color_codes["VX"]
            description = model_description[4:].strip()
        else:
            color = color_codes["DEFAULT"]
            description = model_description

        return f"{color}{model_description}\033[0m"




# Run the application
if __name__ == "__main__":
    app = InventoryManagementApp()
    app.start()
