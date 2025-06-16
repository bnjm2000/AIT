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
    _cache = {'assigned_assets': None, 'available_assets': None, 'cache_timestamp': None}

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
        total_assets = len(event.prepared_items)
        returned_count = len(event.returned_items)
        
        # Initialize actually_prepared if it doesn't exist
        if not hasattr(event, 'actually_prepared'):
            event.actually_prepared = []
        
        prepared_count = len([asset_id for asset_id in event.actually_prepared 
                            if asset_id in event.prepared_items])
        
        # Determine state based on asset counts
        if total_assets == 0:
            event.state = 'Added'
        elif prepared_count == 0:
            event.state = 'Planning'
        elif prepared_count < total_assets and returned_count == 0:
            event.state = 'Preparing'
        elif prepared_count == total_assets and returned_count == 0:
            event.state = 'Ready'
        elif returned_count > 0 and returned_count < total_assets:
            event.state = 'Returning'
        elif returned_count == total_assets:
            event.state = 'Closed'
        else:
            event.state = 'Planning'
            
        logger.debug(f"Event {event.event_id} state updated to {event.state}")
    except Exception as e:
        logger.error(f"Failed to update event state: {e}")
        event.state = 'Planning'  # Safe fallback

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
            
            events_data.append({
                'id': event.event_id,
                'name': event.name,
                'startDate': format_date_output(event.start_date),
                'endDate': format_date_output(event.end_date),
                'state': event.state,
                'assetCount': len(event.prepared_items),
                'preparedCount': len(event.actually_prepared),
                'returnedCount': len(event.returned_items),
                'assetModels': event.asset_models,
                'preparedItems': event.prepared_items,
                'returnedItems': event.returned_items
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
        
        # Initialize actually_prepared if it doesn't exist
        if not hasattr(event, 'actually_prepared'):
            event.actually_prepared = []
        
        # Get detailed asset information grouped by department
        assets_by_department = defaultdict(list)
        assigned_assets = []
        prepared_assets = []
        returned_assets = []
        
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
                    'isLoanOrMisc': True
                }
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
                        'isLoanOrMisc': False
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
        
        # Sort departments and assets within each department
        sorted_departments = {}
        for dept in sorted(assets_by_department.keys()):
            sorted_departments[dept] = sorted(assets_by_department[dept], key=lambda x: x['id'])
        
        event_data = {
            'id': event.event_id,
            'name': event.name,
            'startDate': format_date_output(event.start_date),
            'endDate': format_date_output(event.end_date),
            'state': event.state,
            'assetModels': event.asset_models,
            'preparedItems': event.prepared_items,
            'actuallyPrepared': event.actually_prepared,
            'returnedItems': event.returned_items,
            'assetsByDepartment': sorted_departments,
            'assignedAssets': assigned_assets,
            'preparedAssets': prepared_assets,
            'returnedAssets': returned_assets,
            'totalAssets': len(event.prepared_items),
            'totalPrepared': len(event.actually_prepared),
            'totalReturned': len(event.returned_items)
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
        start_date = datetime.strptime(data['startDate'], '%Y-%m-%d').strftime('%Y%m%d')
        end_date = datetime.strptime(data['endDate'], '%Y-%m-%d').strftime('%Y%m%d')
        
        # Create new event
        event = Event(
            event_id=event_id,
            name=data['name'].strip(),
            start_date=start_date,
            end_date=end_date,
            asset_models=[],
            prepared_items=[],
            state='Added',
            returned_items=[]
        )
        event.actually_prepared = []  # Initialize the new attribute
        
        # Save event
        data_manager.events[event_id] = event
        data_manager.save_event(event)
        
        # Invalidate cache
        invalidate_cache()
        
        log_action(f"Created event {event_id}: {data['name']} via web interface")
        
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
            event.start_date = datetime.strptime(data['startDate'], '%Y-%m-%d').strftime('%Y%m%d')
        if 'endDate' in data:
            event.end_date = datetime.strptime(data['endDate'], '%Y-%m-%d').strftime('%Y%m%d')
        
        # Update asset locations if event name changed
        if old_name != event.name:
            for asset_id in event.prepared_items:
                if asset_id not in event.returned_items:
                    asset = data_manager.inventory.get(asset_id)
                    if asset and asset.current_location == old_name:
                        asset.current_location = event.name
            data_manager.save_inventory()
        
        # Save event
        data_manager.save_event(event)
        
        log_action(f"Updated event {event_id}: {event.name} via web interface")
        
        return jsonify({'success': True, 'message': 'Event updated successfully'})
    except Exception as e:
        logger.error(f"Error updating event {event_id}: {e}")
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
        
        # Return all assets to store
        for asset_id in event.prepared_items.copy():
            asset = data_manager.inventory.get(asset_id)
            if asset and not asset_id.startswith('[LOAN]') and not asset_id.startswith('[MISC]'):
                asset.current_location = asset.default_location or ""
        
        # Save inventory changes
        data_manager.save_inventory()
        
        # Delete event
        del data_manager.events[event_id]
        data_manager.delete_event_file(event_id)
        
        # Invalidate cache
        invalidate_cache()
        
        log_action(f"Deleted event {event_id}: {event_name} via web interface")
        
        return jsonify({'success': True, 'message': 'Event deleted successfully'})
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
        
        log_action(f"Assigned asset {asset_id} to event {event_id} (unprepared)")
        
        return jsonify({'success': True, 'message': f'Asset {asset_id} assigned to event (unprepared)'})
    except Exception as e:
        logger.error(f"Error adding asset to event {event_id}: {e}")
        return jsonify({'error': 'Failed to add asset to event'}), 500

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
        
        # Initialize actually_prepared if it doesn't exist
        if not hasattr(event, 'actually_prepared'):
            event.actually_prepared = []
        
        # Check if asset is assigned to this event
        if asset_id not in event.prepared_items:
            return jsonify({'error': 'Asset is not assigned to this event'}), 400
        
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
    """Mark an asset as unprepared (uncheck from grocery list)"""
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
        
        # Remove from prepared list
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
        
        log_action(f"Unprepared asset {asset_id} from event {event_id}")
        
        return jsonify({'success': True, 'message': f'Asset {asset_id} unprepared'})
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
        
        # Remove the asset
        event.prepared_items.remove(asset_id)
        
        # Also remove from returned items if it was there
        if asset_id in event.returned_items:
            event.returned_items.remove(asset_id)
        
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
        
        log_action(f"Transferred asset {asset_id} from event {from_event_id} to event {event_id}")
        
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
        missing_fields = [field for field in required_fields if not data.get(field, '').strip()]
        if missing_fields:
            return jsonify({'error': f'Missing required fields: {", ".join(missing_fields)}'}), 400
        
        # Generate asset ID
        model_number = data['model'].upper().strip()
        existing_items = [item for item in data_manager.inventory.values() if item.model_number == model_number]
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
        asset = data_manager.inventory.get(asset_id)
        if not asset:
            return jsonify({'error': 'Asset not found'}), 404
        
        data = request.get_json()
        log_entry_text = data.get('logEntry', '').strip()
        new_location = data.get('newLocation', '').strip()
        mark_ooc = data.get('markOOC', False)
        unmark_ooc = data.get('unmarkOOC', False)
        
        if not log_entry_text:
            return jsonify({'error': 'Log entry is required'}), 400
        
        # Add maintenance log
        current_date = datetime.now().strftime("%Y/%m/%d")
        entry = f"{current_date}\t{session['user']}\t{log_entry_text}"
        asset.maintenance_logs.append(entry)
        
        # Update location if provided
        if new_location:
            asset.current_location = new_location
        
        # Update OOC status
        if mark_ooc:
            asset.is_ooc = True
        if unmark_ooc:
            asset.is_ooc = False
        
        # Save changes
        data_manager.save_inventory()
        
        # Invalidate cache
        invalidate_cache()
        
        log_action(f"Maintenance logged for asset {asset_id}: {log_entry_text}")
        
        return jsonify({'success': True, 'message': 'Maintenance logged successfully'})
    except Exception as e:
        logger.error(f"Error maintaining asset {asset_id}: {e}")
        return jsonify({'error': 'Failed to log maintenance'}), 500

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
            searchable_text = f"{asset.brand} {asset.model_number} {asset.description} {asset.serial_number}".lower()
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
            not any(keyword == x['model'].lower() for keyword in keywords),  # Exact model matches first
            not any(keyword in x['brand'].lower() for keyword in keywords),  # Brand matches second
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
        active_events = len([e for e in data_manager.events.values() if e.state not in ['Closed']])
        total_assets = len(data_manager.inventory)
        assigned_assets = get_assigned_assets()
        deployed_assets = len(assigned_assets)
        missing_assets = len([a for a in data_manager.inventory.values() if a.is_missing])
        ooc_assets = len([a for a in data_manager.inventory.values() if a.is_ooc])
        
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