// ---------------- Trial Plan page ----------------
var planPageState = {
  events: [],
  event: null,
  eventId: null,
  assets: [],
  availability: [],
  containers: [],
  templates: [],
  search: '',
  department: 'ALL',
  showContainers: true,
  loading: false,
  templateDraft: null,
  activeSubprojectId: '',
  editingCustomAssetId: ''
};

var EVENT_CONSOLIDATED_SUBPROJECT_ID = '__all__';

function eventSubprojects(event) {
  return Array.isArray(event?.subprojects) ? event.subprojects.filter(row => row && Array.isArray(row.items)) : [];
}

async function openAssetCheckFault(encodedAssetId) {
  const assetId = decodeURIComponent(encodedAssetId || '');
  const checkAsset = assetCheckState.assets.find(item =>
    String(item.id || item.internalId || '') === assetId
  );
  if (!checkAsset) {
    showNotification('warning', 'Asset not found in this check group');
    return;
  }

  try {
    if (!getAssetByApiIdentifier(assetId)) {
      const response = await apiCall('/api/assets');
      assets = response.data || [];
    }
    if (!getAssetByApiIdentifier(assetId)) {
      throw new Error(`Asset ${assetId} could not be loaded`);
    }

    openMaintenanceModalForAsset(assetId);
    const title = document.querySelector('#maintenanceModal .modal-title');
    const logType = document.getElementById('maintenanceLogType');
    const description = document.getElementById('maintenanceLogEntry');
    if (title) title.textContent = 'Log Fault';
    if (logType) {
      logType.value = 'Fault';
      applyMaintenanceLogTypeSelectStyle(logType);
    }
    if (description) {
      description.placeholder = 'Describe the fault or limitation...';
      description.focus();
    }
  } catch (error) {
    showNotification('error', `Unable to open the fault form: ${error.message}`);
  }
}

function eventActiveSubproject(state, event) {
  const rooms = eventSubprojects(event);
  if (!rooms.length) return null;
  if (String(state?.activeSubprojectId) === EVENT_CONSOLIDATED_SUBPROJECT_ID) return null;
  const active = rooms.find(room => String(room.id) === String(state.activeSubprojectId));
  if (active) return active;
  state.activeSubprojectId = String(rooms[0].id || 'main');
  return rooms[0];
}

function eventIsConsolidated(state, event) {
  return (
    eventSubprojects(event).length > 1 &&
    String(state?.activeSubprojectId) === EVENT_CONSOLIDATED_SUBPROJECT_ID
  );
}

function eventCustomAssetIdentity(custom) {
  if (!custom) return '';
  return [
    normalizeCustomType(custom.type),
    normalizeDepartmentCode(custom.department || 'UN'),
    custom.name,
    custom.company,
    custom.description
  ].map(value => String(value || '').trim().toLowerCase()).join('\u001f');
}

function eventCustomItemMatchesAsset(item, custom) {
  return (
    normalizeDepartmentCode(item?.departmentCode || item?.department || 'UN') ===
      normalizeDepartmentCode(custom?.department || 'UN') &&
    String(item?.description || '').trim().toLowerCase() ===
      String(custom?.name || '').trim().toLowerCase()
  );
}

function eventScopedCustomAssets(event, state, assets) {
  const rooms = eventSubprojects(event);
  const room = eventActiveSubproject(state, event);
  if (rooms.length <= 1 || !room) return assets;

  const roomItems = (room.items || []).filter(item => item?.isCustom);
  const roomRefs = new Set(roomItems.flatMap(item => (item.assetRefs || []).map(String)));
  const allocatedRefs = new Set(rooms.flatMap(subproject => (
    (subproject.items || [])
      .filter(item => item?.isCustom)
      .flatMap(item => (item.assetRefs || []).map(String))
  )));
  const legacyItems = roomItems.filter(item => !(item.assetRefs || []).length);

  return assets.filter(asset => {
    const assetId = String(asset?.id || '');
    if (roomRefs.has(assetId)) return true;
    if (allocatedRefs.has(assetId)) return false;
    const custom = asset?.parsedCustom || parseCustomAsset(assetId, asset);
    return !!custom && legacyItems.some(item => eventCustomItemMatchesAsset(item, custom));
  });
}

function groupEventCustomAssets(assets) {
  const grouped = new Map();
  (assets || []).forEach(asset => {
    const custom = asset?.parsedCustom || parseCustomAsset(asset?.id, asset);
    if (!custom) return;
    const key = eventCustomAssetIdentity(custom);
    let row = grouped.get(key);
    if (!row) {
      row = {
        ...asset,
        id: String(asset.id || custom.id || ''),
        assetIds: [],
        members: [],
        parsedCustom: { ...custom, quantity: 0 }
      };
      grouped.set(key, row);
    }
    row.assetIds.push(String(asset.id || custom.id || ''));
    row.members.push(asset);
    row.parsedCustom.quantity += Math.max(1, Number(custom.quantity || 1));
  });
  return Array.from(grouped.values());
}

function eventConsolidatedNotice(options = {}) {
  const interactive = options.interactive === true;
  return `
    <div class="event-consolidated-notice">
      <strong>Consolidated view</strong>
      <span>${interactive
        ? 'Assets from every room are combined. Return assets and log faults directly from this view.'
        : 'Requirements from every room are combined. Select a room to make changes.'}</span>
    </div>
  `;
}

function eventSubprojectStateByName(stateName) {
  if (stateName === 'planPageState') return planPageState;
  if (stateName === 'prepareNewPageState') return prepareNewPageState;
  if (stateName === 'returnPageState') return returnPageState;
  return window[stateName];
}

function eventSelectSubproject(stateName, subprojectId, renderFunction) {
  const state = eventSubprojectStateByName(stateName);
  if (!state) return;
  state.activeSubprojectId = planDecode(subprojectId);
  state.department = state.department === undefined ? undefined : 'ALL';
  state.expandedDepartments?.clear?.();
  state.expandedModels?.clear?.();
  window[renderFunction]?.();
}

function renderEventSubprojectTabs(stateName, event, renderFunction, label, options = {}) {
  const storedRooms = eventSubprojects(event);
  const showImplicitMain = options.showImplicitMain === true && storedRooms.length === 0;
  const rooms = showImplicitMain
    ? [{ id: '', name: 'Main Room', items: [], isImplicit: true }]
    : storedRooms;
  const allowAdd = options.allowAdd === true;
  const allowDelete = options.allowDelete === true && rooms.length > 1;
  const allowRename = options.allowRename === true;
  const allowReorder = options.allowReorder === true && rooms.length > 1;
  const roomNeedsAttention = typeof options.roomNeedsAttention === 'function'
    ? options.roomNeedsAttention
    : null;
  const roomWarning = typeof options.roomWarning === 'function'
    ? options.roomWarning
    : null;
  const attentionLabel = String(options.attentionLabel || 'Items need attention');
  if (rooms.length <= 1 && !allowAdd) return '';
  const state = eventSubprojectStateByName(stateName);
  const active = showImplicitMain ? rooms[0] : eventActiveSubproject(state, event);
  const consolidated = eventIsConsolidated(state, event);
  return `
    <div class="event-subproject-tabs" role="tablist" aria-label="${escapeHtmlAttr(label || 'Event sub-projects')}">
      ${rooms.length > 1 ? `
        <button type="button" role="tab"
                class="event-subproject-tab event-subproject-consolidated ${consolidated ? 'active' : ''}"
                aria-selected="${consolidated}"
                onclick="eventSelectSubproject('${stateName}','${EVENT_CONSOLIDATED_SUBPROJECT_ID}','${renderFunction}')">
          All requirements
        </button>
      ` : ''}
      ${rooms.map(room => {
        const warning = roomWarning?.(room, event) || null;
        const warningType = warning?.type === 'shortage' ? 'shortage' : 'degraded';
        const warningLabel = String(warning?.label || attentionLabel);
        const needsAttention = Boolean(warning) || roomNeedsAttention?.(room, event) === true;
        const roomName = String(room.name || 'Room');
        return `
        <span class="event-subproject-tab-wrap ${room === active ? 'active' : ''} ${allowReorder ? 'is-reorderable' : ''} ${warning ? `has-warning has-warning-${warningType}` : ''}"
              data-subproject-drop-id="${escapeHtmlAttr(String(room.id || ''))}"
              ${allowReorder ? `
                draggable="true"
                ondragstart="eventSubprojectOrderDragStart(event,${Number(event?.id || 0)},'${planEncode(room.id)}')"
                ondragend="eventSubprojectOrderDragEnd(event)"
              ` : ''}
              ondragover="eventSubprojectDragOver(event)"
              ondragleave="eventSubprojectDragLeave(event)"
              ondrop="eventSubprojectDrop(event,'${stateName}','${planEncode(room.id)}')">
          <button type="button" role="tab"
                  class="event-subproject-tab ${room === active ? 'active' : ''}"
                  aria-selected="${room === active}"
                  aria-label="${escapeHtmlAttr(`${roomName}${needsAttention ? `, ${warningLabel}` : ''}`)}"
                  onclick="eventSelectSubproject('${stateName}','${planEncode(room.id)}','${renderFunction}')">
            ${escapeHtml(roomName)}
            ${needsAttention ? `
              <span class="event-subproject-attention ${warning ? `event-subproject-attention-${warningType}` : ''}"
                    aria-hidden="true"
                    title="${escapeHtmlAttr(warningLabel)}">!</span>
            ` : ''}
          </button>
          ${allowRename && !room.isImplicit ? `
            <button type="button" class="event-subproject-rename"
                    title="Rename ${escapeHtmlAttr(roomName)}"
                    aria-label="Rename ${escapeHtmlAttr(roomName)}"
                    onclick="event.stopPropagation();planRenameSubproject('${planEncode(room.id)}')">
              ${eventDetailsActionIconSvg('edit')}
            </button>
          ` : ''}
          ${allowDelete ? `
            <button type="button" class="event-subproject-delete"
                    title="Delete ${escapeHtmlAttr(roomName)}"
                    aria-label="Delete ${escapeHtmlAttr(roomName)}"
                    onclick="event.stopPropagation();planOpenDeleteSubproject('${planEncode(room.id)}')">&times;</button>
          ` : ''}
        </span>
      `;
      }).join('')}
      ${allowAdd ? `
        <button type="button" class="event-subproject-add" onclick="planAddSubproject()">
          <span aria-hidden="true">+</span> Sub-project
        </button>
      ` : ''}
    </div>
  `;
}

function eventSubprojectDragStart(event, encodedPayload) {
  const payload = planDecode(encodedPayload);
  if (!payload || !event?.dataTransfer) {
    event?.preventDefault?.();
    return;
  }
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('application/x-showbase-subproject', payload);
  event.currentTarget?.classList.add('is-dragging');
}

function eventSubprojectDragEnd(event) {
  event.currentTarget?.classList.remove('is-dragging');
  eventSubprojectClearDropTargets();
}

function eventSubprojectClearDropTargets() {
  document.querySelectorAll(
    '.event-subproject-tab-wrap.is-drop-target, ' +
    '.event-subproject-tab-wrap.is-reorder-before, ' +
    '.event-subproject-tab-wrap.is-reorder-after'
  ).forEach(element => {
    element.classList.remove(
      'is-drop-target',
      'is-reorder-before',
      'is-reorder-after'
    );
    delete element.dataset.reorderPosition;
  });
}

function eventSubprojectOrderDragStart(event, eventId, encodedSubprojectId) {
  if (!event?.dataTransfer) return;
  if (event.target?.closest?.('.event-subproject-rename, .event-subproject-delete')) {
    event.preventDefault();
    return;
  }
  const subprojectId = planDecode(encodedSubprojectId);
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData(
    'application/x-showbase-subproject-order',
    JSON.stringify({ eventId: Number(eventId || 0), subprojectId })
  );
  event.currentTarget?.classList.add('is-reordering');
}

function eventSubprojectOrderDragEnd(event) {
  event.currentTarget?.classList.remove('is-reordering');
  eventSubprojectClearDropTargets();
}

function eventSubprojectDragOver(event) {
  const types = Array.from(event?.dataTransfer?.types || []);
  if (types.includes('application/x-showbase-subproject-order')) {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const rect = event.currentTarget.getBoundingClientRect();
    const position = event.clientX < rect.left + (rect.width / 2)
      ? 'before'
      : 'after';
    event.currentTarget.classList.toggle('is-reorder-before', position === 'before');
    event.currentTarget.classList.toggle('is-reorder-after', position === 'after');
    event.currentTarget.classList.remove('is-drop-target');
    event.currentTarget.dataset.reorderPosition = position;
    return;
  }
  if (!types.includes('application/x-showbase-subproject')) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  event.currentTarget?.classList.add('is-drop-target');
}

function eventSubprojectDragLeave(event) {
  if (!event.currentTarget?.contains(event.relatedTarget)) {
    event.currentTarget?.classList.remove(
      'is-drop-target',
      'is-reorder-before',
      'is-reorder-after'
    );
    if (event.currentTarget?.dataset) delete event.currentTarget.dataset.reorderPosition;
  }
}

async function eventSubprojectDrop(event, stateName, encodedTargetId) {
  event.preventDefault();
  const orderPayload = event.dataTransfer?.getData(
    'application/x-showbase-subproject-order'
  );
  if (orderPayload) {
    await eventSubprojectOrderDrop(
      event,
      stateName,
      planDecode(encodedTargetId),
      orderPayload
    );
    return;
  }
  event.currentTarget?.classList.remove('is-drop-target');
  let payload;
  try {
    payload = JSON.parse(
      event.dataTransfer?.getData('application/x-showbase-subproject') || ''
    );
  } catch (error) {
    return;
  }
  const targetSubprojectId = planDecode(encodedTargetId);
  if (
    !payload?.eventId ||
    !payload?.sourceSubprojectId ||
    payload.sourceSubprojectId === targetSubprojectId
  ) return;

  try {
    const response = await apiCall(
      `/api/events/${payload.eventId}/subprojects/move`,
      'POST',
      { ...payload, targetSubprojectId }
    );
    showNotification('success', response.message || 'Moved to room');
    if (stateName === 'planPageState') {
      await refreshPlanSelectedEvent();
    } else if (stateName === 'prepareNewPageState') {
      await refreshPrepareNewSelectedEvent({ preserve: true });
    } else if (stateName === 'returnPageState') {
      await returnPageRefreshSelected();
    }
  } catch (error) {}
}

async function eventSubprojectOrderDrop(event, stateName, targetSubprojectId, rawPayload) {
  const position = event.currentTarget?.dataset?.reorderPosition === 'after'
    ? 'after'
    : 'before';
  eventSubprojectClearDropTargets();
  if (stateName !== 'planPageState') return;

  let payload;
  try {
    payload = JSON.parse(rawPayload || '');
  } catch (error) {
    return;
  }
  const currentEvent = planPageState.event;
  const sourceSubprojectId = String(payload?.subprojectId || '');
  if (
    !currentEvent?.id ||
    Number(payload?.eventId) !== Number(currentEvent.id) ||
    !sourceSubprojectId ||
    sourceSubprojectId === String(targetSubprojectId)
  ) return;

  const rooms = eventSubprojects(currentEvent);
  const source = rooms.find(room => String(room.id) === sourceSubprojectId);
  const target = rooms.find(room => String(room.id) === String(targetSubprojectId));
  if (!source || !target) return;

  const reordered = rooms.filter(room => room !== source);
  const targetIndex = reordered.indexOf(target);
  reordered.splice(targetIndex + (position === 'after' ? 1 : 0), 0, source);
  const orderedSubprojectIds = reordered.map(room => String(room.id || ''));
  if (orderedSubprojectIds.every((id, index) => id === String(rooms[index]?.id || ''))) {
    return;
  }

  planPageState.event.subprojects = reordered;
  renderPlanPage();
  try {
    const response = await apiCall(
      `/api/events/${currentEvent.id}/subprojects/reorder`,
      'POST',
      { orderedSubprojectIds }
    );
    planPageState.event.subprojects = response.data?.subprojects || reordered;
    renderPlanPage();
    showNotification('success', response.message || 'Sub-project order updated');
  } catch (error) {
    await refreshPlanSelectedEvent();
  }
}

function eventSubprojectDragPayload(state, event, payload) {
  const room = eventActiveSubproject(state, event);
  if (!room || eventIsConsolidated(state, event)) return '';
  return planEncode(JSON.stringify({
    eventId: Number(event?.id || 0),
    sourceSubprojectId: String(room.id || ''),
    ...payload
  }));
}

async function planAddSubproject() {
  const event = planPageState.event;
  if (!event?.id) return;
  const name = await showAppPrompt({
    title: 'Add sub-project',
    message: 'Name this room or work area.',
    inputLabel: 'Sub-project name',
    defaultValue: `Room ${Math.max(2, eventSubprojects(event).length + 1)}`,
    confirmText: 'Add'
  });
  const cleanName = String(name || '').trim();
  if (!cleanName) return;

  try {
    const response = await apiCall(
      `/api/events/${event.id}/subprojects`,
      'POST',
      { name: cleanName }
    );
    const data = response.data || {};
    planPageState.event.subprojects = data.subprojects || [];
    planPageState.activeSubprojectId = String(data.subproject?.id || '');
    renderPlanPage();
    showNotification('success', `${cleanName} added`);
  } catch (error) {}
}

async function planRenameSubproject(encodedSubprojectId) {
  const event = planPageState.event;
  const subprojectId = planDecode(encodedSubprojectId);
  const room = eventSubprojects(event).find(
    item => String(item.id) === String(subprojectId)
  );
  if (!event?.id || !room) return;

  const name = await showAppPrompt({
    title: 'Rename sub-project',
    message: 'Enter a new name for this room or work area.',
    inputLabel: 'Sub-project name',
    defaultValue: room.name || 'Room',
    confirmText: 'Rename'
  });
  const cleanName = String(name || '').trim();
  if (!cleanName || cleanName === String(room.name || '').trim()) return;

  try {
    const response = await apiCall(
      `/api/events/${event.id}/subprojects/${encodeURIComponent(subprojectId)}`,
      'PATCH',
      { name: cleanName }
    );
    planPageState.event.subprojects = response.data?.subprojects || [];
    renderPlanPage();
    showNotification('success', response.message || 'Sub-project renamed');
  } catch (error) {}
}

var planDeleteSubprojectState = {
  subprojectId: '',
  mode: 'merge',
  targetSubprojectId: ''
};

function ensurePlanDeleteSubprojectModal() {
  let modal = document.getElementById('planDeleteSubprojectModal');
  if (modal) return modal;
  modal = document.createElement('div');
  modal.id = 'planDeleteSubprojectModal';
  modal.className = 'modal';
  modal.innerHTML = `
    <div class="modal-content event-subproject-delete-modal">
      <div class="modal-header">
        <div>
          <h3>Delete sub-project</h3>
          <small id="planDeleteSubprojectSummary"></small>
        </div>
        <button type="button" class="close-btn" aria-label="Close"
                onclick="closeModal('planDeleteSubprojectModal')">&times;</button>
      </div>
      <div class="event-subproject-delete-options">
        <button type="button" data-delete-mode="merge"
                onclick="planSetDeleteSubprojectMode('merge')">
          <strong>Merge into another room</strong>
          <span>Keep its requirements and assigned assets.</span>
        </button>
        <button type="button" data-delete-mode="remove"
                onclick="planSetDeleteSubprojectMode('remove')">
          <strong>Remove room and assets</strong>
          <span>Remove its requirements and unassign its assets from the event.</span>
        </button>
      </div>
      <div id="planDeleteSubprojectTargets" class="event-subproject-delete-targets"></div>
      <div class="modal-actions">
        <button type="button" class="btn btn-secondary"
                onclick="closeModal('planDeleteSubprojectModal')">Cancel</button>
        <button type="button" class="btn btn-danger"
                onclick="planConfirmDeleteSubproject()">Delete sub-project</button>
      </div>
    </div>
  `;
  modal.addEventListener('click', event => {
    if (event.target === modal) closeModal('planDeleteSubprojectModal');
  });
  document.body.appendChild(modal);
  return modal;
}

function planSubprojectContentQuantity(room) {
  const itemQuantity = (room?.items || []).reduce(
    (total, item) => total + Math.max(0, Number(item?.quantity || 0)),
    0
  );
  return itemQuantity + (room?.extraRefs || []).length;
}

function planSubprojectHasAssignedAssets(room) {
  if ((room?.extraRefs || []).length > 0) return true;
  return (room?.items || []).some(item => (
    (item?.assetRefs || []).length > 0 ||
    Math.max(0, Number(item?.preparedQuantity || 0)) > 0
  ));
}

async function planOpenDeleteSubproject(encodedSubprojectId) {
  const subprojectId = planDecode(encodedSubprojectId);
  const rooms = eventSubprojects(planPageState.event);
  const room = rooms.find(item => String(item.id) === String(subprojectId));
  const targets = rooms.filter(item => item !== room);
  if (!room || !targets.length) return;

  if (!planSubprojectHasAssignedAssets(room)) {
    await planDeleteSubproject({
      subprojectId,
      mode: 'remove',
      targetSubprojectId: ''
    });
    return;
  }

  planDeleteSubprojectState = {
    subprojectId,
    mode: 'merge',
    targetSubprojectId: String(targets[0].id || '')
  };
  ensurePlanDeleteSubprojectModal();
  const summary = document.getElementById('planDeleteSubprojectSummary');
  if (summary) {
    const quantity = planSubprojectContentQuantity(room);
    summary.textContent = quantity > 0
      ? `${room.name} contains ${quantity} planned or assigned item(s).`
      : `${room.name} has no planned or assigned items.`;
  }
  planRenderDeleteSubprojectOptions();
  openModal('planDeleteSubprojectModal');
}

function planSetDeleteSubprojectMode(mode) {
  planDeleteSubprojectState.mode = mode === 'remove' ? 'remove' : 'merge';
  planRenderDeleteSubprojectOptions();
}

function planSetDeleteSubprojectTarget(encodedSubprojectId) {
  planDeleteSubprojectState.targetSubprojectId = planDecode(encodedSubprojectId);
  planRenderDeleteSubprojectOptions();
}

function planRenderDeleteSubprojectOptions() {
  const modal = document.getElementById('planDeleteSubprojectModal');
  if (!modal) return;
  modal.querySelectorAll('[data-delete-mode]').forEach(button => {
    button.classList.toggle(
      'active',
      button.dataset.deleteMode === planDeleteSubprojectState.mode
    );
  });
  const targets = document.getElementById('planDeleteSubprojectTargets');
  if (!targets) return;
  if (planDeleteSubprojectState.mode !== 'merge') {
    targets.innerHTML = `
      <div class="event-subproject-remove-warning">
        Requirements, prepared quantities, and assigned assets in this room will be removed from the event.
      </div>
    `;
    return;
  }
  targets.innerHTML = `
    <span>Merge into</span>
    <div>
      ${eventSubprojects(planPageState.event)
        .filter(room => String(room.id) !== String(planDeleteSubprojectState.subprojectId))
        .map(room => `
          <button type="button"
                  class="${String(room.id) === String(planDeleteSubprojectState.targetSubprojectId) ? 'active' : ''}"
                  onclick="planSetDeleteSubprojectTarget('${planEncode(room.id)}')">
            ${escapeHtml(room.name || 'Room')}
          </button>
        `).join('')}
    </div>
  `;
}

async function planDeleteSubproject(state) {
  if (!state.subprojectId) return;
  if (state.mode === 'merge' && !state.targetSubprojectId) {
    showNotification('warning', 'Choose a destination room');
    return;
  }
  try {
    const response = await apiCall(
      `/api/events/${planPageState.eventId}/subprojects/${encodeURIComponent(state.subprojectId)}`,
      'DELETE',
      {
        mode: state.mode,
        targetSubprojectId: state.mode === 'merge' ? state.targetSubprojectId : ''
      }
    );
    closeModal('planDeleteSubprojectModal');
    planPageState.event.subprojects = response.data?.subprojects || [];
    planPageState.activeSubprojectId = state.mode === 'merge'
      ? state.targetSubprojectId
      : String(planPageState.event.subprojects[0]?.id || '');
    showNotification('success', response.message || 'Sub-project deleted');
    await refreshPlanSelectedEvent();
  } catch (error) {}
}

async function planConfirmDeleteSubproject() {
  await planDeleteSubproject(planDeleteSubprojectState);
}

function eventSubprojectGroupKey(value) {
  return [
    normalizeDepartmentCode(value?.departmentCode || value?.department || 'UN'),
    String(value?.brand || '').trim().toLowerCase(),
    String(value?.model || '').trim().toLowerCase()
  ].join('|');
}

function eventSubprojectModelItems(room) {
  const groups = new Map();
  (room?.items || []).forEach(item => {
    if (item?.isCustom || !item?.brand || !item?.model) return;
    const key = eventSubprojectGroupKey(item);
    if (!groups.has(key)) {
      groups.set(key, {
        ...item,
        department: normalizeDepartmentCode(item.departmentCode || item.department || 'UN'),
        requiredQuantity: 0,
        preparedQuantity: 0,
        assetRefs: []
      });
    }
    const group = groups.get(key);
    group.requiredQuantity += Math.max(0, Number(item.quantity || 0));
    group.preparedQuantity += Math.max(0, Number(item.preparedQuantity || 0));
    group.assetRefs.push(...(item.assetRefs || []).map(String));
  });
  return groups;
}

function eventSubprojectAssetAllocations(event) {
  const rooms = eventSubprojects(event);
  const allocations = new Map(rooms.map(room => [String(room.id), new Set()]));
  const claimed = new Set();

  rooms.forEach(room => {
    const refs = [
      ...(room.extraRefs || []),
      ...(room.items || []).flatMap(item => item?.assetRefs || [])
    ].map(String);
    refs.forEach(ref => {
      allocations.get(String(room.id))?.add(ref);
      claimed.add(ref);
    });
  });

  const globalGroups = Object.values(event?.modelGroups || {});
  globalGroups.forEach(group => {
    const groupKey = eventSubprojectGroupKey(group);
    const candidates = (group.assignedAssets || []).filter(asset => (
      asset?.id && !asset?.isExtra && !claimed.has(String(asset.id))
    ));
    let cursor = 0;
    rooms.forEach(room => {
      const required = eventSubprojectModelItems(room).get(groupKey)?.requiredQuantity || 0;
      const already = (group.assignedAssets || []).reduce((total, asset) => (
        allocations.get(String(room.id))?.has(String(asset?.id || ''))
          ? total + Math.max(1, Number(asset?.quantity || 1))
          : total
      ), 0);
      let remaining = Math.max(0, required - already);
      while (cursor < candidates.length && remaining > 0) {
        const asset = candidates[cursor++];
        allocations.get(String(room.id))?.add(String(asset.id));
        claimed.add(String(asset.id));
        remaining -= Math.max(1, Number(asset.quantity || 1));
      }
    });
    while (cursor < candidates.length && rooms.length) {
      const asset = candidates[cursor++];
      allocations.get(String(rooms[0].id))?.add(String(asset.id));
    }

    (group.assignedAssets || []).filter(asset => (
      asset?.id && asset?.isExtra && !claimed.has(String(asset.id))
    )).forEach(asset => {
      if (!rooms.length) return;
      allocations.get(String(rooms[0].id))?.add(String(asset.id));
      claimed.add(String(asset.id));
    });
  });
  return allocations;
}

function eventSubprojectModelGroups(event, state) {
  const rooms = eventSubprojects(event);
  if (!rooms.length) return Object.values(event?.modelGroups || {});
  const room = eventActiveSubproject(state, event);
  if (!room) {
    const roomExtraRefs = new Set(rooms.flatMap(row => (row.extraRefs || []).map(String)));
    const roomOwnedRefs = new Set(rooms.flatMap(row => [
      ...(row.extraRefs || []),
      ...(row.items || []).flatMap(item => item?.assetRefs || [])
    ].map(String)));
    return Object.values(event?.modelGroups || {}).map(group => ({
      ...group,
      assignedAssets: (group.assignedAssets || []).map(asset => {
        const assetId = String(asset?.id || '');
        return {
          ...asset,
          isExtra: roomExtraRefs.has(assetId) || (
            !roomOwnedRefs.has(assetId) && !!asset?.isExtra
          )
        };
      })
    }));
  }
  const roomItems = eventSubprojectModelItems(room);
  const globalGroups = Object.values(event?.modelGroups || {});
  const globalByKey = new Map(globalGroups.map(group => [eventSubprojectGroupKey(group), group]));
  const allocations = eventSubprojectAssetAllocations(event).get(String(room.id)) || new Set();
  const roomExtraRefs = new Set((room.extraRefs || []).map(String));
  const explicitRoomRefs = new Set([
    ...(room.extraRefs || []),
    ...(room.items || []).flatMap(item => item?.assetRefs || [])
  ].map(String));

  return Array.from(roomItems.entries()).map(([key, item]) => {
    const source = globalByKey.get(key) || item;
    const assignedAssets = (source.assignedAssets || [])
      .filter(asset => allocations.has(String(asset?.id || '')))
      .map(asset => {
        const assetId = String(asset?.id || '');
        return {
          ...asset,
          isExtra: roomExtraRefs.has(assetId) || (
            !explicitRoomRefs.has(assetId) && !!asset?.isExtra
          )
        };
      });
    const hasTrackedSlots = (room.items || []).some(row => (
      eventSubprojectGroupKey(row) === key && Object.prototype.hasOwnProperty.call(row, 'preparedQuantity')
    ));
    const hasTrackedReturnedSlots = (room.items || []).some(row => (
      eventSubprojectGroupKey(row) === key && Object.prototype.hasOwnProperty.call(row, 'returnedPreparedQuantity')
    ));
    let preparedSlots = Math.max(0, Number(item.preparedQuantity || 0));
    let returnedPreparedSlots = Math.max(0, Number(item.returnedPreparedQuantity || 0));
    if (!hasTrackedSlots) {
      const sourceSlots = Math.max(0, Number(source.preparedSlotQuantity || 0));
      let priorRequired = 0;
      for (const otherRoom of rooms) {
        if (otherRoom === room) break;
        priorRequired += eventSubprojectModelItems(otherRoom).get(key)?.requiredQuantity || 0;
      }
      preparedSlots = Math.min(
        item.requiredQuantity,
        Math.max(0, sourceSlots - priorRequired)
      );
    }
    if (!hasTrackedReturnedSlots) {
      const sourceSlots = Math.max(0, Number(source.returnedPreparedSlotQuantity || 0));
      let priorRequired = 0;
      for (const otherRoom of rooms) {
        if (otherRoom === room) break;
        priorRequired += eventSubprojectModelItems(otherRoom).get(key)?.requiredQuantity || 0;
      }
      returnedPreparedSlots = Math.min(
        item.requiredQuantity,
        Math.max(0, sourceSlots - priorRequired)
      );
    }
    const assignedSpecific = assignedAssets.reduce(
      (total, asset) => total + Math.max(1, Number(asset?.quantity || 1)),
      0
    );
    const countableAssignedSpecific = assignedAssets.reduce(
      (total, asset) => total + (asset?.isExtra ? 0 : Math.max(1, Number(asset?.quantity || 1))),
      0
    );
    const returnedSpecific = assignedAssets.reduce(
      (total, asset) => total + (asset?.status === 'returned' ? Math.max(1, Number(asset?.quantity || 1)) : 0),
      0
    );
    const countableReturnedSpecific = assignedAssets.reduce(
      (total, asset) => total + (
        !asset?.isExtra && asset?.status === 'returned'
          ? Math.max(1, Number(asset?.quantity || 1))
          : 0
      ),
      0
    );
    const activeExtraSpecific = assignedAssets.reduce(
      (total, asset) => total + (
        asset?.isExtra && asset?.status !== 'returned'
          ? Math.max(1, Number(asset?.quantity || 1))
          : 0
      ),
      0
    );
    const returned = returnedSpecific + returnedPreparedSlots;
    const assigned = assignedSpecific + preparedSlots + returnedPreparedSlots;
    const prepared = Math.max(0, assigned - returned);
    const required = Math.max(0, Number(item.requiredQuantity || 0));
    const countableAssigned = countableAssignedSpecific + preparedSlots + returnedPreparedSlots;
    const countableReturned = countableReturnedSpecific + returnedPreparedSlots;
    const countablePrepared = Math.max(0, countableAssigned - countableReturned);
    return {
      ...source,
      department: item.department,
      brand: item.brand,
      model: item.model,
      description: item.description || source.description || '',
      requiredQuantity: required,
      assignedAssets,
      assignedSpecificQuantity: assignedSpecific,
      assignedQuantity: assigned,
      returnedQuantity: returned,
      preparedSlotQuantity: preparedSlots,
      returnedPreparedSlotQuantity: returnedPreparedSlots,
      openPreparedSlots: preparedSlots,
      preparedQuantity: prepared,
      countableAssignedQuantity: Math.min(required, countableAssigned),
      countableReturnedQuantity: Math.min(required, countableReturned),
      countablePreparedQuantity: Math.min(required, countablePrepared),
      extraPreparedQuantity: activeExtraSpecific + Math.max(
        0,
        preparedSlots + countableAssignedSpecific - required
      )
    };
  });
}

var planEventChooserState = {
  search: '',
  filter: 'ALL',
  page: 1,
  pageSize: 8,
  context: 'plan'
};

var PLAN_EVENT_CHOOSER_FILTERS = [
  { key: 'ALL', label: 'All' },
  { key: 'ACTIVE', label: 'Active' },
  { key: 'PLANNING', label: 'Planning' },
  { key: 'PREPARING', label: 'Preparing' },
  { key: 'ONGOING', label: 'Ongoing' },
  { key: 'RETURNING', label: 'Returning' },
  { key: 'COMPLETED', label: 'Completed' }
];

function planEncode(value) {
  const encoded = encodeURIComponent(String(value ?? ''))
    .replace(/'/g, '%27');
  return escapeHtmlAttr(encoded);
}

function planDecode(value) {
  try {
    return decodeURIComponent(String(value || ''));
  } catch (error) {
    return String(value || '');
  }
}

function planCustomAssets(eventData = planPageState.event) {
  const customAssets = getCustomAssetsFromEvent(eventData || {});
  const visibleAssets = eventScopedCustomAssets(eventData, planPageState, customAssets);
  return groupEventCustomAssets(visibleAssets).map(asset => ({
    ...asset.parsedCustom,
    id: asset.id,
    assetIds: asset.assetIds,
    status: asset.status || 'assigned'
  })).sort((a, b) =>
    compareByDisplayName(customAssetSortName(a), customAssetSortName(b))
  );
}

function planModelGroups(eventData = planPageState.event) {
  return eventSubprojectModelGroups(eventData, planPageState)
    .filter(group => Number(group?.requiredQuantity || 0) > 0)
    .sort((a, b) => (
      compareByDisplayName(a.department, b.department) ||
      compareByDisplayName(modelGroupSortName(a), modelGroupSortName(b))
    ));
}

function planEventSnapshot() {
  return {
    models: planModelGroups().map(group => ({
      department: normalizeDepartmentCode(group.department || 'UN'),
      brand: String(group.brand || ''),
      model: String(group.model || ''),
      description: String(group.description || ''),
      quantity: Math.max(1, Number(group.requiredQuantity || 1))
    })),
    customAssets: planCustomAssets().map(custom => ({
      type: normalizeCustomType(custom.type),
      name: String(custom.name || ''),
      quantity: Math.max(1, Number(custom.quantity || 1)),
      department: normalizeDepartmentCode(custom.department || 'UN'),
      company: String(custom.company || ''),
      description: String(custom.description || '')
    }))
  };
}

function planEventHasRequirements() {
  if (planModelGroups().length || planCustomAssets().length) return true;
  return (planPageState.event?.preparedItems || []).some(ref =>
    typeof ref === 'string' && ref.trim()
  );
}

function planTotals() {
  const models = planModelGroups();
  const customAssets = planCustomAssets();
  const departmentsInUse = new Set();
  let totalQuantity = 0;

  models.forEach(group => {
    totalQuantity += Math.max(0, Number(group.requiredQuantity || 0));
    departmentsInUse.add(normalizeDepartmentCode(group.department || 'UN'));
  });
  customAssets.forEach(custom => {
    totalQuantity += Math.max(1, Number(custom.quantity || 1));
    departmentsInUse.add(normalizeDepartmentCode(custom.department || 'UN'));
  });

  return {
    lineCount: models.length + customAssets.length,
    totalQuantity,
    departmentCount: departmentsInUse.size,
    templateCount: planPageState.templates.length
  };
}

function planEventOptionLabel(event) {
  return String(event?.name || `Event ${event?.id || ''}`);
}

function planStateSlug(value) {
  return String(value || 'added')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-');
}

function planEventTypeBadgeHtml(event) {
  const isDryHire = event?.tag === 'dry hire';
  return `
    <span class="plan-badge ${isDryHire ? 'plan-badge-type-dry-hire' : 'plan-badge-type-event'}">
      ${isDryHire ? 'Dry Hire' : 'Event'}
    </span>
  `;
}

function planEventStateBadgeHtml(event) {
  const state = String(event?.state || 'New');
  return `
    <span class="plan-badge plan-badge-state-${escapeHtmlAttr(planStateSlug(state))}">
      ${escapeHtml(eventStateDisplayLabel(state))}
    </span>
  `;
}

function planEventChooserFilterKey(event) {
  const state = planStateSlug(event?.state);
  if (['new', 'added', 'planning'].includes(state)) return 'PLANNING';
  if (['preparing', 'ready'].includes(state)) return 'PREPARING';
  if (['ongoing', 'last-day'].includes(state)) return 'ONGOING';
  if (['returning', 'overdue'].includes(state)) return 'RETURNING';
  if (['pending-closure', 'closed', 'completed'].includes(state)) return 'COMPLETED';
  return 'PLANNING';
}

function planEventChooserSearchText(event) {
  return [
    event?.id,
    event?.name,
    event?.client,
    event?.clientName,
    event?.client_name,
    event?.clientCompany,
    event?.client_company,
    event?.location,
    event?.venue,
    event?.state
  ].filter(Boolean).join(' ').toLowerCase();
}

function planEventChooserDateValue(value) {
  const raw = String(value || '').trim();
  if (!raw) return Number.POSITIVE_INFINITY;
  const normalized = /^\d{8}$/.test(raw)
    ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`
    : raw.replace(/\//g, '-');
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(normalized)
    ? new Date(`${normalized}T12:00:00`)
    : new Date(normalized);
  const valueOf = parsed.valueOf();
  return Number.isFinite(valueOf) ? valueOf : Number.POSITIVE_INFINITY;
}

function planEventChooserFormattedDate(value) {
  const dateValue = planEventChooserDateValue(value);
  if (!Number.isFinite(dateValue)) return '';
  return new Date(dateValue).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric'
  });
}

function planCompareEventsByStartDate(a, b) {
  const aDate = planEventChooserDateValue(a?.startDate);
  const bDate = planEventChooserDateValue(b?.startDate);
  const aHasDate = Number.isFinite(aDate);
  const bHasDate = Number.isFinite(bDate);
  if (aHasDate && bHasDate && aDate !== bDate) return bDate - aDate;
  if (aHasDate !== bHasDate) return aHasDate ? -1 : 1;
  return Number(a?.id || 0) - Number(b?.id || 0);
}

function planCompareEventsByEventIdDesc(a, b) {
  return Number(b?.id || 0) - Number(a?.id || 0);
}

function planEventChooserDateRange(event) {
  const start = planEventChooserFormattedDate(event?.startDate);
  const end = planEventChooserFormattedDate(event?.endDate);
  if (!start && !end) return 'Date not set';
  return !end || start === end ? (start || end) : `${start} – ${end}`;
}

function planEventChooserRelativeDate(event) {
  const startValue = planEventChooserDateValue(event?.startDate);
  if (!Number.isFinite(startValue)) return '';
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0, 0);
  const days = Math.round((startValue - today.valueOf()) / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days === -1) return 'Yesterday';
  return days > 1 ? `in ${days} days` : `${Math.abs(days)} days ago`;
}

function planEventChooserSecondaryLabel(event) {
  return String(
    event?.client ||
    event?.clientName ||
    event?.client_name ||
    event?.clientCompany ||
    event?.client_company ||
    ''
  );
}

function planEventChooserSourceEvents() {
  if (planEventChooserState.context === 'transfer-source' || planEventChooserState.context === 'transfer-target') {
    return transferSelectableEvents();
  }
  if (planEventChooserState.context === 'prepare-new') {
    return prepareNewPageState.events || [];
  }
  if (planEventChooserState.context === 'profit-loss' && typeof profitLossEventChooserEvents === 'function') {
    return profitLossEventChooserEvents();
  }
  if (planEventChooserState.context === 'compare' && typeof compareEventChooserEvents === 'function') {
    return compareEventChooserEvents();
  }
  return planPageState.events || [];
}

function planEventChooserCurrentEventId() {
  if (planEventChooserState.context === 'transfer-source') {
    return transferPageState.sourceEventId;
  }
  if (planEventChooserState.context === 'transfer-target') {
    return transferPageState.targetEventId;
  }
  if (planEventChooserState.context === 'profit-loss' && typeof profitLossCurrentEventId === 'function') {
    return profitLossCurrentEventId();
  }
  if (planEventChooserState.context === 'compare' && typeof compareCurrentEventId === 'function') {
    return compareCurrentEventId();
  }
  return planEventChooserState.context === 'prepare-new'
    ? prepareNewPageState.eventId
    : planPageState.eventId;
}

function planEventChooserFilteredEvents() {
  const search = String(planEventChooserState.search || '').trim().toLowerCase();
  const filter = planEventChooserState.filter || 'ALL';
  return planEventChooserSourceEvents()
    .filter(event => (
      (
        filter === 'ALL' ||
        (filter === 'ACTIVE' && !['pending-closure', 'closed', 'completed'].includes(planStateSlug(event?.state))) ||
        planEventChooserFilterKey(event) === filter
      ) &&
      (!search || planEventChooserSearchText(event).includes(search))
    ))
    .sort(planEventChooserState.context === 'profit-loss'
      ? planCompareEventsByEventIdDesc
      : planCompareEventsByStartDate);
}

function ensurePlanEventChooserModal() {
  let modal = document.getElementById('planEventChooserModal');
  if (modal) return modal;

  modal = document.createElement('div');
  modal.id = 'planEventChooserModal';
  modal.className = 'modal';
  modal.setAttribute('aria-hidden', 'true');
  modal.innerHTML = `
    <div class="modal-content">
      <div class="modal-header">
        <h3 class="modal-title">Other Events <span title="Select any event to update its plan">&#9432;</span></h3>
        <button type="button" class="close-btn" aria-label="Close event picker"
                onclick="closeModal('planEventChooserModal')">&times;</button>
      </div>
      <div class="plan-event-chooser-search">
        <span aria-hidden="true">&#128269;</span>
        <input type="search" id="planEventChooserSearch"
               placeholder="Search events by name, ID, client, or location..."
               oninput="planEventChooserSearchChanged(this.value)">
      </div>
      <div class="plan-event-chooser-filters" id="planEventChooserFilters"></div>
      <div class="plan-event-chooser-table">
        <div class="plan-event-chooser-head">
          <span>Event</span>
          <span>Dates</span>
          <span>Location</span>
          <span>Status</span>
          <span></span>
        </div>
        <div class="plan-event-chooser-results" id="planEventChooserResults"></div>
      </div>
      <div class="plan-event-chooser-footer" id="planEventChooserFooter"></div>
    </div>
  `;
  modal.addEventListener('click', event => {
    if (event.target === modal) closeModal('planEventChooserModal');
  });
  document.body.appendChild(modal);
  return modal;
}

function renderPlanEventChooser() {
  const filters = document.getElementById('planEventChooserFilters');
  const results = document.getElementById('planEventChooserResults');
  const footer = document.getElementById('planEventChooserFooter');
  if (!filters || !results || !footer) return;

  const counts = planEventChooserSourceEvents().reduce((summary, event) => {
    const key = planEventChooserFilterKey(event);
    summary.ALL += 1;
    if (!['pending-closure', 'closed', 'completed'].includes(planStateSlug(event?.state))) {
      summary.ACTIVE += 1;
    }
    summary[key] = (summary[key] || 0) + 1;
    return summary;
  }, { ALL: 0, ACTIVE: 0 });

  filters.innerHTML = PLAN_EVENT_CHOOSER_FILTERS.map(filter => `
    <button type="button"
            class="plan-event-chooser-filter plan-event-chooser-filter-${filter.key.toLowerCase()} ${planEventChooserState.filter === filter.key ? 'active' : ''}"
            onclick="planSetEventChooserFilter('${filter.key}')">
      ${escapeHtml(filter.label)}
      <span class="plan-event-chooser-count">${Number(counts[filter.key] || 0)}</span>
    </button>
  `).join('');

  const events = planEventChooserFilteredEvents();
  const pageCount = Math.max(1, Math.ceil(events.length / planEventChooserState.pageSize));
  planEventChooserState.page = Math.min(Math.max(1, planEventChooserState.page), pageCount);
  const start = (planEventChooserState.page - 1) * planEventChooserState.pageSize;
  const visibleEvents = events.slice(start, start + planEventChooserState.pageSize);

  results.innerHTML = visibleEvents.length ? visibleEvents.map(event => `
    <button type="button"
            class="plan-event-option ${Number(event.id) === Number(planEventChooserCurrentEventId()) ? 'current' : ''}"
            onclick="planChooseEvent(${Number(event.id)})">
      <span class="plan-event-option-name">
        <span class="plan-event-option-title-line">
          <strong>#${escapeHtml(String(event.id || ''))} &nbsp; ${escapeHtml(planEventOptionLabel(event))}</strong>
          ${planEventTypeBadgeHtml(event)}
        </span>
        <span>${escapeHtml(planEventChooserSecondaryLabel(event))}</span>
      </span>
      <span class="plan-event-option-dates">
        ${escapeHtml(planEventChooserDateRange(event))}
        <span>${escapeHtml(planEventChooserRelativeDate(event))}</span>
      </span>
      <span class="plan-event-option-location">${escapeHtml(event.location || event.venue || '—')}</span>
      ${planEventStateBadgeHtml(event)}
      <span class="plan-event-option-arrow" aria-hidden="true">›</span>
    </button>
  `).join('') : '<div class="plan-empty">No events match this search.</div>';

  const firstShown = events.length ? start + 1 : 0;
  const lastShown = Math.min(start + visibleEvents.length, events.length);
  const visiblePages = [];
  for (let page = 1; page <= pageCount; page += 1) {
    if (pageCount <= 7 || page === 1 || page === pageCount || Math.abs(page - planEventChooserState.page) <= 1) {
      visiblePages.push(page);
    }
  }
  const pageControls = [];
  let previousPage = 0;
  visiblePages.forEach(page => {
    if (previousPage && page - previousPage > 1) {
      pageControls.push('<span aria-hidden="true">…</span>');
    }
    pageControls.push(`
      <button type="button"
              class="plan-event-chooser-page ${page === planEventChooserState.page ? 'active' : ''}"
              onclick="planSetEventChooserPage(${page})">${page}</button>
    `);
    previousPage = page;
  });

  footer.innerHTML = `
    <span>Showing ${firstShown} to ${lastShown} of ${events.length} events</span>
    <div class="plan-event-chooser-pages">
      <button type="button" class="plan-event-chooser-page"
              ${planEventChooserState.page <= 1 ? 'disabled' : ''}
              onclick="planSetEventChooserPage(${planEventChooserState.page - 1})"
              aria-label="Previous page">‹</button>
      ${pageControls.join('')}
      <button type="button" class="plan-event-chooser-page"
              ${planEventChooserState.page >= pageCount ? 'disabled' : ''}
              onclick="planSetEventChooserPage(${planEventChooserState.page + 1})"
              aria-label="Next page">›</button>
    </div>
  `;
}

function planOpenEventChooser(context = 'plan') {
  const modal = ensurePlanEventChooserModal();
  planEventChooserState.context = context;
  planEventChooserState.search = '';
  planEventChooserState.filter = 'ALL';
  planEventChooserState.page = 1;
  const title = modal.querySelector('.modal-title');
  if (title) {
    const titleText = context === 'transfer-source'
      ? 'Choose From Event'
      : context === 'transfer-target'
        ? 'Choose To Event'
        : context === 'profit-loss'
          ? 'Choose Profit & Loss Event'
          : context === 'compare'
            ? 'Choose Event to Compare'
            : 'Other Events';
    const titleHelp = context === 'transfer-source'
      ? 'Select the event assets are moving out from'
      : context === 'transfer-target'
        ? 'Select the event assets are moving into'
        : context === 'profit-loss'
          ? 'Select an event to review revenue, costs, and net profit'
          : context === 'compare'
            ? 'Select an event to compare against its quotation'
            : 'Select any event to update its plan';
    title.innerHTML = `${titleText} <span title="${escapeHtmlAttr(titleHelp)}">&#9432;</span>`;
  }
  const search = document.getElementById('planEventChooserSearch');
  if (search) search.value = '';
  renderPlanEventChooser();
  openModal('planEventChooserModal');
}

function planEventChooserSearchChanged(value) {
  planEventChooserState.search = value;
  planEventChooserState.page = 1;
  renderPlanEventChooser();
}

function planSetEventChooserFilter(filter) {
  planEventChooserState.filter = filter || 'ALL';
  planEventChooserState.page = 1;
  renderPlanEventChooser();
}

function planSetEventChooserPage(page) {
  planEventChooserState.page = Math.max(1, Number(page || 1));
  renderPlanEventChooser();
}

async function planChooseEvent(eventId) {
  closeModal('planEventChooserModal');
  if (Number(eventId) === Number(planEventChooserCurrentEventId())) return;
  if (planEventChooserState.context === 'transfer-source') {
    await transferChooseEvent('source', eventId);
    return;
  }
  if (planEventChooserState.context === 'transfer-target') {
    await transferChooseEvent('target', eventId);
    return;
  }
  if (planEventChooserState.context === 'prepare-new') {
    await selectPrepareNewEvent(eventId);
    return;
  }
  if (planEventChooserState.context === 'profit-loss' && typeof selectProfitLossEvent === 'function') {
    await selectProfitLossEvent(eventId);
    return;
  }
  if (planEventChooserState.context === 'compare' && typeof selectCompareEvent === 'function') {
    await selectCompareEvent(eventId);
    return;
  }
  await selectPlanEvent(eventId);
}

function planMetricIconSvg(kind) {
  const icons = {
    lines: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 7 8-4 8 4-8 4-8-4Z"></path><path d="M4 7v10l8 4 8-4V7"></path><path d="M12 11v10"></path></svg>',
    quantity: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="7" height="7" rx="1"></rect><rect x="14" y="4" width="7" height="7" rx="1"></rect><rect x="3" y="15" width="7" height="6" rx="1"></rect><rect x="14" y="15" width="7" height="6" rx="1"></rect></svg>',
    departments: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="5" r="2.5"></circle><circle cx="5" cy="18" r="2.5"></circle><circle cx="19" cy="18" r="2.5"></circle><path d="M12 7.5v4M5 15.5v-4h14v4"></path></svg>',
    templates: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h9l3 3v15H6z"></path><path d="M14 3v4h4M9 11h6M9 15h6"></path></svg>',
    calendar: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"></rect><path d="M7 3v4M17 3v4M3 10h18"></path></svg>',
    assignment: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4h6l1 2h3v15H5V6h3l1-2Z"></path><path d="M9 12l2 2 4-5M8 18h8"></path></svg>'
  };
  return icons[kind] || icons.lines;
}

function planDepartmentLabel(code) {
  const department = getDepartmentMeta(code);
  return department.name && department.name !== department.code
    ? `${department.name} (${department.code})`
    : department.code;
}

function planDepartmentColor(code) {
  return getDepartmentMeta(code).color || '#667085';
}

function planDepartmentCodeBadgeHtml(code) {
  const department = getDepartmentMeta(code);
  const normalizedCode = normalizeDepartmentCode(code || 'UN');
  return `
    <span class="plan-dept-code-badge"
          style="background:${escapeHtmlAttr(department.color || '#e2e3e5')};color:${escapeHtmlAttr(department.textColor || '#344054')};"
          title="${escapeHtmlAttr(department.name || normalizedCode)}">
      ${escapeHtml(normalizedCode)}
    </span>
  `;
}

function planDepartmentFilterStyle(code) {
  const department = getDepartmentMeta(code);
  const color = department.color || '#e2e3e5';
  return `background:${escapeHtmlAttr(color)};color:${escapeHtmlAttr(department.textColor || '#344054')};border-color:${escapeHtmlAttr(color)};`;
}

function planAvailableModelGroups() {
  const groups = {};
  (planPageState.assets || []).forEach(asset => {
    addAssetToEditModelGroup(
      groups,
      asset,
      asset.isBulk ? Number(asset.quantity || 1) : 1
    );
  });
  return Object.values(groups).sort((a, b) => (
    compareByDisplayName(a.department, b.department) ||
    compareByDisplayName(modelGroupSortName(a), modelGroupSortName(b))
  ));
}

function planAvailableModelSearchText(group) {
  const assetDescriptions = (group?.assets || []).map(asset =>
    String(asset?.description || '').trim()
  );
  const assetTags = (group?.assets || []).map(assetTagSearchText);
  return [
    group?.department,
    group?.brand,
    group?.model,
    group?.description,
    ...assetDescriptions,
    ...assetTags
  ]
    .map(value => String(value || '').trim())
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function planAvailabilityFor(group) {
  const entry = (planPageState.availability || []).find(item =>
    modelGroupMatchesEditGroup(
      item,
      group.department,
      group.brand,
      group.model
    )
  );
  const physical = Number(entry?.physical ?? group.count ?? 0);
  const overlap = Number(entry?.overlappingDemand || 0);
  const unavailableForCondition = Number(entry?.assetOOC || 0)
    + Number(entry?.assetMissing || 0)
    + Number(entry?.bulkMaintenanceOOC || 0)
    + Number(entry?.bulkMaintenanceMissing || 0);
  const degraded = Number(entry?.degraded ?? (
    Number(entry?.assetDegraded || 0) + Number(entry?.bulkMaintenanceDegraded || 0)
  ));
  const capacity = entry
    ? Number(entry?.capacityForThisEvent ?? Math.max(physical - overlap - unavailableForCondition, 0))
    : 0;
  return {
    hasEntry: !!entry,
    available: Number(entry?.available ?? group.count ?? 0),
    physical,
    capacity,
    healthyCapacity: entry
      ? Number(entry?.healthyCapacityForThisEvent ?? Math.max(capacity - degraded, 0))
      : 0,
    healthy: Number(entry?.healthy ?? Math.max(capacity - degraded, 0)),
    degraded,
    overlap,
    overlapEvents: entry?.overlappingEvents || [],
    usedHere: Number(entry?.usedInThisEvent || 0),
    preparable: Number(entry?.preparable ?? entry?.available ?? group.count ?? 0),
    assetOOC: Number(entry?.assetOOC || 0),
    assetMissing: Number(entry?.assetMissing || 0),
    bulkMaintenanceOOC: Number(entry?.bulkMaintenanceOOC || 0),
    bulkMaintenanceMissing: Number(entry?.bulkMaintenanceMissing || 0),
    degradedDetails: Array.isArray(entry?.degradedDetails) ? entry.degradedDetails : []
  };
}

function planDegradedReasonDetail(availability) {
  const details = Array.isArray(availability?.degradedDetails)
    ? availability.degradedDetails
    : [];
  if (details.length === 0) {
    return '\n\nDegradation reason: No reason recorded.';
  }

  const rows = details.map(detail => {
    const quantity = Math.max(1, Number(detail?.quantity || 1));
    const assetId = String(detail?.assetId || '').trim();
    const label = detail?.isBulk
      ? `${quantity} bulk unit${quantity === 1 ? '' : 's'}`
      : (assetId || `${quantity} asset${quantity === 1 ? '' : 's'}`);
    const reasons = [...new Set(
      (Array.isArray(detail?.reasons) ? detail.reasons : [])
        .map(reason => String(reason || '').trim())
        .filter(Boolean)
    )];
    return `${label}: ${reasons.join('; ') || 'No reason recorded'}`;
  });

  return `\n\nWhy the degraded assets are degraded:\n- ${rows.join('\n- ')}`;
}

function planShowAvailabilityReason(encodedReason) {
  let detail;
  try {
    detail = JSON.parse(planDecode(encodedReason));
  } catch (error) {
    detail = { summary: planDecode(encodedReason) };
  }
  showAppAlert({
    title: 'Asset Availability',
    buildMessage: container => {
      container.classList.add('plan-availability-dialog');
      const summary = document.createElement('div');
      summary.className = 'plan-availability-dialog-summary';
      summary.textContent = detail.summary || 'No unavailable assets were detected.';
      container.appendChild(summary);

      const overlappingEvents = Array.isArray(detail.overlappingEvents)
        ? detail.overlappingEvents
        : [];
      if (!overlappingEvents.length) return;
      const heading = document.createElement('strong');
      heading.className = 'plan-availability-dialog-heading';
      heading.textContent = 'Used by overlapping events';
      container.appendChild(heading);

      const list = document.createElement('div');
      list.className = 'plan-availability-event-list';
      overlappingEvents.forEach(event => {
        const eventId = Number(event?.eventId || 0);
        const eventName = String(event?.eventName || `Event ${eventId || ''}`).trim();
        const quantity = Math.max(0, Number(event?.quantity || 0));
        const startDate = String(event?.startDate || '').trim();
        const endDate = String(event?.endDate || '').trim();
        const dates = startDate && endDate && startDate !== endDate
          ? `${startDate} - ${endDate}`
          : (startDate || endDate);
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'plan-availability-event-link';
        button.innerHTML = `
          <span><strong>${escapeHtml(eventId ? `#${eventId}: ${eventName}` : eventName)}</strong>
          <small>${escapeHtml([
            `${quantity} asset${quantity === 1 ? '' : 's'}`,
            dates
          ].filter(Boolean).join(' · '))}</small></span>
          <span aria-hidden="true">View</span>
        `;
        button.addEventListener('click', () => {
          document.querySelector('#appDialogModal [data-dialog-confirm]')?.click();
          if (eventId) setTimeout(() => viewEvent(eventId, { updateHistory: false }), 0);
        });
        list.appendChild(button);
      });
      container.appendChild(list);
    },
    variant: 'warning'
  });
}

function planAvailabilityDetail(group, availability, reasonTooltip = '') {
  const allocations = planRequirementRoomAllocations(group, planPageState.event || {});
  const allocatedQuantity = allocations.reduce(
    (sum, allocation) => sum + allocation.quantity,
    0
  );
  const usedHere = Math.max(0, Number(availability?.usedHere || 0));
  const available = Math.max(0, Number(availability?.available || 0));
  const physical = Math.max(0, Number(availability?.physical || 0));
  const assetName = [group?.brand, group?.model].filter(Boolean).join(' ') || 'Asset';
  const details = [
    `Asset: ${assetName}`,
    `Available: ${available} of ${physical}`,
    `Assigned to this event: ${usedHere}`
  ];

  if (allocations.length > 0) {
    details.push('', 'Sub-project breakdown:');
    allocations.forEach(allocation => {
      details.push(`- ${allocation.name}: ${allocation.quantity}`);
    });
    const unallocated = Math.max(usedHere - allocatedQuantity, 0);
    if (unallocated > 0) details.push(`- Event-level or unallocated: ${unallocated}`);
  } else if (usedHere > 0) {
    details.push('', `- Main event plan: ${usedHere}`);
  }

  const factors = String(reasonTooltip || '')
    .split('\n')
    .slice(1)
    .map(line => line.replace(/^\s*-\s*/, '').trim())
    .filter(line => (
      line &&
      !line.includes('already requested for this event') &&
      !line.includes(' used by #')
    ));
  if (factors.length > 0) {
    details.push('', 'Other availability factors:');
    factors.forEach(factor => details.push(`- ${factor}`));
  }
  return {
    summary: details.join('\n'),
    overlappingEvents: availability?.overlapEvents || []
  };
}

function planAvailabilityLabelHtml(group, availability, reasonTooltip = '') {
  const available = Math.max(0, Number(availability?.available || 0));
  const physical = Math.max(0, Number(availability?.physical || 0));
  const countText = `${available}/${physical || available} available`;
  if (!reasonTooltip || available >= physical) return escapeHtml(countText);
  return `
    <button type="button"
            class="plan-availability-count"
            title="${escapeHtmlAttr(reasonTooltip)}"
            aria-label="Show why only ${escapeHtmlAttr(countText)}"
            onclick="planShowAvailabilityReason('${planEncode(JSON.stringify(planAvailabilityDetail(group, availability, reasonTooltip)))}')">
      ${escapeHtml(countText)}
    </button>
  `;
}

function renderPlanAvailableResults() {
  const results = document.getElementById('planAvailableResults');
  if (!results) return;

  const search = String(planPageState.search || '').trim().toLowerCase();
  const department = planPageState.department || 'ALL';
  const models = planAvailableModelGroups().filter(group => {
    if (
      department !== 'ALL' &&
      normalizeDepartmentCode(group.department) !== department
    ) {
      return false;
    }
    if (!search) return true;
    return planAvailableModelSearchText(group).includes(search);
  });

  const rows = models.slice(0, 80).map((group, index) => {
    const availability = planAvailabilityFor(group);
    const availabilityTooltip = modelAvailabilityReasonTooltip(
      availability.available,
      availability.physical,
      availability
    );
    const inputId = `planAddQty${index}`;
    return `
      <div class="plan-result-row">
        <div>
          <div class="plan-item-title-line">
            <div class="plan-item-name">${escapeHtml([group.brand, group.model].filter(Boolean).join(' '))}</div>
            ${planDepartmentCodeBadgeHtml(group.department)}
          </div>
          <div class="plan-item-description">${escapeHtml(group.description || 'No description')}</div>
        </div>
        <div class="plan-result-side">
          ${planAvailabilityLabelHtml(group, availability, availabilityTooltip)}
        </div>
        <div class="plan-inline-actions">
          <input class="plan-search-input" id="${inputId}" type="number" min="1" value="1"
                 style="width:56px;min-height:30px;padding:5px 7px;">
          <button type="button" class="plan-button plan-button-small"
                  onclick="planAddModel('${planEncode(group.department)}','${planEncode(group.brand)}','${planEncode(group.model)}','${planEncode(group.description || '')}','${inputId}')">
            + Add
          </button>
        </div>
      </div>
    `;
  });

  if (planPageState.showContainers && search.length >= 2) {
    const assetLookup = buildEditAvailableAssetLookup(planPageState.assets || []);
    const matching = (planPageState.containers || [])
      .map(container => ({
        container,
        summary: buildContainerAvailableModelSummary(container, assetLookup)
      }))
      .filter(item =>
        editContainerSearchText(item.container, item.summary).includes(search)
      )
      .slice(0, 30);

    if (matching.length) {
      const families = new Map();
      matching.forEach(item => {
        const label = editContainerFamilyLabel(item.container);
        const key = label.toLowerCase();
        if (!families.has(key)) families.set(key, { label, items: [] });
        families.get(key).items.push(item);
      });

      const variants = [];
      Array.from(families.values())
        .sort((a, b) => compareByDisplayName(a.label, b.label))
        .forEach(family => {
          const familyVariants = new Map();
          family.items.forEach(item => {
            const signature = editContainerSummarySignature(item.summary) || 'empty';
            if (!familyVariants.has(signature)) {
              familyVariants.set(signature, {
                label: family.label,
                items: [],
                summary: item.summary
              });
            }
            familyVariants.get(signature).items.push(item);
          });
          variants.push(...familyVariants.values());
        });

      rows.push(`
        <div style="padding:8px 12px;background:#f8f9fc;border-bottom:1px solid #e8ebf2;font-weight:700;font-size:11px;">
          Matching container types (${variants.length} variation${variants.length === 1 ? '' : 's'} from ${matching.length} case${matching.length === 1 ? '' : 's'})
        </div>
      `);

      variants.forEach(variant => {
        const representativeId = String(variant.items[0]?.container?.id || '');
        const summaryText = variant.summary.groups
          .slice(0, 4)
          .map(group => `${group.count}x ${group.brand} ${group.model}`)
          .join(', ');
        const caseIds = variant.items
          .map(item => String(item.container?.id || ''))
          .filter(Boolean);
        const caseCount = variant.items.length;
        rows.push(`
          <div class="plan-result-row" title="${escapeHtmlAttr(caseIds.join(', '))}">
            <div>
              <div class="plan-item-name">Container: ${escapeHtml(variant.label)}</div>
              <div class="plan-item-description">${escapeHtml(summaryText || 'No available contents')}</div>
            </div>
            <div class="plan-result-side">
              ${caseCount} case${caseCount === 1 ? '' : 's'} · ${variant.summary.usableCount} item${variant.summary.usableCount === 1 ? '' : 's'} each
            </div>
            <button type="button" class="plan-button plan-button-small"
                    title="Add one set of these container contents"
                    ${variant.summary.usableCount ? '' : 'disabled'}
                    onclick="planAddContainerContents('${planEncode(representativeId)}')">
              Add Contents
            </button>
          </div>
        `);
      });
    }
  }

  if (!rows.length) {
    results.innerHTML = '<div class="plan-empty">No matching asset models or containers.</div>';
    return;
  }
  results.innerHTML = rows.join('');
}

function renderPlanAvailableCard() {
  const groups = planAvailableModelGroups();
  const departmentCodes = Array.from(new Set(
    groups.map(group => normalizeDepartmentCode(group.department || 'UN'))
  )).sort(compareByDisplayName);

  return `
    <section class="plan-card">
      <div class="plan-card-header">
        <div>
          <h3>Available Asset Models</h3>
          <p>Add model quantities; specific assets are assigned during Prepare.</p>
        </div>
      </div>
      <div class="plan-search-panel">
        <div class="plan-search-row">
          <input type="search" class="plan-search-input" id="planAssetSearch"
                 value="${escapeHtmlAttr(planPageState.search)}"
                 placeholder="Search brand, model, description, or container..."
                 oninput="planPageState.search=this.value;renderPlanAvailableResults();">
          <label class="plan-toggle">
            <input type="checkbox" ${planPageState.showContainers ? 'checked' : ''}
                   onchange="planPageState.showContainers=this.checked;renderPlanAvailableResults();">
            Show containers
          </label>
        </div>
        <div class="plan-filter-chips">
          <button type="button" class="plan-chip ${planPageState.department === 'ALL' ? 'active' : ''}"
                  onclick="planSetDepartmentFilter('ALL')">All</button>
          ${departmentCodes.map(code => `
            <button type="button" class="plan-chip plan-chip-department ${planPageState.department === code ? 'active' : ''}"
                    style="${planDepartmentFilterStyle(code)}"
                    onclick="planSetDepartmentFilter('${planEncode(code)}')">
              ${escapeHtml(getDepartmentMeta(code).name || code)}
            </button>
          `).join('')}
        </div>
      </div>
      <div class="plan-results" id="planAvailableResults"></div>
    </section>
  `;
}

function planSetDepartmentFilter(encodedDepartment) {
  planPageState.department = planDecode(encodedDepartment) || 'ALL';
  const card = document.getElementById('planAvailableCard');
  if (card) card.innerHTML = renderPlanAvailableCard();
  renderPlanAvailableResults();
}

function planRequirementQuantityControl(group) {
  const quantity = Math.max(1, Number(group.requiredQuantity || 1));
  if (eventIsConsolidated(planPageState, planPageState.event)) {
    return `
      <div class="plan-qty-total" aria-label="${quantity} required across all rooms">
        ${quantity}
      </div>
    `;
  }
  const args = [
    planEncode(group.department),
    planEncode(group.brand),
    planEncode(group.model),
    planEncode(group.description || '')
  ].map(value => `'${value}'`).join(',');
  return `
    <div class="plan-qty-control" aria-label="Required quantity">
      <button type="button" ${quantity <= 1 ? 'disabled' : ''}
              onclick="planSetModelQuantity(${args},${quantity - 1})">−</button>
      <input type="number" min="1" value="${quantity}"
             onchange="planSetModelQuantity(${args},this.value)">
      <button type="button" onclick="planSetModelQuantity(${args},${quantity + 1})">+</button>
    </div>
  `;
}

function planCustomQuantityControl(custom) {
  const quantity = Math.max(1, Number(custom.quantity || 1));
  if (eventIsConsolidated(planPageState, planPageState.event)) {
    return `
      <div class="plan-qty-total" aria-label="${quantity} required across all rooms">
        ${quantity}
      </div>
    `;
  }
  return `
    <div class="plan-qty-control" aria-label="Required quantity">
      <button type="button" ${quantity <= 1 ? 'disabled' : ''}
              onclick="planSetCustomQuantity('${planEncode(custom.id)}',${quantity - 1})">−</button>
      <input type="number" min="1" value="${quantity}"
             onchange="planSetCustomQuantity('${planEncode(custom.id)}',this.value)">
      <button type="button"
              onclick="planSetCustomQuantity('${planEncode(custom.id)}',${quantity + 1})">+</button>
    </div>
  `;
}

function planRequirementRoomAllocations(group, event = planPageState.event) {
  const groupKey = eventSubprojectGroupKey(group);
  return eventSubprojects(event)
    .map(room => {
      const item = eventSubprojectModelItems(room).get(groupKey);
      return {
        id: String(room.id || ''),
        name: String(room.name || 'Unnamed room'),
        quantity: Math.max(0, Number(item?.requiredQuantity || 0))
      };
    })
    .filter(room => room.quantity > 0);
}

function planRequirementWarning(group) {
  return planRequirementWarningForState(group, planPageState);
}

function planRequirementWarningForState(group, state = planPageState) {
  const visibleRequired = Math.max(1, Number(group?.requiredQuantity || 1));
  const availability = planAvailabilityFor(group);
  const fulfillableForThisEvent = Math.max(0, Number(availability.capacity || 0));
  const availabilityDetail = availability.hasEntry
    ? modelAvailabilityReasonTooltip(
        availability.available,
        availability.physical,
        availability
      )
    : 'This asset model is not present in the current inventory.';
  const event = state?.event || planPageState.event || {};
  const rooms = eventSubprojects(event);
  const room = eventActiveSubproject(state, event);
  const roomAllocations = planRequirementRoomAllocations(group, event);
  const allocatedRequired = roomAllocations.reduce(
    (sum, allocation) => sum + allocation.quantity,
    0
  );
  const required = Math.max(
    visibleRequired,
    allocatedRequired > 0 ? allocatedRequired : visibleRequired
  );
  const shortage = Math.max(required - fulfillableForThisEvent, 0);
  const context = [
    `Event #${event.id || ''}: ${event.name || 'Unnamed event'}`,
    rooms.length > 1
      ? (room ? `Room: ${room.name || 'Unnamed room'}` : `Consolidated across ${rooms.length} rooms`)
      : ''
  ].filter(Boolean).join('\n');
  const roomAllocationDetail = roomAllocations.length > 0 && rooms.length > 1
    ? [
        'Assigned to sub-projects:',
        ...roomAllocations.map(allocation => (
          `${allocation.name}: ${allocation.quantity}`
        ))
      ].join('\n')
    : '';
  if (shortage > 0) {
    const inventoryOverage = Math.max(required - availability.physical, 0);
    const inventoryDetail = inventoryOverage > 0
      ? `Required quantity is ${inventoryOverage} above the total inventory of ${availability.physical}.`
      : '';
    return {
      type: 'shortage',
      quantity: shortage,
      availability,
      reason: `${context}\n\n${shortage} of ${required} required unit${required === 1 ? '' : 's'} cannot be fulfilled. ` +
        `Usable capacity for this event is ${fulfillableForThisEvent}.` +
        `${inventoryDetail ? `\n${inventoryDetail}` : ''}` +
        `${roomAllocationDetail ? `\n\n${roomAllocationDetail}` : ''}\n\n${availabilityDetail}`
    };
  }

  const healthyCapacity = Math.max(0, Number(availability.healthyCapacity || 0));
  const degradedRequired = Math.max(required - healthyCapacity, 0);
  if (degradedRequired <= 0) return null;
  const degradedReasonDetail = planDegradedReasonDetail(availability);
  return {
    type: 'degraded',
    quantity: degradedRequired,
    availability,
    reason: `${context}\n\n${degradedRequired} of ${required} required unit${required === 1 ? '' : 's'} ` +
      `can only be fulfilled by using degraded assets. Fully working capacity for this event is ${healthyCapacity}.` +
      `${degradedReasonDetail}` +
      `${roomAllocationDetail ? `\n\n${roomAllocationDetail}` : ''}\n\n${availabilityDetail}`
  };
}

function planSubprojectWarning(room, event = planPageState.event) {
  if (!room || !event) return null;
  const roomState = {
    ...planPageState,
    event,
    activeSubprojectId: String(room.id || '')
  };
  const groups = eventSubprojectModelGroups(event, roomState)
    .filter(group => Number(group?.requiredQuantity || 0) > 0);
  let degradedWarning = null;
  for (const group of groups) {
    const warning = planRequirementWarningForState(group, roomState);
    if (warning?.type === 'shortage') {
      return { type: 'shortage', label: 'Has asset shortage' };
    }
    if (warning?.type === 'degraded') degradedWarning = warning;
  }
  return degradedWarning
    ? { type: 'degraded', label: 'Requires degraded assets' }
    : null;
}

function planShowRequirementWarning(encodedReason, warningType = 'shortage') {
  showAppAlert({
    title: warningType === 'degraded' ? 'Degraded Assets Required' : 'Shortage Detected',
    message: planDecode(encodedReason) || 'This requirement has an availability warning.',
    variant: 'warning',
  });
}

var planReplacementState = { source: null, shortage: 1, sourceQuantity: 1, warningType: 'shortage', preset: '', search: '', mode: 'replace' };

function ensurePlanReplacementModal() {
  let modal = document.getElementById('planReplacementModal');
  if (modal) return modal;
  modal = document.createElement('div');
  modal.id = 'planReplacementModal';
  modal.className = 'modal';
  modal.innerHTML = `
    <div class="modal-content plan-replacement-modal-content">
      <div class="modal-header">
        <div><h3 id="planReplacementTitle">Resolve Shortage</h3><small id="planReplacementSourceLabel"></small></div>
        <button type="button" class="close-btn" aria-label="Close" onclick="closeModal('planReplacementModal')">&times;</button>
      </div>
      <div class="plan-resolution-mode" data-selected="replace" role="radiogroup" aria-label="Resolution method">
        <span class="plan-resolution-mode-indicator" aria-hidden="true"></span>
        <button type="button" role="radio" aria-checked="true" data-plan-resolution-mode="replace" onclick="planSetResolutionMode('replace')">Replace</button>
        <button type="button" role="radio" aria-checked="false" data-plan-resolution-mode="loan" onclick="planSetResolutionMode('loan')">Loan</button>
      </div>
      <div class="plan-replacement-toolbar">
        <div class="plan-replacement-quantity-panel">
          <span>Quantity</span>
          <div class="plan-replacement-quantity-row">
            <div class="plan-qty-control" aria-label="Resolution quantity">
              <button type="button" aria-label="Decrease resolution quantity" onclick="planAdjustReplacementQuantity(-1)">&minus;</button>
              <input id="planReplacementQuantity" type="number" min="1" value="1"
                     aria-label="Resolution quantity" onchange="planSetReplacementQuantity(this.value)">
              <button type="button" aria-label="Increase resolution quantity" onclick="planAdjustReplacementQuantity(1)">+</button>
            </div>
            <div class="plan-replacement-presets" aria-label="Resolution quantity presets">
              <button id="planReplacementShort" type="button" title="Resolve only the quantity currently short for this event period" onclick="planUseReplacementQuantity('short')">Short</button>
              <button id="planReplacementAll" type="button" title="Resolve the full planned quantity for this item" onclick="planUseReplacementQuantity('all')">All</button>
            </div>
          </div>
        </div>
        <div id="planReplacementSearchField">
          <input id="planReplacementSearch" class="form-input" type="search" placeholder="Search replacement assets..."
                 aria-label="Search replacement assets"
                 oninput="planReplacementState.search=this.value;renderPlanReplacementOptions()">
        </div>
      </div>
      <div id="planReplacementPanel">
        <div id="planReplacementOptions" class="plan-replacement-options"></div>
      </div>
      <div id="planLoanResolutionPanel" class="plan-loan-resolution-panel" hidden>
        <form id="planLoanResolutionForm" class="plan-loan-resolution-card" onsubmit="planConvertRequirementToLoan(event)">
          <div>
            <label class="form-label" for="planLoanCompany">Loan company / source</label>
            <input id="planLoanCompany" class="form-input" type="text" maxlength="200"
                   autocomplete="organization" placeholder="Enter supplier or lending company" required>
          </div>
          <p>The selected quantity will be removed from this inventory requirement and added to the event as a loan item.</p>
          <div class="plan-loan-resolution-actions">
            <button id="planLoanResolutionSubmit" type="submit" class="plan-button plan-loan-resolution-submit">Convert to loan</button>
          </div>
        </form>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  return modal;
}

function planOpenResolution(encodedDepartment, encodedBrand, encodedModel, encodedDescription, shortage, warningType = 'shortage') {
  const source = {
    department: planDecode(encodedDepartment),
    brand: planDecode(encodedBrand),
    model: planDecode(encodedModel),
    description: planDecode(encodedDescription)
  };
  const sourceGroup = planModelGroups().find(group => modelGroupMatchesEditGroup(
    group, source.department, source.brand, source.model
  ));
  const maxQuantity = Math.max(1, Number(sourceGroup?.requiredQuantity || shortage || 1));
  planReplacementState = {
    source,
    shortage: Math.min(Math.max(1, Number(shortage || 1)), maxQuantity),
    sourceQuantity: maxQuantity,
    warningType,
    preset: 'short',
    search: '',
    mode: 'replace'
  };
  ensurePlanReplacementModal();
  document.getElementById('planReplacementTitle').textContent = warningType === 'degraded'
    ? 'Resolve Degraded Requirement'
    : 'Resolve Shortage';
  document.getElementById('planReplacementSourceLabel').textContent =
    `${source.brand} ${source.model} needs attention`;
  document.getElementById('planReplacementShort').title = warningType === 'degraded'
    ? 'Resolve only the quantity that would require degraded assets'
    : 'Resolve only the quantity currently short for this event period';
  planUseReplacementQuantity('short');
  document.getElementById('planReplacementSearch').value = '';
  document.getElementById('planLoanCompany').value = '';
  planSetResolutionMode('replace');
  renderPlanReplacementOptions();
  openModal('planReplacementModal');
}

function planSetResolutionMode(mode) {
  const normalizedMode = mode === 'loan' ? 'loan' : 'replace';
  planReplacementState.mode = normalizedMode;
  const selector = document.querySelector('.plan-resolution-mode');
  if (selector) selector.dataset.selected = normalizedMode;
  document.querySelectorAll('[data-plan-resolution-mode]').forEach(button => {
    button.setAttribute('aria-checked', button.dataset.planResolutionMode === normalizedMode ? 'true' : 'false');
  });
  document.getElementById('planReplacementPanel')?.toggleAttribute('hidden', normalizedMode !== 'replace');
  document.getElementById('planReplacementSearchField')?.toggleAttribute('hidden', normalizedMode !== 'replace');
  document.getElementById('planLoanResolutionPanel')?.toggleAttribute('hidden', normalizedMode !== 'loan');
  document.querySelector('.plan-replacement-toolbar')?.classList.toggle('loan-mode', normalizedMode === 'loan');
  if (normalizedMode === 'loan') {
    requestAnimationFrame(() => document.getElementById('planLoanCompany')?.focus());
  }
}

function planSetReplacementQuantity(value, preset = '') {
  const input = document.getElementById('planReplacementQuantity');
  const maximum = Math.max(1, Number(planReplacementState.sourceQuantity || 1));
  const quantity = Math.min(maximum, Math.max(1, Math.round(Number(value || 1))));
  if (input) {
    input.max = maximum;
    input.value = quantity;
  }
  planReplacementState.preset = preset;
  document.getElementById('planReplacementShort')?.classList.toggle('active', preset === 'short');
  document.getElementById('planReplacementAll')?.classList.toggle('active', preset === 'all');
  return quantity;
}

function planAdjustReplacementQuantity(delta) {
  const input = document.getElementById('planReplacementQuantity');
  planSetReplacementQuantity(Number(input?.value || 1) + Number(delta || 0));
}

function planUseReplacementQuantity(mode) {
  const quantity = mode === 'all'
    ? planReplacementState.sourceQuantity
    : planReplacementState.shortage;
  planSetReplacementQuantity(quantity, mode);
}

function renderPlanReplacementOptions() {
  const container = document.getElementById('planReplacementOptions');
  if (!container || !planReplacementState.source) return;
  const query = String(planReplacementState.search || '').trim().toLowerCase();
  const source = planReplacementState.source;
  const options = planAvailableModelGroups().filter(group => {
    if (modelGroupMatchesEditGroup(group, source.department, source.brand, source.model)) return false;
    if (query && !planAvailableModelSearchText(group).includes(query)) return false;
    const availability = planAvailabilityFor(group);
    const usable = planReplacementState.warningType === 'degraded'
      ? availability.healthy
      : availability.available;
    return Math.max(0, usable) > 0;
  }).slice(0, 60);

  container.innerHTML = options.map(group => {
    const availability = planAvailabilityFor(group);
    const maximum = Math.max(0, planReplacementState.warningType === 'degraded'
      ? availability.healthy
      : availability.available);
    const availabilityLabel = planReplacementState.warningType === 'degraded'
      ? 'fully working available to plan'
      : 'available to plan';
    return `
      <div class="plan-replacement-option">
        <div>
          <strong>${escapeHtml([group.brand, group.model].filter(Boolean).join(' '))}</strong>
          <small>${escapeHtml(group.description || 'No description')} &middot; ${maximum} ${availabilityLabel}</small>
        </div>
        ${planDepartmentCodeBadgeHtml(group.department)}
        <button type="button" class="plan-button plan-button-small"
                onclick="planReplaceRequirement('${planEncode(group.department)}','${planEncode(group.brand)}','${planEncode(group.model)}','${planEncode(group.description || '')}',${maximum})">
          Replace
        </button>
      </div>
    `;
  }).join('') || '<div class="plan-empty">No replacement models match this search.</div>';
}

async function planReplaceRequirement(encodedDepartment, encodedBrand, encodedModel, encodedDescription, maximum) {
  const input = document.getElementById('planReplacementQuantity');
  const quantity = Math.max(1, Number(input?.value || 1));
  if (quantity > Number(maximum || 0)) {
    showNotification('warning', `This replacement has only ${maximum} unit(s) available to plan.`);
    input?.focus();
    return;
  }
  try {
    await apiCall(`/api/events/${planPageState.eventId}/models/replace`, 'POST', {
      source: planReplacementState.source,
      replacement: {
        department: planDecode(encodedDepartment),
        brand: planDecode(encodedBrand),
        model: planDecode(encodedModel),
        description: planDecode(encodedDescription)
      },
      quantity,
      subprojectId: eventActiveSubproject(planPageState, planPageState.event)?.id || ''
    });
    closeModal('planReplacementModal');
    showNotification('success', `Replaced ${quantity} planned item${quantity === 1 ? '' : 's'}`);
    await refreshPlanSelectedEvent();
  } catch (error) {}
}

async function planConvertRequirementToLoan(event) {
  event?.preventDefault();
  const companyInput = document.getElementById('planLoanCompany');
  const company = String(companyInput?.value || '').trim();
  const quantity = Math.max(1, Number(document.getElementById('planReplacementQuantity')?.value || 1));
  if (!company) {
    showNotification('warning', 'Enter the company or source providing the loan item.');
    companyInput?.focus();
    return;
  }

  const submitButton = document.getElementById('planLoanResolutionSubmit');
  if (submitButton) {
    submitButton.disabled = true;
    submitButton.textContent = 'Converting...';
  }
  try {
    await apiCall(`/api/events/${planPageState.eventId}/models/loan`, 'POST', {
      source: planReplacementState.source,
      quantity,
      company,
      subprojectId: eventActiveSubproject(planPageState, planPageState.event)?.id || ''
    });
    closeModal('planReplacementModal');
    showNotification('success', `Converted ${quantity} planned item${quantity === 1 ? '' : 's'} to loan`);
    await refreshPlanSelectedEvent();
  } catch (error) {
    // apiCall displays the server validation message.
  } finally {
    if (submitButton) {
      submitButton.disabled = false;
      submitButton.textContent = 'Convert to loan';
    }
  }
}

function renderPlanRequirementsCard() {
  const byDepartment = new Map();
  planModelGroups().forEach(group => {
    const code = normalizeDepartmentCode(group.department || 'UN');
    if (!byDepartment.has(code)) byDepartment.set(code, []);
    byDepartment.get(code).push({ type: 'model', group });
  });
  planCustomAssets().forEach(custom => {
    const code = normalizeDepartmentCode(custom.department || 'UN');
    if (!byDepartment.has(code)) byDepartment.set(code, []);
    byDepartment.get(code).push({ type: 'custom', custom });
  });

  const departmentsHtml = Array.from(byDepartment.entries())
    .sort(([a], [b]) => compareByDisplayName(a, b))
    .map(([code, rows]) => {
      const departmentQuantity = rows.reduce((total, row) => (
        total + Math.max(
          1,
          Number(row.type === 'model'
            ? row.group.requiredQuantity
            : row.custom.quantity) || 1
        )
      ), 0);
      const collapseForMobile = window.matchMedia?.('(max-width: 840px)').matches;
      const rowHtml = rows.map(row => {
        if (row.type === 'model') {
          const group = row.group;
          const warning = planRequirementWarning(group);
          const warningReason = warning?.reason || '';
          const dragPayload = eventSubprojectDragPayload(
            planPageState,
            planPageState.event,
            {
              kind: 'requirement',
              group: {
                department: group.department,
                brand: group.brand,
                model: group.model,
                description: group.description || ''
              }
            }
          );
          return `
            <div class="plan-requirement-row ${warning ? (warning.type === 'degraded' ? 'requires-degraded' : 'has-shortage') : ''} ${dragPayload ? 'is-room-draggable' : ''}"
                 ${dragPayload ? `draggable="true" ondragstart="eventSubprojectDragStart(event,'${dragPayload}')" ondragend="eventSubprojectDragEnd(event)"` : ''}>
              <div class="plan-item-title-line">
                <div class="plan-item-name">${escapeHtml([group.brand, group.model].filter(Boolean).join(' '))}</div>
                ${warning ? `
                  <button type="button" class="plan-shortage-info ${warning.type === 'degraded' ? 'degraded-warning' : ''}"
                          title="${escapeHtmlAttr(warningReason)}"
                          aria-label="Show availability warning"
                          onclick="planShowRequirementWarning('${planEncode(warningReason)}','${warning.type}')">!</button>
                ` : ''}
                ${planDepartmentCodeBadgeHtml(group.department)}
              </div>
              <div class="plan-item-description">${escapeHtml(group.description || 'No description')}</div>
              <div class="plan-replace-slot">
                ${warning ? `
                  <button type="button" class="plan-button plan-button-small plan-swap-button ${warning.type === 'degraded' ? 'degraded-warning' : ''}"
                          onclick="planOpenResolution('${planEncode(group.department)}','${planEncode(group.brand)}','${planEncode(group.model)}','${planEncode(group.description || '')}',${warning.quantity},'${warning.type}')">Resolve</button>
                ` : ''}
              </div>
              ${planRequirementQuantityControl(group)}
              <div class="plan-row-actions">
                <button type="button" class="plan-button plan-button-danger plan-button-small"
                        title="Remove requirement"
                        onclick="planRemoveModel('${planEncode(group.department)}','${planEncode(group.brand)}','${planEncode(group.model)}','${planEncode(group.description || '')}')">
                  &#128465;
                </button>
              </div>
            </div>
          `;
        }

        const custom = row.custom;
        const dragPayload = eventSubprojectDragPayload(
          planPageState,
          planPageState.event,
          { kind: 'asset', assetRef: custom.id }
        );
        const description = custom.type === 'LOAN'
          ? (custom.company ? `From ${custom.company}` : 'Loan / rental item')
          : (custom.description || 'Custom miscellaneous item');
        return `
          <div class="plan-requirement-row ${dragPayload ? 'is-room-draggable' : ''}"
               ${dragPayload ? `draggable="true" ondragstart="eventSubprojectDragStart(event,'${dragPayload}')" ondragend="eventSubprojectDragEnd(event)"` : ''}>
            <div>
              <div class="plan-item-title-line">
                <div class="plan-item-name">${escapeHtml(custom.name)}</div>
                ${planDepartmentCodeBadgeHtml(custom.department)}
              </div>
              <div class="plan-item-meta">${escapeHtml(custom.type === 'LOAN' ? 'Loan / Rental' : 'Misc')}</div>
            </div>
            <div class="plan-item-description">${escapeHtml(description)}</div>
            <div class="plan-replace-slot">
              <button type="button" class="plan-button plan-button-small"
                      title="Edit custom asset"
                      aria-label="Edit custom asset"
                      onclick="planEditCustomAsset('${planEncode(custom.id)}')">
                &#9998;
              </button>
            </div>
            ${planCustomQuantityControl(custom)}
            <div class="plan-row-actions">
              <button type="button" class="plan-button plan-button-danger plan-button-small"
                      title="Remove custom asset"
                      onclick="planRemoveCustomAsset('${planEncode(custom.id)}')">
                &#128465;
              </button>
            </div>
          </div>
        `;
      }).join('');

      return `
        <details class="plan-department-section" ${collapseForMobile ? '' : 'open'}>
          <summary class="plan-department-summary">
            <span>
              <i class="plan-department-dot" style="--department-color:${escapeHtmlAttr(planDepartmentColor(code))}"></i>
              ${escapeHtml(planDepartmentLabel(code))} (${rows.length})
            </span>
            <span class="plan-department-summary-end">
              <span class="plan-department-mobile-total">Qty: ${departmentQuantity}</span>
              <span aria-hidden="true">⌄</span>
            </span>
          </summary>
          <div class="plan-requirement-head">
            <span>Brand / Model</span>
            <span>Description</span>
            <span></span>
            <span>Required Qty</span>
            <span></span>
          </div>
          ${rowHtml}
        </details>
      `;
    }).join('');

  return `
    <section class="plan-card">
      <div class="plan-card-header">
        <div>
          <h3>Planned Requirements</h3>
          <p>Changes save immediately. Departments appear when their first item is added.</p>
        </div>
      </div>
      <div class="plan-requirements-scroll">
        ${departmentsHtml || '<div class="plan-empty">No assets planned yet. Add models from the left.</div>'}
      </div>
    </section>
  `;
}

function renderPlanEventDetailsCard() {
  const event = planPageState.event || {};
  const notes = String(event.notes || '');
  const eventDates = event.startDate && event.startDate === event.endDate
    ? event.startDate
    : [event.startDate, event.endDate].filter(Boolean).join(' – ');
  return `
    <section class="plan-card plan-details-card">
      <div class="plan-card-header event-detail-card-header">
        <h3>Event Details</h3>
        ${eventDetailsActionsHtml(event.id)}
      </div>
      <div class="plan-aside-body">
        <dl class="plan-detail-list">
          <div><dt>Name</dt><dd>${escapeHtml(event.name || `Event ${event.id || ''}`)}</dd></div>
          <div><dt>Location</dt><dd>${escapeHtml(event.location || '—')}</dd></div>
          <div><dt>Date(s)</dt><dd>${escapeHtml(eventDates || '—')}</dd></div>
          <div><dt>Status</dt><dd>${planEventStateBadgeHtml(event)}</dd></div>
          <div><dt>Type</dt><dd>${planEventTypeBadgeHtml(event)}</dd></div>
          <div class="plan-detail-notes-row">
            <dd>
              <textarea class="plan-notes-textarea" id="planEventNotes"
                        maxlength="50000"
                        placeholder="Add notes or special requirements for this event..."
                        oninput="planNotesChanged(this)"
                        onblur="planFlushNotesSave()">${escapeHtml(notes)}</textarea>
              <span class="plan-notes-footer">
                <span id="planNotesSaveState">Saved</span>
                <span id="planNotesCharacterCount">${notes.length}/50000</span>
              </span>
            </dd>
          </div>
        </dl>
      </div>
    </section>
  `;
}

function renderPlanVendorManagementCard() {
  const rows = Array.isArray(planPageState.event?.vendorManagement)
    ? planPageState.event.vendorManagement
    : [];
  if (!rows.length) return '';
  return `
    <section class="plan-card vendor-management-card">
      <div class="plan-card-header"><h3>Vendor Management</h3><button type="button" class="vendor-management-open" onclick="planOpenVendorManagement()">Open</button></div>
      <p class="vendor-management-help">Self pickup items appear as loans in Plan. Delivered items go directly to the venue.</p>
    </section>
  `;
}

function planVendorManagementDialogMarkup() {
  const rows = Array.isArray(planPageState.event?.vendorManagement)
    ? planPageState.event.vendorManagement
    : [];
  return `<div class="modal-content vendor-management-dialog">
    <div class="modal-header">
      <div><h3 class="modal-title">Vendor Management</h3><p>Choose how each vendor fulfils their equipment.</p></div>
      <button type="button" class="close-btn" aria-label="Close vendor management" onclick="closeModal('planVendorManagementModal')">&times;</button>
    </div>
    <div class="vendor-management-list">
      ${rows.map(row => {
        const dryHire = row.mode !== 'outsourced';
        return `<div class="vendor-management-row">
          <div class="vendor-management-details"><strong>${escapeHtml(row.vendorName || 'Vendor')}</strong><small>${Number(row.itemCount || 0)} item line${Number(row.itemCount || 0) === 1 ? '' : 's'} &middot; ${financeMoney(Number(row.amount || 0))}</small></div>
          <div class="vendor-mode-toggle" role="radiogroup" aria-label="Fulfilment for ${escapeHtmlAttr(row.vendorName || 'vendor')}">
            <button type="button" role="radio" aria-checked="${dryHire}" class="${dryHire ? 'selected' : ''}" onclick="planSetVendorManagement('${planEncode(row.key)}','dry-hire')">Self Pickup</button>
            <button type="button" role="radio" aria-checked="${!dryHire}" class="${!dryHire ? 'selected' : ''}" onclick="planSetVendorManagement('${planEncode(row.key)}','outsourced')">Delivered</button>
          </div>
        </div>`;
      }).join('') || '<p class="vendor-management-empty">No external vendors for this event.</p>'}
    </div>
    <p class="vendor-management-help">Self pickup items appear as loans in Plan. Delivered items go directly to the venue.</p>
  </div>`;
}

function planOpenVendorManagement() {
  let modal = document.getElementById('planVendorManagementModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'planVendorManagementModal';
    modal.className = 'modal vendor-management-modal';
    modal.addEventListener('click', event => {
      if (event.target === modal) closeModal(modal.id);
    });
    document.body.appendChild(modal);
  }
  modal.innerHTML = planVendorManagementDialogMarkup();
  openModal(modal.id);
}

async function planSetVendorManagement(encodedKey, mode) {
  const key = planDecode(encodedKey);
  if (!planPageState.eventId || !['dry-hire', 'outsourced'].includes(mode)) return;
  try {
    const response = await apiCall(
      `/api/events/${planPageState.eventId}/vendor-management`,
      'PUT',
      { key, mode }
    );
    planPageState.event.vendorManagement = response.data || [];
    await refreshPlanSelectedEvent();
    const modal = document.getElementById('planVendorManagementModal');
    if (modal?.classList.contains('active')) {
      modal.innerHTML = planVendorManagementDialogMarkup();
    }
    showNotification('success', mode === 'dry-hire'
      ? 'Vendor items set for self pickup and added to Plan as loans'
      : 'Vendor items marked as delivered');
  } catch (error) {
    // apiCall already displays the server message.
  }
}

function renderPlanTemplatesCard() {
  const templates = planPageState.templates || [];
  const rows = templates.map(template => {
    const quantity = (template.models || []).reduce(
      (sum, row) => sum + Number(row.quantity || 0),
      0
    ) + (template.customAssets || []).reduce(
      (sum, row) => sum + Number(row.quantity || 0),
      0
    );
    return `
      <div class="plan-template-row">
        <div>
          <strong>${escapeHtml(template.name)}</strong>
          <span>${template.models.length} models · ${template.customAssets.length} custom · ${quantity} total</span>
        </div>
        <button type="button" class="plan-button plan-button-small"
                onclick="planApplyTemplate('${planEncode(template.id)}')">Apply</button>
        <button type="button" class="plan-button plan-button-small"
                title="Edit template"
                onclick="planOpenTemplateEditor('${planEncode(template.id)}')">&#9998;</button>
      </div>
    `;
  }).join('');

  return `
    <section class="plan-card" id="planTemplatesCard">
      <div class="plan-card-header"><h3>Templates</h3></div>
      <div class="plan-aside-body">
        <div class="plan-template-actions">
          <button type="button" class="plan-button plan-button-small"
                  onclick="planOpenTemplateChooser()">Apply Template</button>
          <button type="button" class="plan-button plan-button-small"
                  onclick="planOpenTemplateManager()">Manage Templates</button>
        </div>
        <div class="plan-template-list">
          ${rows || '<div class="plan-item-meta">No templates created yet.</div>'}
          <button type="button" class="plan-button" onclick="planOpenTemplateEditor()">Save Template</button>
        </div>
      </div>
    </section>
  `;
}

function renderPlanCustomItemCard() {
  return `
    <section class="plan-card plan-custom-card">
      <div class="plan-card-header">
        <h3>Add Custom Item</h3>
      </div>
      <div class="plan-aside-body">
        <form class="plan-custom-form" id="planCustomAssetForm"
              onsubmit="planSubmitCustomAsset(event)">
          <input type="hidden" id="planCustomType" value="MISC">
          <div class="plan-custom-type-toggle" aria-label="Custom item type">
            <button type="button" id="planCustomTypeMisc" class="active"
                    aria-pressed="true" onclick="planSetCustomType('MISC')">Misc</button>
            <button type="button" id="planCustomTypeLoan"
                    aria-pressed="false" onclick="planSetCustomType('LOAN')">Loan</button>
          </div>
          <div class="plan-custom-field-grid">
            <div class="plan-custom-field">
              <label for="planCustomName">Item Name</label>
              <input id="planCustomName" maxlength="160"
                     placeholder="e.g. Wireless Handheld" required>
            </div>
            <div class="plan-custom-field">
              <label for="planCustomQuantity">Quantity</label>
              <input id="planCustomQuantity" type="number" min="1" value="1" required>
            </div>
          </div>
          <div class="plan-custom-field-grid plan-custom-field-grid-secondary">
            <div class="plan-custom-field">
              <label for="planCustomDepartment">Department</label>
              <select id="planCustomDepartment" required>
                ${customDepartmentOptionsHtml('UN')}
              </select>
            </div>
            <div class="plan-custom-field" id="planCustomCompanyGroup">
              <label for="planCustomCompany" id="planCustomDetailLabel">Description</label>
              <input id="planCustomCompany" maxlength="160"
                     placeholder="Optional description">
            </div>
          </div>
          <div class="plan-custom-form-actions">
            <button type="submit" id="planCustomSubmitButton" class="plan-button plan-button-primary plan-custom-submit">
              Add Custom Item
            </button>
            <button type="button" id="planCustomCancelEdit" class="plan-button plan-button-small"
                    style="display:none" onclick="planCancelCustomAssetEdit()">Cancel edit</button>
          </div>
          <div class="plan-custom-help">
            <span aria-hidden="true">&#9432;</span>
            <span>Custom items are not part of core inventory.</span>
          </div>
        </form>
      </div>
    </section>
  `;
}

var planNotesSaveTimer = null;
var planPendingNotesSave = null;

function planNotesChanged(textarea) {
  const notes = String(textarea?.value || '');
  const counter = document.getElementById('planNotesCharacterCount');
  const state = document.getElementById('planNotesSaveState');
  if (counter) counter.textContent = `${notes.length}/50000`;
  if (state) state.textContent = 'Unsaved changes';

  planPendingNotesSave = {
    eventId: Number(planPageState.eventId),
    notes
  };
  clearTimeout(planNotesSaveTimer);
  planNotesSaveTimer = setTimeout(() => {
    planFlushNotesSave();
  }, 700);
}

async function planFlushNotesSave() {
  clearTimeout(planNotesSaveTimer);
  planNotesSaveTimer = null;
  const pending = planPendingNotesSave;
  if (!pending?.eventId) return;
  planPendingNotesSave = null;

  const state = document.getElementById('planNotesSaveState');
  if (state) state.textContent = 'Saving…';
  try {
    const response = await apiCall(
      `/api/events/${pending.eventId}/notes`,
      'PUT',
      { notes: pending.notes }
    );
    if (Number(planPageState.eventId) === Number(pending.eventId)) {
      planPageState.event.notes = response.data?.notes ?? pending.notes;
      if (state) state.textContent = 'Saved';
    }
  } catch (error) {
    planPendingNotesSave = pending;
    if (state) state.textContent = 'Save failed';
  }
}

function renderPlanMetrics() {
  const event = planPageState.event || {};
  const totals = planTotals();
  return `
    <div class="plan-metric"><div class="plan-metric-icon">${planMetricIconSvg('lines')}</div><div><strong>${totals.lineCount}</strong><span>Asset Lines</span></div></div>
    <div class="plan-metric"><div class="plan-metric-icon">${planMetricIconSvg('quantity')}</div><div><strong>${totals.totalQuantity}</strong><span>Total Qty Required</span></div></div>
    <div class="plan-metric"><div class="plan-metric-icon">${planMetricIconSvg('departments')}</div><div><strong>${totals.departmentCount}</strong><span>Active Departments</span></div></div>
    ${event.quotationId ? `
      <button type="button" class="plan-metric plan-compare-launch"
              onclick="typeof openCompareForEvent === 'function' && openCompareForEvent(${Number(event.id) || 0}, '${escapeJs(String(event.quotationId))}')">
        <div class="plan-metric-icon">${planMetricIconSvg('templates')}</div>
        <div><strong>Compare</strong><span>To Quotation</span></div>
      </button>
    ` : ''}
  `;
}

function renderPlanSubprojectTabs() {
  return renderEventSubprojectTabs(
    'planPageState',
    planPageState.event,
    'renderPlanPage',
    'Planning sub-projects',
    {
      allowAdd: true,
      allowDelete: true,
      allowRename: true,
      allowReorder: true,
      showImplicitMain: true,
      roomWarning: planSubprojectWarning
    }
  );
}

function renderPlanPage() {
  const root = document.getElementById('plan-page-root');
  if (!root) return;

  if (!isAdminUser()) {
    root.innerHTML = '<div class="plan-empty">Admin access is required.</div>';
    return;
  }
  if (!planPageState.event) {
    root.innerHTML = '<div class="plan-empty">There are no events available to plan.</div>';
    return;
  }

  const event = planPageState.event;
  const consolidated = eventIsConsolidated(planPageState, event);
  root.classList.toggle('event-consolidated-mode', consolidated);
  root.innerHTML = `
    <div class="plan-page-heading">
      <div><h2>Plan Event Assets</h2><p>Add required asset models and quantities for this event.</p></div>
    </div>

    <div class="plan-layout">
      <div class="plan-primary">
        <div class="plan-event-bar">
          <button type="button" class="plan-event-select-wrap"
                  aria-haspopup="dialog" aria-label="Choose an event to plan"
                  onclick="planOpenEventChooser()">
            <div class="plan-event-icon" aria-hidden="true">${planMetricIconSvg('calendar')}</div>
            <div style="min-width:0;flex:1;">
              <div class="plan-event-title-row">
                <span class="plan-event-id">#${escapeHtml(String(event.id || ''))}</span>
                <span class="plan-event-name">${escapeHtml(planEventOptionLabel(event))}</span>
              </div>
              <div class="plan-event-meta">
                <span>${escapeHtml([event.startDate, event.endDate].filter(Boolean).join(' – '))}</span>
                ${event.location ? `<span aria-hidden="true">•</span><span>${escapeHtml(event.location)}</span>` : ''}
                ${planEventTypeBadgeHtml(event)}
                ${planEventStateBadgeHtml(event)}
              </div>
            </div>
            <span class="plan-event-picker-chevron" aria-hidden="true">⌄</span>
          </button>

          <div class="plan-metrics" id="planMetrics">${renderPlanMetrics()}</div>
        </div>

        <div id="planSubprojectTabs">${renderPlanSubprojectTabs()}</div>
        ${consolidated ? eventConsolidatedNotice() : ''}
        <div class="plan-workspace">
          <div class="plan-available-stack">
            <div id="planAvailableCard">${renderPlanAvailableCard()}</div>
            <div id="planCustomItemCard">${renderPlanCustomItemCard()}</div>
          </div>
          <div id="planRequirementsCard">${renderPlanRequirementsCard()}</div>
        </div>

      </div>
      <aside class="plan-aside">
        ${renderPlanEventDetailsCard()}
        ${renderPlanVendorManagementCard()}
        <button type="button" class="plan-button plan-button-primary plan-aside-proceed"
                onclick="planProceedToPrepare()">Proceed to Prepare →</button>
      </aside>
      <div class="plan-mobile-actionbar">
        <button type="button" class="plan-button plan-button-primary" onclick="planProceedToPrepare()">
          Proceed to Prepare →
        </button>
      </div>
    </div>
  `;
  renderPlanAvailableResults();
}

function renderPlanRealtimeAssets() {
  const available = document.getElementById('planAvailableCard');
  const requirements = document.getElementById('planRequirementsCard');
  const metrics = document.getElementById('planMetrics');
  const tabs = document.getElementById('planSubprojectTabs');
  if (!available || !requirements) {
    renderPlanPage();
    return;
  }
  const requirementsScrollTop = requirements.querySelector(
    '.plan-requirements-scroll'
  )?.scrollTop || 0;
  available.innerHTML = renderPlanAvailableCard();
  requirements.innerHTML = renderPlanRequirementsCard();
  if (metrics) metrics.innerHTML = renderPlanMetrics();
  if (tabs) tabs.innerHTML = renderPlanSubprojectTabs();
  renderPlanAvailableResults();
  const nextScroll = requirements.querySelector('.plan-requirements-scroll');
  if (nextScroll) nextScroll.scrollTop = requirementsScrollTop;
}

async function loadPlanPage() {
  const root = document.getElementById('plan-page-root');
  if (!root || !isAdminUser() || planPageState.loading) return;
  planPageState.loading = true;
  root.innerHTML = '<div class="loading">Loading planning workspace...</div>';

  try {
    const [eventOptionsLoad, assetsResponse, templatesResponse, containerCache] = await Promise.all([
      startProgressiveEventOptions(planPageState.eventId, loaded => {
        planPageState.events = [...loaded].sort(planCompareEventsByStartDate);
        if (activeModal('planEventChooserModal')) renderPlanEventChooser();
      }),
      apiCall('/api/assets/available'),
      apiCall('/api/planning-templates'),
      refreshContainersCache(true)
    ]);
    planPageState.events = [...eventOptionsLoad.first].sort(planCompareEventsByStartDate);
    eventOptionsLoad.completion.then(loaded => {
      planPageState.events = [...loaded].sort(planCompareEventsByStartDate);
      if (activeModal('planEventChooserModal')) renderPlanEventChooser();
    }).catch(error => console.warn('Unable to load more event options:', error));
    planPageState.assets = assetsResponse.data || [];
    planPageState.templates = templatesResponse.data || [];
    planPageState.containers = Object.values(containerCache || {});

    const preferredId = planPageState.eventId;
    const selected = planPageState.events.find(item =>
      Number(item.id) === Number(preferredId)
    ) || planPageState.events[0];

    if (selected) {
      await selectPlanEvent(selected.id, { renderLoading: false });
    } else {
      planPageState.event = null;
      renderPlanPage();
    }
  } catch (error) {
    root.innerHTML = `<div class="plan-empty">Failed to load Plan: ${escapeHtml(error.message || String(error))}</div>`;
  } finally {
    planPageState.loading = false;
  }
}

async function selectPlanEvent(eventId, options = {}) {
  await planFlushNotesSave();
  const id = Number(eventId);
  if (!id) return;
  planPageState.eventId = id;
  const root = document.getElementById('plan-page-root');
  if (options.renderLoading !== false && root) {
    root.innerHTML = '<div class="loading">Loading event plan...</div>';
  }

  try {
    const [eventResponse, availabilityResponse] = await Promise.all([
      apiCall(`/api/events/${id}`),
      apiCall(`/api/events/${id}/availability`)
    ]);
    planPageState.event = eventResponse.data;
    planPageState.availability = availabilityResponse.data || [];
    renderPlanPage();
  } catch (error) {
    if (root) {
      root.innerHTML = `<div class="plan-empty">Failed to load event: ${escapeHtml(error.message || String(error))}</div>`;
    }
  }
}

async function refreshPlanSelectedEvent(options = {}) {
  if (!planPageState.eventId) return;
  const pageScrollTop = window.scrollY;
  const requirementsScrollTop = document.querySelector('.plan-requirements-scroll')?.scrollTop || 0;
  const [eventResponse, availabilityResponse, templatesResponse] = await Promise.all([
    apiCall(`/api/events/${planPageState.eventId}`),
    apiCall(`/api/events/${planPageState.eventId}/availability`),
    options.templates ? apiCall('/api/planning-templates') : Promise.resolve(null)
  ]);
  planPageState.event = eventResponse.data;
  planPageState.availability = availabilityResponse.data || [];
  if (templatesResponse) planPageState.templates = templatesResponse.data || [];
  renderPlanPage();
  requestAnimationFrame(() => {
    window.scrollTo({ top: pageScrollTop, behavior: 'auto' });
    const requirements = document.querySelector('.plan-requirements-scroll');
    if (requirements) requirements.scrollTop = requirementsScrollTop;
  });
  refreshEventOverviewViews().catch(() => {});
}

async function planAddModel(encodedDepartment, encodedBrand, encodedModel, encodedDescription, inputId) {
  const input = document.getElementById(inputId);
  const quantity = Math.max(1, Number(input?.value || 1));
  try {
    await apiCall(`/api/events/${planPageState.eventId}/models`, 'POST', {
      department: planDecode(encodedDepartment),
      brand: planDecode(encodedBrand),
      model: planDecode(encodedModel),
      description: planDecode(encodedDescription),
      quantity,
      subprojectId: eventActiveSubproject(planPageState, planPageState.event)?.id || ''
    });
    showNotification('success', 'Asset requirement added');
    await refreshPlanSelectedEvent();
  } catch (error) {}
}

async function planSetModelQuantity(encodedDepartment, encodedBrand, encodedModel, encodedDescription, quantity) {
  const nextQuantity = Math.max(1, Number(quantity || 1));
  try {
    await apiCall(`/api/events/${planPageState.eventId}/models`, 'PUT', {
      department: planDecode(encodedDepartment),
      brand: planDecode(encodedBrand),
      model: planDecode(encodedModel),
      description: planDecode(encodedDescription),
      quantity: nextQuantity,
      subprojectId: eventActiveSubproject(planPageState, planPageState.event)?.id || ''
    });
    await refreshPlanSelectedEvent();
  } catch (error) {
    renderPlanPage();
  }
}

async function planRemoveModel(encodedDepartment, encodedBrand, encodedModel, encodedDescription) {
  const brand = planDecode(encodedBrand);
  const model = planDecode(encodedModel);
  const confirmed = await showAppConfirm({
    title: 'Remove Requirement',
    message: `Remove ${brand} ${model} from this event? Prepared units will remain attached and be shown as extra.`,
    confirmText: 'Remove',
    cancelText: 'Cancel',
    variant: 'danger'
  });
  if (!confirmed) return;

  try {
    await apiCall(`/api/events/${planPageState.eventId}/models`, 'DELETE', {
      department: planDecode(encodedDepartment),
      brand,
      model,
      description: planDecode(encodedDescription),
      subprojectId: eventActiveSubproject(planPageState, planPageState.event)?.id || ''
    });
    await refreshPlanSelectedEvent();
  } catch (error) {}
}

async function planAddContainerContents(encodedContainerId) {
  const containerId = planDecode(encodedContainerId);
  try {
    const response = await apiCall(
      `/api/events/${planPageState.eventId}/container-models`,
      'POST',
      {
        containerId,
        subprojectId: eventActiveSubproject(planPageState, planPageState.event)?.id || ''
      }
    );
    const added = response.data || {};
    showNotification(
      'success',
      `Added ${added.assetCount || 0} item(s) from ${containerId} as model requirements`
    );
    await refreshPlanSelectedEvent();
  } catch (error) {}
}

function planSyncCustomCompanyField() {
  const isLoan = document.getElementById('planCustomType')?.value === 'LOAN';
  const input = document.getElementById('planCustomCompany');
  const label = document.getElementById('planCustomDetailLabel');
  if (input) {
    input.required = isLoan;
    input.placeholder = isLoan ? 'Company Pte Ltd' : 'Optional description';
  }
  if (label) label.textContent = isLoan ? 'Company / Source' : 'Description';
}

function planSetCustomType(type) {
  const normalizedType = normalizeCustomType(type);
  const input = document.getElementById('planCustomType');
  const miscButton = document.getElementById('planCustomTypeMisc');
  const loanButton = document.getElementById('planCustomTypeLoan');
  if (input) input.value = normalizedType;
  if (miscButton) {
    miscButton.classList.toggle('active', normalizedType === 'MISC');
    miscButton.setAttribute('aria-pressed', normalizedType === 'MISC' ? 'true' : 'false');
  }
  if (loanButton) {
    loanButton.classList.toggle('active', normalizedType === 'LOAN');
    loanButton.setAttribute('aria-pressed', normalizedType === 'LOAN' ? 'true' : 'false');
  }
  planSyncCustomCompanyField();
}

async function planSubmitCustomAsset(event) {
  event.preventDefault();
  const type = normalizeCustomType(document.getElementById('planCustomType')?.value);
  const detail = document.getElementById('planCustomCompany')?.value.trim() || '';
  const company = type === 'LOAN' ? detail : '';
  const description = type === 'MISC' ? detail : '';
  if (type === 'LOAN' && !company) {
    showNotification('warning', 'Please enter the loan or rental company');
    return;
  }

  try {
    const assetId = planPageState.editingCustomAssetId;
    const payload = {
      name: document.getElementById('planCustomName')?.value.trim(),
      quantity: Math.max(1, Number(document.getElementById('planCustomQuantity')?.value || 1)),
      type,
      department: normalizeDepartmentCode(document.getElementById('planCustomDepartment')?.value || 'UN'),
      company,
      description,
      subprojectId: eventActiveSubproject(planPageState, planPageState.event)?.id || ''
    };
    if (assetId) {
      await apiCall(
        `/api/events/${planPageState.eventId}/custom-assets/update-quantity`,
        'PUT',
        { ...payload, assetId, newQuantity: payload.quantity }
      );
    } else {
      await apiCall(`/api/events/${planPageState.eventId}/custom-assets`, 'POST', payload);
    }
    planPageState.editingCustomAssetId = '';
    showNotification('success', assetId ? 'Custom asset updated' : 'Custom asset added');
    await refreshPlanSelectedEvent();
  } catch (error) {}
}

function planEditCustomAsset(encodedAssetId) {
  const assetId = planDecode(encodedAssetId);
  const custom = parseCustomAsset(assetId);
  if (!custom) return;
  planPageState.editingCustomAssetId = assetId;
  planSetCustomType(custom.type);
  const setValue = (id, value) => {
    const input = document.getElementById(id);
    if (input) input.value = value == null ? '' : String(value);
  };
  setValue('planCustomName', custom.name);
  setValue('planCustomQuantity', custom.quantity);
  const departmentInput = document.getElementById('planCustomDepartment');
  const customDepartment = normalizeDepartmentCode(custom.department || 'UN');
  if (
    departmentInput &&
    !Array.from(departmentInput.options).some(option => option.value === customDepartment)
  ) {
    departmentInput.add(new Option(customDepartment, customDepartment));
  }
  setValue('planCustomDepartment', customDepartment);
  setValue('planCustomCompany', custom.type === 'LOAN' ? custom.company : custom.description);
  const submit = document.getElementById('planCustomSubmitButton');
  const cancel = document.getElementById('planCustomCancelEdit');
  if (submit) submit.textContent = 'Save Changes';
  if (cancel) cancel.style.display = 'inline-flex';
  document.getElementById('planCustomAssetForm')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function planCancelCustomAssetEdit() {
  planPageState.editingCustomAssetId = '';
  const form = document.getElementById('planCustomAssetForm');
  form?.reset();
  planSetCustomType('MISC');
  const submit = document.getElementById('planCustomSubmitButton');
  const cancel = document.getElementById('planCustomCancelEdit');
  if (submit) submit.textContent = 'Add Custom Item';
  if (cancel) cancel.style.display = 'none';
}

async function planSetCustomQuantity(encodedAssetId, quantity) {
  try {
    await apiCall(
      `/api/events/${planPageState.eventId}/custom-assets/update-quantity`,
      'PUT',
      {
        assetId: planDecode(encodedAssetId),
        newQuantity: Math.max(1, Number(quantity || 1)),
        subprojectId: eventActiveSubproject(planPageState, planPageState.event)?.id || ''
      }
    );
    await refreshPlanSelectedEvent();
  } catch (error) {
    renderPlanPage();
  }
}

async function planRemoveCustomAsset(encodedAssetId) {
  const assetId = planDecode(encodedAssetId);
  const custom = parseCustomAsset(assetId);
  const confirmed = await showAppConfirm({
    title: 'Remove Custom Asset',
    message: `Remove ${custom?.name || 'this custom asset'} from the event?`,
    confirmText: 'Remove',
    cancelText: 'Cancel',
    variant: 'danger'
  });
  if (!confirmed) return;

  try {
    await apiCall(
      `/api/events/${planPageState.eventId}/custom-assets/remove`,
      'POST',
      {
        assetId,
        subprojectId: eventActiveSubproject(planPageState, planPageState.event)?.id || ''
      }
    );
    await refreshPlanSelectedEvent();
  } catch (error) {}
}

function planTemplateDraftRows() {
  const draft = planPageState.templateDraft || { models: [], customAssets: [] };
  return [
    ...(draft.models || []).map((row, index) => ({ kind: 'models', index, row })),
    ...(draft.customAssets || []).map((row, index) => ({ kind: 'customAssets', index, row }))
  ];
}

function ensurePlanTemplateEditorModal() {
  let modal = document.getElementById('planTemplateEditorModal');
  if (modal) return modal;
  modal = document.createElement('div');
  modal.id = 'planTemplateEditorModal';
  modal.className = 'modal';
  modal.innerHTML = `
    <div class="modal-content" style="max-width:720px;">
      <div class="modal-header">
        <h3 class="modal-title" id="planTemplateEditorTitle">Save Template</h3>
        <button type="button" class="close-btn" onclick="closeModal('planTemplateEditorModal')">&times;</button>
      </div>
      <div class="form-group">
        <label class="form-label" for="planTemplateName">Template Name</label>
        <input class="form-input" id="planTemplateName" maxlength="120">
      </div>
      <div class="plan-inline-actions">
        <button type="button" class="plan-button plan-button-small" onclick="planUseCurrentEventForTemplate()">
          Use Current Event Assets
        </button>
        <span class="plan-item-meta">This replaces the template editor list, not the event.</span>
      </div>
      <div class="plan-template-editor-list" id="planTemplateEditorRows"></div>
      <div class="modal-actions">
        <button type="button" class="btn btn-danger" id="planDeleteTemplateButton" onclick="planDeleteTemplate()">Delete</button>
        <button type="button" class="btn btn-secondary" onclick="closeModal('planTemplateEditorModal')">Cancel</button>
        <button type="button" class="btn btn-primary" onclick="planSaveTemplate()">Save Template</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  return modal;
}

function renderPlanTemplateEditorRows() {
  const container = document.getElementById('planTemplateEditorRows');
  if (!container) return;
  const rows = planTemplateDraftRows();
  container.innerHTML = rows.length ? rows.map(({ kind, index, row }) => {
    const isModel = kind === 'models';
    const title = isModel
      ? [row.brand, row.model].filter(Boolean).join(' ')
      : row.name;
    const description = isModel
      ? (row.description || 'No description')
      : (row.type === 'LOAN' ? (row.company || 'Loan / rental') : 'Misc item');
    return `
      <div class="plan-template-editor-row">
        <div>
          <div class="plan-item-name">${escapeHtml(title)}</div>
          <div class="plan-item-description">${escapeHtml(description)} · ${escapeHtml(planDepartmentLabel(row.department))}</div>
        </div>
        <input class="form-input" type="number" min="1" value="${Math.max(1, Number(row.quantity || 1))}"
               onchange="planUpdateTemplateDraftQuantity('${kind}',${index},this.value)">
        <button type="button" class="plan-button plan-button-danger plan-button-small"
                onclick="planRemoveTemplateDraftRow('${kind}',${index})">&#128465;</button>
      </div>
    `;
  }).join('') : '<div class="plan-empty">This template has no assets. Use the current event to populate it.</div>';
}

function planOpenTemplateEditor(encodedTemplateId = '') {
  const templateId = planDecode(encodedTemplateId);
  const existing = (planPageState.templates || []).find(item => item.id === templateId);
  const snapshot = planEventSnapshot();
  planPageState.templateDraft = existing
    ? JSON.parse(JSON.stringify(existing))
    : {
        id: '',
        name: '',
        models: snapshot.models,
        customAssets: snapshot.customAssets
      };

  ensurePlanTemplateEditorModal();
  document.getElementById('planTemplateEditorTitle').textContent =
    existing ? 'Edit Template' : 'Save Template';
  document.getElementById('planTemplateName').value =
    planPageState.templateDraft.name || '';
  document.getElementById('planDeleteTemplateButton').style.display =
    existing ? 'inline-flex' : 'none';
  renderPlanTemplateEditorRows();
  openModal('planTemplateEditorModal');
}

function planUseCurrentEventForTemplate() {
  if (!planPageState.templateDraft) return;
  const snapshot = planEventSnapshot();
  planPageState.templateDraft.models = snapshot.models;
  planPageState.templateDraft.customAssets = snapshot.customAssets;
  renderPlanTemplateEditorRows();
}

function planUpdateTemplateDraftQuantity(kind, index, quantity) {
  const rows = planPageState.templateDraft?.[kind];
  if (!rows?.[index]) return;
  rows[index].quantity = Math.max(1, Number(quantity || 1));
}

function planRemoveTemplateDraftRow(kind, index) {
  const rows = planPageState.templateDraft?.[kind];
  if (!rows) return;
  rows.splice(index, 1);
  renderPlanTemplateEditorRows();
}

async function planSaveTemplate() {
  const draft = planPageState.templateDraft;
  if (!draft) return;
  const name = document.getElementById('planTemplateName')?.value.trim();
  if (!name) {
    showNotification('warning', 'Please enter a template name');
    return;
  }
  const payload = {
    name,
    models: draft.models || [],
    customAssets: draft.customAssets || []
  };

  try {
    if (draft.id) {
      await apiCall(`/api/planning-templates/${encodeURIComponent(draft.id)}`, 'PUT', payload);
    } else {
      await apiCall('/api/planning-templates', 'POST', payload);
    }
    closeModal('planTemplateEditorModal');
    showNotification('success', 'Template saved');
    await refreshPlanSelectedEvent({ templates: true });
  } catch (error) {}
}

async function planDeleteTemplate() {
  const draft = planPageState.templateDraft;
  if (!draft?.id) return;
  const confirmed = await showAppConfirm({
    title: 'Delete Template',
    message: `Delete "${draft.name}" for everyone in this company?`,
    confirmText: 'Delete',
    cancelText: 'Cancel',
    variant: 'danger'
  });
  if (!confirmed) return;

  try {
    await apiCall(`/api/planning-templates/${encodeURIComponent(draft.id)}`, 'DELETE');
    closeModal('planTemplateEditorModal');
    showNotification('success', 'Template deleted');
    await refreshPlanSelectedEvent({ templates: true });
  } catch (error) {}
}

var planTemplateModeResolver = null;

function ensurePlanTemplateModeModal() {
  let modal = document.getElementById('planTemplateModeModal');
  if (modal) return modal;
  modal = document.createElement('div');
  modal.id = 'planTemplateModeModal';
  modal.className = 'modal';
  modal.innerHTML = `
    <div class="modal-content" style="max-width:520px;">
      <div class="modal-header">
        <h3 class="modal-title" id="planTemplateChooserTitle">Apply Template</h3>
        <button type="button" class="close-btn" onclick="planResolveTemplateMode('')">&times;</button>
      </div>
      <p id="planTemplateModeMessage"></p>
      <div style="display:grid;gap:10px;margin:16px 0;">
        <button type="button" class="plan-button" onclick="planResolveTemplateMode('merge')">
          <span><strong>Merge</strong><br><small>Add template quantities to the existing plan.</small></span>
        </button>
        <button type="button" class="plan-button plan-button-danger" onclick="planResolveTemplateMode('replace')">
          <span><strong>Replace</strong><br><small>Replace model and custom requirements. Prepared physical assets remain attached.</small></span>
        </button>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-secondary" onclick="planResolveTemplateMode('')">Cancel</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  return modal;
}

function planChooseTemplateMode(templateName) {
  ensurePlanTemplateModeModal();
  document.getElementById('planTemplateModeMessage').textContent =
    `"${templateName}" can be merged with or replace the current requirements.`;
  openModal('planTemplateModeModal');
  return new Promise(resolve => {
    planTemplateModeResolver = resolve;
  });
}

function planResolveTemplateMode(mode) {
  closeModal('planTemplateModeModal');
  if (planTemplateModeResolver) {
    const resolve = planTemplateModeResolver;
    planTemplateModeResolver = null;
    resolve(mode);
  }
}

async function planApplyTemplate(encodedTemplateId) {
  const templateId = planDecode(encodedTemplateId);
  const template = planPageState.templates.find(item => item.id === templateId);
  if (!template) return;
  const mode = planEventHasRequirements()
    ? await planChooseTemplateMode(template.name)
    : 'merge';
  if (!mode) return;

  try {
    await apiCall(
      `/api/events/${planPageState.eventId}/apply-planning-template`,
      'POST',
      {
        templateId,
        mode,
        subprojectId: eventActiveSubproject(planPageState, planPageState.event)?.id || ''
      }
    );
    closeModal('planTemplateChooserModal');
    showNotification('success', `Template ${mode === 'merge' ? 'merged' : 'applied'}`);
    await refreshPlanSelectedEvent();
  } catch (error) {}
}

function ensurePlanTemplateChooserModal() {
  let modal = document.getElementById('planTemplateChooserModal');
  if (modal) return modal;
  modal = document.createElement('div');
  modal.id = 'planTemplateChooserModal';
  modal.className = 'modal';
  modal.innerHTML = `
    <div class="modal-content" style="max-width:620px;">
      <div class="modal-header">
        <h3 class="modal-title">Apply Template</h3>
        <button type="button" class="close-btn" onclick="closeModal('planTemplateChooserModal')">&times;</button>
      </div>
      <div class="plan-template-list" id="planTemplateChooserRows"></div>
      <div class="modal-actions">
        <button type="button" class="btn btn-secondary" onclick="closeModal('planTemplateChooserModal')">Cancel</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  return modal;
}

function planOpenTemplateChooser(mode = 'apply') {
  ensurePlanTemplateChooserModal();
  const manageMode = mode === 'manage';
  const title = document.getElementById('planTemplateChooserTitle');
  if (title) title.textContent = manageMode ? 'Manage Templates' : 'Apply Template';
  const rows = document.getElementById('planTemplateChooserRows');
  rows.innerHTML = planPageState.templates.length
    ? planPageState.templates.map(template => `
        <div class="plan-template-row">
          <div>
            <strong>${escapeHtml(template.name)}</strong>
            <span>${template.models.length} models · ${template.customAssets.length} custom assets</span>
          </div>
          ${manageMode ? '' : `
            <button type="button" class="plan-button plan-button-small"
                    onclick="planApplyTemplate('${planEncode(template.id)}')">Apply</button>
          `}
          <button type="button" class="plan-button plan-button-small"
                  onclick="closeModal('planTemplateChooserModal');planOpenTemplateEditor('${planEncode(template.id)}')">
            ${manageMode ? 'Edit' : '&#9998;'}
          </button>
        </div>
      `).join('')
    : '<div class="plan-empty">No templates yet. Save one from the current event.</div>';
  openModal('planTemplateChooserModal');
}

function planOpenTemplateManager() {
  planOpenTemplateChooser('manage');
}

function planScrollToTemplates() {
  document.getElementById('planTemplatesCard')?.scrollIntoView({
    behavior: 'smooth',
    block: 'center'
  });
}

function planProceedToPrepare() {
  prepareNewPageState.eventId = Number(planPageState.eventId) || null;
  showSection('prepare-new');
}
