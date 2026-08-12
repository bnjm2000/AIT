// Transfer workspace, actions, and PDF export.

// Event list view controls and transfer state
let transferReturnToOfficeCache = [];
let transferPanelMode = 'common';

// Transfer grouping, actions, and grouped PDFs
window.__transferActionState = window.__transferActionState || {};
window.__transferPendingActions = window.__transferPendingActions || {};


function setTransferActionState(assetId, state) {
  if (!assetId) return;
  if (state) window.__transferActionState[String(assetId)] = state;
  else delete window.__transferActionState[String(assetId)];
}

function resetTransferActionState() {
  window.__transferActionState = {};
  window.__transferPendingActions = {};
  window.__transferSelections = {
    transfer: new Set(),
    returnOffice: new Set(),
    officePrepare: new Set()
  };
}

function getTransferPendingAction(assetId) {
  return window.__transferPendingActions?.[String(assetId || '')] || '';
}

function beginTransferPendingAction(assetId, action) {
  if (!assetId || getTransferPendingAction(assetId)) return false;
  window.__transferPendingActions[String(assetId)] = action;
  return true;
}

function endTransferPendingAction(assetId) {
  if (!assetId) return;
  delete window.__transferPendingActions[String(assetId)];
}

function transferAssetTypeKey(item) {
  return [
    normalizeDepartmentCode(item.department || 'UN'),
    String(item.brand || '').trim().toLocaleLowerCase(),
    String(item.model || '').trim().toLocaleLowerCase()
  ].join('|');
}

function transferAssetTypeName(group) {
  return `${group.brand || ''} ${group.model || ''} ${group.description || ''}`.replace(/\s+/g, ' ').trim() || 'Unnamed Asset Type';
}


function transferProgressHtml(done, total) {
  const safeDone = Math.max(0, Number(done || 0));
  const safeTotal = Math.max(0, Number(total || 0));
  const pct = safeTotal > 0 ? Math.min(100, Math.round((safeDone / safeTotal) * 100)) : 0;
  return `
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:6px;">
      <small style="color:#666;">Progress</small>
      <small style="color:#666;">${safeDone}/${safeTotal}</small>
    </div>
    <div style="background:#e9ecef;border-radius:10px;height:6px;overflow:hidden;">
      <div style="background:#28a745;height:100%;width:${pct}%;transition:width .25s ease;"></div>
    </div>
  `;
}



function renderLegacyTransferWorkspace() {
  const container = document.getElementById('transfer-history');
  if (!container) return;

  const sourceEvents = transferOptionsCache?.sourceEvents || [];
  const targetEvents = transferOptionsCache?.targetEvents || [];

  const sourceOptions = sourceEvents.map(event => {
    const tagPrefix = event.tag === 'dry hire' ? '[DH]' : '[E]';
    return `<option value="${event.id}">${tagPrefix} #${event.id} ${escapeHtml(event.name)} · ${escapeHtml(eventStateDisplayLabel(event.state))} · ${event.unreturnedCount || 0} out</option>`;
  }).join('');

  const targetOptions = targetEvents.map(event => {
    const tagPrefix = event.tag === 'dry hire' ? '[DH]' : '[E]';
    return `<option value="${event.id}">${tagPrefix} #${event.id} ${escapeHtml(event.name)} · ${escapeHtml(eventStateDisplayLabel(event.state))}</option>`;
  }).join('');

  container.innerHTML = `
    <div class="transfer-page">
      <div class="transfer-page-header">
        <div>
          <h2>Transfer Assets</h2>
          <p>Move selected physical assets from one event directly into another event workflow.</p>
        </div>
        <div class="transfer-page-tools">
          <button type="button" class="transfer-tool-button" onclick="loadTransferCandidates()">↻ Refresh</button>
          <button type="button" class="transfer-tool-button" onclick="generateTransferPdf()">▣ Export PDF</button>
        </div>
      </div>

      <div class="transfer-event-bar">
        <div class="transfer-event-card">
          <div class="transfer-event-icon" aria-hidden="true">□</div>
          <div class="transfer-event-copy">
            <label class="transfer-event-kicker" for="transferSourceSelect">From event</label>
            <select id="transferSourceSelect" class="transfer-event-select" onchange="loadTransferCandidates()">
              <option value="">Choose source event…</option>
              ${sourceOptions}
            </select>
          </div>
          <div class="transfer-event-count">
            <strong>${sourceEvents.length}</strong>
            <span>eligible<br>events</span>
          </div>
        </div>
        <div class="transfer-direction" aria-label="Transfer direction">
          <span>→</span>
        </div>
        <div class="transfer-event-card">
          <div class="transfer-event-icon" aria-hidden="true">◇</div>
          <div class="transfer-event-copy">
            <label class="transfer-event-kicker" for="transferTargetSelect">To event</label>
            <select id="transferTargetSelect" class="transfer-event-select" onchange="loadTransferCandidates()">
              <option value="">Choose destination event…</option>
              ${targetOptions}
            </select>
          </div>
          <div class="transfer-event-count">
            <strong>${targetEvents.length}</strong>
            <span>planning /<br>preparing</span>
          </div>
        </div>
      </div>

      <div id="transfer-candidates-panel">
        ${renderTransferInitialMessage(sourceEvents, targetEvents)}
      </div>
    </div>
  `;
}












function renderTransferInitialMessage() {
  const selectableEvents = transferSelectableEvents();
  if (!selectableEvents.length) {
    return `
      <div class="transfer-empty">
        <strong>No events found</strong>
        <div>Create an event first, then return here to choose From and To events.</div>
      </div>
    `;
  }
  return '<div class="transfer-empty"><strong>Choose both events</strong><span>Select a source and destination above to compare assets and choose exact Asset IDs.</span></div>';
}

function transferSelectableEvents() {
  const options = transferOptionsCache || {};
  const rawEvents = Array.isArray(options.events) && options.events.length
    ? options.events
    : [...(options.sourceEvents || []), ...(options.targetEvents || [])];
  const byId = new Map();
  rawEvents.forEach(event => {
    if (!event?.id) return;
    byId.set(String(event.id), event);
  });
  return Array.from(byId.values()).sort(planCompareEventsByStartDate);
}

function transferEventById(eventId) {
  const id = String(eventId || '');
  if (!id) return null;
  return transferSelectableEvents().find(event => String(event.id || '') === id) || null;
}

function transferTargetSubprojects(event) {
  return Array.isArray(event?.subprojects)
    ? event.subprojects.filter(room => room && String(room.id || '').trim())
    : [];
}

function transferEnsureTargetSubproject(event) {
  const rooms = transferTargetSubprojects(event);
  if (!rooms.length) {
    transferPageState.targetSubprojectId = '';
    return null;
  }
  const selected = rooms.find(room => (
    String(room.id) === String(transferPageState.targetSubprojectId)
  ));
  if (selected) return selected;
  transferPageState.targetSubprojectId = String(rooms[0].id || '');
  return rooms[0];
}

function transferSelectedTargetSubproject() {
  return transferEnsureTargetSubproject(
    transferEventById(transferPageState.targetEventId)
  );
}

function renderTransferTargetSubprojects(event) {
  const rooms = transferTargetSubprojects(event);
  if (!rooms.length) return '';
  const selected = transferEnsureTargetSubproject(event);
  return `
    <div class="transfer-target-subprojects">
      <span class="transfer-target-subprojects-label">Prepare for</span>
      <div class="transfer-target-subproject-tabs" role="tablist" aria-label="Destination sub-project">
        ${rooms.map(room => `
          <button type="button" role="tab"
                  class="transfer-target-subproject-tab ${room === selected ? 'active' : ''}"
                  aria-selected="${room === selected}"
                  onclick="transferChooseTargetSubproject('${planEncode(room.id)}')">
            ${escapeHtml(room.name || 'Unnamed room')}
          </button>
        `).join('')}
      </div>
    </div>
  `;
}

async function transferChooseTargetSubproject(encodedSubprojectId) {
  const subprojectId = planDecode(encodedSubprojectId);
  if (!subprojectId || subprojectId === String(transferPageState.targetSubprojectId)) return;
  transferPageState.targetSubprojectId = subprojectId;
  resetTransferActionState();
  renderTransferWorkspace();
  if (transferPageState.sourceEventId && transferPageState.targetEventId) {
    await loadTransferCandidates();
  }
}

function transferUpdateCachedEventSummary(summary) {
  if (!summary?.id || !transferOptionsCache) return;
  ['events', 'sourceEvents', 'targetEvents'].forEach(listName => {
    const list = transferOptionsCache[listName];
    if (!Array.isArray(list)) return;
    const index = list.findIndex(event => String(event.id || '') === String(summary.id));
    if (index >= 0) list[index] = { ...list[index], ...summary };
  });
}

function transferEventIconSvg(kind) {
  if (kind === 'to') {
    return `
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M4 7.5 12 3l8 4.5v9L12 21l-8-4.5v-9Z"></path>
        <path d="M12 12v9M4.5 8 12 12l7.5-4"></path>
        <path d="M9 7h4.5a2.5 2.5 0 0 1 0 5H11"></path>
        <path d="m12.5 9.5-2 2 2 2"></path>
      </svg>
    `;
  }
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M4 7.5 12 3l8 4.5v9L12 21l-8-4.5v-9Z"></path>
      <path d="M12 12v9M4.5 8 12 12l7.5-4"></path>
      <path d="M10.5 8H15a2.5 2.5 0 0 1 0 5h-4"></path>
      <path d="m13 10.5 2 2-2 2"></path>
    </svg>
  `;
}

function transferUiIconSvg(kind) {
  const paths = {
    refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"></path><path d="M20 4v7h-7"></path>',
    export: '<path d="M12 3v12"></path><path d="m8 11 4 4 4-4"></path><path d="M5 20h14"></path>',
    arrow: '<path d="M5 12h14"></path><path d="m14 7 5 5-5 5"></path>',
    return: '<path d="M9 7 4 12l5 5"></path><path d="M4 12h10a6 6 0 0 1 6 6"></path>',
    prepare: '<path d="M4 7.5 12 3l8 4.5v9L12 21l-8-4.5v-9Z"></path><path d="M12 12v9M4.5 8 12 12l7.5-4"></path><path d="M12 3v9"></path>',
  };
  return `<svg class="transfer-ui-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${paths[kind] || paths.arrow}</svg>`;
}

function renderTransferEventPickerCard(role, event) {
  const isSource = role === 'source';
  const pickerContext = isSource ? 'transfer-source' : 'transfer-target';
  const kicker = isSource ? 'From event' : 'To event';
  const placeholder = isSource ? 'Choose source event' : 'Choose destination event';
  const metricValue = isSource
    ? Number(event?.unreturnedCount || 0)
    : Number(event?.requiredCount || event?.assetCount || 0);
  const metricLabel = isSource ? 'assets currently out' : 'assets required';
  const dateLabel = event ? transferEventDateLabel(event) : '';
  const location = event?.location || event?.venue || '';

  return `
    <button type="button"
            class="transfer-event-card transfer-event-picker ${event ? 'has-metric' : 'is-empty'}"
            aria-haspopup="dialog"
            onclick="planOpenEventChooser('${pickerContext}')">
      <div class="transfer-event-icon ${isSource ? 'from' : 'to'}" aria-hidden="true">${transferEventIconSvg(isSource ? 'from' : 'to')}</div>
      <div class="transfer-event-copy">
        <span class="transfer-event-kicker">${kicker}</span>
        ${event ? `
          <div class="transfer-event-title-row">
            <span class="transfer-event-id">#${escapeHtml(String(event.id || ''))}</span>
            <span class="transfer-event-name">${escapeHtml(event.name || `Event ${event.id || ''}`)}</span>
          </div>
          <div class="transfer-event-meta">
            ${dateLabel ? `<span>${escapeHtml(dateLabel)}</span>` : ''}
            ${location ? `<span aria-hidden="true">•</span><span>${escapeHtml(location)}</span>` : ''}
            ${planEventTypeBadgeHtml(event)}
            ${planEventStateBadgeHtml(event)}
          </div>
        ` : `
          <div class="transfer-event-placeholder">${placeholder}</div>
          <div class="transfer-event-meta">
            <span>Search by event name, ID, status, client, or location</span>
          </div>
        `}
      </div>
      ${event ? `<div class="transfer-event-count">
        <strong>${metricValue}</strong>
        <span>${escapeHtml(metricLabel)}</span>
      </div>` : ''}
      <span class="transfer-event-chevron" aria-hidden="true">⌄</span>
    </button>
  `;
}

async function transferChooseEvent(role, eventId) {
  const id = Number(eventId);
  if (!id) return;

  if (role === 'source') {
    transferPageState.sourceEventId = id;
    if (Number(transferPageState.targetEventId) === id) {
      transferPageState.targetEventId = null;
      transferPageState.targetSubprojectId = '';
      showNotification('info', 'Choose a different To Event for this transfer');
    }
  } else {
    transferPageState.targetEventId = id;
    transferPageState.targetSubprojectId = '';
    if (Number(transferPageState.sourceEventId) === id) {
      transferPageState.sourceEventId = null;
      showNotification('info', 'Choose a different From Event for this transfer');
    }
    transferEnsureTargetSubproject(transferEventById(id));
  }

  renderTransferWorkspace();
  if (transferPageState.sourceEventId && transferPageState.targetEventId) {
    await loadTransferCandidates();
  }
}

function renderTransferWorkspace() {
  const container = document.getElementById('transfer-history');
  if (!container) return;

  const selectedSource = transferEventById(transferPageState.sourceEventId);
  const selectedTarget = transferEventById(transferPageState.targetEventId);
  transferEnsureTargetSubproject(selectedTarget);

  container.innerHTML = `
    <div class="transfer-page">
      <input type="hidden" id="transferSourceSelect" value="${escapeHtmlAttr(selectedSource?.id || '')}">
      <input type="hidden" id="transferTargetSelect" value="${escapeHtmlAttr(selectedTarget?.id || '')}">
      <div class="transfer-page-header">
        <div>
          <h2>Transfer Assets</h2>
        </div>
        <div class="transfer-page-tools">
          <button type="button" class="transfer-tool-button" onclick="loadTransferCandidates()">${transferUiIconSvg('refresh')}<span>Refresh</span></button>
          <button type="button" class="transfer-tool-button transfer-tool-button-primary" onclick="openTransferPdfExportDialog()">${transferUiIconSvg('export')}<span>Export PDF</span></button>
        </div>
      </div>

      <div class="transfer-event-bar">
        ${renderTransferEventPickerCard('source', selectedSource)}
        <div class="transfer-direction" aria-label="Transfer direction">
          <span>${transferUiIconSvg('arrow')}</span>
        </div>
        ${renderTransferEventPickerCard('target', selectedTarget)}
      </div>
      ${renderTransferTargetSubprojects(selectedTarget)}

      <div id="transfer-candidates-panel">
        ${renderTransferInitialMessage()}
      </div>
    </div>
  `;
}

// Preserve prepare and transfer panel state during async refreshes.
function __aitCapturePrepareOpenState() {
  const state = {
    expandedSections: [],
    visiblePanels: [],
    openDetails: [],
    scrollTop: 0,
    activeTabText: ''
  };

  document.querySelectorAll('[onclick*="togglePrepareSection"]').forEach(el => {
    const onclickAttr = el.getAttribute('onclick') || '';
    const match = onclickAttr.match(/togglePrepareSection\('([^']+)'\)/);
    if (!match) return;
    const section = document.getElementById(match[1]);
    if (section && section.style.display !== 'none') {
      state.expandedSections.push(match[1]);
    }
  });

  document.querySelectorAll('#prepareEventContent [id]').forEach(el => {
    const id = el.id || '';
    if (!id) return;
    const looksLikeDropdown = id.startsWith('model-') || id.startsWith('dept-') || id.startsWith('assigned-dept-') || id === 'model-requirements' || id === 'custom-assets' || id === 'all-assigned-assets';
    if (looksLikeDropdown && el.style && el.style.display && el.style.display !== 'none') {
      state.visiblePanels.push(id);
    }
  });

  document.querySelectorAll('#prepareEventContent details[open]').forEach(details => {
    if (details.id) state.openDetails.push(details.id);
  });

  const modalContent = document.querySelector('#prepareEventModal .modal-content');
  state.scrollTop = modalContent ? modalContent.scrollTop : 0;

  const activeTab = document.querySelector('.nav-link.active');
  state.activeTabText = activeTab ? activeTab.textContent.trim() : '';
  return state;
}

function __aitRestorePrepareOpenState(state) {
  if (!state) return;
  const idsToOpen = Array.from(new Set([...(state.expandedSections || []), ...(state.visiblePanels || [])]));
  idsToOpen.forEach(sectionId => {
    const section = document.getElementById(sectionId);
    if (!section) return;
    section.style.display = 'block';
    const toggleIcon = document.querySelector(`[onclick*="togglePrepareSection('${sectionId}')"] .toggle-icon`);
    if (toggleIcon) toggleIcon.textContent = '▼';
  });

  (state.openDetails || []).forEach(id => {
    const details = document.getElementById(id);
    if (details && details.tagName && details.tagName.toLowerCase() === 'details') {
      details.open = true;
    }
  });

  const modalContent = document.querySelector('#prepareEventModal .modal-content');
  if (modalContent) modalContent.scrollTop = state.scrollTop || 0;

  if (state.activeTabText) {
    document.querySelectorAll('.nav-link').forEach(tab => {
      if (tab.textContent.trim() === state.activeTabText) tab.classList.add('active');
    });
  }
}

function preserveModalState(callback) {
  const state = __aitCapturePrepareOpenState();
  const result = typeof callback === 'function' ? callback() : null;
  Promise.resolve(result)
    .catch(err => console.error('preserveModalState callback failed:', err))
    .finally(() => {
      // Restore more than once because the modal content is rebuilt after an async API refresh.
      // This keeps the same model/department dropdown open after Prepare/Unprepare clicks.
      [50, 180, 400, 800].forEach(delay => {
        setTimeout(() => __aitRestorePrepareOpenState(state), delay);
      });
    });
  return result;
}

function getTransferActionState(assetOrId) {
  if (assetOrId && typeof assetOrId === 'object') {
    return assetOrId.transferState || assetOrId.actionState || window.__transferActionState?.[String(assetOrId.assetId || '')] || '';
  }
  return window.__transferActionState?.[String(assetOrId || '')] || '';
}

function getTransferItemState(item) {
  return getTransferActionState(item) || item?.transferState || item?.actionState || '';
}

function transferGroupDetailsId(group) {
  const raw = `${group.mode || ''}|${group.key || ''}`;
  return `transfer-group-${encodeURIComponent(raw).replace(/%/g, '_').replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

function getOpenTransferDropdownIds() {
  return Array.from(document.querySelectorAll('#transfer-candidates-panel details[open]'))
    .map(details => details.id)
    .filter(Boolean);
}

function restoreOpenTransferDropdownIds(ids) {
  (ids || []).forEach(id => {
    const details = document.getElementById(id);
    if (details && details.tagName && details.tagName.toLowerCase() === 'details') {
      details.open = true;
    }
  });
}

function getTransferSelections(kind) {
  if (!window.__transferSelections) {
    window.__transferSelections = {
      transfer: new Set(),
      returnOffice: new Set(),
      officePrepare: new Set()
    };
  }
  if (!window.__transferSelections.officePrepare) {
    window.__transferSelections.officePrepare = new Set();
  }
  if (kind === 'officePrepare') return window.__transferSelections.officePrepare;
  return kind === 'returnOffice'
    ? window.__transferSelections.returnOffice
    : window.__transferSelections.transfer;
}

function selectedTransferCountForGroup(group, kind) {
  const selected = getTransferSelections(kind);
  return transferSelectableItemsForGroup(group, kind)
    .filter(item => selected.has(String(item.assetId || item.id || ''))).length;
}

function transferGroupSelectionLimit(group) {
  return Math.max(0, Number(group.actionQty || 0) - Number(group.doneQty || 0));
}

function transferSelectableItemsForGroup(group, kind) {
  if (kind === 'officePrepare') return group.officeCandidates || [];
  return group.items || [];
}

function toggleTransferAssetSelection(encodedAssetId, kind, checked) {
  const assetId = decodeURIComponent(encodedAssetId);
  const selected = getTransferSelections(kind);
  if (!checked) {
    selected.delete(assetId);
    renderTransferCandidatesInPlace();
    return;
  }

  const mode = kind === 'returnOffice'
    ? 'return-office'
    : (kind === 'officePrepare' ? 'office-needed' : 'common');
  const groups = buildTransferGroups(getTransferListForMode(mode, window.__lastTransferData || {}), mode);
  const group = groups.find(candidate => transferSelectableItemsForGroup(candidate, kind)
    .some(item => String(item.assetId || item.id || '') === assetId));
  if (!group) return;

  const selectedInGroup = selectedTransferCountForGroup(group, kind);
  const limit = transferGroupSelectionLimit(group);
  if (selectedInGroup >= limit) {
    showNotification('warning', `Only ${limit} ${transferAssetTypeName(group)} asset(s) are needed for this action`);
    renderTransferCandidatesInPlace();
    return;
  }

  selected.add(assetId);
  renderTransferCandidatesInPlace();
}

function toggleTransferGroupSelection(encodedKey, kind) {
  const key = decodeURIComponent(encodedKey);
  const mode = kind === 'returnOffice'
    ? 'return-office'
    : (kind === 'officePrepare' ? 'office-needed' : 'common');
  const groups = buildTransferGroups(getTransferListForMode(mode, window.__lastTransferData || {}), mode);
  const group = groups.find(candidate => candidate.key === key);
  if (!group) return;

  const selected = getTransferSelections(kind);
  const selectable = transferSelectableItemsForGroup(group, kind)
    .filter(item => !getTransferItemState(item) && !getTransferPendingAction(item.assetId || item.id));
  const currentlySelected = selectable.filter(item => selected.has(String(item.assetId || item.id || '')));
  const limit = transferGroupSelectionLimit(group);

  if (currentlySelected.length >= Math.min(limit, selectable.length)) {
    selectable.forEach(item => selected.delete(String(item.assetId || item.id || '')));
  } else {
    selectable.forEach(item => selected.delete(String(item.assetId || item.id || '')));
    selectable.slice(0, limit).forEach(item => selected.add(String(item.assetId || item.id || '')));
  }
  renderTransferCandidatesInPlace();
}



function transferAssetDropdownRows(group) {
  const transferLimitReached = group.mode === 'common' && (group.doneQty + (group.pendingQty || 0)) >= group.actionQty;
  const returnLimitReached = group.mode !== 'common' && (group.doneQty + (group.pendingQty || 0)) >= group.actionQty;

  return group.items.map(item => {
    const encodedAssetId = encodeURIComponent(item.assetId || '');
    const state = getTransferItemState(item);
    const pendingAction = getTransferPendingAction(item.assetId);
    const isTransferred = state === 'transferred';
    const isReturnedOffice = state === 'returnedOffice';

    let actionHtml = '';
    let statusHtml = '<span class="asset-badge status-available">Ready</span>';

    if (pendingAction) {
      const pendingLabels = {
        transfer: 'Transferring...',
        undoTransfer: 'Undoing...',
        returnOffice: 'Returning...',
        undoReturnOffice: 'Undoing...'
      };
      statusHtml = `<span class="asset-badge status-deployed">${pendingLabels[pendingAction] || 'Updating...'}</span>`;
      actionHtml = '<button class="btn btn-secondary btn-sm" disabled>Working...</button>';
    } else if (group.mode === 'common') {
      if (isTransferred) {
        statusHtml = '<span class="asset-badge status-deployed">Transferred</span>';
        actionHtml = `<button class="btn btn-warning btn-sm" onclick="undoTransferDropdownAsset('${encodedAssetId}')">Undo</button>`;
      } else if (isReturnedOffice) {
        statusHtml = '<span class="asset-badge status-deployed">Return to Office</span>';
        actionHtml = `<button class="btn btn-secondary btn-sm" disabled title="This asset has already been returned to office">Transfer</button>`;
      } else {
        actionHtml = `<button class="btn btn-success btn-sm" ${transferLimitReached ? 'disabled title="Required transfer quantity reached"' : ''} onclick="transferDropdownAsset('${encodedAssetId}')">Transfer</button>`;
      }
    } else {
      if (isReturnedOffice) {
        statusHtml = '<span class="asset-badge status-deployed">Return to Office</span>';
        actionHtml = `<button class="btn btn-warning btn-sm" onclick="undoReturnOfficeDropdownAsset('${encodedAssetId}')">Undo</button>`;
      } else if (isTransferred) {
        statusHtml = '<span class="asset-badge status-deployed">Transferred</span>';
        actionHtml = `<button class="btn btn-secondary btn-sm" disabled title="This asset has already been transferred">Return</button>`;
      } else {
        actionHtml = `<button class="btn btn-primary btn-sm" ${returnLimitReached ? 'disabled title="Required return quantity reached"' : ''} onclick="returnOfficeDropdownAsset('${encodedAssetId}')">Return</button>`;
      }
    }

    return `
      <div style="display:flex;justify-content:space-between;gap:12px;align-items:center;padding:9px 10px;border-bottom:1px solid #f1f1f1;background:white;">
        <div style="min-width:0;">
          <div style="font-weight:700;color:#333;">${escapeHtml(item.assetId || '')}</div>
          <div style="font-size:12px;color:#666;">${item.serial ? `SN: ${escapeHtml(item.serial)}` : 'No serial'}${item.currentLocation ? ` • ${escapeHtml(item.currentLocation)}` : ''}</div>
        </div>
        <div style="display:flex;gap:8px;align-items:center;white-space:nowrap;">
          ${statusHtml}
          ${actionHtml}
        </div>
      </div>
    `;
  }).join('');
}


function renderTransferCandidatesInPlace() {
  const openDropdowns = getOpenTransferDropdownIds();
  renderTransferCandidates(window.__lastTransferData || {});
  restoreOpenTransferDropdownIds(openDropdowns);
}

function setTransferCachedItemState(assetId, state) {
  const data = window.__lastTransferData || {};
  ['candidates', 'returnToOffice'].forEach(listName => {
    (data[listName] || []).forEach(item => {
      if (String(item.assetId || '') === String(assetId || '')) {
        item.transferState = state || '';
      }
    });
  });
  setTransferActionState(assetId, state);
}

function adjustTransferCandidateRequirement(assetId, remainingDelta, preparedDelta) {
  const data = window.__lastTransferData || {};
  const sourceItem = (data.candidates || []).find(item => String(item.assetId || '') === String(assetId || ''));
  if (!sourceItem) return;
  const key = transferAssetTypeKey(sourceItem);

  (data.candidates || []).forEach(item => {
    if (transferAssetTypeKey(item) !== key) return;
    const remaining = Math.max(
      0,
      Number(item.targetRemainingBeforeThisAsset ?? item.targetRemaining ?? 0) + remainingDelta
    );
    item.targetRemainingBeforeThisAsset = remaining;
    item.targetRemaining = remaining;
    item.targetPrepared = Math.max(0, Number(item.targetPrepared || 0) + preparedDelta);
  });
}

function updateTransferSummaryAfterMove(direction, responseData = null) {
  const data = window.__lastTransferData || {};
  if (responseData?.fromEvent) {
    data.fromEvent = { ...(data.fromEvent || {}), ...responseData.fromEvent };
    transferUpdateCachedEventSummary(data.fromEvent);
  } else if (data.fromEvent) {
    data.fromEvent.unreturnedCount = Math.max(0, Number(data.fromEvent.unreturnedCount || 0) - direction);
    transferUpdateCachedEventSummary(data.fromEvent);
  }
  if (responseData?.toEvent) {
    data.toEvent = { ...(data.toEvent || {}), ...responseData.toEvent };
    transferUpdateCachedEventSummary(data.toEvent);
  }
}

async function transferDropdownAsset(encodedAssetId) {
  const assetId = decodeURIComponent(encodedAssetId);
  const fromEventId = document.getElementById('transferSourceSelect')?.value;
  const toEventId = document.getElementById('transferTargetSelect')?.value;
  if (!fromEventId || !toEventId || !assetId || !beginTransferPendingAction(assetId, 'transfer')) return;
  renderTransferCandidatesInPlace();
  try {
    const response = await apiCall('/api/transfers/execute', 'POST', {
      fromEventId: Number(fromEventId),
      toEventId: Number(toEventId),
      toSubprojectId: transferSelectedTargetSubproject()?.id || '',
      assetIds: [assetId]
    });
    setTransferCachedItemState(assetId, 'transferred');
    adjustTransferCandidateRequirement(assetId, -1, 1);
    updateTransferSummaryAfterMove(1, response.data);
    showNotification('success', `${assetId} transferred`);
  } catch (error) {
    showNotification('error', `Failed to transfer ${assetId}: ${error.message}`);
  } finally {
    endTransferPendingAction(assetId);
    renderTransferCandidatesInPlace();
  }
}

async function undoTransferDropdownAsset(encodedAssetId) {
  const assetId = decodeURIComponent(encodedAssetId);
  const fromEventId = document.getElementById('transferSourceSelect')?.value;
  const toEventId = document.getElementById('transferTargetSelect')?.value;
  if (!fromEventId || !toEventId || !assetId || !beginTransferPendingAction(assetId, 'undoTransfer')) return;
  renderTransferCandidatesInPlace();
  try {
    await apiCall('/api/transfers/undo', 'POST', { fromEventId: Number(fromEventId), toEventId: Number(toEventId), assetIds: [assetId] });
    setTransferCachedItemState(assetId, '');
    adjustTransferCandidateRequirement(assetId, 1, -1);
    updateTransferSummaryAfterMove(-1);
    showNotification('success', `${assetId} transfer undone`);
  } catch (error) {
    showNotification('error', `Failed to undo transfer for ${assetId}: ${error.message}`);
  } finally {
    endTransferPendingAction(assetId);
    renderTransferCandidatesInPlace();
  }
}

async function returnOfficeDropdownAsset(encodedAssetId) {
  const assetId = decodeURIComponent(encodedAssetId);
  const fromEventId = document.getElementById('transferSourceSelect')?.value;
  if (!fromEventId || !assetId || !beginTransferPendingAction(assetId, 'returnOffice')) return;
  renderTransferCandidatesInPlace();
  try {
    await apiCall('/api/transfers/return-office', 'POST', { fromEventId: Number(fromEventId), assetIds: [assetId] });
    setTransferCachedItemState(assetId, 'returnedOffice');
    updateTransferSummaryAfterMove(1);
    showNotification('success', `${assetId} marked to return to office`);
  } catch (error) {
    showNotification('error', `Failed to return ${assetId}: ${error.message}`);
  } finally {
    endTransferPendingAction(assetId);
    renderTransferCandidatesInPlace();
  }
}

async function undoReturnOfficeDropdownAsset(encodedAssetId) {
  const assetId = decodeURIComponent(encodedAssetId);
  const fromEventId = document.getElementById('transferSourceSelect')?.value;
  if (!fromEventId || !assetId || !beginTransferPendingAction(assetId, 'undoReturnOffice')) return;
  renderTransferCandidatesInPlace();
  try {
    await apiCall('/api/transfers/undo-return-office', 'POST', { fromEventId: Number(fromEventId), assetIds: [assetId] });
    setTransferCachedItemState(assetId, '');
    updateTransferSummaryAfterMove(-1);
    showNotification('success', `${assetId} return-to-office undone`);
  } catch (error) {
    showNotification('error', `Failed to undo return for ${assetId}: ${error.message}`);
  } finally {
    endTransferPendingAction(assetId);
    renderTransferCandidatesInPlace();
  }
}

async function executeSelectedTransfers() {
  const assetIds = Array.from(getTransferSelections('transfer'));
  const fromEventId = document.getElementById('transferSourceSelect')?.value;
  const toEventId = document.getElementById('transferTargetSelect')?.value;
  if (!fromEventId || !toEventId || !assetIds.length) return;

  assetIds.forEach(assetId => beginTransferPendingAction(assetId, 'transfer'));
  renderTransferCandidatesInPlace();
  try {
    const response = await apiCall('/api/transfers/execute', 'POST', {
      fromEventId: Number(fromEventId),
      toEventId: Number(toEventId),
      toSubprojectId: transferSelectedTargetSubproject()?.id || '',
      assetIds
    });
    getTransferSelections('transfer').clear();
    const transferred = response.data?.transferred?.length || assetIds.length;
    const skipped = response.data?.skipped?.length || 0;
    showNotification(skipped ? 'warning' : 'success', `${transferred} exact asset${transferred === 1 ? '' : 's'} transferred${skipped ? `; ${skipped} skipped` : ''}`);
    await loadTransferCandidates({ quiet: true });
  } catch (error) {
    showNotification('error', `Transfer failed: ${error.message}`);
  } finally {
    assetIds.forEach(assetId => endTransferPendingAction(assetId));
    renderTransferCandidatesInPlace();
  }
}

async function executeSelectedReturns() {
  const assetIds = Array.from(getTransferSelections('returnOffice'));
  const fromEventId = document.getElementById('transferSourceSelect')?.value;
  if (!fromEventId || !assetIds.length) return;

  assetIds.forEach(assetId => beginTransferPendingAction(assetId, 'returnOffice'));
  renderTransferCandidatesInPlace();
  try {
    const response = await apiCall('/api/transfers/return-office', 'POST', {
      fromEventId: Number(fromEventId),
      assetIds
    });
    getTransferSelections('returnOffice').clear();
    const returned = response.data?.returned?.length || assetIds.length;
    const skipped = response.data?.skipped?.length || 0;
    showNotification(skipped ? 'warning' : 'success', `${returned} exact asset${returned === 1 ? '' : 's'} returned to office${skipped ? `; ${skipped} skipped` : ''}`);
    await loadTransferCandidates({ quiet: true });
  } catch (error) {
    showNotification('error', `Return failed: ${error.message}`);
  } finally {
    assetIds.forEach(assetId => endTransferPendingAction(assetId));
    renderTransferCandidatesInPlace();
  }
}

async function executeSelectedOfficePrepares() {
  const assetIds = Array.from(getTransferSelections('officePrepare'));
  const toEventId = document.getElementById('transferTargetSelect')?.value;
  if (!toEventId || !assetIds.length) return;

  assetIds.forEach(assetId => beginTransferPendingAction(assetId, 'officePrepare'));
  renderTransferCandidatesInPlace();

  const prepared = [];
  const failed = [];
  try {
    for (const assetId of assetIds) {
      try {
        await apiCall(`/api/events/${toEventId}/prepare`, 'POST', {
          assetId,
          subprojectId: transferSelectedTargetSubproject()?.id || ''
        });
        prepared.push(assetId);
      } catch (error) {
        failed.push({ assetId, error });
      }
    }

    getTransferSelections('officePrepare').clear();
    if (prepared.length) {
      showNotification(
        failed.length ? 'warning' : 'success',
        `${prepared.length} office asset${prepared.length === 1 ? '' : 's'} prepared${failed.length ? `; ${failed.length} failed` : ''}`
      );
    } else if (failed.length) {
      showNotification('error', `No office assets were prepared; ${failed.length} failed`);
    }

    await loadTransferCandidates({ quiet: true });
  } catch (error) {
    showNotification('error', `Prepare from office failed: ${error.message || error}`);
  } finally {
    assetIds.forEach(assetId => endTransferPendingAction(assetId));
    renderTransferCandidatesInPlace();
  }
}

// Transfer assets needed from office for the destination event.
var transferNeededFromOfficeCache = [];

function transferModeMeta(mode) {
  const normalized = mode === 'return-office' || mode === 'office-needed' ? mode : 'common';
  if (normalized === 'return-office') {
    return {
      mode: normalized,
      title: 'RETURN TO OFFICE ASSETS',
      numberPrefix: 'RTO',
      qtyNoun: 'asset(s) to return',
      emptyText: 'There are no excess source-event asset types that should go back to office.',
      buttonLabel: 'Not Common / Return to Office',
      doneSuffix: 'marked to return'
    };
  }
  if (normalized === 'office-needed') {
    return {
      mode: normalized,
      title: 'NEEDED FROM OFFICE',
      numberPrefix: 'NFO',
      qtyNoun: 'asset(s) needed from office',
      emptyText: 'The destination event can be completed using what is already prepared and what can transfer from the source event.',
      buttonLabel: 'Needed from Office',
      doneSuffix: 'needed from office'
    };
  }
  return {
    mode: 'common',
    title: 'TRANSFER ASSETS',
    numberPrefix: 'TR',
    qtyNoun: 'asset(s) to transfer',
    emptyText: 'There are no unreturned source asset types that match the destination event’s remaining model requirements.',
    buttonLabel: 'Common / Transferable',
    doneSuffix: 'transferred'
  };
}

function setTransferPanelMode(mode) {
  transferPanelMode = transferModeMeta(mode).mode;
  renderTransferCandidates(window.__lastTransferData || {});
}

async function loadTransferCandidates(options = {}) {
  const sourceSelect = document.getElementById('transferSourceSelect');
  const targetSelect = document.getElementById('transferTargetSelect');
  const panel = document.getElementById('transfer-candidates-panel');
  if (!sourceSelect || !targetSelect || !panel) return;

  const fromEventId = sourceSelect.value;
  const toEventId = targetSelect.value;
  const toSubprojectId = transferSelectedTargetSubproject()?.id || '';
  const pairKey = `${fromEventId || ''}|${toEventId || ''}|${toSubprojectId}`;
  const pairChanged = window.__lastTransferPairKey !== pairKey;
  const openDropdowns = pairChanged
    ? []
    : (options.openDropdowns || getOpenTransferDropdownIds());

  if (pairChanged) {
    resetTransferActionState();
    window.__lastTransferPairKey = pairKey;
  }

  if (!fromEventId || !toEventId) {
    panel.innerHTML = '<p style="text-align:center;color:#666;padding:28px;">Choose both events to compare transferable assets, return-to-office assets, and what is still needed from office.</p>';
    return;
  }
  if (fromEventId === toEventId) {
    panel.innerHTML = '<p style="text-align:center;color:#a00;padding:28px;">Source and destination events cannot be the same.</p>';
    return;
  }

  if (!options.quiet) {
    panel.innerHTML = '<div class="loading">Comparing events...</div>';
  }

  try {
    const response = await apiCall(
      `/api/transfers/candidates?fromEventId=${encodeURIComponent(fromEventId)}` +
      `&toEventId=${encodeURIComponent(toEventId)}` +
      `&toSubprojectId=${encodeURIComponent(toSubprojectId)}`
    );
    transferUpdateCachedEventSummary(response.data?.fromEvent);
    transferUpdateCachedEventSummary(response.data?.toEvent);
    transferCandidateCache = response.data?.candidates || [];
    transferReturnToOfficeCache = response.data?.returnToOffice || [];
    transferNeededFromOfficeCache = response.data?.neededFromOffice || [];
    renderTransferCandidates(response.data || {});
    setTimeout(() => restoreOpenTransferDropdownIds(openDropdowns), 50);
    setTimeout(() => restoreOpenTransferDropdownIds(openDropdowns), 200);
  } catch (error) {
    panel.innerHTML = `<div style="padding:28px;text-align:center;color:#a00;">Failed to compare events: ${escapeHtml(error.message || String(error))}</div>`;
  }
}

function getTransferListForMode(mode, data = {}) {
  const normalized = transferModeMeta(mode).mode;
  if (normalized === 'return-office') {
    return (data.returnToOffice || transferReturnToOfficeCache || [])
      .filter(item => getTransferItemState(item) !== 'transferred');
  }
  if (normalized === 'office-needed') return data.neededFromOffice || transferNeededFromOfficeCache || [];
  return data.candidates || transferCandidateCache || [];
}

function buildTransferGroups(items, mode) {
  const normalizedMode = transferModeMeta(mode).mode;
  const map = new Map();

  (items || []).forEach(item => {
    const key = transferAssetTypeKey(item);
    if (!map.has(key)) {
      const remaining = Math.max(0, Number(item.targetRemainingBeforeThisAsset || item.targetRemaining || 0));
      map.set(key, {
        key,
        mode: normalizedMode,
        department: normalizeDepartmentCode(item.department || 'UN'),
        brand: item.brand || '',
        model: item.model || '',
        description: item.description || '',
        reason: item.reason || '',
        targetRequired: Number(item.targetRequired || 0),
        targetPrepared: Number(item.targetPrepared || 0),
        targetRemaining: remaining,
        returnQuantity: Number(item.returnQuantity || 0),
        officeQuantity: Number(item.officeQuantity || 0),
        sourceQuantity: Number(item.sourceQuantity || 0),
        officeCandidates: [],
        items: []
      });
    }

    const group = map.get(key);
    group.items.push(item);
    (item.officeCandidates || []).forEach(candidate => {
      const candidateId = String(candidate?.assetId || candidate?.id || '');
      if (candidateId && !group.officeCandidates.some(existing => String(existing.assetId || existing.id || '') === candidateId)) {
        group.officeCandidates.push(candidate);
      }
    });
    group.targetRemaining = Math.max(group.targetRemaining || 0, Number(item.targetRemainingBeforeThisAsset || item.targetRemaining || 0));
    group.targetRequired = Math.max(group.targetRequired || 0, Number(item.targetRequired || 0));
    group.targetPrepared = Math.max(group.targetPrepared || 0, Number(item.targetPrepared || 0));
    group.returnQuantity = Math.max(group.returnQuantity || 0, Number(item.returnQuantity || 0));
    group.officeQuantity = Math.max(group.officeQuantity || 0, Number(item.officeQuantity || 0));
    group.sourceQuantity = Math.max(group.sourceQuantity || 0, Number(item.sourceQuantity || 0));
    if (item.reason && !group.reason) group.reason = item.reason;
  });

  const groups = Array.from(map.values()).map(group => {
    group.items.sort((a, b) => String(a.assetId || '').localeCompare(String(b.assetId || ''), undefined, { numeric: true, sensitivity: 'base' }));

    if (normalizedMode === 'common') {
      group.doneQty = group.items.filter(item => getTransferItemState(item) === 'transferred').length;
      group.pendingQty = group.items.filter(item => getTransferPendingAction(item.assetId) === 'transfer').length;
      const currentRemaining = Math.max(0, Number(group.targetRemaining || 0));
      const totalNeededForThisComparison = group.doneQty + currentRemaining;
      group.actionQty = Math.min(group.items.length, Math.max(group.doneQty, totalNeededForThisComparison, group.doneQty ? group.doneQty : 1));
      group.progressLabel = `${group.doneQty}/${group.actionQty} transferred${group.pendingQty ? ` (${group.pendingQty} pending)` : ''}`;
      group.helpText = `${group.items.length} source option(s) available${currentRemaining ? `; destination still needs ${currentRemaining}` : ''}.`;
    } else if (normalizedMode === 'return-office') {
      const returnQty = group.returnQuantity > 0 ? group.returnQuantity : group.items.length;
      group.doneQty = group.items.filter(item => getTransferItemState(item) === 'returnedOffice').length;
      group.pendingQty = group.items.filter(item => getTransferPendingAction(item.assetId) === 'returnOffice').length;
      group.actionQty = Math.min(group.items.length, Math.max(group.doneQty, returnQty));
      group.progressLabel = `${group.doneQty}/${group.actionQty} marked to return${group.pendingQty ? ` (${group.pendingQty} pending)` : ''}`;
      group.helpText = group.reason || (group.targetRemaining > 0
        ? `Destination needs ${group.targetRemaining}; source has ${group.sourceQuantity || group.items.length}; ${group.actionQty} should return to office.`
        : 'Not required by destination event.');
    } else {
      const officeQty = group.officeQuantity > 0 ? group.officeQuantity : group.items.length;
      group.doneQty = 0;
      group.pendingQty = group.officeCandidates.filter(item => getTransferPendingAction(item.assetId || item.id) === 'officePrepare').length;
      group.actionQty = officeQty;
      group.progressLabel = `${officeQty} needed from office${group.pendingQty ? ` (${group.pendingQty} pending)` : ''}`;
      group.helpText = group.reason || `Destination still needs ${group.targetRemaining}; source can provide ${group.sourceQuantity || 0}; ${officeQty} should be packed from office.`;
      group.officeCandidates.sort((a, b) => String(a.assetId || a.id || '').localeCompare(String(b.assetId || b.id || ''), undefined, { numeric: true, sensitivity: 'base' }));
    }

    return group;
  });

  return groups.sort((a, b) => (
    a.department.localeCompare(b.department, undefined, { numeric: true }) ||
    a.brand.localeCompare(b.brand, undefined, { numeric: true, sensitivity: 'base' }) ||
    a.model.localeCompare(b.model, undefined, { numeric: true, sensitivity: 'base' }) ||
    a.description.localeCompare(b.description, undefined, { numeric: true, sensitivity: 'base' })
  ));
}

function renderTransferModeButtons(data) {
  const commonGroups = buildTransferGroups(getTransferListForMode('common', data), 'common');
  const returnGroups = buildTransferGroups(getTransferListForMode('return-office', data), 'return-office');
  const officeGroups = buildTransferGroups(getTransferListForMode('office-needed', data), 'office-needed');
  const active = transferModeMeta(transferPanelMode).mode;

  const button = (mode, label, count) => `
    <button class="btn btn-${active === mode ? 'primary' : 'secondary'} btn-sm" onclick="setTransferPanelMode('${mode}')">
      ${label} (${count})
    </button>`;

  return `
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px;">
      ${button('common', 'Common / Transferable', commonGroups.length)}
      ${button('return-office', 'Not Common / Return to Office', returnGroups.length)}
      ${button('office-needed', 'Needed from Office', officeGroups.length)}
    </div>
  `;
}

function transferEventDateLabel(event) {
  if (!event?.startDate) return '';
  return event.startDate === event.endDate
    ? formatDate(event.startDate)
    : `${formatDate(event.startDate)} – ${formatDate(event.endDate)}`;
}

function buildTransferSourceGroups(data) {
  const map = new Map();
  const seenIds = new Set();
  [...(data.candidates || []), ...(data.returnToOffice || [])].forEach(item => {
    const assetId = String(item.assetId || '');
    if (!assetId || seenIds.has(assetId)) return;
    seenIds.add(assetId);
    const key = transferAssetTypeKey(item);
    if (!map.has(key)) {
      map.set(key, {
        key,
        department: normalizeDepartmentCode(item.department || 'UN'),
        brand: item.brand || '',
        model: item.model || '',
        description: item.description || '',
        items: []
      });
    }
    map.get(key).items.push(item);
  });
  return Array.from(map.values()).sort((a, b) => (
    a.department.localeCompare(b.department, undefined, { numeric: true }) ||
    transferAssetTypeName(a).localeCompare(transferAssetTypeName(b), undefined, { numeric: true, sensitivity: 'base' })
  ));
}

function renderTransferSourcePanel(data) {
  const groups = buildTransferSourceGroups(data);
  const rows = groups.length ? groups.map(group => `
    <div class="transfer-source-row">
      <div class="transfer-model-line">
        <div>
          <strong>${escapeHtml(transferAssetTypeName(group))}</strong>
          <small>${escapeHtml(group.department)} · ${group.items.length} exact Asset ID${group.items.length === 1 ? '' : 's'}</small>
        </div>
        <span class="transfer-qty">${group.items.length}</span>
      </div>
    </div>
  `).join('') : '<div class="transfer-empty-section">No source assets found.</div>';

  return `
    <section class="transfer-panel transfer-panel-source">
      <div class="transfer-panel-heading">
        <h3>From Event</h3>
        <p>#${escapeHtml(data.fromEvent?.id || '')} · ${escapeHtml(data.fromEvent?.name || '')}<br>${escapeHtml(transferEventDateLabel(data.fromEvent))}</p>
      </div>
      <div>${rows}</div>
    </section>
  `;
}

function renderTransferAssetSelectionRows(group, kind) {
  const selected = getTransferSelections(kind);
  const selectedInGroup = selectedTransferCountForGroup(group, kind);
  const limit = transferGroupSelectionLimit(group);
  const encodedKey = encodeURIComponent(group.key);
  const rowItems = transferSelectableItemsForGroup(group, kind);
  const allSelectable = rowItems.filter(item => !getTransferItemState(item) && !getTransferPendingAction(item.assetId || item.id));
  const allSelected = allSelectable.length > 0 && allSelectable.slice(0, limit).every(item => selected.has(String(item.assetId || item.id || '')));

  const rows = rowItems.map(item => {
    const assetId = String(item.assetId || item.id || '');
    const encodedAssetId = encodeURIComponent(assetId);
    const state = getTransferItemState(item);
    const pendingAction = getTransferPendingAction(assetId);
    const checked = selected.has(assetId);
    const disabled = !!state || !!pendingAction || (!checked && selectedInGroup >= limit);
    let action = '';
    if (state === 'transferred') {
      action = `<button type="button" class="transfer-row-action undo" onclick="undoTransferDropdownAsset('${encodedAssetId}')">Undo transfer</button>`;
    } else if (state === 'returnedOffice') {
      action = `<button type="button" class="transfer-row-action undo" onclick="undoReturnOfficeDropdownAsset('${encodedAssetId}')">Undo return</button>`;
    } else if (pendingAction) {
      action = '<span class="transfer-selection-pill">Updating…</span>';
    } else {
      action = `<span class="transfer-selection-pill">${checked ? 'Selected' : 'Ready'}</span>`;
    }

    return `
      <label class="transfer-id-row">
        <input type="checkbox"
          aria-label="Select Asset ID ${escapeHtml(assetId)}"
          ${checked ? 'checked' : ''}
          ${disabled ? 'disabled' : ''}
          onchange="toggleTransferAssetSelection('${encodedAssetId}', '${kind}', this.checked)">
        <span>
          <strong>${escapeHtml(assetId)}</strong>
          <small>${item.serial ? `Serial: ${escapeHtml(item.serial)}` : 'No serial recorded'}${item.currentLocation ? ` · ${escapeHtml(item.currentLocation)}` : ''}</small>
        </span>
        ${action}
      </label>
    `;
  }).join('');

  return `
    <div class="transfer-id-list">
      <div class="transfer-id-toolbar">
        <span>Select the physical Asset IDs (${selectedInGroup}/${limit})</span>
        ${allSelectable.length ? `<button type="button" onclick="toggleTransferGroupSelection('${encodedKey}', '${kind}')">${allSelected ? 'Clear group' : 'Select required'}</button>` : ''}
      </div>
      ${rows || '<div class="transfer-empty-section">No matching office Asset IDs are currently available.</div>'}
    </div>
  `;
}

function renderTransferDecisionGroup(group, kind, index) {
  const selectedCount = selectedTransferCountForGroup(group, kind);
  const remainingAction = transferGroupSelectionLimit(group);
  const detailsId = transferGroupDetailsId(group);
  const targetNeed = kind === 'officePrepare'
    ? Number(group.actionQty || 0)
    : group.mode === 'return-office'
      ? Number(group.returnQuantity || group.actionQty || 0)
      : Math.max(0, Number(group.targetRemaining || 0));
  const fromQty = kind === 'officePrepare'
    ? Number(group.officeCandidates?.length || 0)
    : Number(group.items?.length || 0);
  const subtitle = kind === 'officePrepare' ? 'choose office Asset IDs' : 'choose exact IDs';
  return `
    <details class="transfer-decision-group" id="${detailsId}">
      <summary class="transfer-decision-summary">
        <span class="transfer-decision-model">
          <strong>${escapeHtml(transferAssetTypeName(group))}</strong>
          <small>${escapeHtml(group.department)} · ${subtitle}</small>
        </span>
        <span class="transfer-number">${fromQty}</span>
        <span class="transfer-number">${targetNeed}</span>
        <span class="transfer-number"><span class="transfer-selection-pill">${selectedCount}/${remainingAction}</span></span>
        <span class="transfer-choose-label">Choose IDs ▾</span>
      </summary>
      ${renderTransferAssetSelectionRows(group, kind)}
    </details>
  `;
}

function renderTransferDecisionSection(title, stepClass, groups, kind, emptyText) {
  const rows = groups.length
    ? groups.map((group, index) => renderTransferDecisionGroup(group, kind, index)).join('')
    : `<div class="transfer-empty-section">${escapeHtml(emptyText)}</div>`;
  return `
    <div class="transfer-decision-section">
      <div class="transfer-decision-title">
        <span class="transfer-step ${stepClass}">${stepClass === 'office' ? '3' : (stepClass === 'return' ? '2' : '1')}</span>
        ${escapeHtml(title)}
      </div>
      ${groups.length ? `
        <div class="transfer-decision-head">
          <span>Asset / Model</span>
          <span>${kind === 'officePrepare' ? 'In office' : 'From out'}</span>
          <span>${kind === 'returnOffice' ? 'Return qty' : (kind === 'officePrepare' ? 'Need qty' : 'To needed')}</span>
          <span>Selected</span>
          <span>Action</span>
        </div>` : ''}
      ${rows}
    </div>
  `;
}

function renderTransferOfficeNeededSection(groups) {
  const rows = groups.length ? groups.map(group => `
    <div class="transfer-decision-summary">
      <span class="transfer-decision-model">
        <strong>${escapeHtml(transferAssetTypeName(group))}</strong>
        <small>${escapeHtml(group.department)}</small>
      </span>
      <span class="transfer-number">${group.sourceQuantity || 0}</span>
      <span class="transfer-number">${group.targetRemaining || 0}</span>
      <span class="transfer-number"><span class="transfer-selection-pill">${group.actionQty}</span></span>
      <span class="transfer-choose-label">Prepare</span>
    </div>
  `).join('') : '<div class="transfer-empty-section">Nothing additional is needed from office.</div>';
  return `
    <div class="transfer-decision-section">
      <div class="transfer-decision-title">
        <span class="transfer-step office">3</span>
        Needed From Office
      </div>
      ${rows}
    </div>
  `;
}

function renderTransferTargetPanel(data, commonGroups) {
  const requirements = data.destinationRequirements || [];
  const selected = getTransferSelections('transfer');
  const selectedByKey = new Map();
  commonGroups.forEach(group => {
    selectedByKey.set(group.key, group.items.filter(item => selected.has(String(item.assetId || ''))).length);
  });

  const rows = requirements.length ? requirements.map(requirement => {
    const key = transferAssetTypeKey(requirement);
    const required = Number(requirement.required || 0);
    const prepared = Number(requirement.prepared || 0);
    const newlySelected = Number(selectedByKey.get(key) || 0);
    const matched = Math.min(required, prepared + newlySelected);
    const stillNeeded = Math.max(0, required - matched);
    const pct = required ? Math.round((matched / required) * 100) : 100;
    return `
      <div class="transfer-target-row">
        <div class="transfer-model-line">
          <div>
            <strong>${escapeHtml(transferAssetTypeName(requirement))}</strong>
            <small>${escapeHtml(requirement.department || 'UN')}</small>
          </div>
          <span class="transfer-qty">${required}</span>
        </div>
        <div class="transfer-match-copy">
          <span>${matched} matched${newlySelected ? ` (${newlySelected} selected)` : ''}</span>
          ${stillNeeded ? `<span class="needed">${stillNeeded} still needed</span>` : ''}
        </div>
        <div class="transfer-progress ${stillNeeded ? 'warning' : ''}"><span style="width:${pct}%"></span></div>
      </div>
    `;
  }).join('') : '<div class="transfer-empty-section">No model requirements found for this event.</div>';

  return `
    <section class="transfer-panel transfer-panel-target">
      <div class="transfer-panel-heading">
        <h3>To Event</h3>
        <p>#${escapeHtml(data.toEvent?.id || '')} · ${escapeHtml(data.toEvent?.name || '')}<br>${escapeHtml(transferEventDateLabel(data.toEvent))}${data.targetSubproject?.name ? `<br>${escapeHtml(data.targetSubproject.name)}` : ''}</p>
      </div>
      <div class="transfer-target-list">${rows}</div>
    </section>
  `;
}

function renderTransferSummarySchematic(data, commonGroups, returnGroups, officeGroups) {
  const directQty = commonGroups.reduce((sum, group) => sum + Number(group.actionQty || 0), 0);
  const returnQty = returnGroups.reduce((sum, group) => sum + Number(group.actionQty || 0), 0);
  const officeQty = officeGroups.reduce((sum, group) => sum + Number(group.actionQty || 0), 0);
  const sourceOut = Number(data.fromEvent?.unreturnedCount || 0);
  const destinationRequired = (data.destinationRequirements || [])
    .reduce((sum, item) => sum + Number(item.required || 0), 0);
  const destinationMatched = (data.destinationRequirements || [])
    .reduce((sum, item) => sum + Math.min(Number(item.required || 0), Number(item.prepared || 0)), 0);
  const destinationNet = Math.max(0, destinationMatched + directQty + officeQty);

  return `
    <section class="transfer-schematic" aria-label="Transfer summary schematic">
      <div class="transfer-schematic-heading">
        <div>
          <h3>Transfer Summary</h3>
          <p>Overview of asset movement between events and office inventory.</p>
        </div>
      </div>
      <div class="transfer-schematic-flow">
        <div class="transfer-schematic-node source">
          <span>Source Event</span>
          <strong>#${escapeHtml(data.fromEvent?.id || '')}</strong>
          <small>${escapeHtml(data.fromEvent?.name || '')}</small>
          <em>${sourceOut} assets out</em>
        </div>
        <div class="transfer-schematic-lanes">
          <div class="transfer-schematic-lane direct">
            <i></i>
            <div><strong>${directQty}</strong><span>Direct Transfer</span><small>to destination</small></div>
            <b>→</b>
          </div>
          <div class="transfer-schematic-lane return">
            <i></i>
            <div><strong>${returnQty}</strong><span>Return To Office</span><small>not needed</small></div>
            <b>→</b>
          </div>
          <div class="transfer-schematic-lane office">
            <i></i>
            <div><strong>${officeQty}</strong><span>Prepare From Office</span><small>still needed</small></div>
            <b>→</b>
          </div>
        </div>
        <div class="transfer-schematic-destinations">
          <div class="transfer-schematic-node destination">
            <span>Destination Event</span>
            <strong>#${escapeHtml(data.toEvent?.id || '')}</strong>
            <small>${escapeHtml(data.toEvent?.name || '')}</small>
            <em>${Math.min(destinationRequired, destinationNet)} / ${destinationRequired} matched</em>
          </div>
          <div class="transfer-schematic-node office">
            <span>Office Inventory</span>
            <strong>${returnQty}</strong>
            <small>asset${returnQty === 1 ? '' : 's'} returning</small>
          </div>
        </div>
      </div>
    </section>
  `;
}

function renderTransferCandidates(data) {
  window.__lastTransferData = data;
  const panel = document.getElementById('transfer-candidates-panel');
  if (!panel) return;

  const commonGroups = buildTransferGroups(getTransferListForMode('common', data), 'common');
  const returnGroups = buildTransferGroups(getTransferListForMode('return-office', data), 'return-office');
  const officeGroups = buildTransferGroups(getTransferListForMode('office-needed', data), 'office-needed');
  const transferSelected = getTransferSelections('transfer').size;
  const returnSelected = getTransferSelections('returnOffice').size;
  const officePrepareSelected = getTransferSelections('officePrepare').size;
  const officeNeeded = officeGroups.reduce((sum, group) => sum + Number(group.actionQty || 0), 0);

  panel.innerHTML = `
    <div class="transfer-board">
      ${renderTransferSourcePanel(data)}
      <section class="transfer-panel">
        <div class="transfer-panel-heading">
          <h3>Transfer Decision</h3>
        </div>
        ${renderTransferDecisionSection('Common / Transferable', '', commonGroups, 'transfer', 'No matching transferable assets.')}
        ${renderTransferDecisionSection('Return To Office', 'return', returnGroups, 'returnOffice', 'No unused source assets need to return.')}
        ${renderTransferDecisionSection('Needed From Office', 'office', officeGroups, 'officePrepare', 'Nothing additional is needed from office.')}
        <div class="transfer-summary-strip">
          <div class="transfer-summary-card"><strong>${transferSelected}</strong><span>selected for direct transfer</span></div>
          <div class="transfer-summary-card"><strong>${returnSelected}</strong><span>selected to return to office</span></div>
          <div class="transfer-summary-card"><strong>${officePrepareSelected}</strong><span>selected to prepare from office</span></div>
        </div>
      </section>
      ${renderTransferTargetPanel(data, commonGroups)}
    </div>
    ${renderTransferSummarySchematic(data, commonGroups, returnGroups, officeGroups)}
    <div class="transfer-action-bar">
      <button type="button" class="transfer-primary-action" onclick="executeSelectedTransfers()" ${transferSelected ? '' : 'disabled'}>
        <span>Transfer Selected (${transferSelected})</span>${transferUiIconSvg('arrow')}
      </button>
      <button type="button" class="transfer-return-action" onclick="executeSelectedReturns()" ${returnSelected ? '' : 'disabled'}>
        ${transferUiIconSvg('return')}<span>Return Selected (${returnSelected})</span>
      </button>
      <button type="button" class="transfer-office-action" onclick="executeSelectedOfficePrepares()" ${officePrepareSelected ? '' : 'disabled'}>
        ${transferUiIconSvg('prepare')}<span>Prepare Selected (${officePrepareSelected})</span>
      </button>
      <button type="button" class="transfer-export-action" onclick="openTransferPdfExportDialog()">${transferUiIconSvg('export')}<span>Export PDF</span></button>
    </div>
  `;
}

var transferPdfExportModes = new Set(['common']);

function transferPdfExportOptions(data = window.__lastTransferData || {}) {
  return [
    { mode: 'common', label: 'Common / Transferable', tone: 'common' },
    { mode: 'return-office', label: 'Uncommon / Return to Office', tone: 'return' },
    { mode: 'office-needed', label: 'Needed From Office', tone: 'office' }
  ].map(option => {
    const groups = buildTransferGroups(
      getTransferListForMode(option.mode, data),
      option.mode
    );
    return {
      ...option,
      groups,
      typeCount: groups.length,
      quantity: groups.reduce(
        (sum, group) => sum + Number(group.actionQty || 0),
        0
      )
    };
  });
}

function ensureTransferPdfExportDialog() {
  if (document.getElementById('transferPdfExportModal')) return;
  document.body.insertAdjacentHTML('beforeend', `
    <div id="transferPdfExportModal" class="modal">
      <div class="modal-content transfer-export-dialog" role="dialog" aria-modal="true" aria-labelledby="transferPdfExportTitle">
        <div class="modal-header">
          <div>
            <h3 id="transferPdfExportTitle">Export Transfer PDF</h3>
            <span>PDF contents</span>
          </div>
          <button type="button" class="close-btn" aria-label="Close" onclick="closeModal('transferPdfExportModal')">&times;</button>
        </div>
        <div id="transferPdfExportOptions" class="transfer-export-options"></div>
        <div id="transferPdfExportError" class="transfer-export-error" role="alert"></div>
        <div class="modal-actions transfer-export-dialog-actions">
          <button type="button" class="btn btn-secondary" onclick="closeModal('transferPdfExportModal')">Cancel</button>
          <button type="button" class="btn btn-primary" onclick="exportSelectedTransferPdf()">Create PDF</button>
        </div>
      </div>
    </div>
  `);
}

function renderTransferPdfExportOptions() {
  const container = document.getElementById('transferPdfExportOptions');
  if (!container) return;
  container.innerHTML = transferPdfExportOptions().map(option => `
    <label class="transfer-export-option is-${option.tone}">
      <input type="checkbox" value="${option.mode}"
        ${transferPdfExportModes.has(option.mode) ? 'checked' : ''}
        onchange="toggleTransferPdfExportMode(this)">
      <span class="transfer-export-option-mark" aria-hidden="true"></span>
      <span class="transfer-export-option-copy">
        <strong>${escapeHtml(option.label)}</strong>
        <small>${option.typeCount} asset type${option.typeCount === 1 ? '' : 's'} &middot; ${option.quantity} asset${option.quantity === 1 ? '' : 's'}</small>
      </span>
    </label>
  `).join('');
}

function openTransferPdfExportDialog() {
  const fromEventId = document.getElementById('transferSourceSelect')?.value;
  const toEventId = document.getElementById('transferTargetSelect')?.value;
  if (!fromEventId || !toEventId) {
    showNotification('warning', 'Select both source and destination events first');
    return;
  }
  ensureTransferPdfExportDialog();
  if (!transferPdfExportModes.size) transferPdfExportModes.add('common');
  document.getElementById('transferPdfExportError').textContent = '';
  renderTransferPdfExportOptions();
  openModal('transferPdfExportModal');
}

function toggleTransferPdfExportMode(input) {
  if (input.checked) transferPdfExportModes.add(input.value);
  else transferPdfExportModes.delete(input.value);
  document.getElementById('transferPdfExportError').textContent = '';
}

async function exportSelectedTransferPdf() {
  if (!transferPdfExportModes.size) {
    document.getElementById('transferPdfExportError').textContent = 'Select at least one section.';
    return;
  }
  const modes = Array.from(transferPdfExportModes);
  closeModal('transferPdfExportModal');
  await generateTransferPdf(modes);
}

function groupedTransferPdfRows(groups) {
  if (!groups.length) {
    return '<tr><td colspan="5" style="text-align:center;color:#666;padding:18px;">No asset types in this view.</td></tr>';
  }

  return groups.map((group, index) => transferPdfRowHtml(group, index + 1)).join('');
}

const TRANSFER_PDF_COLGROUP = `
  <col style="width:8mm;">
  <col style="width:16mm;">
  <col style="width:20mm;">
  <col style="width:54mm;">
  <col>
`;

function transferPdfTableHead() {
  return `
    ${TRANSFER_PDF_COLGROUP}
    <thead>
      <tr>
        <th>#</th>
        <th>Qty</th>
        <th>Dept</th>
        <th>Brand / Model</th>
        <th>Description</th>
      </tr>
    </thead>
  `;
}

function transferPdfRowHtml(group, rowNumber) {
  return `
    <tr>
      <td>${rowNumber}</td>
      <td>${escapeHtml(String(group.actionQty || 0))}</td>
      <td>${escapeHtml(group.department || 'UN')}</td>
      <td>${escapeHtml(`${group.brand || ''} ${group.model || ''}`.trim())}</td>
      <td>${escapeHtml(group.description || '')}</td>
    </tr>
  `;
}

function buildLegacyTransferPdfPages(groups, context) {
  const safe = (value) => escapeHtml(String(value ?? ''));
  const logoRowHtml = renderPdfLogoRowHtml();
  const footerHtml = renderPdfFooterHtml();

  const fromDate = context.fromDateRange ? ` | ${safe(context.fromDateRange)}` : '';
  const toDate = context.toDateRange ? ` | ${safe(context.toDateRange)}` : '';

  const headerHtml = `
    ${logoRowHtml}
    <div class="header">
      <div class="header-left">
        FROM EVENT:<br>
        ${safe(context.fromEvent.id || context.fromEventId)} - ${safe(context.fromEvent.name || '')}<br>
        ${safe(context.fromEvent.state || '')}${fromDate}<br><br>
        TO EVENT:<br>
        ${safe(context.toEvent.id || context.toEventId)} - ${safe(context.toEvent.name || '')}<br>
        ${safe(context.toEvent.state || '')}${toDate}
      </div>
      <div class="header-right">
        <div class="transfer-title">${safe(context.title)}</div>
        No. : ${safe(context.transferNumber)}<br>
        Date : ${safe(context.formattedDate)}
      </div>
    </div>
  `;

  const summaryHtml = `
    <table class="summary-table">
      <tr>
        <td><strong>Source unreturned assets:</strong><br>${safe(context.fromEvent.unreturnedCount || 0)}</td>
        <td><strong>Asset type count:</strong><br>${safe(groups.length)}</td>
        <td><strong>Total quantity:</strong><br>${safe(context.totalQty)}</td>
      </tr>
    </table>
  `;

  const emptyRow = '<tr><td colspan="5" style="text-align:center;color:#666;padding:18px;">No asset types in this view.</td></tr>';
  const rowRecords = groups.length
    ? groups.map((group, index) => ({ html: transferPdfRowHtml(group, index + 1), height: 0 }))
    : [{ html: emptyRow, height: 0 }];

  const measureBox = document.createElement('div');
  measureBox.id = '__transferMeasureBox';
  measureBox.style.cssText = `
    position:absolute;
    left:-10000px;
    top:0;
    visibility:hidden;
    width:196mm;
    font-family:${PDF_EXPORT_FONT_FAMILY};
    font-size:8.5pt;
    line-height:1.25;
    background:white;
    z-index:-1;
  `;

  measureBox.innerHTML = `
    <style>
      #__transferMeasureBox * { box-sizing: border-box; }
      #__transferMeasureBox .logo-row { display:flex; justify-content:flex-end; margin-bottom:7px; height:39px; }
      #__transferMeasureBox .logo-row img { height:39px; width:auto; object-fit:contain; }
      #__transferMeasureBox .header { display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:20px; }
      #__transferMeasureBox .header-left { flex:1; font-size:9pt; font-weight:bold; line-height:1.35; }
      #__transferMeasureBox .header-right { text-align:right; font-size:9pt; font-weight:bold; }
      #__transferMeasureBox .transfer-title { font-size:14pt; font-weight:bold; margin-bottom:5px; }
      #__transferMeasureBox .summary-table,
      #__transferMeasureBox .items-table { width:100%; border-collapse:collapse; border:2px solid black; table-layout:fixed; }
      #__transferMeasureBox .summary-table { margin-bottom:16px; }
      #__transferMeasureBox .items-table { margin-bottom:0; }
      #__transferMeasureBox .summary-table td { border:1px solid #333; padding:7px; font-size:9pt; vertical-align:top; }
      #__transferMeasureBox .items-table th { background:#333; color:white; padding:8px; text-align:left; font-size:8.5pt; border:1px solid #333; }
      #__transferMeasureBox .items-table td { border:1px solid #333; padding:6px; font-size:8.5pt; vertical-align:top; line-height:1.25; word-break:break-word; overflow-wrap:anywhere; }
      #__transferMeasureBox .footer-measure { width:100%; text-align:center; font-size:7pt; font-weight:bold; line-height:1.2; overflow-wrap:anywhere; }
    </style>
    <div id="__transferFirstBase">
      ${headerHtml}
      ${summaryHtml}
      <table class="items-table">${transferPdfTableHead()}</table>
    </div>
    <div id="__transferNextBase">
      ${headerHtml}
      <table class="items-table">${transferPdfTableHead()}</table>
    </div>
    <table class="items-table">
      ${TRANSFER_PDF_COLGROUP}
      <tbody id="__transferMeasureBody"></tbody>
    </table>
    <div id="__transferFooterMeasure" class="footer-measure">${footerHtml}</div>
  `;

  const normaliseMeasuredHeight = mountPdfMeasureBox(measureBox, 196);

  const measureBody = measureBox.querySelector('#__transferMeasureBody');
  const firstBaseHeight = normaliseMeasuredHeight(
    measureBox.querySelector('#__transferFirstBase').getBoundingClientRect().height
  );
  const nextBaseHeight = normaliseMeasuredHeight(
    measureBox.querySelector('#__transferNextBase').getBoundingClientRect().height
  );
  const footerHeight = normaliseMeasuredHeight(
    measureBox.querySelector('#__transferFooterMeasure')?.getBoundingClientRect().height || 0
  );
  const pageFlowHeightMm = 276;
  const footerReserveMm = pdfFooterReserveMm({ pageFlowHeightMm }, footerHeight);
  const firstPageBudget = Math.max(40, pdfMmToPx(pageFlowHeightMm - footerReserveMm) - firstBaseHeight);
  const nextPageBudget = Math.max(40, pdfMmToPx(pageFlowHeightMm - footerReserveMm) - nextBaseHeight);

  function measureRow(rowHtml) {
    measureBody.innerHTML = rowHtml;
    const row = measureBody.querySelector('tr');
    return row ? normaliseMeasuredHeight(row.getBoundingClientRect().height) : 0;
  }

  rowRecords.forEach(record => {
    record.height = measureRow(record.html);
  });

  measureBox.remove();

  const pages = [];
  let index = 0;

  while (index < rowRecords.length) {
    const isFirstPage = pages.length === 0;
    const budget = isFirstPage ? firstPageBudget : nextPageBudget;
    const pageRows = [];
    let pageHeight = 0;

    while (index < rowRecords.length) {
      const record = rowRecords[index];

      if (pageRows.length > 0 && pageHeight + record.height > budget) {
        break;
      }

      pageRows.push(record);
      pageHeight += record.height;
      index++;

      if (pageRows.length === 1 && record.height > budget) {
        break;
      }
    }

    pages.push({
      includeSummary: isFirstPage,
      rows: pageRows
    });
  }

  const totalPages = pages.length;

  return pages.map((page, pageIndex) => `
    <div class="page">
      ${headerHtml}
      ${page.includeSummary ? summaryHtml : ''}
      <table class="items-table">
        ${transferPdfTableHead()}
        <tbody>
          ${page.rows.map(row => row.html).join('')}
        </tbody>
      </table>
      <div class="footer">${footerHtml}</div>
      <div class="page-number">Page ${pageIndex + 1} of ${totalPages}</div>
    </div>
  `).join('');
}

function transferPdfTextColor(background) {
  const match = String(background || '').match(/^#([0-9a-f]{6})$/i);
  if (!match) return '#ffffff';
  const value = match[1];
  const red = parseInt(value.slice(0, 2), 16);
  const green = parseInt(value.slice(2, 4), 16);
  const blue = parseInt(value.slice(4, 6), 16);
  return ((red * 299 + green * 587 + blue * 114) / 1000) > 158
    ? '#172033'
    : '#ffffff';
}

function transferPdfSectionHeadingHtml(section) {
  return `<tr class="transfer-section-row"><td colspan="5">${escapeHtml(section.label)}</td></tr>`;
}

function transferPdfReportRows(sections) {
  let rowNumber = 0;
  return sections.flatMap(section => {
    const rows = [{
      kind: 'heading',
      html: transferPdfSectionHeadingHtml(section),
      height: 0
    }];
    if (!section.groups.length) {
      rows.push({
        kind: 'empty',
        html: '<tr><td colspan="5" class="transfer-empty-row">No assets in this section.</td></tr>',
        height: 0
      });
      return rows;
    }
    section.groups.forEach(group => {
      rowNumber += 1;
      rows.push({
        kind: 'item',
        html: transferPdfRowHtml(group, rowNumber),
        height: 0
      });
    });
    return rows;
  });
}

function buildTransferPdfPagesV2(sections, context) {
  const safe = value => escapeHtml(String(value ?? ''));
  const logoHtml = renderPdfLogoRowHtml('transfer-report-logo');
  const footerHtml = renderPdfFooterHtml();
  const themeColor = /^#[0-9a-f]{6}$/i.test(context.themeColor || '')
    ? context.themeColor
    : '#0f766e';
  const themeText = transferPdfTextColor(themeColor);
  const eventMeta = event => [
    transferEventDateLabel(event),
    event.location || event.venue || '',
    eventStateDisplayLabel(event.state || '')
  ].filter(Boolean).map(safe).join(' &middot; ');

  const showLetterheadText = pdfSettings?.letterheadEnabled !== false;
  const letterheadHtml = (showLetterheadText || logoHtml) ? `
    <div class="transfer-report-letterhead">
      ${showLetterheadText ? `<div>
        <strong>${safe(context.companyName || 'Showbase')}</strong>
        <span>Asset Operations</span>
      </div>` : '<div></div>'}
      ${logoHtml}
    </div>
  ` : '';
  const reportHeaderHtml = `
    ${letterheadHtml}
    <div class="transfer-report-header">
      <div>
        <span class="transfer-report-kicker">OPERATIONS REPORT</span>
        <div class="transfer-report-title">ASSET TRANSFER REPORT</div>
      </div>
      <div class="transfer-report-generated">
        <span>Generated by</span><strong>${safe(context.generatedBy || '-')}</strong>
        <span>Generated on</span><strong>${safe(context.generatedAt)}</strong>
      </div>
    </div>
    <div class="transfer-report-route">
      <div class="transfer-report-event from">
        <span>FROM EVENT</span>
        <strong>#${safe(context.fromEvent.id || context.fromEventId)} ${safe(context.fromEvent.name || '')}</strong>
        <small>${eventMeta(context.fromEvent)}</small>
      </div>
      <div class="transfer-report-arrow" aria-hidden="true">&rarr;</div>
      <div class="transfer-report-event to">
        <span>TO EVENT</span>
        <strong>#${safe(context.toEvent.id || context.toEventId)} ${safe(context.toEvent.name || '')}</strong>
        <small>${eventMeta(context.toEvent)}${context.targetSubproject?.name ? ` &middot; ${safe(context.targetSubproject.name)}` : ''}</small>
      </div>
    </div>
  `;
  const summaryHtml = `
    <div class="transfer-report-summary">
      <div><span>Included</span><strong>${sections.map(section => safe(section.label)).join(', ')}</strong></div>
      <div><span>Asset types</span><strong>${safe(context.totalTypes)}</strong></div>
      <div><span>Total quantity</span><strong>${safe(context.totalQty)}</strong></div>
    </div>
  `;

  const rowRecords = transferPdfReportRows(sections);
  const measureBox = document.createElement('div');
  measureBox.id = '__transferReportMeasureBox';
  measureBox.style.cssText = `position:absolute;left:-10000px;top:0;visibility:hidden;width:196mm;
    font-family:${PDF_EXPORT_FONT_FAMILY};font-size:8pt;line-height:1.3;background:#fff;z-index:-1;`;
  measureBox.innerHTML = `
    <style>
      #__transferReportMeasureBox *{box-sizing:border-box}
      #__transferReportMeasureBox .transfer-report-letterhead{display:flex;align-items:center;justify-content:space-between;min-height:34px;margin-bottom:6px;border-bottom:1px solid #dbe5e3;padding-bottom:6px}
      #__transferReportMeasureBox .transfer-report-letterhead strong{display:block;color:${themeColor};font-size:13pt}
      #__transferReportMeasureBox .transfer-report-letterhead span{display:block;margin-top:1px;color:#65736f;font-size:7pt;text-transform:uppercase}
      #__transferReportMeasureBox .transfer-report-logo{height:32px}.transfer-report-logo img{max-height:32px;max-width:62mm;object-fit:contain}
      #__transferReportMeasureBox .transfer-report-header{display:flex;justify-content:space-between;gap:16px;align-items:flex-end;margin:8px 0 10px}
      #__transferReportMeasureBox .transfer-report-kicker{color:#667085;font-size:7pt;font-weight:700}
      #__transferReportMeasureBox .transfer-report-title{margin-top:2px;color:#172033;font-size:15pt;font-weight:800}
      #__transferReportMeasureBox .transfer-report-generated{display:grid;grid-template-columns:auto auto;gap:2px 8px;text-align:right;font-size:7.5pt}
      #__transferReportMeasureBox .transfer-report-generated span{color:#667085}.transfer-report-generated strong{color:#172033}
      #__transferReportMeasureBox .transfer-report-route{display:grid;grid-template-columns:minmax(0,1fr) 12mm minmax(0,1fr);gap:5px;align-items:stretch;margin-bottom:10px}
      #__transferReportMeasureBox .transfer-report-event{border:1px solid #dce6e4;border-radius:5px;background:#f8fbfa;padding:7px 9px}
      #__transferReportMeasureBox .transfer-report-event.to{border-color:${themeColor};background:${themeColor}12}
      #__transferReportMeasureBox .transfer-report-event span{display:block;color:#667085;font-size:6.8pt;font-weight:800}
      #__transferReportMeasureBox .transfer-report-event strong{display:block;margin-top:3px;color:#172033;font-size:9pt}
      #__transferReportMeasureBox .transfer-report-event small{display:block;margin-top:3px;color:#667085;font-size:7pt}
      #__transferReportMeasureBox .transfer-report-arrow{display:grid;place-items:center;color:${themeColor};font-size:18pt;font-weight:800}
      #__transferReportMeasureBox .transfer-report-summary{display:grid;grid-template-columns:minmax(0,1fr) 25mm 27mm;margin-bottom:10px;border:1px solid #dce6e4;border-radius:5px;overflow:hidden}
      #__transferReportMeasureBox .transfer-report-summary>div{padding:6px 8px;border-right:1px solid #dce6e4}.transfer-report-summary>div:last-child{border-right:0}
      #__transferReportMeasureBox .transfer-report-summary span{display:block;color:#667085;font-size:6.8pt}.transfer-report-summary strong{display:block;margin-top:2px;color:#172033;font-size:8pt}
      #__transferReportMeasureBox .items-table{width:100%;border-collapse:collapse;table-layout:fixed}
      #__transferReportMeasureBox .items-table th{border:0;background:${themeColor};color:${themeText};padding:6px 7px;font-size:7.4pt;text-align:left}
      #__transferReportMeasureBox .items-table td{border-bottom:1px solid #dfe7e5;padding:5px 7px;color:#24312e;font-size:7.5pt;vertical-align:top;overflow-wrap:anywhere}
      #__transferReportMeasureBox .items-table th:first-child,#__transferReportMeasureBox .items-table td:first-child{text-align:center}
      #__transferReportMeasureBox .items-table th:nth-child(2),#__transferReportMeasureBox .items-table td:nth-child(2){text-align:right}
      #__transferReportMeasureBox .transfer-section-row td{background:${themeColor}14;color:${themeColor};font-weight:800;text-transform:uppercase;padding:6px 7px;border-top:2px solid #fff}
      #__transferReportMeasureBox .transfer-empty-row{text-align:center;color:#667085!important;padding:12px!important}
      #__transferReportMeasureBox .footer-measure{width:100%;font-size:7pt;line-height:1.2;text-align:center}
    </style>
    <div id="__transferReportFirstBase">${reportHeaderHtml}${summaryHtml}<table class="items-table">${transferPdfTableHead()}</table></div>
    <div id="__transferReportNextBase">${reportHeaderHtml}<table class="items-table">${transferPdfTableHead()}</table></div>
    <table class="items-table">${TRANSFER_PDF_COLGROUP}<tbody id="__transferReportMeasureBody"></tbody></table>
    <div id="__transferReportFooterMeasure" class="footer-measure">${footerHtml}</div>
  `;

  const normalise = mountPdfMeasureBox(measureBox, 196);
  const measureBody = measureBox.querySelector('#__transferReportMeasureBody');
  const firstBaseHeight = normalise(measureBox.querySelector('#__transferReportFirstBase').getBoundingClientRect().height);
  const nextBaseHeight = normalise(measureBox.querySelector('#__transferReportNextBase').getBoundingClientRect().height);
  const footerHeight = normalise(measureBox.querySelector('#__transferReportFooterMeasure')?.getBoundingClientRect().height || 0);
  rowRecords.forEach(record => {
    measureBody.innerHTML = record.html;
    record.height = normalise(measureBody.querySelector('tr')?.getBoundingClientRect().height || 0);
  });
  measureBox.remove();

  const pageFlowHeightMm = 276;
  const footerReserveMm = pdfFooterReserveMm({ pageFlowHeightMm }, footerHeight);
  const pages = [];
  let recordIndex = 0;
  while (recordIndex < rowRecords.length) {
    const firstPage = pages.length === 0;
    const baseHeight = firstPage ? firstBaseHeight : nextBaseHeight;
    const budget = Math.max(40, pdfMmToPx(pageFlowHeightMm - footerReserveMm) - baseHeight);
    const pageRows = [];
    let pageHeight = 0;
    while (recordIndex < rowRecords.length) {
      const record = rowRecords[recordIndex];
      const nextRecord = rowRecords[recordIndex + 1];
      const headingBundleHeight = record.kind === 'heading' && nextRecord
        ? record.height + nextRecord.height
        : record.height;
      if (pageRows.length && pageHeight + headingBundleHeight > budget) break;
      if (pageRows.length && pageHeight + record.height > budget) break;
      pageRows.push(record);
      pageHeight += record.height;
      recordIndex += 1;
      if (pageRows.length === 1 && record.height > budget) break;
    }
    pages.push({ includeSummary: firstPage, rows: pageRows });
  }

  const totalPages = pages.length;
  return pages.map((page, pageIndex) => `
    <div class="page">
      ${reportHeaderHtml}
      ${page.includeSummary ? summaryHtml : ''}
      <table class="items-table">
        ${transferPdfTableHead()}
        <tbody>${page.rows.map(record => record.html).join('')}</tbody>
      </table>
      <div class="footer">${footerHtml}</div>
      <div class="page-number">Page ${pageIndex + 1} of ${totalPages}</div>
    </div>
  `).join('');
}

async function generateTransferPdf(selectedModes = ['common']) {
  const fromEventId = document.getElementById('transferSourceSelect')?.value;
  const toEventId = document.getElementById('transferTargetSelect')?.value;
  const fromEvent = transferEventById(fromEventId) || {};
  const toEvent = transferEventById(toEventId) || {};

  if (!fromEventId || !toEventId) {
    showNotification('warning', 'Select both source and destination events first');
    return;
  }

  const win = window.open('', '_blank', 'width=900,height=1000');
  if (!win) {
    showNotification('error', 'Pop-up blocked. Please allow pop-ups to export the transfer PDF.');
    return;
  }
  win.document.write('<!doctype html><title>Preparing transfer report...</title><p style="font:14px Arial;padding:24px">Preparing transfer report...</p>');

  try {
    const optionMap = new Map(
      transferPdfExportOptions().map(option => [option.mode, option])
    );
    const sections = selectedModes
      .map(mode => optionMap.get(transferModeMeta(mode).mode))
      .filter(Boolean);
    if (!sections.length) throw new Error('Select at least one PDF section');

    const eventId = currentDeliveryOrderEvent.id || currentDeliveryOrderEvent.event_id || '0';
    deliveryOrderCaptureDocument(eventId);
    await flushDoEdits(eventId);
    await loadPdfSettings(true);
    const totalQty = sections.reduce(
      (sum, section) => sum + Number(section.quantity || 0),
      0
    );
    const totalTypes = sections.reduce(
      (sum, section) => sum + Number(section.typeCount || 0),
      0
    );
    const generatedBy = (
      typeof eventAssigneeDisplayName === 'function'
        ? eventAssigneeDisplayName(currentUser)
        : ''
    ) || currentUser?.username || '';
    const themeColor = /^#[0-9a-f]{6}$/i.test(pdfSettings?.themeColor || '')
      ? pdfSettings.themeColor
      : '#0f766e';
    const themeText = transferPdfTextColor(themeColor);
    const pagesHtml = buildTransferPdfPagesV2(sections, {
      fromEvent,
      toEvent,
      fromEventId,
      toEventId,
      targetSubproject: transferSelectedTargetSubproject(),
      companyName: pdfSettings?.companyName || currentUser?.company?.name || '',
      generatedBy,
      generatedAt: reportGeneratedAt(),
      totalQty,
      totalTypes,
      themeColor
    });
    const safe = value => escapeHtml(String(value ?? ''));
    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Asset Transfer Report - ${safe(fromEvent.name || '')} to ${safe(toEvent.name || '')}</title><style>
      @page{size:A4;margin:0}
      *{box-sizing:border-box}
      body{margin:0;background:#eef2f1;color:#172033;font-family:${PDF_EXPORT_FONT_FAMILY}}
      .page{position:relative;width:210mm;height:297mm;min-height:297mm;margin:0 auto 12px;padding:7mm 7mm 14mm;background:#fff;overflow:hidden;page-break-after:always;break-after:page}
      .page:last-child{page-break-after:auto;break-after:auto}
      .transfer-report-letterhead{display:flex;align-items:center;justify-content:space-between;min-height:34px;margin-bottom:6px;border-bottom:1px solid #dbe5e3;padding-bottom:6px}
      .transfer-report-letterhead strong{display:block;color:${themeColor};font-size:13pt}.transfer-report-letterhead span{display:block;margin-top:1px;color:#65736f;font-size:7pt;text-transform:uppercase}
      .transfer-report-logo{height:32px}.transfer-report-logo img{max-width:62mm;max-height:32px;object-fit:contain}
      .transfer-report-header{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;margin:8px 0 10px}
      .transfer-report-kicker{color:#667085;font-size:7pt;font-weight:700}.transfer-report-title{margin-top:2px;color:#172033;font-size:15pt;font-weight:800}
      .transfer-report-generated{display:grid;grid-template-columns:auto auto;gap:2px 8px;text-align:right;font-size:7.5pt}.transfer-report-generated span{color:#667085}.transfer-report-generated strong{color:#172033}
      .transfer-report-route{display:grid;grid-template-columns:minmax(0,1fr) 12mm minmax(0,1fr);gap:5px;align-items:stretch;margin-bottom:10px}
      .transfer-report-event{border:1px solid #dce6e4;border-radius:5px;background:#f8fbfa;padding:7px 9px}.transfer-report-event.to{border-color:${themeColor};background:${themeColor}12}
      .transfer-report-event span{display:block;color:#667085;font-size:6.8pt;font-weight:800}.transfer-report-event strong{display:block;margin-top:3px;color:#172033;font-size:9pt}.transfer-report-event small{display:block;margin-top:3px;color:#667085;font-size:7pt}
      .transfer-report-arrow{display:grid;place-items:center;color:${themeColor};font-size:18pt;font-weight:800}
      .transfer-report-summary{display:grid;grid-template-columns:minmax(0,1fr) 25mm 27mm;margin-bottom:10px;border:1px solid #dce6e4;border-radius:5px;overflow:hidden}
      .transfer-report-summary>div{padding:6px 8px;border-right:1px solid #dce6e4}.transfer-report-summary>div:last-child{border-right:0}.transfer-report-summary span{display:block;color:#667085;font-size:6.8pt}.transfer-report-summary strong{display:block;margin-top:2px;color:#172033;font-size:8pt}
      .items-table{width:100%;border-collapse:collapse;table-layout:fixed}.items-table th{border:0;background:${themeColor};color:${themeText};padding:6px 7px;font-size:7.4pt;text-align:left}.items-table td{border-bottom:1px solid #dfe7e5;padding:5px 7px;color:#24312e;font-size:7.5pt;vertical-align:top;line-height:1.3;overflow-wrap:anywhere}
      .items-table th:first-child,.items-table td:first-child{text-align:center}.items-table th:nth-child(2),.items-table td:nth-child(2){text-align:right}.transfer-section-row td{border-top:2px solid #fff;background:${themeColor}14;color:${themeColor};font-weight:800;text-transform:uppercase;padding:6px 7px}.transfer-empty-row{text-align:center!important;color:#667085!important;padding:12px!important}
      .footer{position:absolute;right:7mm;bottom:7mm;left:7mm;text-align:center;font-size:7pt;font-weight:700;line-height:1.2}.page-number{position:absolute;right:7mm;bottom:3mm;color:#667085;font-size:7pt}
      .print-btn{position:fixed;z-index:999;top:20px;right:20px;min-height:40px;border:0;border-radius:6px;background:${themeColor};color:${themeText};padding:0 17px;cursor:pointer;font-weight:800}
      @media print{body,body *{-webkit-print-color-adjust:exact;print-color-adjust:exact}body{background:#fff}.page{margin:0;page-break-after:always;break-after:page}.page:last-child{page-break-after:auto;break-after:auto}.print-btn{display:none}}
    </style></head><body><button class="print-btn" onclick="window.print()">Print / Save as PDF</button>${pagesHtml}</body></html>`;
    win.document.open();
    win.document.write(html);
    win.document.close();
    win.focus();
    showNotification('success', 'Transfer PDF generated');
  } catch (error) {
    win.close();
    showNotification('error', `Failed to generate transfer PDF: ${error.message || error}`);
  }
}
