"""Transfers between events and Store: candidates, execution, and undo.

Shared preparation, authorization, and locking policies are supplied by the app.
The data manager remains a request-local proxy throughout each operation.
"""

from collections import defaultdict

from flask import jsonify, request

from models import format_date_output, normalize_asset_tags


def register_transfer_routes(
    app, *, data_manager, require_auth, require_event_access, with_transfer_action_lock,
    logger, invalidate_cache, log_action, refresh_event_states_for_read, update_event_state,
    active_asset_refs, asset_group, asset_status, can_access_event, ensure_model_requirement,
    access_denied, asset_log_item, find_subproject, assign_subproject_ref, subproject_item_group,
    subproject_prepared_quantity, subproject_refs, remove_subproject_ref, is_bulk_asset,
    is_degraded, is_disposed, is_real_asset_ref, is_untagged, log_asset_action,
    parse_model_marker, remove_direct_asset_ref, safe_int,
):
    def _ensure_event_lists(event):
        """Make old event files safe to work with."""
        if not hasattr(event, 'prepared_items') or event.prepared_items is None:
            event.prepared_items = []
        if not hasattr(event, 'returned_items') or event.returned_items is None:
            event.returned_items = []
        if not hasattr(event, 'actually_prepared') or event.actually_prepared is None:
            event.actually_prepared = []
        if not hasattr(event, 'extra_assets') or event.extra_assets is None:
            event.extra_assets = []


    def _event_summary_for_transfer(event):
        _ensure_event_lists(event)
        unreturned_count = len(_get_unreturned_real_asset_ids(event))
        required_count = 0
        for item in getattr(event, 'prepared_items', []) or []:
            requirement = _model_marker_to_requirement(item)
            if requirement:
                required_count += int(requirement.get('quantity', 0) or 0)
        return {
            'id': event.event_id,
            'name': event.name,
            'startDate': format_date_output(event.start_date),
            'endDate': format_date_output(event.end_date),
            'location': getattr(event, 'location', '') or '',
            'state': event.state,
            'tag': getattr(event, 'tag', 'events'),
            'unreturnedCount': unreturned_count,
            'requiredCount': required_count,
            'assetCount': len([x for x in event.prepared_items if isinstance(x, str) and not x.startswith('[MODEL]')]),
            'subprojects': [
                {
                    'id': str(row.get('id') or ''),
                    'name': str(row.get('name') or 'Unnamed room'),
                }
                for row in (getattr(event, 'subprojects', []) or [])
                if isinstance(row, dict) and str(row.get('id') or '').strip()
            ],
        }


    def _norm(value, uppercase=False):
        value = str(value or '').strip()
        return value.upper() if uppercase else value.casefold()


    def _asset_match_key(asset):
        return (
            _norm(getattr(asset, 'department_code', ''), True),
            _norm(getattr(asset, 'brand', '')),
            _norm(getattr(asset, 'model_number', '')),
            _norm(getattr(asset, 'description', '')),
        )


    def _model_marker_to_requirement(marker):
        parsed = parse_model_marker(marker)
        if not parsed:
            return None

        try:
            quantity = int(parsed.get('quantity') or 0)
        except Exception:
            quantity = 0

        if quantity <= 0:
            return None

        return {
            'department': parsed['department'],
            'brand': parsed['brand'],
            'model': parsed['model'],
            'description': parsed.get('description', ''),
            'quantity': quantity,
            'key': (
                _norm(parsed['department'], True),
                _norm(parsed['brand']),
                _norm(parsed['model']),
                _norm(parsed.get('description', '')),
            )
        }


    def _get_unreturned_real_asset_ids(event):
        """Return real inventory asset IDs that are still physically out for an event."""
        _ensure_event_lists(event)
        returned = set(event.returned_items)

        # Most current web workflows put prepared physical assets in actually_prepared.
        # Keep prepared_items as a fallback for older event files.
        candidates = []
        for asset_id in list(event.actually_prepared) + list(event.prepared_items):
            if not is_real_asset_ref(asset_id):
                continue
            if asset_id in returned:
                continue
            if asset_id not in data_manager.inventory:
                continue
            if asset_id not in candidates:
                candidates.append(asset_id)

        return candidates


    def _transfer_target_subproject(event, subproject_id):
        rooms = [
            row for row in (getattr(event, 'subprojects', []) or [])
            if isinstance(row, dict) and str(row.get('id') or '').strip()
        ]
        if not rooms:
            return None

        clean_id = str(subproject_id or '').strip()
        if clean_id:
            room = find_subproject(event, clean_id)
            if room:
                return room
            raise ValueError('Destination sub-project was not found')
        if len(rooms) == 1:
            return rooms[0]
        raise ValueError('Choose a destination sub-project')


    def _target_model_requirements(event, subproject=None):
        """Return target [MODEL] requirements with already-prepared counts and remaining counts."""
        _ensure_event_lists(event)

        requirements = {}
        if subproject:
            for item in subproject.get('items') or []:
                group = subproject_item_group(item)
                if not group:
                    continue
                quantity = max(0, safe_int(item.get('quantity'), 0))
                if quantity <= 0:
                    continue
                key = (
                    _norm(group['department'], True),
                    _norm(group['brand']),
                    _norm(group['model']),
                    _norm(group.get('description', '')),
                )
                if key not in requirements:
                    requirements[key] = {
                        'department': group['department'],
                        'brand': group['brand'],
                        'model': group['model'],
                        'description': group.get('description', ''),
                        'required': 0,
                        'prepared': 0,
                        'remaining': 0,
                    }
                requirements[key]['required'] += quantity

            for key, requirement in requirements.items():
                group = {
                    'department': requirement['department'],
                    'brand': requirement['brand'],
                    'model': requirement['model'],
                    'description': requirement['description'],
                }
                requirement['prepared'] = subproject_prepared_quantity(
                    event,
                    subproject,
                    group,
                )
                requirement['remaining'] = max(
                    requirement['required'] - requirement['prepared'],
                    0,
                )
            return requirements

        for item in event.prepared_items:
            requirement = _model_marker_to_requirement(item)
            if not requirement:
                continue

            key = requirement['key']
            if key not in requirements:
                requirements[key] = {
                    'department': requirement['department'],
                    'brand': requirement['brand'],
                    'model': requirement['model'],
                    'description': requirement['description'],
                    'required': 0,
                    'prepared': 0,
                    'remaining': 0,
                }
            requirements[key]['required'] += requirement['quantity']

        # Count real assets that are already prepared for the target and not returned.
        for asset_id in _get_unreturned_real_asset_ids(event):
            asset = data_manager.inventory.get(asset_id)
            if not asset:
                continue
            key = _asset_match_key(asset)
            if key in requirements:
                requirements[key]['prepared'] += 1

        for requirement in requirements.values():
            requirement['remaining'] = max(requirement['required'] - requirement['prepared'], 0)

        return requirements


    def _destination_requirements_payload(event, subproject=None):
        """Return destination requirements in a frontend-friendly list."""
        requirements = []
        for requirement in _target_model_requirements(event, subproject).values():
            requirements.append({
                'department': requirement.get('department', ''),
                'brand': requirement.get('brand', ''),
                'model': requirement.get('model', ''),
                'description': requirement.get('description', ''),
                'required': int(requirement.get('required', 0) or 0),
                'prepared': int(requirement.get('prepared', 0) or 0),
                'remaining': int(requirement.get('remaining', 0) or 0),
            })

        requirements.sort(key=lambda item: (
            item['department'],
            item['brand'].casefold(),
            item['model'].casefold(),
            item['description'].casefold(),
        ))
        return requirements


    def _transfer_office_candidate_payload(asset):
        return {
            'assetId': asset.asset_id,
            'id': asset.asset_id,
            'department': asset.department_code,
            'brand': asset.brand,
            'model': asset.model_number,
            'version': getattr(asset, 'version', ''),
            'description': asset.description or '',
            'tags': normalize_asset_tags(getattr(asset, 'tags', [])),
            'serial': asset.serial_number,
            'serial2': getattr(asset, 'secondary_serial_number', ''),
            'status': asset_status(asset),
            'currentLocation': asset.current_location or asset.default_location or 'Office',
            'isUntagged': is_untagged(asset),
            'isDegraded': is_degraded(asset),
            'isDisposed': is_disposed(asset),
        }


    def _get_available_office_candidates_for_transfer(to_event, requirement_key):
        """Return available exact asset IDs that can be prepared for the destination."""
        _ensure_event_lists(to_event)
        current_event_refs = active_asset_refs(to_event)
        busy_elsewhere = set()

        for other in data_manager.events.values():
            if not other or other.event_id == to_event.event_id:
                continue
            busy_elsewhere.update(active_asset_refs(other))

        candidates = []
        for asset_id, asset in sorted(data_manager.inventory.items(), key=lambda pair: pair[0]):
            if not asset or is_bulk_asset(asset):
                continue
            if getattr(asset, 'is_missing', False) or getattr(asset, 'is_ooc', False) or is_disposed(asset):
                continue
            if asset_id in current_event_refs or asset_id in busy_elsewhere:
                continue
            if _asset_match_key(asset) != requirement_key:
                continue
            candidates.append(_transfer_office_candidate_payload(asset))

        return candidates


    def _asset_fulfills_event_model_requirement(event, asset, subproject=None):
        requirements = _target_model_requirements(event, subproject)
        return _asset_match_key(asset) in requirements


    def _transfer_asset_payload(asset, state='', from_event=None, to_event=None, reason='', requirement=None, source_quantity=0, return_quantity=0):
        """Build a transfer-page asset payload.

        state is intentionally server-side so multiple browser/device sessions see
        the same action result after refreshing the comparison.
        """
        requirement = requirement or {}
        target_remaining = int(requirement.get('remaining', 0) or 0)
        return {
            'assetId': asset.asset_id,
            'department': asset.department_code,
            'brand': asset.brand,
            'model': asset.model_number,
            'description': asset.description,
            'tags': normalize_asset_tags(getattr(asset, 'tags', [])),
            'serial': asset.serial_number,
            'serial2': getattr(asset, 'secondary_serial_number', ''),
            'status': asset_status(asset),
            'isUntagged': is_untagged(asset),
            'isDegraded': is_degraded(asset),
            'isDisposed': is_disposed(asset),
            'currentLocation': asset.current_location or (getattr(from_event, 'name', '') if from_event else ''),
            'matchLabel': f"[{asset.department_code}] {asset.brand} {asset.model_number} {asset.description}".strip(),
            'targetRequired': int(requirement.get('required', 0) or 0),
            'targetPrepared': int(requirement.get('prepared', 0) or 0),
            'targetRemainingBeforeThisAsset': target_remaining,
            'targetRemaining': target_remaining,
            'sourceQuantity': int(source_quantity or 0),
            'returnQuantity': int(return_quantity or 0),
            'reason': reason,
            'transferState': state,
        }


    def _real_source_asset_ids_including_returned(event):
        """Return real inventory asset IDs connected to a source event.

        Unlike _get_unreturned_real_asset_ids(), this intentionally keeps returned
        IDs so the transfer page can keep showing already-transferred / returned-to-
        office assets with an Undo button after the server-side refresh.
        """
        _ensure_event_lists(event)
        ids = []
        for asset_id in list(event.actually_prepared) + list(event.prepared_items):
            if not is_real_asset_ref(asset_id):
                continue
            if asset_id not in data_manager.inventory:
                continue
            if asset_id not in ids:
                ids.append(asset_id)
        return ids


    def _asset_is_active_on_destination(asset_id, to_event, to_subproject=None):
        _ensure_event_lists(to_event)
        active = (
            asset_id in (getattr(to_event, 'actually_prepared', []) or [])
            and asset_id not in (getattr(to_event, 'returned_items', []) or [])
        )
        if not active or not to_subproject:
            return active
        return asset_id in subproject_refs(to_subproject)


    def _get_transfer_candidates(from_event, to_event, to_subproject=None):
        """
        Find source assets that can fill the destination event's remaining model
        requirements. Already-transferred assets are included too, marked with
        transferState='transferred', so every device can show them with Undo instead
        of disappearing after refresh.
        """
        _ensure_event_lists(from_event)
        _ensure_event_lists(to_event)

        requirements = _target_model_requirements(to_event, to_subproject)
        remaining_by_key = {key: req['remaining'] for key, req in requirements.items() if req['remaining'] > 0}

        candidates = []
        seen = set()

        # 1) Active source assets that may still be transferred.
        if remaining_by_key:
            for asset_id in _get_unreturned_real_asset_ids(from_event):
                asset = data_manager.inventory.get(asset_id)
                if not asset:
                    continue
                if getattr(asset, 'is_missing', False) or getattr(asset, 'is_ooc', False) or is_disposed(asset):
                    continue

                key = _asset_match_key(asset)
                if remaining_by_key.get(key, 0) <= 0:
                    continue

                req = requirements[key]
                candidates.append(_transfer_asset_payload(
                    asset,
                    state='',
                    from_event=from_event,
                    to_event=to_event,
                    requirement=req,
                ))
                seen.add(asset.asset_id)

        # 2) Assets already moved from this source to this destination. These must
        # stay visible in Common / Transferable with an Undo button, and must not be
        # available in Return to Office.
        for asset_id in _real_source_asset_ids_including_returned(from_event):
            if asset_id in seen:
                continue
            if asset_id not in (getattr(from_event, 'returned_items', []) or []):
                continue
            if not _asset_is_active_on_destination(asset_id, to_event, to_subproject):
                continue

            asset = data_manager.inventory.get(asset_id)
            if not asset:
                continue

            key = _asset_match_key(asset)
            req = requirements.get(key, {
                'required': 0,
                'prepared': 0,
                'remaining': 0,
            })
            candidates.append(_transfer_asset_payload(
                asset,
                state='transferred',
                from_event=from_event,
                to_event=to_event,
                requirement=req,
                reason='Already transferred to destination event',
            ))
            seen.add(asset.asset_id)

        candidates.sort(key=lambda x: (x['department'], x['brand'], x['model'], x['description'], x['assetId']))
        return candidates



    def _get_transfer_needed_from_office_assets(from_event, to_event, to_subproject=None):
        """Return destination event model quantities that still need to be packed from office.

        This compares the destination event's remaining model requirements against
        the source event's currently unreturned, transferable matching assets. If
        the destination still needs 12 of a type and the source event can provide 9,
        this view returns 3x for that type as still needed from office.
        """
        _ensure_event_lists(from_event)
        _ensure_event_lists(to_event)

        requirements = _target_model_requirements(to_event, to_subproject)

        # Count how many active, transferable source assets can still satisfy each
        # destination requirement. Already-transferred assets are not in this list,
        # and they are already counted as prepared in _target_model_requirements().
        source_available_by_key = defaultdict(int)
        for asset_id in _get_unreturned_real_asset_ids(from_event):
            asset = data_manager.inventory.get(asset_id)
            if not asset:
                continue
            if getattr(asset, 'is_missing', False) or getattr(asset, 'is_ooc', False):
                continue
            source_available_by_key[_asset_match_key(asset)] += 1

        needed = []
        for key, req in requirements.items():
            target_remaining = max(0, int(req.get('remaining', 0) or 0))
            if target_remaining <= 0:
                continue

            source_available = max(0, int(source_available_by_key.get(key, 0) or 0))
            office_quantity = max(0, target_remaining - source_available)
            if office_quantity <= 0:
                continue

            office_candidates = _get_available_office_candidates_for_transfer(to_event, key)
            needed.append({
                'assetId': '',
                'department': req.get('department', ''),
                'brand': req.get('brand', ''),
                'model': req.get('model', ''),
                'description': req.get('description', ''),
                'serial': '',
                'currentLocation': 'Office',
                'matchLabel': f"[{req.get('department', '')}] {req.get('brand', '')} {req.get('model', '')} {req.get('description', '')}".strip(),
                'targetRequired': int(req.get('required', 0) or 0),
                'targetPrepared': int(req.get('prepared', 0) or 0),
                'targetRemainingBeforeThisAsset': target_remaining,
                'targetRemaining': target_remaining,
                'sourceQuantity': source_available,
                'officeQuantity': office_quantity,
                'officeCandidateCount': len(office_candidates),
                'officeCandidates': office_candidates,
                'returnQuantity': 0,
                'reason': (
                    f"Destination still needs {target_remaining}; "
                    f"source can provide {source_available}; {office_quantity} should be packed from office"
                ),
                'transferState': 'neededFromOffice',
            })

        needed.sort(key=lambda x: (x['department'], x['brand'], x['model'], x['description']))
        return needed


    def _get_transfer_return_to_office_assets(from_event, to_event, to_subproject=None):
        """Return source assets that should go back to office.

        This is quantity-based by asset type and server-state aware:
        - transferred assets are excluded from this view
        - already-returned-to-office assets remain visible with transferState
          'returnedOffice' so users can Undo from any device
        - the grouped quantity remains the true excess count, e.g. source has 15
          and destination only needs 12 => 3x should go back, even after one of the
          three has already been marked returned.
        """
        _ensure_event_lists(from_event)
        _ensure_event_lists(to_event)

        target_requirements = _target_model_requirements(to_event, to_subproject)

        source_groups = defaultdict(list)
        for asset_id in _real_source_asset_ids_including_returned(from_event):
            asset = data_manager.inventory.get(asset_id)
            if not asset:
                continue
            # If this exact unit was transferred to the destination, it belongs only
            # in Common / Transferable with Undo, not in Return to Office.
            if _asset_is_active_on_destination(asset_id, to_event):
                continue
            source_groups[_asset_match_key(asset)].append(asset)

        going_back = []

        for key, group_assets in source_groups.items():
            group_assets.sort(key=lambda asset: asset.asset_id)
            source_quantity = len(group_assets)
            requirement = target_requirements.get(key)

            if requirement:
                target_remaining = max(0, int(requirement.get('remaining', 0) or 0))
                return_quantity = max(0, source_quantity - target_remaining)
                if return_quantity <= 0:
                    continue
                reason = (
                    f"Destination needs {target_remaining}; "
                    f"source has {source_quantity}; {return_quantity} should return to office"
                )
                target_required = int(requirement.get('required', 0) or 0)
                target_prepared = int(requirement.get('prepared', 0) or 0)
            else:
                target_remaining = 0
                return_quantity = source_quantity
                reason = 'Not required by destination event'
                target_required = 0
                target_prepared = 0

            req_payload = {
                'required': target_required,
                'prepared': target_prepared,
                'remaining': target_remaining,
            }

            for asset in group_assets:
                state = 'returnedOffice' if asset.asset_id in (getattr(from_event, 'returned_items', []) or []) else ''
                going_back.append(_transfer_asset_payload(
                    asset,
                    state=state,
                    from_event=from_event,
                    to_event=to_event,
                    requirement=req_payload,
                    reason=reason,
                    source_quantity=source_quantity,
                    return_quantity=return_quantity,
                ))

        going_back.sort(key=lambda x: (x['department'], x['brand'], x['model'], x['description'], x['assetId']))
        return going_back

    def _transfer_one_asset(from_event, to_event, asset_id, to_subproject=None):
        _ensure_event_lists(from_event)
        _ensure_event_lists(to_event)

        if not is_real_asset_ref(asset_id):
            raise ValueError('Only real inventory assets can be transferred here')

        asset = data_manager.inventory.get(asset_id)
        if not asset:
            raise ValueError(f'Asset {asset_id} not found')

        if asset_id in from_event.returned_items:
            raise ValueError(f'Asset {asset_id} has already been returned from the source event')

        if asset_id not in from_event.prepared_items and asset_id not in from_event.actually_prepared:
            raise ValueError(f'Asset {asset_id} is not currently prepared for the source event')

        # Return it from the source event.
        if asset_id not in from_event.returned_items:
            from_event.returned_items.append(asset_id)
        if asset_id in from_event.actually_prepared:
            from_event.actually_prepared.remove(asset_id)

        # Prepare it immediately for the destination event. If the destination did
        # not already have this asset type as a model requirement, add it so it shows
        # together with the rest of the event assets.
        if not _asset_fulfills_event_model_requirement(to_event, asset, to_subproject):
            ensure_model_requirement(to_event, asset, 1)

        remove_direct_asset_ref(to_event, asset_id)
        if asset_id in to_event.returned_items:
            to_event.returned_items.remove(asset_id)
        if asset_id not in to_event.actually_prepared:
            to_event.actually_prepared.append(asset_id)

        if to_subproject:
            group = asset_group(asset)
            remove_subproject_ref(to_event, asset_id)
            if not assign_subproject_ref(to_subproject, group, asset_id):
                raise ValueError(
                    f'{asset_id} is not required by the selected destination sub-project'
                )

        # The asset has a model row now, so it should not be displayed as a loose extra.
        if asset_id in to_event.extra_assets:
            to_event.extra_assets.remove(asset_id)

        # The physical location should now show the destination event.
        asset.current_location = to_event.name

        return {
            'assetId': asset.asset_id,
            'brand': asset.brand,
            'model': asset.model_number,
            'description': asset.description,
            'department': asset.department_code,
            'serial': asset.serial_number,
            'serial2': getattr(asset, 'secondary_serial_number', ''),
        }


    @app.route('/api/transfers/options', methods=['GET'])
    @require_auth
    def get_transfer_options():
        """Return valid source and destination events for the Transfer Assets page."""
        try:
            visible_events = [
                event for event in data_manager.events.values()
                if can_access_event(event)
            ]
            refresh_event_states_for_read(visible_events)
            visible_events.sort(
                key=lambda event: (str(getattr(event, 'start_date', '') or ''), event.event_id)
            )

            total = len(visible_events)
            offset = max(0, request.args.get('offset', type=int) or 0)
            requested_limit = request.args.get('limit', type=int)
            limit = min(max(1, requested_limit), 500) if requested_limit else None
            page_events = visible_events[
                offset:offset + limit if limit is not None else None
            ] if (offset or limit is not None) else visible_events
            event_summaries = [_event_summary_for_transfer(event) for event in page_events]

            return jsonify({
                'success': True,
                'data': {
                    'events': event_summaries,
                    'sourceEvents': event_summaries,
                    'targetEvents': event_summaries,
                },
                'meta': {
                    'total': total,
                    'offset': offset,
                    'limit': limit,
                    'hasMore': offset + len(event_summaries) < total,
                    'nextOffset': (
                        offset + len(event_summaries)
                        if offset + len(event_summaries) < total
                        else None
                    ),
                },
            })
        except Exception as e:
            logger.error(f"Error getting transfer options: {e}")
            return jsonify({'error': 'Failed to load transfer options'}), 500


    @app.route('/api/transfers/candidates', methods=['GET'])
    @require_auth
    def get_transfer_candidates():
        """Return assets from the source event that match the destination event's remaining requirements."""
        try:
            from_event_id = request.args.get('fromEventId', type=int)
            to_event_id = request.args.get('toEventId', type=int)
            to_subproject_id = request.args.get('toSubprojectId', type=str)

            if not from_event_id or not to_event_id:
                return jsonify({'error': 'Source and destination events are required'}), 400
            if from_event_id == to_event_id:
                return jsonify({'error': 'Source and destination events cannot be the same'}), 400

            from_event = data_manager.events.get(from_event_id)
            to_event = data_manager.events.get(to_event_id)

            if not from_event or not to_event:
                return jsonify({'error': 'Event not found'}), 404
            if not can_access_event(from_event) or not can_access_event(to_event):
                return access_denied()

            try:
                to_subproject = _transfer_target_subproject(to_event, to_subproject_id)
            except ValueError as error:
                return jsonify({'error': str(error)}), 400

            candidates = _get_transfer_candidates(from_event, to_event, to_subproject)
            return_to_office = _get_transfer_return_to_office_assets(
                from_event,
                to_event,
                to_subproject,
            )
            needed_from_office = _get_transfer_needed_from_office_assets(
                from_event,
                to_event,
                to_subproject,
            )

            return jsonify({
                'success': True,
                'data': {
                    'fromEvent': _event_summary_for_transfer(from_event),
                    'toEvent': _event_summary_for_transfer(to_event),
                    'targetSubproject': (
                        {
                            'id': str(to_subproject.get('id') or ''),
                            'name': str(to_subproject.get('name') or 'Unnamed room'),
                        }
                        if to_subproject else None
                    ),
                    'candidates': candidates,
                    'candidateCount': len(candidates),
                    'returnToOffice': return_to_office,
                    'returnToOfficeCount': len(return_to_office),
                    'neededFromOffice': needed_from_office,
                    'neededFromOfficeCount': len(needed_from_office),
                    'neededFromOfficeQuantity': sum(int(item.get('officeQuantity', 0) or 0) for item in needed_from_office),
                    'destinationRequirements': _destination_requirements_payload(
                        to_event,
                        to_subproject,
                    ),
                }
            })
        except Exception as e:
            logger.error(f"Error getting transfer candidates: {e}")
            return jsonify({'error': 'Failed to load transfer candidates'}), 500


    @app.route('/api/transfers/execute', methods=['POST'])
    @require_auth
    @with_transfer_action_lock
    def execute_transfer_assets():
        """Bulk transfer selected matching assets from one event to another."""
        try:
            data = request.get_json() or {}
            from_event_id = data.get('fromEventId')
            to_event_id = data.get('toEventId')
            to_subproject_id = data.get('toSubprojectId')
            asset_ids = data.get('assetIds') or []

            if not from_event_id or not to_event_id:
                return jsonify({'error': 'Source and destination events are required'}), 400
            if int(from_event_id) == int(to_event_id):
                return jsonify({'error': 'Source and destination events cannot be the same'}), 400
            if not isinstance(asset_ids, list) or not asset_ids:
                return jsonify({'error': 'Select at least one asset to transfer'}), 400

            from_event = data_manager.events.get(int(from_event_id))
            to_event = data_manager.events.get(int(to_event_id))

            if not from_event or not to_event:
                return jsonify({'error': 'Event not found'}), 404
            if not can_access_event(from_event) or not can_access_event(to_event):
                return access_denied()

            try:
                to_subproject = _transfer_target_subproject(
                    to_event,
                    to_subproject_id,
                )
            except ValueError as error:
                return jsonify({'error': str(error)}), 400

            transferred = []
            skipped = []

            for raw_asset_id in asset_ids:
                asset_id = str(raw_asset_id or '').strip()
                if not asset_id:
                    continue

                asset = data_manager.inventory.get(asset_id)
                if not asset:
                    skipped.append({'assetId': asset_id, 'reason': 'Asset not found'})
                    continue

                requirements = _target_model_requirements(to_event, to_subproject)
                requirement = requirements.get(_asset_match_key(asset))
                if not requirement or requirement.get('remaining', 0) <= 0:
                    skipped.append({'assetId': asset_id, 'reason': 'Destination event no longer needs this asset type'})
                    continue

                try:
                    transferred.append(_transfer_one_asset(
                        from_event,
                        to_event,
                        asset_id,
                        to_subproject,
                    ))
                except ValueError as e:
                    skipped.append({'assetId': asset_id, 'reason': str(e)})

            if not transferred:
                return jsonify({'error': 'No assets were transferred', 'skipped': skipped}), 400

            data_manager.save_inventory()
            update_event_state(from_event)
            update_event_state(to_event)
            data_manager.save_event(from_event)
            data_manager.save_event(to_event)
            invalidate_cache()

            log_action(
                f"Transferred {len(transferred)} asset(s) from event {from_event.event_id} to event {to_event.event_id}: "
                f"{', '.join([item['assetId'] for item in transferred])}"
            )

            return jsonify({
                'success': True,
                'message': f"Transferred {len(transferred)} asset(s)",
                'data': {
                    'transferred': transferred,
                    'skipped': skipped,
                    'fromEvent': _event_summary_for_transfer(from_event),
                    'toEvent': _event_summary_for_transfer(to_event),
                    'targetSubproject': (
                        {
                            'id': str(to_subproject.get('id') or ''),
                            'name': str(to_subproject.get('name') or 'Unnamed room'),
                        }
                        if to_subproject else None
                    ),
                }
            })
        except Exception as e:
            logger.error(f"Error executing transfer: {e}")
            import traceback
            logger.error(f"Transfer traceback: {traceback.format_exc()}")
            return jsonify({'error': 'Failed to transfer assets'}), 500


    def _undo_transfer_one_asset(from_event, to_event, asset_id):
        _ensure_event_lists(from_event)
        _ensure_event_lists(to_event)

        if not is_real_asset_ref(asset_id):
            raise ValueError('Only real inventory assets can be undone here')

        asset = data_manager.inventory.get(asset_id)
        if not asset:
            raise ValueError(f'Asset {asset_id} not found')

        if asset_id not in getattr(to_event, 'actually_prepared', []):
            raise ValueError(f'Asset {asset_id} is not currently prepared for the destination event')

        # Remove from destination event's active prepared assets.
        if asset_id in to_event.actually_prepared:
            to_event.actually_prepared.remove(asset_id)
        if asset_id in to_event.prepared_items:
            to_event.prepared_items.remove(asset_id)
        if asset_id in to_event.extra_assets:
            to_event.extra_assets.remove(asset_id)
        if asset_id in to_event.returned_items:
            to_event.returned_items.remove(asset_id)
        remove_subproject_ref(to_event, asset_id)

        # Put it back as active on the source event.
        if asset_id in from_event.returned_items:
            from_event.returned_items.remove(asset_id)
        if not _asset_fulfills_event_model_requirement(from_event, asset) and asset_id not in from_event.prepared_items:
            from_event.prepared_items.append(asset_id)
        if asset_id not in from_event.actually_prepared:
            from_event.actually_prepared.append(asset_id)

        asset.current_location = from_event.name

        return {
            'assetId': asset.asset_id,
            'brand': asset.brand,
            'model': asset.model_number,
            'description': asset.description,
            'department': asset.department_code,
            'serial': asset.serial_number,
            'serial2': getattr(asset, 'secondary_serial_number', ''),
        }


    def _return_source_asset_to_office(from_event, asset_id):
        _ensure_event_lists(from_event)

        if not is_real_asset_ref(asset_id):
            raise ValueError('Only real inventory assets can be returned to office here')

        asset = data_manager.inventory.get(asset_id)
        if not asset:
            raise ValueError(f'Asset {asset_id} not found')

        if asset_id in from_event.returned_items:
            raise ValueError(f'Asset {asset_id} has already been returned from the source event')

        if asset_id not in from_event.prepared_items and asset_id not in from_event.actually_prepared:
            raise ValueError(f'Asset {asset_id} is not currently prepared for the source event')

        if asset_id in from_event.actually_prepared:
            from_event.actually_prepared.remove(asset_id)
        if asset_id not in from_event.returned_items:
            from_event.returned_items.append(asset_id)

        asset.current_location = asset.default_location or 'Store'

        return {
            'assetId': asset.asset_id,
            'brand': asset.brand,
            'model': asset.model_number,
            'description': asset.description,
            'department': asset.department_code,
            'serial': asset.serial_number,
            'serial2': getattr(asset, 'secondary_serial_number', ''),
        }


    def _undo_return_source_asset_to_office(from_event, asset_id):
        _ensure_event_lists(from_event)

        if not is_real_asset_ref(asset_id):
            raise ValueError('Only real inventory assets can be restored here')

        asset = data_manager.inventory.get(asset_id)
        if not asset:
            raise ValueError(f'Asset {asset_id} not found')

        if asset_id not in from_event.returned_items:
            raise ValueError(f'Asset {asset_id} is not marked as returned from the source event')

        from_event.returned_items.remove(asset_id)
        if not _asset_fulfills_event_model_requirement(from_event, asset) and asset_id not in from_event.prepared_items:
            from_event.prepared_items.append(asset_id)
        if asset_id not in from_event.actually_prepared:
            from_event.actually_prepared.append(asset_id)

        asset.current_location = from_event.name

        return {
            'assetId': asset.asset_id,
            'brand': asset.brand,
            'model': asset.model_number,
            'description': asset.description,
            'department': asset.department_code,
            'serial': asset.serial_number,
            'serial2': getattr(asset, 'secondary_serial_number', ''),
        }


    @app.route('/api/transfers/undo', methods=['POST'])
    @require_auth
    @with_transfer_action_lock
    def undo_transfer_assets():
        """Undo one or more direct transfers from a destination event back to the source event."""
        try:
            data = request.get_json() or {}
            from_event_id = data.get('fromEventId')
            to_event_id = data.get('toEventId')
            asset_ids = data.get('assetIds') or []

            if not from_event_id or not to_event_id:
                return jsonify({'error': 'Source and destination events are required'}), 400
            if not isinstance(asset_ids, list) or not asset_ids:
                return jsonify({'error': 'Select at least one asset to undo'}), 400

            from_event = data_manager.events.get(int(from_event_id))
            to_event = data_manager.events.get(int(to_event_id))
            if not from_event or not to_event:
                return jsonify({'error': 'Event not found'}), 404
            if not can_access_event(from_event) or not can_access_event(to_event):
                return access_denied()

            undone = []
            skipped = []
            for raw_asset_id in asset_ids:
                asset_id = str(raw_asset_id or '').strip()
                if not asset_id:
                    continue
                try:
                    undone.append(_undo_transfer_one_asset(from_event, to_event, asset_id))
                except ValueError as e:
                    skipped.append({'assetId': asset_id, 'reason': str(e)})

            if not undone:
                return jsonify({'error': 'No transfers were undone', 'skipped': skipped}), 400

            data_manager.save_inventory()
            update_event_state(from_event)
            update_event_state(to_event)
            data_manager.save_event(from_event)
            data_manager.save_event(to_event)
            invalidate_cache()

            log_action(
                f"Undid {len(undone)} transfer(s) from event {to_event.event_id} back to event {from_event.event_id}: "
                f"{', '.join([item['assetId'] for item in undone])}"
            )

            return jsonify({'success': True, 'message': f"Undid {len(undone)} transfer(s)", 'data': {'undone': undone, 'skipped': skipped}})
        except Exception as e:
            logger.error(f"Error undoing transfer: {e}", exc_info=True)
            return jsonify({'error': 'Failed to undo transfer'}), 500


    @app.route('/api/transfers/return-office', methods=['POST'])
    @require_auth
    @with_transfer_action_lock
    def return_transfer_assets_to_office():
        """Mark selected source-event assets as returned to office."""
        try:
            data = request.get_json() or {}
            from_event_id = data.get('fromEventId')
            asset_ids = data.get('assetIds') or []

            if not from_event_id:
                return jsonify({'error': 'Source event is required'}), 400
            if not isinstance(asset_ids, list) or not asset_ids:
                return jsonify({'error': 'Select at least one asset to return to office'}), 400

            from_event = data_manager.events.get(int(from_event_id))
            if not from_event:
                return jsonify({'error': 'Source event not found'}), 404
            if not can_access_event(from_event):
                return access_denied()

            returned = []
            skipped = []
            for raw_asset_id in asset_ids:
                asset_id = str(raw_asset_id or '').strip()
                if not asset_id:
                    continue
                try:
                    returned.append(_return_source_asset_to_office(from_event, asset_id))
                except ValueError as e:
                    skipped.append({'assetId': asset_id, 'reason': str(e)})

            if not returned:
                return jsonify({'error': 'No assets were returned to office', 'skipped': skipped}), 400

            data_manager.save_inventory()
            update_event_state(from_event)
            data_manager.save_event(from_event)
            invalidate_cache()

            log_asset_action(
                from_event.event_id,
                'return',
                [
                    asset_log_item(item.get('assetId'))
                    for item in returned
                    if item.get('assetId')
                ],
            )

            return jsonify({'success': True, 'message': f"Returned {len(returned)} asset(s) to office", 'data': {'returned': returned, 'skipped': skipped}})
        except Exception as e:
            logger.error(f"Error returning transfer assets to office: {e}", exc_info=True)
            return jsonify({'error': 'Failed to return assets to office'}), 500


    @app.route('/api/transfers/undo-return-office', methods=['POST'])
    @require_auth
    @with_transfer_action_lock
    def undo_return_transfer_assets_to_office():
        """Undo return-to-office for selected source-event assets."""
        try:
            data = request.get_json() or {}
            from_event_id = data.get('fromEventId')
            asset_ids = data.get('assetIds') or []

            if not from_event_id:
                return jsonify({'error': 'Source event is required'}), 400
            if not isinstance(asset_ids, list) or not asset_ids:
                return jsonify({'error': 'Select at least one asset to restore'}), 400

            from_event = data_manager.events.get(int(from_event_id))
            if not from_event:
                return jsonify({'error': 'Source event not found'}), 404
            if not can_access_event(from_event):
                return access_denied()

            restored = []
            skipped = []
            for raw_asset_id in asset_ids:
                asset_id = str(raw_asset_id or '').strip()
                if not asset_id:
                    continue
                try:
                    restored.append(_undo_return_source_asset_to_office(from_event, asset_id))
                except ValueError as e:
                    skipped.append({'assetId': asset_id, 'reason': str(e)})

            if not restored:
                return jsonify({'error': 'No return-to-office actions were undone', 'skipped': skipped}), 400

            data_manager.save_inventory()
            update_event_state(from_event)
            data_manager.save_event(from_event)
            invalidate_cache()

            log_action(
                f"Restored {len(restored)} asset(s) from office back to event {from_event.event_id}: "
                f"{', '.join([item['assetId'] for item in restored])}"
            )

            return jsonify({'success': True, 'message': f"Restored {len(restored)} asset(s)", 'data': {'restored': restored, 'skipped': skipped}})
        except Exception as e:
            logger.error(f"Error undoing return-to-office: {e}", exc_info=True)
            return jsonify({'error': 'Failed to undo return-to-office'}), 500


    @app.route('/api/events/<int:event_id>/transfer', methods=['POST'])
    @require_auth
    @require_event_access
    @with_transfer_action_lock
    def transfer_asset_between_events(event_id):
        """Transfer one asset from one event to another. Kept for the existing manual modal."""
        try:
            data = request.get_json() or {}
            from_event_id = data.get('fromEventId')
            asset_id = str(data.get('assetId', '')).strip()

            if not from_event_id or not asset_id:
                return jsonify({'error': 'From event ID and asset ID are required'}), 400

            from_event = data_manager.events.get(int(from_event_id))
            to_event = data_manager.events.get(event_id)

            if not from_event or not to_event:
                return jsonify({'error': 'Event not found'}), 404
            if not can_access_event(from_event):
                return access_denied()

            transferred = _transfer_one_asset(from_event, to_event, asset_id)

            data_manager.save_inventory()
            update_event_state(from_event)
            update_event_state(to_event)
            data_manager.save_event(from_event)
            data_manager.save_event(to_event)
            invalidate_cache()

            log_action(f"Transferred asset {asset_id} from event {from_event_id} to event {event_id}")

            return jsonify({
                'success': True,
                'message': f'Asset {asset_id} transferred successfully',
                'data': transferred
            })
        except ValueError as e:
            return jsonify({'error': str(e)}), 400
        except Exception as e:
            logger.error(f"Error transferring asset: {e}")
            import traceback
            logger.error(f"Transfer traceback: {traceback.format_exc()}")
            return jsonify({'error': 'Failed to transfer asset'}), 500
