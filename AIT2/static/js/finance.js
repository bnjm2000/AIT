const FINANCE_STATUSES = ['draft', 'sent', 'accepted', 'declined', 'expired', 'cancelled', 'invoiced', 'paid'];
const FINANCE_UOMS = [
  { value: 'units', label: 'unit(s)' },
  { value: 'pax', label: 'pax' },
  { value: 'lot', label: 'lot' }
];

const financeState = {
  documents: [],
  current: null,
  clients: [],
  catalog: [],
  departments: ['Manpower', 'Transportation'],
  saveTimer: null,
  catalogTimer: null,
  listTimer: null,
  changeVersion: 0,
  statusTargetId: '',
  addDepartment: 'Manpower'
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

function financeLineTotal(line) {
  const gross = financeNumber(line.quantity, 1) * financeNumber(line.days, 1) * financeNumber(line.unitPrice);
  return Math.round(gross * (1 - financeNumber(line.discountPercent) / 100) * 100) / 100;
}

function financeRecalculateAdjustments(document) {
  const lines = document?.lineItems || [];
  const adjustments = document?.adjustments || [];
  adjustments.filter(row => row.scope === 'department').forEach(row => {
    const percent = Math.max(0, financeNumber(row.percent));
    if (!percent) return;
    const base = lines
      .filter(line => (line.department || 'Unknown Department') === row.department)
      .reduce((sum, line) => sum + financeLineTotal(line), 0);
    row.amount = Math.round(base * percent / 100 * (row.kind === 'discount' ? -1 : 1) * 100) / 100;
  });
}

function financeTotals(document = financeState.current) {
  const lines = document?.lineItems || [];
  lines.forEach(line => { line.total = financeLineTotal(line); });
  financeRecalculateAdjustments(document);
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
  if (!document?.setupDate || !document?.teardownDate) return 1;
  const start = new Date(`${document.setupDate}T00:00:00`);
  const end = new Date(`${document.teardownDate}T00:00:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 1;
  return Math.max(1, Math.round((end - start) / 86400000) + 1);
}

function financeUomLabel(value) {
  return FINANCE_UOMS.find(row => row.value === value)?.label || 'unit(s)';
}

function financeStatusLabel(status) {
  const clean = String(status || 'draft').toLowerCase();
  return clean[0].toUpperCase() + clean.slice(1);
}

function financeToggleMenu(menuId, event) {
  event?.stopPropagation();
  const target = document.getElementById(menuId);
  if (!target) return;
  const open = !target.classList.contains('open');
  document.querySelectorAll('.finance-custom-menu.open').forEach(menu => menu.classList.remove('open'));
  if (open) target.classList.add('open');
}

document.addEventListener('click', event => {
  if (event.target.closest('.finance-custom-control')) return;
  document.querySelectorAll('.finance-custom-menu.open').forEach(menu => menu.classList.remove('open'));
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
          <button type="button" class="${status === document.status ? 'selected' : ''}" onclick="financeRequestStatus('${financeEscapeAttr(document.id)}','${status}','${context}')">
            <span class="finance-status-dot" data-status="${status}"></span>${financeEscape(financeStatusLabel(status))}
          </button>
        `).join('')}
      </div>
    </div>
  `;
}

function ensureFinanceSections() {
  const firstSection = document.querySelector('.content-section');
  const parent = firstSection?.parentElement || document.body;
  if (document.getElementById('quotations-section')) return;
  const section = document.createElement('div');
  section.id = 'quotations-section';
  section.className = 'content-section';
  section.innerHTML = '<div id="quotations-page-root" class="finance-page"><div class="loading">Loading...</div></div>';
  parent.appendChild(section);
}

function setupFinanceNavigation() {
  const canUseFinance = typeof currentUserHasSalesAccess === 'function'
    ? currentUserHasSalesAccess()
    : !!(window.currentUser && (window.currentUser.hasSalesAccess || window.currentUser.isSales || window.currentUser.isOwner || window.currentUser.isSuperAdmin));
  const sidebar = document.getElementById('appSidebar');
  if (!sidebar) return;
  const existing = sidebar.querySelector('[data-finance-navigation="true"]');
  if (!canUseFinance) {
    existing?.remove();
    return;
  }
  if (existing) return;
  ensureFinanceSections();
  const section = document.createElement('div');
  section.className = 'nav-section sales-only';
  section.dataset.salesDisplay = 'block';
  section.dataset.financeNavigation = 'true';
  section.innerHTML = '<h3>Finance</h3><button type="button" class="nav-item" data-section="quotations">▤ Quotations</button>';
  const reports = Array.from(sidebar.querySelectorAll('.nav-section')).find(row => row.querySelector('h3')?.textContent.trim() === 'Reports');
  const settings = Array.from(sidebar.querySelectorAll('.nav-section')).find(row => row.querySelector('h3')?.textContent.trim() === 'Settings');
  sidebar.insertBefore(section, reports || settings || null);
  if (typeof setupSidebarNavigation === 'function') setupSidebarNavigation();
}

function financeRoot() {
  return document.getElementById('quotations-page-root');
}

async function loadQuotations() {
  financeState.current = null;
  return financeLoadList();
}

async function financeLoadList(query = '') {
  const root = financeRoot();
  if (!root) return;
  root.innerHTML = '<div class="loading">Loading quotations...</div>';
  try {
    const response = await apiCall(`/api/quotations${query ? `?query=${encodeURIComponent(query)}` : ''}`);
    financeState.documents = response.data || [];
    financeRenderList(query);
  } catch (error) {
    root.innerHTML = '<div class="finance-empty">Could not load quotations.</div>';
    showNotification('error', error.message || 'Failed to load quotations');
  }
}

function financeRenderList(query = '') {
  const root = financeRoot();
  if (!root) return;
  const rows = financeState.documents.map(document => {
    const client = document.client || {};
    const total = document.totals?.total ?? financeTotals(document).total;
    return `
      <tr onclick="financeOpenDocument('${financeEscapeAttr(document.id)}')">
        <td><span class="finance-doc-number">${financeEscape(document.number)}</span><br><small>Rev ${String(document.revision || 1).padStart(2, '0')}</small></td>
        <td><strong>${financeEscape(client.name || client.contactPerson || 'No client')}</strong><br><small>${financeEscape(client.company || client.email || '')}</small></td>
        <td>${financeEscape(document.projectName || 'Project name required')}</td>
        <td>${financeEscape(document.quotationDate || '')}</td>
        <td>${financeStatusControl(document, 'list')}</td>
        <td style="text-align:right;font-weight:750;">${financeEscape(financeMoney(total))}</td>
      </tr>
    `;
  }).join('');
  root.innerHTML = `
    <div class="finance-toolbar">
      <div><h2>Quotations</h2><p class="finance-subtitle">Your quotations, revisions and client approvals.</p></div>
      <div class="finance-toolbar-actions">
        <input class="finance-search" type="search" value="${financeEscapeAttr(query)}" placeholder="Search quotations..." oninput="financeQueueListSearch(this.value)">
        <button type="button" class="btn btn-primary" onclick="financeCreateDocument()">+ New Quotation</button>
      </div>
    </div>
    <div class="finance-card">
      ${rows ? `
        <table class="finance-list-table">
          <thead><tr><th>Number</th><th>Bill to</th><th>Project Name</th><th>Date</th><th>Status</th><th style="text-align:right;">Total</th></tr></thead>
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

async function financeLoadEditorData() {
  const [clientsResponse, departmentsResponse] = await Promise.all([
    apiCall('/api/clients').catch(() => ({ data: [] })),
    apiCall('/api/finance/departments').catch(() => ({ data: ['Manpower', 'Transportation'] }))
  ]);
  financeState.clients = clientsResponse.data || [];
  financeState.departments = departmentsResponse.data || ['Manpower', 'Transportation'];
}

async function financeCreateDocument() {
  try {
    const response = await apiCall('/api/quotations', 'POST', {});
    financeState.current = response.data;
    financeState.addDepartment = 'Manpower';
    await financeLoadEditorData();
    financeRenderEditor();
  } catch (error) {
    showNotification('error', error.message || 'Failed to create quotation');
  }
}

async function financeOpenDocument(documentId) {
  try {
    const response = await apiCall(`/api/quotations/${encodeURIComponent(documentId)}`);
    financeState.current = response.data;
    financeState.addDepartment = financeState.current.departments?.[0] || 'Manpower';
    await financeLoadEditorData();
    financeRenderEditor();
  } catch (error) {
    showNotification('error', error.message || 'Failed to open quotation');
  }
}

function financeClientDisplay(client) {
  return client?.name || client?.contactPerson || client?.company || '';
}

function financeFilterClients(query) {
  const clean = String(query || '').trim().toLowerCase();
  return financeState.clients.filter(client => !clean || [
    client.name, client.company, client.contactPerson, client.email, client.phone
  ].some(value => String(value || '').toLowerCase().includes(clean))).slice(0, 12);
}

function financeShowClientSuggestions(query = '') {
  const results = document.getElementById('financeClientResults');
  if (!results) return;
  const rows = financeFilterClients(query);
  results.innerHTML = rows.map(client => `
    <button type="button" class="finance-client-option" onclick="financeApplySavedClient('${financeEscapeAttr(encodeURIComponent(client.name))}')">
      <strong>${financeEscape(client.name || client.contactPerson || client.company)}</strong>
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

function financeDepartmentSuggestions(query) {
  const clean = String(query || '').trim().toLowerCase();
  const values = [...new Set([
    ...(financeState.departments || []),
    ...(financeState.current?.departments || []),
    'Manpower',
    'Transportation'
  ])];
  return values.filter(value => !clean || value.toLowerCase().includes(clean)).slice(0, 10);
}

function financeShowDepartmentSuggestions(index, query, targetId) {
  const results = document.getElementById(targetId);
  if (!results) return;
  results.innerHTML = financeDepartmentSuggestions(query).map(value => `
    <button type="button" onclick="financeChooseDepartment(${index},'${financeEscapeAttr(encodeURIComponent(value))}')">${financeEscape(value)}</button>
  `).join('');
  results.classList.add('open');
}

function financeDepartmentInput(index, value) {
  const line = financeState.current?.lineItems?.[index];
  if (!line) return;
  line.department = value;
  line.departmentCode = '';
  if (value && !financeState.current.departments.includes(value)) financeState.current.departments.push(value);
  financeQueueSave();
}

function financeChooseDepartment(index, encodedValue) {
  const value = decodeURIComponent(encodedValue);
  const line = financeState.current?.lineItems?.[index];
  if (!line) return;
  line.department = value;
  if (!financeState.current.departments.includes(value)) financeState.current.departments.push(value);
  financeQueueSave();
  financeRenderEditor();
}

function financeShowAddDepartmentSuggestions(query) {
  const results = document.getElementById('financeAddDepartmentResults');
  if (!results) return;
  results.innerHTML = financeDepartmentSuggestions(query).map(value => `
    <button type="button" onclick="financeChooseAddDepartment('${financeEscapeAttr(encodeURIComponent(value))}')">${financeEscape(value)}</button>
  `).join('');
  results.classList.add('open');
}

function financeChooseAddDepartment(encodedValue) {
  financeState.addDepartment = decodeURIComponent(encodedValue);
  const input = document.getElementById('financeAddDepartmentInput');
  if (input) input.value = financeState.addDepartment;
  document.getElementById('financeAddDepartmentResults')?.classList.remove('open');
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
  return (financeState.current?.adjustments || [])
    .filter(row => row.scope === 'department' && row.department === department)
    .map(row => `
      <tr class="finance-adjustment-row">
        <td></td><td colspan="7">${financeEscape(row.label)}</td>
        <td style="text-align:right;">${financeEscape(financeMoney(row.amount))}</td>
        <td><button type="button" class="finance-delete-line" onclick="financeRemoveAdjustment('${financeEscapeAttr(row.id)}')">×</button></td>
      </tr>
    `).join('');
}

function financeRenderLineGroups() {
  const document = financeState.current;
  const configured = [...new Set([...(document.departments || []), 'Manpower', 'Transportation'])];
  const active = (document.lineItems || []).map(line => line.department || 'Unknown Department');
  active.forEach(value => { if (!configured.includes(value)) configured.push(value); });
  return configured.map(department => {
    const rows = (document.lineItems || []).map((line, index) => ({ line, index }))
      .filter(row => (row.line.department || 'Unknown Department') === department);
    const base = rows.reduce((sum, row) => sum + financeLineTotal(row.line), 0);
    const adjustment = (document.adjustments || []).filter(row => row.scope === 'department' && row.department === department)
      .reduce((sum, row) => sum + financeNumber(row.amount), 0);
    const subtotal = base + adjustment;
    const encoded = encodeURIComponent(department);
    const lineRows = rows.map(({ line, index }) => {
      const departmentResultsId = `finance-department-results-${line.id}`;
      return `
        <tr>
          <td>${index + 1}</td>
          <td><input class="finance-line-input" value="${financeEscapeAttr(line.description)}" aria-label="Description" onchange="financeLineChange(${index},'description',this.value)"></td>
          <td>
            <div class="finance-inline-combobox">
              <input class="finance-line-input" value="${financeEscapeAttr(line.department)}" aria-label="Department" autocomplete="off"
                onfocus="financeShowDepartmentSuggestions(${index},this.value,'${departmentResultsId}')"
                oninput="financeDepartmentInput(${index},this.value);financeShowDepartmentSuggestions(${index},this.value,'${departmentResultsId}')">
              <div class="finance-inline-suggestions" id="${departmentResultsId}"></div>
            </div>
          </td>
          <td><input class="finance-line-input" type="number" min="0" step="0.25" value="${financeEscapeAttr(line.days)}" aria-label="Days" onchange="financeLineChange(${index},'days',this.value)"></td>
          <td><input class="finance-line-input" type="number" min="0" step="0.25" value="${financeEscapeAttr(line.quantity)}" aria-label="Quantity" onchange="financeLineChange(${index},'quantity',this.value)"></td>
          <td>${financeUomControl(line, index)}</td>
          <td><div class="finance-money-input"><span>$</span><input class="finance-line-input" type="number" min="0" step="0.01" value="${financeEscapeAttr(line.unitPrice)}" aria-label="Unit price" onchange="financeLineChange(${index},'unitPrice',this.value)"></div></td>
          <td><input class="finance-line-input" type="number" min="0" max="100" step="0.1" value="${financeEscapeAttr(line.discountPercent || 0)}" aria-label="Discount percentage" onchange="financeLineChange(${index},'discountPercent',this.value)"></td>
          <td style="text-align:right;font-weight:700;">${financeEscape(financeMoney(financeLineTotal(line)))}</td>
          <td><button type="button" class="finance-delete-line" title="Delete line" onclick="financeDeleteLine(${index})">×</button></td>
        </tr>
      `;
    }).join('');
    return `
      <tr class="finance-department-row"><td colspan="10">${financeEscape(department)}</td></tr>
      ${lineRows || '<tr class="finance-empty-department"><td></td><td colspan="9">No items yet. Add an item below and choose this department.</td></tr>'}
      ${financeAdjustmentRows(department)}
      <tr class="finance-department-subtotal-row">
        <td></td><td colspan="7">${financeEscape(department)} subtotal</td>
        <td><div class="finance-money-input finance-subtotal-input"><span>$</span><input type="number" step="0.01" value="${subtotal.toFixed(2)}" onchange="financeOverrideDepartmentSubtotal(decodeURIComponent('${encoded}'),this.value)"></div></td><td></td>
      </tr>
    `;
  }).join('');
}

function financeSwitch(label, checked, handler) {
  return `<button type="button" class="finance-switch ${checked ? 'on' : ''}" role="switch" aria-checked="${checked}" onclick="${handler}"><span></span>${financeEscape(label)}</button>`;
}

function financeRenderEditor() {
  const root = financeRoot();
  const document = financeState.current;
  if (!root || !document) return;
  document.departments = [...new Set([...(document.departments || []), 'Manpower', 'Transportation'])];
  const totals = financeTotals(document);
  const client = document.client || {};
  const lockMismatch = document.totalLocked && Math.abs(totals.lockDifference) > 0.01;
  const allDaysMenu = `finance-days-all-${document.id}`;
  root.innerHTML = `
    <div class="finance-editor-header">
      <div>
        <button type="button" class="finance-back" onclick="financeBackToList()">← Back to Quotations</button>
        <h2 id="financeDocumentNumber" style="margin-top:8px;">${financeEscape(document.number)}</h2>
        <span class="finance-save-state" id="financeSaveState">${document.projectName ? 'All changes saved' : 'Project Name is required before saving'}</span>
      </div>
      <div class="finance-editor-actions">
        ${financeStatusControl(document, 'editor')}
        <button type="button" class="btn btn-secondary" onclick="financeExportPdf()">Export PDF</button>
        <button type="button" class="btn btn-danger" onclick="financeDeleteCurrent()">Delete</button>
        <button type="button" class="btn btn-primary" onclick="financeSaveCurrent(true)">Save</button>
      </div>
    </div>

    <div class="finance-editor-layout">
      <div class="finance-main-column">
        <section class="finance-card finance-section">
          <h3>Client &amp; quotation details</h3>
          <div class="finance-client-search-wrap">
            <input id="financeClientSearch" class="finance-input" value="${financeEscapeAttr(financeClientDisplay(client))}" placeholder="Search clients by name, company, phone or email..." autocomplete="off"
              onfocus="financeShowClientSuggestions(this.value)" oninput="financeShowClientSuggestions(this.value)">
            <button type="button" class="btn btn-secondary" onclick="financeOpenClientModal()">+ New Client</button>
            <div class="finance-client-results" id="financeClientResults"></div>
          </div>
          <div class="finance-form-grid">
            <label class="finance-field"><span>Name</span><input class="finance-input" value="${financeEscapeAttr(client.name || '')}" onchange="financeClientFieldChange('name',this.value)"></label>
            <label class="finance-field"><span>Company</span><input class="finance-input" value="${financeEscapeAttr(client.company || '')}" onchange="financeClientFieldChange('company',this.value)"></label>
            <label class="finance-field"><span>Email</span><input class="finance-input" type="email" value="${financeEscapeAttr(client.email || '')}" onchange="financeClientFieldChange('email',this.value)"></label>
            <label class="finance-field finance-span-2"><span>Billing address</span><input class="finance-input" value="${financeEscapeAttr([client.address1, client.address2, client.address3, client.postalCode].filter(Boolean).join(', '))}" onchange="financeSetClientAddress(this.value)"></label>
            <label class="finance-field"><span>Phone</span><input class="finance-input" value="${financeEscapeAttr(client.phone || '')}" onchange="financeClientFieldChange('phone',this.value)"></label>
            <label class="finance-field finance-span-2"><span>Project Name *</span><input class="finance-input" required value="${financeEscapeAttr(document.projectName || '')}" onchange="financeFieldChange('projectName',this.value)"></label>
            <label class="finance-field"><span>PO / reference number</span><input class="finance-input" value="${financeEscapeAttr(document.reference || '')}" onchange="financeFieldChange('reference',this.value)"></label>
            <label class="finance-field"><span>Quotation date</span><input class="finance-input" type="date" value="${financeEscapeAttr(document.quotationDate || '')}" onchange="financeFieldChange('quotationDate',this.value)"></label>
            <label class="finance-field"><span>Valid until</span><input class="finance-input" type="date" value="${financeEscapeAttr(document.validUntil || '')}" onchange="financeFieldChange('validUntil',this.value)"></label>
            <label class="finance-field"><span>Payment terms</span><input class="finance-input" value="${financeEscapeAttr(document.paymentTerms || '')}" onchange="financeFieldChange('paymentTerms',this.value)"></label>
            <label class="finance-field finance-span-all"><span>Event location</span><input class="finance-input" value="${financeEscapeAttr(document.eventLocation || '')}" onchange="financeFieldChange('eventLocation',this.value)"></label>
          </div>
        </section>

        <section class="finance-card finance-section">
          <div class="finance-section-heading"><div><h3>Event schedule</h3><p>Dates are optional. New line items will use ${financeEventDays(document)} day(s).</p></div></div>
          <div class="finance-schedule-grid">
            ${[['Set-up','setup'],['Rehearsal','rehearsal'],['Show','show'],['Teardown','teardown']].map(([label,key]) => `
              <div class="finance-schedule-pair">
                <strong>${label}</strong>
                <input class="finance-input" type="date" value="${financeEscapeAttr(document[`${key}Date`] || '')}" onchange="financeScheduleChange('${key}Date',this.value)">
                <input class="finance-input" type="time" value="${financeEscapeAttr(document[`${key}Time`] || '')}" onchange="financeScheduleChange('${key}Time',this.value)">
              </div>
            `).join('')}
          </div>
        </section>

        <section class="finance-card finance-lines-card">
          <div class="finance-section finance-section-heading">
            <div><h3>Line items</h3><p>Department names accept free text and saved suggestions.</p></div>
            <div class="finance-custom-control">
              <button type="button" class="btn btn-secondary" onclick="financeToggleMenu('${allDaysMenu}',event)">Set all days</button>
              <div class="finance-custom-menu finance-days-menu" id="${allDaysMenu}">
                <label>Days<input id="financeAllDaysValue" class="finance-input" type="number" min="0" step="0.25" value="${financeEventDays(document)}"></label>
                <button type="button" class="btn btn-primary" onclick="financeSetAllDays()">Apply</button>
              </div>
            </div>
          </div>
          <div style="overflow-x:auto;">
            <table class="finance-lines-table">
              <colgroup><col style="width:42px"><col style="width:24%"><col style="width:155px"><col style="width:64px"><col style="width:64px"><col style="width:84px"><col style="width:105px"><col style="width:70px"><col style="width:105px"><col style="width:38px"></colgroup>
              <thead><tr><th>#</th><th>Description</th><th>Department</th><th>Days</th><th>Qty</th><th>UOM</th><th>Unit price</th><th>Disc %</th><th style="text-align:right;">Total</th><th></th></tr></thead>
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
            <span>Total before GST</span>
            <div class="finance-lock-value">
              <div class="finance-money-input"><span>$</span><input type="number" step="0.01" value="${(document.totalLocked ? totals.lockedPreTax : totals.netSubtotal).toFixed(2)}" onchange="financeSetLockedPreTax(this.value)"></div>
              <button type="button" class="finance-lock-button ${document.totalLocked ? 'locked' : ''}" title="${document.totalLocked ? 'Unlock pre-GST total' : 'Lock pre-GST total'}" onclick="financeToggleTotalLock()"> ${document.totalLocked ? '🔒' : '🔓'} </button>
            </div>
          </div>
          ${document.totalLocked ? `<div class="finance-lock-difference ${lockMismatch ? 'mismatch' : 'matched'}"><span>Calculated departments</span><strong>${financeMoney(totals.netSubtotal)}</strong><span>Difference</span><strong>${financeMoney(totals.lockDifference)}</strong></div>` : ''}
          <div class="finance-summary-row"><span>${financeEscape(pdfSettings?.taxLabel || 'GST')} (${financeNumber(document.taxRate)}%)</span><strong>${financeEscape(financeMoney(totals.tax))}</strong></div>
          <div class="finance-summary-row finance-summary-total"><span>Total</span><strong>${financeEscape(financeMoney(totals.total))}</strong></div>
          ${lockMismatch ? '<p class="finance-lock-warning">Department subtotals must match the locked pre-GST total before sending or exporting.</p>' : ''}
        </section>
        <section class="finance-card finance-section">
          <h3>PDF visibility</h3>
          ${financeSwitch('Show unit prices', !!document.showUnitPrices, "financeToggleDocumentFlag('showUnitPrices')")}
          ${financeSwitch('Show department discounts', !!document.showDepartmentDiscounts, "financeToggleDocumentFlag('showDepartmentDiscounts')")}
        </section>
        <section class="finance-card finance-section">
          <h3>Revision</h3>
          <div class="finance-summary-row"><span>Current revision</span><strong>${String(document.revision || 1).padStart(2, '0')}</strong></div>
          <div class="finance-summary-row"><span>Sent snapshots</span><strong>${(document.revisions || []).length}</strong></div>
          ${document.eventId ? `<div class="finance-summary-row"><span>Created event</span><strong>#${document.eventId}</strong></div>` : ''}
        </section>
      </aside>
    </div>
  `;
}

function financeBackToList() {
  clearTimeout(financeState.saveTimer);
  const leave = () => { financeState.current = null; financeLoadList(); };
  if (!financeState.current?.projectName) return leave();
  financeSaveCurrent(false).finally(leave);
}

function financeFieldChange(field, value) {
  if (!financeState.current) return;
  financeState.current[field] = field === 'taxRate' ? financeNumber(value) : value;
  if (field === 'projectName') financeState.current.title = value;
  financeQueueSave();
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
  line.total = financeLineTotal(line);
  financeQueueSave();
  financeRenderEditor();
}

function financeDeleteLine(index) {
  financeState.current.lineItems.splice(index, 1);
  const active = new Set(financeState.current.lineItems.map(line => line.department));
  financeState.current.adjustments = (financeState.current.adjustments || []).filter(row => row.scope !== 'department' || active.has(row.department));
  financeQueueSave();
  financeRenderEditor();
}

function financeRemoveAdjustment(id) {
  financeState.current.adjustments = (financeState.current.adjustments || []).filter(row => row.id !== id);
  financeQueueSave();
  financeRenderEditor();
}

function financeOverrideDepartmentSubtotal(department, rawTarget) {
  const target = Math.max(0, financeNumber(rawTarget));
  const base = financeState.current.lineItems.filter(line => line.department === department).reduce((sum, line) => sum + financeLineTotal(line), 0);
  const difference = target - base;
  const percent = base ? Math.abs(difference) / base * 100 : 0;
  const adjustments = financeState.current.adjustments || (financeState.current.adjustments = []);
  const existing = adjustments.find(row => row.scope === 'department' && row.department === department);
  if (Math.abs(difference) < 0.005) {
    financeState.current.adjustments = adjustments.filter(row => row !== existing);
  } else {
    const row = existing || { id: `adjustment_${Date.now()}_${Math.random().toString(16).slice(2)}`, scope: 'department', department };
    Object.assign(row, {
      amount: Math.round(difference * 100) / 100,
      percent,
      kind: difference < 0 ? 'discount' : 'adjustment',
      label: `${percent.toFixed(2).replace(/\.?0+$/, '')}% department ${difference < 0 ? 'discount' : 'adjustment'}`
    });
    if (!existing) adjustments.push(row);
  }
  financeQueueSave();
  financeRenderEditor();
}

function financeSetAllDays() {
  const value = Math.max(0, financeNumber(document.getElementById('financeAllDaysValue')?.value, 1));
  financeState.current.lineItems.forEach(line => { line.days = value; line.total = financeLineTotal(line); });
  financeQueueSave();
  financeRenderEditor();
}

function financeToggleTotalLock() {
  const totals = financeTotals();
  financeState.current.totalLocked = !financeState.current.totalLocked;
  financeState.current.lockedPreTaxTotal = financeState.current.totalLocked ? totals.netSubtotal : null;
  financeQueueSave();
  financeRenderEditor();
}

function financeSetLockedPreTax(value) {
  financeState.current.totalLocked = true;
  financeState.current.lockedPreTaxTotal = Math.max(0, financeNumber(value));
  financeQueueSave();
  financeRenderEditor();
}

function financeToggleDocumentFlag(field) {
  financeState.current[field] = !financeState.current[field];
  financeQueueSave();
  financeRenderEditor();
}

function financeQueueSave() {
  financeState.changeVersion += 1;
  const state = document.getElementById('financeSaveState');
  if (state) state.textContent = financeState.current?.projectName ? 'Unsaved changes' : 'Project Name is required before saving';
  clearTimeout(financeState.saveTimer);
  if (!financeState.current?.projectName) return;
  financeState.saveTimer = setTimeout(() => financeSaveCurrent(false), 650);
}

async function financeSaveCurrent(notify = false) {
  const current = financeState.current;
  if (!current) return null;
  if (!String(current.projectName || '').trim()) {
    const state = document.getElementById('financeSaveState');
    if (state) state.textContent = 'Project Name is required before saving';
    if (notify) showNotification('warning', 'Project Name is required');
    throw new Error('Project Name is required');
  }
  clearTimeout(financeState.saveTimer);
  const version = financeState.changeVersion;
  const state = document.getElementById('financeSaveState');
  if (state) state.textContent = 'Saving...';
  try {
    const response = await apiCall(`/api/quotations/${encodeURIComponent(current.id)}`, 'PUT', current);
    if (financeState.current?.id === current.id && financeState.changeVersion === version) {
      const previousNumber = financeState.current.number;
      const previousStatus = financeState.current.status;
      financeState.current = response.data;
      if (previousNumber !== response.data.number || previousStatus !== response.data.status || notify) financeRenderEditor();
    } else if (financeState.current?.id === current.id) {
      clearTimeout(financeState.saveTimer);
      financeState.saveTimer = setTimeout(() => financeSaveCurrent(false), 300);
    }
    const nextState = document.getElementById('financeSaveState');
    if (nextState) nextState.textContent = 'All changes saved';
    if (notify) showNotification('success', 'Quotation saved');
    return response.data;
  } catch (error) {
    if (state) state.textContent = 'Save failed';
    if (notify || error.message !== 'Project Name is required') showNotification('error', error.message || 'Failed to save quotation');
    throw error;
  }
}

function financeSearchCatalog(query) {
  clearTimeout(financeState.catalogTimer);
  const results = document.getElementById('financeCatalogResults');
  if (!query.trim()) {
    financeState.catalog = [];
    results?.classList.remove('open');
    return;
  }
  financeState.catalogTimer = setTimeout(async () => {
    try {
      const response = await apiCall(`/api/finance/catalog?query=${encodeURIComponent(query)}`);
      financeState.catalog = response.data || [];
    } catch {
      financeState.catalog = [];
    }
    financeRenderCatalog();
  }, 220);
}

function financeRenderCatalog() {
  const results = document.getElementById('financeCatalogResults');
  if (!results) return;
  results.innerHTML = financeState.catalog.map((row, index) => `
    <button type="button" class="finance-catalog-option" onclick="financeSelectCatalog(${index})">
      <span><strong>${financeEscape(row.description)}</strong><br><small>${financeEscape(row.department)}${row.availableQuantity === null ? ' · previously used' : ` · ${financeNumber(row.availableQuantity)} available`}</small></span>
      <span>${row.unitPrice ? financeEscape(financeMoney(row.unitPrice)) : '<small>No saved price</small>'}</span>
    </button>
  `).join('') || '<div class="finance-suggestion-empty">Press Add to create a custom item</div>';
  results.classList.add('open');
}

function financeSelectCatalog(index) {
  const selected = financeState.catalog[index];
  if (!selected) return;
  const department = financeState.addDepartment?.trim() || selected.department || 'Manpower';
  financeState.current.lineItems.push({
    id: `line_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    catalogKey: selected.catalogKey || '',
    sourceAssetIds: selected.sourceAssetIds || [],
    brand: selected.brand || '',
    model: selected.model || '',
    description: selected.description,
    department,
    departmentCode: selected.departmentCode || '',
    days: financeEventDays(),
    quantity: 1,
    uom: selected.uom || 'units',
    unitPrice: financeNumber(selected.unitPrice),
    discountPercent: 0,
    total: financeNumber(selected.unitPrice) * financeEventDays(),
    isCustom: !!selected.isCustom
  });
  if (!financeState.current.departments.includes(department)) financeState.current.departments.push(department);
  financeState.catalog = [];
  financeQueueSave();
  financeRenderEditor();
}

async function financeAddCustomItem() {
  const input = document.getElementById('financeAddItemInput');
  const description = input?.value.trim();
  if (!description) return input?.focus();
  let remembered = {};
  try {
    remembered = (await apiCall(`/api/finance/price-suggestion?description=${encodeURIComponent(description)}`)).data || {};
  } catch {}
  const department = financeState.addDepartment?.trim() || remembered.department || 'Manpower';
  financeState.current.lineItems.push({
    id: `line_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    catalogKey: '',
    sourceAssetIds: [],
    brand: '',
    model: '',
    description,
    department,
    departmentCode: remembered.departmentCode || '',
    days: financeEventDays(),
    quantity: 1,
    uom: remembered.uom || 'units',
    unitPrice: financeNumber(remembered.unitPrice),
    discountPercent: 0,
    total: financeNumber(remembered.unitPrice) * financeEventDays(),
    isCustom: true
  });
  if (!financeState.current.departments.includes(department)) financeState.current.departments.push(department);
  financeQueueSave();
  financeRenderEditor();
}

function financeAddItemKeydown(event) {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  if (financeState.catalog.length === 1) financeSelectCatalog(0);
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
      <p style="color:#64748b;margin-bottom:16px;">A snapshot of this revision will be saved. Later edits will create the next revision.</p>
      <label class="finance-field"><span>Quotation validity (days)</span><input id="financeSentValidityDays" class="finance-input" type="number" min="1" max="365" value="30"></label>
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
    document.getElementById('financeSentValidityDays').value = documentRow.validityDays || 30;
    openModal('financeSentModal');
    return;
  }
  if (status === 'accepted') {
    const confirmed = await showAppConfirm({
      title: 'Accept quotation and create event?',
      message: 'This will create an event with the quotation project, location and required items.',
      confirmText: 'Accept & Create Event',
      cancelText: 'Cancel'
    });
    if (!confirmed) return;
  }
  await financeCommitStatus(documentId, status, {});
}

async function financeConfirmSent() {
  const days = Math.max(1, financeNumber(document.getElementById('financeSentValidityDays')?.value, 30));
  closeModal('financeSentModal');
  await financeCommitStatus(financeState.statusTargetId, 'sent', { validityDays: days });
}

async function financeCommitStatus(documentId, status, extras) {
  try {
    if (financeState.current?.id === documentId) await financeSaveCurrent(false);
    const response = await apiCall(`/api/quotations/${encodeURIComponent(documentId)}`, 'PUT', { status, ...extras });
    if (financeState.current?.id === documentId) {
      financeState.current = response.data;
      financeRenderEditor();
    } else {
      await financeLoadList();
    }
    const eventNote = status === 'accepted' && response.data.eventId ? ` Event #${response.data.eventId} was created.` : '';
    showNotification('success', `Quotation marked ${financeStatusLabel(response.data.status)}.${eventNote}`);
  } catch (error) {
    showNotification('error', error.message || 'Failed to change quotation status');
  }
}

async function financeExportPdf() {
  try {
    const current = await financeSaveCurrent(false);
    const totals = financeTotals(current);
    if (current.totalLocked && Math.abs(totals.lockDifference) > 0.01) {
      throw new Error('Department subtotals must match the locked pre-GST total before exporting');
    }
    const link = document.createElement('a');
    link.href = `/api/quotations/${encodeURIComponent(current.id)}/pdf`;
    link.download = `${current.number || 'quotation'}.pdf`;
    document.body.appendChild(link);
    link.click();
    link.remove();
  } catch (error) {
    showNotification('error', error.message || 'Failed to export quotation');
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
          <label class="finance-field"><span>Name *</span><input id="financeClientName" class="finance-input" required></label>
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
  openModal('financeClientModal');
}

async function financeSaveNewClient(event) {
  event.preventDefault();
  const value = id => document.getElementById(id)?.value.trim() || '';
  try {
    const response = await apiCall('/api/clients', 'POST', {
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
