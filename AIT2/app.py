from flask import Flask, render_template, request, jsonify, session, redirect, url_for, jsonify
import csv
from urllib.parse import unquote_plus
import os
from flask_cors import CORS
from functools import wraps
import os
import json
from datetime import datetime
from collections import defaultdict
import logging
import threading
import time

# Import your existing modules
from models import User, InventoryItem, Container, Event, LogEntry, hash_password, format_date_output, dates_overlap
from data_manager import DataManager
from utils import get_state_color
from urllib.parse import unquote_plus

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = Flask(__name__)
app.secret_key = os.environ.get('SECRET_KEY', 'AVEC')
CORS(app)

# Global data manager instance
data_manager = None

# Caching for performance
_cache = {
    'assigned_assets': None,
    'available_assets': None,
    'cache_timestamp': None
}

from datetime import datetime as _dt
from flask import request, jsonify

def _parse_any_date(_s):
    if not _s:
        return None
    s = str(_s).strip()
    for fmt in ("%Y%m%d", "%Y/%m/%d", "%Y-%m-%d"):
        try:
            return _dt.strptime(s, fmt).date()
        except Exception:
            pass
    return None

def _ranges_overlap(a_start, a_end, b_start, b_end):
    ad1, ad2 = _parse_any_date(a_start), _parse_any_date(a_end)
    bd1, bd2 = _parse_any_date(b_start), _parse_any_date(b_end)
    if not all([ad1, ad2, bd1, bd2]):
        return False
    return ad1 <= bd2 and bd1 <= ad2

def invalidate_cache():
    """Invalidate the asset cache when data changes"""
    global _cache
    _cache = {'assigned_assets': None,
              'available_assets': None, 'cache_timestamp': None}


def require_auth(f):
    """Decorator to require authentication"""
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if 'user' not in session:
            return jsonify({'error': 'Not authenticated'}), 401
        return f(*args, **kwargs)
    return decorated_function

@app.route('/api/assets/available-for-event/<int:event_id>', methods=['GET'])
@require_auth
def get_available_assets_for_event(event_id):
    """
    Return the list of *asset objects* that are free for this event, after subtracting:
      - assets specifically assigned (and not returned) to overlapping events, and
      - additional assets equal to the *model quantity* reserved in those overlapping events
        (even if no specific IDs have been attached there yet).

    Matching/comparison is done by (department, brand, model) — description is ignored for the overlap math.
    We DO NOT prevent anything on the client — this only adjusts the 'available' list/counts shown to the user.
    """
    try:
        # --- Load target event & its dates ---
        event = data_manager.events.get(event_id)
        if not event:
            return jsonify({'error': 'Event not found'}), 404

        my_start = getattr(event, 'start_date', '')
        my_end   = getattr(event, 'end_date', '')

        from collections import defaultdict

        # --- Build a pool of all physical assets (not missing/OOC) grouped by model key (dept, brand, model) ---
        assets_by_k3 = defaultdict(list)   # (dept, brand, model) -> [asset_id, ...]
        asset_info = {}                    # id -> { id, brand, model, description, department, serial, ... }

        for a_id, a in data_manager.inventory.items():
            if not a:
                continue
            if getattr(a, 'is_missing', False) or getattr(a, 'is_ooc', False):
                continue
            k3 = (a.department_code, a.brand, a.model_number)
            assets_by_k3[k3].append(a_id)
            # shape it to what your frontend expects
            asset_info[a_id] = {
                'id': a_id,
                'brand': a.brand,
                'model': a.model_number,
                'description': getattr(a, 'description', '') or '',
                'department': a.department_code,
                'serial': (getattr(a, 'serial_number', None) or getattr(a, 'serial', None) or ''),
                # add any other fields your UI shows here if needed
            }

        # --- Tally overlapping events' demand ---
        #   For each overlapping event:
        #     event_demand_by_k3 = max( MODEL qty sum by k3 , count of specific assets assigned & not returned by k3 )
        #   Sum across all overlapping events.
        total_specific_by_k3 = defaultdict(int)
        total_event_demand_by_k3 = defaultdict(int)

        for other in data_manager.events.values():
            if not other or other.event_id == event_id:
                continue
            if not _ranges_overlap(my_start, my_end, getattr(other, 'start_date', ''), getattr(other, 'end_date', '')):
                continue

            returned_other = set(getattr(other, 'returned_items', []) or [])
            other_specific_by_k3 = defaultdict(int)
            other_model_qty_by_k3 = defaultdict(int)

            for it in getattr(other, 'prepared_items', []) or []:
                if not isinstance(it, str):
                    continue

                # [MODEL]dept|brand|model|qty|desc?
                if it.startswith('[MODEL]'):
                    parts = it[7:].split('|')
                    if len(parts) >= 4:
                        dept = parts[0]; brand = parts[1]; model = parts[2]
                        try:
                            qty = int(parts[3])
                        except Exception:
                            qty = 0
                        other_model_qty_by_k3[(dept, brand, model)] += qty
                    continue

                # specific asset id
                if it.startswith('[LOAN]') or it.startswith('[MISC]'):
                    # ignore custom lines here
                    continue

                # count only if not returned
                if it in returned_other:
                    continue
                a = data_manager.inventory.get(it)
                if not a or getattr(a, 'is_missing', False) or getattr(a, 'is_ooc', False):
                    continue
                k3 = (a.department_code, a.brand, a.model_number)
                other_specific_by_k3[k3] += 1

            # accumulate totals
            for k3 in set(other_model_qty_by_k3.keys()) | set(other_specific_by_k3.keys()):
                ev_specific = other_specific_by_k3.get(k3, 0)
                ev_models   = other_model_qty_by_k3.get(k3, 0)
                ev_demand   = max(ev_models, ev_specific)
                total_specific_by_k3[k3] += ev_specific
                total_event_demand_by_k3[k3] += ev_demand

        # --- Build a set of "busy" asset IDs we must exclude from availability ---
        busy_assets = set()

        # 1) Add specifically assigned assets from overlapping events (not returned)
        for other in data_manager.events.values():
            if not other or other.event_id == event_id:
                continue
            if not _ranges_overlap(my_start, my_end, getattr(other, 'start_date', ''), getattr(other, 'end_date', '')):
                continue
            returned_other = set(getattr(other, 'returned_items', []) or [])
            for it in getattr(other, 'prepared_items', []) or []:
                if not isinstance(it, str):
                    continue
                if it.startswith('[MODEL]') or it.startswith('[LOAN]') or it.startswith('[MISC]'):
                    continue
                if it in returned_other:
                    continue
                # it's a specific asset id
                busy_assets.add(it)

        # 2) For the remaining "pure model qty" demand, reserve additional assets by k3
        #    extra_needed_by_k3 = total_event_demand_by_k3 - total_specific_by_k3
        extra_needed_by_k3 = {
            k3: max(total_event_demand_by_k3.get(k3, 0) - total_specific_by_k3.get(k3, 0), 0)
            for k3 in set(total_event_demand_by_k3.keys()) | set(total_specific_by_k3.keys())
        }

        # Also remove assets this *current* event already has assigned (so we don't offer them again)
        current_assigned = set()
        for it in getattr(event, 'prepared_items', []) or []:
            if isinstance(it, str) and not it.startswith('[MODEL]') and not it.startswith('[LOAN]') and not it.startswith('[MISC]'):
                current_assigned.add(it)

        # For each k3, grab extra_needed assets from free pool and mark as busy
        for k3, need in extra_needed_by_k3.items():
            if need <= 0:
                continue
            # candidate pool = all assets of this k3 minus already busy minus already in this event
            pool = [aid for aid in assets_by_k3.get(k3, [])
                    if aid not in busy_assets and aid not in current_assigned]
            # pick any 'need' assets (stable order by id)
            pool.sort()
            for aid in pool[:need]:
                busy_assets.add(aid)

        # --- Now compute the final list of assets that are free for this event ---
        # Base pool = all physical assets minus busy assets minus those already in this event
        final_ids = [aid for aid in asset_info.keys()
                     if aid not in busy_assets and aid not in current_assigned]

        # Optionally, if you previously excluded anything else in /api/assets/available (like maintenance), do it here too.

        # Shape into the same structure the frontend expects
        final_list = [asset_info[aid] for aid in sorted(final_ids)]
        return jsonify({'success': True, 'data': final_list})
    except Exception as e:
        logger.error(f"Error computing available-for-event({event_id}): {e}")
        return jsonify({'error': 'Failed to compute event-aware availability'}), 500
    
def require_admin(f):
    """Decorator to require admin privileges"""
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if 'user' not in session:
            return jsonify({'error': 'Not authenticated'}), 401
        if not session.get('is_admin', False):
            return jsonify({'error': 'Admin privileges required'}), 403
        return f(*args, **kwargs)
    return decorated_function


def log_action(action):
    """Helper function to log actions"""
    try:
        log_entry = LogEntry(
            timestamp=datetime.now().strftime("%Y/%m/%d %H:%M:%S"),
            user=session.get('user', 'system'),
            action=action
        )
        data_manager.logs.append(log_entry)
        data_manager.save_logs()
        logger.info(f"Action logged: {action}")
    except Exception as e:
        logger.error(f"Failed to log action: {e}")

def log_asset_change(event_id, asset_id, action, details=""):
    """Log all asset changes for debugging"""
    timestamp = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    log_message = f"[ASSET_CHANGE] {timestamp} - Event {event_id}: {action} asset {asset_id} {details}"
    logger.warning(log_message)
    print(log_message)

def validate_event_data(data):
    """Validate event data"""
    errors = []

    if not data.get('name', '').strip():
        errors.append('Event name is required')

    if len(data.get('name', '')) > 100:
        errors.append('Event name must be less than 100 characters')

    try:
        start_date = datetime.strptime(data['startDate'], '%Y-%m-%d')
        end_date = datetime.strptime(data['endDate'], '%Y-%m-%d')
        if end_date < start_date:
            errors.append('End date must be after start date')
    except (KeyError, ValueError):
        errors.append('Invalid date format')

    return errors

def get_assigned_assets():
    """Get all assets currently assigned to events (with caching)"""
    global _cache

    try:
        # Add validation checks
        if data_manager is None:
            logger.error("get_assigned_assets: data_manager is None")
            return set()
            
        if not hasattr(data_manager, 'events') or data_manager.events is None:
            logger.error("get_assigned_assets: data_manager.events is None")
            return set()

        # Cache for 30 seconds
        now = datetime.now().timestamp()
        if (_cache['assigned_assets'] is not None and
            _cache['cache_timestamp'] is not None and
                now - _cache['cache_timestamp'] < 30):
            logger.debug("get_assigned_assets: returning cached result")
            return _cache['assigned_assets']

        logger.debug(f"get_assigned_assets: processing {len(data_manager.events)} events")
        
        assigned_assets = set()
        for event in data_manager.events.values():
            try:
                # Ensure event has prepared_items attribute
                if not hasattr(event, 'prepared_items'):
                    logger.warning(f"Event {getattr(event, 'event_id', 'unknown')} missing prepared_items")
                    continue
                    
                # Ensure event has returned_items attribute
                if not hasattr(event, 'returned_items'):
                    event.returned_items = []
                    
                for asset_id in event.prepared_items:
                    if (asset_id not in event.returned_items and
                            not (asset_id.startswith('[LOAN]') or asset_id.startswith('[MISC]'))):
                        assigned_assets.add(asset_id)
                        
            except Exception as e:
                logger.error(f"Error processing event {getattr(event, 'event_id', 'unknown')}: {e}")
                continue

        logger.debug(f"get_assigned_assets: found {len(assigned_assets)} assigned assets")
        
        _cache['assigned_assets'] = assigned_assets
        _cache['cache_timestamp'] = now
        return assigned_assets
        
    except Exception as e:
        logger.error(f"Error in get_assigned_assets: {e}")
        import traceback
        logger.error(f"get_assigned_assets traceback: {traceback.format_exc()}")
        return set()  # Return empty set on error

def update_event_state(event):
    """Update the state of an event based on its prepared and returned items"""
    try:
        # Check if state is manually forced - if so, don't auto-update
        if getattr(event, 'force_state_override', False):
            logger.debug(f"Event {event.event_id} has forced state override, skipping automatic update")
            return
            
        # Get current date for overdue checks
        current_date = datetime.now().strftime('%Y%m%d')
        
        # Initialize actually_prepared if it doesn't exist
        if not hasattr(event, 'actually_prepared'):
            event.actually_prepared = []
        
        # Check if this event has model assignments
        has_model_assignments = any(item.startswith('[MODEL]') for item in event.prepared_items)
        
        if has_model_assignments:
            # Use model-based logic only for events with model assignments
            total_model_requirements = 0
            total_specific_assignments = 0
            total_returned = 0
            
            # Process model assignments
            for item_id in event.prepared_items:
                if item_id.startswith('[MODEL]'):
                    try:
                        # Parse: [MODEL]DEPT|BRAND|MODEL|QUANTITY|DESCRIPTION
                        parts = item_id[7:].split('|')
                        if len(parts) >= 4:
                            dept = parts[0]
                            brand = parts[1]
                            model = parts[2]
                            required_quantity = int(parts[3])
                      
                            total_model_requirements += required_quantity
                            
                            # Count specific assets assigned to this model
                            assigned_to_this_model = 0
                            returned_for_this_model = 0
                            
                            # Get all assets that were ever assigned to this model
                            all_assigned_assets = set(event.actually_prepared + event.returned_items)
                            
                            for specific_asset_id in all_assigned_assets:
                                specific_asset = data_manager.inventory.get(specific_asset_id)
                                if (specific_asset and 
                                    specific_asset.brand == brand and 
                                    specific_asset.model_number == model and
                                    specific_asset.department_code == dept):
                                    
                                    assigned_to_this_model += 1
                                    if specific_asset_id in event.returned_items:
                                        returned_for_this_model += 1
                            
                            total_specific_assignments += assigned_to_this_model
                            total_returned += returned_for_this_model
                            
                    except Exception as e:
                        logger.error(f"Error parsing model assignment {item_id}: {e}")
                        continue
            
            # Apply model-based state logic WITH PROPER PRECEDENCE
            logger.debug(f"Event {event.event_id}: requirements={total_model_requirements}, assigned={total_specific_assignments}, returned={total_returned}")
            
            # 1. CHECK FOR AUTO-CLOSE FIRST - all required assets returned
            if (total_model_requirements > 0 and 
                total_specific_assignments >= total_model_requirements and 
                total_returned == total_specific_assignments):
                event.state = 'Closed'
                #logger.info(f"Event {event.event_id} set to Closed: all assets returned")
            # 2. CHECK FOR OVERDUE - event ended but still has unreturned assets
            elif (total_specific_assignments > total_returned and 
                  current_date > event.end_date):
                event.state = 'Overdue'
                #logger.info(f"Event {event.event_id} set to Overdue: past end date with unreturned assets")
            # 3. No requirements set yet
            elif total_model_requirements == 0:
                event.state = 'Added'
            # 4. Requirements set but no assets assigned
            elif total_specific_assignments == 0:
                event.state = 'Planning'
            # 5. Some assets assigned but not enough, no returns yet
            elif total_specific_assignments < total_model_requirements and total_returned == 0:
                event.state = 'Preparing'
            # 6. All requirements met, no returns yet
            elif total_specific_assignments >= total_model_requirements and total_returned == 0:
                # Check if ready event is within its date range to make it ongoing
                if event.start_date <= current_date <= event.end_date:
                    event.state = 'Ongoing'
                else:
                    event.state = 'Ready'
            # 7. Some assets returned but not all
            elif total_returned > 0 and total_returned < total_specific_assignments:
                event.state = 'Returning'
            # 8. Fallback - shouldn't reach here with proper logic above
            else:
                logger.warning(f"Event {event.event_id} fell through to fallback case - keeping current state {event.state}")
                # Don't change state if we can't determine what it should be
        else:
            # Use logic for events without model assignments (includes custom assets like LOAN/MISC)
            total_prepared_items = len([item for item in event.prepared_items if not item.startswith('[MODEL]')])
            total_actually_prepared = len(event.actually_prepared)
            total_returned = len(event.returned_items)
            
            logger.info(f"Event {event.event_id} state calculation - Prepared items: {total_prepared_items}, Actually prepared: {total_actually_prepared}, Returned: {total_returned}")
            
            # For custom assets, check if all items in actually_prepared are also in returned_items
            all_actually_prepared_returned = True
            if total_actually_prepared > 0:
                for item in event.actually_prepared:
                    if item not in event.returned_items:
                        all_actually_prepared_returned = False
                        break
            else:
                all_actually_prepared_returned = False
            
            # 1. CHECK FOR AUTO-CLOSE FIRST - all actually prepared assets returned
            if (total_actually_prepared > 0 and all_actually_prepared_returned):
                event.state = 'Closed'
                #logger.info(f"Event {event.event_id} set to Closed: all actually prepared assets returned")
            # 2. CHECK FOR OVERDUE - event ended but still has unreturned assets (HIGH PRIORITY)
            elif (total_actually_prepared > total_returned and 
                  current_date > event.end_date):
                event.state = 'Overdue'
                # logger.info(f"Event {event.event_id} set to Overdue: past end date with unreturned assets")
            # 3. No assets assigned yet
            elif total_prepared_items == 0:
                event.state = 'Added'
            # 4. Assets assigned but none prepared yet
            elif total_prepared_items > 0 and total_actually_prepared == 0:
                event.state = 'Planning'
            # 5. Some assets prepared but not all
            elif total_actually_prepared > 0 and total_actually_prepared < total_prepared_items and total_returned == 0:
                event.state = 'Preparing'
            # 6. All assets prepared, none returned yet - check if event is active
            elif total_actually_prepared >= total_prepared_items and total_returned == 0:
                # Check if event is within its date range
                if event.start_date <= current_date <= event.end_date:
                    event.state = 'Ongoing'
                else:
                    event.state = 'Ready'
            # 7. Some assets returned but not all
            elif total_returned > 0 and not all_actually_prepared_returned:
                event.state = 'Returning'
            # 8. Fallback - keep current state if we can't determine what it should be
            else:
                logger.warning(f"Event {event.event_id} fell through to fallback case - keeping current state {event.state}")
                # Don't change state if we can't determine what it should be
                
    except Exception as e:
        logger.error(f"Error updating event state for event {event.event_id}: {e}")
        import traceback
        logger.error(f"Traceback: {traceback.format_exc()}")

def cleanup_extra_assets(event):
    """Clean up the extra_assets list - ONLY call this when explicitly needed, not on every view"""
    if not hasattr(event, 'extra_assets'):
        event.extra_assets = []
        return
    
    # SAFETY CHECK: Only run if explicitly called for maintenance
    logger.warning(f"CLEANUP: Manual cleanup requested for event {event.event_id}")
    logger.warning(f"CLEANUP: Before cleanup - Extra assets: {event.extra_assets}")
    logger.warning(f"CLEANUP: Before cleanup - Prepared items: {event.prepared_items}")
    
    # Don't auto-cleanup unless there are real issues
    if not event.extra_assets:
        return
    
    assets_to_remove = []
    
    for asset_id in event.extra_assets:
        # Check if this asset fulfills any model requirement
        fulfills_requirement = False
        
        for item in event.prepared_items:
            if item.startswith('[MODEL]'):
                try:
                    parts = item.split('|')
                    if len(parts) >= 4:
                        dept = parts[0][7:]  # Remove '[MODEL]' prefix
                        brand = parts[1]
                        model = parts[2]
                        
                        # Check if this specific asset matches this model requirement
                        asset = data_manager.inventory.get(asset_id)
                        if (asset and 
                            asset.brand == brand and 
                            asset.model_number == model and
                            asset.department_code == dept):
                            fulfills_requirement = True
                            logger.warning(f"CLEANUP: Asset {asset_id} fulfills {brand} {model} requirement")
                            break
                except Exception as e:
                    logger.error(f"CLEANUP: Error checking model requirement for {item}: {e}")
                    continue
        
        if fulfills_requirement:
            assets_to_remove.append(asset_id)
    
    # Remove assets that fulfill requirements
    for asset_id in assets_to_remove:
        event.extra_assets.remove(asset_id)
        logger.warning(f"CLEANUP: Removed {asset_id} from extra_assets (fulfills requirement)")
    
    logger.warning(f"CLEANUP: After cleanup - Extra assets: {event.extra_assets}")

def schedule_ongoing_check():
    """Run the ongoing event check in a background thread"""
    logger.info("Background thread started - checking events every 5 minutes")
    
    # Wait for data_manager to be initialized
    while data_manager is None:
        logger.info("Background thread: Waiting for data_manager to be initialized...")
        time.sleep(5)
    
    logger.info("Background thread: data_manager is ready, starting checks")
    
    while True:
        try:
            if data_manager is not None and hasattr(data_manager, 'events'):
                logger.info("Background thread: Starting scheduled event state check")
                check_and_update_ongoing_events()
                logger.info("Background thread: Completed scheduled event state check")
            else:
                logger.warning("Background thread: data_manager.events not available, skipping check")
            
            time.sleep(300)  # Check every 5 minutes for testing (change to 3600 for production)
        except Exception as e:
            logger.error(f"Background thread error: {e}")
            import traceback
            logger.error(f"Background thread traceback: {traceback.format_exc()}")
            time.sleep(300)  # Continue running even if there's an error

def start_background_thread():
    """Start the background thread for event checking"""
    try:
        ongoing_thread = threading.Thread(target=schedule_ongoing_check, daemon=True)
        ongoing_thread.start()
        logger.info("Background thread for event checking started successfully")
        return True
    except Exception as e:
        logger.error(f"Failed to start background thread: {e}")
        return False

def init_data_manager():
    """Initialize the data manager with the configured data folder"""
    global data_manager

    try:
        # Try to read data folder from config file
        if os.path.exists('data_folder.txt'):
            with open('data_folder.txt', 'r') as f:
                data_folder = f.read().strip()
        else:
            # Default data folder
            data_folder = './data'
            if not os.path.exists(data_folder):
                os.makedirs(data_folder)
            with open('data_folder.txt', 'w') as f:
                f.write(data_folder)

        data_manager = DataManager(data_folder)
        data_manager.setup_data_folder()
        data_manager.check_and_initialize_files()
        data_manager.load_all_data()
        logger.info(f"Data manager initialized with folder: {data_folder}")
        
        # Start the background thread AFTER data_manager is initialized
        background_started = start_background_thread()
        if not background_started:
            logger.warning("Background thread failed to start - automatic event updates disabled")
        else:
            logger.info("Background thread started successfully after data_manager initialization")
            
    except Exception as e:
        logger.error(f"Failed to initialize data manager: {e}")
        raise

    def _client_to_dict(c):
        return {
            'name': c.name, 'company': c.company,
            'address1': c.address1, 'address2': c.address2, 'address3': c.address3,
            'postalCode': c.postal_code, 'phone': c.phone
        }

# Routes

@app.route('/')
@require_auth
def index():
    """Serve the main web interface"""
    return render_template('index.html')


@app.route('/login', methods=['GET', 'POST'])
def login():
    """Handle user authentication"""
    if request.method == 'GET':
        return render_template('login.html')

    try:
        data = request.get_json()
        username = data.get('username', '').strip()
        password = data.get('password', '')

        if not username or not password:
            return jsonify({'success': False, 'message': 'Username and password required'}), 400

        if username in data_manager.users:
            user = data_manager.users[username]
            hashed_input = hash_password(password, user.salt)
            if hashed_input == user.password_hash:
                session['user'] = username
                session['is_admin'] = user.is_admin

                log_action(f"User {username} logged in via web interface")
                return jsonify({'success': True, 'message': 'Login successful'})

        # Log failed attempt
        log_action(f"Failed login attempt for username: {username}")
        return jsonify({'success': False, 'message': 'Invalid credentials'}), 401

    except Exception as e:
        logger.error(f"Login error: {e}")
        return jsonify({'success': False, 'message': 'Login failed'}), 500


@app.route('/logout')
def logout():
    """Handle user logout"""
    if 'user' in session:
        username = session['user']
        log_action(f"User {username} logged out from web interface")
        session.clear()

    return redirect(url_for('login'))

# API Routes


@app.route('/api/events', methods=['GET'])
@require_auth
def get_events():
    """Get all events"""
    try:
        events_data = []
        for event in data_manager.events.values():
            # Initialize actually_prepared if missing
            if not hasattr(event, 'actually_prepared'):
                event.actually_prepared = []

            # Build model groups for this event
            model_groups = {}
            has_model_assignments = False
            
            for asset_id in event.prepared_items:
                if asset_id.startswith('[MODEL]'):
                    has_model_assignments = True
                    try:
                        parts = asset_id[7:].split('|')
                        if len(parts) >= 4:
                            dept = parts[0]
                            brand = parts[1]
                            model = parts[2]
                            quantity = int(parts[3])
                            description = parts[4] if len(parts) > 4 else ''
                            
                            model_key = f"{dept}|{brand}|{model}|{description}"
                            
                            if model_key not in model_groups:
                                model_groups[model_key] = {
                                    'department': dept,
                                    'brand': brand,
                                    'model': model,
                                    'description': description,
                                    'requiredQuantity': quantity,
                                    'assignedAssets': [],
                                    'status': 'pending'
                                }
                            
                            # Find assigned specific assets for this model
                            for specific_asset_id in event.actually_prepared:
                                specific_asset = data_manager.inventory.get(specific_asset_id)
                                if (specific_asset and 
                                    specific_asset.brand == brand and 
                                    specific_asset.model_number == model and
                                    specific_asset.department_code == dept):
                                    
                                    asset_status = 'returned' if specific_asset_id in event.returned_items else 'prepared'
                                    
                                    model_groups[model_key]['assignedAssets'].append({
                                        'id': specific_asset_id,
                                        'serial': specific_asset.serial_number,
                                        'status': asset_status,
                                        'location': specific_asset.current_location
                                    })
                            
                            # Determine overall model status - FIXED LOGIC
                            assigned_count = len(model_groups[model_key]['assignedAssets'])
                            returned_count = len([a for a in model_groups[model_key]['assignedAssets'] if a['status'] == 'returned'])
                            
                            if returned_count == assigned_count and returned_count == quantity:
                                model_groups[model_key]['status'] = 'returned'
                            elif assigned_count >= quantity:
                                model_groups[model_key]['status'] = 'ready'
                            elif assigned_count > 0:
                                model_groups[model_key]['status'] = 'partial'
                            else:
                                model_groups[model_key]['status'] = 'pending'
                                
                    except Exception as e:
                        logger.error(f"Error parsing model assignment {asset_id}: {e}")
                        continue

            # Calculate totals - ONLY use model-based logic for events with model assignments
            if has_model_assignments:
                total_required = 0
                total_prepared = 0
                total_returned = 0
                
                # Count from model groups for accurate totals
                for model_group in model_groups.values():
                    total_required += model_group['requiredQuantity']
                    total_prepared += len(model_group['assignedAssets'])
                    total_returned += len([a for a in model_group['assignedAssets'] if a['status'] == 'returned'])
            else:
                # Use old logic for events without model assignments
                total_required = len(event.prepared_items)
                total_prepared = len(event.actually_prepared)
                total_returned = len(event.returned_items)

            events_data.append({
                'id': event.event_id,
                'name': event.name,
                'startDate': format_date_output(event.start_date),
                'endDate': format_date_output(event.end_date),
                'state': event.state,  # Keep original state, don't force update
                'tag': getattr(event, 'tag', 'events'), 
                'assetCount': total_required,
                'preparedCount': total_prepared,
                'returnedCount': total_returned,
                'assetModels': event.asset_models,
                'preparedItems': event.prepared_items,
                'returnedItems': event.returned_items,
                'modelGroups': model_groups,
                'hasModelAssignments': has_model_assignments,  # Flag to know which logic to use
                'forceStateOverride': getattr(event, 'force_state_override', False)
            })

        # Sort by event ID descending
        events_data.sort(key=lambda x: x['id'], reverse=True)

        return jsonify({'success': True, 'data': events_data})
    except Exception as e:
        logger.error(f"Error getting events: {e}")
        return jsonify({'error': 'Failed to retrieve events'}), 500

@app.route('/api/events/<int:event_id>', methods=['GET'])
@require_auth
def get_event(event_id):
    """Get a specific event with detailed asset information"""
    try:
        event = data_manager.events.get(event_id)
        if not event:
            return jsonify({'error': 'Event not found'}), 404

        # Initialize lists if they don't exist
        if not hasattr(event, 'actually_prepared'):
            event.actually_prepared = []
        if not hasattr(event, 'extra_assets'):
            event.extra_assets = []

        # Get detailed asset information grouped by department
        assets_by_department = defaultdict(list)
        assigned_assets = []
        prepared_assets = []
        returned_assets = []

        # Process ALL items in prepared_items (including model assignments)
        for asset_id in event.prepared_items:
            asset_info = None

            if asset_id.startswith('[LOAN]') or asset_id.startswith('[MISC]'):
                # Handle loan/misc items
                dept = 'LOAN' if asset_id.startswith('[LOAN]') else 'MISC'
                name = asset_id.replace(f'[{dept}]', '').strip()
                if ';' in name:
                    name, quantity = name.split(';', 1)
                    name = f"{name} (Qty: {quantity})"

                # Determine status for loan/misc items
                if asset_id in event.returned_items:
                    status = 'returned'
                elif asset_id in event.actually_prepared:
                    status = 'prepared'
                else:
                    status = 'assigned'

                asset_info = {
                    'id': asset_id,
                    'name': name,
                    'status': status,
                    'isLoanOrMisc': True,
                    'isExtra': asset_id in event.extra_assets
                }
            elif asset_id.startswith('[MODEL]'):
                    continue
            else:
                # Handle regular assets
                asset = data_manager.inventory.get(asset_id)
                if asset:
                    dept = asset.department_code

                    # Determine status
                    if asset_id in event.returned_items:
                        status = 'returned'
                    elif asset_id in event.actually_prepared:
                        status = 'prepared'
                    else:
                        status = 'assigned'

                    # Check if this is an extra asset
                    is_extra = asset_id in event.extra_assets
                    
                    # However, if this asset fulfills a model requirement, it should NOT be extra
                    # regardless of what's in the extra_assets list
                    if is_extra:
                        for model_assignment in event.prepared_items:
                            if model_assignment.startswith('[MODEL]'):
                                try:
                                    parts = model_assignment[7:].split('|')
                                    if len(parts) >= 4:
                                        req_dept = parts[0]
                                        req_brand = parts[1]
                                        req_model = parts[2]
                                        req_description = parts[4] if len(parts) > 4 else ''
                                        
                                        if (asset.department_code == req_dept and 
                                            asset.brand == req_brand and 
                                            asset.model_number == req_model and
                                            asset.description == req_description):
                                            is_extra = False
                                            # Also clean up the extra_assets list
                                            if asset_id in event.extra_assets:
                                                event.extra_assets.remove(asset_id)
                                            break
                                except Exception as e:
                                    logger.error(f"Error checking model fulfillment: {e}")
                                    continue

                    asset_info = {
                        'id': asset.asset_id,
                        'name': f"{asset.brand} {asset.model_number} - {asset.description}",
                        'brand': asset.brand,
                        'model': asset.model_number,
                        'description': asset.description,
                        'serial': asset.serial_number,
                        'status': status,
                        'location': asset.current_location,
                        'isMissing': asset.is_missing,
                        'isOOC': asset.is_ooc,
                        'isLoanOrMisc': False,
                        'isExtra': is_extra
                    }

            if asset_info:
                assets_by_department[dept].append(asset_info)

                # Categorize assets
                if asset_info['status'] == 'returned':
                    returned_assets.append(asset_info)
                elif asset_info['status'] == 'prepared':
                    prepared_assets.append(asset_info)
                else:
                    assigned_assets.append(asset_info)

        # Also process any assets that are in actually_prepared but not in prepared_items
        for asset_id in event.actually_prepared:
            # Check if this asset was already processed above
            already_processed = False
            for dept_assets in assets_by_department.values():
                if any(existing_asset['id'] == asset_id for existing_asset in dept_assets):
                    already_processed = True
                    break

            if not already_processed:
                # This is an asset in actually_prepared but not in prepared_items (truly extra)
                asset = data_manager.inventory.get(asset_id)
                if asset:
                    dept = asset.department_code

                    # Determine status
                    if asset_id in event.returned_items:
                        status = 'returned'
                    else:
                        status = 'prepared'

                    asset_info = {
                        'id': asset.asset_id,
                        'name': f"{asset.brand} {asset.model_number} - {asset.description}",
                        'brand': asset.brand,
                        'model': asset.model_number,
                        'description': asset.description,
                        'serial': asset.serial_number,
                        'status': status,
                        'location': asset.current_location,
                        'isMissing': asset.is_missing,
                        'isOOC': asset.is_ooc,
                        'isLoanOrMisc': False,
                        'isExtra': True  # Always extra if in actually_prepared but not prepared_items
                    }

                    assets_by_department[dept].append(asset_info)

                    # Categorize assets
                    if asset_info['status'] == 'returned':
                        returned_assets.append(asset_info)
                    else:
                        prepared_assets.append(asset_info)

        # Sort departments and assets within each department
        sorted_departments = {}
        for dept in sorted(assets_by_department.keys()):
            sorted_departments[dept] = sorted(
                assets_by_department[dept], key=lambda x: x['id'])

        # Group assets by model for cleaner display
        model_groups = {}
        for asset_id in event.prepared_items:
            if asset_id.startswith('[MODEL]'):
                # Parse model assignment
                try:
                    parts = asset_id[7:].split('|')
                    if len(parts) >= 4:
                        dept = parts[0]
                        brand = parts[1]
                        model = parts[2]
                        quantity = int(parts[3])
                        description = parts[4] if len(parts) > 4 else ''

                        model_key = f"{dept}|{brand}|{model}|{description}"

                        if model_key not in model_groups:
                            model_groups[model_key] = {
                                'department': dept,
                                'brand': brand,
                                'model': model,
                                'description': description,
                                'requiredQuantity': quantity,
                                'assignedAssets': [],
                                'status': 'pending'
                            }

                        # Find assigned specific assets for this model
                        # Check both actually_prepared and all inventory assets
                        all_potential_assets = set()
                        if hasattr(event, 'actually_prepared'):
                            all_potential_assets.update(event.actually_prepared)
                        
                        # Also check returned items as they might have been assigned to this model
                        all_potential_assets.update(event.returned_items)
                        
                        logger.info(f"Checking assets for model {brand} {model}: {all_potential_assets}")
                        
                        for specific_asset_id in all_potential_assets:
                            specific_asset = data_manager.inventory.get(specific_asset_id)
                            
                            if specific_asset:
                                logger.info(f"Asset {specific_asset_id}: brand={specific_asset.brand}, model={specific_asset.model_number}, dept={specific_asset.department_code}")
                                logger.info(f"Looking for: brand={brand}, model={model}, dept={dept}")
                                
                                if (specific_asset.brand == brand and
                                    specific_asset.model_number == model and
                                    specific_asset.department_code == dept):

                                    # Check if this asset is returned
                                    asset_status = 'returned' if specific_asset_id in event.returned_items else 'prepared'
                                    logger.info(f"Asset {specific_asset_id} matches model and has status: {asset_status}")

                                    model_groups[model_key]['assignedAssets'].append({
                                        'id': specific_asset_id,
                                        'serial': specific_asset.serial_number,
                                        'status': asset_status,
                                        'location': specific_asset.current_location
                                    })

                        # Determine overall model status - FIXED LOGIC
                        assigned_count = len(model_groups[model_key]['assignedAssets'])
                        returned_count = len([a for a in model_groups[model_key]['assignedAssets'] if a['status'] == 'returned'])
                        prepared_count = assigned_count - returned_count

                        logger.info(f"Model {brand} {model}: assigned={assigned_count}, returned={returned_count}, prepared={prepared_count}, required={quantity}")

                        if returned_count == assigned_count and assigned_count > 0:
                            model_groups[model_key]['status'] = 'returned'
                        elif prepared_count >= quantity:
                            model_groups[model_key]['status'] = 'ready'
                        elif prepared_count > 0:
                            model_groups[model_key]['status'] = 'partial'
                        else:
                            model_groups[model_key]['status'] = 'pending'

                        logger.info(f"Model {brand} {model} final status: {model_groups[model_key]['status']}")

                except Exception as e:
                    logger.error(f"Error parsing model assignment {asset_id}: {e}")

        # Calculate totals based on model requirements vs specific assignments
        has_model_assignments = len(model_groups) > 0
        
        if has_model_assignments:
            total_required = 0
            total_prepared = 0
            total_returned = 0
            
            # Count from model groups for accurate totals
            for model_group in model_groups.values():
                total_required += model_group['requiredQuantity']
                # Count only non-returned assigned assets as prepared
                prepared_assets_count = len([a for a in model_group['assignedAssets'] if a['status'] != 'returned'])
                returned_assets_count = len([a for a in model_group['assignedAssets'] if a['status'] == 'returned'])
                total_prepared += prepared_assets_count
                total_returned += returned_assets_count
        else:
            # Use old logic for events without model assignments
            # Count all items in prepared_items except [MODEL] items (includes [LOAN] and [MISC])
            total_required = len([item for item in event.prepared_items if not item.startswith('[MODEL]')])
            total_prepared = len([item for item in event.actually_prepared if item not in event.returned_items])
            total_returned = len(event.returned_items)

        logger.info(f"Event {event_id} final asset counts - Required: {total_required}, Prepared: {total_prepared}, Returned: {total_returned}, Extra assets in list: {len(event.extra_assets)}")
            
        event_data = {
            'id': event.event_id,
            'name': event.name,
            'startDate': format_date_output(event.start_date),
            'endDate': format_date_output(event.end_date),    
            'state': event.state,
            'tag': getattr(event, 'tag', 'events'), 
            'assetModels': event.asset_models,
            'preparedItems': event.prepared_items,
            'actuallyPrepared': event.actually_prepared,
            'returnedItems': event.returned_items,
            'extraAssets': event.extra_assets,
            'assetsByDepartment': sorted_departments,
            'assignedAssets': assigned_assets,
            'preparedAssets': prepared_assets,
            'returnedAssets': returned_assets,
            'totalAssets': total_required,
            'totalPrepared': total_prepared,
            'totalReturned': total_returned,
            'modelGroups': model_groups,
            'forceStateOverride': getattr(event, 'force_state_override', False)
        }

        return jsonify({'success': True, 'data': event_data})

    except Exception as e:
        logger.error(f"Error getting event {event_id}: {e}")
        return jsonify({'error': 'Failed to retrieve event'}), 500

@app.route('/api/events/<int:event_id>/availability', methods=['GET'])
@require_auth
def get_event_model_availability(event_id):
    """
    For a given event, compute availability per (dept, brand, model), ignoring description for overlap math:
      global_physical(∑ across desc)
      - used_here_models(∑ across desc for THIS event)
      - overlapping_demand(∑ across desc for OTHER overlapping events,
                           taken as max(models_qty_sum, specific_assets_count))
    For display per description row, we clamp to the per-description physical with:
      available_for_desc = max(0, min(global_adjusted, physical_for_desc))

    We DO NOT block adding when available < 1; UI just shows the number in red.
    """
    try:
        event = data_manager.events.get(event_id)
        if not event:
            return jsonify({'error': 'Event not found'}), 404

        from collections import defaultdict

        # ---------- 1) PHYSICAL ----------
        # per-desc: key4 = (dept, brand, model, desc)
        # desc-agnostic: key3 = (dept, brand, model)
        physical_by4 = defaultdict(int)
        physical_by3 = defaultdict(int)

        for asset in data_manager.inventory.values():
            if not asset:
                continue
            if getattr(asset, 'is_missing', False) or getattr(asset, 'is_ooc', False):
                continue
            k4 = (asset.department_code, asset.brand, asset.model_number, asset.description or '')
            k3 = (asset.department_code, asset.brand, asset.model_number)
            physical_by4[k4] += 1
            physical_by3[k3] += 1

        # ---------- 2) USED IN THIS EVENT (MODEL LINES), desc-agnostic ----------
        used_here_by3 = defaultdict(int)
        for it in getattr(event, 'prepared_items', []) or []:
            if isinstance(it, str) and it.startswith('[MODEL]'):
                parts = it[7:].split('|')  # dept|brand|model|qty|desc?
                if len(parts) >= 4:
                    dept = parts[0]; brand = parts[1]; model = parts[2]
                    try:
                        qty = int(parts[3])
                    except Exception:
                        qty = 0
                    used_here_by3[(dept, brand, model)] += qty

        # ---------- 3) OVERLAPPING DEMAND (OTHER EVENTS), desc-agnostic ----------
        overlap_by3 = defaultdict(int)
        my_s, my_e = getattr(event, 'start_date', ''), getattr(event, 'end_date', '')

        for other in data_manager.events.values():
            if not other or other.event_id == event_id:
                continue
            if not _ranges_overlap(my_s, my_e, getattr(other, 'start_date', ''), getattr(other, 'end_date', '')):
                continue

            # Sum MODEL qty across descriptions
            other_models_by3 = defaultdict(int)
            # Count specific assets (not returned)
            other_specific_by3 = defaultdict(int)
            returned_other = set(getattr(other, 'returned_items', []) or [])

            for it in getattr(other, 'prepared_items', []) or []:
                if isinstance(it, str) and it.startswith('[MODEL]'):
                    p = it[7:].split('|')  # dept|brand|model|qty|desc?
                    if len(p) >= 4:
                        k3 = (p[0], p[1], p[2])
                        try:
                            other_models_by3[k3] += int(p[3])
                        except Exception:
                            pass
                    continue

                # Specific asset IDs (exclude virtual markers)
                if isinstance(it, str) and not (it.startswith('[MODEL]') or it.startswith('[LOAN]') or it.startswith('[MISC]')):
                    if it in returned_other:
                        continue
                    a = data_manager.inventory.get(it)
                    if not a or getattr(a, 'is_missing', False) or getattr(a, 'is_ooc', False):
                        continue
                    k3 = (a.department_code, a.brand, a.model_number)
                    other_specific_by3[k3] += 1

            # For each key3 present, overlap demand += max(models_sum, specific_count)
            for k3 in set(other_models_by3.keys()) | set(other_specific_by3.keys()):
                overlap_by3[k3] += max(other_models_by3.get(k3, 0), other_specific_by3.get(k3, 0))

        # ---------- 4) Build response per description row ----------
        result = []
        # Iterate every description variant we physically have; that’s what UI lists/searches
        for k4, physical_desc in physical_by4.items():
            dept, brand, model, desc = k4
            k3 = (dept, brand, model)
            physical_global = physical_by3.get(k3, 0)
            used_here = used_here_by3.get(k3, 0)
            overlap = overlap_by3.get(k3, 0)

            global_adjusted = physical_global - used_here - overlap
            # show per-desc availability but never above that desc’s own physical
            available_for_desc = max(0, min(global_adjusted, physical_desc))

            result.append({
                'department': dept,
                'brand': brand,
                'model': model,
                'description': desc,
                'physical': physical_desc,             # physical for THIS description
                'physicalGlobal': physical_global,     # physical across all desc
                'usedInThisEvent': used_here,          # desc-agnostic
                'overlappingDemand': overlap,          # desc-agnostic
                'available': available_for_desc,       # final display value for THIS description
                'adjustedGlobal': max(global_adjusted, 0)
            })

        return jsonify({'success': True, 'data': result})
    except Exception as e:
        logger.error(f"Error computing model availability for event {event_id}: {e}")
        return jsonify({'error': 'Failed to compute availability'}), 500

@app.route('/api/events', methods=['POST'])
@require_auth
def create_event():
    """Create a new event"""
    try:
        data = request.get_json()

        # Validate input data
        errors = validate_event_data(data)
        if errors:
            return jsonify({'success': False, 'errors': errors}), 400

        # Generate new event ID
        event_id = max(data_manager.events.keys(), default=0) + 1

        # Convert dates to internal format
        start_date = datetime.strptime(
            data['startDate'], '%Y-%m-%d').strftime('%Y%m%d')
        end_date = datetime.strptime(
            data['endDate'], '%Y-%m-%d').strftime('%Y%m%d')

        # Create new event
        event = Event(
            event_id=event_id,
            name=data['name'].strip(),
            start_date=start_date,
            end_date=end_date,
            asset_models=[],
            prepared_items=[],
            state='Added',
            returned_items=[],
            tag=data.get('tag', 'event')
        )
        event.actually_prepared = []

        # Save event
        data_manager.events[event_id] = event
        data_manager.save_event(event)

        # Invalidate cache
        invalidate_cache()

        log_action(
            f"Created event {event_id}: {data['name']} via web interface")

        return jsonify({'success': True, 'message': 'Event created successfully', 'eventId': event_id})
    except Exception as e:
        logger.error(f"Error creating event: {e}")
        return jsonify({'error': 'Failed to create event'}), 500


@app.route('/api/events/<int:event_id>', methods=['PUT'])
@require_auth
def update_event(event_id):
    """Update an existing event"""
    try:
        event = data_manager.events.get(event_id)
        if not event:
            return jsonify({'error': 'Event not found'}), 404

        data = request.get_json()

        # Validate input data
        errors = validate_event_data(data)
        if errors:
            return jsonify({'success': False, 'errors': errors}), 400

        # Update event properties
        old_name = event.name
        if 'name' in data:
            event.name = data['name'].strip()
        if 'startDate' in data:
            event.start_date = datetime.strptime(
                data['startDate'], '%Y-%m-%d').strftime('%Y%m%d')
        if 'endDate' in data:
            event.end_date = datetime.strptime(
                data['endDate'], '%Y-%m-%d').strftime('%Y%m%d')
        if 'tag' in data:
            event.tag = data['tag']

        # Update asset locations if event name changed
        if old_name != event.name:
            for asset_id in event.prepared_items:
                if asset_id not in event.returned_items:
                    asset = data_manager.inventory.get(asset_id)
                    if asset and asset.current_location == old_name:
                        asset.current_location = event.name
            data_manager.save_inventory()

        # Save event
        data_manager.events[event_id] = event
        data_manager.save_event(event)

        # Invalidate cache
        invalidate_cache()

        log_action(f"Updated event {event_id}: {event.name} via web interface")

        return jsonify({'success': True, 'message': 'Event updated successfully'})
    except Exception as e:
        logger.error(f"Error updating event: {e}")
        return jsonify({'error': 'Failed to update event'}), 500

@app.route('/api/assets/<asset_id>/maintenance-log/<int:log_index>', methods=['DELETE'])
@require_auth
def delete_maintenance_log(asset_id, log_index):
    """Delete a specific maintenance log entry and recalculate asset status"""
    try:
        logger.info(f"Received maintenance log delete request for asset: '{asset_id}', log index: {log_index}")
        
        # URL decode the asset_id in case it has special characters
        from urllib.parse import unquote
        asset_id = unquote_plus(asset_id)
        
        asset = data_manager.inventory.get(asset_id)
        if not asset:
            return jsonify({'error': 'Asset not found'}), 404
        
        # Check if log index is valid
        if not asset.maintenance_logs or log_index < 0 or log_index >= len(asset.maintenance_logs):
            return jsonify({'error': 'Invalid log index'}), 400
        
        # Get the log entry that will be deleted for logging purposes
        deleted_log = asset.maintenance_logs[log_index]
        log_parts = deleted_log.split('\t')
        deleted_description = '\t'.join(log_parts[2:]) if len(log_parts) >= 3 else deleted_log
        
        # Remove the log entry
        asset.maintenance_logs.pop(log_index)
        
        # Recalculate asset status based on remaining logs
        recalculate_asset_status_from_logs(asset)
        
        # Save changes
        data_manager.save_inventory()
        
        # Log the action
        log_action(f"Deleted maintenance log for asset {asset_id}: '{deleted_description}' (deleted by {session['user']})")
        
        logger.info(f"Successfully deleted maintenance log for asset {asset_id}")
        return jsonify({'success': True, 'message': 'Maintenance log deleted successfully'})
        
    except Exception as e:
        logger.error(f"Error deleting maintenance log for asset {asset_id}: {e}")
        import traceback
        logger.error(f"Traceback: {traceback.format_exc()}")
        return jsonify({'error': f'Failed to delete maintenance log: {str(e)}'}), 500

def recalculate_asset_status_from_logs(asset):
    """Recalculate asset OOC, Missing status, and location based on maintenance logs"""
    try:
        # Reset status to defaults
        asset.is_ooc = False
        asset.is_missing = False
        
        # Reset location to default (Store), will be updated if logs contain location changes
        asset.current_location = ''  # Empty string represents "Store"
        
        # Sort logs by date to ensure chronological processing
        sorted_logs = []
        for i, log_entry in enumerate(asset.maintenance_logs):
            parts = log_entry.split('\t')
            if len(parts) >= 3:
                date_str = parts[0]
                # Convert date to comparable format for sorting
                try:
                    date_obj = datetime.strptime(date_str, "%Y/%m/%d")
                    sorted_logs.append((date_obj, i, log_entry))
                except ValueError:
                    # If date parsing fails, treat as very old date
                    logger.warning(f"Invalid date format in log: {date_str}")
                    sorted_logs.append((datetime.min, i, log_entry))
        
        # Sort by date (chronological order - oldest first for processing)
        sorted_logs.sort(key=lambda x: x[0])
        
        logger.info(f"Processing {len(sorted_logs)} logs for {asset.asset_id} in chronological order")
        
        # Process logs in chronological order to determine final status and location
        for date_obj, log_index, log_entry in sorted_logs:
            parts = log_entry.split('\t')
            if len(parts) >= 3:
                description = '\t'.join(parts[2:])
                date_str = parts[0]
                
                logger.info(f"Processing log {log_index} ({date_str}): {description[:50]}...")
                
                # Check for status changes in the log description
                if '[' in description and ']' in description:
                    # Extract status changes from brackets
                    import re
                    status_match = re.search(r'\[(.*?)\]', description)
                    if status_match:
                        status_info = status_match.group(1)
                        status_parts = [part.strip() for part in status_info.split(',')]
                        
                        for part in status_parts:
                            if part.startswith('Location:'):
                                new_location = part.replace('Location:', '').strip()
                                asset.current_location = new_location
                                logger.info(f"Updated location to: {new_location}")
                            elif part.startswith('Serial:'):
                                new_serial = part.replace('Serial:', '').strip()
                                asset.serial_number = new_serial
                                logger.info(f"Updated serial to: {new_serial}")
                            elif part == 'Marked OOC':
                                asset.is_ooc = True
                                logger.info("Marked asset as OOC")
                            elif part == 'Unmarked OOC':
                                asset.is_ooc = False
                                logger.info("Unmarked asset as OOC")
                            elif part == 'Marked Missing':
                                asset.is_missing = True
                                logger.info("Marked asset as Missing")
                            elif part == 'Unmarked Missing':
                                asset.is_missing = False
                                logger.info("Unmarked asset as Missing")
                        
        logger.info(f"Final status for {asset.asset_id}: OOC={asset.is_ooc}, Missing={asset.is_missing}, Location='{asset.current_location}'")
        
    except Exception as e:
        logger.error(f"Error recalculating asset status from logs for {asset.asset_id}: {e}")
        import traceback
        logger.error(f"Traceback: {traceback.format_exc()}")

@app.route('/api/events/<int:event_id>', methods=['DELETE'])
@require_admin
def delete_event(event_id):
    """Delete an event"""
    try:
        event = data_manager.events.get(event_id)
        if not event:
            return jsonify({'error': 'Event not found'}), 404

        event_name = event.name

        # Backup event file
        data_manager.backup_event_file(event_id)

        # Return all assets to their default locations
        assets_reset = []
        
        # Reset assets from prepared_items
        for asset_id in event.prepared_items.copy():
            if not (asset_id.startswith('[LOAN]') or asset_id.startswith('[MISC]') or asset_id.startswith('[MODEL]')):
                asset = data_manager.inventory.get(asset_id)
                if asset:
                    old_location = asset.current_location
                    asset.current_location = asset.default_location or ""
                    assets_reset.append(f"{asset_id} (from '{old_location}' to '{asset.current_location or 'Store'}')")
                    log_action(f"Reset location for asset {asset_id} due to deletion of Event {event_id}")

        # Reset assets from actually_prepared (in case there are any not in prepared_items)
        if hasattr(event, 'actually_prepared'):
            for asset_id in event.actually_prepared.copy():
                if not (asset_id.startswith('[LOAN]') or asset_id.startswith('[MISC]')):
                    asset = data_manager.inventory.get(asset_id)
                    if asset and asset_id not in event.prepared_items:
                        old_location = asset.current_location
                        asset.current_location = asset.default_location or ""
                        assets_reset.append(f"{asset_id} (from '{old_location}' to '{asset.current_location or 'Store'}')")
                        log_action(f"Reset location for asset {asset_id} due to deletion of Event {event_id}")

        # Save inventory changes
        data_manager.save_inventory()

        # Delete event
        del data_manager.events[event_id]
        data_manager.delete_event_file(event_id)

        # Delete related logs
        logs_deleted = 0
        logs_to_keep = []
        
        for log in data_manager.logs:
            # Check if this log is related to the deleted event
            if (f"event {event_id}" in log.action.lower() or 
                f"Event {event_id}" in log.action or
                f"to event {event_id}" in log.action.lower() or
                f"from event {event_id}" in log.action.lower()):
                logs_deleted += 1
            else:
                logs_to_keep.append(log)
        
        # Update the logs list
        data_manager.logs = logs_to_keep
        
        # Save the updated logs
        data_manager.save_logs()

        # Invalidate cache
        invalidate_cache()

        # Log the deletion with details of reset assets and deleted logs
        if assets_reset:
            log_action(f"Deleted event {event_id}: {event_name} via web interface. Reset {len(assets_reset)} asset locations: {', '.join(assets_reset[:5])}{'...' if len(assets_reset) > 5 else ''}. Removed {logs_deleted} related log entries.")
        else:
            log_action(f"Deleted event {event_id}: {event_name} via web interface. No asset locations to reset. Removed {logs_deleted} related log entries.")

        return jsonify({'success': True, 'message': 'Event deleted successfully', 'assetsReset': len(assets_reset)})
    except Exception as e:
        logger.error(f"Error deleting event {event_id}: {e}")
        return jsonify({'error': f'Failed to delete event: {str(e)}'}), 500

@app.route('/api/events/<int:event_id>/assets', methods=['POST'])
@require_auth
def add_asset_to_event(event_id):
    """Add an asset to an event (unprepared by default)"""
    try:
        event = data_manager.events.get(event_id)
        if not event:
            return jsonify({'error': 'Event not found'}), 404

        data = request.get_json()
        asset_id = data.get('assetId', '').strip()

        if not asset_id:
            return jsonify({'error': 'Asset ID is required'}), 400

        # Initialize actually_prepared if it doesn't exist
        if not hasattr(event, 'actually_prepared'):
            event.actually_prepared = []

        # Check if asset is already in this event
        if asset_id in event.prepared_items:
            return jsonify({'error': 'Asset is already assigned to this event'}), 400

        # For regular assets, perform additional checks
        if not (asset_id.startswith('[LOAN]') or asset_id.startswith('[MISC]')):
            asset = data_manager.inventory.get(asset_id)
            if not asset:
                return jsonify({'error': 'Asset not found'}), 404

            if asset.is_missing:
                return jsonify({'error': 'Cannot assign missing asset'}), 400

            if asset.is_ooc:
                return jsonify({'error': 'Cannot assign out-of-commission asset'}), 400

        # Add the asset as UNPREPARED (just assigned to event)
        event.prepared_items.append(asset_id)

        # Remove from returned items if it was there
        if asset_id in event.returned_items:
            event.returned_items.remove(asset_id)

        # Update event state
        update_event_state(event)

        # Save changes
        data_manager.save_event(event)

        # Invalidate cache
        invalidate_cache()

        log_action(
            f"Assigned asset {asset_id} to event {event_id} (unprepared)")

        return jsonify({'success': True, 'message': f'Asset {asset_id} assigned to event (unprepared)'})
    except Exception as e:
        logger.error(f"Error adding asset to event {event_id}: {e}")
        return jsonify({'error': 'Failed to add asset to event'}), 500


@app.route('/api/events/<int:event_id>/models', methods=['POST', 'DELETE'])
@require_auth
def manage_event_models(event_id):
    """Add or remove model assignments to/from events"""
    try:
        event = data_manager.events.get(event_id)
        if not event:
            return jsonify({'error': 'Event not found'}), 404

        data = request.get_json()

        # In the POST section of manage_event_models function, around line 620:

        if request.method == 'POST':
            # Add model assignment
            brand = data.get('brand', '').strip()
            model = data.get('model', '').strip()
            department = data.get('department', '').strip()
            provided_description = data.get('description', '').strip()
            quantity = int(data.get('quantity', 1))

            # --- server-side cap: total assigned for this brand/model/dept cannot exceed physical inventory ---
            # Count how many you physically own (ignore deployments), excluding Missing/OOC
            inv_count = sum(
                1 for a in data_manager.inventory.values()
                if (a.brand == brand and a.model_number == model and a.department_code == department
                    and not a.is_missing and not a.is_ooc)
            )

            # Current total of this brand/model/dept already requested in this event (across all descriptions)
            current_total = 0
            for item in event.prepared_items:
                if item.startswith('[MODEL]'):
                    parts = item[7:].split('|')
                    if len(parts) >= 4 and parts[0] == department and parts[1] == brand and parts[2] == model:
                        try:
                            current_total += int(parts[3])
                        except Exception:
                            pass

            requested_total = current_total + quantity
            if requested_total > inv_count:
                return jsonify({
                    'error': (
                        f"Quantity exceeds inventory: you have {inv_count} units of {brand} {model} "
                        f"in {department}. Already assigned here: {current_total}. Requested additional: {quantity}."
                    )
                }), 400


            logger.info(f"=== ADD MODEL REQUEST ===")
            logger.info(f"Brand: '{brand}', Model: '{model}', Dept: '{department}'")
            logger.info(f"Provided description: '{provided_description}'")
            logger.info(f"Raw data: {data}")  # Add this line to see what's being sent
            logger.info(f"Quantity: {quantity}")

            if not brand or not model or not department:
                return jsonify({'error': 'Brand, model, and department are required'}), 400

            # Get the FULL description from the actual asset, not from the request if none provided
            full_description = provided_description

            # Only try to get description from inventory if none was provided
            if not full_description:
                for asset in data_manager.inventory.values():
                    if (asset.brand == brand and 
                        asset.model_number == model and 
                        asset.department_code == department):
                        full_description = asset.description
                        logger.info(f"No description provided, using from asset {asset.asset_id}: '{full_description}'")
                        break

            logger.info(f"Final description for {brand} {model}: '{full_description}' (length: {len(full_description)})")
            
            # Log current prepared_items
            logger.info(f"Current prepared_items: {event.prepared_items}")

            # Check if this model already exists in the event (including description)
            existing_model_id = None
            existing_quantity = 0

            for item in event.prepared_items:
                logger.info(f"Checking item: '{item}'")
                if item.startswith('[MODEL]'):
                    parts = item[7:].split('|')
                    logger.info(f"Item parts: {parts}")
                    if len(parts) >= 5:  # dept|brand|model|qty|description
                        item_dept = parts[0]
                        item_brand = parts[1]
                        item_model = parts[2]
                        item_description = parts[4] if len(parts) > 4 else ''
                        
                        logger.info(f"Item details - Dept: '{item_dept}', Brand: '{item_brand}', Model: '{item_model}', Desc: '{item_description}'")
                        
                        # Match on department, brand, model, AND description
                        if (item_dept == department and 
                            item_brand == brand and 
                            item_model == model and
                            item_description == full_description):
                            existing_model_id = item
                            existing_quantity = int(parts[3])
                            logger.info(f"FOUND EXISTING MODEL: '{existing_model_id}' with quantity {existing_quantity}")
                            break
                        else:
                            logger.info(f"No match - descriptions differ: '{item_description}' vs '{full_description}'")

            if existing_model_id:
                logger.info(f"Updating existing model, removing: '{existing_model_id}'")
                event.prepared_items.remove(existing_model_id)
                new_quantity = existing_quantity + quantity
            else:
                logger.info("Creating new model assignment")
                new_quantity = quantity

            # Create consolidated model assignment identifier with FULL description
            model_id = f"[MODEL]{department}|{brand}|{model}|{new_quantity}|{full_description}"
            logger.info(f"Creating model assignment: '{model_id}'")
            event.prepared_items.append(model_id)
            
            logger.info(f"Updated prepared_items: {event.prepared_items}")

            # Initialize actually_prepared if it doesn't exist
            if not hasattr(event, 'actually_prepared'):
                event.actually_prepared = []

            # Update event state if needed
            update_event_state(event)

            # Save changes
            data_manager.save_event(event)

            # Invalidate cache
            invalidate_cache()

            log_action(
                f"Added {quantity}x {brand} {model} model to event {event_id} (total: {new_quantity})")

            return jsonify({'success': True, 'message': f'Added {quantity}x {brand} {model} to event (total: {new_quantity})'})

        elif request.method == 'DELETE':
            # Remove model assignment completely
            brand = data.get('brand', '').strip()
            model = data.get('model', '').strip()
            department = data.get('department', '').strip()

            if not brand or not model or not department:
                return jsonify({'error': 'Brand, model, and department are required'}), 400

            # Find and remove matching model assignments
            items_to_remove = []
            description_to_match = data.get('description', '').strip()

            # If no description provided, get it from inventory
            if not description_to_match:
                for asset in data_manager.inventory.values():
                    if (asset.brand == brand and 
                        asset.model_number == model and 
                        asset.department_code == department):
                        description_to_match = asset.description
                        break

            for item in event.prepared_items:
                if item.startswith('[MODEL]'):
                    parts = item[7:].split('|')
                    if len(parts) >= 5:
                        item_dept = parts[0]
                        item_brand = parts[1] 
                        item_model = parts[2]
                        item_description = parts[4] if len(parts) > 4 else ''
                        
                        # Match on department, brand, model, AND description
                        if (item_dept == department and 
                            item_brand == brand and 
                            item_model == model and
                            item_description == description_to_match):
                            items_to_remove.append(item)

            if not items_to_remove:
                return jsonify({'error': 'Model assignment not found'}), 404

            # Remove the items
            for item in items_to_remove:
                event.prepared_items.remove(item)
                if item in event.returned_items:
                    event.returned_items.remove(item)
                # Initialize actually_prepared if it doesn't exist
                if not hasattr(event, 'actually_prepared'):
                    event.actually_prepared = []
                if item in event.actually_prepared:
                    event.actually_prepared.remove(item)

            # Update event state
            update_event_state(event)

            # Save changes
            data_manager.save_event(event)

            # Invalidate cache
            invalidate_cache()

            log_action(f"Removed {brand} {model} model from event {event_id}")

            return jsonify({'success': True, 'message': f'Removed {brand} {model} from event'})

    except Exception as e:
        logger.error(f"Error managing event models: {e}")
        return jsonify({'error': 'Failed to manage event models'}), 500

@app.route('/api/events/<int:event_id>/prepare', methods=['POST'])
@require_auth
def prepare_event_asset(event_id):
    """Mark an asset as prepared for an event"""
    try:
        event = data_manager.events.get(event_id)
        if not event:
            return jsonify({'error': 'Event not found'}), 404

        data = request.get_json()
        asset_id = data.get('assetId', '').strip()

        if not asset_id:
            return jsonify({'error': 'Asset ID is required'}), 400

        # Initialize lists if they don't exist
        if not hasattr(event, 'actually_prepared'):
            event.actually_prepared = []
        if not hasattr(event, 'extra_assets'):
            event.extra_assets = []

        # Check if already prepared
        if asset_id in event.actually_prepared:
            return jsonify({'error': 'Asset is already prepared'}), 400

        # For regular assets, perform additional checks
        if not (asset_id.startswith('[LOAN]') or asset_id.startswith('[MISC]')):
            asset = data_manager.inventory.get(asset_id)
            if not asset:
                return jsonify({'error': 'Asset not found'}), 404

            if asset.is_missing:
                return jsonify({'error': 'Asset is marked as missing'}), 400

            if asset.is_ooc:
                return jsonify({'error': 'Asset is out of commission'}), 400

            # Check if this asset fulfills a model requirement
            fulfills_model_requirement = False
            
            # Check if this asset fulfills any model requirement
            for prepared_item in event.prepared_items:
                if prepared_item.startswith('[MODEL]'):
                    try:
                        parts = prepared_item[7:].split('|')
                        if len(parts) >= 4:
                            dept = parts[0]
                            brand = parts[1]
                            model = parts[2]
                            description = parts[4]

                            # Check if this asset matches the model requirement
                            if (asset.department_code == dept and 
                                asset.brand == brand and 
                                asset.model_number == model and
                                asset.description == description):
                                fulfills_model_requirement = True
                                logger.info(f"Asset {asset_id} fulfills model requirement {prepared_item}")
                                break
                    except Exception as e:
                        logger.error(f"Error parsing model assignment: {e}")
                        continue
            
            # Add to prepared_items if not already there
            if asset_id not in event.prepared_items:
                event.prepared_items.append(asset_id)
            
            # Handle extra_assets logic based on whether it fulfills a model requirement
            if fulfills_model_requirement:
                # If it fulfills a requirement, ensure it's NOT marked as extra
                if asset_id in event.extra_assets:
                    event.extra_assets.remove(asset_id)
                    logger.info(f"Removed {asset_id} from extra_assets (fulfills model requirement). Extra assets: {event.extra_assets}")
            else:
                # Only add to extra_assets if it doesn't fulfill any model requirement
                if asset_id not in event.extra_assets:
                    event.extra_assets.append(asset_id)
                    logger.info(f"Added extra asset {asset_id} to event {event_id}. Extra assets: {event.extra_assets}")

            # Update asset location now that it's prepared
            asset.current_location = event.name
            data_manager.save_inventory()

        # Mark as prepared
        event.actually_prepared.append(asset_id)

        # Update event state
        update_event_state(event)

        # Save changes
        data_manager.save_event(event)

        # Invalidate cache
        invalidate_cache()

        log_action(f"Prepared asset {asset_id} for event {event_id}")

        return jsonify({'success': True, 'message': f'Asset {asset_id} prepared for event'})
    except Exception as e:
        logger.error(f"Error preparing asset for event {event_id}: {e}")
        return jsonify({'error': 'Failed to prepare asset'}), 500
@app.route('/api/events/<int:event_id>/custom-assets', methods=['POST'])
@require_auth
def add_custom_asset_to_event(event_id):
    """Add a custom asset (LOAN/MISC) to an event"""
    try:
        event = data_manager.events.get(event_id)
        if not event:
            return jsonify({'error': 'Event not found'}), 404

        data = request.get_json()
        name = data.get('name', '').strip()
        quantity = int(data.get('quantity', 1))
        asset_type = data.get('type', 'MISC').upper()
        
        if not name:
            return jsonify({'error': 'Asset name is required'}), 400
            
        if asset_type not in ['LOAN', 'MISC']:
            return jsonify({'error': 'Invalid asset type'}), 400
        
        # Create custom asset ID
        custom_asset_id = f"[{asset_type}]{name}"
        if quantity > 1:
            custom_asset_id += f";{quantity}"
        
        # Add to event
        if custom_asset_id not in event.prepared_items:
            event.prepared_items.append(custom_asset_id)
        
        # Initialize actually_prepared if it doesn't exist
        if not hasattr(event, 'actually_prepared'):
            event.actually_prepared = []
            
        # Custom assets are automatically "prepared" when added since they don't require physical preparation
        if custom_asset_id not in event.actually_prepared:
            event.actually_prepared.append(custom_asset_id)
        
        # Update event state
        update_event_state(event)
        
        # Save changes
        data_manager.save_event(event)
        
        # Invalidate cache
        invalidate_cache()
        
        log_action(f"Added custom asset '{name}' to event {event_id}")
        
        return jsonify({
            'success': True, 
            'message': f'Custom asset "{name}" added to event'
        })
        
    except Exception as e:
        logger.error(f"Error adding custom asset to event {event_id}: {e}")
        return jsonify({'error': 'Failed to add custom asset'}), 500
    
@app.route('/api/events/<int:event_id>/unprepare', methods=['POST'])
@require_auth
def unprepare_event_asset(event_id):
    """Remove a specific asset completely from the event"""
    try:
        event = data_manager.events.get(event_id)
        if not event:
            return jsonify({'error': 'Event not found'}), 404

        data = request.get_json()
        asset_id = data.get('assetId', '').strip()

        if not asset_id:
            return jsonify({'error': 'Asset ID is required'}), 400

        # Initialize actually_prepared if it doesn't exist
        if not hasattr(event, 'actually_prepared'):
            event.actually_prepared = []

        # Check if asset is assigned to this event first
        if asset_id not in event.prepared_items:
            return jsonify({'error': 'Asset is not assigned to this event'}), 400

        # LOG THE UNPREPARE ACTION
        log_asset_change(event_id, asset_id, "UNPREPARING", "completely removing asset from event [unprepare_event_asset]")

        # Remove from prepared list (completely unassign the asset)
        event.prepared_items.remove(asset_id)
        
        # Remove from actually_prepared if it's there
        if asset_id in event.actually_prepared:
            event.actually_prepared.remove(asset_id)
        
        # Remove from extra_assets if it's there
        if hasattr(event, 'extra_assets') and asset_id in event.extra_assets:
            event.extra_assets.remove(asset_id)

        # For regular assets, reset location to default
        if not (asset_id.startswith('[LOAN]') or asset_id.startswith('[MISC]')):
            asset = data_manager.inventory.get(asset_id)
            if asset:
                asset.current_location = asset.default_location or ''
                data_manager.save_inventory()

        # Update event state
        update_event_state(event)

        # Save changes
        data_manager.save_event(event)

        # Invalidate cache
        invalidate_cache()

        log_action(f"Completely removed asset {asset_id} from event {event_id}")

        return jsonify({'success': True, 'message': f'Asset {asset_id} removed from event'})
    except Exception as e:
        logger.error(f"Error removing asset from event {event_id}: {e}")
        return jsonify({'error': 'Failed to remove asset'}), 500

@app.route('/api/events/<int:event_id>/return', methods=['POST'])
@require_auth
def return_event_asset(event_id):
    """Return an asset from an event"""
    try:
        event = data_manager.events.get(event_id)
        if not event:
            return jsonify({'error': 'Event not found'}), 404

        data = request.get_json()
        asset_id = data.get('assetId', '').strip()

        if not asset_id:
            return jsonify({'error': 'Asset ID is required'}), 400

        # Check if asset is prepared for this event
        if asset_id not in event.prepared_items:
            return jsonify({'error': 'Asset is not assigned to this event'}), 400

        # Check if asset is already returned
        if asset_id in event.returned_items:
            return jsonify({'error': 'Asset is already returned'}), 400

        # Return the asset
        event.returned_items.append(asset_id)

        # Initialize actually_prepared if it doesn't exist
        if not hasattr(event, 'actually_prepared'):
            event.actually_prepared = []

        # IMPORTANT: Do NOT remove custom assets from actually_prepared when returning them
        # Custom assets (LOAN/MISC) should remain in actually_prepared for proper state calculation
        # Only remove regular inventory assets from actually_prepared when they're returned
        if not (asset_id.startswith('[LOAN]') or asset_id.startswith('[MISC]')):
            # For regular assets, remove from actually_prepared when returned
            if asset_id in event.actually_prepared:
                event.actually_prepared.remove(asset_id)
        # For custom assets, keep them in actually_prepared - the state logic will check
        # if they're in returned_items to determine closure

        # For regular assets, update location
        if not (asset_id.startswith('[LOAN]') or asset_id.startswith('[MISC]')):
            asset = data_manager.inventory.get(asset_id)
            if asset:
                asset.current_location = asset.default_location or ''
                data_manager.save_inventory()

        # Update event state
        update_event_state(event)

        # Save changes
        data_manager.save_event(event)

        # Invalidate cache
        invalidate_cache()

        log_action(f"Returned asset {asset_id} from event {event_id}")

        return jsonify({'success': True, 'message': f'Asset {asset_id} returned successfully'})
    except Exception as e:
        logger.error(f"Error returning asset from event {event_id}: {e}")
        import traceback
        logger.error(f"Traceback: {traceback.format_exc()}")
        return jsonify({'error': 'Failed to return asset'}), 500
    
@app.route('/api/events/<int:event_id>/return-department', methods=['POST'])
@require_auth
def return_department_assets(event_id):
    """Return all unreturned assets for a given department in this event.
    Includes regular inventory assets from actually_prepared that match the department,
    any specifically prepared assets from prepared_items in that department,
    and custom assets ([LOAN]/[MISC]) if department is LOAN or MISC.
    """
    try:
        event = data_manager.events.get(event_id)
        if not event:
            return jsonify({'error': 'Event not found'}), 404

        data = request.get_json() or {}
        department = (data.get('department') or '').strip()
        if not department:
            return jsonify({'error': 'Department is required'}), 400

        # Ensure lists exist
        if not hasattr(event, 'actually_prepared'):
            event.actually_prepared = []
        if not hasattr(event, 'extra_assets'):
            event.extra_assets = []

        already_returned = set(event.returned_items or [])
        targets = []

        # 1) Regular inventory assets (match department)
        specific_ids_in_prepared = [
            aid for aid in event.prepared_items
            if not (aid.startswith('[LOAN]') or aid.startswith('[MISC]') or aid.startswith('[MODEL]'))
        ]
        for asset_id in set(event.actually_prepared + specific_ids_in_prepared):
            if asset_id in already_returned:
                continue
            asset = data_manager.inventory.get(asset_id)
            if not asset:
                continue
            if asset.department_code == department:
                targets.append(asset_id)

        # 2) Custom assets (LOAN/MISC)
        if department in ('LOAN', 'MISC'):
            for item in event.prepared_items:
                if item.startswith(f'[{department}]') and item not in already_returned:
                    targets.append(item)

        if not targets:
            return jsonify({'success': True, 'message': f'No pending items for department {department}', 'returned': []})

        returned_now = []

        for asset_id in targets:
            if asset_id in event.returned_items:
                continue

            # Mark returned
            event.returned_items.append(asset_id)
            returned_now.append(asset_id)

            # Regular assets: remove from actually_prepared + reset location
            if not (asset_id.startswith('[LOAN]') or asset_id.startswith('[MISC]')):
                if asset_id in event.actually_prepared:
                    event.actually_prepared.remove(asset_id)
                asset = data_manager.inventory.get(asset_id)
                if asset:
                    asset.current_location = asset.default_location or ''

            # For custom assets, DO NOT remove from actually_prepared (to match single-return semantics)

        # Persist
        data_manager.save_inventory()
        update_event_state(event)
        data_manager.save_event(event)
        invalidate_cache()

        log_action(f"Returned all assets for department {department} in event {event_id}: {len(returned_now)} items")

        return jsonify({'success': True, 'message': f'Returned {len(returned_now)} items for {department}', 'returned': returned_now})
    except Exception as e:
        logger.error(f"Error returning all assets for department {department} in event {event_id}: {e}")
        return jsonify({'error': 'Failed to return department assets'}), 500


@app.route('/api/events/<int:event_id>/assign-specific', methods=['POST'])
@require_auth
def assign_specific_asset_to_model(event_id):
    """Assign a specific asset to fulfill a model requirement"""
    try:
        event = data_manager.events.get(event_id)
        if not event:
            return jsonify({'error': 'Event not found'}), 404

        data = request.get_json()
        asset_id = data.get('assetId', '').strip()

        if not asset_id:
            return jsonify({'error': 'Asset ID is required'}), 400

        # Initialize lists if they don't exist
        if not hasattr(event, 'actually_prepared'):
            event.actually_prepared = []
        if not hasattr(event, 'extra_assets'):
            event.extra_assets = []

        # Check if asset is already assigned
        if asset_id in event.actually_prepared:
            return jsonify({'error': 'Asset is already assigned to this event'}), 400

        # For regular assets, perform checks
        if not (asset_id.startswith('[LOAN]') or asset_id.startswith('[MISC]')):
            asset = data_manager.inventory.get(asset_id)
            if not asset:
                return jsonify({'error': 'Asset not found'}), 404

            logger.info(f"Assigning asset {asset_id} - Brand: {asset.brand}, Model: {asset.model_number}, Dept: {asset.department_code}")

            if asset.is_missing:
                return jsonify({'error': 'Asset is marked as missing'}), 400

            if asset.is_ooc:
                return jsonify({'error': 'Asset is out of commission'}), 400

            # Check if asset is assigned to another active event
            assigned_assets = get_assigned_assets()
            if asset_id in assigned_assets:
                for other_event_id, other_event in data_manager.events.items():
                    if (asset_id in other_event.prepared_items and 
                        asset_id not in other_event.returned_items):
                        return jsonify({'error': f'Asset is already assigned to event {other_event_id}: {other_event.name}'}), 400

            # Check if asset matches any model requirement
            fulfills_model_requirement = False
            if hasattr(event, 'model_requirements'):
                for req in event.model_requirements:
                    if req.get('fulfilled', 0) < req.get('quantity', 0):
                        req_dept = req.get('department', '').strip()
                        req_brand = req.get('brand', '').strip()
                        req_model = req.get('model', '').strip()
                        
                        if (req_dept == asset.department_code and
                            req_brand.lower() == asset.brand.lower() and
                                req_model.lower() == asset.model_number.lower()):
                            fulfills_model_requirement = True
                            break

            logger.info(f"Asset {asset_id} fulfills model requirement: {fulfills_model_requirement}")
            
            # Add to prepared_items if not already there (regardless of whether it fulfills a model requirement)
            if asset_id not in event.prepared_items:
                event.prepared_items.append(asset_id)
                logger.info(f"Added {asset_id} to prepared_items")
            
            # Handle extra_assets logic:
            # If asset was previously extra but now fulfills a requirement, remove from extra list
            if asset_id in event.extra_assets and fulfills_model_requirement:
                event.extra_assets.remove(asset_id)
                logger.info(f"Removed {asset_id} from extra_assets (now fulfills requirement). Extra assets: {event.extra_assets}")
            
            # Only add to extra_assets if it doesn't fulfill any model requirement AND isn't already there
            elif not fulfills_model_requirement and asset_id not in event.extra_assets:
                event.extra_assets.append(asset_id)
                logger.info(f"Added {asset_id} to extra_assets list (doesn't fulfill model requirement). Extra assets: {event.extra_assets}")
            
            # If asset fulfills requirement, ensure it's NOT in extra_assets
            elif fulfills_model_requirement and asset_id in event.extra_assets:
                event.extra_assets.remove(asset_id)
                logger.info(f"Removed {asset_id} from extra_assets (fulfills requirement). Extra assets: {event.extra_assets}")

            asset.current_location = event.name
            data_manager.save_inventory()

        # Add to actually_prepared if not already there
        if asset_id not in event.actually_prepared:
            event.actually_prepared.append(asset_id)
            logger.info(f"Added {asset_id} to actually_prepared. List now: {event.actually_prepared}")

        # Update event state
        update_event_state(event)
        
        # Save changes
        data_manager.save_event(event)
        
        # Invalidate cache
        invalidate_cache()

        log_action(f"Assigned specific asset {asset_id} to event {event_id}")

        return jsonify({'success': True, 'message': f'Asset {asset_id} assigned to event'})

    except Exception as e:
        logger.error(f"Error assigning specific asset to event {event_id}: {e}")
        return jsonify({'error': 'Failed to assign asset'}), 500

@app.route('/api/events/<int:event_id>/unassign-specific', methods=['POST'])
@require_auth
def unassign_specific_asset_from_model(event_id):
    """Unassign a specific asset from a model requirement"""
    try:
        event = data_manager.events.get(event_id)
        if not event:
            return jsonify({'error': 'Event not found'}), 404

        data = request.get_json()
        asset_id = data.get('assetId', '').strip()

        if not asset_id:
            return jsonify({'error': 'Asset ID is required'}), 400

        # Initialize actually_prepared if it doesn't exist
        if not hasattr(event, 'actually_prepared'):
            event.actually_prepared = []

        # Check if asset is assigned
        if asset_id not in event.actually_prepared:
            return jsonify({'error': 'Asset is not currently prepared for this event'}), 400

        # Remove from actually_prepared
        event.actually_prepared.remove(asset_id)

        # For regular assets, reset location
        if not (asset_id.startswith('[LOAN]') or asset_id.startswith('[MISC]')):
            asset = data_manager.inventory.get(asset_id)
            if asset:
                asset.current_location = asset.default_location or ''
                data_manager.save_inventory()

        # Update event state
        update_event_state(event)

        # Save changes
        data_manager.save_event(event)

        # Invalidate cache
        invalidate_cache()

        log_action(
            f"Unassigned specific asset {asset_id} from event {event_id}")

        return jsonify({'success': True, 'message': f'Asset {asset_id} unassigned from event'})

    except Exception as e:
        logger.error(
            f"Error unassigning specific asset from event {event_id}: {e}")
        return jsonify({'error': 'Failed to unassign asset'}), 500
    
@app.route('/api/events/<int:event_id>/remove-asset', methods=['POST'])
@require_auth
def remove_asset_from_event_body(event_id):
    """Remove an asset from an event (with asset ID in request body)"""
    try:
        data = request.get_json()
        asset_id = data.get('assetId', '').strip()
        
        if not asset_id:
            return jsonify({'error': 'Asset ID is required'}), 400
        
        logger.info(f"Removing asset '{asset_id}' from event {event_id}")
        
        event = data_manager.events.get(event_id)
        if not event:
            return jsonify({'error': 'Event not found'}), 404

        # Check if asset is in this event
        if asset_id not in event.prepared_items:
            return jsonify({'error': 'Asset is not assigned to this event'}), 400

        # LOG THE REMOVAL
        log_asset_change(event_id, asset_id, "REMOVING", "from prepared_items via POST remove-asset endpoint", "remove_asset_from_event_body")

        # Remove the asset
        event.prepared_items.remove(asset_id)

        # Also remove from returned items if it was there
        if asset_id in event.returned_items:
            event.returned_items.remove(asset_id)
            log_asset_change(event_id, asset_id, "REMOVING", "from returned_items", "remove_asset_from_event_body")

        # Initialize actually_prepared if it doesn't exist
        if not hasattr(event, 'actually_prepared'):
            event.actually_prepared = []

        # Remove from actually_prepared if it was there
        if asset_id in event.actually_prepared:
            event.actually_prepared.remove(asset_id)
            log_asset_change(event_id, asset_id, "REMOVING", "from actually_prepared", "remove_asset_from_event_body")

        # Remove from extra_assets if it exists
        if hasattr(event, 'extra_assets') and asset_id in event.extra_assets:
            event.extra_assets.remove(asset_id)
            log_asset_change(event_id, asset_id, "REMOVING", "from extra_assets", "remove_asset_from_event_body")

        # For regular assets, update location
        if not (asset_id.startswith('[LOAN]') or asset_id.startswith('[MISC]')):
            asset = data_manager.inventory.get(asset_id)
            if asset:
                asset.current_location = asset.default_location or ''
                data_manager.save_inventory()

        # Update event state
        update_event_state(event)

        # Save changes
        data_manager.save_event(event)

        # Invalidate cache
        invalidate_cache()

        log_action(f"Removed asset {asset_id} from event {event_id}")

        return jsonify({'success': True, 'message': f'Asset {asset_id} removed from event'})
    except Exception as e:
        logger.error(f"Error removing asset from event {event_id}: {e}")
        return jsonify({'error': 'Failed to remove asset from event'}), 500

@app.route('/api/events/<int:event_id>/remove-asset', methods=['POST'])
@require_auth
def remove_asset_from_event_post(event_id):
    """Remove an asset from an event - uses POST body to avoid URL encoding issues"""
    try:
        data = request.get_json()
        asset_id = data.get('assetId', '').strip()
        
        if not asset_id:
            return jsonify({'error': 'Asset ID is required'}), 400
        
        logger.info(f"Remove asset request: Event {event_id}, Asset: '{asset_id}'")
        
        event = data_manager.events.get(event_id)
        if not event:
            return jsonify({'error': 'Event not found'}), 404

        # Initialize lists if they don't exist
        if not hasattr(event, 'actually_prepared'):
            event.actually_prepared = []
        if not hasattr(event, 'extra_assets'):
            event.extra_assets = []

        # Check if asset is in this event (check ALL possible locations)
        asset_is_assigned = (asset_id in event.prepared_items or 
                            asset_id in event.actually_prepared or
                            asset_id in event.extra_assets)

        if not asset_is_assigned:
            logger.warning(f"Asset '{asset_id}' not found in event {event_id}")
            logger.info(f"  prepared_items: {event.prepared_items}")
            logger.info(f"  actually_prepared: {event.actually_prepared}")
            logger.info(f"  extra_assets: {event.extra_assets}")
            return jsonify({'error': 'Asset is not assigned to this event'}), 400

        # Remove the asset from ALL possible locations
        if asset_id in event.prepared_items:
            event.prepared_items.remove(asset_id)
            logger.info(f"Removed '{asset_id}' from prepared_items")

        if asset_id in event.returned_items:
            event.returned_items.remove(asset_id)
            logger.info(f"Removed '{asset_id}' from returned_items")

        if asset_id in event.actually_prepared:
            event.actually_prepared.remove(asset_id)
            logger.info(f"Removed '{asset_id}' from actually_prepared")

        if asset_id in event.extra_assets:
            event.extra_assets.remove(asset_id)
            logger.info(f"Removed '{asset_id}' from extra_assets")

        # For regular assets, update location
        if not (asset_id.startswith('[LOAN]') or asset_id.startswith('[MISC]')):
            asset = data_manager.inventory.get(asset_id)
            if asset:
                asset.current_location = asset.default_location or ''
                data_manager.save_inventory()
                logger.info(f"Reset location for asset '{asset_id}'")

        # Update event state
        update_event_state(event)

        # Save changes
        data_manager.save_event(event)

        # Invalidate cache
        invalidate_cache()

        log_action(f"Removed asset {asset_id} from event {event_id}")

        return jsonify({'success': True, 'message': f'Asset {asset_id} removed from event'})
    except Exception as e:
        logger.error(f"Error removing asset from event {event_id}: {e}")
        return jsonify({'error': 'Failed to remove asset from event'}), 500

@app.route('/api/events/<int:event_id>/transfer', methods=['POST'])
@require_auth
def transfer_asset_between_events(event_id):
    """Transfer an asset from one event to another"""
    try:
        data = request.get_json()
        from_event_id = data.get('fromEventId')
        asset_id = data.get('assetId', '').strip()

        if not from_event_id or not asset_id:
            return jsonify({'error': 'From event ID and asset ID are required'}), 400

        # Get events
        from_event = data_manager.events.get(from_event_id)
        to_event = data_manager.events.get(event_id)

        if not from_event or not to_event:
            return jsonify({'error': 'Event not found'}), 404

        # Initialize actually_prepared for both events if needed
        if not hasattr(from_event, 'actually_prepared'):
            from_event.actually_prepared = []
        if not hasattr(to_event, 'actually_prepared'):
            to_event.actually_prepared = []

        # Check if asset is assigned to from_event
        if asset_id not in from_event.prepared_items or asset_id in from_event.returned_items:
            return jsonify({'error': 'Asset is not currently assigned to the source event'}), 400

        # Transfer the asset
        from_event.returned_items.append(asset_id)

        # Remove from actually_prepared in source event
        if asset_id in from_event.actually_prepared:
            from_event.actually_prepared.remove(asset_id)

        # Add to destination event
        if asset_id in to_event.prepared_items and asset_id in to_event.returned_items:
            to_event.returned_items.remove(asset_id)
        elif asset_id not in to_event.prepared_items:
            to_event.prepared_items.append(asset_id)

        # For regular assets, update location
        if not (asset_id.startswith('[LOAN]') or asset_id.startswith('[MISC]')):
            asset = data_manager.inventory.get(asset_id)
            if asset:
                asset.current_location = to_event.name
                data_manager.save_inventory()

        # Update event states
        update_event_state(from_event)
        update_event_state(to_event)

        # Save changes
        data_manager.save_event(from_event)
        data_manager.save_event(to_event)

        # Invalidate cache
        invalidate_cache()

        log_action(
            f"Transferred asset {asset_id} from event {from_event_id} to event {event_id}")

        return jsonify({'success': True, 'message': f'Asset {asset_id} transferred successfully'})
    except Exception as e:
        logger.error(f"Error transferring asset: {e}")
        return jsonify({'error': 'Failed to transfer asset'}), 500


@app.route('/api/assets', methods=['GET'])
@require_auth
def get_assets():
    """Get all assets"""
    try:
        assets_data = []
        assigned_assets = get_assigned_assets()

        for asset in data_manager.inventory.values():
            # Determine current status
            status = 'available'
            if asset.is_missing:
                status = 'missing'
            elif asset.is_ooc:
                status = 'ooc'
            elif asset.asset_id in assigned_assets:
                status = 'deployed'

            assets_data.append({
                'id': asset.asset_id,
                'brand': asset.brand,
                'model': asset.model_number,
                'serial': asset.serial_number,
                'description': asset.description,
                'department': asset.department_code,
                'status': status,
                'location': asset.current_location or asset.default_location,
                'isMissing': asset.is_missing,
                'isOOC': asset.is_ooc,
                'defaultLocation': asset.default_location,
                'currentLocation': asset.current_location,
                'maintenanceLogs': asset.maintenance_logs
            })

        return jsonify({'success': True, 'data': assets_data})
    except Exception as e:
        logger.error(f"Error getting assets: {e}")
        return jsonify({'error': 'Failed to retrieve assets'}), 500


@app.route('/api/assets/available', methods=['GET'])
@require_auth
def get_available_assets():
    """
    Get assets that are assignable, ignoring whether they are already assigned
    to other events. We only exclude Missing / OOC here.
    """
    try:
        available_assets = []
        for asset in data_manager.inventory.values():
            if not asset.is_missing and not asset.is_ooc:
                available_assets.append({
                    'id': asset.asset_id,
                    'brand': asset.brand,
                    'model': asset.model_number,
                    'description': asset.description,
                    'serial': asset.serial_number,
                    'department': asset.department_code,
                    'location': asset.current_location or asset.default_location
                })

        # keep the same sort as before to avoid UI surprises
        available_assets.sort(key=lambda x: (x['department'], x['id']))
        return jsonify({'success': True, 'data': available_assets})
    except Exception as e:
        logger.error(f"Error getting available assets: {e}")
        return jsonify({'error': 'Failed to retrieve available assets'}), 500


@app.route('/api/events/<int:event_id>/assets', methods=['GET'])
def get_event_assets(event_id):
    """Get all assets assigned to an event with their details"""
    if 'user' not in session:
        return jsonify({'error': 'Not authenticated'}), 401

    event = data_manager.events.get(event_id)
    if not event:
        return jsonify({'error': 'Event not found'}), 404

    event_assets = []
    for asset_id in event.prepared_items:
        if not (asset_id.startswith('[LOAN]') or asset_id.startswith('[MISC]')):
            asset = data_manager.inventory.get(asset_id)
            if asset:
                event_assets.append({
                    'id': asset.asset_id,
                    'brand': asset.brand,
                    'model': asset.model_number,
                    'description': asset.description,
                    'serial': asset.serial_number,
                    'department': asset.department_code,
                    'status': 'returned' if asset_id in event.returned_items else 'prepared',
                    'location': asset.current_location,
                    'isMissing': asset.is_missing,
                    'isOOC': asset.is_ooc
                })

    return jsonify({'success': True, 'data': event_assets})


@app.route('/api/assets', methods=['POST'])
@require_auth
def create_asset():
    """Create a new asset"""
    try:
        data = request.get_json()

        # Validate required fields
        required_fields = ['brand', 'model']
        missing_fields = [
            field for field in required_fields if not data.get(field, '').strip()]
        if missing_fields:
            return jsonify({'error': f'Missing required fields: {", ".join(missing_fields)}'}), 400

        # Generate asset ID
        model_number = data['model'].upper().strip()
        existing_items = [item for item in data_manager.inventory.values(
        ) if item.model_number == model_number]
        next_number = len(existing_items) + 1
        asset_id = f"{model_number}#{next_number:02d}"

        # Create new asset
        asset = InventoryItem(
            asset_id=asset_id,
            brand=data['brand'].strip(),
            model_number=model_number,
            serial_number=data.get('serial', '').strip(),
            description=data.get('description', '').strip(),
            is_missing=False,
            is_ooc=False,
            maintenance_logs=[],
            department_code=data.get('department', 'UN').strip(),
            default_location='Store',
            current_location=''
        )

        # Save asset
        data_manager.inventory[asset_id] = asset
        data_manager.save_inventory()

        # Invalidate cache
        invalidate_cache()

        log_action(f"Added asset {asset_id} via web interface")

        return jsonify({'success': True, 'message': 'Asset created successfully', 'assetId': asset_id})
    except Exception as e:
        logger.error(f"Error creating asset: {e}")
        return jsonify({'error': 'Failed to create asset'}), 500


@app.route('/api/assets/<asset_id>', methods=['PUT'])
@require_auth
def update_asset(asset_id):
    """Update an existing asset"""
    try:
        asset = data_manager.inventory.get(asset_id)
        if not asset:
            return jsonify({'error': 'Asset not found'}), 404

        data = request.get_json()

        # Update asset properties
        if 'brand' in data:
            asset.brand = data['brand'].strip()
        if 'model' in data:
            asset.model_number = data['model'].upper().strip()
        if 'serial' in data:
            asset.serial_number = data['serial'].strip()
        if 'description' in data:
            asset.description = data['description'].strip()
        if 'department' in data:
            asset.department_code = data['department'].strip()
        if 'isMissing' in data:
            asset.is_missing = bool(data['isMissing'])
        if 'isOOC' in data:
            asset.is_ooc = bool(data['isOOC'])

        # Save asset
        data_manager.save_inventory()

        # Invalidate cache
        invalidate_cache()

        log_action(f"Updated asset {asset_id} via web interface")

        return jsonify({'success': True, 'message': 'Asset updated successfully'})
    except Exception as e:
        logger.error(f"Error updating asset {asset_id}: {e}")
        return jsonify({'error': 'Failed to update asset'}), 500

@app.route('/api/assets/<asset_id>/maintain', methods=['POST'])
@require_auth
def maintain_asset(asset_id):
    """Add maintenance log to an asset"""
    try:
        logger.info(f"Received maintenance request for asset: '{asset_id}'")
        
        # URL decode the asset_id in case it has special characters
        from urllib.parse import unquote
        asset_id = unquote_plus(asset_id)
        logger.info(f"Decoded asset ID: '{asset_id}'")
        
        asset = data_manager.inventory.get(asset_id)
        if not asset:
            logger.error(f"Asset not found: '{asset_id}'. Available assets: {list(data_manager.inventory.keys())[:10]}")
            return jsonify({'error': 'Asset not found'}), 404

        data = request.get_json()
        logger.info(f"Received data: {data}")
        
        if not data:
            return jsonify({'error': 'No data provided'}), 400
            
        # Safely handle potentially None values
        log_entry_text = data.get('logEntry')
        if log_entry_text is None:
            return jsonify({'error': 'Log entry is required'}), 400
        log_entry_text = log_entry_text.strip()
        
        new_location = data.get('newLocation')
        if new_location is not None:
            new_location = new_location.strip()
            # Treat empty string as None
            if not new_location:
                new_location = None
        
        new_serial = data.get('newSerial')
        if new_serial is not None:
            new_serial = new_serial.strip()
            # Treat empty string as None
            if not new_serial:
                new_serial = None
        
        mark_ooc = data.get('markOOC', False)
        unmark_ooc = data.get('unmarkOOC', False)
        mark_missing = data.get('markMissing', False)
        unmark_missing = data.get('unmarkMissing', False)

        if not log_entry_text:
            return jsonify({'error': 'Log entry is required'}), 400

        # Add maintenance log
        # Get maintenance date from request or use current date as fallback
        maintenance_date = data.get('maintenanceDate')
        if maintenance_date:
            try:
                # Parse the date from frontend (YYYY-MM-DD format) and convert to our format (YYYY/MM/DD)
                parsed_date = datetime.strptime(maintenance_date, '%Y-%m-%d')
                formatted_date = parsed_date.strftime("%Y/%m/%d")
            except ValueError:
                # If date parsing fails, use current date
                formatted_date = datetime.now().strftime("%Y/%m/%d")
                logger.warning(f"Invalid maintenance date format: {maintenance_date}, using current date")
        else:
            # If no date provided, use current date
            formatted_date = datetime.now().strftime("%Y/%m/%d")

        # Build status changes information - INITIALIZE HERE
        status_changes = []
        
        if new_location:
            status_changes.append(f"Location: {new_location}")
        if new_serial:
            status_changes.append(f"Serial: {new_serial}")
        if mark_ooc:
            status_changes.append("Marked OOC")
        elif unmark_ooc:
            status_changes.append("Cleared OOC")
        if mark_missing:
            status_changes.append("Marked Missing")
        elif unmark_missing:
            status_changes.append("Cleared Missing")
        
        # Create enhanced log entry with status changes
        status_text = f" [{', '.join(status_changes)}]" if status_changes else ""
        entry = f"{formatted_date}\t{session['user']}\t{log_entry_text}{status_text}"
        
        asset.maintenance_logs.append(entry)

        # Update location if provided
        if new_location:
            old_location = asset.current_location or ''
            asset.current_location = new_location
            log_action(f"Updated location for asset {asset_id} from '{old_location}' to '{new_location}'")

        # Update serial number if provided
        if new_serial:
            old_serial = asset.serial_number or 'None'
            asset.serial_number = new_serial
            log_action(f"Updated serial number for asset {asset_id} from '{old_serial}' to '{new_serial}'")

        # Update OOC status
        if mark_ooc and not asset.is_ooc:
            asset.is_ooc = True
            log_action(f"Marked asset {asset_id} as Out of Commission")
        elif unmark_ooc and asset.is_ooc:
            asset.is_ooc = False
            log_action(f"Removed Out of Commission status from asset {asset_id}")

        # Update Missing status
        if mark_missing and not asset.is_missing:
            asset.is_missing = True
            log_action(f"Marked asset {asset_id} as Missing")
        elif unmark_missing and asset.is_missing:
            asset.is_missing = False
            log_action(f"Removed Missing status from asset {asset_id}")

        # Save changes
        data_manager.save_inventory()

        # Invalidate cache
        invalidate_cache()

        log_action(f"Maintenance logged for asset {asset_id}: {log_entry_text}")

        logger.info(f"Successfully logged maintenance for asset {asset_id}")
        return jsonify({'success': True, 'message': 'Maintenance logged successfully'})
        
    except Exception as e:
        logger.error(f"Error maintaining asset {asset_id}: {e}")
        import traceback
        logger.error(f"Traceback: {traceback.format_exc()}")
        return jsonify({'error': f'Failed to log maintenance: {str(e)}'}), 500

@app.route('/api/assets/<asset_id>/maintenance-log-enhanced/<int:log_index>', methods=['PUT'])
@require_auth
def update_maintenance_log_enhanced(asset_id, log_index):
    """Update a maintenance log entry with enhanced options"""
    try:
        logger.info(f"Received enhanced maintenance log update request for asset: '{asset_id}', log index: {log_index}")
        
        # URL decode the asset_id in case it has special characters
        from urllib.parse import unquote
        asset_id = unquote_plus(asset_id)
        
        asset = data_manager.inventory.get(asset_id)
        if not asset:
            return jsonify({'error': 'Asset not found'}), 404

        data = request.get_json()
        if not data:
            return jsonify({'error': 'No data provided'}), 400
        
        logger.info(f"Enhanced update data: {data}")
        
        # Validate required fields
        new_date = data.get('date')
        new_user = data.get('user')
        new_description = data.get('description')
        
        if not all([new_date, new_user, new_description]):
            return jsonify({'error': 'Date, user, and description are required'}), 400
        
        new_description = new_description.strip()
        new_user = new_user.strip()
        
        # Check if log index is valid
        if not asset.maintenance_logs or log_index < 0 or log_index >= len(asset.maintenance_logs):
            return jsonify({'error': 'Invalid log index'}), 400
        
        # Convert date format from YYYY-MM-DD to YYYY/MM/DD
        try:
            parsed_date = datetime.strptime(new_date, '%Y-%m-%d')
            formatted_date = parsed_date.strftime("%Y/%m/%d")
        except ValueError:
            return jsonify({'error': 'Invalid date format'}), 400
        
        # Get original log for logging purposes
        original_log = asset.maintenance_logs[log_index]
        original_parts = original_log.split('\t')
        original_description = '\t'.join(original_parts[2:]) if len(original_parts) >= 3 else original_log
        
        # Handle additional updates - INITIALIZE changes_made HERE
        changes_made = []
        
        # Handle location changes - preserve original log's location if not explicitly changed
        new_location = data.get('newLocation')

        # First, check what location change was originally in this specific log
        original_log_location_change = None
        original_log = asset.maintenance_logs[log_index]
        if original_log:
            original_parts = original_log.split('\t')
            original_description = '\t'.join(original_parts[2:]) if len(original_parts) >= 3 else ''
            if '[' in original_description and ']' in original_description:
                import re
                location_match = re.search(r'Location:\s*([^,\]]+)', original_description)
                if location_match:
                    original_log_location_change = location_match.group(1).strip()

        if new_location is not None:
            # User provided a location (even if empty string, meaning they want to set it explicitly)
            new_location_clean = new_location.strip() if new_location.strip() else 'Store'
            changes_made.append(f"Location: {new_location_clean}")
            logger.info(f"User set location to: '{new_location_clean}'")
        elif original_log_location_change is not None:
            # User didn't provide location, but original log had a location change - preserve it
            changes_made.append(f"Location: {original_log_location_change}")
            logger.info(f"Preserved original location change: '{original_log_location_change}'")
        # If neither condition is met, no location change is added to the log

        # Update serial ONLY if provided and different
        new_serial = data.get('newSerial')
        if new_serial is not None and new_serial.strip():
            old_serial = asset.serial_number or ''
            new_serial_clean = new_serial.strip()
            if new_serial_clean != old_serial:
                asset.serial_number = new_serial_clean
                changes_made.append(f"Serial: {asset.serial_number}")
                logger.info(f"Updated serial from '{old_serial}' to '{new_serial_clean}'")
        
        # Handle status changes
        mark_ooc = data.get('markOOC', False)
        unmark_ooc = data.get('unmarkOOC', False)
        mark_missing = data.get('markMissing', False)
        unmark_missing = data.get('unmarkMissing', False)
        
        logger.info(f"Status change flags: markOOC={mark_ooc}, unmarkOOC={unmark_ooc}, markMissing={mark_missing}, unmarkMissing={unmark_missing}")
        logger.info(f"Current asset status: OOC={asset.is_ooc}, Missing={asset.is_missing}")
        
        # Apply OOC status changes
        if mark_ooc:
            if not asset.is_ooc:
                asset.is_ooc = True
                changes_made.append("Marked OOC")
                logger.info("Marked asset as OOC")
            else:
                logger.info("Asset already OOC, no change needed")
        elif unmark_ooc:
            # Always add to changes_made when explicitly clearing, even if already clear
            changes_made.append("Cleared OOC")
            if asset.is_ooc:
                asset.is_ooc = False
                logger.info("Cleared OOC status")
            else:
                logger.info("Confirmed OOC status cleared (was already clear)")
                
        # Apply Missing status changes
        if mark_missing:
            if not asset.is_missing:
                asset.is_missing = True
                changes_made.append("Marked Missing")
                logger.info("Marked asset as Missing")
            else:
                logger.info("Asset already Missing, no change needed")
        elif unmark_missing:
            # Always add to changes_made when explicitly clearing, even if already clear
            changes_made.append("Cleared Missing")
            if asset.is_missing:
                asset.is_missing = False
                logger.info("Cleared Missing status")
            else:
                logger.info("Confirmed Missing status cleared (was already clear)")
        
        logger.info(f"Final changes made: {changes_made}")
        logger.info(f"Final asset status: OOC={asset.is_ooc}, Missing={asset.is_missing}")
        
        # Create updated log entry with status changes
        status_text = f" [{', '.join(changes_made)}]" if changes_made else ""
        updated_log = f"{formatted_date}\t{new_user}\t{new_description}{status_text}"
        
        logger.info(f"Updated log entry: {updated_log}")
        
        asset.maintenance_logs[log_index] = updated_log

        recalculate_asset_status_from_logs(asset)

        # Save changes
        data_manager.save_inventory()

        # Log the action
        changes_text = f" (also: {', '.join(changes_made)})" if changes_made else ""
        log_action(f"Updated maintenance log for asset {asset_id}: '{original_description}' -> '{new_description}'{changes_text} (edited by {session['user']})")
        
        logger.info(f"Successfully updated enhanced maintenance log for asset {asset_id}")
        return jsonify({'success': True, 'message': 'Maintenance log updated successfully'})
        
    except Exception as e:
        logger.error(f"Error updating enhanced maintenance log for asset {asset_id}: {e}")
        import traceback
        logger.error(f"Traceback: {traceback.format_exc()}")
        return jsonify({'error': f'Failed to update maintenance log: {str(e)}'}), 500

@app.route('/api/search', methods=['GET'])
@require_auth
def search_assets():
    """Search assets by keywords"""
    try:
        query = request.args.get('q', '').lower().strip()
        if not query:
            return jsonify({'success': True, 'data': []})

        keywords = query.split()
        results = []
        assigned_assets = get_assigned_assets()

        for asset in data_manager.inventory.values():
            searchable_text = f"{asset.brand} {asset.model_number} {asset.description} {asset.serial_number}".lower(
            )
            if any(keyword in searchable_text for keyword in keywords):
                # Determine current status
                status = 'available'
                if asset.is_missing:
                    status = 'missing'
                elif asset.is_ooc:
                    status = 'ooc'
                elif asset.asset_id in assigned_assets:
                    status = 'deployed'

                results.append({
                    'id': asset.asset_id,
                    'brand': asset.brand,
                    'model': asset.model_number,
                    'serial': asset.serial_number,
                    'description': asset.description,
                    'department': asset.department_code,
                    'status': status,
                    'location': asset.current_location or asset.default_location,
                    'isMissing': asset.is_missing,
                    'isOOC': asset.is_ooc
                })

        # Sort by relevance (exact matches first, then partial)
        results.sort(key=lambda x: (
            not any(keyword == x['model'].lower()
                    for keyword in keywords),  # Exact model matches first
            not any(keyword in x['brand'].lower()
                    for keyword in keywords),  # Brand matches second
            x['id']  # Then by asset ID
        ))

        return jsonify({'success': True, 'data': results})
    except Exception as e:
        logger.error(f"Error searching assets: {e}")
        return jsonify({'error': 'Failed to search assets'}), 500


@app.route('/api/containers', methods=['GET'])
@require_auth
def get_containers():
    """Get all containers"""
    try:
        containers_data = []
        for container in data_manager.containers.values():
            containers_data.append({
                'id': container.container_id,
                'assetIds': container.asset_ids,
                'assetCount': len(container.asset_ids)
            })

        return jsonify({'success': True, 'data': containers_data})
    except Exception as e:
        logger.error(f"Error getting containers: {e}")
        return jsonify({'error': 'Failed to retrieve containers'}), 500


@app.route('/api/logs', methods=['GET'])
@require_auth
def get_logs():
    """Get activity logs"""
    try:
        # Get all logs (not just last 100) for event activity tracking
        logs_data = []
        for log in data_manager.logs:
            logs_data.append({
                'timestamp': log.timestamp,
                'user': log.user,
                'action': log.action
            })

        # Reverse to show most recent first
        logs_data.reverse()

        return jsonify({'success': True, 'data': logs_data})
    except Exception as e:
        logger.error(f"Error getting logs: {e}")
        return jsonify({'error': 'Failed to retrieve logs'}), 500

@app.route('/api/stats', methods=['GET'])
@require_auth
def get_stats():
    """Get dashboard statistics"""
    try:
        # Add validation checks
        if data_manager is None:
            logger.error("Data manager is not initialized")
            return jsonify({'error': 'Data manager not initialized'}), 500
            
        if not hasattr(data_manager, 'events') or data_manager.events is None:
            logger.error("Data manager events not initialized")
            return jsonify({'error': 'Events data not available'}), 500
            
        if not hasattr(data_manager, 'inventory') or data_manager.inventory is None:
            logger.error("Data manager inventory not initialized")
            return jsonify({'error': 'Inventory data not available'}), 500

        logger.info(f"Getting stats - Events: {len(data_manager.events)}, Inventory: {len(data_manager.inventory)}")
        
        total_events = len(data_manager.events)
        active_events = len(
            [e for e in data_manager.events.values() if e.state not in ['Closed']])
        total_assets = len(data_manager.inventory)
        
        # Add error handling for get_assigned_assets
        try:
            assigned_assets = get_assigned_assets()
            deployed_assets = len(assigned_assets)
            logger.info(f"Successfully got assigned assets count: {deployed_assets}")
        except Exception as e:
            logger.error(f"Error getting assigned assets: {e}")
            deployed_assets = 0
            
        missing_assets = len(
            [a for a in data_manager.inventory.values() if a.is_missing])
        ooc_assets = len(
            [a for a in data_manager.inventory.values() if a.is_ooc])

        stats_data = {
            'totalEvents': total_events,
            'activeEvents': active_events,
            'totalAssets': total_assets,
            'deployedAssets': deployed_assets,
            'missingAssets': missing_assets,
            'oocAssets': ooc_assets
        }
        
        logger.info(f"Returning stats: {stats_data}")

        return jsonify({
            'success': True,
            'data': stats_data
        })
    except Exception as e:
        logger.error(f"Error getting stats: {e}")
        import traceback
        logger.error(f"Stats error traceback: {traceback.format_exc()}")
        return jsonify({'error': 'Failed to retrieve statistics'}), 500
    
@app.route('/api/events/<int:event_id>/custom-assets/update-quantity', methods=['PUT'])
@require_auth
def update_custom_asset_quantity(event_id):
    """Update the quantity of a custom asset in an event"""
    try:
        data = request.get_json()
        old_asset_id = data.get('assetId')
        new_quantity = data.get('newQuantity')
        
        logger.info(f"Updating custom asset quantity: {old_asset_id} -> {new_quantity} for event {event_id}")
        
        if not old_asset_id or not new_quantity:
            return jsonify({'success': False, 'error': 'assetId and newQuantity are required'}), 400
        
        # Validate new_quantity is a positive integer
        try:
            new_quantity = int(new_quantity)
            if new_quantity < 1:
                return jsonify({'success': False, 'error': 'newQuantity must be a positive integer'}), 400
        except (ValueError, TypeError):
            return jsonify({'success': False, 'error': 'newQuantity must be a valid integer'}), 400
        
        # Get the event using your existing data manager
        event = data_manager.events.get(event_id)
        if not event:
            return jsonify({'success': False, 'error': 'Event not found'}), 404
        
        logger.info(f"Found event: {event.name}")
        
        # Check if the old asset exists in prepared_items
        if old_asset_id not in event.prepared_items:
            return jsonify({'success': False, 'error': f'Custom asset {old_asset_id} not found in event'}), 404
        
        logger.info(f"Found old asset in prepared_items")
        
        # Parse the old asset ID to extract name and type
        if not old_asset_id.startswith('['):
            return jsonify({'success': False, 'error': 'Invalid custom asset format'}), 400
        
        try:
            if old_asset_id.startswith('[MISC]'):
                asset_type = 'MISC'
                name_part = old_asset_id[6:]  # Remove '[MISC]'
            elif old_asset_id.startswith('[LOAN]'):
                asset_type = 'LOAN'
                name_part = old_asset_id[6:]  # Remove '[LOAN]'
            else:
                return jsonify({'success': False, 'error': 'Unsupported custom asset type'}), 400
            
            # Remove existing quantity if present
            if ';' in name_part:
                asset_name = name_part.split(';')[0]
            else:
                asset_name = name_part
                
        except Exception as e:
            logger.error(f"Error parsing asset ID: {e}")
            return jsonify({'success': False, 'error': f'Error parsing asset ID: {str(e)}'}), 400
        
        logger.info(f"Parsed asset: type={asset_type}, name={asset_name}")
        
        # Create the new asset ID with updated quantity
        if new_quantity > 1:
            new_asset_id = f'[{asset_type}]{asset_name};{new_quantity}'
        else:
            new_asset_id = f'[{asset_type}]{asset_name}'
        
        logger.info(f"New asset ID: {new_asset_id}")
        
        # Find and replace the old asset ID in prepared_items
        old_asset_index = event.prepared_items.index(old_asset_id)
        event.prepared_items[old_asset_index] = new_asset_id
        
        # Initialize actually_prepared if it doesn't exist
        if not hasattr(event, 'actually_prepared'):
            event.actually_prepared = []
        
        # Update actually_prepared if the old asset was there
        if old_asset_id in event.actually_prepared:
            actually_prepared_index = event.actually_prepared.index(old_asset_id)
            event.actually_prepared[actually_prepared_index] = new_asset_id
            logger.info(f"Updated asset in actually_prepared")
        
        # Update returned_items if the old asset was there
        if old_asset_id in event.returned_items:
            returned_index = event.returned_items.index(old_asset_id)
            event.returned_items[returned_index] = new_asset_id
            logger.info(f"Updated asset in returned_items")
        
        # Update event state
        update_event_state(event)
        
        # Save the event using your existing data manager
        data_manager.save_event(event)
        
        # Invalidate cache
        invalidate_cache()
        
        # Log the activity
        log_action(f'Updated custom asset quantity: {old_asset_id} -> {new_asset_id} for event {event_id}')
        
        logger.info(f"Successfully updated custom asset quantity")
        
        return jsonify({
            'success': True,
            'message': f'Custom asset quantity updated from {old_asset_id} to {new_asset_id}',
            'oldAssetId': old_asset_id,
            'newAssetId': new_asset_id,
            'newQuantity': new_quantity
        })
        
    except Exception as e:
        logger.error(f"Error updating custom asset quantity: {str(e)}")
        import traceback
        traceback.print_exc()
        return jsonify({'success': False, 'error': 'An unexpected error occurred'}), 500
    
@app.route('/api/events/<int:event_id>/custom-assets/remove', methods=['POST'])
@require_auth
def remove_custom_asset_from_event(event_id):
    """Remove a custom asset (LOAN/MISC) from an event"""
    try:
        data = request.get_json()
        asset_id = data.get('assetId', '').strip()
        
        if not asset_id:
            return jsonify({'error': 'Asset ID is required'}), 400
        
        logger.info(f"Removing custom asset '{asset_id}' from event {event_id}")
        
        event = data_manager.events.get(event_id)
        if not event:
            return jsonify({'error': 'Event not found'}), 404

        # Verify this is a custom asset
        if not (asset_id.startswith('[MISC]') or asset_id.startswith('[LOAN]')):
            return jsonify({'error': 'This endpoint is only for custom assets'}), 400

        # Check if asset is in this event
        if asset_id not in event.prepared_items:
            return jsonify({'error': 'Custom asset is not assigned to this event'}), 400

        # Remove the asset from prepared_items
        event.prepared_items.remove(asset_id)
        logger.info(f"Removed {asset_id} from prepared_items")

        # Initialize lists if they don't exist
        if not hasattr(event, 'actually_prepared'):
            event.actually_prepared = []
        if not hasattr(event, 'extra_assets'):
            event.extra_assets = []

        # Remove from actually_prepared if it was there
        if asset_id in event.actually_prepared:
            event.actually_prepared.remove(asset_id)
            logger.info(f"Removed {asset_id} from actually_prepared")

        # Remove from returned_items if it was there
        if asset_id in event.returned_items:
            event.returned_items.remove(asset_id)
            logger.info(f"Removed {asset_id} from returned_items")

        # Remove from extra_assets if it was there
        if asset_id in event.extra_assets:
            event.extra_assets.remove(asset_id)
            logger.info(f"Removed {asset_id} from extra_assets")

        # Update event state
        update_event_state(event)

        # Save changes
        data_manager.save_event(event)

        # Invalidate cache
        invalidate_cache()

        log_action(f"Removed custom asset {asset_id} from event {event_id}")

        return jsonify({'success': True, 'message': f'Custom asset {asset_id} removed from event'})
        
    except Exception as e:
        logger.error(f"Error removing custom asset from event {event_id}: {e}")
        import traceback
        logger.error(f"Traceback: {traceback.format_exc()}")
        return jsonify({'error': 'Failed to remove custom asset from event'}), 500

@app.route('/api/events/update-states', methods=['POST'])
@require_auth
def update_all_event_states():
    """Manually trigger state updates for all events"""
    try:
        current_date = datetime.now().strftime('%Y%m%d')
        updated_events = []
        
        for event in data_manager.events.values():
            old_state = event.state
            update_event_state(event)
            
            if event.state != old_state:
                data_manager.save_event(event)
                updated_events.append({
                    'eventId': event.event_id,
                    'name': event.name,
                    'oldState': old_state,
                    'newState': event.state
                })
                logger.info(f"Event {event.event_id} state changed from {old_state} to {event.state}")
        
        if updated_events:
            invalidate_cache()
        
        return jsonify({
            'success': True, 
            'message': f'Updated {len(updated_events)} events',
            'updatedEvents': updated_events
        })
        
    except Exception as e:
        logger.error(f"Error updating event states: {e}")
        return jsonify({'error': 'Failed to update event states'}), 500

@app.route('/api/events/<int:event_id>/force-state', methods=['POST'])
@require_auth
def force_event_state(event_id):
    """Force an event to a specific state"""
    try:
        data = request.get_json()
        new_state = data.get('state')
        
        # Validate state
        valid_states = ['Added', 'Planning', 'Preparing', 'Ready', 'Ongoing', 'Returning', 'Closed', 'Overdue']
        if new_state not in valid_states:
            return jsonify({'error': f'Invalid state. Must be one of: {valid_states}'}), 400
            
        # Get the event
        event = data_manager.events.get(event_id)
        if not event:
            return jsonify({'error': 'Event not found'}), 404
            
        # Store old state for logging
        old_state = event.state
        
        # Force the new state and set override flag
        event.state = new_state
        event.force_state_override = True
        
        # Save the event
        data_manager.save_event(event)
        
        # Log the action
        username = session.get('user', 'Unknown')
        log_action(f"User {username} forced event {event_id} ({event.name}) state from {old_state} to {new_state}")
        
        # Invalidate cache
        invalidate_cache()
        
        return jsonify({
            'success': True,
            'message': f'Event {event_id} state forced to {new_state}',
            'eventId': event_id,
            'oldState': old_state,
            'newState': new_state
        })
        
    except Exception as e:
        logger.error(f"Error forcing event state: {e}")
        import traceback
        logger.error(f"Traceback: {traceback.format_exc()}")
        return jsonify({'error': 'Failed to force event state'}), 500

@app.route('/api/events/<int:event_id>/remove-force-state', methods=['POST'])
@require_auth
def remove_force_state(event_id):
    """Remove forced state override and return to automatic state management"""
    try:
        # Get the event
        event = data_manager.events.get(event_id)
        if not event:
            return jsonify({'error': 'Event not found'}), 404
            
        # Store old state for logging
        old_state = event.state
        
        # Remove the override flag
        event.force_state_override = False
        
        # Update state automatically
        update_event_state(event)
        
        # Save the event
        data_manager.save_event(event)
        
        # Log the action
        username = session.get('user', 'Unknown')
        log_action(f"User {username} removed forced state override for event {event_id} ({event.name}): {old_state} -> {event.state}")
        
        # Invalidate cache
        invalidate_cache()
        
        return jsonify({
            'success': True,
            'message': f'Event {event_id} returned to automatic state management',
            'eventId': event_id,
            'oldState': old_state,
            'newState': event.state
        })
        
    except Exception as e:
        logger.error(f"Error removing forced state: {e}")
        import traceback
        logger.error(f"Traceback: {traceback.format_exc()}")
        return jsonify({'error': 'Failed to remove forced state'}), 500

# Error handlers


@app.errorhandler(404)
def not_found(error):
    return jsonify({'error': 'Not found'}), 404


@app.errorhandler(500)
def internal_error(error):
    logger.error(f"Internal server error: {error}")
    return jsonify({'error': 'Internal server error'}), 500


@app.errorhandler(Exception)
def handle_exception(e):
    logger.error(f"Unhandled exception: {e}")
    return jsonify({'error': 'An unexpected error occurred'}), 500

def check_and_update_ongoing_events():
    """Periodically check if ready events should become ongoing or overdue"""
    try:
        if data_manager is None:
            logger.warning("data_manager is None, cannot check events")
            return
            
        if not hasattr(data_manager, 'events') or data_manager.events is None:
            logger.warning("data_manager.events is None or missing, cannot check events")
            return
            
        current_date = datetime.now().strftime('%Y%m%d')
        updated_count = 0
        
        logger.info(f"Checking {len(data_manager.events)} events for state updates (current date: {current_date})")
        
        for event in data_manager.events.values():
            old_state = event.state
            
            # Log event details for debugging overdue detection
            has_unreturned = len(getattr(event, 'actually_prepared', [])) > len(getattr(event, 'returned_items', []))
            is_past_end = current_date > event.end_date
            
            # (DEBUG)
            # logger.info(f"Event {event.event_id}: {event.name}")
            # logger.info(f"  State: {old_state}, End: {event.end_date}, Current: {current_date}")
            # logger.info(f"  Past end date: {is_past_end}, Has unreturned assets: {has_unreturned}")
            # logger.info(f"  Actually prepared: {len(getattr(event, 'actually_prepared', []))}, Returned: {len(getattr(event, 'returned_items', []))}")
            
            # Always call update_event_state to check for state changes
            update_event_state(event)
            
            if event.state != old_state:
                data_manager.save_event(event)
                updated_count += 1
                ##logger.info(f"  *** STATE CHANGED: {old_state} → {event.state} ***")

                ##DEBUG
            # else:
            #     logger.info(f"  No state change (remains {event.state})")
        
        if updated_count > 0:
            invalidate_cache()
            logger.info(f"Updated {updated_count} events (ongoing/overdue status)")
        else:
            logger.info("No events required state updates")
            
    except Exception as e:
        logger.error(f"Error checking ongoing/overdue events: {e}")
        import traceback
        logger.error(f"Traceback: {traceback.format_exc()}")

def _client_to_dict(c):
    # Handles both model instances and plain dicts defensively
    get = (lambda k, d='': getattr(c, k, getattr(c, k.replace('postalCode', 'postal_code'), d)))
    return {
        'name': get('name'),
        'company': get('company'),
        'address1': get('address1'),
        'address2': get('address2'),
        'address3': get('address3'),
        'postalCode': getattr(c, 'postal_code', getattr(c, 'postalCode', '')),
        'phone': get('phone'),
    }


@app.route('/api/clients', methods=['GET', 'POST'])
@require_auth
def clients_collection():
    if request.method == 'GET':
        query = (request.args.get('query') or '').strip().lower()
        data = []
        for c in data_manager.clients.values():
            name = (getattr(c, 'name', '') or '').strip().lower()
            company = (getattr(c, 'company', '') or '').strip().lower()
            if not query or (query in name) or (query in company):
                data.append(_client_to_dict(c))
        return jsonify({'success': True, 'data': data})


    # POST (create or upsert)
    data = request.get_json(force=True) or {}
    name = (data.get('name') or '').strip()
    if not name:
        return jsonify({'success': False, 'message': 'Client name is required'}), 400

    from models import Client
    c = Client(
        name=name,
        company=(data.get('company') or '').strip(),
        address1=(data.get('address1') or '').strip(),
        address2=(data.get('address2') or '').strip(),
        address3=(data.get('address3') or '').strip(),
        postal_code=(data.get('postalCode') or '').strip(),
        phone=(data.get('phone') or '').strip(),
    )
    data_manager.clients[name] = c
    data_manager.save_clients()
    log_action(f"Saved client {name}")
    return jsonify({'success': True, 'data': _client_to_dict(c)})

@app.route('/api/clients/<name>', methods=['GET', 'PUT', 'DELETE'])
@require_auth
def client_item(name):
    key = unquote_plus(name)
    c = data_manager.clients.get(key)
    if request.method == 'GET':
        if not c:
            return jsonify({'success': False, 'message': 'Not found'}), 404
        return jsonify({'success': True, 'data': _client_to_dict(c)})

    if request.method == 'PUT':
        if not c:
            return jsonify({'success': False, 'message': 'Not found'}), 404
        data = request.get_json(force=True) or {}
        c.company = (data.get('company') or c.company).strip()
        c.address1 = (data.get('address1') or c.address1).strip()
        c.address2 = (data.get('address2') or c.address2).strip()
        c.address3 = (data.get('address3') or c.address3).strip()
        c.postal_code = (data.get('postalCode') or c.postal_code).strip()
        c.phone = (data.get('phone') or c.phone).strip()
        data_manager.save_clients()
        log_action(f"Updated client {key}")
        return jsonify({'success': True, 'data': _client_to_dict(c)})

    # DELETE (admin)
    if not c:
        return jsonify({'success': False, 'message': 'Not found'}), 404
    if not session.get('is_admin', False):
        return jsonify({'error': 'Admin privileges required'}), 403
    del data_manager.clients[key]
    data_manager.save_clients()
    log_action(f"Deleted client {key}")
    return jsonify({'success': True})

if __name__ == '__main__':
    try:
        # Initialize data manager
        init_data_manager()
        
        # Start the background thread AFTER data_manager is initialized
        background_started = start_background_thread()
        if not background_started:
            logger.warning("Background thread failed to start - automatic event updates disabled")
        else:
            logger.info("Background thread started successfully after data_manager initialization")

        # Run the Flask app
        app.run(debug=True, host='127.0.0.1', port=5000)
        logger.info("app starteded")
    except Exception as e:
        logger.error(f"Failed to start application: {e}")
        raise
