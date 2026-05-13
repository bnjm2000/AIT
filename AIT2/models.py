import hashlib
import datetime

# Constants
DATE_FORMAT = "%Y/%m/%d"

def hash_password(password, salt):
    return hashlib.sha256((salt + password).encode()).hexdigest()

def get_current_date():
    return datetime.datetime.now().strftime(DATE_FORMAT)

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

class User:
    def __init__(self, username, password_hash, salt, is_admin, is_active=True):
        self.username = username
        self.password_hash = password_hash
        self.salt = salt
        self.is_admin = is_admin
        self.is_active = is_active

class Client:
    def __init__(self, name, company='', address1='', address2='', address3='', postal_code='', phone=''):
        self.name = name
        self.company = company
        self.address1 = address1
        self.address2 = address2
        self.address3 = address3
        self.postal_code = postal_code
        self.phone = phone

class InventoryItem:
    def __init__(self, asset_id, brand, model_number, serial_number, description, is_missing, maintenance_logs, department_code, default_location='', current_location='', is_ooc=False, is_bulk=False, quantity=1):
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
        self.is_bulk = is_bulk
        try:
            self.quantity = max(1, int(quantity)) if is_bulk else 1
        except (TypeError, ValueError):
            self.quantity = 1

class Container:
    def __init__(self, container_id, asset_ids):
        self.container_id = container_id
        self.asset_ids = asset_ids  # List of asset IDs

class Event:
    def __init__(self, event_id, name, start_date, end_date, asset_models, prepared_items=None, state='Added', returned_items=None, actually_prepared=None, extra_assets=None, tag='event', force_state_override=False, custom_collected=None):
        self.event_id = event_id
        self.name = name
        self.start_date = start_date
        self.end_date = end_date
        self.asset_models = asset_models
        self.prepared_items = prepared_items if prepared_items is not None else []  # List of specific asset IDs or loan/misc items
        self.returned_items = returned_items if returned_items is not None else []  # List to track returned items
        self.state = state  # Event state
        self.actually_prepared = actually_prepared if actually_prepared is not None else []  # List of actually prepared assets
        self.extra_assets = extra_assets if extra_assets is not None else [] 
        # Structured custom loan/rental items use this list to track the "collected" step.
        # The actual marker still lives in prepared_items; final preparation lives in actually_prepared.
        self.custom_collected = custom_collected if custom_collected is not None else []
        self.tag = tag
        self.force_state_override = force_state_override  # Flag to track if state was manually forced

class LogEntry:
    def __init__(self, timestamp, user, action):
        self.timestamp = timestamp
        self.user = user
        self.action = action