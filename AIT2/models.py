import hashlib
import datetime


# Date formats used by form input/display and CSV storage.
DATE_FORMAT = "%Y/%m/%d"
STORAGE_DATE_FORMAT = "%Y%m%d"


def hash_password(password, salt):
    return hashlib.sha256((salt + password).encode()).hexdigest()


def get_current_date():
    return datetime.datetime.now().strftime(DATE_FORMAT)


def parse_date_input(date_str):
    try:
        date_obj = datetime.datetime.strptime(date_str.strip(), DATE_FORMAT)
        return date_obj.strftime(STORAGE_DATE_FORMAT)
    except ValueError:
        return None


def format_date_output(date_str):
    return datetime.datetime.strptime(date_str, STORAGE_DATE_FORMAT).strftime(DATE_FORMAT)


def dates_overlap(start1, end1, start2, end2):
    start1 = datetime.datetime.strptime(start1, STORAGE_DATE_FORMAT)
    end1 = datetime.datetime.strptime(end1, STORAGE_DATE_FORMAT)
    start2 = datetime.datetime.strptime(start2, STORAGE_DATE_FORMAT)
    end2 = datetime.datetime.strptime(end2, STORAGE_DATE_FORMAT)
    return max(start1, start2) <= min(end1, end2)


class User:
    def __init__(self, username, password_hash, salt, is_admin, is_active=True, last_online='-'):
        self.username = username
        self.password_hash = password_hash
        self.salt = salt
        self.is_admin = is_admin
        self.is_active = is_active
        self.last_online = str(last_online or '-').strip() or '-'


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
    def __init__(
        self,
        asset_id,
        brand,
        model_number,
        serial_number,
        description,
        is_missing,
        maintenance_logs,
        department_code,
        default_location='',
        current_location='',
        is_ooc=False,
        is_bulk=False,
        quantity=1,
        is_degraded=False,
        is_disposed=False,
        date_of_purchase='',
        date_added='',
        date_modified='',
        change_history=None,
        notes='',
        secondary_serial_number='',
    ):
        self.asset_id = asset_id
        self.brand = brand
        self.model_number = model_number
        self.serial_number = serial_number
        self.secondary_serial_number = secondary_serial_number or ''
        self.description = description
        self.is_missing = is_missing
        self.is_ooc = is_ooc
        self.is_degraded = bool(is_degraded)
        self.is_disposed = bool(is_disposed)

        # Imported CSV rows may contain multiple legacy status flags. The app
        # treats condition states as exclusive, with decommissioned as strongest.
        if self.is_disposed:
            self.is_missing = False
            self.is_ooc = False
            self.is_degraded = False
        elif self.is_missing:
            self.is_ooc = False
            self.is_degraded = False
        elif self.is_ooc:
            self.is_degraded = False

        self.maintenance_logs = maintenance_logs
        self.department_code = department_code.upper()
        self.default_location = default_location
        self.current_location = current_location
        self.date_of_purchase = date_of_purchase or ''
        self.date_added = date_added or ''
        self.date_modified = date_modified or ''
        self.change_history = change_history if change_history is not None else []
        self.notes = notes or ''
        self.is_bulk = is_bulk
        try:
            self.quantity = max(1, int(quantity)) if is_bulk else 1
        except (TypeError, ValueError):
            self.quantity = 1


class Container:
    def __init__(self, container_id, asset_ids, serial_number=''):
        self.container_id = container_id
        self.asset_ids = asset_ids
        self.serial_number = serial_number or ''


class Event:
    def __init__(
        self,
        event_id,
        name,
        start_date,
        end_date,
        asset_models,
        prepared_items=None,
        state='Added',
        returned_items=None,
        actually_prepared=None,
        extra_assets=None,
        tag='event',
        force_state_override=False,
        custom_collected=None,
        notes='',
        event_logs=None,
    ):
        self.event_id = event_id
        self.name = name
        self.start_date = start_date
        self.end_date = end_date
        self.asset_models = asset_models
        self.prepared_items = prepared_items if prepared_items is not None else []
        self.returned_items = returned_items if returned_items is not None else []
        self.state = state
        self.actually_prepared = actually_prepared if actually_prepared is not None else []
        self.extra_assets = extra_assets if extra_assets is not None else []
        # Custom loan/rental items use collected -> prepared -> returned stages.
        self.custom_collected = custom_collected if custom_collected is not None else []
        self.tag = tag
        self.force_state_override = force_state_override
        self.notes = notes or ''
        self.event_logs = event_logs if event_logs is not None else []


class LogEntry:
    def __init__(self, timestamp, user, action):
        self.timestamp = timestamp
        self.user = user
        self.action = action
