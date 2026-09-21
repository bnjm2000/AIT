const FINANCE_STATUSES = ['draft', 'sent', 'accepted', 'cancelled'];
const FINANCE_LIST_STATUSES = ['draft', 'sent', 'accepted', 'invoiced', 'overdue', 'paid', 'expired', 'cancelled'];
const FINANCE_UOMS = [
  { value: 'units', label: 'unit(s)' },
  { value: 'sets', label: 'set(s)' },
  { value: 'pax', label: 'pax' },
  { value: 'lot', label: 'lot' },
  { value: 'sqm', label: 'sqm' }
];
const FINANCE_SALUTATIONS = ['', 'Mr.', 'Ms.', 'Mrs.', 'Mdm.'];
const FINANCE_SCHEDULE_KEYS = {
  setup: 'additionalSetups',
  rehearsal: 'additionalRehearsals',
  show: 'additionalShows',
  teardown: 'additionalTeardowns'
};
const FINANCE_SCHEDULE_LABELS = {
  setup: 'Set-up',
  rehearsal: 'Rehearsal',
  show: 'Show',
  teardown: 'Teardown'
};
const FINANCE_STANDARD_SCHEDULE_ORDER = ['setup', 'rehearsal', 'show', 'teardown'];
const FINANCE_WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const FINANCE_WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const FINANCE_VALIDITY_UNITS = [
  { value: 'days', label: 'day(s)', multiplier: 1 },
  { value: 'weeks', label: 'week(s)', multiplier: 7 },
  { value: 'months', label: 'month(s)', multiplier: 30 }
];

const financeState = {
  documents: [],
  current: null,
  baseDocument: null,
  clients: [],
  events: [],
  salespeople: [],
  invoicePlanTemplates: [],
  catalog: [],
  departments: ['Manpower', 'Transportation'],
  saveTimer: null,
  activeSaves: new Set(),
  discardingRevision: false,
  catalogTimer: null,
  catalogRequestSeq: 0,
  catalogCache: {},
  catalogAbortController: null,
  catalogInFlight: false,
  catalogQueuedSearch: null,
  catalogQuery: '',
  pendingCatalogSelection: null,
  listTimer: null,
  listLoading: false,
  listRequestSeq: 0,
  listQuery: '',
  listObserver: null,
  listSort: 'updated',
  listStatuses: [],
  listMeta: {
    total: 0,
    hasMore: false,
    nextOffset: null,
    statusTotal: 0,
    statusCounts: {}
  },
  changeVersion: 0,
  automaticDraftDateRefresh: false,
  statusTargetId: '',
  eventPairTargetId: '',
  eventCreatingIds: new Set(),
  eventOptionsRequestSeq: 0,
  contextDocumentId: '',
  contextSubprojectId: '',
  salespersonReassignmentTarget: null,
  addDepartment: '',
  dragLineIndex: null,
  dragLineIndexes: [],
  dragWholeLineGroup: false,
  dragHeaderId: '',
  dragDepartment: '',
  dragSubprojectId: '',
  snapshotMode: false,
  activeSubprojectId: 'main',
  rateCard: [],
  rateCardSearch: '',
  rateCardTab: 'assets',
  rateCardUom: 'units',
  rateCardTarget: 'quotation',
  products: [],
  newClientSalutation: '',
  editorDataLoadedAt: 0,
  mineOnly: true,
  expandedScheduleBatches: {}
};

function financeCloneDocument(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function financeValuesEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function financeHasPendingChanges() {
  return Boolean(
    financeState.current
    && !financeState.snapshotMode
    && (
      financeState.saveTimer
      || financeState.activeSaves.size
      || !financeValuesEqual(financeState.current, financeState.baseDocument)
    )
  );
}

async function financeHandleRealtimeChanges(changes) {
  const rows = Array.isArray(changes) ? changes : [];
  const quotationIds = [...new Set(rows
    .map(row => String(row?.quotationId || '').trim())
    .filter(Boolean))];
  if (!quotationIds.length) return false;

  const currentId = String(financeState.current?.id || '');
  if (currentId && quotationIds.includes(currentId)) {
    const response = await apiCall(`/api/quotations/${encodeURIComponent(currentId)}`);
    const latest = response.data;
    const base = financeState.baseDocument || financeState.current;
    const hasLocalChanges = !financeValuesEqual(financeState.current, base);
    if (hasLocalChanges) {
      financeState.current = financeMergeDocumentConflict(
        base,
        financeState.current,
        latest
      );
      // Retain the original edit version. The server then performs the
      // authoritative three-way merge and rejects a true same-line conflict.
      financeState.current.documentVersion = base.documentVersion;
    } else {
      financeState.current = latest;
      financeState.baseDocument = financeCloneDocument(latest);
    }
    financeRenderEditor();
  }

  if (!currentId) {
    await Promise.all(quotationIds.map(async quotationId => {
      try {
        const response = await apiCall(`/api/quotations/${encodeURIComponent(quotationId)}`);
        financeUpdateListRow(response.data);
      } catch (error) {
        if (error?.status === 404) {
          financeState.documents = financeState.documents.filter(
            row => String(row.id) !== quotationId
          );
          financeRenderList(financeState.listQuery);
        }
      }
    }));
  }
  return true;
}

function financeIsPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function financeMergeObjectFields(baseValue, localValue, latestValue) {
  const base = financeIsPlainObject(baseValue) ? baseValue : {};
  const local = financeIsPlainObject(localValue) ? localValue : {};
  const latest = financeIsPlainObject(latestValue) ? latestValue : {};
  const merged = financeCloneDocument(latest);
  new Set([...Object.keys(base), ...Object.keys(local)]).forEach(key => {
    if (!Object.prototype.hasOwnProperty.call(local, key)) {
      if (Object.prototype.hasOwnProperty.call(base, key)) delete merged[key];
      return;
    }
    if (financeValuesEqual(local[key], base[key])) return;
    if (Array.isArray(local[key]) && Array.isArray(base[key]) && Array.isArray(latest[key])) {
      merged[key] = financeMergeVersionedRows(base[key], local[key], latest[key]);
    } else if (
      financeIsPlainObject(local[key])
      && financeIsPlainObject(base[key])
      && financeIsPlainObject(latest[key])
    ) {
      merged[key] = financeMergeObjectFields(base[key], local[key], latest[key]);
    } else {
      merged[key] = financeCloneDocument(local[key]);
    }
  });
  return merged;
}

function financeMergeVersionedRows(baseRows, localRows, latestRows) {
  const base = Array.isArray(baseRows) ? baseRows : [];
  const local = Array.isArray(localRows) ? localRows : [];
  const latest = Array.isArray(latestRows) ? latestRows : [];
  const allHaveIds = [...base, ...local, ...latest].every(row => (
    row && typeof row === 'object' && String(row.id || '').trim()
  ));
  if (!allHaveIds) return financeCloneDocument(local);

  const baseById = new Map(base.map(row => [String(row.id), row]));
  const localById = new Map(local.map(row => [String(row.id), row]));
  const latestById = new Map(latest.map(row => [String(row.id), row]));
  const deletedLocally = new Set(
    [...baseById.keys()].filter(id => !localById.has(id))
  );
  const merged = local.map(row => {
    const id = String(row.id);
    const baseRow = baseById.get(id);
    const latestRow = latestById.get(id);
    if (baseRow && financeValuesEqual(row, baseRow)) {
      return latestRow ? financeCloneDocument(latestRow) : null;
    }
    return baseRow && latestRow
      ? financeMergeObjectFields(baseRow, row, latestRow)
      : financeCloneDocument(row);
  }).filter(Boolean);
  const included = new Set(merged.map(row => String(row.id)));
  latest.forEach(row => {
    const id = String(row.id);
    if (!included.has(id) && !deletedLocally.has(id)) {
      merged.push(financeCloneDocument(row));
    }
  });
  return merged;
}

function financeMergeDocumentConflict(baseDocument, localDocument, latestDocument) {
  const base = baseDocument || {};
  const local = localDocument || {};
  const latest = latestDocument || {};
  const merged = financeCloneDocument(latest);
  const protectedFields = new Set([
    'documentVersion', 'updatedAt', 'updatedBy', 'updatedByName', 'totals'
  ]);
  Object.keys(local).forEach(key => {
    if (protectedFields.has(key) || key.startsWith('_')) return;
    if (financeValuesEqual(local[key], base[key])) return;
    if (Array.isArray(local[key]) && Array.isArray(base[key]) && Array.isArray(latest[key])) {
      merged[key] = financeMergeVersionedRows(base[key], local[key], latest[key]);
    } else if (
      financeIsPlainObject(local[key])
      && financeIsPlainObject(base[key])
      && financeIsPlainObject(latest[key])
    ) {
      merged[key] = financeMergeObjectFields(base[key], local[key], latest[key]);
    } else {
      merged[key] = financeCloneDocument(local[key]);
    }
  });
  merged.documentVersion = latest.documentVersion;
  Object.keys(local).filter(key => key.startsWith('_')).forEach(key => {
    merged[key] = local[key];
  });
  return merged;
}

const financeScheduleBulkState = {
  kind: 'show',
  method: 'recurring',
  editingBatchId: '',
  startDate: '',
  endDate: '',
  weekdays: [],
  intervalWeeks: 1,
  time: '',
  pasteText: '',
  excluded: {},
  initialBatchIdentities: [],
  initialiseExclusions: false,
  restrictPasteKind: false
};

const financeCustomScheduleState = {
  editingId: '',
  label: '',
  dates: [],
  positionIndex: -1,
  baseOrder: []
};

const financeLineGroupState = {
  mode: 'finance',
  groupId: '',
  subprojectId: 'main',
  title: '',
  category: '',
  groupQuantity: 1,
  displayFields: ['brand', 'model', 'description'],
  selected: [],
  customText: '',
  commercialHeader: null,
  results: [],
  searchTimer: null,
  searchRequestSeq: 0,
  searchAbortController: null,
  searchInFlight: false,
  queuedSearch: null,
  dragSelectionIndex: -1
};

const profitLossState = {
  events: [],
  eventId: null,
  data: null,
  loading: false,
  commissionDraft: [],
  editingExpenseId: ''
};

const profitLossExpenseUploadState = {
  rows: new Map(),
  queue: [],
  active: false,
  sequence: 0
};

const compareState = {
  events: [],
  eventId: null,
  quotationId: '',
  data: null,
  search: '',
  filter: 'all',
  viewId: 'all',
  showMisc: false,
  showLoans: true,
  loading: false
};

function financeEscape(value) {
  if (typeof escapeHtml === 'function') return escapeHtml(String(value ?? ''));
  const node = document.createElement('div');
  node.textContent = String(value ?? '');
  return node.innerHTML;
}

function financeEscapeAttr(value) {
  if (typeof escapeHtmlAttr === 'function') return escapeHtmlAttr(String(value ?? ''));
  return financeEscape(value).replace(/"/g, '&quot;');
}

function financeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function financeMoney(value) {
  const amount = financeNumber(value);
  return `${amount < 0 ? '-' : ''}$${Math.abs(amount).toLocaleString('en-SG', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
}

function financeMoneyInputValue(value) {
  return Math.abs(financeCurrencyNumber(value)).toLocaleString('en-SG', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function financeFormatMoneyInput(input) {
  if (input) input.value = financeMoneyInputValue(input.value);
}

function financeCurrencyNumber(value, fallback = 0) {
  if (typeof value === 'number') return financeNumber(value, fallback);
  const cleaned = String(value ?? '').replace(/[$,\s]/g, '');
  return financeNumber(cleaned, fallback);
}

function financeValidityUnit(document = financeState.current) {
  const value = String(document?.validityUnit || 'days').toLowerCase();
  return FINANCE_VALIDITY_UNITS.some(row => row.value === value) ? value : 'days';
}

function financeValidityUnitMeta(unit = financeValidityUnit()) {
  return FINANCE_VALIDITY_UNITS.find(row => row.value === unit) || FINANCE_VALIDITY_UNITS[0];
}

function financeValidityAmount(document = financeState.current) {
  const raw = financeNumber(document?.validityAmount, 0);
  if (raw > 0) return raw;
  const unit = financeValidityUnit(document);
  const multiplier = financeValidityUnitMeta(unit).multiplier || 1;
  return Math.max(1, Math.round(financeNumber(document?.validityDays, 30) / multiplier));
}

function financeValidityTotalDays(document = financeState.current) {
  const amount = Math.max(1, financeNumber(document?.validityAmount, financeValidityAmount(document)));
  const multiplier = financeValidityUnitMeta(financeValidityUnit(document)).multiplier || 1;
  return Math.max(1, Math.round(amount * multiplier));
}

function financeLocationOptions() {
  return [...new Set([
    ...(financeState.events || []).map(event => event.location),
    ...(financeState.documents || []).map(document => document.eventLocation)
  ].map(value => String(value || '').trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b))
    .slice(0, 80);
}

function financeShowLocationSuggestions(value = '') {
  const results = document.getElementById('financeLocationResults');
  if (!results) return;
  const query = String(value || '').trim().toLowerCase();
  const options = financeLocationOptions()
    .filter(location => !query || location.toLowerCase().includes(query))
    .slice(0, 6);
  results.innerHTML = options.map(location => `
    <button type="button" onmousedown="event.preventDefault();financeChooseLocation('${financeEscapeAttr(encodeURIComponent(location))}')">${financeEscape(location)}</button>
  `).join('');
  results.classList.toggle('open', options.length > 0);
}

function financeChooseLocation(encodedLocation) {
  const location = decodeURIComponent(encodedLocation);
  const input = document.getElementById('financeLocationInput');
  if (input) input.value = location;
  document.getElementById('financeLocationResults')?.classList.remove('open');
  financeFieldChange('eventLocation', location);
}

function financeSalespersonSuggestionRows(value = '') {
  const query = String(value || '').trim().toLowerCase();
  return (financeState.salespeople || []).filter(user => !query || [
    user.name, user.username, user.phone
  ].some(field => String(field || '').toLowerCase().includes(query))).slice(0, 8);
}

function financeRenderSalespersonSuggestions(results, value, chooseHandler) {
  if (!results) return;
  const options = financeSalespersonSuggestionRows(value);
  results.innerHTML = options.map(user => `
    <button type="button" onmousedown="event.preventDefault()" onclick="${chooseHandler}('${financeEscapeAttr(encodeURIComponent(user.username))}')">
      <strong>${financeEscape(user.name || user.username)}</strong>
      <small>${financeEscape([user.username, user.phone].filter(Boolean).join(' · '))}</small>
    </button>
  `).join('');
  results.classList.toggle('open', options.length > 0);
}

function financeShowSalespersonSuggestions(value = '') {
  financeRenderSalespersonSuggestions(
    document.getElementById('financeSalespersonResults'),
    value,
    'financeChooseSalesperson'
  );
}

function financeSalespersonInput(value) {
  if (!financeState.current) return;
  financeState.current.salesperson = value;
  financeState.current.salespersonUsername = '';
  financeQueueSave();
  financeShowSalespersonSuggestions(value);
}

function financeChooseSalesperson(encodedUsername) {
  const username = decodeURIComponent(encodedUsername);
  const user = (financeState.salespeople || []).find(row => row.username === username);
  if (!user || !financeState.current) return;
  financeState.current.salesperson = user.name || user.username;
  financeState.current.salespersonUsername = user.username;
  const input = document.getElementById('financeSalespersonInput');
  if (input) input.value = financeState.current.salesperson;
  document.getElementById('financeSalespersonResults')?.classList.remove('open');
  financeQueueSave();
}

function financeEnsureSalespersonReassignmentModal() {
  if (typeof ensureAppDialogStyles === 'function') ensureAppDialogStyles();
  let modal = document.getElementById('financeSalespersonReassignmentModal');
  if (modal) return modal;
  modal = document.createElement('div');
  modal.id = 'financeSalespersonReassignmentModal';
  modal.className = 'modal app-dialog-modal finance-salesperson-reassignment-modal';
  modal.innerHTML = `
    <form class="modal-content app-dialog-content finance-salesperson-reassignment-content" onsubmit="financeSaveSalespersonReassignment(event)">
      <div class="app-dialog-accent"></div>
      <div class="modal-header app-dialog-header">
        <div class="app-dialog-title-wrap"><span class="app-dialog-icon" aria-hidden="true">i</span><h3 class="modal-title app-dialog-title">Change salesperson</h3></div>
        <button type="button" class="close-btn" aria-label="Close salesperson dialog" onclick="financeCloseSalespersonReassignmentModal()">&times;</button>
      </div>
      <div class="modal-body app-dialog-body">
        <p>Search for an active user in this company.</p>
        <label class="app-dialog-field"><span>Salesperson</span><span class="finance-salesperson-combobox"><input id="financeReassignSalespersonInput" autocomplete="off" placeholder="Search by name, username or phone" onfocus="financeShowReassignmentSalespersonSuggestions(this.value)" oninput="financeReassignmentSalespersonInput(this)" onblur="setTimeout(()=>document.getElementById('financeReassignSalespersonResults')?.classList.remove('open'),120)"><span class="finance-salesperson-results" id="financeReassignSalespersonResults"></span></span></label>
      </div>
      <div class="modal-footer app-dialog-actions">
        <button type="button" class="btn btn-secondary" onclick="financeCloseSalespersonReassignmentModal()">Cancel</button>
        <button type="submit" class="btn btn-primary" id="financeReassignSalespersonSave">Save salesperson</button>
      </div>
    </form>`;
  document.body.appendChild(modal);
  return modal;
}

function financeShowReassignmentSalespersonSuggestions(value = '') {
  financeRenderSalespersonSuggestions(
    document.getElementById('financeReassignSalespersonResults'),
    value,
    'financeChooseReassignmentSalesperson'
  );
}

function financeReassignmentSalespersonInput(input) {
  if (!input) return;
  input.dataset.username = '';
  financeShowReassignmentSalespersonSuggestions(input.value);
}

function financeChooseReassignmentSalesperson(encodedUsername) {
  const username = decodeURIComponent(encodedUsername || '');
  const user = (financeState.salespeople || []).find(row => row.username === username);
  const input = document.getElementById('financeReassignSalespersonInput');
  if (!user || !input) return false;
  input.value = user.name || user.username;
  input.dataset.username = user.username;
  document.getElementById('financeReassignSalespersonResults')?.classList.remove('open');
  return true;
}

async function financeOpenSalespersonReassignment(target = {}) {
  const type = target.type === 'costing' ? 'costing' : 'quotation';
  const id = String(target.id || '').trim();
  if (!id) return;
  financeState.salespersonReassignmentTarget = { type, id };
  if (!financeState.salespeople.length) {
    const response = await apiCall('/api/finance/salespeople');
    financeState.salespeople = response.data || [];
  }
  const modal = financeEnsureSalespersonReassignmentModal();
  const input = modal.querySelector('#financeReassignSalespersonInput');
  input.value = target.salesperson || '';
  input.dataset.username = target.salespersonUsername || '';
  openModal(modal.id);
  setTimeout(() => {
    input.focus({ preventScroll: true });
    input.select();
    financeShowReassignmentSalespersonSuggestions(input.value);
  }, 0);
}

function financeCloseSalespersonReassignmentModal() {
  closeModal('financeSalespersonReassignmentModal');
  document.getElementById('financeReassignSalespersonResults')?.classList.remove('open');
}

async function financeSaveSalespersonReassignment(event) {
  event?.preventDefault();
  const target = financeState.salespersonReassignmentTarget;
  const input = document.getElementById('financeReassignSalespersonInput');
  const button = document.getElementById('financeReassignSalespersonSave');
  const salesperson = String(input?.value || '').trim();
  if (!target?.id || !salesperson) return input?.focus();
  const resource = target.type === 'costing' ? 'costings' : 'quotations';
  if (button) button.disabled = true;
  try {
    await apiCall(`/api/${resource}/${encodeURIComponent(target.id)}/salesperson`, 'PUT', {
      salesperson,
      salespersonUsername: String(input?.dataset.username || '').trim()
    });
    financeCloseSalespersonReassignmentModal();
    if (target.type === 'costing' && typeof costingLoadList === 'function') {
      await costingLoadList();
    } else {
      await financeLoadList(financeState.listQuery);
    }
    showNotification('success', `Salesperson changed to ${salesperson}`);
  } catch (error) {
    showNotification('error', error.message || 'Failed to change salesperson');
  } finally {
    if (button) button.disabled = false;
  }
}

function financeAdditionalScheduleRows(kind, document = financeState.current) {
  const key = FINANCE_SCHEDULE_KEYS[kind];
  return Array.isArray(document?.[key]) ? document[key] : [];
}

function financeScheduleMode(document = financeState.current) {
  return document?.scheduleMode === 'dry-hire' ? 'dry-hire' : 'event';
}

function financeScheduleLabel(kind, document = financeState.current) {
  if (financeScheduleMode(document) === 'dry-hire') {
    if (kind === 'setup') return 'Delivery / Collection';
    if (kind === 'teardown') return 'Return';
  }
  return FINANCE_SCHEDULE_LABELS[kind] || kind;
}

function financeScheduleModeControl(document = financeState.current) {
  const mode = financeScheduleMode(document);
  return `
    <div class="finance-schedule-mode" role="radiogroup" aria-label="Quotation schedule type">
      <button type="button" class="${mode === 'event' ? 'selected' : ''}" role="radio" aria-checked="${mode === 'event'}" onclick="financeSetScheduleMode('event')">Event</button>
      <button type="button" class="${mode === 'dry-hire' ? 'selected' : ''}" role="radio" aria-checked="${mode === 'dry-hire'}" onclick="financeSetScheduleMode('dry-hire')">Dry Hire</button>
    </div>
  `;
}

function financeSetScheduleMode(mode) {
  if (!financeState.current) return;
  financeState.current.scheduleMode = mode === 'dry-hire' ? 'dry-hire' : 'event';
  financeQueueSave();
  financeRenderEditor();
}

function financeAddScheduleRow(kind) {
  if (!financeState.current || !FINANCE_SCHEDULE_KEYS[kind]) return;
  const key = FINANCE_SCHEDULE_KEYS[kind];
  const rows = financeState.current[key] || (financeState.current[key] = []);
  rows.push({ id: `schedule_${Date.now()}_${Math.random().toString(16).slice(2)}`, date: '', time: '' });
  financeQueueSave();
  financeRenderEditor();
}

function financeAdditionalScheduleChange(kind, index, field, value) {
  const row = financeAdditionalScheduleRows(kind)[index];
  if (!row || !['date', 'time'].includes(field)) return;
  row[field] = value;
  financeQueueSave();
  financeRefreshEventCreationControls();
}

function financeRemoveScheduleRow(kind, index) {
  const key = FINANCE_SCHEDULE_KEYS[kind];
  if (!financeState.current || !Array.isArray(financeState.current[key])) return;
  const [removed] = financeState.current[key].splice(index, 1);
  const batch = removed?.batchId
    ? financeScheduleBatches().find(row => row.id === removed.batchId)
    : null;
  if (batch) {
    const identity = financeScheduleIdentity(removed.date, removed.time);
    batch.excludedDates = [...new Set([...(batch.excludedDates || []), identity])];
  }
  financeRemoveEmptyScheduleBatches();
  financeQueueSave();
  financeRenderEditor();
}

function financeScheduleTimeIsTbc(value) {
  return String(value || '').trim().toLowerCase() === 'tbc';
}

function financeClearSchedulePair(key) {
  if (!financeState.current || !FINANCE_SCHEDULE_KEYS[key]) return;
  financeState.current[`${key}Date`] = '';
  financeState.current[`${key}Time`] = '';
  financeQueueSave();
  financeRenderEditor();
}

function financeScheduleTimeChange(key, value) {
  financeScheduleChange(`${key}Time`, value);
  financeRenderEditor();
}

function financeToggleScheduleTimeTbc(key) {
  if (!financeState.current || !FINANCE_SCHEDULE_KEYS[key]) return;
  const field = `${key}Time`;
  financeState.current[field] = financeScheduleTimeIsTbc(financeState.current[field]) ? '' : 'TBC';
  financeQueueSave();
  financeRenderEditor();
}

function financeAdditionalScheduleTimeChange(kind, index, value) {
  financeAdditionalScheduleChange(kind, index, 'time', value);
  financeRenderEditor();
}

function financeToggleAdditionalScheduleTimeTbc(kind, index) {
  const row = financeAdditionalScheduleRows(kind)[index];
  if (!row) return;
  row.time = financeScheduleTimeIsTbc(row.time) ? '' : 'TBC';
  financeQueueSave();
  financeRenderEditor();
}

function financeSchedulePair(label, key) {
  const document = financeState.current || {};
  const time = document[`${key}Time`] || '';
  const timeIsTbc = financeScheduleTimeIsTbc(time);
  return `
    <div class="finance-schedule-pair">
      <strong>${financeEscape(label)}</strong>
      <input class="finance-input" type="date" value="${financeEscapeAttr(document[`${key}Date`] || '')}" onchange="financeScheduleChange('${key}Date',this.value)">
      <span class="finance-schedule-time-control">
        <input class="finance-input" type="time" aria-label="${financeEscapeAttr(label)} time" value="${timeIsTbc ? '' : financeEscapeAttr(time)}" onchange="financeScheduleTimeChange('${key}',this.value)">
        <button type="button" class="finance-schedule-tbc${timeIsTbc ? ' selected' : ''}" aria-label="Set ${financeEscapeAttr(label)} time as TBC" aria-pressed="${timeIsTbc}" onclick="financeToggleScheduleTimeTbc('${key}')">TBC</button>
      </span>
      <button type="button" class="finance-schedule-remove" title="Clear ${financeEscapeAttr(label)} date and time" aria-label="Clear ${financeEscapeAttr(label)} date and time" onclick="financeClearSchedulePair('${key}')">&times;</button>
    </div>
  `;
}

function financeAdditionalSchedulePair(kind, row, index) {
  const baseLabel = financeScheduleLabel(kind);
  const label = `${baseLabel} ${index + 2}`;
  const timeIsTbc = financeScheduleTimeIsTbc(row.time);
  return `
    <div class="finance-schedule-pair finance-schedule-extra">
      <strong>${financeEscape(label)}</strong>
      <input class="finance-input" type="date" value="${financeEscapeAttr(row.date || '')}" onchange="financeAdditionalScheduleChange('${kind}',${index},'date',this.value)">
      <span class="finance-schedule-time-control">
        <input class="finance-input" type="time" aria-label="${financeEscapeAttr(label)} time" value="${timeIsTbc ? '' : financeEscapeAttr(row.time || '')}" onchange="financeAdditionalScheduleTimeChange('${kind}',${index},this.value)">
        <button type="button" class="finance-schedule-tbc${timeIsTbc ? ' selected' : ''}" aria-label="Set ${financeEscapeAttr(label)} time as TBC" aria-pressed="${timeIsTbc}" onclick="financeToggleAdditionalScheduleTimeTbc('${kind}',${index})">TBC</button>
      </span>
      <button type="button" class="finance-schedule-remove" title="Remove ${financeEscapeAttr(label)}" aria-label="Remove ${financeEscapeAttr(label)}" onclick="financeRemoveScheduleRow('${kind}',${index})">&times;</button>
    </div>
  `;
}

function financeScheduleBatches(document = financeState.current) {
  return Array.isArray(document?.scheduleBatches) ? document.scheduleBatches : [];
}

function financeScheduleIdentity(date, time = '') {
  return `${String(date || '').trim()}|${String(time || '').trim().toLowerCase()}`;
}

function financeScheduleDate(value) {
  const raw = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const parsed = new Date(`${raw}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== raw ? null : parsed;
}

function financeScheduleDateLabel(value, month = 'short') {
  const parsed = financeScheduleDate(value);
  if (!parsed) return String(value || '');
  return new Intl.DateTimeFormat('en-SG', {
    day: 'numeric',
    month,
    year: 'numeric',
    timeZone: 'UTC'
  }).format(parsed);
}

function financeScheduleBatchRows(kind, batchId, document = financeState.current) {
  return financeScheduleRowsForKind(kind, document)
    .map((row, index) => ({ row, index }))
    .filter(item => item.row?.batchId === batchId);
}

function financeRemoveEmptyScheduleBatches(document = financeState.current) {
  if (!document || !Array.isArray(document.scheduleBatches)) return;
  const used = new Set(
    financeScheduleKindOptions(document).flatMap(option =>
      financeScheduleRowsForKind(option.value, document).map(row => row?.batchId).filter(Boolean)
    )
  );
  document.scheduleBatches = document.scheduleBatches.filter(batch => used.has(batch.id));
}

function financeScheduleBatchSummary(batch, rows) {
  const dates = rows.map(item => item.row?.date).filter(Boolean).sort();
  const first = dates[0] || batch.startDate;
  const last = dates[dates.length - 1] || batch.endDate || first;
  const range = first && last && first !== last
    ? `${financeScheduleDateLabel(first)} to ${financeScheduleDateLabel(last)}`
    : financeScheduleDateLabel(first);
  if (batch.method === 'recurring') {
    const days = (batch.weekdays || []).map(day => FINANCE_WEEKDAY_NAMES[Number(day)]).filter(Boolean);
    const interval = Math.max(1, Number(batch.intervalWeeks || 1));
    if (!days.length) {
      return `${range || 'Date range'}${batch.time ? ` at ${batch.time}` : ''}`;
    }
    const recurrence = interval === 1
      ? `Every ${days.join(', ')}`
      : `Every ${interval} weeks on ${days.join(', ')}`;
    return `${recurrence}${range ? `, ${range}` : ''}${batch.time ? ` at ${batch.time}` : ''}`;
  }
  return `Imported dates${range ? `, ${range}` : ''}`;
}

function financeScheduleBatchMarkup(kind, batch, rows) {
  const encodedId = financeEscapeAttr(encodeURIComponent(batch.id));
  const expanded = !!financeState.expandedScheduleBatches[batch.id];
  return `
    <div class="finance-schedule-batch">
      <div class="finance-schedule-batch-summary">
        <div>
          <strong>${financeEscape(financeScheduleBatchSummary(batch, rows))}</strong>
          <small>${rows.length} date${rows.length === 1 ? '' : 's'}</small>
        </div>
        <div class="finance-schedule-batch-actions">
          <button type="button" onclick="financeToggleScheduleBatch('${encodedId}')">${expanded ? 'Hide dates' : 'View dates'}</button>
          <button type="button" onclick="financeOpenBulkSchedule('${kind}','${encodedId}')">Edit</button>
          <button type="button" onclick="financeDuplicateScheduleBatch('${encodedId}')">Duplicate</button>
          <button type="button" class="is-danger" onclick="financeDeleteScheduleBatch('${encodedId}')">Delete</button>
        </div>
      </div>
      <div class="finance-schedule-batch-dates" ${expanded ? '' : 'hidden'}>
        ${rows.map(item => financeAdditionalSchedulePair(kind, item.row, item.index)).join('')}
      </div>
    </div>
  `;
}

function financeScheduleRowsMarkup(kind, document = financeState.current) {
  const rows = financeAdditionalScheduleRows(kind, document);
  const batches = financeScheduleBatches(document)
    .filter(batch => batch.kind === kind)
    .map(batch => ({ batch, rows: financeScheduleBatchRows(kind, batch.id, document) }))
    .filter(item => item.rows.length);
  const knownBatchIds = new Set(batches.map(item => item.batch.id));
  return [
    ...batches.map(item => financeScheduleBatchMarkup(kind, item.batch, item.rows)),
    ...rows
      .map((row, index) => ({ row, index }))
      .filter(item => !item.row?.batchId || !knownBatchIds.has(item.row.batchId))
      .map(item => financeAdditionalSchedulePair(kind, item.row, item.index))
  ].join('');
}

function financeCustomScheduleGroups(document = financeState.current) {
  return Array.isArray(document?.customScheduleGroups) ? document.customScheduleGroups : [];
}

function financeCustomScheduleGroupForKind(kind, document = financeState.current) {
  const groupId = String(kind || '').startsWith('custom:') ? String(kind).slice(7) : '';
  return financeCustomScheduleGroups(document).find(group => group.id === groupId) || null;
}

function financeScheduleKindOptions(document = financeState.current) {
  return [
    ...Object.keys(FINANCE_SCHEDULE_KEYS).map(value => ({
      value,
      label: financeScheduleLabel(value, document)
    })),
    ...financeCustomScheduleGroups(document).map(group => ({
      value: `custom:${group.id}`,
      label: group.label,
      custom: true
    }))
  ];
}

function financeScheduleKindExists(kind, document = financeState.current) {
  return financeScheduleKindOptions(document).some(option => option.value === kind);
}

function financeScheduleKindLabel(kind, document = financeState.current) {
  return financeScheduleKindOptions(document).find(option => option.value === kind)?.label || 'Show';
}

function financeScheduleRowsForKind(kind, document = financeState.current) {
  if (FINANCE_SCHEDULE_KEYS[kind]) return financeAdditionalScheduleRows(kind, document);
  return financeCustomScheduleGroupForKind(kind, document)?.dates || [];
}

function financeReplaceScheduleRowsForKind(kind, rows, document = financeState.current) {
  if (!document) return;
  if (FINANCE_SCHEDULE_KEYS[kind]) {
    document[FINANCE_SCHEDULE_KEYS[kind]] = rows;
    return;
  }
  const group = financeCustomScheduleGroupForKind(kind, document);
  if (group) group.dates = rows;
}

function financeScheduleOrder(document = financeState.current) {
  const customTokens = financeCustomScheduleGroups(document).map(group => `custom:${group.id}`);
  const valid = new Set([...FINANCE_STANDARD_SCHEDULE_ORDER, ...customTokens]);
  const result = [];
  (Array.isArray(document?.scheduleOrder) ? document.scheduleOrder : []).forEach(token => {
    if (valid.has(token) && !result.includes(token)) result.push(token);
  });
  [...FINANCE_STANDARD_SCHEDULE_ORDER, ...customTokens].forEach(token => {
    if (!result.includes(token)) result.push(token);
  });
  return result;
}

function financeScheduleTokenLabel(token, document = financeState.current) {
  if (FINANCE_SCHEDULE_LABELS[token]) return financeScheduleLabel(token, document);
  const groupId = String(token || '').startsWith('custom:') ? String(token).slice(7) : '';
  return financeCustomScheduleGroups(document).find(group => group.id === groupId)?.label || 'Custom date';
}

function financeScheduleTokenHasDate(token, document = financeState.current) {
  if (FINANCE_SCHEDULE_KEYS[token]) {
    return Boolean(document?.[`${token}Date`])
      || financeScheduleTimeIsTbc(document?.[`${token}Time`])
      || financeAdditionalScheduleRows(token, document).some(row => (
        Boolean(row?.date) || financeScheduleTimeIsTbc(row?.time)
      ));
  }
  return financeScheduleRowsForKind(token, document).some(row => (
    Boolean(row?.date) || financeScheduleTimeIsTbc(row?.time)
  ));
}

function financeScheduleOrderPreview(document = financeState.current) {
  if (!financeCustomScheduleGroups(document).length) return '';
  const order = financeScheduleOrder(document)
    .filter(token => financeScheduleTokenHasDate(token, document));
  return `
    <div class="finance-schedule-order-preview" aria-label="PDF schedule order">
      <span>PDF order</span>
      <div>${order.map((token, index) => `<b class="${token.startsWith('custom:') ? 'is-custom' : ''}"><small>${index + 1}</small>${financeEscape(financeScheduleTokenLabel(token, document))}</b>`).join('')}</div>
    </div>
  `;
}

function financeCustomScheduleDateChange(encodedGroupId, index, field, value) {
  if (!['date', 'time'].includes(field)) return;
  const groupId = decodeURIComponent(encodedGroupId);
  const group = financeCustomScheduleGroups().find(row => row.id === groupId);
  const date = group?.dates?.[Number(index)];
  if (!date) return;
  date[field] = value;
  financeQueueSave();
  const note = document.querySelector('.finance-event-schedule-heading p');
  if (note) note.textContent = `Dates are optional. New line items will use ${financeEventDays()} day(s).`;
}

function financeCustomScheduleMarkup(document = financeState.current) {
  const groups = financeCustomScheduleGroups(document);
  if (!groups.length) return '';
  const groupById = Object.fromEntries(groups.map(group => [group.id, group]));
  const order = financeScheduleOrder(document);
  const customGroups = order
    .filter(token => token.startsWith('custom:'))
    .map(token => groupById[token.slice(7)])
    .filter(Boolean);
  return `
    <div class="finance-custom-schedule-panel">
      ${customGroups.map(group => {
        const encodedId = financeEscapeAttr(encodeURIComponent(group.id));
        return `
          <div class="finance-schedule-stack finance-custom-schedule-group">
            ${(group.dates || []).map((row, index) => `
              <div class="finance-schedule-pair finance-custom-schedule-pair">
                <strong title="${financeEscapeAttr(group.label)}">${financeEscape(group.label)}${index ? ` ${index + 1}` : ''}</strong>
                <input class="finance-input" type="date" value="${financeEscapeAttr(row.date || '')}" onchange="financeCustomScheduleDateChange('${encodedId}',${index},'date',this.value)">
                <input class="finance-input" type="time" value="${financeEscapeAttr(row.time || '')}" onchange="financeCustomScheduleDateChange('${encodedId}',${index},'time',this.value)">
                ${index === 0 ? `
                  <span class="finance-custom-schedule-actions">
                    <button type="button" class="finance-custom-schedule-edit" title="Edit dates and PDF order" onclick="financeOpenCustomSchedule('${encodedId}')">Edit</button>
                    <button type="button" class="finance-schedule-remove" title="Delete ${financeEscapeAttr(group.label)}" aria-label="Delete ${financeEscapeAttr(group.label)}" onclick="financeDeleteCustomSchedule('${encodedId}')">&times;</button>
                  </span>
                ` : '<span></span>'}
              </div>
            `).join('')}
          </div>
        `;
      }).join('')}
    </div>
  `;
}

function ensureFinanceCustomScheduleModal() {
  let modal = document.getElementById('financeCustomScheduleModal');
  if (modal) return modal;
  modal = document.createElement('div');
  modal.id = 'financeCustomScheduleModal';
  modal.className = 'modal';
  modal.innerHTML = `
    <div class="modal-content finance-custom-schedule-modal">
      <div class="modal-header">
        <div><h3>Custom schedule dates</h3><small>Add a labelled date group and place it in the PDF schedule</small></div>
        <button type="button" class="close-btn" aria-label="Close custom schedule" onclick="closeModal('financeCustomScheduleModal')">&times;</button>
      </div>
      <div id="financeCustomScheduleBody"></div>
    </div>
  `;
  modal.addEventListener('click', event => {
    if (event.target === modal) closeModal('financeCustomScheduleModal');
  });
  document.body.appendChild(modal);
  return modal;
}

function financeOpenCustomSchedule(encodedGroupId = '') {
  if (!financeState.current) return;
  const groupId = encodedGroupId ? decodeURIComponent(encodedGroupId) : '';
  const group = financeCustomScheduleGroups().find(row => row.id === groupId);
  const token = group ? `custom:${group.id}` : '';
  const currentOrder = financeScheduleOrder();
  const baseOrder = currentOrder.filter(row => row !== token);
  Object.assign(financeCustomScheduleState, {
    editingId: group?.id || '',
    label: group?.label || '',
    dates: group?.dates?.length
      ? group.dates.map(row => ({ ...row }))
      : [{ id: `custom_date_${Date.now()}`, date: '', time: '' }],
    positionIndex: token ? Math.max(0, currentOrder.indexOf(token)) : -1,
    baseOrder
  });
  ensureFinanceCustomScheduleModal();
  financeRenderCustomScheduleModal();
  openModal('financeCustomScheduleModal');
  setTimeout(() => document.getElementById('financeCustomScheduleLabel')?.focus(), 40);
}

function financeSetCustomScheduleField(field, value) {
  if (field !== 'label') return;
  financeCustomScheduleState.label = value;
  const preview = document.getElementById('financeCustomSchedulePlacementLabel');
  if (preview) {
    const label = String(value || '').trim() || 'Custom date';
    preview.textContent = `${financeCustomScheduleState.positionIndex + 1}. ${label}`;
  }
}

function financeSetCustomScheduleDate(index, field, value) {
  const row = financeCustomScheduleState.dates[index];
  if (row && ['date', 'time'].includes(field)) row[field] = value;
}

function financeAddCustomScheduleDate() {
  financeCustomScheduleState.dates.push({
    id: `custom_date_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    date: '',
    time: ''
  });
  financeRenderCustomScheduleModal();
}

function financeRemoveCustomScheduleDate(index) {
  if (financeCustomScheduleState.dates.length <= 1) return;
  const [removed] = financeCustomScheduleState.dates.splice(index, 1);
  const batch = removed?.batchId
    ? financeScheduleBatches().find(row => row.id === removed.batchId)
    : null;
  if (batch) {
    const identity = financeScheduleIdentity(removed.date, removed.time);
    batch.excludedDates = [...new Set([...(batch.excludedDates || []), identity])];
  }
  financeRenderCustomScheduleModal();
}

function financeSetCustomSchedulePosition(index) {
  financeCustomScheduleState.positionIndex = Math.max(
    0,
    Math.min(financeCustomScheduleState.baseOrder.length, Number(index) || 0)
  );
  financeRenderCustomScheduleModal();
}

function financeCustomSchedulePositionLabel(index, order) {
  if (index <= 0) return `Before ${financeScheduleTokenLabel(order[0])}`;
  if (index >= order.length) return `After ${financeScheduleTokenLabel(order[order.length - 1])}`;
  return `Between ${financeScheduleTokenLabel(order[index - 1])} and ${financeScheduleTokenLabel(order[index])}`;
}

function financeCustomSchedulePlacementMarkup(state) {
  const previewLabel = String(state.label || '').trim() || 'Custom date';
  return Array.from({ length: state.baseOrder.length + 1 }, (_unused, index) => {
    const selected = state.positionIndex === index;
    const insertion = `
      <button
        type="button"
        class="finance-schedule-insertion${selected ? ' active' : ''}"
        aria-label="${financeEscapeAttr(financeCustomSchedulePositionLabel(index, state.baseOrder))}"
        aria-pressed="${selected ? 'true' : 'false'}"
        onclick="financeSetCustomSchedulePosition(${index})"
      >
        <span class="finance-schedule-insertion-line"></span>
        <span class="finance-schedule-insertion-control">
          <b${selected ? ' id="financeCustomSchedulePlacementLabel"' : ''}>${selected ? `${index + 1}. ${financeEscape(previewLabel)}` : '+'}</b>
          <small>${selected ? 'Custom date' : 'Place here'}</small>
        </span>
        <span class="finance-schedule-insertion-line"></span>
      </button>
    `;
    if (index >= state.baseOrder.length) return insertion;
    const token = state.baseOrder[index];
    const isCustom = token.startsWith('custom:');
    const stageNumber = index + 1 + (state.positionIndex >= 0 && state.positionIndex <= index ? 1 : 0);
    return `${insertion}
      <div class="finance-schedule-placement-stage${isCustom ? ' is-custom' : ''}">
        <span>${stageNumber}</span>
        <div>
          <strong>${financeEscape(financeScheduleTokenLabel(token))}</strong>
          <small>${isCustom ? 'Custom date' : 'Standard schedule'}</small>
        </div>
      </div>
    `;
  }).join('');
}

function financeRenderCustomScheduleModal() {
  const body = document.getElementById('financeCustomScheduleBody');
  if (!body) return;
  const state = financeCustomScheduleState;
  body.innerHTML = `
    <form onsubmit="financeSaveCustomSchedule(event)">
      <div class="finance-custom-schedule-content">
        <label class="finance-field"><span>Custom label</span><input id="financeCustomScheduleLabel" class="finance-input" maxlength="100" required placeholder="e.g. Handover" value="${financeEscapeAttr(state.label)}" oninput="financeSetCustomScheduleField('label',this.value)"></label>
        <div class="finance-custom-schedule-dates">
          <div class="finance-custom-schedule-subheading"><span>Date(s)</span><button type="button" class="btn btn-secondary" onclick="financeAddCustomScheduleDate()">+ Add date</button></div>
          ${state.dates.map((row, index) => `
            <div class="finance-custom-schedule-date-row">
              <label class="finance-field"><span>Date ${index + 1}</span><input class="finance-input" type="date" required value="${financeEscapeAttr(row.date || '')}" onchange="financeSetCustomScheduleDate(${index},'date',this.value)"></label>
              <label class="finance-field"><span>Time</span><input class="finance-input" type="time" value="${financeEscapeAttr(row.time || '')}" onchange="financeSetCustomScheduleDate(${index},'time',this.value)"></label>
              <button type="button" class="finance-schedule-remove" ${state.dates.length <= 1 ? 'disabled' : ''} title="Remove date" aria-label="Remove date ${index + 1}" onclick="financeRemoveCustomScheduleDate(${index})">&times;</button>
            </div>
          `).join('')}
        </div>
        <div class="finance-custom-schedule-position">
          <div class="finance-schedule-placement-heading">
            <span class="finance-bulk-schedule-label">Schedule position</span>
            <small>Select a line to place this custom date in the PDF order.</small>
          </div>
          <div class="finance-schedule-placement-flow">
            ${financeCustomSchedulePlacementMarkup(state)}
          </div>
          ${state.positionIndex < 0 ? '<p class="finance-schedule-placement-required">Choose one of the <b>+ Place here</b> rows before adding these dates.</p>' : ''}
        </div>
      </div>
      <div class="modal-actions finance-bulk-schedule-footer">
        <button type="button" class="btn btn-secondary" onclick="closeModal('financeCustomScheduleModal')">Cancel</button>
        <button type="submit" class="btn btn-primary">${state.editingId ? 'Update custom dates' : 'Add custom dates'}</button>
      </div>
    </form>
  `;
}

function financeSaveCustomSchedule(event) {
  event.preventDefault();
  if (!financeState.current) return;
  const state = financeCustomScheduleState;
  const label = String(state.label || '').trim();
  const dates = state.dates
    .filter(row => String(row.date || '').trim())
    .map(row => ({
      id: row.id,
      date: row.date,
      time: row.time || '',
      batchId: row.batchId || ''
    }));
  if (!label || !dates.length) {
    showNotification('warning', 'Enter a custom label and at least one date');
    return;
  }
  if (!Number.isInteger(state.positionIndex) || state.positionIndex < 0 || state.positionIndex > state.baseOrder.length) {
    showNotification('warning', 'Choose where the custom dates should appear in the schedule');
    return;
  }
  const groupId = state.editingId || `custom_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const groups = financeCustomScheduleGroups().filter(group => group.id !== groupId);
  groups.push({ id: groupId, label, dates });
  const order = [...state.baseOrder];
  order.splice(Math.min(state.positionIndex, order.length), 0, `custom:${groupId}`);
  financeState.current.customScheduleGroups = groups;
  financeState.current.scheduleOrder = order;
  financeRemoveEmptyScheduleBatches();
  closeModal('financeCustomScheduleModal');
  financeQueueSave();
  financeRenderEditor();
  showNotification('success', `${label} added to the schedule`);
}

async function financeDeleteCustomSchedule(encodedGroupId) {
  const groupId = decodeURIComponent(encodedGroupId);
  const group = financeCustomScheduleGroups().find(row => row.id === groupId);
  if (!group) return;
  const confirmed = await showAppConfirm({
    title: 'Delete custom dates?',
    message: `Delete ${group.label} and all dates under this label?`,
    confirmText: 'Delete',
    cancelText: 'Cancel',
    danger: true
  });
  if (!confirmed) return;
  financeState.current.customScheduleGroups = financeCustomScheduleGroups().filter(row => row.id !== groupId);
  financeState.current.scheduleOrder = financeScheduleOrder().filter(token => token !== `custom:${groupId}`);
  financeState.current.scheduleBatches = financeScheduleBatches().filter(row => row.kind !== `custom:${groupId}`);
  financeQueueSave();
  financeRenderEditor();
}

function financeToggleScheduleBatch(encodedBatchId) {
  const batchId = decodeURIComponent(encodedBatchId);
  financeState.expandedScheduleBatches[batchId] = !financeState.expandedScheduleBatches[batchId];
  financeRenderEditor();
}

async function financeDeleteScheduleBatch(encodedBatchId) {
  const batchId = decodeURIComponent(encodedBatchId);
  const batch = financeScheduleBatches().find(row => row.id === batchId);
  if (!batch) return;
  const confirmed = await showAppConfirm({
    title: 'Delete schedule',
    message: `Delete this ${financeScheduleKindLabel(batch.kind).toLowerCase()} schedule and all of its dates?`,
    confirmText: 'Delete schedule',
    cancelText: 'Cancel',
    destructive: true
  });
  if (!confirmed) return;
  financeScheduleKindOptions().forEach(({ value: kind }) => {
    financeReplaceScheduleRowsForKind(
      kind,
      financeScheduleRowsForKind(kind).filter(row => row.batchId !== batchId)
    );
  });
  financeState.current.scheduleBatches = financeScheduleBatches().filter(row => row.id !== batchId);
  delete financeState.expandedScheduleBatches[batchId];
  financeQueueSave();
  financeRenderEditor();
}

function financeDuplicateScheduleBatch(encodedBatchId) {
  const batchId = decodeURIComponent(encodedBatchId);
  const batch = financeScheduleBatches().find(row => row.id === batchId);
  if (batch) financeOpenBulkSchedule(batch.kind, batchId, true);
}

function financeScheduleIsoDate(year, month, day) {
  const value = new Date(Date.UTC(year, month - 1, day));
  if (
    value.getUTCFullYear() !== year
    || value.getUTCMonth() !== month - 1
    || value.getUTCDate() !== day
  ) return '';
  return value.toISOString().slice(0, 10);
}

function financeParseBulkScheduleLine(value) {
  const original = String(value || '').trim();
  if (!original) return null;
  let dateText = original;
  let time = '';
  const timeMatch = dateText.match(/(?:,\s*|\s+)(\d{1,2}):(\d{2})(?:\s*hrs?)?\s*$/i);
  if (timeMatch) {
    const hour = Number(timeMatch[1]);
    const minute = Number(timeMatch[2]);
    if (hour > 23 || minute > 59) return { error: 'Invalid time', original };
    time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    dateText = dateText.slice(0, timeMatch.index).trim().replace(/,$/, '').trim();
  }

  let date = '';
  let match = dateText.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (match) {
    date = financeScheduleIsoDate(Number(match[1]), Number(match[2]), Number(match[3]));
  }
  if (!date) {
    match = dateText.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/);
    if (match) date = financeScheduleIsoDate(Number(match[3]), Number(match[2]), Number(match[1]));
  }
  if (!date) {
    const monthNames = {
      jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3,
      apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
      aug: 8, august: 8, sep: 9, sept: 9, september: 9,
      oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12
    };
    match = dateText.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
    if (match && monthNames[match[2].toLowerCase()]) {
      date = financeScheduleIsoDate(Number(match[3]), monthNames[match[2].toLowerCase()], Number(match[1]));
    }
  }
  return date ? { date, time, original } : { error: 'Unrecognised date', original };
}

function financeBriefScheduleKind(value, fallbackKind) {
  const label = String(value || '').split(':', 1)[0].trim().toLowerCase();
  if (/\b(?:tear\s*down|strike|return)\b/.test(label)) return 'teardown';
  if (/\b(?:set\s*up|delivery|collection)\b/.test(label)) return 'setup';
  if (/\brehears/.test(label)) return 'rehearsal';
  if (/\b(?:event|show)\b/.test(label)) return 'show';
  return financeScheduleKindExists(fallbackKind) ? fallbackKind : 'show';
}

function financeBriefStartTime(value) {
  const text = String(value || '').replace(/[\u2013\u2014]/g, '-');
  let match = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*-\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (match) {
    const suffix = String(match[3] || match[6] || '').toLowerCase();
    let hour = Number(match[1]);
    const minute = Number(match[2] || 0);
    if (hour >= 1 && hour <= 12 && minute <= 59) {
      if (suffix === 'pm' && hour !== 12) hour += 12;
      if (suffix === 'am' && hour === 12) hour = 0;
      return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    }
  }
  match = text.match(/\b(\d{1,2})(?::(\d{2}))\s*(?:hrs?)?\b/i);
  if (match && Number(match[1]) <= 23 && Number(match[2]) <= 59) {
    return `${String(Number(match[1])).padStart(2, '0')}:${String(Number(match[2])).padStart(2, '0')}`;
  }
  match = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (!match) return '';
  let hour = Number(match[1]);
  const minute = Number(match[2] || 0);
  if (hour < 1 || hour > 12 || minute > 59) return '';
  if (match[3].toLowerCase() === 'pm' && hour !== 12) hour += 12;
  if (match[3].toLowerCase() === 'am' && hour === 12) hour = 0;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function financeBriefMonthNumber(value) {
  const months = {
    jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3,
    apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
    aug: 8, august: 8, sep: 9, sept: 9, september: 9,
    oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12
  };
  return months[String(value || '').trim().toLowerCase()] || 0;
}

function financeBriefDateRange(startDay, startMonth, endDay, endMonth, year) {
  let startYear = Number(year);
  let endYear = Number(year);
  if (Number(startMonth) > Number(endMonth)) endYear += 1;
  const startIso = financeScheduleIsoDate(startYear, Number(startMonth), Number(startDay));
  const endIso = financeScheduleIsoDate(endYear, Number(endMonth), Number(endDay));
  const start = financeScheduleDate(startIso);
  const end = financeScheduleDate(endIso);
  if (!start || !end || end < start) return [];
  const dates = [];
  for (let cursor = new Date(start); cursor <= end && dates.length < 500; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    dates.push(cursor.toISOString().slice(0, 10));
  }
  return dates;
}

function financeParseClientBriefLine(value, fallbackKind, fallbackYear) {
  const original = String(value || '').trim();
  if (!original) return { rows: [] };
  const simple = financeParseBulkScheduleLine(original);
  if (simple?.date) {
    return {
      rows: [{
        kind: fallbackKind,
        date: simple.date,
        time: simple.time || ''
      }]
    };
  }

  const kind = financeBriefScheduleKind(original, fallbackKind);
  const time = financeBriefStartTime(original);
  const year = Number(fallbackYear) || new Date().getFullYear();
  const dates = [];
  let dateText = original
    .replace(/^[^:]+:\s*/, '')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\b\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s*-\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/gi, ' ')
    .replace(/\b\d{1,2}:\d{2}\s*(?:hrs?)?\b/gi, ' ')
    .replace(/\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/gi, ' ');
  const monthPattern = 'Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t|tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?';
  const rangePattern = new RegExp(
    `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s*(${monthPattern})?\\s*-\\s*(\\d{1,2})(?:st|nd|rd|th)?\\s*(${monthPattern})(?:\\s+(\\d{4}))?\\b`,
    'gi'
  );
  dateText = dateText.replace(rangePattern, (...match) => {
    const startMonth = financeBriefMonthNumber(match[2] || match[4]);
    const endMonth = financeBriefMonthNumber(match[4]);
    const rangeYear = Number(match[5]) || year;
    dates.push(...financeBriefDateRange(match[1], startMonth, match[3], endMonth, rangeYear));
    return ' ';
  });

  const listPattern = new RegExp(
    `\\b((?:\\d{1,2}(?:st|nd|rd|th)?\\s*(?:(?:,|and|&)\\s*)?)+)\\s*(${monthPattern})(?:\\s+(\\d{4}))?\\b`,
    'gi'
  );
  dateText.replace(listPattern, (...match) => {
    const month = financeBriefMonthNumber(match[2]);
    const listYear = Number(match[3]) || year;
    (match[1].match(/\d{1,2}/g) || []).forEach(day => {
      const date = financeScheduleIsoDate(listYear, month, Number(day));
      if (date) dates.push(date);
    });
    return match[0];
  });

  const uniqueDates = [...new Set(dates)].sort();
  if (!uniqueDates.length) return { rows: [], error: 'Unrecognised date', original };
  return {
    rows: uniqueDates.map(date => ({ kind, date, time }))
  };
}

function financeBulkScheduleCandidates() {
  const state = financeScheduleBulkState;
  const candidates = [];
  const invalid = [];
  let truncated = false;
  if (state.method === 'recurring') {
    const start = financeScheduleDate(state.startDate);
    const end = financeScheduleDate(state.endDate);
    if (!start || !end || end < start) {
      invalid.push('Choose a valid start and end date.');
    } else {
      const selectedWeekdays = state.weekdays || [];
      const interval = Math.max(1, Math.min(52, Number(state.intervalWeeks || 1)));
      for (let cursor = new Date(start); cursor <= end; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
        const elapsedDays = Math.round((cursor - start) / 86400000);
        const weekIndex = Math.floor(elapsedDays / 7);
        const everyDay = selectedWeekdays.length === 0;
        if (everyDay || (selectedWeekdays.includes(cursor.getUTCDay()) && weekIndex % interval === 0)) {
          candidates.push({ kind: state.kind, date: cursor.toISOString().slice(0, 10), time: state.time || '' });
          if (candidates.length >= 500) {
            truncated = true;
            break;
          }
        }
      }
    }
  } else {
    const referenceYear = Number(String(state.startDate || financeTodayIso()).slice(0, 4));
    String(state.pasteText || '').split(/\r?\n/).forEach((line, index) => {
      if (!line.trim() || candidates.length >= 500) return;
      const parsed = financeParseClientBriefLine(line, state.kind, referenceYear);
      if (parsed?.error) invalid.push(`Line ${index + 1}: ${parsed.error} (${parsed.original})`);
      (parsed?.rows || []).forEach(row => {
        const targetKind = financeCustomScheduleGroupForKind(state.kind) ? state.kind : row.kind;
        if (candidates.length < 500 && (!state.restrictPasteKind || targetKind === state.kind)) {
          candidates.push({ ...row, kind: targetKind, time: row.time || state.time || '' });
        }
      });
    });
    truncated = candidates.length >= 500;
  }

  const scheduleKinds = financeScheduleKindOptions().map(option => option.value);
  const existing = new Map(scheduleKinds.map(kind => [kind, new Set()]));
  scheduleKinds.forEach(kind => {
    const primaryDate = FINANCE_SCHEDULE_KEYS[kind] ? financeState.current?.[`${kind}Date`] : '';
    if (primaryDate) {
      existing.get(kind).add(financeScheduleIdentity(primaryDate, financeState.current?.[`${kind}Time`]));
    }
    financeScheduleRowsForKind(kind).forEach(row => {
      if (!state.editingBatchId || row.batchId !== state.editingBatchId) {
        existing.get(kind).add(financeScheduleIdentity(row.date, row.time));
      }
    });
  });

  const seen = new Set();
  const rows = candidates.map((row, index) => {
    const kind = financeScheduleKindExists(row.kind) ? row.kind : state.kind;
    const scheduleIdentity = financeScheduleIdentity(row.date, row.time);
    const identity = `${kind}|${scheduleIdentity}`;
    const duplicate = existing.get(kind).has(scheduleIdentity) || seen.has(identity);
    seen.add(identity);
    return {
      ...row,
      kind,
      identity,
      scheduleIdentity,
      id: `${identity}_${index}`,
      duplicate,
      selected: !duplicate && !state.excluded[identity]
    };
  });

  if (state.initialiseExclusions) {
    const initial = new Set(state.initialBatchIdentities || []);
    rows.forEach(row => {
      if (!row.duplicate && !initial.has(row.identity)) state.excluded[row.identity] = true;
    });
    state.initialiseExclusions = false;
    rows.forEach(row => { row.selected = !row.duplicate && !state.excluded[row.identity]; });
  }
  return { rows, invalid, truncated };
}

function ensureFinanceBulkScheduleModal() {
  let modal = document.getElementById('financeBulkScheduleModal');
  if (modal) return modal;
  modal = document.createElement('div');
  modal.id = 'financeBulkScheduleModal';
  modal.className = 'modal';
  modal.innerHTML = `
    <div class="modal-content finance-bulk-schedule-modal">
      <div class="modal-header">
        <div><h3>Bulk add schedule dates</h3><small>Create recurring dates or paste an existing schedule</small></div>
        <button type="button" class="close-btn" aria-label="Close schedule builder" onclick="closeModal('financeBulkScheduleModal')">&times;</button>
      </div>
      <div id="financeBulkScheduleBody"></div>
    </div>
  `;
  modal.addEventListener('click', event => {
    if (event.target === modal) closeModal('financeBulkScheduleModal');
  });
  document.body.appendChild(modal);
  return modal;
}

function financeOpenBulkSchedule(kind = 'show', encodedBatchId = '', duplicate = false) {
  if (!financeState.current || !financeScheduleKindExists(kind)) return;
  const batchId = encodedBatchId ? decodeURIComponent(encodedBatchId) : '';
  const source = batchId ? financeScheduleBatches().find(row => row.id === batchId) : null;
  const defaultDate = financeCustomScheduleGroupForKind(kind)?.dates?.[0]?.date
    || financeState.current[`${kind}Date`]
    || financeState.current.showDate
    || financeState.current.setupDate
    || financeState.current.rehearsalDate
    || financeState.current.teardownDate
    || financeState.current.quotationDate
    || financeTodayIso();
  const defaultDay = financeScheduleDate(defaultDate)?.getUTCDay() ?? new Date().getDay();
  Object.assign(financeScheduleBulkState, {
    kind: source?.kind || kind,
    method: source?.method || 'recurring',
    editingBatchId: source && !duplicate ? source.id : '',
    startDate: source?.startDate || defaultDate,
    endDate: source?.endDate || defaultDate,
    weekdays: source ? [...(source.weekdays || [])] : [defaultDay],
    intervalWeeks: Math.max(1, Number(source?.intervalWeeks || 1)),
    time: source?.time || '',
    pasteText: source?.pasteText || '',
    excluded: Object.fromEntries(
      (source?.excludedDates || []).map(identity => [`${source.kind}|${identity}`, true])
    ),
    initialBatchIdentities: source && !duplicate
      ? financeScheduleBatchRows(source.kind, source.id)
        .map(item => `${source.kind}|${financeScheduleIdentity(item.row.date, item.row.time)}`)
      : [],
    initialiseExclusions: !!(source && !duplicate),
    restrictPasteKind: !!source
  });
  ensureFinanceBulkScheduleModal();
  financeRenderBulkScheduleModal();
  openModal('financeBulkScheduleModal');
}

function financeSetBulkScheduleKind(kind) {
  if (!financeScheduleKindExists(kind)) return;
  financeScheduleBulkState.kind = kind;
  financeScheduleBulkState.excluded = {};
  financeRenderBulkScheduleModal();
}

function financeSetBulkScheduleMethod(method) {
  if (!['recurring', 'paste'].includes(method)) return;
  financeScheduleBulkState.method = method;
  financeScheduleBulkState.excluded = {};
  financeRenderBulkScheduleModal();
}

function financeSetBulkScheduleField(field, value) {
  if (!['startDate', 'endDate', 'intervalWeeks', 'time', 'pasteText'].includes(field)) return;
  financeScheduleBulkState[field] = value;
  financeRenderBulkSchedulePreview();
}

function financeToggleBulkScheduleWeekday(day) {
  const value = Number(day);
  const days = new Set(financeScheduleBulkState.weekdays || []);
  if (days.has(value)) days.delete(value);
  else days.add(value);
  financeScheduleBulkState.weekdays = [...days].sort((a, b) => a - b);
  financeRenderBulkScheduleModal();
}

function financeToggleBulkScheduleDate(encodedIdentity, checked) {
  const identity = decodeURIComponent(encodedIdentity);
  if (checked) delete financeScheduleBulkState.excluded[identity];
  else financeScheduleBulkState.excluded[identity] = true;
  financeRenderBulkSchedulePreview();
}

function financeRenderBulkScheduleModal() {
  const body = document.getElementById('financeBulkScheduleBody');
  if (!body) return;
  const state = financeScheduleBulkState;
  body.innerHTML = `
    <form onsubmit="financeApplyBulkSchedule(event)">
      <div class="finance-bulk-schedule-content">
        <div class="finance-bulk-schedule-section">
          <span class="finance-bulk-schedule-label">Schedule type</span>
          <div class="finance-schedule-segments finance-schedule-type-segments">
            ${financeScheduleKindOptions().map(option => `
              <button type="button" class="${state.kind === option.value ? 'active' : ''}${option.custom ? ' is-custom' : ''}" onclick="financeSetBulkScheduleKind('${financeEscapeAttr(option.value)}')">${financeEscape(option.label)}</button>
            `).join('')}
          </div>
        </div>
        <div class="finance-bulk-schedule-section">
          <span class="finance-bulk-schedule-label">Entry method</span>
          <div class="finance-schedule-segments finance-schedule-methods">
            <button type="button" class="${state.method === 'recurring' ? 'active' : ''}" onclick="financeSetBulkScheduleMethod('recurring')">Recurring range</button>
            <button type="button" class="${state.method === 'paste' ? 'active' : ''}" onclick="financeSetBulkScheduleMethod('paste')">Paste dates</button>
          </div>
        </div>
        ${state.method === 'recurring' ? `
          <div class="finance-bulk-schedule-grid">
            <label class="finance-field"><span>From</span><input class="finance-input" type="date" value="${financeEscapeAttr(state.startDate)}" onchange="financeSetBulkScheduleField('startDate',this.value)"></label>
            <label class="finance-field"><span>To</span><input class="finance-input" type="date" value="${financeEscapeAttr(state.endDate)}" onchange="financeSetBulkScheduleField('endDate',this.value)"></label>
            <label class="finance-field"><span>Time</span><input class="finance-input" type="time" value="${financeEscapeAttr(state.time)}" onchange="financeSetBulkScheduleField('time',this.value)"></label>
            <label class="finance-field finance-schedule-repeat-field${state.weekdays.length ? '' : ' is-disabled'}"><span>Repeat every</span><span class="finance-schedule-interval"><input class="finance-input" type="number" min="1" max="52" value="${financeEscapeAttr(state.intervalWeeks)}" onchange="financeSetBulkScheduleField('intervalWeeks',this.value)" ${state.weekdays.length ? '' : 'disabled'}><small>week(s)</small></span></label>
          </div>
          <div class="finance-bulk-schedule-section">
            <span class="finance-bulk-schedule-label">Repeat on${state.weekdays.length ? '' : ' - Every day'}</span>
            <div class="finance-schedule-weekdays">
              ${FINANCE_WEEKDAYS.map((label, day) => `<button type="button" class="${state.weekdays.includes(day) ? 'active' : ''}" onclick="financeToggleBulkScheduleWeekday(${day})">${label}</button>`).join('')}
            </div>
          </div>
        ` : `
          <div class="finance-bulk-schedule-paste">
            <label class="finance-field"><span>Dates, times or client brief</span><textarea class="finance-input" rows="8" placeholder="Event Date and Time: 18th Sep 2027, 7-10pm&#10;Setup Date(s): 16th - 18th Sep 2027&#10;AV rehearsal dates: 16th and 17th Sep 2027 (9am - 7pm)" oninput="financeSetBulkScheduleField('pasteText',this.value)">${financeEscape(state.pasteText)}</textarea></label>
            <label class="finance-field"><span>Default time when omitted</span><input class="finance-input" type="time" value="${financeEscapeAttr(state.time)}" onchange="financeSetBulkScheduleField('time',this.value)"></label>
          </div>
        `}
        <div id="financeBulkSchedulePreview"></div>
      </div>
      <div class="modal-actions finance-bulk-schedule-footer">
        <button type="button" class="btn btn-secondary" onclick="closeModal('financeBulkScheduleModal')">Cancel</button>
        <button id="financeBulkScheduleSubmit" type="submit" class="btn btn-primary">Add dates</button>
      </div>
    </form>
  `;
  financeRenderBulkSchedulePreview();
}

function financeRenderBulkSchedulePreview() {
  const container = document.getElementById('financeBulkSchedulePreview');
  if (!container) return;
  const preview = financeBulkScheduleCandidates();
  const selected = preview.rows.filter(row => row.selected).length;
  const duplicates = preview.rows.filter(row => row.duplicate).length;
  const submit = document.getElementById('financeBulkScheduleSubmit');
  if (submit) {
    submit.disabled = selected === 0;
    submit.textContent = financeScheduleBulkState.editingBatchId
      ? `Update ${selected} date${selected === 1 ? '' : 's'}`
      : `Add ${selected} date${selected === 1 ? '' : 's'}`;
  }
  container.innerHTML = `
    <div class="finance-bulk-preview-heading">
      <div><strong>Preview</strong><small>${selected} date${selected === 1 ? '' : 's'} selected</small></div>
      <div class="finance-bulk-preview-counts">
        ${duplicates ? `<span>${duplicates} duplicate${duplicates === 1 ? '' : 's'} skipped</span>` : ''}
        ${preview.truncated ? '<span class="is-warning">Limited to 500 dates</span>' : ''}
      </div>
    </div>
    ${preview.invalid.length ? `<div class="finance-bulk-preview-errors">${preview.invalid.map(message => `<span>${financeEscape(message)}</span>`).join('')}</div>` : ''}
    <div class="finance-bulk-preview-list">
      ${preview.rows.map(row => `
        <label class="finance-bulk-preview-row ${row.duplicate ? 'is-duplicate' : ''}">
          <input type="checkbox" ${row.selected ? 'checked' : ''} ${row.duplicate ? 'disabled' : ''} onchange="financeToggleBulkScheduleDate('${financeEscapeAttr(encodeURIComponent(row.identity))}',this.checked)">
          <span><strong>${financeEscape(financeScheduleDateLabel(row.date, 'long'))}</strong><small><b class="finance-bulk-preview-kind">${financeEscape(financeScheduleKindLabel(row.kind))}</b>${row.time ? `${financeEscape(row.time)}hrs` : 'No time'}</small></span>
          ${row.duplicate ? '<em>Already added</em>' : ''}
        </label>
      `).join('') || '<div class="finance-suggestion-empty">Enter a schedule to preview its dates.</div>'}
    </div>
  `;
}

function financeApplyBulkSchedule(event) {
  event.preventDefault();
  if (!financeState.current) return;
  const state = financeScheduleBulkState;
  const preview = financeBulkScheduleCandidates();
  const selected = preview.rows.filter(row => row.selected && !row.duplicate);
  if (!selected.length) {
    showNotification('warning', 'Choose at least one date to add');
    return;
  }
  const batchId = state.editingBatchId || `schedule_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  if (state.editingBatchId) {
    financeScheduleKindOptions().forEach(({ value: kind }) => {
      financeReplaceScheduleRowsForKind(
        kind,
        financeScheduleRowsForKind(kind).filter(row => row.batchId !== batchId)
      );
    });
    financeState.current.scheduleBatches = financeScheduleBatches().filter(row => row.id !== batchId);
  }

  const grouped = selected.reduce((result, row) => {
    const kind = financeScheduleKindExists(row.kind) ? row.kind : state.kind;
    (result[kind] || (result[kind] = [])).push(row);
    return result;
  }, {});
  const newBatches = [];
  Object.entries(grouped).forEach(([kind, rows]) => {
    const groupBatchId = state.editingBatchId
      ? batchId
      : Object.keys(grouped).length === 1
        ? batchId
        : `${batchId}_${kind}`;
    const targetRows = financeScheduleRowsForKind(kind);
    rows.forEach((row, index) => targetRows.push({
      id: `${groupBatchId}_${index + 1}`,
      date: row.date,
      time: row.time,
      batchId: groupBatchId
    }));
    targetRows.sort((left, right) =>
      String(left.date || '').localeCompare(String(right.date || ''))
      || String(left.time || '').localeCompare(String(right.time || ''))
    );
    financeReplaceScheduleRowsForKind(kind, targetRows);
    newBatches.push({
      id: groupBatchId,
      kind,
      method: state.method,
      startDate: state.startDate,
      endDate: state.endDate,
      weekdays: [...state.weekdays],
      intervalWeeks: Math.max(1, Number(state.intervalWeeks || 1)),
      time: state.time || '',
      pasteText: state.method === 'paste' ? state.pasteText : '',
      excludedDates: preview.rows
        .filter(row => row.kind === kind && !row.duplicate && !row.selected)
        .map(row => row.scheduleIdentity)
    });
    financeState.expandedScheduleBatches[groupBatchId] = false;
  });
  financeState.current.scheduleBatches = [
    ...financeScheduleBatches().filter(row => row.id !== batchId),
    ...newBatches
  ];
  closeModal('financeBulkScheduleModal');
  financeQueueSave();
  financeRenderEditor();
  showNotification('success', `${selected.length} schedule date${selected.length === 1 ? '' : 's'} added`);
}

function financePercent(value, fallback = 0) {
  return Math.max(-9999, Math.min(100, financeNumber(value, fallback)));
}

function financeLineTotal(line) {
  if (
    line?.totalMode === 'amount'
    && line.total !== null
    && line.total !== undefined
    && String(line.total).trim() !== ''
  ) {
    return Math.round(Math.max(0, financeCurrencyNumber(line.total)) * 100) / 100;
  }
  const gross = financeNumber(line.quantity, 1) * financeNumber(line.days, 1) * financeNumber(line.unitPrice);
  return Math.round(gross * (1 - financeNumber(line.discountPercent) / 100) * 100) / 100;
}

function financeLinePriceMatchKey(line) {
  const catalogKey = String(line?.catalogKey || '').trim().toLowerCase();
  if (catalogKey) return `catalog:${catalogKey}`;
  const sourceAssetIds = [...new Set((line?.sourceAssetIds || [])
    .map(value => String(value || '').trim().toLowerCase())
    .filter(Boolean))]
    .sort();
  if (sourceAssetIds.length) return `assets:${sourceAssetIds.join('|')}`;
  const brand = String(line?.brand || '').trim().toLowerCase();
  const model = String(line?.model || '').trim().toLowerCase();
  const description = String(line?.description || '').trim().toLowerCase();
  if (!brand && !model && !description) return '';
  return `item:${brand}|${model}|${description}|${String(line?.uom || 'units').trim().toLowerCase()}`;
}

function financePropagateLineUnitPrice(sourceLine) {
  if (sourceLine?.groupId || sourceLine?.hiddenFromQuotation) return;
  const matchKey = financeLinePriceMatchKey(sourceLine);
  if (!matchKey) return;
  const unitPrice = financeNumber(sourceLine.unitPrice);
  (financeState.current?.lineItems || []).forEach(line => {
    if (line.hiddenFromQuotation || financeLinePriceMatchKey(line) !== matchKey) return;
    line.unitPrice = unitPrice;
    line.totalMode = 'calculated';
    line.total = financeLineTotal(line);
  });
}

function financeCaptureGroupItemCommercial(line, force = false) {
  if (!line) return;
  const hasStoredPrice = line.groupItemCommercialStored === true
    || (line.groupItemCommercialStored === undefined && line.groupItemUnitPrice !== undefined && line.groupItemUnitPrice !== null);
  if (!force && hasStoredPrice) return;
  line.groupItemDays = Math.max(0, financeNumber(line.days, 1));
  line.groupItemQuantity = Math.max(0, financeNumber(line.groupItemQuantity, line.quantity ?? 1));
  line.groupItemUom = String(line.uom || 'units');
  line.groupItemUnitPrice = Math.max(0, financeNumber(line.unitPrice));
  line.groupItemDiscountPercent = Math.max(-9999, Math.min(100, financeNumber(line.discountPercent)));
  line.groupItemTotalMode = line.totalMode === 'amount' ? 'amount' : 'calculated';
  line.groupItemTotal = Math.max(0, financeLineTotal(line));
  line.groupItemCommercialStored = true;
}

function financeGroupItemPriceContribution(line) {
  if (line?.groupItemPriceContribution !== undefined && line?.groupItemPriceContribution !== null) {
    return Math.max(0, financeNumber(line.groupItemPriceContribution));
  }
  const discount = Math.max(-9999, Math.min(100, financeNumber(line?.groupItemDiscountPercent)));
  return Math.max(0, financeNumber(line?.groupItemQuantity, 1))
    * Math.max(0, financeNumber(line?.groupItemUnitPrice))
    * (1 - discount / 100);
}

function financeCalculatedGroupItemContribution(line) {
  const discount = Math.max(-9999, Math.min(100, financeNumber(line?.groupItemDiscountPercent)));
  return Math.max(0, financeNumber(line?.groupItemQuantity, 1))
    * Math.max(0, financeNumber(line?.groupItemUnitPrice))
    * (1 - discount / 100);
}

function financeGroupPricingMode(lines) {
  const members = Array.isArray(lines) ? lines : [lines];
  return members.some(line => String(line?.groupPricingMode || '').toLowerCase() === 'total')
    ? 'total'
    : 'items';
}

function financeSetGroupPricingMode(lines, mode) {
  const nextMode = mode === 'total' ? 'total' : 'items';
  (lines || []).forEach(line => { line.groupPricingMode = nextMode; });
}

function financeRecalculateGroupPriceFromItems(groupId, subprojectId) {
  const members = financeLineGroupMembers(groupId, subprojectId);
  const leader = members.find(line => line.groupLeader) || members[0];
  if (!leader) return null;
  financeSetGroupPricingMode(members, 'items');
  leader.unitPrice = Math.round(members.reduce(
    (sum, line) => sum + financeGroupItemPriceContribution(line), 0
  ) * 100) / 100;
  leader.totalMode = 'calculated';
  leader.total = financeLineTotal(leader);
  return leader;
}

function financeRestoreGroupItemCommercial(line) {
  if (!line) return;
  line.days = Math.max(0, financeNumber(line.groupItemDays, 1));
  line.quantity = Math.max(0, financeNumber(line.groupItemQuantity, 1));
  line.uom = String(line.groupItemUom || 'units');
  line.unitPrice = Math.max(0, financeNumber(line.groupItemUnitPrice));
  line.discountPercent = Math.max(-9999, Math.min(100, financeNumber(line.groupItemDiscountPercent)));
  line.totalMode = line.groupItemTotalMode === 'amount' ? 'amount' : 'calculated';
  line.total = line.totalMode === 'amount'
    ? Math.max(0, financeNumber(line.groupItemTotal))
    : financeLineTotal(line);
}

function financeClearLineGroupFields(line) {
  if (!line) return;
  [
    'groupId', 'groupTitle', 'groupDisplayFields', 'groupCustomText',
    'groupPlaceholder', 'isContainerGroup', 'containerId',
    'groupItemQuantity', 'groupHeaderQuantity', 'groupLeader',
    'groupItemDays', 'groupItemUom', 'groupItemUnitPrice',
    'groupItemDiscountPercent', 'groupItemTotalMode', 'groupItemTotal',
    'groupItemPriceContribution', 'groupItemCommercialStored', 'groupPricingMode'
  ].forEach(key => delete line[key]);
}

function financeNormaliseLineGroups(document = financeState.current) {
  const groups = new Map();
  (document?.lineItems || []).forEach(line => {
    const groupId = String(line.groupId || '');
    if (!groupId) return;
    const key = `${line.subprojectId || 'main'}::${groupId}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(line);
  });
  groups.forEach(lines => {
    const explicitLeader = lines.find(line => line.groupLeader);
    const leader = explicitLeader || lines[0];
    const groupPricingMode = financeGroupPricingMode(lines);
    lines.forEach(line => financeCaptureGroupItemCommercial(line, !explicitLeader));
    const legacyTotal = explicitLeader
      ? financeLineTotal(leader)
      : lines.reduce((sum, line) => sum + financeLineTotal(line), 0);
    const header = explicitLeader ? {
      days: financeNumber(leader.days, 1),
      quantity: financeNumber(leader.quantity, 1),
      uom: leader.uom || 'sets',
      unitPrice: financeNumber(leader.unitPrice),
      discountPercent: financeNumber(leader.discountPercent),
      total: legacyTotal
    } : {
      days: 1,
      quantity: 1,
      uom: 'sets',
      unitPrice: legacyTotal,
      discountPercent: 0,
      total: legacyTotal
    };
    const groupSystemName = String(
      leader.systemName || financeDefaultSystemName(leader.department)
    );
    lines.forEach(line => {
      if (line.groupItemQuantity === undefined || line.groupItemQuantity === null) {
        line.groupItemQuantity = financeNumber(line.quantity, 1);
      }
      if (line.groupItemPriceContribution === undefined || line.groupItemPriceContribution === null) {
        const headerFactor = header.days * header.quantity * (1 - header.discountPercent / 100);
        line.groupItemPriceContribution = !explicitLeader && headerFactor
          ? Math.max(0, financeNumber(line.groupItemTotal)) / headerFactor
          : 0;
      }
      line.groupLeader = line === leader;
      line.groupHeaderQuantity = header.quantity;
      line.groupPricingMode = groupPricingMode;
      line.days = header.days;
      line.quantity = header.quantity;
      line.uom = header.uom;
      line.unitPrice = header.unitPrice;
      line.discountPercent = header.discountPercent;
      line.totalMode = 'amount';
      line.total = line === leader ? header.total : 0;
      line.systemName = groupSystemName;
    });
  });
}

function financeDefaultSystemName(department) {
  const value = String(department || '').trim();
  if (!value) return 'Unknown';
  const base = value.replace(/\s+(department|system)$/i, '').trim();
  if (base.toLowerCase() === 'manpower') return 'Manpower';
  if (['transport', 'transportation'].includes(base.toLowerCase())) return 'Transportation';
  return base || 'Unknown';
}

function financeLineSystem(line) {
  return String(line?.systemName || '').trim() || financeDefaultSystemName(line?.department);
}

function financeNormalisedDepartmentName(value) {
  return String(value || '')
    .trim()
    .replace(/\s+(department|system)$/i, '')
    .trim()
    .toLocaleLowerCase();
}

function financeDepartmentIdentity(line) {
  const code = String(line?.departmentCode || '').trim().toLocaleLowerCase();
  if (code && code !== 'un') return `code:${code}`;
  const name = financeNormalisedDepartmentName(line?.department);
  return `name:${name || 'general'}`;
}

function financeSameOperationalDepartment(left, right) {
  const leftCode = String(left?.departmentCode || '').trim().toLocaleLowerCase();
  const rightCode = String(right?.departmentCode || '').trim().toLocaleLowerCase();
  if (leftCode && rightCode && leftCode !== 'un' && rightCode !== 'un') {
    return leftCode === rightCode;
  }
  const leftName = financeNormalisedDepartmentName(left?.department);
  const rightName = financeNormalisedDepartmentName(right?.department);
  return !!leftName && leftName === rightName;
}

function financeIsRenamedCategory(line) {
  const category = financeLineSystem(line).toLocaleLowerCase();
  const defaultCategory = financeDefaultSystemName(line?.department).toLocaleLowerCase();
  return !!category && category !== defaultCategory;
}

function financePreferredCatalogCategory(selected, document = financeState.current) {
  const subprojectId = financeCurrentSubprojectId(document);
  const matches = (document?.lineItems || []).filter(line => (
    String(line.subprojectId || 'main') === String(subprojectId)
    && financeSameOperationalDepartment(line, selected)
  ));
  const newest = rows => [...rows].reverse();
  return (
    newest(matches).find(financeIsRenamedCategory)
    || newest(matches)[0]
    || null
  );
}

function financeCatalogCategory(selected, explicitCategory = '') {
  const requested = String(explicitCategory || '').trim();
  if (requested) return requested;
  const existing = financePreferredCatalogCategory(selected);
  if (existing && financeIsRenamedCategory(existing)) {
    return financeLineSystem(existing);
  }
  const productCategory = String(selected?.productCategory || '').trim();
  if (productCategory) return productCategory;
  return existing ? financeLineSystem(existing) : financeDefaultSystemName(selected?.department);
}

function financeCategoryOperationalDepartment(category, subprojectId = financeCurrentSubprojectId()) {
  const target = String(category || '').trim().toLocaleLowerCase();
  if (!target) return null;
  const totals = new Map();
  (financeState.current?.lineItems || []).forEach((line, index) => {
    if (
      line.isCustom
      || String(line.subprojectId || 'main') !== String(subprojectId || 'main')
      || financeLineSystem(line).toLocaleLowerCase() !== target
    ) return;
    const key = financeDepartmentIdentity(line);
    const quantity = Math.max(0, financeNumber(
      line.groupId ? line.groupItemQuantity : line.quantity,
      0
    )) * (line.groupId ? Math.max(0, financeNumber(line.quantity, 1)) : 1);
    const current = totals.get(key) || {
      department: String(line.department || 'General'),
      departmentCode: String(line.departmentCode || ''),
      quantity: 0,
      firstIndex: index
    };
    current.quantity += quantity || 1;
    totals.set(key, current);
  });
  return [...totals.values()].sort((left, right) => (
    right.quantity - left.quantity || left.firstIndex - right.firstIndex
  ))[0] || null;
}

function financeIsOptionalCategory(value) {
  return /\boptional\b/i.test(String(value || ''));
}

function financeLineIsOptional(line) {
  return financeIsOptionalCategory(financeLineSystem(line));
}

function financeAdjustmentCountsTowardTotal(row) {
  return row?.scope !== 'department' || !financeIsOptionalCategory(row?.department);
}

function financeRecalculateAdjustments(document) {
  const lines = document?.lineItems || [];
  const adjustments = document?.adjustments || [];
  adjustments.filter(row => row.scope === 'department').forEach(row => {
    if ((row.calculationMode || 'percent') !== 'percent') return;
    const percent = Math.max(0, financeNumber(row.percent));
    if (!percent) return;
    const base = lines
      .filter(line => (
        financeLineSystem(line) === row.department
        && (line.subprojectId || 'main') === (row.subprojectId || 'main')
      ))
      .reduce((sum, line) => sum + financeLineTotal(line), 0);
    row.amount = Math.round(base * percent / 100 * (row.kind === 'discount' ? -1 : 1) * 100) / 100;
  });
}

function financeTotals(document = financeState.current) {
  const lines = document?.lineItems || [];
  lines.forEach(line => { line.total = financeLineTotal(line); });
  financeRecalculateAdjustments(document);
  financeApplyLockedTotalAdjustment(document);
  const includedLines = lines.filter(line => !financeLineIsOptional(line));
  const includedAdjustments = (document?.adjustments || []).filter(financeAdjustmentCountsTowardTotal);
  const subtotal = Math.round(includedLines.reduce((sum, line) => sum + financeNumber(line.total), 0) * 100) / 100;
  const adjustmentTotal = Math.round(includedAdjustments.reduce((sum, row) => sum + financeNumber(row.amount), 0) * 100) / 100;
  const netSubtotal = Math.round((subtotal + adjustmentTotal) * 100) / 100;
  const tax = Math.round(Math.max(0, netSubtotal) * financeNumber(document?.taxRate) / 100 * 100) / 100;
  const lockedPreTax = document?.totalLocked ? financeNumber(document.lockedPreTaxTotal, netSubtotal) : null;
  return {
    subtotal,
    adjustmentTotal,
    discount: Math.round(includedAdjustments.reduce((sum, row) => sum + Math.abs(Math.min(0, financeNumber(row.amount))), 0) * 100) / 100,
    netSubtotal,
    lockedPreTax,
    lockDifference: lockedPreTax === null ? 0 : Math.round((netSubtotal - lockedPreTax) * 100) / 100,
    tax,
    total: Math.round((netSubtotal + tax) * 100) / 100
  };
}

function financeEventDays(document = financeState.current) {
  const scheduleDates = [
    document?.setupDate,
    ...financeAdditionalScheduleRows('setup', document).map(row => row.date),
    document?.rehearsalDate,
    ...financeAdditionalScheduleRows('rehearsal', document).map(row => row.date),
    document?.showDate,
    ...financeAdditionalScheduleRows('show', document).map(row => row.date),
    document?.teardownDate,
    ...financeAdditionalScheduleRows('teardown', document).map(row => row.date),
    ...financeCustomScheduleGroups(document).flatMap(group =>
      (group.dates || []).map(row => row.date)
    )
  ].filter(Boolean).sort();
  if (!scheduleDates.length) return 1;
  const start = new Date(`${scheduleDates[0]}T00:00:00`);
  const end = new Date(`${scheduleDates[scheduleDates.length - 1]}T00:00:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 1;
  return Math.max(1, Math.round((end - start) / 86400000) + 1);
}

function financeUomLabel(value) {
  return FINANCE_UOMS.find(row => row.value === value)?.label || 'unit(s)';
}

function financeDefaultUom(department, preferred = '') {
  const departmentName = String(department || '').trim().toLowerCase();
  const isManpower = departmentName === 'manpower' || departmentName.includes('manpower department');
  if (isManpower && (!preferred || preferred === 'units')) return 'pax';
  return preferred || 'units';
}

function financeClientName(client = {}) {
  return [client.salutation, client.name].filter(Boolean).join(' ').trim();
}

function financeSalutationControl(value, menuId, handler) {
  const selected = FINANCE_SALUTATIONS.includes(value) ? value : '';
  return `
    <div class="finance-custom-control finance-salutation-control">
      <button type="button" class="finance-line-select-button" aria-label="Salutation"
              onclick="financeToggleMenu('${financeEscapeAttr(menuId)}',event)">${financeEscape(selected || 'None')}<span>&#8964;</span></button>
      <div class="finance-custom-menu" id="${financeEscapeAttr(menuId)}">
        ${FINANCE_SALUTATIONS.map(option => `
          <button type="button" class="${option === selected ? 'selected' : ''}"
                  onclick="${handler}('${financeEscapeAttr(option)}','${financeEscapeAttr(menuId)}')">${financeEscape(option || 'None')}</button>
        `).join('')}
      </div>
    </div>
  `;
}

function financeSetClientSalutation(value, menuId) {
  document.getElementById(menuId)?.classList.remove('open');
  financeClientFieldChange('salutation', FINANCE_SALUTATIONS.includes(value) ? value : '');
  financeRenderEditor();
}

function financeSetNewClientSalutation(value, menuId) {
  financeState.newClientSalutation = FINANCE_SALUTATIONS.includes(value) ? value : '';
  document.getElementById(menuId)?.classList.remove('open');
  const control = document.getElementById('financeNewClientSalutationControl');
  if (control) control.innerHTML = financeSalutationControl(
    financeState.newClientSalutation,
    menuId,
    'financeSetNewClientSalutation'
  );
}

function financeSubprojects(document = financeState.current) {
  if (!document) return [];
  if (!Array.isArray(document.subprojects) || !document.subprojects.length) {
    document.subprojects = [{ id: 'main', name: 'Main Room' }];
  }
  return document.subprojects;
}

function financeCurrentSubprojectId(document = financeState.current) {
  const rows = financeSubprojects(document);
  const active = rows.find(row => row.id === financeState.activeSubprojectId);
  if (active) return active.id;
  financeState.activeSubprojectId = rows[0]?.id || 'main';
  return financeState.activeSubprojectId;
}

function financeLinkedRecordId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(16).slice(2)}`;
}

function financeLinkedSubprojectMembers(subprojectId, document = financeState.current) {
  const rows = financeSubprojects(document);
  const source = rows.find(row => String(row.id) === String(subprojectId || ''));
  const linkedGroupId = String(source?.linkedGroupId || '');
  if (!linkedGroupId) return source ? [source] : [];
  return rows.filter(row => String(row.linkedGroupId || '') === linkedGroupId);
}

function financeSubprojectsAreLinked(leftId, rightId, document = financeState.current) {
  const rows = financeSubprojects(document);
  const left = rows.find(row => String(row.id) === String(leftId || ''));
  const right = rows.find(row => String(row.id) === String(rightId || ''));
  return !!(
    left?.linkedGroupId
    && String(left.linkedGroupId) === String(right?.linkedGroupId || '')
  );
}

function financeClearLinkedRoomKeys(document, subprojectId) {
  const roomId = String(subprojectId || '');
  (document?.lineItems || []).forEach(line => {
    if (String(line.subprojectId || 'main') === roomId) delete line.linkedItemId;
  });
  (document?.headerRows || []).forEach(header => {
    if (String(header.subprojectId || 'main') === roomId) delete header.linkedHeaderId;
  });
  (document?.adjustments || []).forEach(adjustment => {
    if (
      adjustment.scope !== 'total'
      && String(adjustment.subprojectId || 'main') === roomId
    ) delete adjustment.linkedAdjustmentId;
  });
}

function financeRepairLinkedSubprojectGroups(document = financeState.current) {
  if (!document) return;
  const groups = new Map();
  financeSubprojects(document).forEach(row => {
    const linkedGroupId = String(row.linkedGroupId || '');
    if (!linkedGroupId) return;
    if (!groups.has(linkedGroupId)) groups.set(linkedGroupId, []);
    groups.get(linkedGroupId).push(row);
  });
  groups.forEach(rows => {
    if (rows.length > 1) return;
    rows.forEach(row => {
      delete row.linkedGroupId;
      financeClearLinkedRoomKeys(document, row.id);
    });
  });
}

function financeEnsureLinkedRoomKeys(document, subprojectId) {
  const roomId = String(subprojectId || '');
  (document?.lineItems || []).forEach(line => {
    if (String(line.subprojectId || 'main') !== roomId) return;
    line.linkedItemId = String(line.linkedItemId || financeLinkedRecordId('linked_line'));
  });
  (document?.headerRows || []).forEach(header => {
    if (String(header.subprojectId || 'main') !== roomId) return;
    header.linkedHeaderId = String(
      header.linkedHeaderId || financeLinkedRecordId('linked_header')
    );
  });
  (document?.adjustments || []).forEach(adjustment => {
    if (
      adjustment.scope === 'total'
      || String(adjustment.subprojectId || 'main') !== roomId
    ) return;
    adjustment.linkedAdjustmentId = String(
      adjustment.linkedAdjustmentId || financeLinkedRecordId('linked_adjustment')
    );
  });
}

function financeLinkedText(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

function financeLinkedLineIdentity(line) {
  const catalogIdentity = [line?.productId, line?.productKey, line?.catalogKey]
    .map(financeLinkedText)
    .find(Boolean);
  const assetIdentity = [...new Set((line?.sourceAssetIds || []).map(financeLinkedText).filter(Boolean))]
    .sort()
    .join('|');
  const itemIdentity = catalogIdentity
    ? `catalog:${catalogIdentity}`
    : assetIdentity
      ? `assets:${assetIdentity}`
      : `text:${[
          line?.brand, line?.model, line?.description, line?.departmentCode
        ].map(financeLinkedText).join('|')}`;
  const groupIdentity = line?.groupId
    ? `group:${financeLinkedText(line.groupTitle) || 'group'}`
    : 'line';
  return `${groupIdentity}::${itemIdentity}`;
}

function financeLinkedHeaderIdentity(header, lines) {
  const anchor = (lines || []).find(
    line => String(line.id || '') === String(header?.beforeLineId || '')
  );
  return `${financeLinkedText(header?.content)}::${String(anchor?.linkedItemId || '')}`;
}

function financeLinkedAdjustmentIdentity(adjustment) {
  return [
    adjustment?.scope,
    adjustment?.department,
    adjustment?.label,
    adjustment?.kind,
  ].map(financeLinkedText).join('::');
}

function financeLinkedCounterpart(source, targetRows, used, identity, linkField) {
  const linkedId = String(source?.[linkField] || '');
  const exact = linkedId
    ? targetRows.find(row => !used.has(row) && String(row?.[linkField] || '') === linkedId)
    : null;
  if (exact) return exact;
  return targetRows.find(row => !used.has(row) && identity(row) === identity(source)) || null;
}

function financeReplaceRoomRecords(records, subprojectId, replacements, include) {
  const rows = Array.isArray(records) ? records : [];
  const roomId = String(subprojectId || '');
  const matches = row => (
    String(row?.subprojectId || 'main') === roomId
    && (!include || include(row))
  );
  const firstIndex = rows.findIndex(matches);
  if (firstIndex < 0) return [...rows, ...replacements];
  const result = [];
  rows.forEach((row, index) => {
    if (index === firstIndex) result.push(...replacements);
    if (!matches(row)) result.push(row);
  });
  return result;
}

function financeSynchroniseLinkedSubprojects(
  document = financeState.current,
  sourceSubprojectId = financeCurrentSubprojectId(document)
) {
  if (!document) return false;
  financeRepairLinkedSubprojectGroups(document);
  const members = financeLinkedSubprojectMembers(sourceSubprojectId, document);
  if (members.length < 2) return false;
  const sourceId = String(sourceSubprojectId || members[0].id);
  const source = members.find(row => String(row.id) === sourceId) || members[0];
  financeEnsureLinkedRoomKeys(document, source.id);
  const sourceLines = (document.lineItems || []).filter(
    line => String(line.subprojectId || 'main') === String(source.id)
  );
  const sourceHeaders = (document.headerRows || []).filter(
    header => String(header.subprojectId || 'main') === String(source.id)
  );
  const sourceAdjustments = (document.adjustments || []).filter(adjustment => (
    adjustment.scope !== 'total'
    && String(adjustment.subprojectId || 'main') === String(source.id)
  ));

  members.filter(row => row !== source).forEach(target => {
    const targetId = String(target.id);
    const targetLines = (document.lineItems || []).filter(
      line => String(line.subprojectId || 'main') === targetId
    );
    const usedLines = new Set();
    const linePairs = sourceLines.map(sourceLine => {
      const existing = financeLinkedCounterpart(
        sourceLine,
        targetLines,
        usedLines,
        financeLinkedLineIdentity,
        'linkedItemId'
      );
      if (existing) usedLines.add(existing);
      return { sourceLine, existing };
    });
    const groupIdMap = new Map();
    linePairs.forEach(({ sourceLine, existing }) => {
      if (sourceLine.groupId && existing?.groupId && !groupIdMap.has(sourceLine.groupId)) {
        groupIdMap.set(sourceLine.groupId, existing.groupId);
      }
    });
    const targetLineIdBySourceId = new Map();
    const syncedLines = linePairs.map(({ sourceLine, existing }) => {
      const clone = financeCloneDocument(sourceLine);
      clone.id = existing?.id || financeLinkedRecordId('line');
      clone.subprojectId = targetId;
      clone.linkedItemId = sourceLine.linkedItemId;
      if (sourceLine.groupId) {
        if (!groupIdMap.has(sourceLine.groupId)) {
          groupIdMap.set(sourceLine.groupId, financeLinkedRecordId('group'));
        }
        clone.groupId = groupIdMap.get(sourceLine.groupId);
      } else {
        clone.groupId = '';
      }
      targetLineIdBySourceId.set(String(sourceLine.id || ''), clone.id);
      return clone;
    });
    document.lineItems = financeReplaceRoomRecords(
      document.lineItems,
      targetId,
      syncedLines
    );

    const targetHeaders = (document.headerRows || []).filter(
      header => String(header.subprojectId || 'main') === targetId
    );
    const usedHeaders = new Set();
    const syncedHeaders = sourceHeaders.map(sourceHeader => {
      const existing = financeLinkedCounterpart(
        sourceHeader,
        targetHeaders,
        usedHeaders,
        header => financeLinkedHeaderIdentity(header, document.lineItems),
        'linkedHeaderId'
      );
      if (existing) usedHeaders.add(existing);
      const clone = financeCloneDocument(sourceHeader);
      clone.id = existing?.id || financeLinkedRecordId('header');
      clone.subprojectId = targetId;
      clone.linkedHeaderId = sourceHeader.linkedHeaderId;
      clone.beforeLineId = targetLineIdBySourceId.get(
        String(sourceHeader.beforeLineId || '')
      ) || '';
      return clone;
    });
    document.headerRows = financeReplaceRoomRecords(
      document.headerRows,
      targetId,
      syncedHeaders
    );

    const targetAdjustments = (document.adjustments || []).filter(adjustment => (
      adjustment.scope !== 'total'
      && String(adjustment.subprojectId || 'main') === targetId
    ));
    const usedAdjustments = new Set();
    const syncedAdjustments = sourceAdjustments.map(sourceAdjustment => {
      const existing = financeLinkedCounterpart(
        sourceAdjustment,
        targetAdjustments,
        usedAdjustments,
        financeLinkedAdjustmentIdentity,
        'linkedAdjustmentId'
      );
      if (existing) usedAdjustments.add(existing);
      const clone = financeCloneDocument(sourceAdjustment);
      clone.id = existing?.id || financeLinkedRecordId('adjustment');
      clone.subprojectId = targetId;
      clone.linkedAdjustmentId = sourceAdjustment.linkedAdjustmentId;
      return clone;
    });
    document.adjustments = financeReplaceRoomRecords(
      document.adjustments,
      targetId,
      syncedAdjustments,
      adjustment => adjustment.scope !== 'total'
    );
  });
  return true;
}

function financeActiveDepartments(document = financeState.current, subprojectId = financeCurrentSubprojectId(document)) {
  const departments = [];
  (document?.lineItems || []).forEach(line => {
    if (line.hiddenFromQuotation) return;
    if (String(line.subprojectId || 'main') !== String(subprojectId || 'main')) return;
    const department = financeLineSystem(line);
    if (!departments.includes(department)) departments.push(department);
  });
  return departments;
}

function financeSyncDocumentDepartments(document = financeState.current) {
  if (!document) return [];
  financeNormaliseLineGroups(document);
  const groupCategories = new Map();
  (document.lineItems || []).forEach(line => {
    line.department = String(line.department || 'Unknown Department').trim() || 'Unknown Department';
    line.systemName = financeLineSystem(line);
    line.subprojectId = line.subprojectId || financeSubprojects(document)[0]?.id || 'main';
    const groupId = String(line.groupId || '');
    if (!groupId) return;
    const groupKey = `${line.subprojectId}::${groupId}`;
    const category = groupCategories.get(groupKey);
    if (category) {
      line.systemName = category.systemName;
    } else {
      groupCategories.set(groupKey, {
        systemName: line.systemName
      });
    }
  });
  const departments = [...new Set((document.lineItems || []).map(line => financeLineSystem(line)))];
  document.departments = departments;
  const activeBySubproject = new Map();
  (document.lineItems || []).forEach(line => {
    const subprojectId = String(line.subprojectId || 'main');
    if (!activeBySubproject.has(subprojectId)) {
      activeBySubproject.set(subprojectId, []);
    }
    const category = financeLineSystem(line);
    if (!activeBySubproject.get(subprojectId).includes(category)) {
      activeBySubproject.get(subprojectId).push(category);
    }
  });
  (document.adjustments || []).forEach(row => {
    if (row.scope !== 'department') return;
    const candidates = activeBySubproject.get(String(row.subprojectId || 'main')) || [];
    const exact = candidates.find(category => (
      category.toLocaleLowerCase() === String(row.department || '').trim().toLocaleLowerCase()
    ));
    const equivalent = candidates.filter(category => (
      financeNormalisedDepartmentName(category)
      === financeNormalisedDepartmentName(row.department)
    ));
    const match = exact || (equivalent.length === 1 ? equivalent[0] : '');
    if (match) row.department = match;
  });
  document.adjustments = (document.adjustments || []).filter(row => (
    row.scope !== 'department'
    || (activeBySubproject.get(String(row.subprojectId || 'main')) || [])
      .includes(row.department)
  ));
  return departments;
}

function financeLineGroupMembers(groupId, subprojectId, document = financeState.current) {
  const key = String(groupId || '');
  const roomId = String(subprojectId || 'main');
  return (document?.lineItems || []).filter(line => (
    String(line.groupId || '') === key
    && String(line.subprojectId || 'main') === roomId
  ));
}

function financeGroupCommercialFactor(line) {
  const discount = Math.max(-9999, Math.min(100, financeNumber(line?.discountPercent)));
  return Math.max(0, financeNumber(line?.days, 1))
    * Math.max(0, financeNumber(line?.quantity, 1))
    * (1 - discount / 100);
}

function financeAdjustGroupPrice(leader, delta) {
  if (!leader || !delta) return;
  const nextUnitPrice = Math.max(0, financeNumber(leader.unitPrice) + delta);
  const totalDelta = delta * financeGroupCommercialFactor(leader);
  leader.unitPrice = nextUnitPrice;
  if (leader.totalMode === 'amount') {
    leader.total = Math.max(0, financeNumber(leader.total) + totalDelta);
  } else {
    leader.total = financeLineTotal(leader);
  }
}

function financeSetGroupItemQuantityValue(line, value) {
  if (!line) return 0;
  const previousQuantity = Math.max(0, financeNumber(line.groupItemQuantity, 1));
  const previousContribution = financeGroupItemPriceContribution(line);
  const nextQuantity = Math.max(0, financeNumber(value, 1));
  const unitContribution = previousQuantity
    ? previousContribution / previousQuantity
    : Math.max(0, financeNumber(line.groupItemUnitPrice));
  const previousItemTotal = Math.max(0, financeNumber(line.groupItemTotal));
  line.groupItemQuantity = nextQuantity;
  if (line.groupItemTotalMode === 'amount') {
    line.groupItemTotal = previousQuantity
      ? previousItemTotal / previousQuantity * nextQuantity
      : Math.max(0, financeNumber(line.groupItemUnitPrice))
        * Math.max(0, financeNumber(line.groupItemDays, 1)) * nextQuantity;
  }
  line.groupItemPriceContribution = unitContribution * nextQuantity;
  return line.groupItemPriceContribution - previousContribution;
}

function financeGroupLinesFromIndexes(encodedIndexes) {
  return String(encodedIndexes || '').split(',')
    .map(index => Number(index))
    .filter(index => Number.isInteger(index))
    .map(index => financeState.current?.lineItems?.[index])
    .filter(line => line?.groupId && !line.groupCustomText);
}

function financeCommitGroupItemPricing(lines) {
  const first = lines?.[0];
  if (!first) return;
  financeRecalculateGroupPriceFromItems(first.groupId, first.subprojectId);
  financeSyncDocumentDepartments();
  financeQueueSave();
  financeRenderEditor();
}

function financeGroupItemUnitPriceChange(encodedIndexes, value) {
  const lines = financeGroupLinesFromIndexes(encodedIndexes);
  const unitPrice = Math.max(0, financeCurrencyNumber(value));
  lines.forEach(line => {
    line.groupItemUnitPrice = unitPrice;
    line.groupItemTotalMode = 'calculated';
    line.groupItemPriceContribution = financeCalculatedGroupItemContribution(line);
    line.groupItemTotal = Math.round(
      Math.max(0, financeNumber(line.groupItemDays, 1))
      * line.groupItemPriceContribution * 100
    ) / 100;
  });
  financeCommitGroupItemPricing(lines);
}

function financeGroupItemDiscountChange(encodedIndexes, value) {
  const lines = financeGroupLinesFromIndexes(encodedIndexes);
  const discount = financePercent(value);
  lines.forEach(line => {
    line.groupItemDiscountPercent = discount;
    line.groupItemTotalMode = 'calculated';
    line.groupItemPriceContribution = financeCalculatedGroupItemContribution(line);
    line.groupItemTotal = Math.round(
      Math.max(0, financeNumber(line.groupItemDays, 1))
      * line.groupItemPriceContribution * 100
    ) / 100;
  });
  financeCommitGroupItemPricing(lines);
}

function financeGroupItemAmountChange(encodedIndexes, value) {
  const lines = financeGroupLinesFromIndexes(encodedIndexes);
  const amount = Math.max(0, financeCurrencyNumber(value));
  const denominator = lines.reduce((sum, line) => {
    const discount = Math.max(-9999, Math.min(100, financeNumber(line.groupItemDiscountPercent)));
    return sum + Math.max(0, financeNumber(line.groupItemQuantity, 1)) * (1 - discount / 100);
  }, 0);
  const unitPrice = denominator > 0 ? amount / denominator : amount;
  lines.forEach(line => {
    line.groupItemUnitPrice = Math.round(unitPrice * 100) / 100;
    line.groupItemTotalMode = 'amount';
    line.groupItemPriceContribution = financeCalculatedGroupItemContribution(line);
    line.groupItemTotal = Math.round(
      Math.max(0, financeNumber(line.groupItemDays, 1))
      * line.groupItemPriceContribution * 100
    ) / 100;
  });
  const calculatedAmount = lines.reduce(
    (sum, line) => sum + financeGroupItemPriceContribution(line), 0
  );
  if (lines.length && Math.abs(calculatedAmount - amount) >= 0.005) {
    const last = lines[lines.length - 1];
    const otherAmount = calculatedAmount - financeGroupItemPriceContribution(last);
    last.groupItemPriceContribution = Math.max(0, amount - otherAmount);
    last.groupItemTotal = Math.round(
      Math.max(0, financeNumber(last.groupItemDays, 1))
      * last.groupItemPriceContribution * 100
    ) / 100;
  }
  financeCommitGroupItemPricing(lines);
}

function financeDetachLineFromGroup(line) {
  if (!line?.groupId) return line;
  const members = financeLineGroupMembers(line.groupId, line.subprojectId);
  const leader = members.find(member => member.groupLeader) || members[0];
  const remaining = members.filter(member => member !== line);
  const replacement = remaining[0];
  const contribution = financeGroupItemPriceContribution(line);
  if (replacement) {
    if (leader === line) {
      Object.assign(replacement, {
        groupLeader: true,
        days: line.days,
        quantity: line.quantity,
        uom: line.uom,
        unitPrice: line.unitPrice,
        discountPercent: line.discountPercent,
        totalMode: line.totalMode,
        total: line.total
      });
    }
    if (financeGroupPricingMode(members) !== 'total') {
      financeAdjustGroupPrice(leader === line ? replacement : leader, -contribution);
    }
  }
  financeRestoreGroupItemCommercial(line);
  financeClearLineGroupFields(line);
  return line;
}

function financeAttachLineToGroup(line, targetGroupId, targetSubprojectId) {
  if (!line || !targetGroupId) return false;
  const currentGroupId = String(line.groupId || '');
  const currentRoomId = String(line.subprojectId || 'main');
  const roomId = String(targetSubprojectId || currentRoomId || 'main');
  if (currentGroupId === String(targetGroupId) && currentRoomId === roomId) return false;
  if (currentGroupId) financeDetachLineFromGroup(line);
  const members = financeLineGroupMembers(targetGroupId, roomId);
  const leader = members.find(member => member.groupLeader) || members[0];
  if (!leader) return false;

  financeCaptureGroupItemCommercial(line, true);
  const factor = financeGroupCommercialFactor(leader);
  line.groupItemPriceContribution = factor
    ? Math.max(0, financeNumber(line.groupItemTotal)) / factor
    : Math.max(0, financeNumber(line.groupItemUnitPrice)) * Math.max(0, financeNumber(line.groupItemQuantity, 1));
  const pricingMode = financeGroupPricingMode(members);
  if (pricingMode !== 'total') {
    financeAdjustGroupPrice(leader, financeGroupItemPriceContribution(line));
  }
  Object.assign(line, {
    groupId: String(targetGroupId),
    groupTitle: leader.groupTitle || 'Group',
    groupDisplayFields: [...(leader.groupDisplayFields || ['brand', 'model', 'description'])],
    groupCustomText: false,
    groupLeader: false,
    groupHeaderQuantity: financeNumber(leader.quantity, 1),
    groupPricingMode: pricingMode,
    subprojectId: roomId,
    systemName: financeLineSystem(leader)
  });
  return true;
}

function financeGroupItemQuantityChange(index, value) {
  const line = financeState.current?.lineItems?.[index];
  if (!line?.groupId) return;
  const members = financeLineGroupMembers(line.groupId, line.subprojectId);
  const leader = members.find(member => member.groupLeader) || members[0];
  const contributionDelta = financeSetGroupItemQuantityValue(line, value);
  if (financeGroupPricingMode(members) !== 'total') {
    financeAdjustGroupPrice(leader, contributionDelta);
  }
  financeSyncDocumentDepartments();
  financeQueueSave();
  financeRenderEditor();
}

function financeGroupBucketQuantityChange(encodedIndexes, value) {
  const lines = financeGroupLinesFromIndexes(encodedIndexes);
  if (!lines.length) return;
  const target = Math.max(0, Math.round(financeNumber(value)));
  const quantities = lines.map(line => Math.max(0, financeNumber(line.groupItemQuantity, 1)));
  const currentTotal = quantities.reduce((sum, quantity) => sum + quantity, 0);
  let allocations;
  if (!currentTotal) {
    allocations = lines.map((_line, index) => index === 0 ? target : 0);
  } else {
    const raw = quantities.map(quantity => target * quantity / currentTotal);
    allocations = raw.map(quantity => Math.floor(quantity));
    let remainder = target - allocations.reduce((sum, quantity) => sum + quantity, 0);
    raw.map((quantity, index) => ({ index, fraction: quantity - allocations[index] }))
      .sort((a, b) => b.fraction - a.fraction || a.index - b.index)
      .forEach(row => {
        if (remainder <= 0) return;
        allocations[row.index] += 1;
        remainder -= 1;
      });
  }
  const members = financeLineGroupMembers(lines[0].groupId, lines[0].subprojectId);
  const leader = members.find(line => line.groupLeader) || members[0];
  const contributionDelta = lines.reduce(
    (sum, line, index) => sum + financeSetGroupItemQuantityValue(line, allocations[index]),
    0
  );
  if (financeGroupPricingMode(members) !== 'total') {
    financeAdjustGroupPrice(leader, contributionDelta);
  }
  financeSyncDocumentDepartments();
  financeQueueSave();
  financeRenderEditor();
}

function financeDeleteLineGroup(groupId, subprojectId = financeCurrentSubprojectId()) {
  const key = String(groupId || '');
  const roomId = String(subprojectId || 'main');
  financeState.current.lineItems = (financeState.current.lineItems || [])
    .filter(line => !(
      String(line.groupId || '') === key
      && String(line.subprojectId || 'main') === roomId
    ));
  financeSyncDocumentDepartments();
  financeQueueSave();
  financeRenderEditor();
}

async function financeRenameLineGroup(groupId, subprojectId = financeCurrentSubprojectId()) {
  const key = String(groupId || '');
  const roomId = String(subprojectId || 'main');
  const members = (financeState.current?.lineItems || []).filter(line => (
    String(line.groupId || '') === key
    && String(line.subprojectId || 'main') === roomId
  ));
  if (!members.length) return;
  const title = await showAppPrompt({
    title: 'Rename group header',
    message: 'Enter the description shown for this group.',
    inputLabel: 'Group header',
    defaultValue: members[0].groupTitle || '',
    confirmText: 'Rename'
  });
  const nextTitle = String(title || '').trim();
  if (!nextTitle || nextTitle === String(members[0].groupTitle || '')) return;
  members.forEach(line => { line.groupTitle = nextTitle; });
  financeQueueSave();
  financeRenderEditor();
}

function financeDeleteGroupChildren(indexes) {
  const lines = financeState.current?.lineItems || [];
  const members = String(indexes || '').split(',')
    .map(value => lines[financeNumber(value, -1)])
    .filter(Boolean);
  members.forEach(line => financeDetachLineFromGroup(line));
  members.forEach(line => {
    const index = lines.indexOf(line);
    if (index >= 0) lines.splice(index, 1);
  });
  financeSyncDocumentDepartments();
  financeQueueSave();
  financeRenderEditor();
}

function financeIsLockedAdjustment(row) {
  return !!row?.lockedTotalAdjustment || String(row?.id || '').startsWith('locked_total_');
}

function financeIsGeneratedTotalAdjustment(row) {
  if (financeIsLockedAdjustment(row)) return true;
  if (String(row?.scope || '') !== 'total') return false;
  const label = String(row?.label || '').trim().toLowerCase();
  return /^\d+(?:\.\d+)?% (?:overall|total) (?:discount|adjustment)$/.test(label);
}

function financeLockedAdjustmentId(document = financeState.current) {
  return `locked_total_${document?.id || 'current'}`;
}

function financeApplyLockedTotalAdjustment(document = financeState.current) {
  if (!document) return;
  const adjustments = document.adjustments || (document.adjustments = []);
  const unlockedAdjustments = adjustments.filter(row => !financeIsGeneratedTotalAdjustment(row));
  if (!document.totalLocked) {
    document.adjustments = unlockedAdjustments;
    document.lockedPreTaxTotal = null;
    return;
  }
  const subtotal = Math.round((document.lineItems || [])
    .filter(line => !financeLineIsOptional(line))
    .reduce((sum, line) => sum + financeLineTotal(line), 0) * 100) / 100;
  const adjustmentBase = Math.round((
    subtotal
    + unlockedAdjustments
      .filter(financeAdjustmentCountsTowardTotal)
      .reduce((sum, row) => sum + financeNumber(row.amount), 0)
  ) * 100) / 100;
  const rawTarget = document.lockedPreTaxTotal;
  const target = rawTarget === null || rawTarget === undefined || rawTarget === ''
    ? adjustmentBase
    : Math.max(0, financeNumber(rawTarget, adjustmentBase));
  document.lockedPreTaxTotal = Math.round(target * 100) / 100;
  const difference = Math.round((document.lockedPreTaxTotal - adjustmentBase) * 100) / 100;
  if (Math.abs(difference) < 0.005) {
    document.adjustments = unlockedAdjustments;
    return;
  }
  const percent = adjustmentBase ? Math.abs(difference) / adjustmentBase * 100 : 0;
  const labelPercent = percent.toFixed(2).replace(/\.?0+$/, '') || '0';
  document.adjustments = [
    ...unlockedAdjustments,
    {
      id: financeLockedAdjustmentId(document),
      scope: 'total',
      department: '',
      label: String(document.totalDiscountLabel || '').trim() || `${labelPercent}% total ${difference < 0 ? 'discount' : 'adjustment'}`,
      amount: difference,
      percent,
      calculationMode: 'amount',
      kind: difference < 0 ? 'discount' : 'adjustment',
      lockedTotalAdjustment: true
    }
  ];
}

function financeSubprojectCollapsedCategories(
  document = financeState.current,
  subprojectId = financeCurrentSubprojectId(document)
) {
  const subproject = financeSubprojects(document).find(row => (
    String(row.id || '') === String(subprojectId || '')
  ));
  return Array.isArray(subproject?.collapsedCategories)
    ? subproject.collapsedCategories
    : [];
}

function financeIsDepartmentCollapsed(department) {
  const target = String(department || '').trim().toLocaleLowerCase();
  return financeSubprojectCollapsedCategories().some(value => (
    String(value || '').trim().toLocaleLowerCase() === target
  ));
}

function financeStatusLabel(status) {
  const clean = String(status || 'draft').toLowerCase();
  return clean[0].toUpperCase() + clean.slice(1);
}

function financeTodayIso() {
  const today = new Date();
  const offsetDate = new Date(today.getTime() - today.getTimezoneOffset() * 60000);
  return offsetDate.toISOString().slice(0, 10);
}

function financeDateOnly(value) {
  return String(value || '').slice(0, 10);
}

function financeEventDateSummary(document) {
  const summaryRange = [document?.eventStartDate, document?.eventEndDate].filter(Boolean);
  const rawDates = summaryRange.length
    ? summaryRange
    : [
        document?.setupDate,
        ...financeAdditionalScheduleRows('setup', document).map(row => row.date),
        document?.rehearsalDate,
        ...financeAdditionalScheduleRows('rehearsal', document).map(row => row.date),
        document?.showDate,
        ...financeAdditionalScheduleRows('show', document).map(row => row.date),
        document?.teardownDate,
        ...financeAdditionalScheduleRows('teardown', document).map(row => row.date)
      ];
  const dates = [...new Set(rawDates.map(financeDateOnly).filter(value => /^\d{4}-\d{2}-\d{2}$/.test(value)))]
    .sort()
    .map(value => new Date(`${value}T00:00:00Z`))
    .filter(value => !Number.isNaN(value.getTime()));
  if (!dates.length) return '';

  const month = value => value.toLocaleDateString('en-SG', { month: 'short', timeZone: 'UTC' });
  const start = dates[0];
  const end = dates[dates.length - 1];
  if (start.getTime() === end.getTime()) {
    return `${start.getUTCDate()} ${month(start)} ${start.getUTCFullYear()}`;
  }
  if (start.getUTCFullYear() === end.getUTCFullYear() && start.getUTCMonth() === end.getUTCMonth()) {
    return `${start.getUTCDate()} - ${end.getUTCDate()} ${month(end)} ${end.getUTCFullYear()}`;
  }
  if (start.getUTCFullYear() === end.getUTCFullYear()) {
    return `${start.getUTCDate()} ${month(start)} - ${end.getUTCDate()} ${month(end)} ${end.getUTCFullYear()}`;
  }
  return `${start.getUTCDate()} ${month(start)} ${start.getUTCFullYear()} - ${end.getUTCDate()} ${month(end)} ${end.getUTCFullYear()}`;
}

function financeDaysSince(value) {
  const date = financeDateOnly(value);
  if (!date) return null;
  const today = new Date(`${financeTodayIso()}T00:00:00`);
  const then = new Date(`${date}T00:00:00`);
  if (Number.isNaN(then.getTime())) return null;
  return Math.max(0, Math.floor((today - then) / 86400000));
}

function financeDaysLeft(validUntil) {
  if (!validUntil) return null;
  const today = new Date(`${financeTodayIso()}T00:00:00`);
  const until = new Date(`${financeDateOnly(validUntil)}T00:00:00`);
  if (Number.isNaN(until.getTime())) return null;
  return Math.ceil((until - today) / 86400000);
}

function financePaymentCountdownText(document) {
  const status = String(document?.status || '').toLowerCase();
  if (!['invoiced', 'overdue'].includes(status)) return '';
  const days = financeDaysLeft(document.paymentDueDate);
  if (days === null) return '';
  if (status === 'overdue' || days < 0) {
    const overdueDays = Math.max(1, Math.abs(days));
    return `Overdue by: ${overdueDays} day${overdueDays === 1 ? '' : 's'}`;
  }
  return `Pay by: ${days} day${days === 1 ? '' : 's'}`;
}

function financeValidityCountdown(document) {
  const days = financeDaysLeft(document.validUntil);
  return days === null
    ? `${financeNumber(document.validityDays, 30)} day validity`
    : days < 0
      ? 'Expired'
      : `${days} day${days === 1 ? '' : 's'} left`;
}

function financeAgeText(days) {
  if (days === null || days === undefined) return '';
  if (days === 0) return 'today';
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

function financeListDateSummary(document) {
  const status = String(document?.status || 'draft').toLowerCase();
  if (status === 'draft') {
    return {
      label: 'Last modified',
      date: financeDateOnly(document.updatedAt || document.createdAt),
      detail: ''
    };
  }
  if (status === 'sent') {
    return {
      label: 'Sent on',
      date: financeDateOnly(document.sentAt || document.statusChangedAt),
      detail: financeValidityCountdown(document)
    };
  }
  if (status === 'accepted') {
    return {
      label: 'Accepted',
      date: financeDateOnly(document.acceptedAt || document.statusChangedAt),
      detail: ''
    };
  }
  if (status === 'invoiced') {
    const date = document.invoiceSentDate || document.invoicedAt || document.statusChangedAt;
    return {
      label: 'Invoiced',
      date: financeDateOnly(date),
      detail: financePaymentCountdownText(document) || financeAgeText(financeDaysSince(date))
    };
  }
  if (status === 'overdue') {
    return {
      label: 'Payment due',
      date: financeDateOnly(document.paymentDueDate),
      detail: financePaymentCountdownText(document)
    };
  }
  if (status === 'paid') {
    return {
      label: 'Paid',
      date: financeDateOnly(document.paidAt || document.statusChangedAt),
      detail: ''
    };
  }
  return {
    label: financeStatusLabel(status),
    date: financeDateOnly(document.statusChangedAt || document.updatedAt),
    detail: ''
  };
}

function financeSnapshotValidity(snapshot) {
  const sent = financeDateOnly(snapshot?.sentAt);
  const accepted = financeDateOnly(snapshot?.acceptedAt);
  const validityDays = financeNumber(snapshot?.validityDays ?? snapshot?.snapshot?.validityDays, 0);
  const validUntil = financeDateOnly(snapshot?.validUntil || snapshot?.snapshot?.validUntil);
  if (!sent && accepted) return `Accepted ${accepted}`;
  return [
    sent ? `Sent ${sent}` : '',
    validityDays ? `${validityDays} days` : '',
    validUntil ? `Valid until ${validUntil}` : ''
  ].filter(Boolean).join(' · ') || 'No validity recorded';
}

function financeRestoreCustomMenu(menu) {
  if (!menu) return;
  menu.classList.remove('open', 'open-up');
  if (menu.dataset?.financeMenuPortal !== 'true') return;
  const origin = menu.__financeMenuOriginParent;
  const nextSibling = menu.__financeMenuOriginNextSibling;
  if (origin?.isConnected) {
    origin.insertBefore(menu, nextSibling?.parentNode === origin ? nextSibling : null);
  } else {
    menu.remove();
  }
  for (const property of [
    'position', 'top', 'right', 'bottom', 'left', 'zIndex', 'maxHeight', 'overflowY'
  ]) {
    menu.style[property] = '';
  }
  delete menu.dataset.financeMenuPortal;
  delete menu.__financeMenuOriginParent;
  delete menu.__financeMenuOriginNextSibling;
}

function financeCloseCustomMenus() {
  document.querySelectorAll(
    '.finance-custom-menu.open, .finance-custom-menu[data-finance-menu-portal]'
  ).forEach(financeRestoreCustomMenu);
}

function financePortalScrollableMenu(menu, control, event) {
  const trigger = event?.currentTarget?.getBoundingClientRect
    ? event.currentTarget
    : control;
  if (!menu || !trigger || !document.body) return;
  const viewport = typeof showbaseViewport !== 'undefined'
    ? showbaseViewport
    : {
        rect: rect => rect,
        width: () => window.innerWidth,
        height: () => window.innerHeight
      };
  const triggerRect = viewport.rect(trigger.getBoundingClientRect());
  menu.__financeMenuOriginParent = menu.parentElement;
  menu.__financeMenuOriginNextSibling = menu.nextSibling;
  document.body.appendChild(menu);
  menu.dataset.financeMenuPortal = 'true';
  const menuRect = viewport.rect(menu.getBoundingClientRect());
  const margin = 8;
  const gap = 5;
  const viewportWidth = viewport.width();
  const viewportHeight = viewport.height();
  const roomBelow = viewportHeight - triggerRect.bottom - gap - margin;
  const roomAbove = triggerRect.top - gap - margin;
  const openAbove = roomBelow < menuRect.height && roomAbove > roomBelow;
  const availableHeight = Math.max(48, openAbove ? roomAbove : roomBelow);
  const visibleHeight = Math.min(menuRect.height, availableHeight);
  const preferredTop = openAbove
    ? triggerRect.top - visibleHeight - gap
    : triggerRect.bottom + gap;
  menu.style.position = 'fixed';
  menu.style.top = `${Math.max(
    margin,
    Math.min(preferredTop, viewportHeight - visibleHeight - margin)
  )}px`;
  menu.style.left = `${Math.max(
    margin,
    Math.min(triggerRect.left, viewportWidth - menuRect.width - margin)
  )}px`;
  menu.style.right = 'auto';
  menu.style.bottom = 'auto';
  menu.style.zIndex = '2000';
  menu.style.maxHeight = `${availableHeight}px`;
  menu.style.overflowY = 'auto';
}

function financeToggleMenu(menuId, event) {
  event?.stopPropagation();
  const target = document.getElementById(menuId);
  if (!target) return;
  const open = !target.classList.contains('open');
  financeCloseCustomMenus();
  if (!open) return;
  target.classList.add('open');
  const scrollContainer = target.closest('.finance-lines-scroll');
  const control = target.closest('.finance-custom-control');
  if (!scrollContainer || !control) return;
  if (target.classList.contains('finance-uom-menu')) {
    financePortalScrollableMenu(target, control, event);
    return;
  }
  const menuRect = target.getBoundingClientRect();
  const scrollRect = scrollContainer.getBoundingClientRect();
  const controlRect = control.getBoundingClientRect();
  if (
    menuRect.bottom > scrollRect.bottom - 4
    && controlRect.top - menuRect.height >= scrollRect.top + 4
  ) {
    target.classList.add('open-up');
  }
}

function financeValidityUnitControl(currentUnit, menuId, selectHandler) {
  const unit = financeValidityUnitMeta(currentUnit).value;
  const label = financeValidityUnitMeta(unit).label;
  return `
    <span class="finance-custom-control finance-validity-unit-control" onclick="event.stopPropagation()">
      <button type="button" class="finance-validity-unit-button" onclick="financeToggleMenu('${financeEscapeAttr(menuId)}',event)">
        ${financeEscape(label)}<span aria-hidden="true">v</span>
      </button>
      <span class="finance-custom-menu finance-validity-menu" id="${financeEscapeAttr(menuId)}">
        ${FINANCE_VALIDITY_UNITS.map(row => `
          <button type="button" class="${row.value === unit ? 'selected' : ''}" onclick="financeCloseMenus();${selectHandler}('${financeEscapeAttr(row.value)}')">${financeEscape(row.label)}</button>
        `).join('')}
      </span>
    </span>
  `;
}

function financeCloseMenus() {
  financeCloseCustomMenus();
  financeCloseQuotationContextMenu();
  financeCloseSubprojectContextMenu();
}

function financeEnsureQuotationContextMenu() {
  let menu = document.getElementById('financeQuotationContextMenu');
  if (menu) return menu;
  menu = document.createElement('div');
  menu.id = 'financeQuotationContextMenu';
  menu.className = 'finance-quotation-context-menu';
  menu.setAttribute('role', 'menu');
  menu.innerHTML = `
    <button type="button" role="menuitem" onclick="event.stopPropagation();financeDuplicateQuotation()">
      <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="1"></rect><path d="M16 8V4H4v12h4"></path></svg>
      <span>Duplicate quotation</span>
    </button>
    <button type="button" role="menuitem" onclick="event.stopPropagation();financeChangeSalespersonFromMenu()">
      <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="3"></circle><path d="M5 20c.8-4 3.1-6 7-6s6.2 2 7 6"></path></svg>
      <span>Change salesperson</span>
    </button>
    <button type="button" role="menuitem" onclick="event.stopPropagation();financeRenumberQuotation()">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h8M4 12h5M4 17h8"></path><path d="M16 5v14M13.5 7.5 16 5l2.5 2.5M13.5 16.5 16 19l2.5-2.5"></path></svg>
      <span>Renumber quotation</span>
    </button>
    <button type="button" class="danger" role="menuitem" onclick="event.stopPropagation();financeDeleteQuotationFromMenu()">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"></path></svg>
      <span>Delete quotation</span>
    </button>
  `;
  document.body.appendChild(menu);
  return menu;
}

function financeCloseQuotationContextMenu() {
  const menu = document.getElementById('financeQuotationContextMenu');
  menu?.classList.remove('open');
  document.querySelectorAll('.finance-list-row.context-open').forEach(row => row.classList.remove('context-open'));
  financeState.contextDocumentId = '';
}

function financeOpenQuotationContextMenu(event, documentId) {
  event.preventDefault();
  event.stopPropagation();
  financeCloseMenus();
  const menu = financeEnsureQuotationContextMenu();
  financeState.contextDocumentId = documentId;
  document.querySelector(`.finance-list-row[data-document-id="${CSS.escape(String(documentId))}"]`)?.classList.add('context-open');
  menu.classList.add('open');
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  const x = showbaseViewport.toLayout(event.clientX);
  const y = showbaseViewport.toLayout(event.clientY);
  menu.style.left = `${Math.max(8, Math.min(x, showbaseViewport.width() - width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, showbaseViewport.height() - height - 8))}px`;
  menu.querySelector('button')?.focus();
}

function financeChangeSalespersonFromMenu() {
  const documentId = financeState.contextDocumentId;
  const source = financeState.documents.find(row => String(row.id) === String(documentId));
  financeCloseQuotationContextMenu();
  if (!documentId) return;
  financeOpenSalespersonReassignment({
    type: 'quotation',
    id: documentId,
    salesperson: source?.salesperson || source?.createdByName || source?.createdBy || '',
    salespersonUsername: source?.salespersonUsername || source?.createdBy || ''
  });
}

async function financeDuplicateQuotation() {
  const documentId = financeState.contextDocumentId;
  if (!documentId) return;
  const source = financeState.documents.find(row => row.id === documentId);
  financeCloseQuotationContextMenu();
  try {
    const response = await apiCall(
      `/api/quotations/${encodeURIComponent(documentId)}/duplicate`,
      'POST',
      {}
    );
    await financeLoadList(financeState.listQuery);
    showNotification('success', `${response.data.number} created as ${response.data.projectName || 'a quotation copy'}.`);
  } catch (error) {
    showNotification('error', error.message || `Failed to duplicate ${source?.number || 'quotation'}`);
  }
}

async function financeRenumberQuotation() {
  const documentId = financeState.contextDocumentId;
  if (!documentId) return;
  const source = financeState.documents.find(row => row.id === documentId);
  const numberParts = financeQuotationNumberParts(source?.number, source?.revision);
  financeCloseQuotationContextMenu();
  const requestedBase = await showAppPrompt({
    title: 'Renumber quotation',
    message: `Enter a new number for ${source?.number || 'this quotation'}. The ${numberParts.suffix} version suffix is managed automatically.`,
    inputLabel: 'Quotation number',
    defaultValue: numberParts.base,
    placeholder: 'QT-2026-001',
    confirmText: 'Renumber',
    cancelText: 'Cancel',
    required: true
  });
  if (requestedBase === null || requestedBase === false) return;
  const cleanBase = String(requestedBase || '').trim().replace(/-\d{2}$/, '').trim();
  if (!cleanBase || cleanBase === numberParts.base) return;
  try {
    const detail = await apiCall(`/api/quotations/${encodeURIComponent(documentId)}`);
    const current = detail.data;
    const currentParts = financeQuotationNumberParts(current.number, current.revision);
    const response = await apiCall(`/api/quotations/${encodeURIComponent(documentId)}`, 'PUT', {
      ...current,
      number: `${cleanBase}${currentParts.suffix}`,
      customNumber: true
    });
    financeUpdateListRow(response.data);
    showNotification('success', `Quotation renumbered to ${response.data.number}`);
  } catch (error) {
    showNotification('error', error.message || 'Failed to renumber quotation');
  }
}

async function financeDeleteQuotationFromMenu() {
  const documentId = financeState.contextDocumentId;
  if (!documentId) return;
  const source = financeState.documents.find(row => row.id === documentId);
  financeCloseQuotationContextMenu();
  const confirmed = await showAppConfirm({
    title: 'Delete quotation',
    message: `Delete ${source?.number || 'this quotation'}${source?.projectName ? ` (${source.projectName})` : ''}? This cannot be undone.`,
    confirmText: 'Delete quotation',
    cancelText: 'Cancel',
    variant: 'danger'
  });
  if (!confirmed) return;
  try {
    await apiCall(`/api/quotations/${encodeURIComponent(documentId)}`, 'DELETE');
    financeState.documents = financeState.documents.filter(row => row.id !== documentId);
    financeState.listMeta.total = Math.max(0, Number(financeState.listMeta.total || 0) - 1);
    financeState.listMeta.statusTotal = Math.max(0, Number(financeState.listMeta.statusTotal || 0) - 1);
    const counts = financeState.listMeta.statusCounts || (financeState.listMeta.statusCounts = {});
    const status = String(source?.status || 'draft').toLowerCase();
    counts[status] = Math.max(0, Number(counts[status] || 0) - 1);
    financeRenderList(financeState.listQuery);
    showNotification('success', `${source?.number || 'Quotation'} deleted`);
  } catch (error) {
    showNotification('error', error.message || 'Failed to delete quotation');
  }
}

function financeSetSentValidityUnit(value) {
  financeCloseMenus();
  const unit = financeValidityUnitMeta(value).value;
  const input = document.getElementById('financeSentValidityUnitValue');
  if (input) input.value = unit;
  const holder = document.getElementById('financeSentValidityUnitHolder');
  if (holder) holder.innerHTML = financeValidityUnitControl(unit, 'finance-sent-validity-unit-menu', 'financeSetSentValidityUnit');
}

document.addEventListener('click', event => {
  if (event.target.closest('.finance-custom-control')) return;
  financeCloseMenus();
});

function financeStatusControl(document, context = 'list') {
  const menuId = `finance-status-${context}-${document.id}`;
  return `
    <div class="finance-custom-control finance-status-control" onclick="event.stopPropagation()">
      <button type="button" class="finance-status" data-status="${financeEscapeAttr(document.status)}" onclick="financeToggleMenu('${financeEscapeAttr(menuId)}',event)">
        ${financeEscape(financeStatusLabel(document.status))}<span aria-hidden="true">⌄</span>
      </button>
      <div class="finance-custom-menu finance-status-menu" id="${financeEscapeAttr(menuId)}">
        ${FINANCE_STATUSES.map(status => `
          <button type="button" data-status="${status}" class="${status === document.status ? 'selected' : ''}" onclick="financeRequestStatus('${financeEscapeAttr(document.id)}','${status}','${context}')">
            <span class="finance-status-dot" data-status="${status}"></span>${financeEscape(financeStatusLabel(status))}
          </button>
        `).join('')}
      </div>
    </div>
  `;
}

function financeSnapshotControl(document) {
  const revisions = (document.revisions || []).filter(row => row && row.snapshot);
  if (!revisions.length) return '<span class="finance-muted-inline">No saved versions</span>';
  const menuId = `finance-snapshots-${document.id}`;
  return `
    <div class="finance-custom-control finance-snapshot-control" onclick="event.stopPropagation()">
      <button type="button" class="finance-snapshot-button" onclick="financeToggleMenu('${financeEscapeAttr(menuId)}',event)">
        ${revisions.length} version${revisions.length === 1 ? '' : 's'}<span aria-hidden="true">⌄</span>
      </button>
      <div class="finance-custom-menu finance-snapshot-menu" id="${financeEscapeAttr(menuId)}">
        ${revisions.map(row => `
          <div class="finance-snapshot-row">
            <button type="button" class="finance-snapshot-preview" title="Open PDF" onclick="financeOpenRevisionPdf('${financeEscapeAttr(document.id)}',${Number(row.revision) || 1})">
              <strong>${financeEscape(row.number || `Version ${row.revision}`)}</strong>
              <span>${financeEscape(financeSnapshotValidity(row))}</span>
            </button>
            <button type="button" class="finance-snapshot-edit" title="Edit this saved version" aria-label="Edit ${financeEscapeAttr(row.number || `version ${row.revision}`)}" onclick="financeEditRevision('${financeEscapeAttr(document.id)}',${Number(row.revision) || 1})">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"></path><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"></path><path d="m15 5 4 4"></path></svg>
            </button>
            <button type="button" class="finance-snapshot-delete" title="Delete this version" aria-label="Delete ${financeEscapeAttr(row.number || `version ${row.revision}`)}" onclick="financeDeleteRevision('${financeEscapeAttr(document.id)}',${Number(row.revision) || 1})">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18"></path><path d="M8 6V4h8v2"></path><path d="M19 6l-1 15H6L5 6"></path><path d="M10 11v5M14 11v5"></path></svg>
            </button>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

function financeCanExportInvoice(document = financeState.current) {
  return ['accepted', 'cancelled'].includes(String(document?.status || '').toLowerCase());
}

function financeExportInvoiceButton(document = financeState.current) {
  if (!financeCanExportInvoice(document)) return '';
  return `
    <button type="button" class="finance-export-invoice-button" onclick="event.stopPropagation();financeExportInvoice('${financeEscapeAttr(document.id)}')">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h7l4 4v14H7z"></path><path d="M14 3v5h4"></path><path d="M9 13h6M9 17h4"></path></svg>
      <span>Export Invoice</span>
    </button>
  `;
}

function financeCanExportQuotation(document = financeState.current) {
  return ['draft', 'sent'].includes(String(document?.status || '').toLowerCase());
}

function financeExportQuotationButton(document = financeState.current) {
  if (!financeCanExportQuotation(document)) return '';
  return `
    <button type="button" class="finance-export-quotation-button" onclick="event.stopPropagation();financeExportQuotation('${financeEscapeAttr(document.id)}')">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h7l4 4v14H7z"></path><path d="M14 3v5h4"></path><path d="M9 13h6M9 17h4"></path></svg>
      <span>Export Quotation</span>
    </button>
  `;
}

function ensureFinanceSections() {
  const firstSection = document.querySelector('.content-section');
  const parent = firstSection?.parentElement || document.body;
  const sections = [
    ['costing-section', '<div id="costing-page-root" class="finance-page costing-page"><div class="loading">Loading costing...</div></div>'],
    ['quotations-section', '<div id="quotations-page-root" class="finance-page"><div class="loading">Loading...</div></div>'],
    ['products-section', '<div id="products-page-root" class="finance-page finance-products-page"><div class="loading">Loading products...</div></div>'],
    ['clients-section', '<div id="clients-page-root" class="finance-page finance-clients-page"><div class="loading">Loading clients...</div></div>'],
    ['invoices-section', '<div id="invoices-page-root" class="finance-page invoice-page"><div class="loading">Loading invoices...</div></div>'],
    ['profit-loss-section', '<div id="profit-loss-page-root" class="finance-page profit-loss-page"><div class="loading">Loading...</div></div>'],
    ['accounting-section', '<div id="accounting-page-root" class="accounting-page"><div class="loading">Loading accounting...</div></div>'],
    ['compare-section', '<div id="compare-page-root" class="finance-page compare-page"><div class="loading">Loading...</div></div>']
  ];
  sections.forEach(([id, html]) => {
    if (document.getElementById(id)) return;
    const section = document.createElement('div');
    section.id = id;
    section.className = 'content-section';
    section.innerHTML = html;
    parent.appendChild(section);
  });
}

function setupFinanceNavigation() {
  ensureFinanceSections();
  const canUseFinance = typeof currentUserHasSalesAccess === 'function'
    ? currentUserHasSalesAccess()
    : !!(window.currentUser && (window.currentUser.hasSalesAccess || window.currentUser.isSales || window.currentUser.isSuperAdmin));
  const canUseAccounting = typeof canCurrentUserAccessAccounting === 'function'
    ? canCurrentUserAccessAccounting()
    : typeof currentUser !== 'undefined' && ['owner', 'admin'].includes(String(currentUser?.role || '').toLowerCase());
  const canUseClients = typeof canCurrentUserAccessClients === 'function'
    ? canCurrentUserAccessClients()
    : !!(
      typeof currentUser !== 'undefined'
      && currentUser
      && (
        ['owner', 'admin'].includes(String(currentUser.role || '').toLowerCase())
        || canUseFinance
      )
    );
  const canUseProducts = typeof canCurrentUserAccessProducts === 'function'
    ? canCurrentUserAccessProducts()
    : canUseClients;
  const sidebar = document.getElementById('appSidebar');
  if (!sidebar || (!canUseFinance && !canUseAccounting && !canUseClients && !canUseProducts)) return;
  const existing = sidebar.querySelector('[data-finance-navigation="true"]');
  if (existing) return;
  const section = document.createElement('div');
  section.className = 'nav-section';
  section.dataset.financeNavigation = 'true';
  section.innerHTML = `
    <h3>Finance</h3>
    ${canUseProducts ? '<button type="button" class="nav-item nav-item-inline" data-section="products">Products</button>' : ''}
    ${canUseClients ? '<button type="button" class="nav-item nav-item-inline" data-section="clients">Clients</button>' : ''}
    ${canUseFinance ? `
    <button type="button" class="nav-item nav-item-inline" data-section="costing">Costing</button>
    <button type="button" class="nav-item nav-item-inline" data-section="quotations">Quotations</button>
    <button type="button" class="nav-item nav-item-inline" data-section="invoices">Invoices</button>
    <button type="button" class="nav-item" data-section="profit-loss">Profit &amp; Loss</button>
    ` : ''}
    ${canUseAccounting ? '<button type="button" class="nav-item nav-item-inline accounting-access-only" data-section="accounting">Accounting <span class="accounting-beta-badge accounting-beta-badge-nav">Beta</span></button>' : ''}
  `;
  const reports = Array.from(sidebar.querySelectorAll('.nav-section')).find(row => row.querySelector('h3')?.textContent.trim() === 'Reports');
  const settings = Array.from(sidebar.querySelectorAll('.nav-section')).find(row => row.querySelector('h3')?.textContent.trim() === 'Settings');
  sidebar.insertBefore(section, reports || settings || null);
  sidebar.querySelector('.nav-section.accounting-access-only')?.remove();
  if (typeof setupSidebarNavigation === 'function') setupSidebarNavigation();
}

function financeRoot() {
  return document.getElementById('quotations-page-root');
}

const productCatalogState = {
  rows: [],
  query: '',
  category: '',
  sourceFilters: { inventory: true, additional: true },
  formOpen: false,
  loading: false,
  saving: false
};
const productCatalogSaveQueues = new Map();

function productsRoot() {
  return document.getElementById('products-page-root');
}

function productCatalogCategory(row) {
  return String(row?.productCategory || row?.department || 'General').trim() || 'General';
}

function productCatalogPageRows() {
  return (productCatalogState.rows || []).filter(row => !row.isContainer);
}

function productCatalogFilteredRows() {
  const query = String(productCatalogState.query || '').trim().toLowerCase();
  return productCatalogPageRows().filter(row => {
    const source = row.isCustom ? 'additional' : 'inventory';
    const matchesSource = productCatalogState.sourceFilters[source];
    const matchesCategory = productCatalogCategory(row) === productCatalogState.category;
    return matchesSource && matchesCategory && (!query || [
      productCatalogCategory(row), row.department, row.brand, row.model,
      row.description, row.productLabel, row.containerId, row.containerSerial,
      ...(row.searchTags || [])
    ].join(' ').toLowerCase().includes(query));
  }).sort((left, right) => String(
    left.productLabel || left.description || ''
  ).localeCompare(String(
    right.productLabel || right.description || ''
  ), undefined, { sensitivity: 'base' }));
}

function productCatalogCategories() {
  return [...new Set(productCatalogPageRows()
    .filter(row => productCatalogState.sourceFilters[row.isCustom ? 'additional' : 'inventory'])
    .map(row => productCatalogCategory(row))
    .filter(Boolean))]
    .sort((left, right) => left.localeCompare(right, undefined, { sensitivity: 'base' }));
}

function productCatalogTabsMarkup(categories = productCatalogCategories()) {
  return categories.map(category => `<button type="button" role="tab" aria-selected="${productCatalogState.category === category}" class="${productCatalogState.category === category ? 'active' : ''}" title="Right-click to manage category" onclick="productCatalogSetCategory('${financeEscapeAttr(encodeURIComponent(category))}')" oncontextmenu="productCatalogOpenCategoryMenu(event,'${financeEscapeAttr(encodeURIComponent(category))}')">${financeEscape(category)}</button>`).join('');
}

function productCatalogRefreshTabs() {
  const categories = productCatalogCategories();
  if (!categories.includes(productCatalogState.category)) {
    productCatalogState.category = categories[0] || '';
  }
  const tabs = productsRoot()?.querySelector('.finance-products-tabs');
  if (tabs) tabs.innerHTML = productCatalogTabsMarkup(categories);
}

function productCatalogRowsMarkup() {
  const rows = productCatalogFilteredRows();
  if (!rows.length) return `<div class="finance-products-empty"><strong>No products match this view.</strong><span>${productCatalogState.query ? 'Try another product name, brand, model or category.' : 'Choose another category or source filter, or add a product.'}</span></div>`;
  return `<div class="finance-product-table-wrap"><table class="finance-product-table">
    <thead><tr><th>Product label</th><th>Category</th><th>Source</th><th>Availability</th><th>UOM</th><th>Sale price</th><th><span class="sr-only">Actions</span></th></tr></thead>
    <tbody>${rows.map(row => {
      const index = productCatalogState.rows.indexOf(row);
      const productLabel = row.productLabel || [row.brand, row.model].filter(Boolean).join(' ') || row.description || 'Unnamed product';
      const availability = row.isCustom
        ? 'Not tracked'
        : `${financeNumber(row.availableQuantity ?? row.sourceAssetIds?.length, 0)} in inventory`;
      return `<tr>
        <td data-label="Product label"><input class="finance-input finance-product-label-input" value="${financeEscapeAttr(productLabel)}" maxlength="1000" aria-label="Product label" onchange="productCatalogUpdateField(${index},'productLabel',this.value,this)"></td>
        <td data-label="Category"><input class="finance-input finance-product-category-input" value="${financeEscapeAttr(productCatalogCategory(row))}" list="financeProductCategoryOptions" maxlength="240" aria-label="Category for ${financeEscapeAttr(productLabel)}" onchange="productCatalogUpdateField(${index},'productCategory',this.value,this)"></td>
        <td data-label="Source"><span class="finance-product-source ${row.isCustom ? 'additional' : 'inventory'}">${row.isCustom ? 'Added product' : 'Inventory'}</span></td>
        <td data-label="Availability">${financeEscape(availability)}</td>
        <td data-label="UOM"><select class="finance-input finance-product-uom-select" aria-label="UOM for ${financeEscapeAttr(productLabel)}" onchange="productCatalogUpdateField(${index},'uom',this.value,this)">${FINANCE_UOMS.map(option => `<option value="${option.value}" ${option.value === row.uom ? 'selected' : ''}>${financeEscape(option.label)}</option>`).join('')}</select></td>
        <td data-label="Sale price"><label class="finance-money-input"><span>$</span><input type="text" inputmode="decimal" value="${financeNumber(row.unitPrice) ? financeEscapeAttr(financeMoneyInputValue(row.unitPrice)) : ''}" placeholder="Not set" aria-label="Sale price for ${financeEscapeAttr(productLabel)}" onblur="if(this.value) financeFormatMoneyInput(this)" onchange="productCatalogUpdatePrice(${index},this.value,this)"></label></td>
        <td data-label="Actions">${row.isCustom ? `<button type="button" class="btn btn-danger compact" onclick="productCatalogDelete(${index})">Remove</button>` : ''}</td>
      </tr>`;
    }).join('')}</tbody>
  </table></div>`;
}

function productCatalogFormMarkup() {
  if (!productCatalogState.formOpen) return '';
  return `
    <form class="finance-card finance-product-form" onsubmit="productCatalogCreate(event)">
      <div class="finance-product-form-heading"><div><h3>Add product</h3><p>Create a non-inventory product for future quotations.</p></div><button type="button" class="finance-clients-form-close" aria-label="Close product form" onclick="productCatalogToggleForm(false)">×</button></div>
      <div class="finance-product-form-grid">
        <label class="finance-field finance-product-description"><span>Item label *</span><input class="finance-input" name="productLabel" maxlength="1000" required></label>
        <label class="finance-field"><span>Category *</span><input class="finance-input" name="department" list="financeProductCategoryOptions" required></label>
        <label class="finance-field"><span>Sale price</span><span class="finance-money-input"><span>$</span><input name="unitPrice" type="number" min="0" step="0.01" value="0"></span></label>
        <label class="finance-field"><span>Unit</span><select class="finance-input" name="uom">${FINANCE_UOMS.map(row => `<option value="${row.value}">${financeEscape(row.label)}</option>`).join('')}</select></label>
      </div>
      <div class="finance-product-form-actions"><button type="button" class="btn btn-secondary" onclick="productCatalogToggleForm(false)">Cancel</button><button type="submit" class="btn btn-primary" ${productCatalogState.saving ? 'disabled' : ''}>${productCatalogState.saving ? 'Saving…' : 'Add product'}</button></div>
    </form>`;
}

function productCatalogRender() {
  const root = productsRoot();
  if (!root) return;
  const pageRows = productCatalogPageRows();
  const inventoryCount = pageRows.filter(row => !row.isCustom).length;
  const additionalCount = pageRows.filter(row => row.isCustom).length;
  const visibleSourceCount = Number(productCatalogState.sourceFilters.inventory)
    + Number(productCatalogState.sourceFilters.additional);
  const categories = productCatalogCategories();
  const categoryOptions = [...new Set([
    ...(financeState.departments || []),
    ...pageRows.map(productCatalogCategory)
  ].map(value => String(value || '').trim()).filter(Boolean))].sort((left, right) => (
    left.localeCompare(right, undefined, { sensitivity: 'base' })
  ));
  if (!categories.includes(productCatalogState.category)) {
    productCatalogState.category = categories[0] || '';
  }
  root.innerHTML = `
    <datalist id="financeProductCategoryOptions">${categoryOptions.map(value => `<option value="${financeEscapeAttr(value)}"></option>`).join('')}</datalist>
    <div class="finance-toolbar finance-products-toolbar">
      <div class="finance-toolbar-heading"><h2>Products</h2><p class="finance-subtitle">The sale catalogue used by quotation search.</p></div>
      <div class="finance-toolbar-actions"><input class="finance-search" type="search" value="${financeEscapeAttr(productCatalogState.query)}" placeholder="Search products..." oninput="productCatalogSetQuery(this.value)"><button type="button" class="btn btn-primary" onclick="productCatalogToggleForm(true)">+ Add Product</button></div>
    </div>
    <div class="finance-products-guidance"><strong>Future quotations only.</strong><span>Price edits here change future additions; products already placed in quotations keep their saved prices.</span></div>
    ${productCatalogFormMarkup()}
    <div class="finance-card finance-products-card">
      <div class="finance-product-source-filters" aria-label="Product sources">
        <span>Show</span>
        <button type="button" class="${productCatalogState.sourceFilters.inventory ? 'active' : ''}" aria-pressed="${productCatalogState.sourceFilters.inventory}" onclick="productCatalogToggleSource('inventory')"><span class="finance-product-filter-check">✓</span> Inventory <strong>${inventoryCount}</strong></button>
        <button type="button" class="${productCatalogState.sourceFilters.additional ? 'active' : ''}" aria-pressed="${productCatalogState.sourceFilters.additional}" onclick="productCatalogToggleSource('additional')"><span class="finance-product-filter-check">✓</span> Added <strong>${additionalCount}</strong></button>
        <small>${visibleSourceCount === 2 ? 'Both sources selected' : 'One source selected'}</small>
      </div>
      <div class="finance-products-tabs" role="tablist" aria-label="Product categories">
        ${productCatalogTabsMarkup(categories)}
      </div>
      <div id="productCatalogResults">${productCatalogRowsMarkup()}</div>
    </div>`;
}

function productCatalogSetQuery(value) {
  productCatalogState.query = String(value || '');
  productCatalogRender();
  requestAnimationFrame(() => {
    const input = productsRoot()?.querySelector('.finance-search');
    input?.focus();
    input?.setSelectionRange(input.value.length, input.value.length);
  });
}

function productCatalogToggleSource(source) {
  if (!['inventory', 'additional'].includes(source)) return;
  const selectedCount = Object.values(productCatalogState.sourceFilters).filter(Boolean).length;
  if (productCatalogState.sourceFilters[source] && selectedCount === 1) return;
  productCatalogState.sourceFilters[source] = !productCatalogState.sourceFilters[source];
  productCatalogRender();
}

function productCatalogSetCategory(encodedCategory) {
  productCatalogState.category = decodeURIComponent(encodedCategory || '');
  productCatalogRender();
}

function productCatalogToggleForm(open = !productCatalogState.formOpen) {
  productCatalogState.formOpen = !!open;
  productCatalogRender();
  if (productCatalogState.formOpen) requestAnimationFrame(() => productsRoot()?.querySelector('[name="productLabel"]')?.focus());
}

function financeApplyProductRows(rows) {
  const nextRows = rows || [];
  productCatalogState.rows = nextRows;
  financeState.products = nextRows;
  financeState.rateCard = nextRows;
  financeState.catalogCache = {};
  return nextRows;
}

async function financePersistProduct(item, options = {}) {
  const response = await apiCall('/api/finance/products', 'POST', item);
  financeState.catalogCache = {};
  if (options.applyRows === false) return response.data || [];
  return financeApplyProductRows(response.data || []);
}

async function productCatalogPersistInline(item) {
  const key = String(
    item?.productKey || item?.catalogKey || item?.productId || item?.id || ''
  ).toLocaleLowerCase();
  const previous = productCatalogSaveQueues.get(key) || Promise.resolve();
  const snapshot = { ...item };
  const pending = previous.catch(() => undefined).then(() => (
    financePersistProduct(snapshot, { applyRows: false })
  ));
  productCatalogSaveQueues.set(key, pending);
  try {
    return await pending;
  } finally {
    if (productCatalogSaveQueues.get(key) === pending) {
      productCatalogSaveQueues.delete(key);
    }
  }
}

async function loadProducts(options = {}) {
  const root = productsRoot();
  if (!root || productCatalogState.loading) return;
  productCatalogState.loading = true;
  if (!options.silent) root.innerHTML = '<div class="loading">Loading products...</div>';
  try {
    const [productsResponse, departmentsResponse] = await Promise.all([
      apiCall('/api/finance/products'),
      apiCall('/api/finance/departments').catch(() => ({ data: [] }))
    ]);
    financeState.departments = departmentsResponse.data || financeState.departments;
    financeApplyProductRows(productsResponse.data || []);
    productCatalogRender();
  } catch (error) {
    root.innerHTML = '<div class="finance-empty">Could not load products.</div>';
  } finally {
    productCatalogState.loading = false;
  }
}

async function productCatalogCreate(event) {
  event.preventDefault();
  if (productCatalogState.saving || !event.currentTarget.reportValidity()) return;
  const payload = Object.fromEntries(new FormData(event.currentTarget).entries());
  payload.productLabel = String(payload.productLabel || '').trim();
  payload.description = payload.productLabel;
  payload.productCategory = String(payload.department || '').trim();
  productCatalogState.saving = true;
  try {
    await financePersistProduct({ ...payload, isCustom: true });
    productCatalogState.formOpen = false;
    productCatalogRender();
    showNotification('success', 'Product added');
  } catch (error) {
    productCatalogRender();
  } finally {
    productCatalogState.saving = false;
    if (productCatalogState.formOpen) productCatalogRender();
  }
}

async function productCatalogUpdatePrice(index, value, control = null) {
  const item = productCatalogState.rows[Number(index)];
  if (!item) return;
  const previousPrice = item.unitPrice;
  item.unitPrice = financeCurrencyNumber(value);
  try {
    await productCatalogPersistInline(item);
    showNotification('success', 'Product price updated for future additions');
  } catch (error) {
    item.unitPrice = previousPrice;
    if (control) control.value = financeNumber(previousPrice) ? financeMoneyInputValue(previousPrice) : '';
  }
}

async function productCatalogUpdateField(index, field, value, control = null) {
  const item = productCatalogState.rows[Number(index)];
  if (!item || !['productLabel', 'productCategory', 'uom'].includes(field)) return;
  const nextValue = String(value || '').trim();
  if (['productLabel', 'productCategory'].includes(field) && !nextValue) {
    if (control) control.value = item[field] || '';
    showNotification('error', `${field === 'productCategory' ? 'Category' : 'Product label'} is required`);
    return;
  }
  if (field === 'uom' && !FINANCE_UOMS.some(row => row.value === nextValue)) {
    return;
  }
  const previousValue = item[field];
  const previousDescription = item.description;
  item[field] = nextValue;
  if (field === 'productLabel' && item.isCustom) item.description = nextValue;
  try {
    await productCatalogPersistInline({
      ...item,
      ...(item.isCustom ? { brand: '', model: '', description: item.productLabel } : {})
    });
    if (field === 'productCategory' && previousValue !== nextValue) {
      const results = document.getElementById('productCatalogResults');
      const rowsRemainingInPreviousCategory = productCatalogFilteredRows().length;
      if (rowsRemainingInPreviousCategory) {
        control?.closest('tr')?.remove();
      } else {
        productCatalogState.category = nextValue;
        if (results) results.innerHTML = productCatalogRowsMarkup();
      }
      const categoryOptions = document.getElementById('financeProductCategoryOptions');
      if (categoryOptions && ![...categoryOptions.options].some(option => option.value === nextValue)) {
        categoryOptions.append(new Option('', nextValue));
      }
      productCatalogRefreshTabs();
    }
    const fieldLabel = field === 'uom' ? 'UOM' : field === 'productCategory' ? 'Category' : 'Product label';
    showNotification('success', `${fieldLabel} updated for future additions`);
  } catch (error) {
    item[field] = previousValue;
    if (field === 'productLabel' && item.isCustom) item.description = previousDescription;
    if (control) control.value = previousValue || '';
  }
}

function productCatalogEnsureCategoryMenu() {
  let menu = document.getElementById('financeProductCategoryMenu');
  if (menu) return menu;
  menu = document.createElement('div');
  menu.id = 'financeProductCategoryMenu';
  menu.className = 'finance-product-category-menu';
  menu.setAttribute('role', 'menu');
  menu.innerHTML = '<button type="button" class="rename" role="menuitem" onclick="productCatalogRenameCategory()">Rename category</button><button type="button" class="delete" role="menuitem" onclick="productCatalogDeleteCategory()">Delete category</button>';
  document.body.appendChild(menu);
  document.addEventListener('pointerdown', event => {
    if (!menu.contains(event.target)) productCatalogCloseCategoryMenu();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') productCatalogCloseCategoryMenu();
  });
  window.addEventListener('blur', productCatalogCloseCategoryMenu);
  return menu;
}

function productCatalogCloseCategoryMenu() {
  const menu = document.getElementById('financeProductCategoryMenu');
  if (!menu) return;
  menu.classList.remove('open');
  menu.removeAttribute('data-category');
}

function productCatalogOpenCategoryMenu(event, encodedCategory) {
  event.preventDefault();
  event.stopPropagation();
  const category = decodeURIComponent(encodedCategory || '');
  if (!category) return;
  const menu = productCatalogEnsureCategoryMenu();
  menu.dataset.category = category;
  menu.classList.add('open');
  const width = 172;
  const height = 76;
  menu.style.left = `${Math.max(8, Math.min(event.clientX, window.innerWidth - width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(event.clientY, window.innerHeight - height - 8))}px`;
  menu.querySelector('button')?.focus();
}

async function productCatalogRenameCategory() {
  const menu = document.getElementById('financeProductCategoryMenu');
  const category = String(menu?.dataset.category || '').trim();
  productCatalogCloseCategoryMenu();
  if (!category) return;
  const requested = await showAppPrompt({
    title: 'Rename product category',
    message: 'Inventory added later from this department will use the renamed category too.',
    inputLabel: 'Category name',
    defaultValue: category,
    confirmText: 'Rename',
    cancelText: 'Cancel',
    required: true
  });
  const nextCategory = String(requested || '').trim();
  if (!nextCategory || nextCategory.toLocaleLowerCase() === category.toLocaleLowerCase()) return;
  const existing = productCatalogCategories().find(value => (
    value.toLocaleLowerCase() === nextCategory.toLocaleLowerCase()
  ));
  if (existing) {
    const merge = await showAppConfirm({
      title: 'Merge product categories?',
      message: `${existing} already exists. All products in ${category} will be merged into it. Existing quotation items will not change.`,
      confirmText: 'Merge Categories',
      cancelText: 'Cancel'
    });
    if (!merge) return;
  }
  try {
    const response = await apiCall('/api/finance/products/category', 'PATCH', {
      category,
      newCategory: existing || nextCategory
    });
    financeApplyProductRows(response.data || []);
    productCatalogState.category = existing || nextCategory;
    productCatalogRender();
    showNotification(
      'success',
      response.merged ? 'Product categories merged' : 'Product category renamed'
    );
  } catch (error) {}
}

async function productCatalogDeleteCategory() {
  const menu = document.getElementById('financeProductCategoryMenu');
  const category = String(menu?.dataset.category || '').trim();
  productCatalogCloseCategoryMenu();
  if (!category) return;
  const targets = (productCatalogState.rows || []).filter(row => (
    productCatalogCategory(row).toLocaleLowerCase() === category.toLocaleLowerCase()
  ));
  const inventoryCount = targets.filter(row => !row.isCustom).length;
  const addedCount = targets.filter(row => row.isCustom).length;
  if (!addedCount) {
    showNotification('warning', 'Inventory products cannot be deleted');
    return;
  }
  const confirmed = await showAppConfirm({
    title: `Delete ${category} category?`,
    message: `${addedCount} added product${addedCount === 1 ? '' : 's'} will be deleted.${inventoryCount ? ` ${inventoryCount} inventory product${inventoryCount === 1 ? '' : 's'} will remain because inventory products cannot be deleted.` : ''} Existing quotations will not change.`,
    confirmText: 'Delete Category',
    cancelText: 'Cancel',
    destructive: true
  });
  if (!confirmed) return;
  try {
    const response = await apiCall('/api/finance/products/category', 'DELETE', { category });
    financeApplyProductRows(response.data || []);
    productCatalogRender();
    showNotification('success', inventoryCount ? 'Added products deleted; inventory products retained' : `${category} category deleted`);
  } catch (error) {}
}

async function productCatalogDelete(index) {
  const item = productCatalogState.rows[Number(index)];
  if (!item?.isCustom) return;
  const title = item.productLabel || [item.brand, item.model].filter(Boolean).join(' ') || item.description;
  const confirmed = await showAppConfirm({
    title: 'Remove product?',
    message: `${title} will no longer appear in product or quotation search. Existing quotation items will not change.`,
    confirmText: 'Remove Product',
    cancelText: 'Cancel',
    destructive: true
  });
  if (!confirmed) return;
  try {
    const response = await apiCall('/api/finance/products', 'DELETE', item);
    financeApplyProductRows(response.data || []);
    productCatalogRender();
    showNotification('success', 'Product removed');
  } catch (error) {}
}

function profitLossRoot() {
  return document.getElementById('profit-loss-page-root');
}

function compareRoot() {
  return document.getElementById('compare-page-root');
}

async function loadQuotations() {
  financeState.current = null;
  financeState.automaticDraftDateRefresh = false;
  financeState.eventPairTargetId = '';
  return financeLoadList();
}

async function financeLoadList(query = '', options = {}) {
  const root = financeRoot();
  if (!root) return;
  const append = options.append === true;
  if (append && (financeState.listLoading || !financeState.listMeta.hasMore)) return;
  const requestSeq = ++financeState.listRequestSeq;
  const cleanQuery = String(query || '').trim();
  financeState.listLoading = true;
  financeState.listQuery = cleanQuery;
  if (!append) {
    financeState.listMeta = {
      total: 0,
      hasMore: false,
      nextOffset: null,
      statusTotal: 0,
      statusCounts: {}
    };
    if (!root.querySelector('.finance-toolbar')) {
      root.innerHTML = '<div class="loading">Loading quotations...</div>';
    }
  }
  try {
    const params = new URLSearchParams();
    params.set('view', 'summary');
    params.set('limit', '40');
    params.set('offset', String(append ? financeState.listMeta.nextOffset || financeState.documents.length : 0));
    if (cleanQuery) params.set('query', cleanQuery);
    if (financeListCanToggleMine() && financeState.mineOnly) params.set('mine', '1');
    financeState.listStatuses.forEach(status => params.append('status', status));
    params.set('sort', financeState.listSort);
    const response = await apiCall(`/api/quotations?${params.toString()}`);
    if (requestSeq !== financeState.listRequestSeq) return;
    const incoming = response.data || [];
    if (append) {
      const existingIds = new Set(financeState.documents.map(row => String(row.id)));
      financeState.documents.push(
        ...incoming.filter(row => !existingIds.has(String(row.id)))
      );
    } else {
      financeState.documents = incoming;
    }
    financeState.listMeta = {
      total: Number(response.meta?.total ?? financeState.documents.length),
      hasMore: response.meta?.hasMore === true,
      nextOffset: response.meta?.nextOffset ?? null,
      statusTotal: Number(response.meta?.statusTotal ?? financeState.documents.length),
      statusCounts: response.meta?.statusCounts || {}
    };
    financeRenderList(cleanQuery);
  } catch (error) {
    if (requestSeq !== financeState.listRequestSeq) return;
    if (!append) {
      const results = document.getElementById('financeListResults');
      if (results) {
        results.innerHTML = '<div class="finance-empty">Could not load quotations.</div>';
      } else {
        root.innerHTML = '<div class="finance-empty">Could not load quotations.</div>';
      }
    } else {
      financeRenderList(cleanQuery);
    }
    showNotification('error', error.message || 'Failed to load quotations');
  } finally {
    if (requestSeq === financeState.listRequestSeq) financeState.listLoading = false;
  }
}

function financeLoadMore() {
  return financeLoadList(financeState.listQuery, { append: true });
}

function financeObserveListContinuation() {
  financeState.listObserver?.disconnect();
  financeState.listObserver = null;
  if (!financeState.listMeta.hasMore || typeof IntersectionObserver !== 'function') return;
  const sentinel = document.getElementById('financeListSentinel');
  if (!sentinel) return;
  financeState.listObserver = new IntersectionObserver(entries => {
    if (entries.some(entry => entry.isIntersecting)) financeLoadMore();
  }, { rootMargin: '240px 0px' });
  financeState.listObserver.observe(sentinel);
}

function financeListShowsSalesperson() {
  const role = typeof currentUserRole === 'function'
    ? currentUserRole()
    : String(window.currentUser?.role || '').toLowerCase();
  return role === 'admin'
    || (typeof isPlatformAdminUser === 'function' && isPlatformAdminUser());
}

function financeListCanToggleMine() {
  const role = typeof currentUserRole === 'function'
    ? currentUserRole()
    : String(window.currentUser?.role || '').toLowerCase();
  return role === 'admin'
    || (typeof isPlatformAdminUser === 'function' && isPlatformAdminUser());
}

function financeToggleMineOnly() {
  financeState.mineOnly = !financeState.mineOnly;
  const toggle = document.querySelector('.finance-list-mine-toggle');
  toggle?.classList.toggle('on', financeState.mineOnly);
  toggle?.setAttribute('aria-checked', financeState.mineOnly ? 'true' : 'false');
  financeLoadList(document.querySelector('.finance-search')?.value || '');
}

function financeListSortLabel(value = financeState.listSort) {
  return value === 'number' ? 'Quotation number' : 'Last modified';
}

function financeListSortControl() {
  const options = ['updated', 'number'];
  return `
    <div class="finance-custom-control finance-list-sort-control" onclick="event.stopPropagation()">
      <button type="button" class="finance-list-sort-button" onclick="financeToggleMenu('finance-list-sort-menu',event)" aria-haspopup="menu">
        <span id="financeListSortLabel">${financeEscape(financeListSortLabel())}</span><span aria-hidden="true">v</span>
      </button>
      <div class="finance-custom-menu finance-list-sort-menu" id="finance-list-sort-menu" role="menu">
        ${options.map(value => `
          <button type="button" class="${value === financeState.listSort ? 'selected' : ''}" onclick="financeSetListSort('${value}')">${financeEscape(financeListSortLabel(value))}</button>
        `).join('')}
      </div>
    </div>
  `;
}

function financeSetListSort(value) {
  financeState.listSort = value === 'number' ? 'number' : 'updated';
  financeCloseMenus();
  const label = document.getElementById('financeListSortLabel');
  if (label) label.textContent = financeListSortLabel();
  financeLoadList(document.querySelector('.finance-search')?.value || '');
}

function financeListStatusFiltersHtml() {
  const counts = financeState.listMeta.statusCounts || {};
  const allActive = financeState.listStatuses.length === 0;
  const statusButtons = FINANCE_LIST_STATUSES
    .filter(status => Number(counts[status] || 0) > 0 || financeState.listStatuses.includes(status))
    .map(status => {
      const active = financeState.listStatuses.includes(status);
      return `
        <button type="button" class="finance-list-filter ${active ? `status-${status} active` : ''}"
          aria-pressed="${active ? 'true' : 'false'}" onclick="financeToggleListStatus('${status}')">
          ${financeEscape(financeStatusLabel(status))}<span>${Number(counts[status] || 0)}</span>
        </button>
      `;
    }).join('');
  return `
    <div class="finance-list-status-filters" aria-label="Filter quotation statuses">
      <button type="button" class="finance-list-filter ${allActive ? 'active' : ''}"
        aria-pressed="${allActive ? 'true' : 'false'}" onclick="financeToggleListStatus('all')">
        All<span>${Number(financeState.listMeta.statusTotal || 0)}</span>
      </button>
      ${statusButtons}
    </div>
  `;
}

function financeRefreshListStatusFilters() {
  const filters = document.querySelector('.finance-list-status-filters');
  if (filters) filters.outerHTML = financeListStatusFiltersHtml();
}

function financeToggleListStatus(value) {
  if (value === 'all') {
    financeState.listStatuses = [];
  } else if (FINANCE_LIST_STATUSES.includes(value)) {
    financeState.listStatuses = financeState.listStatuses.includes(value)
      ? financeState.listStatuses.filter(status => status !== value)
      : [...financeState.listStatuses, value];
  }
  financeLoadList(document.querySelector('.finance-search')?.value || '');
}

function financePairedEventStatus(document) {
  const eventId = Number(document?.eventId || 0);
  const pairTargetId = financeEscapeAttr(document?.id || '');
  if (!eventId) {
    return `<div class="finance-event-cell-actions">
      <button type="button" class="finance-event-cell-action is-unpaired" title="Link an existing event" onclick="financeHandleQuotationEventClick(event,'${pairTargetId}',0)">Link</button>
      <button type="button" class="finance-event-cell-action is-unpaired" title="Create and link an event" onclick="financeCreateEventFromList(event,'${pairTargetId}')">Create</button>
    </div>`;
  }
  if (document.eventMissing) {
    return `<button type="button" class="finance-event-cell-action is-missing" onclick="financeHandleQuotationEventClick(event,'${pairTargetId}',0)">Event #${eventId} unavailable</button>`;
  }
  const state = String(document.eventState || '').trim();
  if (!state) {
    return `<button type="button" class="finance-event-cell-action" onclick="financeHandleQuotationEventClick(event,'${pairTargetId}',${eventId})">Event #${eventId}</button>`;
  }
  const badge = typeof planEventStateBadgeHtml === 'function'
    ? planEventStateBadgeHtml({ state })
    : `<span class="finance-event-state">${financeEscape(state)}</span>`;
  return `<button type="button" class="finance-event-cell-action" title="View Event #${eventId}" onclick="financeHandleQuotationEventClick(event,'${pairTargetId}',${eventId})"><span class="finance-event-status"><small>#${eventId}</small>${badge}</span></button>`;
}

function financeHandleQuotationEventClick(domEvent, documentId, eventId) {
  domEvent?.stopPropagation();
  const id = Number(eventId || 0);
  if (!id) {
    financeOpenEventPicker(documentId);
    return;
  }
  if (typeof viewEvent === 'function') viewEvent(id, { updateHistory: false });
}

async function financeCreateEventFromList(domEvent, documentId) {
  domEvent?.stopPropagation();
  const id = String(documentId || '');
  const quotation = financeState.documents.find(row => String(row.id) === id);
  if (!quotation || quotation.eventId || financeState.eventCreatingIds.has(id)) return;
  const confirmed = await showAppConfirm({
    title: 'Create event from quotation?',
    message: 'This creates and links an event now so planning can begin. The quotation status will remain unchanged.',
    confirmText: 'Create Event',
    cancelText: 'Cancel'
  });
  if (!confirmed || financeState.eventCreatingIds.has(id)) return;
  financeState.eventCreatingIds.add(id);
  try {
    const response = await apiCall(
      `/api/quotations/${encodeURIComponent(id)}/create-event`, 'POST', {}
    );
    const event = typeof registerCreatedEventInClient === 'function'
      ? await registerCreatedEventInClient(response.eventId).catch(() => null)
      : null;
    financeUpdateListRow({
      id,
      eventId: response.eventId,
      eventMissing: false,
      eventName: event?.name || quotation.projectName || '',
      eventState: event?.state || 'New',
      documentVersion: response.data?.documentVersion || quotation.documentVersion,
      updatedAt: response.data?.updatedAt || quotation.updatedAt,
      status: response.data?.status || quotation.status
    });
    showNotification('success', response.alreadyCreated
      ? `Quotation already linked to Event #${response.eventId}`
      : `Event #${response.eventId} created and linked`);
  } catch (error) {
    showNotification('error', error.message || 'Failed to create event. Check the quotation project, location and schedule.');
  } finally {
    financeState.eventCreatingIds.delete(id);
  }
}

function financeRenderListRow(document, showSalesperson = financeListShowsSalesperson()) {
  const client = document.client || {};
  const total = document.totals?.total ?? financeTotals(document).total;
  const dateSummary = financeListDateSummary(document);
  const eventDates = financeEventDateSummary(document);
  return `
    <tr class="finance-list-row ${document.status === 'cancelled' ? 'is-cancelled' : ''}" data-document-id="${financeEscapeAttr(document.id)}" onclick="financeOpenDocument('${financeEscapeAttr(document.id)}')" oncontextmenu="financeOpenQuotationContextMenu(event,'${financeEscapeAttr(document.id)}')">
      <td data-label="Quotation"><span class="finance-doc-number">${financeEscape(document.number)}</span><br><small>Ver ${String(document.revision || 1).padStart(2, '0')}</small>${document.invoiceNumber ? `<br><small class="finance-linked-invoice">Invoice ${financeEscape(document.invoiceNumber)}</small>` : ''}</td>
      <td data-label="Client"><strong>${financeEscape(financeClientName(client) || client.contactPerson || 'No client')}</strong><br><small>${financeEscape(client.company || client.email || '')}</small></td>
      <td data-label="Project" class="finance-project-cell"><strong>${financeEscape(document.projectName || 'Project name required')}</strong>${eventDates ? `<small class="finance-project-dates">${financeEscape(eventDates)}</small>` : ''}</td>
      ${showSalesperson ? `<td data-label="Salesperson"><strong>${financeEscape(document.salesperson || document.createdByName || document.createdBy || 'Unassigned')}</strong>${document.salespersonUsername || document.createdBy ? `<br><small>${financeEscape(document.salespersonUsername || document.createdBy)}</small>` : ''}</td>` : ''}
      <td data-label="Event">${financePairedEventStatus(document)}</td>
      <td data-label="Date"><span>${financeEscape(dateSummary.label)}${dateSummary.date ? ` ${financeEscape(dateSummary.date)}` : ''}</span>${dateSummary.detail ? `<br><small>${financeEscape(dateSummary.detail)}</small>` : ''}</td>
      <td data-label="Versions">${financeSnapshotControl(document)}</td>
      <td data-label="Status" class="finance-list-status-cell"><div class="finance-list-status-actions">${financeStatusControl(document, 'list')}</div></td>
      <td data-label="Export" class="finance-list-export-cell"><div class="finance-list-export-action">${financeExportQuotationButton(document)}${financeExportInvoiceButton(document)}</div></td>
      <td data-label="Total" style="text-align:right;font-weight:750;">${financeEscape(financeMoney(total))}</td>
    </tr>
  `;
}

function financeUpdateListRow(updated) {
  const index = financeState.documents.findIndex(row => row.id === updated.id);
  const previous = index >= 0 ? financeState.documents[index] : null;
  const merged = index >= 0
    ? { ...previous, ...updated }
    : updated;
  let statusCountsChanged = false;
  if (previous && previous.status !== merged.status) {
    const counts = financeState.listMeta.statusCounts || (financeState.listMeta.statusCounts = {});
    counts[previous.status] = Math.max(0, Number(counts[previous.status] || 0) - 1);
    counts[merged.status] = Number(counts[merged.status] || 0) + 1;
    statusCountsChanged = true;
  }
  if (financeState.listStatuses.length && !financeState.listStatuses.includes(merged.status)) {
    if (index >= 0) {
      financeState.documents.splice(index, 1);
      financeState.listMeta.total = Math.max(0, Number(financeState.listMeta.total || 0) - 1);
      financeRenderList(financeState.listQuery);
    }
    return;
  }
  if (index >= 0) financeState.documents[index] = merged;
  const currentRow = Array.from(financeRoot()?.querySelectorAll('.finance-list-row') || [])
    .find(row => row.dataset.documentId === String(updated.id));
  if (currentRow) currentRow.outerHTML = financeRenderListRow(merged);
  if (statusCountsChanged) financeRefreshListStatusFilters();
}

function financeListResultsHtml(showSalesperson = financeListShowsSalesperson()) {
  const rows = financeState.documents.map(document => financeRenderListRow(document, showSalesperson)).join('');
  const loadedCount = financeState.documents.length;
  const totalCount = Math.max(loadedCount, Number(financeState.listMeta.total || 0));
  return `
    <div class="finance-card" id="financeListResults">
      ${financeListStatusFiltersHtml()}
      ${rows ? `
        <table class="finance-list-table">
          <thead><tr><th>Number</th><th>Bill to</th><th>Project Name</th>${showSalesperson ? '<th>Salesperson</th>' : ''}<th>Event status</th><th>Date</th><th>Versions</th><th class="finance-list-status-heading">Status</th><th class="finance-list-export-heading">Export</th><th style="text-align:right;">Total</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <div class="finance-list-pagination">
          <span>Showing ${loadedCount} of ${totalCount} quotation${totalCount === 1 ? '' : 's'}</span>
          ${financeState.listMeta.hasMore ? `
            <button type="button" class="btn btn-secondary" onclick="financeLoadMore()">Load more</button>
            <span id="financeListSentinel" class="finance-list-sentinel" aria-hidden="true"></span>
          ` : ''}
        </div>
      ` : financeState.listStatuses.length
        ? `<div class="finance-empty">No quotations match the selected status${financeState.listStatuses.length === 1 ? '' : 'es'}.</div>`
        : '<div class="finance-empty">No quotations yet.<br><button type="button" class="btn btn-primary" style="margin-top:14px;" onclick="financeCreateDocument()">Create the first quotation</button></div>'}
    </div>
  `;
}

function financeRenderList(query = '') {
  const root = financeRoot();
  if (!root) return;
  const showSalesperson = financeListShowsSalesperson();
  const existingResults = document.getElementById('financeListResults');
  if (existingResults && root.contains(existingResults)) {
    existingResults.outerHTML = financeListResultsHtml(showSalesperson);
    requestAnimationFrame(financeObserveListContinuation);
    return;
  }
  const showMineToggle = financeListCanToggleMine();
  root.innerHTML = `
    <div class="finance-toolbar">
      <div class="finance-toolbar-heading">
        <div class="finance-toolbar-title-line">
          <h2>Quotations</h2>
          ${showMineToggle ? `
            <button
              type="button"
              class="finance-switch finance-list-mine-toggle ${financeState.mineOnly ? 'on' : ''}"
              role="switch"
              aria-checked="${financeState.mineOnly ? 'true' : 'false'}"
              onclick="financeToggleMineOnly()"
            ><span aria-hidden="true"></span>My projects</button>
          ` : ''}
        </div>
        <p class="finance-subtitle">Your quotations, versions and client approvals.</p>
      </div>
      <div class="finance-toolbar-actions">
        <input class="finance-search" type="search" value="${financeEscapeAttr(query)}" placeholder="Search quotations..." autocomplete="off" oninput="financeQueueListSearch(this.value)">
        ${financeListSortControl()}
        <button type="button" class="btn btn-primary" onclick="financeCreateDocument()">+ New Quotation</button>
      </div>
    </div>
    ${financeListResultsHtml(showSalesperson)}
  `;
  requestAnimationFrame(financeObserveListContinuation);
}

function financeQueueListSearch(query) {
  clearTimeout(financeState.listTimer);
  financeState.listQuery = String(query || '').trim();
  financeState.listRequestSeq += 1;
  financeState.listTimer = setTimeout(() => financeLoadList(query), 400);
}

async function financeLoadEditorData(force = false) {
  if (!force && financeState.editorDataLoadedAt && Date.now() - financeState.editorDataLoadedAt < 30000) return;
  const linkedEventId = Number(financeState.current?.eventId || 0);
  const [clientsResponse, departmentsResponse, linkedEventResponse, salespeopleResponse, planTemplatesResponse] = await Promise.all([
    apiCall('/api/clients').catch(() => ({ data: [] })),
    apiCall('/api/finance/departments').catch(() => ({ data: ['Manpower', 'Transportation'] })),
    linkedEventId
      ? apiCall(`/api/events?view=options&eventId=${encodeURIComponent(linkedEventId)}&limit=1`).catch(() => ({ data: [] }))
      : Promise.resolve({ data: [] }),
    apiCall('/api/finance/salespeople').catch(() => ({ data: [] })),
    apiCall('/api/invoice-plan-templates').catch(() => ({ data: [] }))
  ]);
  financeState.clients = clientsResponse.data || [];
  financeState.departments = departmentsResponse.data || ['Manpower', 'Transportation'];
  financeState.events = mergeEventsById(financeState.events, linkedEventResponse.data || []);
  financeState.salespeople = salespeopleResponse.data || [];
  financeState.invoicePlanTemplates = planTemplatesResponse.data || [];
  financeState.editorDataLoadedAt = Date.now();
}

async function financeCreateDocument() {
  try {
    const response = await apiCall('/api/quotations', 'POST', {});
    financeState.current = response.data;
    financeState.baseDocument = financeCloneDocument(response.data);
    financeState.automaticDraftDateRefresh = false;
    financeState.eventPairTargetId = financeState.current.id;
    financeState.current._createdBlank = true;
    financeState.current._initialQuotationDate = financeState.current.quotationDate || '';
    financeState.activeSubprojectId = financeSubprojects(financeState.current)[0]?.id || 'main';
    financeState.snapshotMode = false;
    financeState.addDepartment = '';
    if (typeof updateAppDetailHistory === 'function') {
      updateAppDetailHistory(`/quotations/${encodeURIComponent(financeState.current.id)}`);
    }
    await financeLoadEditorData();
    financeRenderEditor();
  } catch (error) {
    showNotification('error', error.message || 'Failed to create quotation');
  }
}

async function financeOpenDocument(documentId, options = {}) {
  const root = financeRoot();
  const listQuery = root?.querySelector('.finance-search')?.value || '';
  if (root) {
    root.innerHTML = `
      <div class="finance-editor-loading" role="status" aria-live="polite">
        <span class="finance-loading-spinner" aria-hidden="true"></span>
        <strong>Loading quotation...</strong>
      </div>
    `;
  }
  if (options.updateHistory !== false && typeof updateAppDetailHistory === 'function') {
    updateAppDetailHistory(`/quotations/${encodeURIComponent(documentId)}`, options.replaceHistory === true);
  }
  try {
    const editorDataPromise = financeLoadEditorData();
    const response = await apiCall(`/api/quotations/${encodeURIComponent(documentId)}`);
    financeState.current = response.data;
    financeState.baseDocument = financeCloneDocument(response.data);
    financeState.automaticDraftDateRefresh = false;
    financeState.eventPairTargetId = financeState.current.id;
    financeState.activeSubprojectId = financeSubprojects(financeState.current)[0]?.id || 'main';
    financeState.snapshotMode = false;
    financeState.addDepartment = '';
    const refreshedDraftDate = financeRefreshDraftDate();
    financeRenderEditor();
    if (refreshedDraftDate) {
      financeQueueSave({ automaticDraftDateRefresh: true });
    }
    editorDataPromise.then(() => {
      if (financeState.current?.id === documentId) financeRenderEditor();
    });
  } catch (error) {
    if (options.updateHistory !== false && typeof updateAppDetailHistory === 'function') {
      updateAppDetailHistory('/quotations', true);
    }
    financeRenderList(listQuery);
    showNotification('error', error.message || 'Failed to open quotation');
  }
}

function financeRefreshDraftDate(document = financeState.current) {
  if (!document || document.status !== 'draft') return false;
  const today = financeTodayIso();
  if (document.quotationDate === today) return false;
  document.quotationDate = today;
  return true;
}

function financeOpenRevisionPdf(documentId, revision) {
  financeCloseMenus();
  const url = `/api/quotations/${encodeURIComponent(documentId)}/pdf?revision=${encodeURIComponent(revision)}`;
  const opened = window.open(url, '_blank', 'noopener');
  if (!opened) showNotification('warning', 'Please allow pop-ups to preview the PDF');
}

async function financeEditRevision(documentId, revision) {
  financeCloseMenus();
  let documentRow = financeState.current?.id === documentId
    ? financeState.current
    : financeState.documents.find(row => row.id === documentId);
  let snapshotRow = (documentRow?.revisions || []).find(row => Number(row.revision) === Number(revision));
  if (!documentRow || !snapshotRow?.snapshot) {
    showNotification('error', 'This quotation version could not be loaded');
    return;
  }
  const confirmed = await showAppConfirm({
    title: 'Edit saved version?',
    message: `${snapshotRow.number || `Version ${revision}`} has already been saved as a quotation version. Changes will update this version and its archived PDF directly without creating a new version.`,
    confirmText: 'Edit Version',
    cancelText: 'Cancel'
  });
  if (!confirmed) return;
  if (snapshotRow.snapshot === true) {
    try {
      const response = await apiCall(`/api/quotations/${encodeURIComponent(documentId)}`);
      documentRow = response.data;
      snapshotRow = (documentRow?.revisions || [])
        .find(row => Number(row.revision) === Number(revision));
    } catch (error) {
      showNotification('error', error.message || 'Failed to load this quotation version');
      return;
    }
  }
  if (!snapshotRow?.snapshot || typeof snapshotRow.snapshot !== 'object') {
    showNotification('error', 'This quotation version could not be loaded');
    return;
  }
  financeState.current = {
    ...snapshotRow.snapshot,
    id: documentRow.id,
    type: documentRow.type,
    number: snapshotRow.number || snapshotRow.snapshot.number,
    revision: snapshotRow.revision,
    status: snapshotRow.status || 'sent',
    sentAt: snapshotRow.sentAt || '',
    validUntil: snapshotRow.validUntil || snapshotRow.snapshot.validUntil || '',
    validityAmount: snapshotRow.validityAmount || snapshotRow.snapshot.validityAmount || '',
    validityUnit: snapshotRow.validityUnit || snapshotRow.snapshot.validityUnit || 'days',
    validityDays: snapshotRow.validityDays || snapshotRow.snapshot.validityDays || 30,
    documentVersion: documentRow.documentVersion,
    revisions: documentRow.revisions || [],
    totals: snapshotRow.snapshot.totals || financeTotals(snapshotRow.snapshot)
  };
  financeState.automaticDraftDateRefresh = false;
  financeState.activeSubprojectId = financeSubprojects(financeState.current)[0]?.id || 'main';
  financeState.snapshotMode = false;
  financeState.addDepartment = '';
  financeState.current._editingSentRevision = Number(snapshotRow.revision) || 1;
  financeState.baseDocument = financeCloneDocument(financeState.current);
  if (typeof updateAppDetailHistory === 'function') {
    updateAppDetailHistory(`/quotations/${encodeURIComponent(documentId)}`);
  }
  financeRenderEditor();
}

async function financeDeleteRevision(documentId, revision) {
  financeCloseMenus();
  const documentRow = financeState.current?.id === documentId
    ? financeState.current
    : financeState.documents.find(row => row.id === documentId);
  const revisionRow = (documentRow?.revisions || []).find(row => Number(row.revision) === Number(revision));
  if (!documentRow || !revisionRow) return;
  const confirmed = await showAppConfirm({
    title: 'Delete sent version?',
    message: `${revisionRow.number || `Version ${revision}`} has been sent to the client. Deleting it removes its archived PDF and cannot be undone.`,
    confirmText: 'Delete Version',
    cancelText: 'Cancel',
    destructive: true
  });
  if (!confirmed) return;
  try {
    clearTimeout(financeState.saveTimer);
    const response = await apiCall(
      `/api/quotations/${encodeURIComponent(documentId)}/revisions/${encodeURIComponent(revision)}?documentVersion=${encodeURIComponent(documentRow.documentVersion || 1)}`,
      'DELETE'
    );
    if (financeState.current?.id === documentId) {
      financeState.current = response.data;
      financeState.baseDocument = financeCloneDocument(response.data);
      financeState.snapshotMode = false;
      financeRenderEditor();
    } else {
      const index = financeState.documents.findIndex(row => row.id === documentId);
      if (index >= 0) financeState.documents[index] = response.data;
      financeRenderList(document.querySelector('.finance-search')?.value || '');
    }
    showNotification('success', 'Quotation version deleted');
  } catch (error) {
    showNotification('error', error.message || 'Failed to delete quotation version');
  }
}

function financeCanDiscardDraft(document = financeState.current) {
  const revision = Number(document?.revision || 1);
  return document?.status === 'draft'
    && revision > 1
    && (document.revisions || []).some(row => Number(row?.revision || 0) < revision && row?.snapshot);
}

async function financeDiscardChanges() {
  const current = financeState.current;
  if (!current || !financeCanDiscardDraft(current)) return;
  const confirmed = await showAppConfirm({
    title: 'Discard draft changes?',
    message: `Discard version ${String(current.revision || 1).padStart(2, '0')} and restore the previous sent version? All changes in this draft will be lost.`,
    confirmText: 'Discard Changes',
    cancelText: 'Keep Editing',
    danger: true
  });
  if (!confirmed) return;
  financeState.discardingRevision = true;
  financeState.changeVersion += 1;
  clearTimeout(financeState.saveTimer);
  financeState.saveTimer = null;
  try {
    if (financeState.activeSaves.size) {
      await Promise.allSettled([...financeState.activeSaves]);
    }
    clearTimeout(financeState.saveTimer);
    financeState.saveTimer = null;
    const response = await apiCall(`/api/quotations/${encodeURIComponent(current.id)}/discard-revision`, 'POST', {
      documentVersion: current.documentVersion
    });
    financeState.current = response.data;
    financeState.baseDocument = financeCloneDocument(response.data);
    financeUpdateListRow(response.data);
    financeState.snapshotMode = false;
    financeRenderEditor();
    showNotification('success', `Draft discarded. ${response.data.number} has been restored.`);
  } catch (error) {
    showNotification('error', error.message || 'Failed to discard draft changes');
  } finally {
    financeState.discardingRevision = false;
  }
}

function financeClientDisplay(client) {
  return financeClientName(client) || client?.contactPerson || client?.company || '';
}

function financeClientRows(query) {
  const clean = String(query || '').trim().toLowerCase();
  return (financeState.clients || [])
    .map((client, index) => ({ client, index }))
    .filter(({ client }) => !clean || [
      client.name, client.company, client.contactPerson, client.email, client.phone
    ].some(value => String(value || '').toLowerCase().includes(clean)))
    .slice(0, 40);
}

function financeEnsureClientPickerModal() {
  if (document.getElementById('financeClientPickerModal')) return;
  const modal = document.createElement('div');
  modal.id = 'financeClientPickerModal';
  modal.className = 'modal';
  modal.innerHTML = `
    <div class="modal-content finance-picker-modal">
      <div class="modal-header"><h3 class="modal-title">Select known client</h3><button type="button" class="close-btn" onclick="closeModal('financeClientPickerModal')">×</button></div>
      <input id="financeClientPickerSearch" class="finance-input" placeholder="Select known clients..." autocomplete="off" oninput="financeRenderClientPickerResults(this.value)">
      <div id="financeClientPickerResults" class="finance-picker-results"></div>
      <div class="modal-actions finance-picker-actions">
        <button type="button" class="btn btn-secondary" onclick="closeModal('financeClientPickerModal')">Cancel</button>
        <button type="button" class="btn btn-primary" onclick="closeModal('financeClientPickerModal');financeOpenClientModal()">+ New Client</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
}

function financeRenderClientPickerResults(query = '') {
  const results = document.getElementById('financeClientPickerResults');
  if (!results) return;
  const rows = financeClientRows(query);
  results.innerHTML = rows.map(({ client, index }) => `
    <button type="button" class="finance-picker-option" onclick="financeApplySavedClientByIndex(${index})">
      <strong>${financeEscape(financeClientName(client) || client.contactPerson || client.company || 'Unnamed client')}</strong>
      <span>${financeEscape([client.company, client.email, client.phone].filter(Boolean).join(' · '))}</span>
    </button>
  `).join('') || '<div class="finance-suggestion-empty">No matching clients</div>';
}

function financeOpenClientPicker() {
  financeEnsureClientPickerModal();
  const search = document.getElementById('financeClientPickerSearch');
  if (search) search.value = '';
  financeRenderClientPickerResults('');
  openModal('financeClientPickerModal');
  setTimeout(() => search?.focus(), 50);
}

function financeApplySavedClientByIndex(index) {
  const client = financeState.clients[Number(index)];
  if (!client || !financeState.current) return;
  financeState.current.client = { ...client };
  financeState.current.clientRecordName = client.name;
  closeModal('financeClientPickerModal');
  financeQueueSave();
  financeRenderEditor();
}

function financeFindEvent(eventId) {
  const id = Number(eventId || 0);
  return financeState.events.find(event => Number(event.id) === id);
}

function financeEventDisplay(eventId) {
  const event = financeFindEvent(eventId);
  if (!event) return eventId ? `Event #${eventId}` : '';
  return `#${event.id} — ${event.name || 'Untitled event'}${event.location ? ` @ ${event.location}` : ''}`;
}

async function financeLoadEventOptions(preferredEventId = null) {
  const requestId = ++financeState.eventOptionsRequestSeq;
  const eventOptionsLoad = await startProgressiveEventOptions(
    preferredEventId,
    loaded => {
      if (requestId !== financeState.eventOptionsRequestSeq) return;
      financeState.events = loaded;
      if (typeof planEventChooserState !== 'undefined' && planEventChooserState.context === 'quotation-link') {
        renderPlanEventChooser();
      }
    }
  );
  if (requestId !== financeState.eventOptionsRequestSeq) return;
  financeState.events = eventOptionsLoad.first;
  if (typeof renderPlanEventChooser === 'function') renderPlanEventChooser();
  const loaded = await eventOptionsLoad.completion;
  if (requestId !== financeState.eventOptionsRequestSeq) return;
  financeState.events = loaded;
  if (typeof renderPlanEventChooser === 'function') renderPlanEventChooser();
}

async function financeOpenEventPicker(documentId = financeState.current?.id) {
  financeState.eventPairTargetId = String(documentId || '');
  planOpenEventChooser('quotation-link');
  try {
    await financeLoadEventOptions(financeState.current?.eventId || null);
  } catch (error) {
    showNotification('error', error.message || 'Unable to load events');
  }
}

async function financePairEvent(eventId) {
  const id = Number(eventId || 0);
  const targetId = String(financeState.eventPairTargetId || financeState.current?.id || '');
  if (!targetId || !id) return;
  const selectedEvent = financeFindEvent(id);
  if (financeState.current?.id === targetId) {
    try {
      financeState.current.eventId = id;
      closeModal('planEventChooserModal');
      financeQueueSave();
      const saved = await financeFlushPendingSave();
      if (!saved) return;
      financeState.eventPairTargetId = '';
      financeRenderEditor();
      showNotification('success', `Quotation paired to Event #${id}`);
    } catch (error) {
      showNotification('error', error.message || 'Failed to pair event');
    }
    return;
  }

  try {
    const response = await apiCall(
      `/api/quotations/${encodeURIComponent(targetId)}`,
      'PUT',
      {
        eventId: id,
        documentVersion: financeState.documents.find(row => row.id === targetId)?.documentVersion
      }
    );
    closeModal('planEventChooserModal');
    financeUpdateListRow({
      ...response.data,
      eventState: selectedEvent?.state || '',
      eventName: selectedEvent?.name || '',
      eventMissing: false
    });
    financeState.eventPairTargetId = '';
    showNotification('success', `Quotation paired to Event #${id}`);
  } catch (error) {
    showNotification('error', error.message || 'Failed to pair event');
  }
}

function financeUnpairEvent() {
  if (!financeState.current) return;
  financeState.current.eventId = null;
  financeQueueSave();
  financeRenderEditor();
}

async function financeGoToLinkedEventPlan() {
  if (typeof isAdminUser !== 'function' || !isAdminUser()) return;
  try {
    const saved = await financeFlushPendingSave();
    const eventId = Number(saved?.eventId || 0);
    if (!eventId) return;
    if (typeof openEventPlanning !== 'function') {
      throw new Error('Plan is unavailable right now');
    }
    await openEventPlanning(eventId);
  } catch (error) {
    showNotification('error', error.message || 'Unable to open the event plan');
  }
}

function financeEventCreationIssue(document = financeState.current) {
  if (!String(document?.projectName || '').trim()) return 'Add a project name first.';
  if (
    String(document?.scheduleMode || 'event').toLowerCase() !== 'dry-hire' &&
    !String(document?.eventLocation || '').trim()
  ) return 'Add the event location first.';
  const scheduleDates = [
    document?.setupDate,
    document?.rehearsalDate,
    document?.showDate,
    document?.teardownDate,
    ...Object.values(FINANCE_SCHEDULE_KEYS).flatMap(key =>
      (document?.[key] || []).map(row => row?.date)
    ),
    ...(document?.customScheduleGroups || []).flatMap(group =>
      (group?.dates || []).map(row => row?.date)
    )
  ].filter(Boolean);
  if (!scheduleDates.length) return 'Add at least one event schedule date first.';
  return '';
}

function financeRefreshEventCreationControls(overrides = {}) {
  const button = document.getElementById('financeCreateEventButton');
  const note = document.getElementById('financeEventCreationNote');
  if (!button || !note) return;
  const issue = financeEventCreationIssue({
    ...(financeState.current || {}),
    ...overrides
  });
  button.disabled = Boolean(issue);
  button.title = issue || 'Create and pair a planning event';
  note.textContent = issue;
  note.hidden = !issue;
}

function financePreviewEventField(field, value) {
  if (!financeState.current) return;
  financeState.current[field] = value;
  if (field === 'projectName') financeState.current.title = value;
  financeRefreshEventCreationControls();
}

async function financeCreateEventFromQuotation() {
  const current = financeState.current;
  if (!current || current.eventId) return;
  const creationIssue = financeEventCreationIssue(current);
  if (creationIssue) {
    showNotification('warning', creationIssue);
    return;
  }
  const confirmed = await showAppConfirm({
    title: 'Create event from quotation?',
    message: 'This creates and pairs an event now so planning can begin. The quotation status will remain unchanged.',
    confirmText: 'Create Event',
    cancelText: 'Cancel'
  });
  if (!confirmed) return;
  try {
    await financeFlushPendingSave();
    const response = await apiCall(
      `/api/quotations/${encodeURIComponent(current.id)}/create-event`,
      'POST',
      {}
    );
    financeState.current = response.data;
    if (typeof registerCreatedEventInClient === 'function') {
      await registerCreatedEventInClient(response.eventId);
    }
    showNotification('success', `Event #${response.eventId} created and paired`);
    if (typeof openEventPlanning === 'function') {
      openEventPlanning(response.eventId);
    } else {
      financeRenderEditor();
    }
  } catch (error) {
    showNotification('error', error.message || 'Failed to create event');
  }
}

async function financeOpenCosting() {
  if (!financeState.current || typeof costingOpen !== 'function') return;
  try {
    await financeFlushPendingSave();
    let costingId = financeState.current?.sourceCostingId;
    if (!costingId) {
      const response = await apiCall(
        `/api/quotations/${encodeURIComponent(financeState.current.id)}/costing`,
        'POST',
        {}
      );
      costingId = response.data?.id;
      if (response.quotation) financeState.current = response.quotation;
    }
    if (!costingId) throw new Error('Costing is still being prepared. Save the quotation and try again.');
    showSection('costing');
    await costingOpen(costingId);
  } catch (error) {
    showNotification('error', error.message || 'Failed to open costing');
  }
}

async function financeOpenComparePage() {
  const document = financeState.current;
  if (!document?.eventId) return;
  try {
    await financeSaveCurrent(false);
  } catch (error) {
    showNotification('error', error.message || 'Save the quotation before comparing');
    return;
  }
  if (typeof openCompareForEvent === 'function') {
    openCompareForEvent(document.eventId, document.id);
  }
}

function financeDepartmentSuggestions(query) {
  const clean = String(query || '').trim().toLowerCase();
  const documentLines = financeState.current?.lineItems || [];
  const currentCategories = financeActiveDepartments(financeState.current);
  const allCategories = documentLines.map(line => financeLineSystem(line));
  const renamedCategories = documentLines
    .filter(financeIsRenamedCategory)
    .map(line => financeLineSystem(line));
  const values = [];
  [
    ...renamedCategories,
    ...currentCategories,
    ...allCategories,
    ...(financeState.departments || []).map(financeDefaultSystemName),
    'Manpower',
    'Transportation'
  ].forEach(value => {
    const label = String(value || '').trim();
    if (
      !label
      || !isSelectableCompanyDepartment({
        code: label,
        name: label.replace(/\s+(?:department|system)$/i, '')
      })
      || values.some(existing => existing.toLocaleLowerCase() === label.toLocaleLowerCase())
    ) return;
    values.push(label);
  });
  return values.filter(value => !clean || value.toLowerCase().includes(clean)).slice(0, 10);
}

function financeShowDepartmentSuggestions(index, query, targetId) {
  const results = document.getElementById(targetId);
  if (!results) return;
  results.innerHTML = financeDepartmentSuggestions(query).map(value => `
    <button type="button" onmousedown="event.preventDefault()" onclick="financeChooseDepartment(${index},'${financeEscapeAttr(encodeURIComponent(value))}')">${financeEscape(value)}</button>
  `).join('');
  results.classList.add('open');
}

function financeChooseDepartment(index, encodedValue) {
  const value = decodeURIComponent(encodedValue);
  const line = financeState.current?.lineItems?.[index];
  if (!line) return;
  const input = document.querySelector(`[data-finance-department-index="${index}"]`);
  if (input) {
    input.value = value;
    input.dataset.departmentSelectionCommitted = 'true';
  }
  line.systemName = value;
  financeSyncDocumentDepartments();
  financeQueueSave();
  financeRenderEditor();
}

function financeCommitDepartmentInput(index, input) {
  if (input?.dataset?.departmentSelectionCommitted === 'true') return;
  financeLineChange(index, 'systemName', input?.value || '');
}

function financeShowAddDepartmentSuggestions(query) {
  const results = document.getElementById('financeAddDepartmentResults');
  if (!results) return;
  results.innerHTML = financeDepartmentSuggestions(query).map(value => `
    <button type="button" onmousedown="event.preventDefault()" onkeydown="financeAddDepartmentSuggestionKeydown(event,'${financeEscapeAttr(encodeURIComponent(value))}')" onclick="financeChooseAddDepartment('${financeEscapeAttr(encodeURIComponent(value))}')">${financeEscape(value)}</button>
  `).join('');
  results.classList.add('open');
}

function financeAddDepartmentSuggestionKeydown(event, encodedValue) {
  if (showbaseLineWorkspace.suggestionOptionKeydown(event, 'financeAddDepartmentResults')) return;
  if (event.key !== 'Enter') return;
  event.preventDefault();
  event.stopPropagation();
  financeChooseAddDepartment(encodedValue, true);
}

function financeChooseAddDepartment(encodedValue, addPending = false) {
  financeState.addDepartment = decodeURIComponent(encodedValue);
  const input = document.getElementById('financeAddDepartmentInput');
  if (input) input.value = financeState.addDepartment;
  document.getElementById('financeAddDepartmentResults')?.classList.remove('open');
  if (!addPending || !financeState.pendingCatalogSelection) return;
  const pending = financeState.pendingCatalogSelection;
  financeState.pendingCatalogSelection = null;
  if (pending.isKeyboardCustom) {
    financeAddCustomItem();
    return;
  }
  financeState.catalog = [pending];
  financeSelectCatalog(0);
}

function financeAddDepartmentOverride() {
  return String(document.getElementById('financeAddDepartmentInput')?.value || financeState.addDepartment || '').trim();
}

function financeUomControl(line, index) {
  const menuId = `finance-uom-${line.id}`;
  return `
    <div class="finance-custom-control">
      <button type="button" class="finance-line-select-button" onclick="financeToggleMenu('${financeEscapeAttr(menuId)}',event)">${financeEscape(financeUomLabel(line.uom))}<span>⌄</span></button>
      <div class="finance-custom-menu finance-uom-menu" id="${financeEscapeAttr(menuId)}">
        ${FINANCE_UOMS.map(row => `<button type="button" class="${row.value === line.uom ? 'selected' : ''}" onclick="financeLineChange(${index},'uom','${row.value}')">${financeEscape(row.label)}</button>`).join('')}
      </div>
    </div>
  `;
}

function financeAdjustmentRows(department) {
  const subprojectId = financeCurrentSubprojectId();
  return (financeState.current?.adjustments || [])
    .filter(row => row.scope === 'department' && row.department === department && (row.subprojectId || 'main') === subprojectId)
    .map(row => `
      <tr class="finance-adjustment-row finance-adjustment-editor-row">
        <td></td>
        <td colspan="3"><input class="finance-adjustment-label" value="${financeEscapeAttr(row.label || 'Discount')}" aria-label="Discount name" onchange="financeSetAdjustmentLabel('${financeEscapeAttr(row.id)}',this.value)"></td>
        <td colspan="2"><span class="finance-percent-input finance-adjustment-percent"><input type="number" min="0" max="100" step="0.1" value="${financeEscapeAttr(financeNumber(row.percent).toFixed(2).replace(/\.?0+$/, ''))}" aria-label="Discount percentage" onchange="financeSetDepartmentAdjustmentPercent('${financeEscapeAttr(row.id)}','${financeEscapeAttr(encodeURIComponent(department))}',this.value)"><span>%</span></span></td>
        <td colspan="2"><div class="finance-money-input finance-adjustment-amount"><span>$</span><input type="text" inputmode="decimal" value="${financeEscapeAttr(financeMoneyInputValue(row.amount))}" aria-label="Discount amount" onblur="financeFormatMoneyInput(this)" onchange="financeSetDepartmentAdjustmentAmount('${financeEscapeAttr(row.id)}','${financeEscapeAttr(encodeURIComponent(department))}',this.value)"></div></td>
        <td></td>
        <td><button type="button" class="finance-delete-line" onclick="financeRemoveAdjustment('${financeEscapeAttr(row.id)}')">×</button></td>
      </tr>
    `).join('');
}

function financeTotalAdjustmentRows() {
  return (financeState.current?.adjustments || [])
    .filter(row => row.scope === 'total')
    .map(row => {
      const lockedAdjustment = financeIsLockedAdjustment(row);
      const label = lockedAdjustment
        ? String(financeState.current?.totalDiscountLabel || '').trim() || 'Total discount'
        : row.label || 'Total adjustment';
      const changeHandler = lockedAdjustment
        ? 'financeSetTotalDiscountLabel(this.value)'
        : `financeSetAdjustmentLabel('${financeEscapeAttr(row.id)}',this.value)`;
      return `
        <tr class="finance-adjustment-row finance-adjustment-editor-row finance-total-adjustment-row">
          <td></td>
          <td colspan="7"><input class="finance-adjustment-label" value="${financeEscapeAttr(label)}" aria-label="Total discount name" onchange="${changeHandler}"></td>
          <td style="text-align:right;">${financeEscape(financeMoney(row.amount))}</td>
          <td></td>
        </tr>
      `;
    }).join('');
}

function financeGroupedLineDescription(line) {
  const description = String(line?.description || '').trim();
  if (!description) return '';
  const brand = String(line?.brand || '').trim();
  const model = String(line?.model || '').trim();
  const prefixes = [
    [brand, model].filter(Boolean).join(' '),
    [model, brand].filter(Boolean).join(' '),
    brand,
    model
  ].filter(Boolean).sort((left, right) => right.length - left.length);
  let remainder = description;
  for (let pass = 0; pass < 4; pass += 1) {
    let stripped = false;
    for (const prefix of [...new Set(prefixes)]) {
      if (!remainder.toLocaleLowerCase().startsWith(prefix.toLocaleLowerCase())) continue;
      const boundary = remainder.slice(prefix.length, prefix.length + 1);
      if (boundary && !/[\s\-\u2013\u2014:|/]/.test(boundary)) continue;
      // Strip repeated legacy prefixes too ("Brand Model Brand Model …").
      const next = remainder.slice(prefix.length).trim();
      if (!next) break;
      remainder = next;
      stripped = true;
      break;
    }
    if (!stripped) break;
  }
  return remainder;
}

function financeGroupedLineDisplay(line) {
  const fields = Array.isArray(line?.groupDisplayFields) && line.groupDisplayFields.length
    ? line.groupDisplayFields
    : ['brand', 'model', 'description'];
  const values = fields.map(field => (
    field === 'description'
      ? financeGroupedLineDescription(line)
      : String(line?.[field] || '').trim()
  )).filter(Boolean);
  return [...new Set(values)].join(' ') || String(line?.description || 'Item');
}

function financeGroupWorkingLines(mode = financeLineGroupState.mode) {
  if (mode === 'delivery-order') {
    return typeof deliveryOrderGroupWorkingLines === 'function'
      ? deliveryOrderGroupWorkingLines()
      : [];
  }
  return mode === 'costing'
    ? (typeof costingLines === 'function' ? costingLines() : [])
    : (financeState.current?.lineItems || []);
}

function financeGroupActiveSubproject(mode = financeLineGroupState.mode) {
  if (mode === 'delivery-order') {
    return typeof deliveryOrderActiveSubprojectId === 'function'
      ? deliveryOrderActiveSubprojectId()
      : 'main';
  }
  return mode === 'costing'
    ? (typeof costingActiveSubprojectId === 'function' ? costingActiveSubprojectId() : 'main')
    : financeCurrentSubprojectId();
}

function financeOpenLineGroupEditor(mode = 'finance', groupId = '') {
  clearTimeout(financeLineGroupState.searchTimer);
  financeLineGroupState.searchRequestSeq += 1;
  financeLineGroupState.queuedSearch = null;
  financeLineGroupState.searchAbortController?.abort?.();
  const lines = financeGroupWorkingLines(mode);
  const activeSubprojectId = financeGroupActiveSubproject(mode);
  const existing = groupId ? lines.filter(line => (
    String(line.groupId || '') === String(groupId)
    && String(line.subprojectId || 'main') === String(activeSubprojectId || 'main')
  )) : [];
  const first = existing[0] || {};
  const commercialLeader = existing.find(line => line.groupLeader) || first;
  financeLineGroupState.mode = mode;
  financeLineGroupState.groupId = String(groupId || `group_${Date.now()}_${Math.random().toString(16).slice(2)}`);
  financeLineGroupState.subprojectId = String(activeSubprojectId || 'main');
  financeLineGroupState.title = String(first.groupTitle || '');
  financeLineGroupState.category = String(
    mode === 'costing'
      ? first.category || costingState.addCategory || 'General'
      : (mode === 'delivery-order'
          ? first.category || first.department || 'MISC'
          : financeLineSystem(first) || financeState.addDepartment || 'General')
  );
  financeLineGroupState.groupQuantity = Math.max(
    1,
    financeNumber(first.groupHeaderQuantity, 1)
  );
  financeLineGroupState.displayFields = Array.isArray(first.groupDisplayFields) && first.groupDisplayFields.length
    ? [...first.groupDisplayFields]
    : ['brand', 'model', 'description'];
  financeLineGroupState.selected = existing
    .filter(line => !line.groupCustomText && !line.groupPlaceholder)
    .map(line => ({
      key: financeLineGroupResultKey(line),
      line: JSON.parse(JSON.stringify(line))
    }));
  financeLineGroupState.customText = String(existing.find(line => line.groupCustomText)?.description || '');
  financeLineGroupState.commercialHeader = existing.length && mode === 'finance' ? {
    days: financeNumber(commercialLeader.days, 1),
    quantity: financeNumber(commercialLeader.quantity, 1),
    uom: commercialLeader.uom || 'sets',
    unitPrice: financeNumber(commercialLeader.unitPrice),
    discountPercent: financeNumber(commercialLeader.discountPercent),
    totalMode: commercialLeader.totalMode || 'amount',
    total: financeLineTotal(commercialLeader),
    groupPricingMode: financeGroupPricingMode(existing)
  } : null;
  financeLineGroupState.results = [];

  let modal = document.getElementById('financeLineGroupModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'financeLineGroupModal';
    modal.className = 'modal';
    modal.innerHTML = `
      <div class="modal-content finance-line-group-modal">
        <div class="modal-header"><h3 id="financeLineGroupHeading">Add group</h3><button type="button" class="modal-close" onclick="closeModal('financeLineGroupModal')">&times;</button></div>
        <div class="finance-line-group-form">
          <div class="finance-line-group-basics">
            <label class="finance-field"><span>Group header</span><input id="financeLineGroupTitle" class="finance-input" maxlength="500" placeholder="e.g. Wireless microphone package"></label>
            <label class="finance-field"><span>Category</span><div class="finance-inline-combobox"><input id="financeLineGroupCategory" class="finance-input" maxlength="200" placeholder="e.g. Audio System" autocomplete="off" onfocus="financeShowLineGroupCategorySuggestions(this.value)" oninput="financeShowLineGroupCategorySuggestions(this.value)" onkeydown="showbaseLineWorkspace.suggestionKeydown(event,'financeLineGroupCategoryResults')" onblur="setTimeout(()=>showbaseLineWorkspace.hideSuggestionsUnlessFocused('financeLineGroupCategoryResults'),120)"><div id="financeLineGroupCategoryResults" class="finance-inline-suggestions"></div></div></label>
            <label class="finance-field" id="financeLineGroupQuantityField" hidden><span>Group quantity</span><input id="financeLineGroupQuantity" class="finance-input" type="number" min="1" max="999" step="1" value="1"></label>
          </div>
          <fieldset class="finance-line-group-fields"><legend>Show for assets</legend>
            <label><input type="checkbox" value="brand" onchange="financeLineGroupFieldsChanged()"> Brand</label>
            <label><input type="checkbox" value="model" onchange="financeLineGroupFieldsChanged()"> Model</label>
            <label><input type="checkbox" value="description" onchange="financeLineGroupFieldsChanged()"> Description</label>
          </fieldset>
          <label class="finance-field"><span>Find assets or containers</span><input id="financeLineGroupSearch" class="finance-input" autocomplete="off" placeholder="Search inventory..." oninput="financeSearchLineGroupCatalog(this.value)"></label>
          <div id="financeLineGroupResults" class="finance-line-group-results"></div>
          <div><span class="finance-line-group-section-label">Group contents</span><div id="financeLineGroupSelection" class="finance-line-group-selection"></div></div>
          <label class="finance-field"><span>Custom text (optional)</span><textarea id="financeLineGroupCustomText" class="finance-textarea" rows="3" placeholder="Enter text that should appear as part of this group"></textarea></label>
        </div>
        <div class="modal-footer"><button type="button" class="btn btn-secondary" onclick="closeModal('financeLineGroupModal')">Cancel</button><button type="button" class="btn btn-primary" onclick="financeSaveLineGroup()">Save group</button></div>
      </div>`;
    document.body.appendChild(modal);
  }
  document.getElementById('financeLineGroupHeading').textContent = existing.length ? 'Edit group' : 'Add group';
  document.getElementById('financeLineGroupTitle').value = financeLineGroupState.title;
  document.getElementById('financeLineGroupCategory').value = financeLineGroupState.category;
  const quantityField = document.getElementById('financeLineGroupQuantityField');
  const quantityControl = document.getElementById('financeLineGroupQuantity');
  if (quantityField && quantityControl) {
    const supportsGroupQuantity = true;
    quantityField.hidden = !supportsGroupQuantity;
    quantityField.closest('.finance-line-group-basics')?.classList.toggle(
      'has-group-quantity',
      supportsGroupQuantity
    );
    quantityControl.value = financeLineGroupState.groupQuantity;
  }
  document.getElementById('financeLineGroupCustomText').value = financeLineGroupState.customText;
  modal.querySelectorAll('.finance-line-group-fields input').forEach(input => {
    input.checked = financeLineGroupState.displayFields.includes(input.value);
  });
  document.getElementById('financeLineGroupSearch').value = '';
  financeRenderLineGroupResults();
  financeRenderLineGroupSelection();
  openModal('financeLineGroupModal');
  setTimeout(() => document.getElementById('financeLineGroupTitle')?.focus(), 40);
}

function financeLineGroupCategorySuggestions(query = '') {
  const mode = financeLineGroupState.mode;
  const values = mode === 'costing' && typeof costingAvailableCategories === 'function'
    ? costingAvailableCategories()
    : financeDepartmentSuggestions(query);
  const needle = String(query || '').trim().toLocaleLowerCase();
  return [...new Set(values.map(value => String(value || '').trim()).filter(Boolean))]
    .filter(value => !needle || value.toLocaleLowerCase().includes(needle))
    .slice(0, 12);
}

function financeShowLineGroupCategorySuggestions(query = '') {
  const results = document.getElementById('financeLineGroupCategoryResults');
  if (!results) return;
  results.innerHTML = financeLineGroupCategorySuggestions(query).map(value => `
    <button type="button" onmousedown="event.preventDefault()" onclick="financeChooseLineGroupCategory('${financeEscapeAttr(encodeURIComponent(value))}')">${financeEscape(value)}</button>
  `).join('') || '<div class="finance-suggestion-empty">Enter a new category name</div>';
  results.classList.add('open');
}

function financeChooseLineGroupCategory(encodedValue) {
  const value = decodeURIComponent(encodedValue || '');
  const input = document.getElementById('financeLineGroupCategory');
  if (input) input.value = value;
  showbaseLineWorkspace.hideSuggestions('financeLineGroupCategoryResults');
}

function financeEditLineGroup(event, mode, groupId) {
  event?.preventDefault?.();
  event?.stopPropagation?.();
  financeOpenLineGroupEditor(mode, groupId);
}

function financeRenderLineGroupResults() {
  const root = document.getElementById('financeLineGroupResults');
  if (!root) return;
  root.innerHTML = (financeLineGroupState.results || []).map((row, index) => {
    const category = row.isContainer && financeLineGroupState.mode === 'finance'
      ? financeContainerMajorityCategory(row)
      : row.department || 'General';
    return `
      <button type="button" onclick="financeAddLineGroupResult(${index})">
        <span><strong>${financeCatalogDescription(row)}</strong><small>${financeEscape(category)}${row.isContainer ? ' &middot; container' : ''}</small></span><b>+</b>
      </button>`;
  }).join('');
  root.classList.toggle('open', Boolean(financeLineGroupState.results?.length));
}

function financeRunLineGroupCatalogSearch(query, requestSeq) {
  if (requestSeq !== financeLineGroupState.searchRequestSeq) return;
  if (financeLineGroupState.searchInFlight) {
    financeLineGroupState.queuedSearch = { query, requestSeq };
    return;
  }
  financeLineGroupState.searchInFlight = true;
  const controller = new AbortController();
  financeLineGroupState.searchAbortController = controller;
  const timeout = setTimeout(() => controller.abort(), 8000);
  (async () => {
    try {
      const response = await fetch(`/api/finance/catalog?query=${encodeURIComponent(query)}`, {
        credentials: 'same-origin',
        signal: controller.signal
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Search failed');
      if (requestSeq !== financeLineGroupState.searchRequestSeq) return;
      financeLineGroupState.results = financeGroupEquivalentContainers(payload.data || []);
    } catch {
      if (requestSeq !== financeLineGroupState.searchRequestSeq) return;
      financeLineGroupState.results = [];
    } finally {
      clearTimeout(timeout);
      if (financeLineGroupState.searchAbortController === controller) {
        financeLineGroupState.searchAbortController = null;
      }
      financeLineGroupState.searchInFlight = false;
      const queued = financeLineGroupState.queuedSearch;
      financeLineGroupState.queuedSearch = null;
      if (queued?.requestSeq === financeLineGroupState.searchRequestSeq) {
        financeRunLineGroupCatalogSearch(queued.query, queued.requestSeq);
      }
    }
    if (requestSeq !== financeLineGroupState.searchRequestSeq) return;
    financeRenderLineGroupResults();
  })();
}

function financeSearchLineGroupCatalog(value) {
  clearTimeout(financeLineGroupState.searchTimer);
  const requestSeq = ++financeLineGroupState.searchRequestSeq;
  financeLineGroupState.queuedSearch = null;
  const query = String(value || '').trim();
  if (query.length < 2) {
    financeLineGroupState.results = [];
    financeRenderLineGroupResults();
    return;
  }
  financeLineGroupState.searchTimer = setTimeout(() => {
    financeRunLineGroupCatalogSearch(query, requestSeq);
  }, 300);
}

function financeLineGroupResultKey(row) {
  const catalogIdentity = String(
    row.catalogKey
    || row.containerItemKey
    || row.containerId
    || 'custom'
  );
  return [
    catalogIdentity,
    row.brand || '',
    row.model || '',
    row.description || ''
  ].map(value => String(value).trim().toLowerCase()).join('|');
}

function financeAddLineGroupResult(index) {
  const selected = financeLineGroupState.results[index];
  if (!selected) return;
  if (
    selected.isContainer
    && financeLineGroupState.mode === 'finance'
    && !financeLineGroupState.selected.length
    && !financeLineGroupState.commercialHeader
  ) {
    const categoryInput = document.getElementById('financeLineGroupCategory');
    if (categoryInput && categoryInput.value === financeLineGroupState.category) {
      categoryInput.value = financeContainerMajorityCategory(selected);
    }
  }
  const rows = selected.isContainer ? (selected.containerItems || []).map(item => ({
    ...item,
    quantityOverride: item.containerQuantity || item.availableQuantity || 1
  })) : [selected];
  rows.forEach(row => {
    const key = financeLineGroupResultKey(row);
    const existing = financeLineGroupState.selected.find(item => item.key === key);
    if (existing) {
      const addedQuantity = Math.max(0, financeNumber(row.quantityOverride, 1));
      const existingIndex = financeLineGroupState.selected.indexOf(existing);
      financeLineGroupSelectionQuantityChange(
        existingIndex,
        financeLineGroupSelectionQuantity(existing) + addedQuantity
      );
      if (existing.line) {
        existing.line.sourceAssetIds = [...new Set([
          ...(existing.line.sourceAssetIds || []),
          ...(row.sourceAssetIds || [])
        ])];
      } else {
        existing.catalog.sourceAssetIds = [...new Set([
          ...(existing.catalog.sourceAssetIds || []),
          ...(row.sourceAssetIds || [])
        ])];
      }
    } else if (!existing) {
      financeLineGroupState.selected.push({ key, catalog: JSON.parse(JSON.stringify(row)) });
    }
  });
  if (!financeLineGroupState.title && selected.isContainer) {
    financeLineGroupState.title = selected.containerId || selected.description || 'Container';
    const title = document.getElementById('financeLineGroupTitle');
    if (title) title.value = financeLineGroupState.title;
  }
  financeRenderLineGroupSelection();
}

function financeRemoveLineGroupSelection(index) {
  financeLineGroupState.selected.splice(index, 1);
  financeRenderLineGroupSelection();
}

function financeLineGroupSelectionDragStart(event, index) {
  financeLineGroupState.dragSelectionIndex = Number(index);
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', String(index));
  event.currentTarget?.closest('.finance-line-group-selection-row')?.classList.add('dragging');
}

function financeLineGroupSelectionDragOver(event) {
  if (financeLineGroupState.dragSelectionIndex < 0) return;
  event.preventDefault();
  const row = event.currentTarget;
  const rect = row.getBoundingClientRect();
  const position = event.clientY < rect.top + (rect.height / 2) ? 'before' : 'after';
  row.classList.toggle('drag-over-before', position === 'before');
  row.classList.toggle('drag-over-after', position === 'after');
  row.dataset.dropPosition = position;
}

function financeLineGroupSelectionDragLeave(event) {
  event.currentTarget?.classList.remove('drag-over-before', 'drag-over-after');
}

function financeLineGroupSelectionDrop(event, targetIndex) {
  event.preventDefault();
  const sourceIndex = financeLineGroupState.dragSelectionIndex;
  const position = event.currentTarget?.dataset.dropPosition || 'before';
  if (sourceIndex < 0 || sourceIndex >= financeLineGroupState.selected.length) {
    financeLineGroupSelectionDragEnd();
    return;
  }
  const [entry] = financeLineGroupState.selected.splice(sourceIndex, 1);
  let insertionIndex = Number(targetIndex);
  if (sourceIndex < insertionIndex) insertionIndex -= 1;
  if (position === 'after') insertionIndex += 1;
  financeLineGroupState.selected.splice(
    Math.max(0, Math.min(insertionIndex, financeLineGroupState.selected.length)),
    0,
    entry
  );
  financeLineGroupSelectionDragEnd();
  financeRenderLineGroupSelection();
}

function financeLineGroupSelectionMove(index, direction) {
  const sourceIndex = Number(index);
  const targetIndex = sourceIndex + Number(direction);
  if (
    sourceIndex < 0
    || sourceIndex >= financeLineGroupState.selected.length
    || targetIndex < 0
    || targetIndex >= financeLineGroupState.selected.length
  ) return;
  const [entry] = financeLineGroupState.selected.splice(sourceIndex, 1);
  financeLineGroupState.selected.splice(targetIndex, 0, entry);
  financeRenderLineGroupSelection();
}

function financeLineGroupSelectionHandleKeydown(event, index) {
  if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return;
  event.preventDefault();
  const direction = event.key === 'ArrowUp' ? -1 : 1;
  financeLineGroupSelectionMove(index, direction);
  requestAnimationFrame(() => {
    document.querySelector(`[data-group-selection-index="${Number(index) + direction}"] .finance-line-group-reorder-handle`)?.focus();
  });
}

function financeLineGroupSelectionDragEnd() {
  financeLineGroupState.dragSelectionIndex = -1;
  document.querySelectorAll('.finance-line-group-selection-row')
    .forEach(row => row.classList.remove('dragging', 'drag-over-before', 'drag-over-after'));
}

function financeLineGroupSelectionQuantity(entry) {
  const row = entry?.line || entry?.catalog || {};
  if (financeLineGroupState.mode === 'delivery-order') {
    return Math.max(0, financeNumber(row.quantityOverride, row.quantity ?? 1));
  }
  if (financeLineGroupState.mode === 'costing') {
    return Math.max(0, financeNumber(row.quantity, row.groupItemQuantity ?? 1));
  }
  return Math.max(0, financeNumber(
    entry?.line ? row.groupItemQuantity : row.quantityOverride,
    row.quantity ?? 1
  ));
}

function financeLineGroupSelectionQuantityChange(index, value) {
  const entry = financeLineGroupState.selected[index];
  if (!entry) return;
  const quantity = Math.max(0, financeNumber(value, 1));
  if (entry.line) {
    if (financeLineGroupState.mode === 'delivery-order') {
      entry.line.quantity = quantity;
    } else if (financeLineGroupState.mode === 'costing') {
      const line = entry.line;
      const previousQuantity = Math.max(0, financeNumber(line.quantity, 1));
      const previousUnitSale = previousQuantity
        ? Math.max(0, financeNumber(line.salePrice)) / previousQuantity
        : 0;
      line.quantity = quantity;
      line.groupItemQuantity = quantity;
      if (typeof costingLineRecalculate === 'function') {
        costingLineRecalculate(line, 'cost');
        if (previousUnitSale) {
          line.salePrice = previousUnitSale * quantity;
          costingLineRecalculate(line, 'sale');
        }
      }
    } else {
      financeSetGroupItemQuantityValue(entry.line, quantity);
    }
  } else if (entry.catalog) {
    entry.catalog.quantityOverride = quantity;
  }
}

function financeLineGroupFieldsChanged() {
  financeLineGroupState.displayFields = [...document.querySelectorAll('.finance-line-group-fields input:checked')].map(input => input.value);
  financeRenderLineGroupSelection();
}

function financeRenderLineGroupSelection() {
  const root = document.getElementById('financeLineGroupSelection');
  if (!root) return;
  root.innerHTML = financeLineGroupState.selected.map((entry, index) => {
    const row = entry.line || entry.catalog || {};
    return `<div class="finance-line-group-selection-row" data-group-selection-index="${index}" ondragover="financeLineGroupSelectionDragOver(event)" ondragleave="financeLineGroupSelectionDragLeave(event)" ondrop="financeLineGroupSelectionDrop(event,${index})"><span class="finance-drag-handle finance-line-group-reorder-handle" role="button" tabindex="0" draggable="true" title="Drag to rearrange" aria-label="Rearrange item" ondragstart="financeLineGroupSelectionDragStart(event,${index})" ondragend="financeLineGroupSelectionDragEnd()" onkeydown="financeLineGroupSelectionHandleKeydown(event,${index})">&#9776;</span><span class="finance-line-group-selection-name"><strong>${financeEscape(financeGroupedLineDisplay({ ...row, groupDisplayFields: financeLineGroupState.displayFields }))}</strong><small>${financeEscape(row.department || row.category || 'General')}</small></span><label class="finance-line-group-quantity"><span>Qty</span><input type="number" min="0" step="1" value="${financeEscapeAttr(financeLineGroupSelectionQuantity(entry))}" aria-label="Child asset quantity" onchange="financeLineGroupSelectionQuantityChange(${index},this.value)"></label><button type="button" class="finance-line-group-remove" aria-label="Remove item" onclick="financeRemoveLineGroupSelection(${index})">&times;</button></div>`;
  }).join('') || '<p>No contents. You can save this group empty or add assets or custom text.</p>';
}

function financeNewGroupedQuotationLine(selected, category) {
  const days = financeEventDays();
  const quantity = Math.max(0, financeNumber(selected.quantityOverride, 1));
  const unitPrice = financeNumber(selected.unitPrice);
  return {
    id: `line_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    productId: selected.productId || selected.id || '',
    productKey: selected.productKey || selected.catalogKey || '',
    catalogKey: selected.catalogKey || '', sourceAssetIds: selected.sourceAssetIds || [],
    brand: selected.brand || '', model: selected.model || '', description: selected.productLabel || selected.description || 'Item',
    inventoryNameMode: selected.catalogKey ? 'inventory' : '',
    department: selected.department || category, departmentCode: selected.departmentCode || '',
    systemName: category, days, quantity,
    uom: financeDefaultUom(category, selected.uom), unitPrice, discountPercent: 0,
    total: unitPrice * days * quantity, isCustom: !!selected.isCustom,
    subprojectId: financeCurrentSubprojectId()
  };
}

function financeNewEmptyGroupPlaceholder({
  groupId,
  title,
  category,
  fields,
  subprojectId,
  groupQuantity,
  existingLine = null
}) {
  const previous = existingLine || {};
  return {
    id: previous.id || `line_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    productId: '', productKey: '', catalogKey: '', sourceAssetIds: [],
    brand: '', model: '', description: '', inventoryNameMode: '',
    department: previous.department || category,
    departmentCode: previous.departmentCode || '',
    systemName: category,
    days: 1,
    quantity: groupQuantity,
    uom: 'sets',
    unitPrice: 0,
    discountPercent: 0,
    totalMode: 'amount',
    total: 0,
    isCustom: true,
    subprojectId,
    groupId,
    groupTitle: title,
    groupDisplayFields: fields,
    groupCustomText: false,
    groupPlaceholder: true,
    groupItemQuantity: 0,
    groupHeaderQuantity: groupQuantity,
    groupLeader: true,
    groupItemDays: 1,
    groupItemUom: 'units',
    groupItemUnitPrice: 0,
    groupItemDiscountPercent: 0,
    groupItemTotalMode: 'calculated',
    groupItemTotal: 0,
    groupItemPriceContribution: 0,
    groupItemCommercialStored: true,
    groupPricingMode: 'items'
  };
}

async function financeSaveLineGroup() {
  const mode = financeLineGroupState.mode;
  const title = String(document.getElementById('financeLineGroupTitle')?.value || '').trim();
  const category = String(document.getElementById('financeLineGroupCategory')?.value || '').trim() || 'General';
  const groupQuantity = Math.max(
    1,
    financeNumber(document.getElementById('financeLineGroupQuantity')?.value, 1)
  );
  const customText = String(document.getElementById('financeLineGroupCustomText')?.value || '').trim();
  const fields = [...document.querySelectorAll('.finance-line-group-fields input:checked')].map(input => input.value);
  if (!title) return showNotification('warning', 'Enter a group header');
  if (!fields.length) return showNotification('warning', 'Choose at least one asset field to show');
  if (mode !== 'finance' && !financeLineGroupState.selected.length && !customText) {
    return showNotification('warning', 'Add an asset or custom text to the group');
  }

  const groupId = financeLineGroupState.groupId;
  const groupSubprojectId = String(financeLineGroupState.subprojectId || 'main');
  const lines = financeGroupWorkingLines(mode);
  const inEditedGroup = line => (
    String(line.groupId || '') === groupId
    && String(line.subprojectId || 'main') === groupSubprojectId
  );
  const existingGroupLines = lines.filter(inEditedGroup);
  const firstGroupIndex = lines.findIndex(inEditedGroup);
  const insertionIndex = firstGroupIndex < 0
    ? lines.length
    : lines.slice(0, firstGroupIndex).filter(line => !inEditedGroup(line)).length;
  const retained = lines.filter(line => !inEditedGroup(line));
  const grouped = financeLineGroupState.selected.map(entry => {
    let line;
    let costingUnitSale = null;
    if (entry.line) {
      line = JSON.parse(JSON.stringify(entry.line));
      if (mode === 'costing') line.category = category;
      else if (mode === 'delivery-order') {
        line.category = category;
        line.department = category;
      }
      else line.systemName = category;
    } else if (mode === 'costing') {
      line = costingNewLine({ ...(entry.catalog || {}), department: category }, category);
      line.multiplier = 1;
      line.category = category;
    } else if (mode === 'delivery-order') {
      line = deliveryOrderNewGroupedLine(entry.catalog || {}, category, groupSubprojectId);
    } else {
      line = financeNewGroupedQuotationLine(entry.catalog || {}, category);
    }
    if (mode === 'costing') {
      costingUnitSale = costingLineUnitSale(line);
      line.groupItemQuantity = Math.max(0, financeNumber(line.quantity, 1));
    }
    return {
      ...line,
      subprojectId: groupSubprojectId,
      groupId,
      groupTitle: title,
      groupDisplayFields: fields,
      groupCustomText: false,
      groupPlaceholder: false,
      groupHeaderQuantity: groupQuantity,
      ...(mode === 'costing' ? { _groupEditorUnitSale: costingUnitSale } : {})
    };
  });
  if (customText) {
    const custom = mode === 'costing'
      ? costingNewLine({ description: customText, department: category }, category)
      : (mode === 'delivery-order'
          ? deliveryOrderNewGroupedLine({ description: customText, isCustom: true }, category, groupSubprojectId)
          : financeNewGroupedQuotationLine({ description: customText, isCustom: true }, category));
    if (mode === 'costing') custom.category = category;
    if (mode === 'costing') custom.multiplier = 1;
    if (mode === 'delivery-order') custom.category = category;
    grouped.push({
      ...custom,
      subprojectId: groupSubprojectId,
      groupId,
      groupTitle: title,
      groupDisplayFields: fields,
      groupCustomText: true,
      groupPlaceholder: false,
      isCustom: true,
      groupHeaderQuantity: groupQuantity,
      ...(mode === 'costing' ? {
        _groupEditorUnitSale: costingLineUnitSale(custom)
      } : {})
    });
  }
  if (mode === 'finance' && !grouped.length) {
    grouped.push(financeNewEmptyGroupPlaceholder({
      groupId,
      title,
      category,
      fields,
      subprojectId: groupSubprojectId,
      groupQuantity,
      existingLine: existingGroupLines.find(line => line.groupPlaceholder) || null
    }));
  }
  if (mode === 'costing') {
    grouped.forEach((line, index) => {
      const unitSale = Math.max(0, financeNumber(line._groupEditorUnitSale));
      delete line._groupEditorUnitSale;
      line.groupLeader = index === 0;
      line.groupHeaderQuantity = groupQuantity;
      costingLineRecalculate(line, 'cost');
      line.salePrice = Math.round(
        unitSale * (costingLineUnits(line) || 1) * 100
      ) / 100;
      costingLineRecalculate(line, 'sale');
    });
  }
  if (mode === 'finance' && financeLineGroupState.commercialHeader && grouped.length) {
    const originalHeader = {
      ...financeLineGroupState.commercialHeader,
      quantity: groupQuantity
    };
    const headerFactor = financeGroupCommercialFactor(originalHeader);
    const oldContribution = existingGroupLines.reduce(
      (sum, line) => sum + financeGroupItemPriceContribution(line), 0
    );
    grouped.forEach((line, index) => {
      financeCaptureGroupItemCommercial(line);
      if (line.groupItemPriceContribution === undefined || line.groupItemPriceContribution === null) {
        line.groupItemPriceContribution = headerFactor
          ? Math.max(0, financeNumber(line.groupItemTotal)) / headerFactor
          : Math.max(0, financeNumber(line.groupItemUnitPrice)) * Math.max(0, financeNumber(line.groupItemQuantity, 1));
      }
    });
    const newContribution = grouped.reduce(
      (sum, line) => sum + financeGroupItemPriceContribution(line), 0
    );
    const contributionDelta = newContribution - oldContribution;
    const pricingMode = financeGroupPricingMode(originalHeader);
    const adjustedHeader = pricingMode === 'total'
      ? { ...originalHeader }
      : {
          ...originalHeader,
          unitPrice: Math.max(0, financeNumber(originalHeader.unitPrice) + contributionDelta),
          total: Math.max(
            0,
            (financeNumber(originalHeader.unitPrice) + contributionDelta)
              * headerFactor
          )
        };
    grouped.forEach((line, index) => {
      Object.assign(line, adjustedHeader, {
        groupLeader: index === 0,
        groupPricingMode: pricingMode,
        total: index === 0 ? adjustedHeader.total : 0,
        totalMode: 'amount'
      });
    });
  } else if (mode === 'finance' && grouped.length) {
    let remembered = {};
    try {
      remembered = (await apiCall(
        `/api/finance/group-price-suggestion?title=${encodeURIComponent(title)}`
      )).data || {};
    } catch {
      remembered = {};
    }
    if (remembered.remembered === true) {
      const headerDays = 1;
      const headerQuantity = groupQuantity;
      const headerDiscount = financePercent(remembered.discountPercent || 0);
      const headerUnitPrice = Math.max(0, financeNumber(remembered.unitPrice));
      const headerTotal = Math.round(
        headerDays * headerQuantity * headerUnitPrice * (1 - headerDiscount / 100) * 100
      ) / 100;
      grouped.forEach((line, index) => {
        financeCaptureGroupItemCommercial(line);
        Object.assign(line, {
          days: headerDays,
          quantity: headerQuantity,
          uom: remembered.uom || 'sets',
          unitPrice: headerUnitPrice,
          discountPercent: headerDiscount,
          totalMode: 'amount',
          total: index === 0 ? headerTotal : 0,
          groupLeader: index === 0,
          groupHeaderQuantity: headerQuantity,
          groupPricingMode: 'total'
        });
      });
    } else {
      grouped.forEach(line => financeCaptureGroupItemCommercial(line));
      const headerUnitPrice = Math.round(grouped.reduce(
        (sum, line) => sum + financeGroupItemPriceContribution(line),
        0
      ) * 100) / 100;
      const headerTotal = Math.round(headerUnitPrice * groupQuantity * 100) / 100;
      grouped.forEach((line, index) => Object.assign(line, {
        days: 1,
        quantity: groupQuantity,
        uom: 'sets',
        unitPrice: headerUnitPrice,
        discountPercent: 0,
        totalMode: 'amount',
        total: index === 0 ? headerTotal : 0,
        groupLeader: index === 0,
        groupHeaderQuantity: groupQuantity,
        groupPricingMode: 'items'
      }));
    }
  }
  const nextLines = [...retained];
  nextLines.splice(Math.min(insertionIndex, nextLines.length), 0, ...grouped);
  if (mode === 'delivery-order') {
    deliveryOrderCommitLineGroup(groupId, groupSubprojectId, grouped);
  } else if (mode === 'costing') {
    costingState.current.lineItems = nextLines;
    costingState.changeVersion += 1;
    costingQueueSave();
    costingRenderEditor();
  } else {
    financeState.current.lineItems = nextLines;
    financeSyncDocumentDepartments();
    financeState.changeVersion += 1;
    financeQueueSave();
    financeRenderEditor();
  }
  closeModal('financeLineGroupModal');
}

function financeCategoryColumnHeader(department) {
  const document = financeState.current;
  const suffix = `${document?.id || 'quotation'}-${financeCurrentSubprojectId(document)}-${department}`
    .replace(/[^A-Za-z0-9_-]+/g, '-');
  const menuId = `finance-days-category-${suffix}`;
  const inputId = `finance-days-value-${suffix}`;
  const encodedDepartment = encodeURIComponent(department).replace(/'/g, '%27');
  const defaults = financeCategoryMultiplierDefaults(department);
  return `
    <tr class="finance-category-column-header">
      <td class="finance-col-number">${document?.showLineNumbers === false ? '' : '#'}</td>
      <td class="finance-col-description">Description</td>
      <td class="finance-col-category">Category</td>
      <td class="finance-col-quantity">Qty</td>
      <td class="finance-col-uom">UOM</td>
      <td class="finance-col-multiplier">
        <div class="finance-custom-control finance-header-control">
          <button type="button" class="finance-header-button showbase-line-header-action" onclick="financeToggleMenu('${financeEscapeAttr(menuId)}',event)">${financeEscape(financeCategoryMultiplierHeaderLabel(department))}</button>
          <div class="finance-custom-menu finance-days-menu" id="${financeEscapeAttr(menuId)}">
            <span class="finance-menu-caption">Column label</span>
            <div class="finance-label-choice">
              <button type="button" onclick="financeSetCategoryMultiplierLabels('Day','${financeEscapeAttr(encodedDepartment)}')">Day(s)</button>
              <button type="button" onclick="financeSetCategoryMultiplierLabels('Mult','${financeEscapeAttr(encodedDepartment)}')">Mult</button>
            </div>
            <label>Days value<input id="${financeEscapeAttr(inputId)}" class="finance-input" type="number" min="0" step="0.5" value="${financeEscapeAttr(defaults.days)}"></label>
            <button type="button" class="btn btn-primary" onclick="financeApplyCategoryDays('${financeEscapeAttr(inputId)}','${financeEscapeAttr(encodedDepartment)}')">Apply to this category</button>
          </div>
        </div>
      </td>
      <td class="finance-col-unit-price">Unit price</td><td class="finance-col-discount">Disc %</td><td class="finance-col-total">Total</td><td></td>
    </tr>
  `;
}

function financeGroupDisplayBuckets(rows, groupId) {
  const buckets = new Map();
  rows.filter(row => (
    String(row.line.groupId || '') === String(groupId || '')
    && !row.line.groupPlaceholder
  )).forEach(row => {
    const description = row.line.groupCustomText
      ? String(row.line.description || 'Item')
      : financeGroupedLineDisplay(row.line);
    const key = `${row.line.groupCustomText ? 'custom' : 'asset'}::${description.trim().toLocaleLowerCase()}`;
    if (!buckets.has(key)) {
      buckets.set(key, { description, rows: [], quantity: 0, customText: !!row.line.groupCustomText });
    }
    const bucket = buckets.get(key);
    bucket.rows.push(row);
    bucket.quantity += Math.max(0, financeNumber(row.line.groupItemQuantity, 1));
  });
  return [...buckets.values()];
}

function financeHeaderRows(document = financeState.current) {
  if (!document) return [];
  if (!Array.isArray(document.headerRows)) document.headerRows = [];
  return document.headerRows;
}

function financeLineUnitKey(line) {
  const groupId = String(line?.groupId || '');
  return groupId ? `group:${groupId}` : `line:${String(line?.id || '')}`;
}

function financeDisplayLineUnits(
  document = financeState.current,
  subprojectId = financeCurrentSubprojectId(document)
) {
  const units = [];
  financeActiveDepartments(document, subprojectId).forEach(department => {
    const rows = (document?.lineItems || []).map((line, index) => ({ line, index }))
      .filter(row => (
        !row.line.hiddenFromQuotation
        && financeLineSystem(row.line) === department
        && String(row.line.subprojectId || 'main') === String(subprojectId || 'main')
      ));
    const seenGroups = new Set();
    rows.forEach(row => {
      const groupId = String(row.line.groupId || '');
      if (groupId && seenGroups.has(groupId)) return;
      if (groupId) seenGroups.add(groupId);
      const members = groupId
        ? rows.filter(candidate => String(candidate.line.groupId || '') === groupId)
        : [row];
      units.push({
        key: financeLineUnitKey(row.line),
        department,
        lineIds: members.map(candidate => String(candidate.line.id || '')).filter(Boolean),
        firstLineId: String(members[0]?.line?.id || '')
      });
    });
  });
  return units;
}

function financeHeaderLayout(document = financeState.current, subprojectId = financeCurrentSubprojectId(document)) {
  const units = financeDisplayLineUnits(document, subprojectId);
  const unitByLineId = new Map();
  const firstUnitByDepartment = new Map();
  units.forEach(unit => {
    if (!firstUnitByDepartment.has(unit.department)) {
      firstUnitByDepartment.set(unit.department, unit);
    }
    unit.lineIds.forEach(lineId => unitByLineId.set(lineId, unit));
  });
  const beforeCategory = new Map();
  const beforeUnit = new Map();
  const end = [];
  financeHeaderRows(document)
    .filter(row => String(row.subprojectId || 'main') === String(subprojectId || 'main'))
    .forEach(row => {
      const unit = unitByLineId.get(String(row.beforeLineId || ''));
      if (!unit) {
        end.push(row);
        return;
      }
      const target = firstUnitByDepartment.get(unit.department)?.key === unit.key
        ? beforeCategory
        : beforeUnit;
      const key = target === beforeCategory ? unit.department : unit.key;
      if (!target.has(key)) target.set(key, []);
      target.get(key).push(row);
    });
  return { units, beforeCategory, beforeUnit, end };
}

function financeHeaderRowMarkup(header) {
  const id = financeEscapeAttr(header?.id || '');
  return `
    <tr class="finance-quotation-header-row" data-header-id="${id}"
      ondragover="financeDragHeaderOver(event,'${id}')"
      ondragleave="financeDragHeaderLeave(event)"
      ondrop="financeDropHeader(event,'${id}')"
      ondragend="financeDragHeaderEnd()">
      <td colspan="10">
        <div class="finance-quotation-header-content">
          <span class="finance-header-drag-handle" draggable="true" title="Drag header to reorder" aria-label="Drag header to reorder" ondragstart="financeDragHeaderStart(event,'${id}')" ondragend="financeDragHeaderEnd()">&#9776;</span>
          <textarea class="finance-quotation-header-input" rows="1" maxlength="2000" placeholder="Header content" aria-label="Header content" oninput="financeHeaderContentInput('${id}',this)">${financeEscape(header?.content || '')}</textarea>
          <button type="button" class="finance-delete-line finance-delete-header" title="Delete header" aria-label="Delete header" onclick="financeDeleteHeader('${id}')">&times;</button>
        </div>
      </td>
    </tr>`;
}

function financeHeaderRowsMarkup(rows) {
  return (rows || []).map(financeHeaderRowMarkup).join('');
}

function financeRenderLineGroups() {
  const document = financeState.current;
  const subprojectId = financeCurrentSubprojectId(document);
  const showLineNumbers = document?.showLineNumbers !== false;
  const configured = financeActiveDepartments(document);
  const headerLayout = financeHeaderLayout(document, subprojectId);
  if (!configured.length) {
    return `
      ${financeHeaderRowsMarkup(headerLayout.end)}
      <tr class="finance-empty-department">
        <td colspan="10">No line items yet. Add an inventory or custom item below.</td>
      </tr>
      ${financeTotalAdjustmentRows()}
    `;
  }
  let displayIndex = 0;
  const categoryMarkup = configured.map(department => {
    const rows = (document.lineItems || []).map((line, index) => ({ line, index }))
      .filter(row => !row.line.hiddenFromQuotation && financeLineSystem(row.line) === department && (row.line.subprojectId || 'main') === subprojectId);
    const base = rows.reduce((sum, row) => sum + financeLineTotal(row.line), 0);
    const adjustment = (document.adjustments || []).filter(row => row.scope === 'department' && row.department === department && (row.subprojectId || 'main') === subprojectId)
      .reduce((sum, row) => sum + financeNumber(row.amount), 0);
    const subtotal = base + adjustment;
    const itemCount = rows.filter(row => !row.line.groupId || row.line.groupLeader).length;
    const encoded = encodeURIComponent(department);
    const collapsed = financeIsDepartmentCollapsed(department);
    const renderedGroups = new Set();
    const lineRows = rows.map(({ line, index }) => {
      const departmentResultsId = `finance-department-results-${line.id}`;
      const groupId = String(line.groupId || '');
      const isGroupStart = groupId && !renderedGroups.has(groupId);
      const customHeaders = financeHeaderRowsMarkup(
        headerLayout.beforeUnit.get(financeLineUnitKey(line)) || []
      );
      const displayNumber = groupId
        ? (isGroupStart ? ++displayIndex : '')
        : ++displayIndex;
      if (groupId) {
        if (!isGroupStart) return '';
        renderedGroups.add(groupId);
        const groupRows = rows.filter(row => String(row.line.groupId || '') === groupId);
        const leaderEntry = rows.find(row => String(row.line.groupId || '') === groupId && row.line.groupLeader) || { line, index };
        const leader = leaderEntry.line;
        const leaderIndex = leaderEntry.index;
        const firstGroupIndex = groupRows[0]?.index ?? leaderIndex;
        const leaderResultsId = `finance-department-results-${leader.id}`;
        const groupPricingOverridden = financeGroupPricingMode(
          groupRows.map(row => row.line)
        ) === 'total';
        const groupHeader = `
          <tr class="finance-line-row finance-line-group-header finance-group-commercial-row" data-line-index="${firstGroupIndex}" data-group-boundary="before"
            oncontextmenu="financeEditLineGroup(event,'finance','${financeEscapeAttr(groupId)}')"
            ondragover="financeDragLineOver(event,${firstGroupIndex})"
            ondragleave="financeDragLineLeave(event)"
            ondrop="financeDropLine(event,${firstGroupIndex})"
            ondragend="financeDragLineEnd()">
            <td class="finance-line-number"><span class="finance-drag-handle finance-group-drag-handle" draggable="true" title="Drag group to reorder" ondragstart="financeDragLineGroupStart(event,'${financeEscapeAttr(groupId)}','${financeEscapeAttr(subprojectId)}')" ondragend="financeDragLineEnd()">&#9776;</span>${showLineNumbers ? displayNumber : ''}</td>
            <td><div class="finance-group-title"><button type="button" class="finance-group-title-button" title="Rename group header" onclick="financeRenameLineGroup('${financeEscapeAttr(groupId)}','${financeEscapeAttr(subprojectId)}')">${financeEscape(leader.groupTitle || 'Group')}</button>${groupPricingOverridden ? '<small class="finance-group-pricing-note">Manual total</small>' : ''}<button type="button" class="finance-group-menu-button" title="Edit group" aria-label="Edit ${financeEscapeAttr(leader.groupTitle || 'group')}" aria-haspopup="dialog" onclick="financeOpenLineGroupEditor('finance','${financeEscapeAttr(groupId)}')">...</button></div></td>
            <td><div class="finance-inline-combobox"><input class="finance-line-input" value="${financeEscapeAttr(financeLineSystem(leader))}" aria-label="Category" autocomplete="off" data-finance-department-index="${leaderIndex}" onfocus="financeShowDepartmentSuggestions(${leaderIndex},this.value,'${leaderResultsId}')" oninput="financeShowDepartmentSuggestions(${leaderIndex},this.value,'${leaderResultsId}')" onkeydown="showbaseLineWorkspace.suggestionKeydown(event,'${leaderResultsId}')" onchange="financeCommitDepartmentInput(${leaderIndex},this)" onblur="setTimeout(()=>showbaseLineWorkspace.hideSuggestions('${leaderResultsId}'),120)"><div class="finance-inline-suggestions" id="${leaderResultsId}"></div></div></td>
            <td class="finance-col-quantity"><input class="finance-line-input" type="number" min="0" step="1" value="${financeEscapeAttr(leader.quantity)}" aria-label="Group quantity" onchange="financeLineChange(${leaderIndex},'quantity',this.value)"></td>
            <td class="finance-col-uom">${financeUomControl(leader, leaderIndex)}</td>
            <td class="finance-col-multiplier"><input class="finance-line-input" type="number" min="0" step="0.5" value="${financeEscapeAttr(leader.days)}" aria-label="Days" onchange="financeLineChange(${leaderIndex},'days',this.value)"></td>
            <td><div class="finance-money-input finance-line-unit-price-input"><span>$</span><input class="finance-line-input" type="text" inputmode="decimal" value="${financeEscapeAttr(financeMoneyInputValue(leader.unitPrice))}" aria-label="Group unit price" onblur="financeFormatMoneyInput(this)" onchange="financeLineChange(${leaderIndex},'unitPrice',this.value)"></div></td>
            <td><span class="finance-percent-input"><input class="finance-line-input" type="number" min="-9999" max="100" step="0.1" value="${financeEscapeAttr(leader.discountPercent || 0)}" aria-label="Group discount percentage" onchange="financeLineChange(${leaderIndex},'discountPercent',this.value)"><span>%</span></span></td>
            <td><div class="finance-money-input finance-line-total-input"><span>$</span><input class="finance-line-input" type="text" inputmode="decimal" value="${financeEscapeAttr(financeMoneyInputValue(financeLineTotal(leader)))}" aria-label="Group total" onblur="financeFormatMoneyInput(this)" onchange="financeSetLineTotal(${leaderIndex},this.value)"></div></td>
            <td><button type="button" class="finance-delete-line" title="Delete group" onclick="financeDeleteLineGroup('${financeEscapeAttr(groupId)}','${financeEscapeAttr(subprojectId)}')">&times;</button></td>
          </tr>`;
        const childRows = financeGroupDisplayBuckets(rows, groupId).map(bucket => {
          const representativeIndex = bucket.rows[0].index;
          const representative = bucket.rows[0].line;
          const indexes = bucket.rows.map(row => row.index).join(',');
          const isConsolidated = bucket.rows.length > 1;
          const pricingHint = groupPricingOverridden
            ? 'Editing this value will use the item prices for the group total again.'
            : '';
          const quantityControl = isConsolidated
            ? `<input class="finance-line-input finance-group-child-quantity" type="number" min="0" step="1" value="${financeEscapeAttr(bucket.quantity)}" aria-label="Consolidated item quantity" title="${bucket.rows.length} matching asset lines" onchange="financeGroupBucketQuantityChange('${financeEscapeAttr(indexes)}',this.value)">`
            : `<input class="finance-line-input finance-group-child-quantity" type="number" min="0" step="1" value="${financeEscapeAttr(bucket.quantity)}" aria-label="Item quantity" onchange="financeGroupItemQuantityChange(${representativeIndex},this.value)">`;
          const unitPrice = bucket.rows.reduce(
            (sum, row) => sum + Math.max(0, financeNumber(row.line.groupItemQuantity, 1))
              * Math.max(0, financeNumber(row.line.groupItemUnitPrice)), 0
          ) / Math.max(1, bucket.quantity);
          const itemAmount = bucket.rows.reduce(
            (sum, row) => sum + financeGroupItemPriceContribution(row.line), 0
          );
          const pricingClass = groupPricingOverridden ? ' is-inactive' : '';
          const unitPriceControl = bucket.customText ? '' : `<div class="finance-money-input finance-line-unit-price-input finance-group-child-pricing${pricingClass}" title="${financeEscapeAttr(pricingHint)}"><span>$</span><input class="finance-line-input" type="text" inputmode="decimal" value="${financeEscapeAttr(financeMoneyInputValue(unitPrice))}" aria-label="Item unit price" onblur="financeFormatMoneyInput(this)" onchange="financeGroupItemUnitPriceChange('${financeEscapeAttr(indexes)}',this.value)"></div>`;
          const discountControl = bucket.customText ? '' : `<span class="finance-percent-input finance-group-child-pricing${pricingClass}" title="${financeEscapeAttr(pricingHint)}"><input class="finance-line-input" type="number" min="-9999" max="100" step="0.1" value="${financeEscapeAttr(representative.groupItemDiscountPercent || 0)}" aria-label="Item discount percentage" onchange="financeGroupItemDiscountChange('${financeEscapeAttr(indexes)}',this.value)"><span>%</span></span>`;
          const amountControl = bucket.customText ? '' : `<div class="finance-money-input finance-line-total-input finance-group-child-pricing${pricingClass}" title="${financeEscapeAttr(pricingHint)}"><span>$</span><input class="finance-line-input" type="text" inputmode="decimal" value="${financeEscapeAttr(financeMoneyInputValue(itemAmount))}" aria-label="Item amount per group" onblur="financeFormatMoneyInput(this)" onchange="financeGroupItemAmountChange('${financeEscapeAttr(indexes)}',this.value)"></div>`;
          return `
            <tr class="finance-line-row finance-group-child-row" data-line-index="${representativeIndex}" data-group-pricing="${groupPricingOverridden ? 'total' : 'items'}"
              oncontextmenu="financeEditLineGroup(event,'finance','${financeEscapeAttr(groupId)}')"
              ondragover="financeDragLineOver(event,${representativeIndex})"
              ondragleave="financeDragLineLeave(event)"
              ondrop="financeDropLine(event,${representativeIndex})"
              ondragend="financeDragLineEnd()">
              <td class="finance-line-number"><span class="finance-drag-handle" draggable="true" title="Drag to reorder or move out of group" ondragstart="financeDragLineBundleStart(event,'${financeEscapeAttr(indexes)}')" ondragend="financeDragLineEnd()">&#9776;</span></td>
              <td><div class="finance-group-item-display"><span class="${bucket.customText ? 'showbase-group-custom-text' : ''}">${financeEscape(bucket.description)}</span>${bucket.customText ? '<small>Custom text</small>' : ''}${isConsolidated ? `<small>${bucket.rows.length} matching line items consolidated</small>` : ''}</div></td><td></td>
              <td class="finance-col-quantity">${quantityControl}</td>
              <td class="finance-col-uom">${bucket.customText ? '' : `<span class="finance-group-child-uom">${financeEscape(financeUomLabel(representative.groupItemUom || 'units'))}</span>`}</td>
              <td class="finance-col-multiplier"></td><td>${unitPriceControl}</td><td>${discountControl}</td><td>${amountControl}</td>
              <td><button type="button" class="finance-delete-line" title="Remove ${isConsolidated ? 'matching items' : 'item'} from group" onclick="financeDeleteGroupChildren('${financeEscapeAttr(indexes)}')">&times;</button></td>
            </tr>`;
        }).join('');
        return `${customHeaders}${groupHeader}${childRows}`;
      }
      const groupHeader = '';
      const itemControl = `<input class="finance-line-input" value="${financeEscapeAttr(line.description)}" aria-label="Description" onchange="financeLineChange(${index},'description',this.value)">`;
      return `
        ${customHeaders}
        ${groupHeader}
        <tr class="finance-line-row" data-line-index="${index}" ${groupId ? `oncontextmenu="financeEditLineGroup(event,'finance','${financeEscapeAttr(groupId)}')"` : ''}
          ondragover="financeDragLineOver(event,${index})"
          ondragleave="financeDragLineLeave(event)"
          ondrop="financeDropLine(event,${index})"
          ondragend="financeDragLineEnd()">
          <td class="finance-line-number"><span class="finance-drag-handle" draggable="true" title="Drag to reorder" ondragstart="financeDragLineStart(event,${index})" ondragend="financeDragLineEnd()">&#9776;</span>${showLineNumbers ? displayNumber : ''}</td>
          <td>${itemControl}</td>
          <td>
            <div class="finance-inline-combobox">
              <input class="finance-line-input" value="${financeEscapeAttr(financeLineSystem(line))}" aria-label="Category" autocomplete="off"
                data-finance-department-index="${index}"
                onfocus="financeShowDepartmentSuggestions(${index},this.value,'${departmentResultsId}')"
                oninput="financeShowDepartmentSuggestions(${index},this.value,'${departmentResultsId}')"
                onkeydown="showbaseLineWorkspace.suggestionKeydown(event,'${departmentResultsId}')"
                onchange="financeCommitDepartmentInput(${index},this)"
                onblur="setTimeout(()=>showbaseLineWorkspace.hideSuggestions('${departmentResultsId}'),120)">
              <div class="finance-inline-suggestions" id="${departmentResultsId}"></div>
            </div>
          </td>
          <td class="finance-col-quantity"><input class="finance-line-input" type="number" min="0" step="1" value="${financeEscapeAttr(line.quantity)}" aria-label="Quantity" onchange="financeLineChange(${index},'quantity',this.value)"></td>
          <td class="finance-col-uom">${financeUomControl(line, index)}</td>
          <td class="finance-col-multiplier"><input class="finance-line-input" type="number" min="0" step="0.5" value="${financeEscapeAttr(line.days)}" aria-label="Days" onchange="financeLineChange(${index},'days',this.value)"></td>
          <td><div class="finance-money-input finance-line-unit-price-input"><span>$</span><input class="finance-line-input" type="text" inputmode="decimal" value="${financeEscapeAttr(financeMoneyInputValue(line.unitPrice))}" aria-label="Unit price" onblur="financeFormatMoneyInput(this)" onchange="financeLineChange(${index},'unitPrice',this.value)"></div></td>
          <td><span class="finance-percent-input"><input class="finance-line-input" type="number" min="-9999" max="100" step="0.1" value="${financeEscapeAttr(line.discountPercent || 0)}" aria-label="Discount percentage" onchange="financeLineChange(${index},'discountPercent',this.value)"><span>%</span></span></td>
          <td><div class="finance-money-input finance-line-total-input"><span>$</span><input class="finance-line-input" type="text" inputmode="decimal" value="${financeEscapeAttr(financeMoneyInputValue(financeLineTotal(line)))}" aria-label="Line total" onblur="financeFormatMoneyInput(this)" onchange="financeSetLineTotal(${index},this.value)"></div></td>
          <td><button type="button" class="finance-delete-line" title="Delete line" onclick="financeDeleteLine(${index})">×</button></td>
        </tr>
      `;
    }).join('');
    const categoryHeader = showbaseLineWorkspace.categoryHeaderRowMarkup({
      cellTag: 'td',
      colspan: 10,
      className: `finance-department-row ${collapsed ? 'is-collapsed' : ''}`,
      attributes: `ondragover="financeDragDepartmentOver(event,'${financeEscapeAttr(encoded)}')" ondragleave="financeDragDepartmentLeave(event)" ondrop="financeDropDepartment(event,'${financeEscapeAttr(encoded)}')" ondragend="financeDragDepartmentEnd()"`,
      content: `<div class="finance-department-heading-main">
          <span class="finance-department-drag-handle" draggable="true" title="Drag department" ondragstart="financeDragDepartmentStart(event,'${financeEscapeAttr(encoded)}')" ondragend="financeDragDepartmentEnd()">&#9776;</span>
          ${showbaseLineWorkspace.categoryToggleMarkup({
            label: `${department} category`,
            collapsed,
            action: `financeToggleDepartmentCollapse(${JSON.stringify(encoded)})`,
            className: 'finance-collapse-button'
          })}
          <span>${financeEscape(department)}</span>
          <button type="button" class="finance-department-rename" title="Rename header" aria-label="Rename ${financeEscapeAttr(department)} header" onclick="financeRenameDepartment('${financeEscapeAttr(encoded)}')">&#9998;</button>
          <small>${itemCount} item${itemCount === 1 ? '' : 's'} &middot; ${financeEscape(financeMoney(subtotal))}</small>
        </div>`
    });
    return `
      ${financeHeaderRowsMarkup(headerLayout.beforeCategory.get(department) || [])}
      ${categoryHeader}
      ${collapsed ? '' : `
        ${financeCategoryColumnHeader(department)}
        ${lineRows}
        ${financeAdjustmentRows(department)}
        <tr class="finance-department-subtotal-row ${rows.length ? 'finance-line-drop-end-target' : ''}"
          ${rows.length ? `ondragover="financeDragLineEndOver(event)"
            ondragleave="event.currentTarget.classList.remove('drag-over')"
            ondrop="financeDropLineAtEnd(event,'${financeEscapeAttr(encoded)}')"` : ''}>
          <td></td><td colspan="5">${financeEscape(department)} subtotal</td>
          <td colspan="2">${(document.adjustments || []).some(row => row.scope === 'department' && row.department === department && (row.subprojectId || 'main') === subprojectId) ? '' : `<button type="button" class="finance-add-discount" onclick="financeAddDepartmentDiscount('${financeEscapeAttr(encoded)}')">+ Discount</button>`}</td>
          <td><div class="finance-money-input finance-subtotal-input"><span>$</span><input type="text" inputmode="decimal" value="${financeEscapeAttr(financeMoneyInputValue(subtotal))}" onblur="financeFormatMoneyInput(this)" onchange="financeOverrideDepartmentSubtotal(decodeURIComponent('${encoded}'),this.value)"></div></td><td></td>
        </tr>
      `}
    `;
  }).join('');
  return categoryMarkup
    + financeHeaderRowsMarkup(headerLayout.end)
    + financeTotalAdjustmentRows();
}

function financeRenderSubprojectTabs() {
  return showbaseLineWorkspace.subprojectTabsMarkup({
    rows: financeSubprojects(),
    activeId: financeCurrentSubprojectId(),
    readOnly: financeState.snapshotMode,
    allowItemDrop: true,
    showLinkedStatus: true,
    handlerPrefix: 'finance',
    ariaLabel: 'Quotation sub-projects'
  });
}

function ensureFinanceRateCardModal() {
  let modal = document.getElementById('financeRateCardModal');
  if (modal) return modal;
  modal = document.createElement('div');
  modal.id = 'financeRateCardModal';
  modal.className = 'modal';
  modal.innerHTML = `
    <div class="modal-content finance-rate-card-modal">
      <div class="modal-header">
        <div><h3>Products</h3><small>Inventory and added products available for this quotation</small></div>
        <button type="button" class="close-btn" aria-label="Close products" onclick="closeModal('financeRateCardModal')">&times;</button>
      </div>
      <div class="finance-rate-card-toolbar">
        <input id="financeRateCardSearch" class="finance-input" type="search" placeholder="Search assets or departments..." oninput="financeState.rateCardSearch=this.value;financeRenderRateCard()">
        <button id="financeRateCardAddButton" type="button" class="btn btn-primary" onclick="financeToggleRateCardForm()">+ Add product</button>
      </div>
      <div class="finance-rate-card-tabs" role="tablist" aria-label="Rate card item type">
        <button type="button" data-rate-card-tab="assets" onclick="financeSetRateCardTab('assets')">Assets</button>
        <button type="button" data-rate-card-tab="containers" onclick="financeSetRateCardTab('containers')">Containers</button>
        <button type="button" data-rate-card-tab="custom" onclick="financeSetRateCardTab('custom')">Custom assets</button>
      </div>
      <form id="financeRateCardForm" class="finance-rate-card-form" hidden onsubmit="financeCreateRateCardItem(event)">
        <input id="financeRateCardBrand" class="finance-input finance-rate-card-brand" placeholder="Brand">
        <input id="financeRateCardModel" class="finance-input finance-rate-card-model" placeholder="Model">
        <input id="financeRateCardDescription" class="finance-input finance-rate-card-description" required placeholder="Description">
        <div class="finance-inline-combobox finance-rate-card-department-field">
          <input id="financeRateCardDepartment" class="finance-input" required placeholder="Department" autocomplete="off"
                 oninput="financeShowRateCardDepartmentSuggestions(this.value)" onfocus="financeShowRateCardDepartmentSuggestions(this.value)"
                 onkeydown="showbaseLineWorkspace.suggestionKeydown(event,'financeRateCardDepartmentResults')"
                 onblur="setTimeout(()=>showbaseLineWorkspace.hideSuggestions('financeRateCardDepartmentResults'),120)">
          <div id="financeRateCardDepartmentResults" class="finance-inline-suggestions"></div>
        </div>
        <input id="financeRateCardPrice" class="finance-input finance-rate-card-price" required type="number" min="0.01" step="0.01" placeholder="Rate">
        <div class="finance-custom-control finance-rate-card-uom-control">
          <button id="financeRateCardUomButton" type="button" class="finance-line-select-button" onclick="financeToggleMenu('finance-rate-card-uom-menu',event)">unit(s)<span>⌄</span></button>
          <div id="finance-rate-card-uom-menu" class="finance-custom-menu finance-uom-menu">
            ${FINANCE_UOMS.map(row => `<button type="button" onclick="financeChooseRateCardUom('${row.value}')">${financeEscape(row.label)}</button>`).join('')}
          </div>
        </div>
        <button type="submit" class="btn btn-primary finance-rate-card-save">Save item</button>
      </form>
      <div id="financeRateCardResults" class="finance-rate-card-results"></div>
    </div>
  `;
  modal.addEventListener('click', event => {
    if (event.target === modal) closeModal('financeRateCardModal');
  });
  document.body.appendChild(modal);
  return modal;
}

async function financeOpenRateCard() {
  return financeOpenRateCardFor('quotation');
}

async function financeOpenRateCardFor(target = 'quotation') {
  ensureFinanceRateCardModal();
  financeState.rateCardTarget = target === 'costing' ? 'costing' : 'quotation';
  financeState.rateCardSearch = '';
  financeState.rateCardTab = 'assets';
  document.getElementById('financeRateCardSearch').value = '';
  document.getElementById('financeRateCardResults').innerHTML = '<div class="finance-suggestion-empty">Loading rates...</div>';
  openModal('financeRateCardModal');
  try {
    const response = await apiCall('/api/finance/products');
    financeState.rateCard = response.data || [];
    financeRenderRateCard();
  } catch (error) {
    document.getElementById('financeRateCardResults').innerHTML = `<div class="finance-suggestion-empty">${financeEscape(error.message || 'Unable to load products')}</div>`;
  }
}

function financeRenderRateCard() {
  const root = document.getElementById('financeRateCardResults');
  if (!root) return;
  const query = String(financeState.rateCardSearch || '').trim().toLowerCase();
  const activeTab = financeState.rateCardTab || 'assets';
  document.querySelectorAll('[data-rate-card-tab]').forEach(button => {
    button.classList.toggle('active', button.dataset.rateCardTab === activeTab);
    button.setAttribute('aria-selected', String(button.dataset.rateCardTab === activeTab));
  });
  const addButton = document.getElementById('financeRateCardAddButton');
  if (addButton) addButton.hidden = activeTab !== 'custom';
  if (activeTab !== 'custom') {
    const form = document.getElementById('financeRateCardForm');
    if (form) form.hidden = true;
  }
  const filtered = (financeState.rateCard || []).filter(row => {
    const matchesType = activeTab === 'containers'
      ? row.isContainer
      : activeTab === 'custom'
        ? row.isCustom && !row.isContainer
        : !row.isCustom && !row.isContainer;
    return matchesType && (!query || [
      financeLineSystem(row), row.department, row.brand, row.model,
      row.description, row.containerId, row.containerSerial, ...(row.searchTags || [])
    ].join(' ').toLowerCase().includes(query));
  });
  const departments = new Map();
  filtered.forEach(row => {
    const department = financeLineSystem(row);
    if (!departments.has(department)) departments.set(department, []);
    departments.get(department).push(row);
  });
  root.innerHTML = [...departments.entries()]
    .sort(([left], [right]) => left.localeCompare(right, undefined, { sensitivity: 'base' }))
    .map(([department, rows]) => `
      <section class="finance-rate-card-department">
        <h4>${financeEscape(department)} <span>${rows.length}</span></h4>
        ${rows.sort((left, right) => [left.brand, left.model, left.description].filter(Boolean).join(' ').localeCompare([right.brand, right.model, right.description].filter(Boolean).join(' '), undefined, { sensitivity: 'base' })).map(row => {
          const index = financeState.rateCard.indexOf(row);
          const title = [row.brand, row.model].filter(Boolean).join(' ') || row.description;
          const detail = [row.brand || row.model ? row.description : '', financeUomLabel(row.uom)].filter(Boolean).join(' · ');
          const quotationQuantity = financeState.rateCardTarget === 'quotation'
            ? `<label class="finance-rate-card-quantity"><span>Qty</span><input id="financeRateCardQuantity-${index}" class="finance-input" type="number" min="1" step="1" value="1" aria-label="Quantity for ${financeEscapeAttr(title)}"></label>`
            : '';
          return `
            <div class="finance-rate-card-row ${quotationQuantity ? 'has-quantity' : ''}">
              <div><strong>${financeEscape(title)}</strong>${detail ? `<small>${financeEscape(detail)}</small>` : ''}</div>
              <label class="finance-money-input"><span>$</span><input type="text" inputmode="decimal" value="${financeNumber(row.unitPrice) ? financeEscapeAttr(financeMoneyInputValue(row.unitPrice)) : ''}" placeholder="Not set" aria-label="Rate for ${financeEscapeAttr(title)}" onblur="if(this.value) financeFormatMoneyInput(this)" onchange="financeUpdateRateCardItem(${index},this.value)"></label>
              ${quotationQuantity}
              <button type="button" class="btn btn-secondary" onclick="${financeState.rateCardTarget === 'costing' ? 'costingAddRateCardItem' : 'financeAddRateCardItemToQuotation'}(${index})">Add</button>
              ${row.isCustom ? `<button type="button" class="finance-rate-card-delete" title="Delete product" aria-label="Delete ${financeEscapeAttr(title)}" onclick="financeDeleteRateCardItem(${index})">&times;</button>` : '<span></span>'}
            </div>
          `;
        }).join('')}
      </section>
    `).join('') || '<div class="finance-suggestion-empty">No products match this search.</div>';
}

function financeSetRateCardTab(tab) {
  financeState.rateCardTab = ['assets', 'containers', 'custom'].includes(tab)
    ? tab : 'assets';
  financeRenderRateCard();
}

function financeToggleRateCardForm() {
  const form = document.getElementById('financeRateCardForm');
  if (!form) return;
  form.hidden = !form.hidden;
  if (!form.hidden) document.getElementById('financeRateCardDescription')?.focus();
}

function financeShowRateCardDepartmentSuggestions(query) {
  const root = document.getElementById('financeRateCardDepartmentResults');
  if (!root) return;
  root.innerHTML = financeDepartmentSuggestions(query).map(value => `
    <button type="button" onmousedown="event.preventDefault()" onclick="financeChooseRateCardDepartment('${financeEscapeAttr(encodeURIComponent(value))}')">${financeEscape(value)}</button>
  `).join('');
  root.classList.toggle('open', !!root.innerHTML);
}

function financeChooseRateCardDepartment(encodedValue) {
  const input = document.getElementById('financeRateCardDepartment');
  if (input) input.value = decodeURIComponent(encodedValue);
  document.getElementById('financeRateCardDepartmentResults')?.classList.remove('open');
}

function financeChooseRateCardUom(value) {
  financeState.rateCardUom = FINANCE_UOMS.some(row => row.value === value) ? value : 'units';
  const button = document.getElementById('financeRateCardUomButton');
  if (button) button.innerHTML = `${financeEscape(financeUomLabel(financeState.rateCardUom))}<span>⌄</span>`;
  document.getElementById('finance-rate-card-uom-menu')?.classList.remove('open');
}

async function financeSaveRateCardItem(item) {
  await financePersistProduct(item);
  financeRenderRateCard();
}

async function financeCreateRateCardItem(event) {
  event.preventDefault();
  try {
    await financeSaveRateCardItem({
      brand: document.getElementById('financeRateCardBrand')?.value || '',
      model: document.getElementById('financeRateCardModel')?.value || '',
      description: document.getElementById('financeRateCardDescription')?.value || '',
      department: document.getElementById('financeRateCardDepartment')?.value || '',
      unitPrice: document.getElementById('financeRateCardPrice')?.value || 0,
      uom: financeDefaultUom(
        document.getElementById('financeRateCardDepartment')?.value || '',
        financeState.rateCardUom || 'units'
      ),
      isCustom: true
    });
    event.currentTarget.reset();
    financeChooseRateCardUom('units');
    event.currentTarget.hidden = true;
    showNotification('success', 'Rate card item added');
  } catch (error) {}
}

async function financeUpdateRateCardItem(index, value) {
  const item = financeState.rateCard[index];
  if (!item) return;
  try {
    const unitPrice = financeCurrencyNumber(value);
    if (unitPrice <= 0 && !item.isCustom) {
      const response = await apiCall('/api/finance/products', 'DELETE', item);
      financeState.rateCard = response.data || [];
      financeState.catalogCache = {};
      financeRenderRateCard();
      return;
    }
    await financeSaveRateCardItem({ ...item, unitPrice });
  } catch (error) {
    financeRenderRateCard();
  }
}

async function financeDeleteRateCardItem(index) {
  const item = financeState.rateCard[index];
  if (!item) return;
  const title = [item.brand, item.model].filter(Boolean).join(' ') || item.description;
  const confirmed = await showAppConfirm({
    title: 'Delete product',
    message: `Remove ${title} from Products? Existing quotation items will not change.`,
    confirmText: 'Delete',
    destructive: true
  });
  if (!confirmed) return;
  try {
    const response = await apiCall('/api/finance/products', 'DELETE', item);
    financeState.rateCard = response.data || [];
    financeState.catalogCache = {};
    financeRenderRateCard();
    showNotification('success', 'Rate card item deleted');
  } catch (error) {}
}

function financeRateCardQuantity(index) {
  const input = document.getElementById(`financeRateCardQuantity-${index}`);
  return Math.max(1, financeNumber(input?.value, 1));
}

async function financeAddRateCardItemToQuotation(index) {
  const item = financeState.rateCard[index];
  if (!item || financeState.snapshotMode) return;
  const quantity = financeRateCardQuantity(index);
  if (item.isContainer) {
    try {
      const response = await apiCall(`/api/finance/catalog?query=${encodeURIComponent(item.containerId || item.description)}`);
      const container = (response.data || []).find(row => (
        row.isContainer && String(row.containerId || '').toLowerCase() === String(item.containerId || '').toLowerCase()
      ));
      if (!container) throw new Error('Container contents are unavailable');
      financeAddContainerAsGroup(container, '', quantity);
    } catch (error) {
      showNotification('error', error.message || 'Unable to add container');
      return;
    }
  } else {
    financeAddLineFromCatalog(item, '', quantity);
  }
  financeSyncDocumentDepartments();
  financeQueueSave();
  financeRenderEditor();
  showNotification('success', `${item.description} added to quotation`);
}

function financeSelectSubproject(subprojectId) {
  if (!financeSubprojects().some(row => row.id === subprojectId)) return;
  financeState.activeSubprojectId = subprojectId;
  financeState.addDepartment = '';
  financeRenderEditor();
}

function financeMergeLinkedRoomContent(document, sourceSubprojectId, targetSubprojectId) {
  const sourceId = String(sourceSubprojectId || '');
  const targetId = String(targetSubprojectId || '');
  financeEnsureLinkedRoomKeys(document, sourceId);
  financeEnsureLinkedRoomKeys(document, targetId);
  const sourceLines = (document.lineItems || []).filter(
    line => String(line.subprojectId || 'main') === sourceId
  );
  const targetLines = (document.lineItems || []).filter(
    line => String(line.subprojectId || 'main') === targetId
  );
  const usedSourceLines = new Set();
  const pairs = targetLines.map(targetLine => {
    const sourceLine = financeLinkedCounterpart(
      targetLine,
      sourceLines,
      usedSourceLines,
      financeLinkedLineIdentity,
      'linkedItemId'
    );
    if (sourceLine) usedSourceLines.add(sourceLine);
    return { targetLine, sourceLine };
  });
  const targetGroupToSourceGroup = new Map();
  pairs.forEach(({ targetLine, sourceLine }) => {
    if (targetLine.groupId && sourceLine?.groupId) {
      targetGroupToSourceGroup.set(targetLine.groupId, sourceLine.groupId);
    }
  });
  const addedLines = [];
  pairs.forEach(({ targetLine, sourceLine }) => {
    if (sourceLine) {
      const linkedItemId = String(
        sourceLine.linkedItemId || targetLine.linkedItemId || financeLinkedRecordId('linked_line')
      );
      sourceLine.linkedItemId = linkedItemId;
      targetLine.linkedItemId = linkedItemId;
      return;
    }
    const clone = financeCloneDocument(targetLine);
    clone.id = financeLinkedRecordId('line');
    clone.subprojectId = sourceId;
    clone.linkedItemId = String(
      targetLine.linkedItemId || financeLinkedRecordId('linked_line')
    );
    targetLine.linkedItemId = clone.linkedItemId;
    if (targetLine.groupId) {
      if (!targetGroupToSourceGroup.has(targetLine.groupId)) {
        targetGroupToSourceGroup.set(targetLine.groupId, financeLinkedRecordId('group'));
      }
      clone.groupId = targetGroupToSourceGroup.get(targetLine.groupId);
    } else {
      clone.groupId = '';
    }
    addedLines.push(clone);
  });
  document.lineItems = [...(document.lineItems || []), ...addedLines];

  const sourceHeaderCandidates = (document.headerRows || []).filter(
    header => String(header.subprojectId || 'main') === sourceId
  );
  const targetHeaders = (document.headerRows || []).filter(
    header => String(header.subprojectId || 'main') === targetId
  );
  const usedSourceHeaders = new Set();
  const addedHeaders = [];
  targetHeaders.forEach(targetHeader => {
    const sourceHeader = financeLinkedCounterpart(
      targetHeader,
      sourceHeaderCandidates,
      usedSourceHeaders,
      header => financeLinkedHeaderIdentity(header, document.lineItems),
      'linkedHeaderId'
    );
    if (sourceHeader) {
      usedSourceHeaders.add(sourceHeader);
      const linkedHeaderId = String(
        sourceHeader.linkedHeaderId
        || targetHeader.linkedHeaderId
        || financeLinkedRecordId('linked_header')
      );
      sourceHeader.linkedHeaderId = linkedHeaderId;
      targetHeader.linkedHeaderId = linkedHeaderId;
      return;
    }
    const clone = financeCloneDocument(targetHeader);
    clone.id = financeLinkedRecordId('header');
    clone.subprojectId = sourceId;
    clone.linkedHeaderId = String(
      targetHeader.linkedHeaderId || financeLinkedRecordId('linked_header')
    );
    targetHeader.linkedHeaderId = clone.linkedHeaderId;
    const targetAnchor = targetLines.find(
      line => String(line.id || '') === String(targetHeader.beforeLineId || '')
    );
    const sourceAnchor = (document.lineItems || []).find(line => (
      String(line.subprojectId || 'main') === sourceId
      && String(line.linkedItemId || '') === String(targetAnchor?.linkedItemId || '')
    ));
    clone.beforeLineId = sourceAnchor?.id || '';
    addedHeaders.push(clone);
    sourceHeaderCandidates.push(clone);
  });
  document.headerRows = [...(document.headerRows || []), ...addedHeaders];

  const sourceAdjustmentCandidates = (document.adjustments || []).filter(adjustment => (
    adjustment.scope !== 'total'
    && String(adjustment.subprojectId || 'main') === sourceId
  ));
  const targetAdjustments = (document.adjustments || []).filter(adjustment => (
    adjustment.scope !== 'total'
    && String(adjustment.subprojectId || 'main') === targetId
  ));
  const usedSourceAdjustments = new Set();
  const addedAdjustments = [];
  targetAdjustments.forEach(targetAdjustment => {
    const sourceAdjustment = financeLinkedCounterpart(
      targetAdjustment,
      sourceAdjustmentCandidates,
      usedSourceAdjustments,
      financeLinkedAdjustmentIdentity,
      'linkedAdjustmentId'
    );
    if (sourceAdjustment) {
      usedSourceAdjustments.add(sourceAdjustment);
      const linkedAdjustmentId = String(
        sourceAdjustment.linkedAdjustmentId
        || targetAdjustment.linkedAdjustmentId
        || financeLinkedRecordId('linked_adjustment')
      );
      sourceAdjustment.linkedAdjustmentId = linkedAdjustmentId;
      targetAdjustment.linkedAdjustmentId = linkedAdjustmentId;
      return;
    }
    const clone = financeCloneDocument(targetAdjustment);
    clone.id = financeLinkedRecordId('adjustment');
    clone.subprojectId = sourceId;
    clone.linkedAdjustmentId = String(
      targetAdjustment.linkedAdjustmentId || financeLinkedRecordId('linked_adjustment')
    );
    targetAdjustment.linkedAdjustmentId = clone.linkedAdjustmentId;
    addedAdjustments.push(clone);
    sourceAdjustmentCandidates.push(clone);
  });
  document.adjustments = [...(document.adjustments || []), ...addedAdjustments];
  return {
    lines: addedLines.length,
    headers: addedHeaders.length,
    adjustments: addedAdjustments.length,
  };
}

function financeLinkSubprojects(sourceSubprojectId, targetSubprojectId) {
  const document = financeState.current;
  const rows = financeSubprojects(document);
  const source = rows.find(row => String(row.id) === String(sourceSubprojectId || ''));
  const target = rows.find(row => String(row.id) === String(targetSubprojectId || ''));
  if (
    !document
    || financeState.snapshotMode
    || !source
    || !target
    || source === target
    || financeSubprojectsAreLinked(source.id, target.id, document)
  ) return false;
  const groupIds = new Set(
    [source.linkedGroupId, target.linkedGroupId].filter(Boolean).map(String)
  );
  const members = rows.filter(row => (
    row === source
    || row === target
    || groupIds.has(String(row.linkedGroupId || ''))
  ));
  const linkedGroupId = String(
    source.linkedGroupId || target.linkedGroupId || financeLinkedRecordId('linked_rooms')
  );
  const merged = financeMergeLinkedRoomContent(document, source.id, target.id);
  members.forEach(row => { row.linkedGroupId = linkedGroupId; });
  financeState.activeSubprojectId = source.id;
  financeSynchroniseLinkedSubprojects(document, source.id);
  financeSyncDocumentDepartments(document);
  financeQueueSave({ sourceSubprojectId: source.id, immediate: true });
  financeRenderEditor();
  const additions = merged.lines + merged.headers + merged.adjustments;
  showNotification(
    'success',
    `${source.name} and ${target.name} linked${additions ? `; ${additions} missing entr${additions === 1 ? 'y was' : 'ies were'} added` : ''}`
  );
  return true;
}

function financeUnlinkSubproject(subprojectId) {
  const document = financeState.current;
  const row = financeSubprojects(document).find(
    item => String(item.id) === String(subprojectId || '')
  );
  const members = financeLinkedSubprojectMembers(subprojectId, document);
  if (!document || financeState.snapshotMode || !row?.linkedGroupId || members.length < 2) {
    return false;
  }
  delete row.linkedGroupId;
  financeClearLinkedRoomKeys(document, row.id);
  const remaining = members.filter(member => member !== row);
  if (remaining.length === 1) {
    delete remaining[0].linkedGroupId;
    financeClearLinkedRoomKeys(document, remaining[0].id);
  }
  financeQueueSave({
    sourceSubprojectId: financeCurrentSubprojectId(document),
    immediate: true
  });
  financeRenderEditor();
  showNotification('success', `${row.name} unlinked`);
  return true;
}

function financeSubprojectContextMenuMarkup(subprojectId) {
  const rows = financeSubprojects();
  const source = rows.find(row => String(row.id) === String(subprojectId || ''));
  if (!source) return '';
  const members = financeLinkedSubprojectMembers(source.id);
  const linkedNames = members.filter(row => row !== source).map(row => row.name);
  const candidates = rows.filter(row => (
    row !== source && !financeSubprojectsAreLinked(source.id, row.id)
  ));
  return `
    <button type="button" role="menuitem" onclick="event.stopPropagation();financeDuplicateSubprojectFromMenu()">
      <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="1"></rect><path d="M16 8V4H4v12h4"></path></svg>
      <span>Duplicate sub-project</span>
    </button>
    ${linkedNames.length ? `
      <div class="finance-subproject-menu-label">Linked with ${financeEscape(linkedNames.join(', '))}</div>
      <button type="button" role="menuitem" onclick="event.stopPropagation();financeUnlinkSubprojectFromMenu()">
        <span aria-hidden="true">&#128279;</span><span>Unlink this sub-project</span>
      </button>
    ` : ''}
    ${candidates.length ? `
      <div class="finance-subproject-menu-label">Link sub-project</div>
      ${candidates.map(row => `
        <button type="button" role="menuitem" onclick="event.stopPropagation();financeLinkSubprojectFromMenu('${financeEscapeAttr(row.id)}')">
          <span aria-hidden="true">&#128279;</span><span>Link with ${financeEscape(row.name)}</span>
        </button>
      `).join('')}
    ` : ''}`;
}

function financeEnsureSubprojectContextMenu() {
  let menu = document.getElementById('financeSubprojectContextMenu');
  if (menu) return menu;
  menu = document.createElement('div');
  menu.id = 'financeSubprojectContextMenu';
  menu.className = 'finance-quotation-context-menu finance-subproject-context-menu';
  menu.setAttribute('role', 'menu');
  document.body.appendChild(menu);
  return menu;
}

function financeCloseSubprojectContextMenu() {
  document.getElementById('financeSubprojectContextMenu')?.classList.remove('open');
  document.querySelectorAll('.finance-subproject-tab.context-open').forEach(tab => {
    tab.classList.remove('context-open');
  });
  financeState.contextSubprojectId = '';
}

function financeOpenSubprojectContextMenu(event, subprojectId) {
  if (financeState.snapshotMode || !financeSubprojects().some(
    row => String(row.id) === String(subprojectId)
  )) return;
  event.preventDefault();
  event.stopPropagation();
  financeCloseMenus();
  const menu = financeEnsureSubprojectContextMenu();
  financeState.contextSubprojectId = String(subprojectId);
  menu.innerHTML = financeSubprojectContextMenuMarkup(subprojectId);
  document.querySelector(
    `.finance-subproject-tab[data-subproject-id="${CSS.escape(String(subprojectId))}"]`
  )?.classList.add('context-open');
  menu.classList.add('open');
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  const x = showbaseViewport.toLayout(event.clientX);
  const y = showbaseViewport.toLayout(event.clientY);
  menu.style.left = `${Math.max(8, Math.min(x, showbaseViewport.width() - width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, showbaseViewport.height() - height - 8))}px`;
  menu.querySelector('button')?.focus();
}

function financeSubprojectCopyName(sourceName) {
  const base = String(sourceName || 'Sub-project').trim() || 'Sub-project';
  const names = new Set(financeSubprojects().map(
    row => String(row.name || '').trim().toLowerCase()
  ));
  let name = `${base} Copy`;
  let number = 2;
  while (names.has(name.toLowerCase())) name = `${base} Copy ${number++}`;
  return name;
}

function financeDuplicateSubproject(subprojectId) {
  const document = financeState.current;
  const rows = financeSubprojects(document);
  const sourceIndex = rows.findIndex(
    row => String(row.id) === String(subprojectId)
  );
  if (!document || financeState.snapshotMode || sourceIndex < 0) return '';
  const source = rows[sourceIndex];
  source.linkedGroupId = String(
    source.linkedGroupId || financeLinkedRecordId('linked_rooms')
  );
  financeEnsureLinkedRoomKeys(document, source.id);
  const newSubprojectId = `room_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const lineIdMap = new Map();
  const groupIdMap = new Map();
  const sourceLines = (document.lineItems || []).filter(
    line => String(line.subprojectId || 'main') === String(subprojectId)
  );
  const clonedLines = sourceLines.map((line, index) => {
    const clone = JSON.parse(JSON.stringify(line));
    clone.id = `line_${Date.now()}_${index}_${Math.random().toString(16).slice(2)}`;
    clone.subprojectId = newSubprojectId;
    lineIdMap.set(String(line.id || ''), clone.id);
    if (line.groupId) {
      const groupId = String(line.groupId);
      if (!groupIdMap.has(groupId)) {
        groupIdMap.set(
          groupId,
          `group_${Date.now()}_${groupIdMap.size}_${Math.random().toString(16).slice(2)}`
        );
      }
      clone.groupId = groupIdMap.get(groupId);
    }
    return clone;
  });
  const clonedHeaders = financeHeaderRows().filter(
    row => String(row.subprojectId || 'main') === String(subprojectId)
  ).map((row, index) => ({
    ...JSON.parse(JSON.stringify(row)),
    id: `header_${Date.now()}_${index}_${Math.random().toString(16).slice(2)}`,
    subprojectId: newSubprojectId,
    beforeLineId: lineIdMap.get(String(row.beforeLineId || '')) || ''
  }));
  const clonedAdjustments = (document.adjustments || []).filter(row => (
    row.scope !== 'total'
    && String(row.subprojectId || 'main') === String(subprojectId)
  )).map((row, index) => ({
    ...JSON.parse(JSON.stringify(row)),
    id: `adjustment_${Date.now()}_${index}_${Math.random().toString(16).slice(2)}`,
    subprojectId: newSubprojectId
  }));
  const clone = {
    ...JSON.parse(JSON.stringify(source)),
    id: newSubprojectId,
    name: financeSubprojectCopyName(source.name)
  };
  document.subprojects = [...rows];
  document.subprojects.splice(sourceIndex + 1, 0, clone);
  document.lineItems = [...(document.lineItems || []), ...clonedLines];
  document.headerRows = [...financeHeaderRows(), ...clonedHeaders];
  document.adjustments = [...(document.adjustments || []), ...clonedAdjustments];
  financeState.activeSubprojectId = newSubprojectId;
  financeState.addDepartment = '';
  financeSyncDocumentDepartments(document);
  financeQueueSave({ sourceSubprojectId: newSubprojectId, immediate: true });
  financeRenderEditor();
  showNotification('success', `${clone.name} created and linked with ${source.name}`);
  return newSubprojectId;
}

function financeDuplicateSubprojectFromMenu() {
  const subprojectId = financeState.contextSubprojectId;
  financeCloseSubprojectContextMenu();
  if (subprojectId) financeDuplicateSubproject(subprojectId);
}

function financeLinkSubprojectFromMenu(targetSubprojectId) {
  const sourceSubprojectId = financeState.contextSubprojectId;
  financeCloseSubprojectContextMenu();
  if (sourceSubprojectId) financeLinkSubprojects(sourceSubprojectId, targetSubprojectId);
}

function financeUnlinkSubprojectFromMenu() {
  const subprojectId = financeState.contextSubprojectId;
  financeCloseSubprojectContextMenu();
  if (subprojectId) financeUnlinkSubproject(subprojectId);
}

function financeMoveLinesToSubproject(sourceIndexes, targetSubprojectId) {
  const document = financeState.current;
  const lines = document?.lineItems || [];
  const targetId = String(targetSubprojectId || '');
  const selectedIndexes = [...new Set((sourceIndexes || []).map(
    value => financeNumber(value, -1)
  ))].filter(index => index >= 0 && !!lines[index]);
  const movedItems = selectedIndexes.map(index => lines[index]);
  if (
    !document
    || financeState.snapshotMode
    || !movedItems.length
    || !financeSubprojects(document).some(row => String(row.id) === targetId)
    || movedItems.every(line => String(line.subprojectId || 'main') === targetId)
  ) {
    financeDragLineEnd();
    return 0;
  }
  const sourceRoomIds = [...new Set(movedItems.map(
    line => String(line.subprojectId || 'main')
  ))];
  if (sourceRoomIds.some(sourceId => (
    financeSubprojectsAreLinked(sourceId, targetId, document)
  ))) {
    financeDragLineEnd();
    showNotification('info', 'Those sub-projects are linked, so their items are already shared');
    return 0;
  }
  const wholeGroup = !!financeState.dragWholeLineGroup
    || showbaseLineWorkspace.draggedWholeGroup(lines, selectedIndexes);
  if (!wholeGroup) {
    movedItems.forEach(line => {
      if (line.groupId) financeDetachLineFromGroup(line);
    });
  }
  [...selectedIndexes].sort((left, right) => right - left).forEach(
    index => lines.splice(index, 1)
  );
  movedItems.forEach(line => {
    line.subprojectId = targetId;
    delete line.linkedItemId;
  });
  let insertionIndex = lines.reduce((last, line, index) => (
    String(line.subprojectId || 'main') === targetId ? index + 1 : last
  ), -1);
  if (insertionIndex < 0) insertionIndex = lines.length;
  lines.splice(insertionIndex, 0, ...movedItems);
  sourceRoomIds.forEach(sourceId => {
    financeSynchroniseLinkedSubprojects(document, sourceId);
  });
  financeState.activeSubprojectId = targetId;
  financeState.addDepartment = '';
  financeSyncDocumentDepartments(document);
  financeQueueSave({ sourceSubprojectId: targetId });
  financeDragLineEnd();
  financeRenderEditor();
  showNotification(
    'success',
    `${movedItems.length} item${movedItems.length === 1 ? '' : 's'} moved`
  );
  return movedItems.length;
}

const financeSubprojectWorkspace = showbaseLineWorkspace.createSubprojectController({
  state: financeState,
  getRows: financeSubprojects,
  isReadOnly: () => financeState.snapshotMode,
  mimeType: 'application/x-showbase-quotation-room',
  commit: reordered => {
    if (!reordered || !financeState.current) return false;
    financeState.current.subprojects = reordered;
    financeQueueSave();
    financeRenderEditor();
    return true;
  }
});

function financeClearSubprojectDropTargets() {
  financeSubprojectWorkspace.clearDropTargets();
  document.querySelectorAll('.finance-subproject-tab.is-item-drop-target').forEach(tab => {
    tab.classList.remove('is-item-drop-target');
  });
}

function financeSubprojectDragStart(event, subprojectId) {
  financeSubprojectWorkspace.dragStart(event, subprojectId);
}

function financeSubprojectDragOver(event, targetId) {
  if ((financeState.dragLineIndexes || []).length) {
    const sourceRooms = new Set(financeState.dragLineIndexes.map(index => (
      String(financeState.current?.lineItems?.[index]?.subprojectId || 'main')
    )));
    if (sourceRooms.size && !sourceRooms.has(String(targetId))) {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      financeClearSubprojectDropTargets();
      event.currentTarget.classList.add('is-item-drop-target');
    }
    return;
  }
  financeSubprojectWorkspace.dragOver(event, targetId);
}

function financeSubprojectDragLeave(event) {
  if (event.currentTarget.contains(event.relatedTarget)) return;
  event.currentTarget.classList.remove('is-item-drop-target');
  financeSubprojectWorkspace.dragLeave(event);
}

function financeSubprojectEndDragOver(event) {
  financeSubprojectWorkspace.endDragOver(event);
}

function financeSubprojectEndDragLeave(event) {
  financeSubprojectWorkspace.endDragLeave(event);
}

function financeSubprojectSlotDragOver(event, targetIndex) {
  financeSubprojectWorkspace.slotDragOver(event, targetIndex);
}

function financeSubprojectSlotDragLeave(event) {
  financeSubprojectWorkspace.slotDragLeave(event);
}

function financeSubprojectDropAtIndex(event, targetIndex) {
  financeSubprojectWorkspace.dropAtIndex(event, targetIndex);
}

function financeSubprojectDrop(event, targetId) {
  if ((financeState.dragLineIndexes || []).length) {
    event.preventDefault();
    event.stopPropagation();
    const indexes = financeDraggedLineIndexes(event);
    financeClearSubprojectDropTargets();
    financeMoveLinesToSubproject(indexes, targetId);
    return;
  }
  financeSubprojectWorkspace.drop(event, targetId);
}

function financeSubprojectDropAtEnd(event) {
  financeSubprojectWorkspace.dropAtEnd(event);
}

function financeSubprojectDragEnd() {
  financeSubprojectWorkspace.dragEnd();
}

function financeSubprojectDragKeydown(event, subprojectId) {
  financeSubprojectWorkspace.dragKeydown(event, subprojectId);
}

async function financeAddSubproject() {
  const name = await showAppPrompt({
    title: 'Add sub-project',
    message: 'Name this room or work area.',
    inputLabel: 'Sub-project name',
    defaultValue: `Room ${financeSubprojects().length + 1}`,
    confirmText: 'Add'
  });
  if (!String(name || '').trim()) return;
  const id = `room_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  financeSubprojects().push({ id, name: String(name).trim() });
  financeState.activeSubprojectId = id;
  financeQueueSave();
  financeRenderEditor();
}

async function financeRenameSubproject(subprojectId) {
  const row = financeSubprojects().find(item => item.id === subprojectId);
  if (!row) return;
  const name = await showAppPrompt({
    title: 'Rename sub-project',
    message: 'Use a clear room or area name.',
    inputLabel: 'Sub-project name',
    defaultValue: row.name,
    confirmText: 'Rename'
  });
  if (!String(name || '').trim()) return;
  row.name = String(name).trim();
  financeQueueSave();
  financeRenderEditor();
}

async function financeDeleteSubproject(subprojectId) {
  const rows = financeSubprojects();
  const row = rows.find(item => item.id === subprojectId);
  if (!row || rows.length <= 1) return;
  const lineCount = (financeState.current?.lineItems || []).filter(line => (line.subprojectId || 'main') === subprojectId).length;
  const confirmed = await showAppConfirm({
    title: 'Delete sub-project',
    message: lineCount ? `Delete ${row.name} and its ${lineCount} line item(s)?` : `Delete ${row.name}?`,
    confirmText: 'Delete',
    destructive: true
  });
  if (!confirmed) return;
  financeState.current._deletedSubprojectIds = [...new Set([
    ...(financeState.current._deletedSubprojectIds || []),
    subprojectId
  ])];
  financeState.current.subprojects = rows.filter(item => item.id !== subprojectId);
  financeState.current.lineItems = (financeState.current.lineItems || []).filter(line => (line.subprojectId || 'main') !== subprojectId);
  financeState.current.headerRows = financeHeaderRows()
    .filter(row => (row.subprojectId || 'main') !== subprojectId);
  financeState.current.adjustments = (financeState.current.adjustments || []).filter(item => (item.subprojectId || 'main') !== subprojectId || item.scope === 'total');
  financeRepairLinkedSubprojectGroups(financeState.current);
  financeState.activeSubprojectId = financeState.current.subprojects[0].id;
  financeSyncDocumentDepartments();
  financeQueueSave();
  financeRenderEditor();
}

function financeToggleDepartmentCollapse(encodedDepartment) {
  const department = decodeURIComponent(encodedDepartment);
  const document = financeState.current;
  const subprojectId = financeCurrentSubprojectId(document);
  const subproject = financeSubprojects(document).find(row => (
    String(row.id || '') === String(subprojectId || '')
  ));
  if (!document || !subproject || !department) return;
  const target = department.toLocaleLowerCase();
  const existing = financeSubprojectCollapsedCategories(document, subprojectId)
    .filter(value => String(value || '').trim().toLocaleLowerCase() !== target);
  if (!financeIsDepartmentCollapsed(department)) existing.push(department);
  if (existing.length) subproject.collapsedCategories = existing;
  else delete subproject.collapsedCategories;
  if (!financeState.snapshotMode) {
    financeQueueSave({ sourceSubprojectId: subprojectId });
  }
  financeRenderEditor();
}

async function financeRenameDepartment(encodedDepartment) {
  const currentName = decodeURIComponent(encodedDepartment);
  const document = financeState.current;
  const subprojectId = financeCurrentSubprojectId(document);
  if (!document || !currentName) return;
  const name = await showAppPrompt({
    title: 'Rename header',
    message: 'This changes the header for every matching line item in this header.',
    inputLabel: 'Header name',
    defaultValue: currentName,
    confirmText: 'Rename'
  });
  const nextName = String(name || '').trim();
  if (!nextName || nextName === currentName) return;
  (document.lineItems || []).forEach(line => {
    if (
      String(line.subprojectId || 'main') === String(subprojectId)
      && financeLineSystem(line) === currentName
    ) {
      line.systemName = nextName;
      line.uom = financeDefaultUom(nextName, line.uom);
    }
  });
  (document.adjustments || []).forEach(row => {
    if (
      row.scope === 'department'
      && String(row.subprojectId || 'main') === String(subprojectId)
      && row.department === currentName
    ) {
      row.department = nextName;
    }
  });
  const subproject = financeSubprojects(document).find(row => (
    String(row.id || '') === String(subprojectId)
  ));
  if (Array.isArray(subproject?.collapsedCategories)) {
    subproject.collapsedCategories = [...new Set(
      subproject.collapsedCategories.map(value => (
        String(value || '').trim().toLocaleLowerCase() === currentName.toLocaleLowerCase()
          ? nextName
          : value
      )).filter(Boolean)
    )];
  }
  financeSyncDocumentDepartments(document);
  financeQueueSave();
  financeRenderEditor();
}

function financeFindHeader(headerId) {
  return financeHeaderRows().find(row => String(row.id || '') === String(headerId || ''));
}

function financeResizeHeaderTextarea(input) {
  if (!input) return;
  input.style.height = 'auto';
  input.style.height = `${Math.max(28, input.scrollHeight)}px`;
}

function financeResizeHeaderTextareas(root = financeRoot()) {
  root?.querySelectorAll('.finance-quotation-header-input')
    .forEach(financeResizeHeaderTextarea);
}

function financeHeaderContentInput(headerId, input) {
  const header = financeFindHeader(headerId);
  if (!header) return;
  header.content = String(input?.value || '').slice(0, 2000);
  financeResizeHeaderTextarea(input);
  financeQueueSave();
}

function financeAddHeader() {
  if (!financeState.current) return;
  const header = {
    id: `header_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    content: '',
    beforeLineId: '',
    subprojectId: financeCurrentSubprojectId()
  };
  financeHeaderRows().push(header);
  financeQueueSave();
  financeRenderEditor();
  requestAnimationFrame(() => {
    const input = financeRoot()?.querySelector(
      `[data-header-id="${header.id}"] .finance-quotation-header-input`
    );
    input?.focus();
  });
}

function financeDeleteHeader(headerId) {
  if (!financeState.current) return;
  financeState.current.headerRows = financeHeaderRows()
    .filter(row => String(row.id || '') !== String(headerId || ''));
  financeQueueSave();
  financeRenderEditor();
}

function financePlaceHeader(headerId, beforeLineId = '') {
  const header = financeFindHeader(headerId);
  if (!header) return false;
  const rows = financeHeaderRows();
  financeState.current.headerRows = rows.filter(row => row !== header);
  header.beforeLineId = String(beforeLineId || '');
  header.subprojectId = financeCurrentSubprojectId();
  financeState.current.headerRows.push(header);
  return true;
}

function financeHeaderAnchorForLineDrop(targetIndex, position = 'before') {
  const target = financeState.current?.lineItems?.[targetIndex];
  if (!target) return '';
  const units = financeDisplayLineUnits();
  const unitIndex = units.findIndex(unit => unit.lineIds.includes(String(target.id || '')));
  if (unitIndex < 0) return '';
  return position === 'after'
    ? String(units[unitIndex + 1]?.firstLineId || '')
    : String(units[unitIndex]?.firstLineId || '');
}

function financeHeaderAnchorAfterDepartment(department) {
  const units = financeDisplayLineUnits();
  const lastIndex = units.map(unit => unit.department).lastIndexOf(department);
  return lastIndex >= 0 ? String(units[lastIndex + 1]?.firstLineId || '') : '';
}

function financeDragHeaderStart(event, headerId) {
  if (!financeFindHeader(headerId)) return;
  financeState.dragHeaderId = String(headerId || '');
  financeState.dragLineIndex = null;
  financeState.dragLineIndexes = [];
  financeState.dragWholeLineGroup = false;
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('application/x-showbase-quotation-header', financeState.dragHeaderId);
  event.dataTransfer.setData('text/plain', financeState.dragHeaderId);
  event.currentTarget.closest('.finance-quotation-header-row')?.classList.add('dragging');
}

function financeDragHeaderOver(event, targetHeaderId) {
  if (!financeState.dragHeaderId || financeState.dragHeaderId === String(targetHeaderId || '')) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  financeClearLineDropTargets();
  const position = showbaseLineWorkspace.dropPosition(event);
  event.currentTarget.classList.add(`drag-over-${position}`);
  event.currentTarget.dataset.dropPosition = position;
}

function financeDragHeaderLeave(event) {
  if (event.currentTarget.contains(event.relatedTarget)) return;
  event.currentTarget.classList.remove('drag-over-before', 'drag-over-after');
  delete event.currentTarget.dataset.dropPosition;
}

function financeDropHeader(event, targetHeaderId) {
  if (!financeState.dragHeaderId) return;
  event.preventDefault();
  event.stopPropagation();
  const rows = financeHeaderRows();
  const moved = rows.find(row => String(row.id || '') === financeState.dragHeaderId);
  const target = rows.find(row => String(row.id || '') === String(targetHeaderId || ''));
  if (!moved || !target || moved === target) return financeDragHeaderEnd();
  const position = showbaseLineWorkspace.dropPosition(event);
  const retained = rows.filter(row => row !== moved);
  const targetIndex = retained.indexOf(target);
  moved.beforeLineId = String(target.beforeLineId || '');
  moved.subprojectId = String(target.subprojectId || financeCurrentSubprojectId());
  retained.splice(targetIndex + (position === 'after' ? 1 : 0), 0, moved);
  financeState.current.headerRows = retained;
  financeDragHeaderEnd();
  financeQueueSave();
  financeRenderEditor();
}

function financeDragHeaderEnd() {
  financeState.dragHeaderId = '';
  document.querySelectorAll('.finance-quotation-header-row.dragging').forEach(row => {
    row.classList.remove('dragging');
  });
  financeClearLineDropTargets();
}

function financeBeginLineDrag(event, indexes, wholeGroup = false) {
  const lines = financeState.current?.lineItems || [];
  showbaseLineWorkspace.beginDrag(financeState, event, lines, indexes, {
    wholeGroup,
    mimeType: 'application/x-showbase-quotation-lines'
  });
}

function financeDragLineStart(event, index) {
  financeBeginLineDrag(event, [index]);
}

function financeDragLineBundleStart(event, indexes) {
  financeBeginLineDrag(event, String(indexes || '').split(','));
}

function financeDragLineGroupStart(event, groupId, subprojectId) {
  const indexes = (financeState.current?.lineItems || []).map((line, index) => ({ line, index }))
    .filter(row => (
      String(row.line.groupId || '') === String(groupId || '')
      && String(row.line.subprojectId || 'main') === String(subprojectId || 'main')
    ))
    .map(row => row.index);
  financeBeginLineDrag(event, indexes, true);
}

function financeDraggedLineIndexes(event) {
  return showbaseLineWorkspace.draggedIndexes(financeState, event, {
    mimeType: 'application/x-showbase-quotation-lines'
  });
}

function financeDragLineOver(event, index) {
  const indexes = financeState.dragLineIndexes || [];
  if (financeState.dragHeaderId) {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    financeClearLineDropTargets();
    const position = showbaseLineWorkspace.dropPosition(event);
    event.currentTarget.classList.add(`drag-over-${position}`);
    event.currentTarget.dataset.dropPosition = position;
    return;
  }
  if (!indexes.length || indexes.includes(index)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  financeClearLineDropTargets();
  const position = showbaseLineWorkspace.dropPosition(event);
  event.currentTarget.classList.add(`drag-over-${position}`);
  event.currentTarget.dataset.dropPosition = position;
}

function financeDragLineLeave(event) {
  if (event.currentTarget.contains(event.relatedTarget)) return;
  event.currentTarget.classList.remove('drag-over-before', 'drag-over-after');
  delete event.currentTarget.dataset.dropPosition;
}

function financeClearLineDropTargets() {
  document.querySelectorAll('.finance-line-row,.finance-quotation-header-row').forEach(row => {
    row.classList.remove('drag-over', 'drag-over-before', 'drag-over-after');
    delete row.dataset.dropPosition;
  });
  document.querySelectorAll('.finance-line-drop-end-target.drag-over').forEach(row => {
    row.classList.remove('drag-over');
  });
}

function financeDropLine(event, targetIndex) {
  event.preventDefault();
  event.stopPropagation();
  if (financeState.dragHeaderId) {
    const beforeLineId = financeHeaderAnchorForLineDrop(
      targetIndex,
      showbaseLineWorkspace.dropPosition(event)
    );
    const moved = financePlaceHeader(financeState.dragHeaderId, beforeLineId);
    financeDragHeaderEnd();
    if (moved) {
      financeQueueSave();
      financeRenderEditor();
    }
    return;
  }
  const lines = financeState.current?.lineItems || [];
  const sourceIndexes = financeDraggedLineIndexes(event)
    .filter(index => index >= 0 && !!lines[index]);
  const movedItems = sourceIndexes.map(index => lines[index]);
  const target = lines[targetIndex];
  if (!movedItems.length || !target || movedItems.includes(target)) {
    financeDragLineEnd();
    return;
  }
  const position = showbaseLineWorkspace.dropPosition(event);
  const outsideGroupBoundary = event.currentTarget.dataset.groupBoundary === 'before' && position === 'before';
  const wholeGroup = !!financeState.dragWholeLineGroup
    || showbaseLineWorkspace.draggedWholeGroup(lines, sourceIndexes);
  if (!wholeGroup) {
    movedItems.forEach(moved => {
      const sameGroup = String(moved.groupId || '') === String(target.groupId || '')
        && String(moved.subprojectId || 'main') === String(target.subprojectId || 'main');
      if (target.groupId && !outsideGroupBoundary && !sameGroup) {
        financeAttachLineToGroup(moved, target.groupId, target.subprojectId);
      } else if (moved.groupId && (!sameGroup || outsideGroupBoundary)) {
        financeDetachLineFromGroup(moved);
      }
    });
  }

  [...sourceIndexes].sort((a, b) => b - a).forEach(index => lines.splice(index, 1));
  let anchor = target;
  if (target.groupId && (wholeGroup || outsideGroupBoundary)) {
    const targetMembers = lines.filter(line => (
      String(line.groupId || '') === String(target.groupId || '')
      && String(line.subprojectId || 'main') === String(target.subprojectId || 'main')
    ));
    if (targetMembers.length) {
      anchor = position === 'after' && wholeGroup ? targetMembers.at(-1) : targetMembers[0];
    }
  }
  let insertionIndex = lines.indexOf(anchor);
  if (position === 'after') insertionIndex += 1;
  movedItems.forEach(moved => {
    moved.systemName = financeLineSystem(target);
    moved.subprojectId = target.subprojectId || 'main';
  });
  lines.splice(Math.max(0, insertionIndex), 0, ...movedItems);
  financeSyncDocumentDepartments();
  financeQueueSave();
  financeRenderEditor();
}

function financeDragLineEndOver(event) {
  if (!(financeState.dragLineIndexes || []).length && !financeState.dragHeaderId) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  financeClearLineDropTargets();
  event.currentTarget.classList.add('drag-over');
}

function financeDropLineAtEnd(event, encodedDepartment) {
  event.preventDefault();
  event.stopPropagation();
  const department = decodeURIComponent(encodedDepartment);
  if (financeState.dragHeaderId) {
    const moved = financePlaceHeader(
      financeState.dragHeaderId,
      financeHeaderAnchorAfterDepartment(department)
    );
    financeDragHeaderEnd();
    if (moved) {
      financeQueueSave();
      financeRenderEditor();
    }
    return;
  }
  const lines = financeState.current?.lineItems || [];
  const sourceIndexes = financeDraggedLineIndexes(event)
    .filter(index => index >= 0 && !!lines[index]);
  const movedItems = sourceIndexes.map(index => lines[index]);
  if (!movedItems.length) {
    financeDragLineEnd();
    return;
  }
  const subprojectId = financeCurrentSubprojectId();
  const wholeGroup = !!financeState.dragWholeLineGroup
    || showbaseLineWorkspace.draggedWholeGroup(lines, sourceIndexes);
  if (!wholeGroup) {
    movedItems.forEach(moved => {
      if (moved.groupId) financeDetachLineFromGroup(moved);
    });
  }
  [...sourceIndexes].sort((a, b) => b - a).forEach(index => lines.splice(index, 1));
  movedItems.forEach(moved => {
    moved.systemName = department;
    moved.subprojectId = subprojectId;
  });
  let insertionIndex = -1;
  lines.forEach((line, index) => {
    if (
      (line.subprojectId || 'main') === subprojectId
      && financeLineSystem(line) === department
    ) insertionIndex = index + 1;
  });
  if (insertionIndex < 0) lines.push(...movedItems);
  else lines.splice(insertionIndex, 0, ...movedItems);
  financeSyncDocumentDepartments();
  financeQueueSave();
  financeRenderEditor();
}

function financeDragLineEnd() {
  financeState.dragLineIndex = null;
  financeState.dragLineIndexes = [];
  financeState.dragWholeLineGroup = false;
  document.querySelectorAll('.finance-line-row.dragging').forEach(row => {
    row.classList.remove('dragging');
  });
  financeClearLineDropTargets();
  financeClearSubprojectDropTargets();
}

function financeDragDepartmentStart(event, encodedDepartment) {
  const department = decodeURIComponent(encodedDepartment);
  financeState.dragDepartment = department;
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', department);
  event.currentTarget.closest('.finance-department-row')?.classList.add('dragging');
}

function financeDragDepartmentOver(event, encodedDepartment) {
  const department = decodeURIComponent(encodedDepartment);
  if (financeState.dragHeaderId) {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    event.currentTarget.classList.add('drag-over');
    return;
  }
  if (financeState.dragLineIndex !== null) {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    event.currentTarget.classList.add('drag-over');
    return;
  }
  if (!financeState.dragDepartment || financeState.dragDepartment === department) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  event.currentTarget.classList.add('drag-over');
}

function financeDragDepartmentLeave(event) {
  event.currentTarget.classList.remove('drag-over');
}

function financeDropDepartment(event, encodedTargetDepartment) {
  event.preventDefault();
  event.stopPropagation();
  const targetDepartment = decodeURIComponent(encodedTargetDepartment);
  const lines = financeState.current?.lineItems || [];
  if (financeState.dragHeaderId) {
    const firstUnit = financeDisplayLineUnits()
      .find(unit => unit.department === targetDepartment);
    const moved = financePlaceHeader(
      financeState.dragHeaderId,
      firstUnit?.firstLineId || ''
    );
    financeDragHeaderEnd();
    financeDragDepartmentEnd();
    if (moved) {
      financeQueueSave();
      financeRenderEditor();
    }
    return;
  }
  const sourceIndexes = financeDraggedLineIndexes(event)
    .filter(index => index >= 0 && !!lines[index]);
  if (sourceIndexes.length) {
    const movedItems = sourceIndexes
      .map(index => lines[index])
      .filter(Boolean);
    if (movedItems.length) {
      const wholeGroup = !!financeState.dragWholeLineGroup
        || showbaseLineWorkspace.draggedWholeGroup(lines, sourceIndexes);
      if (!wholeGroup) {
        movedItems.forEach(line => {
          if (line.groupId) financeDetachLineFromGroup(line);
        });
      }
      movedItems.forEach(line => {
        line.systemName = targetDepartment;
        line.uom = financeDefaultUom(targetDepartment, line.uom);
      });
      financeSyncDocumentDepartments();
      financeQueueSave();
      financeRenderEditor();
    }
    financeDragLineEnd();
    financeDragDepartmentEnd();
    return;
  }
  const sourceDepartment = financeState.dragDepartment || event.dataTransfer.getData('text/plain');
  if (!sourceDepartment || sourceDepartment === targetDepartment || !financeState.current) {
    financeDragDepartmentEnd();
    return;
  }
  const subprojectId = financeCurrentSubprojectId(financeState.current);
  const groups = new Map();
  financeActiveDepartments(financeState.current, subprojectId)
    .forEach(department => groups.set(department, []));
  const subprojectLines = (financeState.current.lineItems || []).filter(line => (
    String(line.subprojectId || 'main') === String(subprojectId)
  ));
  subprojectLines.forEach(line => {
    const department = financeLineSystem(line);
    if (!groups.has(department)) groups.set(department, []);
    groups.get(department).push(line);
  });
  const order = Array.from(groups.keys());
  const sourceIndex = order.indexOf(sourceDepartment);
  if (sourceIndex === -1 || !order.includes(targetDepartment)) {
    financeDragDepartmentEnd();
    return;
  }
  order.splice(sourceIndex, 1);
  const targetIndex = order.indexOf(targetDepartment);
  order.splice(targetIndex, 0, sourceDepartment);
  const reordered = order.flatMap(department => groups.get(department) || []);
  let reorderedIndex = 0;
  financeState.current.lineItems = financeState.current.lineItems.map(line => (
    String(line.subprojectId || 'main') === String(subprojectId)
      ? reordered[reorderedIndex++]
      : line
  ));
  financeSyncDocumentDepartments();
  financeQueueSave({ sourceSubprojectId: subprojectId });
  financeRenderEditor();
}

function financeDragDepartmentEnd() {
  financeState.dragDepartment = '';
  document.querySelectorAll('.finance-department-row.dragging,.finance-department-row.drag-over').forEach(row => {
    row.classList.remove('dragging', 'drag-over');
  });
}

function financeSwitch(label, checked, handler) {
  return `<button type="button" class="finance-switch ${checked ? 'on' : ''}" role="switch" aria-checked="${checked}" onclick="${handler}"><span></span>${financeEscape(label)}</button>`;
}

function financeSummaryGroupingControl(document) {
  const byProject = document?.summaryBySubproject !== false;
  return `
    <div class="finance-summary-grouping">
      <span>Group summary by</span>
      <div role="radiogroup" aria-label="Group summary by">
        <button type="button" class="${byProject ? 'selected' : ''}" role="radio" aria-checked="${byProject}" onclick="financeSetSummaryGrouping('project')">Project</button>
        <button type="button" class="${byProject ? '' : 'selected'}" role="radio" aria-checked="${!byProject}" onclick="financeSetSummaryGrouping('category')">Category</button>
      </div>
    </div>
  `;
}

function financeApplySnapshotReadOnly(root) {
  root.classList.add('finance-snapshot-mode');
  root.querySelectorAll('input, textarea, button').forEach(control => {
    if (control.classList.contains('finance-back')) return;
    control.disabled = true;
  });
  root.querySelectorAll('[draggable="true"]').forEach(row => {
    row.setAttribute('draggable', 'false');
  });
}

function financePaymentTermsMarkup(currentValue) {
  const current = String(currentValue || '30 Days').trim() || '30 Days';
  return `
    <label class="finance-field finance-payment-terms-field"><span>Payment terms</span>
      <span class="finance-inline-combobox finance-payment-terms-combobox">
        <input id="financePaymentTermsInput" class="finance-input" value="${financeEscapeAttr(current)}" autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="financePaymentTermsResults" placeholder="e.g. 30 Days" onfocus="financeShowPaymentTermSuggestions(this.value)" oninput="financePaymentTermsInput(this)" onkeydown="financePaymentTermInputKeydown(event)" onblur="setTimeout(financeClosePaymentTermSuggestions,120)">
        <span class="finance-inline-suggestions finance-payment-terms-results" id="financePaymentTermsResults" role="listbox" aria-label="Payment term suggestions" onfocusout="setTimeout(financeClosePaymentTermSuggestions,120)"></span>
      </span>
    </label>`;
}

function financePaymentTermOptions(value = '') {
  const saved = (financeState.invoicePlanTemplates || [])
    .map(row => String(row?.name || '').trim())
    .filter(Boolean);
  const query = String(value || '').trim().toLowerCase();
  const seen = new Set();
  return ['30 Days', ...saved].filter(name => {
    const key = name.toLowerCase();
    if (!name || seen.has(key)) return false;
    seen.add(key);
    return !query || key.includes(query);
  }).slice(0, 8);
}

function financeShowPaymentTermSuggestions(value = '') {
  const input = document.getElementById('financePaymentTermsInput');
  const results = document.getElementById('financePaymentTermsResults');
  if (!input || !results) return;
  const options = financePaymentTermOptions(value);
  results.innerHTML = options.map(name => `
    <button type="button" role="option" aria-selected="false" onmousedown="event.preventDefault()" onkeydown="financePaymentTermSuggestionKeydown(event,'${financeEscapeAttr(encodeURIComponent(name))}')" onclick="financeChoosePaymentTerm('${financeEscapeAttr(encodeURIComponent(name))}')">${financeEscape(name)}</button>
  `).join('');
  const open = options.length > 0;
  results.classList.toggle('open', open);
  input.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function financePaymentTermsInput(input) {
  financeFieldChange('paymentTerms', input?.value || '');
  financeShowPaymentTermSuggestions(input?.value || '');
}

function financePaymentTermInputKeydown(event) {
  const handled = showbaseLineWorkspace.suggestionKeydown(
    event, 'financePaymentTermsResults'
  );
  if (event.key === 'Escape') {
    document.getElementById('financePaymentTermsInput')
      ?.setAttribute('aria-expanded', 'false');
  }
  return handled;
}

function financeClosePaymentTermSuggestions() {
  const input = document.getElementById('financePaymentTermsInput');
  const results = document.getElementById('financePaymentTermsResults');
  if (results?.contains(document.activeElement) || input === document.activeElement) return;
  results?.classList.remove('open');
  input?.setAttribute('aria-expanded', 'false');
}

function financeChoosePaymentTerm(encodedValue) {
  const value = decodeURIComponent(encodedValue || '');
  const input = document.getElementById('financePaymentTermsInput');
  if (input) {
    input.value = value;
    input.setAttribute('aria-expanded', 'false');
  }
  document.getElementById('financePaymentTermsResults')?.classList.remove('open');
  financeFieldChange('paymentTerms', value);
}

function financePaymentTermSuggestionKeydown(event, encodedValue) {
  if (showbaseLineWorkspace.suggestionOptionKeydown(event, 'financePaymentTermsResults')) return;
  if (event.key !== 'Enter') return;
  event.preventDefault();
  event.stopPropagation();
  financeChoosePaymentTerm(encodedValue);
}

function financeRememberPaymentTermOption(value) {
  const name = String(value || '').trim();
  if (!name || name.toLowerCase() === '30 days') return;
  if ((financeState.invoicePlanTemplates || []).some(
    row => String(row?.name || '').trim().toLowerCase() === name.toLowerCase()
  )) return;
  financeState.invoicePlanTemplates.push({ id: '', name, installments: [] });
}

function financeRenderEditor() {
  const root = financeRoot();
  const document = financeState.current;
  if (!root || !document) return;
  const viewport = root.querySelector('.finance-editor-header')
    ? showbaseLineWorkspace.captureViewport(root)
    : null;
  root.classList.remove('finance-snapshot-mode');
  financeSyncDocumentDepartments(document);
  const totals = financeTotals(document);
  const client = document.client || {};
  const snapshotMode = !!financeState.snapshotMode;
  const editingSentRevision = Number(document._editingSentRevision || 0);
  const validityUnit = financeValidityUnit(document);
  const validityAmount = financeValidityAmount(document);
  const quotationNumber = financeQuotationNumberParts(document.number, document.revision);
  const setupLabel = financeScheduleLabel('setup', document);
  const teardownLabel = financeScheduleLabel('teardown', document);
  const canOpenCosting = typeof currentUserHasSalesAccess === 'function'
    ? currentUserHasSalesAccess()
    : false;
  const eventCreationIssue = financeEventCreationIssue(document);
  root.innerHTML = `
    <div class="finance-editor-header">
      <div class="finance-editor-identity">
        <button type="button" class="finance-back" onclick="financeBackToList()">← Back to Quotations</button>
        <div class="finance-editor-title-row">
          <label class="finance-number-field">
            <span>Quotation number</span>
            <span class="finance-number-control">
              <input id="financeDocumentNumber" class="finance-number-input" value="${financeEscapeAttr(quotationNumber.base)}" oninput="financeResizeQuotationNumberInput(this)" onchange="financeSetQuotationNumber(this.value)" aria-label="Quotation number">
              <span class="finance-number-suffix" aria-label="Version suffix ${financeEscapeAttr(quotationNumber.suffix)}" title="The version suffix is managed automatically">${financeEscape(quotationNumber.suffix)}</span>
            </span>
          </label>
          ${snapshotMode ? '<span class="finance-readonly-pill" title="Snapshot view">Version view</span>' : `
            <div class="finance-editor-revision-chip">${financeSnapshotControl(document)}</div>
            ${editingSentRevision ? `<span class="finance-readonly-pill">Editing saved version ${String(editingSentRevision).padStart(2, '0')}</span>` : `
              ${financeStatusControl(document, 'editor')}
              ${financePaymentCountdownText(document) ? `<span class="finance-payment-countdown">${financeEscape(financePaymentCountdownText(document))}</span>` : ''}
              ${financeExportQuotationButton(document)}
              ${financeExportInvoiceButton(document)}
            `}
          `}
        </div>
        <span class="finance-save-state" id="financeSaveState">${snapshotMode ? 'Viewing sent snapshot — read only' : (document.projectName ? 'All changes saved' : 'Project Name is required before saving')}</span>
      </div>
      <div class="finance-editor-actions">
        ${snapshotMode ? '' : `
          <button type="button" class="btn btn-danger" onclick="financeDeleteCurrent()">Delete</button>
          ${financeCanDiscardDraft(document) ? '<button type="button" class="btn btn-secondary finance-discard-draft" onclick="financeDiscardChanges()">Discard changes</button>' : ''}
          <button type="button" class="btn btn-primary" onclick="financeSaveAndExit()">Save and Exit</button>
        `}
      </div>
    </div>

    <div class="finance-editor-layout">
      <div class="finance-main-column">
        <section class="finance-card finance-section">
          <div class="finance-section-heading finance-client-heading">
            <div><h3>Client &amp; quotation details</h3></div>
            <div class="finance-client-actions">
            <button type="button" id="financeClientSearch" class="finance-picker-button" onclick="financeOpenClientPicker()">
              <span>${financeEscape(financeClientDisplay(client) || 'Select known clients')}</span>
              <small>${financeEscape(client.company || client.email || client.phone || '')}</small>
            </button>
            <button type="button" class="btn btn-secondary" onclick="financeOpenClientModal()">+ New Client</button>
            </div>
          </div>
          <div class="finance-form-grid finance-quote-details-grid">
            <label class="finance-field"><span>Name</span><div class="finance-client-name-control">${financeSalutationControl(client.salutation || '', 'finance-client-salutation-menu', 'financeSetClientSalutation')}<input class="finance-input" value="${financeEscapeAttr(client.name || '')}" onchange="financeClientFieldChange('name',this.value)"></div></label>
            <label class="finance-field"><span>Company</span><input class="finance-input" value="${financeEscapeAttr(client.company || '')}" onchange="financeClientFieldChange('company',this.value)"></label>
            <label class="finance-field"><span>Phone</span><input class="finance-input" value="${financeEscapeAttr(client.phone || '')}" onchange="financeClientFieldChange('phone',this.value)"></label>
            <label class="finance-field"><span>Email</span><input class="finance-input" type="email" value="${financeEscapeAttr(client.email || '')}" onchange="financeClientFieldChange('email',this.value)"></label>
            <label class="finance-field finance-span-3"><span>Billing address</span><input class="finance-input" value="${financeEscapeAttr([client.address1, client.address2, client.address3, client.postalCode].filter(Boolean).join(', '))}" onchange="financeSetClientAddress(this.value)"></label>
            <label class="finance-field"><span>Salesperson</span><span class="finance-salesperson-combobox"><input id="financeSalespersonInput" class="finance-input" value="${financeEscapeAttr(document.salesperson || '')}" autocomplete="off" onfocus="financeShowSalespersonSuggestions(this.value)" oninput="financeSalespersonInput(this.value)" onblur="setTimeout(() => document.getElementById('financeSalespersonResults')?.classList.remove('open'),120)"><span class="finance-salesperson-results" id="financeSalespersonResults"></span></span></label>
            <label class="finance-field finance-span-2"><span>Project Name *</span><input id="financeProjectNameInput" class="finance-input" required value="${financeEscapeAttr(document.projectName || '')}" oninput="financeClearProjectNameExportError(this);financePreviewEventField('projectName',this.value)" onchange="financeFieldChange('projectName',this.value)"></label>
            <label class="finance-field finance-span-2"><span>Location</span><span class="finance-location-combobox"><input id="financeLocationInput" class="finance-input" value="${financeEscapeAttr(document.eventLocation || '')}" autocomplete="off" onfocus="financeShowLocationSuggestions(this.value)" oninput="financeFieldChange('eventLocation',this.value);financeShowLocationSuggestions(this.value)" onchange="financeFieldChange('eventLocation',this.value)" onblur="setTimeout(() => document.getElementById('financeLocationResults')?.classList.remove('open'),120)"><span class="finance-location-results" id="financeLocationResults"></span></span></label>
            <label class="finance-field"><span>Quotation date</span><input class="finance-input" type="date" value="${financeEscapeAttr(document.quotationDate || '')}" onchange="financeFieldChange('quotationDate',this.value)"></label>
            <label class="finance-field"><span>Valid for</span><span class="finance-validity-control"><input class="finance-input" type="number" min="1" max="365" value="${financeEscapeAttr(validityAmount)}" onchange="financeSetValidityAmount(this.value)">${financeValidityUnitControl(validityUnit, 'finance-editor-validity-unit-menu', 'financeSetValidityUnit')}</span></label>
            <label class="finance-field"><span>PO / reference number</span><input class="finance-input" value="${financeEscapeAttr(document.reference || '')}" onchange="financeFieldChange('reference',this.value)"></label>
            ${financePaymentTermsMarkup(document.paymentTerms)}
          </div>
        </section>

        <section class="finance-card finance-section">
          <div class="finance-section-heading finance-event-schedule-heading">
            <div class="finance-event-schedule-title"><h3>Event schedule</h3>${financeScheduleModeControl(document)}</div>
            <div class="finance-schedule-heading-order">${financeScheduleOrderPreview(document)}</div>
            <div class="finance-schedule-heading-actions">
              <button type="button" class="btn btn-secondary" onclick="financeOpenCustomSchedule()">+ Custom date(s)</button>
              <button type="button" class="btn btn-primary finance-bulk-schedule-open" onclick="financeOpenBulkSchedule('show')">Bulk add dates</button>
            </div>
          </div>
          <div class="finance-schedule-grid">
            <div class="finance-schedule-stack">
              ${financeSchedulePair(setupLabel, 'setup')}
              ${financeScheduleRowsMarkup('setup', document)}
              <button type="button" class="btn btn-secondary finance-schedule-add" onclick="financeAddScheduleRow('setup')">+ Add ${financeEscape(setupLabel.toLowerCase())}</button>
            </div>
            <div class="finance-schedule-stack">
              ${financeSchedulePair('Rehearsal', 'rehearsal')}
              ${financeScheduleRowsMarkup('rehearsal', document)}
              <button type="button" class="btn btn-secondary finance-schedule-add" onclick="financeAddScheduleRow('rehearsal')">+ Add rehearsal</button>
            </div>
            <div class="finance-schedule-stack">
              ${financeSchedulePair('Show', 'show')}
              ${financeScheduleRowsMarkup('show', document)}
              <button type="button" class="btn btn-secondary finance-schedule-add" onclick="financeAddScheduleRow('show')">+ Add show</button>
            </div>
            <div class="finance-schedule-stack">
              ${financeSchedulePair(teardownLabel, 'teardown')}
              ${financeScheduleRowsMarkup('teardown', document)}
              <button type="button" class="btn btn-secondary finance-schedule-add" onclick="financeAddScheduleRow('teardown')">+ Add ${financeEscape(teardownLabel.toLowerCase())}</button>
            </div>
            ${financeCustomScheduleMarkup(document)}
          </div>
        </section>

        <section class="finance-card finance-lines-card">
          ${financeRenderSubprojectTabs()}
          <div class="finance-section finance-section-heading">
            <div><h3>Line items</h3><p>Category names accept free text and saved suggestions.</p></div>
            <button type="button" class="btn btn-secondary finance-rate-card-button" onclick="financeOpenRateCard()">
              <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="3" width="16" height="18" rx="2"></rect><path d="M8 8h8M8 12h8M8 16h5"></path></svg>
              Browse products
            </button>
          </div>
          <div class="finance-lines-scroll">
            <table class="finance-lines-table showbase-category-table">
              <colgroup><col style="width:44px"><col style="width:368px"><col style="width:120px"><col style="width:72px"><col style="width:70px"><col style="width:72px"><col style="width:112px"><col style="width:84px"><col style="width:116px"><col style="width:36px"></colgroup>
              <tbody>${financeRenderLineGroups()}</tbody>
            </table>
          </div>
          ${showbaseLineWorkspace.addRowMarkup({
            mode: 'finance',
            className: 'finance-quotation-add-row',
            search: {
              id: 'financeAddItemInput',
              resultsId: 'financeCatalogResults',
              placeholder: 'Search inventory or previously used custom items...',
              onfocus: 'financeSearchCatalog(this.value)',
              oninput: 'financeSearchCatalog(this.value)',
              onkeydown: 'financeAddItemKeydown(event)'
            },
            category: {
              id: 'financeAddDepartmentInput',
              resultsId: 'financeAddDepartmentResults',
              value: financeState.addDepartment,
              placeholder: 'Category',
              oninput: 'financeState.addDepartment=this.value;financeShowAddDepartmentSuggestions(this.value)',
              onfocus: 'financeShowAddDepartmentSuggestions(this.value)',
              onkeydown: "showbaseLineWorkspace.suggestionKeydown(event,'financeAddDepartmentResults')"
            },
            addAction: 'financeAddCustomItem()',
            afterGroupMarkup: '<button type="button" class="btn btn-secondary finance-add-header-button" onclick="financeAddHeader()">+ Header</button>'
          })}
        </section>

        <section class="finance-card finance-section">
          <h3>Notes &amp; terms</h3>
          <label class="finance-field"><span>Notes</span><textarea class="finance-textarea" rows="3" onchange="financeFieldChange('notes',this.value)">${financeEscape(document.notes || '')}</textarea></label>
          <label class="finance-field" style="margin-top:12px;"><span>Terms and conditions</span><textarea class="finance-textarea" rows="7" onchange="financeFieldChange('terms',this.value)">${financeEscape(document.terms || '')}</textarea></label>
        </section>
      </div>

      <aside class="finance-side-column">
        <section class="finance-card finance-section finance-quotation-summary-card">
          <h3>Quotation summary</h3>
          <div class="finance-summary-row"><span>Items before adjustments</span><strong>${financeEscape(financeMoney(totals.subtotal))}</strong></div>
          ${totals.discount ? `<div class="finance-summary-row"><span>Discounts</span><strong class="finance-negative">${financeEscape(financeMoney(-totals.discount))}</strong></div>` : ''}
          <div class="finance-summary-row finance-pre-tax-row">
            <span>Total before GST</span>
            <div class="finance-lock-value">
              <div class="finance-money-input finance-pre-tax-input"><input type="text" inputmode="decimal" value="${financeEscapeAttr(financeMoney(document.totalLocked ? totals.lockedPreTax : totals.netSubtotal))}" onfocus="this.select()" onchange="financeSetLockedPreTax(this.value)"></div>
              <button type="button" class="finance-lock-button ${document.totalLocked ? 'locked' : ''}" title="${document.totalLocked ? 'Unlock pre-GST total' : 'Lock pre-GST total'}" onclick="financeToggleTotalLock()"> ${document.totalLocked ? '🔒' : '🔓'} </button>
            </div>
          </div>
          <div class="finance-summary-row finance-tax-row">
            <span>
              ${financeEscape(pdfSettings?.taxLabel || 'GST')}
              <input class="finance-tax-rate-input" type="number" min="0" max="100" step="0.01" value="${financeEscapeAttr(financeNumber(document.taxRate).toFixed(2).replace(/\.?0+$/, ''))}" aria-label="GST percentage" onchange="financeSetTaxRate(this.value)">%
            </span>
            <div class="finance-money-input finance-tax-amount-input"><span>$</span><input type="text" inputmode="decimal" value="${financeEscapeAttr(financeMoneyInputValue(totals.tax))}" aria-label="GST amount" onblur="financeFormatMoneyInput(this)" onchange="financeSetTaxAmount(this.value)"></div>
          </div>
          <div class="finance-summary-row finance-summary-total"><span>Total</span><strong>${financeEscape(financeMoney(totals.total))}</strong></div>
        </section>
        <section class="finance-card finance-section">
          <h3>PDF options</h3>
          ${financeSubprojects(document).length > 1 ? financeSummaryGroupingControl(document) : ''}
          ${financeSwitch('Show unit prices', !!document.showUnitPrices, "financeToggleDocumentFlag('showUnitPrices')")}
          ${financeSwitch('Show category discounts', !!document.showDepartmentDiscounts, "financeToggleDocumentFlag('showDepartmentDiscounts')")}
          ${financeSwitch('Show category subtotals', document.showDepartmentSubtotals !== false, "financeToggleDocumentFlag('showDepartmentSubtotals')")}
          ${financeSwitch('Show line item numbers', document.showLineNumbers !== false, "financeToggleDocumentFlag('showLineNumbers')")}
          ${financeSwitch('Show sign-off', !!document.showSignOff, "financeToggleDocumentFlag('showSignOff')")}
          <button type="button" class="btn btn-primary finance-export-inline" onclick="financeExportPdf()">Export PDF</button>
        </section>
        <section class="finance-card finance-section finance-event-pairing-card">
          <h3>Event pairing</h3>
          <p class="finance-side-note">Pair this quotation to an existing event.</p>
          <div class="finance-event-search-wrap finance-event-actions">
            <button type="button" id="financeEventSearch" class="finance-picker-button" onclick="financeOpenEventPicker()">
              <span>${financeEscape(financeEventDisplay(document.eventId) || 'Link')}</span>
              <small>${document.eventId ? 'Linked event' : 'No event paired'}</small>
            </button>
            ${document.eventId && typeof isAdminUser === 'function' && isAdminUser() ? `
              <button type="button" class="btn btn-secondary finance-compare-event" onclick="financeOpenComparePage()">Compare</button>
            ` : ''}
            ${!document.eventId ? `
              <button type="button" id="financeCreateEventButton" class="btn btn-primary finance-create-event" onclick="financeCreateEventFromQuotation()" ${eventCreationIssue ? 'disabled' : ''} title="${financeEscapeAttr(eventCreationIssue || 'Create and pair a planning event')}">Create</button>
            ` : ''}
          </div>
          ${!document.eventId ? `<p id="financeEventCreationNote" class="finance-side-note" ${eventCreationIssue ? '' : 'hidden'}>${financeEscape(eventCreationIssue)}</p>` : ''}
          ${document.eventId ? `<div class="finance-event-linked-actions">
            <button type="button" class="btn finance-go-event-plan" onclick="financeGoToLinkedEventPlan()" ${typeof isAdminUser === 'function' && isAdminUser() ? '' : 'disabled title="Plan requires admin access"'}>Go to Plan</button>
            <button type="button" class="btn btn-secondary finance-unpair-event" onclick="financeUnpairEvent()">Unpair event</button>
          </div>` : ''}
        </section>
        <section class="finance-card finance-section">
          <h3>Version</h3>
          <div class="finance-summary-row"><span>Current version</span><strong>${String(document.revision || 1).padStart(2, '0')}</strong></div>
          <div class="finance-summary-row"><span>Saved versions</span><strong>${(document.revisions || []).length}</strong></div>
          ${document.eventId ? `<div class="finance-summary-row"><span>Linked event</span><strong>#${document.eventId}</strong></div>` : ''}
        </section>
        ${canOpenCosting ? '<button type="button" class="btn btn-secondary finance-go-costing" onclick="financeOpenCosting()">Go to costing</button>' : ''}
      </aside>
    </div>
  `;
  financeResizeQuotationNumberInput(globalThis.document.getElementById('financeDocumentNumber'));
  financeResizeHeaderTextareas(root);
  if (snapshotMode) financeApplySnapshotReadOnly(root);
  showbaseLineWorkspace.restoreViewport(root, viewport);
}

async function financeBackToList() {
  clearTimeout(financeState.saveTimer);
  const leave = () => {
    financeState.current = null;
    financeState.snapshotMode = false;
    if (typeof updateAppDetailHistory === 'function') updateAppDetailHistory('/quotations');
    financeLoadList();
  };
  if (financeState.snapshotMode) return leave();
  if (financeQuotationIsBlank(financeState.current)) {
    try {
      await apiCall(`/api/quotations/${encodeURIComponent(financeState.current.id)}`, 'DELETE');
      leave();
    } catch (error) {
      showNotification('error', error.message || 'Unable to discard the blank quotation');
    }
    return;
  }
  try {
    const saved = await financeFlushPendingSave();
    if (!saved) {
      showNotification('info', 'Review the unsaved quotation changes before leaving.');
      return;
    }
    leave();
  } catch (error) {
    showNotification('error', error.message || 'Failed to save quotation');
  }
}

async function financeSaveAndExit() {
  try {
    if (financeQuotationIsBlank(financeState.current)) {
      await apiCall(`/api/quotations/${encodeURIComponent(financeState.current.id)}`, 'DELETE');
      financeState.current = null;
      financeState.snapshotMode = false;
      if (typeof updateAppDetailHistory === 'function') updateAppDetailHistory('/quotations');
      financeLoadList();
      return;
    }
    const saved = await financeFlushPendingSave();
    if (!saved) return;
    showNotification('success', 'Quotation saved');
    financeState.current = null;
    financeState.snapshotMode = false;
    if (typeof updateAppDetailHistory === 'function') updateAppDetailHistory('/quotations');
    financeLoadList();
  } catch (error) {
    showNotification('error', error.message || 'Failed to save quotation');
  }
}

function financeQuotationNumberParts(number, revision) {
  const safeRevision = Math.max(1, Math.min(99, financeNumber(revision, 1)));
  const suffix = `-${String(safeRevision).padStart(2, '0')}`;
  const clean = String(number || '').trim();
  return {
    base: clean.replace(/-\d{2}$/, ''),
    suffix
  };
}

function financeResizeQuotationNumberInput(input) {
  if (!input) return;
  const canvas = financeResizeQuotationNumberInput.canvas
    || (financeResizeQuotationNumberInput.canvas = document.createElement('canvas'));
  const context = canvas.getContext('2d');
  const styles = window.getComputedStyle(input);
  context.font = styles.font;
  const contentWidth = Math.ceil(context.measureText(input.value || 'QT').width);
  input.style.width = `${Math.max(28, contentWidth + 2)}px`;
}

function financeSetQuotationNumber(value) {
  if (!financeState.current) return;
  const currentParts = financeQuotationNumberParts(
    financeState.current.number,
    financeState.current.revision
  );
  const base = String(value || '').trim().replace(/-\d{2}$/, '').trim();
  if (!base) {
    const input = document.getElementById('financeDocumentNumber');
    if (input) {
      input.value = currentParts.base;
      financeResizeQuotationNumberInput(input);
    }
    showNotification('warning', 'Quotation number cannot be blank');
    return;
  }
  financeState.current.number = `${base}${currentParts.suffix}`;
  financeState.current.customNumber = true;
  financeQueueSave();
}

function financeSetValidityAmount(value) {
  if (!financeState.current) return;
  financeState.current.validityAmount = Math.max(1, Math.min(365, financeNumber(value, 30)));
  financeState.current.validityDays = financeValidityTotalDays(financeState.current);
  financeQueueSave();
}

function financeSetValidityUnit(value) {
  if (!financeState.current) return;
  financeState.current.validityUnit = financeValidityUnitMeta(value).value;
  financeState.current.validityDays = financeValidityTotalDays(financeState.current);
  financeQueueSave();
  financeRenderEditor();
}

function financeFieldChange(field, value) {
  if (!financeState.current) return;
  financeState.current[field] = ['taxRate', 'validityDays'].includes(field) ? financeNumber(value) : value;
  if (field === 'taxRate') financeState.current.taxRate = Math.max(0, Math.min(100, financeNumber(value, 0)));
  if (field === 'validityDays') financeState.current.validityDays = Math.max(1, Math.min(365, financeNumber(value, 30)));
  if (field === 'projectName') financeState.current.title = value;
  financeQueueSave();
  if (field === 'projectName' || field === 'eventLocation' || field.endsWith('Date')) {
    financeRefreshEventCreationControls();
  }
}

function financeSetTaxRate(value) {
  if (!financeState.current) return;
  financeState.current.taxRate = Math.max(0, Math.min(100, financeNumber(value, 0)));
  financeQueueSave();
  financeRenderEditor();
}

function financeSetTotalDiscountLabel(value) {
  if (!financeState.current) return;
  financeState.current.totalDiscountLabel = String(value || '').trim() || 'Total discount';
  financeApplyLockedTotalAdjustment(financeState.current);
  financeQueueSave();
  financeRenderEditor();
}

function financeSetTaxAmount(value) {
  if (!financeState.current) return;
  const amount = Math.max(0, financeCurrencyNumber(value));
  const totals = financeTotals();
  const base = Math.max(0, financeNumber(totals.netSubtotal, 0));
  financeState.current.taxRate = base > 0
    ? Math.round(Math.max(0, Math.min(100, amount / base * 100)) * 10000) / 10000
    : 0;
  financeQueueSave();
  financeRenderEditor();
}

function financeScheduleChange(field, value) {
  financeFieldChange(field, value);
}

function financeClientFieldChange(field, value) {
  financeState.current.client = financeState.current.client || {};
  financeState.current.client[field] = value;
  financeQueueSave();
}

function financeSetClientAddress(value) {
  financeState.current.client = financeState.current.client || {};
  Object.assign(financeState.current.client, { address1: value, address2: '', address3: '', postalCode: '' });
  financeQueueSave();
}

async function financePersistLineProductPrice(line, nextPrice) {
  const rows = await financePersistProduct({ ...line, unitPrice: nextPrice });
  const product = rows.find(row => (
    (line.productId && (row.productId || row.id) === line.productId)
    || (line.productKey && row.productKey === line.productKey)
    || (line.catalogKey && row.catalogKey === line.catalogKey)
  ));
  if (product) {
    if (!line.productId) line.productId = product.productId || product.id || '';
    if (!line.productKey) line.productKey = product.productKey || product.catalogKey || '';
  }
  return product;
}

async function financeOfferProductPriceUpdate(line, previousPrice) {
  const nextPrice = financeNumber(line?.unitPrice);
  if (!line || line.groupId || nextPrice === financeNumber(previousPrice)) return;
  const isLinkedProduct = Boolean(
    line.productId
    || line.productKey
    || line.catalogKey
    || (line.sourceAssetIds || []).length
  );
  if (!isLinkedProduct) return;
  if (line.productPricePending) {
    try {
      await financePersistLineProductPrice(line, nextPrice);
      line.productPricePending = false;
      financeQueueSave();
      showNotification('success', 'Initial product price saved for future additions');
    } catch (error) {}
    return;
  }
  const title = [line.brand, line.model].filter(Boolean).join(' ') || line.description || 'this product';
  const confirmed = await showAppConfirm({
    title: 'Update the product price?',
    message: `Use ${financeMoney(nextPrice)} as the price for ${title} in future additions? Products already added to any quotation will keep their saved price.`,
    confirmText: 'Update Product',
    cancelText: 'This Quotation Only'
  });
  if (!confirmed) return;
  try {
    await financePersistLineProductPrice(line, nextPrice);
    showNotification('success', 'Product price updated for future additions');
  } catch (error) {}
}

function financeLineChange(index, field, value) {
  const line = financeState.current?.lineItems?.[index];
  if (!line) return;
  const previousUnitPrice = financeNumber(line.unitPrice);
  line[field] = field === 'unitPrice'
    ? financeCurrencyNumber(value)
    : (['days', 'quantity', 'discountPercent'].includes(field) ? financeNumber(value) : value);
  if (field === 'description' && (line.catalogKey || line.sourceAssetIds?.length)) {
    line.inventoryNameMode = 'custom';
  }
  if (field === 'discountPercent') line.discountPercent = financePercent(value);
  if (field === 'department') {
    line.departmentCode = '';
    line.uom = financeDefaultUom(value, line.uom);
  }
  if (field === 'systemName') {
    line.systemName = String(value || '').trim() || financeDefaultSystemName(line.department);
    line.uom = financeDefaultUom(line.systemName, line.uom);
  }
  if (['days', 'quantity', 'unitPrice', 'discountPercent'].includes(field)) {
    line.totalMode = 'calculated';
  }
  if (line.groupId && line.groupLeader && field === 'unitPrice') {
    financeSetGroupPricingMode(
      financeLineGroupMembers(line.groupId, line.subprojectId),
      'total'
    );
  }
  if (field === 'unitPrice') financePropagateLineUnitPrice(line);
  line.total = financeLineTotal(line);
  financeSyncDocumentDepartments();
  financeQueueSave();
  financeRenderEditor();
  if (field === 'unitPrice') void financeOfferProductPriceUpdate(line, previousUnitPrice);
}

function financeSetLineTotal(index, value) {
  const line = financeState.current?.lineItems?.[index];
  if (!line) return;
  const target = Math.max(0, financeCurrencyNumber(value));
  const quantity = financeNumber(line.quantity, 0);
  const days = financeNumber(line.days, 0);
  if (line.groupId && line.groupLeader) {
    const members = financeLineGroupMembers(line.groupId, line.subprojectId);
    financeSetGroupPricingMode(members, 'total');
    line.unitPrice = quantity > 0 && days > 0
      ? Math.round((target / quantity / days) * 100) / 100
      : target;
    line.discountPercent = 0;
    line.totalMode = 'amount';
    line.total = target;
    financeSyncDocumentDepartments();
    financeQueueSave();
    financeRenderEditor();
    return;
  }
  const unitPrice = financeNumber(line.unitPrice, 0);
  const gross = quantity * days * unitPrice;
  if (gross > 0) {
    line.discountPercent = Math.round(financePercent((1 - target / gross) * 100) * 10000) / 10000;
  } else if (quantity > 0 && days > 0) {
    line.unitPrice = Math.round((target / quantity / days) * 100) / 100;
    line.discountPercent = 0;
    financePropagateLineUnitPrice(line);
  } else {
    line.discountPercent = 0;
  }
  line.totalMode = 'amount';
  line.total = target;
  financeSyncDocumentDepartments();
  financeQueueSave();
  financeRenderEditor();
}

function financeDeleteLine(index) {
  financeState.current.lineItems.splice(index, 1);
  financeSyncDocumentDepartments();
  financeQueueSave();
  financeRenderEditor();
}

function financeRemoveAdjustment(id) {
  financeState.current.adjustments = (financeState.current.adjustments || []).filter(row => row.id !== id);
  financeQueueSave();
  financeRenderEditor();
}

function financeDepartmentAdjustment(id, encodedDepartment, create = false) {
  const adjustments = financeState.current?.adjustments || (financeState.current.adjustments = []);
  let row = adjustments.find(adjustment => adjustment.id === id);
  if (!row && create) {
    const department = decodeURIComponent(encodedDepartment);
    row = {
      id: id || `adjustment_${Date.now()}_${Math.random().toString(16).slice(2)}`,
      scope: 'department',
      department,
      label: 'Discount',
      amount: 0,
      percent: 0,
      kind: 'discount',
      calculationMode: 'percent',
      subprojectId: financeCurrentSubprojectId()
    };
    adjustments.push(row);
  }
  return row;
}

function financeAddDepartmentDiscount(encodedDepartment) {
  financeDepartmentAdjustment('', encodedDepartment, true);
  financeQueueSave();
  financeRenderEditor();
}

function financeSetAdjustmentLabel(id, value) {
  const row = (financeState.current?.adjustments || []).find(adjustment => adjustment.id === id);
  if (!row) return;
  row.label = String(value || '').trim() || (row.scope === 'department' ? 'Discount' : 'Total discount');
  financeQueueSave();
}

function financeSetDepartmentAdjustmentPercent(id, encodedDepartment, value) {
  const row = financeDepartmentAdjustment(id, encodedDepartment, true);
  row.kind = 'discount';
  row.calculationMode = 'percent';
  row.percent = Math.max(0, Math.min(100, financeNumber(value)));
  financeQueueSave();
  financeRenderEditor();
}

function financeSetDepartmentAdjustmentAmount(id, encodedDepartment, value) {
  const row = financeDepartmentAdjustment(id, encodedDepartment, true);
  const department = decodeURIComponent(encodedDepartment);
  const base = (financeState.current?.lineItems || [])
    .filter(line => financeLineSystem(line) === department && (line.subprojectId || 'main') === (row.subprojectId || 'main'))
    .reduce((sum, line) => sum + financeLineTotal(line), 0);
  const amount = Math.max(0, financeCurrencyNumber(value));
  row.kind = 'discount';
  row.calculationMode = 'amount';
  row.amount = -Math.round(amount * 100) / 100;
  row.percent = base ? Math.round(amount / base * 100 * 10000) / 10000 : 0;
  financeQueueSave();
  financeRenderEditor();
}

function financeOverrideDepartmentSubtotal(department, rawTarget) {
  const target = Math.max(0, financeCurrencyNumber(rawTarget));
  const subprojectId = financeCurrentSubprojectId();
  const base = financeState.current.lineItems.filter(line => financeLineSystem(line) === department && (line.subprojectId || 'main') === subprojectId).reduce((sum, line) => sum + financeLineTotal(line), 0);
  const difference = target - base;
  const percent = base ? Math.abs(difference) / base * 100 : 0;
  const adjustments = financeState.current.adjustments || (financeState.current.adjustments = []);
  const existing = adjustments.find(row => row.scope === 'department' && row.department === department && (row.subprojectId || 'main') === subprojectId);
  if (Math.abs(difference) < 0.005) {
    financeState.current.adjustments = adjustments.filter(row => row !== existing);
  } else {
    const row = existing || { id: `adjustment_${Date.now()}_${Math.random().toString(16).slice(2)}`, scope: 'department', department, subprojectId };
    Object.assign(row, {
      amount: Math.round(difference * 100) / 100,
      percent,
      kind: difference < 0 ? 'discount' : 'adjustment',
      calculationMode: 'amount',
      label: existing?.label || `Department ${difference < 0 ? 'discount' : 'adjustment'}`
    });
    if (!existing) adjustments.push(row);
  }
  financeQueueSave();
  financeRenderEditor();
}

function financeCategoryLineItems(category, subprojectId = financeCurrentSubprojectId()) {
  return (financeState.current?.lineItems || []).filter(line => (
    (line.subprojectId || 'main') === subprojectId
    && financeLineSystem(line) === String(category || '')
  ));
}

function financeCategoryMultiplierDefaults(category) {
  const firstLine = financeCategoryLineItems(category)[0];
  return {
    days: Math.max(0, financeNumber(firstLine?.days, financeEventDays(financeState.current)))
  };
}

function financeApplyCategoryDays(inputId, encodedCategory) {
  const value = Math.max(0, financeNumber(document.getElementById(inputId)?.value, 1));
  const category = decodeURIComponent(encodedCategory);
  financeCategoryLineItems(category).forEach(line => {
    line.days = value;
    line.totalMode = 'calculated';
    line.total = financeLineTotal(line);
  });
  financeQueueSave();
  financeRenderEditor();
}

function financeCategoryMultiplierHeaderLabel(category) {
  const labels = new Set(financeCategoryLineItems(category)
    .map(line => line.costingMultiplierLabel === 'Mult' ? 'Mult' : 'Day'));
  return labels.size === 1 && labels.has('Mult') ? 'Mult' : 'Day(s)';
}

function financeSetCategoryMultiplierLabels(label, encodedCategory) {
  const next = label === 'Mult' ? 'Mult' : 'Day';
  const category = decodeURIComponent(encodedCategory);
  financeCategoryLineItems(category).forEach(line => {
    line.costingMultiplierLabel = next;
  });
  financeCloseMenus();
  financeQueueSave();
  financeRenderEditor();
}

function financeToggleTotalLock() {
  const totals = financeTotals();
  const nextLocked = !financeState.current.totalLocked;
  financeState.current.totalLocked = nextLocked;
  financeState.current.lockedPreTaxTotal = nextLocked ? totals.netSubtotal : null;
  financeApplyLockedTotalAdjustment();
  financeQueueSave();
  financeRenderEditor();
}

function financeSetLockedPreTax(value) {
  financeState.current.totalLocked = true;
  financeState.current.lockedPreTaxTotal = Math.max(0, financeCurrencyNumber(value));
  financeApplyLockedTotalAdjustment();
  financeQueueSave();
  financeRenderEditor();
}

function financeToggleDocumentFlag(field) {
  const current = ['showDepartmentSubtotals', 'summaryBySubproject'].includes(field)
    ? financeState.current[field] !== false
    : !!financeState.current[field];
  financeState.current[field] = !current;
  financeQueueSave();
  financeRenderEditor();
}

function financeSetSummaryGrouping(grouping) {
  financeState.current.summaryBySubproject = grouping !== 'category';
  financeQueueSave();
  financeRenderEditor();
}

function financeQueueSave(options = {}) {
  if (financeState.discardingRevision) return;
  financeSynchroniseLinkedSubprojects(
    financeState.current,
    options.sourceSubprojectId || financeCurrentSubprojectId(financeState.current)
  );
  financeState.automaticDraftDateRefresh =
    options.automaticDraftDateRefresh === true;
  financeState.changeVersion += 1;
  const state = document.getElementById('financeSaveState');
  if (state) state.textContent = 'Unsaved changes';
  clearTimeout(financeState.saveTimer);
  if (options.immediate === true) {
    financeState.saveTimer = null;
    void financeSaveCurrent(false).catch(error => {
      showNotification('error', error.message || 'Failed to save quotation');
    });
    return;
  }
  financeState.saveTimer = setTimeout(() => financeSaveCurrent(false), 650);
}

function financeSyncClientCache(document, previousRecordName = '') {
  const client = document?.client || {};
  const recordName = String(document?.clientRecordName || client.name || '').trim();
  if (!recordName || !String(client.name || '').trim()) return;
  const previousKey = String(previousRecordName || '').trim().toLowerCase();
  const recordKey = recordName.toLowerCase();
  financeState.clients = (financeState.clients || []).filter(row => {
    const key = String(row?.name || '').trim().toLowerCase();
    return key !== recordKey && (!previousKey || key !== previousKey);
  });
  financeState.clients.push({ ...client });
  financeState.clients.sort((left, right) => financeClientDisplay(left).localeCompare(financeClientDisplay(right)));
}

function financeQuotationIsBlank(document) {
  if (!document?._createdBlank) return false;
  const client = document.client || {};
  const hasClient = Object.values(client).some(value => String(value || '').trim());
  const dateChanged = String(document.quotationDate || '') !== String(document._initialQuotationDate || '');
  const rooms = financeSubprojects(document);
  const hasCustomRooms = rooms.length > 1 || String(rooms[0]?.name || '') !== 'Main Room';
  const hasOtherContent = [
    document.reference,
    document.eventReference,
    document.eventLocation,
    document.setupDate,
    document.rehearsalDate,
    document.showDate,
    document.teardownDate,
    document.notes
  ].some(value => String(value || '').trim()) || [
    ...(document.additionalSetups || []),
    ...(document.additionalRehearsals || []),
    ...(document.additionalShows || []),
    ...(document.additionalTeardowns || [])
  ].some(row => String(row?.date || row?.time || '').trim())
    || financeCustomScheduleGroups(document).some(group =>
      String(group?.label || '').trim()
      || (group?.dates || []).some(row => String(row?.date || row?.time || '').trim())
    );
  return !hasClient
    && !String(document.projectName || '').trim()
    && !(document.departments || []).length
    && !(document.lineItems || []).length
    && !financeHeaderRows(document).length
    && !hasCustomRooms
    && !hasOtherContent
    && !dateChanged;
}

async function financeSaveCurrent(notify = false, conflictRetry = 0) {
  const current = financeState.current;
  if (!current) return null;
  if (financeState.discardingRevision) return current;
  if (financeState.activeSaves.size) {
    const pendingDocumentId = String(current.id || '');
    clearTimeout(financeState.saveTimer);
    financeState.saveTimer = null;
    const state = document.getElementById('financeSaveState');
    if (state) state.textContent = 'Waiting to save...';
    await Promise.allSettled([...financeState.activeSaves]);
    if (
      financeState.discardingRevision
      || String(financeState.current?.id || '') !== pendingDocumentId
    ) {
      return financeState.current;
    }
    return financeSaveCurrent(notify, conflictRetry);
  }
  financeSyncDocumentDepartments(current);
  financeApplyLockedTotalAdjustment(current);
  clearTimeout(financeState.saveTimer);
  financeState.saveTimer = null;
  const version = financeState.changeVersion;
  const automaticDraftDateRefresh = financeState.automaticDraftDateRefresh;
  const localSnapshot = financeCloneDocument(current);
  const baseSnapshot = financeCloneDocument(financeState.baseDocument || current);
  const previousClientRecordName = current.clientRecordName || current.client?.name || '';
  const state = document.getElementById('financeSaveState');
  if (state) state.textContent = 'Saving...';
  try {
    const editingSentRevision = Number(current._editingSentRevision || 0);
    const endpoint = editingSentRevision
      ? `/api/quotations/${encodeURIComponent(current.id)}/revisions/${encodeURIComponent(editingSentRevision)}`
      : `/api/quotations/${encodeURIComponent(current.id)}`;
    const payload = {
      ...current,
      _baseDocument: baseSnapshot,
      ...(automaticDraftDateRefresh ? { _automaticDraftDateRefresh: true } : {})
    };
    const requestPromise = apiCall(endpoint, 'PUT', payload);
    financeState.activeSaves.add(requestPromise);
    let response;
    try {
      response = await requestPromise;
    } finally {
      financeState.activeSaves.delete(requestPromise);
    }
    financeSyncClientCache(response.data, previousClientRecordName);
    financeRememberPaymentTermOption(response.data?.paymentTerms);
    let hasPendingChanges = false;
    if (financeState.current?.id === current.id && financeState.changeVersion === version) {
      const previousNumber = financeState.current.number;
      const previousStatus = financeState.current.status;
      response.data._createdBlank = current._createdBlank;
      response.data._initialQuotationDate = current._initialQuotationDate;
      if (editingSentRevision) response.data._editingSentRevision = editingSentRevision;
      financeState.current = response.data;
      financeState.baseDocument = financeCloneDocument(response.data);
      financeState.automaticDraftDateRefresh = false;
      if (previousNumber !== response.data.number || previousStatus !== response.data.status || notify) financeRenderEditor();
    } else if (financeState.current?.id === current.id && !financeState.discardingRevision) {
      const newestLocal = financeCloneDocument(financeState.current);
      const rebased = financeMergeDocumentConflict(
        localSnapshot,
        newestLocal,
        response.data
      );
      rebased.documentVersion = response.data.documentVersion;
      const serverHeaderChanged = (
        newestLocal.number !== rebased.number
        || newestLocal.status !== rebased.status
        || newestLocal.revision !== rebased.revision
      );
      financeState.current = rebased;
      financeState.baseDocument = financeCloneDocument(response.data);
      hasPendingChanges = true;
      if (serverHeaderChanged) financeRenderEditor();
      clearTimeout(financeState.saveTimer);
      financeState.saveTimer = setTimeout(() => financeSaveCurrent(false), 300);
    }
    const nextState = document.getElementById('financeSaveState');
    if (nextState) {
      nextState.textContent = hasPendingChanges
        ? 'Unsaved changes'
        : editingSentRevision ? 'Version changes saved' : 'All changes saved';
    }
    if (notify) showNotification('success', 'Quotation saved');
    return response.data;
  } catch (error) {
    if (
      error.payload?.code === 'subproject_structure_conflict'
      && error.payload?.data
      && financeState.current?.id === current.id
    ) {
      const latest = error.payload.data;
      financeState.baseDocument = financeCloneDocument(latest);
      financeState.current = latest;
      financeState.changeVersion += 1;
      financeRenderEditor();
      if (state) state.textContent = 'Unsafe sub-project change blocked';
      showNotification(
        'error',
        'A save that would combine sub-projects was blocked. The latest saved layout was restored.'
      );
      return latest;
    }
    if (
      error.payload?.code === 'document_version_conflict'
      && error.payload?.data
      && conflictRetry < 1
      && financeState.current?.id === current.id
    ) {
      const latest = error.payload.data;
      const newestLocal = financeState.changeVersion === version
        ? localSnapshot
        : financeCloneDocument(financeState.current);
      const mergedLocal = financeMergeDocumentConflict(
        baseSnapshot, newestLocal, latest
      );
      const decision = await showAppConfirm({
        title: 'Quotation changed elsewhere',
        message: 'Another user changed the same quotation detail. Keep your value, or use the latest saved value?',
        confirmText: 'Keep My Changes',
        confirmValue: 'keep-local',
        alternateText: 'Use Latest',
        alternateValue: 'use-latest',
        cancelText: 'Review First'
      });
      if (decision === 'keep-local') {
        mergedLocal.documentVersion = latest.documentVersion;
        financeState.baseDocument = financeCloneDocument(latest);
        financeState.current = mergedLocal;
        financeState.changeVersion += 1;
        financeRenderEditor();
        return financeSaveCurrent(notify, conflictRetry + 1);
      }
      if (decision === 'use-latest') {
        financeState.baseDocument = financeCloneDocument(latest);
        financeState.current = latest;
        financeState.changeVersion += 1;
        financeRenderEditor();
        return latest;
      }
      if (state) state.textContent = 'Conflict needs review';
      return null;
    }
    if (state) state.textContent = 'Save failed';
    if (notify) showNotification('error', error.message || 'Failed to save quotation');
    throw error;
  }
}

async function financeFlushPendingSave() {
  const hasUnsavedChanges = () => Boolean(financeState.current && !financeValuesEqual(financeState.current, financeState.baseDocument));
  if (financeState.saveTimer || hasUnsavedChanges()) {
    const saved = await financeSaveCurrent(false);
    if (!saved) return null;
  }
  if (financeState.activeSaves.size) {
    await Promise.allSettled([...financeState.activeSaves]);
  }
  if (financeState.saveTimer || hasUnsavedChanges()) {
    const saved = await financeSaveCurrent(false);
    if (!saved) return null;
  }
  return hasUnsavedChanges() ? null : financeState.current;
}

function financeRunCatalogSearch(clean, cacheKey, requestSeq) {
  if (requestSeq !== financeState.catalogRequestSeq) return;
  if (financeState.catalogInFlight) {
    financeState.catalogQueuedSearch = { clean, cacheKey, requestSeq };
    return;
  }
  financeState.catalogInFlight = true;
  const controller = new AbortController();
  financeState.catalogAbortController = controller;
  const timeout = setTimeout(() => controller.abort(), 8000);
  (async () => {
    try {
      const response = await fetch(`/api/finance/catalog?query=${encodeURIComponent(clean)}`, {
        credentials: 'same-origin',
        signal: controller.signal,
        headers: {
          "X-Client-Id": typeof REALTIME_CLIENT_ID !== 'undefined' ? REALTIME_CLIENT_ID : ''
        }
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Failed to search items');
      if (requestSeq !== financeState.catalogRequestSeq) return;
      financeState.catalog = financeGroupEquivalentContainers(
        financeSortCatalogSuggestions(payload.data || [])
      );
      financeState.catalogCache[cacheKey] = financeState.catalog;
      financeState.catalogQuery = cacheKey;
    } catch {
      if (requestSeq !== financeState.catalogRequestSeq) return;
      financeState.catalog = [];
      financeState.catalogQuery = cacheKey;
    } finally {
      clearTimeout(timeout);
      if (financeState.catalogAbortController === controller) {
        financeState.catalogAbortController = null;
      }
      financeState.catalogInFlight = false;
      const queued = financeState.catalogQueuedSearch;
      financeState.catalogQueuedSearch = null;
      if (queued?.requestSeq === financeState.catalogRequestSeq) {
        financeRunCatalogSearch(queued.clean, queued.cacheKey, queued.requestSeq);
      }
    }
    if (requestSeq !== financeState.catalogRequestSeq) return;
    financeRenderCatalog();
  })();
}

function financeSearchCatalog(query) {
  clearTimeout(financeState.catalogTimer);
  financeState.pendingCatalogSelection = null;
  const results = document.getElementById('financeCatalogResults');
  const clean = String(query || '').trim();
  const cacheKey = clean.toLowerCase();
  const requestSeq = ++financeState.catalogRequestSeq;
  financeState.catalogQueuedSearch = null;
  if (!clean) {
    financeState.catalog = [];
    financeState.catalogQuery = '';
    results?.classList.remove('open');
    return;
  }
  if (cacheKey.length < 2) {
    financeState.catalog = [];
    financeState.catalogQuery = cacheKey;
    if (results) {
      results.innerHTML = '<div class="finance-suggestion-empty">Type at least 2 characters to search inventory, or press Add to create a custom item.</div>';
      results.classList.add('open');
    }
    return;
  }
  if (financeState.catalogCache[cacheKey]) {
    financeState.catalog = financeState.catalogCache[cacheKey];
    financeState.catalogQuery = cacheKey;
    financeRenderCatalog();
    return;
  }
  const cachedPrefix = Object.keys(financeState.catalogCache)
    .filter(key => key.length >= 2 && cacheKey.startsWith(key))
    .sort((left, right) => right.length - left.length)[0];
  if (cachedPrefix) {
    financeState.catalog = financeState.catalogCache[cachedPrefix].filter(row => (
      financeCatalogMatchesQuery(row, cacheKey)
    ));
    financeState.catalogQuery = cacheKey;
    financeRenderCatalog();
  }
  if (results) {
    if (!cachedPrefix) results.innerHTML = '<div class="finance-suggestion-empty">Searching... You can press Add now to create this as a custom item.</div>';
    results.classList.add('open');
  }
  financeState.catalogTimer = setTimeout(() => {
    financeRunCatalogSearch(clean, cacheKey, requestSeq);
  }, 300);
}

function financeCatalogMatchesQuery(row, query) {
  const haystack = [
    row?.brand, row?.model, row?.description, row?.productLabel,
    row?.productCategory, row?.department, row?.departmentCode,
    row?.containerId, row?.containerSerial, ...(row?.searchTags || [])
  ].join(' ').toLocaleLowerCase();
  return String(query || '').trim().toLocaleLowerCase().split(/\s+/).every(
    token => haystack.includes(token)
  );
}

function financeContainerFamilyLabel(containerId) {
  const clean = String(containerId || '').trim();
  return clean.replace(/\s*(?:#|(?:no|number)\.?\s+)\s*[a-z]?\d+(?:[._/-][a-z0-9]+)*\s*$/i, '').trim() || clean;
}

function financeSortCatalogSuggestions(rows) {
  return [...(rows || [])].sort((left, right) => (
    Number(!!left?.isContainer) - Number(!!right?.isContainer)
  ));
}

function financeContainerContentsSignature(row) {
  return (row?.containerItems || []).map(item => [
    String(item.departmentCode || item.department || '').trim().toLowerCase(),
    String(item.brand || '').trim().toLowerCase(),
    String(item.model || '').trim().toLowerCase(),
    String(item.description || '').trim().toLowerCase(),
    financeNumber(item.containerQuantity || item.availableQuantity || 0)
  ].join('|')).sort().join('||');
}

function financeGroupEquivalentContainers(rows) {
  const groups = new Map();
  const result = [];
  (rows || []).forEach(row => {
    if (!row?.isContainer) {
      result.push(row);
      return;
    }
    const family = financeContainerFamilyLabel(row.containerId);
    const key = `${family.toLowerCase()}::${financeContainerContentsSignature(row)}`;
    if (!groups.has(key)) {
      const grouped = { ...row, containerFamily: family, containerIds: [row.containerId], containerCount: 1 };
      groups.set(key, grouped);
      result.push(grouped);
      return;
    }
    const grouped = groups.get(key);
    grouped.containerIds.push(row.containerId);
    grouped.containerCount += 1;
  });
  return result;
}

function financeCatalogDescription(row) {
  if (!row?.isContainer) return financeEscape(row?.productLabel || row?.description || '');
  const label = financeEscape(row.productLabel || row.containerFamily || row.description || 'Container');
  return row.containerCount > 1
    ? `${label} <small>(${row.containerCount} matching containers)</small>`
    : label;
}

function financeCatalogAvailability(row) {
  if (row?.availableQuantity === null) return 'previously used';
  return `${financeNumber(row?.availableQuantity)} ${row?.isContainer ? 'per container' : 'available'}`;
}

function financeContainerMajorityCategory(container) {
  const totals = new Map();
  (container?.containerItems || []).forEach((item, index) => {
    const category = financeCatalogCategory(item);
    const key = category.toLocaleLowerCase();
    const quantity = Math.max(0, financeNumber(
      item?.containerQuantity ?? item?.availableQuantity ?? 1,
      1
    ));
    const current = totals.get(key) || {
      category,
      quantity: 0,
      firstIndex: index
    };
    current.quantity += quantity;
    totals.set(key, current);
  });
  return [...totals.values()].sort((left, right) => (
    right.quantity - left.quantity || left.firstIndex - right.firstIndex
  ))[0]?.category || 'General';
}

function financeRenderCatalog() {
  const results = document.getElementById('financeCatalogResults');
  if (!results) return;
  results.innerHTML = financeState.catalog.map((row, index) => `
    <button type="button" class="finance-catalog-option" onkeydown="financeCatalogSuggestionKeydown(event,${index})" onclick="financeSelectCatalog(${index})">
      <span><strong>${financeCatalogDescription(row)}</strong><small>${financeEscape(row.isContainer ? financeContainerMajorityCategory(row) : financeLineSystem(row))} &middot; ${financeCatalogAvailability(row)}</small></span>
      <span>${row.unitPrice ? financeEscape(financeMoney(row.unitPrice)) : '<small>No saved price</small>'}</span>
    </button>
  `).join('') || '<div class="finance-suggestion-empty">Press Add to create a custom item</div>';
  results.classList.toggle('open', document.activeElement === document.getElementById('financeAddItemInput'));
}

function financeAddLineFromCatalog(selected, categoryOverride = '', quantityOverride = null) {
  const department = selected.department || 'General';
  const category = financeCatalogCategory(
    selected,
    categoryOverride || financeAddDepartmentOverride()
  );
  const days = financeEventDays();
  const quantity = quantityOverride === null || quantityOverride === undefined
    ? 1
    : Math.max(0, financeNumber(quantityOverride, 1));
  const line = {
    id: `line_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    productId: selected.productId || selected.id || '',
    productKey: selected.productKey || selected.catalogKey || '',
    catalogKey: selected.catalogKey || '',
    sourceAssetIds: selected.sourceAssetIds || [],
    brand: selected.brand || '',
    model: selected.model || '',
    description: selected.productLabel || selected.description,
    inventoryNameMode: selected.catalogKey ? 'inventory' : '',
    department,
    departmentCode: selected.departmentCode || '',
    systemName: category,
    days,
    quantity,
    uom: financeDefaultUom(category, selected.uom),
    unitPrice: financeNumber(selected.unitPrice),
    discountPercent: 0,
    total: financeNumber(selected.unitPrice) * days * quantity,
    isCustom: !!selected.isCustom,
    subprojectId: financeCurrentSubprojectId()
  };
  financeState.current.lineItems.push(line);
  return line;
}

function financeAddContainerAsGroup(
  selected,
  categoryOverride = financeAddDepartmentOverride(),
  quantity = 1
) {
  const containerId = String(selected?.containerId || '').trim();
  const containerItems = Array.isArray(selected?.containerItems)
    ? selected.containerItems
    : [];
  if (!containerId || !containerItems.length) return [];

  const containerCategory = categoryOverride || financeContainerMajorityCategory(selected);
  const groupId = `container_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const subprojectId = financeCurrentSubprojectId();
  const groupQuantity = Math.max(1, financeNumber(quantity, 1));
  const grouped = containerItems.map(item => ({
    ...financeNewGroupedQuotationLine({
      ...item,
      quantityOverride: item.containerQuantity || item.availableQuantity || 1
    }, containerCategory),
    subprojectId,
    groupId,
    groupTitle: containerId,
    isContainerGroup: true,
    containerId,
    groupDisplayFields: ['brand', 'model', 'description'],
    groupCustomText: false
  }));
  if (groupQuantity !== 1) {
    grouped.forEach(line => {
      financeCaptureGroupItemCommercial(line);
      line.groupItemPriceContribution = Math.max(0, financeLineTotal(line));
    });
    const headerUnitPrice = Math.round(grouped.reduce(
      (sum, line) => sum + financeGroupItemPriceContribution(line),
      0
    ) * 100) / 100;
    grouped.forEach((line, index) => Object.assign(line, {
      days: 1,
      quantity: groupQuantity,
      uom: 'sets',
      unitPrice: headerUnitPrice,
      discountPercent: 0,
      totalMode: 'amount',
      total: index === 0 ? headerUnitPrice * groupQuantity : 0,
      groupLeader: index === 0,
      groupHeaderQuantity: groupQuantity,
      groupPricingMode: 'items'
    }));
  }
  financeState.current.lineItems.push(...grouped);
  return grouped;
}

function financeSelectCatalog(index) {
  const selected = financeState.catalog[index];
  if (!selected) return;
  financeState.pendingCatalogSelection = null;
  if (selected.isContainer) {
    financeAddContainerAsGroup(selected);
  } else {
    financeAddLineFromCatalog(selected);
  }
  financeSyncDocumentDepartments();
  financeState.addDepartment = '';
  financeState.catalog = [];
  financeQueueSave();
  financeRenderEditor();
  financeFocusAddItemInput();
}

function financeFocusAddItemInput() {
  requestAnimationFrame(() => {
    const input = document.getElementById('financeAddItemInput');
    input?.focus();
    input?.select();
  });
}

function financeCatalogSuggestionKeydown(event, index) {
  if (showbaseLineWorkspace.suggestionOptionKeydown(event, 'financeCatalogResults')) return;
  if (event.key !== 'Enter') return;
  event.preventDefault();
  event.stopPropagation();
  financeStageCatalogSelection(index);
}

function financeStageCatalogSelection(index) {
  const selected = financeState.catalog[index];
  if (!selected) return false;
  financeState.pendingCatalogSelection = selected;
  const descriptionInput = document.getElementById('financeAddItemInput');
  if (descriptionInput) descriptionInput.value = selected.description || '';
  const category = selected.isContainer
    ? financeContainerMajorityCategory(selected)
    : financeCatalogCategory(selected);
  financeState.addDepartment = category;
  const departmentInput = document.getElementById('financeAddDepartmentInput');
  if (departmentInput) departmentInput.value = category;
  showbaseLineWorkspace.hideSuggestions('financeCatalogResults');
  departmentInput?.focus();
  financeShowAddDepartmentSuggestions(category);
  return true;
}

function financeStageCustomCatalogSelection() {
  const description = String(document.getElementById('financeAddItemInput')?.value || '').trim();
  if (!description) return false;
  financeState.pendingCatalogSelection = { isKeyboardCustom: true, description };
  showbaseLineWorkspace.hideSuggestions('financeCatalogResults');
  const departmentInput = document.getElementById('financeAddDepartmentInput');
  departmentInput?.focus();
  financeShowAddDepartmentSuggestions(departmentInput?.value || '');
  return true;
}

async function financeAddCustomItem() {
  const input = document.getElementById('financeAddItemInput');
  const description = input?.value.trim();
  if (!description) return input?.focus();
  financeState.catalogAbortController?.abort?.();
  financeState.catalogRequestSeq += 1;
  const exactLoaded = (financeState.catalog || []).find(row =>
    row.isCustom && [row.productLabel, row.description].some(
      value => String(value || '').trim().toLowerCase() === description.toLowerCase()
    )
  ) || {};
  const departmentOverride = financeAddDepartmentOverride();
  const category = departmentOverride
    || (exactLoaded.department ? financeLineSystem(exactLoaded) : '')
    || exactLoaded.department
    || 'General';
  const categoryDepartment = financeCategoryOperationalDepartment(category);
  const department = categoryDepartment?.department
    || exactLoaded.department
    || departmentOverride
    || 'General';
  const lineId = `line_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  financeState.current.lineItems.push({
    id: lineId,
    productId: exactLoaded.productId || exactLoaded.id || '',
    productKey: exactLoaded.productKey || exactLoaded.catalogKey || '',
    catalogKey: '',
    sourceAssetIds: [],
    brand: '',
    model: '',
    description,
    productLabel: description,
    department,
    departmentCode: categoryDepartment?.departmentCode || exactLoaded.departmentCode || '',
    systemName: category,
    days: financeEventDays(),
    quantity: 1,
    uom: financeDefaultUom(department, exactLoaded.uom),
    unitPrice: financeNumber(exactLoaded.unitPrice),
    discountPercent: 0,
    total: financeNumber(exactLoaded.unitPrice) * financeEventDays(),
    isCustom: true,
    subprojectId: financeCurrentSubprojectId()
  });
  financeSyncDocumentDepartments();
  financeState.addDepartment = '';
  financeState.catalog = [];
  financeState.catalogQuery = '';
  financeQueueSave();
  financeRenderEditor();
  financeFocusAddItemInput();
  if (!exactLoaded.productId && !exactLoaded.id) {
    const addToProducts = await showAppConfirm({
      title: 'Add this as a product?',
      message: `${description} can be saved to Products so it appears in future quotation searches.`,
      confirmText: 'Add to Products',
      cancelText: 'Keep in This Quotation'
    });
    if (addToProducts) {
      try {
        const currentLine = financeState.current?.lineItems?.find(row => row.id === lineId);
        if (currentLine) {
          const rows = await financePersistProduct({
            ...currentLine,
            brand: '',
            model: '',
            description: currentLine.productLabel || currentLine.description,
            productLabel: currentLine.productLabel || currentLine.description,
            productCategory: currentLine.systemName || currentLine.department,
            isCustom: true
          });
          const savedProduct = rows.find(row => row.isCustom
            && String(row.productLabel || '').trim().toLowerCase() === description.toLowerCase());
          if (savedProduct) {
            currentLine.productId = savedProduct.productId || savedProduct.id || '';
            currentLine.productKey = savedProduct.productKey || savedProduct.catalogKey || '';
            currentLine.productPricePending = financeNumber(savedProduct.unitPrice) <= 0;
          }
          financeQueueSave();
          showNotification('success', 'Product added for future quotations');
        }
      } catch (error) {}
    }
  }
  try {
    const remembered = (await apiCall(`/api/finance/price-suggestion?description=${encodeURIComponent(description)}`)).data || {};
    const line = financeState.current?.lineItems?.find(row => row.id === lineId);
    if (!line || financeNumber(line.unitPrice) > 0 || !financeNumber(remembered.unitPrice)) return;
    line.department = categoryDepartment?.department
      || remembered.department
      || line.department;
    line.departmentCode = categoryDepartment?.departmentCode
      || remembered.departmentCode
      || line.departmentCode
      || '';
    line.uom = remembered.uom || line.uom || 'units';
    line.unitPrice = financeNumber(remembered.unitPrice);
    line.totalMode = 'calculated';
    line.total = financeLineTotal(line);
    financeSyncDocumentDepartments();
    financeQueueSave();
    financeRenderEditor();
    financeFocusAddItemInput();
  } catch {}
}

function financeAddItemKeydown(event) {
  if (event.key === 'Tab') {
    showbaseLineWorkspace.suggestionKeydown(event, 'financeCatalogResults');
    return;
  }
  if (event.key !== 'Enter') return;
  event.preventDefault();
  const query = String(document.getElementById('financeAddItemInput')?.value || '').trim().toLowerCase();
  const results = document.getElementById('financeCatalogResults');
  if (results?.classList.contains('open') && financeState.catalog.length > 0 && financeState.catalogQuery === query) financeStageCatalogSelection(0);
  else financeStageCustomCatalogSelection();
}

function financeEnsureSentModal() {
  if (document.getElementById('financeSentModal')) return;
  const modal = document.createElement('div');
  modal.id = 'financeSentModal';
  modal.className = 'modal';
  modal.innerHTML = `
    <div class="modal-content" style="max-width:480px;">
      <div class="modal-header"><h3 class="modal-title">Mark quotation as Sent</h3><button type="button" class="close-btn" onclick="closeModal('financeSentModal')">×</button></div>
      <p style="color:#64748b;margin-bottom:16px;">A version of this quotation will be saved. Later edits will create the next version.</p>
      <div class="finance-invoiced-fields">
        <label class="finance-field"><span>Sent date</span><input id="financeSentDate" class="finance-input" type="date" value="${financeTodayIso()}" required></label>
        <label class="finance-field"><span>Valid for</span><span class="finance-validity-control"><input id="financeSentValidityAmount" class="finance-input" type="number" min="1" max="365" value="30"><input id="financeSentValidityUnitValue" type="hidden" value="days"><span id="financeSentValidityUnitHolder">${financeValidityUnitControl('days', 'finance-sent-validity-unit-menu', 'financeSetSentValidityUnit')}</span></span></label>
      </div>
      <div class="modal-actions" style="display:flex;justify-content:flex-end;gap:8px;margin-top:20px;"><button type="button" class="btn btn-secondary" onclick="closeModal('financeSentModal')">Cancel</button><button type="button" class="btn btn-primary" onclick="financeConfirmSent()">Mark as Sent</button></div>
    </div>
  `;
  document.body.appendChild(modal);
}

async function financeRequestStatus(documentId, status, context) {
  document.querySelectorAll('.finance-custom-menu.open').forEach(menu => menu.classList.remove('open'));
  financeState.statusTargetId = documentId;
  let documentRow = financeState.current?.id === documentId ? financeState.current : financeState.documents.find(row => row.id === documentId);
  if (!documentRow) return;
  if (status === 'sent') {
    financeEnsureSentModal();
    document.getElementById('financeSentDate').value = documentRow.status === 'expired'
      ? financeTodayIso()
      : financeDateOnly(documentRow.sentAt) || financeTodayIso();
    document.getElementById('financeSentValidityAmount').value = financeValidityAmount(documentRow);
    financeSetSentValidityUnit(financeValidityUnit(documentRow));
    openModal('financeSentModal');
    return;
  }
  if (status === 'accepted') {
    const pairedEventId = Number(documentRow.eventId || 0);
    const confirmed = await showAppConfirm({
      title: pairedEventId ? 'Accept paired quotation?' : 'Accept quotation and create event?',
      message: pairedEventId
        ? `This quotation is paired to Event #${pairedEventId}. Accepting it will not create another event.`
        : 'This will create an event with the quotation project, location and inventory requirements. Crew & Vendors and transportation lines are not added to Prepare.',
      confirmText: pairedEventId ? 'Accept Quotation' : 'Accept & Create Event',
      cancelText: 'Cancel'
    });
    if (!confirmed) return;
  }
  await financeCommitStatus(documentId, status, {});
}

async function financeConfirmSent() {
  const sentDate = document.getElementById('financeSentDate')?.value || '';
  if (!sentDate) {
    showNotification('error', 'Choose the date the quotation was sent.');
    document.getElementById('financeSentDate')?.focus();
    return;
  }
  const amount = Math.max(1, financeNumber(document.getElementById('financeSentValidityAmount')?.value, 30));
  const unit = financeValidityUnitMeta(document.getElementById('financeSentValidityUnitValue')?.value).value;
  const days = Math.max(1, Math.round(amount * financeValidityUnitMeta(unit).multiplier));
  closeModal('financeSentModal');
  await financeCommitStatus(financeState.statusTargetId, 'sent', {
    sentDate,
    validityAmount: amount,
    validityUnit: unit,
    validityDays: days
  });
}

async function financeCommitStatus(documentId, status, extras, conflictRetry = 0) {
  const listRow = Array.from(financeRoot()?.querySelectorAll('.finance-list-row') || [])
    .find(row => row.dataset.documentId === String(documentId));
  listRow?.classList.add('is-updating');
  listRow?.setAttribute('aria-busy', 'true');
  try {
    let beforeChange = financeState.current?.id === documentId ? financeState.current : financeState.documents.find(row => row.id === documentId);
    const existingEventId = Number(beforeChange?.eventId || 0);
    if (financeState.current?.id === documentId) {
      const saved = await financeFlushPendingSave();
      if (!saved || saved.id !== documentId) {
        listRow?.classList.remove('is-updating');
        listRow?.removeAttribute('aria-busy');
        return;
      }
      beforeChange = saved;
    }
    const response = await apiCall(`/api/quotations/${encodeURIComponent(documentId)}`, 'PUT', {
      status,
      ...extras,
      documentVersion: beforeChange?.documentVersion
    });
    if (financeState.current?.id === documentId) {
      financeState.current = response.data;
      financeState.baseDocument = financeCloneDocument(response.data);
      financeRenderEditor();
    } else {
      financeUpdateListRow(response.data);
    }
    if (
      status === 'accepted'
      && !existingEventId
      && response.data.eventId
      && typeof registerCreatedEventInClient === 'function'
    ) {
      await registerCreatedEventInClient(response.data.eventId);
    }
    const eventNote = status === 'accepted' && response.data.eventId
      ? (existingEventId ? ` Linked to Event #${response.data.eventId}.` : ` Event #${response.data.eventId} was created.`)
      : '';
    showNotification('success', `Quotation marked ${financeStatusLabel(response.data.status)}.${eventNote}`);
  } catch (error) {
    if (
      error.payload?.code === 'document_version_conflict'
      && error.payload?.data
      && conflictRetry < 1
    ) {
      if (financeState.current?.id === documentId) {
        financeState.current = error.payload.data;
        financeState.baseDocument = financeCloneDocument(error.payload.data);
        financeRenderEditor();
      } else {
        financeUpdateListRow(error.payload.data);
      }
      return financeCommitStatus(documentId, status, extras, conflictRetry + 1);
    }
    listRow?.classList.remove('is-updating');
    listRow?.removeAttribute('aria-busy');
    showNotification('error', error.message || 'Failed to change quotation status');
  }
}

async function financeExportPdf() {
  return financeExportQuotation(financeState.current?.id);
}

function financeClearProjectNameExportError(input = document.getElementById('financeProjectNameInput')) {
  if (!input || !String(input.value || '').trim()) return;
  input.removeAttribute('aria-invalid');
  input.classList.remove('finance-input-error');
}

function financeRequireExportProjectName(quotation) {
  const projectName = String(quotation?.projectName || '').trim();
  if (projectName) {
    financeClearProjectNameExportError();
    return true;
  }
  const input = financeState.current?.id === quotation?.id
    ? document.getElementById('financeProjectNameInput')
    : null;
  if (input) {
    input.setAttribute('aria-invalid', 'true');
    input.classList.add('finance-input-error');
    input.focus();
  }
  const saveState = document.getElementById('financeSaveState');
  if (saveState) saveState.textContent = 'Project Name is required before exporting';
  showNotification('error', 'Add a Project Name before exporting the quotation.');
  return false;
}

async function financeExportQuotation(documentId = financeState.current?.id) {
  const quotation = financeState.current?.id === documentId
    ? financeState.current
    : financeState.documents.find(row => row.id === documentId);
  if (!quotation || !financeCanExportQuotation(quotation)) return;
  if (!financeRequireExportProjectName(quotation)) return;
  try {
    let current = quotation;
    if (financeState.current?.id === quotation.id) {
      current = await financeFlushPendingSave();
    }
    const cacheKey = current.updatedAt || Date.now();
    const pdfUrl = `/api/quotations/${encodeURIComponent(current.id)}/pdf?v=${encodeURIComponent(cacheKey)}`;
    const opened = window.open(pdfUrl, '_blank', 'noopener');
    if (!opened) {
      showNotification('warning', 'Please allow pop-ups to preview the PDF');
    }
  } catch (error) {
    showNotification('error', error.message || 'Failed to export quotation');
  }
}

async function financeExportInvoice(documentId = financeState.current?.id) {
  const current = financeState.current?.id === documentId
    ? financeState.current
    : financeState.documents.find(row => row.id === documentId);
  if (!current || !financeCanExportInvoice(current)) return;
  try {
    if (financeState.current?.id === current.id) await financeSaveCurrent(false);
    const invoicePath = `/invoices/${encodeURIComponent(current.id)}`;
    if (typeof updateAppDetailHistory === 'function') updateAppDetailHistory(invoicePath);
    showSection('invoices', { updateHistory: false });
  } catch (error) {
    showNotification('error', error.message || 'Failed to open invoice plan');
  }
}

async function financeDeleteCurrent() {
  const current = financeState.current;
  if (!current) return;
  const confirmed = await showAppConfirm({
    title: 'Delete Quotation',
    message: `Delete ${current.number}? This cannot be undone.`,
    confirmText: 'Delete',
    cancelText: 'Cancel',
    destructive: true
  });
  if (!confirmed) return;
  try {
    await apiCall(`/api/quotations/${encodeURIComponent(current.id)}`, 'DELETE');
    showNotification('success', 'Quotation deleted');
    financeState.current = null;
    if (typeof updateAppDetailHistory === 'function') updateAppDetailHistory('/quotations', true);
    await financeLoadList();
  } catch (error) {
    showNotification('error', error.message || 'Failed to delete quotation');
  }
}

function financeEnsureClientModal() {
  if (document.getElementById('financeClientModal')) return;
  const modal = document.createElement('div');
  modal.id = 'financeClientModal';
  modal.className = 'modal';
  modal.innerHTML = `
    <div class="modal-content" style="max-width:760px;">
      <div class="modal-header"><h3 class="modal-title">New Client</h3><button type="button" class="close-btn" onclick="closeModal('financeClientModal')">×</button></div>
      <form id="financeClientForm" onsubmit="financeSaveNewClient(event)">
        <div class="finance-new-client-grid">
          <label class="finance-field"><span>Name *</span><div class="finance-client-name-control"><div id="financeNewClientSalutationControl">${financeSalutationControl('', 'finance-new-client-salutation-menu', 'financeSetNewClientSalutation')}</div><input id="financeClientName" class="finance-input" required></div></label>
          <label class="finance-field"><span>Company</span><input id="financeClientCompany" class="finance-input"></label>
          <label class="finance-field"><span>Contact person</span><input id="financeClientContact" class="finance-input"></label>
          <label class="finance-field"><span>Email</span><input id="financeClientEmail" class="finance-input" type="email"></label>
          <label class="finance-field"><span>Phone</span><input id="financeClientPhone" class="finance-input"></label>
          <label class="finance-field"><span>UEN / tax number</span><input id="financeClientTax" class="finance-input"></label>
          <label class="finance-field wide"><span>Address</span><input id="financeClientAddress" class="finance-input"></label>
          <label class="finance-field"><span>Postal code</span><input id="financeClientPostal" class="finance-input"></label>
        </div>
        <div class="modal-actions" style="display:flex;gap:10px;justify-content:flex-end;margin-top:20px;"><button type="button" class="btn btn-secondary" onclick="closeModal('financeClientModal')">Cancel</button><button type="submit" class="btn btn-primary">Save Client</button></div>
      </form>
    </div>
  `;
  document.body.appendChild(modal);
}

function financeOpenClientModal() {
  financeEnsureClientModal();
  document.getElementById('financeClientForm')?.reset();
  financeState.newClientSalutation = '';
  const control = document.getElementById('financeNewClientSalutationControl');
  if (control) control.innerHTML = financeSalutationControl('', 'finance-new-client-salutation-menu', 'financeSetNewClientSalutation');
  openModal('financeClientModal');
}

async function financeSaveNewClient(event) {
  event.preventDefault();
  const value = id => document.getElementById(id)?.value.trim() || '';
  try {
    const response = await apiCall('/api/clients', 'POST', {
      salutation: financeState.newClientSalutation || '',
      name: value('financeClientName'),
      company: value('financeClientCompany'),
      contactPerson: value('financeClientContact'),
      email: value('financeClientEmail'),
      phone: value('financeClientPhone'),
      taxNumber: value('financeClientTax'),
      address1: value('financeClientAddress'),
      address2: '',
      address3: '',
      postalCode: value('financeClientPostal')
    });
    await financeLoadEditorData();
    financeState.current.client = { ...response.data };
    financeState.current.clientRecordName = response.data.name;
    closeModal('financeClientModal');
    financeQueueSave();
    financeRenderEditor();
    showNotification('success', 'Client saved');
  } catch (error) {
    showNotification('error', error.message || 'Failed to save client');
  }
}

function financeSgd(value) {
  return `$${Math.abs(financeNumber(value)).toLocaleString('en-SG', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
}

function financeSignedSgd(value) {
  const amount = financeNumber(value);
  return `${amount < 0 ? '- ' : ''}${financeSgd(amount)}`;
}

function financePercentDisplay(value) {
  return `${financeNumber(value).toLocaleString('en-SG', {
    minimumFractionDigits: Number(value) % 1 ? 1 : 0,
    maximumFractionDigits: 1
  })}%`;
}

function profitLossEventChooserEvents() {
  return profitLossState.events || [];
}

function profitLossCurrentEventId() {
  return profitLossState.eventId;
}

async function financeLoadProgressiveEvents(targetState, preferredEventId, chooserContext) {
  const update = loaded => {
    targetState.events = (loaded || [])
      .slice()
      .sort((a, b) => Number(b.id || 0) - Number(a.id || 0));
    if (
      typeof planEventChooserState !== 'undefined' &&
      planEventChooserState.context === chooserContext &&
      document.getElementById('planEventChooserModal')?.classList.contains('active')
    ) renderPlanEventChooser();
  };
  const eventOptionsLoad = await startProgressiveEventOptions(preferredEventId, update);
  update(eventOptionsLoad.first);
  eventOptionsLoad.completion.then(update).catch(error => {
    console.warn('Unable to finish loading event options:', error);
  });
}

async function loadProfitLoss(options = {}) {
  ensureFinanceSections();
  const root = profitLossRoot();
  if (!root || profitLossState.loading) return;
  profitLossState.loading = true;
  if (!options.preserve) root.innerHTML = '<div class="loading">Loading Profit & Loss...</div>';
  try {
    if (!profitLossState.eventId && typeof workflowRememberedEventId === 'function') {
      profitLossState.eventId = workflowRememberedEventId();
    }
    await financeLoadProgressiveEvents(
      profitLossState,
      profitLossState.eventId,
      'profit-loss'
    );
    if (!profitLossState.events.some(event => Number(event.id) === Number(profitLossState.eventId))) {
      profitLossState.eventId = Number(profitLossState.events[0]?.id || 0);
      profitLossState.data = null;
    }
    if (!profitLossState.eventId) {
      root.innerHTML = '<div class="finance-empty">Create an event before reviewing Profit & Loss.</div>';
      return;
    }
    await selectProfitLossEvent(profitLossState.eventId, { renderLoading: false });
  } catch (error) {
    root.innerHTML = `<div class="finance-empty">Could not load Profit & Loss.<br>${financeEscape(error.message || String(error))}</div>`;
  } finally {
    profitLossState.loading = false;
  }
}

async function selectProfitLossEvent(eventId, options = {}) {
  const id = Number(eventId || 0);
  if (!id) return;
  profitLossState.eventId = id;
  if (options.remember !== false && typeof workflowRememberEvent === 'function') {
    workflowRememberEvent(id);
  }
  const root = profitLossRoot();
  if (options.renderLoading !== false && root) {
    root.innerHTML = '<div class="loading">Loading event Profit & Loss...</div>';
  }
  try {
    const response = await apiCall(`/api/finance/profit-loss/${id}`);
    profitLossState.data = response.data;
    renderProfitLossPage();
  } catch (error) {
    if (root) root.innerHTML = `<div class="finance-empty">Could not load Profit & Loss.<br>${financeEscape(error.message || String(error))}</div>`;
  }
}

async function refreshProfitLossForRealtime(eventId) {
  if (Number(profitLossState.eventId) !== Number(eventId)) return;
  await selectProfitLossEvent(eventId, { renderLoading: false, remember: false });
}

function profitLossOpenQuotation(quotationId) {
  if (!quotationId) return;
  showSection('quotations');
  setTimeout(() => financeOpenDocument(quotationId), 0);
}

function financeEnsureProfitLossRevenueModal() {
  if (document.getElementById('profitLossRevenueModal')) return;
  const modal = document.createElement('div');
  modal.id = 'profitLossRevenueModal';
  modal.className = 'modal';
  modal.innerHTML = `
    <div class="modal-content finance-picker-modal pnl-revenue-modal">
      <div class="modal-header">
        <div><h3 class="modal-title">Set event revenue</h3><p>Pair one of your quotations or enter the agreed revenue manually.</p></div>
        <button type="button" class="close-btn" onclick="closeModal('profitLossRevenueModal')">&times;</button>
      </div>
      <section class="pnl-revenue-option">
        <div class="pnl-revenue-option-heading">
          <div><strong>Select quotation</strong><span>The quotation total will become the event revenue.</span></div>
          <input id="profitLossRevenueSearch" class="finance-input" type="search" placeholder="Search quotations..." autocomplete="off" oninput="profitLossRenderRevenueQuotations(this.value)">
        </div>
        <div id="profitLossRevenueQuotationResults" class="finance-picker-results pnl-revenue-results"></div>
      </section>
      <div class="pnl-revenue-divider"><span>or</span></div>
      <form class="pnl-revenue-option" onsubmit="profitLossSaveManualRevenue(event)">
        <div class="pnl-revenue-option-heading">
          <div><strong>Enter revenue manually</strong><span>This amount is saved specifically to the selected event.</span></div>
        </div>
        <label class="finance-field pnl-manual-revenue-field">
          <span>Revenue amount</span>
          <span class="finance-money-input"><span>$</span><input id="profitLossManualRevenue" class="finance-input" inputmode="decimal" placeholder="0.00" onblur="if(this.value) financeFormatMoneyInput(this)" required></span>
        </label>
        <div id="profitLossRevenueError" class="wf-error"></div>
        <div class="modal-actions finance-picker-actions">
          <button type="button" class="btn btn-secondary" onclick="closeModal('profitLossRevenueModal')">Cancel</button>
          <button type="submit" class="btn btn-primary">Save amount</button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(modal);
}

function profitLossRevenueQuotationRows(query = '') {
  const clean = String(query || '').trim().toLowerCase();
  return (profitLossState.data?.availableQuotations || []).filter(row => {
    if (!clean) return true;
    const client = row.client || {};
    return [row.number, row.projectName, row.status, client.name, client.company]
      .some(value => String(value || '').toLowerCase().includes(clean));
  });
}

function profitLossRenderRevenueQuotations(query = '') {
  const results = document.getElementById('profitLossRevenueQuotationResults');
  if (!results) return;
  const rows = profitLossRevenueQuotationRows(query);
  results.innerHTML = rows.map(row => {
    const client = row.client || {};
    const details = [row.projectName, client.company || client.name, row.status]
      .filter(Boolean)
      .join(' | ');
    return `
      <button type="button" class="finance-picker-option pnl-revenue-quotation" onclick="profitLossPairRevenueQuotation('${financeEscapeAttr(row.id)}')">
        <span><strong>${financeEscape(row.number || 'Untitled quotation')}</strong>${details ? `<small>${financeEscape(details)}</small>` : ''}</span>
        <b>${financeEscape(financeSgd(row.amount))}</b>
      </button>
    `;
  }).join('') || '<div class="finance-suggestion-empty">No available quotations match this search.</div>';
}

function profitLossOpenRevenueModal() {
  financeEnsureProfitLossRevenueModal();
  const search = document.getElementById('profitLossRevenueSearch');
  const amount = document.getElementById('profitLossManualRevenue');
  const error = document.getElementById('profitLossRevenueError');
  if (search) search.value = '';
  if (amount) {
    const currentAmount = profitLossState.data?.manualRevenue?.amount;
    amount.value = currentAmount == null ? '' : financeMoneyInputValue(currentAmount);
  }
  if (error) error.textContent = '';
  profitLossRenderRevenueQuotations('');
  openModal('profitLossRevenueModal');
  setTimeout(() => (profitLossRevenueQuotationRows().length ? search : amount)?.focus(), 50);
}

async function profitLossPairRevenueQuotation(quotationId) {
  if (!profitLossState.eventId || !quotationId) return;
  const error = document.getElementById('profitLossRevenueError');
  if (error) error.textContent = '';
  try {
    const response = await apiCall(
      `/api/finance/profit-loss/${profitLossState.eventId}/revenue`,
      'PUT',
      { quotationId }
    );
    profitLossState.data = response.data;
    closeModal('profitLossRevenueModal');
    renderProfitLossPage();
    showNotification('success', 'Quotation paired to event');
  } catch (requestError) {
    if (error) error.textContent = requestError.message || 'Unable to pair quotation';
  }
}

async function profitLossSaveManualRevenue(event) {
  event.preventDefault();
  if (!profitLossState.eventId) return;
  const error = document.getElementById('profitLossRevenueError');
  const amount = document.getElementById('profitLossManualRevenue')?.value || '';
  if (error) error.textContent = '';
  try {
    const response = await apiCall(
      `/api/finance/profit-loss/${profitLossState.eventId}/revenue`,
      'PUT',
      { manualAmount: financeCurrencyNumber(amount) }
    );
    profitLossState.data = response.data;
    closeModal('profitLossRevenueModal');
    renderProfitLossPage();
    showNotification('success', 'Manual event revenue saved');
  } catch (requestError) {
    if (error) error.textContent = requestError.message || 'Unable to save revenue';
  }
}

function profitLossOpenManpower(eventId, focus = '') {
  if (typeof openEventWorkforce === 'function') {
    openEventWorkforce(eventId, focus);
  }
}

function profitLossAttachmentPreviewKind(attachment) {
  const contentType = String(attachment?.contentType || '').toLowerCase();
  const filename = String(attachment?.originalName || '').toLowerCase();
  if (contentType.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg)$/.test(filename)) return 'image';
  if (contentType.startsWith('video/') || /\.(mp4|webm|mov|m4v)$/.test(filename)) return 'video';
  if (contentType.startsWith('audio/') || /\.(mp3|wav|m4a|ogg)$/.test(filename)) return 'audio';
  if (contentType === 'application/pdf' || filename.endsWith('.pdf')) return 'pdf';
  if (contentType.startsWith('text/') || /\.(txt|csv|log)$/.test(filename)) return 'text';
  return '';
}

function profitLossPreviewAttachment(expenseId) {
  const expense = (profitLossState.data?.expenses || [])
    .find(row => String(row.id) === String(expenseId));
  const attachment = expense?.attachment;
  if (!attachment || typeof previewEventFile !== 'function') {
    showNotification('error', 'This attachment cannot be previewed');
    return;
  }
  previewEventFile(
    Number(profitLossState.data?.event?.id) || 0,
    attachment.originalName || 'Attachment',
    attachment.previewUrl || '',
    profitLossAttachmentPreviewKind(attachment),
    attachment.downloadUrl || attachment.previewUrl || ''
  );
}

function profitLossDepartmentMeta(value) {
  const department = String(value || '').trim();
  if (!department || department.toLowerCase() === 'unallocated') return null;
  const normalized = typeof normalizeDepartmentCode === 'function'
    ? normalizeDepartmentCode(department)
    : department.toUpperCase();
  const rows = Object.values(
    typeof departments === 'object' && departments ? departments : {}
  );
  const matched = rows.find(row => (
    String(row?.code || '').toLowerCase() === department.toLowerCase()
    || String(row?.name || '').toLowerCase() === department.toLowerCase()
  ));
  if (matched) return matched;
  return typeof getDepartmentMeta === 'function'
    ? getDepartmentMeta(normalized)
    : { code: normalized, name: normalized, color: '#e2e8f0', textColor: '#334155' };
}

function profitLossSolidColour(value) {
  const hex = String(value || '').trim();
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return '#2563eb';
  const channels = [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16) / 255);
  const [red, green, blue] = channels;
  const maximum = Math.max(...channels);
  const minimum = Math.min(...channels);
  const delta = maximum - minimum;
  let hue = 0;
  if (delta) {
    if (maximum === red) hue = ((green - blue) / delta) % 6;
    else if (maximum === green) hue = (blue - red) / delta + 2;
    else hue = (red - green) / delta + 4;
    hue = ((hue * 60) + 360) % 360;
  }
  let lightness = (maximum + minimum) / 2;
  let saturation = delta
    ? delta / (1 - Math.abs(2 * lightness - 1))
    : 0;
  if (saturation < 0.08) {
    lightness = Math.min(Math.max(lightness, 0.34), 0.5);
  } else {
    saturation = Math.max(saturation, 0.68);
    lightness = Math.min(Math.max(lightness, 0.4), 0.52);
  }

  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const secondary = chroma * (1 - Math.abs((hue / 60) % 2 - 1));
  const offset = lightness - chroma / 2;
  let rgb = [0, 0, 0];
  if (hue < 60) rgb = [chroma, secondary, 0];
  else if (hue < 120) rgb = [secondary, chroma, 0];
  else if (hue < 180) rgb = [0, chroma, secondary];
  else if (hue < 240) rgb = [0, secondary, chroma];
  else if (hue < 300) rgb = [secondary, 0, chroma];
  else rgb = [chroma, 0, secondary];
  return `#${rgb.map(channel => (
    Math.round((channel + offset) * 255).toString(16).padStart(2, '0')
  )).join('')}`;
}

function profitLossContrastColour(value) {
  const hex = String(value || '').replace('#', '');
  if (!/^[0-9a-f]{6}$/i.test(hex)) return '#ffffff';
  const [red, green, blue] = [0, 2, 4].map(index => parseInt(hex.slice(index, index + 2), 16));
  const luminance = (red * 299 + green * 587 + blue * 114) / 255000;
  return luminance > 0.58 ? '#172033' : '#ffffff';
}

function profitLossExpenseChartSegments(expense, chartSegments = []) {
  const source = String(expense?.source || 'manual');
  const categoryKey = String(expense?.categoryKey || '');
  const categoryLabel = String(
    expense?.categoryLabel || expense?.category || 'Other'
  ).trim();
  let group = 'other';
  let label = categoryLabel;

  if (categoryKey === 'vendor-service') {
    group = 'vendor';
    label = '';
  } else if (source === 'transport-invoice') {
    group = 'transport';
    label = '';
  } else if (source === 'worker-invoice') {
    group = 'manpower';
    label = '';
  } else if (categoryKey === 'meal') {
    group = 'meal';
    label = '';
  } else if (categoryKey === 'crew-transport') {
    group = 'crew-transport';
    label = '';
  } else if (categoryKey === 'equipment-transport') {
    group = 'equipment-transport';
    label = '';
  } else if (categoryKey === 'transport') {
    group = 'transport';
    label = '';
  }

  let matches = chartSegments.filter(row => String(row?.group || 'other') === group);
  if (label) {
    matches = matches.filter(row => (
      String(row?.label || '').trim().toLowerCase() === label.toLowerCase()
    ));
  }
  if (group === 'manpower' || group === 'vendor') {
    const departments = String(expense?.department || '')
      .split(',')
      .map(value => value.trim().toLowerCase())
      .filter(Boolean);
    if (departments.length) {
      matches = matches.filter(row => departments.includes(
        String(row?.department || '').trim().toLowerCase()
      ));
    }
  }
  return matches;
}

function profitLossExpenseChartBands(expense, chartSegments = []) {
  const matches = profitLossExpenseChartSegments(expense, chartSegments)
    .filter(row => /^#[0-9a-f]{6}$/i.test(String(row?.colour || '')));
  const allocations = new Map();
  (Array.isArray(expense?.departmentAllocations) ? expense.departmentAllocations : [])
    .forEach(row => {
      const department = String(row?.department || '').trim().toLowerCase();
      const amount = Math.max(0, financeNumber(row?.amount));
      if (!department || amount <= 0) return;
      allocations.set(department, (allocations.get(department) || 0) + amount);
    });
  const weighted = matches.map(row => ({
    colour: String(row.colour),
    amount: allocations.get(String(row?.department || '').trim().toLowerCase()) || 0,
  })).filter(row => row.amount > 0);
  if (weighted.length && weighted.reduce((sum, row) => sum + row.amount, 0) > 0) {
    return weighted;
  }
  return matches.map(row => ({ colour: String(row.colour), amount: 1 }));
}

function profitLossExpenseCategoryBackground(bands) {
  const rows = (Array.isArray(bands) ? bands : []).filter(row => (
    /^#[0-9a-f]{6}$/i.test(String(row?.colour || '')) && financeNumber(row?.amount) > 0
  ));
  if (!rows.length) return '';
  if (rows.length === 1) return rows[0].colour;
  const total = rows.reduce((sum, row) => sum + financeNumber(row.amount), 0);
  let offset = 0;
  const stops = rows.map(row => {
    const start = offset;
    offset += financeNumber(row.amount) / total * 100;
    const end = offset;
    return `${row.colour} ${Number(start.toFixed(4))}%, ${row.colour} ${Number(end.toFixed(4))}%`;
  });
  return `linear-gradient(90deg, ${stops.join(', ')})`;
}

function profitLossHighlightExpenseSlices(badge, active) {
  const chart = badge?.closest('.content-section')?.querySelector('.pnl-profit-chart')
    || document.querySelector('#profit-loss-section .pnl-profit-chart');
  if (!chart) return;
  const keys = new Set(
    String(badge?.dataset?.pnlChartKeys || '').split(' ').filter(Boolean)
  );
  const keepActive = Boolean(active || badge?.matches(':hover, :focus-visible')) && keys.size > 0;
  chart.classList.toggle('has-badge-highlight', keepActive);
  chart.querySelectorAll('.pnl-chart-segment').forEach(segment => {
    const isMatch = keepActive && keys.has(String(segment.dataset.chartKey || ''));
    segment.classList.toggle('is-badge-highlight', isMatch);
    segment.classList.toggle('is-badge-muted', keepActive && !isMatch);
  });
}

function profitLossExpenseCategoryMarkup(expense, chartSegments = []) {
  const source = String(expense?.source || 'manual');
  const categoryKey = String(expense?.categoryKey || '');
  let category = String(expense?.categoryLabel || expense?.category || 'Other expense');
  if (categoryKey === 'vendor-service') {
    category = 'Service';
  } else if (source === 'worker-invoice') {
    category = 'Manpower';
  } else if (categoryKey === 'meal') {
    category = 'Meal';
  } else if (categoryKey === 'crew-transport') {
    category = 'Crew Transport';
  } else if (categoryKey === 'equipment-transport') {
    category = 'Equipment Transport';
  } else if (categoryKey === 'transport') {
    category = 'Transport';
  } else if (categoryKey === 'purchase') {
    category = 'Purchase';
  }

  const department = String(expense?.department || '').trim();
  const departmentMeta = profitLossDepartmentMeta(department);
  const departmentCode = String(departmentMeta?.code || '');
  const matchingChartSegments = profitLossExpenseChartSegments(expense, chartSegments);
  const chartBands = profitLossExpenseChartBands(expense, matchingChartSegments);
  const chartColours = chartBands.map(row => row.colour);
  const chartKeys = [...new Set(matchingChartSegments.map(row => String(row?.key || '')).filter(Boolean))];
  const categoryColour = chartColours[0] || '';
  const categoryBackground = profitLossExpenseCategoryBackground(chartBands);

  const suffix = department && source !== 'transport-invoice'
    ? ` - ${departmentCode || department}`
    : '';
  const title = departmentMeta
    ? departmentMeta.name || departmentCode
    : department;
  const style = categoryColour
    ? ` style="--pnl-category-colour:${categoryColour};--pnl-category-background:${categoryBackground};--pnl-category-text:${profitLossContrastColour(categoryColour)}"`
    : '';
  const chartInteraction = chartKeys.length
    ? ` tabindex="0" data-pnl-chart-keys="${financeEscapeAttr(chartKeys.join(' '))}" onpointerenter="profitLossHighlightExpenseSlices(this, true)" onpointerleave="profitLossHighlightExpenseSlices(this, false)" onfocus="profitLossHighlightExpenseSlices(this, true)" onblur="profitLossHighlightExpenseSlices(this, false)"`
    : '';
  return `<span class="pnl-category-badge"${style}${chartInteraction}${title ? ` title="${financeEscapeAttr(title)}"` : ''}>${financeEscape(`${category}${suffix}`)}</span>`;
}

function profitLossExpenseSourceRank(expense) {
  return ({
    manual: 0,
    'worker-claim': 1,
    'worker-invoice': 2,
    'transport-invoice': 3,
    'transport-claim': 4
  })[String(expense?.source || 'manual').trim().toLowerCase()] ?? 3;
}

function profitLossCompareExpenses(left, right) {
  const sourceDifference = profitLossExpenseSourceRank(left) - profitLossExpenseSourceRank(right);
  if (sourceDifference) return sourceDifference;
  const compareText = (leftValue, rightValue) => String(leftValue || '').localeCompare(
    String(rightValue || ''),
    undefined,
    { sensitivity: 'base', numeric: true }
  );
  return compareText(left?.department, right?.department)
    || compareText(left?.vendor || left?.description, right?.vendor || right?.description)
    || compareText(left?.description, right?.description)
    || compareText(left?.id, right?.id);
}

function profitLossExpenseProcessingMarkup(expense) {
  const state = String(expense?.processingState || '').trim().toLowerCase();
  if (state === 'queued') {
    return `<span class="pnl-submission-status upload-status"><em class="status-badge status-queued">Queued</em>
      <span class="upload-progress-track processing"><span></span></span><small>Waiting</small></span>`;
  }
  if (state === 'processing') {
    return `<span class="pnl-submission-status upload-status"><em class="status-badge status-processing">Processing</em>
      <span class="upload-progress-track processing"><span></span></span><small>Analysing</small></span>`;
  }
  const source = String(expense?.source || 'manual');
  const isSubmission = ['worker-claim', 'worker-invoice', 'transport-invoice', 'transport-claim'].includes(source);
  const status = expense?.paymentConfirmedAt
    ? 'Payment Confirmed'
    : String(expense?.status || '').trim();
  const stage = String(expense?.submissionStage || '').trim();
  const displayStatus = status === 'Denied'
    ? 'Denied'
    : (stage === 'Details Required'
      ? 'Details Required'
      : (status || (expense?.needsReview ? 'Needs Review' : '')));
  if (!displayStatus || (!isSubmission && !expense?.needsReview)) return '';
  const action = ['worker-claim', 'worker-invoice', 'transport-invoice', 'transport-claim'].includes(expense.source)
    ? `profitLossOpenClaimReview('${financeEscapeAttr(expense.sourceId)}')`
    : `profitLossOpenExpenseModal('${financeEscapeAttr(expense.id)}')`;
  const classStatus = displayStatus === 'Needs Review' ? 'Pending Review' : displayStatus;
  const statusClass = `status-${classStatus.toLowerCase().replace(/\s+/g, '-')}`;
  if (expense?.needsReview) {
    return `<button type="button" class="pnl-review-pill status-badge ${financeEscapeAttr(statusClass)}" onclick="${action}">${financeEscape(displayStatus)}</button>`;
  }
  return `<span class="pnl-submission-status"><em class="status-badge ${financeEscapeAttr(statusClass)}">${financeEscape(displayStatus)}</em></span>`;
}

function profitLossOpenClaimReview(submissionId) {
  if (!submissionId) return;
  if (typeof openEventWorkforceReview === 'function') {
    openEventWorkforceReview(profitLossState.eventId, submissionId);
    return;
  }
  profitLossOpenManpower(profitLossState.eventId, 'claims');
}

function profitLossPendingExpenseUploads(eventId = profitLossState.eventId) {
  return [...profitLossExpenseUploadState.rows.values()].filter(row => (
    Number(row.eventId) === Number(eventId)
  ));
}

function profitLossUploadStateLabel(row) {
  return {
    queued: 'Queued',
    uploading: 'Uploading',
    queueing: 'Queueing',
    failed: 'Failed'
  }[row.status] || 'Queued';
}

function profitLossUploadDetailLabel(row) {
  return {
    queued: 'Waiting',
    uploading: `${Math.round(Number(row.progress || 0))}%`,
    queueing: 'Queueing',
    failed: row.error || 'Upload failed'
  }[row.status] || 'Waiting';
}

function profitLossPendingExpenseStatusMarkup(row) {
  const status = String(row.status || 'queued');
  const progress = status === 'queueing'
    ? 100
    : Math.max(0, Math.min(100, Number(row.progress || 0)));
  const processing = status === 'queued';
  const failed = status === 'failed';
  return `<span class="pnl-submission-status upload-status">
    <em class="status-badge status-${financeEscapeAttr(status)}" data-pnl-upload-state
      ${row.error ? `title="${financeEscapeAttr(row.error)}"` : ''}>${financeEscape(profitLossUploadStateLabel(row))}</em>
    <span class="upload-progress-track ${processing ? 'processing' : ''}" data-pnl-upload-track ${failed ? 'hidden' : ''}>
      <span data-pnl-upload-progress${processing ? '' : ` style="width:${progress}%"`}></span>
    </span>
    <small data-pnl-upload-label>${financeEscape(profitLossUploadDetailLabel(row))}</small>
  </span>`;
}

function profitLossPendingExpenseRowsMarkup() {
  return profitLossPendingExpenseUploads().map(row => `
    <tr class="pnl-upload-row" data-pnl-upload-id="${financeEscapeAttr(row.id)}">
      <td><strong>${financeEscape(row.name)}</strong></td>
      <td><span class="pnl-source-pill pnl-source-manual">Uploading</span></td>
      <td>Pending extraction</td><td>-</td><td>-</td><td>-</td>
      <td>${profitLossPendingExpenseStatusMarkup(row)}</td>
      <td>${row.status === 'failed' ? `<button type="button" class="finance-delete-line" onclick="profitLossDismissExpenseUpload('${financeEscapeAttr(row.id)}')" aria-label="Dismiss failed upload">&times;</button>` : ''}</td>
    </tr>
  `).join('');
}

function profitLossUpdateExpenseUploadRow(uploadId) {
  const row = profitLossExpenseUploadState.rows.get(uploadId);
  const element = document.querySelector(`[data-pnl-upload-id="${CSS.escape(uploadId)}"]`);
  if (!row || !element) return;
  const progress = Math.max(0, Math.min(100, Number(row.progress || 0)));
  const label = profitLossUploadStateLabel(row);
  const detail = profitLossUploadDetailLabel(row);
  const bar = element.querySelector('[data-pnl-upload-progress]');
  const track = element.querySelector('[data-pnl-upload-track]');
  const progressLabel = element.querySelector('[data-pnl-upload-label]');
  const state = element.querySelector('[data-pnl-upload-state]');
  if (bar) {
    if (row.status === 'queued') bar.style.removeProperty('width');
    else bar.style.width = `${row.status === 'queueing' ? 100 : progress}%`;
  }
  if (track) {
    track.hidden = row.status === 'failed';
    track.classList.toggle('processing', row.status === 'queued');
  }
  if (progressLabel) progressLabel.textContent = detail;
  if (state) {
    state.className = `status-badge status-${row.status}`;
    state.textContent = label;
    if (row.error) state.title = row.error;
  }
}

function profitLossDismissExpenseUpload(uploadId) {
  profitLossExpenseUploadState.rows.delete(uploadId);
  document.querySelector(`[data-pnl-upload-id="${CSS.escape(uploadId)}"]`)?.remove();
}

function profitLossChartColour(group, index, row = {}) {
  const departmentMeta = group === 'manpower'
    ? profitLossDepartmentMeta(row.department)
    : null;
  if (departmentMeta?.color && /^#[0-9a-f]{6}$/i.test(departmentMeta.color)) {
    return profitLossSolidColour(departmentMeta.color);
  }
  const palettes = {
    manpower: ['#2563eb', '#0ea5e9', '#06b6d4', '#6366f1', '#0284c7'],
    vendor: ['#0f766e', '#14b8a6', '#0d9488', '#115e59'],
    meal: ['#ec4899'],
    'crew-transport': ['#14b8a6'],
    'equipment-transport': ['#d97706'],
    transport: ['#f59e0b'],
    other: ['#64748b', '#ef4444', '#14b8a6', '#ec4899', '#84cc16'],
    commission: ['#8b5cf6'],
    profit: ['#10b981']
  };
  const palette = palettes[group] || palettes.other;
  return palette[index % palette.length];
}

function profitLossChartRows(rows) {
  const groupIndexes = {};
  const visible = (Array.isArray(rows) ? rows : [])
    .map(row => ({ ...row, amount: Math.max(0, financeNumber(row.amount)) }))
    .filter(row => row.amount > 0);
  const total = visible.reduce((sum, row) => sum + row.amount, 0);
  let offset = 0;
  return visible.map(row => {
    const group = row.group || 'other';
    const colourIndex = groupIndexes[group] || 0;
    groupIndexes[group] = colourIndex + 1;
    const percent = total ? row.amount / total * 100 : 0;
    const result = {
      ...row,
      colour: profitLossChartColour(group, colourIndex, row),
      percent,
      offset
    };
    offset += percent;
    return result;
  });
}

function profitLossPositionChartTooltip(event, segment) {
  const visual = segment?.closest('.pnl-chart-visual');
  const tooltip = visual?.querySelector('.pnl-chart-tooltip');
  if (!visual || !tooltip) return;
  const visualRect = showbaseViewport.rect(visual.getBoundingClientRect());
  const segmentRect = showbaseViewport.rect(segment.getBoundingClientRect());
  const clientX = Number.isFinite(event?.clientX) && event.clientX
    ? showbaseViewport.toLayout(event.clientX)
    : segmentRect.left + segmentRect.width / 2;
  const clientY = Number.isFinite(event?.clientY) && event.clientY
    ? showbaseViewport.toLayout(event.clientY)
    : segmentRect.top + segmentRect.height / 2;
  const x = Math.min(Math.max(clientX - visualRect.left, 18), visualRect.width - 18);
  const y = Math.min(Math.max(clientY - visualRect.top, 18), visualRect.height - 18);
  tooltip.style.left = `${x}px`;
  tooltip.style.top = `${y}px`;
  tooltip.classList.toggle('is-below', y < 72);
}

function profitLossShowChartTooltip(event, segment) {
  const tooltip = segment?.closest('.pnl-chart-visual')?.querySelector('.pnl-chart-tooltip');
  if (!tooltip) return;
  const label = tooltip.querySelector('strong');
  const detail = tooltip.querySelector('span');
  if (label) label.textContent = segment.dataset.label || '';
  if (detail) {
    detail.textContent = `${segment.dataset.amount || '$0.00'} | ${segment.dataset.percent || '0%'}`;
  }
  tooltip.style.setProperty('--tooltip-colour', segment.dataset.colour || '#334155');
  profitLossPositionChartTooltip(event, segment);
  tooltip.classList.add('is-visible');
}

function profitLossHideChartTooltip(segment) {
  const tooltip = segment?.closest('.pnl-chart-visual')?.querySelector('.pnl-chart-tooltip');
  if (tooltip) tooltip.classList.remove('is-visible', 'is-below');
}

function profitLossChartMarkup(rows, summary, rowsAreSegments = false) {
  const segments = rowsAreSegments ? rows : profitLossChartRows(rows);
  if (!segments.length) {
    return '<div class="pnl-chart-empty">No costs or profit to chart yet.</div>';
  }
  return `
    <div class="pnl-profit-chart">
      <div class="pnl-chart-visual">
        <svg class="pnl-chart-svg" viewBox="0 0 120 120" role="img" aria-label="Profit and loss breakdown">
          <circle class="pnl-chart-track" cx="60" cy="60" r="46" pathLength="100"></circle>
          ${segments.map(row => `
            <circle class="pnl-chart-segment" cx="60" cy="60" r="46" pathLength="100"
              style="--segment-colour:${row.colour}"
              stroke-dasharray="${row.percent} ${100 - row.percent}"
              stroke-dashoffset="${-row.offset}"
              data-label="${financeEscapeAttr(row.label)}"
              data-amount="${financeEscapeAttr(financeSgd(row.amount))}"
              data-percent="${financeEscapeAttr(financePercentDisplay(row.percent))}"
              data-colour="${row.colour}"
              data-chart-key="${financeEscapeAttr(row.key || '')}"
              aria-label="${financeEscapeAttr(`${row.label}: ${financeSgd(row.amount)}, ${financePercentDisplay(row.percent)}`)}"
              onpointerenter="profitLossShowChartTooltip(event, this)"
              onpointermove="profitLossPositionChartTooltip(event, this)"
              onpointerleave="profitLossHideChartTooltip(this)"
              onfocus="profitLossShowChartTooltip(event, this)"
              onblur="profitLossHideChartTooltip(this)"
              tabindex="0">
            </circle>
          `).join('')}
        </svg>
        <div class="pnl-chart-tooltip" role="status" aria-live="polite">
          <i aria-hidden="true"></i>
          <div>
            <strong></strong>
            <span></span>
          </div>
        </div>
        <div class="pnl-chart-centre">
          <span>Net Profit</span>
          <strong>${financeSignedSgd(summary.netProfit)}</strong>
          <small>${financePercentDisplay(summary.profitMargin)}</small>
        </div>
      </div>
      <div class="pnl-legend pnl-profit-legend">
        ${segments.map(row => `
          <span>
            <i class="pnl-dot" style="background:${row.colour}"></i>
            <b>${financeEscape(row.label)}</b>
            <em>${financeSgd(row.amount)} · ${financePercentDisplay(row.percent)}</em>
          </span>
        `).join('')}
      </div>
    </div>
  `;
}

function profitLossBudgetNote(summary, kind, hasQuotation) {
  if (!hasQuotation) return '';
  const budget = financeNumber(summary[`${kind}Budget`]);
  const variance = financeNumber(summary[`${kind}BudgetVariance`]);
  const isOver = variance < 0;
  return {
    label: `Budget ${financeSgd(budget)}`,
    text: `${financeSgd(Math.abs(variance))} ${isOver ? 'over' : variance ? 'under' : 'on target'}`,
    className: `pnl-budget-variance ${isOver ? 'is-over' : 'is-under'}`,
  };
}

function profitLossKpi(title, value, note, extraClass = '', action = '') {
  const tag = action ? 'button' : 'article';
  const attrs = action ? `type="button" onclick="${action}"` : '';
  const noteObject = note && typeof note === 'object' ? note : null;
  const noteText = noteObject ? noteObject.text : note;
  const noteLabel = noteObject ? noteObject.label : '';
  const noteClass = noteObject ? noteObject.className : '';
  const noteTitle = noteObject ? noteObject.title : '';
  return `
    <${tag} class="pnl-kpi ${extraClass}" ${attrs}>
      <span>${financeEscape(title)}</span>
      <strong>${financeEscape(value)}</strong>
      ${noteText ? (
        noteObject
          ? `<small class="pnl-budget-note"${noteTitle ? ` title="${financeEscapeAttr(noteTitle)}"` : ''}><span>${financeEscape(noteLabel)}</span><b class="${financeEscapeAttr(noteClass)}">${financeEscape(noteText)}</b></small>`
          : `<small>${financeEscape(noteText)}</small>`
      ) : ''}
    </${tag}>
  `;
}

function profitLossOtherExpenseNote(categories) {
  const parts = (Array.isArray(categories) ? categories : [])
    .filter(row => financeNumber(row?.amount) > 0 && String(row?.label || '').trim())
    .map(row => `${String(row.label).trim()} ${financeSgd(row.amount)}`);
  return parts.join(' · ') || 'No other expenses';
}

function profitLossRenderCensored(root, data) {
  const event = data.event || {};
  const selectedEvent = profitLossState.events.find(
    row => Number(row.id) === Number(event.id)
  ) || event;
  root.innerHTML = `
    <div class="pnl-heading">
      <div>
        <h2>Profit &amp; Loss</h2>
        <p class="finance-subtitle">Financial details for this event are restricted.</p>
      </div>
    </div>
    <div class="plan-event-bar pnl-event-bar">
      <button type="button" class="plan-event-select-wrap"
              aria-haspopup="dialog" aria-label="Choose a Profit and Loss event"
              onclick="planOpenEventChooser('profit-loss')">
        <div class="plan-event-icon" aria-hidden="true">${typeof planMetricIconSvg === 'function' ? planMetricIconSvg('calendar') : ''}</div>
        <div style="min-width:0;flex:1;">
          <div class="plan-event-title-row">
            <span class="plan-event-id">#${financeEscape(String(event.id || ''))}</span>
            <span class="plan-event-name">${financeEscape(event.name || selectedEvent.name || 'Untitled event')}</span>
            ${typeof planEventTypeBadgeHtml === 'function' ? planEventTypeBadgeHtml(selectedEvent) : ''}
          </div>
          <div class="plan-event-meta">
            <span>${financeEscape([event.startDate, event.endDate].filter(Boolean).join(' - '))}</span>
            ${event.location ? `<span aria-hidden="true">-</span><span>${financeEscape(event.location)}</span>` : ''}
            ${event.state && typeof planEventStateBadgeHtml === 'function' ? planEventStateBadgeHtml(event) : ''}
          </div>
        </div>
        <span class="plan-event-picker-chevron" aria-hidden="true">⌄</span>
      </button>
    </div>
    <section class="finance-card pnl-censored">
      <div class="pnl-censored-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24"><rect x="5" y="10" width="14" height="10" rx="2"></rect><path d="M8 10V7a4 4 0 0 1 8 0v3"></path></svg>
      </div>
      <div>
        <h3>Financial information hidden</h3>
        <p>${financeEscape(data.permissions?.reason || 'You do not have access to this event’s financial details.')}</p>
      </div>
    </section>
    <div class="pnl-kpis pnl-kpis-censored" aria-label="Restricted financial summary">
      ${['Revenue', 'Manpower Cost', 'Transport Cost', 'Other Expenses', 'Commission', 'Net Profit', 'Profit Margin']
        .map(label => profitLossKpi(label, 'Restricted', ''))
        .join('')}
    </div>
  `;
}

function profitLossExportPdf(button) {
  const eventId = Number(profitLossState.eventId || profitLossState.data?.event?.id || 0);
  if (!eventId) {
    showNotification('error', 'Select an event before exporting Profit & Loss');
    return;
  }
  const original = button?.innerHTML || '';
  if (button) {
    button.disabled = true;
    button.classList.add('is-loading');
    button.innerHTML = '<span class="finance-button-spinner" aria-hidden="true"></span>Preparing PDF';
  }
  const opened = window.open(
    `/api/finance/profit-loss/${encodeURIComponent(eventId)}/pdf?v=${encodeURIComponent(Date.now())}`,
    '_blank',
    'noopener'
  );
  if (!opened) showNotification('warning', 'Please allow pop-ups to preview the PDF');
  window.setTimeout(() => {
    if (!button) return;
    button.disabled = false;
    button.classList.remove('is-loading');
    button.innerHTML = original;
  }, 900);
}

function renderProfitLossPage() {
  const root = profitLossRoot();
  const data = profitLossState.data;
  if (!root || !data) return;
  if (data.censored || data.permissions?.isCensored) {
    profitLossRenderCensored(root, data);
    return;
  }
  const event = data.event || {};
  const quote = data.quotation || null;
  const summary = data.summary || {};
  const expenses = (data.expenses || []).slice().sort(profitLossCompareExpenses);
  const profitChartSegments = profitLossChartRows(data.profitChart || []);
  const pendingExpenseRows = profitLossPendingExpenseRowsMarkup();
  const listedExpenseTotal = expenses.reduce((sum, row) => sum + financeNumber(row.amount), 0);
  const selectedEvent = profitLossState.events.find(row => Number(row.id) === Number(event.id)) || event;
  const activity = data.activity || [];
  const transportNoteParts = [
    financeNumber(summary.transportBookingCost) > 0 ? `Bookings ${financeSgd(summary.transportBookingCost)}` : ''
  ].filter(Boolean);
  const manpowerInvoiceCost = financeNumber(summary.manpowerInvoiceCost);
  const manpowerFallbackEstimate = financeNumber(
    summary.manpowerFallbackEstimatedCost
      ?? (manpowerInvoiceCost > 0 ? 0 : summary.manpowerEstimatedCost)
  );
  const manpowerNoteParts = [
    manpowerInvoiceCost > 0 ? `Invoices ${financeSgd(manpowerInvoiceCost)}` : '',
    manpowerFallbackEstimate > 0 ? `Pending estimates ${financeSgd(manpowerFallbackEstimate)}` : ''
  ].filter(Boolean);
  const otherExpenseNote = profitLossOtherExpenseNote(data.otherExpenseCategories);
  const revenueSource = data.revenueSource || (quote ? 'quotation' : 'none');
  const invoiceDiscount = financeNumber(summary.invoiceDiscount);
  const revenueTitle = revenueSource === 'manual'
    ? 'Event Revenue'
    : invoiceDiscount > 0
      ? 'Revenue after Invoice Discount'
      : 'Revenue from Quotation';
  const revenueNote = quote
    ? `Quotation: ${quote.number}${invoiceDiscount > 0 ? ` · Invoice discount -${financeSgd(invoiceDiscount)}` : ''}`
    : revenueSource === 'manual'
      ? 'Manual amount - Click to edit'
      : 'Select quotation or enter amount';
  const revenueAction = quote
    ? `profitLossOpenQuotation('${financeEscapeAttr(quote.id)}')`
    : 'profitLossOpenRevenueModal()';
  const manpowerNote = quote
    ? profitLossBudgetNote(summary, 'manpower', true)
    : manpowerNoteParts.join(' · ') || 'No manpower costs';
  const transportNote = quote
    ? profitLossBudgetNote(summary, 'transport', true)
    : transportNoteParts.join(' · ') || 'No transport costs';
  const activityRows = activity.map(row => {
    const category = typeof eventActivityCategory === 'function'
      ? eventActivityCategory(row)
      : (row.category || 'details');
    const meta = typeof eventActivityCategoryMeta === 'function'
      ? eventActivityCategoryMeta(category)
      : { label: category || 'Activity', icon: '' };
    const timestamp = typeof eventActivityTimestamp === 'function'
      ? eventActivityTimestamp(row.timestamp || row.date)
      : (row.timestamp || row.date || '');
    return `
      <article class="pnl-activity-row pnl-activity-${financeEscapeAttr(category)}">
        <div class="pnl-activity-icon" aria-hidden="true">${meta.icon || ''}</div>
        <div class="pnl-activity-copy">
          <div class="pnl-activity-meta">
            <span class="pnl-activity-category">${financeEscape(meta.label || 'Activity')}</span>
            <span>${financeEscape(row.user || 'system')}</span>
            <time>${financeEscape(timestamp)}</time>
          </div>
          <p>${financeEscape(row.action || '')}</p>
        </div>
      </article>
    `;
  }).join('');
  root.innerHTML = `
    <div class="pnl-heading">
      <div>
        <h2>Profit &amp; Loss</h2>
        <p class="finance-subtitle">Track revenue, expenses, and net profit for each event.</p>
      </div>
      <button type="button" class="btn btn-primary" onclick="profitLossExportPdf(this)">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m0 0 4-4m-4 4-4-4"></path><path d="M5 19h14"></path></svg>
        Export PDF
      </button>
    </div>

    <div class="plan-event-bar pnl-event-bar">
      <button type="button" class="plan-event-select-wrap"
              aria-haspopup="dialog" aria-label="Choose a Profit and Loss event"
              onclick="planOpenEventChooser('profit-loss')">
        <div class="plan-event-icon" aria-hidden="true">${typeof planMetricIconSvg === 'function' ? planMetricIconSvg('calendar') : ''}</div>
        <div style="min-width:0;flex:1;">
          <div class="plan-event-title-row">
            <span class="plan-event-id">#${financeEscape(String(event.id || ''))}</span>
            <span class="plan-event-name">${financeEscape(event.name || selectedEvent.name || 'Untitled event')}</span>
            ${typeof planEventTypeBadgeHtml === 'function' ? planEventTypeBadgeHtml(selectedEvent) : ''}
          </div>
          <div class="plan-event-meta">
            <span>${financeEscape([event.startDate, event.endDate].filter(Boolean).join(' - '))}</span>
            ${event.location ? `<span aria-hidden="true">-</span><span>${financeEscape(event.location)}</span>` : ''}
            ${event.state && typeof planEventStateBadgeHtml === 'function' ? planEventStateBadgeHtml(event) : ''}
          </div>
        </div>
        <span class="plan-event-picker-chevron" aria-hidden="true">⌄</span>
      </button>
      <div class="pnl-event-facts">
        <div><span>Event Date</span><strong>${financeEscape(event.startDate || 'Date not set')}</strong></div>
        <div><span>Client</span><strong>${financeEscape(quote?.client?.name || quote?.client?.company || 'No quotation client')}</strong></div>
        <div><span>Location</span><strong>${financeEscape(event.location || 'Location not set')}</strong></div>
        <button type="button" class="btn btn-secondary" onclick="viewEvent(${Number(event.id) || 0})">View Event Details</button>
      </div>
    </div>

    <div class="pnl-kpis">
      ${profitLossKpi(revenueTitle, financeSgd(summary.revenue), revenueNote, 'pnl-link-kpi', revenueAction)}
      ${profitLossKpi('Manpower Cost', financeSgd(summary.manpowerCardCost ?? summary.manpowerCost), manpowerNote, 'pnl-link-kpi', `profitLossOpenManpower(${Number(event.id) || 0})`)}
      ${profitLossKpi('Transport Cost', financeSgd(summary.transportCost), transportNote, 'pnl-link-kpi', `profitLossOpenManpower(${Number(event.id) || 0}, 'transport')`)}
      ${profitLossKpi('Other Expenses', financeSgd(summary.otherExpenses), otherExpenseNote)}
      ${profitLossKpi('Commission', financeSgd(summary.commission), financeNumber(summary.commission) > 0 ? `${(data.commissions || []).length} recipient${(data.commissions || []).length === 1 ? '' : 's'} · ${financePercentDisplay(summary.commissionRate)}` : 'Click to add commission', 'pnl-link-kpi', 'profitLossOpenCommissionModal()')}
      ${profitLossKpi('Net Profit', financeSignedSgd(summary.netProfit), '')}
      ${profitLossKpi('Profit Margin', financePercentDisplay(summary.profitMargin), 'of revenue')}
    </div>

    <div class="pnl-main-grid">
      <section class="finance-card pnl-calculation">
        <h3>Profit Calculation</h3>
        <div class="pnl-calc-row"><span>${financeEscape(revenueTitle)}</span><strong>${financeSgd(summary.revenue)}</strong></div>
        <h4>Less: Direct Costs</h4>
        <div class="pnl-calc-row"><span>Manpower Cost</span><strong>- ${financeSgd(summary.manpowerCost)}</strong></div>
        <div class="pnl-calc-row"><span>Transport Cost</span><strong>- ${financeSgd(summary.transportCost)}</strong></div>
        <div class="pnl-calc-row"><span>Subtotal (Direct Costs)</span><strong>- ${financeSgd(summary.directCosts)}</strong></div>
        <h4>Less: Other Expenses</h4>
        <div class="pnl-calc-row"><span>Other Expenses</span><strong>- ${financeSgd(summary.otherExpenses)}</strong></div>
        <div class="pnl-calc-row pnl-positive"><span>Net Profit (Before Commission)</span><strong>${financeSignedSgd(summary.beforeCommission)}</strong></div>
        <div class="pnl-calc-row"><span>Less: Commission</span><strong>- ${financeSgd(summary.commission)}</strong></div>
        <div class="pnl-calc-total">
          <span>Net Profit (After Commission)</span><strong>${financeSignedSgd(summary.netProfit)}</strong>
          <span>Profit Margin</span><strong>${financePercentDisplay(summary.profitMargin)}</strong>
        </div>
      </section>

      <section class="finance-card pnl-expenses"
               ondragenter="profitLossExpenseDragOver(event)"
               ondragover="profitLossExpenseDragOver(event)"
               ondragleave="profitLossExpenseDragLeave(event)"
               ondrop="profitLossExpenseDrop(event)">
        <input id="profitLossExpenseDropInput" type="file" multiple hidden
               accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg"
               onchange="profitLossUploadExpenseFiles(this.files);this.value=''">
        <div class="pnl-section-head">
          <h3>Expense Breakdown</h3>
          <div class="pnl-actions">
            <span class="pnl-drop-hint">Drop receipt files anywhere in this card</span>
            <button type="button" class="btn btn-secondary" onclick="profitLossOpenExpenseModal()">Add Expense</button>
          </div>
        </div>
        <div class="pnl-table-wrap">
          <table class="pnl-table">
            <thead><tr><th>Description</th><th>Type</th><th>Category</th><th>Vendor / Payee</th><th>Date</th><th>Amount</th><th>Attachment</th><th></th></tr></thead>
            <tbody>
              ${pendingExpenseRows}
              ${expenses.map(row => `
                <tr>
                  <td><strong>${financeEscape(row.description)}</strong>${profitLossExpenseProcessingMarkup(row)}</td>
                  <td><span class="pnl-source-pill pnl-source-${financeEscapeAttr(row.source || 'manual')}">${financeEscape(row.sourceLabel || (row.readOnly ? 'Claim' : 'Added'))}</span></td>
                  <td>${profitLossExpenseCategoryMarkup(row, profitChartSegments)}</td>
                  <td>${financeEscape(row.vendor || '-')}</td>
                  <td>${financeEscape(row.expenseDate || '-')}</td>
                  <td><strong>${financeSgd(row.amount)}</strong></td>
                  <td>${row.attachment ? `
                    <span class="pnl-attachment-actions">
                      <button type="button" class="pnl-attachment-preview" onclick="profitLossPreviewAttachment('${financeEscapeAttr(row.id)}')">${financeEscape(row.attachment.originalName || 'Attachment')}</button>
                      <a class="pnl-attachment-download" href="${financeEscapeAttr(row.attachment.downloadUrl || row.attachment.previewUrl)}" download>Download</a>
                    </span>
                  ` : '-'}</td>
                  <td>${['worker-claim', 'transport-invoice', 'transport-claim'].includes(row.source) ? `
                    <span class="pnl-expense-actions">
                      <button type="button" class="pnl-expense-edit" onclick="profitLossOpenClaimReview('${financeEscapeAttr(row.sourceId)}')" aria-label="Review ${row.source === 'transport-invoice' ? 'transport invoice' : 'claim'}" title="Review ${row.source === 'transport-invoice' ? 'transport invoice' : 'claim'}">
                        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"></path><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4z"></path></svg>
                      </button>
                      <button type="button" class="pnl-expense-edit pnl-expense-source" onclick="profitLossOpenManpower(${Number(event.id) || 0}, '${row.source.startsWith('transport-') ? 'transport' : 'claims'}')" aria-label="Open Crew &amp; Vendors" title="Open Crew &amp; Vendors">
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                          <circle cx="8" cy="8" r="3"></circle>
                          <path d="M3.5 19a4.5 4.5 0 0 1 9 0M16 8h3l2 3v5h-5zM15 16h7"></path>
                          <circle cx="17" cy="18" r="1.5"></circle>
                          <circle cx="21" cy="18" r="1.5"></circle>
                        </svg>
                      </button>
                    </span>
                  ` : row.readOnly ? `
                    <button type="button" class="pnl-expense-edit pnl-expense-source" onclick="profitLossOpenManpower(${Number(event.id) || 0})" aria-label="Open Crew &amp; Vendors" title="Open Crew &amp; Vendors">
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <circle cx="8" cy="8" r="3"></circle>
                        <path d="M3.5 19a4.5 4.5 0 0 1 9 0M16 8h3l2 3v5h-5zM15 16h7"></path>
                        <circle cx="17" cy="18" r="1.5"></circle>
                        <circle cx="21" cy="18" r="1.5"></circle>
                      </svg>
                    </button>
                  ` : `
                    <span class="pnl-expense-actions">
                      <button type="button" class="pnl-expense-edit" onclick="profitLossOpenExpenseModal('${financeEscapeAttr(row.id)}')" aria-label="Edit expense" title="Edit expense">
                        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"></path><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4z"></path></svg>
                      </button>
                      <button type="button" class="finance-delete-line" onclick="profitLossDeleteExpense('${financeEscapeAttr(row.id)}')" aria-label="Delete expense">&times;</button>
                    </span>`}</td>
                </tr>
              `).join('') || (!pendingExpenseRows ? '<tr><td colspan="8" class="pnl-empty-row">No invoices, claims, or additional expenses have been added.</td></tr>' : '')}
            </tbody>
          </table>
        </div>
        <div class="pnl-total-line"><span>Total listed expenses</span><strong>${financeSgd(listedExpenseTotal)}</strong></div>
      </section>

      <aside class="pnl-side">
        <section class="finance-card pnl-summary-card">
          <h3>Profit Summary</h3>
          ${profitLossChartMarkup(profitChartSegments, summary, true)}
        </section>
        <section class="finance-card pnl-activity">
          <div class="pnl-section-head"><h3>Recent Activity</h3></div>
          <div class="pnl-activity-list">${activityRows || '<div class="finance-empty" style="padding:24px 0;">No recent activity.</div>'}</div>
        </section>
      </aside>
    </div>
  `;
}

function financeEnsureProfitLossExpenseModal() {
  if (document.getElementById('profitLossExpenseModal')) return;
  const modal = document.createElement('div');
  modal.id = 'profitLossExpenseModal';
  modal.className = 'modal';
  modal.innerHTML = `
    <div class="modal-content pnl-expense-modal">
      <div class="modal-header"><h3 class="modal-title" id="profitLossExpenseTitle">Add Expense</h3><button type="button" class="close-btn" onclick="profitLossCloseExpenseModal()">&times;</button></div>
      <form id="profitLossExpenseForm" onsubmit="profitLossSubmitExpense(event)">
        <div class="pnl-expense-editor">
          <section class="pnl-expense-review-preview" id="profitLossExpensePreviewPanel" hidden>
            <div class="pnl-expense-review-preview-head">
              <div><span>Uploaded document</span><strong id="profitLossExpensePreviewName"></strong></div>
              <a id="profitLossExpensePreviewDownload" class="pnl-attachment-download" download>Download</a>
            </div>
            <div class="pnl-expense-review-preview-body" id="profitLossExpensePreviewBody"></div>
          </section>
          <div class="pnl-expense-fields">
            <div class="finance-form-grid">
              <label class="finance-field finance-span-all"><span>Description</span><input id="profitLossExpenseDescription" class="finance-input" maxlength="300" placeholder="e.g. Stage backdrop invoice"></label>
              <div class="finance-field"><span>Category</span>
                <div class="finance-custom-control pnl-expense-category-control" onclick="event.stopPropagation()">
                  <input id="profitLossExpenseCategory" type="hidden" value="">
                  <button type="button" class="finance-line-select-button" id="profitLossExpenseCategoryButton"
                          aria-haspopup="menu" onclick="financeToggleMenu('profit-loss-expense-category-menu',event)">
                    <span id="profitLossExpenseCategoryLabel">Select category</span><span aria-hidden="true">⌄</span>
                  </button>
                  <div class="finance-custom-menu" id="profit-loss-expense-category-menu" role="menu">
                    ${['Meal', 'Crew Transport', 'Equipment Transport', 'Purchase', 'Other'].map(category => `
                      <button type="button" data-expense-category="${category}" onclick="profitLossChooseExpenseCategory('${category}')">${category}</button>
                    `).join('')}
                  </div>
                </div>
              </div>
              <label class="finance-field" id="profitLossExpenseOtherCategoryField" hidden><span>Other category</span><input id="profitLossExpenseOtherCategory" class="finance-input" maxlength="120" placeholder="Enter category"></label>
              <label class="finance-field"><span>Vendor / Payee</span><input id="profitLossExpenseVendor" class="finance-input" maxlength="180"></label>
              <label class="finance-field"><span>Date</span><input id="profitLossExpenseDate" class="finance-input" type="date"></label>
              <label class="finance-field"><span>Amount</span><input id="profitLossExpenseAmount" class="finance-input" inputmode="decimal" placeholder="0.00"></label>
              <label class="finance-field finance-span-all" id="profitLossExpenseFileField"><span>Receipt or document</span><input id="profitLossExpenseFile" class="finance-input" type="file" accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg"></label>
            </div>
          </div>
        </div>
        <div class="modal-actions finance-picker-actions">
          <button type="button" class="btn btn-secondary" onclick="profitLossCloseExpenseModal()">Cancel</button>
          <button type="submit" class="btn btn-primary" id="profitLossExpenseSubmit">Save Expense</button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(modal);
}

function financeEnsureProfitLossCommissionModal() {
  if (document.getElementById('profitLossCommissionModal')) return;
  const modal = document.createElement('div');
  modal.id = 'profitLossCommissionModal';
  modal.className = 'modal';
  modal.innerHTML = `
    <div class="modal-content finance-commission-modal">
      <div class="modal-header"><h3 class="modal-title">Commission</h3><button type="button" class="close-btn" onclick="closeModal('profitLossCommissionModal')">&times;</button></div>
      <form onsubmit="profitLossSaveCommissions(event)">
        <div class="modal-body">
          <div id="profitLossCommissionRows" class="pnl-commission-rows"></div>
          <button type="button" class="btn btn-secondary" onclick="profitLossAddCommissionRow()">+ Add commission</button>
          <div class="wf-error" id="profitLossCommissionError"></div>
        </div>
        <div class="modal-footer"><button type="button" class="btn btn-secondary" onclick="closeModal('profitLossCommissionModal')">Cancel</button><button type="submit" class="btn btn-primary">Save commission</button></div>
      </form>
    </div>`;
  document.body.appendChild(modal);
}

function profitLossCommissionDraft() {
  return profitLossState.commissionDraft || (profitLossState.commissionDraft = []);
}

function profitLossOpenCommissionModal() {
  financeEnsureProfitLossCommissionModal();
  profitLossState.commissionDraft = (profitLossState.data?.commissions || []).map(row => ({ ...row }));
  if (!profitLossState.commissionDraft.length) profitLossAddCommissionRow(false);
  profitLossRenderCommissionRows();
  openModal('profitLossCommissionModal');
}

function profitLossAddCommissionRow(render = true) {
  profitLossCommissionDraft().push({
    id: `commission_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    recipient: '', calculationMode: 'percent', percent: 0, amount: 0
  });
  if (render) profitLossRenderCommissionRows();
}

function profitLossRemoveCommissionRow(index) {
  profitLossCommissionDraft().splice(index, 1);
  profitLossRenderCommissionRows();
}

function profitLossCommissionChange(index, field, value) {
  const row = profitLossCommissionDraft()[index];
  if (!row) return;
  if (field === 'recipient') row.recipient = value;
  if (field === 'calculationMode') row.calculationMode = value === 'amount' ? 'amount' : 'percent';
  if (field === 'percent') {
    row.percent = Math.max(0, Math.min(100, financeNumber(value)));
    row.amount = Math.round(financeNumber(profitLossState.data?.summary?.commissionBase) * row.percent) / 100;
    row.calculationMode = 'percent';
  }
  if (field === 'amount') {
    row.amount = Math.max(0, financeCurrencyNumber(value));
    const commissionBase = financeNumber(profitLossState.data?.summary?.commissionBase);
    row.percent = commissionBase ? Math.round(row.amount / commissionBase * 100 * 10000) / 10000 : 0;
    row.calculationMode = 'amount';
  }
  profitLossRenderCommissionRows();
}

function profitLossRenderCommissionRows() {
  const holder = document.getElementById('profitLossCommissionRows');
  if (!holder) return;
  holder.innerHTML = profitLossCommissionDraft().map((row, index) => `
    <div class="pnl-commission-row">
      <label class="finance-field"><span>Recipient</span><input class="finance-input" value="${financeEscapeAttr(row.recipient || '')}" placeholder="Name or company" onchange="profitLossCommissionChange(${index},'recipient',this.value)"></label>
      <label class="finance-field"><span>Percentage</span><span class="finance-percent-input"><input class="finance-input" type="number" min="0" max="100" step="0.1" value="${financeEscapeAttr(row.percent || 0)}" onchange="profitLossCommissionChange(${index},'percent',this.value)"><span>%</span></span></label>
      <label class="finance-field"><span>Amount</span><span class="finance-money-input"><span>$</span><input class="finance-input" type="text" inputmode="decimal" value="${financeEscapeAttr(financeMoneyInputValue(row.amount))}" onblur="financeFormatMoneyInput(this)" onchange="profitLossCommissionChange(${index},'amount',this.value)"></span></label>
      <span class="pnl-commission-mode">Using ${row.calculationMode === 'amount' ? 'amount' : 'percentage'}</span>
      <button type="button" class="finance-delete-line" title="Remove commission" aria-label="Remove commission" onclick="profitLossRemoveCommissionRow(${index})">&times;</button>
    </div>
  `).join('') || '<div class="finance-empty" style="padding:18px 0;">No commission rows.</div>';
}

async function profitLossSaveCommissions(event) {
  event.preventDefault();
  const rows = profitLossCommissionDraft().filter(row => row.recipient || financeNumber(row.percent) > 0 || financeNumber(row.amount) > 0);
  try {
    const response = await apiCall(`/api/finance/profit-loss/${profitLossState.eventId}/commissions`, 'PUT', { commissions: rows });
    profitLossState.data = response.data;
    closeModal('profitLossCommissionModal');
    renderProfitLossPage();
    showNotification('success', 'Commission updated');
  } catch (error) {
    const holder = document.getElementById('profitLossCommissionError');
    if (holder) holder.textContent = error.message || 'Failed to save commission';
  }
}

function profitLossOpenExpenseModal(expenseId = '') {
  financeEnsureProfitLossExpenseModal();
  document.getElementById('profitLossExpenseForm')?.reset();
  profitLossState.editingExpenseId = String(expenseId || '');
  const expense = profitLossState.editingExpenseId
    ? (profitLossState.data?.expenses || []).find(row => String(row.id) === profitLossState.editingExpenseId && !row.readOnly)
    : null;
  if (expense) {
    const setValue = (id, value) => {
      const input = document.getElementById(id);
      if (input) input.value = value == null ? '' : String(value);
    };
    setValue('profitLossExpenseDescription', expense.description);
    const category = profitLossExpenseCategorySelection(expense.category);
    setValue('profitLossExpenseCategory', category.selection);
    setValue('profitLossExpenseOtherCategory', category.other);
    setValue('profitLossExpenseVendor', expense.vendor);
    setValue('profitLossExpenseAmount', expense.amount);
    setValue('profitLossExpenseDate', expense.expenseDate);
  } else {
    profitLossState.editingExpenseId = '';
  }
  profitLossSyncExpenseOtherCategory();
  profitLossRenderExpenseReviewPreview(expense);
  const title = document.getElementById('profitLossExpenseTitle');
  const fileField = document.getElementById('profitLossExpenseFileField');
  const submit = document.getElementById('profitLossExpenseSubmit');
  const isReview = Boolean(expense?.needsReview && expense?.attachment);
  if (title) title.textContent = isReview ? 'Review Expense' : (expense ? 'Edit Expense' : 'Add Expense');
  if (submit) submit.textContent = isReview ? 'Save Review' : 'Save Expense';
  if (fileField) fileField.style.display = expense ? 'none' : 'grid';
  openModal('profitLossExpenseModal');
}

function profitLossExpenseCategorySelection(value) {
  const category = String(value || '').trim();
  const normalized = category.toLowerCase();
  if (['meal', 'meals'].includes(normalized)) return { selection: 'Meal', other: '' };
  if (['crew transport', 'staff transport', 'cab', 'taxi', 'grab'].includes(normalized)) {
    return { selection: 'Crew Transport', other: '' };
  }
  if (['equipment transport', 'transport', 'lorry', 'vehicle'].includes(normalized)) {
    return { selection: 'Equipment Transport', other: '' };
  }
  if (['purchase', 'purchases'].includes(normalized)) return { selection: 'Purchase', other: '' };
  if (!category || ['other', 'miscellaneous'].includes(normalized)) {
    return { selection: category ? 'Other' : '', other: '' };
  }
  return { selection: 'Other', other: category };
}

function profitLossSyncExpenseOtherCategory() {
  const select = document.getElementById('profitLossExpenseCategory');
  const field = document.getElementById('profitLossExpenseOtherCategoryField');
  const input = document.getElementById('profitLossExpenseOtherCategory');
  const label = document.getElementById('profitLossExpenseCategoryLabel');
  if (!select || !field || !input) return;
  const isOther = select.value === 'Other';
  field.hidden = !isOther;
  input.required = isOther;
  if (label) label.textContent = select.value || 'Select category';
  document.querySelectorAll('[data-expense-category]').forEach(button => {
    button.classList.toggle('selected', button.dataset.expenseCategory === select.value);
  });
}

function profitLossChooseExpenseCategory(category) {
  const input = document.getElementById('profitLossExpenseCategory');
  if (!input) return;
  input.value = category;
  financeCloseMenus();
  profitLossSyncExpenseOtherCategory();
}

function profitLossRenderExpenseReviewPreview(expense) {
  const modal = document.querySelector('#profitLossExpenseModal .pnl-expense-modal');
  const panel = document.getElementById('profitLossExpensePreviewPanel');
  const body = document.getElementById('profitLossExpensePreviewBody');
  const name = document.getElementById('profitLossExpensePreviewName');
  const download = document.getElementById('profitLossExpensePreviewDownload');
  const attachment = expense?.attachment;
  if (!modal || !panel || !body) return;

  body.replaceChildren();
  modal.classList.toggle('has-preview', Boolean(attachment));
  panel.hidden = !attachment;
  if (!attachment) return;

  const filename = attachment.originalName || 'Expense attachment';
  const previewUrl = attachment.previewUrl || attachment.downloadUrl || '';
  const downloadUrl = attachment.downloadUrl || previewUrl;
  if (name) name.textContent = filename;
  if (download) {
    download.href = downloadUrl;
    download.download = filename;
    download.hidden = !downloadUrl;
  }

  const kind = profitLossAttachmentPreviewKind(attachment);
  let preview = null;
  if (previewUrl && kind === 'image') {
    preview = document.createElement('img');
    preview.src = previewUrl;
    preview.alt = filename;
  } else if (previewUrl && (kind === 'pdf' || kind === 'text')) {
    preview = document.createElement('iframe');
    preview.src = kind === 'pdf'
      ? `${previewUrl}#toolbar=1&navpanes=0&pagemode=none&view=Fit`
      : previewUrl;
    preview.title = `Preview of ${filename}`;
    preview.referrerPolicy = 'no-referrer';
  } else if (previewUrl && kind === 'video') {
    preview = document.createElement('video');
    preview.src = previewUrl;
    preview.controls = true;
  } else if (previewUrl && kind === 'audio') {
    preview = document.createElement('audio');
    preview.src = previewUrl;
    preview.controls = true;
  }

  if (preview) {
    preview.className = 'pnl-expense-review-media';
    body.appendChild(preview);
    return;
  }

  const unavailable = document.createElement('div');
  unavailable.className = 'pnl-expense-review-unavailable';
  unavailable.innerHTML = '<strong>Preview unavailable</strong><span>Download the attachment to review it.</span>';
  body.appendChild(unavailable);
}

function profitLossCloseExpenseModal() {
  const body = document.getElementById('profitLossExpensePreviewBody');
  const modal = document.querySelector('#profitLossExpenseModal .pnl-expense-modal');
  body?.replaceChildren();
  modal?.classList.remove('has-preview');
  profitLossState.editingExpenseId = '';
  closeModal('profitLossExpenseModal');
}

async function profitLossSubmitExpense(event) {
  event.preventDefault();
  if (!profitLossState.eventId) return;
  const value = id => document.getElementById(id)?.value.trim() || '';
  if (!value('profitLossExpenseCategory')) {
    showNotification('error', 'Choose an expense category');
    return;
  }
  const expense = {
    description: value('profitLossExpenseDescription'),
    category: value('profitLossExpenseCategory') === 'Other'
      ? (value('profitLossExpenseOtherCategory') || 'Other')
      : value('profitLossExpenseCategory'),
    vendor: value('profitLossExpenseVendor'),
    amount: value('profitLossExpenseAmount'),
    expenseDate: value('profitLossExpenseDate')
  };
  const editingExpenseId = profitLossState.editingExpenseId;
  const file = document.getElementById('profitLossExpenseFile')?.files?.[0];
  try {
    let response;
    if (editingExpenseId) {
      expense.needsReview = false;
      response = await apiCall(
        `/api/finance/profit-loss/${profitLossState.eventId}/expenses/${encodeURIComponent(editingExpenseId)}`,
        'PUT',
        expense
      );
    } else {
      const form = new FormData();
      Object.entries(expense).forEach(([key, fieldValue]) => form.append(key, fieldValue));
      if (file) form.append('file', file);
      response = await apiCall(`/api/finance/profit-loss/${profitLossState.eventId}/expenses`, 'POST', form);
    }
    profitLossState.data = response.data;
    profitLossCloseExpenseModal();
    renderProfitLossPage();
    showNotification('success', editingExpenseId ? 'Expense updated' : (file ? 'Receipt uploaded' : 'Expense added'));
  } catch (error) {
    showNotification('error', error.message || 'Failed to save expense');
  }
}

function profitLossExpenseDragOver(event) {
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  event.currentTarget?.classList.add('is-file-dragging');
}

function profitLossExpenseDragLeave(event) {
  const section = event.currentTarget;
  if (!section || (event.relatedTarget && section.contains(event.relatedTarget))) return;
  section.classList.remove('is-file-dragging');
}

async function profitLossExpenseDrop(event) {
  event.preventDefault();
  event.currentTarget?.classList.remove('is-file-dragging');
  profitLossUploadExpenseFiles(event.dataTransfer?.files || []);
}

function profitLossExpenseUploadRequest(eventId, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const form = new FormData();
    form.append('file', file);
    xhr.open('POST', `/api/finance/profit-loss/${eventId}/expenses`);
    xhr.upload.onprogress = event => {
      if (event.lengthComputable) {
        onProgress((event.loaded / event.total) * 100, 'uploading');
      }
    };
    xhr.upload.onload = () => onProgress(100, 'queueing');
    xhr.onload = () => {
      let payload = {};
      try { payload = JSON.parse(xhr.responseText || '{}'); } catch (_error) {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(payload);
      else reject(new Error(payload.error || 'The expense file could not be uploaded.'));
    };
    xhr.onerror = () => reject(new Error('The expense file could not be uploaded.'));
    xhr.send(form);
  });
}

function profitLossUploadExpenseFiles(fileList) {
  const files = Array.from(fileList || []).filter(file => file && file.name);
  const eventId = Number(profitLossState.eventId || 0);
  if (!eventId || !files.length) return;
  files.forEach(file => {
    const id = `pnl-upload-${Date.now()}-${++profitLossExpenseUploadState.sequence}`;
    const row = {
      id,
      eventId,
      file,
      name: file.name,
      size: Number(file.size || 0),
      status: 'queued',
      progress: 0,
      error: ''
    };
    profitLossExpenseUploadState.rows.set(id, row);
    profitLossExpenseUploadState.queue.push(id);
  });
  renderProfitLossPage();
  profitLossProcessExpenseUploadQueue();
}

async function profitLossProcessExpenseUploadQueue() {
  if (profitLossExpenseUploadState.active) return;
  profitLossExpenseUploadState.active = true;
  let uploaded = 0;
  let failed = 0;
  while (profitLossExpenseUploadState.queue.length) {
    const uploadId = profitLossExpenseUploadState.queue.shift();
    const row = profitLossExpenseUploadState.rows.get(uploadId);
    if (!row) continue;
    row.status = 'uploading';
    row.progress = 0;
    profitLossUpdateExpenseUploadRow(uploadId);
    try {
      const response = await profitLossExpenseUploadRequest(
        row.eventId,
        row.file,
        (progress, phase) => {
          row.progress = progress;
          row.status = phase;
          profitLossUpdateExpenseUploadRow(uploadId);
        }
      );
      row.status = 'queued';
      row.progress = 100;
      if (Number(profitLossState.eventId) === Number(row.eventId)) {
        profitLossState.data = response.data;
      }
      profitLossExpenseUploadState.rows.delete(uploadId);
      uploaded += 1;
    } catch (error) {
      row.status = 'failed';
      row.error = error.message || 'Upload failed';
      failed += 1;
      console.warn(`Expense upload failed for ${row.name}:`, error);
    }
    if (Number(profitLossState.eventId) === Number(row.eventId)) {
      renderProfitLossPage();
    }
  }
  profitLossExpenseUploadState.active = false;
  if (uploaded) {
    showNotification('success', `${uploaded} expense file${uploaded === 1 ? '' : 's'} queued for processing`);
  }
  if (failed) {
    showNotification('error', `${failed} file${failed === 1 ? '' : 's'} could not be uploaded`);
  }
}

async function profitLossDeleteExpense(expenseId) {
  if (!expenseId || !profitLossState.eventId) return;
  const confirmed = await showAppConfirm({
    title: 'Delete Expense',
    message: 'Remove this expense from Profit & Loss?',
    confirmText: 'Delete',
    cancelText: 'Cancel',
    destructive: true
  });
  if (!confirmed) return;
  try {
    const response = await apiCall(`/api/finance/profit-loss/${profitLossState.eventId}/expenses/${encodeURIComponent(expenseId)}`, 'DELETE');
    profitLossState.data = response.data;
    renderProfitLossPage();
  } catch (error) {
    showNotification('error', error.message || 'Failed to delete expense');
  }
}

function compareEventChooserEvents() {
  return compareState.events || [];
}

function compareCurrentEventId() {
  return compareState.eventId;
}

function openCompareForEvent(eventId, quotationId = '') {
  ensureFinanceSections();
  compareState.eventId = Number(eventId || 0);
  compareState.quotationId = quotationId || '';
  compareState.data = null;
  showSection('compare');
}

function compareGoToPlan() {
  const eventId = Number(compareState.eventId || compareState.data?.event?.id || 0);
  if (!eventId) return;
  if (typeof planPageState !== 'undefined') {
    planPageState.eventId = eventId;
  }
  showSection('plan');
}

function compareGoToQuotation() {
  const quote = compareState.data?.quotation || null;
  if (!quote?.id) return;
  if (typeof currentUserHasSalesAccess === 'function' && !currentUserHasSalesAccess()) {
    showNotification('error', 'Sales access is required to open quotations');
    return;
  }
  showSection('quotations');
  setTimeout(() => financeOpenDocument(quote.id), 0);
}

async function loadComparePage(options = {}) {
  ensureFinanceSections();
  const root = compareRoot();
  if (!root || compareState.loading) return;
  if (typeof isAdminUser === 'function' && !isAdminUser()) {
    root.innerHTML = '<div class="finance-empty">Manager access is required for Compare.</div>';
    return;
  }
  compareState.loading = true;
  if (!options.preserve) root.innerHTML = '<div class="loading">Loading comparison...</div>';
  try {
    await financeLoadProgressiveEvents(
      compareState,
      compareState.eventId,
      'compare'
    );
    if (!compareState.eventId) compareState.eventId = Number(compareState.events[0]?.id || 0);
    if (!compareState.eventId) {
      root.innerHTML = '<div class="finance-empty">Create an event before comparing quotation items.</div>';
      return;
    }
    await selectCompareEvent(compareState.eventId, { renderLoading: false, keepQuotation: true });
  } catch (error) {
    root.innerHTML = `<div class="finance-empty">Could not load Compare.<br>${financeEscape(error.message || String(error))}</div>`;
  } finally {
    compareState.loading = false;
  }
}

async function selectCompareEvent(eventId, options = {}) {
  const id = Number(eventId || 0);
  if (!id) return;
  if (Number(compareState.eventId) !== id) compareState.viewId = 'all';
  compareState.eventId = id;
  if (!options.keepQuotation) compareState.quotationId = '';
  const root = compareRoot();
  if (options.renderLoading !== false && root) root.innerHTML = '<div class="loading">Loading comparison...</div>';
  try {
    const query = new URLSearchParams({ eventId: String(id) });
    if (compareState.quotationId) query.set('quotationId', compareState.quotationId);
    const response = await apiCall(`/api/finance/compare?${query.toString()}`);
    compareState.data = response.data;
    compareState.quotationId = response.data?.quotation?.id || '';
    if (
      compareState.viewId !== 'all'
      && !(response.data?.subprojectViews || []).some(view => view.id === compareState.viewId)
    ) {
      compareState.viewId = 'all';
    }
    renderComparePage();
  } catch (error) {
    if (root) root.innerHTML = `<div class="finance-empty">Could not load comparison.<br>${financeEscape(error.message || String(error))}</div>`;
  }
}

async function refreshCompareForRealtime(eventId) {
  if (Number(compareState.eventId) !== Number(eventId)) return;
  await selectCompareEvent(eventId, { renderLoading: false, keepQuotation: true });
}

function compareSetFilter(filter) {
  compareState.filter = filter || 'all';
  renderComparePage();
}

function compareSubprojectViews() {
  return compareState.data?.subprojectViews || [];
}

function compareActiveSubprojectView() {
  if (compareState.viewId === 'all') return null;
  return compareSubprojectViews().find(view => view.id === compareState.viewId) || null;
}

function compareCurrentRows() {
  return compareActiveSubprojectView()?.rows || compareState.data?.rows || [];
}

function compareSetSubprojectView(viewId) {
  compareState.viewId = viewId || 'all';
  compareState.filter = 'all';
  renderComparePage();
}

function compareSetSearch(value) {
  compareState.search = value || '';
  renderComparePage();
}

function compareSetItemVisibility(type, visible) {
  if (type === 'misc') compareState.showMisc = Boolean(visible);
  if (type === 'loan') compareState.showLoans = Boolean(visible);
  renderComparePage();
}

function compareStatusLabel(status) {
  return ({
    matched: 'Matched',
    missing_in_event: 'Missing in Event',
    extra_in_event: 'Extra in Event',
    qty_mismatch: 'Qty Mismatch'
  })[status] || status;
}

function compareRowCustomType(row) {
  const identities = [
    row?.eventItem?.identity,
    row?.quotationItem?.identity
  ];
  const custom = identities.find(identity => identity?.kind === 'custom');
  if (!custom) return '';
  return String(custom.type || 'MISC').toUpperCase() === 'LOAN' ? 'LOAN' : 'MISC';
}

function compareRowsAllowedByItemVisibility() {
  const rows = compareCurrentRows();
  return rows.filter(row => {
    const customType = compareRowCustomType(row);
    if (customType === 'MISC') return compareState.showMisc;
    if (customType === 'LOAN') return compareState.showLoans;
    return true;
  });
}

function compareVisibleRows() {
  const rows = compareRowsAllowedByItemVisibility();
  const search = String(compareState.search || '').trim().toLowerCase();
  const filter = compareState.filter || 'all';
  return rows.filter(row => {
    const matchesFilter = filter === 'all' || row.status === filter;
    const text = [
      row.quotationItem?.title,
      row.quotationItem?.subtitle,
      row.eventItem?.title,
      row.eventItem?.subtitle,
      row.status
    ].join(' ').toLowerCase();
    return matchesFilter && (!search || text.includes(search));
  });
}

function compareCountsForRows(rows) {
  return (rows || []).reduce((counts, row) => {
    if (row.status === 'matched') counts.matched += 1;
    if (row.status === 'missing_in_event') counts.missingInEvent += 1;
    if (row.status === 'extra_in_event') counts.extraInEvent += 1;
    if (row.status === 'qty_mismatch') counts.qtyMismatch += 1;
    if (financeNumber(row.quotationItem?.quantity) > 0) counts.quotationItems += 1;
    if (financeNumber(row.eventItem?.quantity) > 0) counts.eventItems += 1;
    return counts;
  }, {
    matched: 0,
    missingInEvent: 0,
    extraInEvent: 0,
    qtyMismatch: 0,
    quotationItems: 0,
    eventItems: 0
  });
}

function compareRowActions(row) {
  const canEditQuote = !!compareState.data?.permissions?.canEditQuotation;
  const quoteQty = financeNumber(row.quotationItem?.quantity);
  const eventQty = financeNumber(row.eventItem?.quantity);
  const actions = [];
  if (quoteQty > eventQty) {
    actions.push(`<button type="button" class="compare-action primary" onclick="compareRunRowAction('add-event','${financeEscapeAttr(row.key)}')">Add to Event</button>`);
  }
  if (eventQty > quoteQty) {
    actions.push(`<button type="button" class="compare-action danger" onclick="compareRunRowAction('remove-extra','${financeEscapeAttr(row.key)}')">Remove Extra</button>`);
    if (canEditQuote) {
      actions.push(`<button type="button" class="compare-action quote" onclick="compareRunRowAction('add-quote','${financeEscapeAttr(row.key)}')">Add to Quote</button>`);
    }
  }
  if (!actions.length) {
    actions.push('<span class="compare-action-static">In sync</span>');
  }
  return actions.join('');
}

function compareItemCell(item, side) {
  const isEmpty = !item?.quantity;
  return `
    <div class="compare-item ${isEmpty ? 'empty' : ''}">
      <div class="compare-item-thumb" aria-hidden="true">${side === 'quote' ? 'Q' : 'E'}</div>
      <div>
        <strong>${financeEscape(isEmpty ? 'Not included' : item.title || 'Untitled item')}</strong>
        <span>${financeEscape(isEmpty ? (side === 'quote' ? 'Not included in quotation' : 'Not included in event') : [item.subtitle, item.department].filter(Boolean).join(' - '))}</span>
      </div>
    </div>
  `;
}

function renderComparePage() {
  const root = compareRoot();
  const data = compareState.data;
  if (!root || !data) return;
  const event = data.event || {};
  const quote = data.quotation || null;
  const subprojectViews = compareSubprojectViews();
  const activeSubprojectView = compareActiveSubprojectView();
  const actionableRows = compareRowsAllowedByItemVisibility();
  const counts = compareCountsForRows(actionableRows);
  const rows = compareVisibleRows();
  const canOpenQuotation = Boolean(quote?.id && data.permissions?.canEditQuotation);
  root.innerHTML = `
    <div class="compare-heading">
      <div>
        <h2>Quotation vs Event Comparison</h2>
        <p class="finance-subtitle">Compare quoted items with event requirements and quickly sync differences.</p>
      </div>
      <div class="compare-top-actions">
        <input class="finance-search" type="search" value="${financeEscapeAttr(compareState.search)}" placeholder="Search items, assets, SKUs..." oninput="compareSetSearch(this.value)">
      </div>
    </div>

    <div class="compare-control-bar finance-card">
      <button type="button" class="finance-picker-button" onclick="compareGoToPlan()">
        <span>${financeEscape(`#${event.id || ''} ${event.name || 'Choose event'}`)}</span>
        <small>Back to Plan</small>
      </button>
      <button type="button" class="finance-picker-button" onclick="compareGoToQuotation()" ${canOpenQuotation ? '' : 'disabled'}>
        <span>${financeEscape(quote ? quote.number : 'No quotation paired')}</span>
        <small>${canOpenQuotation ? 'Back to Quotation' : 'Sales access required'}</small>
      </button>
      <div class="compare-stat matched"><strong>${Number(counts.matched || 0)}</strong><span>Matched</span></div>
      <div class="compare-stat missing"><strong>${Number(counts.missingInEvent || 0)}</strong><span>Missing in Event</span></div>
      <div class="compare-stat extra"><strong>${Number(counts.extraInEvent || 0)}</strong><span>Extra in Event</span></div>
      <div class="compare-stat mismatch"><strong>${Number(counts.qtyMismatch || 0)}</strong><span>Qty Mismatch</span></div>
    </div>

    <div class="compare-project-tabs" role="tablist" aria-label="Comparison sub-projects">
      <button type="button" role="tab" class="${compareState.viewId === 'all' ? 'active' : ''}" aria-selected="${compareState.viewId === 'all'}" onclick="compareSetSubprojectView('all')">
        <span>All Requirements</span>
        <small>Consolidated</small>
      </button>
      ${subprojectViews.map(view => {
        const issueCount = Number(view.counts?.missingInEvent || 0) + Number(view.counts?.extraInEvent || 0) + Number(view.counts?.qtyMismatch || 0);
        const scopeLabel = view.scope === 'quotation_only'
          ? 'Quotation only'
          : view.scope === 'event_only'
            ? 'Event only'
            : 'Paired room';
        return `
          <button type="button" role="tab" class="${activeSubprojectView?.id === view.id ? 'active' : ''}" aria-selected="${activeSubprojectView?.id === view.id}" onclick="compareSetSubprojectView('${financeEscapeAttr(view.id)}')">
            <span>${financeEscape(view.name || 'Room')}</span>
            <small>${financeEscape(scopeLabel)}${issueCount ? ` · ${issueCount} difference${issueCount === 1 ? '' : 's'}` : ''}</small>
          </button>
        `;
      }).join('')}
    </div>

    <section class="finance-card compare-table-card">
      <div class="compare-toolbar">
        <div class="compare-tabs">
          ${[
            ['all', 'All'],
            ['matched', 'Matched'],
            ['missing_in_event', 'Missing'],
            ['extra_in_event', 'Extra'],
            ['qty_mismatch', 'Qty Mismatch']
          ].map(([key, label]) => `
            <button type="button" class="${compareState.filter === key ? 'active' : ''}" onclick="compareSetFilter('${key}')">${label}</button>
          `).join('')}
        </div>
        <div class="compare-item-toggles" aria-label="Item visibility">
          ${financeSwitch('Misc items', compareState.showMisc, "compareSetItemVisibility('misc', !compareState.showMisc)")}
          ${financeSwitch('Loan items', compareState.showLoans, "compareSetItemVisibility('loan', !compareState.showLoans)")}
        </div>
      </div>
      <div class="compare-bulk-actions">
        <span>Suggested actions</span>
        <button type="button" onclick="compareBulkAction('add-event')" ${counts.missingInEvent ? '' : 'disabled'}>Add Missing <strong>${Number(counts.missingInEvent || 0)}</strong></button>
        <button type="button" onclick="compareBulkAction('remove-extra')" ${counts.extraInEvent ? '' : 'disabled'}>Remove Extras <strong>${Number(counts.extraInEvent || 0)}</strong></button>
        ${data.permissions?.canEditQuotation ? `<button type="button" onclick="compareBulkAction('add-quote')" ${counts.extraInEvent ? '' : 'disabled'}>Add to Quotation <strong>${Number(counts.extraInEvent || 0)}</strong></button>` : ''}
        <button type="button" onclick="compareBulkAction('resolve-mismatch')" ${counts.qtyMismatch ? '' : 'disabled'}>Resolve Quantities <strong>${Number(counts.qtyMismatch || 0)}</strong></button>
      </div>
        <div class="compare-table">
          <div class="compare-table-head">
            <span>Quotation Items<br><small>${Number(counts.quotationItems || 0)} items</small></span>
            <span>Compare &amp; Actions</span>
            <span>Event Requirements<br><small>${Number(counts.eventItems || 0)} items</small></span>
          </div>
          ${rows.map(row => `
            <article class="compare-row status-${financeEscapeAttr(row.status)}">
              <div class="compare-side">
                ${compareItemCell(row.quotationItem, 'quote')}
                <div class="compare-qty"><span>Qty</span><strong>${Number(row.quotationItem?.quantity || 0)}</strong><small>${financeEscape(row.quotationItem?.uom || '')}</small></div>
              </div>
              <div class="compare-actions-cell">
                <span class="compare-status">${financeEscape(compareStatusLabel(row.status))}</span>
                ${compareRowActions(row)}
              </div>
              <div class="compare-side">
                ${compareItemCell(row.eventItem, 'event')}
                <div class="compare-qty"><span>Qty</span><strong>${Number(row.eventItem?.quantity || 0)}</strong><small>${financeEscape(row.eventItem?.uom || '')}</small></div>
              </div>
            </article>
          `).join('') || '<div class="finance-empty">No comparison rows match this view.</div>'}
        </div>
    </section>
  `;
}

async function compareRunRowAction(action, key, options = {}) {
  if (!compareState.eventId || !key) return;
  const endpoints = {
    'add-event': 'add-to-event',
    'remove-extra': 'remove-extra',
    'add-quote': 'add-to-quotation'
  };
  const endpoint = endpoints[action];
  if (!endpoint) return;
  const actionViewId = options.viewId || compareState.viewId;
  const activeView = compareSubprojectViews().find(view => view.id === actionViewId) || null;
  try {
    const response = await apiCall(`/api/finance/compare/${compareState.eventId}/${endpoint}`, 'POST', {
      quotationId: compareState.quotationId,
      key,
      viewId: actionViewId
    });
    compareState.data = response.data;
    compareState.quotationId = response.data?.quotation?.id || compareState.quotationId;
    if (!options.preserveView && (
      (action === 'add-event' && activeView?.scope === 'quotation_only')
      || (action === 'add-quote' && activeView?.scope === 'event_only')
    )) {
      compareState.viewId = 'all';
    }
    if (!options.silent) showNotification('success', 'Comparison updated');
    renderComparePage();
  } catch (error) {
    showNotification('error', error.message || 'Compare action failed');
    throw error;
  }
}

async function compareBulkAction(action) {
  const bulkViewId = compareState.viewId;
  const bulkView = compareActiveSubprojectView();
  const rows = compareRowsAllowedByItemVisibility();
  const targets = rows.filter(row => {
    const quoteQty = financeNumber(row.quotationItem?.quantity);
    const eventQty = financeNumber(row.eventItem?.quantity);
    if (action === 'add-event') return quoteQty > eventQty;
    if (action === 'remove-extra') return eventQty > quoteQty;
    if (action === 'add-quote') return eventQty > quoteQty;
    if (action === 'resolve-mismatch') return row.status === 'qty_mismatch';
    return false;
  });
  const bulkEndpoints = {
    'add-event': 'add-to-event',
    'remove-extra': 'remove-extra',
    'add-quote': 'add-to-quotation'
  };
  if (bulkEndpoints[action] && targets.length) {
    try {
      const response = await apiCall(`/api/finance/compare/${compareState.eventId}/${bulkEndpoints[action]}`, 'POST', {
        quotationId: compareState.quotationId,
        keys: targets.map(row => row.key),
        viewId: bulkViewId
      });
      compareState.data = response.data;
      compareState.quotationId = response.data?.quotation?.id || compareState.quotationId;
      if (
        (action === 'add-quote' && bulkView?.scope === 'event_only')
        || (action === 'add-event' && bulkView?.scope === 'quotation_only')
      ) {
        compareState.viewId = 'all';
      }
      renderComparePage();
      const actionLabel = action === 'add-quote'
        ? 'added to quotation'
        : action === 'add-event'
          ? 'added to event'
          : 'removed from event';
      showNotification('success', `${targets.length} item${targets.length === 1 ? '' : 's'} ${actionLabel}`);
    } catch (error) {
      showNotification('error', error.message || 'Compare action failed');
    }
    return;
  }
  if (action === 'resolve-mismatch' && targets.length) {
    const additions = targets.filter(row => financeNumber(row.quotationItem?.quantity) > financeNumber(row.eventItem?.quantity));
    const removals = targets.filter(row => financeNumber(row.eventItem?.quantity) > financeNumber(row.quotationItem?.quantity));
    try {
      let response = null;
      for (const [endpoint, actionRows] of [['add-to-event', additions], ['remove-extra', removals]]) {
        if (!actionRows.length) continue;
        response = await apiCall(`/api/finance/compare/${compareState.eventId}/${endpoint}`, 'POST', {
          quotationId: compareState.quotationId,
          keys: actionRows.map(row => row.key),
          viewId: bulkViewId
        });
        compareState.data = response.data;
        compareState.quotationId = response.data?.quotation?.id || compareState.quotationId;
      }
      renderComparePage();
      showNotification('success', `${targets.length} quantit${targets.length === 1 ? 'y' : 'ies'} resolved`);
    } catch (error) {
      showNotification('error', error.message || 'Compare action failed');
    }
    return;
  }
}
