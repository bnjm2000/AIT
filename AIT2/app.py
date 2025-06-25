from flask import Flask, render_template, request, jsonify, session, redirect, url_for
from flask_cors import CORS
from functools import wraps
import os
import json
from datetime import datetime
from collections import defaultdict
import logging

# Import your existing modules
from models import User, InventoryItem, Container, Event, LogEntry, hash_password, format_date_output
from data_manager import DataManager
from utils import get_state_color

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

    # Cache for 30 seconds
    now = datetime.now().timestamp()
    if (_cache['assigned_assets'] is not None and
        _cache['cache_timestamp'] is not None and
            now - _cache['cache_timestamp'] < 30):
        return _cache['assigned_assets']

    assigned_assets = set()
    for event in data_manager.events.values():
        for asset_id in event.prepared_items:
            if (asset_id not in event.returned_items and
                    not (asset_id.startswith('[LOAN]') or asset_id.startswith('[MISC]'))):
                assigned_assets.add(asset_id)

    _cache['assigned_assets'] = assigned_assets
    _cache['cache_timestamp'] = now
    return assigned_assets


def update_event_state(event):
    """Update the state of an event based on its prepared and returned items"""
    try:
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
                            
                            for specific_asset_id in event.actually_prepared:
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
            
            # Apply model-based state logic
            if total_model_requirements == 0:
                event.state = 'Added'
            elif total_specific_assignments == 0:
                event.state = 'Planning'
            elif total_specific_assignments < total_model_requirements and total_returned == 0:
                event.state = 'Preparing'
            elif total_specific_assignments == total_model_requirements and total_returned == 0:
                event.state = 'Ready'
            elif total_returned > 0 and total_returned < total_specific_assignments:
                event.state = 'Returning'
            elif total_returned == total_specific_assignments and total_returned == total_model_requirements:
                event.state = 'Closed'
            else:
                event.state = 'Planning'
        else:
            # Use old logic for events without model assignments - DON'T CHANGE THEIR STATE
            # Only update state if it's a very basic check
            total_assets = len(event.prepared_items)
            
            if total_assets == 0 and event.state == 'Added':
                # Keep as Added if no assets and currently Added
                pass
            # Don't force state changes for old events without model assignments
                
        logger.debug(f"Event {event.event_id} state: {event.state} (Model-based: {has_model_assignments})")
        
    except Exception as e:
        logger.error(f"Failed to update event state: {e}")

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
    except Exception as e:
        logger.error(f"Failed to initialize data manager: {e}")
        raise

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
                            
                            model_key = f"{dept}|{brand}|{model}"
                            
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
                'hasModelAssignments': has_model_assignments  # Flag to know which logic to use
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

        logger.info(f"Loading event {event_id} - Extra assets: {event.extra_assets}")
        logger.info(f"Loading event {event_id} - Actually prepared: {event.actually_prepared}")
        logger.info(f"Loading event {event_id} - Prepared items: {event.prepared_items}")

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
                # Handle model assignments - INCLUDE THESE IN assetsByDepartment
                try:
                    # Parse: [MODEL]DEPT|BRAND|MODEL|QUANTITY|DESCRIPTION
                    parts = asset_id[7:].split('|')
                    if len(parts) >= 4:
                        dept = parts[0]
                        brand = parts[1]
                        model = parts[2]
                        quantity = parts[3]
                        description = parts[4] if len(parts) > 4 else ''

                        # Clean display name - just brand and model
                        name = f"{quantity}x {brand} {model}"

                        # Determine status for model assignments
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
                            'isModel': True,
                            'quantity': quantity,
                            'brand': brand,
                            'model': model,
                            'description': description,
                            'isExtra': False  # Model assignments are never extra
                        }
                except Exception as e:
                    logger.error(
                        f"Error parsing model assignment {asset_id}: {e}")
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
                                        
                                        if (asset.department_code == req_dept and 
                                            asset.brand == req_brand and 
                                            asset.model_number == req_model):
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

                        model_key = f"{dept}|{brand}|{model}"

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
            'assetsByDepartment': sorted_departments,
            'assignedAssets': assigned_assets,
            'preparedAssets': prepared_assets,
            'returnedAssets': returned_assets,
            'totalAssets': total_required,
            'totalPrepared': total_prepared,
            'totalReturned': total_returned,
            'modelGroups': model_groups
        }

        return jsonify({'success': True, 'data': event_data})

    except Exception as e:
        logger.error(f"Error getting event {event_id}: {e}")
        return jsonify({'error': 'Failed to retrieve event'}), 500
    
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

        # Invalidate cache
        invalidate_cache()

        # Log the deletion with details of reset assets
        if assets_reset:
            log_action(f"Deleted event {event_id}: {event_name} via web interface. Reset {len(assets_reset)} asset locations: {', '.join(assets_reset[:5])}{'...' if len(assets_reset) > 5 else ''}")
        else:
            log_action(f"Deleted event {event_id}: {event_name} via web interface. No asset locations to reset.")

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

            # Check if asset is assigned to another active event
            assigned_assets = get_assigned_assets()
            if asset_id in assigned_assets:
                for other_event in data_manager.events.values():
                    if (other_event.event_id != event_id and
                        asset_id in other_event.prepared_items and
                            asset_id not in other_event.returned_items):
                        return jsonify({
                            'error': f'Asset is currently assigned to Event {other_event.event_id}: {other_event.name}'
                        }), 400

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

        if request.method == 'POST':
            # Add model assignment
            brand = data.get('brand', '').strip()
            model = data.get('model', '').strip()
            department = data.get('department', '').strip()
            provided_description = data.get('description', '').strip()  # Renamed to avoid confusion
            quantity = int(data.get('quantity', 1))

            if not brand or not model or not department:
                return jsonify({'error': 'Brand, model, and department are required'}), 400

            # Get the FULL description from the actual asset, not from the request
            # Find an actual asset of this brand/model to get the complete description
            full_description = provided_description  # Start with what was provided
            
            for asset in data_manager.inventory.values():
                if (asset.brand == brand and 
                    asset.model_number == model and 
                    asset.department_code == department):
                    full_description = asset.description
                    logger.info(f"Found matching asset {asset.asset_id} with full description: '{full_description}'")
                    break
            
            logger.info(f"Using description for {brand} {model}: '{full_description}'")

            # Check if this model already exists in the event
            existing_model_id = None
            existing_quantity = 0

            for item in event.prepared_items:
                if (item.startswith('[MODEL]') and
                    f"|{brand}|{model}|" in item and
                        item.startswith(f"[MODEL]{department}|")):
                    existing_model_id = item
                    # Extract existing quantity
                    parts = item[7:].split('|')
                    if len(parts) >= 4:
                        existing_quantity = int(parts[3])
                    break

            if existing_model_id:
                # Update existing model with new total quantity
                event.prepared_items.remove(existing_model_id)
                new_quantity = existing_quantity + quantity
            else:
                new_quantity = quantity

            # Create consolidated model assignment identifier with FULL description
            model_id = f"[MODEL]{department}|{brand}|{model}|{new_quantity}|{full_description}"
            logger.info(f"Creating model assignment: {model_id}")
            event.prepared_items.append(model_id)

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
            for item in event.prepared_items:
                if (item.startswith('[MODEL]') and
                    f"|{brand}|{model}|" in item and
                        item.startswith(f"[MODEL]{department}|")):
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
                            
                            # Check if this asset matches the model requirement
                            if (asset.department_code == dept and 
                                asset.brand == brand and 
                                asset.model_number == model):
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

@app.route('/api/events/<int:event_id>/unprepare', methods=['POST'])
@require_auth
def unprepare_event_asset(event_id):
    """Mark an asset as unprepared but keep it assigned to the event"""
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

        # Check if asset is prepared
        if asset_id not in event.actually_prepared:
            return jsonify({'error': 'Asset is not prepared'}), 400

        # LOG THE UNPREPARE ACTION
        log_asset_change(event_id, asset_id, "UNPREPARING", "removing from actually_prepared but keeping in event", "unprepare_event_asset")

        # Remove from prepared list BUT KEEP IN prepared_items (don't unassign)
        event.actually_prepared.remove(asset_id)
        
        # DO NOT remove from prepared_items - this was the bug!
        # The asset should stay assigned to the event, just marked as not prepared
        
        # Remove from extra_assets if it's there
        if hasattr(event, 'extra_assets') and asset_id in event.extra_assets:
            event.extra_assets.remove(asset_id)

        # For regular assets, reset location to default but keep assigned
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

        log_action(f"Unprepared asset {asset_id} from event {event_id} (but kept assigned)")

        return jsonify({'success': True, 'message': f'Asset {asset_id} unprepared (but still assigned to event)'})
    except Exception as e:
        logger.error(f"Error unpreparing asset from event {event_id}: {e}")
        return jsonify({'error': 'Failed to unprepare asset'}), 500

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

        # Remove from actually_prepared if it was there
        if asset_id in event.actually_prepared:
            event.actually_prepared.remove(asset_id)

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

        return jsonify({'success': True, 'message': f'Asset {asset_id} returned from event'})
    except Exception as e:
        logger.error(f"Error returning asset from event {event_id}: {e}")
        return jsonify({'error': 'Failed to return asset'}), 500

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
                for other_event in data_manager.events.values():
                    if (other_event.event_id != event_id and
                            asset_id in other_event.actually_prepared):
                        return jsonify({
                            'error': f'Asset is currently assigned to Event {other_event.event_id}: {other_event.name}'
                        }), 400

            # Check if this asset fulfills a model requirement
            fulfills_model_requirement = False
            
            logger.info(f"Checking if {asset_id} fulfills any model requirements...")
            
            # Check if this asset fulfills any model requirement
            for prepared_item in event.prepared_items:
                logger.info(f"Checking prepared item: {prepared_item}")
                
                if prepared_item.startswith('[MODEL]'):
                    try:
                        parts = prepared_item[7:].split('|')
                        logger.info(f"Model parts: {parts}")
                        
                        if len(parts) >= 4:
                            dept = parts[0]
                            brand = parts[1]
                            model = parts[2]
                            
                            logger.info(f"Model requirement - Dept: {dept}, Brand: {brand}, Model: {model}")
                            logger.info(f"Asset matches - Dept: {asset.department_code == dept}, Brand: {asset.brand == brand}, Model: {asset.model_number == model}")
                            
                            # Check if this asset matches the model requirement
                            if (asset.department_code == dept and 
                                asset.brand == brand and 
                                asset.model_number == model):
                                fulfills_model_requirement = True
                                logger.info(f"Asset {asset_id} fulfills model requirement {prepared_item}")
                                break
                    except Exception as e:
                        logger.error(f"Error parsing model assignment: {e}")
                        continue
            
            logger.info(f"Does {asset_id} fulfill a model requirement? {fulfills_model_requirement}")
            
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

            # Update asset location
            asset.current_location = event.name
            data_manager.save_inventory()

        # Add to actually_prepared if not already there
        if asset_id not in event.actually_prepared:
            event.actually_prepared.append(asset_id)
            logger.info(f"Added {asset_id} to actually_prepared. List now: {event.actually_prepared}")

        # Log final state before saving
        logger.info(f"Final state before saving:")
        logger.info(f"  Actually prepared: {event.actually_prepared}")
        logger.info(f"  Extra assets: {event.extra_assets}")

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
            return jsonify({'error': 'Asset is not assigned to this event'}), 400

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

@app.route('/api/events/<int:event_id>/assets/<asset_id>', methods=['DELETE'])
@require_auth
def remove_asset_from_event(event_id, asset_id):
    """Remove an asset from an event"""
    try:
        event = data_manager.events.get(event_id)
        if not event:
            return jsonify({'error': 'Event not found'}), 404

        # Check if asset is in this event
        if asset_id not in event.prepared_items:
            return jsonify({'error': 'Asset is not assigned to this event'}), 400

        # LOG THE REMOVAL
        log_asset_change(event_id, asset_id, "REMOVING", "from prepared_items via DELETE endpoint", "remove_asset_from_event")

        # Remove the asset
        event.prepared_items.remove(asset_id)

        # Also remove from returned items if it was there
        if asset_id in event.returned_items:
            event.returned_items.remove(asset_id)
            log_asset_change(event_id, asset_id, "REMOVING", "from returned_items", "remove_asset_from_event")

        # Initialize actually_prepared if it doesn't exist
        if not hasattr(event, 'actually_prepared'):
            event.actually_prepared = []

        # Remove from actually_prepared if it was there
        if asset_id in event.actually_prepared:
            event.actually_prepared.remove(asset_id)
            log_asset_change(event_id, asset_id, "REMOVING", "from actually_prepared", "remove_asset_from_event")

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
                'maintenanceLogs': asset.maintenance_logs[-5:]  # Last 5 logs
            })

        return jsonify({'success': True, 'data': assets_data})
    except Exception as e:
        logger.error(f"Error getting assets: {e}")
        return jsonify({'error': 'Failed to retrieve assets'}), 500


@app.route('/api/assets/available', methods=['GET'])
@require_auth
def get_available_assets():
    """Get all assets that are available for assignment"""
    try:
        assigned_assets = get_assigned_assets()

        # Filter available assets
        available_assets = []
        for asset in data_manager.inventory.values():
            if (asset.asset_id not in assigned_assets and
                not asset.is_missing and
                    not asset.is_ooc):

                available_assets.append({
                    'id': asset.asset_id,
                    'brand': asset.brand,
                    'model': asset.model_number,
                    'description': asset.description,
                    'serial': asset.serial_number,
                    'department': asset.department_code,
                    'location': asset.current_location or asset.default_location
                })

        # Sort by department, then by asset ID
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
        asset_id = unquote(asset_id)
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

        # Add maintenance log with the specified or current date
        entry = f"{formatted_date}\t{session['user']}\t{log_entry_text}"
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

@app.route('/api/assets/<asset_id>/maintenance-log/<int:log_index>', methods=['PUT'])
@require_auth
def update_maintenance_log(asset_id, log_index):
    """Update a specific maintenance log entry"""
    try:
        logger.info(f"Received maintenance log update request for asset: '{asset_id}', log index: {log_index}")
        
        # URL decode the asset_id in case it has special characters
        from urllib.parse import unquote
        asset_id = unquote(asset_id)
        
        asset = data_manager.inventory.get(asset_id)
        if not asset:
            return jsonify({'error': 'Asset not found'}), 404

        data = request.get_json()
        if not data:
            return jsonify({'error': 'No data provided'}), 400
            
        new_description = data.get('description')
        if not new_description or not new_description.strip():
            return jsonify({'error': 'Description is required'}), 400
        
        new_description = new_description.strip()
        
        # Check if log index is valid
        if not asset.maintenance_logs or log_index < 0 or log_index >= len(asset.maintenance_logs):
            return jsonify({'error': 'Invalid log index'}), 400
        
        # Parse the existing log entry
        log_parts = asset.maintenance_logs[log_index].split('\t')
        if len(log_parts) < 3:
            return jsonify({'error': 'Invalid log format'}), 400
        
        # Keep date and user, update description
        original_date = log_parts[0]
        original_user = log_parts[1]
        original_description = '\t'.join(log_parts[2:])  # In case description contained tabs
        
        # Create updated log entry
        updated_log = f"{original_date}\t{original_user}\t{new_description}"
        asset.maintenance_logs[log_index] = updated_log
        
        # Save changes
        data_manager.save_inventory()
        
        # Log the action
        log_action(f"Updated maintenance log for asset {asset_id}: '{original_description}' -> '{new_description}' (edited by {session['user']})")
        
        logger.info(f"Successfully updated maintenance log for asset {asset_id}")
        return jsonify({'success': True, 'message': 'Maintenance log updated successfully'})
        
    except Exception as e:
        logger.error(f"Error updating maintenance log for asset {asset_id}: {e}")
        import traceback
        logger.error(f"Traceback: {traceback.format_exc()}")
        return jsonify({'error': f'Failed to update maintenance log: {str(e)}'}), 500

@app.route('/api/assets/<asset_id>/maintenance-log/<int:log_index>', methods=['DELETE'])
@require_auth
def delete_maintenance_log(asset_id, log_index):
    """Delete a specific maintenance log entry"""
    try:
        logger.info(f"Received maintenance log delete request for asset: '{asset_id}', log index: {log_index}")
        
        # URL decode the asset_id in case it has special characters
        from urllib.parse import unquote
        asset_id = unquote(asset_id)
        
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
        # Get last 100 logs
        logs_data = []
        for log in data_manager.logs[-100:]:
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
        total_events = len(data_manager.events)
        active_events = len(
            [e for e in data_manager.events.values() if e.state not in ['Closed']])
        total_assets = len(data_manager.inventory)
        assigned_assets = get_assigned_assets()
        deployed_assets = len(assigned_assets)
        missing_assets = len(
            [a for a in data_manager.inventory.values() if a.is_missing])
        ooc_assets = len(
            [a for a in data_manager.inventory.values() if a.is_ooc])

        return jsonify({
            'success': True,
            'data': {
                'totalEvents': total_events,
                'activeEvents': active_events,
                'totalAssets': total_assets,
                'deployedAssets': deployed_assets,
                'missingAssets': missing_assets,
                'oocAssets': ooc_assets
            }
        })
    except Exception as e:
        logger.error(f"Error getting stats: {e}")
        return jsonify({'error': 'Failed to retrieve statistics'}), 500

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


if __name__ == '__main__':
    try:
        # Initialize data manager
        init_data_manager()

        # Run the Flask app
        app.run(debug=True, host='127.0.0.1', port=5000)
    except Exception as e:
        logger.error(f"Failed to start application: {e}")
        raise
