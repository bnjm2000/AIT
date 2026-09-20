"""Company client directory endpoints; saved documents retain their own snapshots."""

from urllib.parse import unquote_plus

from flask import jsonify, request

from services.clients import (
    client_from_payload,
    client_is_active,
    client_key,
    client_to_dict,
    normalise_client,
)


def register_client_routes(app, *, data_manager, require_client_access, log_action):
    @app.route('/api/clients', methods=['GET', 'POST'])
    @require_client_access
    def clients_collection():
        if request.method == 'GET':
            query = (request.args.get('query') or '').strip().casefold()
            data = []
            for c in sorted(
                data_manager.clients.values(),
                key=lambda row: (
                    str(getattr(row, 'company', '') or '').casefold(),
                    str(getattr(row, 'name', '') or '').casefold(),
                ),
            ):
                if not client_is_active(c):
                    continue
                payload = client_to_dict(c)
                searchable = ' '.join(str(value or '') for value in payload.values()).casefold()
                if not query or query in searchable:
                    data.append(payload)
            return jsonify({'success': True, 'data': data})

        # POST (create)
        data = request.get_json(force=True) or {}
        client = normalise_client(data)
        name = client['name']
        if not name:
            return jsonify({'success': False, 'error': 'Client name is required'}), 400

        existing_key = client_key(data_manager, name)
        if existing_key and client_is_active(data_manager.clients.get(existing_key)):
            return jsonify({
                'success': False,
                'error': f'A client named {name} already exists',
            }), 409
        if existing_key:
            del data_manager.clients[existing_key]
        storage_key = name
        client['name'] = name
        c = client_from_payload(client, is_active=True)
        data_manager.clients[storage_key] = c
        data_manager.save_clients()
        log_action(f"Saved client {storage_key}")
        return jsonify({'success': True, 'data': client_to_dict(c)})

    @app.route('/api/clients/<name>', methods=['GET', 'PUT', 'DELETE'])
    @require_client_access
    def client_item(name):
        key = client_key(data_manager, unquote_plus(name))
        c = data_manager.clients.get(key)
        if c and not client_is_active(c):
            c = None
        if request.method == 'GET':
            if not c:
                return jsonify({'success': False, 'error': 'Client not found'}), 404
            return jsonify({'success': True, 'data': client_to_dict(c)})

        if request.method == 'PUT':
            if not c:
                return jsonify({'success': False, 'error': 'Client not found'}), 404
            data = request.get_json(force=True) or {}
            merged = client_to_dict(c)
            for field in merged:
                if field in data:
                    merged[field] = data.get(field)
            updated = normalise_client(merged)
            updated_name = updated['name']
            if not updated_name:
                return jsonify({'success': False, 'error': 'Client name is required'}), 400
            destination_key = client_key(data_manager, updated_name)
            if destination_key and destination_key != key:
                return jsonify({
                    'success': False,
                    'error': f'A client named {updated_name} already exists',
                }), 409

            updated_client = client_from_payload(updated)
            if key != updated_name:
                del data_manager.clients[key]
            data_manager.clients[updated_name] = updated_client
            data_manager.save_clients()
            log_action(
                f"Renamed client {key} to {updated_name}"
                if key != updated_name
                else f"Updated client {key}"
            )
            return jsonify({'success': True, 'data': client_to_dict(updated_client)})

        # DELETE removes the record from future suggestions while keeping the
        # client details already embedded in quotations, invoices, and delivery orders.
        if not c:
            return jsonify({'success': False, 'error': 'Client not found'}), 404
        c.is_active = False
        data_manager.save_clients()
        log_action(f"Removed client {key} from client directory")
        return jsonify({'success': True})
