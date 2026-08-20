// ---------------- Trial Prepare page ----------------
var prepareNewPageState = {
  events: [],
  event: null,
  eventId: null,
  availableAssets: [],
  loading: false,
  refreshing: false,
  refreshQueued: false,
  requestSequence: 0,
  scanRevision: 0,
  renderVersion: 0,
  expandedDepartments: new Set(),
  expandedModels: new Set(),
  activeSubprojectId: ''
};

var prepareNewNotesTimer = null;
var prepareNewPendingNotes = null;

function prepareNewModelKey(group) {
  return [
    normalizeDepartmentCode(group?.department || 'UN'),
    String(group?.brand || ''),
    String(group?.model || '')
  ].join('|');
}

function prepareNewEventDates(event) {
  const start = String(event?.startDate || '');
  const end = String(event?.endDate || '');
  if (!start && !end) return 'Not set';
  return !end || start === end ? (start || end) : `${start} \u2013 ${end}`;
}

function prepareNewModelGroups(event = prepareNewPageState.event, state = prepareNewPageState) {
  return eventSubprojectModelGroups(event, state)
    .filter(group => (
      Number(group?.requiredQuantity || 0) > 0
      || Number(group?.extraPreparedQuantity || 0) > 0
      || (group?.assignedAssets || []).some(asset => asset?.isExtra)
    ))
    .sort((a, b) => {
      const departmentCompare = normalizeDepartmentCode(a.department || 'UN').localeCompare(
        normalizeDepartmentCode(b.department || 'UN'),
        undefined,
        { numeric: true, sensitivity: 'base' }
      );
      return departmentCompare || modelGroupSortName(a).localeCompare(
        modelGroupSortName(b),
        undefined,
        { numeric: true, sensitivity: 'base' }
      );
    });
}

function prepareNewSnapshot(event = prepareNewPageState.event) {
  return buildPackingListSnapshot(event || {});
}

function prepareNewIsComplete(event = prepareNewPageState.event) {
  const totals = prepareNewTotals(event);
  return totals.lineCount > 0 && totals.prepared >= totals.required;
}

function prepareNewTotals(event = prepareNewPageState.event, state = prepareNewPageState) {
  const groups = prepareNewModelGroups(event, state);
  const customAssets = prepareNewCustomAssets(event, state);
  const departmentsInUse = new Set(
    [
      ...groups.map(row => normalizeDepartmentCode(row.department || 'UN')),
      ...customAssets.map(row => normalizeDepartmentCode(row.parsedCustom?.department || 'UN'))
    ]
  );
  const required = groups.reduce((sum, row) => sum + Number(row.requiredQuantity || 0), 0) +
    customAssets.reduce((sum, row) => sum + Number(row.parsedCustom?.quantity || 1), 0);
  const prepared = groups.reduce((sum, row) => sum + Number(row.countablePreparedQuantity || 0), 0) +
    customAssets.reduce((sum, row) => (
      (event?.actuallyPrepared || []).includes(row.id) || (event?.returnedItems || []).includes(row.id)
        ? sum + Number(row.parsedCustom?.quantity || 1)
        : sum
    ), 0);
  return {
    lineCount: groups.length + customAssets.length,
    required,
    prepared,
    extra: groups.reduce((sum, row) => sum + Number(row.extraPreparedQuantity || 0), 0),
    departments: departmentsInUse.size
  };
}

function prepareNewSubprojectNeedsAttention(room, event = prepareNewPageState.event) {
  if (!room || !event) return false;
  const roomState = { ...prepareNewPageState, activeSubprojectId: String(room.id || '') };
  const totals = prepareNewTotals(event, roomState);
  return totals.lineCount > 0 && totals.prepared < totals.required;
}

function prepareNewStatusBadge(status, label = '') {
  const slug = String(status || 'pending').toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const text = label || status || 'Pending';
  return `<span class="prepare-new-status prepare-new-status-${escapeHtmlAttr(slug)}">${escapeHtml(text)}</span>`;
}

function prepareNewInitialExpansion() {
  // Sections are intentionally closed by default; user-opened sections are
  // tracked through ontoggle and restored during realtime refreshes.
}

function prepareNewSetDepartmentExpanded(encodedDepartment, open, detailsElement = null) {
  if (
    detailsElement && (
      !detailsElement.isConnected ||
      Number(detailsElement.dataset.prepareRenderVersion || 0) !== prepareNewPageState.renderVersion
    )
  ) return;
  const department = planDecode(encodedDepartment);
  if (open) prepareNewPageState.expandedDepartments.add(department);
  else prepareNewPageState.expandedDepartments.delete(department);
}

function prepareNewSetModelExpanded(encodedKey, open, detailsElement = null) {
  if (
    detailsElement && (
      !detailsElement.isConnected ||
      Number(detailsElement.dataset.prepareRenderVersion || 0) !== prepareNewPageState.renderVersion
    )
  ) return;
  const key = planDecode(encodedKey);
  if (open) prepareNewPageState.expandedModels.add(key);
  else prepareNewPageState.expandedModels.delete(key);
}

function prepareNewRenderAfterModelToggle(encodedKey) {
  const key = planDecode(encodedKey);
  prepareNewPageState.expandedModels.add(key);
  renderPrepareNewPage();
}

function prepareNewAvailableAssetsForGroup(group) {
  const department = normalizeDepartmentCode(group?.department || 'UN');
  return (prepareNewPageState.availableAssets || [])
    .filter(asset =>
      normalizeDepartmentCode(asset?.department || 'UN') === department &&
      String(asset?.brand || '') === String(group?.brand || '') &&
      String(asset?.model || '') === String(group?.model || '')
    )
    .sort((a, b) => String(a?.id || '').localeCompare(
      String(b?.id || ''),
      undefined,
      { numeric: true, sensitivity: 'base' }
    ));
}

function prepareNewGroupPayload(group) {
  return {
    department: normalizeDepartmentCode(group?.department || 'UN'),
    brand: String(group?.brand || ''),
    model: String(group?.model || ''),
    description: String(group?.description || '')
  };
}

function prepareNewGroupIsBulk(group) {
  if (typeof group?.isBulkQuantity !== 'undefined') return !!group.isBulkQuantity;
  const matching = prepareNewAvailableAssetsForGroup(group)
    .concat(group?.assignedAssets || []);
  return matching.some(asset => asset?.isBulk) && !matching.some(asset => !asset?.isBulk);
}

function prepareNewOpenPreparedSlots(group) {
  if (typeof group?.openPreparedSlots !== 'undefined') {
    return Number(group.openPreparedSlots || 0);
  }
  return Math.max(0, getPreparedQuantity(group) - Number(group?.assignedSpecificQuantity || 0));
}

function prepareNewToggleActionMenu(event, encodedKey) {
  event.preventDefault();
  event.stopPropagation();
  const key = planDecode(encodedKey);
  document.querySelectorAll('.prepare-new-action-menu.open').forEach(menu => {
    if (menu.dataset.modelKey !== key) menu.classList.remove('open');
  });
  const menu = Array.from(document.querySelectorAll('.prepare-new-action-menu'))
    .find(node => node.dataset.modelKey === key);
  menu?.classList.toggle('open');
}

async function prepareNewPromptQuantity({ title, message, confirmText, max = 0, defaultValue = 1, inputLabel = 'Quantity' }) {
  const value = await showAppPrompt({
    title,
    message,
    inputType: 'number',
    inputLabel,
    placeholder: max > 0 ? `Max ${max}` : 'Quantity',
    defaultValue: String(defaultValue),
    confirmText,
    cancelText: 'Cancel',
    required: true
  });
  if (value === null || value === false) return 0;
  const quantity = Number.parseInt(String(value || '').trim(), 10);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    showNotification('warning', 'Enter a quantity greater than 0');
    return 0;
  }
  if (max > 0 && quantity > max) {
    showNotification('warning', `Only ${max} can be selected`);
    return 0;
  }
  return quantity;
}

async function prepareNewChangeModelQuantity(group, action, quantity, options = {}) {
  const eventId = Number(prepareNewPageState.eventId);
  if (!eventId) return;
  try {
    const response = await apiCall(`/api/events/${eventId}/prepare-model-quantity`, 'POST', {
      ...prepareNewGroupPayload(group),
      action,
      quantity,
      all: !!options.all,
      subprojectId: eventActiveSubproject(prepareNewPageState, prepareNewPageState.event)?.id || ''
    });
    showNotification('success', response.message || 'Prepared quantity updated');
    schedulePrepareUiSync(eventId);
  } catch (error) {
    showNotification('error', error.message || 'Failed to update prepared quantity');
  }
}

async function prepareNewPrepareAll(encodedKey) {
  const key = planDecode(encodedKey);
  const group = prepareNewModelGroups().find(item => prepareNewModelKey(item) === key);
  if (!group) return;
  await prepareNewChangeModelQuantity(group, 'prepare', 0, { all: true });
}

async function prepareNewPrepareQty(encodedKey) {
  const key = planDecode(encodedKey);
  const group = prepareNewModelGroups().find(item => prepareNewModelKey(item) === key);
  if (!group) return;
  const quantity = await prepareNewPromptQuantity({
    title: 'Prepare Qty',
    message: `How many ${[group.brand, group.model].filter(Boolean).join(' ') || 'items'} would you like to prepare?`,
    confirmText: 'Prepare'
  });
  if (quantity > 0) await prepareNewChangeModelQuantity(group, 'prepare', quantity);
}

async function prepareNewUnprepareQty(encodedKey) {
  const key = planDecode(encodedKey);
  const group = prepareNewModelGroups().find(item => prepareNewModelKey(item) === key);
  if (!group) return;
  const max = prepareNewGroupIsBulk(group)
    ? getPreparedQuantity(group)
    : prepareNewOpenPreparedSlots(group);
  if (max <= 0) {
    showNotification('info', 'There are no unassigned prepared units to unprepare');
    return;
  }
  const quantity = await prepareNewPromptQuantity({
    title: 'Unprepare Qty',
    message: `How many unassigned prepared unit(s) would you like to unprepare?`,
    confirmText: 'Unprepare',
    max
  });
  if (quantity > 0) await prepareNewChangeModelQuantity(group, 'unprepare', quantity);
}

function prepareNewAssetCard(asset, options = {}) {
  const eventId = Number(prepareNewPageState.eventId);
  const id = String(asset?.id || asset?.bulkId || '');
  const encodedId = planEncode(id);
  const assigned = !!options.assigned;
  const canAssign = options.canAssign !== false;
  const returned = (prepareNewPageState.event?.returnedItems || []).includes(id);
  const missing = !!(asset?.isMissing || String(asset?.status || '').toLowerCase() === 'missing');
  const degraded = !!(asset?.isDegraded || String(asset?.status || '').toLowerCase() === 'degraded');
  const label = asset?.displayId || asset?.bulkId || id || 'Inventory asset';
  const serial = asset?.serial || (asset?.isBulk ? `Qty: ${Number(asset?.quantity || 1)}` : 'No serial');
  const status = returned
    ? prepareNewStatusBadge('returned', 'Returned')
    : (assigned
      ? prepareNewStatusBadge(options.extra ? 'extra' : 'assigned', options.extra ? 'Extra' : 'Prepared')
      : missing
        ? prepareNewStatusBadge('missing', 'Missing')
        : prepareNewStatusBadge('available', 'Available'));
  const flagBadges = [
    degraded ? prepareNewStatusBadge('degraded', 'Degraded') : '',
    missing ? prepareNewStatusBadge('missing', 'Missing') : ''
  ].filter(Boolean).join('');
  const dragPayload = assigned
    ? eventSubprojectDragPayload(
        prepareNewPageState,
        prepareNewPageState.event,
        { kind: 'asset', assetRef: id }
      )
    : '';
  const action = returned
    ? ''
    : (assigned
      ? `<button type="button" class="plan-button plan-button-small prepare-new-asset-action"
                 onclick="event.stopPropagation();prepareNewUnassignAsset(${eventId}, '${encodedId}', '${escapeHtmlAttr(options.modelKey || '')}')">Unassign</button>`
      : missing
        ? `<button type="button" class="plan-button plan-button-small prepare-new-asset-action"
                   ${canAssign ? '' : 'disabled'}
                   onclick="event.stopPropagation();prepareNewAssignMissingAsset(${eventId}, '${encodedId}')">Found &amp; Assign</button>`
      : `<button type="button" class="plan-button plan-button-small prepare-new-asset-action"
                 ${canAssign ? '' : 'disabled'}
                 onclick="event.stopPropagation();prepareNewAssignAsset(${eventId}, '${encodedId}')">Assign</button>`);
  return `
    <div class="prepare-new-asset-card ${assigned ? 'assigned' : ''} ${options.extra ? 'extra' : ''} ${missing ? 'missing' : ''} ${degraded ? 'degraded' : ''} ${dragPayload ? 'is-room-draggable' : ''}"
         ${dragPayload ? `draggable="true" ondragstart="eventSubprojectDragStart(event,'${dragPayload}')" ondragend="eventSubprojectDragEnd(event)"` : ''}>
      <div title="${escapeHtmlAttr(label)}">
        <strong>${escapeHtml(label)}</strong>
        <small>${escapeHtml(serial)}</small>
        ${flagBadges ? `<div class="prepare-new-asset-flags">${flagBadges}</div>` : ''}
      </div>
      <div class="prepare-new-asset-controls">${options.extra ? status : ''}${action || (options.extra ? '' : status)}</div>
    </div>
  `;
}

function prepareNewModelSection(group) {
  const required = Number(group.requiredQuantity || 0);
  const preparedQuantity = getPreparedQuantity(group);
  const countablePrepared = getCountablePreparedQuantity(group);
  const extraPrepared = getExtraPreparedQuantity(group);
  const isBulk = prepareNewGroupIsBulk(group);
  const openSlots = prepareNewOpenPreparedSlots(group);
  const available = prepareNewAvailableAssetsForGroup(group).filter(asset => !asset?.isBulk);
  const assigned = [...(group.assignedAssets || [])].sort((a, b) =>
    String(a?.id || '').localeCompare(String(b?.id || ''), undefined, {
      numeric: true,
      sensitivity: 'base'
    })
  ).filter(asset => !asset?.isBulk);
  const key = prepareNewModelKey(group);
  const complete = countablePrepared >= required;
  const hasReturnedAnonymousSlots = Number(group.returnedPreparedSlotQuantity || 0) > 0;
  const isOpen = !isBulk && prepareNewPageState.expandedModels.has(key);
  const modelName = [group.brand, group.model].filter(Boolean).join(' ') || 'Unspecified model';
  const canAssignExactAssets = !isBulk;
  const encodedKey = planEncode(key);
  const allCards = [
    ...assigned.map(asset => prepareNewAssetCard(asset, {
      assigned: true,
      extra: !!asset?.isExtra,
      modelKey: encodedKey
    })),
    ...(canAssignExactAssets
      ? available.map(asset => prepareNewAssetCard(asset, { canAssign: true }))
      : [])
  ];
  const primaryAction = isBulk
    ? (complete
      ? `<span class="prepare-new-prepared-label">${prepareNewStatusBadge('complete', 'Prepared')}</span>`
      : `<button type="button" class="plan-button plan-button-small prepare-new-primary-action"
                 onclick="event.preventDefault();event.stopPropagation();prepareNewPrepareAll('${encodedKey}')">Prepare all</button>`)
    : (complete || hasReturnedAnonymousSlots
      ? `<button type="button" class="plan-button plan-button-small prepare-new-primary-action"
                 onclick="event.preventDefault();event.stopPropagation();prepareNewSetModelExpanded('${encodedKey}', true); prepareNewRenderAfterModelToggle('${encodedKey}')">Assign</button>`
      : `<button type="button" class="plan-button plan-button-small prepare-new-primary-action"
                 onclick="event.preventDefault();event.stopPropagation();prepareNewPrepareAll('${encodedKey}')">Prepare all</button>`);
  const menu = `
    <span class="prepare-new-action-wrap">
      <button type="button" class="prepare-new-more-button" aria-label="More prepare actions"
              onclick="prepareNewToggleActionMenu(event, '${encodedKey}')">...</button>
      <span class="prepare-new-action-menu" data-model-key="${escapeHtmlAttr(key)}">
        <button type="button" onclick="event.stopPropagation();prepareNewPrepareQty('${encodedKey}')">Prepare qty</button>
        ${(isBulk ? preparedQuantity > 0 : openSlots > 0) ? `<button type="button" onclick="event.stopPropagation();prepareNewUnprepareQty('${encodedKey}')">Unprepare qty</button>` : ''}
      </span>
    </span>
  `;
  const spareLabel = extraPrepared > 0
    ? `<span class="prepare-new-spare-label">${extraPrepared} spare</span>`
    : '';
  const showExactAssetPanel = !isBulk;
  return `
    <details class="prepare-new-model" ${isOpen ? 'open' : ''}
             data-prepare-render-version="${prepareNewPageState.renderVersion}"
             ontoggle="prepareNewSetModelExpanded('${encodedKey}', this.open, this)">
      <summary>
        <span class="prepare-new-model-title">
          <strong>${escapeHtml(modelName)}</strong>
          <span>${escapeHtml(group.description || '')}</span>
        </span>
        <span class="prepare-new-model-count"><strong>${required}</strong>Required</span>
        <span class="prepare-new-model-count ${preparedQuantity < required ? 'is-underprepared' : ''}"><strong>${preparedQuantity}</strong>Prepared${spareLabel}</span>
        <span class="prepare-new-model-actions">${primaryAction}${menu}</span>
      </summary>
      ${showExactAssetPanel ? `<div class="prepare-new-model-assets">
        <div class="prepare-new-model-assets-head">
          <span>Select exact assets from inventory</span>
          <span>${Math.max(0, required - countablePrepared)} still required${extraPrepared > 0 ? ` · ${extraPrepared} spare` : ''}</span>
        </div>
        <div class="prepare-new-asset-grid">
          ${allCards.length ? allCards.join('') : '<div class="prepare-new-empty">No matching assets are currently available.</div>'}
        </div>
      </div>` : ''}
    </details>
  `;
}

function prepareNewDirectAssetCard(asset, encodedPanelKey = '') {
  const eventId = Number(prepareNewPageState.eventId);
  const id = String(asset?.id || '');
  const encodedId = planEncode(id);
  const label = asset?.label || id || 'Assigned asset';
  const detail = asset?.serial || (asset?.isBulk ? `Qty: ${Number(asset?.quantity || 1)}` : 'No serial');
  const status = String(asset?.status || 'pending');
  let badge = prepareNewStatusBadge('pending', 'Pending');
  let action = `
    <button type="button" class="plan-button plan-button-small prepare-new-asset-action"
            onclick="prepareNewPrepareAsset(${eventId}, '${encodedId}')">Prepare</button>
  `;
  if (status === 'packed') {
    badge = prepareNewStatusBadge('complete', 'Prepared');
    action = `
      <button type="button" class="plan-button plan-button-small prepare-new-asset-action"
              onclick="prepareNewUnprepareAsset(${eventId}, '${encodedId}', '${escapeHtmlAttr(encodedPanelKey)}')">Undo</button>
    `;
  } else if (status === 'returned') {
    badge = prepareNewStatusBadge('returned', 'Returned');
    action = '';
  }
  const dragPayload = eventSubprojectDragPayload(
    prepareNewPageState,
    prepareNewPageState.event,
    { kind: 'asset', assetRef: id }
  );
  return `
    <div class="prepare-new-asset-card ${status === 'packed' ? 'assigned' : ''} ${dragPayload ? 'is-room-draggable' : ''}"
         ${dragPayload ? `draggable="true" ondragstart="eventSubprojectDragStart(event,'${dragPayload}')" ondragend="eventSubprojectDragEnd(event)"` : ''}>
      <div title="${escapeHtmlAttr(label)}">
        <strong>${escapeHtml(label)}</strong>
        <small>${escapeHtml(detail)}</small>
      </div>
      <div>${action || badge}</div>
    </div>
  `;
}

function renderPrepareNewDirectRequirements(rows) {
  const physicalRows = rows.filter(row =>
    (row.assets || []).some(asset => !parseCustomAsset(asset.id, asset))
  );
  if (!physicalRows.length) {
    return '<div class="prepare-new-empty">Custom requirements can be prepared from the Misc / Loan Items panel.</div>';
  }
  return physicalRows.map((row, index) => {
    const assets = (row.assets || []).filter(asset => !parseCustomAsset(asset.id, asset));
    const complete = Number(row.packed || 0) >= Number(row.required || 0);
    const panelKey = `direct|${normalizeDepartmentCode(row.department || 'UN')}|${row.description || ''}|${index}`;
    const encodedPanelKey = planEncode(panelKey);
    const isOpen = prepareNewPageState.expandedModels.has(panelKey);
    return `
      <details class="prepare-new-model" ${isOpen ? 'open' : ''}
               data-prepare-render-version="${prepareNewPageState.renderVersion}"
               ontoggle="prepareNewSetModelExpanded('${encodedPanelKey}', this.open, this)">
        <summary>
          <span class="prepare-new-model-title">
            <strong>${escapeHtml(row.description || 'Assigned assets')}</strong>
            <span>${escapeHtml(row.detail || '')}</span>
          </span>
          <span class="prepare-new-model-count"><strong>${Number(row.required || 0)}</strong>Required</span>
          <span class="prepare-new-model-count ${Number(row.packed || 0) < Number(row.required || 0) ? 'is-underprepared' : ''}"><strong>${Number(row.packed || 0)}</strong>Prepared</span>
          ${prepareNewStatusBadge(complete ? 'complete' : 'pending', complete ? 'Complete' : 'Prepare')}
        </summary>
        <div class="prepare-new-model-assets">
          <div class="prepare-new-asset-grid">
            ${assets.map(asset => prepareNewDirectAssetCard(asset, encodedPanelKey)).join('')}
          </div>
        </div>
      </details>
    `;
  }).join('');
}

function prepareNewStandaloneExtras() {
  const extrasShownInRequirements = new Set();
  prepareNewModelGroups().forEach(group => {
    (group.assignedAssets || []).forEach(asset => {
      if (asset?.isExtra && asset?.id) extrasShownInRequirements.add(String(asset.id));
    });
  });
  const event = prepareNewPageState.event || {};
  const rooms = eventSubprojects(event);
  const snapshotExtras = prepareNewSnapshot().extras || [];
  if (!rooms.length) {
    return snapshotExtras.filter(
      asset => !extrasShownInRequirements.has(String(asset?.id || ''))
    );
  }

  const consolidated = eventIsConsolidated(prepareNewPageState, event);
  const activeRoom = eventActiveSubproject(prepareNewPageState, event);
  const scopedExtraRefs = new Set(
    consolidated
      ? rooms.flatMap(room => (room.extraRefs || []).map(String))
      : (activeRoom?.extraRefs || []).map(String)
  );
  if (rooms.length === 1) {
    snapshotExtras.forEach(asset => scopedExtraRefs.add(String(asset?.id || '')));
  }

  const assetsById = new Map();
  Object.values(event?.modelGroups || {}).forEach(group => {
    (group.assignedAssets || []).forEach(asset => {
      if (asset?.id) assetsById.set(String(asset.id), asset);
    });
  });
  Object.values(event?.assetsByDepartment || {}).forEach(assets => {
    (assets || []).forEach(asset => {
      if (asset?.id && !assetsById.has(String(asset.id))) {
        assetsById.set(String(asset.id), asset);
      }
    });
  });
  snapshotExtras.forEach(asset => {
    if (asset?.id && !assetsById.has(String(asset.id))) {
      assetsById.set(String(asset.id), asset);
    }
  });

  return Array.from(scopedExtraRefs)
    .filter(assetId => !extrasShownInRequirements.has(assetId))
    .map(assetId => assetsById.get(assetId))
    .filter(Boolean)
    .map(asset => ({ ...asset, isExtra: true }));
}

function prepareNewExtrasSection() {
  const extras = prepareNewStandaloneExtras();
  const panelKey = 'standalone-extra-assets';
  const encodedPanelKey = planEncode(panelKey);
  const isOpen = prepareNewPageState.expandedModels.has(panelKey);
  if (!extras.length && !isOpen) return '';
  return `
    <details class="prepare-new-department" ${isOpen ? 'open' : ''}
             data-prepare-render-version="${prepareNewPageState.renderVersion}"
             ontoggle="prepareNewSetModelExpanded('${encodedPanelKey}', this.open, this)">
      <summary>
        <span class="prepare-new-department-name">
          <span class="plan-department-dot" style="--department-color:#7c3aed"></span>
          Extra Assets
        </span>
        <span class="prepare-new-progress">${extras.length} item${extras.length === 1 ? '' : 's'}</span>
        <span aria-hidden="true">\u2304</span>
      </summary>
      <div class="prepare-new-model-assets">
        <div class="prepare-new-asset-grid">
          ${extras.length
            ? extras.map(asset => prepareNewAssetCard(asset, {
                assigned: true,
                extra: true,
                modelKey: encodedPanelKey
              })).join('')
            : '<div class="prepare-new-empty">No extra assets remain assigned to this event.</div>'}
        </div>
      </div>
    </details>
  `;
}

function renderPrepareNewAssignment() {
  const groups = prepareNewModelGroups();
  if (!groups.length) {
    const snapshot = prepareNewSnapshot();
    if (!snapshot.rows.length) {
      return '<div class="prepare-new-empty">This event has no planned requirements yet.</div>';
    }
    return renderPrepareNewDirectRequirements(snapshot.rows) + prepareNewExtrasSection();
  }

  const byDepartment = new Map();
  groups.forEach(group => {
    const department = normalizeDepartmentCode(group.department || 'UN');
    if (!byDepartment.has(department)) byDepartment.set(department, []);
    byDepartment.get(department).push(group);
  });

  const departments = Array.from(byDepartment.entries()).map(([department, departmentGroups]) => {
    const required = departmentGroups.reduce(
      (sum, group) => sum + Number(group.requiredQuantity || 0),
      0
    );
    const assigned = departmentGroups.reduce(
      (sum, group) => sum + getCountablePreparedQuantity(group),
      0
    );
    const percent = required ? Math.min(100, Math.round((assigned / required) * 100)) : 0;
    const info = getDepartmentMeta(department);
    return `
      <details class="prepare-new-department"
               ${prepareNewPageState.expandedDepartments.has(department) ? 'open' : ''}
               data-prepare-render-version="${prepareNewPageState.renderVersion}"
               ontoggle="prepareNewSetDepartmentExpanded('${planEncode(department)}', this.open, this)">
        <summary>
          <span class="prepare-new-department-name">
            <span class="plan-department-dot" style="--department-color:${escapeHtmlAttr(info.color || '#667085')}"></span>
            ${escapeHtml(department)} \u00b7 ${escapeHtml(info.name || department)}
            <span class="plan-badge">${departmentGroups.length} line${departmentGroups.length === 1 ? '' : 's'}</span>
          </span>
          <span class="prepare-new-progress">
            ${assigned} / ${required} prepared
            <span class="prepare-new-progress-track"><span style="width:${percent}%"></span></span>
          </span>
          <span aria-hidden="true">\u2304</span>
        </summary>
        ${departmentGroups.map(prepareNewModelSection).join('')}
      </details>
    `;
  }).join('');
  return departments + prepareNewExtrasSection();
}

function prepareNewCustomAssets(event = prepareNewPageState.event, state = prepareNewPageState) {
  const assets = getCustomAssetsFromEvent(event || {})
    .map(asset => ({
      ...asset,
      parsedCustom: asset.parsedCustom || parseCustomAsset(asset.id, asset)
    }))
    .filter(asset => !!asset.parsedCustom)
    .sort((a, b) => customAssetDisplayName(a.parsedCustom, false).localeCompare(
      customAssetDisplayName(b.parsedCustom, false),
      undefined,
      { numeric: true, sensitivity: 'base' }
    ));
  return groupEventCustomAssets(eventScopedCustomAssets(event, state, assets));
}

function renderPrepareNewCustomList() {
  const customAssets = prepareNewCustomAssets();
  if (!customAssets.length) {
    return '<div class="prepare-new-empty">No miscellaneous or loan items.</div>';
  }
  const event = prepareNewPageState.event || {};
  const consolidated = eventIsConsolidated(prepareNewPageState, event);
  const prepared = new Set(event.actuallyPrepared || []);
  const collected = new Set(event.customCollected || []);
  const returned = new Set(event.returnedItems || []);
  const renderRow = asset => {
    const custom = asset.parsedCustom;
    const ids = (asset.assetIds || [asset.id]).map(String).filter(Boolean);
    const id = ids[0] || '';
    const encodedId = planEncode(id);
    const preparedCount = ids.filter(assetId => prepared.has(assetId)).length;
    const collectedCount = ids.filter(assetId => collected.has(assetId)).length;
    const returnedCount = ids.filter(assetId => returned.has(assetId)).length;
    const isPrepared = preparedCount === ids.length;
    const isCollected = collectedCount === ids.length;
    const isReturned = returnedCount === ids.length;
    const collectedIds = ids.filter(assetId => collected.has(assetId) && !prepared.has(assetId));
    const dragPayload = eventSubprojectDragPayload(
      prepareNewPageState,
      prepareNewPageState.event,
      { kind: 'asset', assetRef: id }
    );
    let status = prepareNewStatusBadge('pending', 'Pending');
    let action = '';
    if (consolidated) {
      if (isReturned) {
        status = prepareNewStatusBadge('returned', 'Returned');
      } else if (isPrepared) {
        status = prepareNewStatusBadge('complete', 'Prepared');
      } else if (custom.type === 'LOAN') {
        if (isCollected) {
          status = prepareNewStatusBadge('collected', 'Collected');
          action = `<button type="button" class="plan-button plan-button-small prepare-new-consolidated-loan-action"
                            onclick="prepareNewUncollectCustomMany(${Number(event.id)}, '${planEncode(JSON.stringify(collectedIds))}')">Uncollect</button>`;
        } else {
          if (collectedCount > 0) {
            status = prepareNewStatusBadge('collected', `${collectedCount} / ${ids.length} collected`);
          }
          const pendingIds = ids.filter(assetId => !collected.has(assetId) && !returned.has(assetId));
          const consolidatedActions = [];
          if (collectedIds.length) consolidatedActions.push(
            `<button type="button" class="plan-button plan-button-small prepare-new-consolidated-loan-action"
                     onclick="prepareNewUncollectCustomMany(${Number(event.id)}, '${planEncode(JSON.stringify(collectedIds))}')">Uncollect</button>`
          );
          if (pendingIds.length) consolidatedActions.push(
            `<button type="button" class="plan-button plan-button-small prepare-new-consolidated-loan-action"
                     onclick="prepareNewCollectCustomMany(${Number(event.id)}, '${planEncode(JSON.stringify(pendingIds))}')">Collect</button>`
          );
          action = consolidatedActions.join('');
        }
      }
    } else if (isReturned) {
      status = prepareNewStatusBadge('returned', 'Returned');
    } else if (isPrepared) {
      status = prepareNewStatusBadge('complete', 'Prepared');
      action = `<button type="button" class="plan-button plan-button-small"
                        onclick="prepareNewUnprepareAsset(${Number(event.id)}, '${encodedId}')">Unprepare</button>`;
    } else if (custom.type === 'LOAN' && !isCollected) {
      action = `<button type="button" class="plan-button plan-button-small"
                        onclick="prepareNewCollectCustom(${Number(event.id)}, '${encodedId}')">Collect</button>`;
    } else {
      if (isCollected) status = prepareNewStatusBadge('collected', 'Collected');
      action = custom.type === 'LOAN'
        ? `<button type="button" class="plan-button plan-button-small plan-button-secondary"
                   onclick="prepareNewUncollectCustom(${Number(event.id)}, '${encodedId}')">Uncollect</button>
           <button type="button" class="plan-button plan-button-small"
                   onclick="prepareNewPrepareAsset(${Number(event.id)}, '${encodedId}')">Prepare</button>`
        : `<button type="button" class="plan-button plan-button-small"
                   onclick="prepareNewPrepareAsset(${Number(event.id)}, '${encodedId}')">Prepare</button>`;
    }
    const detail = custom.type === 'LOAN'
      ? (custom.company ? `From ${custom.company}` : '')
      : (custom.description || '');
    return `
      <div class="prepare-new-custom-row ${dragPayload ? 'is-room-draggable' : ''}"
           ${dragPayload ? `draggable="true" ondragstart="eventSubprojectDragStart(event,'${dragPayload}')" ondragend="eventSubprojectDragEnd(event)"` : ''}>
        <div>
          <div class="prepare-new-custom-title">
            <strong>${Math.max(1, Number(custom.quantity || 1))}x ${escapeHtml(customAssetDisplayName(custom, false))}</strong>
            ${planDepartmentCodeBadgeHtml(custom.department)}
          </div>
          ${detail ? `<small>${escapeHtml(detail)}</small>` : ''}
          <div style="margin-top:4px;">${status}</div>
        </div>
        ${action ? `<div class="prepare-new-custom-actions">${action}</div>` : ''}
      </div>
    `;
  };

  const misc = customAssets.filter(asset => asset.parsedCustom?.type !== 'LOAN');
  const loanGroups = new Map();
  customAssets.filter(asset => asset.parsedCustom?.type === 'LOAN').forEach(asset => {
    const company = String(asset.parsedCustom?.company || 'Unspecified company').trim();
    if (!loanGroups.has(company)) loanGroups.set(company, []);
    loanGroups.get(company).push(asset);
  });
  const sections = [];
  if (misc.length) sections.push({ label: 'Miscellaneous', rows: misc });
  Array.from(loanGroups.entries())
    .sort(([left], [right]) => left.localeCompare(right, undefined, { sensitivity: 'base' }))
    .forEach(([company, rows]) => sections.push({ label: company, rows, loan: true }));

  return sections.map(section => `
    <details class="prepare-new-custom-group">
      <summary>
        <span>${section.loan ? 'Loan from ' : ''}${escapeHtml(section.label)}</span>
        <span class="plan-badge">${section.rows.length}</span>
        <span aria-hidden="true">\u2304</span>
      </summary>
      <div class="prepare-new-custom-group-rows">${section.rows.map(renderRow).join('')}</div>
    </details>
  `).join('');
}

function renderPrepareNewEventDetails() {
  const event = prepareNewPageState.event || {};
  return `
    <section class="prepare-new-card prepare-new-event-card">
      <div class="prepare-new-card-header event-detail-card-header">
        <h3>&#128203; Event Details</h3>
        ${eventDetailsActionsHtml(event.id)}
      </div>
      <div class="plan-aside-body">
        <dl class="plan-detail-list">
          <div><dt>Name</dt><dd>${escapeHtml(event.name || '\u2014')}</dd></div>
          <div><dt>Location</dt><dd>${escapeHtml(event.location || '\u2014')}</dd></div>
          <div><dt>Date(s)</dt><dd>${escapeHtml(prepareNewEventDates(event))}</dd></div>
          <div><dt>Status</dt><dd>${planEventStateBadgeHtml(event)}</dd></div>
          <div><dt>Type</dt><dd>${planEventTypeBadgeHtml(event)}</dd></div>
          <div class="plan-detail-notes-row">
            <dt>Notes</dt>
            <dd>
              <textarea id="prepareNewNotes" class="plan-notes-textarea"
                        maxlength="30000"
                        placeholder="Add notes or special requirements for this event\u2026"
                        oninput="prepareNewNotesChanged(this.value)">${escapeHtml(event.notes || '')}</textarea>
              <div class="plan-notes-footer">
                <span id="prepareNewNotesSaveState">Saved</span>
                <span>${String(event.notes || '').length} / 30000</span>
              </div>
            </dd>
          </div>
        </dl>
      </div>
    </section>
  `;
}

function renderPrepareNewCustomForm() {
  return `
    <section class="prepare-new-card prepare-new-custom-card">
      <div class="prepare-new-card-header"><h3>&#10133; Add Custom Item</h3></div>
      <div class="plan-aside-body">
        <div class="plan-custom-form">
          <div class="plan-custom-type-toggle">
            <button type="button" id="prepareNewCustomMisc" class="active"
                    onclick="prepareNewSetCustomType('MISC')">Misc</button>
            <button type="button" id="prepareNewCustomLoan"
                    onclick="prepareNewSetCustomType('LOAN')">Loan</button>
          </div>
          <input type="hidden" id="prepareNewCustomType" value="MISC">
          <div class="plan-custom-field-grid">
            <div class="plan-custom-field">
              <label for="prepareNewCustomName">Item Name</label>
              <input id="prepareNewCustomName" type="text" placeholder="e.g. Wireless Handheld Mic">
            </div>
            <div class="plan-custom-field">
              <label for="prepareNewCustomQuantity">Quantity</label>
              <input id="prepareNewCustomQuantity" type="number" min="1" value="1">
            </div>
          </div>
          <div class="plan-custom-field-grid plan-custom-field-grid-secondary">
            <div class="plan-custom-field">
              <label for="prepareNewCustomDepartment">Department</label>
              <select id="prepareNewCustomDepartment">${customDepartmentOptionsHtml('AX')}</select>
            </div>
            <div class="plan-custom-field">
              <label for="prepareNewCustomCompany" id="prepareNewCustomDetailLabel">Description</label>
              <input id="prepareNewCustomCompany" type="text" placeholder="Optional description">
            </div>
          </div>
          <button type="button" class="plan-button plan-button-primary plan-custom-submit"
                  onclick="prepareNewAddCustomItem()">Add Custom Item</button>
        </div>
      </div>
    </section>
  `;
}

function renderPrepareNewOverallProgressCard() {
  const totals = prepareNewTotals();
  const percent = totals.required > 0
    ? Math.min(100, Math.round((totals.prepared / totals.required) * 100))
    : 0;
  return `
    <section class="prepare-new-card prepare-new-progress-card">
      <div class="prepare-new-card-header">
        <h3>Overall Progress</h3>
        <span class="prepare-new-status prepare-new-status-${percent >= 100 ? 'complete' : 'pending'}">${percent}%</span>
      </div>
      <div class="prepare-new-card-body">
        <div class="prepare-new-overall-copy">
          <strong>${Number(totals.prepared || 0)} / ${Number(totals.required || 0)}</strong>
          <span>prepared</span>
        </div>
        <div class="prepare-new-overall-track" aria-hidden="true">
          <span style="width:${percent}%"></span>
        </div>
        ${totals.extra > 0 ? `<small>${Number(totals.extra)} extra item${totals.extra === 1 ? '' : 's'} prepared</small>` : ''}
      </div>
    </section>
  `;
}

function renderPrepareNewExitButton(mobile = false) {
  const complete = prepareNewIsComplete();
  return `
    <button type="button"
            class="plan-button prepare-new-finish ${complete ? 'plan-button-primary' : 'prepare-new-finish-outline'}"
            onclick="prepareNewExit(${complete ? 'true' : 'false'})">
      ${complete ? 'Finish Preparing \u2192' : 'Save and Exit'}
    </button>
  `;
}

function renderPrepareNewPage() {
  const root = document.getElementById('prepare-new-page-root');
  if (!root) return;
  // Invalidate toggle events dispatched by <details> elements removed during
  // this render before they can overwrite the remembered open state.
  prepareNewPageState.renderVersion += 1;
  const event = prepareNewPageState.event;
  if (!event) {
    root.innerHTML = '<div class="plan-empty">There are no events available to prepare.</div>';
    return;
  }
  const consolidated = eventIsConsolidated(prepareNewPageState, event);
  root.classList.toggle('event-consolidated-mode', consolidated);
  prepareNewInitialExpansion();
  const totals = prepareNewTotals(event);
  const quickAddEnabled = getPrepareQuickAddEnabled();
  root.innerHTML = `
    <div class="prepare-new-heading">
      <div>
        <h2>Prepare Event Assets</h2>
        <p>Assign exact assets by scanning, typing, or selecting them manually.</p>
      </div>
      <div class="prepare-new-heading-actions">
        <button type="button" class="plan-button" onclick="prepareNewReturnToPlan()">\u2190 Return to Planning</button>
      </div>
    </div>
    <div class="prepare-new-top">
      <button type="button" class="plan-event-select-wrap"
              aria-haspopup="dialog" aria-label="Choose an event to prepare"
              onclick="planOpenEventChooser('prepare-new')">
        <div class="plan-event-icon" aria-hidden="true">${planMetricIconSvg('calendar')}</div>
        <div style="min-width:0;flex:1;">
          <div class="plan-event-title-row">
            <span class="plan-event-id">#${escapeHtml(String(event.id || ''))}</span>
            <span class="plan-event-name">${escapeHtml(planEventOptionLabel(event))}</span>
          </div>
          <div class="plan-event-meta">
            <span>${escapeHtml(prepareNewEventDates(event))}</span>
            ${event.location ? `<span aria-hidden="true">\u2022</span><span>${escapeHtml(event.location)}</span>` : ''}
            ${planEventTypeBadgeHtml(event)}
            ${planEventStateBadgeHtml(event)}
          </div>
        </div>
        <span class="plan-event-picker-chevron" aria-hidden="true">\u2304</span>
      </button>
      <div class="plan-metrics prepare-new-metrics">
        <div class="plan-metric"><div class="plan-metric-icon">${planMetricIconSvg('lines')}</div><div><strong>${totals.lineCount}</strong><span>Asset Lines</span></div></div>
        <div class="plan-metric"><div class="plan-metric-icon">${planMetricIconSvg('quantity')}</div><div><strong>${totals.required}</strong><span>Total Required</span></div></div>
        <div class="plan-metric"><div class="plan-metric-icon" style="color:#15803d;background:#dcfce7;">&#10003;</div><div><strong>${totals.prepared}</strong><span>Prepared</span></div></div>
        <div class="plan-metric"><div class="plan-metric-icon">&#8857;</div><div><strong>${totals.extra}</strong><span>Extra</span></div></div>
        <div class="plan-metric"><div class="plan-metric-icon">${planMetricIconSvg('departments')}</div><div><strong>${totals.departments}</strong><span>Active Departments</span></div></div>
      </div>
    </div>
    ${renderEventSubprojectTabs(
      'prepareNewPageState',
      event,
      'renderPrepareNewPage',
      'Preparation sub-projects',
      {
        roomNeedsAttention: prepareNewSubprojectNeedsAttention,
        attentionLabel: 'Has unprepared items'
      }
    )}
    ${consolidated ? eventConsolidatedNotice() : ''}
    <div class="prepare-new-workspace">
      <div class="prepare-new-column prepare-new-left">
        <section class="prepare-new-card prepare-new-scan-card">
          <div class="prepare-new-card-header">
            <h3>&#9889; Scan &amp; Prepare</h3>
            <label class="prepare-new-toggle" title="Unplanned scanned assets become requirements">
              <span>Quick-add</span>
              <input type="checkbox" id="prepareQuickAddToggle" ${quickAddEnabled ? 'checked' : ''}
                     onchange="handlePrepareQuickAddToggle(this)">
              <i class="prepare-new-toggle-track" aria-hidden="true"></i>
              <span id="prepareQuickAddToggleState">${quickAddEnabled ? 'On' : 'Off'}</span>
            </label>
          </div>
          <div class="prepare-new-card-body">
            <label class="prepare-new-scan-label" for="universalAssetInput">Enter Asset ID or Serial Number</label>
            <div class="prepare-new-scan-input">
              <input id="universalAssetInput" type="text"
                     placeholder="Enter Asset ID or Serial Number\u2026"
                     autocomplete="off"
                     onkeydown="if(event.key==='Enter'){event.preventDefault();processUniversalAsset(${Number(event.id)})}">
              <button type="button" class="plan-button" onclick="scanForPrepare(${Number(event.id)})" aria-label="Scan with camera">&#128247;</button>
            </div>
            <div class="prepare-new-scan-actions">
              <button type="button" class="plan-button prepare-new-process"
                      onclick="processUniversalAsset(${Number(event.id)})">&#10003; Process Asset</button>
              <button type="button" class="plan-button plan-button-primary"
                      onclick="scanForPrepare(${Number(event.id)})">&#128247; Scan with Camera</button>
              <button type="button" class="plan-button" onclick="clearUniversalInput()">Clear</button>
            </div>
            <div id="universal-asset-feedback" class="prepare-new-feedback" aria-live="polite"></div>
          </div>
        </section>
        <section class="prepare-new-card prepare-new-custom-list-card">
          <div class="prepare-new-card-header">
            <h3>&#128230; Misc / Loan Items</h3>
            <span class="plan-badge">${prepareNewCustomAssets().length} items</span>
          </div>
          <div class="prepare-new-custom-list">${renderPrepareNewCustomList()}</div>
        </section>
      </div>
      <div class="prepare-new-column prepare-new-center">
        <section class="prepare-new-card prepare-new-assignment-card">
          <div class="prepare-new-card-header">
            <h3><span class="prepare-new-heading-icon">${planMetricIconSvg('assignment')}</span>Assignment Workspace</h3>
            <span class="prepare-new-status prepare-new-status-${prepareNewIsComplete() ? 'complete' : 'pending'}">
              ${totals.prepared} / ${totals.required} prepared
            </span>
          </div>
          <div class="prepare-new-assignment-scroll">${renderPrepareNewAssignment()}</div>
        </section>
      </div>
      <div class="prepare-new-column prepare-new-right">
        ${renderPrepareNewEventDetails()}
        ${renderPrepareNewCustomForm()}
        ${renderPrepareNewOverallProgressCard()}
        ${renderPrepareNewExitButton()}
      </div>
      <div class="prepare-new-mobile-action">${renderPrepareNewExitButton(true)}</div>
    </div>
  `;
}

function prepareNewCaptureViewState() {
  const active = document.activeElement;
  const root = document.getElementById('prepare-new-page-root');
  return {
    pageX: window.scrollX,
    pageY: window.scrollY,
    scanTop: root?.querySelector('.prepare-new-left')?.scrollTop || 0,
    assignmentTop: root?.querySelector('.prepare-new-assignment-scroll')?.scrollTop || 0,
    customTop: root?.querySelector('.prepare-new-custom-list')?.scrollTop || 0,
    activeId: active && root?.contains(active) ? active.id : '',
    selectionStart: typeof active?.selectionStart === 'number' ? active.selectionStart : null,
    selectionEnd: typeof active?.selectionEnd === 'number' ? active.selectionEnd : null,
    scanValue: document.getElementById('universalAssetInput')?.value || '',
    scanRevision: prepareNewPageState.scanRevision,
    scanFeedbackHtml: document.getElementById('universal-asset-feedback')?.innerHTML || '',
    notesValue: document.getElementById('prepareNewNotes')?.value || '',
    customName: document.getElementById('prepareNewCustomName')?.value || '',
    customQuantity: document.getElementById('prepareNewCustomQuantity')?.value || '1',
    customCompany: document.getElementById('prepareNewCustomCompany')?.value || '',
    customDepartment: document.getElementById('prepareNewCustomDepartment')?.value || 'AX',
    customType: document.getElementById('prepareNewCustomType')?.value || 'MISC'
  };
}

function prepareNewRestoreViewState(state) {
  if (!state) return;
  const setValue = (id, value) => {
    const element = document.getElementById(id);
    if (element && typeof value === 'string') element.value = value;
  };
  setValue('universalAssetInput', state.scanValue);
  const feedback = document.getElementById('universal-asset-feedback');
  if (feedback && state.scanRevision === prepareNewPageState.scanRevision) {
    feedback.innerHTML = state.scanFeedbackHtml || '';
  }
  setValue('prepareNewNotes', state.notesValue);
  setValue('prepareNewCustomName', state.customName);
  setValue('prepareNewCustomQuantity', state.customQuantity);
  setValue('prepareNewCustomCompany', state.customCompany);
  setValue('prepareNewCustomDepartment', state.customDepartment);
  prepareNewSetCustomType(state.customType || 'MISC');
  const root = document.getElementById('prepare-new-page-root');
  const scan = root?.querySelector('.prepare-new-left');
  const assignment = root?.querySelector('.prepare-new-assignment-scroll');
  const custom = root?.querySelector('.prepare-new-custom-list');
  if (scan) scan.scrollTop = state.scanTop;
  if (assignment) assignment.scrollTop = state.assignmentTop;
  if (custom) custom.scrollTop = state.customTop;
  window.scrollTo(state.pageX, state.pageY);
  const active = state.activeId ? document.getElementById(state.activeId) : null;
  if (active) {
    active.focus({ preventScroll: true });
    if (
      state.selectionStart !== null &&
      typeof active.setSelectionRange === 'function'
    ) {
      active.setSelectionRange(state.selectionStart, state.selectionEnd);
    }
  }
}

async function loadPrepareNewPage() {
  const root = document.getElementById('prepare-new-page-root');
  if (!root || prepareNewPageState.loading) return;
  prepareNewPageState.loading = true;
  root.innerHTML = '<div class="loading">Loading preparation workspace...</div>';
  try {
    if (!prepareNewPageState.eventId && typeof workflowRememberedEventId === 'function') {
      prepareNewPageState.eventId = workflowRememberedEventId();
    }
    const eventOptionsLoad = await startProgressiveEventOptions(
      prepareNewPageState.eventId,
      loaded => {
        prepareNewPageState.events = [...loaded].sort(planCompareEventsByEventIdDesc);
        if (activeModal('planEventChooserModal')) renderPlanEventChooser();
      }
    );
    prepareNewPageState.events = [...eventOptionsLoad.first].sort(planCompareEventsByEventIdDesc);
    eventOptionsLoad.completion.then(loaded => {
      prepareNewPageState.events = [...loaded].sort(planCompareEventsByEventIdDesc);
      if (activeModal('planEventChooserModal')) renderPlanEventChooser();
    }).catch(error => console.warn('Unable to load more event options:', error));
    const selected = prepareNewPageState.events.find(event =>
      Number(event.id) === Number(prepareNewPageState.eventId)
    ) || prepareNewPageState.events.find(event =>
      !['pending-closure', 'closed', 'completed'].includes(planStateSlug(event?.state))
    ) || prepareNewPageState.events[0];
    if (selected) {
      await selectPrepareNewEvent(selected.id, { renderLoading: false });
    } else {
      prepareNewPageState.event = null;
      renderPrepareNewPage();
    }
  } catch (error) {
    root.innerHTML = `<div class="plan-empty">Failed to load Prepare: ${escapeHtml(error.message || String(error))}</div>`;
  } finally {
    prepareNewPageState.loading = false;
  }
}

async function selectPrepareNewEvent(eventId, options = {}) {
  await prepareNewFlushNotes();
  const id = Number(eventId);
  if (!id) return;
  prepareNewPageState.eventId = id;
  if (typeof workflowRememberEvent === 'function') workflowRememberEvent(id);
  prepareNewPageState.expandedDepartments.clear();
  prepareNewPageState.expandedModels.clear();
  const root = document.getElementById('prepare-new-page-root');
  if (options.renderLoading !== false && root) {
    root.innerHTML = '<div class="loading">Loading event preparation\u2026</div>';
  }
  const requestSequence = ++prepareNewPageState.requestSequence;
  try {
    const [eventResponse, assetsResponse] = await Promise.all([
      apiCall(`/api/events/${id}`),
      apiCall(`/api/assets/available-for-event/${id}`)
    ]);
    if (requestSequence !== prepareNewPageState.requestSequence) return;
    prepareNewPageState.event = eventResponse.data;
    prepareNewPageState.availableAssets = assetsResponse.data || [];
    renderPrepareNewPage();
  } catch (error) {
    if (root) {
      root.innerHTML = `<div class="plan-empty">Failed to load event: ${escapeHtml(error.message || String(error))}</div>`;
    }
  }
}

async function refreshPrepareNewSelectedEvent(options = {}) {
  const id = Number(prepareNewPageState.eventId);
  if (!id) return;
  if (prepareNewPageState.refreshing) {
    prepareNewPageState.refreshQueued = true;
    return;
  }
  prepareNewPageState.refreshing = true;
  const viewState = options.preserve === false ? null : prepareNewCaptureViewState();
  const requestSequence = ++prepareNewPageState.requestSequence;
  try {
    const [eventResponse, assetsResponse] = await Promise.all([
      apiCall(`/api/events/${id}`),
      apiCall(`/api/assets/available-for-event/${id}`)
    ]);
    if (requestSequence !== prepareNewPageState.requestSequence) return;
    prepareNewPageState.event = eventResponse.data;
    prepareNewPageState.availableAssets = assetsResponse.data || [];
    renderPrepareNewPage();
    if (viewState) requestAnimationFrame(() => prepareNewRestoreViewState(viewState));
  } catch (error) {
    console.warn('Prepare live update failed:', error);
  } finally {
    prepareNewPageState.refreshing = false;
    if (prepareNewPageState.refreshQueued) {
      prepareNewPageState.refreshQueued = false;
      queueMicrotask(() => refreshPrepareNewSelectedEvent({ preserve: true }));
    }
  }
}

async function prepareNewApplyRealtimeEvent(event) {
  if (
    !document.getElementById('prepare-new-section')?.classList.contains('active') ||
    Number(event?.id) !== Number(prepareNewPageState.eventId)
  ) {
    return;
  }
  await refreshPrepareNewSelectedEvent({ preserve: true });
}

async function prepareNewAssignMissingAsset(eventId, encodedAssetId) {
  const assetId = planDecode(encodedAssetId);
  const confirmed = await showAppConfirm({
    title: 'Missing Asset',
    message: `${assetId} is currently marked as missing. Mark it as found and prepare it for this event?`,
    confirmText: 'Mark Found & Prepare',
    cancelText: 'Cancel',
    variant: 'warning',
  });
  if (!confirmed) return;

  let actionStarted = false;
  try {
    actionStarted = beginPrepareAssetAction(assetId, 'Marking found...');
    if (!actionStarted) return;
    const response = await apiCall(`/api/events/${eventId}/assign-specific`, 'POST', {
      assetId,
      markFound: true,
      subprojectId: eventActiveSubproject(prepareNewPageState, prepareNewPageState.event)?.id || '',
    });
    await showApiWarning(response);
    const preparedAssetId = response?.data?.assetId || assetId;
    showNotification('success', `${preparedAssetId} marked found and assigned`);
    updateAllButtonsForAsset(preparedAssetId, true, { sourceAssetId: assetId });
    schedulePrepareUiSync(eventId);
  } catch (error) {
    showNotification('error', `Failed to prepare missing asset: ${error.message}`);
    updateAllButtonsForAsset(assetId, false);
  } finally {
    if (actionStarted) endPrepareAssetAction(assetId);
  }
}

async function prepareNewAssignAsset(eventId, encodedAssetId) {
  await assignSpecificAsset(eventId, planDecode(encodedAssetId), '', '', {
    subprojectId: eventActiveSubproject(prepareNewPageState, prepareNewPageState.event)?.id || ''
  });
}

async function prepareNewPrepareAsset(eventId, encodedAssetId) {
  await prepareSpecificAsset(eventId, planDecode(encodedAssetId), {
    subprojectId: eventActiveSubproject(prepareNewPageState, prepareNewPageState.event)?.id || ''
  });
}

async function prepareNewUnprepareAsset(eventId, encodedAssetId, encodedPanelKey = '') {
  const panelKey = encodedPanelKey ? planDecode(encodedPanelKey) : '';
  if (panelKey) prepareNewPageState.expandedModels.add(panelKey);
  const changed = await unprepareSpecificAsset(eventId, planDecode(encodedAssetId), {
    subprojectId: eventActiveSubproject(prepareNewPageState, prepareNewPageState.event)?.id || ''
  });
  if (!changed) return;
  if (panelKey) prepareNewPageState.expandedModels.add(panelKey);
}

async function prepareNewUnassignAsset(eventId, encodedAssetId, encodedModelKey = '') {
  const assetId = planDecode(encodedAssetId);
  const modelKey = encodedModelKey ? planDecode(encodedModelKey) : '';
  const group = modelKey
    ? prepareNewModelGroups().find(item => prepareNewModelKey(item) === modelKey)
    : null;
  const department = group ? normalizeDepartmentCode(group.department || 'UN') : '';
  if (modelKey) prepareNewPageState.expandedModels.add(modelKey);
  if (department) prepareNewPageState.expandedDepartments.add(department);

  const changed = await unassignSpecificAsset(eventId, assetId, '', '', {
    subprojectId: eventActiveSubproject(prepareNewPageState, prepareNewPageState.event)?.id || ''
  });
  if (!changed) return;

  // Keep the exact-asset chooser open while the refreshed card changes back
  // to Available, proving that it is no longer assigned or prepared.
  if (modelKey) prepareNewPageState.expandedModels.add(modelKey);
  if (department) prepareNewPageState.expandedDepartments.add(department);
}

async function prepareNewCollectCustom(eventId, encodedAssetId) {
  await prepareNewCollectCustomMany(eventId, planEncode(JSON.stringify([planDecode(encodedAssetId)])));
}

async function prepareNewCollectCustomMany(eventId, encodedAssetIds) {
  let assetIds = [];
  try {
    assetIds = JSON.parse(planDecode(encodedAssetIds));
  } catch (error) {
    assetIds = [];
  }
  assetIds = Array.isArray(assetIds) ? assetIds.map(String).filter(Boolean) : [];
  if (!assetIds.length) return;
  try {
    const response = await apiCall(`/api/events/${eventId}/custom-assets/collect`, 'POST', { assetIds });
    const collectedCount = Number(response?.data?.collectedCount || assetIds.length);
    showNotification('success', `${collectedCount} loan item${collectedCount === 1 ? '' : 's'} collected`);
  } catch (error) {
    showNotification('error', `Failed to collect item: ${error.message}`);
    return;
  }
  schedulePrepareUiSync(eventId);
}

async function prepareNewUncollectCustom(eventId, encodedAssetId) {
  await prepareNewUncollectCustomMany(eventId, planEncode(JSON.stringify([planDecode(encodedAssetId)])));
}

async function prepareNewUncollectCustomMany(eventId, encodedAssetIds) {
  let assetIds = [];
  try {
    assetIds = JSON.parse(planDecode(encodedAssetIds));
  } catch (error) {
    assetIds = [];
  }
  assetIds = Array.isArray(assetIds) ? assetIds.map(String).filter(Boolean) : [];
  if (!assetIds.length) return;
  try {
    const response = await apiCall(`/api/events/${eventId}/custom-assets/uncollect`, 'POST', { assetIds });
    const uncollectedCount = Number(response?.data?.uncollectedCount || assetIds.length);
    showNotification('success', `${uncollectedCount} loan item${uncollectedCount === 1 ? '' : 's'} uncollected`);
  } catch (error) {
    showNotification('error', `Failed to uncollect item: ${error.message}`);
    return;
  }
  schedulePrepareUiSync(eventId);
}

function prepareNewSetCustomType(type) {
  const normalized = normalizeCustomType(type);
  const value = normalized === 'LOAN' ? 'LOAN' : 'MISC';
  const input = document.getElementById('prepareNewCustomType');
  if (input) input.value = value;
  document.getElementById('prepareNewCustomMisc')?.classList.toggle('active', value === 'MISC');
  document.getElementById('prepareNewCustomLoan')?.classList.toggle('active', value === 'LOAN');
  const detail = document.getElementById('prepareNewCustomCompany');
  const label = document.getElementById('prepareNewCustomDetailLabel');
  if (detail) {
    detail.required = value === 'LOAN';
    detail.placeholder = value === 'LOAN' ? 'Company Pte Ltd' : 'Optional description';
  }
  if (label) label.textContent = value === 'LOAN' ? 'Company / Source' : 'Description';
}

async function prepareNewAddCustomItem() {
  const eventId = Number(prepareNewPageState.eventId);
  const name = document.getElementById('prepareNewCustomName')?.value.trim() || '';
  const quantity = Math.max(
    1,
    Number.parseInt(document.getElementById('prepareNewCustomQuantity')?.value || '1', 10) || 1
  );
  const type = normalizeCustomType(document.getElementById('prepareNewCustomType')?.value || 'MISC');
  const department = normalizeDepartmentCode(
    document.getElementById('prepareNewCustomDepartment')?.value || 'UN'
  );
  const detail = document.getElementById('prepareNewCustomCompany')?.value.trim() || '';
  const company = type === 'LOAN' ? detail : '';
  const description = type === 'MISC' ? detail : '';
  if (!name) {
    showNotification('warning', 'Enter a custom item name');
    document.getElementById('prepareNewCustomName')?.focus();
    return;
  }
  if (type === 'LOAN' && !company) {
    showNotification('warning', 'Enter the loan or rental company');
    document.getElementById('prepareNewCustomCompany')?.focus();
    return;
  }
  try {
    await apiCall(`/api/events/${eventId}/custom-assets`, 'POST', {
      name,
      quantity,
      type,
      department,
      company,
      description,
      subprojectId: eventActiveSubproject(prepareNewPageState, prepareNewPageState.event)?.id || ''
    });
    showNotification('success', `${name} added`);
    await refreshPrepareNewSelectedEvent({ preserve: false });
  } catch (error) {
    showNotification('error', `Failed to add custom item: ${error.message}`);
  }
}

function prepareNewNotesChanged(value) {
  const state = document.getElementById('prepareNewNotesSaveState');
  const footerCount = document.querySelector('#prepareNewNotes + .plan-notes-footer span:last-child');
  if (footerCount) footerCount.textContent = `${String(value || '').length} / 30000`;
  if (state) state.textContent = 'Unsaved';
  prepareNewPendingNotes = {
    eventId: Number(prepareNewPageState.eventId),
    notes: String(value || '')
  };
  clearTimeout(prepareNewNotesTimer);
  prepareNewNotesTimer = setTimeout(prepareNewFlushNotes, 700);
}

async function prepareNewFlushNotes() {
  clearTimeout(prepareNewNotesTimer);
  prepareNewNotesTimer = null;
  const pending = prepareNewPendingNotes;
  if (!pending?.eventId) return;
  prepareNewPendingNotes = null;
  const state = document.getElementById('prepareNewNotesSaveState');
  if (state) state.textContent = 'Saving\u2026';
  try {
    const response = await apiCall(
      `/api/events/${pending.eventId}/notes`,
      'PUT',
      { notes: pending.notes }
    );
    if (Number(prepareNewPageState.eventId) === Number(pending.eventId)) {
      prepareNewPageState.event.notes = response.data?.notes ?? pending.notes;
      if (state) state.textContent = 'Saved';
    }
  } catch (error) {
    prepareNewPendingNotes = pending;
    if (state) state.textContent = 'Save failed';
  }
}

async function prepareNewExit(completed) {
  await prepareNewFlushNotes();
  if (completed) showNotification('success', 'All event assets are prepared');
  showSection('events');
}

function prepareNewReturnToPlan() {
  planPageState.eventId = Number(prepareNewPageState.eventId) || null;
  showSection('plan');
}
