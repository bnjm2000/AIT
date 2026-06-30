// Application state
let currentUser = null;
let events = [];
let assets = [];
let containers = [];
let logs = [];
let stats = {};
let departments = {};
let companyOptions = [];
let usersAdminUsers = [];
let usersAdminSort = { key: 'name', direction: 'asc' };
let departmentsLoaded = false;
let selectedInventoryAssetIds = new Set();
let expandedInventoryBulkDeploymentIds = new Set();
let maintenanceFlaggedAssets = [];
let __autoRefreshInFlight = false;
let __realtimeRefreshQueued = false;
let __realtimeRefreshTimer = null;
let __realtimeFallbackTimer = null;
let __realtimeSource = null;

const VIRTUAL_TABLE_OVERSCAN = 8;
const virtualTableStates = new Map();

function ensureVirtualTableStyles() {
  if (document.getElementById('virtual-table-styles')) return;

  const style = document.createElement('style');
  style.id = 'virtual-table-styles';
  style.textContent = `
    .virtual-table-scroll {
      max-height: none;
      overflow: auto;
      position: relative;
      overscroll-behavior: contain;
      -webkit-overflow-scrolling: touch;
    }

    .virtual-table-scroll thead th {
      background: #f8f9fa;
      position: sticky;
      top: 0;
      z-index: 4;
    }

    .virtual-table-scroll .virtual-table-spacer,
    .virtual-table-scroll .virtual-table-spacer:hover {
      background: transparent !important;
      box-shadow: none !important;
      pointer-events: none;
    }

    .virtual-table-scroll .virtual-table-spacer td {
      border: 0 !important;
      box-sizing: border-box;
      padding: 0 !important;
    }
  `;
  document.head.appendChild(style);
}

function destroyVirtualTable(stateKey) {
  const previous = virtualTableStates.get(stateKey);
  if (!previous) return;

  if (previous.resizeObserver) previous.resizeObserver.disconnect();
  if (previous.animationFrame) cancelAnimationFrame(previous.animationFrame);
  if (previous.resizeHandler) {
    window.removeEventListener('resize', previous.resizeHandler);
  }
  virtualTableStates.delete(stateKey);
}

function virtualTableIndexAtOffset(prefixHeights, offset) {
  let low = 0;
  let high = Math.max(0, prefixHeights.length - 1);

  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (prefixHeights[middle] <= offset) low = middle + 1;
    else high = middle;
  }

  return Math.max(0, low - 1);
}

function renderVirtualTable({
  stateKey,
  container,
  items,
  columnCount,
  headerHtml,
  rowHtml,
  tableClass = 'table',
  estimatedRowHeight = 58
}) {
  if (!container) return;

  ensureVirtualTableStyles();
  destroyVirtualTable(stateKey);

  const safeItems = Array.isArray(items) ? items : [];
  const heights = new Array(safeItems.length).fill(estimatedRowHeight);

  container.innerHTML = `
    <div class="responsive-table-wrap virtual-table-scroll" data-virtual-table="${escapeHtmlAttr(stateKey)}">
      <table class="${escapeHtmlAttr(tableClass)}" aria-rowcount="${safeItems.length + 1}">
        <thead>${headerHtml}</thead>
        <tbody></tbody>
      </table>
    </div>
  `;

  const scrollContainer = container.querySelector('.virtual-table-scroll');
  const tableBody = scrollContainer?.querySelector('tbody');
  if (!scrollContainer || !tableBody) return;

  const state = {
    animationFrame: null,
    endIndex: -1,
    heights,
    resizeObserver: null,
    resizeHandler: null,
    startIndex: -1
  };

  const fitScrollContainerToViewport = () => {
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
    const containerRect = scrollContainer.getBoundingClientRect();
    const containerTop = Math.max(0, containerRect.top);
    const visualScale = scrollContainer.offsetWidth > 0
      ? Math.max(0.1, containerRect.width / scrollContainer.offsetWidth)
      : 1;
    const availableHeight = Math.floor(
      (viewportHeight - containerTop - 20) / visualScale
    );
    const minimumHeight = Math.min(
      240,
      Math.max(160, (viewportHeight - 40) / visualScale)
    );
    const targetHeight = Math.max(minimumHeight, availableHeight);

    if (Math.abs(scrollContainer.clientHeight - targetHeight) > 1) {
      scrollContainer.style.height = `${targetHeight}px`;
    }
  };

  const scheduleRender = (force = false) => {
    if (state.animationFrame) cancelAnimationFrame(state.animationFrame);
    state.animationFrame = requestAnimationFrame(() => {
      state.animationFrame = null;
      renderWindow(force);
    });
  };

  const measureRenderedRows = () => {
    let changed = false;

    tableBody.querySelectorAll('tr[data-virtual-index]').forEach(row => {
      const index = Number(row.dataset.virtualIndex);
      const measuredHeight = row.getBoundingClientRect().height;
      if (
        Number.isInteger(index) &&
        index >= 0 &&
        index < state.heights.length &&
        measuredHeight > 0 &&
        Math.abs(state.heights[index] - measuredHeight) > 0.5
      ) {
        state.heights[index] = measuredHeight;
        changed = true;
      }
    });

    if (changed) scheduleRender(true);
    return changed;
  };

  function renderWindow(force = false) {
    if (!safeItems.length) {
      tableBody.innerHTML = '';
      return;
    }

    const prefixHeights = new Array(state.heights.length + 1);
    prefixHeights[0] = 0;
    for (let index = 0; index < state.heights.length; index += 1) {
      prefixHeights[index + 1] = prefixHeights[index] + state.heights[index];
    }

    const viewportHeight = Math.max(scrollContainer.clientHeight, 480);
    const startIndex = Math.max(
      0,
      virtualTableIndexAtOffset(prefixHeights, scrollContainer.scrollTop) - VIRTUAL_TABLE_OVERSCAN
    );
    const endIndex = Math.min(
      safeItems.length,
      virtualTableIndexAtOffset(
        prefixHeights,
        scrollContainer.scrollTop + viewportHeight
      ) + VIRTUAL_TABLE_OVERSCAN + 1
    );

    if (!force && startIndex === state.startIndex && endIndex === state.endIndex) {
      return;
    }

    state.startIndex = startIndex;
    state.endIndex = endIndex;

    const topHeight = prefixHeights[startIndex];
    const bottomHeight = prefixHeights[safeItems.length] - prefixHeights[endIndex];
    const renderedRows = [];

    for (let index = startIndex; index < endIndex; index += 1) {
      const markup = rowHtml(safeItems[index], index);
      renderedRows.push(
        markup.replace(
          /<tr\b/,
          `<tr data-virtual-index="${index}" aria-rowindex="${index + 2}"`
        )
      );
    }

    tableBody.innerHTML = `
      <tr class="virtual-table-spacer" aria-hidden="true">
        <td colspan="${columnCount}" style="height:${topHeight}px"></td>
      </tr>
      ${renderedRows.join('')}
      <tr class="virtual-table-spacer" aria-hidden="true">
        <td colspan="${columnCount}" style="height:${bottomHeight}px"></td>
      </tr>
    `;

    requestAnimationFrame(measureRenderedRows);
  }

  scrollContainer.addEventListener('scroll', () => scheduleRender(false), { passive: true });
  state.resizeHandler = () => {
    fitScrollContainerToViewport();
    scheduleRender(true);
  };
  window.addEventListener('resize', state.resizeHandler, { passive: true });

  if (typeof ResizeObserver === 'function') {
    state.resizeObserver = new ResizeObserver(() => {
      fitScrollContainerToViewport();
      const rowHeightsChanged = measureRenderedRows();
      if (!rowHeightsChanged) scheduleRender(false);
    });
    state.resizeObserver.observe(scrollContainer);
    state.resizeObserver.observe(tableBody);
  }

  virtualTableStates.set(stateKey, state);
  fitScrollContainerToViewport();
  renderWindow(true);
  requestAnimationFrame(() => scheduleRender(true));
}

const REALTIME_CLIENT_ID = (() => {
  try {
    const existing = sessionStorage.getItem("avecRealtimeClientId");
    if (existing) return existing;
    const id = (crypto && crypto.randomUUID)
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    sessionStorage.setItem("avecRealtimeClientId", id);
    return id;
  } catch (error) {
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
})();

const DEFAULT_PDF_FOOTER_TEXT = "AVEC VISION PRIVATE LIMITED\n601 SIMS DRIVE PAN-I COMPLEX #04-10 SINGAPORE 387382 TEL 65.9743.3660 CO REG 202122775G";
let pdfSettings = {
  footerText: DEFAULT_PDF_FOOTER_TEXT,
  logoUrl: "/api/pdf-settings/logo",
  hasCustomLogo: false,
  logoOriginalName: "",
  updatedAt: ""
};

const DEFAULT_MAINTENANCE_LOG_TYPE = "General";
const ASSET_CHECK_MAINTENANCE_LOG_TYPE = "Asset check";
const USER_MAINTENANCE_LOG_TYPES = [
  DEFAULT_MAINTENANCE_LOG_TYPE,
  "Preventative maintenance",
  "Fault",
  "Update",
  "Repair"
];
const MAINTENANCE_LOG_TYPES = [
  ...USER_MAINTENANCE_LOG_TYPES,
  ASSET_CHECK_MAINTENANCE_LOG_TYPE
];

// ---------- containers cache ----------
let selectedContainerAssets = new Set();
let __containersCache = null;
let __containersCacheTs = 0;
let maintenanceReportSelectedAssetIds = new Set();
let maintenanceReportSelectedContainerIds = new Set();
let __maintenanceReportOutsideClickBound = false;

// keep cache reasonably fresh
async function refreshContainersCache(force = false) {
  const now = Date.now();
  if (!force && __containersCache && (now - __containersCacheTs) < 15000) {
    return __containersCache;
  }

  const res = await apiCall('/api/containers');
  const list = (res && res.data) ? res.data : [];
  __containersCache = {};
  list.forEach(c => { __containersCache[c.id] = c; });
  __containersCacheTs = now;
  return __containersCache;
}

function getContainerSerialNumber(container) {
  return String(container?.serialNumber || container?.serial || '').trim();
}

function findContainerInCacheByLookup(cache, lookup) {
  const raw = String(lookup || '').trim();
  if (!raw || !cache) return null;

  if (cache[raw]) return cache[raw];

  const rawLower = raw.toLowerCase();
  return Object.values(cache).find(container => {
    const serial = getContainerSerialNumber(container);
    return serial && serial.toLowerCase() === rawLower;
  }) || null;
}

async function getContainerById(containerId, force = false) {
  if (!containerId) return null;
  const cache = await refreshContainersCache(force);
  return findContainerInCacheByLookup(cache, containerId);
}

// used to avoid container recursion
window.__processingContainerBatch = false;

// HTML escaping helpers
function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function getEventStateClass(state) {
  return `state-${String(state || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')}`;
}

function isAdminUser() {
  return !!(currentUser && currentUser.isAdmin);
}

function isSuperAdminUser() {
  return !!(currentUser && currentUser.isSuperAdmin);
}

function applyPermissionUi() {
  const adminOnlySelectors = [
    ".admin-only",
    "[data-admin-only='true']"
  ];

  adminOnlySelectors.forEach(selector => {
    document.querySelectorAll(selector).forEach(el => {
      el.style.display = isAdminUser() ? (el.dataset.adminDisplay || 'block') : 'none';
    });
  });

  document.querySelectorAll(".super-admin-only, [data-super-admin-only='true']").forEach(el => {
    el.style.display = isSuperAdminUser() ? (el.dataset.superAdminDisplay || el.dataset.adminDisplay || 'block') : 'none';
  });

  // Older hard-coded Add Event buttons do not all have a class, so hide them by onclick.
  document.querySelectorAll('button').forEach(button => {
    if (button.getAttribute('onclick') === "openModal('addEventModal')") {
      button.style.display = isAdminUser() ? '' : 'none';
    }
  });
}

function openEventFromCalendar(eventId) {
  if (isAdminUser()) {
    editEvent(eventId);
  } else {
    viewEvent(eventId);
  }
}

function parseMaintenanceLogDateForPermission(dateStr) {
  if (!dateStr) return null;
  const parts = String(dateStr).trim().split(/[\/\-]/).map(Number);
  if (parts.length !== 3 || parts.some(n => !Number.isFinite(n))) return null;
  return new Date(parts[0], parts[1] - 1, parts[2]);
}

function canCurrentUserModifyMaintenanceLog(log) {
  if (isAdminUser()) return true;
  if (!currentUser || !log) return false;
  if (String(log.user || '') !== String(currentUser.username || '')) return false;

  const logDate = parseMaintenanceLogDateForPermission(log.date);
  if (!logDate || Number.isNaN(logDate.getTime())) return false;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  logDate.setHours(0, 0, 0, 0);
  const ageDays = Math.floor((today - logDate) / (1000 * 60 * 60 * 24));
  return ageDays >= 0 && ageDays <= 7;
}


// Attribute-safe escaping for inline handlers and data attributes.
function escapeHtmlAttr(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}


const CUSTOM_ASSET_PREFIX = '[CUSTOM]';

function parseCustomAsset(assetId, asset = null) {
  const raw = String(assetId || asset?.id || '');

  if (asset && (asset.isCustom || asset.isLoanOrMisc)) {
    const type = normalizeCustomType(asset.customType || (raw.startsWith('[LOAN]') ? 'LOAN' : 'MISC'));
    return {
      id: raw,
      type,
      name: asset.model || asset.name || asset.displayName || (type === 'LOAN' ? 'Loan/Rental Item' : 'Misc Item'),
      quantity: Math.max(1, parseInt(asset.quantity || 1, 10) || 1),
      department: normalizeDepartmentCode(asset.department || 'UN'),
      company: asset.company || asset.description || '',
      legacy: raw.startsWith('[LOAN]') || raw.startsWith('[MISC]') || raw.toLowerCase().startsWith('loan|') || raw.toLowerCase().startsWith('misc|')
    };
  }

  if (raw.startsWith(CUSTOM_ASSET_PREFIX)) {
    try {
      const data = JSON.parse(raw.slice(CUSTOM_ASSET_PREFIX.length));
      const type = normalizeCustomType(data.type || 'MISC');
      return {
        id: raw,
        uid: data.uid || '',
        type,
        name: String(data.name || (type === 'LOAN' ? 'Loan/Rental Item' : 'Misc Item')).trim(),
        quantity: Math.max(1, parseInt(data.quantity || 1, 10) || 1),
        department: normalizeDepartmentCode(data.department || 'UN'),
        company: String(data.company || '').trim(),
        legacy: false
      };
    } catch (e) {
      return null;
    }
  }

  const lower = raw.toLowerCase();
  if (lower.startsWith('loan|') || lower.startsWith('misc|')) {
    const fallbackType = lower.startsWith('loan|') ? 'LOAN' : 'MISC';
    const parsed = parseCustomAsset(raw.slice(raw.indexOf('|') + 1));
    if (parsed) parsed.type = fallbackType;
    return parsed;
  }

  let type = null;
  let rest = '';
  if (raw.startsWith('[LOAN]')) {
    type = 'LOAN';
    rest = raw.slice('[LOAN]'.length);
  } else if (raw.startsWith('[MISC]')) {
    type = 'MISC';
    rest = raw.slice('[MISC]'.length);
  }

  if (!type) return null;

  let name = rest.trim();
  let quantity = 1;
  const semi = rest.lastIndexOf(';');
  if (semi >= 0) {
    const possibleQty = parseInt(rest.slice(semi + 1), 10);
    if (Number.isFinite(possibleQty) && possibleQty > 0) {
      quantity = possibleQty;
      name = rest.slice(0, semi).trim();
    }
  }

  return {
    id: raw,
    type,
    name: name || (type === 'LOAN' ? 'Loan/Rental Item' : 'Misc Item'),
    quantity,
    department: 'UN',
    company: '',
    legacy: true
  };
}

function normalizeCustomType(type) {
  const value = String(type || 'MISC').trim().toUpperCase();
  return (value === 'LOAN' || value === 'RENTAL' || value === 'LOAN/RENTAL') ? 'LOAN' : 'MISC';
}

function isCustomAssetId(assetId) {
  return !!parseCustomAsset(assetId);
}

function customAssetDisplayName(custom, includeQuantity = true) {
  if (!custom) return '';
  const qty = Math.max(1, parseInt(custom.quantity || 1, 10) || 1);
  const name = String(custom.name || '').trim();
  return includeQuantity ? `${qty}x ${name}` : name;
}

function customAssetSortName(custom) {
  if (!custom) return '';
  return String(custom.name || customAssetDisplayName(custom, false) || '').trim();
}

function modelGroupSortName(modelGroup) {
  if (!modelGroup) return '';
  return [modelGroup.brand, modelGroup.model, modelGroup.description]
    .map(value => String(value || '').trim())
    .filter(Boolean)
    .join(' ');
}

function assetDisplaySortName(asset) {
  if (!asset) return '';
  const custom = asset.parsedCustom || parseCustomAsset(asset.id, asset);
  if (custom) return customAssetSortName(custom);

  const labelParts = [asset.brand, asset.model, asset.description, asset.name, asset.id]
    .map(value => String(value || '').trim())
    .filter(Boolean);

  if (asset.isBulk || String(asset.id || '').startsWith('[BULK]')) {
    const bulkParts = [asset.name, asset.brand, asset.model, asset.description, asset.id]
      .map(value => String(value || '').trim())
      .filter(Boolean);
    return bulkParts.join(' ');
  }

  return labelParts.join(' ');
}

function compareByDisplayName(a, b) {
  return String(a || '').localeCompare(String(b || ''), undefined, {
    numeric: true,
    sensitivity: 'base'
  });
}

function customAssetTypeBadge(custom) {
  if (!custom) return '';
  if (custom.type === 'LOAN') {
    return '<span class="asset-badge status-deployed" style="margin-left:8px;">Loan/Rental</span>';
  }
  return '<span class="asset-badge status-available" style="margin-left:8px;">Misc</span>';
}

function customAssetLabelFromId(assetId, asset = null) {
  const custom = parseCustomAsset(assetId, asset);
  return custom ? customAssetDisplayName(custom) : String(assetId || '');
}

function customDepartmentOptionsHtml(selected = 'UN') {
  const list = (typeof sortedDepartmentList === 'function' ? sortedDepartmentList() : Object.values(departments || {}));
  const fallback = list && list.length ? list : [
    { code: 'AX', name: 'Audio' },
    { code: 'LX', name: 'Lighting' },
    { code: 'VX', name: 'Video' },
    { code: 'UN', name: 'Unknown' }
  ];
  const selectedCode = normalizeDepartmentCode(selected || 'UN');
  return fallback.map(dept => {
    const code = normalizeDepartmentCode(dept.code);
    const title = dept.name && dept.name !== code ? `${code} - ${dept.name}` : code;
    return `<option value="${escapeHtmlAttr(code)}" title="${escapeHtmlAttr(title)}" ${code === selectedCode ? 'selected' : ''}>${escapeHtml(code)}</option>`;
  }).join('');
}

function departmentCodeToDoName(code) {
  const raw = String(code || '').trim();
  if (!raw) return 'MISC';

  // Existing DO labels should stay stable.
  if (['Audio', 'Lighting', 'Video', 'MISC'].includes(raw)) return raw;

  const normalized = normalizeDepartmentCode(raw);
  if (normalized === 'AX') return 'Audio';
  if (normalized === 'LX') return 'Lighting';
  if (normalized === 'VX') return 'Video';
  if (normalized === 'MISC' || normalized === 'LOAN' || normalized === 'UN') return 'MISC';

  // For admin-created departments such as STG, keep them as their own DO section
  // instead of falling back to MISC.
  const dept = departments && departments[normalized] ? departments[normalized] : null;
  if (dept && dept.name && dept.name !== normalized && !['Unknown', 'Misc', 'Loan'].includes(dept.name)) {
    return dept.name;
  }

  return normalized;
}

function getDefaultDoDepartments() {
  return ['Audio', 'Lighting', 'Video', 'MISC'];
}

function ensureDoEditBuckets(data, deptNames = []) {
  data.overrides ||= {};
  data.custom ||= {};
  data.ordering ||= {};

  const dynamicDeptNames = [];
  try {
    Object.values(departments || {}).forEach(dept => {
      const name = departmentCodeToDoName(dept.code || dept.name);
      if (name && !dynamicDeptNames.includes(name)) dynamicDeptNames.push(name);
    });
  } catch {}

  [...getDefaultDoDepartments(), ...dynamicDeptNames, ...deptNames].forEach(dept => {
    if (!dept) return;
    data.custom[dept] ||= [];
  });

  return data;
}

function getDoDepartmentList(groupedDepartments = {}, edits = null) {
  const names = new Set(getDefaultDoDepartments());
  Object.keys(groupedDepartments || {}).forEach(name => names.add(name));
  Object.keys((edits && edits.custom) || {}).forEach(name => names.add(name));

  const preferred = getDefaultDoDepartments();
  return Array.from(names).sort((a, b) => {
    const ai = preferred.indexOf(a);
    const bi = preferred.indexOf(b);
    if (ai !== -1 || bi !== -1) {
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    }
    return String(a).localeCompare(String(b), undefined, { numeric: true });
  });
}

function getDepartmentCodeForDoName(name) {
  if (name === 'Audio') return 'AX';
  if (name === 'Lighting') return 'LX';
  if (name === 'Video') return 'VX';
  if (name === 'MISC') return 'MISC';

  const found = Object.values(departments || {}).find(dept => departmentCodeToDoName(dept.code) === name);
  return found ? normalizeDepartmentCode(found.code) : normalizeDepartmentCode(name);
}

// status badge renderer (used by selectors)


function getPreparedQuantity(modelGroup) {
  if (!modelGroup) return 0;
  if (typeof modelGroup.preparedQuantity !== 'undefined') {
    return Number(modelGroup.preparedQuantity || 0);
  }
  return (modelGroup.assignedAssets || [])
    .filter(asset => asset.status !== 'returned')
    .reduce((sum, asset) => sum + Number(asset.quantity || 1), 0);
}

function getCountablePreparedQuantity(modelGroup) {
  if (!modelGroup) return 0;
  if (typeof modelGroup.countablePreparedQuantity !== 'undefined') {
    return Number(modelGroup.countablePreparedQuantity || 0);
  }

  const required = Number(modelGroup.requiredQuantity || 0);
  const prepared = (modelGroup.assignedAssets || [])
    .filter(asset => !asset.isExtra && asset.status !== 'returned')
    .reduce((sum, asset) => sum + Number(asset.quantity || 1), 0);

  return required > 0 ? Math.min(prepared, required) : prepared;
}

function getExtraPreparedQuantity(modelGroup) {
  if (!modelGroup) return 0;
  if (typeof modelGroup.extraPreparedQuantity !== 'undefined') {
    return Number(modelGroup.extraPreparedQuantity || 0);
  }
  return (modelGroup.assignedAssets || [])
    .filter(asset => asset.isExtra && asset.status !== 'returned')
    .reduce((sum, asset) => sum + Number(asset.quantity || 1), 0);
}

function getEventExtraQuantity(event) {
  if (!event) return 0;
  if (typeof event.totalExtraAssets !== 'undefined') {
    return Number(event.totalExtraAssets || 0);
  }
  if (typeof event.extraCount !== 'undefined') {
    return Number(event.extraCount || 0);
  }
  return Array.isArray(event.extraAssets) ? event.extraAssets.length : 0;
}

const PREPARE_QUICK_ADD_STORAGE_KEY = 'aim.prepare.quickAddEnabled';

function getPrepareQuickAddEnabled() {
  try {
    return localStorage.getItem(PREPARE_QUICK_ADD_STORAGE_KEY) === 'true';
  } catch (error) {
    return false;
  }
}

function setPrepareQuickAddEnabled(enabled) {
  const isEnabled = !!enabled;
  try {
    localStorage.setItem(PREPARE_QUICK_ADD_STORAGE_KEY, isEnabled ? 'true' : 'false');
  } catch (error) {}

  const toggle = document.getElementById('prepareQuickAddToggle');
  const state = document.getElementById('prepareQuickAddToggleState');
  if (toggle) toggle.checked = isEnabled;
  if (state) {
    state.textContent = isEnabled ? 'On' : 'Off';
    state.style.background = isEnabled ? '#d4edda' : '#e9ecef';
    state.style.color = isEnabled ? '#155724' : '#495057';
  }
}

function handlePrepareQuickAddToggle(toggle) {
  setPrepareQuickAddEnabled(!!toggle?.checked);
}

function prepareQuickAddPayload() {
  const quickAdd = getPrepareQuickAddEnabled();
  return {
    quickAdd,
    addScannedAssetsToEvent: quickAdd,
    source: quickAdd ? 'quick-add' : 'manual-scan'
  };
}

function ensurePrepareQuickAddToggleStyles() {
  if (document.getElementById('prepare-quick-add-toggle-styles')) return;

  const style = document.createElement('style');
  style.id = 'prepare-quick-add-toggle-styles';
  style.textContent = `
    .prepare-quick-add-switch {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      min-height: 32px;
      padding: 4px 8px;
      border-radius: 999px;
      background: rgba(255,255,255,0.75);
      border: 1px solid rgba(21,87,36,0.18);
      cursor: pointer;
      user-select: none;
    }
    .prepare-quick-add-switch input {
      position: absolute;
      opacity: 0;
      pointer-events: none;
    }
    .prepare-quick-add-switch-slider {
      position: relative;
      width: 42px;
      height: 24px;
      border-radius: 999px;
      background: #adb5bd;
      transition: background 0.2s ease;
      flex: 0 0 auto;
    }
    .prepare-quick-add-switch-slider::after {
      content: '';
      position: absolute;
      top: 3px;
      left: 3px;
      width: 18px;
      height: 18px;
      border-radius: 50%;
      background: white;
      box-shadow: 0 1px 3px rgba(0,0,0,0.25);
      transition: transform 0.2s ease;
    }
    .prepare-quick-add-switch input:checked + .prepare-quick-add-switch-slider {
      background: #28a745;
    }
    .prepare-quick-add-switch input:checked + .prepare-quick-add-switch-slider::after {
      transform: translateX(18px);
    }
    .prepare-quick-add-switch input:focus-visible + .prepare-quick-add-switch-slider {
      outline: 2px solid #155724;
      outline-offset: 2px;
    }
    .prepare-quick-add-switch-label {
      font-weight: 700;
      color: #155724;
      font-size: 13px;
      line-height: 1;
      white-space: nowrap;
    }
    .prepare-quick-add-switch-state {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 34px;
      padding: 3px 7px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 700;
      line-height: 1;
      transition: background 0.2s ease, color 0.2s ease;
    }
  `;
  document.head.appendChild(style);
}


function getAssetIdentifierForApi(asset) {
  return asset?.internalId || asset?.bulkId || asset?.id || '';
}

function getAssetByApiIdentifier(assetId, assetList = assets) {
  const normalized = String(assetId || '').trim();
  if (!normalized || !Array.isArray(assetList)) return null;
  const lower = normalized.toLowerCase();
  return assetList.find(asset => {
    if (!asset) return false;
    return [
      getAssetIdentifierForApi(asset),
      asset.id,
      asset.internalId,
      asset.bulkId,
      asset.displayId
    ].some(value => String(value || '').trim().toLowerCase() === lower);
  }) || null;
}

function assetMaintenanceDisplayId(asset) {
  if (!asset) return '';
  if (asset.isBulk) return getAssetIdentifierForApi(asset) || 'Bulk Item';
  return asset.id || getAssetIdentifierForApi(asset);
}

function assetMaintenanceDisplayName(asset) {
  if (!asset) return '';
  const id = assetMaintenanceDisplayId(asset);
  const name = [asset.brand, asset.model, asset.description]
    .map(value => String(value || '').trim())
    .filter(Boolean)
    .join(' ');
  return asset.isBulk ? `${name || 'Bulk Item'} (${id})` : (id || name);
}

function normalizeAssetPurchaseDateValue(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';

  const isoMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) return raw;

  const slashMatch = raw.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (slashMatch) {
    return `${slashMatch[1]}-${slashMatch[2].padStart(2, '0')}-${slashMatch[3].padStart(2, '0')}`;
  }

  const compactMatch = raw.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compactMatch) return `${compactMatch[1]}-${compactMatch[2]}-${compactMatch[3]}`;

  return raw;
}

function formatAssetPurchaseDate(value) {
  const normalized = normalizeAssetPurchaseDateValue(value);
  const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return normalized || '—';
  return `${match[1]}/${match[2]}/${match[3]}`;
}

function isAssetDegraded(asset) {
  if (!asset) return false;
  if (asset.isBulk) return !!asset.isDegraded;
  return !!(asset.isDegraded || asset.status === 'degraded');
}

function maintenanceLogMarksStatus(log, status, action = 'marked') {
  const record = normalizeMaintenanceLogRecord(log);
  const targetStatus = String(status || '').trim().toLowerCase();
  const targetAction = String(action || '').trim().toLowerCase();
  return (record.changes || []).some(change =>
    String(change.kind || '').trim().toLowerCase() === targetStatus &&
    String(change.action || '').trim().toLowerCase() === targetAction
  );
}

function cleanDegradedReasonText(value, maxLength = 240) {
  const reason = String(value || '').replace(/\s+/g, ' ').trim();
  if (!reason) return '';
  return reason.length > maxLength ? `${reason.slice(0, maxLength - 1).trim()}...` : reason;
}

function getAssetDegradedReasons(asset, limit = 3) {
  if (!asset) return [];

  const directReasons = Array.isArray(asset.degradedReasons)
    ? asset.degradedReasons.map(reason => cleanDegradedReasonText(reason)).filter(Boolean)
    : [];
  if (directReasons.length) return directReasons.slice(0, limit);

  let activeReason = '';
  getMaintenanceLogRecords(asset).forEach(log => {
    if (maintenanceLogMarksStatus(log, 'degraded', 'marked')) {
      activeReason = cleanDegradedReasonText(log.description);
    }
    if (maintenanceLogMarksStatus(log, 'degraded', 'cleared')) {
      activeReason = '';
    }
  });

  return activeReason ? [activeReason] : [];
}

function degradedReasonMessage(reasons) {
  const cleanReasons = (reasons || []).map(reason => cleanDegradedReasonText(reason)).filter(Boolean);
  if (!cleanReasons.length) return '';
  return cleanReasons.length === 1
    ? `\n\nReason: ${cleanReasons[0]}`
    : `\n\nReasons:\n${cleanReasons.map(reason => `- ${reason}`).join('\n')}`;
}

function normalizeAssetAuditDateTime(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return raw.replace('T', ' ').replace(/\.\d+$/, '');
}

function formatAssetAuditDateTime(value) {
  const normalized = normalizeAssetAuditDateTime(value);
  const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{2}):(\d{2})(?::\d{2})?)?$/);
  if (!match) return normalized || '-';
  return `${match[1]}/${match[2]}/${match[3]}`;
}

function assetAuditValueText(value) {
  if (value === true) return 'Yes';
  if (value === false) return 'No';
  const text = String(value ?? '').trim();
  return text || 'Blank';
}

function assetChangeHistoryHtml(asset) {
  const history = Array.isArray(asset?.changeHistory) ? asset.changeHistory : [];
  if (!history.length) {
    return '<div style="color:#666;font-size:13px;">No manual edit history yet.</div>';
  }

  return history
    .slice()
    .reverse()
    .map(record => {
      const changes = Array.isArray(record.changes) ? record.changes : [];
      const changeRows = changes.length
        ? changes.map(change => `
            <li style="margin:4px 0;">
              <strong>${escapeHtml(change.label || change.field || 'Field')}</strong>:
              ${escapeHtml(assetAuditValueText(change.old))}
              &rarr;
              ${escapeHtml(assetAuditValueText(change.new))}
            </li>
          `).join('')
        : '<li style="margin:4px 0;">Updated asset record</li>';

      return `
        <div style="border-top:1px solid #e9ecef;padding:10px 0;">
          <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;font-size:13px;color:#495057;">
            <strong>${escapeHtml(record.action === 'created' ? 'Created' : 'Updated')}</strong>
            <span>${escapeHtml(formatAssetAuditDateTime(record.date))}${record.user ? ` by ${escapeHtml(record.user)}` : ''}</span>
          </div>
          <ul style="margin:6px 0 0 18px;padding:0;font-size:13px;color:#495057;">
            ${changeRows}
          </ul>
        </div>
      `;
    })
    .join('');
}

function isAssetDisposed(asset) {
  return !!(asset && (asset.isDisposed || asset.isDecommissioned || asset.status === 'disposed' || asset.status === 'decommissioned'));
}

function assetStatusClass(status) {
  return `status-${String(status || 'available').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-')}`;
}

function statusBadgeHtml(status, label = null) {
  const cleanStatus = String(status || 'available').trim().toLowerCase() || 'available';
  const text = label || cleanStatus.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  return `<span class="asset-badge ${assetStatusClass(cleanStatus)}">${escapeHtml(text)}</span>`;
}

function safePdfHexColour(value, fallback) {
  const colour = String(value || '').trim();
  return /^#[0-9A-Fa-f]{6}$/.test(colour) ? colour : fallback;
}

function pdfInlineBadgeHtml(label, background, color, options = {}) {
  const bg = safePdfHexColour(background, '#e5e7eb');
  const fg = safePdfHexColour(color, getReadableTextColour(bg));
  const extraStyle = options.style ? String(options.style) : '';
  const title = options.title ? ` title="${escapeHtmlAttr(options.title)}"` : '';
  return `<span${title} style="display:inline-block;padding:2px 6px;border-radius:999px;font-size:.95em;font-weight:700;line-height:1.2;white-space:nowrap;background:${bg};color:${fg};-webkit-print-color-adjust:exact;print-color-adjust:exact;${extraStyle}">${escapeHtml(label)}</span>`;
}

function getAssetConditionStatus(asset) {
  if (!asset) return 'available';
  if (asset.isDisposed || asset.isDecommissioned || asset.status === 'disposed' || asset.status === 'decommissioned') return 'decommissioned';
  if (asset.isMissing || asset.status === 'missing') return 'missing';
  if (asset.isOOC || asset.status === 'ooc') return 'ooc';
  if (asset.isDegraded || asset.status === 'degraded') return 'degraded';
  return 'available';
}

// Shared by selectors that are initialized both inside and outside the
// DOMContentLoaded handler.
function getAssetStatusBadge(asset) {
  if (!asset) return statusBadgeHtml('available', 'Available');

  const condition = getAssetConditionStatus(asset);
  if (condition !== 'available') {
    const label = condition === 'ooc'
      ? 'OOC'
      : condition.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    return statusBadgeHtml(condition, label);
  }
  if (asset.status === 'deployed') return statusBadgeHtml('deployed', 'Deployed');

  return statusBadgeHtml('available', 'Available');
}

function assetFlagBadgesHtml(asset) {
  if (asset?.isBulk) {
    const badges = [];
    const oocQty = Math.max(0, Number(asset.bulkOOCQuantity || 0) || 0);
    const missingQty = Math.max(0, Number(asset.bulkMissingQuantity || 0) || 0);
    const degradedQty = Math.max(0, Number(asset.bulkDegradedQuantity || 0) || 0);
    let hasOOCBadge = false;
    let hasMissingBadge = false;
    let hasDegradedBadge = false;
    if (asset.isMissing || asset.status === 'missing') {
      badges.push(statusBadgeHtml('missing', missingQty ? `${missingQty} Missing` : 'Missing'));
      hasMissingBadge = true;
    }
    if (asset.isOOC || asset.status === 'ooc') {
      badges.push(statusBadgeHtml('ooc', oocQty ? `${oocQty} OOC` : 'OOC'));
      hasOOCBadge = true;
    }
    if (asset.isDegraded || asset.status === 'degraded') {
      badges.push(statusBadgeHtml('degraded', degradedQty ? `${degradedQty} Degraded` : 'Degraded'));
      hasDegradedBadge = true;
    }
    if (asset.isDisposed || asset.isDecommissioned || asset.status === 'disposed' || asset.status === 'decommissioned') badges.push(statusBadgeHtml('decommissioned', 'Decommissioned'));
    if (!hasOOCBadge && oocQty > 0) badges.push(statusBadgeHtml('ooc', `${oocQty} OOC`));
    if (!hasMissingBadge && missingQty > 0) badges.push(statusBadgeHtml('missing', `${missingQty} Missing`));
    if (!hasDegradedBadge && degradedQty > 0) badges.push(statusBadgeHtml('degraded', `${degradedQty} Degraded`));
    return badges.length ? badges.join(' ') : statusBadgeHtml('available', 'OK');
  }

  const status = getAssetConditionStatus(asset);
  const label = status === 'available'
    ? 'OK'
    : (status === 'ooc' ? 'OOC' : status.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()));
  return statusBadgeHtml(status, label);
}

function maintenanceStatusMeta(value) {
  const cleanValue = String(value || 'nochange').trim().toLowerCase();
  const map = {
    nochange: { label: 'No Change', color: '#495057' },
    ok: { label: 'OK / Clear Status', color: '#28a745' },
    ooc: { label: 'OOC', color: '#dc3545' },
    missing: { label: 'Missing', color: '#fd7e14' },
    degraded: { label: 'Degraded', color: '#856404' },
    decommissioned: { label: 'Decommissioned', color: '#6c757d' },
    disposed: { label: 'Decommissioned', color: '#6c757d' }
  };
  return map[cleanValue] || map.nochange;
}

function applyMaintenanceStatusSelectStyle(selectEl) {
  if (!selectEl) return;

  const meta = maintenanceStatusMeta(selectEl.value);
  selectEl.style.color = meta.color;
  selectEl.style.fontWeight = selectEl.value === 'nochange' ? '400' : '600';
  selectEl.style.borderColor = meta.color;

  Array.from(selectEl.options || []).forEach(option => {
    const optionMeta = maintenanceStatusMeta(option.value);
    option.style.color = optionMeta.color;
    option.style.fontWeight = option.value === 'nochange' ? '400' : '600';
  });
}

function initialiseMaintenanceStatusSelects(root = document) {
  root.querySelectorAll('[data-maintenance-status-select="true"]').forEach(selectEl => {
    applyMaintenanceStatusSelectStyle(selectEl);
    if (selectEl.dataset.statusColourBound === 'true') return;
    selectEl.addEventListener('change', () => applyMaintenanceStatusSelectStyle(selectEl));
    selectEl.dataset.statusColourBound = 'true';
  });
}

function maintenanceStatusSelectHtml(id, name, selected = 'nochange') {
  const value = String(selected || 'nochange');
  const option = (optionValue) => {
    const meta = maintenanceStatusMeta(optionValue);
    return `<option value="${optionValue}" style="color:${meta.color};font-weight:${optionValue === 'nochange' ? '400' : '600'};" ${value === optionValue ? 'selected' : ''}>${meta.label}</option>`;
  };
  return `
    <select id="${id}" name="${name}" class="form-input" data-maintenance-status-select="true" onchange="applyMaintenanceStatusSelectStyle(this)">
      ${option('nochange')}
      ${option('ok')}
      ${option('ooc')}
      ${option('missing')}
      ${option('degraded')}
      ${option('decommissioned')}
    </select>
    <small style="color:#666;font-size:12px;margin-top:6px;display:block;">
      Assets can only have one status. To change a non-OK asset to another status, mark it as OK first.
    </small>
  `;
}


async function confirmDegradedAssetUse(assetId, assetDetails = null) {
  const identifier = getAssetIdentifierForApi(assetDetails) || assetId;
  const fullAsset = getAssetByApiIdentifier(identifier);
  const asset = assetDetails
    ? {
        ...assetDetails,
        maintenanceLogRecords: (
          Array.isArray(assetDetails.maintenanceLogRecords) && assetDetails.maintenanceLogRecords.length
            ? assetDetails.maintenanceLogRecords
            : fullAsset?.maintenanceLogRecords
        ),
        maintenanceLogs: (
          Array.isArray(assetDetails.maintenanceLogs) && assetDetails.maintenanceLogs.length
            ? assetDetails.maintenanceLogs
            : fullAsset?.maintenanceLogs
        ),
        degradedReasons: (
          Array.isArray(assetDetails.degradedReasons) && assetDetails.degradedReasons.length
            ? assetDetails.degradedReasons
            : fullAsset?.degradedReasons
        ),
      }
    : fullAsset;

  if (!isAssetDegraded(asset)) return true;

  const label = [asset?.brand, asset?.model, asset?.description].filter(Boolean).join(' ');
  const reasons = getAssetDegradedReasons(asset);
  return showAppConfirm({
    title: 'Degraded Asset',
    message: `${identifier}${label ? ` (${label})` : ''} is marked as Degraded.${degradedReasonMessage(reasons)}\n\nIt can still be used for show, but it may not be fully functional. Continue preparing this asset?`,
    confirmText: 'Continue',
    cancelText: 'Cancel',
    variant: 'warning',
  });
}

function showApiWarning(response) {
  if (response && response.warning) {
    return showAppAlert({
      title: 'Warning',
      message: response.warning,
      variant: 'warning',
    });
  }
  return Promise.resolve();
}


function getAssignedAssetDisplay(asset) {
  if (!asset) return '';
  if (asset.isBulk) return `${asset.name || 'Bulk Item'} (Qty: ${asset.quantity || 1})`;
  return asset.id || '';
}


// Delivery Order edit state
function getDoEdits(eventId, deptNames = []) {
  const blank = ensureDoEditBuckets({ overrides: {}, custom: {}, ordering: {} }, deptNames);
  try {
    const raw = localStorage.getItem(`doEdits/${eventId}`);
    if (!raw) return blank;
    const data = JSON.parse(raw);
    return ensureDoEditBuckets(data, deptNames);
  } catch { return blank; }
}
function saveDoEdits(eventId, data) {
  localStorage.setItem(`doEdits/${eventId}`, JSON.stringify(ensureDoEditBuckets(data)));
}
function clearDoEdits(eventId) {
  localStorage.removeItem(`doEdits/${eventId}`);
}
/* stable key for model-group rows */
function makeModelKey(mg) {
  return `MG|${mg.department||''}|${mg.brand||''}|${mg.model||''}`;
}

function makeQtyInputId(department, brand, model, description = '') {
  const raw = `${department || ''}|${brand || ''}|${model || ''}`;

  return `qty-${encodeURIComponent(raw)
    .replace(/%/g, '_')
    .replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

let isClickHandlerSetup = false;
let processingAssets = new Set();

// Date formatting for server-provided event dates.
function formatDate(dateStr) {
  if (!dateStr) return '';
  
  // Handle YYYY/MM/DD format from backend
  if (dateStr.includes('/')) {
    const dateParts = dateStr.split('/');
    if (dateParts.length === 3) {
      const [year, month, day] = dateParts;
      const isoDate = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
      return new Date(isoDate).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
    }
  }
  
  // Fallback for other date formats
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

// Function to convert YYYY/MM/DD to YYYY-MM-DD for HTML date inputs
function formatDateForInput(dateStr) {
  if (!dateStr) return '';
  
  // Handle YYYY/MM/DD format from backend
  if (dateStr.includes('/')) {
    const dateParts = dateStr.split('/');
    if (dateParts.length === 3) {
      const [year, month, day] = dateParts;
      return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    }
  }
  
  // Fallback: try parsing as regular date
  const date = new Date(dateStr);
  if (!isNaN(date.getTime())) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  
  return '';
}

function setupSingleAssetClickHandler() {
    // Prevent multiple setups
    if (isClickHandlerSetup) {
        return;
    }
    
    // Remove ALL possible existing listeners
    const oldHandler1 = document._assetClickHandler;
    const oldHandler2 = document._customAssetHandler;
    const oldHandler3 = window.handleAssetActionClick;
    const oldHandler4 = window.handleCustomAssetClick;
    
    if (oldHandler1) document.removeEventListener('click', oldHandler1);
    if (oldHandler2) document.removeEventListener('click', oldHandler2);
    if (oldHandler3) document.removeEventListener('click', oldHandler3);
    if (oldHandler4) document.removeEventListener('click', oldHandler4);
    
    // Create the ONE and ONLY click handler for ALL button types
    const singleClickHandler = async function(event) {
        // Handle prepare/unprepare buttons
        if (event.target.classList.contains('asset-action-btn') || 
            event.target.classList.contains('custom-asset-btn')) {
            
            event.preventDefault();
            event.stopPropagation();
            
            const eventId = event.target.dataset.eventId;
            const assetId = decodeURIComponent(event.target.dataset.assetId);
            const action = event.target.dataset.action;
            
            // Create unique key for this asset
            const assetKey = `${eventId}-${assetId}`;
            
            // Check if already processing
            if (processingAssets.has(assetKey)) {
                return false;
            }
            
            processingAssets.add(assetKey);
            
            if (action === 'prepare') {
                prepareSpecificAsset(eventId, assetId).finally(() => {
                    processingAssets.delete(assetKey);
                });
            } else if (action === 'unprepare') {
                unprepareSpecificAsset(eventId, assetId).finally(() => {
                    processingAssets.delete(assetKey);
                });
            } else if (action === 'editCustom') {
                editCustomAsset(eventId, assetId);
                processingAssets.delete(assetKey);
            } else if (action === 'removeCustom') {
                removeCustomAsset(eventId, assetId).finally(() => {
                    processingAssets.delete(assetKey);
                });
            }
            
            return false;
        }
        
        // Handle removal buttons (remove from event)
        if (event.target.classList.contains('asset-remove-btn') || 
            event.target.classList.contains('custom-remove-btn')) {
            
            event.preventDefault();
            event.stopPropagation();
            
            const eventId = event.target.dataset.eventId;
            const assetId = decodeURIComponent(event.target.dataset.assetId);
            
            // Create unique key for this asset
            const assetKey = `${eventId}-${assetId}`;
            
            // Check if already processing
            if (processingAssets.has(assetKey)) {
                return false;
            }
            
            if (await showAppConfirm({
                title: 'Remove Asset',
                message: `Remove ${assetId} from this event?`,
                confirmText: 'Remove',
                cancelText: 'Cancel',
                variant: 'danger',
            })) {
                // Mark as processing
                processingAssets.add(assetKey);
                
                // Disable the button
                event.target.disabled = true;
                event.target.style.opacity = '0.5';
                
                // Process removal
                const cleanup = () => {
                    processingAssets.delete(assetKey);
                };
                
                removeAssetFromEvent(eventId, assetId).finally(cleanup);
            }
            
            return false;
        }

    };
    
    // Store reference and add listener
    document._singleAssetHandler = singleClickHandler;
    document.addEventListener('click', singleClickHandler, true); // Use capture phase
    
    isClickHandlerSetup = true;
}

// Global variables for maintenance functionality
let selectedMaintenanceAssets = new Set();

function removeExistingListeners() {
    // Remove any existing click handlers
    const existingHandler = document._assetClickHandler;
    if (existingHandler) {
        document.removeEventListener('click', existingHandler);
    }
}

function setupAssetClickHandler() {
    removeExistingListeners();
    
    const clickHandler = function(event) {
        if (event.target.classList.contains('asset-action-btn')) {
            event.preventDefault();
            event.stopPropagation();
            
            const eventId = event.target.dataset.eventId;
            const assetId = decodeURIComponent(event.target.dataset.assetId);
            const action = event.target.dataset.action;
            
            const assetKey = `${eventId}-${assetId}`;
            
            if (processingAssets.has(assetKey)) {
                return;
            }
            
            processingAssets.add(assetKey);

            const allButtonsForAsset = document.querySelectorAll(`[data-asset-id="${encodeURIComponent(assetId)}"]`);
            allButtonsForAsset.forEach(btn => {
                btn.disabled = true;
                btn.style.opacity = '0.6';
            });
            
            const cleanup = () => {
                processingAssets.delete(assetKey);
            };
            
            if (action === 'prepare') {
                prepareSpecificAsset(eventId, assetId)
                    .finally(cleanup);
            } else if (action === 'unprepare') {
                unprepareSpecificAsset(eventId, assetId)
                    .finally(cleanup);
            } else {
                cleanup();
            }
            
            return;
        }
    };
    
    document._assetClickHandler = clickHandler;
    
    document.addEventListener('click', clickHandler);
}

// Global utility function for JavaScript string escaping
function escapeJs(str) {
  if (!str) return '';
  return str.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
}

function escapeHtmlAttribute(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const BARCODE_SCANNER_SCRIPT_URLS = [
  '/static/js/vendor/html5-qrcode.min.js',
  'https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js'
];
const BARCODE_SCANNER_NATIVE_INTERVAL_MS = 80;
const BARCODE_SCANNER_NATIVE_MIN_FRAME_INTERVAL_MS = 45;
const BARCODE_SCANNER_NATIVE_VARIANT_INTERVAL_MS = 320;
let barcodeScannerScriptPromise = null;
let barcodeScannerState = {
  html5: null,
  stream: null,
  nativeTimer: null,
  nativeFrameHandle: null,
  nativeVideo: null,
  nativeDetector: null,
  nativeLastScanAt: 0,
  nativeLastVariantScanAt: 0,
  onScan: null,
  handling: false,
  statusTimer: null
};

const HTML5_QRCODE_FORMAT_NAMES = [
  'QR_CODE',
  'CODE_128',
  'CODE_39',
  'CODE_93',
  'CODABAR',
  'DATA_MATRIX',
  'EAN_13',
  'EAN_8',
  'ITF',
  'PDF_417',
  'UPC_A',
  'UPC_E'
];

const NATIVE_BARCODE_FORMATS = [
  'qr_code',
  'aztec',
  'code_128',
  'code_39',
  'code_93',
  'codabar',
  'data_matrix',
  'ean_13',
  'ean_8',
  'itf',
  'pdf417',
  'upc_a',
  'upc_e'
];

function normalizeScannedIdentifier(rawValue) {
  let value = String(rawValue || '')
    .replace(/[\u0000-\u001f]+/g, ' ')
    .trim();

  if (!value) return '';

  try {
    const url = new URL(value);
    const paramNames = ['assetId', 'asset_id', 'asset', 'id', 'serial', 'sn', 'container'];
    for (const name of paramNames) {
      const paramValue = url.searchParams.get(name);
      if (paramValue && paramValue.trim()) return paramValue.trim();
    }

    const lastPathPart = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() || '').trim();
    if (lastPathPart) return lastPathPart;
  } catch (e) {
    // Not a URL; keep processing as a raw code.
  }

  const prefixed = value.match(/^(?:asset(?:\s*id)?|serial(?:\s*(?:no|number))?|id|sn|container)\s*[:=#]\s*(.+)$/i);
  if (prefixed && prefixed[1]) {
    value = prefixed[1].trim();
  }

  return value;
}

function findAssetByIdentifier(identifier, assetList = assets) {
  const normalized = normalizeScannedIdentifier(identifier).toLowerCase();
  if (!normalized || !Array.isArray(assetList)) return null;

  return assetList.find(asset => {
    if (!asset) return false;
    const ids = [
      asset.id,
      asset.internalId,
      asset.bulkId,
      asset.displayId
    ].map(value => String(value || '').trim()).filter(Boolean);

    if (ids.some(value => value.toLowerCase() === normalized)) return true;

    const serial = String(asset.serial || '').trim();
    return serial && serial.toLowerCase() === normalized;
  }) || null;
}

function getAssetIdFromIdentifier(identifier, assetList = assets) {
  const asset = findAssetByIdentifier(identifier, assetList);
  return asset ? getAssetIdentifierForApi(asset) : normalizeScannedIdentifier(identifier);
}

function scannerButtonHtml(onclick, label = 'Scan') {
  return `<button type="button" class="btn btn-primary scanner-action-btn" onclick="${onclick}" title="Use phone camera to scan QR or barcode">${label}</button>`;
}

function ensureBarcodeScannerStyles() {
  if (document.getElementById('barcode-scanner-styles')) return;

  const style = document.createElement('style');
  style.id = 'barcode-scanner-styles';
  style.textContent = `
    .scanner-action-btn {
      white-space: nowrap;
    }

    #barcodeScannerModal .modal-content {
      max-width: 680px;
    }

    .barcode-scanner-reader {
      overflow: hidden;
      border-radius: 12px;
      background: #111827;
      min-height: 340px;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #fff;
      position: relative;
    }

    .barcode-scanner-reader video {
      width: 100%;
      height: 100%;
      max-height: 68vh;
      object-fit: contain;
    }

    .barcode-scanner-reader img,
    .barcode-scanner-reader canvas {
      max-width: 100%;
      max-height: 68vh;
      object-fit: contain;
    }

    .barcode-scanner-status {
      color: #666;
      font-size: 13px;
      line-height: 1.4;
      margin-top: 10px;
      min-height: 18px;
    }

    .barcode-scanner-fallback {
      display: grid;
      gap: 10px;
      margin-top: 14px;
      padding-top: 14px;
      border-top: 1px solid #e9ecef;
    }

    .barcode-scanner-manual-row {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }

    .barcode-scanner-manual-row input {
      flex: 1 1 220px;
    }

    @media (max-width: 640px) {
      #barcodeScannerModal.modal.active {
        align-items: stretch;
      }

      #barcodeScannerModal .modal-content {
        max-height: calc(100dvh - 20px);
      }

      .barcode-scanner-reader {
        min-height: 420px;
      }

      .barcode-scanner-manual-row .btn,
      .barcode-scanner-fallback .btn,
      .scanner-action-btn {
        flex: 1 1 auto;
      }
    }
  `;

  document.head.appendChild(style);
}

function ensureBarcodeScannerModal() {
  ensureBarcodeScannerStyles();

  let modal = document.getElementById('barcodeScannerModal');
  if (modal) return modal;

  modal = document.createElement('div');
  modal.id = 'barcodeScannerModal';
  modal.className = 'modal';
  modal.innerHTML = `
    <div class="modal-content">
      <div class="modal-header">
        <h3 class="modal-title" id="barcodeScannerTitle">Scan Code</h3>
        <button type="button" class="close-btn" onclick="closeBarcodeScanner()">&times;</button>
      </div>

      <div id="barcodeScannerInstructions" style="color:#666;font-size:14px;margin-bottom:12px;">
        Point your camera at an asset QR code or barcode.
      </div>

      <div id="barcodeScannerReader" class="barcode-scanner-reader">
        Starting camera...
      </div>

      <div id="barcodeScannerStatus" class="barcode-scanner-status"></div>

      <div class="barcode-scanner-fallback">
        <label class="btn btn-secondary" style="text-align:center;cursor:pointer;">
          Take Photo
          <input id="barcodeScannerFileInput" type="file" accept="image/*" capture="environment" style="display:none;" onchange="scanBarcodeImageFile(this)">
        </label>

        <div class="barcode-scanner-manual-row">
          <input id="barcodeScannerManualValue" class="form-input" type="text" placeholder="Or enter code manually" onkeypress="if(event.key==='Enter') submitBarcodeScannerManual()">
          <button type="button" class="btn btn-primary" onclick="submitBarcodeScannerManual()">Use Code</button>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(modal);
  return modal;
}

function setBarcodeScannerStatus(message, type = 'info') {
  const el = document.getElementById('barcodeScannerStatus');
  if (!el) return;

  const colors = {
    info: '#666',
    success: '#155724',
    warning: '#856404',
    error: '#721c24'
  };
  el.style.color = colors[type] || colors.info;
  el.textContent = message || '';
}

function scheduleBarcodeScannerHint() {
  if (barcodeScannerState.statusTimer) {
    clearTimeout(barcodeScannerState.statusTimer);
  }

  barcodeScannerState.statusTimer = setTimeout(() => {
    if (!barcodeScannerState.handling && document.getElementById('barcodeScannerModal')?.classList.contains('active')) {
      setBarcodeScannerStatus('Move closer until the code fills more of the camera view, or use Take Photo for difficult labels.');
    }
  }, 7000);
}

function getBarcodeScannerVideoConstraints(overrides = {}) {
  return {
    facingMode: { ideal: 'environment' },
    width: { ideal: 1920, min: 640 },
    height: { ideal: 1080, min: 480 },
    frameRate: { ideal: 30, min: 15 },
    focusMode: { ideal: 'continuous' },
    resizeMode: 'crop-and-scale',
    ...overrides
  };
}

function isLikelyRearCameraLabel(label) {
  const value = String(label || '');
  return /back|rear|environment|world|wide/i.test(value) && !/front|user|facetime/i.test(value);
}

function getRearCameraScore(label) {
  const value = String(label || '').toLowerCase();
  let score = isLikelyRearCameraLabel(value) ? 100 : 0;

  if (/back|rear|environment|world/.test(value)) score += 20;
  if (/main|wide/.test(value)) score += 8;
  if (/ultra|tele|depth|front|user|facetime/.test(value)) score -= 15;

  return score;
}

function compareBarcodeScannerCameras(a, b) {
  return getRearCameraScore(b?.label) - getRearCameraScore(a?.label);
}

function getPrimaryVideoTrack(stream) {
  return stream?.getVideoTracks?.()[0] || null;
}

function getPreferredBarcodeScannerZoom(capabilities) {
  const zoom = capabilities?.zoom;
  if (!zoom || typeof zoom !== 'object') return null;

  const min = Number.isFinite(zoom.min) ? zoom.min : 1;
  const max = Number.isFinite(zoom.max) ? zoom.max : min;
  if (max <= min) return null;

  const preferred = Math.min(1.6, max);
  const clamped = Math.max(min, preferred);
  if (clamped <= min) return null;

  if (Number.isFinite(zoom.step) && zoom.step > 0) {
    return min + (Math.round((clamped - min) / zoom.step) * zoom.step);
  }

  return clamped;
}

async function applyBarcodeScannerTrackHint(track, constraint) {
  try {
    await track.applyConstraints({ advanced: [constraint] });
  } catch (e) {
    // Camera controls are inconsistent across mobile browsers.
  }
}

async function enhanceBarcodeScannerStream(stream) {
  const track = getPrimaryVideoTrack(stream);
  if (!track?.getCapabilities || !track.applyConstraints) return;

  let capabilities = {};
  try {
    capabilities = track.getCapabilities() || {};
  } catch (e) {
    return;
  }

  if (Array.isArray(capabilities.focusMode) && capabilities.focusMode.includes('continuous')) {
    await applyBarcodeScannerTrackHint(track, { focusMode: 'continuous' });
  }
  if (Array.isArray(capabilities.exposureMode) && capabilities.exposureMode.includes('continuous')) {
    await applyBarcodeScannerTrackHint(track, { exposureMode: 'continuous' });
  }
  if (Array.isArray(capabilities.whiteBalanceMode) && capabilities.whiteBalanceMode.includes('continuous')) {
    await applyBarcodeScannerTrackHint(track, { whiteBalanceMode: 'continuous' });
  }

  const preferredZoom = getPreferredBarcodeScannerZoom(capabilities);
  if (preferredZoom !== null) {
    await applyBarcodeScannerTrackHint(track, { zoom: preferredZoom });
  }
}

async function getBarcodeScannerMediaStream() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Camera scanning is not available in this browser');
  }

  const attempts = [
    { video: getBarcodeScannerVideoConstraints(), audio: false },
    { video: { facingMode: { ideal: 'environment' } }, audio: false },
    { video: true, audio: false }
  ];

  let lastError = null;
  let stream = null;
  for (const constraints of attempts) {
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
      break;
    } catch (error) {
      lastError = error;
    }
  }

  if (!stream) throw lastError || new Error('Camera scanning is not available');

  const track = getPrimaryVideoTrack(stream);
  const currentLabel = track?.label || '';
  if (
    currentLabel &&
    !isLikelyRearCameraLabel(currentLabel) &&
    navigator.mediaDevices?.enumerateDevices
  ) {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const rearCamera = devices
        .filter(device => device.kind === 'videoinput' && device.deviceId && isLikelyRearCameraLabel(device.label))
        .sort(compareBarcodeScannerCameras)[0];

      if (rearCamera) {
        const rearStream = await navigator.mediaDevices.getUserMedia({
          video: getBarcodeScannerVideoConstraints({ deviceId: { exact: rearCamera.deviceId } }),
          audio: false
        });
        stream.getTracks().forEach(existingTrack => existingTrack.stop());
        stream = rearStream;
      }
    } catch (e) {
      // The initial environment-facing stream is still usable.
    }
  }

  await enhanceBarcodeScannerStream(stream);
  return stream;
}

function getHtml5QrcodeFormats() {
  const formats = window.Html5QrcodeSupportedFormats;
  if (!formats) return [];

  return HTML5_QRCODE_FORMAT_NAMES
    .map(name => formats[name])
    .filter(format => typeof format !== 'undefined');
}

function getHtml5QrcodeConfig() {
  const formats = getHtml5QrcodeFormats();
  const config = {
    verbose: false,
    experimentalFeatures: {
      useBarCodeDetectorIfSupported: true
    }
  };

  if (formats.length > 0) {
    config.formatsToSupport = formats;
  }

  return config;
}

function getBarcodeScannerQrbox(viewfinderWidth, viewfinderHeight) {
  const width = Number(viewfinderWidth) || 0;
  const height = Number(viewfinderHeight) || 0;

  if (!width || !height) {
    return { width: 320, height: 220 };
  }

  const scanWidth = Math.min(Math.floor(width * 0.96), 720);
  const scanHeight = Math.min(Math.floor(height * 0.62), 420);
  const minWidth = Math.min(240, width);
  const minHeight = Math.min(180, height);

  return {
    width: Math.min(width, Math.max(minWidth, scanWidth)),
    height: Math.min(height, Math.max(minHeight, scanHeight))
  };
}

function getBarcodeScannerCameraConfig() {
  return {
    fps: 24,
    qrbox: getBarcodeScannerQrbox,
    disableFlip: true,
    experimentalFeatures: {
      useBarCodeDetectorIfSupported: true
    }
  };
}

async function createNativeBarcodeDetector() {
  let formats = NATIVE_BARCODE_FORMATS;

  try {
    if (typeof BarcodeDetector.getSupportedFormats === 'function') {
      const supportedFormats = await BarcodeDetector.getSupportedFormats();
      formats = NATIVE_BARCODE_FORMATS.filter(format => supportedFormats.includes(format));
    }
  } catch (e) {
    formats = NATIVE_BARCODE_FORMATS;
  }

  try {
    return formats.length > 0
      ? new BarcodeDetector({ formats })
      : new BarcodeDetector();
  } catch (e) {
    return new BarcodeDetector();
  }
}

function loadHtml5Qrcode() {
  if (window.Html5Qrcode) return Promise.resolve(true);
  if (barcodeScannerScriptPromise) return barcodeScannerScriptPromise;

  const loadScript = scriptUrl => new Promise(resolve => {
    const script = document.createElement('script');
    script.src = scriptUrl;
    script.async = true;
    script.onload = () => resolve({ ok: !!window.Html5Qrcode, script });
    script.onerror = () => resolve({ ok: false, script });
    document.head.appendChild(script);
  });

  barcodeScannerScriptPromise = (async () => {
    for (const scriptUrl of BARCODE_SCANNER_SCRIPT_URLS) {
      const { ok, script } = await loadScript(scriptUrl);
      if (ok) return true;
      script.remove();
    }

    return false;
  })();

  return barcodeScannerScriptPromise;
}

async function stopBarcodeScannerCamera(clearReader = true) {
  if (barcodeScannerState.statusTimer) {
    clearTimeout(barcodeScannerState.statusTimer);
    barcodeScannerState.statusTimer = null;
  }

  if (barcodeScannerState.nativeTimer) {
    clearTimeout(barcodeScannerState.nativeTimer);
    barcodeScannerState.nativeTimer = null;
  }

  if (
    barcodeScannerState.nativeFrameHandle !== null &&
    barcodeScannerState.nativeVideo &&
    typeof barcodeScannerState.nativeVideo.cancelVideoFrameCallback === 'function'
  ) {
    barcodeScannerState.nativeVideo.cancelVideoFrameCallback(barcodeScannerState.nativeFrameHandle);
  }
  barcodeScannerState.nativeFrameHandle = null;

  barcodeScannerState.nativeDetector = null;

  if (barcodeScannerState.html5) {
    try {
      await barcodeScannerState.html5.stop();
    } catch (e) {
      // Stop can throw if the camera was never started.
    }

    try {
      await barcodeScannerState.html5.clear();
    } catch (e) {
      // Clear is best effort.
    }

    barcodeScannerState.html5 = null;
  }

  if (barcodeScannerState.stream) {
    barcodeScannerState.stream.getTracks().forEach(track => track.stop());
    barcodeScannerState.stream = null;
  }

  barcodeScannerState.nativeVideo = null;
  barcodeScannerState.nativeLastScanAt = 0;
  barcodeScannerState.nativeLastVariantScanAt = 0;

  if (clearReader) {
    const reader = document.getElementById('barcodeScannerReader');
    if (reader) reader.innerHTML = '';
  }
}

async function handleBarcodeScanResult(rawValue) {
  const identifier = normalizeScannedIdentifier(rawValue);
  if (!identifier || barcodeScannerState.handling) return;

  barcodeScannerState.handling = true;
  const onScan = barcodeScannerState.onScan;

  await stopBarcodeScannerCamera(false);
  closeModal('barcodeScannerModal');
  barcodeScannerState.onScan = null;

  try {
    if (typeof onScan === 'function') {
      await onScan(identifier, rawValue);
    }
  } catch (error) {
    console.error('Scanner handler failed:', error);
    showNotification('error', `Failed to use scanned code: ${error.message || error}`);
  } finally {
    barcodeScannerState.handling = false;
  }
}

function enhanceBarcodeScannerCanvas(context, width, height, amount = 1.45) {
  const imageData = context.getImageData(0, 0, width, height);
  const data = imageData.data;

  for (let i = 0; i < data.length; i += 4) {
    const gray = (data[i] * 0.299) + (data[i + 1] * 0.587) + (data[i + 2] * 0.114);
    const boosted = Math.max(0, Math.min(255, ((gray - 128) * amount) + 128));
    data[i] = boosted;
    data[i + 1] = boosted;
    data[i + 2] = boosted;
  }

  context.putImageData(imageData, 0, 0);
}

function getBarcodeScannerLiveCrop(video, mode) {
  const sourceWidth = video.videoWidth || 0;
  const sourceHeight = video.videoHeight || 0;
  if (!sourceWidth || !sourceHeight) return null;

  if (mode === 'strip') {
    const height = Math.max(Math.round(sourceHeight * 0.34), Math.min(sourceHeight, 360));
    return {
      x: 0,
      y: Math.max(0, Math.floor((sourceHeight - height) / 2)),
      width: sourceWidth,
      height: Math.min(sourceHeight, height)
    };
  }

  if (mode === 'square') {
    const side = Math.floor(Math.min(sourceWidth, sourceHeight) * 0.82);
    return {
      x: Math.max(0, Math.floor((sourceWidth - side) / 2)),
      y: Math.max(0, Math.floor((sourceHeight - side) / 2)),
      width: side,
      height: side
    };
  }

  return { x: 0, y: 0, width: sourceWidth, height: sourceHeight };
}

function createBarcodeScannerLiveCanvas(video, { mode = 'full', contrast = false } = {}) {
  const crop = getBarcodeScannerLiveCrop(video, mode);
  if (!crop) return null;

  const maxSide = 1400;
  const scale = Math.min(1, maxSide / Math.max(crop.width, crop.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(crop.width * scale));
  canvas.height = Math.max(1, Math.round(crop.height * scale));

  const context = canvas.getContext('2d');
  context.drawImage(
    video,
    crop.x,
    crop.y,
    crop.width,
    crop.height,
    0,
    0,
    canvas.width,
    canvas.height
  );

  if (contrast) {
    enhanceBarcodeScannerCanvas(context, canvas.width, canvas.height, 1.55);
  }

  return canvas;
}

async function detectNativeBarcodesInVideo(detector, video) {
  const codes = await detector.detect(video);
  if (codes && codes.length > 0) return codes;

  const now = performance.now();
  if (now - barcodeScannerState.nativeLastVariantScanAt < BARCODE_SCANNER_NATIVE_VARIANT_INTERVAL_MS) {
    return [];
  }
  barcodeScannerState.nativeLastVariantScanAt = now;

  const variants = [
    { mode: 'strip' },
    { mode: 'square' },
    { mode: 'strip', contrast: true },
    { mode: 'square', contrast: true }
  ];

  for (const options of variants) {
    const canvas = createBarcodeScannerLiveCanvas(video, options);
    if (!canvas) continue;

    const variantCodes = await detector.detect(canvas);
    if (variantCodes && variantCodes.length > 0) return variantCodes;
  }

  return [];
}

function scheduleNativeBarcodeDetection(video, detectLoop) {
  if (typeof video.requestVideoFrameCallback === 'function') {
    barcodeScannerState.nativeFrameHandle = video.requestVideoFrameCallback(() => {
      barcodeScannerState.nativeFrameHandle = null;
      detectLoop();
    });
    return;
  }

  barcodeScannerState.nativeTimer = setTimeout(detectLoop, BARCODE_SCANNER_NATIVE_INTERVAL_MS);
}

async function startNativeBarcodeDetectionLoop(video) {
  if (!window.BarcodeDetector || !video) return false;

  let detector = barcodeScannerState.nativeDetector;
  if (!detector) {
    detector = await createNativeBarcodeDetector();
    barcodeScannerState.nativeDetector = detector;
  }

  barcodeScannerState.nativeVideo = video;
  barcodeScannerState.nativeLastScanAt = 0;
  barcodeScannerState.nativeLastVariantScanAt = 0;

  const detectLoop = async () => {
    if (barcodeScannerState.nativeVideo !== video || barcodeScannerState.handling) return;

    const now = performance.now();
    if (now - barcodeScannerState.nativeLastScanAt < BARCODE_SCANNER_NATIVE_MIN_FRAME_INTERVAL_MS) {
      scheduleNativeBarcodeDetection(video, detectLoop);
      return;
    }
    barcodeScannerState.nativeLastScanAt = now;

    try {
      if (video.readyState >= 2) {
        const codes = await detectNativeBarcodesInVideo(detector, video);
        if (barcodeScannerState.nativeVideo !== video || barcodeScannerState.handling) return;
        if (codes && codes.length > 0) {
          await handleBarcodeScanResult(codes[0].rawValue || '');
          return;
        }
      }
    } catch (e) {
      console.warn('Native barcode detection failed:', e);
    }

    if (barcodeScannerState.nativeVideo !== video || barcodeScannerState.handling) return;
    scheduleNativeBarcodeDetection(video, detectLoop);
  };

  detectLoop();
  return true;
}

async function startNativeBarcodeScanner() {
  if (!window.BarcodeDetector || !navigator.mediaDevices?.getUserMedia) {
    throw new Error('Camera scanning is not available in this browser');
  }

  const reader = document.getElementById('barcodeScannerReader');
  if (!reader) return;

  reader.innerHTML = '';
  const video = document.createElement('video');
  video.setAttribute('playsinline', 'true');
  video.muted = true;
  reader.appendChild(video);

  const stream = await getBarcodeScannerMediaStream();

  barcodeScannerState.stream = stream;
  video.srcObject = stream;
  await video.play();

  setBarcodeScannerStatus('Camera ready. Point it at the QR code or barcode.');
  scheduleBarcodeScannerHint();
  await startNativeBarcodeDetectionLoop(video);
}

async function cleanupHtml5QrcodeScanner(scanner) {
  if (!scanner) return;

  try {
    await scanner.stop();
  } catch (e) {
    // Stop can throw when a start attempt never reached a running state.
  }

  try {
    await scanner.clear();
  } catch (e) {
    // Clear is best effort.
  }

  if (barcodeScannerState.html5 === scanner) {
    barcodeScannerState.html5 = null;
  }
}

async function getHtml5QrcodeCameraRequests() {
  const cameraRequests = [
    getBarcodeScannerVideoConstraints(),
    { facingMode: { ideal: 'environment' } },
    { facingMode: 'environment' },
    {}
  ];

  if (typeof window.Html5Qrcode?.getCameras !== 'function') {
    return cameraRequests;
  }

  try {
    const cameras = await window.Html5Qrcode.getCameras();
    const rearCameras = [];
    const otherCameras = [];

    (cameras || []).forEach(camera => {
      if (!camera?.id) return;
      if (isLikelyRearCameraLabel(camera.label)) {
        rearCameras.push(camera);
      } else {
        otherCameras.push(camera);
      }
    });

    rearCameras.sort(compareBarcodeScannerCameras);
    otherCameras.sort(compareBarcodeScannerCameras);
    cameraRequests.push(...rearCameras.map(camera => camera.id), ...otherCameras.map(camera => camera.id));
  } catch (e) {
    // Enumerating cameras may fail until permission is granted; constraints above still work.
  }

  return cameraRequests;
}

async function startHtml5BarcodeScanner() {
  const readerId = 'barcodeScannerReader';
  const reader = document.getElementById(readerId);
  if (!reader) return false;

  const loaded = await loadHtml5Qrcode();
  if (!loaded || !window.Html5Qrcode) return false;

  reader.innerHTML = '';
  const cameraRequests = await getHtml5QrcodeCameraRequests();
  let lastStartError = null;
  let activeScanner = null;

  for (const cameraRequest of cameraRequests) {
    reader.innerHTML = '';
    const scanner = new Html5Qrcode(readerId, getHtml5QrcodeConfig());
    barcodeScannerState.html5 = scanner;

    try {
      await scanner.start(
        cameraRequest,
        getBarcodeScannerCameraConfig(),
        decodedText => handleBarcodeScanResult(decodedText),
        () => {}
      );
      lastStartError = null;
      activeScanner = scanner;
      break;
    } catch (error) {
      lastStartError = error;
      await cleanupHtml5QrcodeScanner(scanner);
    }
  }

  if (lastStartError) {
    throw lastStartError;
  }

  barcodeScannerState.html5 = activeScanner;
  const video = reader.querySelector('video');
  if (video?.srcObject) {
    await enhanceBarcodeScannerStream(video.srcObject);
  }
  if (video) {
    startNativeBarcodeDetectionLoop(video).catch(error => {
      console.warn('Native barcode detection unavailable:', error);
    });
  }

  setBarcodeScannerStatus('Camera ready. Point it at the QR code or barcode.');
  scheduleBarcodeScannerHint();
  return true;
}

async function openBarcodeScanner({ title, instructions, onScan }) {
  const modal = ensureBarcodeScannerModal();
  barcodeScannerState.onScan = onScan;
  barcodeScannerState.handling = false;

  document.getElementById('barcodeScannerTitle').textContent = title || 'Scan Code';
  document.getElementById('barcodeScannerInstructions').textContent = instructions || 'Point your camera at an asset QR code or barcode.';
  document.getElementById('barcodeScannerReader').innerHTML = 'Starting camera...';
  document.getElementById('barcodeScannerManualValue').value = '';
  document.getElementById('barcodeScannerFileInput').value = '';

  openModal(modal.id);
  setBarcodeScannerStatus('Starting camera...');

  try {
    const startedWithLibrary = await startHtml5BarcodeScanner();
    if (startedWithLibrary) return;
  } catch (error) {
    console.warn('html5-qrcode scanner unavailable:', error);
    await stopBarcodeScannerCamera(false);
  }

  try {
    await startNativeBarcodeScanner();
    return;
  } catch (error) {
    console.warn('Native camera scanner unavailable:', error);
  }

  await stopBarcodeScannerCamera(false);
  document.getElementById('barcodeScannerReader').innerHTML = `
    <div style="padding:20px;text-align:center;line-height:1.45;">
      Camera scanner could not start.<br>
      Use Take Photo or enter the code below.
    </div>
  `;
  setBarcodeScannerStatus(
    window.isSecureContext
      ? 'Camera access was blocked or unavailable. Check browser camera permission and try again.'
      : 'Camera access usually requires HTTPS on a phone browser.',
    'warning'
  );
}

async function closeBarcodeScanner() {
  barcodeScannerState.onScan = null;
  barcodeScannerState.handling = false;
  await stopBarcodeScannerCamera();
  closeModal('barcodeScannerModal');
}

async function scanBarcodeFileWithHtml5Qrcode(file) {
  const loaded = await loadHtml5Qrcode();
  if (!loaded || !window.Html5Qrcode) {
    throw new Error('Photo scanning is not available in this browser');
  }

  const scanner = new Html5Qrcode('barcodeScannerReader', getHtml5QrcodeConfig());
  barcodeScannerState.html5 = scanner;

  if (typeof scanner.scanFileV2 === 'function') {
    const result = await scanner.scanFileV2(file, true);
    return result?.decodedText || result?.result?.text || '';
  }

  return scanner.scanFile(file, true);
}

function loadBarcodeScannerImage(file) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const url = URL.createObjectURL(file);

    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Unable to read photo'));
    };
    image.src = url;
  });
}

function createBarcodeScannerPhotoCanvas(image, { rotation = 0, contrast = false } = {}) {
  const sourceWidth = image.naturalWidth || image.width || 1;
  const sourceHeight = image.naturalHeight || image.height || 1;
  const maxSide = 1800;
  const scale = Math.min(1, maxSide / Math.max(sourceWidth, sourceHeight));
  const targetWidth = Math.max(1, Math.round(sourceWidth * scale));
  const targetHeight = Math.max(1, Math.round(sourceHeight * scale));
  const normalizedRotation = ((rotation % 360) + 360) % 360;
  const swapsAxes = normalizedRotation === 90 || normalizedRotation === 270;
  const canvas = document.createElement('canvas');
  canvas.width = swapsAxes ? targetHeight : targetWidth;
  canvas.height = swapsAxes ? targetWidth : targetHeight;

  const context = canvas.getContext('2d');
  context.save();
  context.translate(canvas.width / 2, canvas.height / 2);
  context.rotate(normalizedRotation * Math.PI / 180);
  context.drawImage(image, -targetWidth / 2, -targetHeight / 2, targetWidth, targetHeight);
  context.restore();

  if (contrast) {
    enhanceBarcodeScannerCanvas(context, canvas.width, canvas.height);
  }

  return canvas;
}

async function detectBarcodeInPhotoWithNativeDetector(file) {
  if (!window.BarcodeDetector) {
    throw new Error('Photo scanning is not available in this browser');
  }

  const detector = await createNativeBarcodeDetector();
  let lastError = null;

  if (window.createImageBitmap) {
    let bitmap = null;
    try {
      bitmap = await createImageBitmap(file);
      const codes = await detector.detect(bitmap);
      if (codes && codes.length > 0) return codes[0].rawValue || '';
    } catch (error) {
      lastError = error;
    } finally {
      if (bitmap && typeof bitmap.close === 'function') {
        bitmap.close();
      }
    }
  }

  const image = await loadBarcodeScannerImage(file);
  const variantOptions = [
    {},
    { contrast: true },
    { rotation: 90 },
    { rotation: 180 },
    { rotation: 270 },
    { rotation: 90, contrast: true },
    { rotation: 180, contrast: true },
    { rotation: 270, contrast: true }
  ];

  for (const options of variantOptions) {
    try {
      const variant = createBarcodeScannerPhotoCanvas(image, options);
      const codes = await detector.detect(variant);
      if (codes && codes.length > 0) return codes[0].rawValue || '';
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error('No QR code or barcode found in the photo');
}

async function scanBarcodeImageFile(input) {
  const file = input?.files?.[0];
  if (!file) return;

  setBarcodeScannerStatus('Scanning photo...');

  try {
    await stopBarcodeScannerCamera(false);

    let lastScanError = null;
    try {
      const result = await scanBarcodeFileWithHtml5Qrcode(file);
      await handleBarcodeScanResult(result);
      return;
    } catch (error) {
      lastScanError = error;
      await stopBarcodeScannerCamera(false);
    }

    try {
      const result = await detectBarcodeInPhotoWithNativeDetector(file);
      await handleBarcodeScanResult(result);
    } catch (error) {
      throw lastScanError || error;
    }
  } catch (error) {
    console.error('Photo scan failed:', error);
    setBarcodeScannerStatus(error.message || 'Photo scan failed', 'error');
  }
}

function submitBarcodeScannerManual() {
  const input = document.getElementById('barcodeScannerManualValue');
  const value = normalizeScannedIdentifier(input?.value || '');
  if (!value) {
    setBarcodeScannerStatus('Enter a code first.', 'warning');
    input?.focus();
    return;
  }

  handleBarcodeScanResult(value);
}

function scanForPrepare(eventId) {
  openBarcodeScanner({
    title: 'Scan To Prepare',
    instructions: 'Scan an asset ID, barcode, serial number, container ID, or container serial number to prepare it for this event.',
    onScan: async identifier => {
      const input = document.getElementById('universalAssetInput');
      if (input) input.value = identifier;
      await processUniversalAsset(eventId);
    }
  });
}

function scanForReturn() {
  const eventSelect = document.getElementById('returnEventSelect');
  const eventId = eventSelect?.value || '';

  if (!eventId) {
    showNotification('warning', 'Select an event first');
    eventSelect?.focus();
    return;
  }

  openBarcodeScanner({
    title: 'Scan To Return',
    instructions: 'Scan an asset QR code, barcode, or serial number to return it from the selected event.',
    onScan: async identifier => {
      const input = document.getElementById('manualReturnAssetIdNew');
      if (input) input.value = identifier;
      await returnManualAssetNew();
    }
  });
}

async function addIdentifierToMaintenanceSelection(identifier) {
  const normalized = normalizeScannedIdentifier(identifier);
  if (!normalized) {
    showNotification('warning', 'Scan or enter an Asset ID first');
    return;
  }

  await ensureAssetsLoaded();

  const asset = findAssetByIdentifier(normalized, assets);
  if (asset) {
    selectAssetForMaintenance(getAssetIdentifierForApi(asset));
    const searchEl = document.getElementById('maintenanceAssetSearch');
    if (searchEl) searchEl.value = '';
    return;
  }

  const container = await getContainerById(normalized, true);
  if (container) {
    let added = 0;
    let already = 0;
    let skipped = 0;

    for (const assetId of (container.assetIds || [])) {
      const containerAsset = findAssetByIdentifier(assetId, assets);
      const resolvedAssetId = containerAsset ? getAssetIdentifierForApi(containerAsset) : assetId;

      if (!containerAsset || containerAsset.isBulk) {
        skipped++;
        continue;
      }

      if (selectedMaintenanceAssets.has(resolvedAssetId)) {
        already++;
      } else {
        selectedMaintenanceAssets.add(resolvedAssetId);
        added++;
      }
    }

    updateSelectedAssetsDisplay();
    searchMaintenanceAssets();
    showNotification('success', `Added container ${container.id}: ${added} added (${already} already selected${skipped ? `, ${skipped} skipped` : ''})`);
    return;
  }

  showNotification('error', `Asset or container not found: ${normalized}`);
  const searchEl = document.getElementById('maintenanceAssetSearch');
  if (searchEl) {
    searchEl.value = normalized;
    searchEl.focus();
    searchMaintenanceAssets();
  }
}

function scanForMaintenance() {
  openBarcodeScanner({
    title: 'Scan For Maintenance',
    instructions: 'Scan an asset ID, barcode, serial number, container ID, or container serial number to add it to this maintenance log.',
    onScan: async identifier => {
      await addIdentifierToMaintenanceSelection(identifier);
    }
  });
}

function scanForAssetCheck(targetInputId, actionName) {
  openBarcodeScanner({
    title: 'Scan For Asset Check',
    instructions: 'Scan an Asset ID, barcode, or serial number for the asset check.',
    onScan: async identifier => {
      const input = document.getElementById(targetInputId);
      if (input) input.value = identifier;
      if (actionName === 'start') {
        await startAssetCheck();
      } else {
        checkAsset();
      }
    }
  });
}

// Update the overdue events counter
function updateOverdueCounter(count) {
    const counter = document.getElementById('overdue-counter');
    if (counter) {
        if (count > 0) {
            counter.textContent = count;
            counter.style.display = 'inline-block';
            counter.style.background = '#dc3545'; // Red for overdue
            counter.style.animation = 'pulse 2s infinite'; // Add pulsing animation
        } else {
            counter.style.display = 'none';
        }
    }
}

// Count overdue events from events data
function countOverdueEvents(eventsData) {
    return eventsData.filter(event => event.state === 'Overdue').length;
}

// Helper functions for event tags
function getTagStyle(tag) {
    if (tag === 'dry hire') {
        return 'background: #17a2b8; color: white;';
    }
    return 'background: #28a745; color: white;';
}

function getTagDisplay(tag) {
    return tag === 'dry hire' ? 'DRY HIRE' : 'EVENT';
}

// Navigation functions
function isMobileNavigationViewport() {
  return window.matchMedia && window.matchMedia("(max-width: 768px)").matches;
}

function setMobileNavigation(open) {
  const shell = document.getElementById("appShell");
  const toggle = document.getElementById("mobileNavToggle");
  const sidebar = document.getElementById("appSidebar");

  if (!shell || !toggle || !sidebar) return;

  shell.classList.toggle("nav-collapsed", !open);
  toggle.setAttribute("aria-expanded", String(open));
  sidebar.setAttribute("aria-hidden", String(!open && isMobileNavigationViewport()));
}

function toggleMobileNavigation() {
  const shell = document.getElementById("appShell");
  if (!shell) return;

  setMobileNavigation(shell.classList.contains("nav-collapsed"));
}

function closeMobileNavigation() {
  if (isMobileNavigationViewport()) {
    setMobileNavigation(false);
  }
}

function setupMobileNavigation() {
  const shell = document.getElementById("appShell");
  if (!shell) return;

  const sync = () => {
    setMobileNavigation(!isMobileNavigationViewport());
  };

  sync();

  if (window.matchMedia) {
    const media = window.matchMedia("(max-width: 768px)");
    if (media.addEventListener) {
      media.addEventListener("change", sync);
    } else if (media.addListener) {
      media.addListener(sync);
    }
  } else {
    window.addEventListener("resize", sync);
  }
}

function showSection(sectionName) {
  const adminOnlySections = new Set(["logs", "maintenance-report", "users", "pdf-settings"]);
  const superAdminOnlySections = new Set(["companies"]);
  if (adminOnlySections.has(sectionName) && !isAdminUser()) {
    return showSection("events");
  }
  if (superAdminOnlySections.has(sectionName) && !isSuperAdminUser()) {
    return showSection("events");
  }

  const targetSection = document.getElementById(sectionName + "-section");
  if (!targetSection) return;

  document.querySelectorAll(".content-section").forEach((section) => {
    const isActive = section === targetSection;
    section.classList.toggle("active", isActive);
    section.setAttribute("aria-hidden", String(!isActive));
  });

  document.querySelectorAll(".nav-item").forEach((item) => {
    const isActive = item.getAttribute("onclick") === `showSection('${sectionName}')`;
    item.classList.toggle("active", isActive);
    if (isActive) {
      item.setAttribute("aria-current", "page");
    } else {
      item.removeAttribute("aria-current");
    }
  });

  const mainContent = document.getElementById("mainContent");
  if (mainContent) {
    mainContent.setAttribute("tabindex", "-1");
    mainContent.focus({ preventScroll: true });
  }

  closeMobileNavigation();

  // Load section data
  switch (sectionName) {
    case "dashboard":
      loadDashboard();
      break;
    case "events":
      loadAllEvents();
      break;
    case "inventory":
      loadInventory();
      break;
    case "containers":
      loadContainers();
      break;
    case "logs":
      loadLogs();
      break;
    case "maintenance-report":
      loadMaintenanceReportSection();
      break;
    case "prepare":
      loadPrepareEvents();
      break;
    case "return":
      loadReturnEvents();
      break;
    case "transfer":
      loadTransferHistory();
      break;
    case "maintenance":
      loadMaintenanceAssets();
      // Ensure the Log Maintenance button is visible when entering maintenance section
      const logMaintenanceBtn = document.getElementById('log-maintenance-btn');
      if (logMaintenanceBtn) {
        logMaintenanceBtn.style.display = 'inline-block';
      }
      break;
    case "asset-check":
      loadAssetCheck();
      break;
    case "users":
      loadUsersAdmin();
      break;
    case "pdf-settings":
      loadPdfSettingsSection();
      break;
    case "companies":
      loadCompaniesAdmin();
      break;
    case "change-password":
      loadChangePasswordSection();
      break;
    case "delivery-order":
      break;
  }
}

// Modal functions
let __lastFocusedBeforeModal = null;

function getFocusableElements(container) {
  if (!container) return [];
  const selector = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])'
  ].join(',');

  return Array.from(container.querySelectorAll(selector))
    .filter(el => el.offsetParent !== null || el === document.activeElement);
}

function focusModalStart(modal) {
  const focusable = getFocusableElements(modal);
  const target = focusable.find(el => !el.classList.contains('close-btn') && !el.classList.contains('close')) || focusable[0];
  if (target) {
    setTimeout(() => target.focus({ preventScroll: true }), 0);
  }
}

function openModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) {
    __lastFocusedBeforeModal = document.activeElement;
    modal.classList.add("active");
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-hidden", "false");
    enhanceModalAccessibility(modal);

    if (modalId === "editQuantityModal") {
      modal.style.zIndex = "1100";
    }

    if (modalId === "addAssetModal") {
      prepareAddAssetModal();
    }

    focusModalStart(modal);
  }
}


function closeModal(modalId) {
  const modal = document.getElementById(modalId);
  if (!modal) return;
  modal.classList.remove("active");
  modal.setAttribute("aria-hidden", "true");

  if (__lastFocusedBeforeModal && typeof __lastFocusedBeforeModal.focus === 'function') {
    setTimeout(() => {
      try { __lastFocusedBeforeModal.focus({ preventScroll: true }); } catch (e) {}
    }, 0);
  }
}

let appDialogQueue = Promise.resolve();

function ensureAppDialogStyles() {
  if (document.getElementById('app-dialog-styles')) return;

  const style = document.createElement('style');
  style.id = 'app-dialog-styles';
  style.textContent = `
    .app-dialog-modal {
      z-index: 3000;
      background: rgba(17, 24, 39, 0.54);
      backdrop-filter: blur(8px);
      padding: 20px;
    }

    .app-dialog-modal.active {
      display: flex !important;
      align-items: center;
      justify-content: center;
    }

    .app-dialog-content {
      width: min(92vw, 460px) !important;
      max-width: 460px !important;
      margin: 0 !important;
      padding: 0 !important;
      overflow: hidden !important;
      border: 1px solid rgba(102, 126, 234, 0.18) !important;
      border-radius: 14px !important;
      box-shadow: 0 24px 70px rgba(17, 24, 39, 0.28) !important;
    }

    .app-dialog-accent {
      height: 4px;
      background: #667eea;
    }

    .app-dialog-content[data-variant="danger"] .app-dialog-accent {
      background: #dc3545;
    }

    .app-dialog-content[data-variant="warning"] .app-dialog-accent {
      background: #ffc107;
    }

    .app-dialog-header {
      align-items: flex-start !important;
      gap: 14px;
      margin: 0 !important;
      padding: 22px 24px 12px !important;
      border-bottom: none !important;
    }

    .app-dialog-title-wrap {
      display: flex;
      align-items: center;
      gap: 12px;
      min-width: 0;
    }

    .app-dialog-icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 34px;
      height: 34px;
      flex: 0 0 34px;
      border-radius: 50%;
      background: rgba(102, 126, 234, 0.12);
      color: #667eea;
      font-weight: 800;
      font-size: 18px;
    }

    .app-dialog-content[data-variant="danger"] .app-dialog-icon {
      background: rgba(220, 53, 69, 0.12);
      color: #dc3545;
    }

    .app-dialog-content[data-variant="warning"] .app-dialog-icon {
      background: rgba(255, 193, 7, 0.22);
      color: #856404;
    }

    .app-dialog-title {
      color: #2f2f3a !important;
      font-size: 1.25rem !important;
      line-height: 1.25;
    }

    .app-dialog-body {
      color: #4b5563;
      font-size: 14px;
      line-height: 1.55;
      padding: 0 24px 8px !important;
      white-space: pre-line;
    }

    .app-dialog-actions {
      display: flex;
      justify-content: flex-end;
      gap: 10px;
      margin: 0 !important;
      padding: 16px 24px 24px !important;
      border-top: none !important;
      text-align: initial !important;
    }

    .app-dialog-actions .btn {
      min-width: 88px;
      white-space: nowrap;
    }

    @media (max-width: 560px) {
      .app-dialog-modal {
        padding: 14px;
      }

      .app-dialog-header {
        padding: 20px 20px 10px !important;
      }

      .app-dialog-body {
        padding: 0 20px 8px !important;
      }

      .app-dialog-actions {
        padding: 14px 20px 20px !important;
      }
    }
  `;
  document.head.appendChild(style);
}

function ensureAppDialogModal() {
  ensureAppDialogStyles();

  let modal = document.getElementById('appDialogModal');
  if (modal) return modal;

  modal = document.createElement('div');
  modal.id = 'appDialogModal';
  modal.className = 'modal app-dialog-modal';
  modal.innerHTML = `
    <div class="modal-content app-dialog-content" data-variant="info">
      <div class="app-dialog-accent"></div>
      <div class="modal-header app-dialog-header">
        <div class="app-dialog-title-wrap">
          <span class="app-dialog-icon" data-dialog-icon aria-hidden="true">i</span>
          <h3 class="modal-title app-dialog-title" id="appDialogTitle">Notice</h3>
        </div>
        <button type="button" class="close-btn" data-dialog-close aria-label="Close dialog">&times;</button>
      </div>
      <div class="modal-body app-dialog-body" id="appDialogMessage"></div>
      <div class="modal-footer app-dialog-actions">
        <button type="button" class="btn btn-secondary" data-dialog-cancel>Cancel</button>
        <button type="button" class="btn btn-primary" data-dialog-confirm>OK</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  return modal;
}

function showAppDialog(options = {}) {
  const runDialog = () => new Promise((resolve) => {
    const modal = ensureAppDialogModal();
    const content = modal.querySelector('.app-dialog-content');
    const titleEl = modal.querySelector('#appDialogTitle');
    const messageEl = modal.querySelector('#appDialogMessage');
    const iconEl = modal.querySelector('[data-dialog-icon]');
    const confirmButton = modal.querySelector('[data-dialog-confirm]');
    const cancelButton = modal.querySelector('[data-dialog-cancel]');
    const closeButton = modal.querySelector('[data-dialog-close]');
    const variant = options.variant || 'info';
    const isAlert = options.kind === 'alert';
    const cancelResult = isAlert ? true : false;

    content.dataset.variant = variant;
    titleEl.textContent = options.title || (isAlert ? 'Notice' : 'Confirm Action');
    messageEl.textContent = options.message || '';
    iconEl.textContent = variant === 'info' ? 'i' : '!';
    confirmButton.textContent = options.confirmText || (isAlert ? 'OK' : 'Confirm');
    confirmButton.className = `btn ${variant === 'danger' ? 'btn-danger' : variant === 'warning' ? 'btn-warning' : 'btn-primary'}`;
    cancelButton.textContent = options.cancelText || 'Cancel';
    cancelButton.style.display = isAlert ? 'none' : '';
    closeButton.style.display = options.hideClose ? 'none' : '';

    let settled = false;
    const previousFocus = document.activeElement;

    const cleanup = () => {
      modal.classList.remove('active');
      modal.setAttribute('aria-hidden', 'true');
      modal.removeEventListener('click', handleBackdropClick);
      confirmButton.removeEventListener('click', handleConfirm);
      cancelButton.removeEventListener('click', handleCancel);
      closeButton.removeEventListener('click', handleClose);
      document.removeEventListener('keydown', handleKeydown, true);

      if (previousFocus && typeof previousFocus.focus === 'function') {
        setTimeout(() => {
          try { previousFocus.focus({ preventScroll: true }); } catch (e) {}
        }, 0);
      }
    };

    const finish = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const handleConfirm = () => finish(true);
    const handleCancel = () => finish(false);
    const handleClose = () => finish(cancelResult);
    const handleBackdropClick = (event) => {
      if (event.target === modal) {
        event.preventDefault();
        event.stopPropagation();
        finish(cancelResult);
      }
    };
    const handleKeydown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        finish(cancelResult);
      }
    };

    modal.addEventListener('click', handleBackdropClick);
    confirmButton.addEventListener('click', handleConfirm);
    cancelButton.addEventListener('click', handleCancel);
    closeButton.addEventListener('click', handleClose);
    document.addEventListener('keydown', handleKeydown, true);

    modal.classList.add('active');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-hidden', 'false');
    titleEl.id = 'appDialogTitle';
    modal.setAttribute('aria-labelledby', 'appDialogTitle');
    modal.setAttribute('aria-describedby', 'appDialogMessage');
    enhanceModalAccessibility(modal);
    focusModalStart(modal);
  });

  appDialogQueue = appDialogQueue.catch(() => undefined).then(runDialog);
  return appDialogQueue;
}

function showAppConfirm(options = {}) {
  return showAppDialog({ ...options, kind: 'confirm' });
}

function showAppAlert(options = {}) {
  return showAppDialog({ ...options, kind: 'alert', confirmText: options.confirmText || 'OK' });
}

function enhanceModalAccessibility(root = document) {
  root.querySelectorAll(".close-btn:not([aria-label]), .close:not([aria-label])").forEach((button) => {
    button.setAttribute("aria-label", "Close dialog");
  });

  root.querySelectorAll(".modal").forEach((modal) => {
    modal.setAttribute("aria-hidden", modal.classList.contains("active") ? "false" : "true");
    modal.setAttribute("role", "dialog");
  });
}

function enhanceNavigationAccessibility() {
  document.querySelectorAll(".content-section").forEach(section => {
    section.setAttribute("aria-hidden", String(!section.classList.contains("active")));
  });

  document.querySelectorAll(".nav-item").forEach(item => {
    item.setAttribute("type", "button");
    if (item.classList.contains("active")) {
      item.setAttribute("aria-current", "page");
    } else {
      item.removeAttribute("aria-current");
    }
  });
}

// API functions
async function apiCall(endpoint, method = "GET", data = null) {
  try {
    const isFormData = typeof FormData !== 'undefined' && data instanceof FormData;
    const options = {
      method: method,
      headers: {
        "X-Client-Id": REALTIME_CLIENT_ID,
      },
    };

    if (isFormData) {
      options.body = data;
    } else {
      options.headers["Content-Type"] = "application/json";
    }

    if (data && !isFormData) {
      options.body = JSON.stringify(data);
    }

    const response = await fetch(endpoint, options);
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || "API call failed");
    }

    return result;
  } catch (error) {
    console.error("API Error:", error);
    showNotification("error", error.message);
    throw error;
  }
}

function formatEventFileSize(bytes) {
  const size = Number(bytes || 0);
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function formatEventFileModified(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

function renderEventFilesList(eventId, files) {
  const list = Array.isArray(files) ? files : [];

  if (!list.length) {
    return '<div style="padding: 14px; border: 1px dashed #d7dde8; border-radius: 8px; color: #667085; background: #fafbff;">No files uploaded yet.</div>';
  }

  return list.map(file => {
    const name = String(file.name || '');
    const downloadUrl = file.downloadUrl || `/api/events/${eventId}/files/${encodeURIComponent(name)}`;
    const modified = formatEventFileModified(file.modifiedAt);
    const deleteButton = isAdminUser()
      ? `<button type="button" class="btn btn-danger btn-sm" onclick="deleteEventFile(${eventId}, '${escapeJs(name)}')" style="padding: 6px 10px;">Delete</button>`
      : '';

    return `
      <div style="display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 10px 12px; border: 1px solid #e9ecef; border-radius: 8px; background: #fff; margin-bottom: 8px;">
        <div style="min-width: 0; flex: 1;">
          <div style="font-weight: 600; color: #344054; overflow-wrap: anywhere;">${escapeHtml(name)}</div>
          <div style="font-size: 12px; color: #667085; margin-top: 2px;">
            ${formatEventFileSize(file.size)}${modified ? ` · ${escapeHtml(modified)}` : ''}
          </div>
        </div>
        <div style="display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end;">
          <a class="btn btn-secondary btn-sm" href="${escapeHtmlAttr(downloadUrl)}" style="padding: 6px 10px;">Download</a>
          ${deleteButton}
        </div>
      </div>
    `;
  }).join('');
}

function renderEventNotesFilesSection(event) {
  const eventId = Number(event.id);
  const notes = event.notes || '';

  return `
    <div style="margin-bottom: 25px; border: 1px solid #e9ecef; border-radius: 10px; overflow: hidden; background: #fff;">
      <div style="display: flex; flex-wrap: wrap; gap: 0;">
        <div style="padding: 16px; border-right: 1px solid #e9ecef; flex: 1 1 360px; min-width: 0;">
          <h4 style="margin: 0 0 12px 0; color: #495057; font-size: 16px;">Event Notes</h4>
          <textarea id="eventNotesInput-${eventId}" class="form-input" rows="5" style="min-height: 128px; resize: vertical;" placeholder="Add plaintext notes for this event...">${escapeHtml(notes)}</textarea>
          <div style="display: flex; justify-content: flex-end; margin-top: 10px;">
            <button type="button" id="eventNotesSaveButton-${eventId}" class="btn btn-primary" onclick="saveEventNotes(${eventId})">Save Notes</button>
          </div>
        </div>
        <div style="padding: 16px; background: #f8f9fa; flex: 1 1 280px; min-width: 260px;">
          <h4 style="margin: 0 0 12px 0; color: #495057; font-size: 16px;">Event Files</h4>
          <div style="display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-bottom: 12px;">
            <input type="file" id="eventFileInput-${eventId}" class="form-input" multiple style="flex: 1 1 180px; min-width: 180px; padding: 9px;">
            <button type="button" id="eventFileUploadButton-${eventId}" class="btn btn-success" onclick="uploadEventFiles(${eventId})">Upload</button>
          </div>
          <div id="eventFilesList-${eventId}">
            ${renderEventFilesList(eventId, event.files || [])}
          </div>
        </div>
      </div>
    </div>
  `;
}

function updateEventFilesList(eventId, files) {
  const list = document.getElementById(`eventFilesList-${eventId}`);
  if (list) {
    list.innerHTML = renderEventFilesList(eventId, files || []);
  }

  if (window.currentEventData && Number(window.currentEventData.id) === Number(eventId)) {
    window.currentEventData.files = files || [];
  }
}

async function saveEventNotes(eventId) {
  const textarea = document.getElementById(`eventNotesInput-${eventId}`);
  const button = document.getElementById(`eventNotesSaveButton-${eventId}`);
  if (!textarea) return;

  try {
    if (button) button.disabled = true;
    const response = await apiCall(`/api/events/${eventId}/notes`, "PUT", {
      notes: textarea.value
    });

    if (window.currentEventData && Number(window.currentEventData.id) === Number(eventId)) {
      window.currentEventData.notes = response.data?.notes || textarea.value;
    }

    showNotification("success", "Event notes saved");
  } catch (error) {
    showNotification("error", "Failed to save event notes");
  } finally {
    if (button) button.disabled = false;
  }
}

async function uploadEventFiles(eventId) {
  const input = document.getElementById(`eventFileInput-${eventId}`);
  const button = document.getElementById(`eventFileUploadButton-${eventId}`);
  const files = Array.from(input?.files || []);

  if (!files.length) {
    showNotification("warning", "Choose at least one file first");
    return;
  }

  const formData = new FormData();
  files.forEach(file => formData.append("files", file));

  try {
    if (button) button.disabled = true;
    const response = await fetch(`/api/events/${eventId}/files`, {
      method: "POST",
      headers: {
        "X-Client-Id": REALTIME_CLIENT_ID,
      },
      body: formData
    });
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || "Failed to upload event files");
    }

    if (input) input.value = "";
    updateEventFilesList(eventId, result.data || []);
    showNotification("success", "File upload complete");
  } catch (error) {
    console.error("Event file upload failed:", error);
    showNotification("error", error.message || "Failed to upload event files");
  } finally {
    if (button) button.disabled = false;
  }
}

async function deleteEventFile(eventId, filename) {
  if (!isAdminUser()) {
    showNotification("error", "Admin privileges required to delete event files");
    return;
  }

  const confirmed = await showAppConfirm({
    title: "Delete File",
    message: `Delete "${filename}" from this event?`,
    confirmText: "Delete",
    cancelText: "Cancel",
    variant: "danger",
  });
  if (!confirmed) return;

  try {
    const response = await fetch(`/api/events/${eventId}/files/${encodeURIComponent(filename)}`, {
      method: "DELETE",
      headers: {
        "X-Client-Id": REALTIME_CLIENT_ID,
      },
    });
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || "Failed to delete event file");
    }

    updateEventFilesList(eventId, result.data || []);
    showNotification("success", "Event file deleted");
  } catch (error) {
    console.error("Event file delete failed:", error);
    showNotification("error", error.message || "Failed to delete event file");
  }
}


// ---------------- PDF Settings ----------------
function normalisePdfSettings(settings = {}) {
  return {
    footerText: typeof settings.footerText === 'string' ? settings.footerText : DEFAULT_PDF_FOOTER_TEXT,
    logoUrl: settings.logoUrl || "/api/pdf-settings/logo",
    hasCustomLogo: !!settings.hasCustomLogo,
    logoOriginalName: settings.logoOriginalName || "",
    updatedAt: settings.updatedAt || ""
  };
}

function getPdfLogoUrl() {
  return (pdfSettings && pdfSettings.logoUrl) || "/api/pdf-settings/logo";
}

function getPdfFooterText() {
  return pdfSettings && typeof pdfSettings.footerText === 'string'
    ? pdfSettings.footerText
    : DEFAULT_PDF_FOOTER_TEXT;
}

function renderPdfFooterHtml() {
  const text = getPdfFooterText();
  if (!text) return '';
  return text.split(/\r?\n/).map(line => escapeHtml(line)).join('<br>');
}

function pdfMmToPx(mm) {
  return (Number(mm || 0) * 96) / 25.4;
}

function mountPdfMeasureBox(measureBox, measureWidthMm) {
  // The application body is displayed with CSS zoom, but print windows render
  // at full scale. Mount beside the body and normalise any remaining scaling.
  const measureRoot = document.documentElement || document.body;
  measureRoot.appendChild(measureBox);

  const expectedWidth = pdfMmToPx(measureWidthMm);
  const renderedWidth = measureBox.getBoundingClientRect().width;
  const measurementScale = renderedWidth > 0 && expectedWidth > 0
    ? renderedWidth / expectedWidth
    : 1;

  return height => Number(height || 0) / measurementScale;
}

function pdfFooterReserveMm(pageConfig, footerHeightPx) {
  const pageHeightMm = Number(pageConfig.pageHeightMm || 297);
  const pageFlowHeightMm = Number(pageConfig.pageFlowHeightMm || 276);
  const topPaddingMm = Number(pageConfig.topPaddingMm ?? 7);
  const footerBottomMm = Number(pageConfig.footerBottomMm ?? 7);
  const footerGapMm = Number(pageConfig.footerGapMm ?? 2);
  const minReserveMm = Math.max(0, Number(pageConfig.minReserveMm ?? 6));
  const footerHeightMm = Math.max(0, Number(footerHeightPx || 0) * 25.4 / 96);
  const safeFlowHeightMm = pageHeightMm - topPaddingMm - footerBottomMm - footerHeightMm - footerGapMm;
  return Math.max(minReserveMm, pageFlowHeightMm - safeFlowHeightMm, 0);
}

function applyPdfSettingsToApp() {
  const logo = document.getElementById('company-logo');
  if (logo) {
    logo.src = getPdfLogoUrl();
    logo.style.display = '';
  }
}

async function loadPdfSettings(force = false) {
  if (!force && pdfSettings && pdfSettings.logoUrl) {
    return pdfSettings;
  }

  try {
    const res = await apiCall('/api/pdf-settings');
    pdfSettings = normalisePdfSettings(res.data || {});
  } catch (error) {
    console.warn('PDF settings not loaded:', error);
    pdfSettings = normalisePdfSettings(pdfSettings);
  }

  applyPdfSettingsToApp();
  renderPdfSettingsForm();
  return pdfSettings;
}

async function setupPdfSettingsTab() {
  if (!isAdminUser()) {
    removePdfSettingsTab();
    return;
  }

  ensurePdfSettingsNavItem();
  ensurePdfSettingsSection();
  renderPdfSettingsForm();
}

function removePdfSettingsTab() {
  const tab = document.querySelector(`[onclick="showSection('pdf-settings')"]`);
  if (tab) tab.remove();

  const section = document.getElementById('pdf-settings-section');
  if (section) section.remove();
}

function ensurePdfSettingsNavItem() {
  if (document.querySelector(`[onclick="showSection('pdf-settings')"]`)) return;

  const settingsSection = Array.from(document.querySelectorAll('.nav-section'))
    .find(section => {
      const heading = section.querySelector('h3');
      return heading && heading.textContent.trim() === 'Settings';
    });

  if (!settingsSection) {
    console.warn('Could not find Settings section for PDF Settings tab');
    return;
  }

  const pdfSettingsTab = document.createElement('button');
  pdfSettingsTab.type = 'button';
  pdfSettingsTab.className = 'nav-item';
  pdfSettingsTab.setAttribute('onclick', "showSection('pdf-settings')");
  pdfSettingsTab.textContent = '📄 PDF Settings';

  const logoutButton = settingsSection.querySelector(`[onclick="logout()"]`);

  if (logoutButton) {
    settingsSection.insertBefore(pdfSettingsTab, logoutButton);
  } else {
    settingsSection.appendChild(pdfSettingsTab);
  }
}

function ensurePdfSettingsSection() {
  if (document.getElementById('pdf-settings-section')) return;

  const firstSection = document.querySelector('.content-section');
  const sectionParent = firstSection ? firstSection.parentElement : document.body;

  const section = document.createElement('div');
  section.id = 'pdf-settings-section';
  section.className = 'content-section';

  section.innerHTML = `
    <div class="content-header">
      <h2 class="content-title">PDF Settings</h2>
    </div>

    <div class="form-container">
      <div style="display:grid;grid-template-columns:minmax(240px,320px) minmax(280px,1fr);gap:24px;align-items:start;">
        <div class="form-group">
          <label class="form-label" for="pdfSettingsLogoInput">Logo</label>
          <div style="border:1px solid #e9ecef;border-radius:8px;padding:18px;background:#fff;min-height:130px;display:flex;align-items:center;justify-content:center;margin-bottom:12px;">
            <img id="pdfSettingsLogoPreview" alt="PDF Logo" style="max-width:240px;max-height:90px;object-fit:contain;">
          </div>
          <input id="pdfSettingsLogoInput" class="form-input" type="file" accept="image/png,image/jpeg,image/webp,image/gif">
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;">
            <button type="button" class="btn btn-primary" onclick="uploadPdfSettingsLogo()">Upload Logo</button>
            <button type="button" class="btn btn-secondary" onclick="resetPdfSettingsLogo()">Reset Logo</button>
          </div>
          <div id="pdfSettingsLogoName" style="font-size:12px;color:#666;margin-top:8px;"></div>
        </div>

        <div class="form-group">
          <label class="form-label" for="pdfSettingsFooterText">Footer</label>
          <textarea id="pdfSettingsFooterText" class="form-input" rows="5" maxlength="2000"></textarea>
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;">
            <button type="button" class="btn btn-primary" onclick="savePdfSettingsFooter()">Save Footer</button>
            <button type="button" class="btn btn-secondary" onclick="resetPdfSettingsFooter()">Reset Footer</button>
          </div>
        </div>
      </div>
    </div>
  `;

  sectionParent.appendChild(section);
}

function renderPdfSettingsForm() {
  const logoPreview = document.getElementById('pdfSettingsLogoPreview');
  const logoName = document.getElementById('pdfSettingsLogoName');
  const footerText = document.getElementById('pdfSettingsFooterText');

  if (logoPreview) {
    logoPreview.src = getPdfLogoUrl();
  }

  if (logoName) {
    logoName.textContent = pdfSettings.hasCustomLogo && pdfSettings.logoOriginalName
      ? pdfSettings.logoOriginalName
      : 'Default logo';
  }

  if (footerText && footerText.value !== getPdfFooterText()) {
    footerText.value = getPdfFooterText();
  }
}

async function loadPdfSettingsSection() {
  if (!isAdminUser()) {
    showNotification('error', 'Admin privileges required');
    showSection('events');
    return;
  }

  ensurePdfSettingsSection();
  await loadPdfSettings(true);
}

async function uploadPdfSettingsLogo() {
  if (!isAdminUser()) {
    showNotification('error', 'Admin privileges required');
    return;
  }

  const input = document.getElementById('pdfSettingsLogoInput');
  const file = input && input.files ? input.files[0] : null;

  if (!file) {
    showNotification('warning', 'Choose a logo file first');
    return;
  }

  const formData = new FormData();
  formData.append('logo', file);

  try {
    const response = await fetch('/api/pdf-settings/logo', {
      method: 'POST',
      headers: {
        "X-Client-Id": REALTIME_CLIENT_ID,
      },
      body: formData
    });
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || 'Failed to upload logo');
    }

    pdfSettings = normalisePdfSettings(result.data || {});
    if (input) input.value = '';
    applyPdfSettingsToApp();
    renderPdfSettingsForm();
    showNotification('success', 'PDF logo updated');
  } catch (error) {
    console.error('PDF logo upload failed:', error);
    showNotification('error', error.message || 'Failed to upload logo');
  }
}

async function resetPdfSettingsLogo() {
  if (!isAdminUser()) {
    showNotification('error', 'Admin privileges required');
    return;
  }

  try {
    const response = await fetch('/api/pdf-settings/logo', {
      method: 'DELETE',
      headers: {
        "X-Client-Id": REALTIME_CLIENT_ID,
      },
    });
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || 'Failed to reset logo');
    }

    pdfSettings = normalisePdfSettings(result.data || {});
    applyPdfSettingsToApp();
    renderPdfSettingsForm();
    showNotification('success', 'PDF logo reset');
  } catch (error) {
    console.error('PDF logo reset failed:', error);
    showNotification('error', error.message || 'Failed to reset logo');
  }
}

async function savePdfSettingsFooter() {
  if (!isAdminUser()) {
    showNotification('error', 'Admin privileges required');
    return;
  }

  const textarea = document.getElementById('pdfSettingsFooterText');
  const footerText = textarea ? textarea.value : '';

  try {
    const res = await apiCall('/api/pdf-settings', 'PUT', { footerText });
    pdfSettings = normalisePdfSettings(res.data || {});
    renderPdfSettingsForm();
    showNotification('success', 'PDF footer saved');
  } catch (error) {
    showNotification('error', 'Failed to save PDF footer');
  }
}

async function resetPdfSettingsFooter() {
  const textarea = document.getElementById('pdfSettingsFooterText');
  if (textarea) textarea.value = DEFAULT_PDF_FOOTER_TEXT;
  await savePdfSettingsFooter();
}


// ---------------- Company Management ----------------
async function fetchCompanies(force = false) {
  if (!force && companyOptions.length) return companyOptions;
  if (!isSuperAdminUser()) {
    companyOptions = currentUser?.company ? [currentUser.company] : [];
    return companyOptions;
  }

  const res = await apiCall('/api/companies');
  companyOptions = res.data || [];
  return companyOptions;
}

function companyOptionsMarkup(selectedCode = '') {
  const selected = String(selectedCode || '').toUpperCase();
  return (companyOptions || []).map(company => `
    <option value="${escapeHtmlAttr(company.code)}" ${String(company.code).toUpperCase() === selected ? 'selected' : ''}>
      ${escapeHtml(company.code)} - ${escapeHtml(company.name || company.code)}
    </option>
  `).join('');
}

function ensureCompanyActionModals() {
  if (document.getElementById('createCompanyModal')) return;

  const style = document.createElement('style');
  style.id = 'company-action-styles';
  style.textContent = `
    .company-action-buttons {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
    }
    .company-action-buttons .btn {
      min-width: 150px;
    }
    .company-action-buttons .company-edit-button,
    .company-edit-button {
      background: #fd7e14;
      color: #fff;
    }
    .company-action-buttons .company-edit-button:hover,
    .company-edit-button:hover {
      background: #e96b02;
    }
    @media (max-width: 640px) {
      .company-action-buttons .btn {
        width: 100%;
      }
    }
  `;
  document.head.appendChild(style);

  const wrapper = document.createElement('div');
  wrapper.innerHTML = `
    <div id="createCompanyModal" class="modal">
      <div class="modal-content" style="max-width:620px;">
        <div class="modal-header">
          <h3 class="modal-title">Create Company</h3>
          <button type="button" class="close-btn" onclick="closeModal('createCompanyModal')" aria-label="Close">&times;</button>
        </div>
        <form onsubmit="event.preventDefault(); createCompanyFromUsersAdmin();">
          <div class="modal-body">
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;">
              <div class="form-group">
                <label class="form-label" for="userNewCompanyCode">Code</label>
                <input id="userNewCompanyCode" class="form-input" placeholder="e.g. CLIENTCO" autocomplete="off">
              </div>
              <div class="form-group">
                <label class="form-label" for="userNewCompanyName">Name</label>
                <input id="userNewCompanyName" class="form-input" placeholder="Company name" autocomplete="organization">
              </div>
              <div class="form-group">
                <label class="form-label" for="userNewCompanyFirstAdmin">First Admin</label>
                <input id="userNewCompanyFirstAdmin" class="form-input" placeholder="Existing or new username" autocomplete="off">
              </div>
              <div class="form-group">
                <label class="form-label" for="userNewCompanyFirstAdminPassword">Password</label>
                <input id="userNewCompanyFirstAdminPassword" type="password" class="form-input" placeholder="Only needed for a new user" autocomplete="new-password">
              </div>
            </div>
          </div>
          <div class="modal-footer modal-actions">
            <button type="button" class="btn btn-secondary" onclick="closeModal('createCompanyModal')">Cancel</button>
            <button type="submit" class="btn btn-success">Create Company</button>
          </div>
        </form>
      </div>
    </div>

    <div id="editCompanyModal" class="modal">
      <div class="modal-content" style="max-width:520px;">
        <div class="modal-header">
          <h3 class="modal-title">Edit Company</h3>
          <button type="button" class="close-btn" onclick="closeModal('editCompanyModal')" aria-label="Close">&times;</button>
        </div>
        <form onsubmit="event.preventDefault(); editCompanyFromUsersAdmin();">
          <div class="modal-body">
            <div class="form-group">
              <label class="form-label" for="userEditCompanyCode">Company</label>
              <select id="userEditCompanyCode" class="form-input" onchange="populateEditCompanyName()"></select>
            </div>
            <div class="form-group">
              <label class="form-label" for="userEditCompanyName">Company Name</label>
              <input id="userEditCompanyName" class="form-input" placeholder="Company name" autocomplete="organization">
            </div>
            <p style="margin:8px 0 0;color:#667085;font-size:13px;">Company codes stay fixed so folders and user assignments remain intact.</p>
          </div>
          <div class="modal-footer modal-actions">
            <button type="button" class="btn btn-secondary" onclick="closeModal('editCompanyModal')">Cancel</button>
            <button type="submit" class="btn company-edit-button">Save Company</button>
          </div>
        </form>
      </div>
    </div>

    <div id="deleteCompanyModal" class="modal">
      <div class="modal-content" style="max-width:520px;">
        <div class="modal-header">
          <h3 class="modal-title">Delete Company</h3>
          <button type="button" class="close-btn" onclick="closeModal('deleteCompanyModal')" aria-label="Close">&times;</button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label class="form-label" for="userDeleteCompanyCode">Company</label>
            <select id="userDeleteCompanyCode" class="form-input"></select>
          </div>
          <p style="margin:8px 0 0;color:#b42318;font-size:13px;">Deleting a company permanently removes its assets and assigned non-super-admin users.</p>
        </div>
        <div class="modal-footer modal-actions">
          <button type="button" class="btn btn-secondary" onclick="closeModal('deleteCompanyModal')">Cancel</button>
          <button type="button" class="btn btn-danger" onclick="deleteCompanyFromUsersAdmin()">Delete Company</button>
        </div>
      </div>
    </div>
  `;

  while (wrapper.firstElementChild) {
    document.body.appendChild(wrapper.firstElementChild);
  }
}

function companyActionButtonsMarkup() {
  return `
    <div class="company-action-buttons">
      <button type="button" class="btn btn-success" onclick="openCreateCompanyModal()">Create Company</button>
      <button type="button" class="btn company-edit-button" onclick="openEditCompanyModal()">Edit Company</button>
      <button type="button" class="btn btn-danger" onclick="openDeleteCompanyModal()">Delete Company</button>
    </div>
  `;
}

function openCreateCompanyModal() {
  ensureCompanyActionModals();
  ['userNewCompanyCode', 'userNewCompanyName', 'userNewCompanyFirstAdmin', 'userNewCompanyFirstAdminPassword'].forEach(id => {
    const input = document.getElementById(id);
    if (input) input.value = '';
  });
  openModal('createCompanyModal');
}

function populateEditCompanyName() {
  const code = document.getElementById('userEditCompanyCode')?.value || '';
  const company = companyOptions.find(item => String(item.code || '').toUpperCase() === String(code).toUpperCase());
  const input = document.getElementById('userEditCompanyName');
  if (input) input.value = company?.name || '';
}

async function openEditCompanyModal() {
  ensureCompanyActionModals();
  await fetchCompanies(true);
  const select = document.getElementById('userEditCompanyCode');
  if (select) select.innerHTML = companyOptionsMarkup(currentUser?.company?.code || '');
  populateEditCompanyName();
  openModal('editCompanyModal');
}

async function openDeleteCompanyModal() {
  ensureCompanyActionModals();
  await fetchCompanies(true);
  const select = document.getElementById('userDeleteCompanyCode');
  if (select) select.innerHTML = companyOptionsMarkup('');
  openModal('deleteCompanyModal');
}

async function setupCompanyManagementTab() {
  if (!isSuperAdminUser()) {
    removeCompanyManagementTab();
    return;
  }

  ensureCompanyManagementNavItem();
  ensureCompanyManagementSection();
  await fetchCompanies(true);
  renderCompanySwitchControl();
}

function removeCompanyManagementTab() {
  const tab = document.querySelector(`[onclick="showSection('companies')"]`);
  if (tab) tab.remove();

  const section = document.getElementById('companies-section');
  if (section) section.remove();
}

function ensureCompanyManagementNavItem() {
  if (document.querySelector(`[onclick="showSection('companies')"]`)) return;

  const settingsSection = Array.from(document.querySelectorAll('.nav-section'))
    .find(section => {
      const heading = section.querySelector('h3');
      return heading && heading.textContent.trim() === 'Settings';
    });

  if (!settingsSection) {
    console.warn('Could not find Settings section for Companies tab');
    return;
  }

  const companiesTab = document.createElement('button');
  companiesTab.type = 'button';
  companiesTab.className = 'nav-item super-admin-only';
  companiesTab.setAttribute('onclick', "showSection('companies')");
  companiesTab.innerHTML = '&#127970; Companies';

  const logoutButton = settingsSection.querySelector(`[onclick="logout()"]`);
  if (logoutButton) {
    settingsSection.insertBefore(companiesTab, logoutButton);
  } else {
    settingsSection.appendChild(companiesTab);
  }
}

function ensureCompanyManagementSection() {
  if (document.getElementById('companies-section')) return;

  ensureCompanyActionModals();
  const firstSection = document.querySelector('.content-section');
  const sectionParent = firstSection ? firstSection.parentElement : document.body;

  const section = document.createElement('div');
  section.id = 'companies-section';
  section.className = 'content-section';

  section.innerHTML = `
    <div class="content-header">
      <h2 class="content-title">Companies</h2>
    </div>

    <div class="form-container" style="margin-bottom:20px;">
      <h3 style="margin-bottom:15px;">Active Company</h3>
      <div style="display:flex;gap:10px;align-items:end;flex-wrap:wrap;">
        <div class="form-group" style="min-width:280px;">
          <label class="form-label" for="activeCompanySelect">Company</label>
          <select id="activeCompanySelect" class="form-input"></select>
        </div>
        <button type="button" class="btn btn-primary" onclick="switchCompanyAdmin()">Switch</button>
      </div>
    </div>

    <div class="form-container" style="margin-bottom:20px;">
      <h3 style="margin-bottom:15px;">Company Actions</h3>
      ${companyActionButtonsMarkup()}
    </div>

    <div class="form-container">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:15px;">
        <h3 style="margin:0;">Existing Companies</h3>
        <button type="button" class="btn btn-secondary btn-sm" onclick="loadCompaniesAdmin()">Refresh</button>
      </div>
      <div id="companies-admin-table-container">
        <p style="text-align:center;color:#666;padding:30px;">Loading companies...</p>
      </div>
    </div>
  `;

  sectionParent.appendChild(section);
}

function renderCompanySwitchControl() {
  const select = document.getElementById('activeCompanySelect');
  if (!select) return;
  const activeCode = currentUser?.company?.code || '';
  select.innerHTML = companyOptionsMarkup(activeCode);
}

async function loadCompaniesAdmin() {
  if (!isSuperAdminUser()) {
    showNotification('error', 'Super admin privileges required');
    showSection('events');
    return;
  }

  ensureCompanyManagementSection();
  const container = document.getElementById('companies-admin-table-container');
  if (container) {
    container.innerHTML = '<p style="text-align:center;color:#666;padding:30px;">Loading companies...</p>';
  }

  try {
    const companies = await fetchCompanies(true);
    renderCompanySwitchControl();

    if (!container) return;
    if (!companies.length) {
      container.innerHTML = '<p style="text-align:center;color:#666;padding:30px;">No companies found.</p>';
      return;
    }

    container.innerHTML = `
      <table class="table">
        <thead>
          <tr>
            <th>Code</th>
            <th>Name</th>
            <th>Users</th>
            <th>Backend Folder</th>
            <th>Frontend Folder</th>
            <th>Branding</th>
          </tr>
        </thead>
        <tbody>
          ${companies.map(company => `
            <tr>
              <td><strong>${escapeHtml(company.code)}</strong>${company.isActive ? ' <span style="font-size:11px;color:#198754;">active</span>' : ''}</td>
              <td>${escapeHtml(company.name || '')}</td>
              <td>${Number(company.userCount || 0)}</td>
              <td style="font-size:12px;color:#667085;overflow-wrap:anywhere;">${escapeHtml(company.backendFolder || '')}</td>
              <td style="font-size:12px;color:#667085;overflow-wrap:anywhere;">${escapeHtml(company.frontendFolder || '')}</td>
              <td>${company.brandingSetupRequired ? 'Pending' : 'Ready'}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  } catch (error) {
    if (container) {
      container.innerHTML = `<p style="color:red;text-align:center;padding:30px;">Failed to load companies: ${escapeHtml(error.message)}</p>`;
    }
  }
}

async function deleteCompanyAdmin(code, isActive = false, companyCount = 0) {
  if (!isSuperAdminUser()) {
    showNotification('error', 'Super admin privileges required');
    return false;
  }

  if (isActive) {
    showNotification('warning', 'Switch to another company before deleting this one');
    return false;
  }

  if (Number(companyCount || 0) <= 1) {
    showNotification('warning', 'At least one company must remain');
    return false;
  }

  const company = (companyOptions || []).find(item => String(item.code || '').toUpperCase() === String(code || '').toUpperCase());
  const name = company?.name || code;

  const confirmed = await showAppConfirm({
    title: 'Delete Company',
    message: `Delete ${name || code}? This permanently removes the company folder and all company assets.`,
    confirmText: 'Delete',
    cancelText: 'Cancel',
    variant: 'danger'
  });

  if (!confirmed) return false;

  try {
    const res = await apiCall(`/api/companies/${encodeURIComponent(code)}`, 'DELETE');
    const removedUsers = res?.data?.removedUsers || [];
    const userNote = removedUsers.length ? ` Removed ${removedUsers.length} assigned user account(s).` : '';
    showNotification('success', `Company deleted.${userNote}`);
    closeModal('deleteCompanyModal');
    await loadCompaniesAdmin();
    if (document.getElementById('users-section')) {
      await loadUsersAdmin();
    }
    return true;
  } catch (error) {
    showNotification('error', `Failed to delete company: ${error.message}`);
    return false;
  }
}

async function switchCompanyAdmin() {
  const code = document.getElementById('activeCompanySelect')?.value || '';
  if (!code) {
    showNotification('warning', 'Choose a company first');
    return;
  }

  try {
    await apiCall('/api/current-company', 'PUT', { companyCode: code });
    showNotification('success', 'Company switched');
    setTimeout(() => window.location.reload(), 400);
  } catch (error) {
    showNotification('error', `Failed to switch company: ${error.message}`);
  }
}

function ensureCompanyBrandingPromptModal() {
  if (document.getElementById('companyBrandingSetupModal')) return;

  const modal = document.createElement('div');
  modal.id = 'companyBrandingSetupModal';
  modal.className = 'modal';
  modal.innerHTML = `
    <div class="modal-content" style="max-width:720px;">
      <div class="modal-header">
        <h3>Company Branding</h3>
      </div>
      <div class="modal-body">
        <p style="margin-bottom:16px;color:#495057;">
          Set the logo and footer for <strong id="companyBrandingName"></strong>. The AVPL defaults are already filled in.
        </p>
        <div style="display:grid;grid-template-columns:minmax(220px,280px) 1fr;gap:18px;align-items:start;">
          <div class="form-group">
            <label class="form-label" for="companyBrandingLogoInput">Logo</label>
            <div style="border:1px solid #e9ecef;border-radius:8px;padding:16px;background:#fff;min-height:110px;display:flex;align-items:center;justify-content:center;margin-bottom:10px;">
              <img id="companyBrandingLogoPreview" alt="Company Logo" style="max-width:220px;max-height:80px;object-fit:contain;">
            </div>
            <input id="companyBrandingLogoInput" class="form-input" type="file" accept="image/png,image/jpeg,image/webp,image/gif">
          </div>
          <div class="form-group">
            <label class="form-label" for="companyBrandingFooterText">Footer</label>
            <textarea id="companyBrandingFooterText" class="form-input" rows="6" maxlength="2000"></textarea>
          </div>
        </div>
      </div>
      <div class="modal-footer modal-actions">
        <button type="button" class="btn btn-secondary" onclick="completeCompanyBrandingSetup(true)">Use Defaults</button>
        <button type="button" class="btn btn-primary" onclick="completeCompanyBrandingSetup(false)">Save Branding</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);
}

async function showCompanyBrandingPromptIfNeeded() {
  if (!currentUser || !currentUser.isAdmin || !currentUser.company?.brandingSetupRequired) return;

  await loadPdfSettings(true);
  ensureCompanyBrandingPromptModal();

  const name = document.getElementById('companyBrandingName');
  const preview = document.getElementById('companyBrandingLogoPreview');
  const footer = document.getElementById('companyBrandingFooterText');
  const fileInput = document.getElementById('companyBrandingLogoInput');

  if (name) name.textContent = currentUser.company.name || currentUser.company.code || 'this company';
  if (preview) preview.src = getPdfLogoUrl();
  if (footer) footer.value = getPdfFooterText();
  if (fileInput) fileInput.value = '';

  openModal('companyBrandingSetupModal');
}

async function completeCompanyBrandingSetup(useDefaults = false) {
  try {
    if (useDefaults) {
      await apiCall('/api/company/branding-setup-complete', 'POST', {});
    } else {
      const input = document.getElementById('companyBrandingLogoInput');
      const file = input && input.files ? input.files[0] : null;
      const footerText = document.getElementById('companyBrandingFooterText')?.value || DEFAULT_PDF_FOOTER_TEXT;

      if (file) {
        const formData = new FormData();
        formData.append('logo', file);
        const response = await fetch('/api/pdf-settings/logo', {
          method: 'POST',
          headers: {
            "X-Client-Id": REALTIME_CLIENT_ID,
          },
          body: formData
        });
        const result = await response.json();
        if (!response.ok) {
          throw new Error(result.error || 'Failed to upload logo');
        }
        pdfSettings = normalisePdfSettings(result.data || {});
      }

      const res = await apiCall('/api/pdf-settings', 'PUT', { footerText });
      pdfSettings = normalisePdfSettings(res.data || pdfSettings);
    }

    const currentUserRes = await apiCall('/api/current-user');
    currentUser = currentUserRes.data;
    await loadPdfSettings(true);
    applyPdfSettingsToApp();
    closeModal('companyBrandingSetupModal');
    showNotification('success', 'Company branding saved');
  } catch (error) {
    showNotification('error', `Failed to save company branding: ${error.message}`);
  }
}


// ---------------- Department Management ----------------
function normalizeDepartmentCode(code) {
  const cleaned = String(code || 'UN').trim().toUpperCase().replace(/[^A-Z0-9_-]+/g, '');
  return cleaned || 'UN';
}

function departmentClassName(code) {
  return `dept-${normalizeDepartmentCode(code).toLowerCase().replace(/[^a-z0-9_-]+/g, '-')}`;
}

function getDepartmentMeta(code) {
  const normalized = normalizeDepartmentCode(code);
  return departments[normalized] || {
    code: normalized,
    name: normalized,
    color: '#e2e3e5',
    textColor: '#383d41',
    assetCount: 0
  };
}

function departmentBadgeHtml(code, showName = false) {
  const dept = getDepartmentMeta(code);
  const label = showName && dept.name && dept.name !== dept.code
    ? `${dept.code} - ${dept.name}`
    : dept.code;

  return `<span class="asset-badge ${departmentClassName(dept.code)}" title="${escapeHtmlAttr(dept.name || dept.code)}">${escapeHtml(label)}</span>`;
}

function applyDepartmentStyles() {
  let style = document.getElementById('dynamic-department-styles');
  if (!style) {
    style = document.createElement('style');
    style.id = 'dynamic-department-styles';
    document.head.appendChild(style);
  }

  const rules = Object.values(departments).map(dept => {
    const cls = departmentClassName(dept.code);
    const bg = /^#[0-9A-Fa-f]{6}$/.test(dept.color || '') ? dept.color : '#e2e3e5';
    const fg = /^#[0-9A-Fa-f]{6}$/.test(dept.textColor || '') ? dept.textColor : '#383d41';
    return `.${cls} { background: ${bg} !important; color: ${fg} !important; }`;
  });

  style.textContent = rules.join('\n');
}

async function loadDepartments(force = false) {
  if (departmentsLoaded && !force) return departments;

  const res = await apiCall('/api/departments');
  const list = res.data || [];
  departments = {};
  list.forEach(dept => {
    const code = normalizeDepartmentCode(dept.code);
    departments[code] = {
      code,
      name: dept.name || code,
      color: dept.color || '#e2e3e5',
      textColor: dept.textColor || '#383d41',
      assetCount: Number(dept.assetCount || 0)
    };
  });

  departmentsLoaded = true;
  applyDepartmentStyles();
  populateDepartmentSelects();
  renderDepartmentManager();
  return departments;
}

function sortedDepartmentList() {
  return Object.values(departments).sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
}

function populateDepartmentSelects() {
  const list = sortedDepartmentList();

  const filter = document.getElementById('department-filter');
  if (filter) {
    const options = document.getElementById('department-filter-options');
    const existingCheckboxes = Array.from(options?.querySelectorAll('input[type="checkbox"]') || []);
    const selectedCodes = new Set(existingCheckboxes.filter(input => input.checked).map(input => input.value));
    const previouslySelectedAll = existingCheckboxes.length === 0 || selectedCodes.size === existingCheckboxes.length;
    if (options) {
      options.innerHTML = list.map(dept => {
        const checked = previouslySelectedAll || selectedCodes.has(dept.code);
        return `
          <label>
            <input type="checkbox" value="${escapeHtmlAttr(dept.code)}"${checked ? ' checked' : ''} />
            <span>${escapeHtml(dept.code)} - ${escapeHtml(dept.name || dept.code)}</span>
          </label>
        `;
      }).join('');
      updateInventoryCheckboxFilterSummary('department-filter');
    }
  }

  const assetDeptSelect = document.getElementById('assetDepartment');
  if (assetDeptSelect) {
    const current = assetDeptSelect.value || 'UN';
    assetDeptSelect.innerHTML = list.map(dept => (
      `<option value="${escapeHtmlAttr(dept.code)}">${escapeHtml(dept.code)} - ${escapeHtml(dept.name || dept.code)}</option>`
    )).join('');
    assetDeptSelect.value = list.some(dept => dept.code === current) ? current : (list[0]?.code || 'UN');
  }

  ensureDepartmentDatalist();
}

function ensureDepartmentDatalist() {
  let datalist = document.getElementById('department-code-options');
  if (!datalist) {
    datalist = document.createElement('datalist');
    datalist.id = 'department-code-options';
    document.body.appendChild(datalist);
  }

  datalist.innerHTML = sortedDepartmentList().map(dept => (
    `<option value="${escapeHtmlAttr(dept.code)}">${escapeHtml(dept.name || dept.code)}</option>`
  )).join('');
}

function ensureDepartmentManagerPanel() {
  if (!currentUser || !currentUser.isAdmin) return;
  if (document.getElementById('department-admin-panel')) return;

  const inventorySection = document.getElementById('inventory-section');
  const controls = inventorySection?.querySelector('.inventory-controls');
  if (!inventorySection || !controls) return;

  const panel = document.createElement('details');
  panel.id = 'department-admin-panel';
  panel.className = 'card';
  panel.style.cssText = 'margin-bottom:20px;background:white;border-radius:8px;padding:0;box-shadow:0 4px 15px rgba(0,0,0,0.08);overflow:hidden;';
  panel.innerHTML = `
    <summary style="display:flex;justify-content:space-between;align-items:center;gap:12px;padding:16px 18px;cursor:pointer;list-style:none;">
      <div>
        <h3 style="margin:0;color:#333;">Department Management</h3>
        <p style="margin:4px 0 0;color:#666;font-size:13px;">Admin-only department setup</p>
      </div>
      <span style="font-size:13px;color:#667eea;font-weight:700;">Manage departments &#9662;</span>
    </summary>
    <div style="padding:0 18px 18px;">
      <div style="display:flex;justify-content:flex-end;margin-bottom:12px;">
        <button class="btn btn-success" onclick="openDepartmentModal()">+ Add Department</button>
      </div>
      <div id="department-admin-table" style="max-height:360px;overflow:auto;"></div>
    </div>
  `;

  controls.parentNode.insertBefore(panel, controls);
}

function renderDepartmentManager() {
  if (!currentUser || !currentUser.isAdmin) return;
  ensureDepartmentManagerPanel();

  const container = document.getElementById('department-admin-table');
  if (!container) return;

  const list = sortedDepartmentList().filter((dept) => {
    const code = normalizeDepartmentCode(dept.code);
    if (code === 'LOAN' || code === 'MISC') return false;
    if (code === 'UN' && Number(dept.assetCount || 0) === 0) return false;
    return true;
  });
  if (list.length === 0) {
    container.innerHTML = '<p style="color:#666;text-align:center;padding:20px;">No departments found.</p>';
    return;
  }

  container.innerHTML = `
    <table class="table" style="margin-top:0;">
      <thead>
        <tr>
          <th>Code</th>
          <th>Name</th>
          <th>Preview</th>
          <th>Colour</th>
          <th>Assets</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        ${list.map(dept => `
          <tr>
            <td><strong>${escapeHtml(dept.code)}</strong></td>
            <td>${escapeHtml(dept.name || dept.code)}</td>
            <td>${departmentBadgeHtml(dept.code, true)}</td>
            <td><span style="display:inline-flex;align-items:center;gap:8px;"><span style="width:22px;height:22px;border-radius:6px;border:1px solid #ccc;background:${escapeHtmlAttr(dept.color || '#e2e3e5')};display:inline-block;"></span>${escapeHtml(dept.color || '')}</span></td>
            <td>${Number(dept.assetCount || 0)}</td>
            <td>
              <button class="btn btn-warning btn-sm" onclick="openDepartmentModal('${encodeURIComponent(dept.code)}')">Edit</button>
              <button class="btn btn-danger btn-sm" onclick="deleteDepartment('${encodeURIComponent(dept.code)}')">Delete</button>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

function ensureDepartmentModal() {
  if (document.getElementById('departmentModal')) return;

  const modal = document.createElement('div');
  modal.id = 'departmentModal';
  modal.className = 'modal';
  modal.innerHTML = `
    <div class="modal-content" style="max-width:520px;">
      <div class="modal-header">
        <h3 class="modal-title" id="departmentModalTitle">Department</h3>
        <button class="close-btn" onclick="closeModal('departmentModal')">&times;</button>
      </div>
      <div class="modal-body">
        <div id="departmentRenameWarning" style="display:none;background:#fff3cd;border:1px solid #ffeaa7;color:#856404;padding:12px;border-radius:8px;margin-bottom:14px;">
          Renaming the department code will update matching inventory rows and event model requirements so old events stay linked.
        </div>
        <div class="form-group">
          <label class="form-label">Department Code</label>
          <input id="departmentCodeInput" class="form-input" placeholder="AX / LX / VIDEO" style="text-transform:uppercase;">
        </div>
        <div class="form-group">
          <label class="form-label">Display Name</label>
          <input id="departmentNameInput" class="form-input" placeholder="Audio / Lighting / Video">
        </div>
        <div class="form-group">
          <label class="form-label">Badge Colour</label>
          <div style="display:flex;gap:10px;align-items:center;">
            <input id="departmentColorInput" type="color" class="form-input" style="width:80px;padding:4px;height:44px;">
            <input id="departmentColorTextInput" class="form-input" placeholder="#667EEA">
          </div>
        </div>
        <div style="margin-top:10px;">
          <span style="color:#666;font-size:13px;margin-right:8px;">Preview:</span>
          <span id="departmentPreviewBadge" class="asset-badge">DEPT</span>
        </div>
      </div>
      <div class="modal-footer modal-actions" style="display:flex;gap:10px;justify-content:flex-end;margin-top:20px;">
        <button class="btn btn-secondary" onclick="closeModal('departmentModal')">Cancel</button>
        <button class="btn btn-success" onclick="saveDepartmentModal()">Save Department</button>
      </div>
    </div>
  `;

  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal('departmentModal');
  });

  document.body.appendChild(modal);

  const colorInput = document.getElementById('departmentColorInput');
  const colorTextInput = document.getElementById('departmentColorTextInput');
  const codeInput = document.getElementById('departmentCodeInput');
  const nameInput = document.getElementById('departmentNameInput');

  colorInput.addEventListener('input', () => {
    colorTextInput.value = colorInput.value.toUpperCase();
    updateDepartmentPreview();
  });
  colorTextInput.addEventListener('input', () => {
    if (/^#[0-9A-Fa-f]{6}$/.test(colorTextInput.value.trim())) {
      colorInput.value = colorTextInput.value.trim();
    }
    updateDepartmentPreview();
  });
  codeInput.addEventListener('input', updateDepartmentPreview);
  nameInput.addEventListener('input', updateDepartmentPreview);
}

function updateDepartmentPreview() {
  const badge = document.getElementById('departmentPreviewBadge');
  if (!badge) return;

  const code = normalizeDepartmentCode(document.getElementById('departmentCodeInput')?.value || 'DEPT');
  const name = document.getElementById('departmentNameInput')?.value.trim() || code;
  const colour = document.getElementById('departmentColorTextInput')?.value.trim() || '#e2e3e5';

  badge.textContent = name && name !== code ? `${code} - ${name}` : code;
  const safeColour = /^#[0-9A-Fa-f]{6}$/.test(colour) ? colour : '#e2e3e5';
  badge.style.background = safeColour;
  badge.style.color = getReadableTextColour(safeColour);
}

function getReadableTextColour(colour) {
  // Supports hex input. Browser rgb() fallback uses dark text.
  if (!/^#[0-9A-Fa-f]{6}$/.test(colour || '')) return '#111827';
  const r = parseInt(colour.slice(1, 3), 16);
  const g = parseInt(colour.slice(3, 5), 16);
  const b = parseInt(colour.slice(5, 7), 16);
  const brightness = (r * 299 + g * 587 + b * 114) / 1000;
  return brightness > 150 ? '#111827' : '#FFFFFF';
}

function openDepartmentModal(encodedCode = '') {
  if (!currentUser || !currentUser.isAdmin) {
    showNotification('error', 'Admin privileges required');
    return;
  }

  ensureDepartmentModal();

  const modal = document.getElementById('departmentModal');
  const originalCode = encodedCode ? decodeURIComponent(encodedCode) : '';
  const dept = originalCode ? getDepartmentMeta(originalCode) : { code: '', name: '', color: '#667eea' };

  modal.dataset.originalCode = originalCode;
  document.getElementById('departmentModalTitle').textContent = originalCode ? `Edit Department: ${originalCode}` : 'Add Department';
  document.getElementById('departmentRenameWarning').style.display = originalCode ? 'block' : 'none';
  document.getElementById('departmentCodeInput').value = dept.code || '';
  document.getElementById('departmentNameInput').value = dept.name || '';
  document.getElementById('departmentColorInput').value = dept.color || '#667eea';
  document.getElementById('departmentColorTextInput').value = (dept.color || '#667eea').toUpperCase();

  updateDepartmentPreview();
  openModal('departmentModal');
  setTimeout(() => document.getElementById('departmentCodeInput')?.focus(), 100);
}

async function saveDepartmentModal() {
  if (!currentUser || !currentUser.isAdmin) {
    showNotification('error', 'Admin privileges required');
    return;
  }

  const modal = document.getElementById('departmentModal');
  const originalCode = modal.dataset.originalCode || '';
  const code = normalizeDepartmentCode(document.getElementById('departmentCodeInput')?.value);
  const name = document.getElementById('departmentNameInput')?.value.trim();
  const color = document.getElementById('departmentColorTextInput')?.value.trim();

  if (!code) {
    showNotification('warning', 'Department code is required');
    return;
  }

  if (!name) {
    showNotification('warning', 'Department display name is required');
    return;
  }

  if (!/^#[0-9A-Fa-f]{6}$/.test(color || '')) {
    showNotification('warning', 'Colour must be a valid hex colour, e.g. #667EEA');
    return;
  }

  if (originalCode && code !== normalizeDepartmentCode(originalCode)) {
    const ok = await showAppConfirm({
      title: 'Rename Department',
      message: `Rename department code "${originalCode}" to "${code}"?\n\nThis will update matching inventory rows and event model requirements.`,
      confirmText: 'Rename',
      cancelText: 'Cancel',
      variant: 'warning',
    });
    if (!ok) return;
  }

  try {
    const endpoint = originalCode
      ? `/api/departments/${encodeURIComponent(originalCode)}`
      : '/api/departments';
    const method = originalCode ? 'PUT' : 'POST';

    const res = await apiCall(endpoint, method, { code, name, color });
    closeModal('departmentModal');

    const data = res.data || {};
    let message = originalCode ? 'Department updated' : 'Department created';
    if (data.assetsUpdated) message += `; ${data.assetsUpdated} asset(s) updated`;
    if (data.eventsUpdated) message += `; ${data.eventsUpdated} event(s) updated`;
    showNotification('success', message);

    departmentsLoaded = false;
    await loadDepartments(true);
    await loadInventory();
  } catch (error) {
    showNotification('error', `Failed to save department: ${error.message}`);
  }
}

async function deleteDepartment(encodedCode) {
  if (!currentUser || !currentUser.isAdmin) {
    showNotification('error', 'Admin privileges required');
    return;
  }

  const code = decodeURIComponent(encodedCode || '');
  const dept = getDepartmentMeta(code);
  const ok = await showAppConfirm({
    title: 'Delete Department',
    message: `Delete department "${dept.code}"?\n\nThis is only allowed when no assets are assigned to it.`,
    confirmText: 'Delete',
    cancelText: 'Cancel',
    variant: 'danger',
  });
  if (!ok) return;

  try {
    await apiCall(`/api/departments/${encodeURIComponent(dept.code)}`, 'DELETE');
    showNotification('success', `Department ${dept.code} deleted`);
    departmentsLoaded = false;
    await loadDepartments(true);
    await loadInventory();
  } catch (error) {
    await showAppAlert({
      title: 'Department Not Deleted',
      message: error.message,
      variant: 'warning',
    });
  }
}


// ---------------- Admin User Management ----------------

async function setupChangePasswordTab() {
  if (!currentUser) {
    const res = await apiCall('/api/current-user');
    currentUser = res.data;
  }

  ensureChangePasswordNavItem();
  ensureChangePasswordSection();
}

function ensureChangePasswordNavItem() {
  if (document.querySelector(`[onclick="showSection('change-password')"]`)) return;

  const settingsSection = Array.from(document.querySelectorAll('.nav-section'))
    .find(section => {
      const heading = section.querySelector('h3');
      return heading && heading.textContent.trim() === 'Settings';
    });

  if (!settingsSection) {
    console.warn('Could not find Settings section for Change Password tab');
    return;
  }

  const passwordTab = document.createElement('button');
  passwordTab.type = 'button';
  passwordTab.className = 'nav-item';
  passwordTab.setAttribute('onclick', "showSection('change-password')");
  passwordTab.textContent = '🔐 Change Password';

  const logoutButton = settingsSection.querySelector(`[onclick="logout()"]`);

  if (logoutButton) {
    settingsSection.insertBefore(passwordTab, logoutButton);
  } else {
    settingsSection.appendChild(passwordTab);
  }
}

function ensureChangePasswordSection() {
  if (document.getElementById('change-password-section')) return;

  const firstSection = document.querySelector('.content-section');
  const sectionParent = firstSection ? firstSection.parentElement : document.body;

  const section = document.createElement('div');
  section.id = 'change-password-section';
  section.className = 'content-section';

  section.innerHTML = `
    <div class="content-header">
      <h2 class="content-title">Change Password</h2>
    </div>

    <div class="form-container" style="max-width:520px;">
      <form id="changePasswordForm" onsubmit="submitChangePassword(event)">
        <div class="form-group">
          <label class="form-label" for="currentPasswordInput">Current Password</label>
          <input
            id="currentPasswordInput"
            type="password"
            class="form-input"
            autocomplete="current-password"
          >
        </div>

        <div class="form-group">
          <label class="form-label" for="newPasswordInput">New Password</label>
          <input
            id="newPasswordInput"
            type="password"
            class="form-input"
            autocomplete="new-password"
          >
        </div>

        <div class="form-group">
          <label class="form-label" for="confirmPasswordInput">Confirm Password</label>
          <input
            id="confirmPasswordInput"
            type="password"
            class="form-input"
            autocomplete="new-password"
          >
        </div>

        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:8px;">
          <button type="submit" id="changePasswordSubmit" class="btn btn-primary">Save Password</button>
          <button type="button" class="btn btn-secondary" onclick="resetChangePasswordForm()">Clear</button>
        </div>
      </form>
    </div>
  `;

  sectionParent.appendChild(section);
}

function resetChangePasswordForm() {
  const form = document.getElementById('changePasswordForm');
  if (form) form.reset();
}

function loadChangePasswordSection() {
  ensureChangePasswordSection();
  const input = document.getElementById('currentPasswordInput');
  if (input) {
    setTimeout(() => input.focus({ preventScroll: true }), 0);
  }
}

async function submitChangePassword(event) {
  if (event) event.preventDefault();

  const currentPassword = document.getElementById('currentPasswordInput')?.value || '';
  const newPassword = document.getElementById('newPasswordInput')?.value || '';
  const confirmPassword = document.getElementById('confirmPasswordInput')?.value || '';
  const submitButton = document.getElementById('changePasswordSubmit');

  if (!currentPassword) {
    showNotification('warning', 'Current password is required');
    return;
  }

  if (!newPassword) {
    showNotification('warning', 'New password is required');
    return;
  }

  if (newPassword !== confirmPassword) {
    showNotification('warning', 'New passwords do not match');
    return;
  }

  if (submitButton) submitButton.disabled = true;

  try {
    await apiCall('/api/current-user/password', 'PUT', {
      currentPassword,
      newPassword
    });

    resetChangePasswordForm();
    showNotification('success', 'Password changed');
  } catch (error) {
    showNotification('error', `Failed to change password: ${error.message}`);
  } finally {
    if (submitButton) submitButton.disabled = false;
  }
}

async function setupAdminUserManagementTab() {
  try {
    if (!currentUser) {
      const res = await apiCall('/api/current-user');
      currentUser = res.data;
    }

    if (!currentUser || !currentUser.isAdmin) return;

    ensureUsersNavItem();
    ensureUsersSection();
  } catch (error) {
    console.warn('User management tab not loaded:', error);
  }
}

function ensureUsersNavItem() {
  if (document.querySelector(`[onclick="showSection('users')"]`)) return;

  const settingsSection = Array.from(document.querySelectorAll('.nav-section'))
    .find(section => {
      const heading = section.querySelector('h3');
      return heading && heading.textContent.trim() === 'Settings';
    });

  if (!settingsSection) {
    console.warn('Could not find Settings section for Users tab');
    return;
  }

  const usersTab = document.createElement('button');
  usersTab.type = 'button';
  usersTab.className = 'nav-item';
  usersTab.setAttribute('onclick', "showSection('users')");
  usersTab.innerHTML = `👤 Users`;

  const logoutButton = settingsSection.querySelector(`[onclick="logout()"]`);

  if (logoutButton) {
    settingsSection.insertBefore(usersTab, logoutButton);
  } else {
    settingsSection.appendChild(usersTab);
  }
}

function ensureUsersSection() {
  if (document.getElementById('users-section')) return;

  const firstSection = document.querySelector('.content-section');
  const sectionParent = firstSection ? firstSection.parentElement : document.body;

  const section = document.createElement('div');
  section.id = 'users-section';
  section.className = 'content-section';

  section.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;">
      <div>
        <h2 style="margin:0;">User Management</h2>
        <p style="margin:5px 0 0;color:#666;">Create users, edit admin privileges, reset passwords, deactivate accounts, and assign companies.</p>
      </div>
    </div>

    <div class="card" style="margin-bottom:20px;">
      <h3 style="margin-bottom:15px;">Create New User</h3>

      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;align-items:end;">
        <div class="form-group">
          <label class="form-label">Username</label>
          <input id="newUserUsername" class="form-input" placeholder="Username">
        </div>

        <div class="form-group">
          <label class="form-label">Password</label>
          <input id="newUserPassword" type="password" class="form-input" placeholder="Password">
        </div>

        <label style="display:flex;gap:8px;align-items:center;margin-bottom:10px;">
          <input id="newUserIsAdmin" type="checkbox">
          Admin
        </label>

        <label class="super-admin-only" style="display:flex;gap:8px;align-items:center;margin-bottom:10px;">
          <input id="newUserIsSuperAdmin" type="checkbox">
          Super
        </label>

        <label style="display:flex;gap:8px;align-items:center;margin-bottom:10px;">
          <input id="newUserIsActive" type="checkbox" checked>
          Active
        </label>

        <div class="form-group super-admin-only" id="newUserCompanyGroup">
          <label class="form-label" for="newUserCompanyCode">Company</label>
          <select id="newUserCompanyCode" class="form-input"></select>
        </div>

        <button class="btn btn-success" onclick="createUserAdmin()">Create User</button>
      </div>
    </div>

    <div class="card">
      <div class="users-admin-toolbar">
        <h3 style="margin:0;">Existing Users</h3>
        <div class="users-admin-toolbar-actions">
          <label class="users-admin-search">
            <span class="sr-only">Search users</span>
            <input
              id="usersAdminSearch"
              type="search"
              class="form-input"
              placeholder="Search users..."
              oninput="renderUsersAdminTables()"
              autocomplete="off"
            >
          </label>
          <button class="btn btn-secondary btn-sm" onclick="loadUsersAdmin()">Refresh</button>
        </div>
      </div>

      <div id="users-admin-table-container">
        <p style="text-align:center;color:#666;padding:30px;">Loading users...</p>
      </div>
    </div>
  `;

  sectionParent.appendChild(section);
}

function setUsersAdminSort(key) {
  if (!isSuperAdminUser() || !['name', 'company'].includes(key)) return;
  if (usersAdminSort.key === key) {
    usersAdminSort.direction = usersAdminSort.direction === 'asc' ? 'desc' : 'asc';
  } else {
    usersAdminSort = { key, direction: 'asc' };
  }
  renderUsersAdminTables();
}

function usersAdminSortHeader(label, key) {
  if (!isSuperAdminUser()) return `<th>${label}</th>`;
  const active = usersAdminSort.key === key;
  const arrow = active ? (usersAdminSort.direction === 'asc' ? '&#9650;' : '&#9660;') : '&#8597;';
  const ariaSort = active ? (usersAdminSort.direction === 'asc' ? 'ascending' : 'descending') : 'none';
  return `
    <th aria-sort="${ariaSort}">
      <button type="button" class="users-admin-sort" onclick="setUsersAdminSort('${key}')">
        ${label}<span aria-hidden="true">${arrow}</span>
      </button>
    </th>
  `;
}

function usersAdminTableHeader() {
  return `
    <thead>
      <tr>
        ${usersAdminSortHeader('Username', 'name')}
        <th>Admin</th>
        ${isSuperAdminUser() ? usersAdminSortHeader('Company', 'company') : ''}
        ${isSuperAdminUser() ? '<th>Super</th>' : ''}
        <th>Active</th>
        <th>Last Online</th>
        <th>Actions</th>
      </tr>
    </thead>
  `;
}

function formatUserLastOnline(value) {
  const raw = String(value || '-').trim();
  if (!raw || raw === '-') return '-';

  const timestamp = new Date(raw);
  if (Number.isNaN(timestamp.getTime())) return escapeHtml(raw);

  try {
    return escapeHtml(new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short'
    }).format(timestamp));
  } catch (error) {
    return escapeHtml(timestamp.toLocaleString());
  }
}

function usersAdminRowMarkup(user, index) {
  const rowId = `userrow-${index}`;
  const encodedOriginalUsername = encodeURIComponent(user.username);
  const isSelf = currentUser && currentUser.username === user.username;
  const protectedSuperUser = user.isSuperAdmin && !isSuperAdminUser() && !isSelf;
  const rawLastOnline = String(user.lastOnline || '-');
  const lastOnlineDisplay = formatUserLastOnline(rawLastOnline);

  return `
    <tr>
      <td>
        <input
          type="text"
          id="username-${rowId}"
          class="form-input user-admin-username-input"
          value="${escapeHtmlAttr(user.username)}"
          ${protectedSuperUser ? 'disabled' : ''}
        >
        ${isSelf ? '<span style="font-size:11px;color:#666;margin-left:6px;">(you)</span>' : ''}
      </td>
      <td>
        <label class="user-admin-switch">
          <input type="checkbox" id="admin-${rowId}" ${user.isAdmin ? 'checked' : ''} ${protectedSuperUser ? 'disabled' : ''}>
          <span class="user-admin-switch-slider"></span>
          <span class="user-admin-switch-text">Admin</span>
        </label>
      </td>
      ${isSuperAdminUser() ? `
        <td>
          <select id="company-${rowId}" class="form-input">
            ${companyOptionsMarkup(user.companyCode || currentUser?.company?.code || '')}
          </select>
        </td>
      ` : ''}
      ${isSuperAdminUser() ? `
        <td>
          <label class="user-admin-switch">
            <input type="checkbox" id="super-${rowId}" ${user.isSuperAdmin ? 'checked' : ''}>
            <span class="user-admin-switch-slider"></span>
            <span class="user-admin-switch-text">Super</span>
          </label>
        </td>
      ` : ''}
      <td>
        <label class="user-admin-switch">
          <input type="checkbox" id="active-${rowId}" ${user.isActive ? 'checked' : ''} ${protectedSuperUser ? 'disabled' : ''}>
          <span class="user-admin-switch-slider"></span>
          <span class="user-admin-switch-text">Active</span>
        </label>
      </td>
      <td class="user-admin-last-online" title="${rawLastOnline === '-' ? '' : escapeHtmlAttr(rawLastOnline)}">
        ${lastOnlineDisplay}
      </td>
      <td class="users-admin-actions">
        <button class="btn btn-primary btn-sm" onclick="saveUserAdmin('${encodedOriginalUsername}', '${rowId}')">Save</button>
        <button class="btn btn-warning btn-sm" onclick="openResetPasswordModal('${encodedOriginalUsername}')">Reset Password</button>
        <button class="btn btn-danger btn-sm" onclick="deleteUserAdmin('${encodedOriginalUsername}')" ${(isSelf || protectedSuperUser) ? 'disabled title="This account cannot be deleted here"' : ''}>Delete</button>
      </td>
    </tr>
  `;
}

function sortedUsersAdmin(users) {
  const direction = usersAdminSort.direction === 'desc' ? -1 : 1;
  return [...users].sort((left, right) => {
    const leftValue = usersAdminSort.key === 'company'
      ? (left.companyName || left.companyCode || '')
      : (left.username || '');
    const rightValue = usersAdminSort.key === 'company'
      ? (right.companyName || right.companyCode || '')
      : (right.username || '');
    const primary = String(leftValue).localeCompare(String(rightValue), undefined, { sensitivity: 'base', numeric: true });
    if (primary) return primary * direction;
    return String(left.username || '').localeCompare(String(right.username || ''), undefined, { sensitivity: 'base', numeric: true });
  });
}

function renderUsersAdminTables() {
  const container = document.getElementById('users-admin-table-container');
  if (!container) return;

  const search = (document.getElementById('usersAdminSearch')?.value || '').trim().toLocaleLowerCase();
  const inactiveWasOpen = document.getElementById('inactiveUsersDropdown')?.open || false;
  const filtered = usersAdminUsers.filter(user => {
    if (!search) return true;
    return [user.username, user.companyCode, user.companyName]
      .some(value => String(value || '').toLocaleLowerCase().includes(search));
  });
  const sorted = isSuperAdminUser() ? sortedUsersAdmin(filtered) : filtered;
  const activeUsers = sorted.filter(user => user.isActive);
  const inactiveUsers = sorted.filter(user => !user.isActive);
  const inactiveTotal = usersAdminUsers.filter(user => !user.isActive).length;
  const inactiveLabel = search && inactiveUsers.length !== inactiveTotal
    ? `Inactive Users (${inactiveUsers.length} of ${inactiveTotal})`
    : `Inactive Users (${inactiveTotal})`;

  const activeMarkup = activeUsers.length
    ? `<div class="users-admin-table-scroll"><table class="table">${usersAdminTableHeader()}<tbody>${activeUsers.map(usersAdminRowMarkup).join('')}</tbody></table></div>`
    : `<p class="users-admin-empty">${search ? 'No active users match your search.' : 'No active users found.'}</p>`;
  const inactiveMarkup = inactiveUsers.length
    ? `<div class="users-admin-table-scroll"><table class="table">${usersAdminTableHeader()}<tbody>${inactiveUsers.map((user, index) => usersAdminRowMarkup(user, activeUsers.length + index)).join('')}</tbody></table></div>`
    : `<p class="users-admin-empty">${search ? 'No inactive users match your search.' : 'No inactive users.'}</p>`;

  container.innerHTML = `
    ${activeMarkup}
    <details id="inactiveUsersDropdown" class="inactive-users-dropdown" ${(inactiveWasOpen || (search && inactiveUsers.length)) ? 'open' : ''}>
      <summary>${inactiveLabel}</summary>
      <div class="inactive-users-content">${inactiveMarkup}</div>
    </details>
  `;
}

async function loadUsersAdmin() {
  const container = document.getElementById('users-admin-table-container');
  if (!container) return;

  ensureUserAdminStyles();
  container.innerHTML = '<p style="text-align:center;color:#666;padding:30px;">Loading users...</p>';

  try {
    if (isSuperAdminUser()) {
      await fetchCompanies(true);
      const newUserCompany = document.getElementById('newUserCompanyCode');
      if (newUserCompany) {
        newUserCompany.innerHTML = companyOptionsMarkup(currentUser?.company?.code || '');
      }
    }

    const res = await apiCall('/api/users');
    usersAdminUsers = res.data || [];
    renderUsersAdminTables();
  } catch (error) {
    container.innerHTML = `<p style="color:red;text-align:center;padding:30px;">Failed to load users: ${escapeHtml(error.message)}</p>`;
  }
}

async function createUserAdmin() {
  const username = document.getElementById('newUserUsername')?.value.trim();
  const password = document.getElementById('newUserPassword')?.value;
  const isAdmin = document.getElementById('newUserIsAdmin')?.checked || false;
  const isSuperAdmin = document.getElementById('newUserIsSuperAdmin')?.checked || false;
  const isActive = document.getElementById('newUserIsActive')?.checked || false;
  const companyCode = document.getElementById('newUserCompanyCode')?.value || currentUser?.company?.code || '';

  if (!username) {
    showNotification('warning', 'Username is required');
    return;
  }

  if (!password) {
    showNotification('warning', 'Password is required');
    return;
  }

  try {
    const payload = {
      username,
      password,
      isAdmin: isAdmin || isSuperAdmin,
      isSuperAdmin,
      isActive
    };
    if (isSuperAdminUser()) {
      payload.companyCode = companyCode;
    }

    await apiCall('/api/users', 'POST', payload);

    showNotification('success', `User ${username} created`);

    document.getElementById('newUserUsername').value = '';
    document.getElementById('newUserPassword').value = '';
    document.getElementById('newUserIsAdmin').checked = false;
    if (document.getElementById('newUserIsSuperAdmin')) {
      document.getElementById('newUserIsSuperAdmin').checked = false;
    }
    document.getElementById('newUserIsActive').checked = true;
    if (document.getElementById('newUserCompanyCode')) {
      document.getElementById('newUserCompanyCode').value = currentUser?.company?.code || '';
    }

    await loadUsersAdmin();

  } catch (error) {
    showNotification('error', `Failed to create user: ${error.message}`);
  }
}

async function createCompanyFromUsersAdmin() {
  const code = document.getElementById('userNewCompanyCode')?.value.trim() || '';
  const name = document.getElementById('userNewCompanyName')?.value.trim() || '';
  const firstAdminUsername = document.getElementById('userNewCompanyFirstAdmin')?.value.trim() || '';
  const firstAdminPassword = document.getElementById('userNewCompanyFirstAdminPassword')?.value || '';

  if (!code && !name) {
    showNotification('warning', 'Company code or name is required');
    return;
  }

  try {
    await apiCall('/api/companies', 'POST', {
      code,
      name,
      firstAdminUsername,
      firstAdminPassword
    });

    ['userNewCompanyCode', 'userNewCompanyName', 'userNewCompanyFirstAdmin', 'userNewCompanyFirstAdminPassword'].forEach(id => {
      const input = document.getElementById(id);
      if (input) input.value = '';
    });

    closeModal('createCompanyModal');
    showNotification('success', 'Company created');
    await loadCompaniesAdmin();
    if (document.getElementById('users-section')) {
      await loadUsersAdmin();
    }
  } catch (error) {
    showNotification('error', `Failed to create company: ${error.message}`);
  }
}

async function editCompanyFromUsersAdmin() {
  const code = document.getElementById('userEditCompanyCode')?.value || '';
  const name = document.getElementById('userEditCompanyName')?.value.trim() || '';

  if (!code) {
    showNotification('warning', 'Choose a company first');
    return;
  }
  if (!name) {
    showNotification('warning', 'Company name is required');
    return;
  }

  try {
    await apiCall(`/api/companies/${encodeURIComponent(code)}`, 'PUT', { name });
    closeModal('editCompanyModal');
    showNotification('success', 'Company updated');
    await loadCompaniesAdmin();
    if (document.getElementById('users-section')) {
      await loadUsersAdmin();
    }
  } catch (error) {
    showNotification('error', `Failed to update company: ${error.message}`);
  }
}

async function deleteCompanyFromUsersAdmin() {
  const code = document.getElementById('userDeleteCompanyCode')?.value || '';
  if (!code) {
    showNotification('warning', 'Choose a company first');
    return;
  }

  const company = (companyOptions || []).find(item => String(item.code || '').toUpperCase() === String(code).toUpperCase());
  await deleteCompanyAdmin(code, Boolean(company?.isActive), companyOptions.length);
}

async function saveUserAdmin(encodedOriginalUsername, rowId) {
  const originalUsername = decodeURIComponent(encodedOriginalUsername);

  const newUsername = document.getElementById(`username-${rowId}`)?.value.trim();
  const isAdmin = document.getElementById(`admin-${rowId}`)?.checked || false;
  const isActive = document.getElementById(`active-${rowId}`)?.checked || false;
  const isSuperAdmin = document.getElementById(`super-${rowId}`)?.checked || false;
  const companyCode = document.getElementById(`company-${rowId}`)?.value || '';

  if (!newUsername) {
    showNotification('warning', 'Username cannot be empty');
    return;
  }

  try {
    const payload = {
      username: newUsername,
      isAdmin: isAdmin || isSuperAdmin,
      isActive
    };
    if (isSuperAdminUser() && companyCode) {
      payload.companyCode = companyCode;
      payload.isSuperAdmin = isSuperAdmin;
    }

    const updateResult = await apiCall(`/api/users/${encodeURIComponent(originalUsername)}`, 'PUT', payload);

    // Refresh current-user data in case the logged-in admin renamed themselves
    try {
      const currentUserRes = await apiCall('/api/current-user');
      currentUser = currentUserRes.data;
    } catch (e) {
      console.warn('Could not refresh current user:', e);
    }

    const selfChangesPending = !!(updateResult?.data?.selfChangesPending);
    showNotification(
      'success',
      selfChangesPending
        ? `Updated ${newUsername}. Your own permission changes apply after you log out and back in.`
        : `Updated ${newUsername}`
    );
    await loadUsersAdmin();

  } catch (error) {
    showNotification('error', `Failed to update user: ${error.message}`);
    await loadUsersAdmin();
  }
}

async function resetUserPasswordAdmin(encodedOriginalUsername, newPassword) {
  const originalUsername = decodeURIComponent(encodedOriginalUsername);

  if (!newPassword) {
    showNotification('warning', 'Enter a new password first');
    return;
  }

  try {
    await apiCall(`/api/users/${encodeURIComponent(originalUsername)}/password`, 'PUT', {
      password: newPassword
    });

    showNotification('success', `Password reset for ${originalUsername}`);
    closeModal('resetUserPasswordModal');

  } catch (error) {
    showNotification('error', `Failed to reset password: ${error.message}`);
  }
}

function ensureResetPasswordModal() {
  if (document.getElementById('resetUserPasswordModal')) return;

  const modal = document.createElement('div');
  modal.id = 'resetUserPasswordModal';
  modal.className = 'modal';

  modal.innerHTML = `
    <div class="modal-content" style="max-width:420px;">
      <div class="modal-header">
        <h3>Reset User Password</h3>
      </div>

      <div class="modal-body">
        <p style="margin-bottom:12px;">
          Enter a new password for <strong id="resetPasswordUsernameLabel"></strong>.
        </p>

        <div class="form-group">
          <label class="form-label">New Password</label>
          <input
            id="resetUserPasswordInput"
            type="password"
            class="form-input"
            placeholder="Enter new password"
            onkeypress="if(event.key==='Enter') confirmResetPasswordModal()"
          >
        </div>
      </div>

      <div class="modal-footer modal-actions">
        <button class="btn btn-secondary" onclick="closeModal('resetUserPasswordModal')">Cancel</button>
        <button class="btn btn-warning" onclick="confirmResetPasswordModal()">Reset Password</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);
}

function openResetPasswordModal(encodedOriginalUsername) {
  ensureResetPasswordModal();

  const username = decodeURIComponent(encodedOriginalUsername);

  document.getElementById('resetPasswordUsernameLabel').textContent = username;
  document.getElementById('resetUserPasswordInput').value = '';

  const modal = document.getElementById('resetUserPasswordModal');
  modal.dataset.encodedUsername = encodedOriginalUsername;

  openModal('resetUserPasswordModal');

  setTimeout(() => {
    document.getElementById('resetUserPasswordInput')?.focus();
  }, 100);
}

function confirmResetPasswordModal() {
  const modal = document.getElementById('resetUserPasswordModal');
  const encodedOriginalUsername = modal.dataset.encodedUsername;
  const newPassword = document.getElementById('resetUserPasswordInput')?.value || '';

  resetUserPasswordAdmin(encodedOriginalUsername, newPassword);
}

async function deleteUserAdmin(encodedOriginalUsername) {
  const username = decodeURIComponent(encodedOriginalUsername);

  if (currentUser && currentUser.username === username) {
    showNotification('warning', 'You cannot delete your own account');
    return;
  }

  const confirmed = await showAppConfirm({
    title: 'Delete User',
    message: `Delete user "${username}"? This cannot be undone.`,
    confirmText: 'Delete',
    cancelText: 'Cancel',
    variant: 'danger',
  });
  if (!confirmed) return;

  try {
    await apiCall(`/api/users/${encodeURIComponent(username)}`, 'DELETE');

    showNotification('success', `Deleted user ${username}`);
    await loadUsersAdmin();

  } catch (error) {
    showNotification('error', `Failed to delete user: ${error.message}`);
  }
}


function ensureUserAdminStyles() {
  if (document.getElementById('user-admin-switch-styles')) return;

  const style = document.createElement('style');
  style.id = 'user-admin-switch-styles';
  style.textContent = `
    .user-admin-switch {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      cursor: pointer;
      user-select: none;
    }

    .user-admin-switch input {
      position: absolute;
      opacity: 0;
      width: 0;
      height: 0;
    }

    .user-admin-switch-slider {
      position: relative;
      width: 46px;
      height: 24px;
      border-radius: 999px;
      background: #ccc;
      transition: background 0.2s ease;
      flex-shrink: 0;
    }

    .user-admin-switch-slider::before {
      content: "";
      position: absolute;
      width: 20px;
      height: 20px;
      left: 2px;
      top: 2px;
      border-radius: 50%;
      background: white;
      transition: transform 0.2s ease;
      box-shadow: 0 1px 3px rgba(0,0,0,0.3);
    }

    .user-admin-switch input:checked + .user-admin-switch-slider {
      background: #28a745;
    }

    .user-admin-switch input:checked + .user-admin-switch-slider::before {
      transform: translateX(22px);
    }

    .user-admin-switch input:disabled + .user-admin-switch-slider {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .user-admin-switch-text {
      font-size: 13px;
      color: #333;
    }

    .user-admin-username-input {
      max-width: 220px;
      min-width: 160px;
    }

    .users-admin-toolbar,
    .users-admin-toolbar-actions {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
    }

    .users-admin-toolbar {
      margin-bottom: 15px;
    }

    .users-admin-search {
      min-width: min(320px, 70vw);
    }

    .users-admin-sort {
      appearance: none;
      border: 0;
      background: transparent;
      color: inherit;
      font: inherit;
      font-weight: inherit;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 7px;
      padding: 0;
    }

    .users-admin-sort:hover,
    .users-admin-sort:focus-visible {
      color: #485fc7;
    }

    .users-admin-table-scroll {
      overflow-x: auto;
    }

    .users-admin-actions {
      white-space: nowrap;
    }

    .user-admin-last-online {
      white-space: nowrap;
      color: #475467;
      font-size: 13px;
    }

    .users-admin-empty {
      text-align: center;
      color: #667085;
      padding: 30px;
      margin: 0;
    }

    .inactive-users-dropdown {
      margin-top: 20px;
      border: 1px solid #dfe3e8;
      border-radius: 8px;
      overflow: hidden;
      background: #fafbfc;
    }

    .inactive-users-dropdown > summary {
      cursor: pointer;
      padding: 14px 16px;
      font-weight: 600;
      color: #475467;
      user-select: none;
    }

    .inactive-users-dropdown[open] > summary {
      border-bottom: 1px solid #dfe3e8;
    }

    .inactive-users-content {
      background: #fff;
    }

    .inactive-users-content .table {
      margin-bottom: 0;
    }

    @media (max-width: 640px) {
      .users-admin-toolbar-actions,
      .users-admin-search {
        width: 100%;
      }
    }
  `;

  document.head.appendChild(style);
}

// Tab switching functionality
function switchEventsTab(tabName) {
  // Remove active class from all tabs and content
  document.querySelectorAll(".events-tab").forEach((tab) => {
    tab.classList.remove("active");
  });
  document.querySelectorAll(".tab-content").forEach((content) => {
    content.classList.remove("active");
    content.style.display = "none";
  });

  // Add active class to clicked tab
  document.querySelector(`[data-tab="${tabName}"]`).classList.add("active");

  // Show corresponding content
  const contentDiv = document.getElementById(`${tabName}-events`);
  contentDiv.classList.add("active");
  contentDiv.style.display = "block";

  // Load appropriate data
  if (tabName === "ongoing") {
    loadOngoingEvents();
  } else if (tabName === "upcoming") {
    loadUpcomingEvents();
  }
}

// Load ongoing events (events that are currently active)
async function loadOngoingEvents(preloadedEvents = null) {
    try {
        const container = document.getElementById('ongoing-events');
        if (!container) {
            console.warn('ongoing-events container not found, retrying in 500ms...');
            setTimeout(() => loadOngoingEvents(), 500);
            return;
        }
        
        container.innerHTML = '<p style="text-align: center; color: #666; padding: 40px;">Loading ongoing events...</p>';
        
        const eventList = Array.isArray(preloadedEvents)
            ? preloadedEvents
            : (await apiCall('/api/events')).data;
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        
        const ongoingEvents = eventList.filter(event => {
            const startDate = new Date(event.startDate);
            const endDate = new Date(event.endDate);
            startDate.setHours(0, 0, 0, 0);
            endDate.setHours(23, 59, 59, 999);
            
            return today >= startDate && today <= endDate;
        });
        
        container.innerHTML = '';
        
        if (ongoingEvents.length === 0) {
            container.innerHTML = '<p style="text-align: center; color: #666; padding: 40px;">No ongoing events at the moment.</p>';
            return;
        }
        
        ongoingEvents.forEach(event => {
            container.appendChild(createEventCard(event));
        });
        
    } catch (error) {
        console.error('Error loading ongoing events:', error);
        const container = document.getElementById('ongoing-events');
        if (container) {
            container.innerHTML = '<p style="color: red; text-align: center;">Error loading ongoing events. <button onclick="loadOngoingEvents()">Retry</button></p>';
        }
    }
}

// Load upcoming events (events that start in the future)
async function loadUpcomingEvents(preloadedEvents = null) {
    try {
        const container = document.getElementById('upcoming-events');
        if (!container) {
            console.warn('upcoming-events container not found, retrying in 500ms...');
            setTimeout(() => loadUpcomingEvents(), 500);
            return;
        }
        
        container.innerHTML = '<p style="text-align: center; color: #666; padding: 40px;">Loading upcoming events...</p>';
        
        const eventList = Array.isArray(preloadedEvents)
            ? preloadedEvents
            : (await apiCall('/api/events')).data;
        const today = new Date();
        today.setHours(23, 59, 59, 999);
        
        const upcomingEvents = eventList
            .filter(event => {
                const startDate = new Date(event.startDate);
                return startDate > today;
            })
            .sort((a, b) => new Date(a.startDate) - new Date(b.startDate));
        
        // Update the counter
        updateUpcomingEventsCounter(upcomingEvents.length);
        
        container.innerHTML = '';
        
        if (upcomingEvents.length === 0) {
            container.innerHTML = '<p style="text-align: center; color: #666; padding: 40px;">No upcoming events scheduled.</p>';
            return;
        }
        
        upcomingEvents.slice(0, 6).forEach(event => {
            container.appendChild(createEventCard(event));
        });
        
    } catch (error) {
        console.error('Error loading upcoming events:', error);
        const container = document.getElementById('upcoming-events');
        if (container) {
            container.innerHTML = '<p style="color: red; text-align: center;">Error loading upcoming events. <button onclick="loadUpcomingEvents()">Retry</button></p>';
        }
        // Set counter to 0 on error
        updateUpcomingEventsCounter(0);
    }
}

// Update the upcoming events counter
function updateUpcomingEventsCounter(count) {
    const counter = document.getElementById('upcoming-events-counter');
    if (counter) {
        counter.textContent = count;
        
        // Update counter styling based on count
        if (count === 0) {
            counter.style.background = '#6c757d'; // Gray for 0
        } else if (count <= 3) {
            counter.style.background = '#28a745'; // Green for few events
        } else if (count <= 6) {
            counter.style.background = '#ffc107'; // Yellow for moderate events
        } else {
            counter.style.background = '#dc3545'; // Red for many events
        }
    }
}

async function loadStatsCards() {
  try {
    const statsResponse = await apiCall("/api/stats");
    stats = statsResponse.data || {};

    const totalEventsEl = document.getElementById("total-events");
    const activeEventsEl = document.getElementById("active-events");
    const totalAssetsEl = document.getElementById("total-assets");
    const deployedAssetsEl = document.getElementById("deployed-assets");

    if (totalEventsEl) totalEventsEl.textContent = stats.totalEvents || 0;
    if (activeEventsEl) activeEventsEl.textContent = stats.activeEvents || 0;
    if (totalAssetsEl) totalAssetsEl.textContent = stats.totalAssets || 0;
    if (deployedAssetsEl) deployedAssetsEl.textContent = stats.deployedAssets || 0;
  } catch (error) {
    console.error("Error loading stats:", error);
  }
}

// load the dashboard
async function loadDashboard() {
  try {
    await apiCall('/api/events/update-states', 'POST');
    const response = await apiCall('/api/events');

    const overdueCount = countOverdueEvents(response.data);
    updateOverdueCounter(overdueCount);

    setTimeout(async () => {
      await loadOngoingEvents(response.data);
      await loadUpcomingEvents(response.data);
    }, 300);
  } catch (error) {
    console.error("Error loading dashboard:", error);
  }
}

function sortEventsStartDateFutureTop(list) {
  const parseEventDate = (val) => {
    if (!val) return new Date(NaN);
    if (typeof val === "string") {
      const norm = val.includes("/")
        ? (() => {
            const [y, m, d] = val.split("/");
            return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
          })()
        : val;

      // force local noon to avoid timezone edge-cases around midnight
      if (/^\d{4}-\d{2}-\d{2}$/.test(norm)) {
        return new Date(`${norm}T12:00:00`);
      }
      return new Date(norm);
    }
    return new Date(val);
  };

  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);

  return [...list].sort((a, b) => {
    const aStart = parseEventDate(a.startDate);
    const bStart = parseEventDate(b.startDate);

    const aFuture = aStart >= startOfToday;
    const bFuture = bStart >= startOfToday;

    // bucket: future first
    if (aFuture !== bFuture) return aFuture ? -1 : 1;

    // within the future bucket: DESC (later first => Oct above Sep)
    if (aFuture) return bStart - aStart;

    // within past/ongoing bucket: DESC (most recent past first)
    return bStart - aStart;
  });
}



function createEventCard(event) {
    const card = document.createElement('div');
    card.className = `event-card ${getEventStateClass(event.state)}`;
    
    // Helper function to escape HTML
    const escapeHtml = (str) => {
        if (!str) return '';
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    };
    
    // Helper function to get tag styling
    const getTagStyle = (tag) => {
        if (tag === 'dry hire') {
            return 'background: #17a2b8; color: white;';
        }
        return 'background: #28a745; color: white;';
    };
    
    const getTagDisplay = (tag) => {
        return tag === 'dry hire' ? 'DRY HIRE' : 'EVENT';
    };
    
    const dateRange = event.startDate === event.endDate 
        ? formatDate(event.startDate)
        : `${formatDate(event.startDate)} - ${formatDate(event.endDate)}`;

    card.innerHTML = `
        <div class="event-header">
            <div style="display: flex; align-items: center; gap: 8px;">
                <div class="event-id">ID: ${event.id}</div>
                <span style="padding: 2px 8px; border-radius: 12px; font-size: 10px; font-weight: bold; ${getTagStyle(event.tag || 'events')}">
                    ${getTagDisplay(event.tag || 'events')}
                </span>
            </div>
            <div class="event-state ${getEventStateClass(event.state)}">${escapeHtml(event.state)}</div>
        </div>
        <div class="event-title">${escapeHtml(event.name)}</div>
        <div class="event-date">${escapeHtml(dateRange)}</div>
        <div style="margin: 15px 0;">
            <small style="color: #666;">${event.assetCount || 0} assets assigned</small>
        </div>
        <div class="event-actions event-card-actions">
            <button class="btn btn-primary" onclick="viewEvent(${event.id})">View</button>
            ${isAdminUser() ? `
              <button class="btn btn-warning" onclick="editEvent(${event.id})">Edit</button>
              <button class="btn btn-secondary" onclick="showForceStateModal(${event.id}, '${event.state}')">Force State</button>
              <button class="btn btn-danger" onclick="deleteEvent(${event.id})">Delete</button>
            ` : ''}
        </div>
    `;

    return card;
}

// Update all event states manually

// Force event state
async function forceEventState(eventId, newState) {
    if (!isAdminUser()) {
        showNotification('error', 'Admin privileges required');
        return;
    }

    try {
        const response = await apiCall(`/api/events/${eventId}/force-state`, 'POST', { state: newState });
        
        showNotification('success', `Event ${eventId} state forced to ${newState}`);
        
        // Refresh all relevant views
        setTimeout(() => {
            if (document.getElementById('prepare-section').classList.contains('active')) {
                loadPrepareEvents();
            }
            if (document.getElementById('dashboard-section').classList.contains('active')) {
                loadDashboard();
            }
            if (document.getElementById('events-section').classList.contains('active')) {
                loadAllEvents();
            }
            if (document.getElementById('return-section').classList.contains('active')) {
                loadReturnEvents();
            }
        }, 500);
        
    } catch (error) {
        showNotification('error', `Failed to force event state: ${error.message}`);
        console.error('Error forcing event state:', error);
    }
}

// Remove forced state override
async function removeForcedState(eventId) {
    if (!isAdminUser()) {
        showNotification('error', 'Admin privileges required');
        return;
    }

    try {
        const response = await apiCall(`/api/events/${eventId}/remove-force-state`, 'POST');
        
        showNotification('success', `Event ${eventId} returned to automatic state management`);
        
        // Refresh all relevant views
        setTimeout(() => {
            if (document.getElementById('prepare-section').classList.contains('active')) {
                loadPrepareEvents();
            }
            if (document.getElementById('dashboard-section').classList.contains('active')) {
                loadDashboard();
            }
            if (document.getElementById('events-section').classList.contains('active')) {
                loadAllEvents();
            }
            if (document.getElementById('return-section').classList.contains('active')) {
                loadReturnEvents();
            }
        }, 500);
        
    } catch (error) {
        showNotification('error', `Failed to remove forced state: ${error.message}`);
        console.error('Error removing forced state:', error);
    }
}

// Show force state modal

// Show force state modal - Updated to show current force status
function showForceStateModal(eventId, currentState) {
    if (!isAdminUser()) {
        showNotification('error', 'Admin privileges required');
        return;
    }

    // Create modal HTML if it doesn't exist
    let modal = document.getElementById('forceStateModal');
    if (!modal) {
        const modalHTML = `
            <div id="forceStateModal" class="modal">
                <div class="modal-content" style="max-width: 450px;">
                    <div class="modal-header">
                        <h3>Force Event State</h3>
                    </div>
                    <div class="modal-body">
                        <div style="margin-bottom: 20px;">
                            <p><strong>Event ID:</strong> <span id="forceStateEventId"></span></p>
                            <p><strong>Current State:</strong> <span id="forceStateCurrentState"></span> <span id="forceStateIndicator"></span></p>
                        </div>
                        
                        <div class="form-group">
                            <label for="forceStateSelect">Select New State:</label>
                            <select id="forceStateSelect" class="form-input">
                                <option value="">Choose a state...</option>
                                <option value="Added">Added</option>
                                <option value="Planning">Planning</option>
                                <option value="Preparing">Preparing</option>
                                <option value="Ready">Ready</option>
                                <option value="Ongoing">Ongoing</option>
                                <option value="Last Day">Last Day</option>
                                <option value="Returning">Returning</option>
                                <option value="Closed">Closed</option>
                                <option value="Overdue">Overdue</option>
                            </select>
                        </div>
                        <div id="removeForceSection" style="background: #e7f3ff; border: 1px solid #b3d9ff; padding: 15px; border-radius: 5px; margin: 20px 0; display: none;">
                            <strong>ℹ️ Note:</strong> This event's state is currently forced. You can return it to automatic state management.
                        </div>
                    </div>
                    <div class="modal-footer modal-actions">
                        <button type="button" class="btn btn-secondary" id="forceStateCancelBtn">Cancel</button>
                        <button type="button" class="btn btn-warning" id="removeForceBtn" style="display: none;" onclick="handleRemoveForcedState()">Remove Force</button>
                        <button type="button" class="btn btn-primary" id="forceStateConfirmBtn">Force State</button>
                    </div>
                </div>
            </div>
        `;
        
        // Add modal to DOM and set up event listeners
        document.body.insertAdjacentHTML('beforeend', modalHTML);
        modal = document.getElementById('forceStateModal');
        
        // Event listeners
        modal.addEventListener('click', function(event) {
            if (event.target === modal) {
                modal.style.display = 'none';
            }
        });
        
        document.getElementById('forceStateCancelBtn').addEventListener('click', function() {
            modal.style.display = 'none';
        });
        
        document.getElementById('forceStateConfirmBtn').addEventListener('click', function() {
            confirmForceState();
        });
    }
    
    // Populate the modal and check if state is forced
    const eventIdSpan = document.getElementById('forceStateEventId');
    const currentStateSpan = document.getElementById('forceStateCurrentState');
    const forceStateIndicator = document.getElementById('forceStateIndicator');
    const removeForceSection = document.getElementById('removeForceSection');
    const removeForceBtn = document.getElementById('removeForceBtn');
    const stateSelect = document.getElementById('forceStateSelect');
    
    if (eventIdSpan && currentStateSpan && stateSelect) {
        eventIdSpan.textContent = eventId;
        currentStateSpan.textContent = currentState;
        
        // Check if this event has a forced state by calling the API
        checkIfStateIsForced(eventId).then(isForced => {
            if (isForced) {
                forceStateIndicator.innerHTML = '<span style="color: #dc3545; font-weight: bold;">(FORCED)</span>';
                removeForceSection.style.display = 'block';
                removeForceBtn.style.display = 'inline-block';
            } else {
                forceStateIndicator.innerHTML = '';
                removeForceSection.style.display = 'none';
                removeForceBtn.style.display = 'none';
            }
        });
        
        // Reset select and store event ID
        stateSelect.value = '';
        stateSelect.setAttribute('data-event-id', eventId);
        
        // Show modal
        modal.style.display = 'block';
    } else {
        console.error('Modal elements not found after creation');
        showNotification('error', 'Failed to open force state modal');
    }
}

// Helper function to check if state is forced
async function checkIfStateIsForced(eventId) {
    try {
        const response = await apiCall(`/api/events/${eventId}`);
        return response.data.forceStateOverride || false;
    } catch (error) {
        console.error('Error checking force state status:', error);
        return false;
    }
}

// Handle remove forced state
function handleRemoveForcedState() {
    const stateSelect = document.getElementById('forceStateSelect');
    const eventId = parseInt(stateSelect.getAttribute('data-event-id'));
    
    if (!eventId) {
        showNotification('error', 'Event ID not found');
        return;
    }
    
    // Close modal
    const modal = document.getElementById('forceStateModal');
    if (modal) {
        modal.style.display = 'none';
    }
    
    // Remove forced state
    removeForcedState(eventId);
}

// Handle modal backdrop clicks

// Close force state modal specifically

// Confirm force state change
function confirmForceState() {
    const stateSelect = document.getElementById('forceStateSelect');
    const modal = document.getElementById('forceStateModal');
    
    if (!stateSelect) {
        showNotification('error', 'State selection not found');
        return;
    }
    
    const eventId = parseInt(stateSelect.getAttribute('data-event-id'));
    const newState = stateSelect.value;
    
    if (!newState) {
        showNotification('warning', 'Please select a state');
        return;
    }
    
    if (!eventId) {
        showNotification('error', 'Event ID not found');
        return;
    }
    
    // Close modal
    if (modal) {
        modal.style.display = 'none';
    }
    
    // Force the state
    forceEventState(eventId, newState);
}

function getModelStatusIcon(status) {
    switch(status) {
        case 'returned': return '↩️';
        case 'ready': return '✅';
        case 'ongoing': return '🔴';
        case 'partial': return '🔄';
        case 'pending': return '📋';
        default: return '📋';
    }
}

async function loadInventory() {
  try {
    if (!currentUser) {
      try {
        const currentUserRes = await apiCall('/api/current-user');
        currentUser = currentUserRes.data;
      } catch (e) {
        console.warn('Could not load current user for inventory permissions:', e);
      }
    }

    await loadDepartments(true);

    const response = await apiCall("/api/assets");
    assets = response.data;

    ensureDepartmentManagerPanel();
    renderDepartmentManager();
    ensureInventoryBulkEditControls();
    ensureInventoryExportControls();

    // Set up event listeners for filters and sorting
    setupInventoryFilters();

    // Display all assets initially
    displayFilteredInventory();
  } catch (error) {
    document.getElementById("inventory-table-container").innerHTML =
      '<p style="color: red; text-align: center;">Error loading inventory</p>';
  }
}

function ensureInventoryExportControls() {
  const controls = document.querySelector('#inventory-section .inventory-controls');
  if (!controls) return;

  if (!isAdminUser()) {
    const existingGroup = document.getElementById('inventory-export-controls');
    if (existingGroup) existingGroup.style.display = 'none';
    return;
  }

  const existingCheckbox = document.getElementById('inventory-export-individual');
  const existingButton = controls.querySelector('[data-inventory-export-pdf="true"], button[onclick="generateInventoryPdf()"]');
  if (existingCheckbox && existingButton) {
    existingButton.setAttribute('data-inventory-export-pdf', 'true');

    const existingGroup = document.getElementById('inventory-export-controls');
    const actionRow = document.getElementById('asset-count')?.parentElement;
    if (existingGroup) {
      existingGroup.dataset.adminDisplay = 'flex';
      existingGroup.style.display = 'flex';
    }
    if (existingGroup && actionRow && existingGroup.parentElement !== actionRow) {
      existingGroup.style.marginLeft = '';
      actionRow.appendChild(existingGroup);
    }
    return;
  }

  if (document.getElementById('inventory-export-controls')) {
    return;
  }

  const row = document.createElement('div');
  row.id = 'inventory-export-controls';
  row.style.cssText = [
    'display:flex',
    'gap:12px',
    'align-items:center',
    'justify-content:flex-end',
    'flex-wrap:wrap',
    'margin-left:auto'
  ].join(';');

  row.innerHTML = `
    <label style="display:flex;align-items:center;gap:6px;font-size:14px;">
      <input type="checkbox" id="inventory-export-individual">
      Show Individual Items
    </label>
    <button
      type="button"
      class="btn btn-primary"
      data-inventory-export-pdf="true"
      style="padding:8px 16px;font-size:14px;"
    >
      Export PDF
    </button>
  `;

  row.classList.add('admin-only');
  row.setAttribute('data-admin-only', 'true');
  row.setAttribute('data-admin-display', 'flex');

  const actionRow = document.getElementById('asset-count')?.parentElement || controls.lastElementChild;
  if (actionRow && actionRow !== controls.firstElementChild) {
    actionRow.style.flexWrap = 'wrap';
    actionRow.appendChild(row);
  } else {
    controls.appendChild(row);
  }

  row.querySelector('[data-inventory-export-pdf="true"]')?.addEventListener('click', generateInventoryPdf);
}

function ensureInventoryBulkEditControls() {
  const controls = document.querySelector('#inventory-section .inventory-controls');
  if (!controls) return;

  let group = document.getElementById('inventory-bulk-edit-controls');
  if (!isAdminUser()) {
    if (group) group.style.display = 'none';
    return;
  }

  if (!group) {
    group = document.createElement('div');
    group.id = 'inventory-bulk-edit-controls';
    group.className = 'admin-only';
    group.setAttribute('data-admin-only', 'true');
    group.setAttribute('data-admin-display', 'flex');
    group.style.cssText = [
      'display:flex',
      'gap:10px',
      'align-items:center',
      'flex-wrap:wrap'
    ].join(';');
    group.innerHTML = `
      <span id="inventory-selected-count" style="color:#495057;font-size:14px;font-weight:700;">0 selected</span>
      <button type="button" id="inventory-bulk-edit-button" class="btn btn-warning" style="padding:8px 16px;font-size:14px;" disabled>Edit Selected</button>
      <button type="button" id="inventory-bulk-delete-button" class="btn btn-danger" style="padding:8px 16px;font-size:14px;" disabled>Delete Selected</button>
      <button type="button" id="inventory-clear-selection-button" class="btn btn-secondary" style="padding:8px 16px;font-size:14px;" disabled>Clear Selection</button>
    `;

    const actionRow = document.getElementById('asset-count')?.parentElement || controls.lastElementChild;
    if (actionRow) {
      actionRow.insertBefore(group, document.getElementById('asset-count') || actionRow.firstChild);
    } else {
      controls.appendChild(group);
    }

    document.getElementById('inventory-bulk-edit-button')?.addEventListener('click', openBulkAssetEditModal);
    document.getElementById('inventory-bulk-delete-button')?.addEventListener('click', openBulkAssetDeleteModal);
    document.getElementById('inventory-clear-selection-button')?.addEventListener('click', clearInventorySelection);
  }

  group.style.display = 'flex';
}

function handleInventorySortChange() {
  const sortSelect = document.getElementById("sort-select");
  const sortDesc = document.getElementById("sort-descending");
  if (sortSelect?.value === 'dateAdded' && sortDesc) {
    sortDesc.checked = true;
  }
  displayFilteredInventory();
}

function getInventoryCheckboxFilterValues(filterId) {
  const checkboxes = Array.from(
    document.querySelectorAll(`#${filterId} .inventory-checkbox-filter-options input[type="checkbox"]`)
  );
  return {
    values: checkboxes.filter(input => input.checked).map(input => input.value),
    total: checkboxes.length
  };
}

function updateInventoryCheckboxFilterSummary(filterId) {
  const summary = document.getElementById(`${filterId}-summary`);
  if (!summary) return;

  const { values, total } = getInventoryCheckboxFilterValues(filterId);
  const isDepartment = filterId === 'department-filter';
  const itemName = isDepartment ? 'Departments' : 'Statuses';

  if (total === 0 || values.length === total) {
    summary.textContent = `All ${itemName}`;
  } else if (values.length === 0) {
    summary.textContent = `No ${itemName}`;
  } else if (values.length === 1) {
    summary.textContent = isDepartment
      ? inventoryDepartmentLabel(values[0])
      : inventoryStatusText(values[0]);
  } else {
    summary.textContent = `${values.length} ${itemName}`;
  }
}

function handleInventoryCheckboxFilterChange(event) {
  if (!event.target.matches('.inventory-checkbox-filter-options input[type="checkbox"]')) return;
  updateInventoryCheckboxFilterSummary(event.currentTarget.id);
  displayFilteredInventory();
}

function setInventoryCheckboxFilterSelection(filterId, checked) {
  document
    .querySelectorAll(`#${filterId} .inventory-checkbox-filter-options input[type="checkbox"]`)
    .forEach(input => {
      input.checked = checked;
    });
  updateInventoryCheckboxFilterSummary(filterId);
  displayFilteredInventory();
}

function setupInventoryFilters() {
  // Remove existing listeners to prevent duplicates
  const searchInput = document.getElementById("asset-search");
  const deptFilter = document.getElementById("department-filter");
  const statusFilter = document.getElementById("status-filter");
  const sortSelect = document.getElementById("sort-select");
  const sortDesc = document.getElementById("sort-descending");

  if (searchInput) {
    searchInput.removeEventListener("input", displayFilteredInventory);
    searchInput.addEventListener("input", displayFilteredInventory);
  }

  if (deptFilter) {
    deptFilter.removeEventListener("change", handleInventoryCheckboxFilterChange);
    deptFilter.addEventListener("change", handleInventoryCheckboxFilterChange);
    updateInventoryCheckboxFilterSummary('department-filter');
  }

  if (statusFilter) {
    statusFilter.removeEventListener("change", handleInventoryCheckboxFilterChange);
    statusFilter.addEventListener("change", handleInventoryCheckboxFilterChange);
    updateInventoryCheckboxFilterSummary('status-filter');
  }

  document.querySelectorAll('.inventory-filter-action').forEach(button => {
    button.onclick = () => {
      setInventoryCheckboxFilterSelection(
        button.dataset.filterId,
        button.dataset.filterChecked === 'true'
      );
    };
  });

  if (sortSelect) {
    sortSelect.removeEventListener("change", displayFilteredInventory);
    sortSelect.removeEventListener("change", handleInventorySortChange);
    sortSelect.addEventListener("change", handleInventorySortChange);
  }

  if (sortDesc) {
    sortDesc.removeEventListener("change", displayFilteredInventory);
    sortDesc.addEventListener("change", displayFilteredInventory);
  }
}


function clearFilters() {
  document.getElementById("asset-search").value = "";
  ['department-filter', 'status-filter'].forEach(filterId => {
    document
      .querySelectorAll(`#${filterId} .inventory-checkbox-filter-options input[type="checkbox"]`)
      .forEach(input => {
        input.checked = true;
      });
    updateInventoryCheckboxFilterSummary(filterId);
  });
  document.getElementById("sort-select").value = "id";
  document.getElementById("sort-descending").checked = false;
  displayFilteredInventory();
}

function ensureInventoryTableStyles() {
  if (document.getElementById('inventory-compact-table-styles')) return;

  const style = document.createElement('style');
  style.id = 'inventory-compact-table-styles';

  style.textContent = `
    .inventory-compact-table {
      table-layout: auto;
      width: 100%;
      min-width: 1120px;
    }

    .inventory-compact-table th,
    .inventory-compact-table td {
      padding: 8px 10px;
      vertical-align: top;
      height: auto;
      line-height: 1.25;
    }

    .inventory-compact-table tbody tr {
      height: auto;
    }

    .inventory-compact-table .asset-id-cell {
      font-weight: 700;
      white-space: nowrap;
    }

    .inventory-compact-table .asset-id-link {
      border: 0;
      background: none;
      color: #667eea;
      cursor: pointer;
      font: inherit;
      font-weight: 700;
      padding: 0;
      text-align: left;
      text-decoration: underline;
    }

    .inventory-compact-table .asset-id-link:hover,
    .inventory-compact-table .asset-id-link:focus {
      color: #4c63c7;
    }

    .inventory-compact-table .inventory-select-cell {
      width: 38px;
      min-width: 38px;
      text-align: center;
      vertical-align: middle;
    }

    .inventory-compact-table .inventory-select-cell input {
      width: 16px;
      height: 16px;
      cursor: pointer;
    }

    .inventory-compact-table .asset-description-cell {
      max-width: 420px;
      white-space: normal;
      word-break: normal;
      overflow-wrap: anywhere;
    }

    .inventory-compact-table .asset-description-text {
      display: inline;
      line-height: 1.3;
    }

    .inventory-compact-table .asset-description-empty {
      color: #aaa;
    }

    .inventory-compact-table .bulk-quantity-cell {
      min-width: 130px;
    }

    .inventory-compact-table .asset-purchase-date-cell {
      white-space: nowrap;
      color: #495057;
    }

    .inventory-compact-table .asset-audit-date-cell {
      white-space: nowrap;
      color: #495057;
      font-size: 12px;
    }

    .bulk-deployment-details {
      margin-top: 5px;
      font-size: 12px;
      line-height: 1.25;
    }

    .bulk-deployment-details summary {
      cursor: pointer;
      color: #0f5f78;
      font-weight: 700;
      white-space: nowrap;
    }

    .bulk-deployment-menu {
      margin-top: 6px;
      min-width: 220px;
      max-width: 300px;
      padding: 7px 8px;
      border: 1px solid #d5e3ea;
      border-radius: 6px;
      background: #f8fafc;
      color: #1f2937;
      box-shadow: 0 4px 10px rgba(15, 23, 42, 0.08);
    }

    .bulk-deployment-row + .bulk-deployment-row {
      margin-top: 7px;
      padding-top: 7px;
      border-top: 1px solid #e5e7eb;
    }

    .bulk-deployment-main,
    .bulk-deployment-meta {
      display: flex;
      justify-content: space-between;
      gap: 10px;
    }

    .bulk-deployment-event {
      font-weight: 700;
      overflow-wrap: anywhere;
    }

    .bulk-deployment-event-id,
    .bulk-deployment-dates {
      color: #64748b;
    }

    .bulk-deployment-qty {
      color: #78350f;
      font-weight: 700;
      white-space: nowrap;
    }

    .inventory-actions-cell {
      white-space: nowrap;
      display: flex;
      gap: 6px;
      flex-wrap: nowrap;
      align-items: flex-start;
    }

    .inventory-compact-table .btn-sm {
      padding: 5px 9px;
      font-size: 12px;
    }

    .responsive-table-wrap {
      max-width: 100%;
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
    }

    @media (max-width: 768px) {
      .inventory-compact-table {
        min-width: 1040px;
      }

      .inventory-actions-cell {
        flex-wrap: wrap;
      }
    }
  `;

  document.head.appendChild(style);
}

function bulkDeploymentDateText(deployment) {
  const startDate = deployment?.startDate ? formatDate(deployment.startDate) : '';
  const endDate = deployment?.endDate ? formatDate(deployment.endDate) : '';
  if (!startDate && !endDate) return '';
  if (!endDate || startDate === endDate) return startDate;
  return `${startDate} - ${endDate}`;
}

function setInventoryBulkDeploymentExpanded(encodedAssetId, expanded) {
  if (expanded) expandedInventoryBulkDeploymentIds.add(encodedAssetId);
  else expandedInventoryBulkDeploymentIds.delete(encodedAssetId);
}

function bulkDeploymentDetailsHtml(asset) {
  if (!asset?.isBulk || !Array.isArray(asset.bulkDeployments)) return '';

  const deployments = asset.bulkDeployments
    .map(deployment => ({
      ...deployment,
      quantity: Math.max(0, Number(deployment?.quantity || 0) || 0)
    }))
    .filter(deployment => deployment.quantity > 0);

  if (deployments.length === 0) return '';

  const deployedTotal = Math.max(
    0,
    Number(asset.deployedQuantity ?? deployments.reduce((sum, item) => sum + item.quantity, 0)) || 0
  );
  const encodedAssetId = encodeURIComponent(getAssetIdentifierForApi(asset));
  const openAttribute = expandedInventoryBulkDeploymentIds.has(encodedAssetId) ? ' open' : '';

  return `
    <details
      class="bulk-deployment-details"
      ontoggle="setInventoryBulkDeploymentExpanded('${escapeHtmlAttr(encodedAssetId)}', this.open)"
      ${openAttribute}
    >
      <summary>${escapeHtml(String(deployedTotal))} deployed</summary>
      <div class="bulk-deployment-menu" role="list">
        ${deployments.map((deployment) => {
          const eventId = deployment.eventId ? `#${deployment.eventId}` : '';
          const eventName = deployment.eventName || (deployment.eventId ? `Event ${deployment.eventId}` : 'Event');
          const dateText = bulkDeploymentDateText(deployment);
          return `
            <div class="bulk-deployment-row" role="listitem">
              <div class="bulk-deployment-main">
                <span class="bulk-deployment-event">${escapeHtml(eventName)}</span>
                ${eventId ? `<span class="bulk-deployment-event-id">${escapeHtml(eventId)}</span>` : ''}
              </div>
              <div class="bulk-deployment-meta">
                <span class="bulk-deployment-dates">${escapeHtml(dateText || 'Date not set')}</span>
                <span class="bulk-deployment-qty">${escapeHtml(String(deployment.quantity))} deployed</span>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    </details>
  `;
}

function inventoryAssetIdentifier(asset) {
  return getAssetIdentifierForApi(asset);
}

function pruneInventorySelection() {
  const validIds = new Set((assets || []).map(inventoryAssetIdentifier).filter(Boolean));
  Array.from(selectedInventoryAssetIds).forEach(assetId => {
    if (!validIds.has(assetId)) selectedInventoryAssetIds.delete(assetId);
  });
}

function getSelectedInventoryAssets() {
  pruneInventorySelection();
  return (assets || []).filter(asset => selectedInventoryAssetIds.has(inventoryAssetIdentifier(asset)));
}

function updateInventorySelectionUi(currentVisibleAssets = null) {
  pruneInventorySelection();

  const selectedCount = selectedInventoryAssetIds.size;
  const countEl = document.getElementById('inventory-selected-count');
  const editButton = document.getElementById('inventory-bulk-edit-button');
  const deleteButton = document.getElementById('inventory-bulk-delete-button');
  const clearButton = document.getElementById('inventory-clear-selection-button');

  if (countEl) countEl.textContent = `${selectedCount} selected`;
  if (editButton) editButton.disabled = selectedCount === 0;
  if (deleteButton) deleteButton.disabled = selectedCount === 0;
  if (clearButton) clearButton.disabled = selectedCount === 0;

  document.querySelectorAll('.inventory-row-select').forEach(input => {
    input.checked = selectedInventoryAssetIds.has(input.dataset.assetId || '');
  });

  const visibleAssets = currentVisibleAssets || getFilteredInventoryData().filteredAssets || [];
  const visibleIds = visibleAssets.map(inventoryAssetIdentifier).filter(Boolean);
  const selectedVisibleCount = visibleIds.filter(assetId => selectedInventoryAssetIds.has(assetId)).length;
  const selectAll = document.getElementById('inventory-select-all-current');

  if (selectAll) {
    selectAll.checked = visibleIds.length > 0 && selectedVisibleCount === visibleIds.length;
    selectAll.indeterminate = selectedVisibleCount > 0 && selectedVisibleCount < visibleIds.length;
    selectAll.disabled = visibleIds.length === 0;
  }
}

function toggleInventoryAssetSelection(assetId, checked) {
  const normalized = String(assetId || '').trim();
  if (!normalized) return;

  if (checked) selectedInventoryAssetIds.add(normalized);
  else selectedInventoryAssetIds.delete(normalized);

  updateInventorySelectionUi();
}

function toggleInventorySelectAll(checked) {
  const { filteredAssets } = getFilteredInventoryData();
  filteredAssets.forEach(asset => {
    const assetId = inventoryAssetIdentifier(asset);
    if (!assetId) return;
    if (checked) selectedInventoryAssetIds.add(assetId);
    else selectedInventoryAssetIds.delete(assetId);
  });

  updateInventorySelectionUi(filteredAssets);
  displayInventoryTable(filteredAssets);
}

function clearInventorySelection() {
  selectedInventoryAssetIds.clear();
  updateInventorySelectionUi();
  displayFilteredInventory();
}

function openAssetDetailsModal(encodedAssetId) {
  let assetId = String(encodedAssetId || '');
  try {
    assetId = decodeURIComponent(assetId);
  } catch (error) {
    // Keep the original value if it was not URI encoded.
  }

  const asset = getAssetByApiIdentifier(assetId);
  if (!asset) {
    showNotification('error', `Asset ${assetId} not found`);
    return;
  }

  const modal = document.getElementById('assetDetailsModal');
  const title = document.getElementById('assetDetailsTitle');
  const content = document.getElementById('assetDetailsContent');
  if (!modal || !title || !content) return;

  const apiId = getAssetIdentifierForApi(asset);
  const encodedApiId = encodeURIComponent(apiId);
  const displayId = asset.isBulk ? 'Bulk Item' : (asset.id || apiId);
  const notes = String(asset.notes || '').trim();
  const quantityText = asset.isBulk
    ? `${asset.availableQuantity ?? asset.quantity ?? 1}/${asset.quantity ?? 1}`
    : '1';

  title.textContent = `${asset.isBulk ? 'Bulk Asset' : 'Asset'} Details`;
  content.innerHTML = `
    <div class="modal-body">
      <div style="background:#f8f9fa;border:1px solid #e9ecef;border-radius:8px;padding:16px;margin-bottom:16px;">
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:14px;">
          <div>
            <div style="color:#6c757d;font-size:12px;font-weight:700;text-transform:uppercase;margin-bottom:4px;">Asset ID</div>
            <div style="font-weight:800;font-size:18px;">${escapeHtml(displayId)}</div>
            ${asset.isBulk ? `<div style="color:#6c757d;font-size:12px;margin-top:4px;">Internal ID: ${escapeHtml(apiId)}</div>` : ''}
          </div>
          <div>
            <div><strong>Brand:</strong> ${escapeHtml(asset.brand || '')}</div>
            <div><strong>Model:</strong> ${escapeHtml(asset.model || '')}</div>
            <div><strong>Description:</strong> ${escapeHtml(asset.description || 'N/A')}</div>
          </div>
          <div>
            <div><strong>Serial:</strong> ${escapeHtml(asset.isBulk ? 'N/A' : (asset.serial || 'N/A'))}</div>
            <div><strong>Quantity:</strong> ${escapeHtml(String(quantityText))}</div>
            <div><strong>Purchased:</strong> ${escapeHtml(formatAssetPurchaseDate(asset.dateOfPurchase || asset.purchaseDate || ''))}</div>
          </div>
          <div>
            <div><strong>Department:</strong> ${departmentBadgeHtml(asset.department)}</div>
            <div style="margin-top:4px;"><strong>Status:</strong> ${statusBadgeHtml(asset.status || 'available')}</div>
            <div style="margin-top:4px;"><strong>Location:</strong> ${escapeHtml(asset.location || 'Store')}</div>
          </div>
        </div>
      </div>

      <div style="border:1px solid #e9ecef;border-radius:8px;padding:16px;margin-bottom:16px;background:#fff;">
        <h4 style="margin:0 0 10px 0;color:#495057;">Notes</h4>
        <div style="white-space:pre-wrap;line-height:1.5;color:${notes ? '#212529' : '#6c757d'};">
          ${notes ? escapeHtml(notes) : '<span style="font-style:italic;">No notes for this asset.</span>'}
        </div>
      </div>

      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px;margin-bottom:16px;">
        <div style="border:1px solid #e9ecef;border-radius:8px;padding:12px;">
          <strong>Default Location</strong><br>
          ${escapeHtml(asset.defaultLocation || 'Store')}
        </div>
        <div style="border:1px solid #e9ecef;border-radius:8px;padding:12px;">
          <strong>Current Location</strong><br>
          ${escapeHtml(asset.currentLocation || asset.location || 'Store')}
        </div>
        <div style="border:1px solid #e9ecef;border-radius:8px;padding:12px;">
          <strong>Flags</strong><br>
          ${assetFlagBadgesHtml(asset)}
        </div>
      </div>

      <div class="modal-actions" style="display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap;">
        <button type="button" class="btn btn-primary" onclick="closeModal('assetDetailsModal'); viewMaintenanceLog('${escapeHtmlAttr(encodedApiId)}')">View Log</button>
        ${
          isAdminUser()
            ? `<button type="button" class="btn btn-warning" onclick="closeModal('assetDetailsModal'); openEditAssetModal('${escapeHtmlAttr(encodedApiId)}')">Edit Asset</button>`
            : ''
        }
        <button type="button" class="btn btn-secondary" onclick="closeModal('assetDetailsModal')">Close</button>
      </div>
    </div>
  `;

  openModal('assetDetailsModal');
}

function inventoryVirtualRowHtml(asset, isAdmin) {
  const encodedAssetId = encodeURIComponent(getAssetIdentifierForApi(asset));
  const assetIdentifier = inventoryAssetIdentifier(asset);
  const description = asset.description || "";
  const quantityHtml = asset.isBulk
    ? `${escapeHtml(String(asset.availableQuantity ?? asset.quantity ?? 1))}/${escapeHtml(String(asset.quantity ?? 1))}${bulkDeploymentDetailsHtml(asset)}`
    : '1';
  const selectionCellHtml = isAdmin
    ? `<td class="inventory-select-cell">
         <input
           type="checkbox"
           class="inventory-row-select"
           data-asset-id="${escapeHtmlAttr(assetIdentifier)}"
           ${selectedInventoryAssetIds.has(assetIdentifier) ? 'checked' : ''}
           onchange="toggleInventoryAssetSelection(this.dataset.assetId, this.checked)"
           aria-label="Select ${escapeHtmlAttr(assetIdentifier || 'asset')}"
         >
       </td>`
    : '';

  return `
    <tr>
      ${selectionCellHtml}
      <td class="asset-id-cell">
        <button type="button" class="asset-id-link" onclick="openAssetDetailsModal('${encodedAssetId}')" title="View asset details">
          ${asset.isBulk ? '<span class="asset-badge status-available">Bulk Item</span>' : escapeHtml(asset.id)}
        </button>
      </td>
      <td>${escapeHtml(asset.brand || "")}</td>
      <td>${escapeHtml(asset.model || "")}</td>
      <td class="asset-description-cell">
        ${description
          ? `<span class="asset-description-text">${escapeHtml(description)}</span>`
          : `<span class="asset-description-empty">—</span>`}
      </td>
      <td>${asset.isBulk ? '—' : escapeHtml(asset.serial || "N/A")}</td>
      <td class="${asset.isBulk ? 'bulk-quantity-cell' : ''}">${quantityHtml}</td>
      <td class="asset-purchase-date-cell">${escapeHtml(formatAssetPurchaseDate(asset.dateOfPurchase || asset.purchaseDate || ''))}</td>
      <td class="asset-audit-date-cell">${escapeHtml(formatAssetAuditDateTime(asset.dateAdded || ''))}</td>
      <td class="asset-audit-date-cell">${escapeHtml(formatAssetAuditDateTime(asset.dateModified || ''))}</td>
      <td>${departmentBadgeHtml(asset.department)}</td>
      <td>${statusBadgeHtml(asset.status || 'available')}</td>
      <td>${escapeHtml(asset.location || "Store")}</td>
      <td>${assetFlagBadgesHtml(asset)}</td>
      <td class="inventory-actions-cell">
        <button class="btn btn-primary btn-sm" onclick="viewMaintenanceLog('${encodedAssetId}')" title="View maintenance log">
          View Log
        </button>
        ${isAdmin
          ? `<button class="btn btn-warning btn-sm" onclick="openEditAssetModal('${encodedAssetId}')" title="Edit asset attributes">Edit</button>
             <button class="btn btn-danger btn-sm" onclick="openDeleteAssetModal('${encodedAssetId}')" title="Delete asset">Delete</button>`
          : ''}
      </td>
    </tr>
  `;
}

function displayInventoryTable(assetsToShow) {
  ensureInventoryTableStyles();

  const container = document.getElementById("inventory-table-container");
  if (!container) return;

  if (assetsToShow.length === 0) {
    destroyVirtualTable('inventory');
    container.innerHTML =
      '<p style="text-align: center; color: #666; padding: 40px;">No assets found.</p>';
    updateInventorySelectionUi([]);
    return;
  }

  const isAdmin = !!(currentUser && currentUser.isAdmin);
  const selectionHeaderHtml = isAdmin
    ? `<th class="inventory-select-cell">
         <input type="checkbox" id="inventory-select-all-current" onchange="toggleInventorySelectAll(this.checked)" title="Select all visible assets" aria-label="Select all visible assets">
       </th>`
    : '';

  renderVirtualTable({
    stateKey: 'inventory',
    container,
    items: assetsToShow,
    columnCount: isAdmin ? 15 : 14,
    tableClass: 'table inventory-compact-table',
    estimatedRowHeight: 64,
    headerHtml: `
      <tr>
        ${selectionHeaderHtml}
        <th>Asset ID</th>
        <th>Brand</th>
        <th>Model</th>
        <th>Description</th>
        <th>Serial</th>
        <th>Qty</th>
        <th>Purchased</th>
        <th>Added</th>
        <th>Modified</th>
        <th>Department</th>
        <th>Status</th>
        <th>Location</th>
        <th>Flags</th>
        <th>Actions</th>
      </tr>
    `,
    rowHtml: asset => inventoryVirtualRowHtml(asset, isAdmin)
  });

  updateInventorySelectionUi(assetsToShow);
}

function normalizeAssetGroupValue(value, uppercase = false) {
  const cleaned = String(value ?? '').trim();
  return uppercase ? cleaned.toUpperCase() : cleaned;
}

function sameAssetGroup(asset, group) {
  return (
    normalizeAssetGroupValue(asset.department, true) === normalizeAssetGroupValue(group.department, true) &&
    normalizeAssetGroupValue(asset.brand) === normalizeAssetGroupValue(group.brand) &&
    normalizeAssetGroupValue(asset.model) === normalizeAssetGroupValue(group.model)
  );
}

function ensureAssetEditModal() {
  if (document.getElementById('editAssetModal')) return;

  const modal = document.createElement('div');
  modal.id = 'editAssetModal';
  modal.className = 'modal';

  modal.innerHTML = `
    <div class="modal-content" style="max-width:760px;">
      <div class="modal-header">
        <h3 class="modal-title">Edit Asset</h3>
        <button class="close-btn" onclick="closeModal('editAssetModal')">&times;</button>
      </div>

      <div class="modal-body">
        <div style="background:#fff3cd;border:1px solid #ffeaa7;color:#856404;padding:12px;border-radius:8px;margin-bottom:16px;">
          Admin-only edit. If Asset ID is changed, it will be updated across all events and containers.
        </div>

        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;">
          <div class="form-group">
            <label class="form-label">Asset ID</label>
            <input id="editAssetId" class="form-input">
            <div id="editAssetBulkNote" style="display:none;color:#666;font-size:12px;margin-top:5px;">Bulk quantity assets do not have a visible Asset ID. This internal ID is kept only for system tracking.</div>
          </div>

          <div class="form-group">
            <label class="form-label">Brand</label>
            <input id="editAssetBrand" class="form-input">
          </div>

          <div class="form-group">
            <label class="form-label">Model</label>
            <input id="editAssetModel" class="form-input">
          </div>

          <div class="form-group" id="editAssetSerialGroup">
            <label class="form-label">Serial</label>
            <input id="editAssetSerial" class="form-input">
          </div>

          <div class="form-group">
            <label class="form-label">Date of Purchase</label>
            <input id="editAssetDateOfPurchase" type="date" class="form-input">
          </div>

          <div class="form-group" id="editAssetQuantityGroup" style="display:none;">
            <label class="form-label">Bulk Quantity</label>
            <input id="editAssetQuantity" type="number" min="1" class="form-input">
          </div>

          <div class="form-group">
            <label class="form-label">Department</label>
            <input id="editAssetDepartment" class="form-input" placeholder="AX / LX / VX / UN">
          </div>

          <div class="form-group">
            <label class="form-label">Default Location</label>
            <input id="editAssetDefaultLocation" class="form-input" placeholder="Store">
          </div>

          <div class="form-group">
            <label class="form-label">Current Location</label>
            <input id="editAssetCurrentLocation" class="form-input" placeholder="Leave blank for default">
          </div>
        </div>

        <div class="form-group">
          <label class="form-label">Description</label>
          <textarea id="editAssetDescription" class="form-input" rows="3"></textarea>
        </div>

        <div class="form-group">
          <label class="form-label">Notes</label>
          <textarea id="editAssetNotes" class="form-input" rows="4"></textarea>
        </div>

        <div class="form-group" style="margin-top:8px;">
          <label class="form-label" for="editAssetStatus">Asset Status</label>
          <select id="editAssetStatus" class="form-input">
            <option value="ok">OK</option>
            <option value="ooc">OOC</option>
            <option value="missing">Missing</option>
            <option value="degraded">Degraded</option>
            <option value="decommissioned">Decommissioned</option>
          </select>
          <small style="color:#666;font-size:12px;margin-top:6px;display:block;">
            Assets can only have one status at a time.
          </small>
        </div>

        <div style="background:#f8f9fa;border:1px solid #e9ecef;border-radius:8px;padding:12px;margin-top:16px;">
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;">
            <div class="form-group" style="margin-bottom:0;">
              <label class="form-label">Date Added</label>
              <input id="editAssetDateAdded" class="form-input" readonly>
            </div>
            <div class="form-group" style="margin-bottom:0;">
              <label class="form-label">Date Modified</label>
              <input id="editAssetDateModified" class="form-input" readonly>
            </div>
          </div>
          <details style="margin-top:12px;">
            <summary style="cursor:pointer;font-weight:700;color:#495057;">Change History</summary>
            <div id="editAssetChangeHistory" style="margin-top:8px;max-height:260px;overflow-y:auto;"></div>
          </details>
        </div>
      </div>

      <div class="modal-footer modal-actions" style="display:flex;gap:10px;justify-content:flex-end;margin-top:20px;">
        <button class="btn btn-danger" onclick="openDeleteAssetModal()" style="margin-right:auto;">Delete Asset</button>
        <button class="btn btn-secondary" onclick="closeModal('editAssetModal')">Cancel</button>
        <button class="btn btn-success" onclick="saveAssetEditModal()">Save Changes</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);
}

function openEditAssetModal(encodedAssetId) {
  if (!currentUser || !currentUser.isAdmin) {
    showNotification('error', 'Admin privileges required');
    return;
  }

  ensureAssetEditModal();
  ensureDepartmentDatalist();
  document.getElementById('editAssetDepartment')?.setAttribute('list', 'department-code-options');

  const assetId = decodeURIComponent(encodedAssetId);
  const asset = assets.find(a => getAssetIdentifierForApi(a) === assetId);

  if (!asset) {
    showNotification('error', `Asset ${assetId} not found`);
    return;
  }

  const modal = document.getElementById('editAssetModal');

  modal.dataset.originalAsset = JSON.stringify({
    id: getAssetIdentifierForApi(asset),
    isBulk: !!asset.isBulk,
    brand: asset.brand || '',
    model: asset.model || '',
    description: asset.description || '',
    dateOfPurchase: asset.dateOfPurchase || asset.purchaseDate || '',
    department: asset.department || ''
  });

  document.getElementById('editAssetId').value = getAssetIdentifierForApi(asset) || '';
  document.getElementById('editAssetId').readOnly = !!asset.isBulk;
  document.getElementById('editAssetBulkNote').style.display = asset.isBulk ? 'block' : 'none';
  document.getElementById('editAssetSerialGroup').style.display = asset.isBulk ? 'none' : 'block';
  document.getElementById('editAssetQuantityGroup').style.display = asset.isBulk ? 'block' : 'none';
  document.getElementById('editAssetQuantity').value = asset.quantity || 1;
  document.getElementById('editAssetBrand').value = asset.brand || '';
  document.getElementById('editAssetModel').value = asset.model || '';
  document.getElementById('editAssetSerial').value = asset.serial || '';
  document.getElementById('editAssetDateOfPurchase').value = normalizeAssetPurchaseDateValue(asset.dateOfPurchase || asset.purchaseDate || '');
  document.getElementById('editAssetDescription').value = asset.description || '';
  document.getElementById('editAssetNotes').value = asset.notes || '';
  document.getElementById('editAssetDepartment').value = asset.department || 'UN';
  document.getElementById('editAssetDefaultLocation').value = asset.defaultLocation || 'Store';
  document.getElementById('editAssetCurrentLocation').value = asset.currentLocation || '';
  document.getElementById('editAssetDateAdded').value = formatAssetAuditDateTime(asset.dateAdded || '');
  document.getElementById('editAssetDateModified').value = formatAssetAuditDateTime(asset.dateModified || '');
  document.getElementById('editAssetChangeHistory').innerHTML = assetChangeHistoryHtml(asset);
  const editStatusEl = document.getElementById('editAssetStatus');
  if (editStatusEl) {
    const conditionStatus = getAssetConditionStatus(asset);
    editStatusEl.value = conditionStatus === 'available' ? 'ok' : conditionStatus;
  }

  openModal('editAssetModal');
}

async function saveAssetEditModal() {
  if (!currentUser || !currentUser.isAdmin) {
    showNotification('error', 'Admin privileges required');
    return;
  }

  const modal = document.getElementById('editAssetModal');
  const original = JSON.parse(modal.dataset.originalAsset || '{}');

  const payload = {
    id: document.getElementById('editAssetId').value.trim(),
    internalId: original.id,
    brand: document.getElementById('editAssetBrand').value.trim(),
    model: document.getElementById('editAssetModel').value.trim(),
    serial: document.getElementById('editAssetSerial').value.trim(),
    dateOfPurchase: document.getElementById('editAssetDateOfPurchase').value.trim(),
    description: document.getElementById('editAssetDescription').value.trim(),
    notes: document.getElementById('editAssetNotes').value.trim(),
    department: document.getElementById('editAssetDepartment').value.trim().toUpperCase(),
    defaultLocation: document.getElementById('editAssetDefaultLocation').value.trim(),
    currentLocation: document.getElementById('editAssetCurrentLocation').value.trim(),
    isMissing: document.getElementById('editAssetStatus')?.value === 'missing',
    isOOC: document.getElementById('editAssetStatus')?.value === 'ooc',
    isDegraded: document.getElementById('editAssetStatus')?.value === 'degraded',
    isDecommissioned: document.getElementById('editAssetStatus')?.value === 'decommissioned',
    quantity: parseInt(document.getElementById('editAssetQuantity')?.value || '1', 10) || 1,
    applyTo: 'single'
  };

  if (!payload.id && !original.isBulk) {
    showNotification('warning', 'Asset ID cannot be empty');
    return;
  }

  if (original.isBulk) {
    payload.id = original.id;
  }

  if (!payload.brand) {
    showNotification('warning', 'Brand cannot be empty');
    return;
  }

  if (!payload.model) {
    showNotification('warning', 'Model cannot be empty');
    return;
  }

  if (!payload.department) {
    showNotification('warning', 'Department cannot be empty');
    return;
  }

  const modelOrDescriptionChanged =
    normalizeAssetGroupValue(payload.model) !== normalizeAssetGroupValue(original.model) ||
    normalizeAssetGroupValue(payload.description) !== normalizeAssetGroupValue(original.description);

  const sameOriginalGroupAssets = assets.filter(asset => sameAssetGroup(asset, original));

  if (modelOrDescriptionChanged && sameOriginalGroupAssets.length > 1) {
    const changeAll = await showAppConfirm({
      title: 'Update Matching Assets',
      message:
        `This asset belongs to a group of ${sameOriginalGroupAssets.length} asset(s) with the same model/description.\n\n` +
        `Choose whether to update all matching assets or only this specific asset.`,
      confirmText: 'Change All',
      cancelText: 'Only This Asset',
      variant: 'info',
    });

    payload.applyTo = changeAll ? 'allSimilar' : 'single';
  }

  try {
    const res = await apiCall(
      `/api/assets/${encodeURIComponent(original.id)}`,
      'PUT',
      payload
    );

    const data = res.data || {};

    closeModal('editAssetModal');

    let message = `Asset updated`;

    if (data.updatedAssets && data.updatedAssets > 1) {
      message += ` (${data.updatedAssets} matching assets updated)`;
    }

    if (data.eventsUpdated) {
      message += `; ${data.eventsUpdated} event(s) updated`;
    }

    if (data.containersUpdated) {
      message += `; ${data.containersUpdated} container(s) updated`;
    }

    showNotification('success', message);

    await loadInventory();

    if (document.getElementById('events-section')?.classList.contains('active')) {
      await loadAllEvents();
    }

  } catch (error) {
    showNotification('error', `Failed to update asset: ${error.message}`);
  }
}

function commonInventoryAssetValue(selectedAssets, getter) {
  if (!selectedAssets.length) return '';
  const values = selectedAssets.map(asset => String(getter(asset) || ''));
  return values.every(value => value === values[0]) ? values[0] : '';
}

function selectedInventoryAssetSummaryHtml(selectedAssets) {
  const ids = selectedAssets.map(inventoryAssetIdentifier).filter(Boolean);
  const previewIds = ids.slice(0, 8);
  const moreCount = Math.max(0, ids.length - previewIds.length);

  return `
    <strong>${escapeHtml(String(ids.length))} asset${ids.length === 1 ? '' : 's'} selected</strong>
    <div style="margin-top:6px;color:#495057;line-height:1.45;">
      ${previewIds.map(id => `<span class="asset-badge status-available" style="margin:0 4px 4px 0;">${escapeHtml(id)}</span>`).join('')}
      ${moreCount ? `<span style="color:#666;">+${escapeHtml(String(moreCount))} more</span>` : ''}
    </div>
  `;
}

function ensureBulkAssetEditModal() {
  if (document.getElementById('bulkAssetEditModal')) return;

  const modal = document.createElement('div');
  modal.id = 'bulkAssetEditModal';
  modal.className = 'modal';
  modal.innerHTML = `
    <div class="modal-content" style="max-width:820px;">
      <div class="modal-header">
        <h3 class="modal-title">Edit Selected Assets</h3>
        <button class="close-btn" onclick="closeModal('bulkAssetEditModal')">&times;</button>
      </div>

      <div class="modal-body">
        <div id="bulkEditAssetSummary" style="background:#f8f9fa;border:1px solid #e9ecef;border-radius:8px;padding:12px;margin-bottom:16px;"></div>

        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px;">
          <div id="bulkEditAssetIdSequenceGroup" class="form-group" style="grid-column:1/-1;display:none;">
            <label class="form-label">
              <input type="checkbox" id="bulkEditUseAssetIdSequence" style="margin-right:8px;">
              Asset ID sequence
            </label>
            <input id="bulkEditStartingAssetId" class="form-input" placeholder="Starting Asset ID, e.g. MIC#01" disabled>
            <div id="bulkEditAssetIdPreview" style="margin-top:6px;color:#6c757d;font-size:13px;">
              Enter an ID ending in a number. Selected assets will be numbered in the order shown.
            </div>
          </div>

          <div class="form-group">
            <label class="form-label">
              <input type="checkbox" id="bulkEditUseDateOfPurchase" style="margin-right:8px;">
              Date of Purchase
            </label>
            <input id="bulkEditDateOfPurchase" type="date" class="form-input" disabled>
          </div>

          <div class="form-group">
            <label class="form-label">
              <input type="checkbox" id="bulkEditUseDepartment" style="margin-right:8px;">
              Department
            </label>
            <input id="bulkEditDepartment" class="form-input" list="department-code-options" placeholder="AX / LX / VX / UN" disabled>
          </div>

          <div class="form-group">
            <label class="form-label">
              <input type="checkbox" id="bulkEditUseBrand" style="margin-right:8px;">
              Brand
            </label>
            <input id="bulkEditBrand" class="form-input" disabled>
          </div>

          <div class="form-group">
            <label class="form-label">
              <input type="checkbox" id="bulkEditUseModel" style="margin-right:8px;">
              Model
            </label>
            <input id="bulkEditModel" class="form-input" disabled>
          </div>

          <div class="form-group">
            <label class="form-label">
              <input type="checkbox" id="bulkEditUseDefaultLocation" style="margin-right:8px;">
              Default Location
            </label>
            <input id="bulkEditDefaultLocation" class="form-input" placeholder="Store" disabled>
          </div>

          <div class="form-group">
            <label class="form-label">
              <input type="checkbox" id="bulkEditUseCurrentLocation" style="margin-right:8px;">
              Current Location
            </label>
            <input id="bulkEditCurrentLocation" class="form-input" placeholder="Leave blank for default" disabled>
          </div>

          <div class="form-group">
            <label class="form-label">
              <input type="checkbox" id="bulkEditUseStatus" style="margin-right:8px;">
              Asset Status
            </label>
            <select id="bulkEditStatus" class="form-input" disabled>
              <option value="ok">OK</option>
              <option value="ooc">OOC</option>
              <option value="missing">Missing</option>
              <option value="degraded">Degraded</option>
              <option value="decommissioned">Decommissioned</option>
            </select>
          </div>
        </div>

        <div class="form-group">
          <label class="form-label">
            <input type="checkbox" id="bulkEditUseDescription" style="margin-right:8px;">
            Description
          </label>
          <textarea id="bulkEditDescription" class="form-input" rows="3" disabled></textarea>
        </div>
      </div>

      <div class="modal-footer modal-actions" style="display:flex;gap:10px;justify-content:flex-end;margin-top:20px;">
        <button class="btn btn-secondary" onclick="closeModal('bulkAssetEditModal')">Cancel</button>
        <button class="btn btn-success" onclick="saveBulkAssetEditModal()">Save Changes</button>
      </div>
    </div>
  `;

  modal.addEventListener('click', (event) => {
    if (event.target === modal) closeModal('bulkAssetEditModal');
  });

  document.body.appendChild(modal);

  [
    'AssetIdSequence',
    'DateOfPurchase',
    'Department',
    'Brand',
    'Model',
    'DefaultLocation',
    'CurrentLocation',
    'Status',
    'Description'
  ].forEach(name => {
    document.getElementById(`bulkEditUse${name}`)?.addEventListener('change', syncBulkAssetEditFields);
  });

  document.getElementById('bulkEditStartingAssetId')?.addEventListener('input', updateBulkAssetIdSequencePreview);
}

function syncBulkAssetEditFields() {
  [
    ['bulkEditUseAssetIdSequence', 'bulkEditStartingAssetId'],
    ['bulkEditUseDateOfPurchase', 'bulkEditDateOfPurchase'],
    ['bulkEditUseDepartment', 'bulkEditDepartment'],
    ['bulkEditUseBrand', 'bulkEditBrand'],
    ['bulkEditUseModel', 'bulkEditModel'],
    ['bulkEditUseDefaultLocation', 'bulkEditDefaultLocation'],
    ['bulkEditUseCurrentLocation', 'bulkEditCurrentLocation'],
    ['bulkEditUseStatus', 'bulkEditStatus'],
    ['bulkEditUseDescription', 'bulkEditDescription']
  ].forEach(([checkboxId, inputId]) => {
    const checkbox = document.getElementById(checkboxId);
    const input = document.getElementById(inputId);
    if (input) input.disabled = !(checkbox && checkbox.checked);
  });
  updateBulkAssetIdSequencePreview();
}

function resetBulkAssetEditChecks() {
  [
    'bulkEditUseAssetIdSequence',
    'bulkEditUseDateOfPurchase',
    'bulkEditUseDepartment',
    'bulkEditUseBrand',
    'bulkEditUseModel',
    'bulkEditUseDefaultLocation',
    'bulkEditUseCurrentLocation',
    'bulkEditUseStatus',
    'bulkEditUseDescription'
  ].forEach(id => {
    const checkbox = document.getElementById(id);
    if (checkbox) checkbox.checked = false;
  });
  syncBulkAssetEditFields();
}

function buildBulkAssetIdSequence(startingAssetId, count) {
  const value = String(startingAssetId || '').trim();
  const match = value.match(/^(.*?)(\d+)$/);
  if (!match) return null;

  const prefix = match[1];
  const numberText = match[2];
  const startingNumber = Number.parseInt(numberText, 10);
  if (!Number.isSafeInteger(startingNumber)) return null;

  return Array.from({ length: count }, (_, index) => (
    `${prefix}${String(startingNumber + index).padStart(numberText.length, '0')}`
  ));
}

function updateBulkAssetIdSequencePreview() {
  const preview = document.getElementById('bulkEditAssetIdPreview');
  if (!preview) return;

  const selectedAssets = getSelectedInventoryAssets();
  const enabled = document.getElementById('bulkEditUseAssetIdSequence')?.checked;
  const startingAssetId = document.getElementById('bulkEditStartingAssetId')?.value || '';
  if (!enabled || !startingAssetId.trim()) {
    preview.style.color = '#6c757d';
    preview.textContent = 'Enter an ID ending in a number. Selected assets will be numbered in the order shown.';
    return;
  }

  const sequence = buildBulkAssetIdSequence(startingAssetId, selectedAssets.length);
  if (!sequence) {
    preview.textContent = 'The starting Asset ID must end with a number, such as MIC#01.';
    preview.style.color = '#dc3545';
    return;
  }

  preview.style.color = '#6c757d';
  preview.textContent = sequence.length > 1
    ? `IDs will run from ${sequence[0]} to ${sequence[sequence.length - 1]}.`
    : `Asset ID will be ${sequence[0]}.`;
}

function openBulkAssetEditModal() {
  if (!currentUser || !currentUser.isAdmin) {
    showNotification('error', 'Admin privileges required');
    return;
  }

  const selectedAssets = getSelectedInventoryAssets();
  if (!selectedAssets.length) {
    showNotification('warning', 'Select at least one asset');
    return;
  }

  ensureBulkAssetEditModal();
  ensureDepartmentDatalist();

  const sequenceGroup = document.getElementById('bulkEditAssetIdSequenceGroup');
  if (sequenceGroup) sequenceGroup.style.display = selectedAssets.length > 1 ? 'block' : 'none';
  document.getElementById('bulkEditStartingAssetId').value = '';
  document.getElementById('bulkEditAssetSummary').innerHTML = selectedInventoryAssetSummaryHtml(selectedAssets);
  document.getElementById('bulkEditDateOfPurchase').value = normalizeAssetPurchaseDateValue(commonInventoryAssetValue(selectedAssets, asset => asset.dateOfPurchase || asset.purchaseDate || ''));
  document.getElementById('bulkEditDepartment').value = commonInventoryAssetValue(selectedAssets, asset => asset.department || 'UN') || '';
  document.getElementById('bulkEditBrand').value = commonInventoryAssetValue(selectedAssets, asset => asset.brand || '') || '';
  document.getElementById('bulkEditModel').value = commonInventoryAssetValue(selectedAssets, asset => asset.model || '') || '';
  document.getElementById('bulkEditDefaultLocation').value = commonInventoryAssetValue(selectedAssets, asset => asset.defaultLocation || 'Store') || '';
  document.getElementById('bulkEditCurrentLocation').value = commonInventoryAssetValue(selectedAssets, asset => asset.currentLocation || '') || '';
  document.getElementById('bulkEditDescription').value = commonInventoryAssetValue(selectedAssets, asset => asset.description || '') || '';

  const commonStatus = commonInventoryAssetValue(selectedAssets, getAssetConditionStatus);
  document.getElementById('bulkEditStatus').value = commonStatus === 'available' ? 'ok' : (commonStatus || 'ok');

  resetBulkAssetEditChecks();
  openModal('bulkAssetEditModal');
}

function bulkAssetStatusPayload(statusValue) {
  const status = String(statusValue || 'ok').trim().toLowerCase();
  return {
    isMissing: status === 'missing',
    isOOC: status === 'ooc',
    isDegraded: status === 'degraded',
    isDecommissioned: status === 'decommissioned'
  };
}

function collectBulkAssetEditPayload(asset) {
  const payload = {
    id: inventoryAssetIdentifier(asset),
    internalId: inventoryAssetIdentifier(asset),
    applyTo: 'single'
  };

  let selectedFieldCount = 0;
  const useField = (id) => document.getElementById(id)?.checked || false;
  const readValue = (id) => (document.getElementById(id)?.value || '').trim();

  if (useField('bulkEditUseDateOfPurchase')) {
    payload.dateOfPurchase = readValue('bulkEditDateOfPurchase');
    selectedFieldCount += 1;
  }

  if (useField('bulkEditUseDepartment')) {
    payload.department = readValue('bulkEditDepartment').toUpperCase();
    selectedFieldCount += 1;
  }

  if (useField('bulkEditUseBrand')) {
    payload.brand = readValue('bulkEditBrand');
    selectedFieldCount += 1;
  }

  if (useField('bulkEditUseModel')) {
    payload.model = readValue('bulkEditModel');
    selectedFieldCount += 1;
  }

  if (useField('bulkEditUseDescription')) {
    payload.description = readValue('bulkEditDescription');
    selectedFieldCount += 1;
  }

  if (useField('bulkEditUseDefaultLocation')) {
    payload.defaultLocation = readValue('bulkEditDefaultLocation');
    selectedFieldCount += 1;
  }

  if (useField('bulkEditUseCurrentLocation')) {
    payload.currentLocation = readValue('bulkEditCurrentLocation');
    selectedFieldCount += 1;
  }

  if (useField('bulkEditUseStatus')) {
    Object.assign(payload, bulkAssetStatusPayload(readValue('bulkEditStatus')));
    selectedFieldCount += 1;
  }

  payload.__selectedFieldCount = selectedFieldCount;
  return payload;
}

async function saveBulkAssetEditModal() {
  if (!currentUser || !currentUser.isAdmin) {
    showNotification('error', 'Admin privileges required');
    return;
  }

  const selectedAssets = getSelectedInventoryAssets();
  if (!selectedAssets.length) {
    showNotification('warning', 'Select at least one asset');
    return;
  }

  const samplePayload = collectBulkAssetEditPayload(selectedAssets[0]);
  const useAssetIdSequence = (
    selectedAssets.length > 1
    && (document.getElementById('bulkEditUseAssetIdSequence')?.checked || false)
  );
  const startingAssetId = (document.getElementById('bulkEditStartingAssetId')?.value || '').trim();
  const assetIdSequence = useAssetIdSequence
    ? buildBulkAssetIdSequence(startingAssetId, selectedAssets.length)
    : null;

  if (!samplePayload.__selectedFieldCount && !useAssetIdSequence) {
    showNotification('warning', 'Choose at least one field to update');
    return;
  }

  if (useAssetIdSequence && !assetIdSequence) {
    showNotification('warning', 'Starting Asset ID must end with a number, such as MIC#01');
    return;
  }

  if ('department' in samplePayload && !samplePayload.department) {
    showNotification('warning', 'Department cannot be empty');
    return;
  }

  if ('brand' in samplePayload && !samplePayload.brand) {
    showNotification('warning', 'Brand cannot be empty');
    return;
  }

  if ('model' in samplePayload && !samplePayload.model) {
    showNotification('warning', 'Model cannot be empty');
    return;
  }

  let updated = 0;
  let eventsUpdated = 0;
  let containersUpdated = 0;
  const failed = [];
  let assetIdMapping = {};

  if (useAssetIdSequence) {
    try {
      const renumberResult = await apiCall('/api/assets/bulk-renumber', 'POST', {
        assetIds: selectedAssets.map(inventoryAssetIdentifier),
        startingAssetId
      });
      assetIdMapping = renumberResult.data?.mapping || {};
      updated = selectedAssets.length;
      eventsUpdated += Number(renumberResult.data?.eventsUpdated || 0);
      containersUpdated += Number(renumberResult.data?.containersUpdated || 0);
    } catch (error) {
      return;
    }
  }

  if (samplePayload.__selectedFieldCount) {
    for (const asset of selectedAssets) {
      const originalAssetId = inventoryAssetIdentifier(asset);
      const assetId = assetIdMapping[originalAssetId] || originalAssetId;
      const payload = collectBulkAssetEditPayload(asset);
      payload.id = assetId;
      payload.internalId = assetId;
      delete payload.__selectedFieldCount;

      try {
        const res = await apiCall(`/api/assets/${encodeURIComponent(assetId)}`, 'PUT', payload);
        if (!useAssetIdSequence) updated += 1;
        eventsUpdated += Number(res.data?.eventsUpdated || 0);
        containersUpdated += Number(res.data?.containersUpdated || 0);
      } catch (error) {
        failed.push({ assetId, message: error.message });
      }
    }
  }

  closeModal('bulkAssetEditModal');

  if (updated) {
    let message = `Updated ${updated} asset${updated === 1 ? '' : 's'}`;
    if (eventsUpdated) message += `; ${eventsUpdated} event update${eventsUpdated === 1 ? '' : 's'}`;
    if (containersUpdated) message += `; ${containersUpdated} container update${containersUpdated === 1 ? '' : 's'}`;
    if (failed.length) message += `; ${failed.length} failed`;
    showNotification(failed.length ? 'warning' : 'success', message);
  } else if (failed.length) {
    showNotification('error', `Failed to update selected assets`);
  }

  selectedInventoryAssetIds.clear();
  await loadInventory();

  if (document.getElementById('events-section')?.classList.contains('active')) {
    await loadAllEvents();
  }
}

function ensureDeleteAssetModal() {
  if (document.getElementById('deleteAssetModal')) return;

  const modal = document.createElement('div');
  modal.id = 'deleteAssetModal';
  modal.className = 'modal';
  modal.innerHTML = `
    <div class="modal-content" style="max-width:480px;">
      <div class="modal-header">
        <h3 class="modal-title">Delete Asset</h3>
        <button class="close-btn" onclick="closeModal('deleteAssetModal')">&times;</button>
      </div>
      <div class="modal-body">
        <div style="background:#f8d7da;border:1px solid #f5c2c7;color:#842029;padding:12px;border-radius:8px;margin-bottom:14px;">
          This permanently deletes the asset from inventory. Enter your admin password to confirm.
        </div>
        <div id="deleteAssetSummary" style="margin-bottom:14px;color:#495057;font-size:14px;"></div>
        <div class="form-group">
          <label class="form-label" for="deleteAssetPassword">Admin Password</label>
          <input id="deleteAssetPassword" type="password" class="form-input" autocomplete="current-password">
        </div>
      </div>
      <div class="modal-footer modal-actions" style="display:flex;gap:10px;justify-content:flex-end;margin-top:20px;">
        <button class="btn btn-secondary" onclick="closeModal('deleteAssetModal')">Cancel</button>
        <button class="btn btn-danger" onclick="confirmDeleteAsset()">Delete Asset</button>
      </div>
    </div>
  `;

  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal('deleteAssetModal');
  });

  document.body.appendChild(modal);
}

function openDeleteAssetModal(encodedAssetId = '') {
  if (!currentUser || !currentUser.isAdmin) {
    showNotification('error', 'Admin privileges required');
    return;
  }

  ensureDeleteAssetModal();

  let assetId = '';
  if (encodedAssetId) {
    assetId = decodeURIComponent(encodedAssetId);
  } else {
    const editModal = document.getElementById('editAssetModal');
    const original = JSON.parse(editModal?.dataset.originalAsset || '{}');
    assetId = original.id || '';
  }

  const asset = assets.find(a => getAssetIdentifierForApi(a) === assetId);
  const modal = document.getElementById('deleteAssetModal');
  modal.dataset.assetId = assetId;
  document.getElementById('deleteAssetPassword').value = '';
  document.getElementById('deleteAssetSummary').innerHTML = asset
    ? `<strong>${escapeHtml(assetId)}</strong><br>${escapeHtml([asset.brand, asset.model, asset.description].filter(Boolean).join(' ') || 'Asset')}`
    : `<strong>${escapeHtml(assetId)}</strong>`;

  openModal('deleteAssetModal');
  setTimeout(() => document.getElementById('deleteAssetPassword')?.focus(), 100);
}

async function confirmDeleteAsset() {
  if (!currentUser || !currentUser.isAdmin) {
    showNotification('error', 'Admin privileges required');
    return;
  }

  const modal = document.getElementById('deleteAssetModal');
  const assetId = modal?.dataset.assetId || '';
  const password = document.getElementById('deleteAssetPassword')?.value || '';

  if (!assetId) {
    showNotification('error', 'Asset ID missing');
    return;
  }

  if (!password) {
    showNotification('warning', 'Enter your admin password');
    return;
  }

  try {
    const res = await apiCall(`/api/assets/${encodeURIComponent(assetId)}`, 'DELETE', { password });
    const data = res.data || {};

    closeModal('deleteAssetModal');
    closeModal('editAssetModal');

    let message = `Deleted asset ${assetId}`;
    if (data.eventsUpdated) message += `; removed from ${data.eventsUpdated} event(s)`;
    if (data.containersUpdated) message += `; removed from ${data.containersUpdated} container(s)`;
    showNotification('success', message);

    await loadInventory();
    if (document.getElementById('events-section')?.classList.contains('active')) {
      await loadAllEvents();
    }
    if (document.getElementById('prepare-section')?.classList.contains('active')) {
      await loadPrepareEvents();
    }
    if (document.getElementById('containers-section')?.classList.contains('active')) {
      await loadContainers();
    }
  } catch (error) {
    showNotification('error', `Failed to delete asset: ${error.message}`);
  }
}

function ensureBulkAssetDeleteModal() {
  if (document.getElementById('bulkAssetDeleteModal')) return;

  const modal = document.createElement('div');
  modal.id = 'bulkAssetDeleteModal';
  modal.className = 'modal';
  modal.innerHTML = `
    <div class="modal-content" style="max-width:520px;">
      <div class="modal-header">
        <h3 class="modal-title">Delete Selected Assets</h3>
        <button class="close-btn" onclick="closeModal('bulkAssetDeleteModal')">&times;</button>
      </div>
      <div class="modal-body">
        <div style="background:#f8d7da;border:1px solid #f5c2c7;color:#842029;padding:12px;border-radius:8px;margin-bottom:14px;">
          This permanently deletes the selected assets from inventory and removes them from any tagged events. Enter your admin password to confirm.
        </div>
        <div id="bulkDeleteAssetSummary" style="margin-bottom:14px;color:#495057;font-size:14px;"></div>
        <div class="form-group">
          <label class="form-label" for="bulkDeleteAssetPassword">Admin Password</label>
          <input id="bulkDeleteAssetPassword" type="password" class="form-input" autocomplete="current-password">
        </div>
      </div>
      <div class="modal-footer modal-actions" style="display:flex;gap:10px;justify-content:flex-end;margin-top:20px;">
        <button class="btn btn-secondary" onclick="closeModal('bulkAssetDeleteModal')">Cancel</button>
        <button class="btn btn-danger" onclick="confirmBulkAssetDelete()">Delete Selected</button>
      </div>
    </div>
  `;

  modal.addEventListener('click', (event) => {
    if (event.target === modal) closeModal('bulkAssetDeleteModal');
  });

  document.body.appendChild(modal);
}

function openBulkAssetDeleteModal() {
  if (!currentUser || !currentUser.isAdmin) {
    showNotification('error', 'Admin privileges required');
    return;
  }

  const selectedAssets = getSelectedInventoryAssets();
  if (!selectedAssets.length) {
    showNotification('warning', 'Select at least one asset');
    return;
  }

  ensureBulkAssetDeleteModal();
  document.getElementById('bulkDeleteAssetSummary').innerHTML = selectedInventoryAssetSummaryHtml(selectedAssets);
  document.getElementById('bulkDeleteAssetPassword').value = '';

  openModal('bulkAssetDeleteModal');
  setTimeout(() => document.getElementById('bulkDeleteAssetPassword')?.focus(), 100);
}

async function confirmBulkAssetDelete() {
  if (!currentUser || !currentUser.isAdmin) {
    showNotification('error', 'Admin privileges required');
    return;
  }

  const selectedAssets = getSelectedInventoryAssets();
  const assetIds = selectedAssets.map(inventoryAssetIdentifier).filter(Boolean);
  const password = document.getElementById('bulkDeleteAssetPassword')?.value || '';

  if (!assetIds.length) {
    showNotification('warning', 'Select at least one asset');
    return;
  }

  if (!password) {
    showNotification('warning', 'Enter your admin password');
    return;
  }

  try {
    const res = await apiCall('/api/assets/bulk-delete', 'DELETE', { assetIds, password });
    const data = res.data || {};
    const deletedCount = Number(data.deletedAssets?.length || 0);
    const missingCount = Number(data.missingAssetIds?.length || 0);

    closeModal('bulkAssetDeleteModal');

    let message = `Deleted ${deletedCount} selected asset${deletedCount === 1 ? '' : 's'}`;
    if (data.eventsUpdated) message += `; removed from ${data.eventsUpdated} event(s)`;
    if (data.containersUpdated) message += `; removed from ${data.containersUpdated} container(s)`;
    if (missingCount) message += `; ${missingCount} no longer found`;
    showNotification(missingCount ? 'warning' : 'success', message);

    selectedInventoryAssetIds.clear();
    await loadInventory();
    if (document.getElementById('events-section')?.classList.contains('active')) {
      await loadAllEvents();
    }
    if (document.getElementById('prepare-section')?.classList.contains('active')) {
      await loadPrepareEvents();
    }
    if (document.getElementById('containers-section')?.classList.contains('active')) {
      await loadContainers();
    }
  } catch (error) {
    showNotification('error', `Failed to delete selected assets: ${error.message}`);
  }
}

function ensureContainerUiStyles() {
  if (document.getElementById('container-ui-styles')) return;

  const style = document.createElement('style');
  style.id = 'container-ui-styles';
  style.textContent = `
    .containers-dashboard {
      display: flex;
      flex-direction: column;
      gap: 18px;
    }

    .container-hero {
      background: linear-gradient(135deg, rgba(102,126,234,0.12), rgba(118,75,162,0.12));
      border: 1px solid rgba(118,75,162,0.18);
      border-radius: 18px;
      padding: 20px;
    }

    .container-hero-title {
      font-size: 22px;
      font-weight: 800;
      color: #4b2f65;
      margin-bottom: 6px;
    }

    .container-hero-subtitle {
      color: #666;
      font-size: 14px;
    }

    .container-stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: 12px;
    }

    .container-stat-card {
      background: white;
      border: 1px solid #edf0f5;
      border-radius: 16px;
      padding: 16px;
      box-shadow: 0 6px 18px rgba(0,0,0,0.06);
    }

    .container-stat-value {
      font-size: 28px;
      font-weight: 800;
      color: #667eea;
      line-height: 1;
      margin-bottom: 6px;
    }

    .container-stat-label {
      color: #666;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: .7px;
    }

    .container-toolbar {
      background: white;
      border: 1px solid #edf0f5;
      border-radius: 16px;
      padding: 14px;
      display: grid;
      grid-template-columns: minmax(220px, 1fr) 180px auto;
      gap: 10px;
      align-items: center;
      box-shadow: 0 6px 18px rgba(0,0,0,0.05);
    }

    .container-search-input {
      width: 100%;
      border: 1px solid #dfe3ea;
      border-radius: 999px;
      padding: 11px 16px;
      font-size: 14px;
      outline: none;
    }

    .container-search-input:focus {
      border-color: #667eea;
      box-shadow: 0 0 0 3px rgba(102,126,234,0.12);
    }

    .container-sort-select {
      border: 1px solid #dfe3ea;
      border-radius: 999px;
      padding: 11px 14px;
      font-size: 14px;
      background: white;
      outline: none;
    }

    .container-cards-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(min(100%, 320px), 1fr));
      gap: 16px;
    }

    .container-card-modern {
      background: white;
      border: 1px solid #edf0f5;
      border-radius: 18px;
      padding: 18px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.07);
      transition: transform .18s ease, box-shadow .18s ease, border-color .18s ease;
    }

    .container-card-modern:hover {
      transform: translateY(-3px);
      box-shadow: 0 14px 34px rgba(0,0,0,0.11);
      border-color: rgba(102,126,234,0.35);
    }

    .container-card-top {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: flex-start;
      margin-bottom: 14px;
    }

    .container-id-badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font-size: 16px;
      font-weight: 800;
      color: #333;
      word-break: break-word;
    }

    .container-serial-text {
      margin-top: 4px;
      color: #666;
      font-size: 12px;
      font-weight: 600;
      word-break: break-word;
    }

    .container-count-pill {
      background: #eef1ff;
      color: #4f5edb;
      border-radius: 999px;
      padding: 5px 10px;
      font-size: 12px;
      font-weight: 700;
      white-space: nowrap;
    }

    .container-meta-row {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin: 10px 0 14px;
    }

    .container-meta-pill {
      background: #f8f9fb;
      border: 1px solid #edf0f5;
      color: #555;
      border-radius: 999px;
      padding: 5px 9px;
      font-size: 12px;
    }

    .container-preview-list {
      display: flex;
      flex-direction: column;
      gap: 7px;
      min-height: 42px;
      margin-bottom: 14px;
    }

    .container-preview-item {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      align-items: center;
      background: #fafbfc;
      border: 1px solid #edf0f5;
      border-radius: 10px;
      padding: 8px 10px;
      font-size: 13px;
    }

    .container-preview-main {
      min-width: 0;
    }

    .container-preview-id {
      font-weight: 700;
      color: #333;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .container-preview-desc {
      color: #777;
      font-size: 12px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      margin-top: 2px;
    }

    .container-card-actions {
      display: flex;
      gap: 8px;
      justify-content: flex-end;
      flex-wrap: wrap;
      border-top: 1px solid #f0f2f5;
      padding-top: 12px;
    }

    .container-empty-state {
      background: white;
      border: 1px dashed #ccd2dd;
      border-radius: 18px;
      padding: 40px;
      text-align: center;
      color: #666;
    }

    .container-modal-layout {
      display: grid;
      grid-template-columns: minmax(260px, 0.9fr) minmax(320px, 1.1fr);
      gap: 18px;
      align-items: start;
    }

    .container-panel {
      border: 1px solid #edf0f5;
      border-radius: 16px;
      padding: 14px;
      background: #fafbfc;
    }

    .container-panel.white {
      background: white;
    }

    .container-panel-title {
      font-size: 15px;
      font-weight: 800;
      color: #333;
      margin-bottom: 10px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
    }

    .selected-container-assets-grid {
      display: flex;
      flex-direction: column;
      gap: 8px;
      max-height: 330px;
      overflow-y: auto;
      padding-right: 4px;
    }

    .selected-container-chip {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      background: white;
      border: 1px solid #dfe8ff;
      border-left: 4px solid #667eea;
      border-radius: 12px;
      padding: 10px;
    }

    .selected-container-chip-id {
      font-weight: 800;
      color: #333;
      font-size: 13px;
    }

    .selected-container-chip-desc {
      color: #666;
      font-size: 12px;
      margin-top: 2px;
    }

    .selected-container-chip button {
      border: none;
      background: #fff0f0;
      color: #b42318;
      border-radius: 999px;
      width: 26px;
      height: 26px;
      cursor: pointer;
      font-weight: 800;
    }

    .container-search-result {
      padding: 12px;
      border-bottom: 1px solid #edf0f5;
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: center;
      cursor: pointer;
      transition: background .15s ease;
    }

    .container-search-result:hover {
      background: #f6f7ff;
    }

    .container-assets-table-wrap {
      max-height: 520px;
      overflow: auto;
      border: 1px solid #edf0f5;
      border-radius: 14px;
    }

    .container-assets-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }

    .container-assets-table th {
      position: sticky;
      top: 0;
      background: #f8f9fb;
      z-index: 1;
      text-align: left;
      padding: 10px;
      border-bottom: 1px solid #edf0f5;
      color: #555;
    }

    .container-assets-table td {
      padding: 10px;
      border-bottom: 1px solid #f0f2f5;
      vertical-align: top;
    }

    @media (max-width: 900px) {
      .container-toolbar {
        grid-template-columns: 1fr;
      }

      .container-modal-layout {
        grid-template-columns: 1fr;
      }
    }

    @media (max-width: 520px) {
      .container-hero,
      .container-stat-card,
      .container-card-modern,
      .container-panel {
        border-radius: 12px;
        padding: 14px;
      }

      .container-stats-grid {
        grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
      }

      .container-toolbar {
        padding: 12px;
      }

      .container-card-top,
      .container-search-result,
      .selected-container-chip {
        align-items: flex-start;
        flex-wrap: wrap;
      }

      .container-card-actions .btn {
        flex: 1 1 100%;
      }

      .container-assets-table {
        min-width: 620px;
      }
    }
  `;

  document.head.appendChild(style);
}

function getAssetFromCache(assetId) {
  if (!Array.isArray(assets)) return null;
  return assets.find(a => a.id === assetId) || null;
}

function getContainerStats(containerList) {
  const totalContainers = containerList.length;
  const totalAssets = containerList.reduce((sum, c) => sum + ((c.assetIds || []).length), 0);
  const largest = containerList.reduce((max, c) => Math.max(max, (c.assetIds || []).length), 0);

  const uniqueAssetIds = new Set();
  containerList.forEach(c => (c.assetIds || []).forEach(id => uniqueAssetIds.add(id)));

  return {
    totalContainers,
    totalAssets,
    uniqueAssets: uniqueAssetIds.size,
    largest
  };
}

function getContainerDepartments(container) {
  const counts = {};

  (container.assetIds || []).forEach(assetId => {
    const asset = getAssetFromCache(assetId);
    const dept = asset ? (asset.department || 'UN') : 'Unknown';
    counts[dept] = (counts[dept] || 0) + 1;
  });

  return counts;
}

function containerMatchesSearch(container, term) {
  if (!term) return true;

  const searchTextParts = [
    container.id,
    getContainerSerialNumber(container),
    ...(container.assetIds || [])
  ];

  (container.assetIds || []).forEach(assetId => {
    const asset = getAssetFromCache(assetId);
    if (asset) {
      searchTextParts.push(
        asset.brand,
        asset.model,
        asset.serial,
        asset.description,
        asset.department
      );
    }
  });

  return searchTextParts.join(' ').toLowerCase().includes(term.toLowerCase());
}

function sortContainerList(containerList, sortBy) {
  const list = [...containerList];

  if (sortBy === 'assets-desc') {
    return list.sort((a, b) => (b.assetIds || []).length - (a.assetIds || []).length);
  }

  if (sortBy === 'assets-asc') {
    return list.sort((a, b) => (a.assetIds || []).length - (b.assetIds || []).length);
  }

  return list.sort((a, b) => String(a.id || '').localeCompare(String(b.id || ''), undefined, {
    numeric: true,
    sensitivity: 'base'
  }));
}

function renderContainerPreview(container) {
  const assetIds = container.assetIds || [];

  if (assetIds.length === 0) {
    return `<div style="color:#777;font-size:13px;">No assets in this container.</div>`;
  }

  let html = '';

  assetIds.slice(0, 4).forEach(assetId => {
    const asset = getAssetFromCache(assetId);

    html += `
      <div class="container-preview-item">
        <div class="container-preview-main">
          <div class="container-preview-id">${escapeHtml(assetId)}</div>
          <div class="container-preview-desc">
            ${
              asset
                ? `${escapeHtml(asset.brand || '')} ${escapeHtml(asset.model || '')}${asset.serial ? ` • SN: ${escapeHtml(asset.serial)}` : ''}`
                : 'Asset not found in inventory'
            }
          </div>
        </div>
        ${
          asset
            ? `<span class="asset-badge dept-${escapeHtmlAttr((asset.department || 'un').toLowerCase())}">${escapeHtml(asset.department || 'UN')}</span>`
            : `<span class="asset-badge status-missing">Missing</span>`
        }
      </div>
    `;
  });

  if (assetIds.length > 4) {
    html += `
      <div style="color:#667eea;font-size:12px;font-weight:700;padding:2px 4px;">
        +${assetIds.length - 4} more asset(s)
      </div>
    `;
  }

  return html;
}

function renderContainerCards(containerList) {
  const root = document.getElementById('containerCardsGrid');
  const countLabel = document.getElementById('containerVisibleCount');
  if (!root) return;

  const searchTerm = document.getElementById('containerSearchInput')?.value.trim() || '';
  const sortBy = document.getElementById('containerSortSelect')?.value || 'id';

  const visible = sortContainerList(
    containerList.filter(c => containerMatchesSearch(c, searchTerm)),
    sortBy
  );

  if (countLabel) {
    countLabel.textContent = `${visible.length} of ${containerList.length} container(s)`;
  }

  if (visible.length === 0) {
    root.innerHTML = `
      <div class="container-empty-state" style="grid-column:1 / -1;">
        <div style="font-size:34px;margin-bottom:8px;">🔍</div>
        <div style="font-weight:800;color:#333;margin-bottom:4px;">No containers found</div>
        <div>Try a different container ID, asset ID, brand, model, serial number, or department.</div>
      </div>
    `;
    return;
  }

  root.innerHTML = visible.map(container => {
    const deptCounts = getContainerDepartments(container);
    const deptPills = Object.keys(deptCounts).sort().map(dept => {
      return `<span class="container-meta-pill">${escapeHtml(dept)}: ${deptCounts[dept]}</span>`;
    }).join('');

    const jsId = String(container.id).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const serialNumber = getContainerSerialNumber(container);

    return `
      <div class="container-card-modern">
        <div class="container-card-top">
          <div style="min-width:0;">
          <div class="container-id-badge">
            <span>📦</span>
            <span>${escapeHtml(container.id)}</span>
          </div>
          ${serialNumber ? `<div class="container-serial-text">SN: ${escapeHtml(serialNumber)}</div>` : ''}
          </div>
          <div class="container-count-pill">${(container.assetIds || []).length} asset(s)</div>
        </div>

        <div class="container-meta-row">
          ${deptPills || '<span class="container-meta-pill">No assets</span>'}
        </div>

        <div class="container-preview-list">
          ${renderContainerPreview(container)}
        </div>

        <div class="container-card-actions">
          <button class="btn btn-secondary btn-sm" onclick="viewContainer('${jsId}')">View</button>
          <button class="btn btn-primary btn-sm" onclick="editContainer('${jsId}')">Edit</button>
        </div>
      </div>
    `;
  }).join('');
}

function renderContainerAssetsTable(assetIds) {
  if (!assetIds || assetIds.length === 0) {
    return `<div style="padding:20px;text-align:center;color:#666;">No assets in this container.</div>`;
  }

  const rows = assetIds.map(assetId => {
    const asset = getAssetFromCache(assetId);

    if (!asset) {
      return `
        <tr>
          <td><strong>${escapeHtml(assetId)}</strong></td>
          <td colspan="5"><span class="asset-badge status-missing">Asset not found in inventory</span></td>
        </tr>
      `;
    }

    return `
      <tr>
        <td><strong>${escapeHtml(asset.id)}</strong></td>
        <td>${escapeHtml(asset.brand || '')}</td>
        <td>${escapeHtml(asset.model || '')}</td>
        <td>${escapeHtml(asset.serial || 'N/A')}</td>
        <td><span class="asset-badge dept-${escapeHtmlAttr((asset.department || 'un').toLowerCase())}">${escapeHtml(asset.department || 'UN')}</span></td>
        <td>${escapeHtml(asset.description || '')}</td>
      </tr>
    `;
  }).join('');

  return `
    <div class="container-assets-table-wrap">
      <table class="container-assets-table">
        <thead>
          <tr>
            <th>Asset ID</th>
            <th>Brand</th>
            <th>Model</th>
            <th>Serial</th>
            <th>Dept</th>
            <th>Description</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function makeContainerEditorHtml(mode, container = null) {
  const isEdit = mode === 'edit';
  const containerId = container ? container.id : '';
  const serialNumber = getContainerSerialNumber(container);
  const title = isEdit ? `Edit Container: ${escapeHtml(containerId)}` : 'Create New Container';

  return `
    <div class="container-modal-layout">
      <div class="container-panel white">
        <div class="container-panel-title">
          <span>${title}</span>
        </div>

        <div class="form-group">
          <label class="form-label">Container ID</label>
          <input
            id="${isEdit ? 'editContainerIdInput' : 'containerIdInput'}"
            class="form-input"
            value="${escapeHtmlAttr(containerId)}"
            placeholder="e.g. AX-RACK-01 / CASE-A01"
          >
          <div style="color:#666;font-size:12px;margin-top:6px;">
            Use a clear name that is easy to scan, like CASE-A01, RF-RACK, or LX-DISTRO-01.
          </div>
        </div>

        <div class="form-group">
          <label class="form-label">Serial Number <span style="color:#666;font-weight:400;">(optional)</span></label>
          <input
            id="${isEdit ? 'editContainerSerialInput' : 'containerSerialInput'}"
            class="form-input"
            value="${escapeHtmlAttr(serialNumber)}"
            placeholder="e.g. SN-CASE-A01"
          >
        </div>

        <div class="container-panel" style="margin-top:14px;">
          <div class="container-panel-title">
            <span>Selected Assets</span>
            <span class="container-count-pill"><span id="selectedContainerAssetsCount">0</span></span>
          </div>

          <div id="selectedContainerAssetsList" class="selected-container-assets-grid">
            <span style="color:#666;font-style:italic;">No assets selected</span>
          </div>

          <button class="btn btn-secondary btn-sm" onclick="clearContainerSelection()" style="margin-top:12px;">
            Clear Selection
          </button>
        </div>
      </div>

      <div class="container-panel white">
        <div class="container-panel-title">
          <span>Add Assets</span>
        </div>

        <input
          id="containerAssetSearch"
          class="container-search-input"
          placeholder="Loading assets…"
          disabled
        >

        <div style="color:#666;font-size:12px;margin:8px 0 12px;">
          Search by asset ID, brand, model, serial, description, or press Enter on a container ID/serial number to add all assets from that container.
        </div>

        <div
          id="availableContainerAssets"
          style="border:1px solid #edf0f5;border-radius:14px;overflow:auto;max-height:420px;background:white;"
        ></div>
      </div>
    </div>

    <div style="display:flex;gap:10px;justify-content:space-between;margin-top:18px;">
      ${
        isEdit
          ? `<button class="btn btn-danger" onclick="deleteContainer('${String(containerId).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}')">Delete Container</button>`
          : `<div></div>`
      }
      <div style="display:flex;gap:10px;">
        <button class="btn btn-secondary" onclick="closeModal('containerCrudModal')">Cancel</button>
        ${
          isEdit
            ? `<button class="btn btn-success" onclick="saveContainerEdit('${String(containerId).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}')">Save Changes</button>`
            : `<button class="btn btn-success" onclick="saveNewContainer()">Create Container</button>`
        }
      </div>
    </div>
  `;
}

async function loadContainers() {
  const root = document.getElementById("containers-list");
  if (!root) return;

  ensureContainerUiStyles();

  const headerBtn = document.querySelector('#containers-section .content-header button');
  if (headerBtn) {
    headerBtn.textContent = '+ New Container';
    headerBtn.className = 'btn btn-success';
    headerBtn.onclick = createContainer;
  }

  root.innerHTML = `
    <div class="containers-dashboard">
      <div class="container-hero">
        <div class="container-hero-title">Container Management</div>
        <div class="container-hero-subtitle">
          Create, view, and edit containers. Search by container ID, asset ID, brand, model, serial number, or department.
        </div>
      </div>

      <div class="container-stats-grid">
        <div class="container-stat-card">
          <div class="container-stat-value" id="containersTotalCount">0</div>
          <div class="container-stat-label">Containers</div>
        </div>
        <div class="container-stat-card">
          <div class="container-stat-value" id="containersAssetCount">0</div>
          <div class="container-stat-label">Asset References</div>
        </div>
        <div class="container-stat-card">
          <div class="container-stat-value" id="containersUniqueAssets">0</div>
          <div class="container-stat-label">Unique Assets</div>
        </div>
        <div class="container-stat-card">
          <div class="container-stat-value" id="containersLargestCount">0</div>
          <div class="container-stat-label">Largest Container</div>
        </div>
      </div>

      <div class="container-toolbar">
        <input
          id="containerSearchInput"
          class="container-search-input"
          placeholder="Search containers or contained assets..."
        >

        <select id="containerSortSelect" class="container-sort-select">
          <option value="id">Sort by Container ID</option>
          <option value="assets-desc">Most assets first</option>
          <option value="assets-asc">Fewest assets first</option>
        </select>

        <div id="containerVisibleCount" style="color:#666;font-size:13px;text-align:right;"></div>
      </div>

      <div id="containerCardsGrid" class="container-cards-grid">
        <div class="loading">Loading containers...</div>
      </div>
    </div>
  `;

  try {
    await ensureAssetsLoadedForContainerSelector(true);
    await refreshContainersCache(true);

    const cache = await refreshContainersCache(false);
    const list = Object.values(cache);

    containers = list;
    window.__containersList = list;

    const stats = getContainerStats(list);

    document.getElementById('containersTotalCount').textContent = stats.totalContainers;
    document.getElementById('containersAssetCount').textContent = stats.totalAssets;
    document.getElementById('containersUniqueAssets').textContent = stats.uniqueAssets;
    document.getElementById('containersLargestCount').textContent = stats.largest;

    document.getElementById('containerSearchInput')?.addEventListener('input', () => {
      renderContainerCards(window.__containersList || []);
    });

    document.getElementById('containerSortSelect')?.addEventListener('change', () => {
      renderContainerCards(window.__containersList || []);
    });

    if (list.length === 0) {
      document.getElementById('containerCardsGrid').innerHTML = `
        <div class="container-empty-state" style="grid-column:1 / -1;">
          <div style="font-size:38px;margin-bottom:8px;">📦</div>
          <div style="font-weight:800;color:#333;margin-bottom:4px;">No containers yet</div>
          <div style="margin-bottom:16px;">Create your first container to group assets like cases, racks, or kits.</div>
          <button class="btn btn-success" onclick="createContainer()">+ New Container</button>
        </div>
      `;
      document.getElementById('containerVisibleCount').textContent = '0 containers';
      return;
    }

    renderContainerCards(list);

  } catch (error) {
    root.innerHTML = `
      <div class="container-empty-state">
        <div style="font-size:34px;margin-bottom:8px;">⚠️</div>
        <div style="font-weight:800;color:#333;margin-bottom:4px;">Failed to load containers</div>
        <div style="color:#a00;margin-bottom:14px;">${escapeHtml(error.message || String(error))}</div>
        <button class="btn btn-primary" onclick="loadContainers()">Retry</button>
      </div>
    `;
  }
}

function ensureContainerCrudModal() {
  ensureContainerUiStyles();

  if (document.getElementById("containerCrudModal")) return;

  const modal = document.createElement("div");
  modal.id = "containerCrudModal";
  modal.className = "modal";

  modal.innerHTML = `
    <div class="modal-content" style="max-width:1100px;width:94%;">
      <div class="modal-header">
        <h3 id="containerCrudModalTitle" class="modal-title">Container</h3>
        <button class="close-btn" onclick="closeModal('containerCrudModal')">&times;</button>
      </div>
      <div id="containerCrudModalBody"></div>
    </div>
  `;

  modal.addEventListener('click', function(e) {
    if (e.target === modal) {
      closeModal('containerCrudModal');
    }
  });

  document.body.appendChild(modal);
}


// ---------------- Container Asset Selector ----------------

async function ensureAssetsLoadedForContainerSelector(force = false) {
  const looksValid =
    Array.isArray(assets) &&
    assets.length > 0 &&
    assets[0] &&
    typeof assets[0].id !== "undefined" &&
    typeof assets[0].brand !== "undefined" &&
    typeof assets[0].model !== "undefined";

  if (!force && looksValid) return true;

  try {
    const res = await apiCall("/api/assets");
    assets = (res && res.data) ? res.data : [];
    return Array.isArray(assets) && assets.length > 0;
  } catch (e) {
    console.error("Failed to load assets for container selector:", e);
    showNotification("error", "Assets not loaded yet. Please refresh the page.");
    return false;
  }
}

function updateSelectedContainerAssetsDisplay() {
  const countElement = document.getElementById('selectedContainerAssetsCount');
  const listElement = document.getElementById('selectedContainerAssetsList');
  if (!countElement || !listElement) return;

  countElement.textContent = selectedContainerAssets.size;

  if (selectedContainerAssets.size === 0) {
    listElement.innerHTML = '<span style="color:#666;font-style:italic;">No assets selected</span>';
    return;
  }

  let html = '';

  Array.from(selectedContainerAssets).forEach(assetId => {
    const asset = getAssetFromCache(assetId);

    html += `
      <div class="selected-container-chip">
        <div style="min-width:0;">
          <div class="selected-container-chip-id">${escapeHtml(assetId)}</div>
          <div class="selected-container-chip-desc">
            ${
              asset
                ? `${escapeHtml(asset.brand || '')} ${escapeHtml(asset.model || '')}${asset.serial ? ` • SN: ${escapeHtml(asset.serial)}` : ''}`
                : 'Asset not found in inventory'
            }
          </div>
        </div>

        <button onclick="removeAssetFromContainer('${escapeHtmlAttr(assetId)}')" title="Remove">&times;</button>
      </div>
    `;
  });

  listElement.innerHTML = html;
}

async function initContainerAssetSelector(initialAssetIds = []) {
  const resultsEl = document.getElementById("availableContainerAssets");
  const searchElInitial = document.getElementById("containerAssetSearch");

  if (searchElInitial) {
    searchElInitial.disabled = true;
    searchElInitial.placeholder = "Loading assets…";
  }
  if (resultsEl) {
    resultsEl.innerHTML =
      '<div style="padding:20px;text-align:center;color:#666;">Loading assets…</div>';
  }

  await ensureAssetsLoadedForContainerSelector(true);

  selectedContainerAssets = new Set(Array.isArray(initialAssetIds) ? initialAssetIds : []);
  updateSelectedContainerAssetsDisplay();

  const searchEl = bindContainerAssetSearchHandlers();

  if (searchEl) {
    searchEl.disabled = false;
    searchEl.placeholder = "Search by asset ID / brand / model / serial... (Press Enter for exact asset or container)";
  }

  if (resultsEl) {
    resultsEl.innerHTML =
      '<div style="padding:20px;text-align:center;color:#666;">Type at least 2 characters to search...</div>';
  }

  try { searchContainerAssets(); } catch (err) { console.error("Container search init failed:", err); }
}

let _containerAssetSearchAC = null;

function bindContainerAssetSearchHandlers() {
  const el = document.getElementById("containerAssetSearch");
  if (!el) return null;

  try { _containerAssetSearchAC?.abort(); } catch (_) {}
  _containerAssetSearchAC = new AbortController();
  const { signal } = _containerAssetSearchAC;

  let t = null;
  const scheduleSearch = () => {
    if (t) clearTimeout(t);
    t = setTimeout(() => {
      try {
        searchContainerAssets();
      } catch (err) {
        console.error("searchContainerAssets failed:", err);
        const results = document.getElementById("availableContainerAssets");
        if (results) {
          results.innerHTML =
            '<div style="padding:20px;text-align:center;color:#c00;">Search failed — check console.</div>';
        }
      }
    }, 50);
  };

  el.addEventListener("input", scheduleSearch, { signal });
  el.addEventListener("keyup", scheduleSearch, { signal });
  el.addEventListener("paste", scheduleSearch, { signal });
  el.addEventListener("change", scheduleSearch, { signal });

  // Enter adds an exact asset, asset serial, container ID, or container serial match.
  el.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Enter") return;
      Promise.resolve(handleContainerAssetSearchKeypress(e)).catch((err) => {
        console.error("handleContainerAssetSearchKeypress failed:", err);
      });
    },
    { signal }
  );

  scheduleSearch();

  return el;
}


function selectAssetForContainer(assetId) {
  if (!assetId) return;
  if (!Array.isArray(assets) || assets.length === 0) {
    showNotification('error', 'Assets not loaded');
    return;
  }

  const asset = assets.find(a => a.id === assetId);
  if (!asset) {
    showNotification('error', `Asset ${assetId} not found`);
    return;
  }
  if (asset.isBulk) {
    showNotification('warning', 'Bulk quantity assets cannot be added to containers');
    return;
  }

  if (selectedContainerAssets.has(assetId)) {
    showNotification('warning', `Asset ${assetId} is already selected`);
    return;
  }

  selectedContainerAssets.add(assetId);
  updateSelectedContainerAssetsDisplay();
  searchContainerAssets();

  showNotification('success', `Added ${assetId} to container`);
}

function removeAssetFromContainer(assetId) {
  selectedContainerAssets.delete(assetId);
  updateSelectedContainerAssetsDisplay();
  // refresh search results
  searchContainerAssets();
}

function clearContainerSelection() {
  selectedContainerAssets.clear();
  updateSelectedContainerAssetsDisplay();
  searchContainerAssets();
}

function handleContainerAssetSelectionClick(e) {
  const containerSelectBtn = e.target.closest && e.target.closest('.select-container-btn');
  if (containerSelectBtn) {
    e.preventDefault();
    e.stopPropagation();
    const assetId = containerSelectBtn.getAttribute('data-asset-id');
    if (assetId) selectAssetForContainer(assetId);
    return true;
  }

  const containerItem = e.target.closest && e.target.closest('.container-asset-item');
  if (containerItem) {
    const assetId = containerItem.getAttribute('data-asset-id');
    if (assetId) selectAssetForContainer(assetId);
    return true;
  }

  return false;
}

function searchContainerAssets() {
  const searchEl = document.getElementById('containerAssetSearch');
  const containerEl = document.getElementById('availableContainerAssets');
  if (!searchEl || !containerEl) return;

  const term = (searchEl.value || '').toLowerCase().trim();

  if (!term || term.length < 2) {
    containerEl.innerHTML = `
      <div style="padding:24px;text-align:center;color:#666;">
        <div style="font-size:28px;margin-bottom:6px;">🔎</div>
        Type at least 2 characters to search assets.
      </div>
    `;
    return;
  }

  if (!Array.isArray(assets) || assets.length === 0) {
    containerEl.innerHTML = '<div style="padding:20px;text-align:center;color:#666;">No assets loaded. Please refresh the page.</div>';
    return;
  }

  const filtered = assets.filter(asset => {
    const searchableText =
      `${asset.id} ${asset.brand} ${asset.model} ${asset.serial || ''} ${asset.description || ''} ${asset.department || ''}`
        .toLowerCase();

    return searchableText.includes(term) && !selectedContainerAssets.has(asset.id);
  });

  if (filtered.length === 0) {
    containerEl.innerHTML = `
      <div style="padding:24px;text-align:center;color:#666;">
        <div style="font-size:28px;margin-bottom:6px;">📭</div>
        No matching assets found.
      </div>
    `;
    return;
  }

  let html = '';

  filtered.slice(0, 60).forEach(asset => {
    const statusBadge = getAssetStatusBadge(asset);
    const locationText = asset.location || 'Store';

    html += `
      <div class="container-search-result container-asset-item" data-asset-id="${escapeHtmlAttr(asset.id)}">
        <div style="min-width:0;flex:1;">
          <div style="font-weight:800;color:#333;margin-bottom:3px;">${escapeHtml(asset.id)}</div>
          <div style="color:#555;font-size:13px;margin-bottom:2px;">
            ${escapeHtml(asset.brand || '')} ${escapeHtml(asset.model || '')}
            ${asset.serial ? `• SN: ${escapeHtml(asset.serial)}` : ''}
          </div>
          <div style="color:#888;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
            ${escapeHtml(asset.description || '')}
          </div>
          <div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap;align-items:center;">
            ${statusBadge}
            <span class="asset-badge dept-${escapeHtmlAttr((asset.department || 'un').toLowerCase())}">${escapeHtml(asset.department || 'UN')}</span>
            <span style="color:#999;font-size:11px;">📍 ${escapeHtml(locationText)}</span>
          </div>
        </div>

        <button type="button" class="btn btn-primary btn-sm select-container-btn" data-asset-id="${escapeHtmlAttr(asset.id)}">
          Add
        </button>
      </div>
    `;
  });

  if (filtered.length > 60) {
    html += `
      <div style="padding:10px 12px;color:#666;font-size:12px;text-align:center;background:#fafbfc;">
        Showing first 60 results. Type more to narrow your search.
      </div>
    `;
  }

  containerEl.innerHTML = html;
}

async function handleContainerAssetSearchKeypress(e) {
  if (e.key !== 'Enter') return;
  e.preventDefault();

  const searchTerm = (e.target.value || '').trim();
  if (!searchTerm) return;

  // load assets on demand
  await ensureAssetsLoadedForContainerSelector();
  if (!Array.isArray(assets) || assets.length === 0) return;

  // exact asset match first
  const asset = assets.find(a =>
    a.id.toLowerCase() === searchTerm.toLowerCase() ||
    (a.serial && a.serial.toLowerCase() === searchTerm.toLowerCase())
  );

  if (asset) {
    selectAssetForContainer(asset.id);
    e.target.value = '';
    return;
  }

  // container match (lets you type a container ID/serial and add all its assets)
  try {
    const container = await getContainerById(searchTerm, true);
    if (!container) {
      showNotification('error', `Asset/Container '${searchTerm}' not found`);
      return;
    }

    let added = 0;
    let already = 0;

    for (const aid of (container.assetIds || [])) {
      if (!selectedContainerAssets.has(aid)) {
        // only add if the asset exists in inventory
        if (assets.find(a => a.id === aid)) {
          selectedContainerAssets.add(aid);
          added++;
        }
      } else {
        already++;
      }
    }

    updateSelectedContainerAssetsDisplay();
    e.target.value = '';
    showNotification('success', `Added container ${container.id}: ${added} added (${already} already selected)`);
  } catch (err) {
    showNotification('error', `Failed to load container: ${err.message}`);
  }
}

async function createContainer() {
  ensureContainerCrudModal();

  document.getElementById("containerCrudModalTitle").textContent = "Create Container";
  document.getElementById("containerCrudModalBody").innerHTML = makeContainerEditorHtml('create');

  openModal("containerCrudModal");

  await initContainerAssetSelector([]);
  document.getElementById('containerAssetSearch')?.focus();
}

async function saveNewContainer() {
  const id = (document.getElementById("containerIdInput").value || '').trim();
  const serialNumber = (document.getElementById("containerSerialInput")?.value || '').trim();
  const assetIds = Array.from(selectedContainerAssets);

  if (!id) return showNotification('error', 'Container ID is required');
  if (assetIds.length === 0) return showNotification('error', 'Add at least 1 asset ID');

  try {
    await apiCall('/api/containers', 'POST', { id, serialNumber, assetIds });
    showNotification('success', `Created container ${id}`);
    closeModal("containerCrudModal");
    await refreshContainersCache(true);
    await loadContainers();
  } catch (e) {
    showNotification('error', `Failed to create container: ${e.message}`);
  }
}

async function viewContainer(containerId) {
  ensureContainerCrudModal();

  try {
    await ensureAssetsLoadedForContainerSelector(true);

    const c = await getContainerById(containerId, true);
    if (!c) return showNotification('error', `Container ${containerId} not found`);

    const deptCounts = getContainerDepartments(c);
    const deptPills = Object.keys(deptCounts).sort().map(dept => {
      return `<span class="container-meta-pill">${escapeHtml(dept)}: ${deptCounts[dept]}</span>`;
    }).join('');
    const serialNumber = getContainerSerialNumber(c);

    document.getElementById("containerCrudModalTitle").textContent = `Container: ${c.id}`;

    document.getElementById("containerCrudModalBody").innerHTML = `
      <div class="container-hero" style="margin-bottom:16px;">
        <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap;">
          <div>
            <div class="container-hero-title">📦 ${escapeHtml(c.id)}</div>
            <div class="container-hero-subtitle">
              ${(c.assetIds || []).length} asset(s) in this container${serialNumber ? ` • SN: ${escapeHtml(serialNumber)}` : ''}
            </div>
          </div>

          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <button class="btn btn-primary" onclick="editContainer('${String(c.id).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}')">Edit Container</button>
            <button class="btn btn-secondary" onclick="closeModal('containerCrudModal')">Close</button>
          </div>
        </div>

        <div class="container-meta-row" style="margin-bottom:0;">
          ${deptPills || '<span class="container-meta-pill">No department data</span>'}
        </div>
      </div>

      ${renderContainerAssetsTable(c.assetIds || [])}
    `;

    openModal("containerCrudModal");

  } catch (e) {
    showNotification('error', `Failed to load container: ${e.message}`);
  }
}

async function editContainer(containerId) {
  ensureContainerCrudModal();

  try {
    await ensureAssetsLoadedForContainerSelector(true);

    const c = await getContainerById(containerId, true);
    if (!c) return showNotification('error', `Container ${containerId} not found`);

    document.getElementById("containerCrudModalTitle").textContent = `Edit Container: ${c.id}`;
    document.getElementById("containerCrudModalBody").innerHTML = makeContainerEditorHtml('edit', c);

    openModal("containerCrudModal");

    await initContainerAssetSelector(c.assetIds || []);
    document.getElementById('containerAssetSearch')?.focus();

  } catch (e) {
    showNotification('error', `Failed to edit container: ${e.message}`);
  }
}

async function saveContainerEdit(containerId) {
  const newId = (document.getElementById('editContainerIdInput')?.value || '').trim();
  const serialNumber = (document.getElementById('editContainerSerialInput')?.value || '').trim();
  const assetIds = Array.from(selectedContainerAssets);

  if (!newId) return showNotification('error', 'Container ID is required');
  if (assetIds.length === 0) return showNotification('error', 'Container must include at least 1 asset ID');

  try {
    await apiCall(`/api/containers/${encodeURIComponent(containerId)}`, 'PUT', { newId, serialNumber, assetIds });
    if (newId !== containerId) {
      showNotification('success', `Renamed container ${containerId} → ${newId}`);
    } else {
      showNotification('success', `Updated container ${containerId}`);
    }
    closeModal("containerCrudModal");
    await refreshContainersCache(true);
    await loadContainers();
  } catch (e) {
    showNotification('error', `Failed to update container: ${e.message}`);
  }
} 

async function deleteContainer(containerId) {
  const confirmed = await showAppConfirm({
    title: 'Delete Container',
    message: `Delete container ${containerId}?`,
    confirmText: 'Delete',
    cancelText: 'Cancel',
    variant: 'danger',
  });
  if (!confirmed) return;

  try {
    await apiCall(`/api/containers/${encodeURIComponent(containerId)}`, 'DELETE');
    showNotification('success', `Deleted container ${containerId}`);
    closeModal("containerCrudModal");
    await refreshContainersCache(true);
    await loadContainers();
  } catch (e) {
    showNotification('error', `Failed to delete container: ${e.message}`);
  }
}

async function loadLogs() {
  try {
    const response = await apiCall("/api/logs");
    logs = response.data;

    const container = document.getElementById("logs-container");

    if (logs.length === 0) {
      container.innerHTML =
        '<p style="text-align: center; color: #666; padding: 40px;">No logs found.</p>';
      return;
    }

    let tableHTML = `
            <table class="table">
                <thead>
                    <tr>
                        <th>Timestamp</th>
                        <th>User</th>
                        <th>Action</th>
                    </tr>
                </thead>
                <tbody>
        `;

    logs.forEach((log) => {
      tableHTML += `
                <tr>
                    <td>${escapeHtml(log.timestamp)}</td>
                    <td>${escapeHtml(log.user)}</td>
                    <td>${escapeHtml(log.action)}</td>
                </tr>
            `;
    });

    tableHTML += "</tbody></table>";
    container.innerHTML = tableHTML;
  } catch (error) {
    document.getElementById("logs-container").innerHTML =
      '<p style="color: red; text-align: center;">Error loading logs</p>';
  }
}

function maintenanceReportAssetList() {
  return Array.isArray(assets) ? assets : [];
}

function maintenanceReportContainerList() {
  return Object.values(__containersCache || {}).filter(container => container && container.id);
}

function maintenanceReportSortIds(ids) {
  return Array.from(ids || []).sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' }));
}

function findMaintenanceReportAsset(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  return maintenanceReportAssetList().find(asset => {
    const candidates = [asset.id, asset.internalId, asset.bulkId, asset.displayId, asset.serial];
    return candidates.some(candidate => String(candidate || '').trim().toLowerCase() === raw);
  }) || null;
}

function findMaintenanceReportContainer(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  return maintenanceReportContainerList().find(container => {
    const candidates = [container.id, getContainerSerialNumber(container)];
    return candidates.some(candidate => String(candidate || '').trim().toLowerCase() === raw);
  }) || null;
}

function maintenanceReportContainerAssetIds(container) {
  return (container?.assetIds || [])
    .map(assetId => String(assetId || '').trim())
    .filter(Boolean);
}

function maintenanceReportSelectedAssetIdSet() {
  const selected = new Set();
  maintenanceReportSelectedAssetIds.forEach(assetId => {
    if (assetId) selected.add(String(assetId));
  });
  maintenanceReportSelectedContainerIds.forEach(containerId => {
    const container = findMaintenanceReportContainer(containerId);
    maintenanceReportContainerAssetIds(container).forEach(assetId => selected.add(assetId));
  });
  return selected;
}

function maintenanceReportSplitFilterTokens(value) {
  return String(value || '')
    .split(/[,\n;]+/)
    .map(token => token.trim())
    .filter(Boolean);
}

async function ensureMaintenanceReportContainersLoaded() {
  if (__containersCache) return true;
  try {
    await refreshContainersCache(true);
    return true;
  } catch (error) {
    console.warn('Failed to load containers for maintenance report filter:', error);
    return false;
  }
}

function renderMaintenanceReportAssetSelections() {
  const container = document.getElementById('maintenanceReportAssetSelections');
  if (!container) return;

  const selectedContainers = maintenanceReportSortIds(maintenanceReportSelectedContainerIds);
  const selectedAssets = maintenanceReportSortIds(maintenanceReportSelectedAssetIds);

  if (selectedContainers.length === 0 && selectedAssets.length === 0) {
    container.innerHTML = '<div class="maintenance-report-empty-filter">All assets</div>';
    return;
  }

  const containerChips = selectedContainers.map(containerId => {
    const selectedContainer = findMaintenanceReportContainer(containerId);
    const assetCount = maintenanceReportContainerAssetIds(selectedContainer).length;
    const label = assetCount ? `${containerId} (${assetCount})` : containerId;
    return `
      <div class="maintenance-report-chip container-chip" title="Container">
        <span>${escapeHtml(label)}</span>
        <button type="button" onclick="removeMaintenanceReportContainerFilter('${escapeHtmlAttr(encodeURIComponent(containerId))}')" aria-label="Remove ${escapeHtmlAttr(containerId)}">&times;</button>
      </div>
    `;
  });

  const assetChips = selectedAssets.map(assetId => `
    <div class="maintenance-report-chip asset-chip" title="Asset">
      <span>${escapeHtml(assetId)}</span>
      <button type="button" onclick="removeMaintenanceReportAssetFilter('${escapeHtmlAttr(encodeURIComponent(assetId))}')" aria-label="Remove ${escapeHtmlAttr(assetId)}">&times;</button>
    </div>
  `);

  container.innerHTML = [...containerChips, ...assetChips].join('');
}

function addMaintenanceReportAssetFilterValue(value, options = {}) {
  const tokens = maintenanceReportSplitFilterTokens(value);
  const showFeedback = options.showFeedback !== false;
  let addedAssets = 0;
  let addedContainers = 0;
  let alreadySelected = 0;
  const unknown = [];

  tokens.forEach(token => {
    const matchingContainer = findMaintenanceReportContainer(token);
    if (matchingContainer) {
      if (maintenanceReportSelectedContainerIds.has(matchingContainer.id)) {
        alreadySelected++;
      } else {
        maintenanceReportSelectedContainerIds.add(matchingContainer.id);
        addedContainers++;
      }
      return;
    }

    const matchingAsset = findMaintenanceReportAsset(token);
    if (matchingAsset) {
      const assetId = String(getAssetIdentifierForApi(matchingAsset) || matchingAsset.displayId || token);
      if (maintenanceReportSelectedAssetIds.has(assetId)) {
        alreadySelected++;
      } else {
        maintenanceReportSelectedAssetIds.add(assetId);
        addedAssets++;
      }
      return;
    }

    unknown.push(token);
  });

  renderMaintenanceReportAssetSelections();
  renderMaintenanceReportPreview();

  if (showFeedback) {
    if (unknown.length > 0) {
      showNotification('warning', `No asset or container found for: ${unknown.join(', ')}`);
    } else if (addedAssets > 0 || addedContainers > 0) {
      const parts = [];
      if (addedContainers > 0) parts.push(`${addedContainers} container${addedContainers === 1 ? '' : 's'}`);
      if (addedAssets > 0) parts.push(`${addedAssets} asset${addedAssets === 1 ? '' : 's'}`);
      showNotification('success', `Added ${parts.join(' and ')} to the report filter`);
    } else if (alreadySelected > 0) {
      showNotification('info', 'That filter is already selected');
    }
  }

  return { addedAssets, addedContainers, alreadySelected, unknown, tokenCount: tokens.length };
}

async function flushMaintenanceReportAssetInput(showFeedback = false) {
  const input = document.getElementById('maintenanceReportAssetFilter');
  const value = input?.value || '';
  if (!value.trim()) return null;

  await ensureMaintenanceReportContainersLoaded();
  const result = addMaintenanceReportAssetFilterValue(value, { showFeedback });
  const onlyUnknown = result.unknown.length === result.tokenCount && result.addedAssets === 0 && result.addedContainers === 0 && result.alreadySelected === 0;
  if (input && !onlyUnknown) input.value = '';
  return result;
}

async function addMaintenanceReportAssetFilterFromInput() {
  await flushMaintenanceReportAssetInput(true);
}

function removeMaintenanceReportAssetFilter(encodedAssetId) {
  const assetId = decodeURIComponent(encodedAssetId || '');
  maintenanceReportSelectedAssetIds.delete(assetId);
  renderMaintenanceReportAssetSelections();
  renderMaintenanceReportPreview();
}

function removeMaintenanceReportContainerFilter(encodedContainerId) {
  const containerId = decodeURIComponent(encodedContainerId || '');
  maintenanceReportSelectedContainerIds.delete(containerId);
  renderMaintenanceReportAssetSelections();
  renderMaintenanceReportPreview();
}

function getMaintenanceReportTypeCheckboxes() {
  return Array.from(document.querySelectorAll('#maintenanceReportTypeFilterMenu input[type="checkbox"]'));
}

function getSelectedMaintenanceReportTypes() {
  const checkboxes = getMaintenanceReportTypeCheckboxes();
  if (checkboxes.length === 0) return MAINTENANCE_LOG_TYPES.slice();
  return checkboxes
    .filter(checkbox => checkbox.checked)
    .map(checkbox => checkbox.value);
}

function syncMaintenanceReportTypeButton() {
  const button = document.getElementById('maintenanceReportTypeFilterButton');
  if (!button) return;

  const selectedTypes = getSelectedMaintenanceReportTypes();
  if (selectedTypes.length === 0) {
    button.textContent = 'No types selected';
  } else if (selectedTypes.length === MAINTENANCE_LOG_TYPES.length) {
    button.textContent = 'All types';
  } else if (selectedTypes.length === 1) {
    button.textContent = selectedTypes[0];
  } else {
    button.textContent = `${selectedTypes.length} types`;
  }
}

function populateMaintenanceReportTypeFilter() {
  const menu = document.getElementById('maintenanceReportTypeFilterMenu');
  if (!menu) return;

  const existingCheckboxes = getMaintenanceReportTypeCheckboxes();
  const selectedBefore = existingCheckboxes.length > 0
    ? new Set(existingCheckboxes.filter(checkbox => checkbox.checked).map(checkbox => checkbox.value))
    : new Set(MAINTENANCE_LOG_TYPES);

  const actionButtons = `
    <div class="maintenance-report-type-actions">
      <button type="button" onclick="setAllMaintenanceReportTypes(true)">Select all</button>
      <button type="button" onclick="setAllMaintenanceReportTypes(false)">Deselect all</button>
    </div>
  `;

  menu.innerHTML = actionButtons + MAINTENANCE_LOG_TYPES.map(type => `
    <label class="maintenance-report-type-option">
      <input type="checkbox" value="${escapeHtmlAttr(type)}"${selectedBefore.has(type) ? ' checked' : ''}>
      <span>${escapeHtml(type)}</span>
    </label>
  `).join('');

  syncMaintenanceReportTypeButton();
}

function setAllMaintenanceReportTypes(selected, { updatePreview = true } = {}) {
  getMaintenanceReportTypeCheckboxes().forEach(checkbox => {
    checkbox.checked = selected;
  });
  syncMaintenanceReportTypeButton();
  if (updatePreview) renderMaintenanceReportPreview();
}

function toggleMaintenanceReportTypeMenu() {
  const wrapper = document.getElementById('maintenanceReportTypeFilter');
  const button = document.getElementById('maintenanceReportTypeFilterButton');
  if (!wrapper) return;

  const isOpen = wrapper.classList.toggle('open');
  if (button) button.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
}

function closeMaintenanceReportTypeMenu() {
  const wrapper = document.getElementById('maintenanceReportTypeFilter');
  const button = document.getElementById('maintenanceReportTypeFilterButton');
  if (wrapper) wrapper.classList.remove('open');
  if (button) button.setAttribute('aria-expanded', 'false');
}

function parseMaintenanceReportDate(dateText) {
  const raw = String(dateText || '').trim();
  if (!raw) return null;
  const parts = raw.split(/[\/-]/).map(Number);
  if (parts.length !== 3 || parts.some(part => !Number.isFinite(part))) return null;
  const date = new Date(parts[0], parts[1] - 1, parts[2]);
  date.setHours(0, 0, 0, 0);
  return Number.isNaN(date.getTime()) ? null : date;
}

function maintenanceReportDateForDisplay(dateText) {
  const date = parseMaintenanceReportDate(dateText);
  if (!date) return String(dateText || '');
  return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function maintenanceReportAssetLocation(asset) {
  return String(
    asset?.location ||
    asset?.currentLocation ||
    asset?.defaultLocation ||
    'Store'
  ).trim() || 'Store';
}

function maintenanceReportRowLocation(asset, log) {
  const logLocation = getMaintenanceChangeValue(log, 'location');
  return String(logLocation || maintenanceReportAssetLocation(asset)).trim() || 'Store';
}

function getAllMaintenanceReportRows() {
  return (Array.isArray(assets) ? assets : []).flatMap(asset => {
    const assetId = asset.id || asset.internalId || asset.displayId || '';
    const records = getMaintenanceLogRecords(asset);
    return records.map((log, index) => {
      const dateObj = parseMaintenanceReportDate(log.date);
      return {
        assetId,
        asset,
        log,
        logIndex: index,
        dateObj,
        dateSort: dateObj ? dateObj.getTime() : 0,
        type: normalizeMaintenanceLogType(log.type),
        location: maintenanceReportRowLocation(asset, log),
        changes: getMaintenanceChangeLabels(log.changes)
      };
    });
  });
}

function getMaintenanceReportFilters() {
  const startDate = parseMaintenanceReportDate(document.getElementById('maintenanceReportStartDate')?.value);
  const endDate = parseMaintenanceReportDate(document.getElementById('maintenanceReportEndDate')?.value);
  const selectedAssetIds = maintenanceReportSelectedAssetIdSet();
  const selectedTypes = getSelectedMaintenanceReportTypes();

  return {
    startDate,
    endDate,
    assetIds: Array.from(selectedAssetIds).map(value => String(value || '').toLowerCase()),
    user: document.getElementById('maintenanceReportUserFilter')?.value || '',
    location: document.getElementById('maintenanceReportLocationFilter')?.value || '',
    types: selectedTypes,
    noTypesSelected: selectedTypes.length === 0,
    typeFilterActive: selectedTypes.length > 0 && selectedTypes.length < MAINTENANCE_LOG_TYPES.length
  };
}

function getFilteredMaintenanceReportRows() {
  const filters = getMaintenanceReportFilters();
  return getAllMaintenanceReportRows()
    .filter(row => {
      if (filters.startDate && (!row.dateObj || row.dateObj < filters.startDate)) return false;
      if (filters.endDate && (!row.dateObj || row.dateObj > filters.endDate)) return false;
      if (filters.assetIds.length > 0) {
        const rowAssetId = String(row.assetId || '').toLowerCase();
        if (!filters.assetIds.includes(rowAssetId)) return false;
      }
      if (filters.user && row.log.user !== filters.user) return false;
      if (filters.location && row.location !== filters.location) return false;
      if (filters.noTypesSelected) return false;
      if (filters.typeFilterActive && !filters.types.includes(row.type)) return false;
      return true;
    })
    .sort((a, b) => {
      if (b.dateSort !== a.dateSort) return b.dateSort - a.dateSort;
      return String(a.assetId || '').localeCompare(String(b.assetId || ''), undefined, { numeric: true });
    });
}

function populateMaintenanceReportFilters() {
  const rows = getAllMaintenanceReportRows();
  const users = Array.from(new Set(rows.map(row => row.log.user).filter(Boolean))).sort((a, b) => a.localeCompare(b));
  const userSelect = document.getElementById('maintenanceReportUserFilter');
  if (userSelect) {
    const selected = userSelect.value;
    userSelect.innerHTML = '<option value="">All users</option>' + users.map(user => (
      `<option value="${escapeHtmlAttr(user)}"${user === selected ? ' selected' : ''}>${escapeHtml(user)}</option>`
    )).join('');
  }

  const locations = Array.from(new Set(rows.map(row => row.location).filter(Boolean))).sort((a, b) => a.localeCompare(b));
  const locationSelect = document.getElementById('maintenanceReportLocationFilter');
  if (locationSelect) {
    const selected = locationSelect.value;
    locationSelect.innerHTML = '<option value="">All locations</option>' + locations.map(location => (
      `<option value="${escapeHtmlAttr(location)}"${location === selected ? ' selected' : ''}>${escapeHtml(location)}</option>`
    )).join('');
  }

  const datalist = document.getElementById('maintenanceReportAssetOptions');
  if (datalist) {
    const assetOptions = (Array.isArray(assets) ? assets : [])
      .map(asset => asset.id || asset.internalId || asset.displayId || '')
      .filter(Boolean)
      .sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }))
      .map(assetId => `<option value="${escapeHtmlAttr(assetId)}" label="Asset"></option>`);

    const containerOptions = maintenanceReportContainerList()
      .sort((a, b) => String(a.id || '').localeCompare(String(b.id || ''), undefined, { numeric: true }))
      .flatMap(container => {
        const containerId = container.id || '';
        if (!containerId) return [];

        const serialNumber = getContainerSerialNumber(container);
        const count = maintenanceReportContainerAssetIds(container).length;
        const label = `Container${count ? ` (${count} assets)` : ''}`;
        const options = [
          `<option value="${escapeHtmlAttr(containerId)}" label="${escapeHtmlAttr(label)}"></option>`
        ];

        if (serialNumber) {
          options.push(
            `<option value="${escapeHtmlAttr(serialNumber)}" label="${escapeHtmlAttr(label)} - ${escapeHtmlAttr(containerId)}"></option>`
          );
        }

        return options;
      });

    datalist.innerHTML = [...containerOptions, ...assetOptions].join('');
  }

  populateMaintenanceReportTypeFilter();
  renderMaintenanceReportAssetSelections();
}

function renderMaintenanceReportPreview() {
  const rows = getFilteredMaintenanceReportRows();
  const previewText = document.getElementById('maintenanceReportPreview');
  if (previewText) {
    previewText.textContent = `${rows.length} maintenance log${rows.length === 1 ? '' : 's'} selected`;
  }

  const container = document.getElementById('maintenance-report-preview');
  if (!container) return;

  if (rows.length === 0) {
    container.innerHTML = '<p style="text-align:center;color:#666;padding:30px;">No maintenance records match the selected filters.</p>';
    return;
  }

  const previewRows = rows.slice(0, 60);
  container.innerHTML = `
    <table class="table">
      <thead>
        <tr>
          <th>Date</th>
          <th>Asset ID</th>
          <th>Location</th>
          <th>Type</th>
          <th>User</th>
          <th>Description</th>
          <th>Cost</th>
        </tr>
      </thead>
      <tbody>
        ${previewRows.map(row => `
          <tr>
            <td>${escapeHtml(maintenanceReportDateForDisplay(row.log.date))}</td>
            <td>${escapeHtml(row.assetId)}</td>
            <td>${escapeHtml(row.location)}</td>
            <td>${maintenanceLogTypeBadgeHtml(row.type)}</td>
            <td>${escapeHtml(row.log.user)}</td>
            <td>${escapeHtml(row.log.description)}</td>
            <td>${maintenanceCostDisplayHtml(row.log.cost)}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
    ${rows.length > previewRows.length ? `<div style="color:#666;font-size:13px;margin-top:8px;">Showing first ${previewRows.length} records in preview.</div>` : ''}
  `;
}

function bindMaintenanceReportFilters() {
  [
    'maintenanceReportStartDate',
    'maintenanceReportEndDate',
    'maintenanceReportUserFilter',
    'maintenanceReportLocationFilter'
  ].forEach(id => {
    const element = document.getElementById(id);
    if (!element || element.dataset.reportBound === 'true') return;
    element.dataset.reportBound = 'true';
    element.addEventListener('input', renderMaintenanceReportPreview);
    element.addEventListener('change', renderMaintenanceReportPreview);
  });

  const assetInput = document.getElementById('maintenanceReportAssetFilter');
  if (assetInput && assetInput.dataset.reportBound !== 'true') {
    assetInput.dataset.reportBound = 'true';
    assetInput.addEventListener('keydown', event => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      addMaintenanceReportAssetFilterFromInput();
    });
  }

  const typeMenu = document.getElementById('maintenanceReportTypeFilterMenu');
  if (typeMenu && typeMenu.dataset.reportBound !== 'true') {
    typeMenu.dataset.reportBound = 'true';
    typeMenu.addEventListener('change', event => {
      if (!event.target || event.target.type !== 'checkbox') return;
      syncMaintenanceReportTypeButton();
      renderMaintenanceReportPreview();
    });
  }

  if (!__maintenanceReportOutsideClickBound) {
    __maintenanceReportOutsideClickBound = true;
    document.addEventListener('click', event => {
      const wrapper = document.getElementById('maintenanceReportTypeFilter');
      if (!wrapper || wrapper.contains(event.target)) return;
      closeMaintenanceReportTypeMenu();
    });
  }
}

async function loadMaintenanceReportSection() {
  try {
    const response = await apiCall('/api/assets');
    assets = response.data || [];
    try {
      await refreshContainersCache(true);
    } catch (containerError) {
      console.warn('Maintenance report container filter unavailable:', containerError);
    }
    populateMaintenanceReportFilters();
    bindMaintenanceReportFilters();
    renderMaintenanceReportPreview();
  } catch (error) {
    const container = document.getElementById('maintenance-report-preview');
    if (container) {
      container.innerHTML = '<p style="color:red;text-align:center;">Error loading maintenance records</p>';
    }
  }
}

function clearMaintenanceReportFilters() {
  ['maintenanceReportStartDate', 'maintenanceReportEndDate', 'maintenanceReportAssetFilter'].forEach(id => {
    const element = document.getElementById(id);
    if (element) element.value = '';
  });
  const user = document.getElementById('maintenanceReportUserFilter');
  const location = document.getElementById('maintenanceReportLocationFilter');
  if (user) user.value = '';
  if (location) location.value = '';
  maintenanceReportSelectedAssetIds.clear();
  maintenanceReportSelectedContainerIds.clear();
  setAllMaintenanceReportTypes(true, { updatePreview: false });
  closeMaintenanceReportTypeMenu();
  renderMaintenanceReportAssetSelections();
  renderMaintenanceReportPreview();
}

function maintenanceReportTableHead() {
  return `
    <colgroup>
      <col style="width:8%;">
      <col style="width:11%;">
      <col style="width:15%;">
      <col style="width:12%;">
      <col style="width:9%;">
      <col style="width:9%;">
      <col style="width:22%;">
      <col style="width:6%;">
      <col style="width:8%;">
    </colgroup>
    <thead>
      <tr>
        <th>Date</th>
        <th>Asset ID</th>
        <th>Asset</th>
        <th>Location</th>
        <th>Type</th>
        <th>User</th>
        <th>Description</th>
        <th>Cost</th>
        <th>Changes</th>
      </tr>
    </thead>
  `;
}

function maintenanceReportRowHtml(row, rowNumber) {
  const safe = value => escapeHtml(String(value ?? ''));
  const assetText = [row.asset?.brand, row.asset?.model, row.asset?.description]
    .filter(Boolean)
    .join(' ');
  const changesText = row.changes.length ? row.changes.map(maintenanceChangePdfHtml).join('') : '-';
  return `
    <tr>
      <td>${safe(maintenanceReportDateForDisplay(row.log.date))}</td>
      <td><strong>${safe(row.assetId)}</strong></td>
      <td>${safe(assetText || '-')}</td>
      <td>${safe(row.location || '-')}</td>
      <td>${maintenanceLogTypePdfBadgeHtml(row.type)}</td>
      <td>${safe(row.log.user)}</td>
      <td>${safe(row.log.description)}</td>
      <td>${maintenanceCostDisplayHtml(row.log.cost)}</td>
      <td>${changesText}</td>
    </tr>
  `;
}

function localDateStamp() {
  const now = new Date();
  const pad = value => String(value).padStart(2, '0');
  return {
    date: now.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }),
    number: `MR-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
  };
}

function maintenanceReportFilterSummary(rows) {
  const start = document.getElementById('maintenanceReportStartDate')?.value || '';
  const end = document.getElementById('maintenanceReportEndDate')?.value || '';
  const user = document.getElementById('maintenanceReportUserFilter')?.value || '';
  const location = document.getElementById('maintenanceReportLocationFilter')?.value || '';
  const selectedTypes = getSelectedMaintenanceReportTypes();
  const parts = [];
  const compactList = (values, max = 5) => {
    const list = maintenanceReportSortIds(values);
    if (list.length <= max) return list.join(', ');
    return `${list.slice(0, max).join(', ')} +${list.length - max} more`;
  };

  if (start || end) parts.push(`Date range: ${start || 'All'} to ${end || 'All'}`);
  if (maintenanceReportSelectedContainerIds.size > 0) {
    parts.push(`Containers: ${compactList(maintenanceReportSelectedContainerIds)}`);
  }
  if (maintenanceReportSelectedAssetIds.size > 0) {
    parts.push(`Assets: ${compactList(maintenanceReportSelectedAssetIds)}`);
  }
  if (user) parts.push(`User: ${user}`);
  if (location) parts.push(`Location: ${location}`);
  if (selectedTypes.length === 0) {
    parts.push('Report types: None selected');
  } else if (selectedTypes.length < MAINTENANCE_LOG_TYPES.length) {
    parts.push(`Report types: ${compactList(selectedTypes, 4)}`);
  }
  if (parts.length === 0) parts.push('All maintenance logs, all time');
  parts.push(`Records: ${rows.length}`);
  return parts;
}

function buildMaintenanceReportPdfPages(rows, context) {
  const safe = value => escapeHtml(String(value ?? ''));
  const logoUrl = escapeHtmlAttr(getPdfLogoUrl());
  const footerHtml = renderPdfFooterHtml();

  const headerHtml = `
    <div class="logo-row"><img src="${logoUrl}" alt="Company Logo"></div>
    <div class="header">
      <div class="header-left">
        GENERATED BY:<br>
        ${safe(context.generatedBy)}<br><br>
        FILTERS:<br>
        ${context.filterSummary.map(safe).join('<br>')}
      </div>
      <div class="header-right">
        <div class="report-title">MAINTENANCE REPORT</div>
        No. : ${safe(context.reportNumber)}<br>
        Date : ${safe(context.formattedDate)}
      </div>
    </div>
  `;

  const rowRecords = rows.length
    ? rows.map((row, index) => ({ html: maintenanceReportRowHtml(row, index + 1), height: 0 }))
    : [{ html: '<tr><td colspan="9" style="text-align:center;color:#666;padding:18px;">No maintenance records match the selected filters.</td></tr>', height: 0 }];

  const measureBox = document.createElement('div');
  measureBox.id = '__maintenanceReportMeasureBox';
  measureBox.style.cssText = `
    position:absolute;
    left:-10000px;
    top:0;
    visibility:hidden;
    width:196mm;
    font-family:'Century Gothic', Arial, sans-serif;
    font-size:7.6pt;
    line-height:1.25;
    background:white;
    z-index:-1;
  `;

  measureBox.innerHTML = `
    <style>
      #__maintenanceReportMeasureBox * { box-sizing: border-box; }
      #__maintenanceReportMeasureBox .logo-row { display:flex; justify-content:flex-end; margin-bottom:7px; height:39px; }
      #__maintenanceReportMeasureBox .logo-row img { height:39px; width:auto; object-fit:contain; }
      #__maintenanceReportMeasureBox .header { display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:18px; }
      #__maintenanceReportMeasureBox .header-left { flex:1; font-size:9pt; font-weight:bold; line-height:1.35; }
      #__maintenanceReportMeasureBox .header-right { text-align:right; font-size:9pt; font-weight:bold; }
      #__maintenanceReportMeasureBox .report-title { font-size:14pt; font-weight:bold; margin-bottom:5px; }
      #__maintenanceReportMeasureBox .items-table { width:100%; border-collapse:collapse; border:2px solid black; margin-bottom:0; table-layout:fixed; }
      #__maintenanceReportMeasureBox .items-table th { background:#333; color:white; padding:6px; text-align:left; font-size:7.8pt; border:1px solid #333; }
      #__maintenanceReportMeasureBox .items-table td { border:1px solid #333; padding:5px; font-size:7.6pt; vertical-align:top; line-height:1.25; word-break:break-word; overflow-wrap:anywhere; }
      #__maintenanceReportMeasureBox .items-table td > span { max-width:100%; white-space:normal !important; overflow-wrap:anywhere; }
      #__maintenanceReportMeasureBox .footer-measure { width:100%; text-align:center; font-size:7pt; font-weight:bold; line-height:1.2; overflow-wrap:anywhere; }
    </style>
    <div id="__maintenanceReportBase">
      ${headerHtml}
      <table class="items-table">${maintenanceReportTableHead()}</table>
    </div>
    <table class="items-table">
      ${maintenanceReportTableHead()}
      <tbody id="__maintenanceReportMeasureBody"></tbody>
    </table>
    <div id="__maintenanceReportFooterMeasure" class="footer-measure">${footerHtml}</div>
  `;

  const normaliseMeasuredHeight = mountPdfMeasureBox(measureBox, 196);

  const measureBody = measureBox.querySelector('#__maintenanceReportMeasureBody');
  const baseHeight = normaliseMeasuredHeight(
    measureBox.querySelector('#__maintenanceReportBase').getBoundingClientRect().height
  );
  const footerHeight = normaliseMeasuredHeight(
    measureBox.querySelector('#__maintenanceReportFooterMeasure')?.getBoundingClientRect().height || 0
  );
  const pageFlowHeightMm = 276;
  const footerReserveMm = pdfFooterReserveMm({ pageFlowHeightMm }, footerHeight);
  const rowBudget = Math.max(40, pdfMmToPx(pageFlowHeightMm - footerReserveMm) - baseHeight);

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
    const pageRows = [];
    let pageHeight = 0;
    while (index < rowRecords.length) {
      const record = rowRecords[index];
      if (pageRows.length > 0 && pageHeight + record.height > rowBudget) break;
      pageRows.push(record);
      pageHeight += record.height;
      index++;
      if (pageRows.length === 1 && record.height > rowBudget) break;
    }
    pages.push(pageRows);
  }

  const totalPages = pages.length;
  return pages.map((pageRows, pageIndex) => `
    <div class="page">
      ${headerHtml}
      <table class="items-table">
        ${maintenanceReportTableHead()}
        <tbody>
          ${pageRows.map(row => row.html).join('')}
        </tbody>
      </table>
      <div class="footer">${footerHtml}</div>
      <div class="page-number">Page ${pageIndex + 1} of ${totalPages}</div>
    </div>
  `).join('');
}

async function generateMaintenanceReportPdf() {
  try {
    const response = await apiCall('/api/assets');
    assets = response.data || [];
    try {
      await refreshContainersCache(true);
    } catch (containerError) {
      console.warn('Maintenance report container filter unavailable:', containerError);
    }
    const pendingAssetFilter = await flushMaintenanceReportAssetInput(true);
    if (
      pendingAssetFilter &&
      pendingAssetFilter.unknown.length === pendingAssetFilter.tokenCount &&
      pendingAssetFilter.addedAssets === 0 &&
      pendingAssetFilter.addedContainers === 0 &&
      pendingAssetFilter.alreadySelected === 0
    ) {
      return;
    }

    const rows = getFilteredMaintenanceReportRows();
    await loadPdfSettings(true);
    const stamp = localDateStamp();
    const pagesHtml = buildMaintenanceReportPdfPages(rows, {
      generatedBy: currentUser?.username || '',
      reportNumber: stamp.number,
      formattedDate: stamp.date,
      filterSummary: maintenanceReportFilterSummary(rows)
    });

    const win = window.open('', '_blank', 'width=900,height=1000');
    if (!win) {
      showNotification('error', 'Pop-up blocked. Please allow pop-ups to export the maintenance report PDF.');
      return;
    }

    const html = `<!DOCTYPE html><html><head><title>Maintenance Report</title><style>
      @page { size: A4; margin: 0; }
      * { box-sizing: border-box; }
      body { margin: 0; font-family: 'Century Gothic', Arial, sans-serif; color: #000; background: #f0f0f0; }
      .page { width: 210mm; height: 297mm; min-height: 297mm; margin: 0 auto 12px auto; padding: 7mm 7mm 14mm 7mm; background: white; position: relative; overflow: hidden; page-break-after: always; break-after: page; }
      .page:last-child { page-break-after: auto; break-after: auto; }
      .logo-row { display:flex; justify-content:flex-end; margin-bottom:7px; height:39px; }
      .logo-row img { height:39px; width:auto; object-fit:contain; }
      .header { display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:18px; }
      .header-left { flex:1; font-size:9pt; font-weight:bold; line-height:1.35; }
      .header-right { text-align:right; font-size:9pt; font-weight:bold; }
      .report-title { font-size:14pt; font-weight:bold; margin-bottom:5px; }
      .items-table { width:100%; border-collapse:collapse; border:2px solid black; margin-bottom:0; table-layout:fixed; }
      .items-table th { background:#333; color:white; padding:6px; text-align:left; font-size:7.8pt; border:1px solid #333; }
      .items-table td { border:1px solid #333; padding:5px; font-size:7.6pt; vertical-align:top; line-height:1.25; word-break:break-word; overflow-wrap:anywhere; }
      .items-table td > span { max-width:100%; white-space:normal !important; overflow-wrap:anywhere; }
      .footer { position:absolute; bottom:7mm; left:7mm; right:7mm; text-align:center; font-size:7pt; font-weight:bold; line-height:1.2; overflow-wrap:anywhere; }
      .page-number { position:absolute; bottom:3mm; right:7mm; font-size:7pt; }
      .print-btn { position:fixed; top:20px; right:20px; background:#667eea; color:white; border:none; padding:10px 18px; border-radius:6px; cursor:pointer; z-index:999; }
      @media print { body, body * { -webkit-print-color-adjust:exact; print-color-adjust:exact; } body { background:white; } .page { margin:0; page-break-after:always; break-after:page; } .page:last-child { page-break-after:auto; break-after:auto; } .print-btn { display:none; } }
    </style></head><body><button class="print-btn" onclick="window.print()">Print / Save as PDF</button>${pagesHtml}</body></html>`;
    win.document.write(html);
    win.document.close();
    win.focus();
    showNotification('success', 'Maintenance report PDF generated successfully');
  } catch (error) {
    showNotification('error', `Failed to generate maintenance report: ${error.message}`);
  }
}


function createPrepareEventCard(event) {
  const card = document.createElement("div");
  card.className = `event-card ${getEventStateClass(event.state)}`;

  // Helper function to escape HTML
  const escapeHtml = (str) => {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  };

  const dateRange =
    event.startDate === event.endDate
      ? formatDate(event.startDate)
      : `${formatDate(event.startDate)} - ${formatDate(event.endDate)}`;

  // Calculate overall preparation progress from model groups
  let totalRequired = 0;
  let totalAssigned = 0;
  let modelSummary = "";

  if (event.modelGroups && Object.keys(event.modelGroups).length > 0) {
    const models = Object.values(event.modelGroups);

    models.forEach((model) => {
      totalRequired += model.requiredQuantity;
      totalAssigned += getCountablePreparedQuantity(model);
    });

    // Show first 2 models as preview
    modelSummary =
      '<div style="margin: 10px 0; font-size: 12px; color: #666;">';
    models.slice(0, 2).forEach((model) => {
      const statusIcon = getModelStatusIcon(model.status);
      const assignedCount = getPreparedQuantity(model);
      modelSummary += `<div>${statusIcon} ${model.requiredQuantity}x ${escapeHtml(model.brand)} ${escapeHtml(model.model)} (${assignedCount}/${model.requiredQuantity})</div>`;
    });

    if (models.length > 2) {
      modelSummary += `<div style="font-style: italic;">... and ${
        models.length - 2
      } more</div>`;
    }
    modelSummary += "</div>";
  } else {
    // Fall back to using the event's asset counts for events without model groups (like custom assets only)
    totalRequired = event.assetCount || 0;
    totalAssigned = event.preparedCount || 0;
  }

  const progressPercent =
    totalRequired > 0 ? Math.round((totalAssigned / totalRequired) * 100) : 0;

    card.innerHTML = `
        <div class="event-header">
            <div style="display: flex; align-items: center; gap: 8px;">
                <div class="event-id">ID: ${event.id}</div>
                <span style="padding: 2px 8px; border-radius: 12px; font-size: 10px; font-weight: bold; ${event.tag === 'dry hire' ? 'background: #17a2b8; color: white;' : 'background: #28a745; color: white;'}">
                    ${event.tag === 'dry hire' ? 'DRY HIRE' : 'EVENT'}
                </span>
            </div>
            <div class="event-state ${getEventStateClass(event.state)}">${escapeHtml(event.state)}</div>
        </div>
        <div class="event-title">${escapeHtml(event.name)}</div>
        <div class="event-date">${escapeHtml(dateRange)}</div>
        ${modelSummary}
        <div style="margin: 15px 0;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                <small style="color: #666;">Preparation Progress</small>
                <small style="color: #666;">${totalAssigned}/${totalRequired} assets</small>
            </div>
            <div style="background: #e9ecef; border-radius: 10px; height: 6px; overflow: hidden;">
                <div style="background: #28a745; height: 100%; width: ${progressPercent}%; transition: width 0.3s ease;"></div>
            </div>
        </div>
        <div class="event-actions">
            <button class="btn btn-success" onclick="openPrepareEventModal(${event.id})">Prepare Assets</button>
            <button class="btn btn-primary" onclick="viewEvent(${event.id})">View Details</button>
        </div>
    `;

  return card;
}

async function openPrepareEventModal(eventId) {
    try {
        window.currentPrepareEventId = eventId;
        ensurePrepareQuickAddToggleStyles();
        const [eventResponse, availableAssetsResponse] = await Promise.all([
            apiCall(`/api/events/${eventId}`),
            apiCall(`/api/assets/available-for-event/${eventId}`)
        ]);
        
        const event = eventResponse.data;
        const availableAssets = availableAssetsResponse.data;
        const quickAddEnabled = getPrepareQuickAddEnabled();
        window.__currentPrepareEventData = event;
        
        document.getElementById('prepareEventTitle').textContent = `Prepare Assets - Event ${event.id}: ${event.name}`;
        
        let content = `
            <div class="prepare-event-interface">
                <!-- Event Summary -->
                <div style="background: #f8f9fa; padding: 15px; border-radius: 8px; margin-bottom: 20px;">
                    <h4 style="margin-bottom: 10px; color: #495057;">Event Summary</h4>
                    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 10px; text-align: center;">
                        <div>
                            <div id="prepare-required-count" style="font-size: 20px; font-weight: bold; color: #007bff;">${event.totalAssets}</div>
                            <div style="color: #666; font-size: 12px;">Required</div>
                        </div>
                        <div>
                            <div id="prepare-prepared-count" style="font-size: 20px; font-weight: bold; color: #28a745;">${event.totalPrepared}</div>
                            <div style="color: #666; font-size: 12px;">Prepared</div>
                        </div>
                        <div>
                            <div id="prepare-extra-count" style="font-size: 20px; font-weight: bold; color: #6c757d;">${getEventExtraQuantity(event)}</div>
                            <div style="color: #666; font-size: 12px;">Extra</div>
                        </div>
                    </div>
                </div>

                <!-- Quick Asset Search Bar -->
                <div style="margin-bottom: 10px; padding: 10px; background: #e8f5e8; border-radius: 8px; border: 2px solid #28a745;">
                    <div style="display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:15px;">
                        <h4 style="color: #155724; margin:0;">Prepare or Assign Assets</h4>
                        <label class="prepare-quick-add-switch" title="When on, scanned extra assets become event requirements instead of extra assets.">
                            <input type="checkbox" id="prepareQuickAddToggle" ${quickAddEnabled ? 'checked' : ''} onchange="handlePrepareQuickAddToggle(this)" aria-label="Quick-add">
                            <span class="prepare-quick-add-switch-slider" aria-hidden="true"></span>
                            <span class="prepare-quick-add-switch-label">Quick-add</span>
                            <span id="prepareQuickAddToggleState" class="prepare-quick-add-switch-state" style="background:${quickAddEnabled ? '#d4edda' : '#e9ecef'}; color:${quickAddEnabled ? '#155724' : '#495057'};">${quickAddEnabled ? 'On' : 'Off'}</span>
                        </label>
                    </div>
                    <div class="form-group">
                        <div style="display:flex; gap:10px; flex-wrap:wrap; align-items:stretch;">
                            <input type="text" class="form-input" id="universalAssetInput" 
                                  placeholder="Enter Asset ID or Serial Number..." 
                                  onkeypress="if(event.key==='Enter') processUniversalAsset(${eventId})"
                                  autocomplete="off"
                                  style="font-size: 16px; padding: 12px; flex:1 1 260px;">
                            <button type="button" class="btn btn-success" onclick="processUniversalAsset(${eventId})">Process Asset</button>
                            ${scannerButtonHtml(`scanForPrepare(${eventId})`)}
                            <button type="button" class="btn btn-secondary" onclick="clearUniversalInput()">Clear</button>
                        </div>
                    </div>
                    <div id="universal-asset-feedback" style="margin-top: 15px; min-height: 10px;">
                        <!-- Feedback messages will appear here -->
                    </div>
                </div>

                <!-- Model Requirements -->
                <div style="margin-bottom: 30px;">
                    <div style="display: flex; justify-content: space-between; align-items: center; padding: 15px; background: #f8f9fa; border-radius: 8px 8px 0 0; border-bottom: 1px solid #e9ecef; cursor: pointer;" onclick="togglePrepareSection('model-requirements')">
                        <h4 style="margin: 0; color: #495057;">Model Requirements</h4>
                        <span class="toggle-icon" style="font-size: 18px; font-weight: bold; color: #666;">▼</span>
                    </div>
                    <div id="model-requirements" style="border: 1px solid #e9ecef; border-top: none; border-radius: 0 0 8px 8px;">

                <!-- Custom Assets Preparation Section -->
                <div style="margin-bottom: 20px;">
                    <h4 style="color: #495057; margin-bottom: 15px; display: flex; justify-content: space-between; align-items: center;">
                        <span>🛠️ Custom Assets</span>
                        <span class="toggle-icon" style="font-size: 14px; cursor: pointer;" onclick="togglePrepareSection('custom-assets')">▼</span>
                    </h4>
                    <div id="custom-assets" style="display: block;">
                        <!-- Quick Add Custom Asset -->
                        <div style="background: #f8f9fa; padding: 15px; border-radius: 8px; margin-bottom: 15px;">
                            <h5 style="margin-bottom: 10px;">Quick Add Custom Asset</h5>
                            <div style="display: flex; flex-wrap: wrap; gap: 10px; align-items: center; max-width: 100%;">
                                <input type="text" id="prepareCustomAssetName" placeholder="Custom asset name"
                                      style="flex: 1 1 220px; min-width: 170px; padding: 8px 12px; border: 1px solid #ccc; border-radius: 4px;">
                                <input type="number" id="prepareCustomAssetQuantity" placeholder="Qty" min="1" value="1"
                                      style="flex: 0 0 70px; width: 70px; padding: 8px 12px; border: 1px solid #ccc; border-radius: 4px;">
                                <select id="prepareCustomAssetType" style="flex: 0 1 140px; min-width: 125px; padding: 8px 12px; border: 1px solid #ccc; border-radius: 4px;">
                                    <option value="MISC">Misc Item</option>
                                    <option value="LOAN">Loan/Rental</option>
                                </select>
                                <select id="prepareCustomAssetDepartment" style="flex: 0 0 82px; width: 82px; padding: 8px 10px; border: 1px solid #ccc; border-radius: 4px;">
                                    ${customDepartmentOptionsHtml('AX')}
                                </select>
                                <input type="text" id="prepareCustomAssetCompany" placeholder="Company (loan/rental only)"
                                      style="flex: 1 1 210px; min-width: 160px; padding: 8px 12px; border: 1px solid #ccc; border-radius: 4px;">
                                <button type="button" class="btn btn-success" onclick="addAndPrepareCustomAsset(${event.id})"
                                        style="flex: 0 0 auto; padding: 8px 16px; white-space: nowrap;">
                                    Add Custom Asset
                                </button>
                            </div>
                        </div>
                        
                        <!-- Existing custom assets are rendered inside their tagged department below. -->
                    </div>
                </div>
        `;
        
        // Process model assignments and custom assets together, grouped by department.
        const customAssetsByDeptForPrepare = groupCustomAssetsByDepartment(event);
        const renderedCustomDepartments = new Set();
        let renderedAnyRequirementRows = false;

        if (event.modelGroups && Object.keys(event.modelGroups).length > 0) {
            const modelGroupsByDept = {};
            Object.values(event.modelGroups).forEach(modelGroup => {
                const dept = normalizeDepartmentCode(modelGroup.department || 'UN');
                if (!modelGroupsByDept[dept]) modelGroupsByDept[dept] = [];
                modelGroupsByDept[dept].push(modelGroup);
            });

            Object.keys(modelGroupsByDept).sort().forEach(dept => {
                const modelGroups = modelGroupsByDept[dept];
                const customAssetsForDept = customAssetsByDeptForPrepare[dept] || [];
                renderedCustomDepartments.add(dept);
                renderedAnyRequirementRows = true;

                let totalRequired = 0;
                let totalAssigned = 0;

                modelGroups.forEach(modelGroup => {
                    totalRequired += Number(modelGroup.requiredQuantity || 0);
                    totalAssigned += getCountablePreparedQuantity(modelGroup);
                });

                totalRequired += getCustomRequiredQuantityForProgress(customAssetsForDept);
                totalAssigned += getCustomPreparedQuantityForProgress(customAssetsForDept);

                const progressPercent = totalRequired > 0 ? Math.round((totalAssigned / totalRequired) * 100) : 0;
                const progressColor = totalAssigned >= totalRequired ? '#28a745' : '#ffc107';

                content += `
                    <div class="dept-section" data-prepare-department="${escapeHtmlAttr(dept)}" style="margin-bottom: 20px;">
                        <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; background: #f1f3f4; border-radius: 6px; cursor: pointer; margin-bottom: 10px;" onclick="togglePrepareSection('dept-${dept}')">
                            <h5 style="margin: 0; color: #495057; font-size: 14px;">${departmentBadgeHtml(dept, true)} Department</h5>
                            <div style="display: flex; align-items: center; gap: 10px;">
                                <div style="text-align: right;">
                                    <div class="prepare-dept-progress-text" style="font-size: 12px; font-weight: 500; color: ${progressColor};">
                                        ${totalAssigned}/${totalRequired} prepared
                                    </div>
                                    <div style="background: #e9ecef; border-radius: 8px; height: 3px; width: 100px; overflow: hidden; margin-top: 2px;">
                                        <div class="prepare-dept-progress-bar" style="background: ${progressColor}; height: 100%; width: ${Math.min(progressPercent, 100)}%; transition: width 0.3s ease;"></div>
                                    </div>
                                </div>
                                <span class="toggle-icon" style="font-size: 14px; font-weight: bold; color: #666;">▼</span>
                            </div>
                        </div>
                        <div id="dept-${dept}" style="display: block; padding: 0 10px;">
                `;

                const requirementRows = [
                    ...modelGroups.map(modelGroup => ({
                        type: 'model',
                        sortName: modelGroupSortName(modelGroup),
                        modelGroup
                    })),
                    ...customAssetsForDept.map(asset => ({
                        type: 'custom',
                        sortName: customAssetSortName(asset.parsedCustom || parseCustomAsset(asset.id, asset)),
                        asset
                    }))
                ].sort((a, b) => compareByDisplayName(a.sortName, b.sortName));

                requirementRows.forEach(row => {
                    if (row.type === 'custom') {
                        content += createCustomPreparationSection(eventId, [row.asset], event);
                        return;
                    }

                    const modelGroup = row.modelGroup;
                    const modelAvailableAssets = availableAssets.filter(a => 
                        a.brand === modelGroup.brand && 
                        a.model === modelGroup.model && 
                        a.department === modelGroup.department
                    );

                    if (isBulkModelGroupForPrepare(modelGroup, modelAvailableAssets, modelGroup.assignedAssets || [])) {
                        content += createBulkPreparationSection(eventId, modelGroup, modelAvailableAssets, modelGroup.assignedAssets || []);
                    } else {
                        content += createModelPreparationSection(
                            eventId,
                            modelGroup.department,
                            modelGroup.brand,
                            modelGroup.model,
                            modelGroup.description,
                            modelGroup.requiredQuantity,
                            modelAvailableAssets,
                            modelGroup.assignedAssets || []
                        );
                    }
                });

                content += '</div></div>';
            });
        }

        Object.keys(customAssetsByDeptForPrepare).sort().forEach(dept => {
            if (renderedCustomDepartments.has(dept)) return;

            const customAssetsForDept = customAssetsByDeptForPrepare[dept] || [];
            const totalRequired = getCustomRequiredQuantityForProgress(customAssetsForDept);
            const totalAssigned = getCustomPreparedQuantityForProgress(customAssetsForDept);
            const progressPercent = totalRequired > 0 ? Math.round((totalAssigned / totalRequired) * 100) : 0;
            const progressColor = totalAssigned >= totalRequired ? '#28a745' : '#ffc107';
            renderedAnyRequirementRows = true;

            content += `
                <div class="dept-section" data-prepare-department="${escapeHtmlAttr(dept)}" style="margin-bottom: 20px;">
                    <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; background: #f1f3f4; border-radius: 6px; cursor: pointer; margin-bottom: 10px;" onclick="togglePrepareSection('dept-${dept}')">
                        <h5 style="margin: 0; color: #495057; font-size: 14px;">${departmentBadgeHtml(dept, true)} Department</h5>
                        <div style="display: flex; align-items: center; gap: 10px;">
                            <div style="text-align: right;">
                                <div class="prepare-dept-progress-text" style="font-size: 12px; font-weight: 500; color: ${progressColor};">${totalAssigned}/${totalRequired} prepared</div>
                                <div style="background: #e9ecef; border-radius: 8px; height: 3px; width: 100px; overflow: hidden; margin-top: 2px;">
                                    <div class="prepare-dept-progress-bar" style="background: ${progressColor}; height: 100%; width: ${Math.min(progressPercent, 100)}%; transition: width 0.3s ease;"></div>
                                </div>
                            </div>
                            <span class="toggle-icon" style="font-size: 14px; font-weight: bold; color: #666;">▼</span>
                        </div>
                    </div>
                    <div id="dept-${dept}" style="display: block; padding: 0 10px;">
                        ${createCustomPreparationSection(eventId, customAssetsForDept, event)}
                    </div>
                </div>
            `;
        });

        if (!renderedAnyRequirementRows) {
            content += '<p style="text-align: center; color: #666; padding: 40px;">No model or custom asset assignments found for this event.</p>';
        }
        content += `
                    </div>
                </div>
                    <!-- All Assets Assigned to Event -->
                    <div style="margin-top: 30px; padding-top: 20px; border-top: 2px solid #e9ecef;">
                    <div style="display: flex; justify-content: space-between; align-items: center; padding: 15px; background: #f8f9fa; border-radius: 8px 8px 0 0; border-bottom: 1px solid #e9ecef; cursor: pointer;" onclick="togglePrepareSection('all-assigned-assets')">
                        <h4 style="margin: 0; color: #495057;">All Assets Assigned to Event</h4>
                        <span class="toggle-icon" style="font-size: 18px; font-weight: bold; color: #666;">▼</span>
                    </div>
                    <div id="all-assigned-assets" style="border: 1px solid #e9ecef; border-top: none; border-radius: 0 0 8px 8px; max-height: 400px; overflow-y: auto;">
        `;

        // Show all assigned assets with their preparation status
        if (event.assetsByDepartment && Object.keys(event.assetsByDepartment).length > 0) {
            Object.keys(event.assetsByDepartment).forEach(dept => {
                const assets = event.assetsByDepartment[dept];
                
                // Add department header if there are non-model assets
                const nonModelAssets = assets
                    .filter(asset => !asset.id.startsWith('[MODEL]'))
                    .sort((a, b) => compareByDisplayName(assetDisplaySortName(a), assetDisplaySortName(b)));
                if (nonModelAssets.length > 0) {
                    content += `
                        <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; background: #f1f3f4; border-bottom: 1px solid #e9ecef; cursor: pointer;" onclick="togglePrepareSection('assigned-dept-${dept}')">
                            <div style="font-weight: 500; font-size: 13px;">${dept} Department (${nonModelAssets.length} assets)</div>
                            <span class="toggle-icon" style="font-size: 14px; font-weight: bold; color: #666;">▼</span>
                        </div>
                        <div id="assigned-dept-${dept}" style="display: block;">
                    `;
                }
                
                nonModelAssets.forEach(asset => {
                    if (!asset.id.startsWith('[MODEL]')) {
                        const custom = parseCustomAsset(asset.id, asset);
                        const isReturned = event.returnedItems && event.returnedItems.includes(asset.id);
                        const isPrepared = event.actuallyPrepared && event.actuallyPrepared.includes(asset.id);
                        const isCollected = custom && custom.type === 'LOAN' && event.customCollected && event.customCollected.includes(asset.id);
                        let statusIcon = isReturned ? '↩️' : (isPrepared ? '✅' : (isCollected ? '📥' : '⏳'));
                        let statusColor = isReturned ? '#dc3545' : (isPrepared ? '#28a745' : (isCollected ? '#17a2b8' : '#ffc107'));
                        let statusText = isReturned ? 'Returned' : (isPrepared ? 'Prepared' : (isCollected ? 'Collected' : 'Pending'));
                        const isExtra = event.extraAssets && event.extraAssets.includes(asset.id);
                        const extraBadge = isExtra ? 
                            '<span style="background: #fff3cd; color: #856404; padding: 2px 6px; border-radius: 3px; font-size: 10px; margin-left: 10px;">EXTRA</span>' : '';
                        const safeAssetId = encodeURIComponent(asset.id);
                        const displayName = custom ? customAssetDisplayName(custom) : (asset.isBulk ? (asset.name || `${asset.brand || ''} ${asset.model || ''}`.trim() || asset.id) : asset.id);
                        const detailText = custom ? (custom.type === 'LOAN' ? custom.company : '') : (asset.isBulk ? (asset.description || '') : (asset.name || ''));
                        const typeBadge = custom ? customAssetTypeBadge(custom) : '';
                        let actionButton = '';
                        if (isReturned) {
                            actionButton = '<span style="color:#dc3545;font-size:11px;">Returned</span>';
                        } else if (custom) {
                            const encodedCustomId = escapeHtmlAttr(safeAssetId);
                            if (custom.type === 'LOAN') {
                                if (isPrepared) {
                                    actionButton = `
                                        <button class="btn btn-warning asset-action-btn" data-event-id="${eventId}" data-asset-id="${encodedCustomId}" data-action="unprepare" style="padding: 4px 8px; font-size: 11px;">Unprepare</button>
                                        <button class="btn btn-secondary btn-sm" onclick="uncollectCustomAsset(${eventId}, '${escapeJs(safeAssetId)}')" style="padding: 4px 8px; font-size: 11px;">Uncollect</button>
                                    `;
                                } else if (isCollected) {
                                    actionButton = `
                                        <button class="btn btn-success asset-action-btn" data-event-id="${eventId}" data-asset-id="${encodedCustomId}" data-action="prepare" style="padding: 4px 8px; font-size: 11px;">Prepare</button>
                                        <button class="btn btn-secondary btn-sm" onclick="uncollectCustomAsset(${eventId}, '${escapeJs(safeAssetId)}')" style="padding: 4px 8px; font-size: 11px;">Uncollect</button>
                                    `;
                                } else {
                                    actionButton = `<button class="btn btn-primary btn-sm" onclick="collectCustomAsset(${eventId}, '${escapeJs(safeAssetId)}')" style="padding: 4px 8px; font-size: 11px;">Collect</button>`;
                                }
                            } else {
                                actionButton = isPrepared ?
                                    `<button class="btn btn-warning asset-action-btn" data-event-id="${eventId}" data-asset-id="${encodedCustomId}" data-action="unprepare" style="padding: 4px 8px; font-size: 11px;">Unprepare</button>` :
                                    `<button class="btn btn-success asset-action-btn" data-event-id="${eventId}" data-asset-id="${encodedCustomId}" data-action="prepare" style="padding: 4px 8px; font-size: 11px;">Prepare</button>`;
                            }
                        } else {
                            actionButton = isPrepared ? 
                                `<button class="btn btn-warning asset-action-btn" data-event-id="${eventId}" data-asset-id="${safeAssetId}" data-action="unprepare" style="padding: 4px 8px; font-size: 11px;">Unprepare</button>` :
                                `<button class="btn btn-success asset-action-btn" data-event-id="${eventId}" data-asset-id="${safeAssetId}" data-action="prepare" style="padding: 4px 8px; font-size: 11px;">Prepare</button>`;
                        }

                        content += `
                            <div style="padding: 8px 12px; border-bottom: 1px solid #f1f1f1; display: flex; justify-content: space-between; align-items: center;">
                                <div>
                                    <span style="font-weight: 500;">${custom ? '' : statusIcon + ' '}${escapeHtml(displayName)} ${typeBadge}</span>
                                    <span style="color: #666; font-size: 12px; margin-left: 10px;">${escapeHtml(detailText || '')}</span>
                                    ${extraBadge}
                                    <div style="color: ${statusColor}; font-size: 11px; margin-top: 2px;">${statusText}</div>
                                </div>
                                <div>
                                    ${actionButton}
                                </div>
                            </div>
                        `;
                    }
                });
                
                if (nonModelAssets.length > 0) {
                    content += '</div>';
                }
            });
        } else {
            content += '<p style="text-align: center; color: #666; padding: 20px; border: 1px solid #e9ecef; border-radius: 8px; margin-top: 15px;">No individual assets assigned to this event.</p>';
        }

        content += `
                    </div>
                </div>
                
                <!-- Actions -->
                <div class="modal-actions" style="margin-top: 20px; text-align: right; padding-top: 20px; border-top: 2px solid #e9ecef;">
                    <button class="btn btn-secondary" onclick="closeModal('prepareEventModal')">Close</button>
                    <button class="btn btn-primary" onclick="finishEventPreparation(${eventId})">Finish Preparation</button>
                </div>
            </div>
        `;
        
        document.getElementById('prepareEventContent').innerHTML = content;
        setPrepareQuickAddEnabled(quickAddEnabled);
        openModal('prepareEventModal');
        
        // Store available assets for the additional asset search
        window.currentAdditionalAssets = availableAssets;
        
    } catch (error) {
        showNotification('error', 'Failed to load event preparation interface');
        console.error('Error loading prepare event modal:', error);
    }
    setupAssetClickHandler();
}
// All Events Tab System

// Calendar functionality
let currentCalendarDate = new Date();

async function loadCalendarView() {
  try {
    const response = await apiCall('/api/events');
    const events = response.data;
    
    renderCalendar(events);
  } catch (error) {
    document.getElementById('calendar-container').innerHTML = 
      '<p style="color: red; text-align: center;">Error loading calendar</p>';
  }
}

function renderCalendar(events) {
  const container = document.getElementById('calendar-container');
  const currentMonth = currentCalendarDate.getMonth();
  const currentYear = currentCalendarDate.getFullYear();
  
  // Calendar header
  const monthNames = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];
  
  const headerHTML = `
    <div class="calendar-header">
      <h3>${monthNames[currentMonth]} ${currentYear}</h3>
      <div class="calendar-nav">
        <button onclick="navigateCalendar(-1)">‹ Previous</button>
        <button onclick="goToToday()">Today</button>
        <button onclick="navigateCalendar(1)">Next ›</button>
      </div>
    </div>
  `;
  
  // Days of week header
  const daysOfWeek = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const headerRowHTML = daysOfWeek.map(day => 
    `<div class="calendar-day-header">${day}</div>`
  ).join('');
  
  // Calculate calendar grid
  const firstDay = new Date(currentYear, currentMonth, 1);
  const lastDay = new Date(currentYear, currentMonth + 1, 0);
  const firstDayOfWeek = (firstDay.getDay() + 6) % 7;
  const daysInMonth = lastDay.getDate();
  
  // Previous month days
  const prevMonth = new Date(currentYear, currentMonth, 0);
  const daysInPrevMonth = prevMonth.getDate();
  
  // Create calendar grid data structure
  const calendarDays = [];
  
  // Previous month's trailing days
  for (let i = firstDayOfWeek - 1; i >= 0; i--) {
    const dayNum = daysInPrevMonth - i;
    const date = new Date(currentYear, currentMonth - 1, dayNum);
    calendarDays.push({
      date,
      dayNum,
      isCurrentMonth: false,
      isToday: false
    });
  }
  
  // Current month days
  const today = new Date();
  for (let day = 1; day <= daysInMonth; day++) {
    const date = new Date(currentYear, currentMonth, day);
    const isToday = date.toDateString() === today.toDateString();
    
    calendarDays.push({
      date,
      dayNum: day,
      isCurrentMonth: true,
      isToday
    });
  }
  
  // Next month's leading days
  const totalCells = 35; // 5 rows × 7 days (changed from 42)
  const usedCells = calendarDays.length;
  const remainingCells = totalCells - usedCells;

  for (let day = 1; day <= remainingCells; day++) {
    const date = new Date(currentYear, currentMonth + 1, day);
    calendarDays.push({
      date,
      dayNum: day,
      isCurrentMonth: false,
      isToday: false
    });
  }
  
  // Process events for the calendar with proper row assignment
  const eventPlacements = processEventsForCalendar(events, calendarDays);
  
  // Generate calendar HTML
  let calendarDaysHTML = '';
  
  calendarDays.forEach((dayData, dayIndex) => {
    const dayPlacements = eventPlacements.filter(p => p.dayIndex === dayIndex);
    
    // Create event layers HTML (max 4 visible)
    const eventLayersHTML = [];
    for (let row = 0; row < 4; row++) {
      const placement = dayPlacements.find(p => p.row === row);
      if (placement) {
        const eventClass = `calendar-event ${getEventStateClass(placement.event.state)}${placement.event.tag === 'dry hire' ? ' dry-hire' : ''} ${placement.spanClass}`;
        
        // Only show text on the first day of the event span or if it's a single day event
        let eventText = '';
        if (placement.spanClass === 'span-single' || placement.spanClass === 'span-start') {
          eventText = placement.event.name;
        }

        eventLayersHTML.push(`
          <div class="calendar-event-layer" style="top: ${20 + (row * 18)}px; z-index: ${placement.spanClass === 'span-start' ? 10 : 5};">
            <div class="${eventClass}" onclick="openEventFromCalendar(${placement.event.id})" title="${placement.event.name}" style="z-index: ${placement.spanClass === 'span-start' ? 10 : 5}; position: relative;">
              ${eventText}
            </div>
          </div>
        `);
      }
    }
    
    // Count total events for this day (for "more" indicator)
    const allDayEvents = events.filter(event => {
      const eventStart = new Date(event.startDate);
      const eventEnd = new Date(event.endDate);
      const dayDate = new Date(dayData.date);
      eventStart.setHours(0, 0, 0, 0);
      eventEnd.setHours(23, 59, 59, 999);
      dayDate.setHours(0, 0, 0, 0);
      return dayDate >= eventStart && dayDate <= eventEnd;
    });
    
    const hiddenEventCount = Math.max(0, allDayEvents.length - 4);
    
    // More events indicator
    const moreEventsHTML = hiddenEventCount > 0 ? 
      `<div class="more-events" onclick="showDayEvents(event, ${dayIndex}, '${dayData.date.toDateString()}')">${hiddenEventCount} more</div>` : '';
    
    const dayClass = `calendar-day ${!dayData.isCurrentMonth ? 'other-month' : ''} ${dayData.isToday ? 'today' : ''}`;
    
    calendarDaysHTML += `
      <div class="${dayClass}">
        <div class="calendar-day-number">${dayData.dayNum}</div>
        <div class="calendar-events-container">
          ${eventLayersHTML.join('')}
          ${moreEventsHTML}
        </div>
      </div>
    `;
  });
  
  container.innerHTML = `
    ${headerHTML}
    <div class="calendar-grid">
      ${headerRowHTML}
      ${calendarDaysHTML}
    </div>
  `;
  
  // Store events data for popup
  window.calendarAllEvents = events;
  window.calendarDays = calendarDays;
}

function processEventsForCalendar(events, calendarDays) {
  const eventPlacements = [];
  const rowOccupancy = {}; // Track which rows are occupied on which days
  
  // Initialize row occupancy tracking
  calendarDays.forEach((_, dayIndex) => {
    rowOccupancy[dayIndex] = new Set();
  });
  
  // Sort events by start date, then by duration (longer events first)
  const sortedEvents = [...events].sort((a, b) => {
    const startA = new Date(a.startDate);
    const startB = new Date(b.startDate);
    if (startA.getTime() === startB.getTime()) {
      const durationA = new Date(a.endDate) - new Date(a.startDate);
      const durationB = new Date(b.endDate) - new Date(b.startDate);
      return durationB - durationA; // Longer events first
    }
    return startA - startB;
  });
  
  sortedEvents.forEach(event => {
    const eventStart = new Date(event.startDate);
    const eventEnd = new Date(event.endDate);
    eventStart.setHours(0, 0, 0, 0);
    eventEnd.setHours(23, 59, 59, 999);
    
    // Find all days this event spans
    const spanningDays = [];
    calendarDays.forEach((dayData, dayIndex) => {
      const dayDate = new Date(dayData.date);
      dayDate.setHours(0, 0, 0, 0);
      
      if (dayDate >= eventStart && dayDate <= eventEnd) {
        spanningDays.push({
          dayIndex,
          date: dayDate,
          calendarRow: Math.floor(dayIndex / 7),
          calendarCol: dayIndex % 7
        });
      }
    });
    
    if (spanningDays.length === 0) return;
    
    // Find the first available row that works for ALL spanning days
    let assignedRow = -1;
    for (let row = 0; row < 4; row++) {
      let rowAvailable = true;
      for (let day of spanningDays) {
        if (rowOccupancy[day.dayIndex].has(row)) {
          rowAvailable = false;
          break;
        }
      }
      if (rowAvailable) {
        assignedRow = row;
        break;
      }
    }
    
    // If no row available in visible area, skip this event
    if (assignedRow === -1) return;
    
    // Mark this row as occupied on all spanning days
    spanningDays.forEach(day => {
      rowOccupancy[day.dayIndex].add(assignedRow);
    });
    
    // Group spanning days by calendar row to handle week breaks
    const daysByCalendarRow = {};
    spanningDays.forEach(day => {
      if (!daysByCalendarRow[day.calendarRow]) {
        daysByCalendarRow[day.calendarRow] = [];
      }
      daysByCalendarRow[day.calendarRow].push(day);
    });
    
    // Create placements for each calendar row
    Object.values(daysByCalendarRow).forEach(rowDays => {
      rowDays.sort((a, b) => a.calendarCol - b.calendarCol);
      
      // Group consecutive days
      const consecutiveGroups = [];
      let currentGroup = [rowDays[0]];
      
      for (let i = 1; i < rowDays.length; i++) {
        if (rowDays[i].calendarCol === rowDays[i-1].calendarCol + 1) {
          currentGroup.push(rowDays[i]);
        } else {
          consecutiveGroups.push(currentGroup);
          currentGroup = [rowDays[i]];
        }
      }
      consecutiveGroups.push(currentGroup);
      
      // Create placements for each consecutive group
      consecutiveGroups.forEach(group => {
        group.forEach((day, dayIndexInGroup) => {
          let spanClass = 'span-single';
          
          if (group.length > 1) {
            if (dayIndexInGroup === 0) {
              spanClass = 'span-start';
            } else if (dayIndexInGroup === group.length - 1) {
              spanClass = 'span-end';
            } else {
              spanClass = 'span-middle';
            }
          }
          
          eventPlacements.push({
            event,
            dayIndex: day.dayIndex,
            row: assignedRow,
            spanClass
          });
        });
      });
    });
  });
  
  return eventPlacements;
}

function showDayEvents(event, dayIndex, dateString) {
  event.stopPropagation();
  
  // Remove any existing popup
  const existingPopup = document.querySelector('.day-events-popup');
  if (existingPopup) {
    existingPopup.remove();
  }
  
  // Get all events for this day
  const dayDate = window.calendarDays[dayIndex].date;
  const dayEvents = window.calendarAllEvents.filter(event => {
    const eventStart = new Date(event.startDate);
    const eventEnd = new Date(event.endDate);
    const checkDate = new Date(dayDate);
    eventStart.setHours(0, 0, 0, 0);
    eventEnd.setHours(23, 59, 59, 999);
    checkDate.setHours(0, 0, 0, 0);
    return checkDate >= eventStart && checkDate <= eventEnd;
  });
  
  // Create popup
  const popup = document.createElement('div');
  popup.className = 'day-events-popup';
  
  const eventsHTML = dayEvents.map(event => {
    const eventClass = `day-event-item ${getEventStateClass(event.state)}${event.tag === 'dry hire' ? ' dry-hire' : ''}`;
    return `<div class="${eventClass}" onclick="viewEvent(${event.id}); closeDayEventsPopup();" title="${event.name}">${event.name}</div>`;
  }).join('');
  
  popup.innerHTML = `
    <div class="day-events-header">
      <span>${dateString}</span>
      <button class="day-events-close" onclick="closeDayEventsPopup()">×</button>
    </div>
    ${eventsHTML}
  `;
  
  // Position popup near the click
  const rect = event.target.getBoundingClientRect();
  popup.style.left = `${rect.left}px`;
  popup.style.top = `${rect.bottom + 5}px`;
  
  // Adjust if popup goes off screen
  document.body.appendChild(popup);
  const popupRect = popup.getBoundingClientRect();
  if (popupRect.right > window.innerWidth) {
    popup.style.left = `${window.innerWidth - popupRect.width - 10}px`;
  }
  if (popupRect.bottom > window.innerHeight) {
    popup.style.top = `${rect.top - popupRect.height - 5}px`;
  }
  
  // Close popup when clicking outside
  setTimeout(() => {
    document.addEventListener('click', closeDayEventsPopup);
  }, 100);
}

function closeDayEventsPopup() {
  const popup = document.querySelector('.day-events-popup');
  if (popup) {
    popup.remove();
  }
  document.removeEventListener('click', closeDayEventsPopup);
}

function navigateCalendar(direction) {
  currentCalendarDate.setMonth(currentCalendarDate.getMonth() + direction);
  loadCalendarView();
}

function goToToday() {
  currentCalendarDate = new Date();
  loadCalendarView();
}

function handleAssetActionClick(event) {
    if (event.target.classList.contains('asset-action-btn')) {
        event.preventDefault();
        
        const eventId = event.target.dataset.eventId;
        const assetId = event.target.dataset.assetId.replace(/&quot;/g, '"').replace(/&#39;/g, "'");
        const action = event.target.dataset.action;
        
        if (action === 'prepare') {
            prepareSpecificAsset(eventId, assetId);
        } else if (action === 'unprepare') {
            unprepareSpecificAsset(eventId, assetId);
        }
    }
}

function groupCustomAssetsByDepartment(event) {
    const grouped = {};
    getCustomAssetsFromEvent(event).forEach(asset => {
        const custom = asset.parsedCustom || parseCustomAsset(asset.id, asset);
        if (!custom) return;
        const dept = normalizeDepartmentCode(custom.department || asset.department || 'UN');
        if (!grouped[dept]) grouped[dept] = [];
        grouped[dept].push({ ...asset, parsedCustom: custom, department: dept });
    });

    Object.keys(grouped).forEach(dept => {
        grouped[dept].sort((a, b) => compareByDisplayName(
            customAssetSortName(a.parsedCustom || parseCustomAsset(a.id, a)),
            customAssetSortName(b.parsedCustom || parseCustomAsset(b.id, b))
        ));
    });

    return grouped;
}

function getCustomPreparedQuantityForProgress(customAssets) {
    return (customAssets || []).reduce((sum, asset) => {
        const custom = asset.parsedCustom || parseCustomAsset(asset.id, asset);
        if (!custom) return sum;
        return sum + (asset.status === 'prepared' ? Number(custom.quantity || 1) : 0);
    }, 0);
}

function getCustomRequiredQuantityForProgress(customAssets) {
    return (customAssets || []).reduce((sum, asset) => {
        const custom = asset.parsedCustom || parseCustomAsset(asset.id, asset);
        return sum + (custom ? Number(custom.quantity || 1) : 0);
    }, 0);
}

function createCustomPreparationSection(eventId, customAssets, event) {
    if (!customAssets || customAssets.length === 0) return '';

    return [...customAssets]
        .sort((a, b) => compareByDisplayName(
            customAssetSortName(a.parsedCustom || parseCustomAsset(a.id, a)),
            customAssetSortName(b.parsedCustom || parseCustomAsset(b.id, b))
        ))
        .map((asset) => {
        const custom = asset.parsedCustom || parseCustomAsset(asset.id, asset);
        if (!custom) return '';

        const encodedId = encodeURIComponent(asset.id);
        const safeEncodedId = escapeHtmlAttr(encodedId);
        const isReturned = asset.status === 'returned' || (event.returnedItems || []).includes(asset.id);
        const isPrepared = asset.status === 'prepared' || (event.actuallyPrepared || []).includes(asset.id);
        const isCollected = custom.type === 'LOAN' && (asset.status === 'collected' || asset.isCollected || (event.customCollected || []).includes(asset.id));

        let statusText = 'Pending';
        let statusColor = '#ffc107';

        if (isReturned) {
            statusText = 'Returned';
            statusColor = '#dc3545';
        } else if (isPrepared) {
            statusText = 'Prepared';
            statusColor = '#28a745';
        } else if (isCollected) {
            statusText = 'Collected';
            statusColor = '#17a2b8';
        }

        let actionButtons = '';
        if (isReturned) {
            actionButtons = '<span style="color:#dc3545; font-size:11px;">Returned</span>';
        } else if (custom.type === 'LOAN') {
            if (isPrepared) {
                actionButtons = `
                    <button class="btn btn-warning btn-sm asset-action-btn" data-event-id="${eventId}" data-asset-id="${safeEncodedId}" data-action="unprepare" style="padding:4px 8px; font-size:11px;">Unprepare</button>
                    <button class="btn btn-secondary btn-sm" onclick="uncollectCustomAsset(${eventId}, '${escapeJs(encodedId)}')" style="padding:4px 8px; font-size:11px;">Uncollect</button>
                `;
            } else if (isCollected) {
                actionButtons = `
                    <button class="btn btn-success btn-sm asset-action-btn" data-event-id="${eventId}" data-asset-id="${safeEncodedId}" data-action="prepare" style="padding:4px 8px; font-size:11px;">Prepare</button>
                    <button class="btn btn-secondary btn-sm" onclick="uncollectCustomAsset(${eventId}, '${escapeJs(encodedId)}')" style="padding:4px 8px; font-size:11px;">Uncollect</button>
                `;
            } else {
                actionButtons = `<button class="btn btn-primary btn-sm" onclick="collectCustomAsset(${eventId}, '${escapeJs(encodedId)}')" style="padding:4px 8px; font-size:11px;">Collect</button>`;
            }
        } else {
            actionButtons = isPrepared
                ? `<button class="btn btn-warning btn-sm asset-action-btn" data-event-id="${eventId}" data-asset-id="${safeEncodedId}" data-action="unprepare" style="padding:4px 8px; font-size:11px;">Unprepare</button>`
                : `<button class="btn btn-success btn-sm asset-action-btn" data-event-id="${eventId}" data-asset-id="${safeEncodedId}" data-action="prepare" style="padding:4px 8px; font-size:11px;">Prepare</button>`;
        }

        const descriptionLine = custom.type === 'LOAN' && custom.company
            ? `<div style="color:#666; font-size:12px; margin-top:2px; overflow-wrap:anywhere;">${escapeHtml(custom.company)}</div>`
            : '';

        return `
            <div class="model-prep-section custom-prep-flat-section" style="border: 1px solid #e9ecef; border-radius: 8px; padding: 0; margin-bottom: 15px; overflow:hidden;">
                <div style="display:flex; justify-content:space-between; align-items:center; gap:15px; padding:15px; background:#f8f9fa; border-radius:8px;">
                    <div style="min-width:0; flex:1;">
                        <h5 style="margin:0; color:#495057; font-size:14px; display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
                            <span>${escapeHtml(customAssetDisplayName(custom))}</span>
                            ${customAssetTypeBadge(custom)}
                        </h5>
                        ${descriptionLine}
                        <div style="color:${statusColor}; font-size:12px; margin-top:2px; font-weight:500;">${statusText}</div>
                    </div>
                    <div style="display:flex; gap:6px; flex-wrap:wrap; justify-content:flex-end; align-items:center; flex-shrink:0;">
                        ${actionButtons}
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

function getCustomAssetsFromEvent(event) {
    const list = [];
    if (!event || !event.assetsByDepartment) return list;

    Object.keys(event.assetsByDepartment).forEach(dept => {
        (event.assetsByDepartment[dept] || []).forEach(asset => {
            const custom = parseCustomAsset(asset.id, asset);
            if (!custom) return;
            list.push({ ...asset, parsedCustom: custom, department: custom.department || dept });
        });
    });

    return list;
}


function updateCustomCollectionUi(eventId, encodedAssetId, isCollected) {
    const root = document.getElementById('prepareEventContent') || document;
    const matchingButtons = Array.from(root.querySelectorAll('button[onclick]')).filter(button => {
        const handler = button.getAttribute('onclick') || '';
        return handler.includes(encodedAssetId) && (
            handler.includes('collectCustomAsset(') || handler.includes('uncollectCustomAsset(')
        );
    });
    const actionContainers = matchingButtons
        .map(button => button.parentElement)
        .filter((container, index, all) => container && all.indexOf(container) === index);

    actionContainers.forEach(container => {
        container.innerHTML = isCollected
            ? `
                <button class="btn btn-success btn-sm asset-action-btn"
                        data-event-id="${eventId}"
                        data-asset-id="${escapeHtmlAttr(encodedAssetId)}"
                        data-action="prepare"
                        style="padding:4px 8px; font-size:11px;">Prepare</button>
                <button class="btn btn-secondary btn-sm"
                        onclick="uncollectCustomAsset(${eventId}, '${escapeJs(encodedAssetId)}')"
                        style="padding:4px 8px; font-size:11px;">Uncollect</button>
              `
            : `<button class="btn btn-primary btn-sm"
                       onclick="collectCustomAsset(${eventId}, '${escapeJs(encodedAssetId)}')"
                       style="padding:4px 8px; font-size:11px;">Collect</button>`;

        let row = container.parentElement;
        while (row && !row.querySelector('div[style*="margin-top: 2px"], div[style*="margin-top:2px"]')) {
            row = row.parentElement;
        }
        const status = row?.querySelector('div[style*="margin-top: 2px"], div[style*="margin-top:2px"]');
        if (status) {
            status.textContent = isCollected ? 'Collected' : 'Pending';
            status.style.color = isCollected ? '#17a2b8' : '#ffc107';
        }
    });
}

async function collectCustomAsset(eventId, encodedAssetId) {
    const assetId = decodeURIComponent(encodedAssetId);
    try {
        await apiCall(`/api/events/${eventId}/custom-assets/collect`, 'POST', { assetId });
        showNotification('success', `${customAssetLabelFromId(assetId)} collected`);
        updateCustomCollectionUi(eventId, encodedAssetId, true);
        schedulePrepareUiSync(eventId);
    } catch (error) {
        showNotification('error', `Failed to collect item: ${error.message}`);
    }
}

async function uncollectCustomAsset(eventId, encodedAssetId) {
    const assetId = decodeURIComponent(encodedAssetId);
    try {
        await apiCall(`/api/events/${eventId}/custom-assets/uncollect`, 'POST', { assetId });
        showNotification('success', `${customAssetLabelFromId(assetId)} uncollected`);
        updateCustomCollectionUi(eventId, encodedAssetId, false);
        schedulePrepareUiSync(eventId);
    } catch (error) {
        showNotification('error', `Failed to uncollect item: ${error.message}`);
    }
}

function handleCustomAssetClick(event) {
    if (event.target.classList.contains('custom-asset-btn')) {
        event.preventDefault();
        
        const eventId = event.target.dataset.eventId;
        const assetId = event.target.dataset.assetId.replace(/&quot;/g, '"').replace(/&#39;/g, "'");
        const action = event.target.dataset.action;
        
        if (action === 'prepare') {
            prepareSpecificAsset(eventId, assetId);
        } else if (action === 'unprepare') {
            unprepareSpecificAsset(eventId, assetId);
        }
    }
}

function generateActionButton(eventId, asset, isPrepared) {
    const safeAssetId = encodeURIComponent(asset.id);
    
    if (isPrepared) {
        return `<button class="btn btn-warning asset-action-btn" 
                        data-event-id="${eventId}" 
                        data-asset-id="${safeAssetId}" 
                        data-action="unprepare"
                        style="padding: 4px 8px; font-size: 11px; margin-right: 5px;">Unprepare</button>`;
    } else {
        return `<button class="btn btn-success asset-action-btn" 
                        data-event-id="${eventId}" 
                        data-asset-id="${safeAssetId}" 
                        data-action="prepare"
                        style="padding: 4px 8px; font-size: 11px; margin-right: 5px;">Prepare</button>`;
    }
}

// Add function to handle adding custom assets in prepare modal
async function addAndPrepareCustomAsset(eventId) {
    const nameInput = document.getElementById("prepareCustomAssetName");
    const quantityInput = document.getElementById("prepareCustomAssetQuantity");
    const typeSelect = document.getElementById("prepareCustomAssetType");
    const departmentSelect = document.getElementById("prepareCustomAssetDepartment");
    const companyInput = document.getElementById("prepareCustomAssetCompany");

    const name = nameInput.value.trim();
    const quantity = Math.max(1, parseInt(quantityInput?.value || '1', 10) || 1);
    const type = normalizeCustomType(typeSelect.value);
    const department = normalizeDepartmentCode(departmentSelect?.value || 'UN');
    const company = (companyInput?.value || '').trim();

    if (!name) {
        showNotification("error", "Please enter a custom asset name");
        return;
    }

    if (type === 'LOAN' && !company) {
        showNotification("warning", "Please enter the loan/rental company");
        companyInput?.focus();
        return;
    }

    try {
        await apiCall(`/api/events/${eventId}/custom-assets`, "POST", {
            name,
            quantity,
            type,
            department,
            company
        });

        showNotification("success", `Custom asset "${name}" added. Prepare it from the Custom Assets section.`);

        nameInput.value = "";
        if (quantityInput) quantityInput.value = "1";
        if (companyInput) companyInput.value = "";

        await refreshEventOverviewViews();

        setTimeout(() => {
            openPrepareEventModal(eventId);
        }, 300);

    } catch (error) {
        showNotification("error", `Failed to add custom asset: ${error.message}`);
    }
}

function togglePrepareSection(sectionId) {
    const section = document.getElementById(sectionId);
    const toggleIcon = event.target.closest('[onclick]').querySelector('.toggle-icon');
    
    if (section && toggleIcon) {
        if (section.style.display === 'none') {
            section.style.display = 'block';
            toggleIcon.textContent = '▼';
        } else {
            section.style.display = 'none';
            toggleIcon.textContent = '▶';
        }
    }
}


/**
 * ASSIGN additional asset from search results
 * Used by: "Assign as Extra" buttons in additional asset search
 * Maintains exact same function signature as before
 */
async function assignAdditionalAsset(eventId, assetId) {
    try {
        const response = await apiCall(`/api/events/${eventId}/assign-specific`, 'POST', { assetId });
        showNotification('success', `Assigned ${assetId} as additional asset`);
        
        // Remove from search results
        const assetElement = document.querySelector(`[onclick*="assignAdditionalAsset(${eventId}, '${assetId}')"]`).closest('div');
        if (assetElement) {
            assetElement.remove();
        }
        
        // Update available assets cache
        if (window.currentAdditionalAssets) {
            window.currentAdditionalAssets = window.currentAdditionalAssets.filter(a => a.id !== assetId);
        }
        
        updateAllButtonsForAsset(response?.data?.assetId || assetId, true, { sourceAssetId: assetId });
        schedulePrepareUiSync(eventId);
        
    } catch (error) {
        console.error('Error in assignAdditionalAsset:', error);
        showNotification('error', `Failed to assign asset: ${error.message}`);
    }
}

/**
 * PREPARE asset from manual input field
 * Used by: Input field with "Prepare Asset" button
 * Maintains exact same function signature as before
 */
async function prepareAssignedAsset(eventId) {
    const input = document.getElementById('assignedAssetPrepare');
    const assetId = input.value.trim();
    
    if (!assetId) {
        showNotification('warning', 'Please enter an asset ID');
        return;
    }
    
    try {
        const response = await apiCall(`/api/events/${eventId}/prepare`, 'POST', { assetId });
        showNotification('success', `${assetId} marked as prepared`);
        
        // Clear input
        input.value = '';
        
        updateAllButtonsForAsset(response?.data?.assetId || assetId, true, { sourceAssetId: assetId });
        schedulePrepareUiSync(eventId);
        
    } catch (error) {
        console.error('Error in prepareAssignedAsset:', error);
        showNotification('error', `Failed to prepare asset: ${error.message}`);
    }
}




















async function processUniversalAsset(eventId) {
    const input = document.getElementById('universalAssetInput');
    const feedbackDiv = document.getElementById('universal-asset-feedback');
    let assetId = normalizeScannedIdentifier(input.value);
    const quickAddEnabled = getPrepareQuickAddEnabled();
    const scanPayload = prepareQuickAddPayload();
    
    if (!assetId) {
        showFeedback(feedbackDiv, 'warning', 'Please enter an asset ID');
        return;
    }

    input.value = assetId;

    if (!window.__processingContainerBatch) {
      const container = await getContainerById(assetId, true);
      if (container) {
        await processUniversalContainer(eventId, container.id);
        return;
      }
    }
    
    try {
        // Get event details and available assets to check asset existence and model matching
        const [eventResponse, availableAssetsResponse] = await Promise.all([
            apiCall(`/api/events/${eventId}`),
            apiCall('/api/assets/available')
        ]);
        
        const event = eventResponse.data;
        const allAssets = availableAssetsResponse.data;
        
        // Find the asset in available assets or check if it exists in inventory
        let assetDetails = findAssetByIdentifier(assetId, allAssets);

        if (!assetDetails) {
            const inventoryAssets = await ensureAssetsLoaded();
            assetDetails = findAssetByIdentifier(assetId, inventoryAssets);
        }

        if (assetDetails) {
            assetId = getAssetIdentifierForApi(assetDetails);
        }
        
        // If not in available assets, try to get asset details from the event's actually_prepared list
        if (!assetDetails && event.actuallyPrepared && event.actuallyPrepared.includes(assetId)) {
            // Asset might already be prepared, we need to check its details differently
            // For now, we'll create a basic asset object
            assetDetails = { id: assetId };
        }
        
        let isDirectlyAssigned = false;
        let isAlreadyPrepared = false;
        let isReturned = false;
        let fulfillsModelRequirement = false;
        let isExtra = false;
        
        // Check if asset is directly in prepared_items (assigned)
        if (event.preparedItems && event.preparedItems.includes(assetId)) {
            isDirectlyAssigned = true;
        }
        
        // Check if asset is already prepared
        if (event.actuallyPrepared && event.actuallyPrepared.includes(assetId)) {
            isAlreadyPrepared = true;
        }
        
        // Check if asset is returned
        if (event.returnedItems && event.returnedItems.includes(assetId)) {
            isReturned = true;
        }

        if (event.extraAssets && event.extraAssets.includes(assetId)) {
            isExtra = true;
        }
        
        // Check if asset fulfills any model requirement
        if (assetDetails && event.preparedItems) {
            for (const preparedItem of event.preparedItems) {
                if (preparedItem.startsWith('[MODEL]')) {
                    try {
                        const parts = preparedItem.substring(7).split('|');
                        if (parts.length >= 4) {
                            const reqDept = parts[0];
                            const reqBrand = parts[1];
                            const reqModel = parts[2];
                            
                            // Description is display text only; type matching uses department, brand, and model.
                            if (assetDetails.department === reqDept && 
                                assetDetails.brand === reqBrand && 
                                assetDetails.model === reqModel) {
                                fulfillsModelRequirement = true;
                                break;
                            }
                        }
                    } catch (e) {
                        console.error('Error parsing model assignment:', e);
                    }
                }
            }
        }
        
        // Determine if asset is considered "assigned" (either directly or through model requirement)
        const isAssigned = isDirectlyAssigned || fulfillsModelRequirement;
        
        if (isReturned) {
            showFeedback(feedbackDiv, 'error', `${assetId} has already been returned from this event`);
            return;
        }
        
        if (isAssigned) {
            if (isAlreadyPrepared) {
                if (quickAddEnabled && isExtra) {
                    const response = await apiCall(`/api/events/${eventId}/assign-specific`, 'POST', { assetId, ...scanPayload });
                    await showApiWarning(response);
                    showFeedback(feedbackDiv, 'success', `✅ ${assetId} added into the event`);
                } else {
                    showFeedback(feedbackDiv, 'info', `${assetId} is already prepared for this event`);
                }
                refreshPrepareUiAfterAssetChange(eventId);
            } else {
                // Asset is assigned but not prepared - prepare it
                if (!(await confirmDegradedAssetUse(assetId, assetDetails))) return;
                const response = await apiCall(`/api/events/${eventId}/assign-specific`, 'POST', { assetId, ...scanPayload });
                await showApiWarning(response);
                const responseIsExtra = !!(response?.data?.isExtra);
                updateAllButtonsForAsset(response?.data?.assetId || assetId, true, { sourceAssetId: assetId });
                showFeedback(feedbackDiv, 'success', responseIsExtra ? `✅ ${assetId} prepared as extra asset` : `✅ ${assetId} assigned and prepared`);
                
                // Clear input and focus back on it
                input.value = '';
                input.focus();
                
                refreshPrepareUiAfterAssetChange(eventId);
            }
        } else {
            // Asset is not assigned; prepare it immediately as a manual extra.
            if (!assetDetails) {
                showFeedback(feedbackDiv, 'error', `${assetId} not found in inventory or not available`);
                return;
            }

            if (!(await confirmDegradedAssetUse(assetId, assetDetails))) return;
            const response = await apiCall(`/api/events/${eventId}/assign-specific`, 'POST', { assetId, ...scanPayload });
            await showApiWarning(response);
            const responseIsExtra = !!(response?.data?.isExtra);
            updateAllButtonsForAsset(response?.data?.assetId || assetId, true, { sourceAssetId: assetId });
            showFeedback(feedbackDiv, 'success', responseIsExtra ? `✅ ${assetId} prepared as extra asset` : `✅ ${assetId} added into the event`);

            input.value = '';
            input.focus();

            refreshPrepareUiAfterAssetChange(eventId);
        }
        
    } catch (error) {
        showFeedback(feedbackDiv, 'error', `Failed to process asset: ${error.message}`);
    }
}


/**
 * Legacy one-step assign + prepare helper for extra assets.
 * The universal asset input now calls the same endpoint directly.
 */
async function assignAndPrepareAsset(eventId, assetId) {
    const feedbackDiv = document.getElementById('universal-asset-feedback');
    const input = document.getElementById('universalAssetInput');
    
    try {
        const response = await apiCall(`/api/events/${eventId}/assign-specific`, 'POST', { assetId });
        
        if (feedbackDiv) {
            showFeedback(feedbackDiv, 'success', `✅ ${assetId} assigned and prepared as extra asset`);
        } else {
            showNotification('success', `${assetId} assigned and prepared as extra asset`);
        }
        
        // Clear input and focus back on it
        if (input) {
            input.value = '';
            input.focus();
        }
        
        updateAllButtonsForAsset(response?.data?.assetId || assetId, true, { sourceAssetId: assetId });
        schedulePrepareUiSync(eventId);
        
    } catch (error) {
        console.error('Error in assignAndPrepareAsset:', error);
        if (feedbackDiv) {
            showFeedback(feedbackDiv, 'error', `Failed to assign asset: ${error.message}`);
        } else {
            showNotification('error', `Failed to assign and prepare asset: ${error.message}`);
        }
    }
}

function updateEventSummary(event) {
    // Update the event summary numbers
    const requiredEl = document.querySelector('.prepare-event-interface .stats-grid div:nth-child(1) .stat-number');
    const preparedEl = document.querySelector('.prepare-event-interface .stats-grid div:nth-child(2) .stat-number');
    const extraEl = document.querySelector('.prepare-event-interface .stats-grid div:nth-child(3) .stat-number');
    
    if (requiredEl) requiredEl.textContent = event.totalAssets;
    if (preparedEl) preparedEl.textContent = event.totalPrepared;
    if (extraEl) extraEl.textContent = getEventExtraQuantity(event);
}

function updateModelGroupsSection(event, eventId) {
    // Find all model requirement sections and update their status
    const modelSections = document.querySelectorAll('.model-prep-section');
    
    modelSections.forEach(section => {
        // Extract model info from the section
        const titleElement = section.querySelector('h5');
        if (!titleElement) return;
        
        const titleText = titleElement.textContent;
        const match = titleText.match(/(\d+)x (.+)/);
        if (!match) return;
        
        const requiredQty = parseInt(match[1]);
        const modelName = match[2];
        
        // Find matching model group in event data
        if (event.modelGroups) {
            Object.values(event.modelGroups).forEach(modelGroup => {
                const groupModelName = `${modelGroup.brand} ${modelGroup.model}`;
                if (groupModelName === modelName) {
                    updateModelSection(section, modelGroup, eventId);
                }
            });
        }
    });
}

function updateModelSection(section, modelGroup, eventId) {
    const assignedCount = getPreparedQuantity(modelGroup);
    const requiredQty = modelGroup.requiredQuantity;
    const countableAssignedCount = getCountablePreparedQuantity(modelGroup);
    const extraAssignedCount = getExtraPreparedQuantity(modelGroup);
    const progressPercent = requiredQty > 0 ? Math.round((assignedCount / requiredQty) * 100) : 0;
    
    // Update the progress info
    const statusDiv = section.querySelector('div[style*="text-align: right"] div:first-child');
    if (statusDiv) {
        const color = countableAssignedCount >= requiredQty ? '#28a745' : '#ffc107';
        statusDiv.innerHTML = `
            <div style="font-size: 14px; font-weight: 500; color: ${color};">
                ${assignedCount}/${requiredQty} assigned
                ${extraAssignedCount > 0 ? ` (+${extraAssignedCount} extra)` : ''}
            </div>
        `;
    }
    
    // Update the progress bar
    const progressBar = section.querySelector('div[style*="background: #e9ecef"] div');
    if (progressBar) {
        const color = countableAssignedCount >= requiredQty ? '#28a745' : '#ffc107';
        progressBar.style.background = color;
        progressBar.style.width = `${Math.min(progressPercent, 100)}%`;
    }
    
    // Update assigned assets list
    const assignedContainer = section.querySelector('div[style*="background: #d4edda"]');
    if (assignedContainer && modelGroup.assignedAssets.length > 0) {
        let content = '';
        const assignedAssetsForDisplay = [...(modelGroup.assignedAssets || [])].sort((a, b) => {
            if (!!a.isExtra !== !!b.isExtra) return a.isExtra ? 1 : -1;
            return String(a.id || '').localeCompare(String(b.id || ''), undefined, { numeric: true, sensitivity: 'base' });
        });
        assignedAssetsForDisplay.forEach((asset, index) => {
            const isExtra = !!asset.isExtra || index >= requiredQty;
            const bgColor = isExtra ? '#fff3cd' : '#d4edda';
            const textColor = isExtra ? '#856404' : '#155724';
            
            content += `
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 5px; padding: 4px 8px; background: ${bgColor}; border-radius: 3px;">
                    <span style="color: ${textColor};">
                        ${isExtra ? '➕' : '✅'} ${asset.id} (SN: ${asset.serial || 'N/A'})
                        ${isExtra ? ' <span style="font-size: 10px;">(EXTRA)</span>' : ''}
                    </span>
                    <button class="btn btn-warning" style="padding: 2px 6px; font-size: 10px;" onclick="unassignSpecificAsset(${eventId}, '${asset.id}', '${modelGroup.brand}', '${modelGroup.model}')">Unprepare</button>
                </div>
            `;
        });
        assignedContainer.innerHTML = content;
    }
}

function updateAllAssetsSection(event, eventId) {
  // This container DOES exist in your modal markup:
  // <div id="all-assigned-assets" ...></div>
  const container = document.getElementById("all-assigned-assets");
  if (!container) return;

  let content = "";

  // Rebuild the “All Assets Assigned to Event” inner list (header stays outside this div)
  if (event.assetsByDepartment && Object.keys(event.assetsByDepartment).length > 0) {
    Object.keys(event.assetsByDepartment).forEach((dept) => {
      const deptAssets = event.assetsByDepartment[dept] || [];

      // Only show real assets here (ignore [MODEL] rows)
      const nonModelAssets = deptAssets
        .filter((a) => a && a.id && !a.id.startsWith("[MODEL]"))
        .sort((a, b) => compareByDisplayName(assetDisplaySortName(a), assetDisplaySortName(b)));

      if (nonModelAssets.length > 0) {
        content += `
          <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;background:#f1f3f4;border-bottom:1px solid #e9ecef;cursor:pointer;"
               onclick="togglePrepareSection('assigned-dept-${dept}')">
            <div style="font-weight:500;font-size:13px;">${dept} Department (${nonModelAssets.length} assets)</div>
            <span class="toggle-icon" style="font-size:14px;font-weight:bold;color:#666;">▼</span>
          </div>
          <div id="assigned-dept-${dept}" style="display:block;">
        `;
      }

      nonModelAssets.forEach((asset) => {
        const assetId = asset.id;
        const custom = parseCustomAsset(assetId, asset);
        const isBulk = !!asset.isBulk;

        const isPrepared = Array.isArray(event.actuallyPrepared) && event.actuallyPrepared.includes(assetId);
        const isReturned = Array.isArray(event.returnedItems) && event.returnedItems.includes(assetId);
        const isCollected = custom && custom.type === 'LOAN' && Array.isArray(event.customCollected) && event.customCollected.includes(assetId);
        const isExtra = Array.isArray(event.extraAssets) && event.extraAssets.includes(assetId);

        const statusIcon = isReturned ? "↩️" : (isPrepared ? "✅" : (isCollected ? "" : "⏳"));
        const statusColor = isReturned ? "#dc3545" : (isPrepared ? "#28a745" : (isCollected ? "#17a2b8" : "#ffc107"));
        const statusText = isReturned ? "Returned" : (isPrepared ? "Prepared" : (isCollected ? "Collected" : "Pending"));

        const extraBadge = isExtra
          ? '<span style="background:#fff3cd;color:#856404;padding:2px 6px;border-radius:3px;font-size:10px;margin-left:10px;">EXTRA</span>'
          : "";

        const safeAssetId = encodeURIComponent(assetId);
        const safeEncodedId = escapeHtmlAttr(safeAssetId);
        const displayName = custom
          ? customAssetDisplayName(custom)
          : (isBulk ? (asset.name || `${asset.brand || ''} ${asset.model || ''}`.trim() || 'Bulk quantity item') : assetId);
        const detailText = custom
          ? (custom.type === 'LOAN' ? custom.company : '')
          : (isBulk ? (asset.description || `Qty: ${asset.quantity || 1}`) : (asset.name || ""));
        const typeBadge = custom ? customAssetTypeBadge(custom) : '';
        const prefix = custom || isBulk ? '' : `${statusIcon} `;

        let actionButton = "";
        if (isReturned) {
          actionButton = '<span style="color:#dc3545;font-size:11px;">Returned</span>';
        } else if (custom && custom.type === 'LOAN') {
          if (isPrepared) {
            actionButton = `
              <button class="btn btn-warning asset-action-btn" data-event-id="${eventId}" data-asset-id="${safeEncodedId}" data-action="unprepare" style="padding:4px 8px;font-size:11px;">Unprepare</button>
              <button class="btn btn-secondary btn-sm" onclick="uncollectCustomAsset(${eventId}, '${escapeJs(safeAssetId)}')" style="padding:4px 8px;font-size:11px;">Uncollect</button>
            `;
          } else if (isCollected) {
            actionButton = `
              <button class="btn btn-success asset-action-btn" data-event-id="${eventId}" data-asset-id="${safeEncodedId}" data-action="prepare" style="padding:4px 8px;font-size:11px;">Prepare</button>
              <button class="btn btn-secondary btn-sm" onclick="uncollectCustomAsset(${eventId}, '${escapeJs(safeAssetId)}')" style="padding:4px 8px;font-size:11px;">Uncollect</button>
            `;
          } else {
            actionButton = `<button class="btn btn-primary btn-sm" onclick="collectCustomAsset(${eventId}, '${escapeJs(safeAssetId)}')" style="padding:4px 8px;font-size:11px;">Collect</button>`;
          }
        } else if (custom) {
          actionButton = isPrepared
            ? `<button class="btn btn-warning asset-action-btn" data-event-id="${eventId}" data-asset-id="${safeEncodedId}" data-action="unprepare" style="padding:4px 8px;font-size:11px;">Unprepare</button>`
            : `<button class="btn btn-success asset-action-btn" data-event-id="${eventId}" data-asset-id="${safeEncodedId}" data-action="prepare" style="padding:4px 8px;font-size:11px;">Prepare</button>`;
        } else if (isPrepared || isBulk) {
          actionButton = `
            <button class="btn btn-warning asset-action-btn"
                    data-event-id="${eventId}"
                    data-asset-id="${safeEncodedId}"
                    data-action="unprepare"
                    style="padding:4px 8px;font-size:11px;">Unprepare</button>
          `;
        } else {
          actionButton = `
            <button class="btn btn-success asset-action-btn"
                    data-event-id="${eventId}"
                    data-asset-id="${safeEncodedId}"
                    data-action="prepare"
                    style="padding:4px 8px;font-size:11px;">Prepare</button>
          `;
        }

        content += `
          <div style="padding:8px 12px;border-bottom:1px solid #f1f1f1;display:flex;justify-content:space-between;align-items:center;">
            <div>
              <span style="font-weight:500;">${prefix}${escapeHtml(displayName)} ${typeBadge}</span>
              <span style="color:#666;font-size:12px;margin-left:10px;">${escapeHtml(detailText || "")}</span>
              ${extraBadge}
              <div style="color:${statusColor};font-size:11px;margin-top:2px;">${statusText}</div>
            </div>
            <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;">${actionButton}</div>
          </div>
        `;
      });

      if (nonModelAssets.length > 0) {
        content += `</div>`;
      }
    });
  } else {
    content =
      '<p style="text-align:center;color:#666;padding:20px;">No individual assets assigned to this event.</p>';
  }

  container.innerHTML = content;
}

async function updateAssetListSection(eventId) {
    try {
        const response = await apiCall(`/api/events/${eventId}`);
        const event = response.data;
        
        // Update Event Summary
        updateEventSummary(event);
        
        // Update Model Groups sections
        updateModelGroupsSection(event, eventId);
        
        // Update the "All Assets Assigned to Event" section
        updateAllAssetsSection(event, eventId);
        
        // Ensure the input stays focused
        const input = document.getElementById('universalAssetInput');
        if (input) {
            setTimeout(() => input.focus(), 100);
        }
        
    } catch (error) {
        console.error('Error updating asset list section:', error);
    }
}


function showFeedback(feedbackDiv, type, message) {
    const colors = {
        'success': { bg: '#d4edda', color: '#155724', border: '#c3e6cb' },
        'error': { bg: '#f8d7da', color: '#721c24', border: '#f5c6cb' },
        'warning': { bg: '#fff3cd', color: '#856404', border: '#ffeaa7' },
        'info': { bg: '#d1ecf1', color: '#0c5460', border: '#bee5eb' }
    };
    
    const style = colors[type] || colors.info;
    
    feedbackDiv.innerHTML = `
        <div style="
            background: ${style.bg}; 
            color: ${style.color}; 
            border: 1px solid ${style.border}; 
            padding: 10px; 
            border-radius: 4px; 
            font-size: 14px;
            display: flex;
            align-items: center;
            justify-content: space-between;
        ">
            <span>${message}</span>
        </div>
    `;
}

function clearUniversalInput() {
    const input = document.getElementById('universalAssetInput');
    const feedbackDiv = document.getElementById('universal-asset-feedback');
    
    input.value = '';
    feedbackDiv.innerHTML = '';
    input.focus();
}

function clearUniversalFeedback() {
    const feedbackDiv = document.getElementById('universal-asset-feedback');
    feedbackDiv.innerHTML = '';
}

function refreshPrepareUiAfterAssetChange(eventId, delay = 250) {
    schedulePrepareUiSync(eventId, delay);
}

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


function createReturnEventCard(event) {
  const card = document.createElement("div");
  card.className = `event-card ${getEventStateClass(event.state)}`;

  // Helper function to escape HTML
  const escapeHtml = (str) => {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  };

  const dateRange =
    event.startDate === event.endDate
      ? formatDate(event.startDate)
      : `${formatDate(event.startDate)} - ${formatDate(event.endDate)}`;

  const returnedCount = Number(event.returnedCount || 0);
  const totalCount = Math.max(getEventReturnTotalCount(event), returnedCount + getEventReturnableCount(event));

  card.innerHTML = `
      <div class="event-header">
          <div style="display: flex; align-items: center; gap: 8px;">
              <div class="event-id">ID: ${event.id}</div>
              <span style="padding: 2px 8px; border-radius: 12px; font-size: 10px; font-weight: bold; ${event.tag === 'dry hire' ? 'background: #17a2b8; color: white;' : 'background: #28a745; color: white;'}">
                  ${event.tag === 'dry hire' ? 'DRY HIRE' : 'EVENT'}
              </span>
          </div>
          <div class="event-state ${getEventStateClass(event.state)}">${escapeHtml(event.state)}</div>
      </div>
      <div class="event-title">${escapeHtml(event.name)}</div>
      <div class="event-date">${escapeHtml(dateRange)}</div>
      <div style="margin: 15px 0;">
          <small style="color: #666;">${returnedCount}/${totalCount} assets returned</small>
      </div>
      <div class="event-actions">
          <button class="btn btn-primary" onclick="viewEvent(${event.id})">View Assets</button>
          <button class="btn btn-warning" onclick="openReturnAssetsModalWithEvent(${event.id})">Return</button>
      </div>
  `;

  return card;
}

async function openReturnAssetsModalWithEvent(eventId) {
    try {
        // Open the return assets modal
        await openReturnAssetsModal();
        
        // Wait a short moment for the modal to render
        setTimeout(() => {
            // Pre-select the event in the dropdown
            const eventSelect = document.getElementById('returnEventSelect');
            if (eventSelect) {
                eventSelect.value = eventId;
                // Trigger the change event to load the assets
                loadEventAssetsForReturn();
            }
        }, 100);
        
    } catch (error) {
        showNotification('error', 'Failed to open return modal');
        console.error('Error opening return modal with pre-selected event:', error);
    }
}

async function openReturnAssetsModal() {
    try {
        const response = await apiCall('/api/events');
        
        const returnableEvents = response.data.filter(event => {
            return getEventReturnableCount(event) > 0 && event.state !== 'Closed';
        });

        let content = `
            <div class="return-assets-interface">
                <!-- Event Selection -->
                <div style="background: #f8f9fa; padding: 20px; border-radius: 8px; margin-bottom: 25px;">
                    <h4 style="margin-bottom: 15px; color: #495057;">Select Event to Return Assets From</h4>
                    <div class="form-group">
                        <select class="form-input" id="returnEventSelect" onchange="loadEventAssetsForReturn()">
                            <option value="">Select an event...</option>
        `;

        sortEventsStartDateFutureTop(returnableEvents).forEach(event => {
            const dateRange = event.startDate === event.endDate 
                ? formatDate(event.startDate)
                : `${formatDate(event.startDate)} - ${formatDate(event.endDate)}`;
            
            const statusBadge = event.state === 'Overdue' ? ' 🔴 OVERDUE' : '';
            
            const totalUnreturned = getEventReturnableCount(event);
            
            content += `
                <option value="${event.id}">
                    Event ${event.id}: ${event.name} (${totalUnreturned} assets to return) • ${dateRange}${statusBadge}
                </option>
            `;
        });

        content += `
                        </select>
                    </div>
                    <div id="event-summary" style="display: none; margin-top: 15px; padding: 15px; background: white; border-radius: 6px; border: 1px solid #e9ecef;">
                        <!-- Event summary will be populated when event is selected -->
                    </div>
                </div>

                <!-- Assets to Return (hidden until event is selected) -->
                <div id="assets-return-section" style="display: none;">
                    <!-- Manual Return -->
                    <div style="margin-bottom: 24px; padding-bottom: 20px; border-bottom: 2px solid #e9ecef;">
                        <h4 style="color: #495057; margin-bottom: 15px;">Manual Return</h4>
                        <p style="color: #666; font-size: 14px; margin-bottom: 15px;">Scan or enter any asset ID to return it</p>
                        <div class="form-group" style="display: flex; gap: 10px; flex-wrap: wrap;">
                            <input type="text" class="form-input" id="manualReturnAssetIdNew" 
                                   placeholder="Enter Asset ID or Serial Number..." 
                                   onkeypress="if(event.key==='Enter') returnManualAssetNew()"
                                   autocomplete="off"
                                   style="flex: 1 1 260px;">
                            <button type="button" class="btn btn-warning" onclick="returnManualAssetNew()">Return Asset</button>
                            ${scannerButtonHtml('scanForReturn()')}
                        </div>
                    </div>

                    <h4 style="color: #495057; margin-bottom: 15px;">Assets Available for Return</h4>
                    <div id="return-assets-list">
                        <!-- Assets will be populated when event is selected -->
                    </div>
                </div>

                <!-- Actions -->
                <div class="modal-actions" style="margin-top: 30px; text-align: right; padding-top: 20px; border-top: 2px solid #e9ecef;">
                    <button class="btn btn-secondary" onclick="closeModal('returnAssetsModalNew')">Close</button>
                </div>
            </div>
        `;

        document.getElementById('returnAssetsContentNew').innerHTML = content;
        openModal('returnAssetsModalNew');
        
    } catch (error) {
        showNotification('error', 'Failed to load return assets interface');
        console.error('Error loading return assets modal:', error);
    }
}

async function loadEventAssetsForReturn() {
    const selectElement = document.getElementById('returnEventSelect');
    const eventId = selectElement?.value;
    
    if (!eventId) {
        document.getElementById('event-summary').style.display = 'none';
        document.getElementById('assets-return-section').style.display = 'none';
        return;
    }

    try {
        const response = await apiCall(`/api/events/${eventId}`);
        const event = response.data;

        const returnAssets = [];
        if (event.assetsByDepartment) {
            Object.entries(event.assetsByDepartment).forEach(([dept, deptAssets]) => {
                (deptAssets || []).forEach(asset => {
                    if (!asset || !asset.id || String(asset.id).startsWith('[MODEL]')) return;
                    returnAssets.push({ ...asset, department: asset.department || dept });
                });
            });
        }

        const totalReturnedIncludingCustom = returnAssets
            .filter(asset => asset.status === 'returned')
            .reduce((sum, asset) => sum + Number(asset.quantity || 1), 0);
        const remainingAssets = returnAssets.filter(asset => isAssetReturnableFromEventDetail(asset, event));
        const remaining = remainingAssets.reduce((sum, asset) => sum + Number(asset.quantity || 1), 0);
        const totalAssetsIncludingCustom = Math.max(Number(event.returnableTotalCount || 0), totalReturnedIncludingCustom + remaining);

        const summaryDiv = document.getElementById('event-summary');
        summaryDiv.style.display = 'block';
        summaryDiv.innerHTML = `
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 15px; text-align: center;">
                <div>
                    <div style="font-size: 24px; font-weight: bold; color: #007bff;">${totalAssetsIncludingCustom}</div>
                    <div style="color: #6c757d; font-size: 12px;">Total Assets</div>
                </div>
                <div>
                    <div style="font-size: 24px; font-weight: bold; color: #28a745;">${totalReturnedIncludingCustom}</div>
                    <div style="color: #6c757d; font-size: 12px;">Returned</div>
                </div>
                <div>
                    <div style="font-size: 24px; font-weight: bold; color: #ffc107;">${remaining}</div>
                    <div style="color: #6c757d; font-size: 12px;">Remaining</div>
                </div>
            </div>
        `;

        const assetsSection = document.getElementById('assets-return-section');
        assetsSection.style.display = 'block';

        const byDept = {};
        remainingAssets.forEach(asset => {
            const custom = parseCustomAsset(asset.id, asset);
            const dept = normalizeDepartmentCode(custom?.department || asset.department || 'UN');
            if (!byDept[dept]) byDept[dept] = [];
            byDept[dept].push({ ...asset, parsedCustom: custom });
        });

        const deptCodes = Object.keys(byDept).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

        let assetsContent = '';

        if (deptCodes.length > 0) {
            const quickRows = deptCodes.map(dept => {
                const items = byDept[dept] || [];
                const unreturnedQty = items.reduce((sum, a) => sum + Number(a.quantity || a.parsedCustom?.quantity || 1), 0);
                return `
                    <div style="display:flex; justify-content:space-between; align-items:center; padding:8px 12px; border:1px solid #e9ecef; border-radius:8px; margin-bottom:8px; background:white;">
                        <div style="font-weight:600;">${departmentBadgeHtml(dept, true)}</div>
                        <div style="display:flex; align-items:center; gap:10px;">
                            <span style="font-size:12px; color:#6c757d;">${unreturnedQty} to return</span>
                            ${isAdminUser() ? `<button class="btn btn-success btn-sm" onclick="returnAllForDepartment(${eventId}, '${escapeJs(dept)}')">Return all</button>` : ''}
                        </div>
                    </div>
                `;
            }).join('');

            assetsContent += `
                <div style="margin-bottom:16px; padding:12px; background:#f8f9fa; border:1px solid #e9ecef; border-radius:10px;">
                    <div style="font-weight:600; margin-bottom:8px; color:#495057;">Department quick actions</div>
                    ${quickRows}
                </div>
            `;
        }

        deptCodes.forEach(dept => {
            const items = (byDept[dept] || []).sort((a, b) =>
                compareByDisplayName(assetDisplaySortName(a), assetDisplaySortName(b))
            );
            const totalQty = items.reduce((sum, a) => sum + Number(a.quantity || a.parsedCustom?.quantity || 1), 0);

            assetsContent += `
                <div class="dept-section" style="margin-bottom: 20px; border: 1px solid #e9ecef; border-radius: 8px; overflow:hidden;">
                    <div style="display:flex; justify-content:space-between; align-items:center; padding:12px 15px; background:#f1f3f4; border-bottom:1px solid #e9ecef;">
                        <h5 style="margin:0; color:#495057; font-size:14px;">${departmentBadgeHtml(dept, true)} Department</h5>
                        <div style="font-size:12px; font-weight:600; color:#ffc107;">${totalQty} to return</div>
                    </div>
                    <div style="padding:10px; background:white;">
            `;

            items.forEach((asset, index) => {
                const custom = asset.parsedCustom;
                const isBulk = asset.isBulk || String(asset.id || '').startsWith('[BULK]');
                const encodedAssetId = encodeURIComponent(asset.id);
                const rowBg = index % 2 === 0 ? '#f8f9fa' : 'white';
                let title = '';
                let subtitle = '';
                let badge = '';

                if (custom) {
                    title = customAssetDisplayName(custom);
                    badge = customAssetTypeBadge(custom);
                    subtitle = custom.type === 'LOAN' && custom.company ? `Company: ${custom.company}` : '';
                } else if (isBulk) {
                    title = `${asset.brand || ''} ${asset.model || ''}`.trim() || 'Bulk Item';
                    subtitle = `${asset.description || ''}${asset.description ? ' • ' : ''}Bulk quantity item • Qty: ${asset.quantity || 1}`;
                } else {
                    title = asset.id || 'Asset';
                    const desc = `${asset.brand || ''} ${asset.model || ''}${asset.description ? ' - ' + asset.description : ''}`.trim();
                    subtitle = [desc, asset.serial ? `SN: ${asset.serial}` : '', asset.location ? `Location: ${asset.location}` : ''].filter(Boolean).join(' • ');
                }

                assetsContent += `
                    <div class="return-asset-item" style="display:flex; justify-content:space-between; align-items:center; gap:12px; padding:12px; background:${rowBg}; border-radius:6px; margin-bottom:8px; border:1px solid #eef0f2;">
                        <div style="min-width:0; flex:1;">
                            <div style="font-weight:500; font-size:14px; color:#333; overflow-wrap:anywhere;">${escapeHtml(title)} ${badge}</div>
                            ${subtitle ? `<div style="color:#666; font-size:11px; margin-top:2px; overflow-wrap:anywhere;">${escapeHtml(subtitle)}</div>` : ''}
                        </div>
                        <div style="display:flex; align-items:center; gap:8px; flex-shrink:0;">
                            <button class="btn btn-warning return-asset-btn" data-return-event-id="${eventId}" data-return-asset-id="${escapeHtmlAttr(encodedAssetId)}" style="padding:6px 12px; font-size:12px;" onclick="returnSpecificAssetNew(${eventId}, '${escapeJs(encodedAssetId)}', this)">Return</button>
                        </div>
                    </div>
                `;
            });

            assetsContent += '</div></div>';
        });

        if (!assetsContent) {
            assetsContent = '<p style="text-align: center; color: #666; padding: 40px;">No assets available for return.</p>';
        }

        document.getElementById('return-assets-list').innerHTML = assetsContent;
        
    } catch (error) {
        showNotification('error', 'Failed to load event assets');
        console.error('Error loading event assets for return:', error);
    }
}


function decodeReturnAssetArgument(value) {
    try {
        return decodeURIComponent(String(value || ''));
    } catch (error) {
        return String(value || '');
    }
}

function findReturnAssetButton(eventId, assetId) {
    const encodedAssetId = encodeURIComponent(String(assetId || ''));
    return Array.from(document.querySelectorAll('.return-asset-btn')).find(button =>
        button.dataset.returnEventId === String(eventId) &&
        button.dataset.returnAssetId === encodedAssetId
    ) || null;
}

async function returnSpecificAssetNew(eventId, assetId, buttonElement = null) {
    const decodedAssetId = decodeReturnAssetArgument(assetId);

    // Prevent multiple clicks
    buttonElement = buttonElement || findReturnAssetButton(eventId, decodedAssetId);
    if (buttonElement && buttonElement.disabled) {
        return;
    }
    
    try {
        // Disable the button immediately
        if (buttonElement) {
            buttonElement.disabled = true;
            buttonElement.style.opacity = '0.5';
            buttonElement.textContent = 'Returning...';
        }
        
        await apiCall(`/api/events/${eventId}/return`, 'POST', { assetId: decodedAssetId });
        showNotification('success', `${customAssetLabelFromId(decodedAssetId)} returned successfully`);
        
        // Remove the asset from the UI with animation
        const parentItem = buttonElement ? buttonElement.closest('.return-asset-item') : null;
        if (parentItem) {
            parentItem.style.transition = 'opacity 0.3s ease';
            parentItem.style.opacity = '0.3';
            parentItem.style.pointerEvents = 'none';
            
            setTimeout(() => {
                if (parentItem.parentNode) {
                    parentItem.parentNode.removeChild(parentItem);
                }
                // Refresh the event summary after removal
                setTimeout(() => {
                    loadEventAssetsForReturn();
                }, 100);
            }, 300);
        } else {
            // Fallback refresh if we can't find the specific element
            setTimeout(() => {
                loadEventAssetsForReturn();
            }, 500);
        }
        
        // Update overdue counter
        const response = await apiCall('/api/events');
        const overdueCount = countOverdueEvents(response.data);
        updateOverdueCounter(overdueCount);
        
    } catch (error) {
        showNotification('error', `Failed to return asset: ${error.message}`);
        console.error('Error returning asset:', error);
        
        // Re-enable button on error
        if (buttonElement) {
            buttonElement.disabled = false;
            buttonElement.style.opacity = '1';
            buttonElement.textContent = 'Return';
        }
    }
}

async function returnAllForDepartment(eventId, department) {
  if (!isAdminUser()) {
      showNotification('error', 'Admin privileges required to use Return all');
      return;
  }

  try {
      // Best-effort disable of the clicked button
      const btn = document.querySelector(`[onclick*="returnAllForDepartment(${eventId}, '${department.replace("'", "\\'")}')"]`);
      if (btn) {
          btn.disabled = true;
          btn.textContent = 'Returning...';
          btn.style.opacity = '0.6';
      }

      const res = await apiCall(`/api/events/${eventId}/return-department`, 'POST', { department });

      // Prefer explicit count, then top-level returned[], then data.returned[]
      const returnedList =
        Array.isArray(res?.returned) ? res.returned :
        Array.isArray(res?.data?.returned) ? res.data.returned : [];

      const count =
        Number.isFinite(res?.count) ? res.count :
        Number.isFinite(res?.data?.count) ? res.data.count :
        returnedList.length;

      // Use a consistent success message
      showNotification('success', `${count} item(s) returned for ${department}`);


      // Refresh views
      loadEventAssetsForReturn();
      if (document.getElementById('return-section').classList.contains('active')) {
          loadReturnEvents();
      }
      if (document.getElementById('dashboard-section').classList.contains('active')) {
          loadDashboard();
      }
      if (document.getElementById('events-section').classList.contains('active')) {
          loadAllEvents();
      }
  } catch (error) {
      console.error('Error returning department assets:', error);
      showNotification('error', `Failed to return all for ${department}`);
  }
}

async function returnManualAssetNew() {
    const eventSelect = document.getElementById('returnEventSelect');
    const assetInput = document.getElementById('manualReturnAssetIdNew');
    const eventId = eventSelect.value;
    let assetId = normalizeScannedIdentifier(assetInput.value);
    
    if (!eventId) {
        showNotification('warning', 'Please select an event first');
        return;
    }
    
    if (!assetId) {
        showNotification('warning', 'Please enter an asset ID');
        return;
    }

    try {
      const inventoryAssets = await ensureAssetsLoaded();
      assetId = getAssetIdFromIdentifier(assetId, inventoryAssets);
      assetInput.value = assetId;
    } catch (error) {
      console.warn('Could not resolve scanned return identifier locally:', error);
    }
    
    try {
        await apiCall(`/api/events/${eventId}/return`, 'POST', { assetId });
        showNotification('success', `${assetId} returned successfully`);
        
        // Clear input and focus back on it
        assetInput.value = '';
        assetInput.focus();
        
        // Refresh the event assets display
        loadEventAssetsForReturn();
        
        // Update overdue counter
        const response = await apiCall('/api/events');
        const overdueCount = countOverdueEvents(response.data);
        updateOverdueCounter(overdueCount);
        
    } catch (error) {
        showNotification('error', `Failed to return asset: ${error.message}`);
    }
}

let transferOptionsCache = null;
let transferCandidateCache = [];

async function loadTransferHistory() {
  const container = document.getElementById("transfer-history");
  if (!container) return;

  container.innerHTML = '<div class="loading">Loading transfer options...</div>';

  try {
    // Keep event states fresh so Ready events become Ongoing and ended events become Overdue.
    try { await apiCall('/api/events/update-states', 'POST'); } catch (e) { console.warn('State refresh skipped:', e); }

    const response = await apiCall('/api/transfers/options');
    transferOptionsCache = response.data || { sourceEvents: [], targetEvents: [] };

    const overdueCount = (transferOptionsCache.sourceEvents || []).filter(e => e.state === 'Overdue').length;
    updateOverdueCounter(overdueCount);

    renderTransferWorkspace();
    populateTransferDropdowns(transferOptionsCache);

    const sourceSelect = document.getElementById('transferSourceSelect');
    const targetSelect = document.getElementById('transferTargetSelect');

    if (sourceSelect && targetSelect && sourceSelect.value && targetSelect.value) {
      await loadTransferCandidates();
    }
  } catch (error) {
    container.innerHTML = `
      <div style="padding:30px;text-align:center;color:#a00;">
        Failed to load transfer options: ${escapeHtml(error.message || String(error))}
        <br><br>
        <button class="btn btn-primary" onclick="loadTransferHistory()">Retry</button>
      </div>
    `;
  }
}










async function openManualTransferModal() {
  if (!transferOptionsCache) {
    const response = await apiCall('/api/transfers/options');
    transferOptionsCache = response.data || { sourceEvents: [], targetEvents: [] };
  }
  populateTransferDropdowns(transferOptionsCache);
  openModal('transferModal');
}

async function viewEvent(eventId) {
  try {
    window.currentViewedEventId = eventId;
    window.currentEventDetailsMode = "view";
    const response = await apiCall(`/api/events/${eventId}`);
    const event = response.data;
    
    // Store the current event ID and data for the delivery order button
    window.currentEventId = eventId;
    window.currentEventData = event;
    

    document.getElementById(
      "eventDetailsTitle"
    ).textContent = `${event.tag === 'dry hire' ? 'Dry Hire' : 'Event'} ${event.id}: ${event.name}`;

    const formatDate = (dateStr) => {
      // Convert server date strings before using the browser Date parser.
      if (dateStr && dateStr.includes('/')) {
        // Convert YYYY/MM/DD to YYYY-MM-DD for proper parsing
        const dateParts = dateStr.split('/');
        if (dateParts.length === 3) {
          const [year, month, day] = dateParts;
          const isoDate = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
          return new Date(isoDate).toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            year: "numeric",
          });
        }
      }
      // Fallback for other date formats
      return new Date(dateStr).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
    };

    const dateRange =
      event.startDate === event.endDate
        ? formatDate(event.startDate)
        : `${formatDate(event.startDate)} - ${formatDate(event.endDate)}`;

    // Helper function to escape HTML
    const escapeHtml = (str) => {
      if (!str) return '';
      const div = document.createElement('div');
      div.textContent = str;
      return div.innerHTML;
    };

    let content = `
        <!-- Event Summary Card -->
        <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 20px; border-radius: 12px; margin-bottom: 25px;">
            <div style="display: grid; grid-template-columns: 1fr auto auto; gap: 20px; align-items: center;">
                <div>
                    <h3 style="margin: 0 0 8px 0; font-size: 1.4rem;">${escapeHtml(event.name)}</h3>
                    <div style="opacity: 0.9; font-size: 14px;">📅 ${dateRange}</div>
                </div>
                <div style="text-align: center;">
                    <div style="font-size: 24px; font-weight: bold; margin-bottom: 4px;">${event.totalPrepared}/${event.totalAssets}</div>
                    <div style="font-size: 12px; opacity: 0.9;">Assets Ready</div>
                </div>
                <div style="text-align: center;">
                    <span style="background: rgba(255,255,255,0.2); padding: 8px 16px; border-radius: 20px; font-size: 13px; font-weight: 500;">
                        ${event.state}
                    </span>
                </div>
            </div>
        </div>

        <!-- Progress Overview -->
        <div style="background: #f8f9fa; padding: 15px; border-radius: 8px; margin-bottom: 25px;">
            <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; text-align: center;">
                <div>
                    <div style="font-size: 20px; font-weight: bold; color: #007bff;">${event.totalAssets}</div>
                    <div style="font-size: 12px; color: #666;">Required</div>
                </div>
                <div>
                    <div style="font-size: 20px; font-weight: bold; color: #28a745;">${event.totalPrepared}</div>
                    <div style="font-size: 12px; color: #666;">Prepared</div>
                </div>
                <div>
                    <div style="font-size: 20px; font-weight: bold; color: #dc3545;">${event.totalReturned}</div>
                    <div style="font-size: 12px; color: #666;">Returned</div>
                </div>
            </div>
        </div>
    `;

    content += renderEventNotesFilesSection(event);

    // Model Requirements Section (Compact)
    if (event.modelGroups && Object.keys(event.modelGroups).length > 0) {
      content += '<div style="margin-bottom: 25px;"><h4 style="color: #495057; margin-bottom: 15px; font-size: 16px;">📦 Model Requirements</h4>';

      // Group by department
      const modelsByDept = {};
      Object.values(event.modelGroups).forEach((model) => {
        if (!modelsByDept[model.department]) {
          modelsByDept[model.department] = [];
        }
        modelsByDept[model.department].push(model);
      });

      Object.keys(modelsByDept).sort().forEach((dept) => {
        const models = modelsByDept[dept];
        
        content += `
            <div style="border: 1px solid #e9ecef; border-radius: 8px; margin-bottom: 15px; overflow: hidden;">
                <div style="display: flex; justify-content: space-between; align-items: center; padding: 10px 15px; background: #f8f9fa; border-bottom: 1px solid #e9ecef; cursor: pointer;" onclick="toggleViewSection('model-dept-${dept}')">
                    <div style="font-weight: 500; font-size: 14px;">${escapeHtml(dept)} Department</div>
                    <span class="toggle-icon" style="font-size: 14px; font-weight: bold; color: #666;">▼</span>
                </div>
                <div id="model-dept-${dept}" style="display: block;">
        `;

        models.forEach((model, index) => {
          const statusIcon = getModelStatusIcon(model.status);
          const assignedCount = getPreparedQuantity(model);
          const modelId = `model-${dept}-${index}`;
          const progressPercent = model.requiredQuantity > 0 ? Math.round((assignedCount / model.requiredQuantity) * 100) : 0;
          
          // Fix status determination - if we have enough or more assets, it should be READY
          let statusColor = '#6c757d';
          let displayStatus = model.status;
          
          if (assignedCount >= model.requiredQuantity && model.status !== 'returned') {
            displayStatus = 'ready';
            statusColor = '#28a745';
          } else if (model.status === 'ready') {
            statusColor = '#28a745';
          } else if (model.status === 'partial') {
            statusColor = '#ffc107';
          } else if (model.status === 'returned') {
            statusColor = '#dc3545';
          }

          content += `
                <div style="padding: 12px 15px; border-bottom: 1px solid #f1f1f1; cursor: pointer; transition: background-color 0.2s;"
                     class="model-toggle" data-model-id="${modelId}" 
                     onmouseover="this.style.backgroundColor='#f8f9fa'" 
                     onmouseout="this.style.backgroundColor='white'">
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                        <div style="flex: 1;">
                            <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 6px;">
                                <span style="font-weight: 500; font-size: 14px;">${statusIcon} ${model.requiredQuantity}x ${escapeHtml(model.brand)} ${escapeHtml(model.model)}</span>
                                <span style="color: ${statusColor}; font-size: 11px; font-weight: 500; text-transform: uppercase;">${displayStatus}</span>
                            </div>
                            ${model.description ? `<div style="color: #666; font-size: 12px; margin-bottom: 6px;">${escapeHtml(model.description)}</div>` : ''}
                            <div style="display: flex; align-items: center; gap: 15px;">
                                <div style="flex: 1; max-width: 200px;">
                                    <div style="background: #e9ecef; height: 4px; border-radius: 2px; overflow: hidden;">
                                        <div style="background: ${statusColor}; height: 100%; width: ${Math.min(progressPercent, 100)}%; transition: width 0.3s ease;"></div>
                                    </div>
                                </div>
                                <span style="font-size: 12px; color: #666; white-space: nowrap;">${assignedCount}/${model.requiredQuantity}</span>
                            </div>
                        </div>
                        <div style="margin-left: 15px;">
                            <span class="toggle-icon" data-model-id="${modelId}" style="font-size: 14px; color: #999; cursor: pointer; padding: 4px; border-radius: 3px; transition: background-color 0.2s;" onmouseover="this.style.backgroundColor='rgba(0,0,0,0.1)'" onmouseout="this.style.backgroundColor='transparent'">▼</span>
                        </div>
                    </div>
                    
                    <div id="${modelId}" class="model-details" style="display: none; margin-top: 12px; padding-top: 12px; border-top: 1px solid #f1f1f1;">
          `;

          if (model.assignedAssets.length > 0) {
            content += '<div style="display: flex; flex-wrap: wrap; gap: 6px;">';
            model.assignedAssets.forEach((asset) => {
              // Check if this specific asset is returned
              const assetStatusIcon = (asset.status === "returned" || (event.returnedItems && event.returnedItems.includes(asset.id))) ? "↩️" : "✅";
              const assetBgColor = (asset.status === "returned" || (event.returnedItems && event.returnedItems.includes(asset.id))) ? "#fff3cd" : "#d4edda";
              const assetTextColor = (asset.status === "returned" || (event.returnedItems && event.returnedItems.includes(asset.id))) ? "#856404" : "#155724";

              content += `
                    <span style="background: ${assetBgColor}; color: ${assetTextColor}; padding: 4px 8px; border-radius: 4px; font-size: 11px; font-weight: 500;">
                        ${assetStatusIcon} ${escapeHtml(asset.id)}
                    </span>
              `;
            });
            content += '</div>';
          } else {
            content += '<div style="color: #999; font-style: italic; font-size: 12px;">No assets assigned yet</div>';
          }

          content += '</div></div>';
        });

        content += '</div><div>';
      });

      content += '</div>';
    }

    // Individual Assets Section (Compact)
    if (event.assetsByDepartment && Object.keys(event.assetsByDepartment).length > 0) {
      // Check if there are any individual assets (non-model)
      let hasIndividualAssets = false;
      Object.values(event.assetsByDepartment).forEach(assets => {
        if (assets.some(asset => !asset.id.startsWith('[MODEL]'))) {
          hasIndividualAssets = true;
        }
      });

      if (hasIndividualAssets) {
        content += `
          <div style="margin-bottom: 25px;">
            <div style="display: flex; justify-content: space-between; align-items: center; padding: 15px; background: #f8f9fa; border-radius: 8px 8px 0 0; border-bottom: 1px solid #e9ecef; cursor: pointer;" onclick="toggleViewSection('individual-assets')">
              <h4 style="margin: 0; color: #495057; font-size: 16px;">📋 Individual Assets</h4>
              <span class="toggle-icon" style="font-size: 18px; font-weight: bold; color: #666;">▶</span>
            </div>
            <div id="individual-assets" style="display: none; border: 1px solid #e9ecef; border-top: none; border-radius: 0 0 8px 8px;">
        `;

        Object.keys(event.assetsByDepartment).sort().forEach((dept) => {
          const assets = event.assetsByDepartment[dept];
          const individualAssets = assets
            .filter(asset => !asset.id.startsWith('[MODEL]'))
            .sort((a, b) => compareByDisplayName(assetDisplaySortName(a), assetDisplaySortName(b)));
          
          if (individualAssets.length > 0) {
            content += `
                <div style="border-bottom: 1px solid #f1f1f1; overflow: hidden;">
                    <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px 15px; background: #f8f9fa; border-bottom: 1px solid #e9ecef; cursor: pointer;" onclick="toggleViewSection('dept-${dept}')">
                        <div style="font-weight: 500; font-size: 14px;">${escapeHtml(dept)} Department (${individualAssets.length})</div>
                        <span class="toggle-icon" style="font-size: 14px; font-weight: bold; color: #666;">▼</span>
                    </div>
                    <div id="dept-${dept}" style="display: block; padding: 10px 15px;">
                        <div style="display: grid; gap: 8px;">
            `;

            individualAssets.forEach((asset) => {
              let statusIcon = '📋';
              let statusColor = '#6c757d';
              let statusText = 'Assigned';
              
              // Check status in the correct order: returned first, then prepared
              if (asset.status === 'returned' || (event.returnedItems && event.returnedItems.includes(asset.id))) {
                statusIcon = '↩️';
                statusColor = '#dc3545';
                statusText = 'Returned';
              } else if (asset.status === 'prepared' || (event.actuallyPrepared && event.actuallyPrepared.includes(asset.id))) {
                statusIcon = '✅';
                statusColor = '#28a745';
                statusText = 'Prepared';
              }

              const extraBadge = asset.isExtra ? 
                '<span style="background: #fff3cd; color: #856404; padding: 2px 6px; border-radius: 3px; font-size: 9px; margin-left: 8px; font-weight: 500;">EXTRA</span>' : '';
              const custom = parseCustomAsset(asset.id, asset);
              const displayId = custom ? customAssetDisplayName(custom) : asset.id;
              const secondaryLine = custom ? (custom.type === 'LOAN' ? custom.company : '') : (asset.name || '');
              const customBadge = custom ? customAssetTypeBadge(custom) : '';

              content += `
                    <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; background: #f8f9fa; border-radius: 6px;">
                        <div style="flex: 1;">
                            <div style="font-weight: 500; font-size: 13px; margin-bottom: 2px;">
                                ${statusIcon} ${escapeHtml(displayId)}${customBadge}${extraBadge}
                            </div>
                            <div style="color: #666; font-size: 11px;">${escapeHtml(secondaryLine || '')}</div>
                            ${!custom && asset.serial ? `<div style="color: #999; font-size: 10px;">SN: ${escapeHtml(asset.serial)}</div>` : ''}
                        </div>
                        <div style="text-align: right;">
                            <span style="color: ${statusColor}; font-size: 11px; font-weight: 500;">${statusText}</span>
                            ${asset.location ? `<div style="color: #999; font-size: 10px;">📍 ${escapeHtml(asset.location)}</div>` : ''}
                        </div>
                    </div>
              `;
            });

            content += '</div></div></div>';
          }
        });

        content += '</div>';
      }
    }

    document.getElementById("eventDetailsContent").innerHTML = content;

    // Add event listeners for model toggles with better event handling
    const eventDetailsContent = document.getElementById("eventDetailsContent");
    
    // Remove any existing listeners to prevent duplicates
    const existingListener = eventDetailsContent.handleModelToggle;
    if (existingListener) {
      eventDetailsContent.removeEventListener('click', existingListener);
    }
    
    function handleModelToggle(e) {
      // Check if clicked on toggle icon specifically
      if (e.target.classList.contains('toggle-icon')) {
        const modelId = e.target.getAttribute('data-model-id');
        if (modelId) {
          e.preventDefault();
          e.stopPropagation();
          toggleModelDetailsInView(modelId);
          return;
        }
      }
      
      // Check if clicked on model toggle area
      let toggleElement = null;
      if (e.target.classList.contains('model-toggle')) {
        toggleElement = e.target;
      } else if (e.target.closest('.model-toggle')) {
        toggleElement = e.target.closest('.model-toggle');
      }
      
      if (toggleElement) {
        const modelId = toggleElement.getAttribute('data-model-id');
        if (modelId) {
          e.preventDefault();
          e.stopPropagation();
          toggleModelDetailsInView(modelId);
        }
      }
    }
    
    // Store the listener reference for cleanup
    eventDetailsContent.handleModelToggle = handleModelToggle;
    eventDetailsContent.addEventListener('click', handleModelToggle);

    const logHTML = await createEventLogViewer(event.id, event.name, event.eventLogs || []);
    eventDetailsContent.innerHTML += logHTML;
    
    openModal("eventDetailsModal");
  } catch (error) {
    showNotification("error", "Failed to load event details");
  }
}

function toggleViewSection(sectionId) {
    const section = document.getElementById(sectionId);
    const toggleIcon = event.target.closest('[onclick]').querySelector('.toggle-icon');
    
    if (section && toggleIcon) {
        if (section.style.display === 'none') {
            section.style.display = 'block';
            toggleIcon.textContent = '▼';
        } else {
            section.style.display = 'none';
            toggleIcon.textContent = '▶';
        }
    }
}

function toggleModelDetailsInView(modelId) {
  const detailsDiv = document.getElementById(modelId);
  const toggleIcon = document.querySelector(`[data-model-id="${modelId}"].toggle-icon`);

  if (detailsDiv && toggleIcon) {
    if (detailsDiv.style.display === "none" || detailsDiv.style.display === "") {
      detailsDiv.style.display = "block";
      toggleIcon.textContent = "▲";
    } else {
      detailsDiv.style.display = "none";
      toggleIcon.textContent = "▼";
    }
  } else {
    console.warn(`Could not find elements for modelId: ${modelId}`);
    console.warn(`DetailsDiv:`, detailsDiv);
    console.warn(`ToggleIcon:`, toggleIcon);
  }
}

// Add the toggle function for expanding/collapsing model details

function normalizeMaintenanceChange(change) {
  if (!change || typeof change !== 'object') return null;

  const kind = String(change.kind || change.type || '').trim().toLowerCase();
  if (kind === 'location' || kind === 'serial') {
    const value = String(change.value || '').trim();
    return value ? { kind, value } : null;
  }

  const normalizedKind = kind === 'disposed' ? 'decommissioned' : kind;

  if (normalizedKind === 'ooc' || normalizedKind === 'missing' || normalizedKind === 'degraded' || normalizedKind === 'decommissioned') {
    const rawAction = String(change.action || '').trim().toLowerCase();
    if (['mark', 'marked'].includes(rawAction)) return { kind: normalizedKind, action: 'marked' };
    if (['clear', 'cleared', 'remove', 'removed', 'unmark', 'unmarked'].includes(rawAction)) {
      return { kind: normalizedKind, action: 'cleared' };
    }
  }

  return null;
}

function maintenanceChangeFromLegacyPart(part) {
  const text = String(part || '').trim();
  const lower = text.toLowerCase();

  if (lower.startsWith('location:')) {
    return normalizeMaintenanceChange({ kind: 'location', value: text.split(':').slice(1).join(':').trim() });
  }
  if (lower.startsWith('serial:')) {
    return normalizeMaintenanceChange({ kind: 'serial', value: text.split(':').slice(1).join(':').trim() });
  }
  if (['marked ooc', 'mark ooc', 'marked out of commission', 'mark out of commission'].includes(lower)) {
    return { kind: 'ooc', action: 'marked' };
  }
  if (['cleared ooc', 'clear ooc', 'removed ooc', 'unmarked ooc', 'unmark ooc', 'cleared out of commission', 'removed out of commission'].includes(lower)) {
    return { kind: 'ooc', action: 'cleared' };
  }
  if (['marked missing', 'mark missing'].includes(lower)) {
    return { kind: 'missing', action: 'marked' };
  }
  if (['cleared missing', 'clear missing', 'removed missing', 'unmarked missing', 'unmark missing'].includes(lower)) {
    return { kind: 'missing', action: 'cleared' };
  }
  if (['marked degraded', 'mark degraded'].includes(lower)) {
    return { kind: 'degraded', action: 'marked' };
  }
  if (['cleared degraded', 'clear degraded', 'removed degraded', 'unmarked degraded', 'unmark degraded'].includes(lower)) {
    return { kind: 'degraded', action: 'cleared' };
  }
  if (['marked decommissioned', 'mark decommissioned', 'marked disposed', 'mark disposed'].includes(lower)) {
    return { kind: 'decommissioned', action: 'marked' };
  }
  if (['cleared decommissioned', 'clear decommissioned', 'removed decommissioned', 'unmarked decommissioned', 'unmark decommissioned', 'cleared disposed', 'clear disposed', 'removed disposed', 'unmarked disposed', 'unmark disposed'].includes(lower)) {
    return { kind: 'decommissioned', action: 'cleared' };
  }

  return null;
}

function splitLegacyMaintenanceStatus(description) {
  const text = String(description || '');
  const match = text.match(/^(.*?)(?:\s*\[([^\]]*)\]\s*)$/s);
  if (!match) return { description: text, changes: [] };

  const changes = match[2]
    .split(',')
    .map(maintenanceChangeFromLegacyPart)
    .filter(Boolean);

  if (changes.length === 0) return { description: text, changes: [] };
  return { description: match[1].trimEnd(), changes };
}

function normalizeMaintenanceLogType(value, allowAssetCheck = true) {
  const raw = String(value || '').trim();
  if (!raw) return DEFAULT_MAINTENANCE_LOG_TYPE;
  const match = MAINTENANCE_LOG_TYPES.find(type => type.toLowerCase() === raw.toLowerCase());
  if (!match) return DEFAULT_MAINTENANCE_LOG_TYPE;
  if (match === ASSET_CHECK_MAINTENANCE_LOG_TYPE && !allowAssetCheck) {
    return DEFAULT_MAINTENANCE_LOG_TYPE;
  }
  return match;
}

function maintenanceLogTypeSelectHtml(id, selectedType = DEFAULT_MAINTENANCE_LOG_TYPE) {
  const selected = normalizeMaintenanceLogType(selectedType, false);
  return `
    <select id="${escapeHtmlAttr(id)}" class="form-input">
      ${USER_MAINTENANCE_LOG_TYPES.map(type => `
        <option value="${escapeHtmlAttr(type)}"${type === selected ? ' selected' : ''}>${escapeHtml(type)}</option>
      `).join('')}
    </select>
  `;
}

function maintenanceLogTypeMeta(type) {
  const normalized = normalizeMaintenanceLogType(type);
  const palette = {
    "General": { background: "#e9ecef", color: "#343a40" },
    "Preventative maintenance": { background: "#d1ecf1", color: "#0c5460" },
    "Fault": { background: "#f8d7da", color: "#721c24" },
    "Update": { background: "#e2d9f3", color: "#3d246c" },
    "Repair": { background: "#fff3cd", color: "#856404" },
    "Asset check": { background: "#d4edda", color: "#155724" }
  };
  const label = normalized === "Preventative maintenance" ? "Preventative" : normalized;
  return { normalized, label, ...(palette[normalized] || palette.General) };
}

function maintenanceLogTypeBadgeHtml(type) {
  const meta = maintenanceLogTypeMeta(type);
  return `<span style="display:inline-block;padding:4px 8px;border-radius:999px;font-size:12px;font-weight:700;white-space:nowrap;background:${meta.background};color:${meta.color};">${escapeHtml(meta.label)}</span>`;
}

function maintenanceLogTypePdfBadgeHtml(type) {
  const meta = maintenanceLogTypeMeta(type);
  return pdfInlineBadgeHtml(meta.label, meta.background, meta.color);
}

function formatMaintenanceCost(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';

  const cleaned = raw.replace(/,/g, '').replace(/^\$/, '').trim();
  if (!cleaned) return '';

  const amount = Number(cleaned);
  if (!Number.isFinite(amount)) return raw;

  return amount.toFixed(2);
}

function maintenanceCostDisplayHtml(value, emptyHtml = '-') {
  const cost = formatMaintenanceCost(value);
  return cost ? `$${escapeHtml(cost)}` : emptyHtml;
}

function normalizeMaintenanceMedia(media) {
  if (!Array.isArray(media)) return [];
  return media
    .filter(item => item && typeof item === 'object')
    .map(item => ({
      id: String(item.id || item.mediaId || ''),
      name: String(item.name || item.filename || item.originalName || 'Media'),
      kind: String(item.kind || item.type || '').toLowerCase() === 'video' ? 'video' : 'image',
      mimeType: String(item.mimeType || item.contentType || ''),
      size: Number(item.size || 0),
      url: String(item.url || (item.id ? `/api/maintenance-media/${encodeURIComponent(item.id)}` : ''))
    }))
    .filter(item => item.id && item.url);
}

function maintenanceMediaLinksHtml(media, emptyHtml = '<span style="color:#999;">—</span>') {
  const items = normalizeMaintenanceMedia(media);
  if (!items.length) return emptyHtml;

  let imageCount = 0;
  let videoCount = 0;

  return `
    <div style="display:flex;flex-wrap:wrap;gap:6px;">
      ${items.map(item => {
        const label = item.kind === 'video'
          ? `Video ${++videoCount}`
          : `Photo ${++imageCount}`;
        const title = item.name || label;
        return `
          <a
            class="maintenance-media-link"
            href="${escapeHtmlAttr(item.url)}"
            target="_blank"
            rel="noopener"
            title="${escapeHtmlAttr(title)}"
          >${escapeHtml(label)}</a>
        `;
      }).join('')}
    </div>
  `;
}

function updateMaintenanceMediaSelection(inputId, listId) {
  const input = document.getElementById(inputId);
  const list = document.getElementById(listId);
  if (!input || !list) return;

  const files = Array.from(input.files || []);
  list.innerHTML = files.map(file => `
    <span class="maintenance-media-pill" title="${escapeHtmlAttr(file.name)}">${escapeHtml(file.name)}</span>
  `).join('');
}

function maintenancePayloadToRequestData(payload, mediaInputId) {
  const input = document.getElementById(mediaInputId);
  const files = Array.from(input?.files || []);
  if (!files.length) return payload;

  const formData = new FormData();
  Object.entries(payload).forEach(([key, value]) => {
    if (value !== null && value !== undefined) {
      formData.append(key, value);
    }
  });
  files.forEach(file => formData.append('media', file));
  return formData;
}

function normalizeMaintenanceLogRecord(log) {
  if (log && typeof log === 'object' && !Array.isArray(log)) {
    return {
      id: String(log.id || log.logId || ''),
      date: String(log.date || ''),
      user: String(log.user || ''),
      description: String(log.description || ''),
      type: normalizeMaintenanceLogType(log.type || log.logType || log.maintenanceType),
      cost: formatMaintenanceCost(log.cost),
      changes: Array.isArray(log.changes)
        ? log.changes.map(normalizeMaintenanceChange).filter(Boolean)
        : [],
      source: log.source && typeof log.source === 'object' ? { ...log.source } : {},
      media: normalizeMaintenanceMedia(log.media || log.attachments)
    };
  }

  const parts = String(log || '').split('\t');
  const parsed = parts.length >= 3
    ? { date: parts[0] || '', user: parts[1] || '', description: parts.slice(2).join('\t') || '' }
    : { date: '', user: '', description: String(log || '') };
  const legacy = splitLegacyMaintenanceStatus(parsed.description);
  return { ...parsed, id: '', description: legacy.description, type: DEFAULT_MAINTENANCE_LOG_TYPE, cost: '', changes: legacy.changes, source: {}, media: [] };
}

function getMaintenanceLogRecords(asset) {
  const source = Array.isArray(asset?.maintenanceLogRecords)
    ? asset.maintenanceLogRecords
    : (Array.isArray(asset?.maintenanceLogs) ? asset.maintenanceLogs : []);
  return source.map(normalizeMaintenanceLogRecord);
}

function maintenanceLogDateSortValue(dateValue) {
  const match = String(dateValue || '').trim().match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  if (!match) return Number.NEGATIVE_INFINITY;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const timestamp = Date.UTC(year, month - 1, day);
  const parsed = new Date(timestamp);
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return Number.NEGATIVE_INFINITY;
  }
  return timestamp;
}

function getLastAddedMaintenanceLog(asset) {
  const records = getMaintenanceLogRecords(asset);
  return records.length ? records[records.length - 1] : null;
}

function maintenanceMarkedStatus(log) {
  const record = normalizeMaintenanceLogRecord(log);
  const flaggedStatuses = new Set(['ooc', 'missing', 'degraded']);

  for (let index = record.changes.length - 1; index >= 0; index--) {
    const change = record.changes[index];
    const kind = String(change.kind || '').trim().toLowerCase();
    const action = String(change.action || '').trim().toLowerCase();
    if (action === 'marked' && flaggedStatuses.has(kind)) return kind;
  }

  const sourceKind = String(record.source?.kind || '').trim().toLowerCase();
  const bulkStatus = String(record.source?.bulkStatus || '').trim().toLowerCase();
  if (sourceKind === 'bulk_maintenance_fault' && flaggedStatuses.has(bulkStatus)) {
    return bulkStatus;
  }

  return '';
}

function getLastFlaggedMaintenanceLog(asset) {
  const records = getMaintenanceLogRecords(asset);
  for (let index = records.length - 1; index >= 0; index--) {
    const status = maintenanceMarkedStatus(records[index]);
    if (status) return { record: records[index], status };
  }
  return null;
}

function sortAssetsByLastAddedMaintenanceLog(assetsToSort) {
  return [...(assetsToSort || [])].sort((assetA, assetB) => {
    const dateA = maintenanceLogDateSortValue(getLastAddedMaintenanceLog(assetA)?.date);
    const dateB = maintenanceLogDateSortValue(getLastAddedMaintenanceLog(assetB)?.date);
    if (dateA !== dateB) {
      if (!Number.isFinite(dateA)) return 1;
      if (!Number.isFinite(dateB)) return -1;
      return dateB - dateA;
    }

    return assetMaintenanceDisplayId(assetA).localeCompare(
      assetMaintenanceDisplayId(assetB),
      undefined,
      { numeric: true, sensitivity: 'base' }
    );
  });
}

function getMaintenanceChangeLabels(logOrChanges) {
  const changes = Array.isArray(logOrChanges)
    ? logOrChanges.map(normalizeMaintenanceChange).filter(Boolean)
    : normalizeMaintenanceLogRecord(logOrChanges).changes;

  return changes.map(change => {
    if (change.kind === 'location') return `Location: ${change.value}`;
    if (change.kind === 'serial') return `Serial: ${change.value}`;
    if (change.kind === 'ooc') return change.action === 'marked' ? 'Marked OOC' : 'Cleared OOC';
    if (change.kind === 'missing') return change.action === 'marked' ? 'Marked Missing' : 'Cleared Missing';
    if (change.kind === 'degraded') return change.action === 'marked' ? 'Marked Degraded' : 'Cleared Degraded';
    if (change.kind === 'decommissioned' || change.kind === 'disposed') return change.action === 'marked' ? 'Marked Decommissioned' : 'Cleared Decommissioned';
    return '';
  }).filter(Boolean);
}

function maintenanceChangeColour(label) {
  const changeLower = String(label || '').toLowerCase();
  if (changeLower.includes('cleared ooc') || changeLower.includes('clear ooc') || changeLower.includes('removed ooc') || changeLower.includes('unmark ooc')) return '#28a745';
  if (changeLower.includes('cleared missing') || changeLower.includes('clear missing') || changeLower.includes('removed missing') || changeLower.includes('unmark missing')) return '#28a745';
  if (changeLower.includes('cleared degraded')) return '#28a745';
  if (changeLower.includes('cleared decommissioned') || changeLower.includes('cleared disposed')) return '#28a745';
  if (changeLower.includes('marked ooc') || changeLower.includes('mark ooc')) return '#dc3545';
  if (changeLower.includes('marked missing') || changeLower.includes('mark missing')) return '#fd7e14';
  if (changeLower.includes('marked degraded')) return '#856404';
  if (changeLower.includes('marked decommissioned') || changeLower.includes('marked disposed')) return '#6c757d';
  if (changeLower.includes('location:')) return '#17a2b8';
  if (changeLower.includes('serial:')) return '#6f42c1';
  return '#667eea';
}

function maintenanceChangePdfHtml(label) {
  const color = maintenanceChangeColour(label);
  return `<span style="display:block;margin-bottom:2px;color:${color};font-weight:700;-webkit-print-color-adjust:exact;print-color-adjust:exact;">${escapeHtml(label)}</span>`;
}

function getMaintenanceChangeValue(log, kind) {
  const record = normalizeMaintenanceLogRecord(log);
  const change = record.changes.find(item => item.kind === kind);
  return change ? (change.value || change.action || '') : '';
}

async function loadMaintenanceAssets() {
  try {
    const response = await apiCall("/api/assets");
    
    // Update the global assets variable
    assets = response.data;
    
    // Check which tab is active and load appropriate content
    const activeTab = document.querySelector(".maintenance-tab.active");
    if (activeTab && activeTab.getAttribute('data-tab') === 'ooc') {
      loadOOCAssets();
    } else {
      displayMaintenanceAssets(response.data);
    }
  } catch (error) {
    document.getElementById("maintenance-assets").innerHTML =
      '<p style="color: red; text-align: center;">Error loading assets</p>';
  }
}

function maintenanceVirtualRowHtml(asset) {
  const assetId = getAssetIdentifierForApi(asset);
  const displayId = assetMaintenanceDisplayId(asset);
  const lastMaintenance = getLastAddedMaintenanceLog(asset)?.date || "Never";

  return `
    <tr>
      <td>${escapeHtml(displayId)}${asset.isBulk ? ' <span class="asset-badge status-available">Bulk Item</span>' : ''}</td>
      <td>${escapeHtml(asset.brand || '')}</td>
      <td>${escapeHtml(asset.model || '')}</td>
      <td><span class="asset-badge status-${escapeHtmlAttr(asset.status || 'available')}">${escapeHtml(asset.status || 'available')}</span></td>
      <td>${escapeHtml(asset.location || "Store")}</td>
      <td>${escapeHtml(lastMaintenance)}</td>
      <td>
        <button class="btn btn-primary" onclick="viewMaintenanceLog('${escapeJs(assetId)}')">View Log</button>
      </td>
    </tr>
  `;
}

function displayMaintenanceAssets(assetsToShow) {
  const container = document.getElementById("maintenance-assets");
  if (!container) return;

  if (assetsToShow.length === 0) {
    destroyVirtualTable('maintenance-all');
    container.innerHTML =
      '<p style="text-align: center; color: #666; padding: 40px;">No assets found.</p>';
    return;
  }

  const sortedAssets = sortAssetsByLastAddedMaintenanceLog([...assetsToShow]);
  renderVirtualTable({
    stateKey: 'maintenance-all',
    container,
    items: sortedAssets,
    columnCount: 7,
    estimatedRowHeight: 58,
    headerHtml: `
      <tr>
        <th>Asset ID</th>
        <th>Brand</th>
        <th>Model</th>
        <th>Status</th>
        <th>Location</th>
        <th>Last Maintenance</th>
        <th>Actions</th>
      </tr>
    `,
    rowHtml: maintenanceVirtualRowHtml
  });
}

let assetCheckState = {
  group: null,
  assets: [],
  checked: new Set(),
  checkIds: {},
  seedIdentifier: ''
};

function ensureAssetCheckStyles() {
  if (document.getElementById('asset-check-styles')) return;

  const style = document.createElement('style');
  style.id = 'asset-check-styles';
  style.textContent = `
    .asset-check-panel {
      background: #fff;
      border: 1px solid #e9ecef;
      border-radius: 14px;
      padding: 20px;
      box-shadow: 0 4px 15px rgba(0,0,0,0.06);
      margin-bottom: 18px;
    }

    .asset-check-scan-row {
      display: grid;
      grid-template-columns: minmax(240px, 1fr) auto auto;
      gap: 10px;
      align-items: end;
    }

    .asset-check-summary-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 12px;
      margin: 16px 0;
    }

    .asset-check-summary-card {
      background: #f8f9fa;
      border: 1px solid #e9ecef;
      border-radius: 12px;
      padding: 14px;
    }

    .asset-check-summary-value {
      font-size: 1.6rem;
      font-weight: 700;
      color: #764ba2;
      margin-bottom: 4px;
    }

    .asset-check-summary-label {
      color: #666;
      font-size: 13px;
    }

    .asset-check-table-wrap {
      overflow-x: auto;
      border: 1px solid #e9ecef;
      border-radius: 12px;
      background: #fff;
    }

    .asset-check-table {
      width: 100%;
      min-width: 680px;
      border-collapse: collapse;
    }

    .asset-check-table th,
    .asset-check-table td {
      padding: 10px 12px;
      border-bottom: 1px solid #f1f1f1;
      text-align: left;
      vertical-align: top;
    }

    .asset-check-table th {
      background: #f8f9fa;
      font-weight: 700;
      color: #495057;
      position: sticky;
      top: 0;
      z-index: 1;
    }

    .asset-check-row-checked {
      background: #eefaf1;
    }

    .asset-check-row-excluded {
      background: #f8f9fa;
      color: #777;
    }

    .asset-check-row-missing {
      background: #fff3cd;
      color: #856404;
    }

    .asset-check-row-flash {
      outline: 3px solid #667eea;
      outline-offset: -3px;
      transition: outline 0.3s ease;
    }

    .asset-check-badge {
      display: inline-block;
      padding: 4px 9px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 700;
      white-space: nowrap;
    }

    .asset-check-badge.checked { background: #d4edda; color: #155724; }
    .asset-check-badge.pending { background: #e2e3e5; color: #383d41; }
    .asset-check-badge.ooc { background: #fff3cd; color: #856404; }
    .asset-check-badge.excluded { background: #e9ecef; color: #495057; }
    .asset-check-badge.missing { background: #f8d7da; color: #721c24; }
    .asset-check-badge.deployed { background: #cce5ff; color: #004085; }
    .asset-check-badge.away { background: #d1ecf1; color: #0c5460; }

    .asset-check-help {
      color: #666;
      font-size: 13px;
      line-height: 1.45;
      margin-top: 6px;
    }

    .asset-check-actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }

    @media (max-width: 850px) {
      .asset-check-scan-row {
        grid-template-columns: 1fr;
      }
    }

    @media (max-width: 640px) {
      .asset-check-panel {
        padding: 14px;
        border-radius: 12px;
      }

      .asset-check-actions {
        display: grid;
        grid-template-columns: 1fr;
        width: 100%;
      }

      .asset-check-table {
        min-width: 620px;
      }
    }
  `;

  document.head.appendChild(style);
}

function resetAssetCheckState() {
  assetCheckState = {
    group: null,
    assets: [],
    checked: new Set(),
    checkIds: {},
    seedIdentifier: ''
  };
}

function loadAssetCheck() {
  ensureAssetCheckStyles();
  resetAssetCheckState();

  const container = document.getElementById("asset-check-content");
  if (!container) return;

  container.innerHTML = `
    <div class="asset-check-panel">
      <h3 style="margin-bottom: 8px;">Asset Check</h3>
      <p style="color:#666;margin-bottom:18px;">
        Scan one Asset ID first. The system will load every asset with the same department, brand, model, and description.
      </p>

      <div class="asset-check-scan-row">
        <div class="form-group" style="margin-bottom:0;">
          <label class="form-label">First Asset ID or Serial Number</label>
          <input
            type="text"
            class="form-input"
            id="assetCheckSeedInput"
            placeholder="Scan or type the first asset..."
            autocomplete="off"
          >
          <div class="asset-check-help">
            Assets currently out on show or away from Store will still be shown, but they will be excluded from the missing check.
          </div>
        </div>

        <button class="btn btn-success" onclick="startAssetCheck()">Start Check</button>
        ${scannerButtonHtml("scanForAssetCheck('assetCheckSeedInput', 'start')")}
        <button class="btn btn-secondary" onclick="loadAssetCheck()">Reset</button>
      </div>
    </div>
  `;

  const input = document.getElementById('assetCheckSeedInput');
  if (input) {
    input.focus();
    input.addEventListener('keypress', function (e) {
      if (e.key === 'Enter') startAssetCheck();
    });
  }
}

function createAssetCheckLogId(assetId) {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    return `asset-check-${window.crypto.randomUUID()}`;
  }
  return `asset-check-${Date.now()}-${Math.random().toString(16).slice(2)}-${String(assetId || '').replace(/[^A-Za-z0-9_-]+/g, '')}`;
}

async function setAssetCheckChecked(assetId, checked) {
  const cleanAssetId = String(assetId || '').trim();
  if (!cleanAssetId) throw new Error('Asset ID is required');

  const checkId = checked
    ? (assetCheckState.checkIds[cleanAssetId] || createAssetCheckLogId(cleanAssetId))
    : (assetCheckState.checkIds[cleanAssetId] || '');

  const response = await apiCall('/api/asset-check/sighting', 'POST', {
    assetId: cleanAssetId,
    groupKey: assetCheckState.group?.key || '',
    checkId,
    checked: !!checked
  });

  if (checked) {
    assetCheckState.checked.add(cleanAssetId);
    assetCheckState.checkIds[cleanAssetId] = response.data?.checkId || checkId;
  } else {
    assetCheckState.checked.delete(cleanAssetId);
    delete assetCheckState.checkIds[cleanAssetId];
  }

  return response;
}

// Event handler functions

async function returnSpecificAsset(eventId, assetId) {
    try {
        await apiCall(`/api/events/${eventId}/return`, 'POST', { assetId });
        showNotification('success', `${assetId} returned successfully`);
        
        // Remove the asset from the return list
        const assetElement = document.querySelector(`[onclick*="returnSpecificAsset(${eventId}, '${assetId}')"]`);
        if (assetElement) {
            assetElement.style.transition = 'opacity 0.3s ease';
            assetElement.style.opacity = '0.5';
            assetElement.style.pointerEvents = 'none';
            
            setTimeout(() => {
                if (assetElement.parentNode) {
                    assetElement.parentNode.removeChild(assetElement);
                }
            }, 300);
        }
        
        // Refresh the return events list if it's active
        if (document.getElementById('return-section').classList.contains('active')) {
            setTimeout(() => {
                loadReturnEvents();
            }, 500);
        }
        
    } catch (error) {
        showNotification('error', `Failed to return asset: ${error.message}`);
    }
}




function populateTransferDropdowns(options) {
  const fromSelect = document.getElementById("transferFromEvent");
  const toSelect = document.getElementById("transferToEvent");
  if (!fromSelect || !toSelect) return;

  const sourceEvents = Array.isArray(options) ? options : (options?.sourceEvents || []);
  const targetEvents = Array.isArray(options) ? options : (options?.targetEvents || []);

  fromSelect.innerHTML = '<option value="">Select source event...</option>';
  toSelect.innerHTML = '<option value="">Select destination event...</option>';

  sourceEvents.forEach((event) => {
    const tagPrefix = event.tag === 'dry hire' ? '[DH]' : '[E]';
    const option = document.createElement("option");
    option.value = event.id;
    option.textContent = `${tagPrefix} ${event.id}: ${event.name} (${event.state})`;
    fromSelect.appendChild(option);
  });

  targetEvents.forEach((event) => {
    const tagPrefix = event.tag === 'dry hire' ? '[DH]' : '[E]';
    const option = document.createElement("option");
    option.value = event.id;
    option.textContent = `${tagPrefix} ${event.id}: ${event.name} (${event.state})`;
    toSelect.appendChild(option);
  });
}

async function startAssetCheck() {
  const input = document.getElementById('assetCheckSeedInput') || document.getElementById('assetCheckInput');
  const identifier = input ? input.value.trim() : '';

  if (!identifier) {
    showNotification('warning', 'Scan or enter an Asset ID first');
    input?.focus();
    return;
  }

  try {
    const response = await apiCall('/api/asset-check/group', 'POST', { identifier });
    const data = response.data || {};

    assetCheckState.group = data.group || null;
    assetCheckState.assets = Array.isArray(data.assets) ? data.assets : [];
    assetCheckState.checked = new Set();
    assetCheckState.checkIds = {};
    assetCheckState.seedIdentifier = identifier;

    const scannedAsset = data.scannedAsset;
    if (scannedAsset && scannedAsset.checkEligible && scannedAsset.id) {
      await setAssetCheckChecked(scannedAsset.id, true);
    }

    renderAssetCheckSession();

    if (scannedAsset && scannedAsset.checkEligible) {
      showNotification('success', `${scannedAsset.id} checked. Loaded ${assetCheckState.assets.length} matching assets.`);
    } else if (scannedAsset) {
      showNotification('warning', `${scannedAsset.id || identifier} loaded, but it is excluded from the check: ${scannedAsset.exclusionReason || 'Not checkable'}`);
    }
  } catch (error) {
    showNotification('error', `Failed to start Asset Check: ${error.message}`);
    input?.focus();
  }
}

function renderAssetCheckSession() {
  ensureAssetCheckStyles();

  const container = document.getElementById('asset-check-content');
  if (!container) return;

  const group = assetCheckState.group || {};
  const checkableAssets = assetCheckState.assets.filter(asset => asset.checkEligible);
  const checkedCount = checkableAssets.filter(asset => asset.id && assetCheckState.checked.has(asset.id)).length;
  const uncheckedCount = Math.max(checkableAssets.length - checkedCount, 0);
  const excludedCount = assetCheckState.assets.filter(asset => asset.excluded && !asset.isMissing).length;
  const missingCount = assetCheckState.assets.filter(asset => asset.isMissing).length;

  container.innerHTML = `
    <div class="asset-check-panel">
      <div style="display:flex;justify-content:space-between;gap:16px;align-items:flex-start;flex-wrap:wrap;">
        <div>
          <h3 style="margin-bottom:6px;">${escapeHtml(group.displayName || 'Asset Check')}</h3>
          <div style="color:#666;font-size:14px;">
            Scan or click each item that is physically present in Store.
          </div>
        </div>
        <div class="asset-check-actions">
          <button class="btn btn-danger" onclick="markUncheckedAssetCheckMissing()" ${uncheckedCount === 0 ? 'disabled' : ''}>
            Mark Unchecked as Missing
          </button>
          <button class="btn btn-secondary" onclick="loadAssetCheck()">Start New Check</button>
        </div>
      </div>

      <div class="asset-check-summary-grid">
        <div class="asset-check-summary-card">
          <div class="asset-check-summary-value">${checkedCount}</div>
          <div class="asset-check-summary-label">Checked in Store</div>
        </div>
        <div class="asset-check-summary-card">
          <div class="asset-check-summary-value">${uncheckedCount}</div>
          <div class="asset-check-summary-label">Unchecked in Store</div>
        </div>
        <div class="asset-check-summary-card">
          <div class="asset-check-summary-value">${excludedCount}</div>
          <div class="asset-check-summary-label">Excluded but Shown</div>
        </div>
        <div class="asset-check-summary-card">
          <div class="asset-check-summary-value">${missingCount}</div>
          <div class="asset-check-summary-label">Already Missing</div>
        </div>
      </div>

      <div class="asset-check-scan-row" style="margin-top: 12px;">
        <div class="form-group" style="margin-bottom:0;">
          <label class="form-label">Continue Scanning Asset ID or Serial Number</label>
          <input
            type="text"
            class="form-input"
            id="assetCheckScanInput"
            placeholder="Scan the next matching asset..."
            autocomplete="off"
          >
        </div>
        <button class="btn btn-success" onclick="checkAsset()">Check Asset</button>
        ${scannerButtonHtml("scanForAssetCheck('assetCheckScanInput', 'continue')")}
        <button class="btn btn-secondary" onclick="renderAssetCheckSession()">Refresh View</button>
      </div>
    </div>

    <div class="asset-check-table-wrap">
      <table class="asset-check-table">
        <thead>
          <tr>
            <th style="width:130px;">Asset ID</th>
            <th>Serial</th>
            <th>Status</th>
            <th>Location</th>
            <th>Notes</th>
            <th style="width:120px;">Action</th>
          </tr>
        </thead>
        <tbody>
          ${assetCheckState.assets.map(renderAssetCheckRow).join('')}
        </tbody>
      </table>
    </div>
  `;

  const scanInput = document.getElementById('assetCheckScanInput');
  if (scanInput) {
    scanInput.focus();
    scanInput.addEventListener('keypress', function (e) {
      if (e.key === 'Enter') checkAsset();
    });
  }
}

function renderAssetCheckRow(asset) {
  const assetId = asset.id || asset.internalId || '';
  const encodedAssetId = encodeURIComponent(assetId);
  const isChecked = asset.checkEligible && assetId && assetCheckState.checked.has(assetId);

  let rowClass = '';
  if (asset.isMissing) rowClass = 'asset-check-row-missing';
  else if (asset.excluded) rowClass = 'asset-check-row-excluded';
  else if (isChecked) rowClass = 'asset-check-row-checked';

  return `
    <tr id="asset-check-row-${escapeHtmlAttr(encodedAssetId)}" class="${rowClass}">
      <td><strong>${escapeHtml(assetId || 'Bulk Item')}</strong></td>
      <td>${escapeHtml(asset.serial || '-')}</td>
      <td>${getAssetCheckStatusBadge(asset, isChecked)}</td>
      <td>${escapeHtml(asset.location || 'Store')}</td>
      <td>${escapeHtml(asset.exclusionReason || (asset.isOOC ? 'OOC, but still checkable because it is in Store' : ''))}</td>
      <td>
        ${asset.checkEligible ? `
          <button class="btn ${isChecked ? 'btn-secondary' : 'btn-success'} btn-sm" onclick="toggleAssetCheck('${escapeHtmlAttr(encodedAssetId)}')">
            ${isChecked ? 'Undo' : 'Check'}
          </button>
        ` : '<span style="font-size:12px;color:#777;">Excluded</span>'}
      </td>
    </tr>
  `;
}

function getAssetCheckStatusBadge(asset, isChecked) {
  if (isChecked) return '<span class="asset-check-badge checked">Checked</span>';
  if (asset.isMissing) return '<span class="asset-check-badge missing">Missing</span>';
  if (asset.status === 'deployed') return '<span class="asset-check-badge deployed">Out on Show</span>';
  if (asset.status === 'away') return '<span class="asset-check-badge away">Away</span>';
  if (asset.status === 'bulk') return '<span class="asset-check-badge excluded">Bulk</span>';
  if (asset.status === 'ooc') return '<span class="asset-check-badge ooc">OOC / Checkable</span>';
  if (asset.excluded) return '<span class="asset-check-badge excluded">Excluded</span>';
  return '<span class="asset-check-badge pending">Unchecked</span>';
}

async function toggleAssetCheck(encodedAssetId) {
  const assetId = decodeURIComponent(encodedAssetId || '');
  const asset = assetCheckState.assets.find(item => item.id === assetId);

  if (!asset) {
    showNotification('warning', 'Asset not found in this check group');
    return;
  }

  if (!asset.checkEligible) {
    showNotification('warning', `${assetId} is excluded: ${asset.exclusionReason || 'Not checkable'}`);
    flashAssetCheckRow(assetId);
    return;
  }

  const shouldCheck = !assetCheckState.checked.has(assetId);

  try {
    await setAssetCheckChecked(assetId, shouldCheck);
  } catch (error) {
    showNotification('error', `Failed to ${shouldCheck ? 'check' : 'undo'} ${assetId}: ${error.message}`);
    return;
  }

  renderAssetCheckSession();
  flashAssetCheckRow(assetId);
}

async function checkAsset() {
  const input = document.getElementById('assetCheckScanInput');
  const identifier = input ? input.value.trim() : '';

  if (!assetCheckState.group) {
    showNotification('warning', 'Start an Asset Check first');
    loadAssetCheck();
    return;
  }

  if (!identifier) {
    showNotification('warning', 'Scan or enter an Asset ID');
    input?.focus();
    return;
  }

  const identifierLower = identifier.toLowerCase();
  const asset = assetCheckState.assets.find(item =>
    String(item.id || '').toLowerCase() === identifierLower ||
    String(item.internalId || '').toLowerCase() === identifierLower ||
    (item.serial && String(item.serial).toLowerCase() === identifierLower)
  );

  if (!asset) {
    showNotification('warning', `${identifier} is not part of this model/description group`);
    input.value = '';
    input.focus();
    return;
  }

  if (!asset.checkEligible) {
    showNotification('warning', `${asset.id || identifier} is excluded: ${asset.exclusionReason || 'Not checkable'}`);
    input.value = '';
    renderAssetCheckSession();
    flashAssetCheckRow(asset.id || asset.internalId || identifier);
    return;
  }

  if (assetCheckState.checked.has(asset.id)) {
    showNotification('info', `${asset.id} is already checked`);
    input.value = '';
    renderAssetCheckSession();
    flashAssetCheckRow(asset.id);
    return;
  }

  try {
    await setAssetCheckChecked(asset.id, true);
  } catch (error) {
    showNotification('error', `Failed to check ${asset.id}: ${error.message}`);
    input.focus();
    return;
  }

  showNotification('success', `${asset.id} checked`);
  input.value = '';
  renderAssetCheckSession();
  flashAssetCheckRow(asset.id);
}

function flashAssetCheckRow(assetId) {
  const encodedAssetId = encodeURIComponent(assetId || '');
  setTimeout(() => {
    const row = document.getElementById(`asset-check-row-${encodedAssetId}`);
    if (!row) return;
    row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    row.classList.add('asset-check-row-flash');
    setTimeout(() => row.classList.remove('asset-check-row-flash'), 1200);
  }, 50);
}

async function refreshAssetCheckGroup(keepChecked = true) {
  if (!assetCheckState.seedIdentifier) return;

  const existingChecked = new Set(assetCheckState.checked);
  const response = await apiCall('/api/asset-check/group', 'POST', {
    identifier: assetCheckState.seedIdentifier
  });

  const data = response.data || {};
  assetCheckState.group = data.group || assetCheckState.group;
  assetCheckState.assets = Array.isArray(data.assets) ? data.assets : [];
  assetCheckState.checked = keepChecked ? existingChecked : new Set();
  if (!keepChecked) assetCheckState.checkIds = {};
}

async function markUncheckedAssetCheckMissing() {
  if (!assetCheckState.group) {
    showNotification('warning', 'Start an Asset Check first');
    return;
  }

  const uncheckedAssets = assetCheckState.assets.filter(asset =>
    asset.checkEligible && asset.id && !assetCheckState.checked.has(asset.id)
  );

  if (uncheckedAssets.length === 0) {
    showNotification('success', 'There are no unchecked in-store assets to mark as missing');
    return;
  }

  const preview = uncheckedAssets.slice(0, 12).map(asset => asset.id).join(', ');
  const extra = uncheckedAssets.length > 12 ? ` and ${uncheckedAssets.length - 12} more` : '';
  const confirmed = await showAppConfirm({
    title: 'Mark Missing',
    message:
      `Mark ${uncheckedAssets.length} unchecked in-store asset(s) as Missing?\n\n` +
      `${preview}${extra}\n\n` +
      `Assets that are out on show or away from Store are excluded and will not be marked missing.`,
    confirmText: 'Mark Missing',
    cancelText: 'Cancel',
    variant: 'warning',
  });

  if (!confirmed) return;

  try {
    const response = await apiCall('/api/asset-check/mark-missing', 'POST', {
      assetIds: uncheckedAssets.map(asset => asset.id),
      groupKey: assetCheckState.group.key,
      confirm: true
    });

    const marked = response.data?.marked || [];
    const skipped = response.data?.skipped || [];

    await refreshAssetCheckGroup(true);
    renderAssetCheckSession();

    if (skipped.length > 0) {
      showNotification('warning', `Marked ${marked.length} as Missing. Skipped ${skipped.length} item(s) that were no longer eligible.`);
      console.warn('Asset Check skipped items:', skipped);
    } else {
      showNotification('success', `Marked ${marked.length} unchecked asset(s) as Missing`);
    }
  } catch (error) {
    showNotification('error', `Failed to mark unchecked assets as missing: ${error.message}`);
  }
}




function toggleEventLogSection(sectionId) {
  const section = document.getElementById(sectionId);
  const toggleIcon = document.getElementById(sectionId + '-toggle');
  
  if (section && toggleIcon) {
    if (section.style.display === 'none') {
      section.style.display = 'block';
      toggleIcon.textContent = '▼';
    } else {
      section.style.display = 'none';
      toggleIcon.textContent = '▶';
    }
  }
}

async function createEventLogViewer(eventId, eventName, eventLogs = []) {
  try {
    const logs = Array.isArray(eventLogs) ? eventLogs : [];
    const relevantLogs = logs
      .filter(log => log && log.action)
      .map(log => ({
        date: log.timestamp || log.date || '',
        user: log.user || 'system',
        action: log.action || '',
        sortValue: String(log.timestamp || log.date || '')
      }))
      .sort((a, b) => b.sortValue.localeCompare(a.sortValue));

    // Helper functions
    const getActionIcon = (actionType) => {
      switch (actionType) {
        case 'prepared': return '📦';
        case 'returned': return '🔄';
        case 'assigned': return '📋';
        case 'unprepared': return '❌';
        default: return '📝';
      }
    };

    const getActionColor = (actionType) => {
      switch (actionType) {
        case 'prepared': return 'color: #28a745; background: #d4edda; border-left-color: #28a745;';
        case 'returned': return 'color: #007bff; background: #cce5ff; border-left-color: #007bff;';
        case 'assigned': return 'color: #ffc107; background: #fff3cd; border-left-color: #ffc107;';
        case 'unprepared': return 'color: #dc3545; background: #f8d7da; border-left-color: #dc3545;';
        default: return 'color: #6c757d; background: #e2e3e5; border-left-color: #6c757d;';
      }
    };

    const getActionType = (action) => {
      const actionLower = action.toLowerCase();
      if (actionLower.includes('unprepared')) return 'unprepared';
      if (actionLower.includes('returned')) return 'returned';
      if (actionLower.includes('assigned')) return 'assigned';
      if (actionLower.includes('prepared')) return 'prepared';
      return 'other';
    };

    const extractAssetId = (action) => {
      const match = action.match(/asset\s+([A-Z0-9#]+(?:\[[^\]]+\])?[^;\s]*)/i);
      return match ? match[1] : null;
    };

    function generateActionButton(eventId, asset, isPrepared) {
    const safeAssetId = encodeURIComponent(asset.id);
    
    if (isPrepared) {
        return `<button class="btn btn-warning asset-action-btn" 
                        data-event-id="${eventId}" 
                        data-asset-id="${safeAssetId}" 
                        data-action="unprepare"
                        style="padding: 4px 8px; font-size: 11px; margin-right: 5px;">Unprepare</button>`;
    } else {
        return `<button class="btn btn-success asset-action-btn" 
                        data-event-id="${eventId}" 
                        data-asset-id="${safeAssetId}" 
                        data-action="prepare"
                        style="padding: 4px 8px; font-size: 11px; margin-right: 5px;">Prepare</button>`;
    }
}

    // Generate unique ID for this event's log section
    const logSectionId = `event-log-${eventId}`;

    // Generate HTML with collapsible header
    let logHTML = `
      <div style="background: white; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); padding: 20px; margin-top: 20px;">
        <div style="display: flex; justify-content: space-between; align-items: center; cursor: pointer; user-select: none;" onclick="toggleEventLogSection('${logSectionId}')">
          <h3 style="margin: 0; color: #333; font-size: 18px; display: flex; align-items: center; gap: 10px;">
            📋 Event Activity Log
            <span style="font-size: 14px; color: #666; font-weight: normal;">(${escapeHtml(eventName)})</span>
            ${relevantLogs.length > 0 ? `<span style="background: #007bff; color: white; border-radius: 12px; padding: 2px 8px; font-size: 12px; font-weight: bold;">${relevantLogs.length}</span>` : ''}
          </h3>
          <span id="${logSectionId}-toggle" style="font-size: 18px; color: #666; font-weight: bold;">▶</span>
        </div>
        <div id="${logSectionId}" style="display: none; margin-top: 20px;">
    `;

    if (relevantLogs.length === 0) {
      logHTML += `
        <div style="text-align: center; padding: 40px 0; color: #666;">
          <div style="font-size: 48px; margin-bottom: 10px;">📋</div>
          <p>No activity recorded for this event yet.</p>
        </div>
      `;
    } else {
      logHTML += `<div style="max-height: 400px; overflow-y: auto;">`;
      
      relevantLogs.forEach((log, index) => {
        const actionType = getActionType(log.action);
        const assetId = extractAssetId(log.action);

        logHTML += `
          <div style="padding: 15px; border-radius: 8px; border-left: 4px solid; margin-bottom: 12px; ${getActionColor(actionType)}">
            <div style="display: flex; align-items: start; gap: 12px;">
              <span style="font-size: 18px; line-height: 1;">${getActionIcon(actionType)}</span>
              <div style="flex: 1;">
                <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 6px;">
                  <span style="font-weight: bold; color: #333;">${escapeHtml(log.user)}</span>
                  <span style="color: #999; font-size: 12px;">•</span>
                  <span style="color: #666; font-size: 13px;">${escapeHtml(log.date)}</span>
                </div>
                ${assetId ? `
                  <div style="margin: 6px 0;">
                    <span style="font-family: 'Courier New', monospace; background: #f8f9fa; padding: 3px 6px; border-radius: 3px; font-size: 12px; color: #495057;">
                      ${escapeHtml(assetId)}
                    </span>
                  </div>
                ` : ''}
                <p style="margin: 6px 0 0 0; color: #555; font-size: 13px; line-height: 1.4;">${escapeHtml(log.action)}</p>
              </div>
            </div>
          </div>
        `;
      });
      
      logHTML += `</div>`;
      
      logHTML += `
        <div style="margin-top: 15px; padding-top: 15px; border-top: 1px solid #e9ecef; text-align: center; color: #666; font-size: 12px;">
          Showing ${relevantLogs.length} activity record(s)
        </div>
      `;
    }

    logHTML += `
        </div>
      </div>
    `;
    
    return logHTML;
  } catch (error) {
    console.error('Error loading event logs:', error);
    return `
      <div style="background: white; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); padding: 20px; margin-top: 20px;">
        <h3 style="margin: 0 0 20px 0; color: #333;">📋 Event Activity Log</h3>
        <div style="text-align: center; padding: 20px; color: #dc3545;">
          Error loading activity log. Please try again.
        </div>
      </div>
    `;
  }
}

async function editEvent(eventId) {
  if (!isAdminUser()) {
    viewEvent(eventId);
    return;
  }

  try {
    window.currentViewedEventId = eventId;
    window.currentEventDetailsMode = "edit";
    const response = await apiCall(`/api/events/${eventId}`);
    const event = response.data;

    document.getElementById(
      "eventDetailsTitle"
    ).textContent = `Edit Event ${event.id}: ${event.name}`;

    // Helper function to escape HTML
    const escapeHtml = (str) => {
      if (!str) return '';
      const div = document.createElement('div');
      div.textContent = str;
      return div.innerHTML;
    };

    let content = `
            <!-- Edit Event Tabs -->
            <div class="edit-event-tabs" style="display: flex; border-bottom: 2px solid #e9ecef; margin-bottom: 20px;">
                <button class="edit-tab active" data-tab="details" onclick="switchEditTab('details')" 
                        style="flex: 1; padding: 15px 20px; border: none; background: rgba(118, 75, 162, 0.05); font-size: 16px; font-weight: 500; cursor: pointer; border-bottom: 3px solid #764ba2; transition: all 0.3s ease; color: #764ba2;">
                    📝 Event Details
                </button>
                <button class="edit-tab" data-tab="assets" onclick="switchEditTab('assets')"
                        style="flex: 1; padding: 15px 20px; border: none; background: none; font-size: 16px; font-weight: 500; cursor: pointer; border-bottom: 3px solid transparent; transition: all 0.3s ease;">
                    📦 Manage Assets
                </button>
            </div>
            
            <!-- Tab Contents -->
            <div id="edit-details-tab" class="edit-tab-content">
                <form id="editEventDetailsForm">
                    <input type="hidden" id="editEventId" value="${event.id}">
                    <div class="form-group">
                        <label class="form-label">Event Name</label>
                        <input type="text" class="form-input" id="editEventName" value="${escapeHtml(event.name)}" required>
                    </div>
                    <div class="form-group">
                        <label class="form-label">Event Tag</label>
                        <select class="form-input" id="editEventTag" required>
                            <option value="events" ${(event.tag === 'events' || !event.tag) ? 'selected' : ''}>Events</option>
                            <option value="dry hire" ${event.tag === 'dry hire' ? 'selected' : ''}>Dry Hire</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label class="form-label">Start Date</label>
                        <input type="date" class="form-input" id="editEventStartDate" value="${formatDateForInput(event.startDate)}" required>
                    </div>
                    <div class="form-group">
                        <label class="form-label">End Date</label>
                        <input type="date" class="form-input" id="editEventEndDate" value="${formatDateForInput(event.endDate)}" required>
                    </div>
                    <div class="modal-actions" style="display: flex; gap: 10px; justify-content: flex-end; margin-top: 20px;">
                        <button type="submit" class="btn btn-primary">Update Event</button>
                    </div>
                </form>
                <div style="margin-top: 24px;">
                    ${renderEventNotesFilesSection(event)}
                </div>
            </div>
            
            <div id="edit-assets-tab" class="edit-tab-content" style="display: none;">
                <div class="assets-edit-interface">
                    <!-- Search Bar at Top -->
                    <div style="background: #e8f5e8; border: 2px solid #28a745; border-radius: 8px; padding: 20px; margin-bottom: 30px;">
                        <h4 style="color: #155724; margin-bottom: 15px; font-size: 18px;">➕ Add Asset Models / Containers</h4>
                        <div style="display: flex; gap: 15px; align-items: flex-end;">
                            <div style="flex: 1;">
                                <input type="text" class="form-input" placeholder="Search available asset models or containers..." 
                                       style="width: 100%; padding: 12px; border: 1px solid #28a745; border-radius: 6px; font-size: 14px;" 
                                       oninput="filterAvailableModels(this.value)">
                            </div>
                            <button type="button" class="btn btn-secondary" onclick="clearModelSearch()" 
                                    style="padding: 12px 20px; background: #6c757d; border: none; border-radius: 6px; color: white; font-size: 14px;">
                                Clear
                            </button>
                        </div>
                        <div id="available-models-container" style="margin-top: 15px; border: 1px solid #28a745; border-radius: 6px; max-height: 250px; overflow-y: auto; background: white;">
                            <div style="text-align: center; padding: 20px; color: #666; font-size: 14px;">
                                Type to search for available asset models or containers...
                            </div>
                        </div>
                    </div>

                    <!-- Add Custom Asset Section -->
                    <div style="margin-bottom: 30px;">
                        <h4 style="color: #495057; margin-bottom: 15px;">🛠️ Add Custom Assets</h4>
                        <div style="display: flex; flex-wrap: wrap; gap: 10px; align-items: center; max-width: 100%; margin-bottom: 15px;">
                            <input type="text" id="customAssetName" placeholder="Asset name, e.g. XLR Cable - 3m"
                                   style="flex: 1 1 220px; min-width: 170px; padding: 8px 12px; border: 1px solid #ccc; border-radius: 4px; font-size: 14px;">
                            <input type="number" id="customAssetQuantity" placeholder="Qty" min="1" value="1"
                                   style="flex: 0 0 70px; width: 70px; padding: 8px 12px; border: 1px solid #ccc; border-radius: 4px; font-size: 14px;">
                            <select id="customAssetType" style="flex: 0 1 140px; min-width: 125px; padding: 8px 12px; border: 1px solid #ccc; border-radius: 4px; font-size: 14px;">
                                <option value="MISC">Misc Item</option>
                                <option value="LOAN">Loan/Rental</option>
                            </select>
                            <select id="customAssetDepartment" style="flex: 0 0 82px; width: 82px; padding: 8px 10px; border: 1px solid #ccc; border-radius: 4px; font-size: 14px;">
                                ${customDepartmentOptionsHtml('AX')}
                            </select>
                            <input type="text" id="customAssetCompany" placeholder="Company (loan/rental only)"
                                   style="flex: 1 1 210px; min-width: 160px; padding: 8px 12px; border: 1px solid #ccc; border-radius: 4px; font-size: 14px;">
                            <button type="button" class="btn btn-success" onclick="addCustomAssetToEvent(${eventId})"
                                    style="flex: 0 0 auto; padding: 8px 16px; white-space: nowrap;">
                                Add Custom Asset
                            </button>
                        </div>
                    </div>

                    <!-- Current Asset Models -->
                    <div style="margin-bottom: 30px;">
                        <h4 style="color: #495057; margin-bottom: 15px; display: flex; justify-content: space-between; align-items: center;">
                            <span>📦 Model Requirements</span>
                            <span class="toggle-icon" style="font-size: 14px; cursor: pointer;" onclick="toggleViewSection('all-models')">▼</span>
                        </h4>
                        <div id="all-models" style="display: block;">
                            <div id="current-asset-models" style="border: 1px solid #e9ecef; border-radius: 8px; min-height: 200px;">
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        `;

    document.getElementById("eventDetailsContent").innerHTML = content;

    // Load available assets for the assets tab
    loadEditEventAssets(eventId);

    // Clean up any existing event listeners on the eventDetailsContent
    const eventDetailsContent = document.getElementById("eventDetailsContent");
    if (eventDetailsContent.handleModelToggle) {
      eventDetailsContent.removeEventListener(
        "click",
        eventDetailsContent.handleModelToggle
      );
    }

    // Set up event delegation for model toggle
    const handleModelToggle = function (e) {
      if (e.target.classList.contains("toggle-model-btn")) {
        e.preventDefault();
        const modelId = e.target.getAttribute("data-model-id");
        toggleModelDetailsInEdit(modelId);
      }
    };

    // Store the listener reference for cleanup
    eventDetailsContent.handleModelToggle = handleModelToggle;
    eventDetailsContent.addEventListener("click", handleModelToggle);

    openModal("eventDetailsModal");
  } catch (error) {
    showNotification("error", "Failed to load event details");
  }
}

// Switch between edit tabs

async function loadEditEventAssets(eventId) {
  try {
    const [eventResponse, availableAssetsResponse, availabilityResponse, containerCache] = await Promise.all([
      apiCall(`/api/events/${eventId}`),
      apiCall("/api/assets/available"),
      apiCall(`/api/events/${eventId}/availability`),
      refreshContainersCache(true).catch(error => {
        console.warn("Container search unavailable:", error);
        return {};
      }),
    ]);

    const event = eventResponse.data;
    const availableAssets = availableAssetsResponse.data || [];
    const availableContainers = Object.values(containerCache || {});

    // Store for functionality
    window.currentEditAvailableAssets = availableAssets;
    window.currentEditContainers = availableContainers;
    window.currentEditEventId = eventId;
    window.currentEditEvent = event;
    window.currentEditAvailabilityList = availabilityResponse.data || [];

    // Helper function to escape HTML
    const escapeHtml = (str) => {
      if (!str) return '';
      const div = document.createElement('div');
      div.textContent = str;
      return div.innerHTML;
    };

    let content = `
            <div class="assets-edit-interface">
                <!-- Search Bar at Top -->
                <div style="background: #e8f5e8; border: 2px solid #28a745; border-radius: 8px; padding: 20px; margin-bottom: 30px;">
                    <h4 style="color: #155724; margin: 0 0 15px 0; font-weight: 600;">🔍 Search Available Asset Models or Containers</h4>
                    <div style="display: flex; align-items: center; gap: 15px;">
                        <input type="text" class="form-input" placeholder="Search available asset models or containers (min 2 characters)..." 
                               style="flex: 1; max-width: 500px; padding: 10px 15px; border: 1px solid #28a745; border-radius: 5px;" 
                               oninput="filterAvailableModels(this.value)">
                        <button type="button" class="btn btn-outline-secondary" onclick="clearModelSearch()" 
                                style="padding: 10px 15px; white-space: nowrap;">Clear Search</button>
                    </div>
                    <div id="available-models-container" style="margin-top: 15px; border: 1px solid #28a745; border-radius: 5px; background: white; max-height: 300px; overflow-y: auto;">
                        <div style="text-align: center; padding: 20px; color: #666; font-size: 14px;">Type to search for available asset models or containers...</div>
                    </div>
                </div>

                <!-- Add Custom Assets Section -->
                <div style="background: #fff3cd; border: 2px solid #ffc107; border-radius: 8px; padding: 20px; margin-bottom: 30px;">
                    <h4 style="color: #856404; margin: 0 0 15px 0; font-weight: 600;">➕ Add Custom Assets</h4>
                    <div style="display: flex; flex-wrap: wrap; gap: 10px; align-items: center; max-width: 100%;">
                        <input type="text" id="customAssetName" placeholder="Asset Name"
                               style="flex: 1 1 220px; min-width: 170px; padding: 8px 12px; border: 1px solid #ccc; border-radius: 4px; font-size: 14px;">
                        <input type="number" id="customAssetQuantity" placeholder="Qty" min="1" value="1"
                               style="flex: 0 0 70px; width: 70px; padding: 8px 12px; border: 1px solid #ccc; border-radius: 4px; font-size: 14px;">
                        <select id="customAssetType" style="flex: 0 1 140px; min-width: 125px; padding: 8px 12px; border: 1px solid #ccc; border-radius: 4px; font-size: 14px;">
                            <option value="MISC">Misc Item</option>
                            <option value="LOAN">Loan/Rental</option>
                        </select>
                        <select id="customAssetDepartment" style="flex: 0 0 82px; width: 82px; padding: 8px 10px; border: 1px solid #ccc; border-radius: 4px; font-size: 14px;">
                            ${customDepartmentOptionsHtml('AX')}
                        </select>
                        <input type="text" id="customAssetCompany" placeholder="Company (loan/rental only)"
                               style="flex: 1 1 210px; min-width: 160px; padding: 8px 12px; border: 1px solid #ccc; border-radius: 4px; font-size: 14px;">
                        <button type="button" class="btn btn-success" onclick="addCustomAssetToEvent(${eventId})"
                                style="flex: 0 0 auto; padding: 8px 16px; white-space: nowrap;">
                            Add Custom Asset
                        </button>
                    </div>
                </div>

                <!-- Current Asset Models -->
                <div style="margin-bottom: 30px;">
                    <h4 style="color: #495057; margin-bottom: 15px; display: flex; justify-content: space-between; align-items: center;">
                        <span>📦 Model Requirements</span>
                        <span class="toggle-icon" style="font-size: 14px; cursor: pointer;" onclick="toggleViewSection('all-models')">▼</span>
                    </h4>
                    <div id="all-models" style="display: block;">
                        <div id="current-asset-models" style="border: 1px solid #e9ecef; border-radius: 8px; min-height: 200px;">
                            <!-- Content will be populated by updateModelRequirementsSection -->
                        </div>
                    </div>
                </div>
            </div>
        `;

    document.getElementById("edit-assets-tab").innerHTML = content;

    // Rebuild model requirements from the latest event payload.
    // This ensures consistent UI with Edit/Remove buttons
    await updateModelRequirementsSection(eventId);

  } catch (error) {
    console.error("Error loading edit event assets:", error);
    showNotification("error", "Failed to load assets for editing");
  }
}

// Add custom asset to event
async function addCustomAssetToEvent(eventId) {
  const nameInput = document.getElementById("customAssetName");
  const quantityInput = document.getElementById("customAssetQuantity");
  const typeSelect = document.getElementById("customAssetType");
  const departmentSelect = document.getElementById("customAssetDepartment");
  const companyInput = document.getElementById("customAssetCompany");

  const name = nameInput.value.trim();
  const quantity = Math.max(1, parseInt(quantityInput.value, 10) || 1);
  const type = normalizeCustomType(typeSelect.value);
  const department = normalizeDepartmentCode(departmentSelect?.value || 'UN');
  const company = (companyInput?.value || '').trim();

  if (!name) {
    showNotification("error", "Please enter a custom asset name");
    return;
  }

  if (type === 'LOAN' && !company) {
    showNotification("warning", "Please enter the loan/rental company");
    companyInput?.focus();
    return;
  }

  try {
    await apiCall(`/api/events/${eventId}/custom-assets`, "POST", {
      name,
      quantity,
      type,
      department,
      company
    });

    const quantityText = quantity > 1 ? ` (${quantity}x)` : '';
    showNotification("success", `${type === 'LOAN' ? 'Loan/Rental' : 'Misc'} item "${name}"${quantityText} added`);

    nameInput.value = "";
    quantityInput.value = "1";
    if (companyInput) companyInput.value = "";

    await updateModelRequirementsSection(eventId);
    await refreshEventOverviewViews();

  } catch (error) {
    showNotification("error", `Failed to add custom asset: ${error.message}`);
  }
}

// Clear model search
function clearModelSearch() {
  const searchInput = document.querySelector('#edit-assets-tab input[placeholder*="Search available asset models"]');
  const container = document.getElementById("available-models-container");
  
  if (searchInput) {
    searchInput.value = "";
  }
  
  if (container) {
    container.innerHTML = '<div style="text-align: center; padding: 20px; color: #666; font-size: 14px;">Type to search for available asset models or containers...</div>';
  }
}

// Add asset model to event (simplified)

// Switch between edit tabs
function switchEditTab(tabName) {
  // Remove active class from all tabs
  document.querySelectorAll(".edit-tab").forEach((tab) => {
    tab.classList.remove("active");
    tab.style.background = "none";
    tab.style.borderBottomColor = "transparent";
    tab.style.color = "#666";
  });

  // Remove active class from all content
  document.querySelectorAll(".edit-tab-content").forEach((content) => {
    content.style.display = "none";
  });

  // Add active class to clicked tab
  const activeTab = document.querySelector(`[data-tab="${tabName}"]`);
  if (activeTab) {
    activeTab.classList.add("active");
    activeTab.style.background = "rgba(118, 75, 162, 0.05)";
    activeTab.style.borderBottomColor = "#764ba2";
    activeTab.style.color = "#764ba2";
  }

  // Show corresponding content
  const contentDiv = document.getElementById(`edit-${tabName}-tab`);
  if (contentDiv) {
    contentDiv.style.display = "block";
  }
}

// Load available assets for editing

async function addModelToEvent(eventId, brand, model, department, description = '') {
  try {
    const cleanDescription = description || '';
    const qtyInputId = makeQtyInputId(department, brand, model, cleanDescription);
    const qtyInput = document.getElementById(qtyInputId);
    const requestedQuantity = Math.max(1, parseInt(qtyInput?.value, 10) || 1);

    const availableAssets = window.currentEditAvailableAssets || [];
    const availabilityList = window.currentEditAvailabilityList || [];

    let eventData = window.currentEditEvent;

    if (!eventData || Number(eventData.id) !== Number(eventId)) {
      const eventResponse = await apiCall(`/api/events/${eventId}`);
      eventData = eventResponse.data;
      window.currentEditEvent = eventData;
    }

    const availabilityEntry = availabilityList.find(entry =>
      entry.department === department &&
      entry.brand === brand &&
      entry.model === model
    );

    const physicalCount = availabilityEntry
      ? Number(availabilityEntry.physical || 0)
      : availableAssets.filter(asset =>
          asset.department === department &&
          asset.brand === brand &&
          asset.model === model
        ).length;

    const currentGroup = Object.values(eventData.modelGroups || {}).find(group =>
      group.department === department &&
      group.brand === brand &&
      group.model === model
    );

    const currentlyRequestedHere = Number(currentGroup?.requiredQuantity || 0);

    if (physicalCount <= 0) {
      showNotification(
        'error',
        `No inventory found for ${brand} ${model}${cleanDescription ? ` (${cleanDescription})` : ''}.`
      );
      return;
    }

    if (currentlyRequestedHere + requestedQuantity > physicalCount) {
      showNotification(
        'error',
        `Cannot add ${requestedQuantity}. You only have ${physicalCount} total ${brand} ${model}${cleanDescription ? ` (${cleanDescription})` : ''} in inventory, and this event already requests ${currentlyRequestedHere}.`
      );
      return;
    }

    await apiCall(`/api/events/${eventId}/models`, 'POST', {
      brand,
      model,
      department,
      description: cleanDescription,
      quantity: requestedQuantity,
    });

    showNotification(
      'success',
      `${requestedQuantity}x ${brand} ${model}${cleanDescription ? ` (${cleanDescription})` : ''} added to event`
    );

    if (qtyInput) {
      qtyInput.value = 1;
    }

    const [eventResponse, availabilityResponse] = await Promise.all([
      apiCall(`/api/events/${eventId}`),
      apiCall(`/api/events/${eventId}/availability`)
    ]);

    window.currentEditEvent = eventResponse.data;
    window.currentEditAvailabilityList = availabilityResponse.data || [];

    await updateModelRequirementsSection(eventId);
    await refreshEventOverviewViews();

    const currentSearchTerm =
      document.querySelector('#edit-assets-tab input[placeholder*="Search available asset models"]')?.value;

    if (currentSearchTerm && currentSearchTerm.length >= 2) {
      filterAvailableModels(currentSearchTerm);
    }

  } catch (error) {
    showNotification('error', `Failed to add model: ${error.message}`);
  }
}

async function updateModelRequirementsSection(eventId) {
  try {
    const eventResponse = await apiCall(`/api/events/${eventId}`);
    const event = eventResponse.data;
    window.currentEditEvent = event;

    const modelsContainer = document.getElementById("current-asset-models");
    if (!modelsContainer) return;

    const modelsByDept = {};
    Object.values(event.modelGroups || {}).forEach((model) => {
      const dept = normalizeDepartmentCode(model.department || 'UN');
      if (!modelsByDept[dept]) modelsByDept[dept] = [];
      modelsByDept[dept].push(model);
    });

    const customAssetsByDept = groupCustomAssetsByDepartment(event);
    const allDepartments = Array.from(new Set([
      ...Object.keys(modelsByDept),
      ...Object.keys(customAssetsByDept)
    ])).sort();

    let content = '';

    allDepartments.forEach((dept) => {
      const models = modelsByDept[dept] || [];
      const customAssets = customAssetsByDept[dept] || [];

      const modelAssigned = models.reduce((sum, model) => sum + getPreparedQuantity(model), 0);
      const modelRequired = models.reduce((sum, model) => sum + Number(model.requiredQuantity || 0), 0);
      const customAssigned = getCustomPreparedQuantityForProgress(customAssets);
      const customRequired = getCustomRequiredQuantityForProgress(customAssets);
      const totalAssigned = modelAssigned + customAssigned;
      const totalRequired = modelRequired + customRequired;
      const deptInfo = getDepartmentInfo(dept);

      content += `
        <div style="background: ${deptInfo.bgColor}; padding: 12px; border-bottom: 1px solid #e9ecef; font-weight: bold; display:flex; align-items:center; gap:8px; justify-content:space-between;">
          <span>${departmentBadgeHtml(dept, true)}</span>
          <span>${totalAssigned}/${totalRequired} prepared</span>
        </div>
        <div style="padding: 12px;">
      `;

      const assignmentRows = [
        ...models.map(model => ({ type: 'model', sortName: modelGroupSortName(model), model })),
        ...customAssets.map(asset => ({
          type: 'custom',
          sortName: customAssetSortName(asset.parsedCustom || parseCustomAsset(asset.id, asset)),
          asset
        }))
      ].sort((a, b) => compareByDisplayName(a.sortName, b.sortName));

      assignmentRows.forEach(row => {
        if (row.type === 'model') {
          const model = row.model;
          const assignedCount = getPreparedQuantity(model);
          const statusIcon = assignedCount >= model.requiredQuantity ? "✅" : "⚠️";

          content += `
            <div class="model-assignment" style="display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid #f1f1f1; gap:12px;">
              <div style="flex: 1; min-width:0;">
                <div style="display: flex; align-items: center; flex-wrap:wrap; gap:6px;">
                  <span>${statusIcon}</span>
                  <span style="font-weight: 500;">${Number(model.requiredQuantity || 0)}x ${escapeHtml(model.brand)} ${escapeHtml(model.model)}</span>
                  <span style="color: #666;">(${assignedCount} assigned)</span>
                </div>
                <div style="color: #666; font-size: 12px; margin-left: 22px; margin-top: 2px;">${escapeHtml(model.description || '')}</div>
              </div>
              <div style="display: flex; gap: 8px; flex-wrap:wrap; justify-content:flex-end;">
                <button class="btn btn-sm btn-outline-primary edit-model-qty-btn"
                        data-event-id="${eventId}"
                        data-brand="${escapeHtmlAttribute(model.brand)}"
                        data-model="${escapeHtmlAttribute(model.model)}"
                        data-department="${escapeHtmlAttribute(model.department)}"
                        data-description="${escapeHtmlAttribute(model.description || '')}"
                        style="padding: 4px 8px; font-size: 11px;">Edit Qty</button>
                <button class="btn btn-sm btn-danger remove-model-btn"
                        data-event-id="${eventId}"
                        data-brand="${escapeHtmlAttribute(model.brand)}"
                        data-model="${escapeHtmlAttribute(model.model)}"
                        data-department="${escapeHtmlAttribute(model.department)}"
                        data-description="${escapeHtmlAttribute(model.description || '')}"
                        style="padding: 4px 8px; font-size: 11px;">Remove</button>
              </div>
            </div>
          `;
          return;
        }

        const asset = row.asset;
        const custom = asset.parsedCustom;
        const statusIcon = asset.status === "returned" ? "↩️"
                         : asset.status === "prepared" ? "✅"
                         : asset.status === "collected" ? "📥"
                         : "📋";
        const displayName = customAssetDisplayName(custom);
        const safeId = escapeHtmlAttr(asset.id);
        const safeName = escapeHtmlAttr(custom.name);

        content += `
          <div class="custom-assignment" style="display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid #f1f1f1; gap:12px;">
            <div style="min-width:0; flex:1;">
              <div style="display: flex; align-items: center; flex-wrap:wrap; gap:6px;">
                <span>${statusIcon}</span>
                <span style="font-weight: 500;">${escapeHtml(displayName)}</span>
                ${customAssetTypeBadge(custom)}
              </div>
              ${custom.type === 'LOAN' && custom.company ? `<div style="color:#666;font-size:12px;margin-left:24px;margin-top:2px;">${escapeHtml(custom.company)}</div>` : ''}
            </div>
            <div style="display: flex; gap: 8px; flex-wrap:wrap; justify-content:flex-end;">
              <button class="btn btn-sm btn-outline-primary edit-custom-qty-btn"
                      data-event-id="${eventId}" data-asset-id="${safeId}"
                      data-asset-name="${safeName}" data-asset-type="${custom.type}"
                      style="padding: 4px 8px; font-size: 11px;">Edit Qty</button>
              <button class="btn btn-danger btn-sm remove-asset-btn"
                      data-event-id="${eventId}" data-asset-id="${safeId}"
                      style="padding: 4px 8px; font-size: 11px;">Remove</button>
            </div>
          </div>
        `;
      });

      content += '</div>';
    });

    if (!content.trim()) {
      content = `
        <div style="text-align: center; padding: 40px; color: #666;">
          No assets assigned to this event
        </div>
      `;
    }

    modelsContainer.innerHTML = content;

  } catch (error) {
    console.error("Error updating model requirements:", error);
  }
}

// Add custom assets to existing model requirements without changing format

async function removeModelFromEvent(eventId, brand, model, department, description = "") {
  const label = `${brand} ${model}${description ? ` (${description})` : ""}`;
  const confirmed = await showAppConfirm({
    title: 'Remove Model',
    message: `Remove ${label} from this event?`,
    confirmText: 'Remove',
    cancelText: 'Cancel',
    variant: 'danger',
  });
  if (!confirmed) return;

  try {
    await apiCall(`/api/events/${eventId}/models`, "DELETE", {
      brand,
      model,
      department,
      description, // <<< critical: disambiguates G52 vs L50
    });

    showNotification("success", `${label} removed from event`);

    // Reload available assets to reflect the newly available items
    const response = await apiCall("/api/assets/available");
    window.currentEditAvailableAssets = response.data;

    // Update only the models section without disrupting the search
    await updateModelRequirementsSection(eventId);
    await refreshEventOverviewViews();

    // Refresh the search results to show the model as available again
    const currentSearchTerm =
      document.querySelector('#edit-assets-tab input[placeholder*="Search available asset models"]')?.value;
    if (currentSearchTerm && currentSearchTerm.length >= 2) {
      filterAvailableModels(currentSearchTerm);
    }
  } catch (error) {
    showNotification("error", `Failed to remove model: ${error.message}`);
  }
}

function editModelQuantity(eventId, brand, model, department, description = "") {
  let currentQuantity = 1;

  fetch(`/api/events/${eventId}`)
    .then(r => r.json())
    .then(data => {
      const event = data.data;
      if (event.modelGroups) {
        const modelKey = Object.keys(event.modelGroups).find(key => {
          const m = event.modelGroups[key];
          return (
            m.brand === brand &&
            m.model === model &&
            m.department === department &&
            (m.description || "") === (description || "")
          );
        });

        if (modelKey) {
          const modelData = event.modelGroups[modelKey];
          currentQuantity = modelData.requiredQuantity || 1;
          populateEditQuantityModal(eventId, brand, model, department, currentQuantity, (modelData.description || ""));
        }
      }
    });
}

function populateEditQuantityModal(eventId, brand, model, department, currentQuantity, description) {
  const cleanDescription = description || '';
  const availableAssets = window.currentEditAvailableAssets || [];
  const availabilityList = window.currentEditAvailabilityList || [];

  const availabilityEntry = availabilityList.find(entry =>
    entry.department === department &&
    entry.brand === brand &&
    entry.model === model
  );

  const maxQuantity = availabilityEntry
    ? Number(availabilityEntry.physical || 0)
    : availableAssets.filter(asset =>
        asset.department === department &&
        asset.brand === brand &&
        asset.model === model
      ).length;

  // Populate modal
  document.getElementById("editQuantityTitle").textContent = `Edit Quantity - ${brand} ${model}`;
  document.getElementById("editQuantityLabel").textContent = `Current quantity: ${currentQuantity}`;
  document.getElementById("editQuantityInput").value = currentQuantity;
  document.getElementById("editQuantityInput").min = 1;
  document.getElementById("editQuantityInput").max = maxQuantity;
  document.getElementById("editQuantityEventId").value = eventId;
  document.getElementById("editQuantityBrand").value = brand;
  document.getElementById("editQuantityModel").value = model;
  document.getElementById("editQuantityDepartment").value = department;
  document.getElementById("editQuantityCurrentQty").value = currentQuantity;
  
  // Store the full description (add this hidden field to your HTML)
  document.getElementById("editQuantityDescription").value = description;

  validateEditQuantityInput();
  openModal("editQuantityModal");
}

// Handle blur for edit quantity modal


async function updateModelQuantity(eventId, brand, model, department, newQuantity, currentQuantity, description = "") {
  try {
    const maxQuantity = parseInt(document.getElementById("editQuantityInput")?.max || "0", 10);

    if (newQuantity > maxQuantity) {
      showNotification(
        "error",
        `Cannot set quantity to ${newQuantity}. Only ${maxQuantity} total units exist in inventory.`
      );
      return;
    }

    // Remove the old model assignment
    await apiCall(`/api/events/${eventId}/models`, "DELETE", {
      brand: brand,
      model: model,
      department: department,
      description: description,
    });

    // Add the new model assignment with updated quantity
    await apiCall(`/api/events/${eventId}/models`, "POST", {
      brand: brand,
      model: model,
      department: department,
      description: description,
      quantity: newQuantity,
    });

    showNotification("success", `Updated ${brand} ${model} quantity to ${newQuantity}`);

    // Update available assets count
    const quantityDifference = newQuantity - currentQuantity;
    if (window.currentEditAvailableAssets) {
      const availableAssets = window.currentEditAvailableAssets;
      const modelAssets = availableAssets.filter((a) => a.brand === brand && a.model === model);

      if (quantityDifference > 0) {
        // Quantity increased - remove more assets from available
        let removedCount = 0;
        window.currentEditAvailableAssets = window.currentEditAvailableAssets.filter((asset) => {
          if (asset.brand === brand && asset.model === model && removedCount < quantityDifference) {
            removedCount++;
            return false;
          }
          return true;
        });
      } else if (quantityDifference < 0) {
        // Quantity decreased - add assets back to available
        const assetsToAddBack = Math.abs(quantityDifference);
        for (let i = 0; i < assetsToAddBack && i < modelAssets.length; i++) {
          window.currentEditAvailableAssets.push(modelAssets[i]);
        }
      }
    }

    // Only update the model requirements section to maintain consistent UI
    await updateModelRequirementsSection(eventId);
    await refreshEventOverviewViews();

    // Refresh the search results if there's an active search
    const currentSearchTerm = document.querySelector('#edit-assets-tab input[placeholder*="Search available asset models"]')?.value;
    if (currentSearchTerm && currentSearchTerm.length >= 2) {
      filterAvailableModels(currentSearchTerm);
    }

  } catch (error) {
    showNotification("error", `Failed to update model quantity: ${error.message}`);
  }
}


function validateEditQuantityInput() {
  const input = document.getElementById("editQuantityInput");
  const maxQty = parseInt(input.max);
  const currentQty = parseInt(
    document.getElementById("editQuantityCurrentQty").value
  );
  let value = parseInt(input.value);

  if (isNaN(value) || value < 1) {
    input.style.borderColor = "#dc3545";
    return false;
  }

  if (value > maxQty) {
    input.style.borderColor = "#dc3545";
    input.value = maxQty;
    showNotification("warning", `Maximum ${maxQty} available`);
    return false;
  }

  input.style.borderColor = "#28a745";
  return true;
}

// Filter available assets for simple interface


function validateQuantityInput(inputId, maxAvailable) {
  const input = document.getElementById(inputId);
  if (!input) return;

  let value = input.value.trim();

  // Allow empty value during typing (don't force to 1 immediately)
  if (value === '') {
    input.style.borderColor = "#ddd";
    input.style.backgroundColor = "white";
    return;
  }

  // Parse the value
  const numValue = parseInt(value);

  // Check if value is valid number
  if (isNaN(numValue) || numValue < 1) {
    input.style.borderColor = "#dc3545";
    input.style.backgroundColor = "#fff5f5";
    return;
  }

  // Check if value exceeds maximum
  if (numValue > maxAvailable) {
    input.value = maxAvailable;
    input.style.borderColor = "#dc3545";
    input.style.backgroundColor = "#fff5f5";
    showNotification("warning", `Maximum ${maxAvailable} available`);
    return;
  }

  // Valid value
  input.style.borderColor = "#28a745";
  input.style.backgroundColor = "white";
}

// Handle when user clicks out of quantity input (blur event)
function handleQuantityBlur(inputId, maxAvailable) {
  const input = document.getElementById(inputId);
  if (!input) return;

  let value = input.value.trim();

  // If empty on blur, default to 1
  if (value === '' || isNaN(parseInt(value)) || parseInt(value) < 1) {
    input.value = 1;
    input.style.borderColor = "#28a745";
    input.style.backgroundColor = "white";
    return;
  }

  // If value exceeds maximum, set to maximum
  const numValue = parseInt(value);
  if (numValue > maxAvailable) {
    input.value = maxAvailable;
    showNotification("warning", `Maximum ${maxAvailable} available`);
  }

  // Final validation
  validateQuantityInput(inputId, maxAvailable);
}

// Handle special key behaviors for quantity input
function handleQuantityKeydown(event) {
  const input = event.target;
  
  // Allow: backspace, delete, tab, escape, enter
  if ([8, 9, 27, 13, 46].indexOf(event.keyCode) !== -1 ||
      // Allow: Ctrl+A, Ctrl+C, Ctrl+V, Ctrl+X
      (event.keyCode === 65 && event.ctrlKey === true) ||
      (event.keyCode === 67 && event.ctrlKey === true) ||
      (event.keyCode === 86 && event.ctrlKey === true) ||
      (event.keyCode === 88 && event.ctrlKey === true) ||
      // Allow: home, end, left, right
      (event.keyCode >= 35 && event.keyCode <= 39)) {
    return;
  }
  
  // Ensure that it is a number and stop the keypress
  if ((event.shiftKey || (event.keyCode < 48 || event.keyCode > 57)) && (event.keyCode < 96 || event.keyCode > 105)) {
    event.preventDefault();
  }
}


async function addAssetToEventSimple(eventId, assetId) {
  try {
    await apiCall(`/api/events/${eventId}/assets`, "POST", { assetId });
    showNotification("success", `Asset ${assetId} added to event`);

    // Remove the asset from the available list (since it's now assigned)
    const assetElement = document
      .querySelector(
        `[onclick*="addAssetToEventSimple(${eventId}, '${assetId}')"]`
      )
      .closest("div");
    if (assetElement) {
      assetElement.remove();
    }

    // Update the current assets section by adding the new asset
    const currentAssetsContainer = document.querySelector(
      "#edit-assets-tab > div:first-child > div:last-child"
    );
    if (currentAssetsContainer) {
      // Find the asset details from the available assets
      const availableAssets = window.currentEditAvailableAssets || [];
      const asset = availableAssets.find((a) => a.id === assetId);

      if (asset) {
        // Remove "no assets" message if it exists
        const noAssetsMsg = currentAssetsContainer.querySelector("p");
        if (
          noAssetsMsg &&
          noAssetsMsg.textContent.includes("No assets assigned")
        ) {
          noAssetsMsg.remove();
        }

        // Look for existing department section by checking the text content
        let deptHeaderElement = null;
        let deptAssetsContainer = null;

        // Find all department headers
        const allHeaders = currentAssetsContainer.querySelectorAll(
          'div[style*="background: #f8f9fa"]'
        );
        for (let header of allHeaders) {
          if (header.textContent.includes(`${asset.department} Department`)) {
            deptHeaderElement = header;
            // The assets container should be the next sibling
            deptAssetsContainer = header.nextElementSibling;
            break;
          }
        }

        if (deptHeaderElement && deptAssetsContainer) {
          // Add to existing department section
          const newAssetHTML = `
                        <div style="padding: 10px 12px; border-bottom: 1px solid #f1f1f1; display: flex; justify-content: space-between; align-items: center;">
                            <div>
                                <span>📋 ${asset.id} - ${asset.brand} ${
            asset.model
          } - ${asset.description || ""}</span>
                            </div>
                            <button class="btn btn-danger" style="padding: 4px 8px; font-size: 11px;" onclick="removeAssetFromEvent(${eventId}, '${
            asset.id
          }')">Remove</button>
                        </div>
                    `;
          deptAssetsContainer.insertAdjacentHTML("beforeend", newAssetHTML);

          // Update department count
          const currentCount = parseInt(
            deptHeaderElement.textContent.match(/\((\d+) assets?\)/)[1]
          );
          deptHeaderElement.textContent = `${asset.department} Department (${
            currentCount + 1
          } assets)`;
        } else {
          // Create new department section
          const deptHTML = `
                        <div style="background: #f8f9fa; padding: 8px 12px; font-weight: bold; border-bottom: 1px solid #e9ecef;">
                            ${asset.department} Department (1 assets)
                        </div>
                        <div class="dept-assets-${asset.department}">
                            <div style="padding: 10px 12px; border-bottom: 1px solid #f1f1f1; display: flex; justify-content: space-between; align-items: center;">
                                <div>
                                    <span>📋 ${asset.id} - ${asset.brand} ${
            asset.model
          } - ${asset.description || ""}</span>
                                </div>
                                <button class="btn btn-danger" style="padding: 4px 8px; font-size: 11px;" onclick="removeAssetFromEvent(${eventId}, '${
            asset.id
          }')">Remove</button>
                            </div>
                        </div>
                    `;
          currentAssetsContainer.insertAdjacentHTML("beforeend", deptHTML);
        }
      }
    }

    // Update the total asset count
    const assetsHeader = document.querySelector("#edit-assets-tab h4");
    if (assetsHeader) {
      const currentText = assetsHeader.textContent;
      const match = currentText.match(/\((\d+)\)/);
      if (match) {
        const currentCount = parseInt(match[1]);
        assetsHeader.textContent = `Current Assets (${currentCount + 1})`;
      }
    }

    // Remove the asset from our available assets array so it won't show up in future searches
    if (window.currentEditAvailableAssets) {
      window.currentEditAvailableAssets =
        window.currentEditAvailableAssets.filter((a) => a.id !== assetId);
    }

    await refreshEventOverviewViews();
  } catch (error) {
    showNotification("error", `Failed to add asset: ${error.message}`);
  }
}

async function assignSpecificAsset(eventId, assetId, brand, model) {
    let actionStarted = false;
    try {
        await ensureAssetsLoaded();
        if (!(await confirmDegradedAssetUse(assetId))) return;
        actionStarted = beginPrepareAssetAction(assetId, 'Preparing...');
        if (!actionStarted) return;
        const response = await apiCall(`/api/events/${eventId}/assign-specific`, 'POST', { assetId });
        await showApiWarning(response);
        const preparedAssetId = response?.data?.assetId || assetId;
        showNotification('success', `Assigned ${preparedAssetId} to event`);
        updateAllButtonsForAsset(preparedAssetId, true, { sourceAssetId: assetId });
        schedulePrepareUiSync(eventId);
    } catch (error) {
        console.error('Error in assignSpecificAsset:', error);
        showNotification('error', `Failed to assign asset: ${error.message}`);
        updateAllButtonsForAsset(assetId, false);
    } finally {
        if (actionStarted) endPrepareAssetAction(assetId);
    }
}

async function unassignSpecificAsset(eventId, assetId, brand, model) {
  try {
    // Use the new unassign-specific endpoint
    await apiCall(`/api/events/${eventId}/unassign-specific`, "POST", {
      assetId,
    });
    showNotification("success", `Unassigned ${assetId} from event`);
    updateAllButtonsForAsset(assetId, false);
    schedulePrepareUiSync(eventId);
  } catch (error) {
    showNotification("error", `Failed to unassign asset: ${error.message}`);
  }
}

function finishEventPreparation(eventId) {
    closeModal('prepareEventModal');
    showNotification('success', 'Event preparation completed');
    
    // Force refresh multiple views
    setTimeout(() => {
        if (document.getElementById('prepare-section').classList.contains('active')) {
            loadPrepareEvents();
        }
        if (document.getElementById('dashboard-section').classList.contains('active')) {
            loadDashboard();
        }
        if (document.getElementById('events-section').classList.contains('active')) {
            loadAllEvents();
        }
    }, 500);
}
function getDepartmentInfo(dept) {
  const deptInfo = {
    AX: { name: "Audio", color: "#007bff", bgColor: "#cce5ff" },
    LX: { name: "Lighting", color: "#28a745", bgColor: "#d4edda" },
    VX: { name: "Video", color: "#6f42c1", bgColor: "#e2d9f3" },
    UN: { name: "Unknown", color: "#6c757d", bgColor: "#e2e3e5" },
  };
  return deptInfo[dept] || { name: dept, color: "#6c757d", bgColor: "#e2e3e5" };
}


async function removeAssetFromEvent(eventId, assetId) {
    try {
        let endpoint;
        
        // Use different endpoints for custom vs regular assets
        if (isCustomAssetId(assetId)) {
            endpoint = `/api/events/${eventId}/custom-assets/remove`;
        } else {
            endpoint = `/api/events/${eventId}/remove-asset`;
        }
        
        const response = await apiCall(endpoint, 'POST', { assetId: assetId });
        
        if (response.success) {
            // Remove matching elements from UI without building an unsafe CSS selector from JSON custom IDs.
            const assetElements = Array.from(document.querySelectorAll('[data-asset-id]')).filter(element => {
                const raw = element.getAttribute('data-asset-id') || '';
                let decoded = raw;
                try { decoded = decodeURIComponent(raw); } catch (_) {}
                return raw === assetId || decoded === assetId;
            });
            assetElements.forEach(element => {
                const assetRow = element.closest('div[style*="display: flex"]') || element.closest('tr');
                if (assetRow) {
                    assetRow.remove();
                }
            });
            
            // Update the model requirements section to reflect changes
            await updateModelRequirementsSection(eventId);
            await refreshEventOverviewViews();
            
            const customAsset = parseCustomAsset(assetId);
            let removedAssetLabel = customAsset ? customAssetDisplayName(customAsset) : String(assetId || '').trim();
            if (!customAsset && String(assetId || '').startsWith(CUSTOM_ASSET_PREFIX)) {
                removedAssetLabel = 'the custom item';
            }
            await showAppAlert({
                title: 'Item Removed',
                message: removedAssetLabel
                    ? `Removed ${removedAssetLabel} from this event.`
                    : 'Removed the item from this event.',
                variant: 'info',
            });
        } else {
            throw new Error(response.error || 'Failed to remove asset');
        }
        
    } catch (error) {
        console.error('Error removing asset from event:', error);
        await showAppAlert({
            title: 'Remove Failed',
            message: `Error removing asset: ${error.message}`,
            variant: 'danger',
        });
  }
}

function modelAvailabilityLabel(available, requested, physical, overlap) {
  const availableQty = Math.max(0, Number(available || 0));
  const physicalQty = Math.max(0, Number(physical || 0));

  // Availability describes the inventory pool, not the quantity currently
  // typed into the Add field. Keep values such as 7/9 stable while editing.
  return `${availableQty}/${physicalQty || availableQty} available`;
}

function modelAvailabilityReasonTooltip(available, physical, reasons = {}) {
  const availableQty = Math.max(0, Number(available || 0));
  const physicalQty = Math.max(0, Number(physical || 0));
  if (availableQty >= physicalQty) return '';

  const rows = [];
  const addReason = (quantity, singular, plural = singular) => {
    const qty = Math.max(0, Number(quantity || 0));
    if (qty > 0) rows.push(`${qty} ${qty === 1 ? singular : plural}`);
    return qty;
  };

  let explainedQuantity = 0;
  explainedQuantity += addReason(reasons.assetOOC, 'asset is out of commission', 'assets are out of commission');
  explainedQuantity += addReason(reasons.assetMissing, 'asset is missing', 'assets are missing');
  explainedQuantity += addReason(
    reasons.bulkMaintenanceOOC,
    'bulk unit is out of commission',
    'bulk units are out of commission'
  );
  explainedQuantity += addReason(
    reasons.bulkMaintenanceMissing,
    'bulk unit is missing',
    'bulk units are missing'
  );
  explainedQuantity += addReason(
    reasons.usedHere,
    'asset is already requested for this event',
    'assets are already requested for this event'
  );

  const overlappingEvents = Array.isArray(reasons.overlapEvents) ? reasons.overlapEvents : [];
  const overlapQty = Math.max(0, Number(reasons.overlap || 0));
  if (overlappingEvents.length > 0) {
    overlappingEvents.forEach(event => {
      const eventName = String(event?.eventName || `Event ${event?.eventId || ''}`).trim();
      const startDate = String(event?.startDate || '').trim();
      const endDate = String(event?.endDate || '').trim();
      const dateRange = startDate && endDate
        ? (startDate === endDate ? startDate : `${startDate} - ${endDate}`)
        : (startDate || endDate);
      const quantity = Math.max(0, Number(event?.quantity || 0));
      rows.push(
        `${quantity} ${quantity === 1 ? 'asset is' : 'assets are'} used by ${eventName}` +
        `${dateRange ? ` (${dateRange})` : ''}`
      );
    });
    explainedQuantity += overlapQty;
  } else {
    explainedQuantity += addReason(
      overlapQty,
      'asset is used by an overlapping event',
      'assets are used by overlapping events'
    );
  }

  const shortfall = Math.max(physicalQty - availableQty, 0);
  if (explainedQuantity < shortfall) {
    addReason(
      shortfall - explainedQuantity,
      'asset is unavailable for another reason',
      'assets are unavailable for another reason'
    );
  }

  return `Why ${availableQty}/${physicalQty} are available:\n- ${rows.join('\n- ')}`;
}

function modelAvailabilityLabelHtml(available, physical, reasonTooltip = '') {
  const availableQty = Math.max(0, Number(available || 0));
  const physicalQty = Math.max(0, Number(physical || 0));
  const totalQty = physicalQty || availableQty;
  const countText = `${availableQty}/${totalQty}`;

  if (!reasonTooltip || availableQty >= totalQty) {
    return `${escapeHtml(countText)} available`;
  }

  return `<span class="availability-count-hint" title="${escapeHtmlAttr(reasonTooltip)}" aria-label="${escapeHtmlAttr(reasonTooltip)}" tabindex="0" style="cursor: help; text-decoration: underline dotted; text-underline-offset: 2px;">${escapeHtml(countText)} available</span>`;
}

function updateModelAvailabilityLabel(qtyInputId) {
  const input = document.getElementById(qtyInputId);
  const label = document.getElementById(`${qtyInputId}-availability`);
  if (!input || !label) return;

  const available = Number(label.dataset.available || 0);
  const physical = Number(label.dataset.physical || 0);
  const reasonTooltip = decodeURIComponent(label.dataset.availabilityTooltip || '');
  label.innerHTML = modelAvailabilityLabelHtml(
    available,
    physical,
    reasonTooltip
  );
}

function addAssetToEditModelGroup(modelGroups, asset, quantity = 1) {
  if (!asset) return null;

  const department = normalizeDepartmentCode(asset.department || asset.departmentCode || 'UN');
  const brand = String(asset.brand || '').trim();
  const model = String(asset.model || '').trim();

  if (!brand || !model) return null;

  const modelKey = `${department}|${brand}|${model}`;
  if (!modelGroups[modelKey]) {
    modelGroups[modelKey] = {
      department,
      brand,
      model,
      description: '',
      descriptionParts: [],
      count: 0,
      assets: []
    };
  }

  const description = String(asset.description || '').trim();
  if (description && !modelGroups[modelKey].descriptionParts.includes(description)) {
    modelGroups[modelKey].descriptionParts.push(description);
    modelGroups[modelKey].description = modelGroups[modelKey].descriptionParts.sort().join(' / ');
  }

  modelGroups[modelKey].count += Math.max(1, parseInt(quantity, 10) || 1);
  modelGroups[modelKey].assets.push(asset);
  return modelGroups[modelKey];
}

function buildEditAvailableAssetLookup(availableAssets = []) {
  const lookup = new Map();

  (availableAssets || []).forEach(asset => {
    if (!asset) return;
    [asset.id, asset.assetId, asset.internalId, asset.bulkId, asset.displayId]
      .map(value => String(value || '').trim())
      .filter(Boolean)
      .forEach(value => {
        lookup.set(value.toLowerCase(), asset);
      });
  });

  return lookup;
}

function findEditAvailableAsset(assetId, assetLookup) {
  const key = String(assetId || '').trim().toLowerCase();
  return key ? assetLookup.get(key) || null : null;
}

function buildContainerAvailableModelSummary(container, assetLookup) {
  const modelGroups = {};
  const missingAssetIds = [];
  const bulkAssetIds = [];

  (container?.assetIds || []).forEach(assetId => {
    const cleanAssetId = String(assetId || '').trim();
    if (!cleanAssetId) return;

    const asset = findEditAvailableAsset(cleanAssetId, assetLookup);
    if (!asset) {
      missingAssetIds.push(cleanAssetId);
      return;
    }

    if (asset.isBulk) {
      bulkAssetIds.push(cleanAssetId);
      return;
    }

    addAssetToEditModelGroup(modelGroups, asset, 1);
  });

  const groups = Object.values(modelGroups).sort((a, b) =>
    compareByDisplayName(modelGroupSortName(a), modelGroupSortName(b))
  );

  return {
    groups,
    missingAssetIds,
    bulkAssetIds,
    usableCount: groups.reduce((sum, group) => sum + Number(group.count || 0), 0),
    skippedCount: missingAssetIds.length + bulkAssetIds.length
  };
}

function editContainerSearchText(container, summary) {
  const groupText = (summary.groups || [])
    .flatMap(group => [group.department, group.brand, group.model, group.description])
    .join(' ');

  return [
    container?.id,
    getContainerSerialNumber(container),
    ...(container?.assetIds || []),
    groupText
  ].join(' ').toLowerCase();
}

function modelGroupMatchesEditGroup(group, department, brand, model) {
  return (
    normalizeDepartmentCode(group?.department || 'UN') === normalizeDepartmentCode(department || 'UN') &&
    String(group?.brand || '') === String(brand || '') &&
    String(group?.model || '') === String(model || '')
  );
}

function getCurrentEditModelQuantity(eventData, group) {
  return Object.values(eventData?.modelGroups || {}).reduce((total, modelGroup) => {
    if (!modelGroupMatchesEditGroup(modelGroup, group.department, group.brand, group.model)) {
      return total;
    }
    return total + Number(modelGroup.requiredQuantity || 0);
  }, 0);
}

function getEditModelPhysicalCount(group) {
  const availabilityEntry = (window.currentEditAvailabilityList || []).find(entry =>
    modelGroupMatchesEditGroup(entry, group.department, group.brand, group.model)
  );

  if (availabilityEntry) {
    return Number(availabilityEntry.physical || 0);
  }

  return (window.currentEditAvailableAssets || []).reduce((total, asset) => {
    if (!modelGroupMatchesEditGroup(asset, group.department, group.brand, group.model)) {
      return total;
    }
    return total + (asset.isBulk ? Number(asset.quantity || 1) : 1);
  }, 0);
}

async function refreshEditEventAfterModelChange(eventId) {
  const [eventResponse, availabilityResponse] = await Promise.all([
    apiCall(`/api/events/${eventId}`),
    apiCall(`/api/events/${eventId}/availability`)
  ]);

  window.currentEditEvent = eventResponse.data;
  window.currentEditAvailabilityList = availabilityResponse.data || [];

  await updateModelRequirementsSection(eventId);
  await refreshEventOverviewViews();

  const currentSearchTerm =
    document.querySelector('#edit-assets-tab input[placeholder*="Search available asset models"]')?.value;

  if (currentSearchTerm && currentSearchTerm.length >= 2) {
    filterAvailableModels(currentSearchTerm);
  }
}

async function addContainerContentsToEvent(eventId, containerId) {
  const cleanContainerId = String(containerId || '').trim();
  if (!cleanContainerId) {
    showNotification('error', 'Container ID is required');
    return;
  }

  let container = (window.currentEditContainers || []).find(item =>
    String(item?.id || '') === cleanContainerId
  );

  if (!container) {
    container = await getContainerById(cleanContainerId, true);
    if (container) {
      const existing = (window.currentEditContainers || []).filter(item =>
        String(item?.id || '') !== cleanContainerId
      );
      window.currentEditContainers = [...existing, container];
    }
  }

  if (!container) {
    showNotification('error', `Container ${cleanContainerId} was not found`);
    return;
  }

  const assetLookup = buildEditAvailableAssetLookup(window.currentEditAvailableAssets || []);
  const summary = buildContainerAvailableModelSummary(container, assetLookup);

  if (!summary.groups.length) {
    showNotification('warning', `Container ${cleanContainerId} has no available asset contents to add`);
    return;
  }

  let eventData = window.currentEditEvent;
  if (!eventData || Number(eventData.id) !== Number(eventId)) {
    const eventResponse = await apiCall(`/api/events/${eventId}`);
    eventData = eventResponse.data;
    window.currentEditEvent = eventData;
  }

  const overLimitGroup = summary.groups.find(group => {
    const physical = getEditModelPhysicalCount(group);
    const currentlyRequested = getCurrentEditModelQuantity(eventData, group);
    group.physicalCount = physical;
    group.currentlyRequested = currentlyRequested;
    return physical > 0 && currentlyRequested + Number(group.count || 0) > physical;
  });

  if (overLimitGroup) {
    showNotification(
      'error',
      `Cannot add container ${cleanContainerId}. ${overLimitGroup.brand} ${overLimitGroup.model} would exceed inventory (${overLimitGroup.currentlyRequested} already requested, ${overLimitGroup.count} in container, ${overLimitGroup.physicalCount} total).`
    );
    return;
  }

  const buttons = Array.from(document.querySelectorAll('.add-container-models-btn'))
    .filter(button => button.getAttribute('data-container-id') === cleanContainerId);
  buttons.forEach(button => {
    button.disabled = true;
    button.textContent = 'Adding...';
  });

  let addedGroups = 0;

  try {
    for (const group of summary.groups) {
      await apiCall(`/api/events/${eventId}/models`, 'POST', {
        brand: group.brand,
        model: group.model,
        department: group.department,
        description: group.description || '',
        quantity: Number(group.count || 1),
      });
      addedGroups++;
    }

    const skippedText = summary.skippedCount ? ` (${summary.skippedCount} skipped)` : '';
    showNotification(
      'success',
      `Added container ${cleanContainerId}: ${summary.usableCount} asset${summary.usableCount === 1 ? '' : 's'} across ${summary.groups.length} model${summary.groups.length === 1 ? '' : 's'}${skippedText}`
    );
  } catch (error) {
    showNotification('error', `Failed to add container contents: ${error.message}`);
  } finally {
    if (addedGroups > 0) {
      await refreshEditEventAfterModelChange(eventId);
    }

    buttons.forEach(button => {
      button.disabled = false;
      button.textContent = 'Add Contents';
    });
  }
}

function filterAvailableModels(searchTerm) {
  const container = document.getElementById("available-models-container");
  const availableAssets = window.currentEditAvailableAssets || [];
  const availableContainers = window.currentEditContainers || [];
  const eventId = window.currentEditEventId;
  const availabilityList = window.currentEditAvailabilityList || [];

  if (!container) {
    console.error("Available models container not found");
    return;
  }

  if (!searchTerm || searchTerm.length < 2) {
    container.innerHTML =
      '<div style="text-align: center; color: #666; padding: 20px;">Type at least 2 characters to search asset models or containers...</div>';
    return;
  }

  // Group the available physical pool by model type.
  const modelGroups = {};
  availableAssets.forEach(asset => {
    addAssetToEditModelGroup(
      modelGroups,
      asset,
      asset.isBulk ? Number(asset.quantity || 1) : 1
    );
  });

  // Filter models by search
  const searchLower = searchTerm.toLowerCase();
  const filteredModels = Object.values(modelGroups).filter(model => {
    const searchableText = `${model.brand} ${model.model} ${model.description}`.toLowerCase();
    return searchableText.includes(searchLower);
  });

  const assetLookup = buildEditAvailableAssetLookup(availableAssets);
  const filteredContainers = availableContainers
    .map(containerItem => {
      const summary = buildContainerAvailableModelSummary(containerItem, assetLookup);
      return { container: containerItem, summary };
    })
    .filter(item => editContainerSearchText(item.container, item.summary).includes(searchLower));

  if (filteredModels.length === 0 && filteredContainers.length === 0) {
    container.innerHTML = '<div style="text-align: center; color: #666; padding: 20px;">No matching asset models or containers found.</div>';
    return;
  }

  const adjustedAvailFor = (m) => {
    const list = window.currentEditAvailabilityList || [];

    const entry = list.find(e =>
      e.department === m.department &&
      e.brand === m.brand &&
      e.model === m.model
    );
    if (entry) {
      return {
        adjusted: (entry.available ?? 0),
        physical: (entry.physical ?? m.count),
        overlap: (entry.overlappingDemand ?? 0),
        overlapEvents: (entry.overlappingEvents ?? []),
        usedHere: (entry.usedInThisEvent ?? 0),
        assetOOC: (entry.assetOOC ?? 0),
        assetMissing: (entry.assetMissing ?? 0),
        bulkMaintenanceOOC: (entry.bulkMaintenanceOOC ?? 0),
        bulkMaintenanceMissing: (entry.bulkMaintenanceMissing ?? 0)
      };
    }

    return {
      adjusted: m.count,
      physical: m.count,
      overlap: 0,
      overlapEvents: [],
      usedHere: 0,
      assetOOC: 0,
      assetMissing: 0,
      bulkMaintenanceOOC: 0,
      bulkMaintenanceMissing: 0
    };
  };

  let html = '';
  filteredContainers.slice(0, 10).forEach(item => {
    const containerItem = item.container;
    const summary = item.summary;
    const containerId = String(containerItem?.id || '');
    const containerSerial = getContainerSerialNumber(containerItem);
    const canAdd = summary.groups.length > 0;
    const modelSummary = summary.groups.length
      ? summary.groups.slice(0, 4).map(group =>
          `${group.count}x ${escapeHtml(group.brand)} ${escapeHtml(group.model)}`
        ).join(', ')
      : 'No available contents';
    const remainingModels = Math.max(0, summary.groups.length - 4);
    const skippedParts = [];

    if (summary.missingAssetIds.length) {
      skippedParts.push(`${summary.missingAssetIds.length} unavailable`);
    }
    if (summary.bulkAssetIds.length) {
      skippedParts.push(`${summary.bulkAssetIds.length} bulk skipped`);
    }

    html += `
      <div style="padding: 12px; border-bottom: 1px solid #f1f1f1; display: flex; justify-content: space-between; align-items: center; gap: 12px;">
        <div style="flex: 1; min-width: 0;">
          <div style="font-weight: 600; margin-bottom: 4px;">Container ${escapeHtml(containerId)}</div>
          ${containerSerial ? `<div style="color: #666; font-size: 12px; margin-bottom: 2px;">SN: ${escapeHtml(containerSerial)}</div>` : ''}
          <div style="color: #666; font-size: 13px; margin-bottom: 2px;">${modelSummary}${remainingModels ? `, +${remainingModels} more` : ''}</div>
          <div style="font-size: 12px; color: ${canAdd ? '#28a745' : '#dc3545'};">
            ${summary.usableCount} addable asset${summary.usableCount === 1 ? '' : 's'}${skippedParts.length ? ` (${skippedParts.join(', ')})` : ''}
          </div>
        </div>
        <button class="btn btn-primary add-container-models-btn" style="padding: 6px 12px; font-size: 12px; white-space: nowrap;"
                data-event-id="${eventId}"
                data-container-id="${escapeHtmlAttribute(containerId)}"
                ${canAdd ? '' : 'disabled'}>
          Add Contents
        </button>
      </div>
    `;
  });

  filteredModels.slice(0, 20).forEach(model => {
    const qtyInputId = makeQtyInputId(
      model.department,
      model.brand,
      model.model,
      model.description || ''
    );

    const availability = adjustedAvailFor(model);
    const { adjusted, physical } = availability;
    const displayCount = Math.max(0, adjusted);
    const color = adjusted < 1 ? '#dc3545' : '#28a745'; // RED if fewer than 1 remaining
    const reasonTooltip = modelAvailabilityReasonTooltip(displayCount, physical, availability);
    const availabilityText = modelAvailabilityLabelHtml(
      displayCount,
      physical,
      reasonTooltip
    );

    html += `
      <div style="padding: 12px; border-bottom: 1px solid #f1f1f1; display: flex; justify-content: space-between; align-items: center;">
        <div style="flex: 1;">
          <div style="font-weight: 500; margin-bottom: 4px;">${model.brand} ${model.model}</div>
          <div style="color: #666; font-size: 13px; margin-bottom: 2px;">${model.description}</div>
          <div id="${qtyInputId}-availability" data-available="${displayCount}" data-physical="${physical}" data-availability-tooltip="${escapeHtmlAttr(encodeURIComponent(reasonTooltip))}" style="font-size: 12px; color: ${color};">${availabilityText}</div>
        </div>
        <div style="display: flex; align-items: center; gap: 10px;">
          <!-- The maximum stays bound to physical availability so adjusted counts below 1 can still be requested. -->
          <input type="number" id="${qtyInputId}" min="1" max="${physical}" value="1"
              style="width: 60px; padding: 4px; border: 1px solid #ddd; border-radius: 4px; font-size: 12px;"
              oninput="validateQuantityInput('${qtyInputId}', ${physical}); updateModelAvailabilityLabel('${qtyInputId}')"
              onblur="handleQuantityBlur('${qtyInputId}', ${physical}); updateModelAvailabilityLabel('${qtyInputId}')"
              onkeydown="handleQuantityKeydown(event)">
        <button class="btn btn-primary add-model-btn" style="padding: 6px 12px; font-size: 12px;"
                data-event-id="${eventId}"
                data-brand="${escapeHtmlAttribute(model.brand)}"
                data-model="${escapeHtmlAttribute(model.model)}"
                data-department="${escapeHtmlAttribute(model.department)}"
                data-description="${escapeHtmlAttribute(model.description || '')}">
          Add
        </button>
        </div>
      </div>
    `;
  });

  container.innerHTML = html;
}

// Toggle model details in edit interface
function toggleModelDetailsInEdit(modelId) {
  const detailsDiv = document.getElementById(modelId);
  const toggleIcon = document.querySelector(`[onclick*="${modelId}"] .toggle-icon`);

  if (detailsDiv && toggleIcon) {
    if (detailsDiv.style.display === "none") {
      detailsDiv.style.display = "block";
      toggleIcon.textContent = "▲";
    } else {
      detailsDiv.style.display = "none";
      toggleIcon.textContent = "▼";
    }
  }
}

async function deleteEvent(eventId) {
  if (!isAdminUser()) {
    showNotification('error', 'Admin privileges required');
    return;
  }

  const confirmed = await showAppConfirm({
    title: 'Delete Event',
    message: 'Are you sure you want to delete this event? This action cannot be undone.',
    confirmText: 'Delete',
    cancelText: 'Cancel',
    variant: 'danger',
  });
  if (!confirmed) return;

  try {
    await apiCall(`/api/events/${eventId}`, "DELETE");
    showNotification("success", "Event deleted successfully");

    // Refresh the current view
    if (
      document.getElementById("dashboard-section").classList.contains("active")
    ) {
      loadDashboard();
    } else if (
      document.getElementById("events-section").classList.contains("active")
    ) {
      loadAllEvents();
    }
  } catch (error) {
    showNotification("error", "Failed to delete event");
  }
}


let __addAssetPreviewTimer = null;
let __addAssetPreviewSequence = 0;

function addAssetField(id) {
  return document.getElementById(id);
}

function addAssetValue(id) {
  return (addAssetField(id)?.value || '').trim();
}

function addAssetQuantityValue() {
  return Math.max(1, Math.min(500, parseInt(addAssetValue('assetQuantity') || '1', 10) || 1));
}

function addAssetSerialList() {
  const serialText = addAssetField('assetSerials')?.value || '';
  return serialText
    .split(/\r?\n/)
    .map(value => value.trim())
    .filter(Boolean);
}

function collectAddAssetPayload() {
  const useCustomPrefix = addAssetField('assetUseCustomPrefix')?.checked || false;
  const isBulk = addAssetField('assetIsBulk')?.checked || false;
  const serials = isBulk ? [] : addAssetSerialList();

  if (addAssetField('assetSerial')) {
    addAssetField('assetSerial').value = serials[0] || '';
  }

  const payload = {
    brand: addAssetValue('assetBrand'),
    model: addAssetValue('assetModel'),
    description: addAssetValue('assetDescription'),
    notes: addAssetValue('assetNotes'),
    dateOfPurchase: addAssetValue('assetDateOfPurchase'),
    department: addAssetValue('assetDepartment') || 'UN',
    isBulk,
    quantity: addAssetQuantityValue(),
    serials
  };

  if (!isBulk && useCustomPrefix) {
    payload.assetIdPrefix = addAssetValue('assetIdPrefix');
  }

  return payload;
}

function uniqueSorted(values) {
  return Array.from(new Set(values.filter(Boolean))).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

function populateDatalist(id, values) {
  const datalist = addAssetField(id);
  if (!datalist) return;
  datalist.innerHTML = uniqueSorted(values)
    .map(value => `<option value="${escapeHtmlAttr(value)}"></option>`)
    .join('');
}

function normalizeAddAssetLookup(value) {
  return String(value || '').trim().toLowerCase();
}

function addAssetSourceAssets() {
  return (assets || []).filter(asset => asset && !asset.isBulk);
}

function mostCommonAddAssetValue(values) {
  const counts = new Map();
  values
    .map(value => String(value || '').trim())
    .filter(Boolean)
    .forEach(value => {
      const key = normalizeAddAssetLookup(value);
      const existing = counts.get(key) || { value, count: 0 };
      existing.count += 1;
      counts.set(key, existing);
    });

  return Array.from(counts.values())
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value, undefined, { sensitivity: 'base' }))[0]?.value || '';
}

function setAddAssetAutofillValue(id, value) {
  const element = addAssetField(id);
  if (!element || !value) return;
  element.value = value;
  element.dataset.addAssetAutofilled = 'true';
}

function canReplaceAddAssetField(id) {
  const element = addAssetField(id);
  return !!element && (!String(element.value || '').trim() || element.dataset.addAssetAutofilled === 'true');
}

function populateAddAssetSuggestions() {
  const sourceAssets = addAssetSourceAssets();
  const brandInput = normalizeAddAssetLookup(addAssetValue('assetBrand'));
  const modelInput = normalizeAddAssetLookup(addAssetValue('assetModel'));

  populateDatalist('assetBrandOptions', sourceAssets.map(asset => asset.brand || ''));

  const brandMatchedAssets = brandInput
    ? sourceAssets.filter(asset => normalizeAddAssetLookup(asset.brand).startsWith(brandInput))
    : [];

  populateDatalist('assetModelOptions', brandMatchedAssets.map(asset => asset.model || ''));

  const exactBrandModelAssets = sourceAssets.filter(asset => (
    normalizeAddAssetLookup(asset.brand) === brandInput &&
    normalizeAddAssetLookup(asset.model) === modelInput
  ));

  populateDatalist('assetDescriptionOptions', exactBrandModelAssets.map(asset => asset.description || ''));
}

function applyKnownAssetDefaults() {
  const brand = normalizeAddAssetLookup(addAssetValue('assetBrand'));
  const model = normalizeAddAssetLookup(addAssetValue('assetModel'));
  const matches = addAssetSourceAssets().filter(asset => (
    normalizeAddAssetLookup(asset.brand) === brand &&
    normalizeAddAssetLookup(asset.model) === model
  ));

  if (!matches.length) {
    if (addAssetField('assetDescription')?.dataset.addAssetAutofilled === 'true') {
      addAssetField('assetDescription').value = '';
      addAssetField('assetDescription').dataset.addAssetAutofilled = '';
    }
    if (addAssetField('assetDepartment')?.dataset.addAssetAutofilled === 'true') {
      addAssetField('assetDepartment').value = 'AX';
    }
    return;
  }

  const description = mostCommonAddAssetValue(matches.map(asset => asset.description));
  const department = mostCommonAddAssetValue(matches.map(asset => asset.department)) || 'UN';

  if (description && canReplaceAddAssetField('assetDescription')) {
    setAddAssetAutofillValue('assetDescription', description);
  }

  if (department && canReplaceAddAssetField('assetDepartment')) {
    setAddAssetAutofillValue('assetDepartment', department);
  }
}

function syncAddAssetSuggestionsAndDefaults() {
  populateAddAssetSuggestions();
  applyKnownAssetDefaults();
  scheduleAddAssetPreview();
}

function renderAddAssetPreview(className, html) {
  const preview = addAssetField('assetIdPreview');
  if (!preview) return;
  preview.className = `add-asset-preview${className ? ` ${className}` : ''}`;
  preview.innerHTML = html;
}

function previewAssetIdList(ids) {
  if (!ids || ids.length === 0) return '';
  if (ids.length <= 8) return ids.map(id => `<strong>${escapeHtml(id)}</strong>`).join(', ');
  return [
    ...ids.slice(0, 4).map(id => `<strong>${escapeHtml(id)}</strong>`),
    '&hellip;',
    `<strong>${escapeHtml(ids[ids.length - 1])}</strong>`
  ].join(', ');
}

function scheduleAddAssetPreview() {
  clearTimeout(__addAssetPreviewTimer);
  __addAssetPreviewTimer = setTimeout(updateAddAssetPreview, 180);
}

async function updateAddAssetPreview() {
  const payload = collectAddAssetPayload();
  const prefixInput = addAssetField('assetIdPrefix');
  const submitButton = addAssetField('addAssetSubmitButton');

  if (submitButton) {
    submitButton.textContent = payload.isBulk ? 'Add Bulk Asset' : (payload.quantity > 1 ? `Add ${payload.quantity} Assets` : 'Add Asset');
  }

  if (payload.isBulk) {
    if (prefixInput) prefixInput.placeholder = 'Not used for bulk assets';
    renderAddAssetPreview('', `Bulk quantity asset: <strong>${escapeHtml(String(payload.quantity))}</strong> total item(s).`);
    return;
  }

  if (!payload.brand || !payload.model) {
    if (prefixInput) prefixInput.placeholder = 'Auto';
    renderAddAssetPreview('', 'Enter brand and model to preview Asset IDs.');
    return;
  }

  const sequence = ++__addAssetPreviewSequence;

  try {
    const response = await fetch('/api/assets/serial-preview', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Client-Id': REALTIME_CLIENT_ID,
      },
      body: JSON.stringify(payload)
    });
    const result = await response.json();

    if (sequence !== __addAssetPreviewSequence) return;

    if (!response.ok) {
      throw new Error(result.error || 'Unable to preview Asset IDs');
    }

    const data = result.data || {};
    const existingText = data.existingCount
      ? `${data.existingCount} existing asset(s) in this brand/model prefix.`
      : 'New brand/model prefix.';

    if (prefixInput && !addAssetField('assetUseCustomPrefix')?.checked) {
      prefixInput.placeholder = data.prefix ? `Auto: ${data.prefix}` : 'Auto';
    }

    const serialCount = addAssetSerialList().length;
    const serialText = serialCount
      ? `<div>${serialCount} serial number(s) entered.</div>`
      : '';

    renderAddAssetPreview('success', `
      <div>${existingText}</div>
      <div>${escapeHtml(String(data.count || payload.quantity))} asset(s): ${previewAssetIdList(data.ids || [])}</div>
      ${serialText}
    `);
  } catch (error) {
    if (sequence !== __addAssetPreviewSequence) return;
    renderAddAssetPreview('error', escapeHtml(error.message || 'Unable to preview Asset IDs'));
  }
}

function updateAddAssetBulkFields() {
  const isBulk = addAssetField('assetIsBulk')?.checked || false;
  const serialisedFields = addAssetField('assetSerialisedFields');
  if (serialisedFields) serialisedFields.style.display = isBulk ? 'none' : 'block';
  if (isBulk && addAssetField('assetSerials')) addAssetField('assetSerials').value = '';
  scheduleAddAssetPreview();
}

async function prepareAddAssetModal() {
  try {
    if (!Array.isArray(assets) || assets.length === 0) {
      const response = await apiCall('/api/assets');
      assets = response.data || [];
    }
    populateAddAssetSuggestions();
    if (addAssetField('assetDepartment') && addAssetField('assetDepartment').dataset.addAssetAutofilled !== '') {
      addAssetField('assetDepartment').dataset.addAssetAutofilled = 'true';
    }
    applyKnownAssetDefaults();
    updateAddAssetBulkFields();
    scheduleAddAssetPreview();
  } catch (error) {
    console.warn('Could not prepare Add Assets modal:', error);
  }
}

function resetAddAssetForm() {
  const form = addAssetField('addAssetForm');
  if (form) form.reset();
  if (addAssetField('assetQuantity')) addAssetField('assetQuantity').value = 1;
  if (addAssetField('assetUseCustomPrefix')) addAssetField('assetUseCustomPrefix').checked = false;
  if (addAssetField('assetIdPrefix')) {
    addAssetField('assetIdPrefix').value = '';
    addAssetField('assetIdPrefix').disabled = true;
    addAssetField('assetIdPrefix').placeholder = 'Auto';
  }
  if (addAssetField('assetDescription')) addAssetField('assetDescription').dataset.addAssetAutofilled = '';
  if (addAssetField('assetDepartment')) addAssetField('assetDepartment').dataset.addAssetAutofilled = 'true';
  populateAddAssetSuggestions();
  updateAddAssetBulkFields();
}


// Form handlers
document.addEventListener("DOMContentLoaded", function () {
  // Add Event Form
  document
    .getElementById("addEventForm")
    .addEventListener("submit", async function (e) {
      e.preventDefault();

      if (!isAdminUser()) {
        showNotification("error", "Admin privileges required to add events");
        return;
      }

      const eventData = {
        name: document.getElementById("eventName").value,
        startDate: document.getElementById("eventStartDate").value,
        endDate: document.getElementById("eventEndDate").value,
        tag: document.getElementById("eventTag").value,
      };

      try {
        await apiCall("/api/events", "POST", eventData);
        closeModal("addEventModal");
        showNotification("success", "Event added successfully!");

        // Refresh the current view
        if (
          document
            .getElementById("dashboard-section")
            .classList.contains("active")
        ) {
          loadDashboard();
        } else if (
          document.getElementById("events-section").classList.contains("active")
        ) {
          loadAllEvents();
        }

        // Reset form
        document.getElementById("addEventForm").reset();
      } catch (error) {
        showNotification("error", "Failed to add event");
      }
    });

  const assetIsBulkToggle = document.getElementById('assetIsBulk');
  if (assetIsBulkToggle) {
    assetIsBulkToggle.addEventListener('change', updateAddAssetBulkFields);
    updateAddAssetBulkFields();
  }

  const addAssetInputs = [
    'assetBrand',
    'assetModel',
    'assetDescription',
    'assetDateOfPurchase',
    'assetDepartment',
    'assetQuantity',
    'assetSerials',
    'assetIdPrefix'
  ];

  addAssetInputs.forEach(id => {
    const element = document.getElementById(id);
    if (!element) return;
    element.addEventListener('input', scheduleAddAssetPreview);
    element.addEventListener('change', scheduleAddAssetPreview);
  });

  ['assetBrand', 'assetModel'].forEach(id => {
    const element = document.getElementById(id);
    if (!element) return;
    element.addEventListener('input', syncAddAssetSuggestionsAndDefaults);
    element.addEventListener('change', syncAddAssetSuggestionsAndDefaults);
  });

  ['assetDescription', 'assetDepartment'].forEach(id => {
    const element = document.getElementById(id);
    if (!element) return;
    const markManual = (event) => {
      if (event.isTrusted) element.dataset.addAssetAutofilled = '';
    };
    element.addEventListener('input', markManual);
    element.addEventListener('change', markManual);
  });

  const customPrefixToggle = document.getElementById('assetUseCustomPrefix');
  if (customPrefixToggle) {
    customPrefixToggle.addEventListener('change', () => {
      const prefixInput = document.getElementById('assetIdPrefix');
      if (prefixInput) {
        prefixInput.disabled = !customPrefixToggle.checked;
        if (!customPrefixToggle.checked) prefixInput.value = '';
        if (customPrefixToggle.checked) setTimeout(() => prefixInput.focus({ preventScroll: true }), 0);
      }
      scheduleAddAssetPreview();
    });
  }

  // Add Asset Form
  document
    .getElementById("addAssetForm")
    .addEventListener("submit", async function (e) {
      e.preventDefault();

      const assetData = collectAddAssetPayload();

      if (!assetData.isBulk && addAssetField('assetUseCustomPrefix')?.checked && !assetData.assetIdPrefix) {
        showNotification('warning', 'Custom Asset ID prefix is empty');
        return;
      }

      try {
        const response = await apiCall("/api/assets", "POST", assetData);
        closeModal("addAssetModal");
        const createdIds = response.assetIds || [];
        const createdMessage = createdIds.length > 1
          ? `Added ${createdIds.length} assets: ${createdIds[0]} to ${createdIds[createdIds.length - 1]}`
          : `Added ${createdIds[0] || 'asset'}`;
        showNotification("success", createdMessage);

        // Refresh inventory if we're on that page
        if (
          document
            .getElementById("inventory-section")
            .classList.contains("active")
        ) {
          await loadInventory();
        } else {
          const assetsResponse = await apiCall('/api/assets');
          assets = assetsResponse.data || [];
        }

        // Refresh dashboard stats
        loadDashboard();

        // Reset form
        resetAddAssetForm();
        populateAddAssetSuggestions();
      } catch (error) {
        renderAddAssetPreview('error', escapeHtml(error.message || 'Failed to add assets'));
      }
    });

  // Event delegation for assign and unassign buttons
  document.addEventListener('click', function(e) {
      if (e.target.classList.contains('assign-btn')) {
          e.preventDefault();
          const eventId = e.target.getAttribute('data-event-id');
          const assetId = e.target.getAttribute('data-asset-id');
          const brand = e.target.getAttribute('data-brand');
          const model = e.target.getAttribute('data-model');
          
          if (eventId && assetId && brand && model) {
              assignSpecificAsset(parseInt(eventId), assetId, brand, model);
          }
      }
      
      if (e.target.classList.contains('unassign-btn')) {
          e.preventDefault();
          const eventId = e.target.getAttribute('data-event-id');
          const assetId = e.target.getAttribute('data-asset-id');
          const brand = e.target.getAttribute('data-brand');
          const model = e.target.getAttribute('data-model');
          
          if (eventId && assetId && brand && model) {
              unassignSpecificAsset(parseInt(eventId), assetId, brand, model);
          }
      }

      if (e.target.classList.contains('add-model-btn')) {
          e.preventDefault();
          const eventId = parseInt(e.target.getAttribute('data-event-id'));
          const brand = e.target.getAttribute('data-brand');
          const model = e.target.getAttribute('data-model');
          const department = e.target.getAttribute('data-department');
          const description = e.target.getAttribute('data-description');
          
          if (eventId && brand && model && department) {
              addModelToEvent(eventId, brand, model, department, description);
          }
      }

      if (e.target.classList.contains('add-container-models-btn')) {
          e.preventDefault();
          const eventId = parseInt(e.target.getAttribute('data-event-id'));
          const containerId = e.target.getAttribute('data-container-id');

          if (eventId && containerId) {
              addContainerContentsToEvent(eventId, containerId);
          }
      }

      if (e.target.classList.contains('edit-model-qty-btn')) {
          e.preventDefault();
          const eventId = parseInt(e.target.getAttribute('data-event-id'));
          const brand = e.target.getAttribute('data-brand');
          const model = e.target.getAttribute('data-model');
          const department = e.target.getAttribute('data-department');
          
          if (eventId && brand && model && department) {
              const description = e.target.getAttribute('data-description') || '';
              editModelQuantity(eventId, brand, model, department, description);
          }
      }
    
    if (e.target.classList.contains('remove-model-btn')) {
      e.preventDefault();
      const eventId = parseInt(e.target.getAttribute('data-event-id'));
      const brand = e.target.getAttribute('data-brand');
      const model = e.target.getAttribute('data-model');
      const department = e.target.getAttribute('data-department');
      const description = e.target.getAttribute('data-description') || '';

      if (eventId && brand && model && department) {
          removeModelFromEvent(eventId, brand, model, department, description);
      }
    }
    
    if (e.target.classList.contains('remove-asset-btn')) {
        e.preventDefault();
        const eventId = parseInt(e.target.getAttribute('data-event-id'));
        const assetId = e.target.getAttribute('data-asset-id');
        
        if (eventId && assetId) {
            removeAssetFromEvent(eventId, assetId);
        }
    }

    if (e.target.classList.contains('edit-custom-qty-btn')) {
        e.preventDefault();
        const eventId = parseInt(e.target.getAttribute('data-event-id'));
        const assetId = e.target.getAttribute('data-asset-id');
        const assetName = e.target.getAttribute('data-asset-name');
        const assetType = e.target.getAttribute('data-asset-type');
        
        if (eventId && assetId && assetName && assetType) {
            editCustomAssetQuantity(eventId, assetId, assetName, assetType);
        }
    }
  });

  // Handle edit event form submission dynamically
  document.addEventListener("submit", async function (e) {
    if (e.target.id === "editEventDetailsForm") {
      e.preventDefault();

      const eventId = document.getElementById("editEventId").value;
      const eventData = {
        name: document.getElementById("editEventName").value,
        startDate: document.getElementById("editEventStartDate").value,
        endDate: document.getElementById("editEventEndDate").value,
        tag: document.getElementById("editEventTag").value,
      };

      try {
        await apiCall(`/api/events/${eventId}`, "PUT", eventData);
        closeModal("eventDetailsModal");
        showNotification("success", "Event updated successfully!");

        // Refresh the current view
        if (
          document
            .getElementById("dashboard-section")
            .classList.contains("active")
        ) {
          loadDashboard();
        } else if (
          document.getElementById("events-section").classList.contains("active")
        ) {
          loadAllEvents();
        }

        // Also refresh prepare section if it's active
        if (
          document.getElementById("prepare-section").classList.contains("active")
        ) {
          loadPrepareEvents();
        }
      } catch (error) {
        showNotification("error", "Failed to update event");
      }
    }
  });

  // Prepare Asset Form
  const prepareAssetForm = document.getElementById("prepareAssetForm");
  if (prepareAssetForm) {
    prepareAssetForm.addEventListener("submit", async function (e) {
      e.preventDefault();

      const eventIdEl = document.getElementById("prepareEventId");
      const assetIdEl = document.getElementById("prepareAssetId");

      if (!eventIdEl || !assetIdEl) {
        console.error("Prepare asset form elements not found");
        showNotification("error", "Form not properly loaded");
        return;
      }

      const eventId = eventIdEl.value;
      const assetId = assetIdEl.value;

      try {
        await apiCall(`/api/events/${eventId}/prepare`, "POST", { assetId });
        closeModal("prepareAssetModal");
        showNotification("success", "Asset prepared successfully!");

        // Refresh prepare events view
        if (
          document
            .getElementById("prepare-section")
            .classList.contains("active")
        ) {
          loadPrepareEvents();
        }

        // Reset form
        prepareAssetForm.reset();
      } catch (error) {
        showNotification("error", "Failed to prepare asset");
      }
    });
  }

  // Return Asset Form
  document
    .getElementById("returnAssetForm")
    .addEventListener("submit", async function (e) {
      e.preventDefault();

      const eventId = document.getElementById("returnEventId").value;
      const assetId = document.getElementById("returnAssetId").value;

      try {
        await apiCall(`/api/events/${eventId}/return`, "POST", { assetId });
        closeModal("returnAssetModal");
        showNotification("success", "Asset returned successfully!");

        // Refresh return events view
        if (
          document.getElementById("return-section").classList.contains("active")
        ) {
          loadReturnEvents();
        }

        // Reset form
        document.getElementById("returnAssetForm").reset();
      } catch (error) {
        showNotification("error", "Failed to return asset");
      }
    });

  // Transfer Asset Form
  document
    .getElementById("transferForm")
    .addEventListener("submit", async function (e) {
      e.preventDefault();

      const assetId = document.getElementById("transferAssetId").value;
      const fromEventId = document.getElementById("transferFromEvent").value;
      const toEventId = document.getElementById("transferToEvent").value;

      if (fromEventId === toEventId) {
        showNotification(
          "error",
          "Source and destination events cannot be the same"
        );
        return;
      }

      try {
        await apiCall(`/api/events/${toEventId}/transfer`, "POST", {
          assetId,
          fromEventId: parseInt(fromEventId),
        });
        closeModal("transferModal");
        showNotification("success", "Asset transferred successfully!");

        // Refresh transfer view
        if (
          document
            .getElementById("transfer-section")
            .classList.contains("active")
        ) {
          loadTransferHistory();
        }

        // Reset form
        document.getElementById("transferForm").reset();
      } catch (error) {
        showNotification("error", "Failed to transfer asset");
      }
    });

  // Maintenance Form
  const maintenanceForm = document.getElementById("maintenanceForm");
  if (maintenanceForm) {
    maintenanceForm.addEventListener("submit", async function (e) {
      e.preventDefault();
      if (maintenanceForm.dataset.submitting === "true") return;

      if (selectedMaintenanceAssets.size === 0) {
        showNotification("warning", "Please select at least one asset");
        return;
      }

      const logEntry = document.getElementById("maintenanceLogEntry").value.trim();
      const maintenanceDate = document.getElementById("maintenanceDate").value;
      const newLocation = document.getElementById("maintenanceNewLocation").value.trim();
      const logType = normalizeMaintenanceLogType(document.getElementById("maintenanceLogType")?.value, false);

      const newSerialElement = document.getElementById("maintenanceNewSerial");
      const newSerial = newSerialElement ? newSerialElement.value.trim() : '';
      const maintenanceCost = document.getElementById("maintenanceCost")?.value.trim() || '';
      
      // Get the requested asset status from the cleaned-up selector.
      const statusValue = document.getElementById('maintenanceAssetStatus')?.value || 'nochange';

      if (!logEntry) {
        showNotification("warning", "Please enter a maintenance log entry");
        return;
      }

      if (!maintenanceDate) {
        showNotification("warning", "Please select a maintenance date");
        return;
      }

      const submitButton = document.getElementById("maintenanceSubmitButton");
      const cancelButton = document.getElementById("maintenanceCancelButton");
      const closeButton = document.getElementById("maintenanceCloseButton");
      const progressPanel = document.getElementById("maintenanceSubmitProgress");
      const progressText = document.getElementById("maintenanceSubmitProgressText");
      const progressBar = document.getElementById("maintenanceSubmitProgressBar");
      const originalButtonText = submitButton?.textContent || "Log Maintenance";
      const updateProgress = (message, percent) => {
        if (progressPanel) progressPanel.style.display = "block";
        if (progressText) progressText.textContent = message;
        if (progressBar) progressBar.style.width = `${Math.max(5, Math.min(100, percent))}%`;
      };

      maintenanceForm.dataset.submitting = "true";
      maintenanceForm.setAttribute("aria-busy", "true");
      if (submitButton) {
        submitButton.disabled = true;
        submitButton.textContent = "Saving...";
      }
      if (cancelButton) cancelButton.disabled = true;
      if (closeButton) closeButton.disabled = true;
      updateProgress("Preparing maintenance log...", 8);

      try {
        let successCount = 0;
        let errorCount = 0;
        const errors = [];
        const succeededIds = new Set();
        const selectedAssetIds = Array.from(selectedMaintenanceAssets);
        const requestId = maintenanceForm.dataset.requestId
          || globalThis.crypto?.randomUUID?.()
          || `maintenance-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        maintenanceForm.dataset.requestId = requestId;
        const findSelectedAsset = assetId => assets.find(asset => (
          getAssetIdentifierForApi(asset) === assetId || String(asset.id || "") === assetId
        ));
        const standardAssetIds = selectedAssetIds.filter(assetId => !findSelectedAsset(assetId)?.isBulk);
        const bulkAssetIds = selectedAssetIds.filter(assetId => !!findSelectedAsset(assetId)?.isBulk);
        const maintenanceData = {
          logEntry,
          logType,
          maintenanceDate,
          newLocation: newLocation || null,
          newSerial: newSerial || null,
          cost: maintenanceCost || null,
          assetStatus: statusValue,
          markOOC: statusValue === "ooc",
          unmarkOOC: statusValue === "ok",
          markMissing: statusValue === "missing",
          unmarkMissing: statusValue === "ok",
          markDegraded: statusValue === "degraded",
          unmarkDegraded: statusValue === "ok",
          markDecommissioned: statusValue === "decommissioned",
          unmarkDecommissioned: statusValue === "ok",
          requestId
        };

        // Standard assets are persisted together, avoiding one full inventory rewrite per asset.
        if (standardAssetIds.length) {
          updateProgress(
            `Saving ${standardAssetIds.length} maintenance entr${standardAssetIds.length === 1 ? "y" : "ies"}...`,
            25
          );
          try {
            const batchPayload = {
              ...maintenanceData,
              assetIds: JSON.stringify(standardAssetIds)
            };
            const requestData = maintenancePayloadToRequestData(batchPayload, "maintenanceMediaFiles");
            const response = await apiCall("/api/assets/maintenance/batch", "POST", requestData);
            (response.results || []).forEach(result => {
              if (result.assetId) succeededIds.add(result.assetId);
            });
            successCount += Number(response.successCount || 0);
            errorCount += Number(response.errorCount || 0);
            (response.errors || []).forEach(item => errors.push(`${item.assetId}: ${item.error}`));
          } catch (error) {
            console.error("Failed to log batch maintenance:", error);
            errorCount += standardAssetIds.length;
            standardAssetIds.forEach(assetId => errors.push(`${assetId}: ${error.message}`));
          }
        }

        // Bulk records have quantity-specific rules, so they retain their dedicated endpoint.
        for (let index = 0; index < bulkAssetIds.length; index++) {
          const assetId = bulkAssetIds[index];
          const completed = standardAssetIds.length + index;
          const total = selectedAssetIds.length;
          updateProgress(
            `Saving asset ${Math.min(completed + 1, total)} of ${total}...`,
            25 + Math.round((completed / Math.max(total, 1)) * 55)
          );
          try {
            const encodedAssetId = encodeURIComponent(assetId);
            const requestData = maintenancePayloadToRequestData(maintenanceData, "maintenanceMediaFiles");
            await apiCall(`/api/assets/${encodedAssetId}/maintain`, "POST", requestData);
            successCount++;
            succeededIds.add(assetId);
          } catch (error) {
            console.error(`Failed to log maintenance for ${assetId}:`, error);
            errorCount++;
            errors.push(`${assetId}: ${error.message}`);
          }
        }

        if (successCount > 0) {
          let statusMessage = "";
          if (statusValue === "ooc") {
            statusMessage = " and marked as OOC";
          } else if (statusValue === "missing") {
            statusMessage = " and marked as Missing";
          } else if (statusValue === "degraded") {
            statusMessage = " and marked as Degraded";
          } else if (statusValue === "decommissioned") {
            statusMessage = " and marked as Decommissioned";
          } else if (statusValue === "ok") {
            statusMessage = " and marked as OK";
          }
          showNotification("success", `Maintenance logged for ${successCount} asset${successCount > 1 ? 's' : ''}${statusMessage}`);
        }
        
        if (errorCount > 0) {
          console.error('Maintenance errors:', errors);
          showNotification("error", `Failed to log maintenance for ${errorCount} asset${errorCount > 1 ? 's' : ''}. Check console for details.`);
        }

        if (successCount > 0) {
          updateProgress("Maintenance saved. Refreshing asset data...", 85);

          // Update assets data without refreshing search results.
          try {
            const assetsResponse = await apiCall("/api/assets");
            if (assetsResponse.success) {
              assets = assetsResponse.data;
            }
          } catch (error) {
            console.error("Failed to refresh assets data:", error);
          }

          const maintenanceSearchInput = document.getElementById("maintenance-search");
          const assetSearchInput = document.getElementById("asset-search");
          const isMaintenanceSearchActive = maintenanceSearchInput && maintenanceSearchInput.value.trim().length > 0;
          const isAssetSearchActive = assetSearchInput && assetSearchInput.value.trim().length > 0;

          if (document.getElementById("maintenance-section").classList.contains("active") && !isMaintenanceSearchActive) {
            loadMaintenanceAssets();
          }

          if (document.getElementById("inventory-section").classList.contains("active") && !isAssetSearchActive) {
            loadInventory();
          }

          succeededIds.forEach(assetId => selectedMaintenanceAssets.delete(assetId));
          updateSelectedAssetsDisplay();
          updateProgress("Maintenance log complete.", 100);

          if (errorCount === 0) {
            delete maintenanceForm.dataset.requestId;
            closeModal("maintenanceModal");
          }
        }

      } catch (error) {
        showNotification("error", "Failed to log maintenance");
        console.error("Maintenance error:", error);
      } finally {
        maintenanceForm.dataset.submitting = "false";
        maintenanceForm.removeAttribute("aria-busy");
        if (submitButton) {
          submitButton.disabled = false;
          submitButton.textContent = originalButtonText;
        }
        if (cancelButton) cancelButton.disabled = false;
        if (closeButton) closeButton.disabled = false;
        if (!document.getElementById("maintenanceModal")?.classList.contains("active") && progressPanel) {
          progressPanel.style.display = "none";
        }
      }
    });
  }

  const maintenanceMediaFiles = document.getElementById("maintenanceMediaFiles");
  if (maintenanceMediaFiles) {
    maintenanceMediaFiles.addEventListener("change", () => {
      updateMaintenanceMediaSelection("maintenanceMediaFiles", "maintenanceMediaFileList");
    });
  }

  // Maintenance search functionality
  const maintenanceSearch = document.getElementById("maintenance-search");
  if (maintenanceSearch) {
    maintenanceSearch.addEventListener("input", function (e) {
      const searchTerm = e.target.value.toLowerCase();
      const filteredAssets = assets.filter(
        (asset) => {
          const assetId = getAssetIdentifierForApi(asset).toLowerCase();
          return (
          assetId.includes(searchTerm) ||
          String(asset.id || '').toLowerCase().includes(searchTerm) ||
          asset.brand.toLowerCase().includes(searchTerm) ||
          asset.model.toLowerCase().includes(searchTerm) ||
          (asset.description &&
            asset.description.toLowerCase().includes(searchTerm))
          );
        }
      );

      displayMaintenanceAssets(filteredAssets);
    });
  }

  // Search functionality
  const eventSearch = document.getElementById("event-search");
  if (eventSearch) {
    eventSearch.addEventListener("input", function () {
      renderAllEventsList(events);
    });
  }

  const assetSearch = document.getElementById("asset-search");
  if (assetSearch) {
    assetSearch.addEventListener("input", displayFilteredInventory);
  }

  // Maintenance Asset Search functionality  
  const maintenanceAssetSearch = document.getElementById("maintenanceAssetSearch");
  if (maintenanceAssetSearch) {
    maintenanceAssetSearch.addEventListener("input", function (e) {
      searchMaintenanceAssets();
    });
    
    // Add Enter key handler for direct asset ID selection
    maintenanceAssetSearch.addEventListener("keypress", async function (e) {
      if (e.key === "Enter") {
        e.preventDefault();
        const searchTerm = normalizeScannedIdentifier(e.target.value);
        if (!searchTerm) return;
        await addIdentifierToMaintenanceSelection(searchTerm);
      }
    });
  }

  fetch("/api/stats")
    .then((response) => {
      if (response.status === 401) {
        window.location.href = "/login";
        return;
      }
      return response.json();
    })
    .then((data) => {
      if (data && data.success) {
        // Initialize application
        initializeApp();
      }
    })
    .catch((error) => {
      console.error("Authentication check failed:", error);
      // Still try to initialize in case of network issues
      initializeApp();
    });

  // Add to the existing event delegation
  document.addEventListener('click', function(e) {
      
      if (e.target.classList.contains('select-maintenance-btn')) {
          e.preventDefault();
          e.stopPropagation();
          const assetId = e.target.getAttribute('data-asset-id');
          if (assetId) {
              selectAssetForMaintenance(assetId);
          }
      }
      
      if (e.target.classList.contains('maintenance-asset-item')) {
          const assetId = e.target.getAttribute('data-asset-id');
          if (assetId) {
              selectAssetForMaintenance(assetId);
          }
      }
      // Container selector (used in Containers create/edit modal)
      if (handleContainerAssetSelectionClick(e)) return;
  });
  
  // Edit Quantity Form
  document.addEventListener("submit", async function (e) {
    if (e.target.id === "editQuantityForm") {
      e.preventDefault();

      const eventId = parseInt(document.getElementById("editQuantityEventId").value);
      const newQuantity = parseInt(document.getElementById("editQuantityInput").value);
      const currentQuantity = parseInt(document.getElementById("editQuantityCurrentQty").value);

      // Check if this is a custom asset edit
      const isCustomAsset = e.target.dataset.customAsset === "true";

      if (isCustomAsset) {
        // Handle custom asset quantity update
        const oldAssetId = document.getElementById("editQuantityBrand").value; // Asset ID stored here
        const assetName = document.getElementById("editQuantityModel").value;
        const assetType = document.getElementById("editQuantityDepartment").value;

        await updateCustomAssetQuantity(eventId, oldAssetId, assetName, assetType, newQuantity);
        
        // Clear the custom asset flag
        delete e.target.dataset.customAsset;
      } else {
          // Handle regular model quantity update
          const brand = document.getElementById("editQuantityBrand").value;
          const model = document.getElementById("editQuantityModel").value;
          const department = document.getElementById("editQuantityDepartment").value;
          const description = document.getElementById("editQuantityDescription").value;
          
          await updateModelQuantity(eventId, brand, model, department, newQuantity, currentQuantity, description);
        }

      closeModal("editQuantityModal");
    }
  });

function openMaintenanceModal() {
  // Check if elements exist before trying to use them
  const formEl = document.getElementById('maintenanceForm');
  const logEntryEl = document.getElementById('maintenanceLogEntry');
  const newLocationEl = document.getElementById('maintenanceNewLocation');
  const maintenanceDateEl = document.getElementById('maintenanceDate');
  const assetSearchEl = document.getElementById('maintenanceAssetSearch');
  const availableAssetsEl = document.getElementById('availableMaintenanceAssets');
  const logTypeEl = document.getElementById('maintenanceLogType');
  
  if (!logEntryEl || !newLocationEl || !maintenanceDateEl || !assetSearchEl || !availableAssetsEl) {
    console.error('Maintenance modal elements not found');
    showNotification('error', 'Maintenance modal not properly loaded');
    return;
  }

  if (formEl) {
    formEl.dataset.submitting = 'false';
    delete formEl.dataset.requestId;
    formEl.removeAttribute('aria-busy');
  }
  const submitProgressEl = document.getElementById('maintenanceSubmitProgress');
  const submitProgressBarEl = document.getElementById('maintenanceSubmitProgressBar');
  if (submitProgressEl) submitProgressEl.style.display = 'none';
  if (submitProgressBarEl) submitProgressBarEl.style.width = '8%';
  
  // Clear previous selections
  selectedMaintenanceAssets.clear();
  updateSelectedAssetsDisplay();
  
  // Clear form
  logEntryEl.value = '';
  newLocationEl.value = '';
  const maintenanceCostEl = document.getElementById('maintenanceCost');
  if (maintenanceCostEl) maintenanceCostEl.value = '';
  if (logTypeEl) logTypeEl.value = DEFAULT_MAINTENANCE_LOG_TYPE;
  const maintenanceMediaEl = document.getElementById('maintenanceMediaFiles');
  if (maintenanceMediaEl) maintenanceMediaEl.value = '';
  updateMaintenanceMediaSelection('maintenanceMediaFiles', 'maintenanceMediaFileList');
  
  // Set current date as default
  const today = new Date().toISOString().split('T')[0];
  maintenanceDateEl.value = today;
  
  // Reset status selector to "No Change"
  const statusSelect = document.getElementById('maintenanceAssetStatus');
  if (statusSelect) {
    statusSelect.value = 'nochange';
    applyMaintenanceStatusSelectStyle(statusSelect);
  }
  
  assetSearchEl.value = '';
  
  // Clear search results
  availableAssetsEl.innerHTML = 
    '<div style="padding: 20px; text-align: center; color: #666;">Type to search for assets...</div>';
  
  openModal('maintenanceModal');
}

function openMaintenanceModalForAsset(assetId) {
  // Ensure the modal is opened first
  openMaintenanceModal();
  
  // Pre-select the asset after a short delay to ensure DOM is ready
  setTimeout(() => {
    if (assets && assets.length > 0) {
      selectAssetForMaintenance(assetId);
    } else {
      console.warn('Assets not loaded yet, cannot pre-select asset');
    }
  }, 200);
}
function searchMaintenanceAssets() {
  const searchEl = document.getElementById('maintenanceAssetSearch');
  const container = document.getElementById('availableMaintenanceAssets');
  
  if (!searchEl || !container) {
    console.error('Search elements not found');
    return;
  }
  
  const searchTerm = searchEl.value.toLowerCase().trim();
  
  if (!searchTerm || searchTerm.length < 2) {
    container.innerHTML = '<div style="padding: 20px; text-align: center; color: #666;">Type at least 2 characters to search...</div>';
    return;
  }
  
  if (!assets || assets.length === 0) {
    container.innerHTML = '<div style="padding: 20px; text-align: center; color: #666;">No assets loaded. Please refresh the page.</div>';
    return;
  }
  
  // Filter assets based on search term
  const filteredAssets = assets.filter(asset => {
    const assetId = getAssetIdentifierForApi(asset);
    const searchableText = `${asset.id || ''} ${assetId} ${asset.bulkId || ''} ${asset.internalId || ''} ${asset.brand || ''} ${asset.model || ''} ${asset.serial || ''} ${escapeJs(asset.description || '')}`.toLowerCase();
    return searchableText.includes(searchTerm) && !selectedMaintenanceAssets.has(assetId);
  });
  
  if (filteredAssets.length === 0) {
    container.innerHTML = '<div style="padding: 20px; text-align: center; color: #666;">No matching assets found.</div>';
    return;
  }
  
  let html = '';
  filteredAssets.slice(0, 50).forEach(asset => { // Limit to 50 results
    const assetId = getAssetIdentifierForApi(asset);
    const displayId = assetMaintenanceDisplayId(asset);
    const statusBadge = getAssetStatusBadge(asset);
    const locationText = asset.location || 'Store';
    const quantityText = asset.isBulk
      ? `<span style="color: #666; font-size: 12px; margin-left: 8px;">Qty: ${escapeHtml(String(asset.availableQuantity ?? asset.quantity ?? 1))}/${escapeHtml(String(asset.quantity ?? 1))}</span>`
      : '';
    
    html += `
      <div style="padding: 12px; border-bottom: 1px solid #f1f1f1; display: flex; justify-content: space-between; align-items: center; cursor: pointer; transition: background-color 0.2s;"
           onmouseover="this.style.backgroundColor='#f8f9fa'" 
           onmouseout="this.style.backgroundColor='white'"
           onclick="selectAssetForMaintenance('${escapeJs(assetId)}')">
        <div style="flex: 1;">
          <div style="font-weight: 500; margin-bottom: 4px;">${escapeHtml(displayId)}${asset.isBulk ? ' <span class="asset-badge status-available">Bulk Item</span>' : ''}${quantityText}</div>
          <div style="color: #666; font-size: 13px; margin-bottom: 2px;">${asset.brand} ${asset.model}</div>
          <div style="color: #999; font-size: 12px;">${escapeJs(asset.description || '')}</div>
          <div style="margin-top: 4px;">
            ${statusBadge}
            <span style="color: #999; font-size: 11px; margin-left: 8px;">📍 ${locationText}</span>
          </div>
        </div>
        <button class="btn btn-primary" style="padding: 6px 12px; font-size: 12px;" onclick="event.stopPropagation(); selectAssetForMaintenance('${escapeJs(assetId)}')">
          Select
        </button>
      </div>
    `;
  });
  
  container.innerHTML = html;
}

function selectAssetForMaintenance(assetId) {
  if (!assets || assets.length === 0) {
    showNotification('error', 'Assets not loaded');
    return;
  }
  
  const asset = getAssetByApiIdentifier(assetId);
  if (!asset) {
    showNotification('error', `Asset ${assetId} not found`);
    return;
  }
  
  const apiId = getAssetIdentifierForApi(asset);
  if (asset.isBulk) {
    closeModal('maintenanceModal');
    openBulkMaintenanceFaultModal(apiId);
    return;
  }

  selectedMaintenanceAssets.add(apiId);
  updateSelectedAssetsDisplay();
  
  // Remove from search results
  searchMaintenanceAssets();
  
  showNotification('success', `Selected ${assetMaintenanceDisplayName(asset)} for maintenance`);
}

function removeAssetFromMaintenance(assetId) {
  selectedMaintenanceAssets.delete(assetId);
  updateSelectedAssetsDisplay();
  
  // Refresh search results
  searchMaintenanceAssets();
  
  showNotification('info', `Removed ${assetId} from selection`);
}

function updateSelectedAssetsDisplay() {
  const countElement = document.getElementById('selectedCount');
  const listElement = document.getElementById('selectedAssetsList');
  
  if (!countElement || !listElement) {
    console.error('Selected assets display elements not found');
    return;
  }
  
  countElement.textContent = selectedMaintenanceAssets.size;
  
  if (selectedMaintenanceAssets.size === 0) {
    listElement.innerHTML = '<span style="color: #666; font-style: italic;">No assets selected</span>';
    return;
  }
  
  let html = '<div style="display: flex; flex-wrap: wrap; gap: 8px;">';
  selectedMaintenanceAssets.forEach(assetId => {
    const asset = getAssetByApiIdentifier(assetId);
    if (asset) {
      const displayId = assetMaintenanceDisplayId(asset);
      const quantityText = asset.isBulk ? ` - Qty ${asset.availableQuantity ?? asset.quantity ?? 1}/${asset.quantity ?? 1}` : '';
      html += `
        <div style="background: #e7f3ff; border: 1px solid #b3d9ff; border-radius: 6px; padding: 6px 10px; display: flex; align-items: center; gap: 8px; font-size: 13px;">
          <span style="font-weight: 500;">${escapeHtml(displayId)}</span>
          <span style="color: #666;">- ${escapeHtml(`${asset.brand || ''} ${asset.model || ''}${quantityText}`.trim())}</span>
          <button onclick="removeAssetFromMaintenance('${assetId}')" style="background: none; border: none; color: #999; cursor: pointer; padding: 0; margin-left: 4px; font-size: 14px;" title="Remove">×</button>
        </div>
      `;
    } else {
      html += `
        <div style="background: #fff3cd; border: 1px solid #ffeaa7; border-radius: 6px; padding: 6px 10px; display: flex; align-items: center; gap: 8px; font-size: 13px;">
          <span style="font-weight: 500;">${assetId}</span>
          <span style="color: #666;">- Asset not found</span>
          <button onclick="removeAssetFromMaintenance('${assetId}')" style="background: none; border: none; color: #999; cursor: pointer; padding: 0; margin-left: 4px; font-size: 14px;" title="Remove">×</button>
        </div>
      `;
    }
  });
  html += '</div>';
  
  listElement.innerHTML = html;
}

function switchMaintenanceTab(tabName) {
  // Remove active class from all tabs
  document.querySelectorAll(".maintenance-tab").forEach((tab) => {
    tab.classList.remove("active");
    tab.style.background = "none";
    tab.style.borderBottomColor = "transparent";
    tab.style.color = "#666";
  });

  // Remove active class from all content
  document.querySelectorAll(".maintenance-content").forEach((content) => {
    content.classList.remove("active");
    content.style.display = "none";
  });

  // Add active class to clicked tab
  const activeTab = document.querySelector(`[data-tab="${tabName}"]`);
  if (activeTab) {
    activeTab.classList.add("active");
    activeTab.style.background = "rgba(118, 75, 162, 0.05)";
    activeTab.style.borderBottomColor = "#764ba2";
    activeTab.style.color = "#764ba2";
  }

  // Show corresponding content
  const contentDiv = document.getElementById(`${tabName}-assets-maintenance`);
  if (contentDiv) {
    contentDiv.classList.add("active");
    contentDiv.style.display = "block";
  }

  // Show/hide the "Log Maintenance" button based on the active tab
  const logMaintenanceBtn = document.getElementById('log-maintenance-btn');
  if (logMaintenanceBtn) {
    if (tabName === 'ooc') {
      // Hide the button in OOC/Missing tab
      logMaintenanceBtn.style.display = 'none';
    } else {
      // Show the button in All Assets tab
      logMaintenanceBtn.style.display = 'inline-block';
    }
  }

  // Load appropriate data
  if (tabName === "all") {
    loadMaintenanceAssets();
  } else if (tabName === "ooc") {
    loadOOCAssets();
  }
}

async function loadOOCAssets() {
  try {
    const response = await apiCall("/api/assets");
    maintenanceFlaggedAssets = response.data.filter(asset =>
      asset.isOOC ||
      asset.isMissing ||
      asset.isDegraded ||
      asset.isDisposed ||
      asset.isDecommissioned ||
      (asset.isBulk && (
        Number(asset.bulkOOCQuantity || 0) > 0 ||
        Number(asset.bulkMissingQuantity || 0) > 0 ||
        Number(asset.bulkDegradedQuantity || 0) > 0
      ))
    );
    
    filterOOCAssets();
    
    // Set up search functionality
    const searchInput = document.getElementById("ooc-search");
    if (searchInput) {
      searchInput.removeEventListener("input", filterOOCAssets);
      searchInput.addEventListener("input", filterOOCAssets);
    }
    
  } catch (error) {
    console.error("Error loading flagged assets:", error);
    document.getElementById("ooc-assets-list").innerHTML =
      '<p style="color: red; text-align: center;">Error loading flagged assets</p>';
  }
}

function flaggedMaintenanceVirtualRowHtml(asset) {
  const assetId = getAssetIdentifierForApi(asset);
  const displayId = assetMaintenanceDisplayId(asset);
  const statusHtml = assetFlagBadgesHtml(asset);
  const lastMaintenance = getLastAddedMaintenanceLog(asset);
  const lastFlagged = getLastFlaggedMaintenanceLog(asset);
  const lastFlaggedStatus = lastFlagged?.status
    ? lastFlagged.status.toUpperCase()
    : '';

  return `
    <tr
      class="ooc-asset-item"
      data-asset-id="${escapeHtmlAttr(assetId)}"
      role="button"
      tabindex="0"
      title="View maintenance log"
      onclick="viewMaintenanceLog('${escapeJs(assetId)}')"
      onkeydown="if(event.target === this && (event.key === 'Enter' || event.key === ' ')){event.preventDefault();viewMaintenanceLog('${escapeJs(assetId)}');}"
      style="cursor:pointer;"
    >
      <td style="font-weight:600;">
        ${escapeHtml(displayId)}
        ${asset.isBulk ? ' <span class="asset-badge status-available">Bulk Item</span>' : ''}
      </td>
      <td>${escapeHtml(`${asset.brand || ''} ${asset.model || ''}`.trim())}</td>
      <td>${statusHtml}</td>
      <td>${escapeHtml(asset.location || 'Store')}</td>
      <td>${escapeHtml(lastMaintenance?.date || 'Never')}</td>
      <td style="max-width:300px;white-space:normal;overflow-wrap:anywhere;">
        ${lastFlagged
          ? `${escapeHtml(lastFlagged.record.description || 'No reason provided')} <span style="color:#666;font-size:11px;">(${escapeHtml(lastFlaggedStatus)})</span>`
          : '—'}
      </td>
      <td>
        <button class="btn btn-primary btn-sm" onclick="event.stopPropagation(); openFlaggedAssetLogEntry('${escapeJs(assetId)}')" style="padding: 4px 8px; font-size: 11px;">
          Add Log
        </button>
      </td>
    </tr>
  `;
}

function displayOOCAssets(oocAssets) {
  const container = document.getElementById("ooc-assets-list");
  if (!container) return;

  if (oocAssets.length === 0) {
    destroyVirtualTable('maintenance-flagged');
    const hasSearch = !!document.getElementById('ooc-search')?.value.trim();
    container.innerHTML = hasSearch
      ? '<p style="text-align: center; color: #666; padding: 40px;">No flagged assets match this search.</p>'
      : '<p style="text-align: center; color: #666; padding: 40px;">No assets are currently marked as OOC, Missing, Degraded, or Decommissioned.</p>';
    return;
  }

  const sortedAssets = sortAssetsByLastAddedMaintenanceLog([...oocAssets]);
  renderVirtualTable({
    stateKey: 'maintenance-flagged',
    container,
    items: sortedAssets,
    columnCount: 7,
    estimatedRowHeight: 62,
    headerHtml: `
      <tr>
        <th>Asset ID</th>
        <th>Brand & Model</th>
        <th>Status</th>
        <th>Location</th>
        <th>Last Maintenance</th>
        <th>Flagged Reason</th>
        <th>Actions</th>
      </tr>
    `,
    rowHtml: flaggedMaintenanceVirtualRowHtml
  });
}


function openFlaggedAssetLogEntry(assetId) {
  const asset = getAssetByApiIdentifier(assetId);
  if (!asset) {
    showNotification('error', 'Asset not found');
    return;
  }

  if (asset.isBulk) {
    openBulkMaintenanceFaultModal(getAssetIdentifierForApi(asset));
    return;
  }

  openMaintenanceModalForAsset(getAssetIdentifierForApi(asset));
}

async function viewMaintenanceLog(assetId) {
  try {
    // Accept both raw IDs and encodeURIComponent IDs
    let decodedAssetId = String(assetId || '');

    try {
      decodedAssetId = decodeURIComponent(decodedAssetId);
    } catch (e) {
      // Keep original if it was not encoded
    }

    // Always refresh from backend so logs are current
    const assetsResponse = await apiCall('/api/assets');
    if (assetsResponse && assetsResponse.success) {
      assets = assetsResponse.data || [];
    }

    const asset = getAssetByApiIdentifier(decodedAssetId);

    if (!asset) {
      showNotification('error', `Asset not found: ${decodedAssetId}`);
      return;
    }

    if (typeof window.showMaintenanceLogModal === 'function') {
      window.showMaintenanceLogModal(asset);
      return;
    }

    if (typeof showMaintenanceLogModal === 'function') {
      showMaintenanceLogModal(asset);
      return;
    }

    showNotification('error', 'Maintenance log modal UI is not available. Please hard refresh.');

  } catch (error) {
    console.error('Error viewing maintenance log:', error);
    showNotification('error', `Failed to load maintenance log: ${error.message}`);
  }
}

function bulkMaintenanceStatusLabel(status) {
  const clean = String(status || '').toLowerCase();
  if (clean === 'ooc') return 'OOC';
  if (clean === 'missing') return 'Missing';
  if (clean === 'degraded') return 'Degraded';
  return clean ? clean.replace(/\b\w/g, c => c.toUpperCase()) : 'Fault';
}

function bulkMaintenanceStatusOptionsHtml(selectedStatus = 'ooc') {
  const selected = String(selectedStatus || 'ooc').toLowerCase();
  return ['ooc', 'missing', 'degraded'].map(value => {
    const meta = maintenanceStatusMeta(value);
    return `
    <option value="${escapeHtmlAttr(value)}" style="color:${meta.color};font-weight:600;" ${selected === value ? 'selected' : ''}>${escapeHtml(meta.label)}</option>
  `;
  }).join('');
}

function bulkMaintenanceFaultCapacity(asset) {
  const totalQty = Math.max(1, Number(asset?.quantity || 1) || 1);
  const openFaultQty = Math.max(0, Number(asset?.bulkFaultQuantity || 0) || 0);
  return Math.max(totalQty - openFaultQty, 0);
}

async function refreshBulkMaintenanceScreens(assetId, showLogbook = true) {
  const assetsResponse = await apiCall('/api/assets');
  if (assetsResponse.success) {
    assets = assetsResponse.data || [];
    const updatedAsset = getAssetByApiIdentifier(assetId);
    if (showLogbook && updatedAsset) showBulkMaintenanceLogModal(updatedAsset);
  }
  if (document.getElementById('inventory-section')?.classList.contains('active')) loadInventory();
  if (document.getElementById('maintenance-section')?.classList.contains('active')) loadMaintenanceAssets();
}

function openBulkMaintenanceFaultModal(assetId) {
  const asset = getAssetByApiIdentifier(assetId);
  const capacity = bulkMaintenanceFaultCapacity(asset);
  if (!asset) {
    showNotification('error', 'Bulk asset not found');
    return;
  }
  if (capacity <= 0) {
    showNotification('warning', 'All quantity in this bulk asset already has open maintenance logs');
    return;
  }

  const today = new Date().toISOString().split('T')[0];
  const existing = document.getElementById('bulkMaintenanceFaultModal');
  if (existing) existing.remove();

  document.body.insertAdjacentHTML('beforeend', `
    <div class="modal" id="bulkMaintenanceFaultModal" style="display:flex;align-items:center;justify-content:center;z-index:1200;">
      <div class="modal-content" style="max-width:620px;width:92%;max-height:90vh;overflow-y:auto;">
        <div class="modal-header">
          <h3 class="modal-title">Bulk Maintenance Log - ${escapeHtml(assetMaintenanceDisplayId(asset))}</h3>
          <button class="close-btn" onclick="closeBulkMaintenanceFaultModal()">&times;</button>
        </div>
        <form id="bulkMaintenanceFaultForm">
          <div style="background:#f8f9fa;border:1px solid #e9ecef;border-radius:8px;padding:12px;margin-bottom:16px;">
            <div style="font-weight:700;">${escapeHtml([asset.brand, asset.model].filter(Boolean).join(' '))}</div>
            <div style="color:#666;font-size:13px;">Available for new logs: ${escapeHtml(String(capacity))}/${escapeHtml(String(asset.quantity || 1))}</div>
          </div>
          <div class="form-group">
            <label class="form-label" for="bulkFaultQuantity">Quantity of Affected Assets</label>
            <input type="number" class="form-input" id="bulkFaultQuantity" min="1" max="${escapeHtmlAttr(String(capacity))}" value="1" required>
          </div>
          <div class="form-group">
            <label class="form-label" for="bulkFaultDescription">Maintenance Log Entry</label>
            <textarea class="form-input" id="bulkFaultDescription" rows="4" placeholder="Describe the fault or limitation" required></textarea>
          </div>
          <div class="form-group">
            <label class="form-label" for="bulkFaultMediaFiles">Photos / Videos</label>
            <input type="file" class="form-input" id="bulkFaultMediaFiles" multiple accept="image/*,video/*">
            <div id="bulkFaultMediaFileList" class="maintenance-media-selection"></div>
          </div>
          <div class="form-group">
            <label class="form-label" for="bulkFaultDate">Maintenance Date</label>
            <input type="date" class="form-input" id="bulkFaultDate" value="${escapeHtmlAttr(today)}" required>
          </div>
          <div class="form-group">
            <label class="form-label" for="bulkFaultStatus">Asset Status</label>
            <select class="form-input" id="bulkFaultStatus" data-maintenance-status-select="true" onchange="applyMaintenanceStatusSelectStyle(this)" required>
              ${bulkMaintenanceStatusOptionsHtml('ooc')}
            </select>
          </div>
          <div class="modal-actions">
            <button type="button" class="btn btn-secondary" onclick="closeBulkMaintenanceFaultModal()">Cancel</button>
            <button type="submit" class="btn btn-primary">Save Log</button>
          </div>
        </form>
      </div>
    </div>
  `);

  document.getElementById('bulkFaultMediaFiles')?.addEventListener('change', () => {
    updateMaintenanceMediaSelection('bulkFaultMediaFiles', 'bulkFaultMediaFileList');
  });

  document.getElementById('bulkMaintenanceFaultForm')?.addEventListener('submit', async event => {
    event.preventDefault();
    await submitBulkMaintenanceFault(assetId, capacity);
  });

  const modal = document.getElementById('bulkMaintenanceFaultModal');
  initialiseMaintenanceStatusSelects(modal);
  enhanceModalAccessibility(modal);
  focusModalStart(modal);
  modal.addEventListener('click', e => {
    if (e.target === modal) closeBulkMaintenanceFaultModal();
  });
}

function closeBulkMaintenanceFaultModal() {
  document.getElementById('bulkMaintenanceFaultModal')?.remove();
}

async function submitBulkMaintenanceFault(assetId, capacity) {
  const quantity = Number(document.getElementById('bulkFaultQuantity')?.value || 0);
  const description = document.getElementById('bulkFaultDescription')?.value.trim() || '';
  const maintenanceDate = document.getElementById('bulkFaultDate')?.value || '';
  const assetStatus = document.getElementById('bulkFaultStatus')?.value || 'ooc';

  if (!Number.isInteger(quantity) || quantity < 1 || quantity > capacity) {
    showNotification('warning', `Quantity must be between 1 and ${capacity}`);
    return;
  }
  if (!description) {
    showNotification('warning', 'Please enter a maintenance log entry');
    return;
  }
  if (!maintenanceDate) {
    showNotification('warning', 'Please select a maintenance date');
    return;
  }

  try {
    const payload = {
      affectedQuantity: quantity,
      logEntry: description,
      maintenanceDate,
      assetStatus,
      logType: 'Fault'
    };
    const requestData = maintenancePayloadToRequestData(payload, 'bulkFaultMediaFiles');
    await apiCall(`/api/assets/${encodeURIComponent(assetId)}/maintain`, 'POST', requestData);

    closeBulkMaintenanceFaultModal();
    showNotification('success', quantity === 1 ? 'Bulk maintenance log added' : `${quantity} bulk maintenance logs added`);
    await refreshBulkMaintenanceScreens(assetId, true);
  } catch (error) {
    showNotification('error', `Failed to add bulk maintenance log: ${error.message}`);
  }
}

function openBulkMaintenanceFaultEditModal(assetId, faultKey, logNumber) {
  const asset = getAssetByApiIdentifier(assetId);
  const row = bulkMaintenanceLogbookRows(asset).find(item =>
    String(item.key || item.id || '') === String(faultKey || '') ||
    String(item.id || '') === String(faultKey || '')
  );
  if (!asset || !row) {
    showNotification('error', 'Bulk maintenance log not found');
    return;
  }

  const report = row.fault || {};
  const dateForInput = String(report.date || '').replace(/\//g, '-') || new Date().toISOString().split('T')[0];
  const existing = document.getElementById('bulkMaintenanceFaultEditModal');
  if (existing) existing.remove();

  document.body.insertAdjacentHTML('beforeend', `
    <div class="modal" id="bulkMaintenanceFaultEditModal" style="display:flex;align-items:center;justify-content:center;z-index:1250;">
      <div class="modal-content" style="max-width:620px;width:92%;max-height:90vh;overflow-y:auto;">
        <div class="modal-header">
          <h3 class="modal-title">Edit Bulk Log #${escapeHtml(String(logNumber || row.logNumber || ''))}</h3>
          <button class="close-btn" onclick="closeBulkMaintenanceFaultEditModal()">&times;</button>
        </div>
        <form id="bulkMaintenanceFaultEditForm">
          <div style="background:#f8f9fa;border:1px solid #e9ecef;border-radius:8px;padding:12px;margin-bottom:16px;">
            <div><strong>Quantity:</strong> 1</div>
            <div><strong>Current Media:</strong> ${maintenanceMediaLinksHtml(report.media)}</div>
          </div>
          <div class="form-group">
            <label class="form-label" for="bulkFaultEditDescription">Maintenance Log Entry</label>
            <textarea class="form-input" id="bulkFaultEditDescription" rows="4" required>${escapeHtml(report.description || '')}</textarea>
          </div>
          <div class="form-group">
            <label class="form-label" for="bulkFaultEditMediaFiles">Add Photos / Videos</label>
            <input type="file" class="form-input" id="bulkFaultEditMediaFiles" multiple accept="image/*,video/*">
            <div id="bulkFaultEditMediaFileList" class="maintenance-media-selection"></div>
          </div>
          <div class="form-group">
            <label class="form-label" for="bulkFaultEditDate">Maintenance Date</label>
            <input type="date" class="form-input" id="bulkFaultEditDate" value="${escapeHtmlAttr(dateForInput)}" required>
          </div>
          <div class="form-group">
            <label class="form-label" for="bulkFaultEditStatus">Asset Status</label>
            <select class="form-input" id="bulkFaultEditStatus" data-maintenance-status-select="true" onchange="applyMaintenanceStatusSelectStyle(this)" required>
              ${bulkMaintenanceStatusOptionsHtml(row.status)}
            </select>
          </div>
          <div class="modal-actions">
            <button type="button" class="btn btn-secondary" onclick="closeBulkMaintenanceFaultEditModal()">Cancel</button>
            <button type="submit" class="btn btn-primary">Save Changes</button>
          </div>
        </form>
      </div>
    </div>
  `);

  document.getElementById('bulkFaultEditMediaFiles')?.addEventListener('change', () => {
    updateMaintenanceMediaSelection('bulkFaultEditMediaFiles', 'bulkFaultEditMediaFileList');
  });

  document.getElementById('bulkMaintenanceFaultEditForm')?.addEventListener('submit', async event => {
    event.preventDefault();
    await submitBulkMaintenanceFaultEdit(assetId, faultKey);
  });

  const modal = document.getElementById('bulkMaintenanceFaultEditModal');
  initialiseMaintenanceStatusSelects(modal);
  enhanceModalAccessibility(modal);
  focusModalStart(modal);
  modal.addEventListener('click', e => {
    if (e.target === modal) closeBulkMaintenanceFaultEditModal();
  });
}

function closeBulkMaintenanceFaultEditModal() {
  document.getElementById('bulkMaintenanceFaultEditModal')?.remove();
}

async function submitBulkMaintenanceFaultEdit(assetId, faultKey) {
  const description = document.getElementById('bulkFaultEditDescription')?.value.trim() || '';
  const maintenanceDate = document.getElementById('bulkFaultEditDate')?.value || '';
  const assetStatus = document.getElementById('bulkFaultEditStatus')?.value || 'ooc';

  if (!description) {
    showNotification('warning', 'Please enter a maintenance log entry');
    return;
  }
  if (!maintenanceDate) {
    showNotification('warning', 'Please select a maintenance date');
    return;
  }

  try {
    const payload = {
      logEntry: description,
      maintenanceDate,
      assetStatus
    };
    const requestData = maintenancePayloadToRequestData(payload, 'bulkFaultEditMediaFiles');
    await apiCall(`/api/assets/${encodeURIComponent(assetId)}/bulk-maintenance/${encodeURIComponent(faultKey)}`, 'PUT', requestData);

    closeBulkMaintenanceFaultEditModal();
    showNotification('success', 'Bulk maintenance fault report updated');
    await refreshBulkMaintenanceScreens(assetId, true);
  } catch (error) {
    showNotification('error', `Failed to update bulk maintenance log: ${error.message}`);
  }
}

function bulkMaintenanceReportHtml(report, emptyText = 'Not resolved') {
  if (!report) {
    return `<div style="color:#6c757d;font-style:italic;">${escapeHtml(emptyText)}</div>`;
  }

  return `
    <div style="display:grid;gap:8px;">
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
        <span style="font-weight:700;color:#333;">${escapeHtml(report.date || '')}</span>
        <span style="color:#666;">${escapeHtml(report.user || '')}</span>
        ${maintenanceLogTypeBadgeHtml(report.type)}
      </div>
      <div style="white-space:pre-wrap;line-height:1.4;">${escapeHtml(report.description || '')}</div>
      <div>${maintenanceMediaLinksHtml(report.media)}</div>
      ${report.cost ? `<div style="font-size:13px;color:#666;">Cost: ${maintenanceCostDisplayHtml(report.cost)}</div>` : ''}
    </div>
  `;
}

function bulkMaintenanceLogbookRows(asset) {
  const rows = Array.isArray(asset?.bulkMaintenanceLogbook) ? asset.bulkMaintenanceLogbook : [];
  return rows.slice().sort((a, b) => Number(a.logNumber || 0) - Number(b.logNumber || 0));
}

function showBulkMaintenanceLogModal(asset) {
  const assetId = getAssetIdentifierForApi(asset);
  const safeAssetId = String(assetId || '').replace(/[^a-zA-Z0-9]/g, '_');
  const rows = bulkMaintenanceLogbookRows(asset);
  const totalQty = Math.max(1, Number(asset.quantity || 1) || 1);
  const availableQty = Math.max(0, Number(asset.availableQuantity ?? totalQty) || 0);
  const preparableQty = Math.max(0, Number(asset.preparableQuantity ?? availableQty) || 0);
  const healthyQty = Math.max(0, Number(asset.healthyQuantity ?? availableQty) || 0);
  const oocQty = Math.max(0, Number(asset.bulkOOCQuantity || 0) || 0);
  const missingQty = Math.max(0, Number(asset.bulkMissingQuantity || 0) || 0);
  const degradedQty = Math.max(0, Number(asset.bulkDegradedQuantity || 0) || 0);

  const rowHtml = rows.length ? rows.map(row => {
    const status = String(row.status || '').toLowerCase();
    const statusBadge = statusBadgeHtml(status || 'degraded', bulkMaintenanceStatusLabel(status));
    const resolveButton = row.isResolved ? '' : `
      <button type="button" class="btn btn-success btn-sm" onclick="openBulkMaintenanceResolutionModal('${escapeJs(assetId)}', '${escapeJs(row.key || row.id)}', '${escapeJs(String(row.logNumber || ''))}')">
        Resolve
      </button>
    `;
    return `
      <tr>
        <td style="padding:14px;border-bottom:1px solid #e9ecef;vertical-align:top;width:110px;">
          <div style="font-weight:800;font-size:16px;">#${escapeHtml(String(row.logNumber || ''))}</div>
          <div style="margin-top:6px;">${statusBadge}</div>
        </td>
        <td style="padding:14px;border-bottom:1px solid #e9ecef;vertical-align:top;">
          <div
            role="button"
            tabindex="0"
            title="Edit fault report"
            onclick="openBulkMaintenanceFaultEditModal('${escapeJs(assetId)}', '${escapeJs(row.key || row.id)}', '${escapeJs(String(row.logNumber || ''))}')"
            style="cursor:pointer;border:1px solid transparent;border-radius:8px;padding:8px;margin:-8px;"
          >
            ${bulkMaintenanceReportHtml(row.fault, 'No fault report')}
            <div style="margin-top:8px;color:#667eea;font-size:12px;font-weight:700;">Edit fault report</div>
          </div>
        </td>
        <td style="padding:14px;border-bottom:1px solid #e9ecef;vertical-align:top;">
          ${bulkMaintenanceReportHtml(row.resolution)}
          ${resolveButton ? `<div style="margin-top:12px;">${resolveButton}</div>` : ''}
        </td>
      </tr>
    `;
  }).join('') : `
    <tr>
      <td colspan="3" style="padding:30px;text-align:center;color:#666;font-style:italic;">
        No bulk maintenance records found.
      </td>
    </tr>
  `;

  const modalContent = `
    <div class="modal maintenance-log-modal" id="maintenanceLogModal" style="display:flex;align-items:center;justify-content:center;">
      <div class="modal-content maintenance-log-content" style="max-width:1120px;width:95%;height:92vh;display:flex;flex-direction:column;overflow:hidden;padding:20px;">
        <div class="modal-header maintenance-log-header" style="flex-shrink:0;margin-bottom:16px;padding-bottom:14px;border-bottom:2px solid #eee;">
          <h3 class="modal-title">Bulk Maintenance Log - ${escapeHtml(assetId)}</h3>
          <button class="close-btn" onclick="closeMaintenanceLogModal()">&times;</button>
        </div>
        <div class="modal-body" style="flex:1;display:flex;flex-direction:column;min-height:0;overflow:hidden;">
          <div style="background:#f8f9fa;border:1px solid #e9ecef;border-radius:8px;padding:14px;margin-bottom:16px;">
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px;">
              <div><strong>Bulk ID:</strong> ${escapeHtml(assetId)}<br><strong>Brand:</strong> ${escapeHtml(asset.brand || '')}<br><strong>Model:</strong> ${escapeHtml(asset.model || '')}</div>
              <div><strong>Description:</strong> ${escapeHtml(asset.description || 'N/A')}<br><strong>Department:</strong> ${escapeHtml(asset.department || '')}<br><strong>Location:</strong> ${escapeHtml(asset.location || 'Store')}</div>
              <div><strong>Available:</strong> ${escapeHtml(String(availableQty))}/${escapeHtml(String(totalQty))}<br><strong>Healthy:</strong> ${escapeHtml(String(healthyQty))}/${escapeHtml(String(totalQty))}<br><strong>Preparable:</strong> ${escapeHtml(String(preparableQty))}/${escapeHtml(String(totalQty))}<br><strong>Flags:</strong> ${assetFlagBadgesHtml(asset)}</div>
            </div>
            <div style="margin-top:10px;color:#666;font-size:13px;">
              ${escapeHtml(String(oocQty))} OOC, ${escapeHtml(String(missingQty))} missing, and ${escapeHtml(String(degradedQty))} degraded unit${(oocQty + missingQty + degradedQty) === 1 ? '' : 's'} currently open.
            </div>
          </div>
          <div style="flex:1;min-height:0;overflow:auto;border:1px solid #e9ecef;border-radius:8px;background:white;">
            <table style="width:100%;border-collapse:collapse;table-layout:fixed;">
              <thead style="position:sticky;top:0;background:#f8f9fa;z-index:2;">
                <tr>
                  <th style="padding:12px;text-align:left;border-bottom:2px solid #e9ecef;width:110px;">Log No.</th>
                  <th style="padding:12px;text-align:left;border-bottom:2px solid #e9ecef;">Fault Report</th>
                  <th style="padding:12px;text-align:left;border-bottom:2px solid #e9ecef;">Resolution Report</th>
                </tr>
              </thead>
              <tbody>${rowHtml}</tbody>
            </table>
          </div>
          <div class="modal-actions maintenance-log-footer" style="margin-top:16px;padding-top:14px;border-top:2px solid #eee;text-align:center;flex-shrink:0;">
            <button type="button" class="btn btn-primary maintenance-log-footer-add" onclick="addNewLogEntryFromModal('${escapeJs(assetId)}')">
              Add New Log Entry
            </button>
            <button type="button" class="btn btn-secondary" onclick="closeMaintenanceLogModal()">Close</button>
          </div>
        </div>
      </div>
    </div>
  `;

  const existingModal = document.getElementById('maintenanceLogModal');
  if (existingModal) existingModal.remove();
  document.body.insertAdjacentHTML('beforeend', modalContent);
  const modal = document.getElementById('maintenanceLogModal');
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-hidden', 'false');
  modal.setAttribute('aria-labelledby', `bulkMaintenanceLogTitle_${safeAssetId}`);
  const titleEl = modal.querySelector('.modal-title');
  if (titleEl) titleEl.id = `bulkMaintenanceLogTitle_${safeAssetId}`;
  enhanceModalAccessibility(modal);
  focusModalStart(modal);
  modal.addEventListener('click', e => {
    if (e.target === modal) closeMaintenanceLogModal();
  });
}

function openBulkMaintenanceResolutionModal(assetId, faultKey, logNumber) {
  const today = new Date().toISOString().split('T')[0];
  const existing = document.getElementById('bulkMaintenanceResolutionModal');
  if (existing) existing.remove();

  document.body.insertAdjacentHTML('beforeend', `
    <div class="modal" id="bulkMaintenanceResolutionModal" style="display:flex;align-items:center;justify-content:center;z-index:1200;">
      <div class="modal-content" style="max-width:560px;width:92%;max-height:90vh;overflow-y:auto;">
        <div class="modal-header">
          <h3 class="modal-title">Resolve Bulk Log #${escapeHtml(String(logNumber || ''))}</h3>
          <button class="close-btn" onclick="closeBulkMaintenanceResolutionModal()">&times;</button>
        </div>
        <form id="bulkMaintenanceResolutionForm">
          <div class="form-group">
            <label class="form-label" for="bulkResolutionDate">Resolution Date</label>
            <input type="date" class="form-input" id="bulkResolutionDate" value="${escapeHtmlAttr(today)}" required>
          </div>
          <div class="form-group">
            <label class="form-label" for="bulkResolutionDescription">Resolution Report</label>
            <textarea class="form-input" id="bulkResolutionDescription" rows="4" placeholder="Describe the repair or resolution" required></textarea>
          </div>
          <div class="form-group">
            <label class="form-label" for="bulkResolutionCost">Cost</label>
            <input type="text" class="form-input" id="bulkResolutionCost" value="$0.00" placeholder="$0.00">
          </div>
          <div class="form-group">
            <label class="form-label" for="bulkResolutionMediaFiles">Photos / Videos</label>
            <input type="file" class="form-input" id="bulkResolutionMediaFiles" multiple accept="image/*,video/*">
            <div id="bulkResolutionMediaFileList" class="maintenance-media-selection"></div>
          </div>
          <div class="modal-actions">
            <button type="button" class="btn btn-secondary" onclick="closeBulkMaintenanceResolutionModal()">Cancel</button>
            <button type="submit" class="btn btn-success">Resolve</button>
          </div>
        </form>
      </div>
    </div>
  `);

  document.getElementById('bulkResolutionMediaFiles')?.addEventListener('change', () => {
    updateMaintenanceMediaSelection('bulkResolutionMediaFiles', 'bulkResolutionMediaFileList');
  });

  document.getElementById('bulkMaintenanceResolutionForm')?.addEventListener('submit', async event => {
    event.preventDefault();
    await submitBulkMaintenanceResolution(assetId, faultKey);
  });

  const modal = document.getElementById('bulkMaintenanceResolutionModal');
  enhanceModalAccessibility(modal);
  focusModalStart(modal);
  modal.addEventListener('click', e => {
    if (e.target === modal) closeBulkMaintenanceResolutionModal();
  });
}

function closeBulkMaintenanceResolutionModal() {
  document.getElementById('bulkMaintenanceResolutionModal')?.remove();
}

async function submitBulkMaintenanceResolution(assetId, faultKey) {
  const description = document.getElementById('bulkResolutionDescription')?.value.trim() || '';
  const maintenanceDate = document.getElementById('bulkResolutionDate')?.value || '';
  const cost = document.getElementById('bulkResolutionCost')?.value.trim() || '';

  if (!description) {
    showNotification('warning', 'Please enter a resolution report');
    return;
  }
  if (!maintenanceDate) {
    showNotification('warning', 'Please select a resolution date');
    return;
  }

  try {
    const payload = {
      logEntry: description,
      maintenanceDate,
      logType: 'Repair',
      cost: cost || null
    };
    const requestData = maintenancePayloadToRequestData(payload, 'bulkResolutionMediaFiles');
    await apiCall(`/api/assets/${encodeURIComponent(assetId)}/bulk-maintenance/${encodeURIComponent(faultKey)}/resolve`, 'POST', requestData);

    closeBulkMaintenanceResolutionModal();
    showNotification('success', 'Bulk maintenance log resolved');

    const assetsResponse = await apiCall('/api/assets');
    if (assetsResponse.success) {
      assets = assetsResponse.data || [];
      const updatedAsset = getAssetByApiIdentifier(assetId);
      if (updatedAsset) showBulkMaintenanceLogModal(updatedAsset);
    }
    if (document.getElementById('inventory-section')?.classList.contains('active')) loadInventory();
    if (document.getElementById('maintenance-section')?.classList.contains('active')) loadMaintenanceAssets();
  } catch (error) {
    showNotification('error', `Failed to resolve bulk maintenance log: ${error.message}`);
  }
}


function showMaintenanceLogModal(asset) {
  if (asset?.isBulk) {
    showBulkMaintenanceLogModal(asset);
    return;
  }

  const maintenanceRecords = getMaintenanceLogRecords(asset);
  
  // Start building modal content
  const assetSafeId = asset.id.replace(/[^a-zA-Z0-9]/g, '_');
  const eventHistoryContainerId = `assetEventHistory_${assetSafeId}`;
  let modalContent = `
    <div class="modal maintenance-log-modal" id="maintenanceLogModal" style="display: flex; align-items: center; justify-content: center;">
      <div class="modal-content maintenance-log-content" style="max-width: 1320px; width: 95%; height: 95vh; display: flex; flex-direction: column; overflow: hidden; padding: 20px;">
        <div class="modal-header maintenance-log-header" style="flex-shrink: 0; margin-bottom: 20px; padding-bottom: 15px; border-bottom: 2px solid #eee;">
          <h3 class="modal-title">Maintenance Log - ${asset.id}</h3>
          <button class="close-btn" onclick="closeMaintenanceLogModal()">&times;</button>
        </div>
        <div class="modal-body maintenance-log-body" style="flex: 1; display: flex; flex-direction: column; overflow: hidden; min-height: 0;">
          <!-- Asset Info -->
          <div class="maintenance-log-section maintenance-log-summary" style="background: #f8f9fa; padding: 15px; border-radius: 8px; margin-bottom: 20px; flex-shrink: 0;">
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px;">
              <div>
                <strong>Asset ID:</strong> ${asset.id}<br>
                <strong>Brand:</strong> ${asset.brand}<br>
                <strong>Model:</strong> ${asset.model}
              </div>
              <div>
                <strong>Description:</strong> ${asset.description || 'N/A'}<br>
                <strong>Serial:</strong> ${asset.serial || 'N/A'}<br>
                <strong>Department:</strong> <span class="asset-badge dept-${asset.department.toLowerCase()}">${asset.department}</span>
              </div>
              <div>
                <strong>Status:</strong> ${statusBadgeHtml(asset.status || 'available')}<br>
                <strong>Location:</strong> ${asset.location || 'Store'}<br>
                <strong>Flags:</strong> ${assetFlagBadgesHtml(asset)}
              </div>
            </div>
          </div>
          <!-- Prepared Event / Dry Hire History -->
          <div class="maintenance-log-section event-history-section" style="background: #fff; padding: 15px; border-radius: 8px; margin-bottom: 20px; border: 1px solid #e9ecef; flex-shrink: 0;">
            <h4 style="margin: 0 0 10px 0; color: #495057;">Prepared Event / Dry Hire History</h4>
            <div id="${eventHistoryContainerId}" class="asset-event-history-wrap" style="max-height: 220px; overflow-y: auto; border: 1px solid #e9ecef; border-radius: 8px; background: #ffffff;">
              <div style="padding: 12px; color: #6c757d; font-style: italic;">Loading…</div>
            </div>
          </div>

          <!-- Maintenance Logs -->
          <div class="maintenance-log-section maintenance-history-section" style="flex: 1; display: flex; flex-direction: column; min-height: 0;">
            <div class="maintenance-history-title-row" style="margin-bottom: 15px; color: #495057; flex-shrink: 0;">
              <h4 style="margin: 0;">
                Maintenance History - Total: ${maintenanceRecords.length} entries
              </h4>
              <button type="button" class="btn btn-primary maintenance-log-mobile-add" onclick="addNewLogEntryFromModal('${asset.id}')">
                📝 Add New Log Entry
              </button>
            </div>
            <div class="maintenance-log-table-wrap" style="flex: 1; overflow-y: scroll; border: 1px solid #e9ecef; border-radius: 8px; background: white;">
             <table class="maintenance-log-table" style="width: 100%; border-collapse: collapse; font-size: 14px; table-layout: fixed;">
                <thead style="position: sticky; top: 0; background: #f8f9fa; z-index: 10; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
                  <tr>
                    <th style="padding: 12px; font-weight: 600; color: #495057; border-bottom: 2px solid #e9ecef; text-align: left; background: #f8f9fa; width: 50px;">#</th>
                    <th style="padding: 12px; font-weight: 600; color: #495057; border-bottom: 2px solid #e9ecef; text-align: left; background: #f8f9fa; width: 110px;">Date</th>
                    <th style="padding: 12px; font-weight: 600; color: #495057; border-bottom: 2px solid #e9ecef; text-align: left; background: #f8f9fa; width: 100px;">User</th>
                    <th style="padding: 12px; font-weight: 600; color: #495057; border-bottom: 2px solid #e9ecef; text-align: left; background: #f8f9fa; width: 150px;">Type</th>
                    <th style="padding: 12px; font-weight: 600; color: #495057; border-bottom: 2px solid #e9ecef; text-align: left; background: #f8f9fa;">Description</th>
                    <th style="padding: 12px; font-weight: 600; color: #495057; border-bottom: 2px solid #e9ecef; text-align: left; background: #f8f9fa; width: 150px;">Media</th>
                    <th style="padding: 12px; font-weight: 600; color: #495057; border-bottom: 2px solid #e9ecef; text-align: left; background: #f8f9fa; width: 110px;">Cost</th>
                    <th style="padding: 12px; font-weight: 600; color: #495057; border-bottom: 2px solid #e9ecef; text-align: left; background: #f8f9fa; width: 200px;">Status Changes</th>
                    <th style="padding: 12px; font-weight: 600; color: #495057; border-bottom: 2px solid #e9ecef; width: 50px; text-align: center; background: #f8f9fa;"></th>
                  </tr>
                </thead>
                <tbody>
  `;

  // Process maintenance logs
  if (maintenanceRecords.length > 0) {
    const maintenanceData = maintenanceRecords.map((log, originalIndex) => ({
      ...log,
      originalIndex: originalIndex // Keep track of the original index
    }));

    // Sort logs by date (most recent first) using proper date parsing
    const sortedData = maintenanceData.map(log => {
      // Parse the date for proper sorting
      let dateObj;
      try {
        const dateParts = log.date.split('/');
        if (dateParts.length === 3) {
          dateObj = new Date(parseInt(dateParts[0]), parseInt(dateParts[1]) - 1, parseInt(dateParts[2]));
        } else {
          dateObj = new Date(0); // Very old date if parsing fails
        }
      } catch (e) {
        dateObj = new Date(0);
      }
      
      return {
        ...log,
        dateObj: dateObj
      };
    }).sort((a, b) => b.dateObj - a.dateObj); // Sort newest first
    
    
    
    sortedData.forEach((log, displayIndex) => {
      const logId = `log_${asset.id.replace(/[^a-zA-Z0-9]/g, '_')}_${log.originalIndex}`;
      const displayNumber = displayIndex + 1;
      
      // Format status changes for display
      let statusChangesDisplay = '';
      const changes = getMaintenanceChangeLabels(log.changes);
      if (changes.length > 0) {
        statusChangesDisplay = changes.map(change => {
          let color = '#667eea'; // Default blue
          let icon = '';
          
          // More comprehensive status change detection
          const changeLower = change.toLowerCase();
          
          if (changeLower.includes('marked ooc') || changeLower.includes('mark ooc')) {
            color = '#dc3545';
            icon = '⚠️';
          } else if (changeLower.includes('cleared ooc') || changeLower.includes('clear ooc') || changeLower.includes('removed ooc') || changeLower.includes('unmark ooc')) {
            color = '#28a745';
            icon = '✅';
          } else if (changeLower.includes('marked missing') || changeLower.includes('mark missing')) {
            color = '#fd7e14';
            icon = '❌';
          } else if (changeLower.includes('cleared missing') || changeLower.includes('clear missing') || changeLower.includes('removed missing') || changeLower.includes('unmark missing')) {
            color = '#28a745';
            icon = '✅';
          } else if (changeLower.includes('marked degraded')) {
            color = '#856404';
            icon = '⚠️';
          } else if (changeLower.includes('cleared degraded')) {
            color = '#28a745';
            icon = '✅';
          } else if (changeLower.includes('marked decommissioned') || changeLower.includes('marked disposed')) {
            color = '#6c757d';
            icon = '!';
          } else if (changeLower.includes('cleared decommissioned') || changeLower.includes('cleared disposed')) {
            color = '#28a745';
            icon = '✅';
          } else if (changeLower.includes('location:')) {
            color = '#17a2b8';
            icon = '📍';
          } else if (changeLower.includes('serial:')) {
            color = '#6f42c1';
            icon = '🔢';
          }
          
          return `<span style="color: ${color}; font-weight: 500; font-size: 12px; display: block; margin-bottom: 2px;">${icon} ${escapeHtml(change)}</span>`;
        }).join('');
      } else {
        statusChangesDisplay = '<span style="color: #999; font-style: italic; font-size: 12px;">No changes</span>';
      }
      
      const canEditThisLog = canCurrentUserModifyMaintenanceLog(log);
      const canDeleteThisLog = isAdminUser();
      const descriptionAttrs = canEditThisLog
        ? `style="display: block; cursor: pointer;" onclick="editMaintenanceLog('${asset.id}', ${log.originalIndex}, '${logId}')" title="Edit this maintenance log"`
        : `style="display: block; cursor: default;" title="Normal users can only edit their own logs within 7 days"`;
      const deleteButtonHtml = canDeleteThisLog ? `
            <button 
              type="button"
              class="delete-log-btn" 
              data-asset-id="${asset.id}"
              data-log-index="${log.originalIndex}"
              data-log-id="${logId}"
              style="background: none; border: none; color: #dc3545; cursor: pointer; font-size: 16px; padding: 4px; border-radius: 3px; line-height: 1; width: 24px; height: 24px;"
              title="Delete this maintenance log"
              onmouseover="this.style.backgroundColor='#ffebee'"
              onmouseout="this.style.backgroundColor='transparent'">
              ×
            </button>
      ` : '';

      modalContent += `
        <tr style="border-bottom: 1px solid #f1f1f1;">
          <td style="padding: 12px; border-bottom: 1px solid #f1f1f1; vertical-align: top; font-weight: 500; text-align: center;">${displayNumber}</td>
          <td style="padding: 12px; border-bottom: 1px solid #f1f1f1; vertical-align: top; font-size: 13px;">${log.date}</td>
          <td style="padding: 12px; border-bottom: 1px solid #f1f1f1; vertical-align: top; font-size: 13px;">${escapeHtml(log.user)}</td>
          <td style="padding: 12px; border-bottom: 1px solid #f1f1f1; vertical-align: top; font-size: 13px;">${maintenanceLogTypeBadgeHtml(log.type)}</td>
          <td style="padding: 12px; border-bottom: 1px solid #f1f1f1; vertical-align: top;">
            <div id="${logId}_display" ${descriptionAttrs}>
              ${escapeHtml(log.description)}
            </div>
          </td>
          <td style="padding: 12px; border-bottom: 1px solid #f1f1f1; vertical-align: top; font-size: 13px;">
            ${maintenanceMediaLinksHtml(log.media)}
          </td>
          <td style="padding: 12px; border-bottom: 1px solid #f1f1f1; vertical-align: top; font-size: 13px;">
            ${maintenanceCostDisplayHtml(log.cost, '<span style="color:#999;">—</span>')}
          </td>
          <td style="padding: 12px; border-bottom: 1px solid #f1f1f1; vertical-align: top; word-wrap: break-word; overflow-wrap: break-word; max-width: 200px;">
            ${statusChangesDisplay}
          </td>
          <td style="padding: 12px; border-bottom: 1px solid #f1f1f1; vertical-align: top; text-align: center;">
            ${deleteButtonHtml}
          </td>
        </tr>
      `;
    });
    
  } else {
    modalContent += `
      <tr>
        <td colspan="9" style="text-align: center; color: #666; padding: 30px; font-style: italic;">
          No maintenance records found for this asset.
        </td>
      </tr>
    `;
  }

  // Close the table and add action buttons
  modalContent += `
                  </tbody>
                </table>
              </div>
            </div>
            
            <!-- Action Buttons -->
            <div class="modal-actions maintenance-log-footer" style="margin-top: 20px; padding-top: 15px; border-top: 2px solid #eee; text-align: center; flex-shrink: 0;">
              <button type="button" class="btn btn-primary maintenance-log-footer-add" onclick="addNewLogEntryFromModal('${asset.id}')">
                📝 Add New Log Entry
              </button>
              <button type="button" class="btn btn-secondary" onclick="closeMaintenanceLogModal()">
                Close
              </button>
            </div>
          </div>
        </div>
      </div>
    `;

  // Remove existing modal if any
  const existingModal = document.getElementById('maintenanceLogModal');
  if (existingModal) {
    existingModal.remove();
  }

  // Add new modal to body
  document.body.insertAdjacentHTML('beforeend', modalContent);

  // Show modal
  const modal = document.getElementById('maintenanceLogModal');
  modal.style.display = 'flex';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-hidden', 'false');
  modal.setAttribute('aria-labelledby', 'maintenanceLogTitle');
  const titleEl = modal.querySelector('.modal-title');
  if (titleEl) titleEl.id = 'maintenanceLogTitle';
  enhanceModalAccessibility(modal);
  focusModalStart(modal);
    // Load prepared event/dry hire history
  setTimeout(() => loadAssetEventHistory(asset.id, eventHistoryContainerId), 0);
  
  // Add event listener for clicking outside modal
  modal.addEventListener('click', function(e) {
    if (e.target === modal) {
      closeMaintenanceLogModal();
    }
  });
  
  // Add event listeners for delete buttons

  setTimeout(() => {
    if (!isAdminUser()) return;
    const deleteButtons = modal.querySelectorAll('.delete-log-btn');
    
    deleteButtons.forEach(button => {
      // Remove any existing click handlers and use a single handler
      button.onclick = function(e) {
        e.preventDefault();
        e.stopPropagation();
        
        const assetId = this.dataset.assetId;
        const logIndex = parseInt(this.dataset.logIndex);
        const logId = this.dataset.logId;
        
        deleteMaintenanceLog(assetId, logIndex, logId);
      };
    });
  }, 100);
}

async function loadAssetEventHistory(assetId, containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;

  container.innerHTML = `<div style="padding: 12px; color: #6c757d; font-style: italic;">Loading…</div>`;

  try {
    const resp = await apiCall(`/api/assets/${encodeURIComponent(assetId)}/event-history`);
    const rows = (resp && resp.success && Array.isArray(resp.data)) ? resp.data : [];

    if (rows.length === 0) {
      container.innerHTML = `<div style="padding: 12px; color: #6c757d; font-style: italic;">No prepared event/dry hire history found for this asset.</div>`;
      return;
    }

    const bodyRows = rows.map(ev => {
      const tag = ev.tag || 'events';
      const tagStyle = getTagStyle(tag);
      const tagLabel = getTagDisplay(tag);

      const dateRange =
        (ev.startDate && ev.endDate && ev.startDate !== ev.endDate)
          ? `${ev.startDate} → ${ev.endDate}`
          : (ev.startDate || ev.endDate || '');

      const statusBadge = ev.returned
        ? '<span style="background:#e6ffed;color:#1e7e34;padding:2px 8px;border-radius:12px;font-size:12px;font-weight:600;">Returned</span>'
        : '<span style="background:#fff3cd;color:#856404;padding:2px 8px;border-radius:12px;font-size:12px;font-weight:600;">Out</span>';

      return `
        <tr style="border-bottom: 1px solid #f1f1f1;">
          <td style="padding: 10px; width: 90px; white-space: nowrap;">
            <span style="padding: 2px 8px; border-radius: 12px; font-size: 10px; font-weight: bold; ${tagStyle}">
              ${tagLabel}
            </span>
          </td>
          <td style="padding: 10px; width: 70px; font-weight: 600;">${ev.id}</td>
          <td style="padding: 10px;">${escapeHtml(ev.name || '')}</td>
          <td style="padding: 10px; width: 160px; white-space: nowrap; font-size: 13px;">${escapeHtml(dateRange)}</td>
          <td style="padding: 10px; width: 110px; text-align: center;">${statusBadge}</td>
        </tr>
      `;
    }).join('');

    container.innerHTML = `
      <table class="asset-event-history-table" style="width: 100%; border-collapse: collapse; font-size: 14px;">
        <thead style="position: sticky; top: 0; background: #f8f9fa; z-index: 5;">
          <tr>
            <th style="padding: 10px; text-align: left; width: 90px; border-bottom: 2px solid #e9ecef;">Type</th>
            <th style="padding: 10px; text-align: left; width: 70px; border-bottom: 2px solid #e9ecef;">ID</th>
            <th style="padding: 10px; text-align: left; border-bottom: 2px solid #e9ecef;">Name</th>
            <th style="padding: 10px; text-align: left; width: 160px; border-bottom: 2px solid #e9ecef;">Dates</th>
            <th style="padding: 10px; text-align: center; width: 110px; border-bottom: 2px solid #e9ecef;">Status</th>
          </tr>
        </thead>
        <tbody>${bodyRows}</tbody>
      </table>
    `;
  } catch (err) {
    console.error('Failed to load asset event history:', err);
    container.innerHTML = `<div style="padding: 12px; color: #dc3545;">Failed to load event/dry hire history.</div>`;
  }
}

if (typeof window !== 'undefined') {
  window.showMaintenanceLogModal = showMaintenanceLogModal;
}

//WHAT IS LOVE, BABY DONT HURT ME, DONT HURT ME NO MOREEE
window.viewMaintenanceLog = viewMaintenanceLog;
window.openMaintenanceModal = openMaintenanceModal;
window.switchMaintenanceTab = switchMaintenanceTab;
window.openMaintenanceModalForAsset = openMaintenanceModal;
window.addNewLogEntryFromModal = addNewLogEntryFromModal;
window.returnSpecificAssetNew = returnSpecificAssetNew;
window.selectAssetForMaintenance = selectAssetForMaintenance;
window.removeAssetFromMaintenance = removeAssetFromMaintenance;
window.openFlaggedAssetLogEntry = openFlaggedAssetLogEntry;
window.displayOOCAssets = displayOOCAssets;
window.openBulkMaintenanceFaultModal = openBulkMaintenanceFaultModal;
window.closeBulkMaintenanceFaultModal = closeBulkMaintenanceFaultModal;
window.openBulkMaintenanceFaultEditModal = openBulkMaintenanceFaultEditModal;
window.closeBulkMaintenanceFaultEditModal = closeBulkMaintenanceFaultEditModal;
window.openBulkMaintenanceResolutionModal = openBulkMaintenanceResolutionModal;
window.closeBulkMaintenanceResolutionModal = closeBulkMaintenanceResolutionModal;

// Helper function to close the maintenance log modal

// Function to handle adding new log entry from the maintenance log modal
function addNewLogEntryFromModal(assetId) {
  const asset = getAssetByApiIdentifier(assetId);
  // Close the current maintenance log modal
  closeMaintenanceLogModal();

  if (asset?.isBulk) {
    openBulkMaintenanceFaultModal(getAssetIdentifierForApi(asset));
    return;
  }
  
  // Open the maintenance modal with the asset pre-selected
  openMaintenanceModalForAsset(assetId);
}

async function deleteMaintenanceLog(assetId, logIndex, logId) {
  if (!isAdminUser()) {
    showNotification('error', 'Admin privileges required to delete maintenance logs');
    return;
  }

  // Show custom confirmation dialog
  const shouldDelete = await showCustomConfirm(
    'Delete Maintenance Log', 
    'Are you sure you want to delete this maintenance log entry? Attached media will be deleted too. This action cannot be undone and will recalculate the asset status.'
  );
  
  if (!shouldDelete) {
    return;
  }
  
  try {
    const encodedAssetId = encodeURIComponent(assetId);
    const url = `/api/assets/${encodedAssetId}/maintenance-log/${logIndex}`;
    
    const response = await apiCall(url, 'DELETE');
    
    if (response && response.success) {
      showNotification('success', 'Maintenance log deleted and asset status updated');
      
      // Force reload from server to get fresh data including updated status
      try {
        const assetsResponse = await apiCall('/api/assets');
        if (assetsResponse.success) {
          // Update the global assets array
          assets = assetsResponse.data;
          const updatedAsset = assets.find(a => a.id === assetId);
          if (updatedAsset) {
            // Close any existing edit modals first
            const editModal = document.getElementById('editMaintenanceLogModal');
            if (editModal) {
              editModal.remove();
            }
            
            // Show refreshed maintenance log modal
            showMaintenanceLogModal(updatedAsset);
          }
        } else {
          closeMaintenanceLogModal();
          showNotification('info', 'Please refresh the page to see updated logs');
        }
      } catch (reloadError) {
        console.warn('Could not reload asset data:', reloadError);
        closeMaintenanceLogModal();
        showNotification('info', 'Log deleted. Please refresh the page to see updated logs and asset status');
      }
    } else {
      console.error('API returned error or no response:', response);
      showNotification('error', (response && response.message) || 'Failed to delete maintenance log');
    }
    
  } catch (error) {
    console.error('Error deleting maintenance log:', error);
    showNotification('error', `Failed to delete maintenance log: ${error.message}`);
  }
}

function showCustomConfirm(titleOrMessage, maybeMessage, options = {}) {
  const hasSeparateMessage = typeof maybeMessage === 'string';
  const title = hasSeparateMessage ? titleOrMessage : (options.title || 'Confirm Action');
  const message = hasSeparateMessage ? maybeMessage : titleOrMessage;
  const destructive = /delete|remove/i.test(`${title} ${message}`);

  return showAppConfirm({
    title,
    message,
    confirmText: options.confirmText || (destructive ? 'Delete' : 'Confirm'),
    cancelText: options.cancelText || 'Cancel',
    variant: options.variant || (destructive ? 'danger' : 'warning'),
  });
}

function deleteMaintenanceLogFromModal(assetId, logIndex, logId) {
  // Close the edit modal first
  const editModal = document.getElementById('editMaintenanceLogModal');
  if (editModal) {
    editModal.remove();
  }
  
  // Then call the delete function
  deleteMaintenanceLog(assetId, logIndex, logId);
}

});

function editCustomAssetQuantity(eventId, assetId, assetName, assetType) {
  const custom = parseCustomAsset(assetId) || { name: assetName, quantity: 1, type: assetType };
  const currentQuantity = Math.max(1, parseInt(custom.quantity || 1, 10) || 1);

  // Populate modal - reuse the existing edit quantity modal
  document.getElementById("editQuantityTitle").textContent = `Edit Custom Asset Quantity`;
  document.getElementById("editQuantityLabel").textContent = `Editing: ${custom.name || assetName} (${custom.type === 'LOAN' ? 'Loan/Rental' : 'Misc'})`;
  document.getElementById("editQuantityInput").value = currentQuantity;
  document.getElementById("editQuantityInput").min = 1;
  document.getElementById("editQuantityInput").max = 999; // No limit for custom assets

  const editQtyInput = document.getElementById("editQuantityInput");
  if (editQtyInput) {
    editQtyInput.oninput = () => validateCustomAssetQuantityInput();
    editQtyInput.onblur = () => handleCustomAssetQuantityBlur();
    editQtyInput.onkeydown = (e) => handleQuantityKeydown(e);
  }

  // Show info
  const availableDiv = document.getElementById("editQuantityAvailable");
  availableDiv.innerHTML = `<span style="color: #28a745;">✅ Custom assets have no quantity limits</span>`;

  // Store values in hidden fields (repurpose existing ones)
  document.getElementById("editQuantityEventId").value = eventId;
  document.getElementById("editQuantityBrand").value = assetId; // Store full asset ID here
  document.getElementById("editQuantityModel").value = custom.name || assetName;
  document.getElementById("editQuantityDepartment").value = custom.type || assetType;
  document.getElementById("editQuantityCurrentQty").value = currentQuantity;

  // Mark this as custom asset edit by setting a flag
  document.getElementById("editQuantityForm").dataset.customAsset = "true";

  // Open modal
  openModal("editQuantityModal");
}

function validateCustomAssetQuantityInput() {
  const input = document.getElementById("editQuantityInput");
  if (!input) return false;

  let value = input.value.trim();

  // Allow empty during typing
  if (value === '') {
    input.style.borderColor = "#ddd";
    return false;
  }

  const numValue = parseInt(value);

  if (isNaN(numValue) || numValue < 1) {
    input.style.borderColor = "#dc3545";
    return false;
  }

  if (numValue > 999) {
    input.style.borderColor = "#dc3545";
    return false;
  }

  input.style.borderColor = "#28a745";
  return true;
}

function handleCustomAssetQuantityBlur() {
  const input = document.getElementById("editQuantityInput");
  if (!input) return;

  let value = input.value.trim();

  // If empty on blur, restore to minimum 1
  if (value === '' || isNaN(parseInt(value)) || parseInt(value) < 1) {
    input.value = 1;
    input.style.borderColor = "#28a745";
    return;
  }

  // If value exceeds maximum, set to maximum
  const numValue = parseInt(value);
  if (numValue > 999) {
    input.value = 999;
    showNotification("warning", "Maximum quantity is 999");
  }

  validateCustomAssetQuantityInput();
}

async function updateCustomAssetQuantity(eventId, oldAssetId, assetName, assetType, newQuantity) {
  try {
    // Create the update payload for a dedicated quantity update endpoint
    const updateData = {
      assetId: oldAssetId,
      newQuantity: newQuantity
    };
    
    // Try a dedicated custom asset quantity update endpoint
    await apiCall(`/api/events/${eventId}/custom-assets/update-quantity`, "PUT", updateData);

    const quantityText = newQuantity > 1 ? ` (Qty: ${newQuantity})` : '';
    showNotification("success", `Updated "${assetName}"${quantityText} quantity to ${newQuantity}`);

    // Update the model requirements section to show the changes
    await updateModelRequirementsSection(eventId);
    await refreshEventOverviewViews();

  } catch (error) {
    console.error("Error in updateCustomAssetQuantity:", error);
    
    // If the dedicated endpoint doesn't exist, show a helpful error
    if (error.message.includes('Not found') || error.message.includes('404')) {
      showNotification("error", "Custom asset quantity update endpoint not available. This feature needs to be implemented on the backend.");
    } else {
      showNotification("error", `Failed to update custom asset quantity: ${error.message}`);
    }
  }
}

// Filter OOC assets (for search functionality)
function filterOOCAssets() {
  const searchInput = document.getElementById('ooc-search');
  const searchTerm = searchInput?.value.toLowerCase().trim() || '';

  const filteredAssets = maintenanceFlaggedAssets.filter(asset => {
    if (!searchTerm) return true;

    const lastMaintenance = getLastAddedMaintenanceLog(asset);
    const lastFlagged = getLastFlaggedMaintenanceLog(asset);
    const searchableText = [
      getAssetIdentifierForApi(asset),
      assetMaintenanceDisplayId(asset),
      asset.brand,
      asset.model,
      asset.status,
      asset.location,
      lastMaintenance?.date,
      lastFlagged?.status,
      lastFlagged?.record?.description
    ].filter(Boolean).join(' ').toLowerCase();

    return searchableText.includes(searchTerm);
  });

  window.displayOOCAssets(filteredAssets);
}



function editMaintenanceLog(assetId, logIndex, logId) {
  // First, close any other editing logs
  const currentlyEditing = document.querySelectorAll('div[id$="_edit"][style*="block"]');
  currentlyEditing.forEach(editDiv => {
    const currentLogId = editDiv.id.replace('_edit', '');
    cancelEditMaintenanceLogModal(currentLogId);
  });
  
  // Get the asset data
  const asset = assets.find(a => a.id === assetId);
  const maintenanceRecords = getMaintenanceLogRecords(asset || {});
  if (!asset || !maintenanceRecords[logIndex]) {
    showNotification('error', 'Maintenance log not found');
    return;
  }

  const permissionLog = maintenanceRecords[logIndex];

  if (!canCurrentUserModifyMaintenanceLog(permissionLog)) {
    showNotification('error', 'You can only edit maintenance logs that you wrote within the last 7 days');
    return;
  }
  
  // Parse the current log entry
  const logEntry = maintenanceRecords[logIndex];
  const currentDate = logEntry.date || '';
  const currentUser = logEntry.user || '';
  const currentDescription = logEntry.description || '';
  const currentLogType = normalizeMaintenanceLogType(logEntry.type);
  const existingStatusChanges = getMaintenanceChangeLabels(logEntry.changes).join(', ');
  const logLocationFromThisEntry = getMaintenanceChangeValue(logEntry, 'location');
  const hasLocationChangeInThisLog = Boolean(logLocationFromThisEntry);

  
  // Convert date format from YYYY/MM/DD to YYYY-MM-DD for HTML date input
  const dateForInput = currentDate.replace(/\//g, '-');
  
  // Determine status selector value from THIS log entry, not current asset status.
  // Older logs may only contain one clear action (e.g. Clear OOC). In this
  // cleaned-up UI, any clear action means the dropdown should show OK / Clear Status.
  let defaultStatusValue = 'nochange';
  const statusKinds = ['ooc', 'missing', 'degraded', 'decommissioned', 'disposed'];
  let hasAnyClearStatusChange = false;
  for (const change of logEntry.changes || []) {
    const kind = String(change.kind || '').toLowerCase() === 'disposed' ? 'decommissioned' : String(change.kind || '').toLowerCase();
    const action = String(change.action || '').toLowerCase();

    if (statusKinds.includes(kind) && action === 'marked') {
      defaultStatusValue = kind;
      break;
    }

    if (statusKinds.includes(kind) && action === 'cleared') {
      hasAnyClearStatusChange = true;
    }
  }
  if (defaultStatusValue === 'nochange' && hasAnyClearStatusChange) {
    defaultStatusValue = 'ok';
  }
  
  // Create the enhanced edit modal
  const modalContent = `
    <div class="modal" id="editMaintenanceLogModal" style="display: flex; align-items: center; justify-content: center; z-index: 1100;">
      <div class="modal-content maintenance-edit-content" style="max-width: 600px; width: 90%; max-height: 90vh; overflow-y: auto;">
        <div class="modal-header">
          <h3 class="modal-title">Edit Maintenance Log - ${assetId}</h3>
          <button class="close-btn" onclick="cancelEditMaintenanceLogModal()">&times;</button>
        </div>
        <div class="modal-body">
          <!-- Current Asset Status Display -->
          <div style="background: #f8f9fa; padding: 15px; border-radius: 8px; margin-bottom: 20px; border-left: 4px solid #667eea;">
            <h5 style="margin: 0 0 10px 0; color: #495057;">Current Asset Status</h5>
            <div style="display: flex; gap: 20px; flex-wrap: wrap;">
              <div>
                <strong>Status:</strong> ${statusBadgeHtml(asset.status || 'available')}
              </div>
              <div>
                <strong>Flags:</strong> ${assetFlagBadgesHtml(asset)}
              </div>
              <div>
                <strong>Location:</strong> <span style="font-weight: 500;">${escapeHtml(asset.location || 'Store')}</span>
              </div>
              <div>
                <strong>Serial:</strong> <span style="font-weight: 500;">${escapeHtml(asset.serial || 'N/A')}</span>
              </div>
            </div>
            ${existingStatusChanges ? `<div style="margin-top: 10px;"><strong>Previous Changes:</strong> <span style="color: #666; font-style: italic;">${escapeHtml(existingStatusChanges)}</span></div>` : ''}
          </div>

          <form id="editMaintenanceLogForm">
            <!-- Date -->
            <div class="form-group">
              <label class="form-label">Maintenance Date</label>
              <input
                type="date"
                class="form-input"
                id="editMaintenanceDate"
                value="${dateForInput}"
                required
              />
            </div>

            <!-- User -->
            <div class="form-group">
              <label class="form-label">User</label>
              <input
                type="text"
                class="form-input"
                id="editMaintenanceUser"
                value="${escapeHtml(currentUser)}"
                required
                ${isAdminUser() ? '' : 'readonly'}
                placeholder="Enter username"
              />
            </div>

            <!-- Type -->
            <div class="form-group">
              <label class="form-label" for="editMaintenanceLogType">Maintenance Log Type</label>
              ${
                currentLogType === ASSET_CHECK_MAINTENANCE_LOG_TYPE
                  ? `<input type="text" class="form-input" id="editMaintenanceLogType" value="${escapeHtmlAttr(ASSET_CHECK_MAINTENANCE_LOG_TYPE)}" readonly />`
                  : maintenanceLogTypeSelectHtml('editMaintenanceLogType', currentLogType)
              }
            </div>

            <!-- Description -->
            <div class="form-group">
              <label class="form-label">Maintenance Description</label>
              <textarea
                class="form-input"
                id="editMaintenanceDescription"
                rows="4"
                required
                placeholder="Describe maintenance work performed..."
              >${escapeHtml(currentDescription)}</textarea>
            </div>

            <div class="form-group">
              <label class="form-label">Attached Media</label>
              ${maintenanceMediaLinksHtml(logEntry.media, '<span style="color:#6c757d;font-size:13px;">No media attached</span>')}
            </div>

            <div class="form-group">
              <label class="form-label" for="editMaintenanceMediaFiles">Add Photos / Videos</label>
              <input
                type="file"
                class="form-input"
                id="editMaintenanceMediaFiles"
                accept="image/*,video/*,.jpg,.jpeg,.png,.mp4,.mov"
                multiple
              />
              <div id="editMaintenanceMediaFileList" class="maintenance-media-selection"></div>
            </div>

            <!-- Repair Cost -->
            <div class="form-group">
              <label class="form-label">Cost (optional)</label>
              <div style="display:flex;align-items:center;border:2px solid #e9ecef;border-radius:8px;background:white;overflow:hidden;">
                <span style="padding:12px 0 12px 12px;color:#495057;font-weight:600;">$</span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  class="form-input"
                  id="editMaintenanceCost"
                  placeholder="Repair cost, if any"
                  value="${escapeHtml(formatMaintenanceCost(logEntry.cost))}"
                  style="border:0;box-shadow:none;"
                />
              </div>
            </div>

            <!-- New Location -->
            <div class="form-group">
              <label class="form-label">Update Location (optional)</label>
              <input
                type="text"
                class="form-input"
                id="editMaintenanceNewLocation"
                placeholder="Leave blank to keep ${hasLocationChangeInThisLog ? 'location from this log (' + escapeHtml(logLocationFromThisEntry || 'Store') + ')' : 'no location change'}"
                value="${hasLocationChangeInThisLog ? escapeHtml(logLocationFromThisEntry || '') : ''}"
              />
            </div>

            <!-- New Serial -->
            <div class="form-group">
              <label class="form-label">Update Serial Number (optional)</label>
              <input
                type="text"
                class="form-input"
                id="editMaintenanceNewSerial"
                placeholder="Leave blank to keep current serial (${escapeHtml(asset.serial || 'N/A')})"
                value=""
              />
            </div>    

            <!-- Asset Status Changes -->
            <div class="form-group">
              <label class="form-label" for="editMaintenanceAssetStatus">Asset Status</label>
              ${maintenanceStatusSelectHtml('editMaintenanceAssetStatus', 'editAssetStatus', defaultStatusValue)}
            </div>

            <!-- Form Buttons -->
            <div class="modal-actions" style="display: flex; gap: 10px; justify-content: flex-end; margin-top: 20px;">
              <button
                type="button"
                class="btn btn-secondary"
                onclick="cancelEditMaintenanceLogModal()"
              >
                Cancel
              </button>

              ${isAdminUser() ? `
              <button 
                type="button" 
                class="btn btn-danger" 
                onclick="deleteMaintenanceLogFromModal('${assetId}', ${logIndex}, '${logId}')"
                style="margin-right: auto;"
              >
                Delete Log
              </button>` : '<span style="margin-right:auto;color:#6c757d;font-size:12px;">Delete is admin-only</span>'}
              <button type="submit" class="btn btn-primary">
                Save Changes
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  `;

  // Remove existing edit modal if any
  const existingModal = document.getElementById('editMaintenanceLogModal');
  if (existingModal) {
    existingModal.remove();
  }

  // Add new modal to body
  document.body.insertAdjacentHTML('beforeend', modalContent);

  // Show modal
  const modal = document.getElementById('editMaintenanceLogModal');
  modal.style.display = 'flex';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-hidden', 'false');
  enhanceModalAccessibility(modal);
  focusModalStart(modal);
  initialiseMaintenanceStatusSelects(modal);
  const editMediaInput = document.getElementById('editMaintenanceMediaFiles');
  if (editMediaInput) {
    editMediaInput.addEventListener('change', () => {
      updateMaintenanceMediaSelection('editMaintenanceMediaFiles', 'editMaintenanceMediaFileList');
    });
  }
  
  // Add form submit handler
  const form = document.getElementById('editMaintenanceLogForm');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    saveEnhancedMaintenanceLog(assetId, logIndex, logId);
  });
  
  // Add event listeners for clicking outside modal and escape key
  modal.addEventListener('click', function(e) {
    if (e.target === modal) {
      cancelEditMaintenanceLogModal();
    }
  });
  
  document.addEventListener('keydown', function escapeHandler(e) {
    if (e.key === 'Escape') {
      cancelEditMaintenanceLogModal();
      document.removeEventListener('keydown', escapeHandler);
    }
  });
}

function handleClickOutside(event) {
  // Find all currently editing textareas
  const editingTextareas = document.querySelectorAll('textarea[id$="_input"]');
  
  editingTextareas.forEach(async (textarea) => {
    const editDiv = textarea.closest('div[id$="_edit"]');
    
    // Check if click was outside this specific edit area
    if (editDiv && !editDiv.contains(event.target)) {
      const assetId = textarea.dataset.assetId;
      const logIndex = parseInt(textarea.dataset.logIndex);
      const logId = textarea.dataset.logId;
      const originalValue = textarea.dataset.originalValue;
      const currentValue = textarea.value.trim();
      
      // If value changed and is not empty, save it
      if (currentValue && currentValue !== originalValue) {
        await saveMaintenanceLogSilent(assetId, logIndex, logId);
      } else if (!currentValue) {
        // If empty, restore original and cancel
        cancelEditMaintenanceLogModal(logId);
      } else {
        // If unchanged, just cancel
        cancelEditMaintenanceLogModal(logId);
      }
    }
  });
  
  // Remove the global click listener after processing
  document.removeEventListener('click', handleClickOutside);
}

function cancelEditMaintenanceLogModal() {
  const modal = document.getElementById('editMaintenanceLogModal');
  if (modal) {
    modal.remove();
  }
}

async function saveEnhancedMaintenanceLog(assetId, logIndex, logId) {
  try {
    // Get the asset data to compare against current values
    const asset = assets.find(a => a.id === assetId);
    if (!asset) {
      showNotification('error', 'Asset not found');
      return;
    }
    
    // Get form values
    const date = document.getElementById('editMaintenanceDate').value;
    const user = isAdminUser()
      ? document.getElementById('editMaintenanceUser').value.trim()
      : (currentUser?.username || document.getElementById('editMaintenanceUser').value.trim());
    const description = document.getElementById('editMaintenanceDescription').value.trim();
    const newLocation = document.getElementById('editMaintenanceNewLocation').value.trim();
    const newSerial = document.getElementById('editMaintenanceNewSerial').value.trim();
    const repairCost = document.getElementById('editMaintenanceCost')?.value.trim() || '';
    const statusValue = document.getElementById('editMaintenanceAssetStatus')?.value || 'nochange';
    const logType = normalizeMaintenanceLogType(document.getElementById('editMaintenanceLogType')?.value, true);
    
    if (!date || !user || !description) {
      showNotification('warning', 'Date, user, and description are required');
      return;
    }
    
    // Extract the original location from this specific log for comparison
    let originalLogLocation = null;
    let hadLocationChangeOriginally = false;
    const logEntry = getMaintenanceLogRecords(asset)[logIndex];
    if (logEntry) {
      const locationValue = getMaintenanceChangeValue(logEntry, 'location');
      if (locationValue) {
        originalLogLocation = locationValue;
        hadLocationChangeOriginally = true;
      }
    }

    // Handle location logic
    let locationToUpdate = null;
    const newLocationClean = newLocation.trim();

    if (newLocationClean) {
      // User entered a new location - always use it
      locationToUpdate = newLocationClean;
    } else if (hadLocationChangeOriginally) {

      locationToUpdate = originalLogLocation;
    }

    // Only include serial if it's different from current serial
    let serialToUpdate = null;
    const currentSerial = asset.serial || '';
    if (newSerial !== currentSerial) {
      serialToUpdate = newSerial || null;
    }
    
    // Prepare the data for the enhanced maintenance update
    const updateData = {
      logIndex: logIndex,
      date: date,
      user: user,
      description: description,
      logType: logType,
      newLocation: locationToUpdate,
      newSerial: serialToUpdate,
      cost: repairCost || null,
      assetStatus: statusValue,
      markOOC: statusValue === 'ooc',
      unmarkOOC: statusValue === 'ok',
      markMissing: statusValue === 'missing',
      unmarkMissing: statusValue === 'ok',
      markDegraded: statusValue === 'degraded',
      unmarkDegraded: statusValue === 'ok',
      markDecommissioned: statusValue === 'decommissioned',
      unmarkDecommissioned: statusValue === 'ok'
    };
    
    // Call the enhanced update API
    const requestData = maintenancePayloadToRequestData(updateData, 'editMaintenanceMediaFiles');
    const response = await apiCall(`/api/assets/${encodeURIComponent(assetId)}/maintenance-log-enhanced/${logIndex}`, 'PUT', requestData);
    
    if (response.success) {
      showNotification('success', 'Maintenance log updated successfully');
      cancelEditMaintenanceLogModal();
      
      // Refresh the maintenance log modal
      const asset = assets.find(a => a.id === assetId);
      if (asset) {
        // Force reload from server to get fresh data
        const assetsResponse = await apiCall('/api/assets');
        if (assetsResponse.success) {
          assets = assetsResponse.data;
          const updatedAsset = assets.find(a => a.id === assetId);
          if (updatedAsset) {
            const fn =
              (typeof window.showMaintenanceLogModal === 'function') ? window.showMaintenanceLogModal :
              (typeof showMaintenanceLogModal === 'function') ? showMaintenanceLogModal :
              null;

            if (fn) {
              fn(updatedAsset);
            } else {
              // avoid throwing a ReferenceError after a successful save
              console.warn('showMaintenanceLogModal is not available; skipping modal refresh');
            }
          }
        }
      }
    }
  } catch (error) {
    showNotification('error', `Failed to update maintenance log: ${error.message}`);
    console.error('Error updating maintenance log:', error);
  }
}

async function saveMaintenanceLogSilent(assetId, logIndex, logId) {
  const displayDiv = document.getElementById(`${logId}_display`);
  const editDiv = document.getElementById(`${logId}_edit`);
  const textarea = document.getElementById(`${logId}_input`);
  
  if (!displayDiv || !editDiv || !textarea) {
    return false;
  }
  
  const newDescription = textarea.value.trim();
  
  if (!newDescription) {
    cancelEditMaintenanceLogModal(logId);
    return false;
  }
  
  try {
    // Call API to update the maintenance log
    const response = await apiCall(`/api/assets/${encodeURIComponent(assetId)}/maintenance-log/${logIndex}`, 'PUT', {
      description: newDescription
    });
    
    if (response.success) {
      // Update the display with new text
      displayDiv.textContent = newDescription;
      
      // Show display, hide edit
      displayDiv.style.display = 'block';
      editDiv.style.display = 'none';
      
      // Clear dataset
      delete textarea.dataset.originalValue;
      delete textarea.dataset.assetId;
      delete textarea.dataset.logIndex;
      delete textarea.dataset.logId;
      
      // Update the assets array if it exists
      if (window.assets) {
        const asset = window.assets.find(a => a.id === assetId);
        const records = getMaintenanceLogRecords(asset || {});
        if (asset && records[logIndex]) {
          records[logIndex].description = newDescription;
          asset.maintenanceLogRecords = records;
        }
      }
      
      // Only remove click-outside listener if no other logs are being edited
      const stillEditing = document.querySelectorAll('div[id$="_edit"][style*="block"]');
      if (stillEditing.length === 0) {
        document.removeEventListener('click', handleClickOutside);
      }
      
      return true;
    } else {
      showNotification('error', response.message || 'Failed to update maintenance log');
      return false;
    }
  } catch (error) {
    showNotification('error', `Failed to update maintenance log: ${error.message}`);
    console.error('Error updating maintenance log:', error);
    return false;
  }
}


function closeMaintenanceLogModal() {
  const modal = document.getElementById('maintenanceLogModal');
  if (modal) {
    modal.remove();
  }
}

// Utility functions
function showNotification(type, message) {
  const notification = document.createElement("div");
  notification.className = `notification ${type}`;
  notification.textContent = message;
  notification.setAttribute("role", type === "error" || type === "warning" ? "alert" : "status");
  notification.setAttribute("aria-live", type === "error" || type === "warning" ? "assertive" : "polite");
  notification.setAttribute("aria-atomic", "true");

  document.body.appendChild(notification);

  // Trigger animation
  setTimeout(() => notification.classList.add("show"), 100);

  // Remove notification after 3 seconds
  setTimeout(() => {
    notification.classList.remove("show");
    setTimeout(() => {
      if (document.body.contains(notification)) {
        document.body.removeChild(notification);
      }
    }, 300);
  }, 3000);
}


function isBulkModelGroupForPrepare(modelGroup, availableAssets = [], assignedAssets = []) {
    return (availableAssets || []).some(asset => asset && asset.isBulk) ||
           (assignedAssets || []).some(asset => asset && typeof asset !== 'string' && asset.isBulk);
}

function createBulkPreparationSection(eventId, modelGroup, availableAssets = [], assignedAssets = []) {
    const requiredQty = Math.max(1, Number(modelGroup.requiredQuantity || 1));
    const assignedQty = (assignedAssets || []).reduce((sum, asset) => sum + Number((asset && asset.quantity) || 1), 0);
    const isPrepared = assignedQty >= requiredQty;
    const statusText = isPrepared ? 'Prepared' : (assignedQty > 0 ? `Partial (${assignedQty}/${requiredQty})` : 'Pending');
    const statusColor = isPrepared ? '#28a745' : (assignedQty > 0 ? '#17a2b8' : '#ffc107');
    const availableBulkSource = (availableAssets || []).find(asset => asset && asset.isBulk) || null;
    const assignedBulkSource = (assignedAssets || []).find(asset => asset && typeof asset !== 'string' && asset.isBulk) || null;
    const bulkId = getAssetIdentifierForApi(availableBulkSource) || availableBulkSource?.bulkId || assignedBulkSource?.bulkId || '';
    const displayName = `${requiredQty}x ${[modelGroup.brand, modelGroup.model].filter(Boolean).join(' ')}`.trim();
    const description = modelGroup.description || availableBulkSource?.description || assignedBulkSource?.description || '';
    const availableQuantity = availableBulkSource ? Number(availableBulkSource.availableQuantity ?? availableBulkSource.quantity ?? 0) : 0;
    const preparableQuantity = availableBulkSource ? Number(availableBulkSource.preparableQuantity ?? availableBulkSource.availableQuantity ?? availableBulkSource.quantity ?? 0) : 0;
    const healthyQuantity = availableBulkSource ? Number(availableBulkSource.healthyQuantity ?? availableQuantity) : 0;
    const modelKey = `${modelGroup.department || ''}|${modelGroup.brand || ''}|${modelGroup.model || ''}`;

    let actionButtons = '';
    if (assignedAssets && assignedAssets.length > 0) {
        actionButtons += (assignedAssets || []).map(asset => {
            const preparedId = typeof asset === 'string' ? asset : asset.id;
            if (!preparedId) return '';
            const bulkSourceId = (typeof asset !== 'string' && asset.bulkId)
                ? asset.bulkId
                : (String(preparedId).match(/^\[BULK\]([^|]+)\|/)?.[1] || '');
            const safePreparedId = escapeHtmlAttr(encodeURIComponent(preparedId));
            return `<button class="btn btn-warning btn-sm asset-action-btn"
                data-event-id="${eventId}"
                data-asset-id="${safePreparedId}"
                data-prepare-source-id="${escapeHtmlAttr(encodeURIComponent(bulkSourceId))}"
                data-prepare-brand="${escapeHtmlAttr(modelGroup.brand || '')}"
                data-prepare-model="${escapeHtmlAttr(modelGroup.model || '')}"
                data-action="unprepare"
                style="padding:4px 8px; font-size:11px;">Unprepare</button>`;
        }).join('');
    }

    if (!isPrepared && bulkId && preparableQuantity !== 0) {
        actionButtons += `<button class="btn btn-success btn-sm"
            data-event-id="${eventId}"
            data-prepare-source-id="${escapeHtmlAttr(encodeURIComponent(bulkId))}"
            data-prepare-brand="${escapeHtmlAttr(modelGroup.brand || '')}"
            data-prepare-model="${escapeHtmlAttr(modelGroup.model || '')}"
            onclick="assignSpecificAsset(${eventId}, '${escapeJs(bulkId)}', '${escapeJs(modelGroup.brand || '')}', '${escapeJs(modelGroup.model || '')}')"
            style="padding:4px 8px; font-size:11px;">Prepare</button>`;
    }

    if (!actionButtons) {
        actionButtons = '<span style="color:#777; font-size:11px;">No action available</span>';
    }

    const quantityLine = availableBulkSource
        ? `<div style="color:#666; font-size:12px; margin-top:2px;">Available Qty: ${escapeHtml(String(availableQuantity))}/${escapeHtml(String(availableBulkSource.quantity ?? requiredQty))}${healthyQuantity !== availableQuantity ? ` | Healthy: ${escapeHtml(String(healthyQuantity))}` : ''}${preparableQuantity !== availableQuantity ? ` | Preparable: ${escapeHtml(String(preparableQuantity))}` : ''}</div>`
        : (assignedBulkSource ? `<div style="color:#666; font-size:12px; margin-top:2px;">Prepared Qty: ${escapeHtml(String(assignedQty))}</div>` : '');

    return `
        <div class="model-prep-section bulk-prep-flat-section" data-prepare-model-key="${escapeHtmlAttr(modelKey)}" style="border: 1px solid #e9ecef; border-radius: 8px; padding: 0; margin-bottom: 15px; overflow:hidden;">
            <div style="display:flex; justify-content:space-between; align-items:center; gap:15px; padding:15px; background:#f8f9fa; border-radius:8px;">
                <div style="min-width:0; flex:1;">
                    <h5 style="margin:0; color:#495057; font-size:14px;">${escapeHtml(displayName)}</h5>
                    ${description ? `<div style="color:#666; font-size:12px; margin-top:2px; overflow-wrap:anywhere;">${escapeHtml(description)}</div>` : ''}
                    ${quantityLine}
                    <div class="prepare-model-progress-text" style="color:${statusColor}; font-size:12px; margin-top:2px; font-weight:500;">${escapeHtml(statusText)}</div>
                </div>
                <div style="display:flex; gap:6px; flex-wrap:wrap; justify-content:flex-end; align-items:center; flex-shrink:0;">
                    ${actionButtons}
                </div>
            </div>
        </div>
    `;
}

function createModelPreparationSection(eventId, department, brand, model, description, requiredQty, availableAssets, assignedAssets) {
    const assignedCount = (assignedAssets || [])
        .filter(a => (typeof a === 'string') || a.status !== 'returned')
        .reduce((sum, a) => sum + Number(a.quantity || 1), 0);
    const countableAssignedCount = (assignedAssets || [])
        .filter(a => (typeof a === 'string') || (!a.isExtra && a.status !== 'returned'))
        .reduce((sum, a) => sum + Number(a.quantity || 1), 0);
    const extraAssignedCount = (assignedAssets || [])
        .filter(a => typeof a !== 'string' && a.isExtra && a.status !== 'returned')
        .reduce((sum, a) => sum + Number(a.quantity || 1), 0);
    const progressPercent = requiredQty > 0 ? Math.round((assignedCount / requiredQty) * 100) : 0;
    const modelProgressColor = countableAssignedCount >= requiredQty ? '#28a745' : '#ffc107';
    const makeDomSafe = (value) => String(value || '')
        .replace(/\s+/g, '')
        .replace(/[^a-zA-Z0-9_-]/g, '');
    const modelId = `model-${makeDomSafe(department)}-${makeDomSafe(brand)}-${makeDomSafe(model)}-${makeDomSafe(description)}-${eventId}`;
    const modelKey = `${department || ''}|${brand || ''}|${model || ''}`;
    
    let section = `
        <div class="model-prep-section" data-prepare-model-key="${escapeHtmlAttr(modelKey)}" style="border: 1px solid #e9ecef; border-radius: 8px; padding: 0; margin-bottom: 15px;">
            <div style="display: flex; justify-content: space-between; align-items: center; padding: 15px; background: #f8f9fa; border-radius: 8px 8px 0 0; cursor: pointer;" onclick="togglePrepareSection('${modelId}')">
                <div>
                    <h5 style="margin: 0; color: #495057;">${requiredQty}x ${escapeHtml(brand)} ${escapeHtml(model)}</h5>
                    <div style="color: #666; font-size: 12px; margin-top: 2px;">${escapeHtml(description)}</div>
                </div>
                <div style="display: flex; align-items: center; gap: 15px;">
                    <div style="text-align: right;">
                        <div class="prepare-model-progress-text" style="font-size: 14px; font-weight: 500; color: ${modelProgressColor};">
                            ${assignedCount}/${requiredQty} assigned
                            ${extraAssignedCount > 0 ? ` (+${extraAssignedCount} extra)` : ''}
                        </div>
                        <div style="background: #e9ecef; border-radius: 10px; height: 4px; width: 120px; overflow: hidden; margin-top: 4px;">
                            <div class="prepare-model-progress-bar" style="background: ${modelProgressColor}; height: 100%; width: ${Math.min(progressPercent, 100)}%; transition: width 0.3s ease;"></div>
                        </div>
                    </div>
                    <span class="toggle-icon" style="font-size: 16px; font-weight: bold; color: #666;">▼</span>
                </div>
            </div>
            
            <div id="${modelId}" style="display: none; padding: 15px; border-top: 1px solid #e9ecef;">
    `;
    
    // Available assets section
    if (availableAssets.length > 0) {
        section += `
            <div style="margin-bottom: 20px;">
                <h6 style="color: #495057; margin-bottom: 10px; font-size: 13px;">Available Assets (${availableAssets.length})</h6>
                <div style="background: #e8f5e8; border-radius: 6px; padding: 10px; max-height: 200px; overflow-y: auto;">
        `;
        
          availableAssets.forEach(asset => {
              const apiId = getAssetIdentifierForApi(asset);
              const isAlreadyAssigned = assignedAssets.some(assigned => 
                  typeof assigned === 'string' ? assigned === apiId : (assigned.id === apiId || assigned.bulkId === apiId)
              );
              const buttonText = isAlreadyAssigned ? 'Assigned ✓' : 'Prepare';
              const buttonClass = isAlreadyAssigned ? 'btn-secondary' : 'btn-success';
              const buttonAction = isAlreadyAssigned ? '' : `assignSpecificAsset(${eventId}, '${escapeJs(apiId)}', '${escapeJs(brand)}', '${escapeJs(model)}')`;
              const disabled = isAlreadyAssigned ? 'disabled' : '';
              const availableQtyText = asset.isBulk
                ? `Available Qty: ${escapeHtml(String(asset.availableQuantity ?? asset.quantity ?? 0))}/${escapeHtml(String(asset.quantity ?? 0))}${Number(asset.healthyQuantity ?? asset.availableQuantity ?? 0) !== Number(asset.availableQuantity ?? 0) ? ` | Healthy: ${escapeHtml(String(asset.healthyQuantity ?? asset.availableQuantity ?? 0))}` : ''}${Number(asset.preparableQuantity ?? asset.availableQuantity ?? 0) !== Number(asset.availableQuantity ?? 0) ? ` | Preparable: ${escapeHtml(String(asset.preparableQuantity ?? asset.availableQuantity ?? 0))}` : ''}`
                : `SN: ${escapeHtml(asset.serial || 'N/A')}`;
              const displayId = asset.isBulk ? 'Bulk quantity item' : escapeHtml(asset.id);
            
            section += `
                <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px 10px; background: white; border-radius: 4px; margin-bottom: 5px; border: 1px solid #c3e6cb;">
                    <div>
                        <div style="font-weight: 500; font-size: 14px;">${displayId}</div>
                        <div style="color: #666; font-size: 12px;">${availableQtyText}</div>
                    </div>
                    <button class="btn ${buttonClass}"
                            data-event-id="${eventId}"
                            data-prepare-source-id="${escapeHtmlAttr(encodeURIComponent(apiId))}"
                            data-prepare-brand="${escapeHtmlAttr(brand)}"
                            data-prepare-model="${escapeHtmlAttr(model)}"
                            style="padding: 4px 10px; font-size: 11px;"
                            onclick="${buttonAction}" ${disabled}>${buttonText}</button>
                </div>
            `;
        });
        
        section += '</div></div>';
    } else {
        section += `
            <div style="margin-bottom: 20px;">
                <h6 style="color: #495057; margin-bottom: 10px; font-size: 13px;">Available Assets</h6>
                <div style="background: #f8d7da; color: #721c24; padding: 10px; border-radius: 6px; font-size: 12px; text-align: center;">
                    No available assets of this model
                </div>
            </div>
        `;
    }
    
    // Assigned/Prepared assets section (made bigger)
    const assignedAssetsForDisplay = [...(assignedAssets || [])].sort((a, b) => {
        const aExtra = typeof a === 'string' ? false : !!a.isExtra;
        const bExtra = typeof b === 'string' ? false : !!b.isExtra;
        if (aExtra !== bExtra) return aExtra ? 1 : -1;
        const aId = typeof a === 'string' ? a : (a.id || a.bulkId || '');
        const bId = typeof b === 'string' ? b : (b.id || b.bulkId || '');
        return String(aId).localeCompare(String(bId), undefined, { numeric: true, sensitivity: 'base' });
    });

    if (assignedAssetsForDisplay.length > 0) {
        section += `
            <div>
                <h6 style="color: #495057; margin-bottom: 10px; font-size: 13px;">Assigned Assets (${assignedAssetsForDisplay.length})</h6>
                <div style="background: #d4edda; border-radius: 6px; padding: 12px;">
        `;
        
        assignedAssetsForDisplay.forEach((asset, index) => {
            // Handle both old format (just ID strings) and new format (asset objects)
            const assetId = typeof asset === 'string' ? asset : asset.id;
            const assetSerial = typeof asset === 'string' ? 'N/A' : (asset.isBulk ? `Qty: ${asset.quantity || 1}` : (asset.serial || 'N/A'));
            const assetLabel = typeof asset === 'string' ? assetId : getAssignedAssetDisplay(asset);
            
            const isExtra = (typeof asset !== 'string' && !!asset.isExtra) || index >= requiredQty;
            const bgColor = isExtra ? '#fff3cd' : '#d4edda';
            const textColor = isExtra ? '#856404' : '#155724';
            const statusIcon = isExtra ? '➕' : '✅';
            const statusText = isExtra ? 'Extra' : 'Required';
            
            section += `
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; padding: 10px 12px; background: ${bgColor}; border-radius: 4px; border: 1px solid ${isExtra ? '#ffeaa7' : '#c3e6cb'};">
                    <div>
                        <span style="color: ${textColor}; font-weight: 500; font-size: 15px;">
                            ${statusIcon} ${escapeHtml(assetLabel)} 
                        </span>
                        <div style="color: ${textColor}; font-size: 13px; margin-top: 3px;">${asset.isBulk ? escapeHtml(assetSerial) : `SN: ${escapeHtml(assetSerial)}`} • ${statusText}</div>
                    </div>
                    <button class="btn btn-warning asset-action-btn"
                            data-event-id="${eventId}"
                            data-asset-id="${escapeHtmlAttr(encodeURIComponent(assetId))}"
                            data-action="unprepare"
                            style="padding: 6px 12px; font-size: 12px;">Unprepare</button>
                </div>
            `;
        });
        
        section += '</div></div>';
    } else {
        section += `
            <div>
                <h6 style="color: #495057; margin-bottom: 10px; font-size: 13px;">Assigned Assets</h6>
                <div style="background: #fff3cd; color: #856404; padding: 10px; border-radius: 6px; font-size: 12px; text-align: center;">
                    No assets assigned yet
                </div>
            </div>
        `;
    }
    
    section += '</div></div>';
    
    return section;
}

function packingListQuantity(value) {
  const quantity = Number(value || 0);
  return Number.isFinite(quantity) ? Math.max(0, quantity) : 0;
}

function packingListAssetQuantity(asset) {
  return Math.max(1, packingListQuantity(asset?.quantity || 1));
}

function packingListDateRange(event) {
  if (!event?.startDate) return '-';
  return event.startDate === event.endDate
    ? formatDate(event.startDate)
    : `${formatDate(event.startDate)} - ${formatDate(event.endDate)}`;
}

function packingListAssetStatus(asset, event) {
  const id = String(asset?.id || '');
  if (asset?.status === 'returned' || (event?.returnedItems || []).includes(id)) return 'returned';
  if (asset?.status === 'prepared' || (event?.actuallyPrepared || []).includes(id)) return 'packed';
  if (
    asset?.status === 'collected' ||
    asset?.isCollected ||
    (event?.customCollected || []).includes(id)
  ) return 'collected';
  return 'pending';
}

function packingListAssetRecord(asset, event, department = 'UN') {
  const custom = parseCustomAsset(asset?.id, asset);
  const quantity = custom
    ? Math.max(1, Number(custom.quantity || 1))
    : packingListAssetQuantity(asset);
  const status = packingListAssetStatus(asset, event);

  return {
    id: String(asset?.id || ''),
    label: custom
      ? customAssetDisplayName(custom, false)
      : String(asset?.displayId || asset?.bulkId || asset?.id || asset?.name || 'Asset'),
    serial: custom ? '' : String(asset?.serial || ''),
    company: custom ? String(custom.company || '') : '',
    quantity,
    status,
    department: normalizeDepartmentCode(custom?.department || department || 'UN'),
    isBulk: !!asset?.isBulk,
    isExtra: !!asset?.isExtra
  };
}

function packingListRowState(row) {
  if (row.required > 0 && row.packed >= row.required) return 'packed';
  if (row.packed > 0) return 'partial';
  if (row.required > 0 && row.returned >= row.required) return 'returned';
  if (row.assets.some(asset => asset.status === 'collected')) return 'collected';
  return 'pending';
}

function buildPackingListSnapshot(event) {
  const rows = [];
  const extras = new Map();
  const assetsById = new Map();

  Object.entries(event?.assetsByDepartment || {}).forEach(([department, departmentAssets]) => {
    (departmentAssets || []).forEach(asset => {
      const record = packingListAssetRecord(asset, event, department);
      if (record.id) assetsById.set(record.id, record);
      if (record.isExtra && record.id) extras.set(record.id, record);
    });
  });

  const modelGroups = Object.values(event?.modelGroups || {})
    .filter(group => packingListQuantity(group.requiredQuantity) > 0)
    .sort((a, b) => {
      const deptCompare = inventoryDepartmentLabel(a.department).localeCompare(
        inventoryDepartmentLabel(b.department),
        undefined,
        { numeric: true, sensitivity: 'base' }
      );
      return deptCompare || modelGroupSortName(a).localeCompare(
        modelGroupSortName(b),
        undefined,
        { numeric: true, sensitivity: 'base' }
      );
    });

  modelGroups.forEach(group => {
    const required = packingListQuantity(group.requiredQuantity);
    const assignedAssets = (group.assignedAssets || [])
      .map(asset => packingListAssetRecord(asset, event, group.department))
      .filter(asset => {
        if (asset.isExtra) {
          if (asset.id) extras.set(asset.id, asset);
          return false;
        }
        return true;
      });
    const packed = Math.min(
      required,
      typeof group.countablePreparedQuantity !== 'undefined'
        ? packingListQuantity(group.countablePreparedQuantity)
        : assignedAssets
            .filter(asset => asset.status === 'packed')
            .reduce((sum, asset) => sum + asset.quantity, 0)
    );
    const returned = Math.min(
      required,
      typeof group.countableReturnedQuantity !== 'undefined'
        ? packingListQuantity(group.countableReturnedQuantity)
        : assignedAssets
            .filter(asset => asset.status === 'returned')
            .reduce((sum, asset) => sum + asset.quantity, 0)
    );
    const row = {
      department: normalizeDepartmentCode(group.department || 'UN'),
      description: [group.brand, group.model].filter(Boolean).join(' ') || 'Unspecified item',
      detail: String(group.description || ''),
      required,
      packed,
      returned,
      pending: Math.max(0, required - packed - returned),
      assets: assignedAssets
    };
    row.state = packingListRowState(row);
    rows.push(row);
  });

  const customRows = new Map();
  (event?.preparedItems || []).forEach(marker => {
    const custom = parseCustomAsset(marker);
    if (!custom) return;

    const asset = assetsById.get(marker) || packingListAssetRecord({
      id: marker,
      isCustom: true,
      customType: custom.type,
      model: custom.name,
      quantity: custom.quantity,
      department: custom.department,
      company: custom.company,
      status: (event?.returnedItems || []).includes(marker)
        ? 'returned'
        : ((event?.actuallyPrepared || []).includes(marker) ? 'prepared' : 'assigned'),
      isCollected: (event?.customCollected || []).includes(marker),
      isExtra: (event?.extraAssets || []).includes(marker)
    }, event, custom.department);

    if (asset.isExtra) {
      if (asset.id) extras.set(asset.id, asset);
      return;
    }

    const key = JSON.stringify([
      asset.department,
      custom.type,
      custom.name,
      custom.company
    ]);
    if (!customRows.has(key)) {
      customRows.set(key, {
        department: asset.department,
        description: custom.name || (custom.type === 'LOAN' ? 'Loan/Rental Item' : 'Misc Item'),
        detail: [
          custom.type === 'LOAN' ? 'Loan/Rental' : 'Miscellaneous',
          custom.company
        ].filter(Boolean).join(' - '),
        required: 0,
        packed: 0,
        returned: 0,
        pending: 0,
        assets: []
      });
    }

    const row = customRows.get(key);
    row.required += asset.quantity;
    if (asset.status === 'packed') row.packed += asset.quantity;
    else if (asset.status === 'returned') row.returned += asset.quantity;
    row.assets.push(asset);
  });

  customRows.forEach(row => {
    row.pending = Math.max(0, row.required - row.packed - row.returned);
    row.state = packingListRowState(row);
    rows.push(row);
  });

  // Legacy/direct events have no model requirements. Group their specifically
  // assigned physical assets by model so the checklist remains compact.
  if (modelGroups.length === 0) {
    const directRows = new Map();
    Object.entries(event?.assetsByDepartment || {}).forEach(([department, departmentAssets]) => {
      (departmentAssets || []).forEach(asset => {
        if (parseCustomAsset(asset?.id, asset)) return;
        const record = packingListAssetRecord(asset, event, department);
        if (record.isExtra) {
          if (record.id) extras.set(record.id, record);
          return;
        }

        const key = JSON.stringify([
          record.department,
          asset?.brand || '',
          asset?.model || '',
          asset?.description || asset?.name || ''
        ]);
        if (!directRows.has(key)) {
          directRows.set(key, {
            department: record.department,
            description: [asset?.brand, asset?.model].filter(Boolean).join(' ') || record.label,
            detail: String(asset?.description || ''),
            required: 0,
            packed: 0,
            returned: 0,
            pending: 0,
            assets: []
          });
        }

        const row = directRows.get(key);
        row.required += record.quantity;
        if (record.status === 'packed') row.packed += record.quantity;
        else if (record.status === 'returned') row.returned += record.quantity;
        row.assets.push(record);
      });
    });

    directRows.forEach(row => {
      row.pending = Math.max(0, row.required - row.packed - row.returned);
      row.state = packingListRowState(row);
      rows.push(row);
    });
  }

  // Some extras only appear inside model groups (including orphan 0-required
  // groups), so collect those after the required rows have been built.
  Object.values(event?.modelGroups || {}).forEach(group => {
    (group.assignedAssets || []).forEach(asset => {
      if (!asset?.isExtra) return;
      const record = packingListAssetRecord(asset, event, group.department);
      if (record.id) extras.set(record.id, record);
    });
  });

  rows.sort((a, b) => {
    const deptCompare = inventoryDepartmentLabel(a.department).localeCompare(
      inventoryDepartmentLabel(b.department),
      undefined,
      { numeric: true, sensitivity: 'base' }
    );
    return deptCompare || a.description.localeCompare(
      b.description,
      undefined,
      { numeric: true, sensitivity: 'base' }
    );
  });

  const required = packingListQuantity(event?.totalAssets);
  const packed = packingListQuantity(event?.totalPrepared);
  const returned = packingListQuantity(event?.totalReturned);

  return {
    rows,
    extras: Array.from(extras.values()).sort((a, b) => {
      const deptCompare = inventoryDepartmentLabel(a.department).localeCompare(
        inventoryDepartmentLabel(b.department),
        undefined,
        { numeric: true, sensitivity: 'base' }
      );
      return deptCompare || a.label.localeCompare(b.label, undefined, {
        numeric: true,
        sensitivity: 'base'
      });
    }),
    totals: {
      required,
      packed,
      pending: Math.max(0, required - packed - returned),
      returned,
      extras: packingListQuantity(event?.totalExtraAssets)
    }
  };
}

function packingListStatusBadge(status) {
  const palette = {
    packed: ['PACKED', '#dcfce7', '#14532d'],
    partial: ['PARTIAL', '#fef3c7', '#78350f'],
    pending: ['PENDING', '#fee2e2', '#7f1d1d'],
    returned: ['RETURNED', '#e5e7eb', '#374151'],
    collected: ['COLLECTED', '#dbeafe', '#1e3a8a']
  };
  const [label, background, colour] = palette[status] || palette.pending;
  return pdfInlineBadgeHtml(label, background, colour, {
    style: 'margin:0;white-space:nowrap;'
  });
}

function packingListAssetHtml(asset) {
  const quantity = asset.quantity > 1 ? ` x${asset.quantity}` : '';
  const serial = asset.serial ? ` / SN ${asset.serial}` : '';
  const company = asset.company ? ` / ${asset.company}` : '';
  return `
    <div class="asset-line">
      ${packingListStatusBadge(asset.status)}
      <span><strong>${escapeHtml(asset.label || 'Asset')}${escapeHtml(quantity)}</strong>${escapeHtml(serial)}${escapeHtml(company)}</span>
    </div>
  `;
}

function packingListTableHead() {
  return `
    <colgroup>
      <col style="width:25%;">
      <col style="width:35%;">
      <col style="width:7%;">
      <col style="width:7%;">
      <col style="width:7%;">
      <col style="width:7%;">
      <col style="width:12%;">
    </colgroup>
    <thead>
      <tr>
        <th>Item</th>
        <th>Assigned / Packed Assets</th>
        <th class="number-cell">Req.</th>
        <th class="number-cell">Packed</th>
        <th class="number-cell">Pending</th>
        <th class="number-cell">Returned</th>
        <th>Status</th>
      </tr>
    </thead>
  `;
}

function packingListModelRowHtml(row, assetHtml, continued = false) {
  const pendingNote = row.pending > 0
    ? `<div class="pending-note">${escapeHtml(String(row.pending))} unit${row.pending === 1 ? '' : 's'} still to pack</div>`
    : '';
  const itemCell = continued
    ? `
      <strong>${escapeHtml(row.description)}</strong>
      <div class="continued-label">Continued</div>
    `
    : `
      <strong>${escapeHtml(row.description)}</strong>
      ${row.detail ? `<div class="muted">${escapeHtml(row.detail)}</div>` : ''}
    `;
  const assetCell = assetHtml || pendingNote || '<span class="muted">No asset assigned</span>';

  if (continued) {
    return `
      <tr class="continuation-row">
        <td>${itemCell}</td>
        <td>${assetCell}</td>
        <td class="number-cell">-</td>
        <td class="number-cell">-</td>
        <td class="number-cell">-</td>
        <td class="number-cell">-</td>
        <td><span class="continued-label">CONTINUED</span></td>
      </tr>
    `;
  }

  return `
    <tr>
      <td>${itemCell}</td>
      <td>${assetCell}</td>
      <td class="number-cell">${row.required}</td>
      <td class="number-cell packed-number">${row.packed}</td>
      <td class="number-cell ${row.pending > 0 ? 'pending-number' : ''}">${row.pending}</td>
      <td class="number-cell">${row.returned}</td>
      <td>${packingListStatusBadge(row.state)}</td>
    </tr>
  `;
}

function packingListExtrasRowHtml(snapshot, assetHtml, continued = false) {
  const status = snapshot.extras.some(asset => asset.status === 'packed')
    ? 'packed'
    : snapshot.extras[0]?.status;
  return `
    <tr class="${continued ? 'continuation-row' : ''}">
      <td>
        <strong>Additional assets</strong>
        ${continued ? '<div class="continued-label">Continued</div>' : ''}
      </td>
      <td colspan="5">${assetHtml}</td>
      <td>${continued ? '<span class="continued-label">CONTINUED</span>' : packingListStatusBadge(status)}</td>
    </tr>
  `;
}

function packingListRowRecords(snapshot) {
  const records = [];
  let currentDepartment = null;

  snapshot.rows.forEach(row => {
    if (row.department !== currentDepartment) {
      currentDepartment = row.department;
      records.push({
        html: `<tr class="department-row"><td colspan="7">${inventoryDepartmentLabel(currentDepartment)}</td></tr>`,
        keepWithNext: true,
        height: 0
      });
    }

    const assetParts = row.assets.map(packingListAssetHtml);
    records.push({
      html: packingListModelRowHtml(row, assetParts.join('')),
      parts: assetParts,
      renderChunk: (parts, continued) => packingListModelRowHtml(row, parts.join(''), continued),
      height: 0
    });
  });

  if (snapshot.extras.length > 0) {
    records.push({
      html: `
        <tr class="extras-row">
          <td colspan="7">EXTRAS - Not included in required or packed totals</td>
        </tr>
      `,
      keepWithNext: true,
      height: 0
    });

    const extraParts = snapshot.extras.map(packingListAssetHtml);
    records.push({
      html: packingListExtrasRowHtml(snapshot, extraParts.join('')),
      parts: extraParts,
      renderChunk: (parts, continued) => packingListExtrasRowHtml(snapshot, parts.join(''), continued),
      height: 0
    });
  }

  if (records.length === 0) {
    records.push({
      html: '<tr><td colspan="7" class="empty-row">No items are assigned to this event.</td></tr>',
      height: 0
    });
  }

  return records;
}

function buildPackingListPdfPages(event, snapshot, context) {
  const safe = value => escapeHtml(String(value ?? ''));
  const logoUrl = escapeHtmlAttr(getPdfLogoUrl());
  const footerHtml = renderPdfFooterHtml();
  const headerHtml = `
    <div class="logo-row"><img src="${logoUrl}" alt="Company Logo"></div>
    <div class="header">
      <div class="header-left">
        EVENT:<br>
        <span class="event-name">#${safe(event.id)} ${safe(event.name)}</span><br>
        ${safe(packingListDateRange(event))}<br>
        Event state: ${safe(event.state || '-')}
      </div>
      <div class="header-right">
        <div class="report-title">PACKING LIST</div>
        No. : ${safe(context.reportNumber)}<br>
        Snapshot : ${safe(context.generatedAt)}<br>
        Generated by : ${safe(context.generatedBy || '-')}
      </div>
    </div>
  `;
  const totals = snapshot.totals;
  const completion = totals.required > 0
    ? Math.min(100, Math.round((totals.packed / totals.required) * 100))
    : 100;
  const summaryHtml = `
    <div class="summary-grid">
      <div class="summary-card"><span>Required</span><strong>${totals.required}</strong></div>
      <div class="summary-card packed"><span>Packed now</span><strong>${totals.packed}</strong></div>
      <div class="summary-card pending"><span>Pending</span><strong>${totals.pending}</strong></div>
      <div class="summary-card returned"><span>Returned</span><strong>${totals.returned}</strong></div>
      <div class="summary-card extras"><span>Active extras</span><strong>${totals.extras}</strong></div>
      <div class="summary-card completion"><span>Packed</span><strong>${completion}%</strong></div>
    </div>
    <div class="snapshot-note">
      Live event snapshot. Packed means currently prepared; returned items are no longer packed.
      Extras are shown separately and do not count toward the requirement.
    </div>
  `;
  const rowRecords = packingListRowRecords(snapshot);
  const measureBox = document.createElement('div');
  measureBox.id = '__packingListMeasureBox';
  measureBox.style.cssText = `
    position:absolute;left:-10000px;top:0;visibility:hidden;width:196mm;
    font-family:'Century Gothic',Arial,sans-serif;font-size:8pt;line-height:1.25;
    background:white;z-index:-1;
  `;
  measureBox.innerHTML = `
    <style>
      #__packingListMeasureBox * { box-sizing:border-box; }
      #__packingListMeasureBox .logo-row { display:flex;justify-content:flex-end;margin-bottom:7px;height:39px; }
      #__packingListMeasureBox .logo-row img { height:39px;width:auto;object-fit:contain; }
      #__packingListMeasureBox .header { display:flex;justify-content:space-between;align-items:flex-start;gap:20px;margin-bottom:12px; }
      #__packingListMeasureBox .header-left,#__packingListMeasureBox .header-right { font-size:8pt;font-weight:bold;line-height:1.35; }
      #__packingListMeasureBox .header-left { flex:1; }
      #__packingListMeasureBox .header-right { min-width:190px;text-align:right; }
      #__packingListMeasureBox .event-name { font-size:10pt; }
      #__packingListMeasureBox .report-title { font-size:14pt;margin-bottom:4px; }
      #__packingListMeasureBox .summary-grid { display:grid;grid-template-columns:repeat(6,1fr);gap:5px;margin-bottom:6px; }
      #__packingListMeasureBox .summary-card { border:1px solid #cbd5e1;padding:6px;text-align:center; }
      #__packingListMeasureBox .summary-card span { display:block;font-size:6.5pt;text-transform:uppercase; }
      #__packingListMeasureBox .summary-card strong { display:block;font-size:12pt; }
      #__packingListMeasureBox .snapshot-note { padding:5px 7px;background:#f8fafc;border:1px solid #cbd5e1;font-size:7pt;margin-bottom:8px; }
      #__packingListMeasureBox .packing-table { width:100%;border-collapse:collapse;border:2px solid #111;table-layout:fixed; }
      #__packingListMeasureBox .packing-table th { padding:5px;background:#333;color:#fff;border:1px solid #333;font-size:7pt;text-align:left; }
      #__packingListMeasureBox .packing-table td { padding:5px;border:1px solid #333;font-size:7.5pt;vertical-align:top;word-break:break-word;overflow-wrap:anywhere; }
      #__packingListMeasureBox .number-cell { text-align:center; }
      #__packingListMeasureBox .asset-line { display:flex;align-items:flex-start;gap:4px;margin-bottom:3px; }
      #__packingListMeasureBox .asset-line:last-child { margin-bottom:0; }
      #__packingListMeasureBox .muted { color:#64748b;font-size:6.8pt; }
      #__packingListMeasureBox .continued-label { color:#64748b;font-size:6.5pt;font-weight:bold;text-transform:uppercase;letter-spacing:.03em; }
      #__packingListMeasureBox .continuation-row td { background:#f8fafc; }
      #__packingListMeasureBox .pending-note { color:#991b1b;font-weight:bold; }
      #__packingListMeasureBox .department-row td,#__packingListMeasureBox .extras-row td { padding:5px 7px;font-weight:bold;background:#e2e8f0; }
      #__packingListMeasureBox .footer-measure { width:100%;text-align:center;font-size:7pt;font-weight:bold;line-height:1.2;overflow-wrap:anywhere; }
    </style>
    <div id="__packingFirstBase">${headerHtml}${summaryHtml}<table class="packing-table">${packingListTableHead()}</table></div>
    <div id="__packingNextBase">${headerHtml}<table class="packing-table">${packingListTableHead()}</table></div>
    <table class="packing-table">${packingListTableHead()}<tbody id="__packingMeasureBody"></tbody></table>
    <div id="__packingFooterMeasure" class="footer-measure">${footerHtml}</div>
  `;

  const normaliseMeasuredHeight = mountPdfMeasureBox(measureBox, 196);
  const measureBody = measureBox.querySelector('#__packingMeasureBody');
  const firstBaseHeight = normaliseMeasuredHeight(
    measureBox.querySelector('#__packingFirstBase').getBoundingClientRect().height
  );
  const nextBaseHeight = normaliseMeasuredHeight(
    measureBox.querySelector('#__packingNextBase').getBoundingClientRect().height
  );
  const footerHeight = normaliseMeasuredHeight(
    measureBox.querySelector('#__packingFooterMeasure')?.getBoundingClientRect().height || 0
  );
  const footerReserveMm = pdfFooterReserveMm({ pageFlowHeightMm: 276 }, footerHeight);
  const firstBudget = Math.max(40, pdfMmToPx(276 - footerReserveMm) - firstBaseHeight);
  const nextBudget = Math.max(40, pdfMmToPx(276 - footerReserveMm) - nextBaseHeight);

  const measureRecordHtml = html => {
    measureBody.innerHTML = html;
    const row = measureBody.querySelector('tr');
    return row
      ? normaliseMeasuredHeight(row.getBoundingClientRect().height)
      : 0;
  };

  rowRecords.forEach(record => {
    record.height = measureRecordHtml(record.html);
  });

  // A model can contain dozens of individual asset IDs. A browser cannot split
  // one table row around a fixed footer, so divide only oversized asset lists
  // into measured continuation rows before assigning rows to pages.
  const keepWithNextReserve = rowRecords.reduce(
    (largest, record) => record.keepWithNext ? Math.max(largest, record.height) : largest,
    0
  );
  const splitBudget = Math.max(
    40,
    Math.min(firstBudget, nextBudget) - keepWithNextReserve
  );
  const fittedRecords = [];

  rowRecords.forEach(record => {
    if (!record.renderChunk || record.parts.length < 2 || record.height <= splitBudget) {
      fittedRecords.push(record);
      return;
    }

    let offset = 0;
    let continued = false;
    while (offset < record.parts.length) {
      let low = 1;
      let high = record.parts.length - offset;
      let fittingCount = 0;
      let fittingHtml = '';
      let fittingHeight = 0;

      while (low <= high) {
        const count = Math.floor((low + high) / 2);
        const html = record.renderChunk(
          record.parts.slice(offset, offset + count),
          continued
        );
        const height = measureRecordHtml(html);
        if (height <= splitBudget) {
          fittingCount = count;
          fittingHtml = html;
          fittingHeight = height;
          low = count + 1;
        } else {
          high = count - 1;
        }
      }

      // One unusually long asset label may itself be taller than the normal
      // budget. Keep it visible as a single row rather than dropping it.
      if (fittingCount === 0) {
        fittingCount = 1;
        fittingHtml = record.renderChunk(
          record.parts.slice(offset, offset + 1),
          continued
        );
        fittingHeight = measureRecordHtml(fittingHtml);
      }

      fittedRecords.push({
        html: fittingHtml,
        height: fittingHeight
      });
      offset += fittingCount;
      continued = true;
    }
  });
  measureBox.remove();

  const pages = [];
  let index = 0;
  while (index < fittedRecords.length) {
    const budget = pages.length === 0 ? firstBudget : nextBudget;
    const pageRows = [];
    let height = 0;

    while (index < fittedRecords.length) {
      const record = fittedRecords[index];
      const nextHeight = record.keepWithNext ? (fittedRecords[index + 1]?.height || 0) : 0;
      if (pageRows.length > 0 && height + record.height + nextHeight > budget) break;

      pageRows.push(record);
      height += record.height;
      index += 1;

      if (pageRows.length === 1 && record.height > budget) break;
    }
    pages.push(pageRows);
  }

  const totalPages = pages.length;
  return pages.map((pageRows, pageIndex) => `
    <div class="page">
      ${headerHtml}
      ${pageIndex === 0 ? summaryHtml : ''}
      <table class="packing-table">
        ${packingListTableHead()}
        <tbody>${pageRows.map(record => record.html).join('')}</tbody>
      </table>
      <div class="footer">${footerHtml}</div>
      <div class="page-number">Page ${pageIndex + 1} of ${totalPages}</div>
    </div>
  `).join('');
}

async function generatePackingList(eventId) {
  if (!eventId) {
    showNotification('error', 'No event selected');
    return;
  }

  const packingWindow = window.open('', '_blank', 'width=950,height=1000');
  if (!packingWindow) {
    showNotification('error', 'Pop-up blocked. Please allow pop-ups to export the packing list PDF.');
    return;
  }

  packingWindow.document.write(`<!DOCTYPE html><html><head><title>Preparing Packing List</title></head><body style="font-family:Arial,sans-serif;padding:24px;">Preparing the latest packing list...</body></html>`);
  packingWindow.document.close();

  try {
    const [response] = await Promise.all([
      apiCall(`/api/events/${eventId}`),
      loadPdfSettings(true)
    ]);
    const event = response.data;
    const snapshot = buildPackingListSnapshot(event);
    const now = new Date();
    const context = {
      reportNumber: `PL-${now.getFullYear()}${String(event.id).padStart(4, '0')}`,
      generatedAt: now.toLocaleString('en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      }),
      generatedBy: currentUser?.username || ''
    };
    const pagesHtml = buildPackingListPdfPages(event, snapshot, context);
    const title = `Packing List - ${escapeHtml(String(event.name || `Event ${event.id}`))}`;
    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${title}</title><style>
      @page { size:A4; margin:0; }
      * { box-sizing:border-box; }
      body { margin:0;font-family:'Century Gothic',Arial,sans-serif;color:#111;background:#f0f0f0;font-size:8pt;line-height:1.25; }
      .page { width:210mm;height:297mm;min-height:297mm;margin:0 auto 12px;padding:7mm 7mm 14mm;background:#fff;position:relative;overflow:hidden;page-break-after:always;break-after:page; }
      .page:last-child { page-break-after:auto;break-after:auto; }
      .print-btn { position:fixed;top:20px;right:20px;background:#16a34a;color:#fff;border:0;padding:10px 18px;border-radius:6px;cursor:pointer;z-index:999;font-size:12px; }
      .logo-row { display:flex;justify-content:flex-end;margin-bottom:7px;height:39px; }
      .logo-row img { height:39px;width:auto;object-fit:contain; }
      .header { display:flex;justify-content:space-between;align-items:flex-start;gap:20px;margin-bottom:12px; }
      .header-left,.header-right { font-size:8pt;font-weight:bold;line-height:1.35; }
      .header-left { flex:1; }
      .header-right { min-width:190px;text-align:right; }
      .event-name { font-size:10pt; }
      .report-title { font-size:14pt;margin-bottom:4px; }
      .summary-grid { display:grid;grid-template-columns:repeat(6,1fr);gap:5px;margin-bottom:6px; }
      .summary-card { border:1px solid #cbd5e1;padding:6px;text-align:center;background:#f8fafc; }
      .summary-card span { display:block;font-size:6.5pt;text-transform:uppercase;color:#475569; }
      .summary-card strong { display:block;font-size:12pt; }
      .summary-card.packed { background:#dcfce7; }
      .summary-card.pending { background:#fee2e2; }
      .summary-card.returned { background:#e5e7eb; }
      .summary-card.extras { background:#fef3c7; }
      .summary-card.completion { background:#dbeafe; }
      .snapshot-note { padding:5px 7px;background:#f8fafc;border:1px solid #cbd5e1;font-size:7pt;margin-bottom:8px; }
      .packing-table { width:100%;border-collapse:collapse;border:2px solid #111;table-layout:fixed; }
      .packing-table thead { display:table-header-group; }
      .packing-table tr { break-inside:avoid;page-break-inside:avoid; }
      .packing-table th { padding:5px;background:#333;color:#fff;border:1px solid #333;font-size:7pt;text-align:left; }
      .packing-table td { padding:5px;border:1px solid #333;font-size:7.5pt;vertical-align:top;word-break:break-word;overflow-wrap:anywhere; }
      .number-cell { text-align:center!important;white-space:nowrap; }
      .packed-number { color:#166534;font-weight:bold; }
      .pending-number { color:#991b1b;font-weight:bold;background:#fff7f7; }
      .asset-line { display:flex;align-items:flex-start;gap:4px;margin-bottom:3px; }
      .asset-line:last-child { margin-bottom:0; }
      .muted { color:#64748b;font-size:6.8pt; }
      .continued-label { color:#64748b;font-size:6.5pt;font-weight:bold;text-transform:uppercase;letter-spacing:.03em; }
      .continuation-row td { background:#f8fafc; }
      .pending-note { color:#991b1b;font-weight:bold; }
      .department-row td { padding:5px 7px;font-weight:bold;background:#e2e8f0;letter-spacing:.03em; }
      .extras-row td { padding:5px 7px;font-weight:bold;background:#fef3c7;color:#78350f; }
      .empty-row { text-align:center;color:#64748b;padding:18px!important; }
      .footer { position:absolute;bottom:7mm;left:7mm;right:7mm;text-align:center;font-size:7pt;font-weight:bold;line-height:1.2;overflow-wrap:anywhere; }
      .page-number { position:absolute;bottom:3mm;right:7mm;font-size:7pt; }
      @media print {
        body,body * { -webkit-print-color-adjust:exact;print-color-adjust:exact; }
        body { background:#fff; }
        .page { margin:0;page-break-after:always;break-after:page; }
        .page:last-child { page-break-after:auto;break-after:auto; }
        .print-btn { display:none; }
      }
    </style></head><body>
      <button class="print-btn" onclick="window.print()">Print / Save as PDF</button>
      ${pagesHtml}
    </body></html>`;

    packingWindow.document.open();
    packingWindow.document.write(html);
    packingWindow.document.close();
    packingWindow.focus();
    showNotification('success', 'Packing list PDF generated from the latest event state');
  } catch (error) {
    console.error('Packing list PDF generation failed:', error);
    if (!packingWindow.closed) {
      packingWindow.document.open();
      packingWindow.document.write(`<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;padding:24px;">Failed to generate packing list: ${escapeHtml(error.message)}</body></html>`);
      packingWindow.document.close();
    }
    showNotification('error', `Failed to generate packing list: ${error.message}`);
  }
}

let currentDeliveryOrderEvent = null;

async function openDeliveryOrderTab(eventId) {
    // Use stored event data if available, otherwise fetch it
    if (window.currentEventData && window.currentEventData.id === eventId) {
        currentDeliveryOrderEvent = window.currentEventData;
        await populateDeliveryOrderForm(window.currentEventData);
        showSection('delivery-order');
        
        // Update the tab to show it's active
        const deliveryTab = document.getElementById('delivery-order-tab');
        if (deliveryTab) deliveryTab.click();
    } else {
        // Fallback: fetch event data
        try {
            const response = await apiCall(`/api/events/${eventId}`);
            currentDeliveryOrderEvent = response.data;
            await populateDeliveryOrderForm(response.data);
            showSection('delivery-order');
            
            // Update the tab to show it's active
            const deliveryTab = document.getElementById('delivery-order-tab');
            if (deliveryTab) deliveryTab.click();
        } catch (error) {
            console.error('Error fetching event data:', error);
            showNotification('error', 'Failed to load event data');
        }
    }
}

async function populateDeliveryOrderForm(event) {
    // Auto-populate form with event data and defaults
    const doNumberEl = document.getElementById('doNumber');
    const doDateEl = document.getElementById('doDate');
    const clientNameEl = document.getElementById('clientName');
    const clientCompanyEl = document.getElementById('clientCompany');
    const deliveryAddress1El = document.getElementById('deliveryAddress1');
    const deliveryAddress2El = document.getElementById('deliveryAddress2');
    const deliveryAddress3El = document.getElementById('deliveryAddress3');
    const clientPhoneEl = document.getElementById('clientPhone');
    const jobTitleEl = document.getElementById('jobTitle');
    const jobLocationEl = document.getElementById('jobLocation');
    const additionalCommentsEl = document.getElementById('additionalComments');

    if (doNumberEl) {
      const year = new Date().getFullYear();
      const eid = (event && (event.event_id ?? event.id)) ? String(event.event_id ?? event.id).padStart(4, '0') : '0000';
      doNumberEl.value = `DO-${year}${eid}`;
    }
    
    if (doDateEl) doDateEl.value = new Date().toISOString().split('T')[0];
    if (clientNameEl) clientNameEl.value = event.client_name || event.name || '';
    if (clientCompanyEl) clientCompanyEl.value = event.client_company || '';
    if (deliveryAddress1El) deliveryAddress1El.value = event.venue || '';
    if (deliveryAddress2El) deliveryAddress2El.value = event.venue_address || '';
    if (deliveryAddress3El) deliveryAddress3El.value = event.venue_city || '';
    if (clientPhoneEl) clientPhoneEl.value = event.client_phone || '';
    if (jobTitleEl) jobTitleEl.value = event.name || '';
    if (jobLocationEl) jobLocationEl.value = event.venue || '';
    if (additionalCommentsEl) additionalCommentsEl.value = '';
    
    if (document.getElementById('showAssetIds')) document.getElementById('showAssetIds').checked = false;

    // Populate items preview (now async)
    await populateDeliveryItemsPreview(event);
    await setupClientAutocomplete();    // NEW
    ensureKnownClientsButton();
}

async function generateDeliveryOrder(format) {
    if (!currentDeliveryOrderEvent) {
        showNotification('error', 'No event selected');
        return;
    }
    
    // Get form data
    const deliveryOrderData = {
        doNumber: document.getElementById('doNumber').value,
        doDate: document.getElementById('doDate').value,
        clientName: document.getElementById('clientName').value,
        clientCompany: document.getElementById('clientCompany').value,
        deliveryAddress1: document.getElementById('deliveryAddress1').value,
        deliveryAddress2: document.getElementById('deliveryAddress2').value,
        deliveryAddress3: document.getElementById('deliveryAddress3').value,
        clientPhone: document.getElementById('clientPhone').value,
        jobTitle: document.getElementById('jobTitle').value,
        jobLocation: document.getElementById('jobLocation').value,
        additionalComments: document.getElementById('additionalComments').value,
        showAssetIds: document.getElementById('showAssetIds').checked,
        event: currentDeliveryOrderEvent
    };
    
    // Validate required fields
    if (!deliveryOrderData.doNumber || !deliveryOrderData.doDate || !deliveryOrderData.clientName) {
        showNotification('error', 'Please fill in DO Number, Date, and Client Name');
        return;
    }

    await loadPdfSettings(true);
    
    if (format === 'excel') {
        generateExcelDO(deliveryOrderData);
    } else {
        generatePdfDO(deliveryOrderData);
    }
}

function generatePdfDO(data) {
    // Format the date for display
    const formattedDate = new Date(data.doDate).toLocaleDateString('en-GB', { 
        day: '2-digit', 
        month: 'short', 
        year: 'numeric' 
    });
    
    // Create a new window for the delivery order
    const doWindow = window.open('', '_blank', 'width=800,height=1000');
    
    // Generate pages content
    const pagesContent = generatePagesContent(data, formattedDate);
    
    // Get the HTML template with populated data
    const template = `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Delivery Order - ${data.jobTitle}</title>
    <style>
        @page {
            size: A4;
            margin: 20mm;
            @top-left { content: ""; }
            @top-center { content: ""; }
            @top-right { content: ""; }
            @bottom-left { content: ""; }
            @bottom-center { content: ""; }
            @bottom-right { content: ""; }
        }
        
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: 'Century Gothic', sans-serif;
            font-size: 9pt;
            line-height: 1.2;
            color: black;
            background: white;
        }
        
        .page {
            min-height: 240mm;
            page-break-after: avoid;
            position: relative;
            padding-bottom: 1mm;
        }

        .page-break {
            page-break-before: always;
            height: 0;
            margin: 0;
            padding: 0;
        }

        .page-break + .page {
            padding-top: 12mm;
        }
        
        .header {
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
            margin-bottom: 25px;
        }
        
        .header-left {
            flex: 1;
        }
        
        .header-right {
            display: flex;
            flex-direction: column;
            align-items: flex-end;
            gap: 5px;
            margin-right: 0;
            margin-top: -5px;
            margin-bottom: 2px;
        }
        
        .logo {
            height: 60px;
            width: auto;
        }
        
        .delivery-order-title {
            font-family: 'Century Gothic', sans-serif;
            font-size: 14pt;
            font-weight: bold;
            color: black;
            margin-bottom: 5;
            text-align: right;
            margin-top: 5;
        }
        
        .do-number {
            font-family: 'Century Gothic', sans-serif;
            font-size: 9pt;
            color: black;
            text-align: left;
            margin-right: 46px;
            font-weight: bold;
            margin-bottom: 1;
        }
        
        .deliver-to {
            font-family: 'Century Gothic', sans-serif;
            font-size: 9pt;
            font-weight: bold;
            color: black;
            margin-bottom: 2px;
        }
        
        .client-info {
            font-family: 'Century Gothic', sans-serif;
            font-size: 9pt;
            color: black;
            font-weight: bold;
            margin-bottom: 1px;
        }
        
        .client-phone {
            font-family: 'Century Gothic', sans-serif;
            font-size: 9pt;
            font-weight: bold;
            color: black;
            margin-bottom: 1px;
        }
        
        .items-table {
            width: 100%;
            border-collapse: collapse;
            margin-bottom: 30px;
            border: 2px solid black;
        }
        
        .items-table th {
            background-color: #333;
            color: white;
            padding: 8px;
            text-align: left;
            font-family: 'Century Gothic', sans-serif;
            font-size: 9pt;
            font-weight: bold;
            border: 1px solid #333;
        }
        
        .items-table td {
            padding: 6px 8px;
            font-family: 'Century Gothic', sans-serif;
            font-size: 9pt;
            color: black;
            vertical-align: top;
            word-break: break-word;
            overflow-wrap: anywhere;
        }

        .items-table td:first-child {
            border-right: 1px solid black;
            border-left: 1px solid black;
        }

        .items-table td:last-child {
            border-right: 1px solid black;
        } 
        
        .job-title {
            font-weight: bold;
            background-color: #f5f5f5;
        }
        
        .department-header {
            font-weight: bold;
            color: black;
            background-color: #f0f0f0;
        }
        
        .quantity-col {
            text-align: center;
            width: 80px;
        }
        
        .comments-section {
            position: absolute;
            bottom: 5mm;
            left: 0;
            right: 0;
            display: flex;
            justify-content: space-between;
            align-items: flex-end;
            margin-top: 30px;
            margin-bottom: 30px;
        }

        .other-comments {
            font-family: 'Century Gothic', sans-serif;
            font-size: 9pt;
            font-weight: bold;
            color: black;
        }
        
        .received-text {
            bottom: 5mm; 
            font-family: 'Century Gothic', sans-serif;
            font-size: 9pt;
            color: black;
        }
        
        .signature-line {
            bottom: 2mm;
            width: 210px;
            height: 60px;
            display: flex;
            flex-direction: column;
            justify-content: flex-end;
            align-items: center;
            font-family: 'Century Gothic', sans-serif;
            font-size: 9pt;
            color: black;
            margin-top: 20px;
        }
        
        .signature-line::before {
            content: "";
            border-bottom: 2px solid black;
            width: 100%;
            margin-bottom: 5px;
        }
        
        .footer {
            position: absolute;
            bottom: 10mm;
            left: 0;
            right: 0;
            text-align: center;
            font-family: 'Calibri', sans-serif;
            font-size: 7pt;
            color: black;
            line-height: 1.2;
            z-index: 100;
            overflow-wrap: anywhere;
        }

        .page-number {
            position: fixed;
            bottom: 5mm;
            right: 0;
            margin-right: 20px;
            font-family: 'Century Gothic', sans-serif;
            font-size: 7pt;
            color: black;
        }
        
        @media print {
            body {
                -webkit-print-color-adjust: exact;
                print-color-adjust: exact;
            }
            
            .page {
                page-break-after: avoid;
                page-break-inside: avoid;
            }
            
            .page-break {
                page-break-before: always;
                display: block;
                height: 0;
            }

            @page { margin: 0; }
            html, body { margin: 0 !important; padding: 7mm !important; }
        }
        
                /* Delivery Order measured pagination */
        body {
            margin: 0;
            padding: 0;
            background: white;
        }

        .page {
            width: 210mm;
            height: 297mm;
            min-height: 297mm;
            position: relative;
            padding: 7mm 7mm 14mm 7mm;
            overflow: hidden;
            page-break-after: always;
            break-after: page;
            background: white;
        }

        .page:last-child {
            page-break-after: auto;
            break-after: auto;
        }

        .page-break {
            display: none !important;
        }

        .page-break + .page {
            padding-top: 7mm;
        }

        .items-table {
            margin-bottom: 0;
        }

        .comments-section {
            position: absolute;
            left: 7mm;
            right: 7mm;
            bottom: 39mm;
            display: flex;
            justify-content: space-between;
            align-items: flex-end;
            margin: 0;
        }

        .signature-holder {
            position: absolute;
            right: 7mm;
            bottom: 18mm;
        }

        .footer {
            position: absolute;
            bottom: 7mm;
            left: 7mm;
            right: 7mm;
            text-align: center;
            font-family: 'Calibri', sans-serif;
            font-size: 7pt;
            color: black;
            line-height: 1.2;
            z-index: 100;
            overflow-wrap: anywhere;
        }

        .page-number {
            position: absolute;
            bottom: 3mm;
            right: 7mm;
            margin-right: 0;
            font-family: 'Century Gothic', sans-serif;
            font-size: 7pt;
            color: black;
        }

        @media print {
            @page {
                size: A4;
                margin: 0;
            }

            html,
            body {
                margin: 0 !important;
                padding: 0 !important;
                width: 210mm;
                background: white;
            }

            .page {
                width: 210mm;
                height: 297mm;
                min-height: 297mm;
                padding: 7mm 7mm 14mm 7mm;
                page-break-after: always;
                break-after: page;
                page-break-inside: avoid;
                break-inside: avoid;
            }

            .page:last-child {
                page-break-after: auto;
                break-after: auto;
            }
        }
    </style>
</head>
<body>
    ${pagesContent}
    
    <script>
        // Calculate total pages and update page numbers
        function updatePageNumbers() {
            const pages = document.querySelectorAll('.page');
            const totalPages = pages.length;
            
            pages.forEach((page, index) => {
                const pageNum = index + 1;
                let pageNumberDiv = page.querySelector('.page-number');
                if (!pageNumberDiv) {
                    pageNumberDiv = document.createElement('div');
                    pageNumberDiv.className = 'page-number';
                    page.appendChild(pageNumberDiv);
                }
                pageNumberDiv.textContent = 'Page ' + pageNum + ' of ' + totalPages;
            });
        }
        
        // Wait for content to load before updating page numbers
        setTimeout(() => {
            updatePageNumbers();
        }, 100);
    </script>
</body>
</html>`;
    
    doWindow.document.write(template);
    doWindow.document.close();
    
    // Add print functionality
    setTimeout(() => {
        doWindow.focus();
        doWindow.print();
    }, 1000);
    
    showNotification('success', 'PDF delivery order generated successfully');
}

function generatePagesContent(data, formattedDate) {
    const departments = groupItemsByDepartment(data.event);
    const logoUrl = escapeHtmlAttr(getPdfLogoUrl());
    const footerHtml = renderPdfFooterHtml();

    // A4 is 210mm x 297mm.
    // Page padding is 7mm top/left/right and 14mm bottom.
    // Normal pages reserve the measured footer height.
    // Last page reserves comments + signature + footer space.
    const PAGE_BODY_HEIGHT_MM = 276;
    const LAST_RESERVED_MM = 52;

    const FOOTER_HTML = `
        <div class="footer">
            ${footerHtml}
        </div>
    `;

    const safe = (value) => escapeHtml(String(value ?? ''));

    const renderAssetIdsLine = (assetIds) => {
        if (!assetIds || assetIds.length === 0) return '';

        return `
            <br>
            <span style="font-size:8px;color:#666;font-style:italic;">
                Asset IDs: ${assetIds.map(id => safe(id)).join(', ')}
            </span>
        `;
    };

    const renderItemRow = (record) => {
        return `
            <tr>
                <td>
                    ${safe(record.item.description)}
                    ${renderAssetIdsLine(record.item.assetIds)}
                </td>
                <td class="quantity-col">${safe(record.item.quantity)}</td>
            </tr>
        `;
    };

    const renderDeptRow = (dept) => {
        return `
            <tr>
                <td class="department-header" colspan="2">${safe(dept)}:</td>
            </tr>
        `;
    };

    // Hidden measuring box: lets the browser calculate real row heights
    // instead of guessing based on row count.
    const measureBox = document.createElement('div');
    measureBox.id = '__doMeasureBox';
    measureBox.style.cssText = `
        position:absolute;
        left:-10000px;
        top:0;
        visibility:hidden;
        width:196mm;
        font-family:'Century Gothic', sans-serif;
        font-size:9pt;
        line-height:1.2;
        background:white;
        z-index:-1;
    `;

    measureBox.innerHTML = `
        <style>
            #__doMeasureBox * {
                box-sizing: border-box;
            }

            #__doMeasureBox .do-logo-row {
                display: flex;
                justify-content: flex-end;
                margin-bottom: 7px;
                height: 39px;
            }

            #__doMeasureBox .header {
                display: flex;
                justify-content: space-between;
                align-items: flex-start;
                margin-bottom: 25px;
            }

            #__doMeasureBox .header-left {
                flex: 1;
            }

            #__doMeasureBox .header-right {
                display: flex;
                flex-direction: column;
                align-items: flex-end;
                gap: 5px;
                margin-right: 0;
                margin-top: -5px;
                margin-bottom: 2px;
            }

            #__doMeasureBox .delivery-order-title {
                font-family: 'Century Gothic', sans-serif;
                font-size: 14pt;
                font-weight: bold;
                color: black;
                margin-bottom: 5px;
                text-align: right;
                margin-top: 5px;
            }

            #__doMeasureBox .do-number,
            #__doMeasureBox .deliver-to,
            #__doMeasureBox .client-info,
            #__doMeasureBox .client-phone {
                font-family: 'Century Gothic', sans-serif;
                font-size: 9pt;
                color: black;
                font-weight: bold;
            }

            #__doMeasureBox .items-table,
            #__doMeasureBox .do-measure-table {
                width: 100%;
                border-collapse: collapse;
                border: 2px solid black;
                margin-bottom: 0;
            }

            #__doMeasureBox .items-table th,
            #__doMeasureBox .do-measure-table th {
                background-color: #333;
                color: white;
                padding: 8px;
                text-align: left;
                font-family: 'Century Gothic', sans-serif;
                font-size: 9pt;
                font-weight: bold;
                border: 1px solid #333;
            }

            #__doMeasureBox .items-table td,
            #__doMeasureBox .do-measure-table td {
                padding: 6px 8px;
                font-family: 'Century Gothic', sans-serif;
                font-size: 9pt;
                color: black;
                vertical-align: top;
                word-break: break-word;
                overflow-wrap: anywhere;
            }

            #__doMeasureBox .items-table td:first-child,
            #__doMeasureBox .do-measure-table td:first-child {
                border-right: 1px solid black;
                border-left: 1px solid black;
            }

            #__doMeasureBox .items-table td:last-child,
            #__doMeasureBox .do-measure-table td:last-child {
                border-right: 1px solid black;
            }

            #__doMeasureBox .job-title {
                font-weight: bold;
                background-color: #f5f5f5;
            }

            #__doMeasureBox .department-header {
                font-weight: bold;
                color: black;
                background-color: #f0f0f0;
            }

            #__doMeasureBox .quantity-col {
                text-align: center;
                width: 80px;
            }

            #__doMeasureBox .footer-measure {
                width: 100%;
                text-align: center;
                font-family: 'Calibri', sans-serif;
                font-size: 7pt;
                line-height: 1.2;
                overflow-wrap: anywhere;
            }
        </style>

        <div id="__doBaseMeasure">
            <div class="do-logo-row"></div>

            <div class="header">
                <div class="header-left">
                    <div class="deliver-to">DELIVER TO:</div>
                    <div class="client-info">
                        ${safe(data.clientName)}<br>
                        ${data.clientCompany ? safe(data.clientCompany) + '<br>' : ''}
                        ${data.deliveryAddress1 ? safe(data.deliveryAddress1) + '<br>' : ''}
                        ${data.deliveryAddress2 ? safe(data.deliveryAddress2) + '<br>' : ''}
                        ${data.deliveryAddress3 ? safe(data.deliveryAddress3) + '<br>' : ''}
                    </div>
                    ${data.clientPhone ? `<div class="client-phone">Tel : ${safe(data.clientPhone)}</div>` : '<div class="client-phone">Tel : N/A</div>'}
                </div>

                <div class="header-right">
                    <div class="delivery-order-title">DELIVERY ORDER</div>
                    <div class="do-number">
                        No. : ${safe(data.doNumber)}<br>
                        Date : ${safe(formattedDate)}
                    </div>
                </div>
            </div>

            <table class="items-table">
                <thead>
                    <tr>
                        <th class="description-header">DESCRIPTION</th>
                        <th class="quantity-header">QUANTITY</th>
                    </tr>
                </thead>
                <tbody>
                    <tr>
                        <td class="job-title">
                            Job Title : ${safe(data.jobTitle)}
                            ${data.jobLocation ? '<br>' + safe(data.jobLocation) : ''}
                        </td>
                        <td class="quantity-col"></td>
                    </tr>
                </tbody>
            </table>
        </div>

        <table class="do-measure-table">
            <tbody id="__doMeasureBody"></tbody>
        </table>

        <div id="__doFooterMeasure" class="footer-measure">${footerHtml}</div>
    `;

    const normaliseMeasuredHeight = mountPdfMeasureBox(measureBox, 196);

    const measureBody = measureBox.querySelector('#__doMeasureBody');
    const baseHeight = normaliseMeasuredHeight(
        measureBox.querySelector('#__doBaseMeasure').getBoundingClientRect().height
    );
    const footerHeight = normaliseMeasuredHeight(
        measureBox.querySelector('#__doFooterMeasure')?.getBoundingClientRect().height || 0
    );
    const normalReservedMm = pdfFooterReserveMm({
        pageFlowHeightMm: PAGE_BODY_HEIGHT_MM
    }, footerHeight);

    const normalPageRowBudget = Math.max(
        50,
        pdfMmToPx(PAGE_BODY_HEIGHT_MM - normalReservedMm) - baseHeight
    );

    const lastPageRowBudget = Math.max(
        50,
        pdfMmToPx(PAGE_BODY_HEIGHT_MM - Math.max(LAST_RESERVED_MM, normalReservedMm)) - baseHeight
    );

    function measureRow(rowHtml) {
        measureBody.innerHTML = rowHtml;
        const row = measureBody.querySelector('tr');
        return row ? normaliseMeasuredHeight(row.getBoundingClientRect().height) : 0;
    }

    const deptHeights = {};
    const records = [];

    Object.keys(departments).forEach(dept => {
        const deptItems = departments[dept] || [];
        if (deptItems.length === 0) return;

        deptHeights[dept] = measureRow(renderDeptRow(dept));

        deptItems.forEach(item => {
            const assetIds = data.showAssetIds
                ? getAssetIdsByItem(data.event, item, dept)
                : [];

            const record = {
                dept,
                item: {
                    ...item,
                    assetIds
                },
                height: 0
            };

            record.height = measureRow(renderItemRow(record));
            records.push(record);
        });
    });

    measureBox.remove();

    function costToAdd(page, record) {
        const needsDeptHeader = page.lastDept !== record.dept;
        return (needsDeptHeader ? deptHeights[record.dept] : 0) + record.height;
    }

    function canFitRemaining(startIndex, budget) {
        const testPage = {
            records: [],
            height: 0,
            lastDept: null
        };

        for (let i = startIndex; i < records.length; i++) {
            const record = records[i];
            const cost = costToAdd(testPage, record);

            if (testPage.height + cost > budget) {
                return false;
            }

            testPage.records.push(record);
            testPage.height += cost;
            testPage.lastDept = record.dept;
        }

        return true;
    }

    function fillPage(startIndex, budget) {
        const page = {
            records: [],
            height: 0,
            lastDept: null
        };

        let i = startIndex;

        while (i < records.length) {
            const record = records[i];
            const cost = costToAdd(page, record);

            if (page.records.length > 0 && page.height + cost > budget) {
                break;
            }

            // If one single row is taller than the available area,
            // keep it on the page instead of creating an infinite loop.
            if (page.records.length === 0 && cost > budget) {
                page.records.push(record);
                page.height += cost;
                page.lastDept = record.dept;
                i++;
                break;
            }

            page.records.push(record);
            page.height += cost;
            page.lastDept = record.dept;
            i++;
        }

        return {
            page,
            nextIndex: i
        };
    }

    const pages = [];

    if (records.length === 0) {
        pages.push({
            records: [],
            height: 0,
            lastDept: null
        });
    } else {
        let index = 0;

        while (index < records.length) {
            const remainingCanBeLastPage = canFitRemaining(index, lastPageRowBudget);
            const budget = remainingCanBeLastPage ? lastPageRowBudget : normalPageRowBudget;

            const result = fillPage(index, budget);
            pages.push(result.page);
            index = result.nextIndex;
        }
    }

    let pagesHtml = '';
    const totalPages = pages.length;

    pages.forEach((page, pageIndex) => {
        const isLastPage = pageIndex === totalPages - 1;
        const pageNumber = pageIndex + 1;

        pagesHtml += `
            <div class="page">
                <div style="display:flex;justify-content:flex-end;margin-bottom:7px;">
                    <img src="${logoUrl}" alt="Company Logo" style="height:39px;width:auto;object-fit:contain">
                </div>

                <div class="header">
                    <div class="header-left">
                        <div class="deliver-to">DELIVER TO:</div>
                        <div class="client-info">
                            ${safe(data.clientName)}<br>
                            ${data.clientCompany ? safe(data.clientCompany) + '<br>' : ''}
                            ${data.deliveryAddress1 ? safe(data.deliveryAddress1) + '<br>' : ''}
                            ${data.deliveryAddress2 ? safe(data.deliveryAddress2) + '<br>' : ''}
                            ${data.deliveryAddress3 ? safe(data.deliveryAddress3) + '<br>' : ''}
                        </div>
                        ${data.clientPhone ? `<div class="client-phone">Tel : ${safe(data.clientPhone)}</div>` : '<div class="client-phone">Tel : N/A</div>'}
                    </div>

                    <div class="header-right">
                        <div class="delivery-order-title">DELIVERY ORDER</div>
                        <div class="do-number">
                            No. : ${safe(data.doNumber)}<br>
                            Date : ${safe(formattedDate)}
                        </div>
                    </div>
                </div>

                <table class="items-table">
                    <thead>
                        <tr>
                            <th class="description-header">DESCRIPTION</th>
                            <th class="quantity-header">QUANTITY</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr>
                            <td class="job-title">
                                Job Title : ${safe(data.jobTitle)}
                                ${data.jobLocation ? '<br>' + safe(data.jobLocation) : ''}
                            </td>
                            <td class="quantity-col"></td>
                        </tr>
        `;

        let currentDept = null;

        page.records.forEach(record => {
            if (record.dept !== currentDept) {
                pagesHtml += renderDeptRow(record.dept);
                currentDept = record.dept;
            }

            pagesHtml += renderItemRow(record);
        });

        pagesHtml += `
                    </tbody>
                </table>
        `;

        if (isLastPage) {
            pagesHtml += `
                <div class="comments-section">
                    <div class="other-comments">Other Comments: ${safe(data.additionalComments || '')}</div>
                    <div class="received-text">Received in good order & condition</div>
                </div>

                <div class="signature-holder">
                    <div class="signature-line">
                        Company's Stamp & Signature
                    </div>
                </div>
            `;
        }

        pagesHtml += `
                ${FOOTER_HTML}
                <div class="page-number">Page ${pageNumber} of ${totalPages}</div>
            </div>
        `;
    });

    return pagesHtml;
}

function generateExcelDO(data) {
    // Import SheetJS if not already loaded
    if (typeof XLSX === 'undefined') {
        const script = document.createElement('script');
        script.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
        script.onload = () => generateExcelDO(data);
        document.head.appendChild(script);
        return;
    }
    
    // Format the date for display
    const formattedDate = new Date(data.doDate).toLocaleDateString('en-GB', { 
        day: '2-digit', 
        month: 'short', 
        year: 'numeric' 
    });
    
    // Prepare data for Excel
    const excelData = [];
    
    // Header information
    excelData.push(['DELIVERY ORDER']);
    excelData.push([]);
    excelData.push(['DELIVER TO:', '', '', 'No.:  ', data.doNumber]);
    excelData.push([data.clientName, '', '', 'Date: ', formattedDate]);
    if (data.clientCompany) excelData.push([data.clientCompany]);
    if (data.deliveryAddress1) excelData.push([data.deliveryAddress1]);
    if (data.deliveryAddress2) excelData.push([data.deliveryAddress2]);
    if (data.deliveryAddress3) excelData.push([data.deliveryAddress3]);
    if (data.clientPhone) excelData.push([`Tel. ${data.clientPhone}`]);
    excelData.push([]);
    
    // Table headers
    excelData.push(['DESCRIPTION', 'QUANTITY']);
    
    // Job title row
    excelData.push([`Job Title :  ${data.jobTitle}`, '']);
    if (data.jobLocation) excelData.push([data.jobLocation, '']);
    
    // Group items by department
    const departments = groupItemsByDepartment(data.event);
    
    // Add items by department
    Object.keys(departments).forEach(dept => {
        if (departments[dept].length > 0) {
            excelData.push([`${dept}:`]);
            departments[dept].forEach(item => {
                excelData.push([item.description, item.quantity]);
            });
        }
    });
    
    excelData.push([]);
    excelData.push([`Other Comments: ${data.additionalComments || ''}`, 'Received in good order & condition']);
    excelData.push([]);
    excelData.push(["Company's Stamp & Signature"]);
    excelData.push([]);
    excelData.push(['AVEC VISION PRIVATE LIMITED']);
    excelData.push(['25 KAKI BUKIT ROAD 4 #07-55 SYNERGY@KB SINGAPORE 417800 TEL 65.6747.5201 CO REG 202122775G']);
    
    // Create workbook
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(excelData);
    
    // Set column widths
    ws['!cols'] = [
        { width: 60 }, // Description column
        { width: 12 }  // Quantity column
    ];
    
    // Add worksheet to workbook
    XLSX.utils.book_append_sheet(wb, ws, 'Delivery Order');
    
    // Generate and download file
    const fileName = `DO_${data.doNumber}_${data.jobTitle.replace(/[^a-zA-Z0-9]/g, '_')}.xlsx`;
    XLSX.writeFile(wb, fileName);
    
    showNotification('success', 'Excel delivery order generated successfully');
}

// Delivery order generation helpers
async function ensureAssetsLoaded() {
    if (!assets || assets.length === 0) {
        try {
            const response = await apiCall('/api/assets');
            if (response.success) {
                assets = response.data;
            } else {
                console.error('Failed to load assets:', response);
            }
        } catch (error) {
            console.error('Error loading assets:', error);
        }
    }
}

// Delivery order item ordering
function reorderDoItems(eventId, dept, fromIndex, toIndex) {
  const state = getDoEdits(eventId);
  
  // Get the current items for this department from groupItemsByDepartment
  const event = events.find(e => e.id === eventId || e.event_id === eventId);
  if (!event) return false;
  
  const depts = groupItemsByDepartment(event);
  const items = depts[dept] || [];
  
  if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || 
      fromIndex >= items.length || toIndex >= items.length) {
    return false;
  }

  // Create a new ordering array for this department if it doesn't exist
  if (!state.ordering) {
    state.ordering = {};
  }
  if (!state.ordering[dept]) {
    // Initialize ordering with current item keys
    state.ordering[dept] = items.map(item => item.key);
  }

  // Reorder in the ordering array
  const ordering = [...state.ordering[dept]];
  const [movedKey] = ordering.splice(fromIndex, 1);
  ordering.splice(toIndex, 0, movedKey);
  
  state.ordering[dept] = ordering;
  saveDoEdits(eventId, state);
  return true;
}

function applyDoOrdering(items, dept, eventId) {
  const state = getDoEdits(eventId);
  
  if (!state.ordering || !state.ordering[dept]) {
    return items; // Return original order if no custom ordering
  }
  
  const ordering = state.ordering[dept];
  const orderedItems = [];
  const itemsMap = new Map(items.map(item => [item.key, item]));
  
  // First, add items in the specified order
  ordering.forEach(key => {
    const item = itemsMap.get(key);
    if (item) {
      orderedItems.push(item);
      itemsMap.delete(key); // Remove from map to avoid duplicates
    }
  });
  
  // Then, add any new items that weren't in the original ordering
  itemsMap.forEach(item => {
    orderedItems.push(item);
  });
  
  return orderedItems;
}

function clearDoOrdering(eventId) {
  const state = getDoEdits(eventId);
  if (state.ordering) {
    delete state.ordering;
    saveDoEdits(eventId, state);
  }
}

function setupDoItemDragHandlers(previewContainer, eventId) {
  let draggedElement = null;
  let draggedIndex = null;
  let draggedDept = null;

  previewContainer.querySelectorAll('.do-item-row[draggable="true"]').forEach(row => {
    row.addEventListener('dragstart', (e) => {
      draggedElement = e.target;
      draggedIndex = parseInt(e.target.getAttribute('data-index'));
      draggedDept = e.target.getAttribute('data-dept');
      e.target.classList.add('dragging');
      
      // Set drag data
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/html', e.target.outerHTML);
    });

    row.addEventListener('dragend', (e) => {
      e.target.classList.remove('dragging');
      draggedElement = null;
      draggedIndex = null;
      draggedDept = null;
      
      // Remove drag-over class from all rows
      previewContainer.querySelectorAll('.do-item-row').forEach(r => r.classList.remove('drag-over'));
    });

    row.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      
      // Only allow dropping within same department
      const targetDept = e.target.closest('.do-item-row').getAttribute('data-dept');
      if (targetDept === draggedDept) {
        e.target.closest('.do-item-row').classList.add('drag-over');
      }
    });

    row.addEventListener('dragleave', (e) => {
      e.target.closest('.do-item-row').classList.remove('drag-over');
    });

    row.addEventListener('drop', (e) => {
      e.preventDefault();
      const targetRow = e.target.closest('.do-item-row');
      const targetIndex = parseInt(targetRow.getAttribute('data-index'));
      const targetDept = targetRow.getAttribute('data-dept');
      
      targetRow.classList.remove('drag-over');
      
      // Only allow dropping within same department
      if (targetDept !== draggedDept || targetIndex === draggedIndex) {
        return;
      }

      // Attempt to reorder the items
      if (reorderDoItems(eventId, draggedDept, draggedIndex, targetIndex)) {
        // Refresh the display
        const event = events.find(e => e.id === eventId || e.event_id === eventId);
        if (event) {
          populateDeliveryItemsPreview(event);
        }
        if (typeof showNotification === 'function') {
          showNotification('success', 'Items reordered successfully');
        }
      } else {
        if (typeof showNotification === 'function') {
          showNotification('warning', 'Can only reorder custom items within the same department');
        }
      }
    });
  });
}

// Delivery order preview and inline editing
async function populateDeliveryItemsPreview(event) {
  const previewContainer = document.getElementById('deliveryItemsPreview');
  if (!previewContainer) return;

  try { 
    if (typeof ensureAssetsLoaded === 'function') await ensureAssetsLoaded(); 
  } catch {}

  const eventId = event.id || event.event_id || window.currentEventId || '0';
  const edits = getDoEdits(eventId);

  const render = () => {
    const depts = groupItemsByDepartment(event);
    const editMode = !!document.querySelector('#doEditToggle')?.checked;

    let html = `
      <style>
        .do-items-container {
          background: white;
          border-radius: 8px;
          overflow: hidden;
        }
        .do-toolbar {
          background: #f8f9fa;
          padding: 15px 20px;
          border-bottom: 1px solid #e9ecef;
          display: flex;
          gap: 12px;
          align-items: center;
          justify-content: space-between;
          flex-wrap: wrap;
        }
        .do-toolbar label {
          display: flex;
          gap: 8px;
          align-items: center;
          font-weight: 500;
          color: #495057;
          cursor: pointer;
        }
        .do-department-section {
          border-bottom: 1px solid #f1f3f4;
        }
        .do-department-section:last-child {
          border-bottom: none;
        }
        .do-dept-header {
          background: #f8f9fa;
          padding: 12px 20px;
          font-weight: 600;
          color: #495057;
          border-bottom: 1px solid #e9ecef;
        }
        .do-items-list {
          padding: 0;
        }
        .do-item-row {
          display: flex;
          align-items: center;
          padding: 12px 20px;
          border-bottom: 1px solid #f8f9fa;
          transition: background-color 0.2s ease;
        }
        .do-item-row:hover {
          background-color: #f8f9fa;
        }
        .do-item-row:last-child {
          border-bottom: none;
        }
        .do-item-description {
          flex: 1;
          min-width: 0;
          margin-right: 15px;
        }
        .do-item-description input {
          width: 100%;
          border: 1px solid #e9ecef;
          border-radius: 4px;
          padding: 8px 12px;
          font-size: 14px;
        }
        .do-item-description input:focus {
          outline: none;
          border-color: #667eea;
          box-shadow: 0 0 0 2px rgba(102, 126, 234, 0.2);
        }
        .do-item-quantity {
          width: 80px;
          margin-right: 15px;
        }
        .do-item-quantity input {
          width: 100%;
          text-align: center;
          border: 1px solid #e9ecef;
          border-radius: 4px;
          padding: 8px;
          font-size: 14px;
          font-weight: 600;
        }
        .do-item-quantity input:focus {
          outline: none;
          border-color: #667eea;
          box-shadow: 0 0 0 2px rgba(102, 126, 234, 0.2);
        }
        .do-quantity-badge {
          display: inline-block;
          background: #6f42c1;
          color: white;
          padding: 4px 12px;
          border-radius: 12px;
          font-size: 12px;
          font-weight: 600;
          min-width: 32px;
          text-align: center;
        }
        .do-item-actions {
          display: flex;
          gap: 8px;
        }
        .do-add-section {
          background: #f8f9fa;
          padding: 15px 20px;
          border-top: 1px solid #e9ecef;
        }
        .do-add-form {
          display: flex;
          gap: 10px;
          align-items: center;
          flex-wrap: wrap;
        }
        .do-add-description {
          flex: 1;
          min-width: 300px;
        }
        .do-add-quantity {
          width: 80px;
        }
        .no-items-message {
          padding: 40px 20px;
          text-align: center;
          color: #6c757d;
          font-style: italic;
        }

        .do-item-row.dragging {
          opacity: 0.5;
        }
        .do-item-row.drag-over {
          border-top: 2px solid #667eea;
        }
        .do-drag-handle {
          cursor: grab;
          padding: 8px;
          margin-right: 8px;
          color: #6c757d;
          font-size: 14px;
          user-select: none;
        }
        .do-drag-handle:hover {
          color: #495057;
        }
        .do-drag-handle:active {
          cursor: grabbing;
        }
      </style>

      <div class="do-items-container">
        <div class="do-toolbar">
          <div>
            <div style="font-weight:700;color:#495057;">Delivery Order Item Editor</div>
            <div style="font-size:12px;color:#6c757d;margin-top:2px;">Review departments, edit quantities/descriptions, add DO-only rows, and drag to reorder while edit mode is on.</div>
          </div>
          <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
            <label>
              <input type="checkbox" id="doEditToggle"${editMode ? ' checked' : ''}> 
              <span>Edit mode</span>
            </label>
            <button class="btn btn-secondary" id="doResetEdits" title="Reset all edits and return to original items">
              Reset Edits
            </button>
          </div>
        </div>
    `;

    const esc = (s) => escapeHtml(s);
    const escA = (s) => (typeof escapeHtmlAttr === 'function' ? escapeHtmlAttr(s) : esc(s));

    // Generate department sections
    const section = (deptName, items) => {
      const rows = items.map((item, i) => {
        const isDoCustom = item.source?.startsWith('do-custom');
        const canDelete = editMode && isDoCustom;
        
        if (editMode) {
          return `
            <div class="do-item-row" draggable="true" data-key="${escA(item.key)}" data-kind="${escA(item.source || '')}" data-dept="${escA(deptName)}" data-index="${i}">
              <div class="do-drag-handle">⋮⋮</div>
              <div class="do-item-description">
                <input type="text" class="do-desc form-input" value="${escA(item.description)}" placeholder="Item description">
              </div>
              <div class="do-item-quantity">
                <input type="number" class="do-qty form-input" value="${item.quantity}" min="1" max="999">
              </div>
              <div class="do-item-actions">
                <button class="btn btn-primary btn-sm do-save">Save</button>
                ${canDelete ? '<button class="btn btn-danger btn-sm do-del">Delete</button>' : ''}
              </div>
            </div>
          `;
        } else {
          return `
            <div class="do-item-row">
              <div class="do-item-description">
                <span style="color: #495057; font-weight: 500;">${esc(item.description)}</span>
              </div>
              <div class="do-item-quantity">
                <span class="do-quantity-badge">${item.quantity}</span>
              </div>
              <div class="do-item-actions">
                <!-- Read-only mode -->
              </div>
            </div>
          `;
        }
      }).join('');

      // Add section for new items (edit mode only)
      const addSection = !editMode ? '' : `
        <div class="do-add-section">
          <div class="do-add-form">
            <div class="do-add-description">
              <input type="text" class="form-input do-add-desc" placeholder="Add custom item to ${deptName} department">
            </div>
            <div class="do-add-quantity">
              <input type="number" class="form-input do-add-qty" value="1" min="1" max="999">
            </div>
            <button class="btn btn-primary do-add-btn" data-dept="${escA(deptName)}">
              Add Item
            </button>
          </div>
        </div>
      `;

      return `
        <div class="do-department-section">
          <div class="do-dept-header">${esc(deptName)} Department</div>
          <div class="do-items-list" data-dept="${escA(deptName)}">
            ${rows || '<div class="no-items-message">No items in this department</div>'}
          </div>
          ${addSection}
        </div>
      `;
    };

    let body = '';
    getDoDepartmentList(depts, edits).forEach(dept => {
      if ((depts[dept] || []).length > 0 || ((edits.custom || {})[dept] || []).length > 0 || (editMode && dept !== 'MISC')) {
        body += section(dept, depts[dept] || []);
      }
    });

    if (!body.trim()) {
      body = '<div class="no-items-message">No items assigned to this event.</div>';
    }

    html += body + '</div>';
    previewContainer.innerHTML = html;

    // Wire up event handlers
    const resetBtn = document.getElementById('doResetEdits');
    if (resetBtn) {
      resetBtn.onclick = () => {
        clearDoEdits(eventId);
        clearDoOrdering(eventId); // Add this line
        if (typeof showNotification === 'function') {
          showNotification('success', 'DO edits reset');
        }
        populateDeliveryItemsPreview(event);
      };
    }

    const toggle = document.getElementById('doEditToggle');
    if (toggle) {
      toggle.onchange = () => populateDeliveryItemsPreview(event);
    }

    // Save / delete / add handlers
    previewContainer.querySelectorAll('.do-save').forEach(btn => {
      btn.onclick = (e) => {
        const row = e.target.closest('.do-item-row');
        const key = row.getAttribute('data-key');
        const kind = row.getAttribute('data-kind');
        const dept = row.getAttribute('data-dept');
        const idxStr = row.getAttribute('data-index');
        const desc = row.querySelector('.do-desc').value.trim();
        const qty = Math.max(1, parseInt(row.querySelector('.do-qty').value, 10) || 1);

        if (!desc) {
          showNotification('warning', 'Description is required');
          return;
        }

        const state = getDoEdits(eventId);
        if (kind === 'do-custom') {
          const i = parseInt(idxStr, 10);
          state.custom[dept] ||= [];
          if (Number.isInteger(i) && state.custom[dept][i]) {
            state.custom[dept][i] = { description: desc, quantity: qty };
          }
        } else {
          state.overrides[key] = { description: desc, quantity: qty };
        }
        
        saveDoEdits(eventId, state);
        if (typeof showNotification === 'function') {
          showNotification('success', 'Item updated successfully');
        }
        populateDeliveryItemsPreview(event);
      };
    });

    previewContainer.querySelectorAll('.do-del').forEach(btn => {
      btn.onclick = async (e) => {
        const confirmed = await showCustomConfirm(
          'Delete Item', 
          'Are you sure you want to delete this item from the delivery order?'
        );
        
        if (!confirmed) return;

        const row = e.target.closest('.do-item-row');
        const dept = row.getAttribute('data-dept');
        const idxStr = row.getAttribute('data-index');
        const i = parseInt(idxStr, 10);
        const state = getDoEdits(eventId);
        
        state.custom[dept] ||= [];
        if (Number.isInteger(i) && state.custom[dept]) {
          state.custom[dept].splice(i, 1);
          saveDoEdits(eventId, state);
          if (typeof showNotification === 'function') {
            showNotification('success', 'Item deleted successfully');
          }
          populateDeliveryItemsPreview(event);
        }
      };
    });

    previewContainer.querySelectorAll('.do-add-btn').forEach(btn => {
      btn.onclick = (e) => {
        const dept = e.currentTarget.getAttribute('data-dept');
        const wrap = e.currentTarget.closest('.do-add-form');
        const desc = wrap.querySelector('.do-add-desc').value.trim();
        const qty = Math.max(1, parseInt(wrap.querySelector('.do-add-qty').value, 10) || 1);
        
        if (!desc) {
          showNotification('warning', 'Description is required');
          wrap.querySelector('.do-add-desc').focus();
          return;
        }

        const state = getDoEdits(eventId);
        state.custom[dept] ||= [];
        state.custom[dept].push({ description: desc, quantity: qty });
        saveDoEdits(eventId, state);
        
        // Clear the form
        wrap.querySelector('.do-add-desc').value = '';
        wrap.querySelector('.do-add-qty').value = '1';
        
        if (typeof showNotification === 'function') {
          showNotification('success', `Added item to ${dept} department`);
        }
        populateDeliveryItemsPreview(event);
      };
    });

    // Add keyboard shortcuts for form inputs
    previewContainer.querySelectorAll('.do-add-desc').forEach(input => {
      input.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
          const addBtn = input.closest('.do-add-form').querySelector('.do-add-btn');
          if (addBtn) addBtn.click();
        }
      });
    });

    // Setup drag and drop handlers for reordering (only in edit mode)
    if (editMode) {
      setupDoItemDragHandlers(previewContainer, eventId);
    }

    // Also update the drag handles to prevent dragging on form inputs
    previewContainer.querySelectorAll('.do-drag-handle').forEach(handle => {
      handle.addEventListener('mousedown', (e) => {
        // Prevent drag from starting on input fields
        const row = handle.closest('.do-item-row');
        const inputs = row.querySelectorAll('input');
        inputs.forEach(input => {
          input.setAttribute('draggable', 'false');
        });
      });
    });
  };

  render();
}

function groupItemsByDepartment(event) {
  const departments = {};
  const ensureDept = (dept) => {
    const name = departmentCodeToDoName(dept);
    if (!departments[name]) departments[name] = [];
    return name;
  };

  getDefaultDoDepartments().forEach(ensureDept);

  // 1) Base groups from modelGroups (what the job actually asked for)
  if (event.modelGroups && Object.keys(event.modelGroups).length) {
    Object.values(event.modelGroups).forEach(mg => {
      const dname = ensureDept(mg.department);
      const baseDesc = `${mg.brand || ''} ${mg.model || ''}${mg.description ? ' - ' + mg.description : ''}`.trim();
      departments[dname].push({
        key: makeModelKey(mg),
        description: baseDesc,
        quantity: String(mg.requiredQuantity || 0),
        source: 'model'
      });
    });
  }

  // 2) Custom assets assigned to the event. Company is intentionally hidden on the DO.
  const groupedCustom = {};
  const addCustomToDo = (custom) => {
    if (!custom) return;
    const dname = ensureDept(custom.department || 'UN');
    const desc = custom.name || (custom.type === 'LOAN' ? 'Loan/Rental Item' : 'Misc Item');
    const key = `CUSTOM|${dname}|${custom.type}|${desc}`;
    if (!groupedCustom[key]) {
      groupedCustom[key] = {
        dept: dname,
        item: {
          key,
          description: desc,
          quantity: 0,
          source: 'custom-prepared'
        }
      };
    }
    groupedCustom[key].item.quantity += Number(custom.quantity || 1);
  };

  const preparedList = event.preparedItems || event.prepared_items || [];
  preparedList.forEach(id => addCustomToDo(parseCustomAsset(id)));

  // Fallback for any event object that only has assetsByDepartment populated.
  if (event.assetsByDepartment) {
    Object.values(event.assetsByDepartment).forEach(list => {
      (list || []).forEach(asset => {
        const custom = parseCustomAsset(asset.id, asset);
        if (custom && !preparedList.includes(asset.id)) addCustomToDo(custom);
      });
    });
  }

  Object.values(groupedCustom).forEach(({ dept, item }) => {
    if (!departments[dept]) departments[dept] = [];
    departments[dept].push({ ...item, quantity: String(item.quantity) });
  });

  // 3) Apply DO display overrides + DO-only custom additions (stored locally per event)
  const eventId = event.id || event.event_id || event.eventId || window.currentEventId || '0';
  const edits = getDoEdits(eventId, Object.keys(departments));

  Object.keys(departments).forEach(d => {
    departments[d].forEach((item) => {
      const ov = edits.overrides[item.key];
      if (ov) {
        item.description = ov.description || item.description;
        item.quantity = String(ov.quantity || item.quantity);
      }
    });
  });

  if (edits && edits.custom) {
    Object.keys(edits.custom).forEach(d => {
      if (!departments[d]) departments[d] = [];
      (edits.custom[d] || []).forEach((ci, i) => {
        departments[d].push({
          key: `DOCUSTOM|${d}|${i}`,
          description: ci.description,
          quantity: String(ci.quantity || 1),
          source: 'do-custom'
        });
      });
    });
  }

  getDoDepartmentList(departments, edits).forEach(d => {
    departments[d] ||= [];
    departments[d] = applyDoOrdering(departments[d], d, eventId);
  });

  return departments;
}

function getAssetIdsByItem(event, item, department) {
    const assetIds = [];
    if (!event.assetsByDepartment || !item || item.source !== 'model') return assetIds;

    const keyParts = String(item.key || '').split('|');
    if (keyParts.length < 4) return assetIds;

    // makeModelKey format: MG|department|brand|model
    const deptCodeFromKey = normalizeDepartmentCode(keyParts[1] || getDepartmentCodeForDoName(department));
    const brand = keyParts[2] || '';
    const model = keyParts[3] || '';

    const departmentAssets = event.assetsByDepartment[deptCodeFromKey] || [];
    departmentAssets.forEach(asset => {
        if (!asset || !asset.id) return;
        if (asset.isBulk || String(asset.id).startsWith('[BULK]') || isCustomAssetId(asset.id) || String(asset.id).startsWith('[MODEL]')) return;
        if (asset.status === 'returned') return;

        if (asset.brand === brand && asset.model === model) {
            assetIds.push(asset.id);
        }
    });

    return assetIds.sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }));
}

function exportLogs() {
  if (logs.length === 0) {
    showNotification("warning", "No logs to export");
    return;
  }

  const csvContent =
    "data:text/csv;charset=utf-8," +
    "Timestamp,User,Action\n" +
    logs
      .map((log) => `"${log.timestamp}","${log.user}","${log.action}"`)
      .join("\n");

  const encodedUri = encodeURI(csvContent);
  const link = document.createElement("a");
  link.setAttribute("href", encodedUri);
  link.setAttribute("download", "system_logs.csv");
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);

  showNotification("success", "Logs exported successfully!");
}

async function logout() {
  if (await showAppConfirm({
    title: 'Log Out',
    message: 'Are you sure you want to logout?',
    confirmText: 'Log Out',
    cancelText: 'Cancel',
    variant: 'warning',
  })) {
    window.location.href = "/logout";
  }
}

function setRealtimeStatus(state) {
  const status = document.getElementById("realtime-status");
  if (!status) return;
  status.dataset.state = state;
  const label = status.querySelector("[data-sync-label]");
  if (label) {
    label.textContent = state === "connected" ? "Live" : "Reconnecting";
  }
}

function getActiveSectionId() {
  const currentSection = document.querySelector(".content-section.active");
  return currentSection ? currentSection.id.replace("-section", "") : "";
}

async function refreshEventOverviewViews() {
  const refreshes = [];

  if (document.getElementById('dashboard-section')?.classList.contains('active')) {
    refreshes.push(loadDashboard());
  }

  if (document.getElementById('events-section')?.classList.contains('active')) {
    refreshes.push(loadAllEvents());
  }

  if (document.getElementById('prepare-section')?.classList.contains('active')) {
    refreshes.push(loadPrepareEvents());
  }

  if (document.getElementById('return-section')?.classList.contains('active')) {
    refreshes.push(loadReturnEvents());
  }

  await Promise.allSettled(refreshes);
}

function activeModal(modalId) {
  return !!document.getElementById(modalId)?.classList.contains("active");
}

async function refreshActiveModalData() {
  const modalRefreshes = [];

  if (activeModal("prepareEventModal") && window.currentPrepareEventId) {
    modalRefreshes.push(preserveModalState(() => openPrepareEventModal(window.currentPrepareEventId)));
  }

  if (activeModal("returnAssetsModalNew")) {
    const selectedEventId = document.getElementById("returnEventSelect")?.value || "";
    modalRefreshes.push((async () => {
      await openReturnAssetsModal();
      if (selectedEventId) {
        const select = document.getElementById("returnEventSelect");
        if (select) {
          select.value = selectedEventId;
          await loadEventAssetsForReturn();
        }
      }
    })());
  }

  if (
    activeModal("eventDetailsModal") &&
    window.currentEventDetailsMode === "view" &&
    window.currentViewedEventId
  ) {
    modalRefreshes.push(viewEvent(window.currentViewedEventId));
  }

  await Promise.allSettled(modalRefreshes);
}

async function refreshVisibleDataFromRealtime() {
  if (document.hidden) {
    __realtimeRefreshQueued = true;
    return;
  }

  if (__autoRefreshInFlight) {
    __realtimeRefreshQueued = true;
    return;
  }

  __autoRefreshInFlight = true;
  try {
    __containersCache = null;
    __containersCacheTs = 0;
    departmentsLoaded = false;

    await refreshActiveModalData();

    switch (getActiveSectionId()) {
      case "dashboard":
        await loadDashboard();
        break;
      case "events":
        await loadAllEvents();
        break;
      case "prepare":
        await loadPrepareEvents();
        break;
      case "return":
        await loadReturnEvents();
        break;
      case "inventory":
        await loadInventory();
        break;
      case "containers":
        await loadContainers();
        break;
      case "maintenance":
        await loadMaintenanceAssets();
        break;
      case "logs":
        await loadLogs();
        break;
      case "maintenance-report":
        await loadMaintenanceReportSection();
        break;
      case "users":
        if (typeof loadUsersAdmin === "function") await loadUsersAdmin();
        break;
      case "pdf-settings":
        if (typeof loadPdfSettingsSection === "function") await loadPdfSettingsSection();
        break;
      case "companies":
        if (typeof loadCompaniesAdmin === "function") await loadCompaniesAdmin();
        break;
    }
  } catch (error) {
    console.error("Realtime refresh error:", error);
  } finally {
    __autoRefreshInFlight = false;
    if (__realtimeRefreshQueued && !document.hidden) {
      __realtimeRefreshQueued = false;
      queueRealtimeRefresh();
    }
  }
}

function queueRealtimeRefresh() {
  clearTimeout(__realtimeRefreshTimer);
  __realtimeRefreshTimer = setTimeout(() => {
    refreshVisibleDataFromRealtime();
  }, 350);
}

function startRealtimeFallbackPolling() {
  if (__realtimeFallbackTimer) return;
  __realtimeFallbackTimer = setInterval(() => {
    refreshVisibleDataFromRealtime();
  }, 30000);
}

function stopRealtimeFallbackPolling() {
  if (!__realtimeFallbackTimer) return;
  clearInterval(__realtimeFallbackTimer);
  __realtimeFallbackTimer = null;
}

function connectRealtimeUpdates() {
  if (!window.EventSource) {
    setRealtimeStatus("reconnecting");
    startRealtimeFallbackPolling();
    return;
  }

  if (__realtimeSource) return;

  __realtimeSource = new EventSource(`/api/realtime/stream?clientId=${encodeURIComponent(REALTIME_CLIENT_ID)}`);

  __realtimeSource.addEventListener("connected", () => {
    setRealtimeStatus("connected");
    stopRealtimeFallbackPolling();
  });

  __realtimeSource.addEventListener("inventory-update", (event) => {
    try {
      const payload = JSON.parse(event.data || "{}");
      if (payload.originClientId && payload.originClientId === REALTIME_CLIENT_ID) {
        return;
      }
      queueRealtimeRefresh();
    } catch (error) {
      console.warn("Realtime update parse failed:", error);
      queueRealtimeRefresh();
    }
  });

  __realtimeSource.onerror = () => {
    setRealtimeStatus("reconnecting");
    startRealtimeFallbackPolling();
    __realtimeSource.close();
    __realtimeSource = null;
    setTimeout(connectRealtimeUpdates, 3000);
  };
}

// Close modals when clicking outside
window.addEventListener("click", function (e) {
  if (e.target.classList.contains("modal")) {
    e.target.classList.remove("active");
  }
});

// Keyboard shortcuts
document.addEventListener("keydown", function (e) {
  // Escape key closes modals
  if (e.key === "Escape") {
    document.querySelectorAll(".modal.active").forEach((modal) => {
      modal.classList.remove("active");
    });
  }

  // Ctrl+N for new event
  if (e.ctrlKey && e.key === "n") {
    e.preventDefault();
    openModal("addEventModal");
  }

  // Ctrl+Shift+N for new asset
  if (e.ctrlKey && e.shiftKey && e.key === "N") {
    e.preventDefault();
    openModal("addAssetModal");
  }
});

// Initialize application
async function initializeApp() {
  try {
    // Set today's date as default for event forms
    const today = new Date().toISOString().split("T")[0];
    
    // Check if elements exist before setting values
    const startDateEl = document.getElementById("eventStartDate");
    const endDateEl = document.getElementById("eventEndDate");

    if (startDateEl) startDateEl.value = today;
    if (endDateEl) endDateEl.value = today;

    // Also set defaults for edit form if it exists
    const editStartDateEl = document.getElementById("editEventStartDate");
    const editEndDateEl = document.getElementById("editEventEndDate");
    
    if (editStartDateEl) editStartDateEl.value = today;
    if (editEndDateEl) editEndDateEl.value = today;

    // Load configurable PDF logo/footer settings used by generated PDFs.
    await loadPdfSettings(true);

    // Load the current user and add Settings tabs.
    await setupChangePasswordTab();
    await setupAdminUserManagementTab();
    await setupPdfSettingsTab();
    await setupCompanyManagementTab();
    applyPermissionUi();
    await showCompanyBrandingPromptIfNeeded();

    // Load configurable department names/colours for badges and dropdowns.
    try {
      await loadDepartments(true);
    } catch (departmentError) {
      console.warn('Departments not loaded during startup:', departmentError);
    }

    // Add a small delay to ensure all DOM elements are ready
    setTimeout(async () => {
      // Load initial data
      await loadAllEvents();
    }, 200);

    connectRealtimeUpdates();
  } catch (error) {
    console.error("Error initializing application:", error);
    showNotification("error", "Failed to initialize application");
  }
}



// Close the currently open app modal with Escape. This only affects the UI shell;
// business actions still require their existing buttons and confirmations.
document.addEventListener('keydown', function(e) {
  if (e.key !== 'Escape') return;
  const activeModals = Array.from(document.querySelectorAll('.modal.active'));
  const topModal = activeModals[activeModals.length - 1];
  if (topModal && topModal.id && topModal.id !== 'maintenanceLogModal') {
    closeModal(topModal.id);
  }
});

// Close maintenance log modal when clicking outside
document.addEventListener('click', function(e) {
  const modal = document.getElementById('maintenanceLogModal');
  if (modal && e.target === modal) {
    closeMaintenanceLogModal();
  }
});

// Handle escape key for maintenance log modal
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') {
    const modal = document.getElementById('maintenanceLogModal');
    if (modal) {
      closeMaintenanceLogModal();
    }
  }
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && __realtimeRefreshQueued) {
    __realtimeRefreshQueued = false;
    queueRealtimeRefresh();
  }
});

document.addEventListener('DOMContentLoaded', function() {
    setupMobileNavigation();
    enhanceNavigationAccessibility();
    enhanceModalAccessibility();
    setupSingleAssetClickHandler();
    initialiseMaintenanceStatusSelects();
});

// --- Client directory helpers ---
async function fetchClients(query = '') {
  try {
    const res = await apiCall(`/api/clients${query ? `?query=${encodeURIComponent(query)}` : ''}`);
    return res.success ? res.data : [];
  } catch (e) {
    console.error('fetchClients error', e);
    return [];
  }
}

async function fetchClientByName(name) {
  try {
    const res = await apiCall(`/api/clients/${encodeURIComponent(name)}`);
    return res.success ? res.data : null;
  } catch { return null; }
}

async function saveClient(client) {
  const res = await apiCall('/api/clients', 'POST', client);
  return res.success ? res.data : null;
}

async function updateClient(name, data) {
  const res = await apiCall(`/api/clients/${encodeURIComponent(name)}`, 'PUT', data);
  return res && res.success ? res.data : null;
}

async function deleteClient(name) {
  const res = await apiCall(`/api/clients/${encodeURIComponent(name)}`, 'DELETE');
  return !!(res && res.success);
}

function fillClientFieldsFromRecord(rec) {
  if (!rec) return;
  const companyEl = document.getElementById('clientCompany');
  const a1 = document.getElementById('deliveryAddress1');
  const a2 = document.getElementById('deliveryAddress2');
  const a3 = document.getElementById('deliveryAddress3');
  const phoneEl = document.getElementById('clientPhone');
  const postalEl = document.getElementById('clientPostalCode'); // optional input if you add it to the form

  if (companyEl) companyEl.value = rec.company || '';
  if (a1) a1.value = rec.address1 || '';
  if (a2) a2.value = rec.address2 || '';
  if (a3) a3.value = rec.address3 || (rec.postalCode ? `${rec.postalCode}` : '');
  if (phoneEl) phoneEl.value = rec.phone || '';

  // If you add a dedicated postal code input:
  if (postalEl) postalEl.value = rec.postalCode || '';
}

async function setupClientAutocomplete() {
  const input = document.getElementById('clientName');
  if (!input) return;

  // Create or reuse a datalist for suggestions
  let dl = document.getElementById('clientNameList');
  if (!dl) {
    dl = document.createElement('datalist');
    dl.id = 'clientNameList';
    document.body.appendChild(dl);
  }
  input.setAttribute('list', 'clientNameList');

  // Populate suggestions
  const all = await fetchClients('');
  dl.innerHTML = all.map(c => `<option value="${c.name}">`).join('');

  // When user chooses a known name, auto-fill the rest
  input.addEventListener('change', async () => {
    const name = input.value.trim();
    if (!name) return;
    const rec = (all.find(x => x.name.toLowerCase() === name.toLowerCase())) || await fetchClientByName(name);
    if (rec) fillClientFieldsFromRecord(rec);
  });
}

function ensureKnownClientsButton() {
  const input = document.getElementById('clientName');
  if (!input || document.getElementById('btnKnownClients')) return;

  const btn = document.createElement('button');
  btn.id = 'btnKnownClients';
  btn.type = 'button';
  btn.className = 'btn btn-secondary';
  btn.style.marginLeft = '8px';
  btn.textContent = 'Known Clients';
  btn.onclick = openClientsManager;

  // Try to place next to the clientName input
  if (input.parentElement) input.parentElement.appendChild(btn);
  else input.insertAdjacentElement('afterend', btn);
}
// Client directory manager
async function openClientsManager() {
  const modal = document.createElement('div');
  modal.className = 'modal active';
  modal.innerHTML = `
    <div class="modal-content" style="max-width: 900px;">
      <div class="modal-header">
        <h3 class="modal-title">Known Clients</h3>
        <button class="close-btn" id="kcClose">&times;</button>
      </div>
      
      <div class="modal-body">
        <!-- Client Form -->
        <div style="background: #f8f9fa; padding: 20px; border-radius: 8px; margin-bottom: 25px;">
          <h4 style="margin-bottom: 15px; color: #495057;">Add/Edit Client</h4>
          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 15px; margin-bottom: 15px;">
            <div class="form-group">
              <label class="form-label">Name *</label>
              <input class="form-input" id="kcName" placeholder="Client name">
            </div>
            <div class="form-group">
              <label class="form-label">Company</label>
              <input class="form-input" id="kcCompany" placeholder="Company name">
            </div>
            <div class="form-group">
              <label class="form-label">Address Line 1</label>
              <input class="form-input" id="kcA1" placeholder="Address line 1">
            </div>
            <div class="form-group">
              <label class="form-label">Address Line 2</label>
              <input class="form-input" id="kcA2" placeholder="Address line 2">
            </div>
            <div class="form-group">
              <label class="form-label">Address Line 3</label>
              <input class="form-input" id="kcA3" placeholder="Address line 3">
            </div>
            <div class="form-group">
              <label class="form-label">Postal Code</label>
              <input class="form-input" id="kcPostal" placeholder="Postal code">
            </div>
            <div class="form-group">
              <label class="form-label">Phone</label>
              <input class="form-input" id="kcPhone" placeholder="Phone number">
            </div>
          </div>
          <div style="text-align: right;">
            <button class="btn btn-primary" id="kcSave">Save Client</button>
          </div>
        </div>

        <!-- Search & Client List -->
        <div>
          <div class="form-group">
            <label class="form-label">Search Clients</label>
            <input class="form-input" id="kcSearch" placeholder="Search by name, company, phone, or postal code...">
          </div>
          
          <div style="border: 1px solid #e9ecef; border-radius: 8px; overflow: hidden; max-height: 400px; overflow-y: auto;">
            <table class="table" style="margin: 0;">
              <thead style="background: #f8f9fa; position: sticky; top: 0; z-index: 1;">
                <tr>
                  <th style="padding: 12px; text-align: left; border-bottom: 1px solid #e9ecef;">Name</th>
                  <th style="padding: 12px; text-align: left; border-bottom: 1px solid #e9ecef;">Company</th>
                  <th style="padding: 12px; text-align: left; border-bottom: 1px solid #e9ecef;">Phone</th>
                  <th style="padding: 12px; text-align: left; border-bottom: 1px solid #e9ecef;">Postal</th>
                  <th style="padding: 12px; text-align: center; border-bottom: 1px solid #e9ecef; width: 140px;">Actions</th>
                </tr>
              </thead>
              <tbody id="kcBody">
                <tr>
                  <td colspan="5" style="padding: 40px; text-align: center; color: #666;">
                    Loading clients...
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  `;
  
  document.body.appendChild(modal);

  const close = () => modal.remove();
  modal.querySelector('#kcClose').onclick = close;
  
  // Close on backdrop click
  modal.addEventListener('click', (e) => {
    if (e.target === modal) close();
  });
  
  // Close on Escape key
  document.addEventListener('keydown', function escapeHandler(e) {
    if (e.key === 'Escape') {
      close();
      document.removeEventListener('keydown', escapeHandler);
    }
  });

  let editingName = null; // track original name when editing

  async function refreshList(query = '') {
    const list = await fetchClients(query);
    const tbody = modal.querySelector('#kcBody');
    
    if (list.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="5" style="padding: 40px; text-align: center; color: #666;">
            ${query ? 'No clients found matching your search.' : 'No clients found. Add your first client above.'}
          </td>
        </tr>
      `;
      return;
    }
    
    tbody.innerHTML = list.map(c => `
      <tr style="cursor: pointer; transition: background-color 0.2s;" data-name="${escapeHtmlAttr(c.name)}">
        <td style="padding: 12px; border-bottom: 1px solid #f1f1f1; font-weight: 500;">${escapeHtml(c.name)}</td>
        <td style="padding: 12px; border-bottom: 1px solid #f1f1f1; color: #666;">${escapeHtml(c.company || '')}</td>
        <td style="padding: 12px; border-bottom: 1px solid #f1f1f1; color: #666;">${escapeHtml(c.phone || '')}</td>
        <td style="padding: 12px; border-bottom: 1px solid #f1f1f1; color: #666;">${escapeHtml(c.postalCode || '')}</td>
        <td style="padding: 12px; border-bottom: 1px solid #f1f1f1; text-align: center;">
          <div style="display: flex; gap: 6px; justify-content: center;">
            <button class="btn btn-secondary kc-edit" data-name="${escapeHtmlAttr(c.name)}" style="padding: 4px 8px; font-size: 12px;">Edit</button>
            <button class="btn btn-danger kc-del" data-name="${escapeHtmlAttr(c.name)}" style="padding: 4px 8px; font-size: 12px;">Delete</button>
          </div>
        </td>
      </tr>
    `).join('');

    // Add hover effects to rows
    tbody.querySelectorAll('tr[data-name]').forEach(row => {
      row.addEventListener('mouseenter', () => {
        row.style.backgroundColor = '#f8f9fa';
      });
      row.addEventListener('mouseleave', () => {
        row.style.backgroundColor = '';
      });
    });

    // Row click selects client into DO form and closes
    tbody.querySelectorAll('tr[data-name]').forEach(tr => {
      tr.onclick = async (e) => {
        // Don't trigger row click if clicking on buttons
        if (e.target.closest('button')) return;
        
        const name = tr.getAttribute('data-name');
        const rec = await fetchClientByName(name);
        if (rec) {
          const input = document.getElementById('clientName');
          if (input) input.value = rec.name;
          fillClientFieldsFromRecord(rec);
          close();
        }
      };
    });

    // Edit buttons
    tbody.querySelectorAll('.kc-edit').forEach(btn => {
      btn.onclick = async (e) => {
        e.stopPropagation();
        const name = btn.getAttribute('data-name');
        const rec = await fetchClientByName(name);
        if (!rec) return;

        editingName = rec.name;
        modal.querySelector('#kcName').value = rec.name || '';
        modal.querySelector('#kcCompany').value = rec.company || '';
        modal.querySelector('#kcA1').value = rec.address1 || '';
        modal.querySelector('#kcA2').value = rec.address2 || '';
        modal.querySelector('#kcA3').value = rec.address3 || '';
        modal.querySelector('#kcPostal').value = rec.postalCode || '';
        modal.querySelector('#kcPhone').value = rec.phone || '';
        modal.querySelector('#kcName').focus();
        
        // Update button text to indicate editing
        modal.querySelector('#kcSave').textContent = 'Update Client';
      };
    });

    // Delete buttons
    tbody.querySelectorAll('.kc-del').forEach(btn => {
      btn.onclick = async (e) => {
        e.stopPropagation();
        const name = btn.getAttribute('data-name');
        const ok = await showCustomConfirm('Delete Client', `Are you sure you want to delete client "${name}"? This action cannot be undone.`);
        if (!ok) return;
        
        try {
          const done = await deleteClient(name);
          if (done) {
            showNotification('success', `Deleted client ${name}`);
            
            // If we were editing this one, clear the form
            if (editingName === name) {
              clearClientForm();
            }
            await refreshList(modal.querySelector('#kcSearch').value.trim());
          } else {
            showNotification('error', 'Delete failed. You may not have permission to delete clients.');
          }
        } catch (err) {
          showNotification('error', err?.message || 'Delete failed');
        }
      };
    });
  }

  function clearClientForm() {
    editingName = null;
    modal.querySelector('#kcName').value = '';
    modal.querySelector('#kcCompany').value = '';
    modal.querySelector('#kcA1').value = '';
    modal.querySelector('#kcA2').value = '';
    modal.querySelector('#kcA3').value = '';
    modal.querySelector('#kcPostal').value = '';
    modal.querySelector('#kcPhone').value = '';
    modal.querySelector('#kcSave').textContent = 'Save Client';
  }

  // Search input handler
  modal.querySelector('#kcSearch').addEventListener('input', (e) => {
    refreshList(e.target.value.trim());
  });

  // Save button handler
  modal.querySelector('#kcSave').onclick = async () => {
    const client = {
      name: modal.querySelector('#kcName').value.trim(),
      company: modal.querySelector('#kcCompany').value.trim(),
      address1: modal.querySelector('#kcA1').value.trim(),
      address2: modal.querySelector('#kcA2').value.trim(),
      address3: modal.querySelector('#kcA3').value.trim(),
      postalCode: modal.querySelector('#kcPostal').value.trim(),
      phone: modal.querySelector('#kcPhone').value.trim(),
    };
    
    if (!client.name) {
      showNotification('warning', 'Name is required');
      modal.querySelector('#kcName').focus();
      return;
    }

    try {
      if (editingName && editingName === client.name) {
        // Update in-place
        await updateClient(editingName, client);
        showNotification('success', `Updated client ${client.name}`);
      } else if (editingName && editingName !== client.name) {
        // Rename: create new + offer to delete old
        await saveClient(client);
        const removeOld = await showCustomConfirm(
          'Replace Client', 
          `Created new client "${client.name}". Would you like to delete the old client "${editingName}"?`
        );
        if (removeOld) {
          await deleteClient(editingName);
        }
        showNotification('success', `Saved ${client.name}`);
      } else {
        // Create new
        await saveClient(client);
        showNotification('success', `Saved ${client.name}`);
      }
      
      clearClientForm();
      await refreshList(modal.querySelector('#kcSearch').value.trim());
    } catch (e) {
      showNotification('error', e?.message || 'Save/Update failed');
    }
  };

  // Initial load
  await refreshList('');
}

// Event list view controls and transfer state
let transferReturnToOfficeCache = [];
let transferPanelMode = 'common';

function ensureEventListViewStyles() {
  if (document.getElementById('event-list-view-styles')) return;
  const style = document.createElement('style');
  style.id = 'event-list-view-styles';
  style.textContent = `
    .event-view-toolbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 10px;
      margin-bottom: 16px;
      background: #fff;
      border: 1px solid #edf0f5;
      border-radius: 12px;
      padding: 12px;
      box-shadow: 0 4px 14px rgba(0,0,0,0.04);
    }
    .event-view-toggle { display: flex; gap: 6px; flex-wrap: wrap; }
    .event-view-toggle .btn.active { background: #764ba2; color: white; }
    .event-list-table-wrap { overflow: auto; border: 1px solid #edf0f5; border-radius: 12px; background: white; }
    .event-list-table { width: 100%; border-collapse: collapse; margin: 0; }
    .event-list-table th { background: #f8f9fa; color: #495057; font-weight: 700; padding: 10px 12px; border-bottom: 1px solid #e9ecef; text-align: left; white-space: nowrap; }
    .event-list-table td { padding: 10px 12px; border-bottom: 1px solid #f1f1f1; vertical-align: top; }
    .event-list-table tr:hover { background: #f8f9fa; }
    .event-list-title { font-weight: 700; color: #333; min-width: 220px; }
    .event-progress-track { background: #e9ecef; border-radius: 999px; height: 6px; width: 120px; overflow: hidden; margin-top: 4px; }
    .event-progress-bar { background: #28a745; height: 100%; transition: width .2s ease; }
  `;
  document.head.appendChild(style);
}

function getEventSortMode(scope) {
  const idMap = {
    all: 'allEventsSortSelect',
    prepare: 'prepareEventsSortSelect',
    return: 'returnEventsSortSelect'
  };
  return document.getElementById(idMap[scope])?.value || 'startDate';
}


function sortEventsForView(list, scope = 'all') {
  const mode = getEventSortMode(scope);
  const arr = [...(list || [])];
  if (mode === 'eventId') {
    return arr.sort((a, b) => Number(b.id || 0) - Number(a.id || 0));
  }
  return sortEventsStartDateFutureTop(arr);
}

function eventDateRangeText(event) {
  return event.startDate === event.endDate
    ? formatDate(event.startDate)
    : `${formatDate(event.startDate)} - ${formatDate(event.endDate)}`;
}

function eventTagBadgeHtml(event) {
  return `<span style="padding:2px 8px;border-radius:12px;font-size:10px;font-weight:bold;${getTagStyle(event.tag || 'events')}">${getTagDisplay(event.tag || 'events')}</span>`;
}

function eventStateBadgeHtml(event) {
  return `<span class="event-state ${getEventStateClass(event.state)}">${escapeHtml(event.state || '')}</span>`;
}

function renderProgressCell(done, total) {
  const safeTotal = Math.max(Number(total || 0), 0);
  const safeDone = Math.max(Number(done || 0), 0);
  const pct = safeTotal > 0 ? Math.min(100, Math.round((safeDone / safeTotal) * 100)) : 0;
  return `
    <div style="white-space:nowrap;">${safeDone}/${safeTotal}</div>
    <div class="event-progress-track"><div class="event-progress-bar" style="width:${pct}%;"></div></div>
  `;
}

function ensureAllEventsViewTabs() {
  ensureEventListViewStyles();
  const tabs = document.querySelector('.all-events-tabs');
  const contentWrap = document.querySelector('.all-events-tab-content');
  if (!tabs || !contentWrap) return;

  const firstTab = tabs.querySelector('.all-events-tab');
  if (firstTab && firstTab.dataset.tab !== 'card') {
    firstTab.dataset.tab = 'card';
    firstTab.setAttribute('onclick', "switchAllEventsTab('card')");
    firstTab.innerHTML = '▦ Card View';
  }

  if (!tabs.querySelector('[data-tab="event-list"]')) {
    const listBtn = document.createElement('button');
    listBtn.className = 'all-events-tab';
    listBtn.dataset.tab = 'event-list';
    listBtn.setAttribute('onclick', "switchAllEventsTab('event-list')");
    listBtn.style.cssText = firstTab ? firstTab.getAttribute('style') || '' : 'flex:1;padding:15px 20px;border:none;background:none;font-size:16px;font-weight:500;cursor:pointer;border-bottom:3px solid transparent;transition:all .3s ease;';
    listBtn.innerHTML = '☰ List View';
    const calendarBtn = tabs.querySelector('[data-tab="calendar"]');
    tabs.insertBefore(listBtn, calendarBtn || null);
  }

  if (!document.getElementById('all-events-toolbar')) {
    const toolbar = document.createElement('div');
    toolbar.id = 'all-events-toolbar';
    toolbar.className = 'event-view-toolbar';
    toolbar.innerHTML = `
      <div style="color:#666;font-size:13px;">Choose how events are sorted in Card View and List View.</div>
      <label style="display:flex;align-items:center;gap:8px;color:#555;font-size:13px;">
        Sort by
        <select id="allEventsSortSelect" class="form-input" style="width:auto;min-width:160px;" onchange="loadAllEvents()">
          <option value="startDate">Start Date</option>
          <option value="eventId">Event ID</option>
        </select>
      </label>
    `;
    contentWrap.parentNode.insertBefore(toolbar, contentWrap);
  }

  if (!document.getElementById('all-events-table-view')) {
    const listView = document.createElement('div');
    listView.id = 'all-events-table-view';
    listView.className = 'all-events-content';
    listView.style.display = 'none';
    listView.innerHTML = '<div id="all-events-table-container"></div>';
    contentWrap.appendChild(listView);
  }
}

function getActiveAllEventsTab() {
  ensureAllEventsViewTabs();
  return document.querySelector('.all-events-tab.active')?.dataset.tab || 'card';
}

function filterEventsBySearch(list) {
  const eventSearch = document.getElementById('event-search');
  const searchTerm = eventSearch ? eventSearch.value.toLowerCase().trim() : '';
  if (!searchTerm) return list;
  return (list || []).filter(event => (`${event.id} ${event.name || ''} ${event.state || ''} ${event.tag || ''} ${event.startDate || ''} ${event.endDate || ''}`).toLowerCase().includes(searchTerm));
}

function renderAllEventsCards(list) {
  const container = document.getElementById('all-events');
  if (!container) return;
  const sorted = sortEventsForView(filterEventsBySearch(list || events), 'all');
  container.innerHTML = '';
  if (!sorted.length) {
    container.innerHTML = '<p style="text-align:center;color:#666;padding:40px;">No matching events found.</p>';
    return;
  }
  sorted.forEach(event => container.appendChild(createEventCard(event)));
}

function renderAllEventsTable(list) {
  const container = document.getElementById('all-events-table-container');
  if (!container) return;
  const sorted = sortEventsForView(filterEventsBySearch(list || events), 'all');
  if (!sorted.length) {
    container.innerHTML = '<p style="text-align:center;color:#666;padding:40px;">No matching events found.</p>';
    return;
  }
  const rows = sorted.map(event => `
    <tr>
      <td><strong>${escapeHtml(String(event.id))}</strong></td>
      <td>${eventTagBadgeHtml(event)}</td>
      <td class="event-list-title">${escapeHtml(event.name || '')}</td>
      <td>${escapeHtml(eventDateRangeText(event))}</td>
      <td>${eventStateBadgeHtml(event)}</td>
      <td>${Number(event.assetCount || 0)} assets assigned</td>
      <td style="white-space:nowrap;">
        <button class="btn btn-primary btn-sm" onclick="viewEvent(${event.id})">View</button>
        ${isAdminUser() ? `<button class="btn btn-warning btn-sm" onclick="editEvent(${event.id})">Edit</button> <button class="btn btn-secondary btn-sm" onclick="showForceStateModal(${event.id}, '${escapeHtmlAttr(event.state || '')}')">Force State</button> <button class="btn btn-danger btn-sm" onclick="deleteEvent(${event.id})">Delete</button>` : ''}
      </td>
    </tr>
  `).join('');
  container.innerHTML = `
    <div class="event-list-table-wrap">
      <table class="event-list-table">
        <thead><tr><th>ID</th><th>Type</th><th>Name</th><th>Date</th><th>State</th><th>Assets</th><th>Actions</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function renderAllEventsList(eventsToRender = null) {
  const active = getActiveAllEventsTab();
  if (active === 'event-list') renderAllEventsTable(eventsToRender || events);
  else renderAllEventsCards(eventsToRender || events);
}

async function loadAllEvents() {
  try {
    ensureAllEventsViewTabs();
    await loadStatsCards();
    const response = await apiCall('/api/events');
    events = response.data || [];
    updateOverdueCounter(countOverdueEvents(events));

    if (!events.length) {
      const active = getActiveAllEventsTab();
      const target = active === 'event-list' ? document.getElementById('all-events-table-container') : document.getElementById('all-events');
      if (target) target.innerHTML = '<p style="text-align:center;color:#666;padding:40px;">No events found.</p>';
      return;
    }

    renderAllEventsList(events);
  } catch (error) {
    const active = getActiveAllEventsTab();
    const target = active === 'event-list' ? document.getElementById('all-events-table-container') : document.getElementById('all-events');
    if (target) target.innerHTML = '<p style="color:red;text-align:center;">Error loading events</p>';
  }
}

function switchAllEventsTab(tabName) {
  ensureAllEventsViewTabs();
  document.querySelectorAll('.all-events-tab').forEach(tab => tab.classList.remove('active'));
  document.querySelectorAll('.all-events-content').forEach(content => {
    content.classList.remove('active');
    content.style.display = 'none';
  });

  const tab = document.querySelector(`[data-tab="${tabName}"]`);
  if (tab) tab.classList.add('active');

  const idMap = {
    card: 'all-events-list-view',
    'event-list': 'all-events-table-view',
    calendar: 'all-events-calendar-view'
  };
  const contentDiv = document.getElementById(idMap[tabName] || 'all-events-list-view');
  if (contentDiv) {
    contentDiv.classList.add('active');
    contentDiv.style.display = 'block';
  }

  loadStatsCards();
  if (tabName === 'calendar') loadCalendarView();
  else loadAllEvents();
}

function ensureEventPageToolbar(scope) {
  ensureEventListViewStyles();
  const containerId = scope === 'prepare' ? 'prepare-events' : 'return-events';
  const container = document.getElementById(containerId);
  if (!container) return;
  const toolbarId = `${scope}-events-toolbar`;
  if (document.getElementById(toolbarId)) return;

  const toolbar = document.createElement('div');
  toolbar.id = toolbarId;
  toolbar.className = 'event-view-toolbar';
  toolbar.innerHTML = `
    <div class="event-view-toggle">
      <button class="btn btn-secondary active" id="${scope}CardViewBtn" onclick="setEventPageView('${scope}', 'card')">▦ Card View</button>
      <button class="btn btn-secondary" id="${scope}ListViewBtn" onclick="setEventPageView('${scope}', 'list')">☰ List View</button>
    </div>
    <label style="display:flex;align-items:center;gap:8px;color:#555;font-size:13px;">
      Sort by
      <select id="${scope}EventsSortSelect" class="form-input" style="width:auto;min-width:160px;" onchange="${scope === 'prepare' ? 'loadPrepareEvents()' : 'loadReturnEvents()'}">
        <option value="startDate">Start Date</option>
        <option value="eventId">Event ID</option>
      </select>
    </label>
  `;
  container.parentNode.insertBefore(toolbar, container);
}

function getEventPageView(scope) {
  return localStorage.getItem(`${scope}EventsView`) || 'card';
}

function setEventPageView(scope, view) {
  localStorage.setItem(`${scope}EventsView`, view);
  if (scope === 'prepare') loadPrepareEvents();
  if (scope === 'return') loadReturnEvents();
}

function updateEventPageToolbarState(scope) {
  const view = getEventPageView(scope);
  document.getElementById(`${scope}CardViewBtn`)?.classList.toggle('active', view === 'card');
  document.getElementById(`${scope}ListViewBtn`)?.classList.toggle('active', view === 'list');
}

function renderPrepareEventsTable(list) {
  const container = document.getElementById('prepare-events');
  if (!container) return;
  container.classList.remove('events-grid');
  const sorted = sortEventsForView(list, 'prepare');
  if (!sorted.length) {
    container.innerHTML = '<p style="text-align:center;color:#666;padding:40px;">No events available for preparation.</p>';
    return;
  }
  const rows = sorted.map(event => {
    let totalRequired = 0;
    let totalAssigned = 0;
    if (event.modelGroups && Object.keys(event.modelGroups).length > 0) {
      Object.values(event.modelGroups).forEach(model => {
        totalRequired += Number(model.requiredQuantity || 0);
        totalAssigned += getPreparedQuantity(model);
      });
    } else {
      totalRequired = Number(event.assetCount || 0);
      totalAssigned = Number(event.preparedCount || 0);
    }
    return `
      <tr>
        <td><strong>${escapeHtml(String(event.id))}</strong></td>
        <td>${eventTagBadgeHtml(event)}</td>
        <td class="event-list-title">${escapeHtml(event.name || '')}</td>
        <td>${escapeHtml(eventDateRangeText(event))}</td>
        <td>${eventStateBadgeHtml(event)}</td>
        <td>${renderProgressCell(totalAssigned, totalRequired)}</td>
        <td style="white-space:nowrap;"><button class="btn btn-success btn-sm" onclick="openPrepareEventModal(${event.id})">Prepare Assets</button> <button class="btn btn-primary btn-sm" onclick="viewEvent(${event.id})">View Details</button></td>
      </tr>
    `;
  }).join('');
  container.innerHTML = `
    <div class="event-list-table-wrap">
      <table class="event-list-table">
        <thead><tr><th>ID</th><th>Type</th><th>Name</th><th>Date</th><th>State</th><th>Progress</th><th>Actions</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function renderPrepareEventsCards(list) {
  const container = document.getElementById('prepare-events');
  if (!container) return;
  container.classList.add('events-grid');
  container.innerHTML = '';
  const sorted = sortEventsForView(list, 'prepare');
  if (!sorted.length) {
    container.innerHTML = '<p style="text-align:center;color:#666;padding:40px;">No events available for preparation.</p>';
    return;
  }
  sorted.forEach(event => container.appendChild(createPrepareEventCard(event)));
}

async function loadPrepareEvents() {
  try {
    ensureEventPageToolbar('prepare');
    updateEventPageToolbarState('prepare');
    const response = await apiCall('/api/events');
    updateOverdueCounter(countOverdueEvents(response.data || []));
    const preparableEvents = (response.data || []).filter(event => event.state !== 'Closed' && event.state !== 'Overdue' && event.assetCount >= 0);
    if (getEventPageView('prepare') === 'list') renderPrepareEventsTable(preparableEvents);
    else renderPrepareEventsCards(preparableEvents);
  } catch (error) {
    const container = document.getElementById('prepare-events');
    if (container) container.innerHTML = '<p style="color:red;text-align:center;">Error loading events</p>';
  }
}

function renderReturnEventsTable(list) {
  const container = document.getElementById('return-events');
  if (!container) return;
  container.classList.remove('events-grid');
  const sorted = sortEventsForView(list, 'return');
  if (!sorted.length) {
    container.innerHTML = '<p style="text-align:center;color:#666;padding:40px;">No events with assets to return.</p>';
    return;
  }
  const rows = sorted.map(event => {
    const returnedCount = Number(event.returnedCount || 0);
    const totalCount = Math.max(getEventReturnTotalCount(event), returnedCount + getEventReturnableCount(event));
    return `
      <tr>
        <td><strong>${escapeHtml(String(event.id))}</strong></td>
        <td>${eventTagBadgeHtml(event)}</td>
        <td class="event-list-title">${escapeHtml(event.name || '')}</td>
        <td>${escapeHtml(eventDateRangeText(event))}</td>
        <td>${eventStateBadgeHtml(event)}</td>
        <td>${renderProgressCell(returnedCount, totalCount)}</td>
        <td style="white-space:nowrap;"><button class="btn btn-primary btn-sm" onclick="viewEvent(${event.id})">View Assets</button> <button class="btn btn-warning btn-sm" onclick="openReturnAssetsModalWithEvent(${event.id})">Return</button></td>
      </tr>
    `;
  }).join('');
  container.innerHTML = `
    <div class="event-list-table-wrap">
      <table class="event-list-table">
        <thead><tr><th>ID</th><th>Type</th><th>Name</th><th>Date</th><th>State</th><th>Returned</th><th>Actions</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function renderReturnEventsCards(list) {
  const container = document.getElementById('return-events');
  if (!container) return;
  container.classList.add('events-grid');
  container.innerHTML = '';
  const sorted = sortEventsForView(list, 'return');
  if (!sorted.length) {
    container.innerHTML = '<p style="text-align:center;color:#666;padding:40px;">No events with assets to return.</p>';
    return;
  }
  sorted.forEach(event => container.appendChild(createReturnEventCard(event)));
}

async function loadReturnEvents() {
  try {
    ensureEventPageToolbar('return');
    updateEventPageToolbarState('return');
    const response = await apiCall('/api/events');
    updateOverdueCounter(countOverdueEvents(response.data || []));
    const returnableEvents = (response.data || []).filter(event => getEventReturnableCount(event) > 0 && event.state !== 'Closed');
    if (getEventPageView('return') === 'list') renderReturnEventsTable(returnableEvents);
    else renderReturnEventsCards(returnableEvents);
  } catch (error) {
    const container = document.getElementById('return-events');
    if (container) container.innerHTML = '<p style="color:red;text-align:center;">Error loading events</p>';
  }
}

window.__preparePendingActions = window.__preparePendingActions || {};
let __prepareUiSyncTimer = null;

function prepareButtonsForAsset(assetId, includeSource = false) {
  const encodedAssetId = encodeURIComponent(String(assetId || ''));
  const root = document.getElementById('prepareEventContent') || document;
  return Array.from(root.querySelectorAll('[data-asset-id], [data-prepare-source-id]')).filter(button => (
    button.dataset.assetId === encodedAssetId ||
    (includeSource && button.dataset.prepareSourceId === encodedAssetId)
  ));
}

function beginPrepareAssetAction(assetId, label = 'Working...') {
  const key = String(assetId || '');
  if (!key || window.__preparePendingActions[key]) return false;
  window.__preparePendingActions[key] = true;
  prepareButtonsForAsset(key, true).forEach(button => {
    button.disabled = true;
    button.style.opacity = '0.65';
    button.dataset.preparePreviousText = button.textContent;
    button.textContent = label;
  });
  return true;
}

function endPrepareAssetAction(assetId) {
  delete window.__preparePendingActions[String(assetId || '')];
}

function updatePrepareRowStatus(button, assetId, isPrepared) {
  let assetRow = button.parentElement;
  while (assetRow && !assetRow.querySelector('div[style*="margin-top: 2px"], div[style*="margin-top:2px"]')) {
    assetRow = assetRow.parentElement;
  }
  if (!assetRow) return;

  const statusText = assetRow.querySelector('div[style*="margin-top: 2px"], div[style*="margin-top:2px"]');
  if (statusText) {
    statusText.textContent = isPrepared ? 'Prepared' : 'Pending';
    statusText.style.color = isPrepared ? '#28a745' : '#ffc107';
  }

  const assetNameSpan = assetRow.querySelector('span');
  if (assetNameSpan && assetNameSpan.textContent.includes(assetId)) {
    assetNameSpan.dataset.prepareState = isPrepared ? 'prepared' : 'pending';
  }
}

function updateAllButtonsForAsset(assetId, isPrepared, options = {}) {
  const sourceAssetId = String(options.sourceAssetId || assetId || '');
  const effectiveAssetId = String(assetId || sourceAssetId);
  const buttons = prepareButtonsForAsset(effectiveAssetId, true)
    .concat(sourceAssetId === effectiveAssetId ? [] : prepareButtonsForAsset(sourceAssetId, true))
    .filter((button, index, all) => all.indexOf(button) === index);

  buttons.forEach(button => {
    button.disabled = false;
    button.style.opacity = '1';
    delete button.dataset.preparePreviousText;

    if (isPrepared) {
      button.textContent = 'Unprepare';
      button.classList.remove('btn-success', 'btn-secondary');
      button.classList.add('btn-warning', 'asset-action-btn');
      button.dataset.assetId = encodeURIComponent(effectiveAssetId);
      button.dataset.action = 'unprepare';
      button.removeAttribute('onclick');
      button.onclick = null;
    } else {
      button.textContent = 'Prepare';
      button.classList.remove('btn-warning', 'btn-secondary');
      button.classList.add('btn-success');

      const assignSourceId = button.dataset.prepareSourceId
        ? decodeURIComponent(button.dataset.prepareSourceId)
        : '';
      if (assignSourceId) {
        const buttonEventId = Number(button.dataset.eventId || window.currentPrepareEventId);
        const brand = button.dataset.prepareBrand || '';
        const model = button.dataset.prepareModel || '';
        button.classList.remove('asset-action-btn');
        delete button.dataset.action;
        button.removeAttribute('onclick');
        button.onclick = () => assignSpecificAsset(buttonEventId, assignSourceId, brand, model);
      } else {
        button.classList.add('asset-action-btn');
        button.dataset.assetId = encodeURIComponent(effectiveAssetId);
        button.dataset.action = 'prepare';
        button.removeAttribute('onclick');
        button.onclick = null;
      }
    }

    updatePrepareRowStatus(button, effectiveAssetId, isPrepared);
  });
}

function prepareModelProgress(group) {
  const required = Math.max(0, Number(group?.requiredQuantity || 0));
  const prepared = Math.max(0, Number(
    group?.countablePreparedQuantity ??
    getCountablePreparedQuantity(group || {})
  ));
  return { required, prepared };
}

function applyPrepareCanonicalProgress(event) {
  if (!event || Number(event.id) !== Number(window.currentPrepareEventId)) return;
  window.__currentPrepareEventData = event;
  const root = document.getElementById('prepareEventContent') || document;

  const requiredEl = document.getElementById('prepare-required-count');
  const preparedEl = document.getElementById('prepare-prepared-count');
  const extraEl = document.getElementById('prepare-extra-count');
  if (requiredEl) requiredEl.textContent = String(event.totalAssets ?? 0);
  if (preparedEl) preparedEl.textContent = String(event.totalPrepared ?? 0);
  if (extraEl) extraEl.textContent = String(getEventExtraQuantity(event));

  const modelGroups = Object.values(event.modelGroups || {});
  root.querySelectorAll('[data-prepare-model-key]').forEach(section => {
    const group = modelGroups.find(item => (
      `${item.department || ''}|${item.brand || ''}|${item.model || ''}` === section.dataset.prepareModelKey
    ));
    if (!group) return;
    const { required, prepared } = prepareModelProgress(group);
    const color = prepared >= required && required > 0 ? '#28a745' : '#ffc107';
    const text = section.querySelector('.prepare-model-progress-text');
    const bar = section.querySelector('.prepare-model-progress-bar');
    if (text) {
      text.textContent = `${prepared}/${required} prepared`;
      text.style.color = color;
    }
    if (bar) {
      bar.style.width = `${required > 0 ? Math.min(100, Math.round((prepared / required) * 100)) : 0}%`;
      bar.style.background = color;
    }
  });

  const customByDepartment = groupCustomAssetsByDepartment(event);
  root.querySelectorAll('[data-prepare-department]').forEach(section => {
    const department = section.dataset.prepareDepartment || '';
    const modelTotals = modelGroups
      .filter(group => normalizeDepartmentCode(group.department || 'UN') === department)
      .reduce((totals, group) => {
        const progress = prepareModelProgress(group);
        totals.required += progress.required;
        totals.prepared += progress.prepared;
        return totals;
      }, { required: 0, prepared: 0 });
    const customAssets = customByDepartment[department] || [];
    const required = modelTotals.required + getCustomRequiredQuantityForProgress(customAssets);
    const prepared = modelTotals.prepared + getCustomPreparedQuantityForProgress(customAssets);
    const color = prepared >= required && required > 0 ? '#28a745' : '#ffc107';
    const text = section.querySelector('.prepare-dept-progress-text');
    const bar = section.querySelector('.prepare-dept-progress-bar');
    if (text) {
      text.textContent = `${prepared}/${required} prepared`;
      text.style.color = color;
    }
    if (bar) {
      bar.style.width = `${required > 0 ? Math.min(100, Math.round((prepared / required) * 100)) : 0}%`;
      bar.style.background = color;
    }
  });
}

function schedulePrepareUiSync(eventId, delay = 600) {
  clearTimeout(__prepareUiSyncTimer);
  __prepareUiSyncTimer = setTimeout(async () => {
    try {
      const response = await apiCall(`/api/events/${eventId}`);
      applyPrepareCanonicalProgress(response.data || {});
      if (document.getElementById('prepare-section')?.classList.contains('active')) {
        await loadPrepareEvents();
      }
    } catch (error) {
      console.warn('Quiet prepare UI sync failed:', error);
    }
  }, delay);
}

async function prepareSpecificAsset(eventId, assetId) {
  let actionStarted = false;
  try {
    await ensureAssetsLoaded();
    if (!(await confirmDegradedAssetUse(assetId))) {
      updateAllButtonsForAsset(assetId, false);
      return;
    }
    actionStarted = beginPrepareAssetAction(assetId, 'Preparing...');
    if (!actionStarted) return;
    const response = await apiCall(`/api/events/${eventId}/prepare`, 'POST', { assetId });
    await showApiWarning(response);
    const preparedAssetId = response?.data?.assetId || assetId;
    showNotification('success', `${customAssetLabelFromId(preparedAssetId)} marked as prepared`);
    updateAllButtonsForAsset(preparedAssetId, true, { sourceAssetId: assetId });
    schedulePrepareUiSync(eventId);
  } catch (error) {
    console.error('Error in prepareSpecificAsset:', error);
    showNotification('error', `Failed to prepare asset: ${error.message}`);
    updateAllButtonsForAsset(assetId, false);
  } finally {
    if (actionStarted) endPrepareAssetAction(assetId);
  }
}

async function unprepareSpecificAsset(eventId, assetId) {
  if (!beginPrepareAssetAction(assetId, 'Unpreparing...')) return;
  try {
    await apiCall(`/api/events/${eventId}/unprepare`, 'POST', { assetId });
    showNotification('success', `${customAssetLabelFromId(assetId)} unprepared`);
    updateAllButtonsForAsset(assetId, false);
    schedulePrepareUiSync(eventId);
  } catch (error) {
    console.error('Error in unprepareSpecificAsset:', error);
    showNotification('error', `Failed to unprepare asset: ${error.message}`);
    updateAllButtonsForAsset(assetId, true);
  } finally {
    endPrepareAssetAction(assetId);
  }
}

async function processUniversalContainer(eventId, containerId) {
  const feedbackDiv = document.getElementById('universal-asset-feedback');
  const input = document.getElementById('universalAssetInput');
  const quickAddEnabled = getPrepareQuickAddEnabled();
  const container = await getContainerById(containerId, true);
  if (!container) {
    if (feedbackDiv) showFeedback(feedbackDiv, 'error', `Container ${containerId} not found`);
    return;
  }

  const containerLabel = container.id || containerId;
  const assetIds = (container.assetIds || []).map(a => String(a || '').trim()).filter(Boolean);
  if (!assetIds.length) {
    if (feedbackDiv) showFeedback(feedbackDiv, 'warning', `Container ${containerLabel} has no assets`);
    return;
  }

  if (feedbackDiv) {
    showFeedback(
      feedbackDiv,
      'info',
      `Processing container <strong>${escapeHtml(containerLabel)}</strong> (${assetIds.length} assets)…<br>` +
      (quickAddEnabled
        ? `Scanned container assets will be added into this event.`
        : `Extra container assets will remain listed as extra assets.`)
    );
  }

  let event;
  try {
    const eventRes = await apiCall(`/api/events/${eventId}`);
    event = eventRes.data || {};
  } catch (e) {
    if (feedbackDiv) showFeedback(feedbackDiv, 'error', `Failed to load event: ${escapeHtml(e.message || String(e))}`);
    return;
  }

  const preparedSet = new Set(event.actuallyPrepared || []);
  const returnedSet = new Set(event.returnedItems || []);
  const results = { prepared: [], addedToEvent: [], extra: [], skippedPrepared: [], skippedReturned: [], failed: [] };

  window.__processingContainerBatch = true;
  try {
    for (const aid of assetIds) {
      if (returnedSet.has(aid)) { results.skippedReturned.push(aid); continue; }
      if (preparedSet.has(aid)) { results.skippedPrepared.push(aid); continue; }
      try {
        await apiCall(`/api/events/${eventId}/assign-specific`, 'POST', {
          quickAdd: quickAddEnabled,
          addScannedAssetsToEvent: quickAddEnabled,
          assetId: aid,
          fromContainer: true,
          source: quickAddEnabled ? 'quick-add-container' : 'container'
        }).then((response) => {
          updateAllButtonsForAsset(response?.data?.assetId || aid, true, { sourceAssetId: aid });
          if (response?.data?.isExtra) {
            results.extra.push(aid);
          } else {
            results.addedToEvent.push(aid);
          }
        });
        results.prepared.push(aid);
        preparedSet.add(aid);
      } catch (err) {
        results.failed.push({ id: aid, error: err?.message || String(err) });
      }
    }
  } finally {
    window.__processingContainerBatch = false;
    if (input) { input.value = ''; input.focus(); }
  }

  const total = assetIds.length;
  const failed = results.failed.length;
  const listToHtml = (title, arr) => arr && arr.length ? `<div style="margin-top:10px;"><div style="font-weight:700;">${escapeHtml(title)}</div><ul style="margin:6px 0 0 18px;">${arr.slice(0, 50).map(x => `<li>${escapeHtml(String(x))}</li>`).join('')}</ul>${arr.length > 50 ? `<div style="color:#666;font-size:12px;">…and ${arr.length - 50} more</div>` : ''}</div>` : '';
  const failuresToHtml = (arr) => arr && arr.length ? `<div style="margin-top:10px;"><div style="font-weight:700;color:#a00;">Failures</div>${arr.slice(0, 30).map(f => `<div style="font-size:12px;color:#a00;">${escapeHtml(f.id)} — ${escapeHtml(f.error)}</div>`).join('')}${arr.length > 30 ? `<div style="color:#666;font-size:12px;">…and ${arr.length - 30} more failures</div>` : ''}</div>` : '';

  const detailsHtml = `
    <div style="margin-top:6px;">
      <div><strong>Summary</strong> (Container ${escapeHtml(containerLabel)}):</div>
      <div>✅ Prepared / added to event: <strong>${results.prepared.length}</strong> / ${total}</div>
      <div>➕ Added into event requirements: <strong>${results.addedToEvent.length}</strong></div>
      <div>Extra assets: <strong>${results.extra.length}</strong></div>
      <div>ℹ️ Already prepared: <strong>${results.skippedPrepared.length}</strong></div>
      <div>↩️ Returned in this event: <strong>${results.skippedReturned.length}</strong></div>
      <div style="${failed ? 'color:#a00;' : ''}">⚠️ Failed: <strong>${failed}</strong></div>
    </div>
    <details style="margin-top:10px;"><summary style="cursor:pointer;">Show details</summary>
      ${listToHtml('Prepared / added', results.prepared)}
      ${listToHtml('Added into event requirements', results.addedToEvent)}
      ${listToHtml('Extra assets', results.extra)}
      ${listToHtml('Skipped (already prepared)', results.skippedPrepared)}
      ${listToHtml('Skipped (returned)', results.skippedReturned)}
      ${failuresToHtml(results.failed)}
    </details>
  `;

  if (feedbackDiv) showFeedback(feedbackDiv, failed ? 'warning' : 'success', detailsHtml);
  schedulePrepareUiSync(eventId, 350);
}






(function initialisePatchedEventViews() {
  document.addEventListener('DOMContentLoaded', () => {
    ensureAllEventsViewTabs();
    const eventSearch = document.getElementById('event-search');
    if (eventSearch) eventSearch.oninput = () => renderAllEventsList(events);
  });
})();

// Inventory sorting and export helpers
function getInventorySortValue(asset, sortBy) {
  if (!asset) return '';
  if (sortBy === 'id') return asset.isBulk ? (asset.internalId || asset.bulkId || `${asset.brand || ''} ${asset.model || ''} ${asset.description || ''}`) : (asset.id || asset.internalId || '');
  if (sortBy === 'serial') return asset.isBulk ? '' : (asset.serial || '');
  if (sortBy === 'department') return asset.department || '';
  if (sortBy === 'status') return asset.status || '';
  if (sortBy === 'location') return asset.location || '';
  if (sortBy === 'dateOfPurchase' || sortBy === 'purchaseDate') return normalizeAssetPurchaseDateValue(asset.dateOfPurchase || asset.purchaseDate || '');
  if (sortBy === 'dateAdded') return normalizeAssetAuditDateTime(asset.dateAdded || '');
  if (sortBy === 'dateModified') return normalizeAssetAuditDateTime(asset.dateModified || '');
  return asset[sortBy] || '';
}

function getInventoryFilterState() {
  const searchTerm = document.getElementById('asset-search')?.value.toLowerCase() || '';
  const departmentSelection = getInventoryCheckboxFilterValues('department-filter');
  const statusSelection = getInventoryCheckboxFilterValues('status-filter');

  return {
    searchTerm,
    searchLabel: document.getElementById('asset-search')?.value.trim() || '',
    deptFilters: departmentSelection.values,
    departmentFilterTotal: departmentSelection.total,
    statusFilters: statusSelection.values,
    statusFilterTotal: statusSelection.total,
    sortBy: document.getElementById('sort-select')?.value || 'id',
    sortDesc: document.getElementById('sort-descending')?.checked || false
  };
}

function getFilteredInventoryData() {
  const filters = getInventoryFilterState();
  const sourceAssets = Array.isArray(assets) ? assets : [];

  let filteredAssets = sourceAssets.filter((asset) => {
    const deptMeta = getDepartmentMeta(asset.department);
    const searchableText = `${asset.id || ''} ${asset.internalId || ''} ${asset.bulkId || ''} ${asset.brand || ''} ${asset.model || ''} ${asset.serial || ''} ${asset.description || ''} ${asset.dateOfPurchase || asset.purchaseDate || ''} ${asset.dateAdded || ''} ${asset.dateModified || ''} ${asset.department || ''} ${deptMeta.name || ''}`.toLowerCase();
    const matchesSearch = !filters.searchTerm || searchableText.includes(filters.searchTerm);
    const matchesDept = filters.departmentFilterTotal === 0 || filters.deptFilters.includes(asset.department);
    const matchesStatus = filters.statusFilterTotal === 0 || filters.statusFilters.includes(asset.status);
    return matchesSearch && matchesDept && matchesStatus;
  });

  filteredAssets.sort((a, b) => {
    let aVal = String(getInventorySortValue(a, filters.sortBy) ?? '').toLowerCase();
    let bVal = String(getInventorySortValue(b, filters.sortBy) ?? '').toLowerCase();
    const primary = aVal.localeCompare(bVal, undefined, { numeric: true, sensitivity: 'base' });
    if (primary !== 0) return filters.sortDesc ? -primary : primary;
    const fallbackA = `${a.brand || ''} ${a.model || ''} ${a.description || ''} ${a.internalId || a.id || ''}`.toLowerCase();
    const fallbackB = `${b.brand || ''} ${b.model || ''} ${b.description || ''} ${b.internalId || b.id || ''}`.toLowerCase();
    const secondary = fallbackA.localeCompare(fallbackB, undefined, { numeric: true, sensitivity: 'base' });
    return filters.sortDesc ? -secondary : secondary;
  });

  return {
    filters,
    filteredAssets,
    totalAssets: sourceAssets.length
  };
}

function displayFilteredInventory() {
  const { filteredAssets, totalAssets } = getFilteredInventoryData();
  const countElement = document.getElementById('asset-count');
  if (countElement) countElement.textContent = `${filteredAssets.length} of ${totalAssets} assets`;
  displayInventoryTable(filteredAssets);
}

function inventoryExportDateStamp() {
  const now = new Date();
  const pad = value => String(value).padStart(2, '0');

  return {
    displayDate: now.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }),
    reportNumber: `INV-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
  };
}

function inventoryPlainText(value, fallback = '-') {
  const text = String(value ?? '').trim();
  return text || fallback;
}

function inventoryStatusText(status) {
  const cleanStatus = inventoryPlainText(status, 'available').toLowerCase();
  if (cleanStatus === 'disposed') return 'Decommissioned';
  if (cleanStatus === 'ooc') return 'OOC';
  return cleanStatus
    .replace(/-/g, ' ')
    .replace(/\b\w/g, char => char.toUpperCase());
}

function inventoryStatusPdfMeta(status) {
  const cleanStatus = inventoryPlainText(status, 'available').toLowerCase();
  const palette = {
    available: { background: '#dcfce7', color: '#14532d' },
    deployed: { background: '#fef3c7', color: '#78350f' },
    degraded: { background: '#fef3c7', color: '#78350f' },
    missing: { background: '#fee2e2', color: '#7f1d1d' },
    ooc: { background: '#fee2e2', color: '#7f1d1d' },
    decommissioned: { background: '#e5e7eb', color: '#374151' },
    disposed: { background: '#e5e7eb', color: '#374151' }
  };
  return {
    label: inventoryStatusText(cleanStatus),
    ...(palette[cleanStatus] || palette.available)
  };
}

function inventoryStatusPdfBadgeHtml(status, label = null) {
  const meta = inventoryStatusPdfMeta(status);
  return pdfInlineBadgeHtml(label || meta.label, meta.background, meta.color, { style: 'margin:0 3px 3px 0;' });
}

function inventoryDepartmentLabel(code) {
  const dept = getDepartmentMeta(code);
  const deptCode = normalizeDepartmentCode(dept.code || code || 'UN');
  return dept.name && dept.name !== deptCode ? `${deptCode} - ${dept.name}` : deptCode;
}

function inventoryDepartmentPdfBadgeHtml(code) {
  const dept = getDepartmentMeta(code);
  const bg = safePdfHexColour(dept.color, '#e2e3e5');
  const fg = safePdfHexColour(dept.textColor, getReadableTextColour(bg));
  return pdfInlineBadgeHtml(inventoryDepartmentLabel(dept.code || code || 'UN'), bg, fg, {
    title: dept.name || dept.code,
    style: 'margin:0 3px 3px 0;'
  });
}

function inventoryExportQuantity(asset, statusFilter = '') {
  if (!asset) return 0;
  const total = Math.max(1, Number(asset.quantity || 1) || 1);
  if (!asset.isBulk) return 1;

  const available = Math.max(0, Number(asset.availableQuantity ?? total) || 0);
  if (statusFilter === 'available') return available;
  if (statusFilter === 'deployed') return Math.max(0, total - available);
  return total;
}

function inventoryAssetFlagsText(asset) {
  const flags = [];
  if (asset?.isMissing) flags.push('Missing');
  if (asset?.isOOC) flags.push('OOC');
  if (asset?.isDegraded) flags.push('Degraded');
  if (asset?.isBulk) {
    const oocQty = Math.max(0, Number(asset.bulkOOCQuantity || 0) || 0);
    const missingQty = Math.max(0, Number(asset.bulkMissingQuantity || 0) || 0);
    const degradedQty = Math.max(0, Number(asset.bulkDegradedQuantity || 0) || 0);
    if (!asset?.isOOC && oocQty > 0) flags.push(`${oocQty} OOC`);
    if (!asset?.isMissing && missingQty > 0) flags.push(`${missingQty} Missing`);
    if (!asset?.isDegraded && degradedQty > 0) flags.push(`${degradedQty} Degraded`);
  }
  if (asset?.isDisposed || asset?.isDecommissioned) flags.push('Decommissioned');
  return flags.length ? flags.join(', ') : 'OK';
}

function inventoryAssetFlagsPdfHtml(asset) {
  const status = getAssetConditionStatus(asset);
  const label = status === 'available' ? 'OK' : inventoryStatusText(status);
  return inventoryStatusPdfBadgeHtml(status, label);
}

function inventoryAssetQuantityText(asset) {
  if (!asset?.isBulk) return '1';
  const total = Math.max(1, Number(asset.quantity || 1) || 1);
  const available = Math.max(0, Number(asset.availableQuantity ?? total) || 0);
  return `${available}/${total}`;
}

function inventoryFilterSummary(filters, rowCount, totalAssets, showIndividual) {
  const parts = [];
  if (filters.searchLabel) parts.push(`Search: ${filters.searchLabel}`);
  if (filters.departmentFilterTotal > 0 && filters.deptFilters.length < filters.departmentFilterTotal) {
    const departmentsText = filters.deptFilters.length
      ? filters.deptFilters.map(inventoryDepartmentLabel).join(', ')
      : 'None selected';
    parts.push(`Departments: ${departmentsText}`);
  }
  if (filters.statusFilterTotal > 0 && filters.statusFilters.length < filters.statusFilterTotal) {
    const statusesText = filters.statusFilters.length
      ? filters.statusFilters.map(inventoryStatusText).join(', ')
      : 'None selected';
    parts.push(`Statuses: ${statusesText}`);
  }
  if (parts.length === 0) parts.push('Filters: All inventory assets');

  const sortLabelMap = {
    id: 'Asset ID',
    brand: 'Brand',
    model: 'Model',
    department: 'Department',
    status: 'Status',
    location: 'Location'
  };
  parts.push(`Sort: ${sortLabelMap[filters.sortBy] || filters.sortBy}${filters.sortDesc ? ' descending' : ' ascending'}`);
  parts.push(`Rows: ${rowCount} of ${totalAssets}`);
  parts.push(`Layout: ${showIndividual ? 'Individual assets' : 'Grouped asset counts'}`);
  return parts;
}

function groupInventoryAssetsForExport(filteredAssets, filters) {
  const groups = new Map();

  filteredAssets.forEach(asset => {
    const department = normalizeDepartmentCode(asset.department || 'UN');
    const brand = inventoryPlainText(asset.brand, 'Unbranded');
    const model = inventoryPlainText(asset.model, 'Unspecified model');
    const key = JSON.stringify([department, brand, model]);
    const statusFilter = filters.statusFilters.length === 1 ? filters.statusFilters[0] : '';
    const quantity = inventoryExportQuantity(asset, statusFilter);

    if (!groups.has(key)) {
      groups.set(key, {
        department,
        departmentLabel: inventoryDepartmentLabel(department),
        brand,
        model,
        descriptions: new Set(),
        count: 0,
        statusCounts: {}
      });
    }

    const group = groups.get(key);
    if (asset.description) group.descriptions.add(asset.description);
    group.count += quantity;
    const status = asset.status || 'available';
    group.statusCounts[status] = (group.statusCounts[status] || 0) + quantity;
  });

  return Array.from(groups.values()).sort((a, b) => {
    const aKey = `${a.departmentLabel} ${a.brand} ${a.model}`.toLowerCase();
    const bKey = `${b.departmentLabel} ${b.brand} ${b.model}`.toLowerCase();
    return aKey.localeCompare(bKey, undefined, { numeric: true, sensitivity: 'base' });
  });
}

function inventoryStatusSummaryText(statusCounts) {
  return Object.entries(statusCounts || {})
    .sort(([a], [b]) => inventoryStatusText(a).localeCompare(inventoryStatusText(b)))
    .map(([status, count]) => `${inventoryStatusText(status)}: ${count}`)
    .join(', ');
}

function inventoryStatusSummaryPdfHtml(statusCounts) {
  const entries = Object.entries(statusCounts || {})
    .sort(([a], [b]) => inventoryStatusText(a).localeCompare(inventoryStatusText(b)));
  return entries.length
    ? entries.map(([status, count]) => inventoryStatusPdfBadgeHtml(status, `${inventoryStatusText(status)}: ${count}`)).join('')
    : '-';
}

function inventoryGroupedRowRecords(filteredAssets, filters) {
  const groups = groupInventoryAssetsForExport(filteredAssets, filters);
  if (groups.length === 0) {
    return [{ html: '<tr><td colspan="6" class="empty-row">No assets match the selected filters.</td></tr>', height: 0 }];
  }

  return groups.map(group => {
    const descriptionText = Array.from(group.descriptions).sort((a, b) => a.localeCompare(b)).join('; ');
    return {
      html: `
      <tr>
        <td>${inventoryDepartmentPdfBadgeHtml(group.department)}</td>
        <td>${escapeHtml(group.brand)}</td>
        <td>${escapeHtml(group.model)}</td>
        <td>${escapeHtml(descriptionText || '-')}</td>
        <td class="number-cell">${escapeHtml(String(group.count))}</td>
        <td>${inventoryStatusSummaryPdfHtml(group.statusCounts)}</td>
      </tr>
      `,
      height: 0
    };
  });
}

function inventoryGroupedRowsHtml(filteredAssets, filters) {
  return inventoryGroupedRowRecords(filteredAssets, filters).map(record => record.html).join('');
}

function inventoryIndividualRowRecords(filteredAssets) {
  if (filteredAssets.length === 0) {
    return [{ html: '<tr><td colspan="11" class="empty-row">No assets match the selected filters.</td></tr>', height: 0 }];
  }

  return filteredAssets.map(asset => {
    const assetId = asset.isBulk
      ? inventoryPlainText(asset.internalId || asset.bulkId, 'Bulk Item')
      : inventoryPlainText(asset.id || asset.internalId);
    const currentLocation = inventoryPlainText(asset.currentLocation || asset.location || asset.defaultLocation || 'Store');
    const defaultLocation = inventoryPlainText(asset.defaultLocation || 'Store');

    return {
      html: `
      <tr>
        <td><strong>${escapeHtml(assetId)}</strong></td>
        <td>${escapeHtml(inventoryPlainText(asset.brand))}</td>
        <td>${escapeHtml(inventoryPlainText(asset.model))}</td>
        <td>${escapeHtml(inventoryPlainText(asset.description))}</td>
        <td>${escapeHtml(asset.isBulk ? '-' : inventoryPlainText(asset.serial, 'N/A'))}</td>
        <td class="number-cell">${escapeHtml(inventoryAssetQuantityText(asset))}</td>
        <td>${inventoryDepartmentPdfBadgeHtml(asset.department)}</td>
        <td>${inventoryStatusPdfBadgeHtml(asset.status || 'available')}</td>
        <td>${escapeHtml(defaultLocation)}</td>
        <td>${escapeHtml(currentLocation)}</td>
        <td>${inventoryAssetFlagsPdfHtml(asset)}</td>
      </tr>
      `,
      height: 0
    };
  });
}

function inventoryIndividualRowsHtml(filteredAssets) {
  return inventoryIndividualRowRecords(filteredAssets).map(record => record.html).join('');
}

function inventoryPdfPageConfig(showIndividual) {
  return showIndividual
    ? {
        orientation: 'landscape',
        widthMm: 297,
        heightMm: 210,
        measureWidthMm: 283,
        pageFlowHeightMm: 189,
        minFooterReserveMm: 6,
        pagePaddingTopMm: 7,
        footerBottomMm: 7,
        footerGapMm: 2,
        bodyFontSize: '7.2pt',
        tableFontSize: '6.8pt',
        tablePadding: '4px'
      }
    : {
        orientation: 'portrait',
        widthMm: 210,
        heightMm: 297,
        measureWidthMm: 196,
        pageFlowHeightMm: 276,
        minFooterReserveMm: 6,
        pagePaddingTopMm: 7,
        footerBottomMm: 7,
        footerGapMm: 2,
        bodyFontSize: '8.4pt',
        tableFontSize: '8pt',
        tablePadding: '5px'
      };
}

function inventoryPdfColGroup(showIndividual) {
  if (showIndividual) {
    return `
      <col style="width:9%;">
      <col style="width:9%;">
      <col style="width:10%;">
      <col style="width:20%;">
      <col style="width:9%;">
      <col style="width:4%;">
      <col style="width:10%;">
      <col style="width:7%;">
      <col style="width:8%;">
      <col style="width:8%;">
      <col style="width:6%;">
    `;
  }

  return `
    <col style="width:16%;">
    <col style="width:17%;">
    <col style="width:17%;">
    <col style="width:26%;">
    <col style="width:7%;">
    <col style="width:17%;">
  `;
}

function inventoryPdfTableHead(showIndividual) {
  if (showIndividual) {
    return `
      ${inventoryPdfColGroup(true)}
      <thead>
        <tr>
          <th>Asset ID</th>
          <th>Brand</th>
          <th>Model</th>
          <th>Description</th>
          <th>Serial</th>
          <th>Qty</th>
          <th>Department</th>
          <th>Status</th>
          <th>Default Location</th>
          <th>Current Location</th>
          <th>Flags</th>
        </tr>
      </thead>
    `;
  }

  return `
    ${inventoryPdfColGroup(false)}
    <thead>
      <tr>
        <th>Department</th>
        <th>Brand</th>
        <th>Model</th>
        <th>Description</th>
        <th>Count</th>
        <th>Status Counts</th>
      </tr>
    </thead>
  `;
}

function inventoryPdfTableHtml(filteredAssets, filters, showIndividual) {
  if (showIndividual) {
    return `
      <table class="inventory-table detail-table">
        ${inventoryPdfTableHead(true)}
        <tbody>${inventoryIndividualRowsHtml(filteredAssets)}</tbody>
      </table>
    `;
  }

  return `
    <table class="inventory-table grouped-table">
      ${inventoryPdfTableHead(false)}
      <tbody>${inventoryGroupedRowsHtml(filteredAssets, filters)}</tbody>
    </table>
  `;
}

function buildInventoryPdfPages(filteredAssets, filters, context) {
  const safe = value => escapeHtml(String(value ?? ''));
  const logoUrl = escapeHtmlAttr(getPdfLogoUrl());
  const footerHtml = renderPdfFooterHtml();
  const showIndividual = !!context.showIndividual;
  const pageConfig = inventoryPdfPageConfig(showIndividual);

  const headerHtml = `
    <div class="logo-row"><img src="${logoUrl}" alt="Company Logo"></div>
    <div class="header">
      <div class="header-left">
        GENERATED BY:<br>
        ${safe(context.generatedBy)}<br><br>
        FILTERS:<br>
        ${context.filterSummary.map(safe).join('<br>')}
      </div>
      <div class="header-right">
        <div class="report-title">${safe(context.reportTitle)}</div>
        No. : ${safe(context.reportNumber)}<br>
        Date : ${safe(context.formattedDate)}
      </div>
    </div>
  `;

  const rowRecords = showIndividual
    ? inventoryIndividualRowRecords(filteredAssets)
    : inventoryGroupedRowRecords(filteredAssets, filters);

  const measureBox = document.createElement('div');
  measureBox.id = '__inventoryMeasureBox';
  measureBox.style.cssText = `
    position:absolute;
    left:-10000px;
    top:0;
    visibility:hidden;
    width:${pageConfig.measureWidthMm}mm;
    font-family:'Century Gothic', Arial, sans-serif;
    font-size:${pageConfig.bodyFontSize};
    line-height:1.25;
    background:white;
    z-index:-1;
  `;

  measureBox.innerHTML = `
    <style>
      #__inventoryMeasureBox * { box-sizing:border-box; }
      #__inventoryMeasureBox .logo-row { display:flex; justify-content:flex-end; margin-bottom:7px; height:39px; }
      #__inventoryMeasureBox .logo-row img { height:39px; width:auto; object-fit:contain; }
      #__inventoryMeasureBox .header { display:flex; justify-content:space-between; align-items:flex-start; gap:20px; margin-bottom:18px; }
      #__inventoryMeasureBox .header-left { flex:1; font-size:8.5pt; font-weight:bold; line-height:1.35; }
      #__inventoryMeasureBox .header-right { text-align:right; font-size:8.5pt; font-weight:bold; line-height:1.35; min-width:180px; }
      #__inventoryMeasureBox .report-title { font-size:14pt; font-weight:bold; margin-bottom:5px; }
      #__inventoryMeasureBox .inventory-table { width:100%; border-collapse:collapse; border:2px solid black; table-layout:fixed; margin-bottom:0; }
      #__inventoryMeasureBox .inventory-table th { background:#333; color:white; padding:${pageConfig.tablePadding}; text-align:left; font-size:${pageConfig.tableFontSize}; border:1px solid #333; }
      #__inventoryMeasureBox .inventory-table td { border:1px solid #333; padding:${pageConfig.tablePadding}; font-size:${pageConfig.tableFontSize}; vertical-align:top; line-height:1.25; word-break:break-word; overflow-wrap:anywhere; }
      #__inventoryMeasureBox .inventory-table td > span { max-width:100%; white-space:normal !important; overflow-wrap:anywhere; }
      #__inventoryMeasureBox .number-cell { text-align:center; white-space:nowrap; }
      #__inventoryMeasureBox .empty-row { text-align:center; color:#666; padding:18px; }
      #__inventoryMeasureBox .footer-measure { width:100%; text-align:center; font-size:7pt; font-weight:bold; line-height:1.2; overflow-wrap:anywhere; }
    </style>
    <div id="__inventoryBase">
      ${headerHtml}
      <table class="inventory-table">${inventoryPdfTableHead(showIndividual)}</table>
    </div>
    <table class="inventory-table">
      ${inventoryPdfColGroup(showIndividual)}
      <tbody id="__inventoryMeasureBody"></tbody>
    </table>
    <div id="__inventoryFooterMeasure" class="footer-measure">${footerHtml}</div>
  `;

  const normaliseMeasuredHeight = mountPdfMeasureBox(measureBox, pageConfig.measureWidthMm);

  const measureBody = measureBox.querySelector('#__inventoryMeasureBody');
  const baseHeight = normaliseMeasuredHeight(
    measureBox.querySelector('#__inventoryBase').getBoundingClientRect().height
  );
  const footerHeight = normaliseMeasuredHeight(
    measureBox.querySelector('#__inventoryFooterMeasure')?.getBoundingClientRect().height || 0
  );
  const footerReserveMm = pdfFooterReserveMm({
    pageHeightMm: pageConfig.heightMm,
    pageFlowHeightMm: pageConfig.pageFlowHeightMm,
    topPaddingMm: pageConfig.pagePaddingTopMm,
    footerBottomMm: pageConfig.footerBottomMm,
    footerGapMm: pageConfig.footerGapMm,
    minReserveMm: pageConfig.minFooterReserveMm
  }, footerHeight);
  const rowBudget = Math.max(36, pdfMmToPx(pageConfig.pageFlowHeightMm - footerReserveMm) - baseHeight);

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
    const pageRows = [];
    let pageHeight = 0;

    while (index < rowRecords.length) {
      const record = rowRecords[index];
      if (pageRows.length > 0 && pageHeight + record.height > rowBudget) break;

      pageRows.push(record);
      pageHeight += record.height;
      index++;

      if (pageRows.length === 1 && record.height > rowBudget) break;
    }

    pages.push(pageRows);
  }

  const totalPages = pages.length;
  return pages.map((pageRows, pageIndex) => `
    <div class="page">
      ${headerHtml}
      <table class="inventory-table ${showIndividual ? 'detail-table' : 'grouped-table'}">
        ${inventoryPdfTableHead(showIndividual)}
        <tbody>${pageRows.map(row => row.html).join('')}</tbody>
      </table>
      <div class="footer">${footerHtml}</div>
      <div class="page-number">Page ${pageIndex + 1} of ${totalPages}</div>
    </div>
  `).join('');
}

async function generateInventoryPdf() {
  let win = null;

  try {
    if (!isAdminUser()) {
      showNotification('error', 'Admin privileges required');
      return;
    }

    const { filteredAssets, filters, totalAssets } = getFilteredInventoryData();
    if (filteredAssets.length === 0) {
      showNotification('warning', 'No assets match the selected filters');
      return;
    }

    win = window.open('', '_blank', 'width=1000,height=1000');
    if (!win) {
      showNotification('error', 'Pop-up blocked. Please allow pop-ups to export the inventory PDF.');
      return;
    }

    win.document.write(`<!DOCTYPE html><html><head><title>Preparing Inventory PDF</title></head><body style="font-family:Arial,sans-serif;padding:24px;">Preparing inventory PDF...</body></html>`);
    win.document.close();

    await loadPdfSettings(true);

    const showIndividual = document.getElementById('inventory-export-individual')?.checked || false;
    const stamp = inventoryExportDateStamp();
    const filterSummary = inventoryFilterSummary(filters, filteredAssets.length, totalAssets, showIndividual);
    const reportTitle = showIndividual ? 'INVENTORY DETAIL REPORT' : 'INVENTORY SUMMARY REPORT';
    const pageConfig = inventoryPdfPageConfig(showIndividual);
    const pagesHtml = buildInventoryPdfPages(filteredAssets, filters, {
      showIndividual,
      generatedBy: currentUser?.username || '',
      filterSummary,
      reportTitle,
      reportNumber: stamp.reportNumber,
      formattedDate: stamp.displayDate
    });

    const html = `<!DOCTYPE html><html><head><title>${reportTitle}</title><style>
      @page { size: A4 ${pageConfig.orientation}; margin: 0; }
      * { box-sizing: border-box; }
      body { margin: 0; font-family: 'Century Gothic', Arial, sans-serif; color: #000; background: #f0f0f0; font-size: ${pageConfig.bodyFontSize}; line-height: 1.25; }
      .page { width: ${pageConfig.widthMm}mm; height: ${pageConfig.heightMm}mm; min-height: ${pageConfig.heightMm}mm; margin: 0 auto 12px auto; padding: 7mm 7mm 14mm 7mm; background: white; position: relative; overflow: hidden; page-break-after: always; break-after: page; }
      .page:last-child { page-break-after: auto; break-after: auto; }
      .print-btn { position: fixed; top: 20px; right: 20px; background: #667eea; color: #fff; border: none; padding: 10px 18px; border-radius: 6px; cursor: pointer; z-index: 999; font-size: 12px; }
      .logo-row { display: flex; justify-content: flex-end; margin-bottom: 7px; height: 39px; }
      .logo-row img { height: 39px; width: auto; object-fit: contain; }
      .header { display: flex; justify-content: space-between; align-items: flex-start; gap: 20px; margin-bottom: 18px; }
      .header-left { flex: 1; font-size: 8.5pt; font-weight: bold; line-height: 1.35; }
      .header-right { text-align: right; font-size: 8.5pt; font-weight: bold; line-height: 1.35; min-width: 180px; }
      .report-title { font-size: 14pt; font-weight: bold; margin-bottom: 5px; }
      .inventory-table { width: 100%; border-collapse: collapse; border: 2px solid black; table-layout: fixed; margin-bottom: 0; }
      .inventory-table thead { display: table-header-group; }
      .inventory-table tr { break-inside: avoid; page-break-inside: avoid; }
      .inventory-table th { background: #333; color: #fff; padding: ${pageConfig.tablePadding}; text-align: left; border: 1px solid #333; font-size: ${pageConfig.tableFontSize}; }
      .inventory-table td { border: 1px solid #333; padding: ${pageConfig.tablePadding}; font-size: ${pageConfig.tableFontSize}; vertical-align: top; line-height: 1.25; word-break: break-word; overflow-wrap: anywhere; }
      .inventory-table td > span { max-width: 100%; white-space: normal !important; overflow-wrap: anywhere; }
      .number-cell { text-align: center; white-space: nowrap; }
      .empty-row { text-align: center; color: #666; padding: 18px; }
      .footer { position: absolute; bottom: 7mm; left: 7mm; right: 7mm; text-align: center; font-size: 7pt; font-weight: bold; line-height: 1.2; overflow-wrap: anywhere; }
      .page-number { position: absolute; bottom: 3mm; right: 7mm; font-size: 7pt; }
      @media print {
        body, body * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        body { background: #fff; }
        .page { margin: 0; page-break-after: always; break-after: page; }
        .page:last-child { page-break-after: auto; break-after: auto; }
        .print-btn { display: none; }
      }
    </style></head><body>
      <button class="print-btn" onclick="window.print()">Print / Save as PDF</button>
      ${pagesHtml}
    </body></html>`;

    win.document.open();
    win.document.write(html);
    win.document.close();
    win.focus();
    showNotification('success', 'Inventory PDF generated successfully');
  } catch (error) {
    console.error('Inventory PDF export failed:', error);
    if (win && !win.closed) {
      win.document.open();
      win.document.write(`<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;padding:24px;">Failed to generate inventory PDF: ${escapeHtml(error.message)}</body></html>`);
      win.document.close();
    }
    showNotification('error', `Failed to generate inventory PDF: ${error.message}`);
  }
}

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
    String(item.brand || '').trim(),
    String(item.model || '').trim(),
    String(item.description || '').trim()
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



function renderTransferInitialMessage(sourceEvents, targetEvents) {
  if (!sourceEvents.length || !targetEvents.length) {
    return `
      <div style="text-align:center;padding:34px;color:#666;">
        <div style="font-size:34px;margin-bottom:8px;">↔️</div>
        <div style="font-weight:800;color:#333;margin-bottom:4px;">No valid transfer pair yet</div>
        <div>${!sourceEvents.length ? 'No source events with unreturned assets are currently eligible. ' : ''}${!targetEvents.length ? 'No Planning/Preparing destination events are currently eligible.' : ''}</div>
      </div>
    `;
  }
  return '<p style="text-align:center;color:#666;padding:28px;">Choose both events to compare transfer and return-to-office assets.</p>';
}

function renderTransferWorkspace() {
  const container = document.getElementById('transfer-history');
  if (!container) return;

  const sourceEvents = transferOptionsCache?.sourceEvents || [];
  const targetEvents = transferOptionsCache?.targetEvents || [];

  const sourceOptions = sourceEvents.map(event => {
    const tagPrefix = event.tag === 'dry hire' ? '[DH]' : '[E]';
    const dateRange = event.startDate === event.endDate ? formatDate(event.startDate) : `${formatDate(event.startDate)} - ${formatDate(event.endDate)}`;
    return `<option value="${event.id}">${tagPrefix} ${event.id}: ${escapeHtml(event.name)} • ${event.state} • ${event.unreturnedCount || 0} out • ${dateRange}</option>`;
  }).join('');

  const targetOptions = targetEvents.map(event => {
    const tagPrefix = event.tag === 'dry hire' ? '[DH]' : '[E]';
    const dateRange = event.startDate === event.endDate ? formatDate(event.startDate) : `${formatDate(event.startDate)} - ${formatDate(event.endDate)}`;
    return `<option value="${event.id}">${tagPrefix} ${event.id}: ${escapeHtml(event.name)} • ${event.state} • ${dateRange}</option>`;
  }).join('');

  container.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:18px;">
      <div style="background:linear-gradient(135deg,rgba(102,126,234,.10),rgba(118,75,162,.10));border:1px solid rgba(118,75,162,.18);border-radius:16px;padding:18px;">
        <h3 style="margin:0 0 6px;color:#4b2f65;">Transfer Assets Directly Between Events</h3>
        <p style="margin:0;color:#666;line-height:1.4;">Select a source and destination event. Asset types are grouped by quantity; expand each dropdown to choose the exact physical asset to transfer or return.</p>
      </div>

      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px;align-items:end;background:white;border:1px solid #edf0f5;border-radius:16px;padding:16px;box-shadow:0 6px 18px rgba(0,0,0,.05);">
        <div class="form-group" style="margin:0;">
          <label class="form-label">From Event — Ready / Ongoing / Last Day / Returning / Overdue</label>
          <select id="transferSourceSelect" class="form-input" onchange="loadTransferCandidates()"><option value="">Select source event...</option>${sourceOptions}</select>
          <div style="font-size:12px;color:#666;margin-top:6px;">${sourceEvents.length} eligible source event(s)</div>
        </div>
        <div class="form-group" style="margin:0;">
          <label class="form-label">To Event — Planning / Preparing</label>
          <select id="transferTargetSelect" class="form-input" onchange="loadTransferCandidates()"><option value="">Select destination event...</option>${targetOptions}</select>
          <div style="font-size:12px;color:#666;margin-top:6px;">${targetEvents.length} eligible destination event(s)</div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button class="btn btn-primary" onclick="loadTransferCandidates()">Compare Events</button>
        </div>
      </div>

      <div id="transfer-candidates-panel" style="background:white;border:1px solid #edf0f5;border-radius:16px;padding:16px;box-shadow:0 6px 18px rgba(0,0,0,.05);">
        ${renderTransferInitialMessage(sourceEvents, targetEvents)}
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

  const modalContent = document.getElementById('prepareEventContent');
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

  const modalContent = document.getElementById('prepareEventContent');
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
  } else if (data.fromEvent) {
    data.fromEvent.unreturnedCount = Math.max(0, Number(data.fromEvent.unreturnedCount || 0) - direction);
  }
  if (responseData?.toEvent) {
    data.toEvent = { ...(data.toEvent || {}), ...responseData.toEvent };
  }
}

async function transferDropdownAsset(encodedAssetId) {
  const assetId = decodeURIComponent(encodedAssetId);
  const fromEventId = document.getElementById('transferSourceSelect')?.value;
  const toEventId = document.getElementById('transferTargetSelect')?.value;
  if (!fromEventId || !toEventId || !assetId || !beginTransferPendingAction(assetId, 'transfer')) return;
  renderTransferCandidatesInPlace();
  try {
    const response = await apiCall('/api/transfers/execute', 'POST', { fromEventId: Number(fromEventId), toEventId: Number(toEventId), assetIds: [assetId] });
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
  const pairKey = `${fromEventId || ''}|${toEventId || ''}`;
  const openDropdowns = options.openDropdowns || getOpenTransferDropdownIds();

  if (window.__lastTransferPairKey !== pairKey) {
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
    const response = await apiCall(`/api/transfers/candidates?fromEventId=${encodeURIComponent(fromEventId)}&toEventId=${encodeURIComponent(toEventId)}`);
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
        items: []
      });
    }

    const group = map.get(key);
    group.items.push(item);
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
      group.actionQty = officeQty;
      group.progressLabel = `${officeQty} needed from office`;
      group.helpText = group.reason || `Destination still needs ${group.targetRemaining}; source can provide ${group.sourceQuantity || 0}; ${officeQty} should be packed from office.`;
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

function renderTransferCandidates(data) {
  window.__lastTransferData = data;
  const panel = document.getElementById('transfer-candidates-panel');
  if (!panel) return;

  const fromEvent = data.fromEvent || {};
  const toEvent = data.toEvent || {};
  const meta = transferModeMeta(transferPanelMode);
  const groups = buildTransferGroups(getTransferListForMode(meta.mode, data), meta.mode);
  const modeButtons = renderTransferModeButtons(data);

  if (!groups.length) {
    panel.innerHTML = `${modeButtons}<div style="text-align:center;padding:34px;color:#666;"><div style="font-size:32px;margin-bottom:8px;">🔍</div><div style="font-weight:700;color:#333;margin-bottom:4px;">No asset types in this view</div><div>${escapeHtml(meta.emptyText)}</div></div>`;
    return;
  }

  const totalQty = groups.reduce((sum, group) => sum + Number(group.actionQty || 0), 0);
  const totalDone = groups.reduce((sum, group) => sum + Number(group.doneQty || 0), 0);
  const groupCards = groups.map((group, index) => renderTransferGroupCard(group, index)).join('');
  const doneText = meta.mode === 'office-needed'
    ? `${totalQty} item(s) still needed from office`
    : `${totalDone}/${totalQty} done`;

  panel.innerHTML = `
    ${modeButtons}
    <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap;margin-bottom:14px;">
      <div>
        <h3 style="margin:0;color:#764ba2;">${groups.length} asset type(s), ${totalQty} ${escapeHtml(meta.qtyNoun)}</h3>
        <div style="color:#666;font-size:13px;margin-top:4px;">From <strong>${escapeHtml(fromEvent.name || '')}</strong> → To <strong>${escapeHtml(toEvent.name || '')}</strong></div>
      </div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
        <span style="color:#666;font-size:13px;">${escapeHtml(doneText)}</span>
        <button class="btn btn-primary" onclick="generateTransferPdf()">Export PDF</button>
      </div>
    </div>
    ${groupCards}
  `;
}

function renderTransferGroupCard(group, index) {
  const qtyLabel = group.actionQty;
  const title = `${qtyLabel}x ${transferAssetTypeName(group)}`;
  const detailsId = transferGroupDetailsId(group);
  const badge = departmentBadgeHtml(group.department || 'UN', true);
  const isOfficeNeeded = group.mode === 'office-needed';

  const progressOrBadge = isOfficeNeeded
    ? `<span class="asset-badge status-ooc">Needed from Office</span>`
    : transferProgressHtml(group.doneQty, group.actionQty);

  const dropdownHtml = isOfficeNeeded ? '' : `
      <details id="${detailsId}">
        <summary style="cursor:pointer;padding:10px 12px;background:#fafafa;border-top:1px solid #e9ecef;font-weight:700;color:#555;">
          Choose exact asset(s) (${group.items.length} available; ${group.actionQty} needed)
        </summary>
        <div>${transferAssetDropdownRows(group)}</div>
      </details>`;

  return `
    <div style="margin-bottom:14px;border:1px solid #e9ecef;border-radius:12px;overflow:hidden;background:#fff;box-shadow:0 3px 10px rgba(0,0,0,.04);">
      <div style="padding:12px;background:#f1f3f4;">
        <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap;">
          <div style="min-width:260px;">
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:4px;">
              ${badge}
              <strong style="font-size:14px;color:#333;">${escapeHtml(title)}</strong>
            </div>
            <div style="font-size:12px;color:#666;">${escapeHtml(group.helpText || '')}</div>
          </div>
          <div style="min-width:180px;text-align:right;">${progressOrBadge}</div>
        </div>
      </div>
      ${dropdownHtml}
    </div>
  `;
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

function buildTransferPdfPages(groups, context) {
  const safe = (value) => escapeHtml(String(value ?? ''));
  const logoUrl = escapeHtmlAttr(getPdfLogoUrl());
  const footerHtml = renderPdfFooterHtml();

  const fromDate = context.fromDateRange ? ` | ${safe(context.fromDateRange)}` : '';
  const toDate = context.toDateRange ? ` | ${safe(context.toDateRange)}` : '';

  const headerHtml = `
    <div class="logo-row"><img src="${logoUrl}" alt="Company Logo"></div>
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
    font-family:'Century Gothic', Arial, sans-serif;
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

async function generateTransferPdf() {
  const fromEventId = document.getElementById('transferSourceSelect')?.value;
  const toEventId = document.getElementById('transferTargetSelect')?.value;
  const fromEvent = (transferOptionsCache?.sourceEvents || []).find(e => String(e.id) === String(fromEventId)) || {};
  const toEvent = (transferOptionsCache?.targetEvents || []).find(e => String(e.id) === String(toEventId)) || {};
  const meta = transferModeMeta(transferPanelMode);

  if (!fromEventId || !toEventId) {
    showNotification('warning', 'Select both source and destination events first');
    return;
  }

  const groups = buildTransferGroups(getTransferListForMode(meta.mode, window.__lastTransferData || {}), meta.mode);
  const safe = (value) => escapeHtml(String(value ?? ''));
  const dateRange = (event) => !event || !event.startDate ? '' : (event.startDate === event.endDate ? formatDate(event.startDate) : `${formatDate(event.startDate)} - ${formatDate(event.endDate)}`);

  const now = new Date();
  const formattedDate = now.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  const transferNumber = `${meta.numberPrefix}-${now.getFullYear()}${String(fromEventId).padStart(4, '0')}-${String(toEventId).padStart(4, '0')}`;
  const totalQty = groups.reduce((sum, group) => sum + Number(group.actionQty || 0), 0);

  await loadPdfSettings(true);

  const pagesHtml = buildTransferPdfPages(groups, {
    fromEvent,
    toEvent,
    fromEventId,
    toEventId,
    fromDateRange: dateRange(fromEvent),
    toDateRange: dateRange(toEvent),
    title: meta.title,
    transferNumber,
    formattedDate,
    totalQty
  });

  const win = window.open('', '_blank', 'width=900,height=1000');
  if (!win) {
    showNotification('error', 'Pop-up blocked. Please allow pop-ups to export the transfer PDF.');
    return;
  }

  const html = `<!DOCTYPE html><html><head><title>${safe(meta.title)} - ${safe(fromEvent.name || '')} to ${safe(toEvent.name || '')}</title><style>
    @page { size: A4; margin: 0; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: 'Century Gothic', Arial, sans-serif; color: #000; background: #f0f0f0; }
    .page { width: 210mm; height: 297mm; min-height: 297mm; margin: 0 auto 12px auto; padding: 7mm 7mm 14mm 7mm; background: white; position: relative; overflow: hidden; page-break-after: always; break-after: page; }
    .page:last-child { page-break-after: auto; break-after: auto; }
    .logo-row { display:flex; justify-content:flex-end; margin-bottom:7px; height:39px; } .logo-row img { height:39px; width:auto; object-fit:contain; }
    .header { display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:20px; } .header-left { flex:1; font-size:9pt; font-weight:bold; line-height:1.35; } .header-right { text-align:right; font-size:9pt; font-weight:bold; }
    .transfer-title { font-size:14pt; font-weight:bold; margin-bottom:5px; } .summary-table, .items-table { width:100%; border-collapse:collapse; border:2px solid black; table-layout:fixed; }
    .summary-table { margin-bottom:16px; } .items-table { margin-bottom:0; }
    .summary-table td { border:1px solid #333; padding:7px; font-size:9pt; vertical-align:top; } .items-table th { background:#333; color:white; padding:8px; text-align:left; font-size:8.5pt; border:1px solid #333; }
    .items-table td { border:1px solid #333; padding:6px; font-size:8.5pt; vertical-align:top; line-height:1.25; word-break:break-word; overflow-wrap:anywhere; }
    .footer { position:absolute; bottom:7mm; left:7mm; right:7mm; text-align:center; font-size:7pt; font-weight:bold; line-height:1.2; overflow-wrap:anywhere; }
    .page-number { position:absolute; bottom:3mm; right:7mm; font-size:7pt; }
    .print-btn { position:fixed; top:20px; right:20px; background:#667eea; color:white; border:none; padding:10px 18px; border-radius:6px; cursor:pointer; z-index:999; }
    @media print { body { background:white; } .page { margin:0; page-break-after:always; break-after:page; } .page:last-child { page-break-after:auto; break-after:auto; } .print-btn { display:none; } }
  </style></head><body><button class="print-btn" onclick="window.print()">Print / Save as PDF</button>${pagesHtml}</body></html>`;
  win.document.write(html);
  win.document.close();
  win.focus();
}
