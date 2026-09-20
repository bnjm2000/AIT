// Return workspace: state, rendering, scanning, and return actions.
// Loaded after app.js and plan.js; uses their shell and subproject helpers.

function getEventReturnableCount(event) {
  const direct = Number(event?.returnableCount ?? 0);
  if (Number.isFinite(direct) && direct > 0) return direct;

  // Fallback for older backend responses. This keeps the Return page working
  // even if /api/events does not include the new returnableCount field yet.
  let count = 0;

  if (Number(event?.preparedCount || 0) > Number(event?.returnedCount || 0)) {
    count += Math.max(Number(event.preparedCount || 0) - Number(event.returnedCount || 0), 0);
  }

  const returned = new Set(event?.returnedItems || []);
  const collected = new Set(event?.customCollected || []);

  (event?.preparedItems || []).forEach(item => {
    if (!isCustomAssetId(item) || returned.has(item)) return;
    const custom = parseCustomAsset(item);
    if (!custom) return;

    const isPrepared = (event?.actuallyPrepared || []).includes(item);
    const isCollectedLoan = custom.type === 'LOAN' && collected.has(item);

    if (isPrepared || isCollectedLoan) {
      count += Number(custom.quantity || 1);
    }
  });

  return count;
}

function getEventReturnTotalCount(event) {
  const direct = Number(event?.returnableTotalCount ?? 0);
  if (Number.isFinite(direct) && direct > 0) return direct;

  return getEventReturnableCount(event) + Number(event?.returnedCount || 0);
}

function isAssetReturnableFromEventDetail(asset, event) {
  if (!asset || !asset.id || asset.status === 'returned') return false;

  const id = asset.id;
  const custom = parseCustomAsset(id, asset);
  const actuallyPrepared = new Set(event?.actuallyPrepared || []);
  const customCollected = new Set(event?.customCollected || []);

  if (custom) {
    const isPrepared = asset.status === 'prepared' || actuallyPrepared.has(id);
    const isCollectedLoan = custom.type === 'LOAN' && (asset.status === 'collected' || asset.isCollected || customCollected.has(id));
    return isPrepared || isCollectedLoan;
  }

  return asset.status === 'prepared' || actuallyPrepared.has(id);
}

const returnPageState = {
  events: [],
  eventId: null,
  event: null,
  outstandingOnly: true,
  department: 'ALL',
  search: '',
  pendingActions: new Set(),
  requestVersion: 0,
  loaded: false,
  activeSubprojectId: '',
  departmentOpenState: new Map(),
  customGroupOpenState: new Map(),
  quickReturnValue: '',
};
const returnPageAssetCache = new WeakMap();

var returnPageNotesSaveTimer = null;
var returnPagePendingNotesSave = null;

function returnPageEncode(value) {
  // encodeURIComponent leaves apostrophes unchanged. These values are also
  // embedded in single-quoted inline handlers, so encode them explicitly to
  // keep descriptions such as 18' (W) by 4' (H) from breaking the handler.
  return encodeURIComponent(String(value || '')).replace(/'/g, '%27');
}

function returnPageDecode(value) {
  try {
    return decodeURIComponent(String(value || ''));
  } catch (error) {
    return String(value || '');
  }
}

function returnPageDateValue(value) {
  const clean = String(value || '').trim().replace(/\//g, '-');
  const parsed = Date.parse(clean);
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

function returnPageCompareEvents(a, b) {
  const aOverdue = a?.state === 'Overdue' ? 0 : 1;
  const bOverdue = b?.state === 'Overdue' ? 0 : 1;
  return (
    aOverdue - bOverdue ||
    returnPageDateValue(a?.endDate) - returnPageDateValue(b?.endDate) ||
    returnPageDateValue(a?.startDate) - returnPageDateValue(b?.startDate) ||
    Number(b?.id || 0) - Number(a?.id || 0)
  );
}

function returnPageSelectableEvents() {
  return [...(returnPageState.events || [])].sort(returnPageCompareEvents);
}

function returnPageEligibleEvents() {
  const selectedId = Number(returnPageState.eventId);
  return returnPageSelectableEvents()
    .filter(event => (
      (getEventReturnableCount(event) > 0 && event.state !== 'Closed') ||
      Number(event.id) === selectedId
    ));
}

function returnPageEventDateText(event) {
  if (!event) return '';
  return event.startDate && event.startDate === event.endDate
    ? event.startDate
    : [event.startDate, event.endDate].filter(Boolean).join(' – ');
}

function returnPageUpsertEventSummary(event) {
  if (!event?.id) return;
  const index = returnPageState.events.findIndex(item => Number(item.id) === Number(event.id));
  const summary = index >= 0
    ? { ...returnPageState.events[index], ...event }
    : { ...event };
  if (index >= 0) returnPageState.events[index] = summary;
  else returnPageState.events.push(summary);
  events = events.map(item => Number(item.id) === Number(event.id) ? { ...item, ...event } : item);
}

function returnPageAssets(event = returnPageState.event, state = returnPageState) {
  if (!event) return [];
  const cacheKey = String(state?.activeSubprojectId || '');
  const cachedByScope = returnPageAssetCache.get(event);
  if (cachedByScope?.has(cacheKey)) return cachedByScope.get(cacheKey);
  const returned = new Set(event.returnedItems || []);
  const rows = new Map();

  Object.entries(event.assetsByDepartment || {}).forEach(([department, departmentAssets]) => {
    (departmentAssets || []).forEach(asset => {
      if (!asset?.id || String(asset.id).startsWith('[MODEL]')) return;
      const custom = parseCustomAsset(asset.id, asset);
      const isReturned = asset.status === 'returned' || returned.has(asset.id);
      if (!isReturned && !isAssetReturnableFromEventDetail(asset, event)) return;

      const code = normalizeDepartmentCode(custom?.department || asset.department || department || 'UN');
      const existing = rows.get(asset.id);
      const next = {
        ...asset,
        department: code,
        parsedCustom: custom,
        isReturned,
        quantity: Math.max(1, Number(asset.quantity || custom?.quantity || 1)),
      };
      if (!existing || (next.isReturned && !existing.isReturned)) rows.set(asset.id, next);
    });
  });

  let assets = Array.from(rows.values());
  const room = eventActiveSubproject(state, event);
  if (room && eventSubprojects(event).length > 1) {
    const allocated = eventSubprojectAssetAllocations(event).get(String(room.id)) || new Set();
    const customItems = (room.items || []).filter(item => item?.isCustom);
    assets = assets.filter(asset => (
      allocated.has(String(asset.id)) ||
      customItems.some(item => (
        (item.assetRefs || []).map(String).includes(String(asset.id)) ||
        (
          normalizeDepartmentCode(item.departmentCode || item.department || 'UN') === asset.department &&
          String(item.description || '').trim().toLowerCase() ===
            String(asset.parsedCustom?.name || '').trim().toLowerCase()
        )
      ))
    ));
  }

  eventSubprojectModelGroups(event, state).forEach(group => {
    const outstandingQuantity = Math.max(0, Number(group?.preparedSlotQuantity || 0));
    const returnedQuantity = Math.max(0, Number(group?.returnedPreparedSlotQuantity || 0));
    const quantity = outstandingQuantity + returnedQuantity;
    if (quantity <= 0) return;
    const modelKey = eventSubprojectGroupKey(group);
    assets.push({
      id: `prepared-model:${modelKey}`,
      department: normalizeDepartmentCode(group?.department || 'UN'),
      brand: String(group?.brand || ''),
      model: String(group?.model || ''),
      description: String(group?.description || ''),
      location: '',
      quantity,
      outstandingQuantity,
      returnedPreparedQuantity: returnedQuantity,
      isReturned: outstandingQuantity <= 0,
      isPreparedModelQuantity: true,
      modelGroup: group,
    });
  });

  assets.sort((a, b) => (
    compareByDisplayName(a.department, b.department) ||
    Number(a.isReturned) - Number(b.isReturned) ||
    compareByDisplayName(returnPageAssetTitle(a), returnPageAssetTitle(b))
  ));
  const cache = cachedByScope || new Map();
  cache.set(cacheKey, assets);
  if (!cachedByScope) returnPageAssetCache.set(event, cache);
  return assets;
}

function returnSubprojectNeedsAttention(room, event = returnPageState.event) {
  if (!room || !event) return false;
  const roomState = { ...returnPageState, activeSubprojectId: String(room.id || '') };
  return returnPageAssets(event, roomState).some(asset => !asset.isReturned);
}

function returnPageAssetTitle(asset) {
  const custom = asset?.parsedCustom || parseCustomAsset(asset?.id, asset);
  if (custom) return customAssetDisplayName(custom);
  if (asset?.isBulk || String(asset?.id || '').startsWith('[BULK]')) {
    return `${asset.brand || ''} ${asset.model || ''}`.trim() || 'Bulk Item';
  }
  if (asset?.isPreparedModelQuantity) {
    return `${asset.brand || ''} ${asset.model || ''}`.trim() || 'Prepared item';
  }
  const model = `${asset?.brand || ''} ${asset?.model || ''}`.trim();
  return [asset?.id || 'Asset', model].filter(Boolean).join(' · ');
}

function returnPageAssetSubtitle(asset) {
  const custom = asset?.parsedCustom || parseCustomAsset(asset?.id, asset);
  if (asset?.isPreparedModelQuantity) {
    return [
      asset.description || 'Prepared without an assigned asset ID',
      `Qty: ${Math.max(1, Number(asset.quantity || 1))}`,
    ].filter(Boolean).join(' / ');
  }
  if (custom) {
    return [
      customAssetDetailText(custom),
      `Qty: ${Math.max(1, Number(custom.quantity || asset.quantity || 1))}`,
    ].filter(Boolean).join(' · ');
  }
  if (asset?.isBulk || String(asset?.id || '').startsWith('[BULK]')) {
    return [
      asset.description || 'Bulk quantity item',
      `Qty: ${Math.max(1, Number(asset.quantity || 1))}`,
    ].join(' · ');
  }
  return [
    asset?.description || '',
    asset?.serial ? `SN: ${asset.serial}` : '',
  ].filter(Boolean).join(' · ');
}

function returnPageMetrics(event = returnPageState.event) {
  const assetRows = returnPageAssets(event);
  const roomScoped = eventSubprojects(event).length > 1;
  const total = roomScoped
    ? assetRows.reduce((sum, asset) => sum + Math.max(1, Number(asset.quantity || 1)), 0)
    : Math.max(getEventReturnTotalCount(event), getEventReturnableCount(event));
  const returned = roomScoped
    ? assetRows.reduce((sum, asset) => (
        sum + (asset.isPreparedModelQuantity
          ? Math.max(0, Number(asset.returnedPreparedQuantity || 0))
          : (asset.isReturned ? Math.max(1, Number(asset.quantity || 1)) : 0))
      ), 0)
    : Math.max(0, total - Math.max(0, getEventReturnableCount(event)));
  const remaining = Math.max(0, total - returned);
  return {
    total,
    returned,
    remaining,
    departments: new Set(assetRows.map(asset => asset.department)).size,
    percent: total > 0 ? Math.round((returned / total) * 100) : 0,
  };
}

function returnPageCaptureViewState() {
  document.querySelectorAll('details.return-department-section[data-return-department]').forEach(details => {
    returnPageState.departmentOpenState.set(
      returnPageDecode(details.dataset.returnDepartment || ''),
      details.open
    );
  });
  document.querySelectorAll('details.return-custom-group[data-return-custom-group]').forEach(details => {
    returnPageState.customGroupOpenState.set(details.dataset.returnCustomGroup || '', details.open);
  });
  const scroller = document.getElementById('returnAssetsScroll');
  const root = document.getElementById('return-page-root');
  const contentArea = root?.closest('.content-area');
  const active = document.activeElement;
  const snapshot = {
    contentAreaTop: contentArea?.scrollTop || 0,
    contentAreaLeft: contentArea?.scrollLeft || 0,
    pageX: window.scrollX,
    pageY: window.scrollY,
    scrollTop: scroller?.scrollTop || 0,
    anchorId: '',
    anchorOffset: 0,
    focusId: active?.id || '',
    selectionStart: Number.isFinite(active?.selectionStart) ? active.selectionStart : null,
    selectionEnd: Number.isFinite(active?.selectionEnd) ? active.selectionEnd : null,
    notesValue: document.getElementById('returnEventNotes')?.value ?? null,
    notesSaveState: document.getElementById('returnNotesSaveState')?.textContent || '',
  };
  if (!scroller) return snapshot;

  const scrollerRect = scroller.getBoundingClientRect();
  const rows = Array.from(scroller.querySelectorAll('[data-return-row-id]'));
  const anchor = rows.find(row => row.getBoundingClientRect().bottom > scrollerRect.top);
  if (anchor) {
    snapshot.anchorId = anchor.dataset.returnRowId || '';
    snapshot.anchorOffset = anchor.getBoundingClientRect().top - scrollerRect.top;
  }
  return snapshot;
}

function returnPageRestoreViewState(snapshot) {
  if (!snapshot) return;
  const root = document.getElementById('return-page-root');
  const contentArea = root?.closest('.content-area');
  if (contentArea) {
    contentArea.scrollTop = snapshot.contentAreaTop || 0;
    contentArea.scrollLeft = snapshot.contentAreaLeft || 0;
  }
  window.scrollTo(snapshot.pageX || 0, snapshot.pageY || 0);
  const scroller = document.getElementById('returnAssetsScroll');
  if (scroller) {
    scroller.scrollTop = snapshot.scrollTop || 0;
    if (snapshot.anchorId) {
      const anchor = Array.from(scroller.querySelectorAll('[data-return-row-id]'))
        .find(row => row.dataset.returnRowId === snapshot.anchorId);
      if (anchor) {
        const scrollerRect = scroller.getBoundingClientRect();
        const currentOffset = anchor.getBoundingClientRect().top - scrollerRect.top;
        scroller.scrollTop += currentOffset - snapshot.anchorOffset;
      }
    }
  }

  const notes = document.getElementById('returnEventNotes');
  if (notes && typeof snapshot.notesValue === 'string') {
    notes.value = snapshot.notesValue;
    const counter = document.getElementById('returnNotesCharacterCount');
    const state = document.getElementById('returnNotesSaveState');
    if (counter) counter.textContent = `${notes.value.length}/50000`;
    if (state && snapshot.notesSaveState) state.textContent = snapshot.notesSaveState;
  }

  if (snapshot.focusId) {
    const target = document.getElementById(snapshot.focusId);
    if (target) {
      target.focus({ preventScroll: true });
      if (
        snapshot.selectionStart !== null &&
        typeof target.setSelectionRange === 'function'
      ) {
        target.setSelectionRange(snapshot.selectionStart, snapshot.selectionEnd);
      }
    }
  }
}

function returnPageUpdatePickerOptions() {
  if (
    typeof planEventChooserState !== 'undefined' &&
    planEventChooserState.context === 'return' &&
    document.getElementById('planEventChooserModal')?.classList.contains('active')
  ) renderPlanEventChooser();
}

function returnPageSetDepartmentOpen(encodedDepartment, open, detailsElement = null) {
  if (detailsElement && !detailsElement.isConnected) return;
  returnPageState.departmentOpenState.set(returnPageDecode(encodedDepartment), !!open);
}

function returnPageSetCustomGroupOpen(type, open, detailsElement = null) {
  if (detailsElement && !detailsElement.isConnected) return;
  returnPageState.customGroupOpenState.set(String(type || ''), !!open);
}

function returnOpenEventChooser() {
  planOpenEventChooser('return');
}

function returnPageDepartmentChipsHtml(assets) {
  const counts = new Map();
  assets.forEach(asset => {
    const quantity = returnPageState.outstandingOnly
      ? returnPageOutstandingQuantity(asset)
      : Number(asset.quantity || 0);
    counts.set(asset.department, (counts.get(asset.department) || 0) + quantity);
  });
  const chips = Array.from(counts.entries())
    .sort((a, b) => compareByDisplayName(planDepartmentLabel(a[0]), planDepartmentLabel(b[0])))
    .map(([code, quantity]) => `
      <button type="button"
              class="return-chip return-chip-department ${returnPageState.department === code ? 'active' : ''}"
              data-return-department="${escapeHtmlAttr(returnPageEncode(code))}"
              style="${planDepartmentFilterStyle(code)}"
              onclick="returnPageSetDepartment('${escapeHtmlAttr(returnPageEncode(code))}')">
        ${escapeHtml(planDepartmentLabel(code))} · ${quantity}
      </button>
    `).join('');
  const total = assets.reduce((sum, asset) => (
    sum + (returnPageState.outstandingOnly
      ? returnPageOutstandingQuantity(asset)
      : Number(asset.quantity || 0))
  ), 0);
  return `
    <button type="button"
            class="return-chip return-chip-all ${returnPageState.department === 'ALL' ? 'active' : ''}"
            onclick="returnPageSetDepartment('ALL')">
      All · ${total}
    </button>
    ${chips}
  `;
}

function returnPageChipAssets() {
  const assets = returnPageAssets();
  return returnPageState.outstandingOnly
    ? assets.filter(asset => !asset.isReturned)
    : assets;
}

function returnPageFilteredAssets() {
  const query = String(returnPageState.search || '').trim().toLowerCase();
  return returnPageAssets().filter(asset => {
    if (asset.parsedCustom || parseCustomAsset(asset.id, asset)) return false;
    if (returnPageState.outstandingOnly && asset.isReturned) return false;
    if (returnPageState.department !== 'ALL' && asset.department !== returnPageState.department) return false;
    if (!query) return true;
    return [
      asset.id,
      asset.brand,
      asset.model,
      asset.description,
      asset.serial,
      asset.location,
      asset.department,
      assetTagSearchText(asset),
      returnPageAssetTitle(asset),
      returnPageAssetSubtitle(asset),
    ].some(value => String(value || '').toLowerCase().includes(query));
  });
}

function returnPageOutstandingQuantity(asset) {
  if (asset?.isPreparedModelQuantity) {
    return Math.max(0, Number(asset.outstandingQuantity || 0));
  }
  return asset?.isReturned ? 0 : Math.max(1, Number(asset?.quantity || 1));
}

function returnPageCanLogFault(asset) {
  const custom = asset?.parsedCustom || parseCustomAsset(asset?.id, asset);
  return Boolean(
    asset?.id && !custom && !asset?.isLoanOrMisc
    && !asset?.isPreparedModelQuantity
  );
}

async function returnPageLogFault(encodedAssetId) {
  const assetId = returnPageDecode(encodedAssetId);
  const row = returnPageAssets().find(asset => String(asset.id) === assetId);
  if (!returnPageCanLogFault(row)) {
    showNotification('warning', 'Fault logs are only available for inventory assets');
    return;
  }

  try {
    await ensureAssetsLoaded();
  } catch (error) {
    showNotification('error', `Unable to load inventory: ${error.message || error}`);
    return;
  }
  const inventoryAsset = getAssetByApiIdentifier(row.bulkId || row.id)
    || findAssetByIdentifier(row.bulkId || row.id, assets);
  if (!inventoryAsset) {
    showNotification('error', 'Inventory asset not found');
    return;
  }

  const inventoryId = getAssetIdentifierForApi(inventoryAsset);
  if (inventoryAsset.isBulk || row.isBulk) {
    openBulkMaintenanceFaultModal(inventoryId);
    return;
  }

  openMaintenanceModalForAsset(inventoryId);
  const logType = document.getElementById('maintenanceLogType');
  if (logType) {
    logType.value = 'Fault';
    applyMaintenanceLogTypeSelectStyle(logType);
  }
  requestAnimationFrame(() => document.getElementById('maintenanceLogEntry')?.focus());
}

function returnPageAssetRowHtml(asset) {
  if (asset?.isPreparedModelQuantity) {
    return returnPagePreparedModelRowHtml(asset);
  }
  const encodedId = returnPageEncode(asset.id);
  const pendingKey = `${asset.isReturned ? 'unreturn' : 'return'}:${asset.id}`;
  const pending = returnPageState.pendingActions.has(pendingKey);
  const dragPayload = eventSubprojectDragPayload(
    returnPageState,
    returnPageState.event,
    { kind: 'asset', assetRef: asset.id }
  );
  return `
    <div class="return-asset-row ${asset.isReturned ? 'is-returned' : ''} ${dragPayload ? 'is-room-draggable' : ''}"
         data-return-row-id="${escapeHtmlAttr(encodedId)}"
         ${dragPayload ? `draggable="true" ondragstart="eventSubprojectDragStart(event,'${dragPayload}')" ondragend="eventSubprojectDragEnd(event)"` : ''}>
      <div>
        <div class="return-asset-title-line">
          <div class="return-asset-name">${escapeHtml(returnPageAssetTitle(asset))}</div>
          ${planDepartmentCodeBadgeHtml(asset.department)}
        </div>
        <div class="return-asset-subtitle">${escapeHtml(returnPageAssetSubtitle(asset))}</div>
      </div>
      <div class="return-status ${asset.isReturned ? 'is-returned' : ''}">
        ${asset.isReturned ? 'Returned' : 'Outstanding'}
      </div>
      <div class="return-row-actions return-row-action">
        ${returnPageCanLogFault(asset) ? `
          <button type="button"
                  class="return-button return-button-fault"
                  onclick="returnPageLogFault('${escapeHtmlAttr(encodedId)}')">
            Log fault
          </button>
        ` : ''}
        <button type="button"
                class="return-button ${asset.isReturned ? '' : 'return-button-primary'}"
                ${pending ? 'disabled' : ''}
                onclick="${asset.isReturned
                  ? `returnPageUnreturnAsset('${escapeHtmlAttr(encodedId)}', this)`
                  : `returnPageReturnAsset('${escapeHtmlAttr(encodedId)}', this)`}">
          ${pending ? (asset.isReturned ? 'Restoring…' : 'Returning…') : (asset.isReturned ? 'Undo' : 'Return')}
        </button>
      </div>
    </div>
  `;
}

function returnPagePreparedModelRowHtml(asset) {
  const encodedId = returnPageEncode(asset.id);
  const outstanding = Math.max(0, Number(asset.outstandingQuantity || 0));
  const returned = Math.max(0, Number(asset.returnedPreparedQuantity || 0));
  const pending = returnPageState.pendingActions.has(`prepared-model:${asset.id}`);
  const statusText = outstanding > 0
    ? (returned > 0 ? `${returned} returned / ${outstanding} outstanding` : `${outstanding} outstanding`)
    : `${returned} returned`;
  return `
    <div class="return-asset-row ${outstanding <= 0 ? 'is-returned' : ''}"
         data-return-row-id="${escapeHtmlAttr(encodedId)}">
      <div>
        <div class="return-asset-title-line">
          <div class="return-asset-name">${escapeHtml(returnPageAssetTitle(asset))}</div>
          ${planDepartmentCodeBadgeHtml(asset.department)}
        </div>
        <div class="return-asset-subtitle">${escapeHtml(returnPageAssetSubtitle(asset))}</div>
      </div>
      <div class="return-status ${outstanding <= 0 ? 'is-returned' : ''}">
        ${escapeHtml(statusText)}
      </div>
      <div class="return-row-actions return-row-action">
        ${outstanding > 0 ? `
          <button type="button"
                  class="return-button return-button-primary"
                  ${pending ? 'disabled' : ''}
                  onclick="returnPagePromptPreparedQuantity('return', '${escapeHtmlAttr(encodedId)}', this)">
            ${pending ? 'Returning...' : 'Return all'}
          </button>
        ` : '<span class="return-prepared-complete">Returned</span>'}
        <details class="return-quantity-menu">
          <summary class="return-button return-more-button" aria-label="More return actions">...</summary>
          <div class="return-quantity-menu-popover">
            ${outstanding > 0 ? `
              <button type="button" onclick="returnPagePromptPreparedQuantity('return', '${escapeHtmlAttr(encodedId)}', this)">Return qty</button>
            ` : ''}
            ${returned > 0 ? `
              <button type="button" onclick="returnPagePromptPreparedQuantity('unreturn', '${escapeHtmlAttr(encodedId)}', this)">Unreturn qty</button>
            ` : ''}
          </div>
        </details>
      </div>
    </div>
  `;
}

function returnPageRenderFilteredAssets(options = {}) {
  const scroller = document.getElementById('returnAssetsScroll');
  if (!scroller) return;
  const previousScroll = options.resetScroll ? 0 : scroller.scrollTop;
  const filtered = returnPageFilteredAssets();
  const groups = new Map();
  filtered.forEach(asset => {
    if (!groups.has(asset.department)) groups.set(asset.department, []);
    groups.get(asset.department).push(asset);
  });

  const html = Array.from(groups.entries())
    .sort((a, b) => compareByDisplayName(planDepartmentLabel(a[0]), planDepartmentLabel(b[0])))
    .map(([department, departmentAssets]) => {
      const outstanding = departmentAssets
        .reduce((sum, asset) => sum + returnPageOutstandingQuantity(asset), 0);
      const rememberedOpen = returnPageState.departmentOpenState.get(department);
      const departmentOpen = typeof rememberedOpen === 'boolean' ? rememberedOpen : true;
      return `
        <details class="return-department-section" ${departmentOpen ? 'open' : ''}
                 data-return-department="${escapeHtmlAttr(returnPageEncode(department))}"
                 ontoggle="returnPageSetDepartmentOpen('${escapeHtmlAttr(returnPageEncode(department))}',this.open,this)">
          <summary class="return-department-summary">
            <span class="return-department-name">
              <i class="return-department-dot"
                 style="--department-color:${escapeHtmlAttr(planDepartmentColor(department))}"></i>
              ${escapeHtml(planDepartmentLabel(department))}
            </span>
            <span class="return-department-actions">
              <span>${outstanding} to return</span>
              ${isAdminUser() && outstanding > 0 ? `
                <button type="button"
                        class="return-button return-button-success"
                        onclick="returnPageReturnDepartment('${escapeHtmlAttr(returnPageEncode(department))}', this)">
                  Return all
                </button>
              ` : ''}
            </span>
          </summary>
          ${departmentAssets.map(returnPageAssetRowHtml).join('')}
        </details>
      `;
    }).join('');

  scroller.innerHTML = html || `
    <div class="return-empty">
      ${returnPageState.outstandingOnly
        ? 'No outstanding assets match the selected filters.'
        : 'No returned or outstanding assets match the selected filters.'}
    </div>
  `;
  scroller.scrollTop = previousScroll;

  document.querySelectorAll('.return-chip').forEach(chip => chip.classList.remove('active'));
  if (returnPageState.department === 'ALL') {
    document.querySelector('.return-chip-all')?.classList.add('active');
  } else {
    document.querySelectorAll('.return-chip-department').forEach(chip => {
      const encoded = chip.dataset.returnDepartment || '';
      chip.classList.toggle('active', returnPageDecode(encoded) === returnPageState.department);
    });
  }

  const helper = document.getElementById('returnAssetsHelper');
  if (helper) {
    helper.textContent = returnPageState.outstandingOnly
      ? 'Outstanding items disappear immediately after return.'
      : 'Showing outstanding and returned assets; use Undo for accidental returns.';
  }
}

function returnPageEventDetailsHtml(event) {
  const notes = String(event.notes || '');
  return `
    <section class="return-surface">
      <div class="return-card-header event-detail-card-header">
        <h3>Event Details</h3>
        ${eventDetailsActionsHtml(event.id)}
      </div>
      <div class="return-aside-body">
        <dl class="return-detail-list">
          <div><dt>Name</dt><dd>${escapeHtml(event.name || `Event ${event.id}`)}</dd></div>
          <div><dt>Location</dt><dd>${escapeHtml(event.location || '—')}</dd></div>
          <div><dt>Date(s)</dt><dd>${escapeHtml(returnPageEventDateText(event) || '—')}</dd></div>
          <div><dt>Status</dt><dd>${planEventStateBadgeHtml(event)}</dd></div>
          <div><dt>Type</dt><dd>${planEventTypeBadgeHtml(event)}</dd></div>
        </dl>
        <div class="return-event-notes">
          <label for="returnEventNotes">Notes</label>
          <textarea id="returnEventNotes" class="plan-notes-textarea"
                    maxlength="50000"
                    placeholder="Add notes or special requirements for this event..."
                    oninput="returnPageNotesChanged(this)"
                    onblur="returnPageFlushNotesSave()">${escapeHtml(notes)}</textarea>
          <div class="plan-notes-footer">
            <span id="returnNotesSaveState">Saved</span>
            <span id="returnNotesCharacterCount">${notes.length}/50000</span>
          </div>
        </div>
      </div>
    </section>
  `;
}

function returnPageNotesChanged(textarea) {
  const notes = String(textarea?.value || '');
  const state = document.getElementById('returnNotesSaveState');
  const counter = document.getElementById('returnNotesCharacterCount');
  if (counter) counter.textContent = `${notes.length}/50000`;
  if (state) state.textContent = 'Unsaved changes';
  if (returnPageState.event) returnPageState.event.notes = notes;

  returnPagePendingNotesSave = {
    eventId: Number(returnPageState.eventId),
    notes,
  };
  clearTimeout(returnPageNotesSaveTimer);
  returnPageNotesSaveTimer = setTimeout(returnPageFlushNotesSave, 700);
}

async function returnPageFlushNotesSave() {
  clearTimeout(returnPageNotesSaveTimer);
  returnPageNotesSaveTimer = null;
  const pending = returnPagePendingNotesSave;
  if (!pending?.eventId) return;
  returnPagePendingNotesSave = null;

  const state = document.getElementById('returnNotesSaveState');
  if (state) state.textContent = 'Saving…';
  try {
    const response = await apiCall(
      `/api/events/${pending.eventId}/notes`,
      'PUT',
      { notes: pending.notes }
    );
    if (Number(returnPageState.eventId) === Number(pending.eventId)) {
      returnPageState.event.notes = response.data?.notes ?? pending.notes;
      if (state) state.textContent = 'Saved';
    }
  } catch (error) {
    returnPagePendingNotesSave = pending;
    if (state) state.textContent = 'Save failed';
  }
}

function returnPageQuickReturnHtml(event = returnPageState.event) {
  // Room tabs filter the table, but Quick Return always operates on the whole
  // event. Keep scanning available while any room still has an asset out.
  const disabled = getEventReturnableCount(event) <= 0 ? 'disabled' : '';
  return `
    <section class="return-surface">
      <div class="return-card-header">
        <div><h3>Quick Return</h3><p>Scan or enter an asset ID, container ID, or serial number.</p></div>
      </div>
      <div class="return-aside-body">
        <label class="return-quick-label" for="returnQuickAssetInput">Asset ID, container ID, or serial number</label>
        <div class="return-quick-row">
          <input class="return-quick-input"
                 id="returnQuickAssetInput"
                 autocomplete="off"
                 value="${escapeHtmlAttr(returnPageState.quickReturnValue)}"
                 placeholder="e.g. AU-1038"
                 ${disabled}
                 oninput="returnPageState.quickReturnValue=this.value"
                 onkeydown="if(event.key==='Enter'){event.preventDefault();returnPageManualReturn();}">
          <button type="button"
                  class="return-button"
                  title="Scan an asset"
                  aria-label="Scan an asset"
                  ${disabled}
                  onclick="scanForReturn()">&#128247;</button>
        </div>
        <button type="button"
                class="return-button return-button-primary return-quick-submit"
                id="returnQuickSubmit"
                ${disabled}
                onclick="returnPageManualReturn()">
          Return Asset
        </button>
        <p class="return-help">The field stays focused after each return for fast consecutive scanning.</p>
      </div>
    </section>
  `;
}

function returnPageCustomItemsHtml(event = returnPageState.event) {
  const rows = returnPageAssets(event).filter(asset => (
    asset.parsedCustom || parseCustomAsset(asset.id, asset)
  ));
  return `
    <section class="return-surface return-custom-items">
      <div class="return-card-header"><div><h3>Misc &amp; Loan Items</h3><p>Return non-inventory items.</p></div></div>
      <div class="return-aside-body">
        ${[['MISC', 'Misc Items'], ['LOAN', 'Loan Items']].map(([type, label]) => {
          const items = rows.filter(asset => normalizeCustomType(
            (asset.parsedCustom || parseCustomAsset(asset.id, asset))?.type
          ) === type);
          const rememberedOpen = returnPageState.customGroupOpenState.get(type);
          const groupOpen = typeof rememberedOpen === 'boolean' ? rememberedOpen : true;
          return `<details class="return-custom-group" ${groupOpen ? 'open' : ''}
                          data-return-custom-group="${escapeHtmlAttr(type)}"
                          ontoggle="returnPageSetCustomGroupOpen('${escapeHtmlAttr(type)}',this.open,this)">
            <summary>${escapeHtml(label)} <span>${items.length}</span></summary>
            <div>${items.map(asset => {
              const encodedId = returnPageEncode(asset.id);
              return `<article class="return-custom-row">
                <span><strong>${escapeHtml(returnPageAssetTitle(asset))}</strong><small>${escapeHtml(returnPageAssetSubtitle(asset))}</small></span>
                <button type="button" class="return-button ${asset.isReturned ? '' : 'return-button-primary'}"
                        onclick="${asset.isReturned
                          ? `returnPageUnreturnAsset('${escapeHtmlAttr(encodedId)}', this)`
                          : `returnPageReturnAsset('${escapeHtmlAttr(encodedId)}', this)`}">
                  ${asset.isReturned ? 'Undo' : 'Return'}
                </button>
              </article>`;
            }).join('') || '<p class="return-help">No items.</p>'}</div>
          </details>`;
        }).join('')}
      </div>
    </section>
  `;
}

function returnPageProgressHtml(event, metrics) {
  const overdue = event.state === 'Overdue';
  return `
    <section class="return-surface">
      <div class="return-card-header">
        <div><h3>Return Progress</h3><p>Event completion at a glance.</p></div>
      </div>
      <div class="return-aside-body">
        <div class="return-progress-number">
          <strong>${metrics.percent}%</strong>
          <span>${metrics.returned} of ${metrics.total} returned</span>
        </div>
        <div class="return-progress-track" aria-label="${metrics.percent}% returned">
          <span style="width:${metrics.percent}%"></span>
        </div>
        <div class="return-progress-copy">
          <span>${metrics.remaining} outstanding</span>
          <span>${metrics.departments} departments</span>
        </div>
        ${overdue ? `
          <div class="return-overdue-note">
            <strong>Overdue:</strong> Return the remaining assets to clear the overdue status.
          </div>
        ` : ''}
      </div>
    </section>
  `;
}

function renderReturnPage(options = {}) {
  const root = document.getElementById('return-page-root');
  if (!root) return;
  const snapshot = options.snapshot || null;
  const event = returnPageState.event;

  if (!event) {
    root.innerHTML = `
      <div class="return-page-heading">
        <h2>Return Event Assets</h2>
        <p>Receive, verify, and return deployed assets to inventory.</p>
      </div>
      <div class="return-surface return-empty">No events currently have assets to return.</div>
    `;
    returnPageRestoreViewState(snapshot);
    return;
  }

  const consolidated = eventIsConsolidated(returnPageState, event);
  root.classList.toggle('event-consolidated-mode', consolidated);
  const metrics = returnPageMetrics(event);
  const assetRows = returnPageAssets(event).filter(asset => (
    !(asset.parsedCustom || parseCustomAsset(asset.id, asset))
  ));
  const hasAssignedAssets = assetRows.length > 0;
  root.innerHTML = `
    <div class="return-page-heading">
      <div><h2>Return Event Assets</h2><p>Receive, verify, and return deployed assets to inventory.</p></div>
    </div>
    <div class="plan-event-bar return-top-event-bar">
      <button type="button"
              class="plan-event-select-wrap"
              id="returnEventPickerButton"
              aria-haspopup="dialog"
              aria-label="Choose an event to return"
              onclick="returnOpenEventChooser()">
        <div class="plan-event-icon" aria-hidden="true">${planMetricIconSvg('calendar')}</div>
        <div style="min-width:0;flex:1;">
          <div class="plan-event-title-row">
            <span class="plan-event-id">#${escapeHtml(String(event.id || ''))}</span>
            <span class="plan-event-name">${escapeHtml(planEventOptionLabel(event))}</span>
          </div>
          <div class="plan-event-meta">
            <span>${escapeHtml(returnPageEventDateText(event))}</span>
            ${event.location ? `<span aria-hidden="true">•</span><span>${escapeHtml(event.location)}</span>` : ''}
            ${planEventTypeBadgeHtml(event)}
            ${planEventStateBadgeHtml(event)}
          </div>
        </div>
        <span class="plan-event-picker-chevron" aria-hidden="true">⌄</span>
      </button>
      <div class="plan-metrics return-metrics">
        <div class="plan-metric"><div class="plan-metric-icon">${planMetricIconSvg('lines')}</div><div><strong>${metrics.total}</strong><span>Total Assets</span></div></div>
        <div class="plan-metric"><div class="plan-metric-icon">${planMetricIconSvg('quantity')}</div><div><strong>${metrics.returned}</strong><span>Returned</span></div></div>
        <div class="plan-metric"><div class="plan-metric-icon">${planMetricIconSvg('calendar')}</div><div><strong>${metrics.remaining}</strong><span>Remaining</span></div></div>
        <div class="plan-metric"><div class="plan-metric-icon">${planMetricIconSvg('departments')}</div><div><strong>${metrics.departments}</strong><span>Departments</span></div></div>
      </div>
    </div>
    <div class="return-layout">
      <aside class="return-left">
        ${returnPageQuickReturnHtml(event)}
        ${returnPageCustomItemsHtml(event)}
      </aside>
      <div class="return-primary">
        ${renderEventSubprojectTabs(
          'returnPageState',
          event,
          'renderReturnPage',
          'Return sub-projects',
          {
            roomNeedsAttention: returnSubprojectNeedsAttention,
            attentionLabel: 'Has unreturned items'
          }
        )}
        ${consolidated ? eventConsolidatedNotice({ interactive: true }) : ''}
        <section class="return-assets-card return-surface">
          <div class="return-card-header">
            <div>
              <h3>Assets to Return</h3>
              ${hasAssignedAssets ? `<p id="returnAssetsHelper">${returnPageState.outstandingOnly
                ? 'Outstanding items disappear immediately after return.'
                : 'Showing outstanding and returned assets; use Undo for accidental returns.'}</p>` : ''}
            </div>
          </div>
          ${hasAssignedAssets ? `
          <div class="return-filters">
            <div class="return-search-row">
              <input class="return-search-input"
                     id="returnAssetSearch"
                     value="${escapeHtmlAttr(returnPageState.search)}"
                     placeholder="Search asset ID, model, serial number…"
                     oninput="returnPageSearchChanged(this.value)">
              <label class="return-toggle">
                <input type="checkbox"
                       ${returnPageState.outstandingOnly ? 'checked' : ''}
                       onchange="returnPageToggleOutstanding(this.checked)">
                Outstanding only
              </label>
            </div>
            <div class="return-filter-chips" id="returnDepartmentChips">
              ${returnPageDepartmentChipsHtml(
                returnPageState.outstandingOnly
                  ? assetRows.filter(asset => !asset.isReturned)
                  : assetRows
              )}
            </div>
          </div>
          <div class="return-assets-table-head">
            <span>Asset</span><span>Status</span><span></span>
          </div>
          <div class="return-assets-scroll" id="returnAssetsScroll"></div>
          ` : `
          <div class="return-empty" id="returnNoAssignedAssets">
            No assets have been assigned to this event.
          </div>
          `}
        </section>
      </div>
      <aside class="return-aside">
        ${returnPageEventDetailsHtml(event)}
        ${returnPageProgressHtml(event, metrics)}
        <button type="button"
                class="return-button return-button-primary return-exit-button"
                onclick="returnPageExit()">
          ${metrics.total > 0 && metrics.remaining === 0 ? 'Close Event' : 'Save and Exit'}
        </button>
      </aside>
    </div>
  `;
  returnPageRenderFilteredAssets();
  returnPageRestoreViewState(snapshot);
}

async function loadReturnWorkspace(options = {}) {
  const root = document.getElementById('return-page-root');
  if (!root) return;
  const snapshot = options.preservePosition === false ? null : returnPageCaptureViewState();
  const version = ++returnPageState.requestVersion;
  if (!returnPageState.loaded) {
    root.innerHTML = '<div class="loading">Loading return workspace...</div>';
  }

  try {
    if (!returnPageState.eventId) returnPageState.eventId = workflowRememberedEventId();
    const preferredId = Number(returnPageState.eventId) || null;
    const eventOptionsPromise = startProgressiveEventOptions(
      preferredId,
      loaded => {
        returnPageState.events = loaded;
        returnPageUpdatePickerOptions();
      }
    );
    let eventOptionsApplied = false;
    const applyEventOptions = eventOptionsLoad => {
      if (eventOptionsApplied || version !== returnPageState.requestVersion) return;
      eventOptionsApplied = true;
      returnPageState.events = eventOptionsLoad.first;
      events = returnPageState.events;
      updateOverdueCounter(countOverdueEvents(returnPageState.events));
      returnPageUpdatePickerOptions();
      eventOptionsLoad.completion.then(loaded => {
        if (version !== returnPageState.requestVersion) return;
        returnPageState.events = loaded;
        events = loaded;
        updateOverdueCounter(countOverdueEvents(loaded));
        returnPageUpdatePickerOptions();
      }).catch(error => console.warn('Unable to load more event options:', error));
    };

    if (preferredId && options.keepSelection !== false) {
      eventOptionsPromise.then(applyEventOptions).catch(error => {
        console.warn('Unable to load Return event options:', error);
      });
      try {
        const detailResponse = await apiCall(`/api/events/${preferredId}?view=return`);
        if (version !== returnPageState.requestVersion) return;
        returnPageState.eventId = preferredId;
        workflowRememberEvent(preferredId);
        returnPageState.event = detailResponse.data;
        returnPageUpsertEventSummary(detailResponse.data);
        returnPageState.loaded = true;
        renderReturnPage({ snapshot });
        return;
      } catch (preferredError) {
        console.warn('Unable to load the remembered Return event:', preferredError);
      }
    }

    const eventOptionsLoad = await eventOptionsPromise;
    if (version !== returnPageState.requestVersion) return;
    applyEventOptions(eventOptionsLoad);

    const eligible = returnPageEligibleEvents().filter(event => (
      getEventReturnableCount(event) > 0 && event.state !== 'Closed'
    ));
    const keepCurrent = options.keepSelection !== false &&
      returnPageState.eventId &&
      returnPageState.events.some(event => Number(event.id) === Number(returnPageState.eventId));
    const selected = keepCurrent
      ? returnPageState.events.find(event => Number(event.id) === Number(returnPageState.eventId))
      : (eligible[0] || returnPageSelectableEvents()[0]);

    if (!selected) {
      returnPageState.eventId = null;
      returnPageState.event = null;
      returnPageState.loaded = true;
      renderReturnPage({ snapshot });
      return;
    }

    const detailResponse = await apiCall(`/api/events/${selected.id}?view=return`);
    if (version !== returnPageState.requestVersion) return;
    returnPageState.eventId = Number(selected.id);
    workflowRememberEvent(selected.id);
    returnPageState.event = detailResponse.data;
    returnPageUpsertEventSummary(detailResponse.data);
    returnPageState.loaded = true;
    renderReturnPage({ snapshot });
  } catch (error) {
    if (version !== returnPageState.requestVersion) return;
    root.innerHTML = `
      <div class="return-empty">
        Failed to load Return: ${escapeHtml(error.message || String(error))}
        <br><br>
        <button type="button" class="return-button return-button-primary" onclick="loadReturnWorkspace()">Retry</button>
      </div>
    `;
  }
}

async function returnPageSelectEvent(eventId) {
  await returnPageFlushNotesSave();
  const id = Number(eventId);
  if (!id || id === Number(returnPageState.eventId)) return;
  const version = ++returnPageState.requestVersion;
  returnPageState.department = 'ALL';
  returnPageState.search = '';
  returnPageState.quickReturnValue = '';
  returnPageState.departmentOpenState.clear();
  returnPageState.customGroupOpenState.clear();
  try {
    const response = await apiCall(`/api/events/${id}?view=return`);
    if (version !== returnPageState.requestVersion) return;
    returnPageState.eventId = id;
    workflowRememberEvent(id);
    returnPageState.event = response.data;
    returnPageUpsertEventSummary(response.data);
    renderReturnPage();
  } catch (error) {
    showNotification('error', `Failed to load event: ${error.message}`);
    returnPageUpdatePickerOptions();
  }
}

async function returnPageRefreshSelected(options = {}) {
  const id = Number(returnPageState.eventId);
  if (!id) return;
  const snapshot = returnPageCaptureViewState();
  if (options.focusId) snapshot.focusId = options.focusId;
  const version = ++returnPageState.requestVersion;
  const response = await apiCall(`/api/events/${id}?view=return`);
  if (version !== returnPageState.requestVersion || id !== Number(returnPageState.eventId)) return;
  returnPageState.event = response.data;
  returnPageUpsertEventSummary(response.data);
  updateOverdueCounter(countOverdueEvents(returnPageState.events));
  renderReturnPage({ snapshot });
}

function returnPageHandleRealtimeEvent(event) {
  if (!event?.id) return;
  returnPageUpsertEventSummary(event);
  if (!document.getElementById('return-section')?.classList.contains('active')) return;
  if (Number(event.id) === Number(returnPageState.eventId)) {
    const snapshot = returnPageCaptureViewState();
    returnPageState.event = event;
    renderReturnPage({ snapshot });
  } else {
    returnPageUpdatePickerOptions();
  }
}

function returnPageSearchChanged(value) {
  returnPageState.search = String(value || '');
  returnPageRenderFilteredAssets({ resetScroll: true });
}

function returnPageToggleOutstanding(checked) {
  returnPageState.outstandingOnly = !!checked;
  const chipAssets = returnPageChipAssets();
  if (
    returnPageState.department !== 'ALL' &&
    !chipAssets.some(asset => asset.department === returnPageState.department)
  ) {
    returnPageState.department = 'ALL';
  }
  const chips = document.getElementById('returnDepartmentChips');
  if (chips) chips.innerHTML = returnPageDepartmentChipsHtml(chipAssets);
  returnPageRenderFilteredAssets({ resetScroll: true });
}

function returnPageSetDepartment(encodedDepartment) {
  returnPageState.department = encodedDepartment === 'ALL'
    ? 'ALL'
    : normalizeDepartmentCode(returnPageDecode(encodedDepartment));
  returnPageRenderFilteredAssets({ resetScroll: true });
}

async function returnPageRunAssetAction(action, encodedAssetId, button) {
  const assetId = returnPageDecode(encodedAssetId);
  const eventId = Number(returnPageState.eventId);
  const key = `${action}:${assetId}`;
  if (!eventId || !assetId || returnPageState.pendingActions.has(key)) return;
  returnPageState.pendingActions.add(key);
  if (button) {
    button.disabled = true;
    button.textContent = action === 'unreturn' ? 'Restoring…' : 'Returning…';
  }

  try {
    const path = action === 'unreturn'
      ? `/api/events/${eventId}/unreturn`
      : `/api/events/${eventId}/return`;
    await apiCall(path, 'POST', { assetId });
    returnPageState.pendingActions.delete(key);
    await returnPageRefreshSelected();
    playWorkflowTone('success');
    showNotification('success', action === 'unreturn'
      ? `${customAssetLabelFromId(assetId)} restored to the event`
      : `${customAssetLabelFromId(assetId)} returned successfully`);
  } catch (error) {
    returnPageState.pendingActions.delete(key);
    playWorkflowTone('error');
    showNotification('error', `${action === 'unreturn' ? 'Undo return' : 'Return'} failed: ${error.message}`);
    try {
      await returnPageRefreshSelected();
    } catch (refreshError) {
      console.warn('Return workspace reconciliation failed:', refreshError);
    }
  } finally {
    returnPageState.pendingActions.delete(key);
    if (button?.isConnected) button.disabled = false;
  }
}

function returnPageReturnAsset(encodedAssetId, button) {
  return returnPageRunAssetAction('return', encodedAssetId, button);
}

function returnPageUnreturnAsset(encodedAssetId, button) {
  return returnPageRunAssetAction('unreturn', encodedAssetId, button);
}

async function returnPageChangePreparedQuantity(action, encodedAssetId, quantity, button) {
  const assetId = returnPageDecode(encodedAssetId);
  const asset = returnPageAssets().find(row => row.id === assetId && row.isPreparedModelQuantity);
  const eventId = Number(returnPageState.eventId);
  const safeQuantity = Math.max(0, Number.parseInt(quantity, 10) || 0);
  const key = `prepared-model:${assetId}`;
  if (!eventId || !asset || safeQuantity <= 0 || returnPageState.pendingActions.has(key)) return;

  returnPageState.pendingActions.add(key);
  if (button) button.disabled = true;
  try {
    const path = action === 'unreturn'
      ? `/api/events/${eventId}/unreturn-prepared-quantity`
      : `/api/events/${eventId}/return-prepared-quantity`;
    const response = await apiCall(path, 'POST', {
      department: asset.department,
      brand: asset.brand,
      model: asset.model,
      description: asset.description,
      quantity: safeQuantity,
      subprojectId: eventActiveSubproject(returnPageState, returnPageState.event)?.id || '',
    });
    await returnPageRefreshSelected();
    playWorkflowTone('success');
    showNotification('success', response.message || (
      action === 'unreturn' ? 'Returned quantity restored' : 'Prepared quantity returned'
    ));
  } catch (error) {
    playWorkflowTone('error');
    showNotification('error', `${action === 'unreturn' ? 'Unreturn' : 'Return'} failed: ${error.message}`);
    try {
      await returnPageRefreshSelected();
    } catch (refreshError) {
      console.warn('Return workspace reconciliation failed:', refreshError);
    }
  } finally {
    returnPageState.pendingActions.delete(key);
    if (button?.isConnected) button.disabled = false;
  }
}

async function returnPagePromptPreparedQuantity(action, encodedAssetId, button) {
  const assetId = returnPageDecode(encodedAssetId);
  const asset = returnPageAssets().find(row => row.id === assetId && row.isPreparedModelQuantity);
  if (!asset) return;
  const max = action === 'unreturn'
    ? Math.max(0, Number(asset.returnedPreparedQuantity || 0))
    : Math.max(0, Number(asset.outstandingQuantity || 0));
  if (max <= 0) return;
  button?.closest('details')?.removeAttribute('open');
  const quantity = await prepareNewPromptQuantity({
    title: action === 'unreturn' ? 'Unreturn Qty' : 'Return Qty',
    message: `How many ${returnPageAssetTitle(asset)} unit(s) would you like to ${action === 'unreturn' ? 'unreturn' : 'return'}?`,
    confirmText: action === 'unreturn' ? 'Unreturn' : 'Return',
    max,
    defaultValue: max,
    inputLabel: action === 'unreturn' ? 'Quantity to restore' : 'Quantity returned',
  });
  if (quantity > 0) {
    await returnPageChangePreparedQuantity(action, encodedAssetId, quantity, button);
  }
}

async function returnPageReturnDepartment(encodedDepartment, button) {
  const eventId = Number(returnPageState.eventId);
  const department = normalizeDepartmentCode(returnPageDecode(encodedDepartment));
  const key = `department:${department}`;
  if (!eventId || returnPageState.pendingActions.has(key)) return;
  returnPageState.pendingActions.add(key);
  if (button) {
    button.disabled = true;
    button.textContent = 'Returning…';
  }
  try {
    if (eventSubprojects(returnPageState.event).length > 1) {
      const targets = returnPageAssets().filter(asset => (
        asset.department === department && !asset.isReturned
      ));
      for (const asset of targets) {
        if (asset.isPreparedModelQuantity) {
          await apiCall(`/api/events/${eventId}/return-prepared-quantity`, 'POST', {
            department: asset.department,
            brand: asset.brand,
            model: asset.model,
            description: asset.description,
            quantity: asset.outstandingQuantity,
            subprojectId: eventActiveSubproject(returnPageState, returnPageState.event)?.id || '',
          });
        } else {
          await apiCall(`/api/events/${eventId}/return`, 'POST', { assetId: asset.id });
        }
      }
      await returnPageRefreshSelected();
      showNotification('success', `${targets.length} item(s) returned for ${department}`);
      return;
    }
    const response = await apiCall(
      `/api/events/${eventId}/return-department`,
      'POST',
      { department }
    );
    const returned = response.returned || response.data?.returned || [];
    await returnPageRefreshSelected();
    showNotification('success', `${returned.length} item(s) returned for ${department}`);
  } catch (error) {
    showNotification('error', `Failed to return ${department}: ${error.message}`);
    try {
      await returnPageRefreshSelected();
    } catch (refreshError) {
      console.warn('Return workspace reconciliation failed:', refreshError);
    }
  } finally {
    returnPageState.pendingActions.delete(key);
    if (button?.isConnected) button.disabled = false;
  }
}

async function returnPageManualReturn() {
  const eventId = Number(returnPageState.eventId);
  const input = document.getElementById('returnQuickAssetInput');
  const submit = document.getElementById('returnQuickSubmit');
  let assetId = normalizeScannedIdentifier(input?.value || '');
  const scannedValue = assetId;
  returnPageState.quickReturnValue = String(input?.value || '');
  if (!eventId) {
    showNotification('warning', 'Select an event first');
    return;
  }
  if (!assetId) {
    showNotification('warning', 'Enter an asset ID, container ID, or serial number');
    input?.focus();
    return;
  }

  try {
    const inventoryAssets = await ensureAssetsLoaded();
    assetId = getAssetIdFromIdentifier(assetId, inventoryAssets);
  } catch (error) {
    console.warn('Could not resolve scanned return identifier locally:', error);
  }

  const key = `return:${assetId}`;
  if (returnPageState.pendingActions.has(key)) return;
  returnPageState.pendingActions.add(key);
  if (submit) {
    submit.disabled = true;
    submit.textContent = 'Returning…';
  }

  try {
    const response = await apiCall(`/api/events/${eventId}/return`, 'POST', { assetId });
    const queuedValue = normalizeScannedIdentifier(input?.value || '') !== normalizeScannedIdentifier(scannedValue)
      ? String(input?.value || '')
      : '';
    clearWorkflowScanInput(input, scannedValue);
    returnPageState.quickReturnValue = queuedValue;
    await returnPageRefreshSelected({ focusId: 'returnQuickAssetInput' });
    const refreshedInput = document.getElementById('returnQuickAssetInput');
    if (queuedValue && refreshedInput && !refreshedInput.value) refreshedInput.value = queuedValue;
    playWorkflowTone('success');
    const returnedContainerId = String(response?.data?.containerId || '');
    const returnedContainerAssets = Array.isArray(response?.data?.returned)
      ? response.data.returned.length
      : 0;
    showNotification(
      'success',
      returnedContainerId
        ? `${returnedContainerAssets} asset(s) returned from container ${returnedContainerId}`
        : `${customAssetLabelFromId(assetId)} returned successfully`
    );
  } catch (error) {
    playWorkflowTone('error');
    showNotification('error', `Return failed: ${error.message}`);
    if (input) {
      input.focus();
    }
    try {
      await returnPageRefreshSelected({ focusId: 'returnQuickAssetInput' });
    } catch (refreshError) {
      console.warn('Return workspace reconciliation failed:', refreshError);
    }
  } finally {
    returnPageState.pendingActions.delete(key);
    const currentInput = document.getElementById('returnQuickAssetInput');
    if (currentInput && getEventReturnableCount(returnPageState.event) > 0) {
      currentInput.focus({ preventScroll: true });
    }
  }
}

async function returnPageExit() {
  await returnPageFlushNotesSave();
  const eventId = Number(returnPageState.eventId);
  const metrics = returnPageMetrics();
  if (!eventId || metrics.total <= 0 || metrics.remaining > 0) {
    showSection('events');
    return;
  }

  try {
    await apiCall(`/api/events/${eventId}/close-return`, 'POST', {});
    showNotification('success', `Event ${eventId} closed`);
    returnPageState.eventId = null;
    returnPageState.event = null;
    returnPageState.loaded = false;
    await loadReturnWorkspace({ preservePosition: false, keepSelection: false });
  } catch (error) {
    showNotification('error', `Failed to close event: ${error.message}`);
  }
}

function scanForReturn() {
  const eventPicker = document.getElementById('returnEventPickerButton');
  const eventId = returnPageState.eventId;

  if (!eventId) {
    showNotification('warning', 'Select an event first');
    eventPicker?.focus();
    return;
  }

  openBarcodeScanner({
    title: 'Scan To Return',
    instructions: 'Scan an asset ID, barcode, serial number, or container ID to return it from the selected event.',
    onScan: async identifier => {
      const input = document.getElementById('returnQuickAssetInput');
      if (input) input.value = identifier;
      await returnPageManualReturn();
    }
  });
}
