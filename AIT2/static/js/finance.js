const FINANCE_STATUSES = ['draft', 'sent', 'accepted', 'cancelled', 'invoiced', 'overdue', 'paid'];
const FINANCE_UOMS = [
  { value: 'units', label: 'unit(s)' },
  { value: 'pax', label: 'pax' },
  { value: 'lot', label: 'lot' },
  { value: 'sqm', label: 'sqm' }
];
const FINANCE_SALUTATIONS = ['', 'Mr.', 'Ms.', 'Mrs.', 'Mdm.'];
const FINANCE_VALIDITY_UNITS = [
  { value: 'days', label: 'day(s)', multiplier: 1 },
  { value: 'weeks', label: 'week(s)', multiplier: 7 },
  { value: 'months', label: 'month(s)', multiplier: 30 }
];

const financeState = {
  documents: [],
  current: null,
  clients: [],
  events: [],
  salespeople: [],
  catalog: [],
  departments: ['Manpower', 'Transportation'],
  saveTimer: null,
  catalogTimer: null,
  catalogRequestSeq: 0,
  catalogCache: {},
  catalogAbortController: null,
  catalogQuery: '',
  listTimer: null,
  changeVersion: 0,
  statusTargetId: '',
  eventPairTargetId: '',
  addDepartment: '',
  collapsedDepartments: {},
  dragLineIndex: null,
  dragDepartment: '',
  snapshotMode: false,
  activeSubprojectId: 'main',
  rateCard: [],
  rateCardSearch: '',
  rateCardUom: 'units',
  newClientSalutation: '',
  editorDataLoadedAt: 0,
  mineOnly: true
};

const profitLossState = {
  events: [],
  eventId: null,
  data: null,
  loading: false,
  commissionDraft: [],
  editingExpenseId: ''
};

const compareState = {
  events: [],
  eventId: null,
  quotationId: '',
  data: null,
  search: '',
  filter: 'all',
  showMisc: false,
  showLoans: true,
  loading: false
};

function financeMeta() {
  return { singular: 'Quotation', plural: 'Quotations', endpoint: '/api/quotations', section: 'quotations' };
}

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

function financeShowSalespersonSuggestions(value = '') {
  const results = document.getElementById('financeSalespersonResults');
  if (!results) return;
  const query = String(value || '').trim().toLowerCase();
  const options = (financeState.salespeople || []).filter(user => !query || [
    user.name, user.username, user.phone
  ].some(field => String(field || '').toLowerCase().includes(query))).slice(0, 8);
  results.innerHTML = options.map(user => `
    <button type="button" onmousedown="event.preventDefault();financeChooseSalesperson('${financeEscapeAttr(encodeURIComponent(user.username))}')">
      <strong>${financeEscape(user.name || user.username)}</strong>
      <small>${financeEscape([user.username, user.phone].filter(Boolean).join(' · '))}</small>
    </button>
  `).join('');
  results.classList.toggle('open', options.length > 0);
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

function financeAdditionalScheduleRows(kind, document = financeState.current) {
  const key = {
    setup: 'additionalSetups',
    rehearsal: 'additionalRehearsals',
    show: 'additionalShows',
    teardown: 'additionalTeardowns'
  }[kind];
  return Array.isArray(document?.[key]) ? document[key] : [];
}

function financeAddScheduleRow(kind) {
  if (!financeState.current || !['setup', 'rehearsal', 'show', 'teardown'].includes(kind)) return;
  const key = {
    setup: 'additionalSetups',
    rehearsal: 'additionalRehearsals',
    show: 'additionalShows',
    teardown: 'additionalTeardowns'
  }[kind];
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
}

function financeRemoveScheduleRow(kind, index) {
  const key = {
    setup: 'additionalSetups',
    rehearsal: 'additionalRehearsals',
    show: 'additionalShows',
    teardown: 'additionalTeardowns'
  }[kind];
  if (!financeState.current || !Array.isArray(financeState.current[key])) return;
  financeState.current[key].splice(index, 1);
  financeQueueSave();
  financeRenderEditor();
}

function financeSchedulePair(label, key) {
  const document = financeState.current || {};
  return `
    <div class="finance-schedule-pair">
      <strong>${financeEscape(label)}</strong>
      <input class="finance-input" type="date" value="${financeEscapeAttr(document[`${key}Date`] || '')}" onchange="financeScheduleChange('${key}Date',this.value)">
      <input class="finance-input" type="time" value="${financeEscapeAttr(document[`${key}Time`] || '')}" onchange="financeScheduleChange('${key}Time',this.value)">
    </div>
  `;
}

function financeAdditionalSchedulePair(kind, row, index) {
  const baseLabel = {
    setup: 'Set-up',
    rehearsal: 'Rehearsal',
    show: 'Show',
    teardown: 'Teardown'
  }[kind] || kind;
  const label = `${baseLabel} ${index + 2}`;
  return `
    <div class="finance-schedule-pair finance-schedule-extra">
      <strong>${financeEscape(label)}</strong>
      <input class="finance-input" type="date" value="${financeEscapeAttr(row.date || '')}" onchange="financeAdditionalScheduleChange('${kind}',${index},'date',this.value)">
      <input class="finance-input" type="time" value="${financeEscapeAttr(row.time || '')}" onchange="financeAdditionalScheduleChange('${kind}',${index},'time',this.value)">
      <button type="button" class="finance-schedule-remove" title="Remove ${financeEscapeAttr(label)}" aria-label="Remove ${financeEscapeAttr(label)}" onclick="financeRemoveScheduleRow('${kind}',${index})">&times;</button>
    </div>
  `;
}

function financePercent(value, fallback = 0) {
  return Math.max(-9999, Math.min(100, financeNumber(value, fallback)));
}

function financeLineTotal(line) {
  const gross = financeNumber(line.quantity, 1) * financeNumber(line.days, 1) * financeNumber(line.unitPrice);
  return Math.round(gross * (1 - financeNumber(line.discountPercent) / 100) * 100) / 100;
}

function financeDefaultSystemName(department) {
  const value = String(department || '').trim();
  if (!value) return 'Unknown System';
  const base = value.replace(/\s+(department|system)$/i, '').trim();
  if (base.toLowerCase() === 'manpower') return 'Manpower';
  if (['transport', 'transportation'].includes(base.toLowerCase())) return 'Transportation';
  return base ? `${base} System` : 'Unknown System';
}

function financeLineSystem(line) {
  return String(line?.systemName || '').trim() || financeDefaultSystemName(line?.department);
}

function financeRecalculateAdjustments(document) {
  const lines = document?.lineItems || [];
  const adjustments = document?.adjustments || [];
  adjustments.filter(row => row.scope === 'department').forEach(row => {
    if ((row.calculationMode || 'percent') !== 'percent') return;
    const percent = Math.max(0, financeNumber(row.percent));
    if (!percent) return;
    const base = lines
      .filter(line => financeLineSystem(line) === row.department)
      .reduce((sum, line) => sum + financeLineTotal(line), 0);
    row.amount = Math.round(base * percent / 100 * (row.kind === 'discount' ? -1 : 1) * 100) / 100;
  });
}

function financeTotals(document = financeState.current) {
  const lines = document?.lineItems || [];
  lines.forEach(line => { line.total = financeLineTotal(line); });
  financeRecalculateAdjustments(document);
  financeApplyLockedTotalAdjustment(document);
  const subtotal = Math.round(lines.reduce((sum, line) => sum + financeNumber(line.total), 0) * 100) / 100;
  const adjustmentTotal = Math.round((document?.adjustments || []).reduce((sum, row) => sum + financeNumber(row.amount), 0) * 100) / 100;
  const netSubtotal = Math.round((subtotal + adjustmentTotal) * 100) / 100;
  const tax = Math.round(Math.max(0, netSubtotal) * financeNumber(document?.taxRate) / 100 * 100) / 100;
  const lockedPreTax = document?.totalLocked ? financeNumber(document.lockedPreTaxTotal, netSubtotal) : null;
  return {
    subtotal,
    adjustmentTotal,
    discount: Math.round((document?.adjustments || []).reduce((sum, row) => sum + Math.abs(Math.min(0, financeNumber(row.amount))), 0) * 100) / 100,
    netSubtotal,
    lockedPreTax,
    lockDifference: lockedPreTax === null ? 0 : Math.round((netSubtotal - lockedPreTax) * 100) / 100,
    tax,
    total: Math.round((netSubtotal + tax) * 100) / 100
  };
}

function financeEventDays(document = financeState.current) {
  const setupDates = [
    document?.setupDate,
    ...financeAdditionalScheduleRows('setup', document).map(row => row.date)
  ].filter(Boolean).sort();
  const teardownDates = [
    document?.teardownDate,
    ...financeAdditionalScheduleRows('teardown', document).map(row => row.date)
  ].filter(Boolean).sort();
  if (!setupDates.length || !teardownDates.length) return 1;
  const start = new Date(`${setupDates[0]}T00:00:00`);
  const end = new Date(`${teardownDates[teardownDates.length - 1]}T00:00:00`);
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

function financeActiveDepartments(document = financeState.current, subprojectId = financeCurrentSubprojectId(document)) {
  const departments = [];
  (document?.lineItems || []).forEach(line => {
    if (String(line.subprojectId || 'main') !== String(subprojectId || 'main')) return;
    const department = financeLineSystem(line);
    if (!departments.includes(department)) departments.push(department);
  });
  return departments;
}

function financeSyncDocumentDepartments(document = financeState.current) {
  if (!document) return [];
  (document.lineItems || []).forEach(line => {
    line.department = String(line.department || 'Unknown Department').trim() || 'Unknown Department';
    line.systemName = financeLineSystem(line);
    line.subprojectId = line.subprojectId || financeSubprojects(document)[0]?.id || 'main';
  });
  const departments = [...new Set((document.lineItems || []).map(line => financeLineSystem(line)))];
  document.departments = departments;
  const active = new Set((document.lineItems || []).map(line => `${line.subprojectId || 'main'}::${financeLineSystem(line)}`));
  document.adjustments = (document.adjustments || []).filter(row => (
    row.scope !== 'department'
    || active.has(`${row.subprojectId || 'main'}::${row.department}`)
  ));
  return departments;
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
  const subtotal = Math.round((document.lineItems || []).reduce((sum, line) => sum + financeLineTotal(line), 0) * 100) / 100;
  const adjustmentBase = Math.round((subtotal + unlockedAdjustments.reduce((sum, row) => sum + financeNumber(row.amount), 0)) * 100) / 100;
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

function financeDepartmentCollapseKey(department, document = financeState.current) {
  return `${document?.id || 'current'}::${financeCurrentSubprojectId(document)}::${department}`;
}

function financeIsDepartmentCollapsed(department) {
  return !!financeState.collapsedDepartments[financeDepartmentCollapseKey(department)];
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
  const rawDates = [
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

  const groups = [];
  dates.forEach(value => {
    const group = groups[groups.length - 1];
    const previous = group?.[group.length - 1];
    if (previous && value.getTime() - previous.getTime() === 86400000) group.push(value);
    else groups.push([value]);
  });

  const month = value => value.toLocaleDateString('en-SG', { month: 'short', timeZone: 'UTC' });
  return groups.map(group => {
    const start = group[0];
    const end = group[group.length - 1];
    if (start.getTime() === end.getTime()) {
      return `${start.getUTCDate()} ${month(start)} ${start.getUTCFullYear()}`;
    }
    if (start.getUTCFullYear() === end.getUTCFullYear() && start.getUTCMonth() === end.getUTCMonth()) {
      return `${start.getUTCDate()}-${end.getUTCDate()} ${month(end)} ${end.getUTCFullYear()}`;
    }
    if (start.getUTCFullYear() === end.getUTCFullYear()) {
      return `${start.getUTCDate()} ${month(start)}-${end.getUTCDate()} ${month(end)} ${end.getUTCFullYear()}`;
    }
    return `${start.getUTCDate()} ${month(start)} ${start.getUTCFullYear()}-${end.getUTCDate()} ${month(end)} ${end.getUTCFullYear()}`;
  }).join(', ');
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

function financePaymentTermDays(value, fallback = 30) {
  const text = String(value || '').trim().toLowerCase();
  if (/(due on receipt|on receipt|immediate|\bcod\b)/.test(text)) return 0;
  const match = text.match(/\b(\d{1,4})\b/);
  if (!match) return Math.max(0, financeNumber(fallback, 30));
  const amount = Math.max(0, Math.min(3650, financeNumber(match[1], fallback)));
  if (text.includes('week')) return Math.min(3650, amount * 7);
  if (text.includes('month')) return Math.min(3650, amount * 30);
  return amount;
}

function financePaymentTermSummary(value, days) {
  const text = String(value || '').trim().toLowerCase();
  if (/(due on receipt|on receipt|immediate|\bcod\b)/.test(text)) return 'Due on receipt';
  const match = text.match(/\b(\d{1,4})\b/);
  if (!match) return `${days} day${days === 1 ? '' : 's'}`;
  const amount = Math.max(0, financeNumber(match[1], 0));
  const unit = text.includes('month') ? 'month' : text.includes('week') ? 'week' : 'day';
  const term = `${amount} ${unit}${amount === 1 ? '' : 's'}`;
  return unit === 'day' ? term : `${term} (${days} days)`;
}

function financePaymentDueDisplay(sentDate, days) {
  const match = String(sentDate || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return '';
  const due = new Date(Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]) + days
  ));
  if (Number.isNaN(due.getTime())) return '';
  return new Intl.DateTimeFormat('en-SG', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC'
  }).format(due);
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

function financeValiditySummary(document) {
  if (!document?.sentAt) return 'Not sent';
  const sent = financeDateOnly(document.sentAt);
  return `Sent ${sent || '—'} · ${financeValidityCountdown(document)}`;
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

function financeToggleMenu(menuId, event) {
  event?.stopPropagation();
  const target = document.getElementById(menuId);
  if (!target) return;
  const open = !target.classList.contains('open');
  document.querySelectorAll('.finance-custom-menu.open').forEach(menu => {
    menu.classList.remove('open', 'open-up');
  });
  if (!open) return;
  target.classList.add('open');
  const scrollContainer = target.closest('.finance-lines-scroll');
  const control = target.closest('.finance-custom-control');
  if (!scrollContainer || !control) return;
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
  document.querySelectorAll('.finance-custom-menu.open').forEach(menu => {
    menu.classList.remove('open', 'open-up');
  });
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
  return ['accepted', 'cancelled', 'invoiced', 'overdue', 'paid'].includes(String(document?.status || '').toLowerCase());
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
    ['quotations-section', '<div id="quotations-page-root" class="finance-page"><div class="loading">Loading...</div></div>'],
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
  const sidebar = document.getElementById('appSidebar');
  if (!sidebar) return;
  const existing = sidebar.querySelector('[data-finance-navigation="true"]');
  if (existing) return;
  const section = document.createElement('div');
  section.className = 'nav-section';
  section.dataset.financeNavigation = 'true';
  section.innerHTML = `
    <h3>Finance</h3>
    ${canUseFinance ? '<button type="button" class="nav-item" data-section="quotations">Quotations</button>' : ''}
    <button type="button" class="nav-item" data-section="profit-loss">Profit &amp; Loss</button>
    ${typeof isPlatformAdminUser === 'function' && isPlatformAdminUser() ? '<button type="button" class="nav-item platform-admin-only" data-section="accounting">Accounting</button>' : ''}
  `;
  const reports = Array.from(sidebar.querySelectorAll('.nav-section')).find(row => row.querySelector('h3')?.textContent.trim() === 'Reports');
  const settings = Array.from(sidebar.querySelectorAll('.nav-section')).find(row => row.querySelector('h3')?.textContent.trim() === 'Settings');
  sidebar.insertBefore(section, reports || settings || null);
  if (typeof setupSidebarNavigation === 'function') setupSidebarNavigation();
}

function financeRoot() {
  return document.getElementById('quotations-page-root');
}

function profitLossRoot() {
  return document.getElementById('profit-loss-page-root');
}

function compareRoot() {
  return document.getElementById('compare-page-root');
}

async function loadQuotations() {
  financeState.current = null;
  financeState.eventPairTargetId = '';
  return financeLoadList();
}

async function financeLoadList(query = '') {
  const root = financeRoot();
  if (!root) return;
  root.innerHTML = '<div class="loading">Loading quotations...</div>';
  try {
    const params = new URLSearchParams();
    if (query) params.set('query', query);
    if (financeListCanToggleMine() && financeState.mineOnly) params.set('mine', '1');
    const queryString = params.toString();
    const response = await apiCall(`/api/quotations${queryString ? `?${queryString}` : ''}`);
    financeState.documents = response.data || [];
    financeRenderList(query);
  } catch (error) {
    root.innerHTML = '<div class="finance-empty">Could not load quotations.</div>';
    showNotification('error', error.message || 'Failed to load quotations');
  }
}

function financeListShowsSalesperson() {
  const role = typeof currentUserRole === 'function'
    ? currentUserRole()
    : String(window.currentUser?.role || '').toLowerCase();
  return role === 'admin';
}

function financeListCanToggleMine() {
  const role = typeof currentUserRole === 'function'
    ? currentUserRole()
    : String(window.currentUser?.role || '').toLowerCase();
  return role === 'admin';
}

function financeToggleMineOnly() {
  financeState.mineOnly = !financeState.mineOnly;
  financeLoadList(document.querySelector('.finance-search')?.value || '');
}

function financePairedEventStatus(document) {
  const eventId = Number(document?.eventId || 0);
  const pairTargetId = financeEscapeAttr(document?.id || '');
  if (!eventId) {
    return `<button type="button" class="finance-event-cell-action is-unpaired" onclick="financeHandleQuotationEventClick(event,'${pairTargetId}',0)">Pair event</button>`;
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

function financeRenderListRow(document, showSalesperson = financeListShowsSalesperson()) {
  const client = document.client || {};
  const total = document.totals?.total ?? financeTotals(document).total;
  const dateSummary = financeListDateSummary(document);
  const eventDates = financeEventDateSummary(document);
  return `
    <tr class="finance-list-row ${document.status === 'cancelled' ? 'is-cancelled' : ''}" data-document-id="${financeEscapeAttr(document.id)}" onclick="financeOpenDocument('${financeEscapeAttr(document.id)}')">
      <td><span class="finance-doc-number">${financeEscape(document.number)}</span><br><small>Ver ${String(document.revision || 1).padStart(2, '0')}</small>${document.invoiceNumber ? `<br><small class="finance-linked-invoice">Invoice ${financeEscape(document.invoiceNumber)}</small>` : ''}</td>
      <td><strong>${financeEscape(financeClientName(client) || client.contactPerson || 'No client')}</strong><br><small>${financeEscape(client.company || client.email || '')}</small></td>
      <td class="finance-project-cell"><strong>${financeEscape(document.projectName || 'Project name required')}</strong>${eventDates ? `<small class="finance-project-dates">${financeEscape(eventDates)}</small>` : ''}</td>
      ${showSalesperson ? `<td><strong>${financeEscape(document.salesperson || document.createdByName || document.createdBy || 'Unassigned')}</strong>${document.salespersonUsername || document.createdBy ? `<br><small>${financeEscape(document.salespersonUsername || document.createdBy)}</small>` : ''}</td>` : ''}
      <td>${financePairedEventStatus(document)}</td>
      <td><span>${financeEscape(dateSummary.label)}${dateSummary.date ? ` ${financeEscape(dateSummary.date)}` : ''}</span>${dateSummary.detail ? `<br><small>${financeEscape(dateSummary.detail)}</small>` : ''}</td>
      <td>${financeSnapshotControl(document)}</td>
      <td class="finance-list-status-cell"><div class="finance-list-status-actions">${financeStatusControl(document, 'list')}</div></td>
      <td class="finance-list-export-cell"><div class="finance-list-export-action">${financeExportQuotationButton(document)}${financeExportInvoiceButton(document)}</div></td>
      <td style="text-align:right;font-weight:750;">${financeEscape(financeMoney(total))}</td>
    </tr>
  `;
}

function financeUpdateListRow(updated) {
  const index = financeState.documents.findIndex(row => row.id === updated.id);
  const merged = index >= 0
    ? { ...financeState.documents[index], ...updated }
    : updated;
  if (index >= 0) financeState.documents[index] = merged;
  const currentRow = Array.from(financeRoot()?.querySelectorAll('.finance-list-row') || [])
    .find(row => row.dataset.documentId === String(updated.id));
  if (currentRow) currentRow.outerHTML = financeRenderListRow(merged);
}

function financeRenderList(query = '') {
  const root = financeRoot();
  if (!root) return;
  const showSalesperson = financeListShowsSalesperson();
  const showMineToggle = financeListCanToggleMine();
  const rows = financeState.documents.map(document => financeRenderListRow(document, showSalesperson)).join('');
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
            ><span aria-hidden="true"></span>My quotations</button>
          ` : ''}
        </div>
        <p class="finance-subtitle">Your quotations, versions and client approvals.</p>
      </div>
      <div class="finance-toolbar-actions">
        <input class="finance-search" type="search" value="${financeEscapeAttr(query)}" placeholder="Search quotations..." oninput="financeQueueListSearch(this.value)">
        <button type="button" class="btn btn-primary" onclick="financeCreateDocument()">+ New Quotation</button>
      </div>
    </div>
    <div class="finance-card">
      ${rows ? `
        <table class="finance-list-table">
          <thead><tr><th>Number</th><th>Bill to</th><th>Project Name</th>${showSalesperson ? '<th>Salesperson</th>' : ''}<th>Event status</th><th>Date</th><th>Versions</th><th class="finance-list-status-heading">Status</th><th class="finance-list-export-heading">Export</th><th style="text-align:right;">Total</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      ` : '<div class="finance-empty">No quotations yet.<br><button type="button" class="btn btn-primary" style="margin-top:14px;" onclick="financeCreateDocument()">Create the first quotation</button></div>'}
    </div>
  `;
}

function financeQueueListSearch(query) {
  clearTimeout(financeState.listTimer);
  financeState.listTimer = setTimeout(() => financeLoadList(query), 280);
}

async function financeLoadEditorData(force = false) {
  if (!force && financeState.editorDataLoadedAt && Date.now() - financeState.editorDataLoadedAt < 30000) return;
  const [clientsResponse, departmentsResponse, eventsResponse, salespeopleResponse] = await Promise.all([
    apiCall('/api/clients').catch(() => ({ data: [] })),
    apiCall('/api/finance/departments').catch(() => ({ data: ['Manpower', 'Transportation'] })),
    apiCall('/api/events?view=summary&limit=500').catch(() => ({ data: [] })),
    apiCall('/api/finance/salespeople').catch(() => ({ data: [] }))
  ]);
  financeState.clients = clientsResponse.data || [];
  financeState.departments = departmentsResponse.data || ['Manpower', 'Transportation'];
  financeState.events = eventsResponse.data || [];
  financeState.salespeople = salespeopleResponse.data || [];
  financeState.editorDataLoadedAt = Date.now();
}

async function financeCreateDocument() {
  try {
    const response = await apiCall('/api/quotations', 'POST', {});
    financeState.current = response.data;
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
    financeState.eventPairTargetId = financeState.current.id;
    financeState.activeSubprojectId = financeSubprojects(financeState.current)[0]?.id || 'main';
    financeState.snapshotMode = false;
    financeState.addDepartment = '';
    const refreshedDraftDate = financeRefreshDraftDate();
    financeRenderEditor();
    if (refreshedDraftDate) financeQueueSave();
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
  const documentRow = financeState.current?.id === documentId
    ? financeState.current
    : financeState.documents.find(row => row.id === documentId);
  const snapshotRow = (documentRow?.revisions || []).find(row => Number(row.revision) === Number(revision));
  if (!documentRow || !snapshotRow?.snapshot) return;
  const confirmed = await showAppConfirm({
    title: 'Edit saved version?',
    message: `${snapshotRow.number || `Version ${revision}`} has already been saved as a quotation version. Changes will update this version and its archived PDF directly without creating a new version.`,
    confirmText: 'Edit Version',
    cancelText: 'Cancel'
  });
  if (!confirmed) return;
  financeState.current = {
    ...snapshotRow.snapshot,
    id: documentRow.id,
    type: documentRow.type,
    number: snapshotRow.number || snapshotRow.snapshot.number,
    revision: snapshotRow.revision,
    status: 'sent',
    sentAt: snapshotRow.sentAt || '',
    validUntil: snapshotRow.validUntil || snapshotRow.snapshot.validUntil || '',
    validityAmount: snapshotRow.validityAmount || snapshotRow.snapshot.validityAmount || '',
    validityUnit: snapshotRow.validityUnit || snapshotRow.snapshot.validityUnit || 'days',
    validityDays: snapshotRow.validityDays || snapshotRow.snapshot.validityDays || 30,
    revisions: documentRow.revisions || [],
    totals: snapshotRow.snapshot.totals || financeTotals(snapshotRow.snapshot)
  };
  financeState.activeSubprojectId = financeSubprojects(financeState.current)[0]?.id || 'main';
  financeState.snapshotMode = false;
  financeState.addDepartment = '';
  financeState.current._editingSentRevision = Number(snapshotRow.revision) || 1;
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
      `/api/quotations/${encodeURIComponent(documentId)}/revisions/${encodeURIComponent(revision)}`,
      'DELETE'
    );
    if (financeState.current?.id === documentId) {
      financeState.current = response.data;
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
  clearTimeout(financeState.saveTimer);
  const confirmed = await showAppConfirm({
    title: 'Discard draft changes?',
    message: `Discard version ${String(current.revision || 1).padStart(2, '0')} and restore the previous sent version? All changes in this draft will be lost.`,
    confirmText: 'Discard Changes',
    cancelText: 'Keep Editing',
    danger: true
  });
  if (!confirmed) return;
  try {
    const response = await apiCall(`/api/quotations/${encodeURIComponent(current.id)}/discard-revision`, 'POST', {});
    financeState.current = response.data;
    financeState.snapshotMode = false;
    financeRenderEditor();
    showNotification('success', `Draft discarded. ${response.data.number} has been restored.`);
  } catch (error) {
    showNotification('error', error.message || 'Failed to discard draft changes');
  }
}

function financeClientDisplay(client) {
  return financeClientName(client) || client?.contactPerson || client?.company || '';
}

function financeFilterClients(query) {
  const clean = String(query || '').trim().toLowerCase();
  return financeState.clients.filter(client => !clean || [
    client.name, client.company, client.contactPerson, client.email, client.phone
  ].some(value => String(value || '').toLowerCase().includes(clean))).slice(0, 12);
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

function financeShowClientSuggestions(query = '') {
  const results = document.getElementById('financeClientResults');
  if (!results) return;
  const rows = financeFilterClients(query);
  results.innerHTML = rows.map(client => `
    <button type="button" class="finance-client-option" onclick="financeApplySavedClient('${financeEscapeAttr(encodeURIComponent(client.name))}')">
      <strong>${financeEscape(financeClientName(client) || client.contactPerson || client.company)}</strong>
      <span>${financeEscape(client.company || client.email || client.phone || '')}</span>
    </button>
  `).join('') || '<div class="finance-suggestion-empty">No matching clients</div>';
  results.classList.add('open');
}

function financeApplySavedClient(encodedName) {
  const name = decodeURIComponent(encodedName);
  const client = financeState.clients.find(row => row.name === name);
  if (!client || !financeState.current) return;
  financeState.current.client = { ...client };
  financeQueueSave();
  financeRenderEditor();
}

function financeApplySavedClientByIndex(index) {
  const client = financeState.clients[Number(index)];
  if (!client || !financeState.current) return;
  financeState.current.client = { ...client };
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

function financeFilterEvents(query) {
  const clean = String(query || '').trim().toLowerCase();
  return (financeState.events || []).filter(event => !clean || [
    event.id, event.name, event.location, event.state, event.startDate, event.endDate
  ].some(value => String(value || '').toLowerCase().includes(clean))).slice(0, 12);
}

function financeEventRows(query) {
  const clean = String(query || '').trim().toLowerCase();
  return (financeState.events || [])
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => !clean || [
      event.id, event.name, event.location, event.state, event.startDate, event.endDate
    ].some(value => String(value || '').toLowerCase().includes(clean)))
    .slice(0, 60);
}

function financeEnsureEventPickerModal() {
  if (document.getElementById('financeEventPickerModal')) return;
  const modal = document.createElement('div');
  modal.id = 'financeEventPickerModal';
  modal.className = 'modal';
  modal.innerHTML = `
    <div class="modal-content finance-picker-modal">
      <div class="modal-header"><h3 class="modal-title">Pair existing event</h3><button type="button" class="close-btn" onclick="closeModal('financeEventPickerModal')">×</button></div>
      <input id="financeEventPickerSearch" class="finance-input" placeholder="Search events by name, location, date or status..." autocomplete="off" oninput="financeRenderEventPickerResults(this.value)">
      <div id="financeEventPickerResults" class="finance-picker-results"></div>
      <div class="modal-actions finance-picker-actions">
        <button type="button" class="btn btn-secondary" onclick="closeModal('financeEventPickerModal')">Cancel</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
}

function financeRenderEventPickerResults(query = '') {
  const results = document.getElementById('financeEventPickerResults');
  if (!results) return;
  const rows = financeEventRows(query);
  results.innerHTML = rows.map(({ event }) => `
    <button type="button" class="finance-picker-option" onclick="financePairEvent(${Number(event.id) || 0})">
      <strong>${financeEscape(financeEventDisplay(event.id))}</strong>
      <span>${financeEscape([event.startDate, event.endDate, event.state].filter(Boolean).join(' · '))}</span>
    </button>
  `).join('') || '<div class="finance-suggestion-empty">No matching events</div>';
}

async function financeOpenEventPicker(documentId = financeState.current?.id) {
  financeState.eventPairTargetId = String(documentId || '');
  try {
    await financeLoadEditorData();
  } catch (error) {
    showNotification('error', error.message || 'Unable to load events');
    return;
  }
  financeEnsureEventPickerModal();
  const search = document.getElementById('financeEventPickerSearch');
  if (search) search.value = '';
  financeRenderEventPickerResults('');
  openModal('financeEventPickerModal');
  setTimeout(() => search?.focus(), 50);
}

function financeShowEventSuggestions(query = '') {
  const results = document.getElementById('financeEventResults');
  if (!results) return;
  const rows = financeFilterEvents(query);
  results.innerHTML = rows.map(event => `
    <button type="button" class="finance-client-option" onmousedown="event.preventDefault();financePairEvent(${Number(event.id) || 0})">
      <strong>${financeEscape(financeEventDisplay(event.id))}</strong>
      <span>${financeEscape([event.startDate, event.endDate, event.state].filter(Boolean).join(' · '))}</span>
    </button>
  `).join('') || '<div class="finance-suggestion-empty">No matching events</div>';
  results.classList.add('open');
}

async function financePairEvent(eventId) {
  const id = Number(eventId || 0);
  const targetId = String(financeState.eventPairTargetId || financeState.current?.id || '');
  if (!targetId || !id) return;
  if (financeState.current?.id === targetId) {
    financeState.current.eventId = id;
    closeModal('financeEventPickerModal');
    financeQueueSave();
    financeRenderEditor();
    return;
  }

  const selectedEvent = financeFindEvent(id);
  try {
    const response = await apiCall(
      `/api/quotations/${encodeURIComponent(targetId)}`,
      'PUT',
      { eventId: id }
    );
    closeModal('financeEventPickerModal');
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
  const values = [...new Set([
    ...(financeState.departments || []),
    ...financeActiveDepartments(financeState.current),
    'Manpower',
    'Transportation'
  ])];
  return values.filter(value => !clean || value.toLowerCase().includes(clean)).slice(0, 10);
}

function financeShowDepartmentSuggestions(index, query, targetId) {
  const results = document.getElementById(targetId);
  if (!results) return;
  results.innerHTML = financeDepartmentSuggestions(query).map(value => `
    <button type="button" onmousedown="event.preventDefault();financeChooseDepartment(${index},'${financeEscapeAttr(encodeURIComponent(value))}')">${financeEscape(value)}</button>
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
    <button type="button" onmousedown="event.preventDefault();financeChooseAddDepartment('${financeEscapeAttr(encodeURIComponent(value))}')">${financeEscape(value)}</button>
  `).join('');
  results.classList.add('open');
}

function financeChooseAddDepartment(encodedValue) {
  financeState.addDepartment = decodeURIComponent(encodedValue);
  const input = document.getElementById('financeAddDepartmentInput');
  if (input) input.value = financeState.addDepartment;
  document.getElementById('financeAddDepartmentResults')?.classList.remove('open');
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
        <td colspan="3"><input class="finance-adjustment-label" value="${financeEscapeAttr(row.label || 'System discount')}" aria-label="Discount name" onchange="financeSetAdjustmentLabel('${financeEscapeAttr(row.id)}',this.value)"></td>
        <td colspan="2"><span class="finance-percent-input finance-adjustment-percent"><input type="number" min="0" max="100" step="0.1" value="${financeEscapeAttr(financeNumber(row.percent).toFixed(2).replace(/\.?0+$/, ''))}" aria-label="System discount percentage" onchange="financeSetDepartmentAdjustmentPercent('${financeEscapeAttr(row.id)}','${financeEscapeAttr(encodeURIComponent(department))}',this.value)"><span>%</span></span></td>
        <td colspan="2"><div class="finance-money-input finance-adjustment-amount"><span>$</span><input type="number" min="0" step="0.01" value="${financeEscapeAttr(Math.abs(financeNumber(row.amount)).toFixed(2))}" aria-label="System discount amount" onchange="financeSetDepartmentAdjustmentAmount('${financeEscapeAttr(row.id)}','${financeEscapeAttr(encodeURIComponent(department))}',this.value)"></div></td>
        <td></td>
        <td><button type="button" class="finance-delete-line" onclick="financeRemoveAdjustment('${financeEscapeAttr(row.id)}')">×</button></td>
      </tr>
    `).join('');
}

function financeTotalAdjustmentRows() {
  return (financeState.current?.adjustments || [])
    .filter(row => row.scope === 'total')
    .map(row => `
      <tr class="finance-adjustment-row finance-total-adjustment-row">
        <td></td><td colspan="7">${financeEscape(row.label || 'Total adjustment')}</td>
        <td style="text-align:right;">${financeEscape(financeMoney(row.amount))}</td>
        <td></td>
      </tr>
    `).join('');
}

function financeRenderLineGroups() {
  const document = financeState.current;
  const subprojectId = financeCurrentSubprojectId(document);
  const showLineNumbers = document?.showLineNumbers !== false;
  const configured = financeActiveDepartments(document);
  if (!configured.length) {
    return `
      <tr class="finance-empty-department">
        <td colspan="10">No line items yet. Add an inventory or custom item below.</td>
      </tr>
      ${financeTotalAdjustmentRows()}
    `;
  }
  let displayIndex = 0;
  return configured.map(department => {
    const rows = (document.lineItems || []).map((line, index) => ({ line, index }))
      .filter(row => financeLineSystem(row.line) === department && (row.line.subprojectId || 'main') === subprojectId);
    const base = rows.reduce((sum, row) => sum + financeLineTotal(row.line), 0);
    const adjustment = (document.adjustments || []).filter(row => row.scope === 'department' && row.department === department && (row.subprojectId || 'main') === subprojectId)
      .reduce((sum, row) => sum + financeNumber(row.amount), 0);
    const subtotal = base + adjustment;
    const encoded = encodeURIComponent(department);
    const collapsed = financeIsDepartmentCollapsed(department);
    const lineRows = rows.map(({ line, index }) => {
      const departmentResultsId = `finance-department-results-${line.id}`;
      const displayNumber = ++displayIndex;
      return `
        <tr class="finance-line-row" data-line-index="${index}"
          ondragover="financeDragLineOver(event,${index})"
          ondragleave="financeDragLineLeave(event)"
          ondrop="financeDropLine(event,${index})"
          ondragend="financeDragLineEnd()">
          <td class="finance-line-number"><span class="finance-drag-handle" draggable="true" title="Drag to reorder" ondragstart="financeDragLineStart(event,${index})" ondragend="financeDragLineEnd()">&#9776;</span>${showLineNumbers ? displayNumber : ''}</td>
          <td><input class="finance-line-input" value="${financeEscapeAttr(line.description)}" aria-label="Description" onchange="financeLineChange(${index},'description',this.value)"></td>
          <td>
            <div class="finance-inline-combobox">
              <input class="finance-line-input" value="${financeEscapeAttr(financeLineSystem(line))}" aria-label="System" autocomplete="off"
                data-finance-department-index="${index}"
                onfocus="financeShowDepartmentSuggestions(${index},this.value,'${departmentResultsId}')"
                oninput="financeShowDepartmentSuggestions(${index},this.value,'${departmentResultsId}')"
                onchange="financeCommitDepartmentInput(${index},this)">
              <div class="finance-inline-suggestions" id="${departmentResultsId}"></div>
            </div>
          </td>
          <td><input class="finance-line-input" type="number" min="0" step="0.5" value="${financeEscapeAttr(line.days)}" aria-label="Days" onchange="financeLineChange(${index},'days',this.value)"></td>
          <td><input class="finance-line-input" type="number" min="0" step="1" value="${financeEscapeAttr(line.quantity)}" aria-label="Quantity" onchange="financeLineChange(${index},'quantity',this.value)"></td>
          <td>${financeUomControl(line, index)}</td>
          <td><div class="finance-money-input finance-line-unit-price-input"><span>$</span><input class="finance-line-input" type="number" min="0" step="0.01" value="${financeEscapeAttr(line.unitPrice)}" aria-label="Unit price" onchange="financeLineChange(${index},'unitPrice',this.value)"></div></td>
          <td><span class="finance-percent-input"><input class="finance-line-input" type="number" min="-9999" max="100" step="0.1" value="${financeEscapeAttr(line.discountPercent || 0)}" aria-label="Discount percentage" onchange="financeLineChange(${index},'discountPercent',this.value)"><span>%</span></span></td>
          <td><div class="finance-money-input finance-line-total-input"><span>$</span><input class="finance-line-input" type="number" min="0" step="0.01" value="${financeEscapeAttr(financeLineTotal(line).toFixed(2))}" aria-label="Line total" onchange="financeSetLineTotal(${index},this.value)"></div></td>
          <td><button type="button" class="finance-delete-line" title="Delete line" onclick="financeDeleteLine(${index})">×</button></td>
        </tr>
      `;
    }).join('');
    return `
      <tr class="finance-department-row ${collapsed ? 'is-collapsed' : ''}"
        ondragover="financeDragDepartmentOver(event,'${financeEscapeAttr(encoded)}')"
        ondragleave="financeDragDepartmentLeave(event)"
        ondrop="financeDropDepartment(event,'${financeEscapeAttr(encoded)}')"
        ondragend="financeDragDepartmentEnd()">
        <td colspan="10">
          <span class="finance-department-drag-handle" draggable="true" title="Drag department" ondragstart="financeDragDepartmentStart(event,'${financeEscapeAttr(encoded)}')" ondragend="financeDragDepartmentEnd()">&#9776;</span>
          <button type="button" class="finance-collapse-button" onclick="financeToggleDepartmentCollapse('${financeEscapeAttr(encoded)}')">${collapsed ? '+' : '-'}</button>
          <span>${financeEscape(department)}</span>
          <button type="button" class="finance-department-rename" title="Rename header" aria-label="Rename ${financeEscapeAttr(department)} header" onclick="financeRenameDepartment('${financeEscapeAttr(encoded)}')">&#9998;</button>
          <small>${rows.length} item${rows.length === 1 ? '' : 's'} · ${financeEscape(financeMoney(subtotal))}</small>
        </td>
      </tr>
      ${collapsed ? '' : `
        ${lineRows}
        ${financeAdjustmentRows(department)}
        <tr class="finance-department-subtotal-row">
          <td></td><td colspan="5">${financeEscape(department)} subtotal</td>
          <td colspan="2">${(document.adjustments || []).some(row => row.scope === 'department' && row.department === department && (row.subprojectId || 'main') === subprojectId) ? '' : `<button type="button" class="finance-add-discount" onclick="financeAddDepartmentDiscount('${financeEscapeAttr(encoded)}')">+ Discount</button>`}</td>
          <td><div class="finance-money-input finance-subtotal-input"><span>$</span><input type="number" step="0.01" value="${subtotal.toFixed(2)}" onchange="financeOverrideDepartmentSubtotal(decodeURIComponent('${encoded}'),this.value)"></div></td><td></td>
        </tr>
      `}
    `;
  }).join('') + financeTotalAdjustmentRows();
}

function financeRenderSubprojectTabs() {
  const activeId = financeCurrentSubprojectId();
  const rows = financeSubprojects();
  return `
    <div class="finance-subproject-tabs" role="tablist" aria-label="Quotation sub-projects">
      ${rows.map(row => `
        <span class="finance-subproject-tab ${row.id === activeId ? 'active' : ''}">
          <button type="button" role="tab" aria-selected="${row.id === activeId}" onclick="financeSelectSubproject('${financeEscapeAttr(row.id)}')">${financeEscape(row.name)}</button>
          <button type="button" class="finance-subproject-edit" title="Rename sub-project" onclick="financeRenameSubproject('${financeEscapeAttr(row.id)}')">&#9998;</button>
          ${rows.length > 1 ? `<button type="button" class="finance-subproject-delete" title="Delete sub-project" onclick="financeDeleteSubproject('${financeEscapeAttr(row.id)}')">&times;</button>` : ''}
        </span>
      `).join('')}
      <button type="button" class="finance-subproject-add" onclick="financeAddSubproject()">+ Sub-project</button>
    </div>
  `;
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
        <div><h3>Rate Card</h3><small>Remembered rates from inventory and custom quotation items</small></div>
        <button type="button" class="close-btn" aria-label="Close rate card" onclick="closeModal('financeRateCardModal')">&times;</button>
      </div>
      <div class="finance-rate-card-toolbar">
        <input id="financeRateCardSearch" class="finance-input" type="search" placeholder="Search assets or departments..." oninput="financeState.rateCardSearch=this.value;financeRenderRateCard()">
        <button type="button" class="btn btn-primary" onclick="financeToggleRateCardForm()">+ Add item</button>
      </div>
      <form id="financeRateCardForm" class="finance-rate-card-form" hidden onsubmit="financeCreateRateCardItem(event)">
        <input id="financeRateCardBrand" class="finance-input finance-rate-card-brand" placeholder="Brand">
        <input id="financeRateCardModel" class="finance-input finance-rate-card-model" placeholder="Model">
        <input id="financeRateCardDescription" class="finance-input finance-rate-card-description" required placeholder="Description">
        <div class="finance-inline-combobox finance-rate-card-department-field">
          <input id="financeRateCardDepartment" class="finance-input" required placeholder="Department" autocomplete="off"
                 oninput="financeShowRateCardDepartmentSuggestions(this.value)" onfocus="financeShowRateCardDepartmentSuggestions(this.value)">
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
  ensureFinanceRateCardModal();
  financeState.rateCardSearch = '';
  document.getElementById('financeRateCardSearch').value = '';
  document.getElementById('financeRateCardResults').innerHTML = '<div class="finance-suggestion-empty">Loading rates...</div>';
  openModal('financeRateCardModal');
  try {
    const response = await apiCall('/api/finance/rate-card');
    financeState.rateCard = response.data || [];
    financeRenderRateCard();
  } catch (error) {
    document.getElementById('financeRateCardResults').innerHTML = `<div class="finance-suggestion-empty">${financeEscape(error.message || 'Unable to load rate card')}</div>`;
  }
}

function financeRenderRateCard() {
  const root = document.getElementById('financeRateCardResults');
  if (!root) return;
  const query = String(financeState.rateCardSearch || '').trim().toLowerCase();
  const filtered = (financeState.rateCard || []).filter(row => !query || [
    financeLineSystem(row), row.department, row.brand, row.model, row.description, ...(row.searchTags || [])
  ].join(' ').toLowerCase().includes(query));
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
          return `
            <div class="finance-rate-card-row">
              <div><strong>${financeEscape(title)}</strong>${detail ? `<small>${financeEscape(detail)}</small>` : ''}</div>
              <label class="finance-money-input"><span>$</span><input type="number" min="0.01" step="0.01" value="${financeEscapeAttr(row.unitPrice)}" aria-label="Rate for ${financeEscapeAttr(title)}" onchange="financeUpdateRateCardItem(${index},this.value)"></label>
              <button type="button" class="btn btn-secondary" onclick="financeAddRateCardItemToQuotation(${index})">Add</button>
              <button type="button" class="finance-rate-card-delete" title="Delete rate card item" aria-label="Delete ${financeEscapeAttr(title)}" onclick="financeDeleteRateCardItem(${index})">&times;</button>
            </div>
          `;
        }).join('')}
      </section>
    `).join('') || '<div class="finance-suggestion-empty">No remembered rates match this search.</div>';
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
    <button type="button" onmousedown="event.preventDefault();financeChooseRateCardDepartment('${financeEscapeAttr(encodeURIComponent(value))}')">${financeEscape(value)}</button>
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
  const response = await apiCall('/api/finance/rate-card', 'POST', item);
  financeState.rateCard = response.data || [];
  financeState.catalogCache = {};
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
    await financeSaveRateCardItem({ ...item, unitPrice: value });
  } catch (error) {
    financeRenderRateCard();
  }
}

async function financeDeleteRateCardItem(index) {
  const item = financeState.rateCard[index];
  if (!item) return;
  const title = [item.brand, item.model].filter(Boolean).join(' ') || item.description;
  const confirmed = await showAppConfirm({
    title: 'Delete rate card item',
    message: `Remove ${title} from the rate card?`,
    confirmText: 'Delete',
    destructive: true
  });
  if (!confirmed) return;
  try {
    const response = await apiCall('/api/finance/rate-card', 'DELETE', item);
    financeState.rateCard = response.data || [];
    financeState.catalogCache = {};
    financeRenderRateCard();
    showNotification('success', 'Rate card item deleted');
  } catch (error) {}
}

function financeAddRateCardItemToQuotation(index) {
  const item = financeState.rateCard[index];
  if (!item || financeState.snapshotMode) return;
  financeAddLineFromCatalog(item);
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
  financeState.current.subprojects = rows.filter(item => item.id !== subprojectId);
  financeState.current.lineItems = (financeState.current.lineItems || []).filter(line => (line.subprojectId || 'main') !== subprojectId);
  financeState.current.adjustments = (financeState.current.adjustments || []).filter(item => (item.subprojectId || 'main') !== subprojectId || item.scope === 'total');
  financeState.activeSubprojectId = financeState.current.subprojects[0].id;
  financeSyncDocumentDepartments();
  financeQueueSave();
  financeRenderEditor();
}

function financeToggleDepartmentCollapse(encodedDepartment) {
  const department = decodeURIComponent(encodedDepartment);
  const key = financeDepartmentCollapseKey(department);
  financeState.collapsedDepartments[key] = !financeState.collapsedDepartments[key];
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
  const oldCollapseKey = financeDepartmentCollapseKey(currentName, document);
  const nextCollapseKey = financeDepartmentCollapseKey(nextName, document);
  if (Object.prototype.hasOwnProperty.call(financeState.collapsedDepartments, oldCollapseKey)) {
    financeState.collapsedDepartments[nextCollapseKey] = financeState.collapsedDepartments[oldCollapseKey];
    delete financeState.collapsedDepartments[oldCollapseKey];
  }
  financeSyncDocumentDepartments(document);
  financeQueueSave();
  financeRenderEditor();
}

function financeDragLineStart(event, index) {
  financeState.dragLineIndex = index;
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', String(index));
  event.currentTarget.closest('.finance-line-row')?.classList.add('dragging');
}

function financeDragLineOver(event, index) {
  if (financeState.dragLineIndex === null || financeState.dragLineIndex === index) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  event.currentTarget.classList.add('drag-over');
}

function financeDragLineLeave(event) {
  event.currentTarget.classList.remove('drag-over');
}

function financeDropLine(event, targetIndex) {
  event.preventDefault();
  const rawSource = event.dataTransfer.getData('text/plain');
  const sourceIndex = rawSource === '' ? financeState.dragLineIndex : financeNumber(rawSource);
  const lines = financeState.current?.lineItems || [];
  if (sourceIndex === null || sourceIndex === undefined || sourceIndex === targetIndex || !lines[sourceIndex] || !lines[targetIndex]) {
    financeDragLineEnd();
    return;
  }
  const [moved] = lines.splice(sourceIndex, 1);
  const adjustedTargetIndex = sourceIndex < targetIndex ? targetIndex - 1 : targetIndex;
  const target = lines[adjustedTargetIndex];
  if (target) moved.systemName = financeLineSystem(target);
  lines.splice(adjustedTargetIndex, 0, moved);
  financeSyncDocumentDepartments();
  financeQueueSave();
  financeRenderEditor();
}

function financeDragLineEnd() {
  financeState.dragLineIndex = null;
  document.querySelectorAll('.finance-line-row.dragging,.finance-line-row.drag-over').forEach(row => {
    row.classList.remove('dragging', 'drag-over');
  });
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
  const targetDepartment = decodeURIComponent(encodedTargetDepartment);
  if (financeState.dragLineIndex !== null) {
    const line = financeState.current?.lineItems?.[financeState.dragLineIndex];
    if (line) {
      line.systemName = targetDepartment;
      line.uom = financeDefaultUom(targetDepartment, line.uom);
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
  const groups = new Map();
  financeActiveDepartments(financeState.current).forEach(department => groups.set(department, []));
  (financeState.current.lineItems || []).forEach(line => {
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
  financeState.current.lineItems = order.flatMap(department => groups.get(department) || []);
  financeSyncDocumentDepartments();
  financeQueueSave();
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

function financeRenderEditor() {
  const root = financeRoot();
  const document = financeState.current;
  if (!root || !document) return;
  root.classList.remove('finance-snapshot-mode');
  financeSyncDocumentDepartments(document);
  const totals = financeTotals(document);
  const client = document.client || {};
  const allDaysMenu = `finance-days-all-${document.id}`;
  const snapshotMode = !!financeState.snapshotMode;
  const editingSentRevision = Number(document._editingSentRevision || 0);
  const validityUnit = financeValidityUnit(document);
  const validityAmount = financeValidityAmount(document);
  const quotationNumber = financeQuotationNumberParts(document.number, document.revision);
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
            <label class="finance-field finance-span-2"><span>Project Name *</span><input class="finance-input" required value="${financeEscapeAttr(document.projectName || '')}" onchange="financeFieldChange('projectName',this.value)"></label>
            <label class="finance-field finance-span-2"><span>Location</span><span class="finance-location-combobox"><input id="financeLocationInput" class="finance-input" value="${financeEscapeAttr(document.eventLocation || '')}" autocomplete="off" onfocus="financeShowLocationSuggestions(this.value)" oninput="financeFieldChange('eventLocation',this.value);financeShowLocationSuggestions(this.value)" onchange="financeFieldChange('eventLocation',this.value)" onblur="setTimeout(() => document.getElementById('financeLocationResults')?.classList.remove('open'),120)"><span class="finance-location-results" id="financeLocationResults"></span></span></label>
            <label class="finance-field"><span>Quotation date</span><input class="finance-input" type="date" value="${financeEscapeAttr(document.quotationDate || '')}" onchange="financeFieldChange('quotationDate',this.value)"></label>
            <label class="finance-field"><span>Valid for</span><span class="finance-validity-control"><input class="finance-input" type="number" min="1" max="365" value="${financeEscapeAttr(validityAmount)}" onchange="financeSetValidityAmount(this.value)">${financeValidityUnitControl(validityUnit, 'finance-editor-validity-unit-menu', 'financeSetValidityUnit')}</span></label>
            <label class="finance-field"><span>PO / reference number</span><input class="finance-input" value="${financeEscapeAttr(document.reference || '')}" onchange="financeFieldChange('reference',this.value)"></label>
            <label class="finance-field"><span>Payment terms</span><input class="finance-input" value="${financeEscapeAttr(document.paymentTerms || '')}" onchange="financeFieldChange('paymentTerms',this.value)"></label>
          </div>
        </section>

        <section class="finance-card finance-section">
          <div class="finance-section-heading"><div><h3>Event schedule</h3><p>Dates are optional. New line items will use ${financeEventDays(document)} day(s).</p></div></div>
          <div class="finance-schedule-grid">
            <div class="finance-schedule-stack">
              ${financeSchedulePair('Set-up', 'setup')}
              ${financeAdditionalScheduleRows('setup', document).map((row, index) => financeAdditionalSchedulePair('setup', row, index)).join('')}
              <button type="button" class="btn btn-secondary finance-schedule-add" onclick="financeAddScheduleRow('setup')">+ Add set-up</button>
            </div>
            <div class="finance-schedule-stack">
              ${financeSchedulePair('Teardown', 'teardown')}
              ${financeAdditionalScheduleRows('teardown', document).map((row, index) => financeAdditionalSchedulePair('teardown', row, index)).join('')}
              <button type="button" class="btn btn-secondary finance-schedule-add" onclick="financeAddScheduleRow('teardown')">+ Add teardown</button>
            </div>
            <div class="finance-schedule-stack">
              ${financeSchedulePair('Rehearsal', 'rehearsal')}
              ${financeAdditionalScheduleRows('rehearsal', document).map((row, index) => financeAdditionalSchedulePair('rehearsal', row, index)).join('')}
              <button type="button" class="btn btn-secondary finance-schedule-add" onclick="financeAddScheduleRow('rehearsal')">+ Add rehearsal</button>
            </div>
            <div class="finance-schedule-stack">
              ${financeSchedulePair('Show', 'show')}
              ${financeAdditionalScheduleRows('show', document).map((row, index) => financeAdditionalSchedulePair('show', row, index)).join('')}
              <button type="button" class="btn btn-secondary finance-schedule-add" onclick="financeAddScheduleRow('show')">+ Add show</button>
            </div>
          </div>
        </section>

        <section class="finance-card finance-lines-card">
          ${financeRenderSubprojectTabs()}
          <div class="finance-section finance-section-heading">
            <div><h3>Line items</h3><p>Department names accept free text and saved suggestions.</p></div>
            <button type="button" class="btn btn-secondary finance-rate-card-button" onclick="financeOpenRateCard()">
              <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="3" width="16" height="18" rx="2"></rect><path d="M8 8h8M8 12h8M8 16h5"></path></svg>
              Show rate card
            </button>
          </div>
          <div class="finance-lines-scroll">
            <table class="finance-lines-table">
              <colgroup><col style="width:44px"><col style="width:350px"><col style="width:120px"><col style="width:72px"><col style="width:72px"><col style="width:88px"><col style="width:112px"><col style="width:84px"><col style="width:116px"><col style="width:36px"></colgroup>
              <thead><tr><th>${document.showLineNumbers === false ? '' : '#'}</th><th>Description</th><th>System</th><th>
                <div class="finance-custom-control finance-header-control">
                  <button type="button" class="finance-header-button" onclick="financeToggleMenu('${allDaysMenu}',event)">Days</button>
                  <div class="finance-custom-menu finance-days-menu" id="${allDaysMenu}">
                    <label>Days value<input id="financeAllDaysValue" class="finance-input" type="number" min="0" step="0.5" value="${financeEventDays(document)}"></label>
                    <button type="button" class="btn btn-primary" onclick="financeApplyAllDays()">Apply to all lines</button>
                  </div>
                </div>
              </th><th>Qty</th><th>UOM</th><th>Unit price</th><th>Disc %</th><th style="text-align:right;">Total</th><th></th></tr></thead>
              <tbody>${financeRenderLineGroups()}</tbody>
            </table>
          </div>
          <div class="finance-add-row finance-add-row-expanded">
            <div class="finance-add-item-wrap">
              <input id="financeAddItemInput" class="finance-input" placeholder="Search inventory or previously used custom items..." autocomplete="off" oninput="financeSearchCatalog(this.value)" onkeydown="financeAddItemKeydown(event)">
              <div id="financeCatalogResults" class="finance-catalog-results"></div>
            </div>
            <div class="finance-inline-combobox">
              <input id="financeAddDepartmentInput" class="finance-input" value="${financeEscapeAttr(financeState.addDepartment)}" placeholder="Department" autocomplete="off" oninput="financeState.addDepartment=this.value;financeShowAddDepartmentSuggestions(this.value)" onfocus="financeShowAddDepartmentSuggestions(this.value)">
              <div class="finance-inline-suggestions" id="financeAddDepartmentResults"></div>
            </div>
            <button type="button" class="btn btn-primary" onclick="financeAddCustomItem()">+ Add</button>
          </div>
        </section>

        <section class="finance-card finance-section">
          <h3>Notes &amp; terms</h3>
          <label class="finance-field"><span>Notes</span><textarea class="finance-textarea" rows="3" onchange="financeFieldChange('notes',this.value)">${financeEscape(document.notes || '')}</textarea></label>
          <label class="finance-field" style="margin-top:12px;"><span>Terms and conditions</span><textarea class="finance-textarea" rows="7" onchange="financeFieldChange('terms',this.value)">${financeEscape(document.terms || '')}</textarea></label>
        </section>
      </div>

      <aside class="finance-side-column">
        <section class="finance-card finance-section">
          <h3>Quotation summary</h3>
          <div class="finance-summary-row"><span>Items before adjustments</span><strong>${financeEscape(financeMoney(totals.subtotal))}</strong></div>
          ${totals.discount ? `<div class="finance-summary-row"><span>Discounts</span><strong class="finance-negative">${financeEscape(financeMoney(-totals.discount))}</strong></div>` : ''}
          <div class="finance-summary-row finance-pre-tax-row">
            <span>${document.totalLocked ? `<input class="finance-total-discount-label" value="${financeEscapeAttr(document.totalDiscountLabel || 'Total discount')}" aria-label="Total discount name" onchange="financeSetTotalDiscountLabel(this.value)">` : 'Total before GST'}</span>
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
            <div class="finance-money-input finance-tax-amount-input"><span>$</span><input type="number" min="0" step="0.01" value="${financeEscapeAttr(totals.tax.toFixed(2))}" aria-label="GST amount" onchange="financeSetTaxAmount(this.value)"></div>
          </div>
          <div class="finance-summary-row finance-summary-total"><span>Total</span><strong>${financeEscape(financeMoney(totals.total))}</strong></div>
        </section>
        <section class="finance-card finance-section">
          <h3>PDF options</h3>
          ${financeSwitch('Show unit prices', !!document.showUnitPrices, "financeToggleDocumentFlag('showUnitPrices')")}
          ${financeSwitch('Show system discounts', !!document.showDepartmentDiscounts, "financeToggleDocumentFlag('showDepartmentDiscounts')")}
          ${financeSwitch('Show system subtotals', document.showDepartmentSubtotals !== false, "financeToggleDocumentFlag('showDepartmentSubtotals')")}
          ${financeSubprojects(document).length > 1 ? financeSwitch('Group summary by sub-project', document.summaryBySubproject !== false, "financeToggleDocumentFlag('summaryBySubproject')") : ''}
          ${financeSwitch('Show line item numbers', document.showLineNumbers !== false, "financeToggleDocumentFlag('showLineNumbers')")}
          ${financeSwitch('Show sign-off', !!document.showSignOff, "financeToggleDocumentFlag('showSignOff')")}
          <button type="button" class="btn btn-primary finance-export-inline" onclick="financeExportPdf()">Export PDF</button>
        </section>
        <section class="finance-card finance-section">
          <h3>Event pairing</h3>
          <p class="finance-side-note">Pair this quotation to an existing event if the event has already been created. Accepted paired quotations will not create another event.</p>
          <div class="finance-event-search-wrap finance-event-actions">
            <button type="button" id="financeEventSearch" class="finance-picker-button" onclick="financeOpenEventPicker()">
              <span>${financeEscape(financeEventDisplay(document.eventId) || 'Pair existing event')}</span>
              <small>${document.eventId ? 'Linked event' : 'No event paired'}</small>
            </button>
            ${document.eventId && typeof isAdminUser === 'function' && isAdminUser() ? `
              <button type="button" class="btn btn-secondary finance-compare-event" onclick="financeOpenComparePage()">Compare</button>
            ` : ''}
          </div>
          ${document.eventId ? `<button type="button" class="btn btn-secondary finance-unpair-event" onclick="financeUnpairEvent()">Unpair event</button>` : ''}
        </section>
        <section class="finance-card finance-section">
          <h3>Version</h3>
          <div class="finance-summary-row"><span>Current version</span><strong>${String(document.revision || 1).padStart(2, '0')}</strong></div>
          <div class="finance-summary-row"><span>Saved versions</span><strong>${(document.revisions || []).length}</strong></div>
          ${document.eventId ? `<div class="finance-summary-row"><span>Linked event</span><strong>#${document.eventId}</strong></div>` : ''}
        </section>
      </aside>
    </div>
  `;
  financeResizeQuotationNumberInput(globalThis.document.getElementById('financeDocumentNumber'));
  if (snapshotMode) financeApplySnapshotReadOnly(root);
}

function financeBackToList() {
  clearTimeout(financeState.saveTimer);
  const leave = () => {
    financeState.current = null;
    financeState.snapshotMode = false;
    if (typeof updateAppDetailHistory === 'function') updateAppDetailHistory('/quotations');
    financeLoadList();
  };
  if (financeState.snapshotMode) return leave();
  if (financeQuotationIsBlank(financeState.current)) {
    return apiCall(`/api/quotations/${encodeURIComponent(financeState.current.id)}`, 'DELETE')
      .catch(() => null)
      .finally(leave);
  }
  financeSaveCurrent(false).finally(leave);
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
    await financeSaveCurrent(false);
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
  const note = document.querySelector('.finance-section-heading p');
  if (note) note.textContent = `Dates are optional. New line items will use ${financeEventDays()} day(s).`;
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

function financeLineChange(index, field, value) {
  const line = financeState.current?.lineItems?.[index];
  if (!line) return;
  line[field] = ['days', 'quantity', 'unitPrice', 'discountPercent'].includes(field) ? financeNumber(value) : value;
  if (field === 'discountPercent') line.discountPercent = financePercent(value);
  if (field === 'department') {
    line.departmentCode = '';
    line.uom = financeDefaultUom(value, line.uom);
  }
  if (field === 'systemName') {
    line.systemName = String(value || '').trim() || financeDefaultSystemName(line.department);
    line.uom = financeDefaultUom(line.systemName, line.uom);
  }
  line.total = financeLineTotal(line);
  financeSyncDocumentDepartments();
  financeQueueSave();
  financeRenderEditor();
}

function financeSetLineTotal(index, value) {
  const line = financeState.current?.lineItems?.[index];
  if (!line) return;
  const target = Math.max(0, financeCurrencyNumber(value));
  const quantity = financeNumber(line.quantity, 0);
  const days = financeNumber(line.days, 0);
  const unitPrice = financeNumber(line.unitPrice, 0);
  const gross = quantity * days * unitPrice;
  if (gross > 0) {
    line.discountPercent = Math.round(financePercent((1 - target / gross) * 100) * 10000) / 10000;
  } else if (quantity > 0 && days > 0) {
    line.unitPrice = Math.round((target / quantity / days) * 100) / 100;
    line.discountPercent = 0;
  } else {
    line.discountPercent = 0;
  }
  line.total = financeLineTotal(line);
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
      label: 'System discount',
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
  row.label = String(value || '').trim() || (row.scope === 'department' ? 'System discount' : 'Total discount');
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
  const target = Math.max(0, financeNumber(rawTarget));
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

function financeApplyAllDays() {
  const value = Math.max(0, financeNumber(document.getElementById('financeAllDaysValue')?.value, 1));
  const subprojectId = financeCurrentSubprojectId();
  financeState.current.lineItems.forEach(line => {
    if ((line.subprojectId || 'main') !== subprojectId) return;
    line.days = value;
    line.total = financeLineTotal(line);
  });
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

function financeQueueSave() {
  financeState.changeVersion += 1;
  const state = document.getElementById('financeSaveState');
  if (state) state.textContent = 'Unsaved changes';
  clearTimeout(financeState.saveTimer);
  financeState.saveTimer = setTimeout(() => financeSaveCurrent(false), 650);
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
  ].some(row => String(row?.date || row?.time || '').trim());
  return !hasClient
    && !String(document.projectName || '').trim()
    && !(document.departments || []).length
    && !(document.lineItems || []).length
    && !hasCustomRooms
    && !hasOtherContent
    && !dateChanged;
}

async function financeSaveCurrent(notify = false) {
  const current = financeState.current;
  if (!current) return null;
  financeSyncDocumentDepartments(current);
  financeApplyLockedTotalAdjustment(current);
  clearTimeout(financeState.saveTimer);
  const version = financeState.changeVersion;
  const state = document.getElementById('financeSaveState');
  if (state) state.textContent = 'Saving...';
  try {
    const editingSentRevision = Number(current._editingSentRevision || 0);
    const endpoint = editingSentRevision
      ? `/api/quotations/${encodeURIComponent(current.id)}/revisions/${encodeURIComponent(editingSentRevision)}`
      : `/api/quotations/${encodeURIComponent(current.id)}`;
    const response = await apiCall(endpoint, 'PUT', current);
    if (financeState.current?.id === current.id && financeState.changeVersion === version) {
      const previousNumber = financeState.current.number;
      const previousStatus = financeState.current.status;
      response.data._createdBlank = current._createdBlank;
      response.data._initialQuotationDate = current._initialQuotationDate;
      if (editingSentRevision) response.data._editingSentRevision = editingSentRevision;
      financeState.current = response.data;
      if (previousNumber !== response.data.number || previousStatus !== response.data.status || notify) financeRenderEditor();
    } else if (financeState.current?.id === current.id) {
      clearTimeout(financeState.saveTimer);
      financeState.saveTimer = setTimeout(() => financeSaveCurrent(false), 300);
    }
    const nextState = document.getElementById('financeSaveState');
    if (nextState) nextState.textContent = editingSentRevision ? 'Version changes saved' : 'All changes saved';
    if (notify) showNotification('success', 'Quotation saved');
    return response.data;
  } catch (error) {
    if (state) state.textContent = 'Save failed';
    if (notify) showNotification('error', error.message || 'Failed to save quotation');
    throw error;
  }
}

function financeSearchCatalog(query) {
  clearTimeout(financeState.catalogTimer);
  const results = document.getElementById('financeCatalogResults');
  const clean = String(query || '').trim();
  const cacheKey = clean.toLowerCase();
  financeState.catalogAbortController?.abort?.();
  if (!clean) {
    financeState.catalogRequestSeq += 1;
    financeState.catalog = [];
    financeState.catalogQuery = '';
    results?.classList.remove('open');
    return;
  }
  if (cacheKey.length < 2) {
    financeState.catalogRequestSeq += 1;
    financeState.catalog = [];
    financeState.catalogQuery = cacheKey;
    if (results) {
      results.innerHTML = '<div class="finance-suggestion-empty">Type at least 2 characters to search inventory, or press Add to create a custom item.</div>';
      results.classList.add('open');
    }
    return;
  }
  if (financeState.catalogCache[cacheKey]) {
    financeState.catalogRequestSeq += 1;
    financeState.catalog = financeState.catalogCache[cacheKey];
    financeState.catalogQuery = cacheKey;
    financeRenderCatalog();
    return;
  }
  if (results) {
    results.innerHTML = '<div class="finance-suggestion-empty">Searching... You can press Add now to create this as a custom item.</div>';
    results.classList.add('open');
  }
  const runSearch = async () => {
    const requestSeq = ++financeState.catalogRequestSeq;
    const controller = new AbortController();
    financeState.catalogAbortController = controller;
    const timeout = setTimeout(() => controller.abort(), 8000);
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
      financeState.catalog = financeGroupEquivalentContainers(payload.data || []);
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
    }
    if (requestSeq !== financeState.catalogRequestSeq) return;
    financeRenderCatalog();
  };
  financeState.catalogTimer = setTimeout(runSearch, 120);
}

function financeContainerFamilyLabel(containerId) {
  const clean = String(containerId || '').trim();
  return clean.replace(/\s*(?:#|(?:no|number)\.?\s+)\s*[a-z]?\d+(?:[._/-][a-z0-9]+)*\s*$/i, '').trim() || clean;
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
  if (!row?.isContainer) return financeEscape(row?.description || '');
  const label = financeEscape(row.containerFamily || row.description || 'Container');
  return row.containerCount > 1
    ? `${label} <small>(${row.containerCount} matching containers)</small>`
    : label;
}

function financeCatalogAvailability(row) {
  if (row?.availableQuantity === null) return 'previously used';
  return `${financeNumber(row?.availableQuantity)} ${row?.isContainer ? 'per container' : 'available'}`;
}

function financeRenderCatalog() {
  const results = document.getElementById('financeCatalogResults');
  if (!results) return;
  results.innerHTML = financeState.catalog.map((row, index) => `
    <button type="button" class="finance-catalog-option" onclick="financeSelectCatalog(${index})">
      <span><strong>${financeCatalogDescription(row)}</strong><br><small>${financeEscape(financeLineSystem(row))} &middot; ${financeCatalogAvailability(row)}</small></span>
      <span>${row.unitPrice ? financeEscape(financeMoney(row.unitPrice)) : '<small>No saved price</small>'}</span>
    </button>
  `).join('') || '<div class="finance-suggestion-empty">Press Add to create a custom item</div>';
  results.classList.add('open');
}

function financeAddLineFromCatalog(selected, departmentOverride = '', quantityOverride = null) {
  const department = departmentOverride || financeAddDepartmentOverride() || selected.department || 'General';
  const days = financeEventDays();
  const quantity = quantityOverride === null || quantityOverride === undefined
    ? 1
    : Math.max(0, financeNumber(quantityOverride, 1));
  financeState.current.lineItems.push({
    id: `line_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    catalogKey: selected.catalogKey || '',
    sourceAssetIds: selected.sourceAssetIds || [],
    brand: selected.brand || '',
    model: selected.model || '',
    description: selected.description,
    department,
    departmentCode: selected.departmentCode || '',
    days,
    quantity,
    uom: financeDefaultUom(department, selected.uom),
    unitPrice: financeNumber(selected.unitPrice),
    discountPercent: 0,
    total: financeNumber(selected.unitPrice) * days * quantity,
    isCustom: !!selected.isCustom,
    subprojectId: financeCurrentSubprojectId()
  });
}

function financeSelectCatalog(index) {
  const selected = financeState.catalog[index];
  if (!selected) return;
  if (selected.isContainer) {
    (selected.containerItems || []).forEach(item => {
      financeAddLineFromCatalog(
        item,
        item.department || 'General',
        item.containerQuantity || item.availableQuantity || 1
      );
    });
  } else {
    financeAddLineFromCatalog(selected);
  }
  financeSyncDocumentDepartments();
  financeState.addDepartment = '';
  financeState.catalog = [];
  financeQueueSave();
  financeRenderEditor();
}

async function financeAddCustomItem() {
  const input = document.getElementById('financeAddItemInput');
  const description = input?.value.trim();
  if (!description) return input?.focus();
  financeState.catalogAbortController?.abort?.();
  financeState.catalogRequestSeq += 1;
  const exactLoaded = (financeState.catalog || []).find(row =>
    row.isCustom && String(row.description || '').trim().toLowerCase() === description.toLowerCase()
  ) || {};
  const departmentOverride = financeAddDepartmentOverride();
  const department = departmentOverride || exactLoaded.department || 'General';
  const lineId = `line_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  financeState.current.lineItems.push({
    id: lineId,
    catalogKey: '',
    sourceAssetIds: [],
    brand: '',
    model: '',
    description,
    department,
    departmentCode: exactLoaded.departmentCode || '',
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
  try {
    const remembered = (await apiCall(`/api/finance/price-suggestion?description=${encodeURIComponent(description)}`)).data || {};
    const line = financeState.current?.lineItems?.find(row => row.id === lineId);
    if (!line || financeNumber(line.unitPrice) > 0 || !financeNumber(remembered.unitPrice)) return;
    line.department = departmentOverride || remembered.department || line.department;
    line.departmentCode = remembered.departmentCode || line.departmentCode || '';
    line.uom = remembered.uom || line.uom || 'units';
    line.unitPrice = financeNumber(remembered.unitPrice);
    line.total = financeLineTotal(line);
    financeSyncDocumentDepartments();
    financeQueueSave();
    financeRenderEditor();
  } catch {}
}

function financeAddItemKeydown(event) {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  const query = String(document.getElementById('financeAddItemInput')?.value || '').trim().toLowerCase();
  if (financeState.catalog.length === 1 && financeState.catalogQuery === query) financeSelectCatalog(0);
  else financeAddCustomItem();
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
      <label class="finance-field"><span>Valid for</span><span class="finance-validity-control"><input id="financeSentValidityAmount" class="finance-input" type="number" min="1" max="365" value="30"><input id="financeSentValidityUnitValue" type="hidden" value="days"><span id="financeSentValidityUnitHolder">${financeValidityUnitControl('days', 'finance-sent-validity-unit-menu', 'financeSetSentValidityUnit')}</span></span></label>
      <div class="modal-actions" style="display:flex;justify-content:flex-end;gap:8px;margin-top:20px;"><button type="button" class="btn btn-secondary" onclick="closeModal('financeSentModal')">Cancel</button><button type="button" class="btn btn-primary" onclick="financeConfirmSent()">Mark as Sent</button></div>
    </div>
  `;
  document.body.appendChild(modal);
}

function financeEnsureInvoicedModal() {
  if (document.getElementById('financeInvoicedModal')) return;
  const modal = document.createElement('div');
  modal.id = 'financeInvoicedModal';
  modal.className = 'modal';
  modal.innerHTML = `
    <div class="modal-content" style="max-width:480px;">
      <div class="modal-header"><h3 class="modal-title">Mark quotation as Invoiced</h3><button type="button" class="close-btn" onclick="closeModal('financeInvoicedModal')">×</button></div>
      <p style="color:#64748b;margin-bottom:16px;">Confirm when the invoice was sent and the agreed payment terms.</p>
      <div class="finance-invoiced-fields">
        <label class="finance-field"><span>Invoice sent date</span><input id="financeInvoiceSentDate" class="finance-input" type="date" value="${financeTodayIso()}" oninput="financeUpdateInvoiceDuePreview()"></label>
        <label class="finance-field"><span>Payment terms</span><input id="financeInvoicePaymentTerms" class="finance-input" value="30 Days" placeholder="For example, 30 Days" oninput="financeUpdateInvoiceDuePreview()"></label>
      </div>
      <div class="finance-payment-preview" id="financeInvoiceDuePreview">Pay by: 30 days</div>
      <div class="modal-actions" style="display:flex;justify-content:flex-end;gap:8px;margin-top:20px;"><button type="button" class="btn btn-secondary" onclick="closeModal('financeInvoicedModal')">Cancel</button><button type="button" class="btn btn-primary" onclick="financeConfirmInvoiced()">Mark as Invoiced</button></div>
    </div>
  `;
  document.body.appendChild(modal);
}

function financeUpdateInvoiceDuePreview() {
  const terms = document.getElementById('financeInvoicePaymentTerms')?.value || '';
  const sentDate = document.getElementById('financeInvoiceSentDate')?.value || '';
  const days = financePaymentTermDays(terms, 30);
  const dueDate = financePaymentDueDisplay(sentDate, days);
  const preview = document.getElementById('financeInvoiceDuePreview');
  if (preview) {
    preview.textContent = dueDate
      ? `Pay by: ${dueDate} · ${financePaymentTermSummary(terms, days)}`
      : 'Choose a valid invoice sent date';
  }
}

async function financeRequestStatus(documentId, status, context) {
  document.querySelectorAll('.finance-custom-menu.open').forEach(menu => menu.classList.remove('open'));
  financeState.statusTargetId = documentId;
  let documentRow = financeState.current?.id === documentId ? financeState.current : financeState.documents.find(row => row.id === documentId);
  if (!documentRow) return;
  if (status === 'sent') {
    financeEnsureSentModal();
    document.getElementById('financeSentValidityAmount').value = financeValidityAmount(documentRow);
    financeSetSentValidityUnit(financeValidityUnit(documentRow));
    openModal('financeSentModal');
    return;
  }
  if (status === 'invoiced') {
    financeEnsureInvoicedModal();
    const sentDate = document.getElementById('financeInvoiceSentDate');
    const paymentTerms = document.getElementById('financeInvoicePaymentTerms');
    if (sentDate) sentDate.value = financeDateOnly(documentRow.invoiceSentDate) || financeTodayIso();
    if (paymentTerms) paymentTerms.value = documentRow.paymentTerms || '30 Days';
    financeUpdateInvoiceDuePreview();
    openModal('financeInvoicedModal');
    return;
  }
  if (status === 'accepted') {
    const pairedEventId = Number(documentRow.eventId || 0);
    const confirmed = await showAppConfirm({
      title: pairedEventId ? 'Accept paired quotation?' : 'Accept quotation and create event?',
      message: pairedEventId
        ? `This quotation is paired to Event #${pairedEventId}. Accepting it will not create another event.`
        : 'This will create an event with the quotation project, location and inventory requirements. Manpower and transportation lines are not added to Prepare.',
      confirmText: pairedEventId ? 'Accept Quotation' : 'Accept & Create Event',
      cancelText: 'Cancel'
    });
    if (!confirmed) return;
  }
  await financeCommitStatus(documentId, status, {});
}

async function financeConfirmSent() {
  const amount = Math.max(1, financeNumber(document.getElementById('financeSentValidityAmount')?.value, 30));
  const unit = financeValidityUnitMeta(document.getElementById('financeSentValidityUnitValue')?.value).value;
  const days = Math.max(1, Math.round(amount * financeValidityUnitMeta(unit).multiplier));
  closeModal('financeSentModal');
  await financeCommitStatus(financeState.statusTargetId, 'sent', {
    validityAmount: amount,
    validityUnit: unit,
    validityDays: days
  });
}

async function financeConfirmInvoiced() {
  const invoiceSentDate = document.getElementById('financeInvoiceSentDate')?.value || financeTodayIso();
  const paymentTerms = document.getElementById('financeInvoicePaymentTerms')?.value.trim() || '30 Days';
  closeModal('financeInvoicedModal');
  await financeCommitStatus(financeState.statusTargetId, 'invoiced', {
    invoiceSentDate,
    paymentTerms
  });
}

async function financeCommitStatus(documentId, status, extras) {
  const listRow = Array.from(financeRoot()?.querySelectorAll('.finance-list-row') || [])
    .find(row => row.dataset.documentId === String(documentId));
  listRow?.classList.add('is-updating');
  listRow?.setAttribute('aria-busy', 'true');
  try {
    const beforeChange = financeState.current?.id === documentId ? financeState.current : financeState.documents.find(row => row.id === documentId);
    const existingEventId = Number(beforeChange?.eventId || 0);
    if (financeState.current?.id === documentId) await financeSaveCurrent(false);
    const response = await apiCall(`/api/quotations/${encodeURIComponent(documentId)}`, 'PUT', { status, ...extras });
    if (financeState.current?.id === documentId) {
      financeState.current = response.data;
      financeRenderEditor();
    } else {
      financeUpdateListRow(response.data);
    }
    const eventNote = status === 'accepted' && response.data.eventId
      ? (existingEventId ? ` Linked to Event #${response.data.eventId}.` : ` Event #${response.data.eventId} was created.`)
      : '';
    showNotification('success', `Quotation marked ${financeStatusLabel(response.data.status)}.${eventNote}`);
  } catch (error) {
    listRow?.classList.remove('is-updating');
    listRow?.removeAttribute('aria-busy');
    showNotification('error', error.message || 'Failed to change quotation status');
  }
}

async function financeExportPdf() {
  return financeExportQuotation(financeState.current?.id);
}

async function financeExportQuotation(documentId = financeState.current?.id) {
  const quotation = financeState.current?.id === documentId
    ? financeState.current
    : financeState.documents.find(row => row.id === documentId);
  if (!quotation || !financeCanExportQuotation(quotation)) return;
  try {
    const current = financeState.current?.id === quotation.id
      ? await financeSaveCurrent(false)
      : quotation;
    const pdfUrl = `/api/quotations/${encodeURIComponent(current.id)}/pdf`;
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
    const response = await apiCall(
      `/api/quotations/${encodeURIComponent(current.id)}/convert-to-invoice`,
      'POST',
      {}
    );
    const invoice = response.data;
    const refreshed = await apiCall(`/api/quotations/${encodeURIComponent(current.id)}`);
    if (financeState.current?.id === current.id) {
      financeState.current = refreshed.data;
      financeRenderEditor();
    } else {
      const index = financeState.documents.findIndex(row => row.id === current.id);
      if (index >= 0) financeState.documents[index] = refreshed.data;
      financeRenderList(document.querySelector('.finance-search')?.value || '');
    }
    const opened = window.open(
      `/api/invoices/${encodeURIComponent(invoice.id)}/pdf`,
      '_blank',
      'noopener'
    );
    if (!opened) showNotification('warning', 'Please allow pop-ups to preview the invoice PDF');
  } catch (error) {
    showNotification('error', error.message || 'Failed to export invoice');
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

function profitLossEventTitle(event) {
  if (!event) return 'Choose event';
  return `#${event.id} ${event.name || 'Untitled event'}`;
}

async function loadProfitLoss(options = {}) {
  ensureFinanceSections();
  const root = profitLossRoot();
  if (!root || profitLossState.loading) return;
  profitLossState.loading = true;
  if (!options.preserve) root.innerHTML = '<div class="loading">Loading Profit & Loss...</div>';
  try {
    const eventsResponse = await apiCall('/api/events?view=summary&limit=500');
    profitLossState.events = (eventsResponse.data || []).slice().sort((a, b) => Number(b.id || 0) - Number(a.id || 0));
    if (!profitLossState.eventId) {
      profitLossState.eventId = Number(profitLossState.events[0]?.id || 0);
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
  await selectProfitLossEvent(eventId, { renderLoading: false });
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
          <span class="finance-money-input"><span>$</span><input id="profitLossManualRevenue" class="finance-input" inputmode="decimal" placeholder="0.00" required></span>
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
    amount.value = currentAmount == null ? '' : String(financeNumber(currentAmount));
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
      { manualAmount: amount }
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

function profitLossExpenseCategoryMarkup(expense) {
  const source = String(expense?.source || 'manual');
  const categoryKey = String(expense?.categoryKey || '');
  let category = String(expense?.categoryLabel || expense?.category || 'Other expense');
  if (
    source === 'worker-invoice'
    || (source === 'worker-claim' && ['meal', 'transport'].includes(categoryKey))
    || (source === 'manual' && categoryKey === 'meal')
  ) {
    category = 'Manpower';
  } else if (source === 'manual' && categoryKey === 'transport') {
    category = 'Transport';
  }

  const department = String(expense?.department || '').trim();
  const departmentMeta = profitLossDepartmentMeta(department);
  const departmentCode = String(departmentMeta?.code || '');
  const departmentColour = departmentMeta
    ? profitLossSolidColour(departmentMeta.color)
    : '';

  const suffix = department
    ? ` - ${departmentCode || department}`
    : '';
  const title = departmentMeta
    ? departmentMeta.name || departmentCode
    : department;
  const style = departmentColour
    ? ` style="--pnl-category-colour:${departmentColour};--pnl-category-text:${profitLossContrastColour(departmentColour)}"`
    : '';
  return `<span class="pnl-category-badge"${style}${title ? ` title="${financeEscapeAttr(title)}"` : ''}>${financeEscape(`${category}${suffix}`)}</span>`;
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
  const visualRect = visual.getBoundingClientRect();
  const segmentRect = segment.getBoundingClientRect();
  const clientX = Number.isFinite(event?.clientX) && event.clientX
    ? event.clientX
    : segmentRect.left + segmentRect.width / 2;
  const clientY = Number.isFinite(event?.clientY) && event.clientY
    ? event.clientY
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

function profitLossChartMarkup(rows, summary) {
  const segments = profitLossChartRows(rows);
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
          </div>
          <div class="plan-event-meta">
            <span>${financeEscape([event.startDate, event.endDate].filter(Boolean).join(' - '))}</span>
            ${event.location ? `<span aria-hidden="true">-</span><span>${financeEscape(event.location)}</span>` : ''}
            ${event.state ? `<span class="plan-badge">${financeEscape(event.state)}</span>` : ''}
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
  const expenses = (data.expenses || []).slice().sort((left, right) => (
    String(right.expenseDate || right.createdAt || '').localeCompare(
      String(left.expenseDate || left.createdAt || '')
    )
  ));
  const listedExpenseTotal = expenses.reduce((sum, row) => sum + financeNumber(row.amount), 0);
  const selectedEvent = profitLossState.events.find(row => Number(row.id) === Number(event.id)) || event;
  const activity = data.activity || [];
  const transportNoteParts = [
    financeNumber(summary.transportBookingCost) > 0 ? `Bookings ${financeSgd(summary.transportBookingCost)}` : '',
    financeNumber(summary.manualTransportExpenses) > 0 ? `Added ${financeSgd(summary.manualTransportExpenses)}` : ''
  ].filter(Boolean);
  const manpowerNoteParts = [
    financeNumber(summary.manpowerInvoiceCost) > 0 ? `Invoices ${financeSgd(summary.manpowerInvoiceCost)}` : `Assignments ${financeSgd(summary.manpowerEstimatedCost)}`,
    financeNumber(summary.crewTransportClaimsCost) > 0 ? `Transport claims ${financeSgd(summary.crewTransportClaimsCost)}` : '',
    financeNumber(summary.workerMealClaimsCost) > 0 ? `Meal claims ${financeSgd(summary.workerMealClaimsCost)}` : '',
    financeNumber(summary.manualMealExpenses) > 0 ? `Added meals ${financeSgd(summary.manualMealExpenses)}` : ''
  ].filter(Boolean);
  const otherNoteParts = [
    financeNumber(summary.workerOtherClaimsCost) > 0 ? `Worker claims ${financeSgd(summary.workerOtherClaimsCost)}` : '',
    financeNumber(summary.manualOtherExpenses) > 0 ? `Added here ${financeSgd(summary.manualOtherExpenses)}` : ''
  ].filter(Boolean);
  const revenueSource = data.revenueSource || (quote ? 'quotation' : 'none');
  const revenueTitle = revenueSource === 'manual' ? 'Event Revenue' : 'Revenue from Quotation';
  const revenueNote = quote
    ? `Quotation: ${quote.number}`
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
      <button type="button" class="btn btn-primary" onclick="window.print()">Export</button>
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
          </div>
          <div class="plan-event-meta">
            <span>${financeEscape([event.startDate, event.endDate].filter(Boolean).join(' - '))}</span>
            ${event.location ? `<span aria-hidden="true">-</span><span>${financeEscape(event.location)}</span>` : ''}
            ${event.state ? `<span class="plan-badge">${financeEscape(event.state)}</span>` : ''}
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
      ${profitLossKpi('Manpower Cost', financeSgd(summary.manpowerCost), manpowerNote, 'pnl-link-kpi', `profitLossOpenManpower(${Number(event.id) || 0})`)}
      ${profitLossKpi('Transport Cost', financeSgd(summary.transportCost), transportNote, 'pnl-link-kpi', `profitLossOpenManpower(${Number(event.id) || 0}, 'transport')`)}
      ${profitLossKpi('Other Expenses', financeSgd(summary.otherExpenses), otherNoteParts.join(' · ') || 'No other expenses')}
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

      <section class="finance-card pnl-expenses">
        <div class="pnl-section-head">
          <h3>Expense Breakdown</h3>
          <div class="pnl-actions">
            <button type="button" class="btn btn-secondary" onclick="profitLossOpenExpenseModal()">Add Expense</button>
          </div>
        </div>
        <div class="pnl-table-wrap">
          <table class="pnl-table">
            <thead><tr><th>Description</th><th>Type</th><th>Category</th><th>Vendor / Payee</th><th>Date</th><th>Amount</th><th>Attachment</th><th></th></tr></thead>
            <tbody>
              ${expenses.map(row => `
                <tr>
                  <td><strong>${financeEscape(row.description)}</strong></td>
                  <td><span class="pnl-source-pill pnl-source-${financeEscapeAttr(row.source || 'manual')}">${financeEscape(row.sourceLabel || (row.readOnly ? 'Claim' : 'Added expense'))}</span></td>
                  <td>${profitLossExpenseCategoryMarkup(row)}</td>
                  <td>${financeEscape(row.vendor || '-')}</td>
                  <td>${financeEscape(row.expenseDate || '-')}</td>
                  <td><strong>${financeSgd(row.amount)}</strong></td>
                  <td>${row.attachment ? `
                    <span class="pnl-attachment-actions">
                      <button type="button" class="pnl-attachment-preview" onclick="profitLossPreviewAttachment('${financeEscapeAttr(row.id)}')">${financeEscape(row.attachment.originalName || 'Attachment')}</button>
                      <a class="pnl-attachment-download" href="${financeEscapeAttr(row.attachment.downloadUrl || row.attachment.previewUrl)}" download>Download</a>
                    </span>
                  ` : '-'}</td>
                  <td>${row.readOnly ? `
                    <button type="button" class="pnl-expense-edit pnl-expense-source" onclick="profitLossOpenManpower(${Number(event.id) || 0})" aria-label="Open Manpower and Transport" title="Open Manpower and Transport">
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
              `).join('') || '<tr><td colspan="8" class="pnl-empty-row">No invoices, claims, or additional expenses have been added.</td></tr>'}
            </tbody>
          </table>
        </div>
        <div class="pnl-total-line"><span>Total listed expenses</span><strong>${financeSgd(listedExpenseTotal)}</strong></div>
      </section>

      <aside class="pnl-side">
        <section class="finance-card pnl-summary-card">
          <h3>Profit Summary</h3>
          ${profitLossChartMarkup(data.profitChart || [], summary)}
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
      <div class="modal-header"><h3 class="modal-title" id="profitLossExpenseTitle">Add Expense</h3><button type="button" class="close-btn" onclick="closeModal('profitLossExpenseModal')">&times;</button></div>
      <form id="profitLossExpenseForm" onsubmit="profitLossSubmitExpense(event)">
        <div class="finance-form-grid">
          <label class="finance-field finance-span-all"><span>Description</span><input id="profitLossExpenseDescription" class="finance-input" maxlength="300" placeholder="e.g. Stage backdrop invoice"></label>
          <label class="finance-field"><span>Category</span><input id="profitLossExpenseCategory" class="finance-input" list="profitLossExpenseCategories" placeholder="Miscellaneous"></label>
          <label class="finance-field"><span>Vendor / Payee</span><input id="profitLossExpenseVendor" class="finance-input" maxlength="180"></label>
          <label class="finance-field"><span>Amount</span><input id="profitLossExpenseAmount" class="finance-input" inputmode="decimal" placeholder="0.00"></label>
          <label class="finance-field"><span>Date</span><input id="profitLossExpenseDate" class="finance-input" type="date"></label>
          <label class="finance-field finance-span-all" id="profitLossExpenseFileField"><span>Receipt or document</span><input id="profitLossExpenseFile" class="finance-input" type="file" accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg"></label>
        </div>
        <datalist id="profitLossExpenseCategories">
          <option value="Transport"></option>
          <option value="Crew Transport"></option>
          <option value="Meal Claims"></option>
          <option value="External Vendors"></option>
          <option value="Miscellaneous"></option>
          <option value="Production Supplies"></option>
          <option value="Parking & Tolls"></option>
        </datalist>
        <div class="modal-actions finance-picker-actions">
          <button type="button" class="btn btn-secondary" onclick="closeModal('profitLossExpenseModal')">Cancel</button>
          <button type="submit" class="btn btn-primary">Save Expense</button>
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
    row.amount = Math.round(financeNumber(profitLossState.data?.summary?.revenue) * row.percent) / 100;
    row.calculationMode = 'percent';
  }
  if (field === 'amount') {
    row.amount = Math.max(0, financeCurrencyNumber(value));
    const revenue = financeNumber(profitLossState.data?.summary?.revenue);
    row.percent = revenue ? Math.round(row.amount / revenue * 100 * 10000) / 10000 : 0;
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
      <label class="finance-field"><span>Amount</span><span class="finance-money-input"><span>$</span><input class="finance-input" type="number" min="0" step="0.01" value="${financeEscapeAttr(row.amount || 0)}" onchange="profitLossCommissionChange(${index},'amount',this.value)"></span></label>
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
    setValue('profitLossExpenseCategory', expense.category);
    setValue('profitLossExpenseVendor', expense.vendor);
    setValue('profitLossExpenseAmount', expense.amount);
    setValue('profitLossExpenseDate', expense.expenseDate);
  } else {
    profitLossState.editingExpenseId = '';
  }
  const title = document.getElementById('profitLossExpenseTitle');
  const fileField = document.getElementById('profitLossExpenseFileField');
  if (title) title.textContent = expense ? 'Edit Expense' : 'Add Expense';
  if (fileField) fileField.style.display = expense ? 'none' : 'grid';
  openModal('profitLossExpenseModal');
}

async function profitLossSubmitExpense(event) {
  event.preventDefault();
  if (!profitLossState.eventId) return;
  const value = id => document.getElementById(id)?.value.trim() || '';
  const expense = {
    description: value('profitLossExpenseDescription'),
    category: value('profitLossExpenseCategory') || 'Miscellaneous',
    vendor: value('profitLossExpenseVendor'),
    amount: value('profitLossExpenseAmount'),
    expenseDate: value('profitLossExpenseDate')
  };
  const editingExpenseId = profitLossState.editingExpenseId;
  const file = document.getElementById('profitLossExpenseFile')?.files?.[0];
  try {
    let response;
    if (editingExpenseId) {
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
    profitLossState.editingExpenseId = '';
    closeModal('profitLossExpenseModal');
    renderProfitLossPage();
    showNotification('success', editingExpenseId ? 'Expense updated' : (file ? 'Receipt uploaded' : 'Expense added'));
  } catch (error) {
    showNotification('error', error.message || 'Failed to save expense');
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
    const eventsResponse = await apiCall('/api/events?view=summary&limit=500');
    compareState.events = (eventsResponse.data || []).slice().sort((a, b) => Number(b.id || 0) - Number(a.id || 0));
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
  const rows = compareState.data?.rows || [];
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
  try {
    const response = await apiCall(`/api/finance/compare/${compareState.eventId}/${endpoint}`, 'POST', {
      quotationId: compareState.quotationId,
      key
    });
    compareState.data = response.data;
    compareState.quotationId = response.data?.quotation?.id || compareState.quotationId;
    if (!options.silent) showNotification('success', 'Comparison updated');
    renderComparePage();
  } catch (error) {
    showNotification('error', error.message || 'Compare action failed');
    throw error;
  }
}

async function compareBulkAction(action) {
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
  if (action === 'add-quote' && targets.length) {
    try {
      const response = await apiCall(`/api/finance/compare/${compareState.eventId}/add-to-quotation`, 'POST', {
        quotationId: compareState.quotationId,
        keys: targets.map(row => row.key)
      });
      compareState.data = response.data;
      compareState.quotationId = response.data?.quotation?.id || compareState.quotationId;
      renderComparePage();
      showNotification('success', `${targets.length} item${targets.length === 1 ? '' : 's'} added to quotation`);
    } catch (error) {
      showNotification('error', error.message || 'Compare action failed');
    }
    return;
  }
  for (const row of targets) {
    const quoteQty = financeNumber(row.quotationItem?.quantity);
    const eventQty = financeNumber(row.eventItem?.quantity);
    const chosen = action === 'resolve-mismatch'
      ? (quoteQty > eventQty ? 'add-event' : 'remove-extra')
      : action;
    await compareRunRowAction(chosen, row.key, { silent: true });
  }
  if (targets.length) showNotification('success', 'Comparison updated');
}

function compareEnsureQuotationPickerModal() {
  if (document.getElementById('compareQuotationPickerModal')) return;
  const modal = document.createElement('div');
  modal.id = 'compareQuotationPickerModal';
  modal.className = 'modal';
  modal.innerHTML = `
    <div class="modal-content finance-picker-modal">
      <div class="modal-header"><h3 class="modal-title">Choose Quotation</h3><button type="button" class="close-btn" onclick="closeModal('compareQuotationPickerModal')">&times;</button></div>
      <div id="compareQuotationPickerResults" class="finance-picker-results"></div>
      <div class="modal-actions finance-picker-actions"><button type="button" class="btn btn-secondary" onclick="closeModal('compareQuotationPickerModal')">Cancel</button></div>
    </div>
  `;
  document.body.appendChild(modal);
}

function compareOpenQuotationPicker() {
  compareEnsureQuotationPickerModal();
  const results = document.getElementById('compareQuotationPickerResults');
  const rows = compareState.data?.quotations || [];
  if (results) {
    results.innerHTML = rows.map(row => `
      <button type="button" class="finance-picker-option" onclick="compareChooseQuotation('${financeEscapeAttr(row.id)}')">
        <strong>${financeEscape(row.number || 'Quotation')}</strong>
        <span>${financeEscape([row.projectName, row.client?.name || row.client?.company].filter(Boolean).join(' - '))}</span>
      </button>
    `).join('') || '<div class="finance-suggestion-empty">No quotations are paired to this event.</div>';
  }
  openModal('compareQuotationPickerModal');
}

async function compareChooseQuotation(quotationId) {
  compareState.quotationId = quotationId || '';
  closeModal('compareQuotationPickerModal');
  await selectCompareEvent(compareState.eventId, { keepQuotation: true });
}
