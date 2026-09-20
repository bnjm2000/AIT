"""Asset Check HTTP endpoints, eligibility rules, and sighting history.

The manager is a request-local proxy. Shared inventory and notification policies
are supplied at registration, so this module never imports application state.
"""

import secrets
import time
from datetime import datetime

from flask import jsonify, request, session

from maintenance_logs import (
    ASSET_CHECK_LOG_TYPE,
    make_change,
    make_maintenance_log,
    normalize_maintenance_log,
)
from models import normalize_asset_tags


def register_asset_check_routes(
    app, *, data_manager, require_auth, logger, find_asset, asset_group_key,
    is_real_asset_ref, is_bulk_asset, is_disposed, is_untagged, is_degraded,
    condition_status, condition_statuses, apply_status, notification_status,
    notify_status, request_bool, invalidate_cache, log_action,
):
    """Register all four Asset Check operations with the shared inventory policy."""
    def _asset_check_is_store_location(asset):
        """Asset Check only counts items that are physically in Store."""
        location = str(
            getattr(asset, 'current_location', '') or
            getattr(asset, 'default_location', '') or
            'Store'
        ).strip()

        return not location or location.lower() == 'store'


    def _asset_check_deployment(asset_id):
        """Return active event information if the asset is currently out on show/dry hire."""
        if not asset_id:
            return None

        for event in data_manager.events.values():
            returned_items = {str(x).strip() for x in (getattr(event, 'returned_items', []) or [])}

            active_refs = []
            for value in (getattr(event, 'actually_prepared', []) or []):
                if isinstance(value, str) and is_real_asset_ref(value):
                    active_refs.append(value.strip())

            # Older files may only have direct asset IDs in prepared_items.
            for value in (getattr(event, 'prepared_items', []) or []):
                if isinstance(value, str) and is_real_asset_ref(value):
                    active_refs.append(value.strip())

            if asset_id in active_refs and asset_id not in returned_items:
                return {
                    'eventId': event.event_id,
                    'eventName': getattr(event, 'name', ''),
                    'eventState': getattr(event, 'state', ''),
                    'eventTag': getattr(event, 'tag', 'event')
                }

        return None


    def _asset_check_group_display_from_key(group_key):
        dept, brand, model, description = group_key
        return f"[{dept}] {brand} {model} {description}".strip()


    def _asset_check_asset_to_dict(asset, group_key):
        location = str(
            getattr(asset, 'current_location', '') or
            getattr(asset, 'default_location', '') or
            'Store'
        ).strip() or 'Store'

        deployment = None if is_bulk_asset(asset) else _asset_check_deployment(asset.asset_id)

        excluded = False
        exclusion_reason = ''
        status = 'unchecked'

        if is_bulk_asset(asset):
            excluded = True
            exclusion_reason = 'Bulk quantity asset - no individual Asset ID to check'
            status = 'bulk'
        elif is_disposed(asset):
            excluded = True
            exclusion_reason = 'Decommissioned asset - no longer in usable inventory'
            status = 'decommissioned'
        elif getattr(asset, 'is_missing', False):
            excluded = True
            exclusion_reason = 'Already marked Missing'
            status = 'missing'
        elif deployment:
            excluded = True
            tag = 'Dry Hire' if deployment.get('eventTag') == 'dry hire' else 'Event'
            exclusion_reason = f"Out on {tag} {deployment.get('eventId')}: {deployment.get('eventName')}"
            status = 'deployed'
        elif not _asset_check_is_store_location(asset):
            excluded = True
            exclusion_reason = f"Away from Store: {location}"
            status = 'away'
        elif getattr(asset, 'is_ooc', False):
            # OOC items that are still in Store can still be physically checked.
            status = 'ooc'
        elif is_untagged(asset):
            status = 'untagged'
        elif is_degraded(asset):
            status = 'degraded'

        return {
            'id': '' if is_bulk_asset(asset) else asset.asset_id,
            'internalId': asset.asset_id,
            'brand': asset.brand,
            'model': asset.model_number,
            'description': asset.description or '',
            'tags': normalize_asset_tags(getattr(asset, 'tags', [])),
            'serial': asset.serial_number or '',
            'serial2': getattr(asset, 'secondary_serial_number', '') or '',
            'department': asset.department_code,
            'location': location,
            'defaultLocation': getattr(asset, 'default_location', '') or 'Store',
            'currentLocation': getattr(asset, 'current_location', '') or '',
            'isMissing': bool(getattr(asset, 'is_missing', False)),
            'isOOC': bool(getattr(asset, 'is_ooc', False)),
            'isUntagged': is_untagged(asset),
            'isDegraded': is_degraded(asset),
            'isDisposed': is_disposed(asset),
            'isBulk': bool(is_bulk_asset(asset)),
            'deployment': deployment,
            'status': status,
            'checkEligible': not excluded,
            'excluded': excluded,
            'exclusionReason': exclusion_reason,
            'groupKey': '|'.join(group_key),
            'groupDisplay': _asset_check_group_display_from_key(group_key)
        }


    def _asset_check_build_group(seed_asset):
        if not seed_asset:
            raise ValueError('Asset not found')

        group_key = asset_group_key(seed_asset)
        group_assets = [
            asset for asset in data_manager.inventory.values()
            if asset and asset_group_key(asset) == group_key
        ]

        group_assets.sort(key=lambda a: (
            bool(is_disposed(a)),
            bool(getattr(a, 'is_missing', False)),
            str(getattr(a, 'asset_id', '') or '').lower()
        ))

        assets_payload = [_asset_check_asset_to_dict(asset, group_key) for asset in group_assets]

        summary = {
            'total': len(assets_payload),
            'checkable': len([a for a in assets_payload if a['checkEligible']]),
            'excluded': len([a for a in assets_payload if a['excluded'] and not a['isMissing'] and not a.get('isDisposed')]),
            'missing': len([a for a in assets_payload if a['isMissing']]),
            'untagged': len([a for a in assets_payload if a.get('isUntagged')]),
            'decommissioned': len([a for a in assets_payload if a.get('isDisposed')]),
            'disposed': len([a for a in assets_payload if a.get('isDisposed')]),
        }

        dept, brand, model, description = group_key

        return {
            'group': {
                'key': '|'.join(group_key),
                'department': dept,
                'brand': brand,
                'model': model,
                'description': description,
                'displayName': _asset_check_group_display_from_key(group_key)
            },
            'assets': assets_payload,
            'summary': summary,
            'scannedAsset': _asset_check_asset_to_dict(seed_asset, group_key)
        }


    @app.route('/api/asset-check/group', methods=['POST'])
    @require_auth
    def asset_check_group():
        """Start/refresh an asset check group from a scanned Asset ID or Serial Number."""
        try:
            data = request.get_json() or {}
            identifier = str(data.get('identifier', '')).strip()

            if not identifier:
                return jsonify({'error': 'Asset ID or Serial Number is required'}), 400

            seed_asset = find_asset(identifier)
            if not seed_asset:
                return jsonify({'error': f'Asset or serial number not found: {identifier}'}), 404

            if is_bulk_asset(seed_asset):
                return jsonify({'error': 'Bulk quantity assets cannot start an Asset Check because they do not have individual Asset IDs'}), 400

            return jsonify({'success': True, 'data': _asset_check_build_group(seed_asset)})

        except Exception as e:
            logger.error(f"Error starting asset check: {e}")
            import traceback
            logger.error(f"Asset check traceback: {traceback.format_exc()}")
            return jsonify({'error': 'Failed to start Asset Check'}), 500


    def _asset_check_sighting_description(username):
        username = str(username or 'user').strip() or 'user'
        return f"Asset sighted by {username} during Asset Check"


    def _asset_check_log_matches_source(log_entry, check_id):
        record = normalize_maintenance_log(log_entry)
        source = record.get('source') or {}
        return (
            record.get('type') == ASSET_CHECK_LOG_TYPE and
            source.get('kind') == 'asset_check_sighting' and
            check_id and
            source.get('checkId') == check_id
        )


    def _asset_check_fallback_sighting_index(asset, username):
        """Find the latest same-day sighting log when an older client has no check id."""
        today = datetime.now().strftime("%Y/%m/%d")
        expected_description = _asset_check_sighting_description(username)

        for index in range(len(getattr(asset, 'maintenance_logs', []) or []) - 1, -1, -1):
            record = normalize_maintenance_log(asset.maintenance_logs[index])
            if (
                record.get('type') == ASSET_CHECK_LOG_TYPE and
                record.get('date') == today and
                record.get('user') == username and
                record.get('description') == expected_description
            ):
                return index

        return None


    @app.route('/api/asset-check/sighting', methods=['POST'])
    @require_auth
    def asset_check_sighting():
        """Add or remove the automatic Asset Check sighting maintenance log."""
        try:
            data = request.get_json() or {}
            asset_id = str(data.get('assetId') or data.get('identifier') or '').strip()
            group_key = str(data.get('groupKey') or '').strip()
            check_id = str(data.get('checkId') or '').strip()[:160]
            checked = request_bool(data.get('checked'), default=True)

            if not asset_id:
                return jsonify({'error': 'Asset ID is required'}), 400

            asset = find_asset(asset_id)
            if not asset:
                return jsonify({'error': 'Asset not found'}), 404

            if is_bulk_asset(asset):
                return jsonify({'error': 'Bulk quantity assets cannot be checked individually'}), 400

            actual_group_key = '|'.join(asset_group_key(asset))
            if group_key and group_key != actual_group_key:
                return jsonify({'error': 'Asset no longer matches this Asset Check group'}), 400

            asset_payload = _asset_check_asset_to_dict(asset, asset_group_key(asset))
            if not asset_payload.get('checkEligible'):
                return jsonify({'error': asset_payload.get('exclusionReason') or 'Asset is not eligible for this Asset Check'}), 400

            username = session.get('user', 'system')

            if checked:
                for existing_log in getattr(asset, 'maintenance_logs', []) or []:
                    if _asset_check_log_matches_source(existing_log, check_id):
                        return jsonify({
                            'success': True,
                            'message': 'Asset Check sighting already logged',
                            'data': {'assetId': asset.asset_id, 'checkId': check_id}
                        })

                if not check_id:
                    check_id = f"asset-check-{int(time.time() * 1000)}-{secrets.token_hex(6)}"

                today = datetime.now().strftime("%Y/%m/%d")
                source = {
                    'kind': 'asset_check_sighting',
                    'checkId': check_id,
                    'groupKey': group_key or actual_group_key,
                    'createdAt': datetime.now().isoformat(timespec='seconds')
                }
                asset.maintenance_logs.append(make_maintenance_log(
                    today,
                    username,
                    _asset_check_sighting_description(username),
                    [],
                    log_type=ASSET_CHECK_LOG_TYPE,
                    source=source
                ))
                data_manager.save_inventory()
                invalidate_cache()
                log_action(
                    f"Asset Check sighted asset {asset.asset_id}",
                    system_log_only=True,
                )

                return jsonify({
                    'success': True,
                    'message': 'Asset Check sighting logged',
                    'data': {'assetId': asset.asset_id, 'checkId': check_id}
                })

            remove_index = None
            if check_id:
                for index in range(len(getattr(asset, 'maintenance_logs', []) or []) - 1, -1, -1):
                    if _asset_check_log_matches_source(asset.maintenance_logs[index], check_id):
                        remove_index = index
                        break

            if remove_index is None:
                remove_index = _asset_check_fallback_sighting_index(asset, username)

            if remove_index is not None:
                asset.maintenance_logs.pop(remove_index)
                data_manager.save_inventory()
                invalidate_cache()
                log_action(
                    f"Asset Check sighting removed for asset {asset.asset_id}",
                    system_log_only=True,
                )

            return jsonify({
                'success': True,
                'message': 'Asset Check sighting removed',
                'data': {
                    'assetId': asset.asset_id,
                    'checkId': check_id,
                    'removed': remove_index is not None
                }
            })

        except Exception as e:
            logger.error(f"Error updating Asset Check sighting: {e}", exc_info=True)
            return jsonify({'error': 'Failed to update Asset Check sighting'}), 500


    @app.route('/api/asset-check/mark-untagged', methods=['POST'])
    @require_auth
    def asset_check_mark_untagged():
        """Mark one serial-identified asset Untagged and record it as sighted."""
        try:
            data = request.get_json() or {}
            asset_identifier = str(data.get('assetId') or data.get('identifier') or '').strip()
            group_key = str(data.get('groupKey') or '').strip()
            check_id = str(data.get('checkId') or '').strip()[:160]

            if not asset_identifier:
                return jsonify({'error': 'Asset ID or Serial Number is required'}), 400

            asset = find_asset(asset_identifier)
            if not asset:
                return jsonify({'error': 'Asset not found'}), 404
            if is_bulk_asset(asset):
                return jsonify({'error': 'Bulk quantity assets cannot be marked Untagged'}), 400

            actual_group_key = '|'.join(asset_group_key(asset))
            if group_key and group_key != actual_group_key:
                return jsonify({'error': 'Asset no longer matches this Asset Check group'}), 400

            asset_payload = _asset_check_asset_to_dict(asset, asset_group_key(asset))
            if not asset_payload.get('checkEligible'):
                return jsonify({
                    'error': asset_payload.get('exclusionReason') or 'Asset is not eligible for this Asset Check'
                }), 400

            username = session.get('user', 'system')
            today = datetime.now().strftime("%Y/%m/%d")
            created_at = datetime.now().isoformat(timespec='seconds')
            already_untagged = is_untagged(asset)

            if not check_id:
                check_id = f"asset-check-{int(time.time() * 1000)}-{secrets.token_hex(6)}"

            sighting_exists = any(
                _asset_check_log_matches_source(log_entry, check_id)
                for log_entry in (getattr(asset, 'maintenance_logs', []) or [])
            )
            if not sighting_exists:
                asset.maintenance_logs.append(make_maintenance_log(
                    today,
                    username,
                    _asset_check_sighting_description(username),
                    [],
                    log_type=ASSET_CHECK_LOG_TYPE,
                    source={
                        'kind': 'asset_check_sighting',
                        'checkId': check_id,
                        'groupKey': group_key or actual_group_key,
                        'createdAt': created_at,
                    },
                ))

            if not already_untagged:
                previous_status = condition_status(asset)
                status_changes = []
                if previous_status in condition_statuses:
                    status_changes.append(make_change(previous_status, action='cleared'))
                status_changes.append(make_change('untagged', action='marked'))
                apply_status(asset, 'untagged')
                asset.maintenance_logs.append(make_maintenance_log(
                    today,
                    username,
                    "Asset identified by serial number and marked Untagged during Asset Check",
                    status_changes,
                    log_type=ASSET_CHECK_LOG_TYPE,
                    source={
                        'kind': 'asset_check_untagged',
                        'checkId': check_id,
                        'groupKey': group_key or actual_group_key,
                        'createdAt': created_at,
                    },
                ))

            data_manager.save_inventory()
            invalidate_cache()
            if not already_untagged:
                log_action(
                    f"Asset Check marked asset {asset.asset_id} as Untagged",
                    system_log_only=True,
                )
                notify_status(
                    manager=data_manager,
                    asset=asset,
                    previous_status=previous_status,
                    new_status=notification_status(asset),
                )

            return jsonify({
                'success': True,
                'message': 'Asset marked Untagged and sighted',
                'data': {
                    'assetId': asset.asset_id,
                    'checkId': check_id,
                    'alreadyUntagged': already_untagged,
                },
            })
        except Exception as e:
            logger.error(f"Error marking Asset Check asset Untagged: {e}", exc_info=True)
            return jsonify({'error': 'Failed to mark asset as Untagged'}), 500


    @app.route('/api/asset-check/mark-missing', methods=['POST'])
    @require_auth
    def asset_check_mark_missing():
        """Mark unchecked, eligible Asset Check items as Missing after frontend confirmation."""
        try:
            data = request.get_json() or {}

            if not data.get('confirm'):
                return jsonify({'error': 'Confirmation is required before marking assets as missing'}), 400

            asset_ids = data.get('assetIds') or []
            group_key = str(data.get('groupKey', '') or '').strip()

            if not isinstance(asset_ids, list):
                return jsonify({'error': 'assetIds must be a list'}), 400

            asset_ids = [str(asset_id or '').strip() for asset_id in asset_ids if str(asset_id or '').strip()]
            if not asset_ids:
                return jsonify({'success': True, 'message': 'No unchecked assets to mark as missing', 'data': {'marked': [], 'skipped': []}})

            marked = []
            marked_status_changes = []
            skipped = []
            today = datetime.now().strftime("%Y/%m/%d")
            username = session.get('user', 'system')

            for asset_id in asset_ids:
                asset = data_manager.inventory.get(asset_id)

                if not asset:
                    skipped.append({'assetId': asset_id, 'reason': 'Asset not found'})
                    continue

                if is_bulk_asset(asset):
                    skipped.append({'assetId': asset_id, 'reason': 'Bulk quantity asset cannot be marked missing by Asset Check'})
                    continue

                if group_key and '|'.join(asset_group_key(asset)) != group_key:
                    skipped.append({'assetId': asset_id, 'reason': 'Asset no longer matches this Asset Check group'})
                    continue

                if getattr(asset, 'is_missing', False):
                    skipped.append({'assetId': asset_id, 'reason': 'Already marked Missing'})
                    continue

                deployment = _asset_check_deployment(asset.asset_id)
                if deployment:
                    skipped.append({'assetId': asset_id, 'reason': f"Currently out on Event {deployment.get('eventId')}"})
                    continue

                if not _asset_check_is_store_location(asset):
                    location = str(getattr(asset, 'current_location', '') or getattr(asset, 'default_location', '') or 'Store').strip() or 'Store'
                    skipped.append({'assetId': asset_id, 'reason': f'Away from Store: {location}'})
                    continue

                previous_status = notification_status(asset)
                apply_status(asset, 'missing')
                asset.maintenance_logs.append(make_maintenance_log(
                    today,
                    username,
                    "Asset Check - marked missing because this item was not checked",
                    [make_change('missing', action='marked')],
                    log_type=ASSET_CHECK_LOG_TYPE,
                    source={
                        'kind': 'asset_check_missing',
                        'groupKey': group_key,
                        'createdAt': datetime.now().isoformat(timespec='seconds')
                    }
                ))
                marked.append(asset_id)
                marked_status_changes.append((asset, previous_status))

            if marked:
                data_manager.save_inventory()
                invalidate_cache()
                log_action(
                    f"Asset Check marked {len(marked)} asset(s) as Missing: {', '.join(marked)}",
                    system_log_only=True,
                )
                for changed_asset, previous_status in marked_status_changes:
                    notify_status(
                        manager=data_manager,
                        asset=changed_asset,
                        previous_status=previous_status,
                        new_status=notification_status(changed_asset),
                    )

            return jsonify({
                'success': True,
                'message': f"Marked {len(marked)} asset(s) as Missing",
                'data': {
                    'marked': marked,
                    'skipped': skipped
                }
            })

        except Exception as e:
            logger.error(f"Error marking Asset Check missing assets: {e}")
            import traceback
            logger.error(f"Asset check mark missing traceback: {traceback.format_exc()}")
            return jsonify({'error': 'Failed to mark unchecked assets as Missing'}), 500
