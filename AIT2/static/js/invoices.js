const INVOICE_PLAN_STATUSES = ['draft', 'sent', 'partially-paid', 'paid', 'overdue', 'cancelled'];
const INVOICE_DOCUMENT_STATUSES = ['draft', 'sent', 'partially-paid', 'paid', 'overdue', 'void'];

const invoiceState = {
  rows: [],
  issuedInvoices: [],
  view: 'plans',
  current: null,
  query: '',
  statuses: [],
  mineOnly: true,
  searchTimer: null,
  saveTimer: null,
  activeSave: null,
  saving: false,
  dirty: false,
  changeVersion: 0,
  basePlan: null,
  remoteUpdatePending: false,
  listMeta: { total: 0, hasMore: false, nextOffset: null, statusTotal: 0, statusCounts: {} },
  listLoading: false,
  listRequestVersion: 0,
  paidTarget: null,
  sentTarget: null,
  defaultPaymentTermDays: null,
  clients: [],
  soaCompanies: [],
  soaCompany: '',
  planTemplates: [],
  planTemplateDraft: null
};

function invoiceClone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function invoiceValuesEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function invoiceHasPendingChanges() {
  return Boolean(
    invoiceState.current
    && (invoiceState.dirty || invoiceState.saveTimer || invoiceState.activeSave)
  );
}

function invoiceMergePlan(base, local, latest) {
  if (typeof financeMergeDocumentConflict === 'function') {
    return financeMergeDocumentConflict(base, local, latest);
  }
  return { ...invoiceClone(latest), ...invoiceClone(local), documentVersion: latest?.documentVersion };
}

async function invoiceHandleRealtimeChanges(changes) {
  const rows = Array.isArray(changes) ? changes : [];
  const quotationIds = [...new Set(rows
    .map(row => String(row?.quotationId || '').trim())
    .filter(Boolean))];
  const currentQuotationId = String(invoiceState.current?.quotation?.id || '');
  if (currentQuotationId && quotationIds.includes(currentQuotationId)) {
    let response;
    try {
      response = await apiCall(
        `/api/invoice-plans/${encodeURIComponent(currentQuotationId)}`
      );
    } catch (error) {
      if (error.payload?.code !== 'quotation_not_invoice_ready') throw error;
      invoiceState.current = null;
      invoiceState.basePlan = null;
      invoiceState.dirty = false;
      invoiceState.remoteUpdatePending = false;
      showNotification('info', 'This quotation is no longer ready for invoicing.');
      await loadInvoices(invoiceState.query);
      return true;
    }
    if (!invoiceState.dirty) {
      invoiceState.current = response.data;
      invoiceState.basePlan = invoiceClone(response.data.plan);
      invoiceState.remoteUpdatePending = false;
    } else {
      const base = invoiceState.basePlan || invoiceState.current.plan;
      invoiceState.current.plan = invoiceMergePlan(
        base, invoiceState.current.plan, response.data.plan
      );
      invoiceState.current.plan.documentVersion = base.documentVersion;
      invoiceState.current.quotation = response.data.quotation;
      invoiceState.remoteUpdatePending = true;
    }
    invoiceRenderEditor();
    return true;
  }
  if (quotationIds.length) {
    await loadInvoices(invoiceState.query);
    return true;
  }
  return false;
}

function invoiceRoot() {
  return document.getElementById('invoices-page-root');
}

function invoiceEscape(value) {
  if (typeof financeEscape === 'function') return financeEscape(value);
  const node = document.createElement('div');
  node.textContent = String(value ?? '');
  return node.innerHTML;
}

function invoiceAttr(value) {
  return invoiceEscape(value).replace(/"/g, '&quot;');
}

function invoiceMoney(value) {
  if (typeof financeMoney === 'function') return financeMoney(value);
  return `$${Number(value || 0).toFixed(2)}`;
}

function invoiceToday() {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function invoiceDateFromToday(days = 0) {
  const date = new Date();
  date.setDate(date.getDate() + Number(days || 0));
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function invoiceDueCountdown(value) {
  const raw = String(value || '').slice(0, 10);
  if (!raw) return '';
  const due = new Date(`${raw}T00:00:00`);
  const today = new Date(`${invoiceToday()}T00:00:00`);
  if (Number.isNaN(due.getTime())) return '';
  const days = Math.round((due.getTime() - today.getTime()) / 86400000);
  if (days === 0) return 'Due today';
  if (days === 1) return '1 day from today';
  if (days > 1) return `${days} days from today`;
  if (days === -1) return '1 day overdue';
  return `${Math.abs(days)} days overdue`;
}

function invoiceUid(prefix) {
  if (window.crypto?.randomUUID) return `${prefix}-${window.crypto.randomUUID()}`;
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function invoiceStatusLabel(status) {
  return String(status || 'draft')
    .split('-')
    .map(part => part ? part[0].toUpperCase() + part.slice(1) : '')
    .join(' ');
}

function invoiceStatusBadgeMarkup(status) {
  const value = String(status || 'draft').toLowerCase();
  return `<span class="invoice-status" data-status="${invoiceAttr(value)}">${invoiceStatusLabel(value)}</span>`;
}

function invoiceDocumentStatusChoices(status) {
  const value = String(status || 'draft').toLowerCase();
  if (value === 'draft') return ['draft', 'sent'];
  if (value === 'paid' || value === 'void') return [value, 'draft'];
  return [...new Set([value, 'draft', 'paid', 'void'])];
}

async function invoiceLoadPlanTemplates(force = false) {
  if (!force && invoiceState.planTemplates.length) return invoiceState.planTemplates;
  try {
    const response = await apiCall('/api/invoice-plan-templates');
    invoiceState.planTemplates = response.data || [];
    if (typeof financeState !== 'undefined') {
      financeState.invoicePlanTemplates = invoiceClone(invoiceState.planTemplates);
      financeState.editorDataLoadedAt = 0;
    }
  } catch (_error) {
    invoiceState.planTemplates = [];
  }
  return invoiceState.planTemplates;
}

function invoicePaymentTermDays(value, fallback = 30) {
  const text = String(value || '').trim().toLowerCase();
  if (/(due on receipt|on receipt|immediate|cod)/.test(text)) return 0;
  const match = text.match(/\b(\d{1,4})\b/);
  if (!match) return Math.max(0, Number(fallback || 30));
  const amount = Math.max(0, Math.min(3650, Number(match[1])));
  if (text.includes('week')) return Math.min(3650, amount * 7);
  if (text.includes('month')) return Math.min(3650, amount * 30);
  return amount;
}

function invoiceClientLabel(quotation) {
  const client = quotation?.client || {};
  return client.company || client.name || 'No client';
}

function invoicePlanDetails(plan = invoiceState.current?.plan, quotation = invoiceState.current?.quotation) {
  if (!plan) return {};
  if (!plan.invoiceDetails) {
    plan.invoiceDetails = {
      client: { ...(quotation?.client || {}) },
      clientRecordName: quotation?.clientRecordName || '',
      projectName: quotation?.projectName || '',
      eventLocation: quotation?.eventLocation || '',
      salesperson: quotation?.salesperson || '',
      salespersonUsername: quotation?.salespersonUsername || '',
      reference: quotation?.reference || '',
      paymentTerms: quotation?.paymentTerms || ''
    };
  }
  plan.invoiceDetails.client ||= {};
  return plan.invoiceDetails;
}

function invoiceClientDisplay(client = {}) {
  return [client.salutation, client.name].filter(Boolean).join(' ').trim()
    || client.company || client.email || '';
}

function invoiceSalutationControl(value) {
  if (typeof financeSalutationControl === 'function') {
    return financeSalutationControl(
      value || '', 'invoice-client-salutation-menu', 'invoiceSetClientSalutation'
    );
  }
  return '';
}

function invoiceDateLabel(value) {
  if (!value) return 'Not set';
  const date = new Date(`${String(value).slice(0, 10)}T00:00:00`);
  return Number.isNaN(date.getTime())
    ? String(value)
    : date.toLocaleDateString('en-SG', { day: 'numeric', month: 'short', year: 'numeric' });
}

function invoiceLocalSummary(plan, quotation) {
  const total = Number(quotation?.totals?.total || 0);
  const taxRate = Math.max(0, Number(quotation?.taxRate || 0));
  const preTaxTotal = Number(
    quotation?.totals?.netSubtotal
    ?? (taxRate ? total / (1 + taxRate / 100) : total)
  );
  const discountMode = plan?.invoiceDiscountMode === 'amount' ? 'amount' : 'percentage';
  const discountValue = Math.max(0, Number(plan?.invoiceDiscountValue || 0));
  const discountAmount = Math.min(preTaxTotal, discountMode === 'amount'
    ? discountValue
    : preTaxTotal * Math.min(100, discountValue) / 100);
  const adjustedPreTax = Math.max(0, Math.round((preTaxTotal - discountAmount) * 100) / 100);
  const adjustedTax = Math.round(adjustedPreTax * taxRate) / 100;
  const adjustedTotal = Math.max(0, Math.round((adjustedPreTax + adjustedTax) * 100) / 100);
  const installments = plan?.installments || [];
  const payments = plan?.payments || [];
  const amountFor = row => invoiceInstallmentIsFrozen(row)
    ? Number(row.amount || 0)
    : row.mode === 'percentage'
    ? Math.round(adjustedTotal * Number(row.value || 0)) / 100
    : Number(row.value || 0);
  installments.forEach(row => { row.amount = Math.round(amountFor(row) * 100) / 100; });
  const active = installments.filter(row => !['cancelled', 'void'].includes(row.status));
  const planned = active.reduce((sum, row) => sum + Number(row.amount || 0), 0);
  const invoiced = active.filter(row => row.invoiceId).reduce((sum, row) => sum + Number(row.amount || 0), 0);
  const paid = payments.reduce((sum, row) => sum + Number(row.amount || 0), 0);
  return {
    quotationTotal: total,
    invoiceDiscountMode: discountMode,
    invoiceDiscountValue: discountValue,
    invoiceDiscountAmount: Math.round(discountAmount * 100) / 100,
    quotationPreTax: Math.round(preTaxTotal * 100) / 100,
    adjustedPreTax,
    taxRate,
    adjustedTax,
    adjustedTotal,
    planned,
    unplanned: Math.max(0, adjustedTotal - planned),
    invoiced,
    notInvoiced: Math.max(0, adjustedTotal - invoiced),
    paid,
    due: Math.max(0, adjustedTotal - paid),
    invoiceBalance: Math.max(0, invoiced - paid)
  };
}

function invoiceInstallmentIsFrozen(row) {
  return !!row?.invoiceId && (
    String(row.status || 'draft').toLowerCase() !== 'draft' || row.invoiceFrozen
  );
}

async function loadInvoices(query = '', options = {}) {
  const root = invoiceRoot();
  if (!root) return;
  const append = options.append === true;
  if (invoiceState.listLoading && append) return;
  if (!append) invoiceState.current = null;
  invoiceState.query = String(query || '').trim();
  const requestVersion = ++invoiceState.listRequestVersion;
  const requestedView = invoiceState.view;
  const requestedQuery = invoiceState.query;
  const requestedMineOnly = invoiceState.mineOnly;
  const requestedStatuses = [...invoiceState.statuses];
  const requestIsCurrent = () => (
    requestVersion === invoiceState.listRequestVersion
    && requestedView === invoiceState.view
    && requestedQuery === invoiceState.query
    && requestedMineOnly === invoiceState.mineOnly
    && requestedStatuses.length === invoiceState.statuses.length
    && requestedStatuses.every((status, index) => status === invoiceState.statuses[index])
  );
  invoiceState.listLoading = true;
  await invoiceLoadPlanTemplates();
  if (!append) root.innerHTML = `<div class="invoice-loading"><span></span>${requestedView === 'issued' ? 'Loading issued invoices...' : 'Loading invoice-ready quotations...'}</div>`;
  try {
    const params = new URLSearchParams();
    if (requestedQuery) params.set('query', requestedQuery);
    if (invoiceListCanToggleMine() && requestedMineOnly) params.set('mine', '1');
    requestedStatuses.forEach(status => params.append('status', status));
    params.set('limit', '40');
    if (append && invoiceState.listMeta.nextOffset != null) params.set('offset', String(invoiceState.listMeta.nextOffset));
    if (requestedView === 'issued') {
      params.set('view', 'summary');
      params.set('sort', 'number');
      const response = await apiCall(`/api/invoices?${params}`);
      if (!requestIsCurrent()) return;
      const incoming = response.data || [];
      invoiceState.issuedInvoices = append
        ? [...invoiceState.issuedInvoices, ...incoming.filter(row => !invoiceState.issuedInvoices.some(existing => existing.id === row.id))]
        : incoming;
      invoiceState.listMeta = { ...invoiceState.listMeta, ...(response.meta || {}) };
    } else {
      const response = await apiCall(`/api/invoice-plans${params.size ? `?${params}` : ''}`);
      if (!requestIsCurrent()) return;
      const incoming = response.data || [];
      invoiceState.rows = append
        ? [...invoiceState.rows, ...incoming.filter(row => !invoiceState.rows.some(existing => existing.quotation?.id === row.quotation?.id))]
        : incoming;
      invoiceState.listMeta = { ...invoiceState.listMeta, ...(response.meta || {}) };
    }
    invoiceRenderList();
  } catch (error) {
    if (requestIsCurrent()) {
      root.innerHTML = `<div class="invoice-empty"><strong>Invoices could not be loaded</strong><span>${invoiceEscape(error.message)}</span></div>`;
    }
  } finally {
    if (requestVersion === invoiceState.listRequestVersion) {
      invoiceState.listLoading = false;
    }
  }
}

function invoiceNumberSortValue(value) {
  return String(value || '').trim().toUpperCase();
}

function invoiceSetView(view) {
  if (!['plans', 'issued'].includes(view) || invoiceState.view === view) return;
  invoiceState.view = view;
  invoiceState.statuses = [];
  loadInvoices(invoiceState.query);
}

function invoiceQueueSearch(value) {
  clearTimeout(invoiceState.searchTimer);
  invoiceState.searchTimer = setTimeout(() => loadInvoices(value), 320);
}

function invoiceListCanToggleMine() {
  return (typeof isAdminUser === 'function' && isAdminUser())
    || (typeof isPlatformAdminUser === 'function' && isPlatformAdminUser());
}

function invoiceToggleMineOnly() {
  invoiceState.mineOnly = !invoiceState.mineOnly;
  const toggle = document.querySelector('.invoice-list-mine-toggle');
  toggle?.classList.toggle('on', invoiceState.mineOnly);
  toggle?.setAttribute('aria-checked', invoiceState.mineOnly ? 'true' : 'false');
  loadInvoices(invoiceState.query);
}

function invoiceToggleFilter(status) {
  if (status === 'all') {
    invoiceState.statuses = [];
  } else if ([...INVOICE_PLAN_STATUSES, ...INVOICE_DOCUMENT_STATUSES].includes(status)) {
    invoiceState.statuses = invoiceState.statuses.includes(status)
      ? invoiceState.statuses.filter(item => item !== status)
      : [...invoiceState.statuses, status];
  }
  loadInvoices(invoiceState.query);
}

function invoiceFilterMarkup() {
  const source = invoiceState.view === 'issued' ? invoiceState.issuedInvoices : invoiceState.rows;
  const statuses = invoiceState.view === 'issued' ? INVOICE_DOCUMENT_STATUSES : INVOICE_PLAN_STATUSES;
  const counts = invoiceState.listMeta.statusCounts || {};
  return `
    <div class="finance-list-status-filters invoice-filter-row" aria-label="Filter invoice statuses">
      <button type="button" class="finance-list-filter invoice-filter ${invoiceState.statuses.length ? '' : 'active'}" onclick="invoiceToggleFilter('all')">All <span>${Number(invoiceState.listMeta.statusTotal || source.length)}</span></button>
      ${statuses.filter(status => counts[status]).map(status => `
        <button type="button" data-status="${status}" class="finance-list-filter invoice-filter status-${status} ${invoiceState.statuses.includes(status) ? 'active' : ''}" onclick="invoiceToggleFilter('${status}')">
          ${invoiceStatusLabel(status)} <span>${counts[status]}</span>
        </button>
      `).join('')}
    </div>
  `;
}

function invoiceEnsureSoaModal() {
  let modal = document.getElementById('invoiceSoaModal');
  if (modal) return modal;
  modal = document.createElement('div');
  modal.id = 'invoiceSoaModal';
  modal.className = 'modal';
  modal.innerHTML = `
    <div class="modal-content invoice-soa-modal">
      <div class="modal-header">
        <div><h3 class="modal-title">Create Statement of Account</h3><p>Statements are grouped by company, regardless of the contact person.</p></div>
        <button type="button" class="close-btn" onclick="closeModal('invoiceSoaModal')" aria-label="Close dialog">&times;</button>
      </div>
      <div class="invoice-soa-body">
        <label class="invoice-soa-search"><span>Company</span><input id="invoiceSoaSearch" placeholder="Search companies" oninput="invoiceRenderSoaCompanies(this.value)"></label>
        <div id="invoiceSoaCompanies" class="invoice-soa-company-list" role="listbox" aria-label="Companies"></div>
        <label class="invoice-soa-date"><span>Statement date</span><input id="invoiceSoaDate" type="date"></label>
      </div>
      <div class="modal-actions invoice-soa-actions">
        <button type="button" class="btn btn-secondary" onclick="closeModal('invoiceSoaModal')">Cancel</button>
        <button type="button" id="invoiceSoaCreate" class="btn invoice-soa-create" onclick="invoiceCreateSoa()" disabled>Create SOA PDF</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  return modal;
}

function invoiceRenderSoaCompanies(query = '') {
  const list = document.getElementById('invoiceSoaCompanies');
  if (!list) return;
  const cleanQuery = String(query || '').trim().toLowerCase();
  const companies = invoiceState.soaCompanies.filter(row => (
    !cleanQuery || String(row.company || '').toLowerCase().includes(cleanQuery)
  ));
  list.innerHTML = companies.length ? companies.map(row => {
    const selected = row.company === invoiceState.soaCompany;
    return `
      <button type="button" class="invoice-soa-company ${selected ? 'selected' : ''}"
              role="option" aria-selected="${selected ? 'true' : 'false'}"
              onclick="invoiceSelectSoaCompany('${invoiceAttr(encodeURIComponent(row.company || '').replace(/'/g, '%27'))}')">
        <span><strong>${invoiceEscape(row.company)}</strong><small>${Number(row.invoiceCount || 0)} invoice${Number(row.invoiceCount || 0) === 1 ? '' : 's'}</small></span>
        <span><small>Outstanding</small><strong>${invoiceMoney(row.outstanding)}</strong></span>
      </button>`;
  }).join('') : '<div class="invoice-soa-empty">No matching companies with invoices.</div>';
}

function invoiceSelectSoaCompany(encodedCompany) {
  invoiceState.soaCompany = decodeURIComponent(String(encodedCompany || ''));
  invoiceRenderSoaCompanies(document.getElementById('invoiceSoaSearch')?.value || '');
  const createButton = document.getElementById('invoiceSoaCreate');
  if (createButton) createButton.disabled = !invoiceState.soaCompany;
}

async function invoiceOpenSoaModal() {
  invoiceEnsureSoaModal();
  invoiceState.soaCompany = '';
  const search = document.getElementById('invoiceSoaSearch');
  const date = document.getElementById('invoiceSoaDate');
  const list = document.getElementById('invoiceSoaCompanies');
  const createButton = document.getElementById('invoiceSoaCreate');
  if (search) search.value = '';
  if (date) date.value = invoiceToday();
  if (createButton) createButton.disabled = true;
  if (list) list.innerHTML = '<div class="invoice-loading"><span></span>Loading companies...</div>';
  openModal('invoiceSoaModal');
  try {
    const response = await apiCall('/api/statements-of-account/companies');
    invoiceState.soaCompanies = response.data || [];
    invoiceRenderSoaCompanies();
  } catch (error) {
    if (list) list.innerHTML = `<div class="invoice-soa-empty">${invoiceEscape(error.message || 'Unable to load companies')}</div>`;
  }
}

function invoiceCreateSoa() {
  const company = invoiceState.soaCompany;
  const statementDate = document.getElementById('invoiceSoaDate')?.value || invoiceToday();
  if (!company) {
    showNotification('error', 'Select a company first');
    return;
  }
  const url = `/api/statements-of-account/pdf?company=${encodeURIComponent(company)}&statementDate=${encodeURIComponent(statementDate)}`;
  const preview = window.open(url, '_blank');
  if (!preview) {
    showNotification('error', 'Allow pop-ups to create the SOA PDF');
    return;
  }
  preview.opener = null;
  closeModal('invoiceSoaModal');
}

function invoiceRenderList() {
  const root = invoiceRoot();
  if (!root) return;
  const showMineToggle = invoiceListCanToggleMine();
  const source = invoiceState.view === 'issued' ? invoiceState.issuedInvoices : invoiceState.rows;
  const visible = invoiceState.statuses.length
    ? source.filter(row => invoiceState.statuses.includes(
        invoiceState.view === 'issued' ? row.status : row.plan?.status || 'draft'
      ))
    : source;
  root.innerHTML = `
    <header class="invoice-list-header">
      <div>
        <div class="finance-toolbar-title-line">
          <h2>Invoices</h2>
          ${showMineToggle ? `<button type="button" class="finance-switch finance-list-mine-toggle invoice-list-mine-toggle ${invoiceState.mineOnly ? 'on' : ''}" role="switch" aria-checked="${invoiceState.mineOnly ? 'true' : 'false'}" onclick="invoiceToggleMineOnly()"><span aria-hidden="true"></span>My projects</button>` : ''}
        </div>
        <p>${invoiceState.view === 'issued' ? 'Review every issued invoice by invoice number and project.' : 'Build installment plans, issue invoices and track every payment.'}</p>
      </div>
      <div class="invoice-list-actions">
        <button type="button" class="invoice-soa-button" onclick="invoiceOpenSoaModal()">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h9l3 3v15H6z"></path><path d="M15 3v4h4M9 11h6M9 15h6"></path></svg>
          Create SOA
        </button>
        <button type="button" class="invoice-view-toggle" onclick="invoiceSetView('${invoiceState.view === 'issued' ? 'plans' : 'issued'}')">
          <svg viewBox="0 0 24 24" aria-hidden="true">${invoiceState.view === 'issued' ? '<path d="M4 6h16M4 12h16M4 18h16"></path>' : '<path d="M7 3h10v18H7zM10 8h4M10 12h4M10 16h4"></path>'}</svg>
          ${invoiceState.view === 'issued' ? 'View billing plans' : 'View all invoices'}
        </button>
        <label class="invoice-search">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-4-4"></path></svg>
          <input value="${invoiceAttr(invoiceState.query)}" placeholder="Search invoice, project or client" oninput="invoiceQueueSearch(this.value)">
        </label>
      </div>
    </header>
    <section class="invoice-list-shell">
      ${invoiceFilterMarkup()}
      ${visible.length ? `
        <div class="invoice-list-scroll">
          ${invoiceState.view === 'issued' ? invoiceIssuedTableMarkup(visible) : `
            <table class="invoice-list-table">
              <thead><tr><th>Invoice / Quotation</th><th>Bill to / Project</th><th>Strategy</th><th>Status</th><th>Invoiced</th><th>Paid</th><th>Due</th><th></th></tr></thead>
              <tbody>${visible.map(invoiceListRowMarkup).join('')}</tbody>
            </table>
          `}
        </div>
      ` : `
        <div class="invoice-empty">
          <strong>${source.length ? 'No invoices match these filters' : invoiceState.view === 'issued' ? 'No invoices have been issued' : 'No accepted or cancelled quotations yet'}</strong>
          <span>${source.length ? 'Choose another status above.' : invoiceState.view === 'issued' ? 'Issued installments will appear here.' : 'Accepted and cancelled quotations will appear here automatically.'}</span>
        </div>
      `}
    </section>
    ${(visible.length || invoiceState.listMeta.total) ? `<div class="finance-list-pagination invoice-list-pagination"><span>Showing ${source.length} of ${Number(invoiceState.listMeta.total || source.length)}</span>${invoiceState.listMeta.hasMore ? '<button type="button" class="btn btn-secondary" onclick="invoiceLoadMore()">Load more</button>' : ''}</div>` : ''}
  `;
}

function invoiceLoadMore() {
  if (invoiceState.listMeta.hasMore) loadInvoices(invoiceState.query, { append: true });
}

function invoiceListRowMarkup(row) {
  const quotation = row.quotation || {};
  const plan = row.plan || {};
  const summary = plan.summary || {};
  const installmentCount = Number(
    plan.installmentCount ?? (plan.installments || []).length
  );
  const isCancelled = String(plan.status || '').toLowerCase() === 'cancelled';
  const invoiceNumbers = Array.isArray(plan.invoiceNumbers)
    ? plan.invoiceNumbers.filter(Boolean)
    : [plan.invoiceNumber].filter(Boolean);
  const primaryInvoiceNumber = invoiceNumbers[0] || '';
  const additionalInvoices = Math.max(0, invoiceNumbers.length - 1);
  return `
    <tr class="${isCancelled ? 'is-cancelled' : ''}" onclick="invoiceOpenPlan('${invoiceAttr(quotation.id)}')">
      <td data-label="Invoice / Quotation" class="invoice-number-cell"><strong>${invoiceEscape(primaryInvoiceNumber)}</strong><small>Quotation ${invoiceEscape(quotation.number || '')}${additionalInvoices ? ` · +${additionalInvoices} more invoice${additionalInvoices === 1 ? '' : 's'}` : ''}</small></td>
      <td data-label="Project"><strong>${invoiceEscape(quotation.projectName || 'Untitled project')}</strong><small>${invoiceEscape(invoiceClientLabel(quotation))}</small></td>
      <td data-label="Strategy"><strong>${invoiceEscape(plan.strategyLabel || 'Not configured')}</strong><small>${installmentCount} installment${installmentCount === 1 ? '' : 's'}</small></td>
      <td data-label="Status">${invoiceStatusBadgeMarkup(plan.status)}</td>
      <td data-label="Invoiced"><strong>${invoiceMoney(summary.invoiced)}</strong><small>of ${invoiceMoney(summary.quotationTotal)}</small></td>
      <td data-label="Paid"><strong class="invoice-positive">${invoiceMoney(summary.paid)}</strong></td>
      <td data-label="Due"><strong class="${Number(summary.due || 0) > 0 ? 'invoice-due' : 'invoice-positive'}">${invoiceMoney(summary.due)}</strong></td>
      <td data-label="Open"><button type="button" class="invoice-row-open" title="Open invoice plan" onclick="event.stopPropagation();invoiceOpenPlan('${invoiceAttr(quotation.id)}')"><svg viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"></path></svg></button></td>
    </tr>
  `;
}

function invoiceIssuedTableMarkup(rows) {
  return `
    <table class="invoice-list-table invoice-issued-table">
      <thead><tr><th>Invoice / Quotation</th><th>Project / Client</th><th>Label</th><th>Status</th><th>Date</th><th>Invoice amount</th><th>Amount due</th><th>Actions</th></tr></thead>
      <tbody>${rows.map(invoiceIssuedRowMarkup).join('')}</tbody>
    </table>
  `;
}

function invoiceIssuedAmountDue(invoice) {
  const paid = (invoice.invoicePlanPayments || [])
    .filter(row => String(row.invoiceId || '') === String(invoice.id || ''))
    .reduce((sum, row) => sum + Number(row.amount || 0), 0);
  return Math.max(0, Number(invoice.invoiceAmount || invoice.totals?.total || 0) - paid);
}

function invoiceIssuedRowMarkup(invoice) {
  const due = invoiceIssuedAmountDue(invoice);
  const status = String(invoice.status || 'draft').toLowerCase();
  const isDraft = status === 'draft';
  const isCancelled = ['cancelled', 'void'].includes(status);
  const countdown = ['sent', 'partially-paid', 'overdue'].includes(status)
    ? invoiceDueCountdown(invoice.paymentDueDate || invoice.dueDate)
    : '';
  return `
    <tr class="${isCancelled ? 'is-cancelled' : ''}" onclick="invoiceOpenPdf('${invoiceAttr(invoice.id)}')">
      <td data-label="Invoice / Quotation" class="invoice-number-cell"><strong>${invoiceEscape(invoice.number || '')}</strong><small>Quotation ${invoiceEscape(invoice.sourceQuotationNumber || '')}</small></td>
      <td data-label="Project"><strong>${invoiceEscape(invoice.projectName || 'Untitled project')}</strong><small>${invoiceEscape(invoiceClientLabel(invoice))}</small></td>
      <td data-label="Label"><strong>${invoiceEscape(invoice.invoiceLabel || '-')}</strong></td>
      <td data-label="Status">${invoiceStatusControlMarkup(status, `issued-status-${invoice.id}`, `invoiceRequestDocumentStatus('${invoiceAttr(invoice.id)}',-1,STATUS_VALUE,'directory')`, invoiceDocumentStatusChoices(status))}</td>
      <td data-label="Date"><strong>${invoiceDateLabel(invoice.invoiceDate || invoice.createdAt)}</strong></td>
      <td data-label="Amount"><strong>${invoiceMoney(invoice.invoiceAmount || invoice.totals?.total)}</strong></td>
      <td data-label="Due"><strong class="${due > 0 ? 'invoice-due' : 'invoice-positive'}">${invoiceMoney(due)}</strong>${countdown ? `<small>${invoiceEscape(countdown)}</small>` : ''}</td>
      <td data-label="Actions"><div class="invoice-directory-actions">
        <button type="button" title="Preview invoice" onclick="event.stopPropagation();invoiceOpenPdf('${invoiceAttr(invoice.id)}')"><svg viewBox="0 0 24 24"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"></path><circle cx="12" cy="12" r="2.5"></circle></svg></button>
        ${isDraft ? `<button type="button" title="Renumber draft invoice" onclick="event.stopPropagation();invoiceRenumber('${invoiceAttr(invoice.id)}','directory')"><svg viewBox="0 0 24 24"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg></button>` : ''}
        <button type="button" class="danger" title="Delete invoice" onclick="event.stopPropagation();invoiceDeleteIssued('${invoiceAttr(invoice.id)}','directory')"><svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13"></path></svg></button>
      </div></td>
    </tr>
  `;
}

async function invoiceRenumber(invoiceId, origin = 'directory') {
  const invoice = invoiceFindDocument(invoiceId);
  if (!invoice) return;
  const number = await showAppPrompt({
    title: 'Renumber invoice',
    message: 'Enter the invoice ID exactly as it should appear on the PDF.',
    inputLabel: 'Invoice number',
    defaultValue: invoice.number || '',
    placeholder: 'INV-2026-0001',
    confirmText: 'Update invoice ID',
    cancelText: 'Cancel'
  });
  if (number === null || number === false) return;
  const clean = String(number || '').trim();
  if (!clean || clean === invoice.number) return;
  try {
    await apiCall(`/api/invoices/${encodeURIComponent(invoiceId)}`, 'PUT', {
      number: clean,
      ...(invoice.documentVersion ? { documentVersion: invoice.documentVersion } : {})
    });
    showNotification('success', `Invoice ID changed to ${clean}`);
    if (origin === 'directory') await loadInvoices(invoiceState.query);
    else await invoiceReloadCurrentPlan();
  } catch (error) {
    showNotification('error', error.message || 'Unable to renumber invoice');
  }
}

async function invoiceDeleteIssued(invoiceId, origin = 'directory') {
  const invoice = invoiceFindDocument(invoiceId);
  if (!invoice) return;
  const confirmed = await showAppConfirm({
    title: 'Delete invoice?',
    message: `${invoice.number || 'This invoice'} will be removed. Its installment will return to a planned state and the invoice number will become available again.`,
    confirmText: 'Delete invoice',
    cancelText: 'Keep invoice',
    variant: 'danger'
  });
  if (!confirmed) return;
  try {
    await apiCall(`/api/invoices/${encodeURIComponent(invoiceId)}`, 'DELETE');
    showNotification('success', `${invoice.number || 'Invoice'} deleted`);
    if (origin === 'directory') await loadInvoices(invoiceState.query);
    else await invoiceReloadCurrentPlan();
  } catch (error) {
    showNotification('error', error.message || 'Unable to delete invoice');
  }
}

function invoiceStatusControlMarkup(status, id, actionTemplate, statuses = INVOICE_PLAN_STATUSES) {
  const action = statusValue => actionTemplate.replace('STATUS_VALUE', `'${statusValue}'`);
  return `
    <div class="invoice-status-control" onclick="event.stopPropagation()">
      <button type="button" class="invoice-status" data-status="${invoiceAttr(status)}" onclick="invoiceToggleStatusMenu('${invoiceAttr(id)}',event)">
        ${invoiceStatusLabel(status)}<svg viewBox="0 0 24 24"><path d="m7 10 5 5 5-5"></path></svg>
      </button>
      <div id="${invoiceAttr(id)}" class="invoice-status-menu">
        ${statuses.map(item => `<button type="button" data-status="${item}" onclick="${action(item)}"><span></span>${invoiceStatusLabel(item)}</button>`).join('')}
      </div>
    </div>
  `;
}

function invoiceToggleStatusMenu(id, event) {
  event?.stopPropagation();
  const existingPortal = Array.from(document.querySelectorAll('[data-invoice-status-portal]'))
    .find(menu => menu.dataset.invoiceStatusPortal === id);
  if (existingPortal) {
    existingPortal.remove();
    return;
  }
  const menu = document.getElementById(id);
  if (!menu) return;
  if (!menu.closest('.invoice-list-scroll')) {
    const shouldOpen = !menu.classList.contains('open');
    invoiceCloseStatusMenus();
    if (!shouldOpen) return;
    menu.classList.toggle('open');
    return;
  }
  invoiceCloseStatusMenus();
  const trigger = event?.currentTarget || menu.previousElementSibling;
  const rect = trigger?.getBoundingClientRect();
  if (!rect) return;
  const portal = menu.cloneNode(true);
  portal.id = `${id}-portal`;
  portal.dataset.invoiceStatusPortal = id;
  portal.classList.add('open', 'viewport-menu');
  document.body.appendChild(portal);
  const menuWidth = Math.max(165, portal.getBoundingClientRect().width || 0);
  portal.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - menuWidth - 8))}px`;
  portal.style.top = `${rect.bottom + 5}px`;
  portal.style.maxHeight = `${Math.max(96, window.innerHeight - rect.bottom - 17)}px`;
}

function invoiceCloseStatusMenus(exceptId = '') {
  document.querySelectorAll('.invoice-status-menu.open:not([data-invoice-status-portal])').forEach(menu => {
    if (menu.id !== exceptId) menu.classList.remove('open');
  });
  document.querySelectorAll('[data-invoice-status-portal]').forEach(menu => {
    if (menu.dataset.invoiceStatusPortal !== exceptId) menu.remove();
  });
}

async function invoiceOpenPlan(quotationId, options = {}) {
  const root = invoiceRoot();
  if (!root) return;
  root.innerHTML = '<div class="invoice-loading"><span></span>Opening billing plan...</div>';
  try {
    await invoiceLoadPlanTemplates();
    const response = await apiCall(`/api/invoice-plans/${encodeURIComponent(quotationId)}`);
    invoiceState.current = response.data;
    const plan = invoiceState.current.plan;
    if (!(plan.installments || []).length) invoiceApplyPreset('full', false);
    invoiceState.dirty = false;
    invoiceState.basePlan = invoiceClone(invoiceState.current.plan);
    invoiceState.remoteUpdatePending = false;
    invoiceRenderEditor();
    if (options.updateHistory !== false && typeof updateAppDetailHistory === 'function') {
      updateAppDetailHistory(`/invoices/${encodeURIComponent(quotationId)}`);
    }
  } catch (error) {
    root.innerHTML = `<div class="invoice-empty"><strong>Billing plan unavailable</strong><span>${invoiceEscape(error.message)}</span><button class="btn btn-secondary" onclick="loadInvoices()">Back to invoices</button></div>`;
  }
}

async function invoiceBackToList() {
  if (!await invoiceFlushPendingSave()) return;
  invoiceState.current = null;
  invoiceState.basePlan = null;
  if (typeof updateAppSectionHistory === 'function') updateAppSectionHistory('invoices');
  loadInvoices(invoiceState.query);
}

function invoiceApplyPreset(preset, rerender = true) {
  const current = invoiceState.current;
  if (!current) return;
  const total = invoiceLocalSummary(current.plan, current.quotation).adjustedTotal;
  const defaultDueDate = invoiceDateFromToday(30);
  const row = (label, mode, value) => ({
    id: invoiceUid('installment'), label, mode, value, amount: mode === 'percentage' ? total * value / 100 : value,
    dueDate: defaultDueDate, notes: '', status: 'planned', invoiceId: '', invoiceNumber: ''
  });
  const existingRows = current.plan.installments || [];
  const issuedRows = existingRows.filter(item => item.invoiceId);
  const issuedAmount = issuedRows.reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const remaining = Math.max(0, Math.round((total - issuedAmount) * 100) / 100);
  if (preset === 'full') {
    current.plan.strategy = 'full';
    current.plan.strategyLabel = 'Full amount';
    current.plan.installments = issuedRows.length
      ? [
          ...issuedRows,
          ...(remaining > 0 ? [row('Remaining balance', 'amount', remaining)] : [])
        ]
      : [row('Full payment', 'percentage', 100)];
  } else if (preset === 'deposit') {
    current.plan.strategy = 'deposit';
    current.plan.strategyLabel = '50% deposit / 50% balance';
    current.plan.installments = issuedRows.length
      ? [
          ...issuedRows,
          ...(remaining > 0 ? [row('Balance after show', 'amount', remaining)] : [])
        ]
      : [
          row('50% deposit', 'percentage', 50),
          row('Balance after show', 'percentage', 50)
        ];
  } else {
    current.plan.strategy = 'custom';
    current.plan.strategyLabel = 'Custom installment plan';
    if (!existingRows.length) current.plan.installments = [row('Installment 1', 'amount', total)];
  }
  invoiceMarkDirty();
  if (rerender) invoiceRenderEditor();
}

function invoiceApplySavedPlan(templateId) {
  const current = invoiceState.current;
  const template = invoiceState.planTemplates.find(row => row.id === templateId);
  if (!current || !template) return;
  if ((current.plan.installments || []).some(row => row.invoiceId)) {
    showNotification('warning', 'Saved plans can only replace a schedule before invoices are issued');
    return;
  }
  const total = invoiceLocalSummary(current.plan, current.quotation).adjustedTotal;
  current.plan.strategy = 'custom';
  current.plan.strategyLabel = template.name;
  current.plan.invoiceDetails = current.plan.invoiceDetails || {};
  current.plan.invoiceDetails.paymentTerms = template.name;
  current.plan.installments = (template.installments || []).map((row, index) => ({
    id: invoiceUid('installment'),
    label: row.label || `Installment ${index + 1}`,
    mode: row.mode === 'amount' ? 'amount' : 'percentage',
    value: Number(row.value || 0),
    amount: row.mode === 'amount'
      ? Number(row.value || 0)
      : total * Number(row.value || 0) / 100,
    dueDate: invoiceDateFromToday(Number(row.dueDays ?? 30)),
    notes: '', status: 'planned', invoiceId: '', invoiceNumber: ''
  }));
  invoiceMarkDirty();
  invoiceRenderEditor();
}

async function invoiceEditDueDays(index) {
  const row = invoiceState.current?.plan?.installments?.[index];
  if (!row || invoiceInstallmentIsFrozen(row)) return;
  const due = new Date(`${row.dueDate || invoiceToday()}T00:00:00`);
  const today = new Date(`${invoiceToday()}T00:00:00`);
  const currentDays = Math.max(0, Math.round((due.getTime() - today.getTime()) / 86400000) || 0);
  const result = await showAppPrompt({
    title: 'Set due date',
    message: 'Enter the number of days from today. The due date will be calculated automatically.',
    label: 'Days from today',
    value: String(currentDays),
    inputType: 'number',
    confirmText: 'Calculate date',
    cancelText: 'Cancel'
  });
  if (result === null || result === false) return;
  const days = Number(result);
  if (!Number.isInteger(days) || days < 0 || days > 3650) {
    showNotification('error', 'Enter a whole number from 0 to 3650');
    return;
  }
  invoiceUpdateInstallment(index, 'dueDate', invoiceDateFromToday(days));
  invoiceRenderEditor();
}

async function invoiceOpenPlanManager() {
  await invoiceLoadPlanTemplates(true);
  let modal = document.getElementById('invoicePlanManagerModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'invoicePlanManagerModal';
    modal.className = 'modal';
    modal.innerHTML = '<div class="modal-content invoice-plan-manager-modal"></div>';
    document.body.appendChild(modal);
  }
  invoiceState.planTemplateDraft = null;
  invoiceRenderPlanManager();
  openModal('invoicePlanManagerModal');
}

function invoiceNewPlanTemplate() {
  invoiceState.planTemplateDraft = {
    id: '', name: '', installments: [{
      id: invoiceUid('plan-row'), label: 'Full payment', mode: 'percentage', value: 100, dueDays: 30
    }]
  };
  invoiceRenderPlanManager();
}

function invoiceEditPlanTemplate(templateId) {
  const template = invoiceState.planTemplates.find(row => row.id === templateId);
  invoiceState.planTemplateDraft = invoiceClone(template);
  invoiceRenderPlanManager();
}

function invoiceUpdatePlanTemplateField(field, value) {
  if (!invoiceState.planTemplateDraft) return;
  invoiceState.planTemplateDraft[field] = value;
}

function invoiceUpdatePlanTemplateRow(index, field, value) {
  const row = invoiceState.planTemplateDraft?.installments?.[index];
  if (!row) return;
  row[field] = ['value', 'dueDays'].includes(field) ? Number(value || 0) : value;
  if (field === 'mode') invoiceRenderPlanManager();
}

function invoiceAddPlanTemplateRow() {
  const draft = invoiceState.planTemplateDraft;
  if (!draft) return;
  draft.installments.push({
    id: invoiceUid('plan-row'), label: `Installment ${draft.installments.length + 1}`,
    mode: 'percentage', value: 0, dueDays: 30
  });
  invoiceRenderPlanManager();
}

function invoiceRemovePlanTemplateRow(index) {
  const rows = invoiceState.planTemplateDraft?.installments;
  if (!rows || rows.length <= 1) return;
  rows.splice(index, 1);
  invoiceRenderPlanManager();
}

async function invoiceSavePlanTemplate() {
  const draft = invoiceState.planTemplateDraft;
  if (!draft) return;
  if (!String(draft.name || '').trim()) {
    showNotification('error', 'Enter a plan name');
    return;
  }
  try {
    const endpoint = draft.id
      ? `/api/invoice-plan-templates/${encodeURIComponent(draft.id)}`
      : '/api/invoice-plan-templates';
    await apiCall(endpoint, draft.id ? 'PUT' : 'POST', draft);
    await invoiceLoadPlanTemplates(true);
    invoiceState.planTemplateDraft = null;
    invoiceRenderPlanManager();
    if (invoiceState.current) invoiceRenderEditor();
    showNotification('success', 'Invoice plan saved');
  } catch (error) {
    showNotification('error', error.message || 'Unable to save invoice plan');
  }
}

async function invoiceDeletePlanTemplate(templateId) {
  const template = invoiceState.planTemplates.find(row => row.id === templateId);
  if (!template) return;
  const confirmed = await showAppConfirm({
    title: 'Delete saved plan?',
    message: `${template.name} will no longer be available for new quotations. Existing invoices are unchanged.`,
    confirmText: 'Delete plan', cancelText: 'Keep plan', variant: 'danger'
  });
  if (!confirmed) return;
  try {
    await apiCall(`/api/invoice-plan-templates/${encodeURIComponent(templateId)}`, 'DELETE');
    await invoiceLoadPlanTemplates(true);
    invoiceState.planTemplateDraft = null;
    invoiceRenderPlanManager();
    if (invoiceState.current) invoiceRenderEditor();
  } catch (error) {
    showNotification('error', error.message || 'Unable to delete invoice plan');
  }
}

function invoiceRenderPlanManager() {
  const root = document.querySelector('#invoicePlanManagerModal .invoice-plan-manager-modal');
  if (!root) return;
  const draft = invoiceState.planTemplateDraft;
  root.innerHTML = `
    <div class="modal-header"><div><h3 class="modal-title">Invoice plans</h3><p>Reusable payment terms and installment schedules.</p></div><div class="invoice-plan-manager-header-actions">${draft ? '' : '<button type="button" class="btn invoice-plan-create-button" onclick="invoiceNewPlanTemplate()">+ Create plan</button>'}<button type="button" class="close-btn" onclick="closeModal('invoicePlanManagerModal')">&times;</button></div></div>
    ${draft ? `
      <div class="invoice-plan-template-editor">
        <label><span>Plan name</span><input value="${invoiceAttr(draft.name || '')}" oninput="invoiceUpdatePlanTemplateField('name',this.value)" placeholder="e.g. 40 / 40 / 20"></label>
        <div class="invoice-plan-template-rows">
          ${(draft.installments || []).map((row, index) => `<div class="invoice-plan-template-row">
            <label><span>Installment</span><input value="${invoiceAttr(row.label || '')}" oninput="invoiceUpdatePlanTemplateRow(${index},'label',this.value)"></label>
            <label><span>Calculate by</span><select onchange="invoiceUpdatePlanTemplateRow(${index},'mode',this.value)"><option value="percentage" ${row.mode !== 'amount' ? 'selected' : ''}>Percentage</option><option value="amount" ${row.mode === 'amount' ? 'selected' : ''}>Amount</option></select></label>
            <label><span>${row.mode === 'amount' ? 'Amount' : 'Percentage'}</span><input type="number" min="0" step="0.01" value="${Number(row.value || 0)}" oninput="invoiceUpdatePlanTemplateRow(${index},'value',this.value)"></label>
            <label><span>Due after</span><div class="invoice-plan-days"><input type="number" min="0" max="3650" step="1" value="${Number(row.dueDays ?? 30)}" oninput="invoiceUpdatePlanTemplateRow(${index},'dueDays',this.value)"><b>days</b></div></label>
            <button type="button" class="invoice-icon-button danger" title="Remove installment" onclick="invoiceRemovePlanTemplateRow(${index})" ${(draft.installments || []).length <= 1 ? 'disabled' : ''}>×</button>
          </div>`).join('')}
        </div>
        <button type="button" class="invoice-icon-text" onclick="invoiceAddPlanTemplateRow()">+ Add installment</button>
        <div class="modal-actions"><button type="button" class="btn btn-secondary" onclick="invoiceState.planTemplateDraft=null;invoiceRenderPlanManager()">Cancel</button><button type="button" class="btn invoice-save" onclick="invoiceSavePlanTemplate()">Save plan</button></div>
      </div>` : `
      <div class="invoice-plan-template-list">
        <article class="invoice-plan-template builtin"><div><strong>30 Days</strong><span>Built in · Full payment due in 30 days</span></div></article>
        ${(invoiceState.planTemplates || []).map(template => `<article class="invoice-plan-template"><div><strong>${invoiceEscape(template.name)}</strong><span>${template.installments.length} installment${template.installments.length === 1 ? '' : 's'}</span></div><div><button type="button" class="btn btn-secondary" onclick="invoiceEditPlanTemplate('${invoiceAttr(template.id)}')">Edit</button><button type="button" class="invoice-icon-button danger" onclick="invoiceDeletePlanTemplate('${invoiceAttr(template.id)}')">×</button></div></article>`).join('')}
        ${(invoiceState.planTemplates || []).length ? '' : '<div class="invoice-inline-empty">No saved plans yet.</div>'}
      </div>
      <div class="modal-actions"><button type="button" class="btn btn-secondary" onclick="closeModal('invoicePlanManagerModal')">Close</button><button type="button" class="btn invoice-save" onclick="invoiceNewPlanTemplate()">Create plan</button></div>`}
  `;
}

function invoiceRenderEditor() {
  const root = invoiceRoot();
  const current = invoiceState.current;
  if (!root || !current) return;
  const quotation = current.quotation || {};
  const plan = current.plan || {};
  const details = invoicePlanDetails(plan, quotation);
  const client = details.client || {};
  const summary = invoiceLocalSummary(plan, quotation);
  const discountLocked = (plan.installments || []).some(invoiceInstallmentIsFrozen);
  plan.summary = summary;
  root.innerHTML = `
    <header class="invoice-editor-header">
      <div class="invoice-editor-title">
        <button type="button" class="invoice-back" onclick="invoiceBackToList()"><svg viewBox="0 0 24 24"><path d="m15 18-6-6 6-6"></path></svg>Invoices</button>
        <div><span>${invoiceEscape(quotation.number)}</span><h2>${invoiceEscape(details.projectName || 'Untitled project')}</h2><p>${invoiceEscape(invoiceClientDisplay(client) || 'No client')}</p></div>
      </div>
      <div class="invoice-editor-actions">
        ${invoiceStatusBadgeMarkup(plan.status || 'draft')}
        <span id="invoiceSaveState" class="invoice-save-state">${invoiceState.remoteUpdatePending ? 'Review concurrent changes' : invoiceState.dirty ? 'Unsaved changes' : 'All changes saved'}</span>
        <button type="button" class="btn invoice-save" onclick="invoiceSavePlan()" ${invoiceState.saving ? 'disabled' : ''}>
          ${invoiceState.saving ? '<span class="invoice-button-spinner"></span>Saving' : 'Save plan'}
        </button>
      </div>
    </header>
    <div class="invoice-metrics">
      ${invoiceMetric('Quotation total', summary.quotationTotal, summary.invoiceDiscountAmount ? `${invoiceMoney(summary.adjustedTotal)} after discount` : '')}
      ${invoiceMetric('Invoiced', summary.invoiced, `${invoiceMoney(summary.notInvoiced)} not invoiced`)}
      ${invoiceMetric('Paid', summary.paid, `${invoiceMoney(summary.invoiceBalance)} issued balance`, 'positive')}
      ${invoiceMetric('Amount due', summary.due, summary.due ? 'Remaining on quotation' : 'Fully paid', summary.due ? 'due' : 'positive')}
    </div>
    <div class="invoice-editor-grid">
      <main class="invoice-editor-main">
        <section class="invoice-panel invoice-details-panel">
          <div class="invoice-panel-heading finance-client-heading">
            <div><h3>Client &amp; invoicing details</h3></div>
            <div class="finance-client-actions invoice-client-actions">
              <button type="button" class="finance-picker-button" onclick="invoiceOpenClientPicker()">
                <span>${invoiceEscape(invoiceClientDisplay(client) || 'Select known client')}</span>
                <small>${invoiceEscape(client.company || client.email || client.phone || '')}</small>
              </button>
              <button type="button" class="btn btn-secondary" onclick="invoiceStartNewClient()">+ New Client</button>
            </div>
          </div>
          <div class="finance-form-grid finance-quote-details-grid invoice-details-grid">
            <label class="finance-field"><span>Name</span><div class="finance-client-name-control">${invoiceSalutationControl(client.salutation || '')}<input id="invoiceClientName" class="finance-input" value="${invoiceAttr(client.name || '')}" oninput="invoiceUpdateClientField('name',this.value)"></div></label>
            <label class="finance-field"><span>Company</span><input class="finance-input" value="${invoiceAttr(client.company || '')}" oninput="invoiceUpdateClientField('company',this.value)"></label>
            <label class="finance-field"><span>Phone</span><input class="finance-input" value="${invoiceAttr(client.phone || '')}" oninput="invoiceUpdateClientField('phone',this.value)"></label>
            <label class="finance-field"><span>Email</span><input class="finance-input" type="email" value="${invoiceAttr(client.email || '')}" oninput="invoiceUpdateClientField('email',this.value)"></label>
            <label class="finance-field finance-span-3"><span>Billing address</span><input class="finance-input" value="${invoiceAttr([client.address1, client.address2, client.address3, client.postalCode].filter(Boolean).join(', '))}" oninput="invoiceSetClientAddress(this.value)"></label>
            <label class="finance-field"><span>Salesperson</span><input class="finance-input" value="${invoiceAttr(details.salesperson || '')}" oninput="invoiceUpdateDetail('salesperson',this.value,true)"></label>
            <label class="finance-field finance-span-2"><span>Project Name</span><input class="finance-input" value="${invoiceAttr(details.projectName || '')}" oninput="invoiceUpdateDetail('projectName',this.value)"></label>
            <label class="finance-field finance-span-2"><span>Location</span><input class="finance-input" value="${invoiceAttr(details.eventLocation || '')}" oninput="invoiceUpdateDetail('eventLocation',this.value)"></label>
            <label class="finance-field finance-span-2"><span>PO / reference number</span><input class="finance-input" value="${invoiceAttr(details.reference || '')}" oninput="invoiceUpdateDetail('reference',this.value)"></label>
            <label class="finance-field finance-span-2"><span>Payment terms</span><input class="finance-input" value="${invoiceAttr(details.paymentTerms || '')}" oninput="invoiceUpdateDetail('paymentTerms',this.value)"></label>
          </div>
        </section>
        <section class="invoice-panel">
          <div class="invoice-panel-heading"><div><h3>Invoicing strategy</h3><p>Choose a starting point, then adjust any installment.</p></div><button type="button" class="btn btn-secondary invoice-view-plans" onclick="invoiceOpenPlanManager()">View plans</button></div>
          <div class="invoice-presets">
            <button type="button" class="${plan.strategy === 'full' ? 'active' : ''}" onclick="invoiceApplyPreset('full')"><strong>Full amount</strong><span>One invoice for 100%</span></button>
            <button type="button" class="${plan.strategy === 'deposit' ? 'active' : ''}" onclick="invoiceApplyPreset('deposit')"><strong>50 / 50</strong><span>Deposit and final balance</span></button>
            <button type="button" class="${plan.strategy === 'custom' ? 'active' : ''}" onclick="invoiceApplyPreset('custom')"><strong>Custom</strong><span>Any installment plan</span></button>
          </div>
          ${(invoiceState.planTemplates || []).length ? `<label class="invoice-saved-plan-select"><span>Saved plan</span><select onchange="invoiceApplySavedPlan(this.value);this.value=''"><option value="">Select a saved plan…</option>${invoiceState.planTemplates.map(row => `<option value="${invoiceAttr(row.id)}">${invoiceEscape(row.name)}</option>`).join('')}</select></label>` : ''}
          <label class="invoice-strategy-name"><span>Plan label</span><input value="${invoiceAttr(plan.strategyLabel || '')}" oninput="invoiceUpdatePlanField('strategyLabel',this.value)"></label>
          <div class="invoice-discount-control ${discountLocked ? 'locked' : ''}">
            <div><strong>Additional discount</strong><span>${discountLocked ? 'Locked after invoice issue' : 'Applied before installments'}</span></div>
            <div class="invoice-discount-mode">
              <button type="button" class="${(plan.invoiceDiscountMode || 'percentage') === 'percentage' ? 'active' : ''}" onclick="invoiceUpdateDiscount('invoiceDiscountMode','percentage')" ${discountLocked ? 'disabled' : ''}>%</button>
              <button type="button" class="${plan.invoiceDiscountMode === 'amount' ? 'active' : ''}" onclick="invoiceUpdateDiscount('invoiceDiscountMode','amount')" ${discountLocked ? 'disabled' : ''}>$</button>
            </div>
            <label><span>${plan.invoiceDiscountMode === 'amount' ? 'Amount' : 'Percentage'}</span><div class="invoice-value-input"><b>${plan.invoiceDiscountMode === 'amount' ? '$' : '%'}</b><input type="number" min="0" ${plan.invoiceDiscountMode === 'amount' ? 'step="0.01"' : 'max="100" step="0.1"'} value="${Number(plan.invoiceDiscountValue || 0)}" oninput="invoiceUpdateDiscount('invoiceDiscountValue',this.value)" ${discountLocked ? 'disabled' : ''}></div></label>
            <div class="invoice-discount-total"><span>Discount</span><strong id="invoiceDiscountAmount">-${invoiceMoney(summary.invoiceDiscountAmount)}</strong></div>
          </div>
        </section>
        <section class="invoice-panel invoice-installments-panel">
          <div class="invoice-panel-heading"><div><h3>Installments</h3><p>${invoiceMoney(summary.planned)} planned of ${invoiceMoney(summary.adjustedTotal)}</p></div><button type="button" class="invoice-icon-text" onclick="invoiceAddInstallment()"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"></path></svg>Add installment</button></div>
          <div class="invoice-installment-list">${(plan.installments || []).map((row, index) => invoiceInstallmentMarkup(row, index)).join('')}</div>
          <div class="invoice-plan-balance ${Math.abs(summary.unplanned) < 0.01 ? 'balanced' : ''}"><span>${Math.abs(summary.unplanned) < 0.01 ? 'Plan covers the quotation total' : 'Still to allocate'}</span><strong>${invoiceMoney(summary.unplanned)}</strong></div>
        </section>
        <section class="invoice-panel">
          <div class="invoice-panel-heading"><div><h3>Payments received</h3><p>Track receipts without changing sent invoices.</p></div><button type="button" class="invoice-icon-text" onclick="invoiceAddPayment()"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"></path></svg>Add payment</button></div>
          <div class="invoice-payment-list">${(plan.payments || []).length ? plan.payments.map((row, index) => invoicePaymentMarkup(row, index)).join('') : '<div class="invoice-inline-empty">No payments recorded yet.</div>'}</div>
        </section>
      </main>
      <aside class="invoice-editor-side">
        <section class="invoice-panel invoice-quote-card">
          <h3>Accepted quotation</h3>
          <dl><div><dt>Number</dt><dd>${invoiceEscape(quotation.number)}</dd></div><div><dt>Accepted</dt><dd>${invoiceDateLabel(quotation.acceptedAt)}</dd></div><div><dt>Salesperson</dt><dd>${invoiceEscape(quotation.salesperson || 'Not set')}</dd></div><div><dt>Payment terms</dt><dd>${invoiceEscape(quotation.paymentTerms || 'Not set')}</dd></div></dl>
          <button type="button" onclick="invoiceOpenQuotation('${invoiceAttr(quotation.id)}')">Open quotation<svg viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"></path></svg></button>
        </section>
        <section class="invoice-panel invoice-history-card">
          <div class="invoice-panel-heading"><div><h3>Billing history</h3><p>Invoices, payments and status changes.</p></div></div>
          <div class="invoice-history">${invoiceHistoryMarkup(plan)}</div>
        </section>
      </aside>
    </div>
  `;
}

function invoiceMetric(label, amount, detail, tone = '') {
  return `<div class="invoice-metric ${tone}"><span>${invoiceEscape(label)}</span><strong>${invoiceMoney(amount)}</strong><small>${invoiceEscape(detail || '\u00a0')}</small></div>`;
}

function invoiceInstallmentMarkup(row, index) {
  const issued = !!row.invoiceId;
  const status = String(row.status || 'draft').toLowerCase();
  const detailsEditable = !issued || (
    status === 'draft' && !row.invoiceFrozen
  );
  return `
    <article class="invoice-installment ${issued ? 'issued' : ''}">
      <div class="invoice-installment-index">${String(index + 1).padStart(2, '0')}</div>
      <label><span>Label</span><input value="${invoiceAttr(row.label || '')}" oninput="invoiceUpdateInstallment(${index},'label',this.value)" ${detailsEditable ? '' : 'disabled'}></label>
      <div class="invoice-mode-field"><span>Calculate by</span><div><button type="button" class="${row.mode === 'percentage' ? 'active' : ''}" onclick="invoiceUpdateInstallment(${index},'mode','percentage')" ${issued ? 'disabled' : ''}>%</button><button type="button" class="${row.mode === 'amount' ? 'active' : ''}" onclick="invoiceUpdateInstallment(${index},'mode','amount')" ${issued ? 'disabled' : ''}>$</button></div></div>
      <label><span>${row.mode === 'percentage' ? 'Percentage' : 'Amount'}</span><div class="invoice-value-input"><b>${row.mode === 'percentage' ? '%' : '$'}</b><input type="number" min="0" step="0.01" value="${Number(row.value || 0)}" oninput="invoiceUpdateInstallment(${index},'value',this.value)" ${issued ? 'disabled' : ''}></div></label>
      <label class="invoice-due-date-field"><span>Due date <button type="button" id="invoiceDueCountdown-${invoiceAttr(row.id)}" onclick="event.preventDefault();invoiceEditDueDays(${index})" ${detailsEditable ? '' : 'disabled'}>${invoiceEscape(invoiceDueCountdown(row.dueDate))}</button></span><input type="date" value="${invoiceAttr(row.dueDate || '')}" oninput="invoiceUpdateInstallment(${index},'dueDate',this.value)" ${detailsEditable ? '' : 'disabled'}></label>
      <div class="invoice-installment-amount"><span>Invoice amount</span><strong>${invoiceMoney(row.amount)}</strong></div>
      <div class="invoice-installment-actions">
        ${issued ? `
          ${invoiceStatusControlMarkup(status, `installment-status-${row.id}`, `invoiceRequestDocumentStatus('${invoiceAttr(row.invoiceId)}',${index},STATUS_VALUE,'editor')`, invoiceDocumentStatusChoices(status))}
          <button type="button" class="invoice-pdf-button" onclick="invoiceOpenPdf('${invoiceAttr(row.invoiceId)}',${index})"><svg viewBox="0 0 24 24"><path d="M7 3h7l4 4v14H7z"></path><path d="M14 3v5h4M9 13h6M9 17h4"></path></svg>${invoiceEscape(row.invoiceNumber || 'Export PDF')}</button>
          ${detailsEditable ? `<button type="button" class="invoice-icon-button" title="Renumber draft invoice" onclick="invoiceRenumber('${invoiceAttr(row.invoiceId)}','editor')"><svg viewBox="0 0 24 24"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg></button>` : ''}<button type="button" class="invoice-icon-button danger" title="Delete invoice" onclick="invoiceDeleteIssued('${invoiceAttr(row.invoiceId)}','editor')"><svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13"></path></svg></button>
        ` : `
          <button type="button" class="invoice-issue-button" onclick="invoiceIssueInstallment(${index})">Issue invoice</button>
          <button type="button" class="invoice-remove-button" title="Remove installment" onclick="invoiceRemoveInstallment(${index})"><svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"></path></svg></button>
        `}
      </div>
    </article>
  `;
}

function invoicePaymentMarkup(row, index) {
  return `
    <article class="invoice-payment">
      <label><span>Date received</span><input type="date" value="${invoiceAttr(row.date || '')}" oninput="invoiceUpdatePayment(${index},'date',this.value)"></label>
      <label class="invoice-payment-label"><span>Payment label</span><input value="${invoiceAttr(row.label || '')}" oninput="invoiceUpdatePayment(${index},'label',this.value)" placeholder="Deposit received"></label>
      <label><span>Amount</span><div class="invoice-value-input"><b>$</b><input type="number" min="0" step="0.01" value="${Number(row.amount || 0)}" oninput="invoiceUpdatePayment(${index},'amount',this.value)"></div></label>
      <button type="button" class="invoice-receipt-button" title="Export payment receipt PDF" onclick="invoiceExportPaymentReceipt(${index})" ${Number(row.amount || 0) > 0 ? '' : 'disabled'}><svg viewBox="0 0 24 24"><path d="M7 3h7l4 4v14H7z"></path><path d="M14 3v5h4M9 13h6M9 17h4"></path></svg>Receipt PDF</button>
      <button type="button" class="invoice-remove-button" title="Remove payment" onclick="invoiceRemovePayment(${index})"><svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"></path></svg></button>
    </article>
  `;
}

function invoiceHistoryMarkup(plan) {
  const entries = [
    ...(plan.history || []).map(row => ({ ...row, kind: row.action || 'update' })),
    ...(plan.payments || []).map(row => ({
      id: `payment-${row.id}`, kind: 'payment-recorded', at: row.createdAt || `${row.date}T00:00:00`,
      detail: `${row.label || 'Payment received'} - ${invoiceMoney(row.amount)}`, byName: row.createdBy || ''
    }))
  ].sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  if (!entries.length) return '<div class="invoice-inline-empty">No billing activity yet.</div>';
  return entries.map(row => `
    <div class="invoice-history-row" data-kind="${invoiceAttr(row.kind)}">
      <span></span><div><strong>${invoiceEscape(row.detail || invoiceStatusLabel(row.action))}</strong><small>${invoiceDateLabel(row.at)}${row.byName ? ` · ${invoiceEscape(row.byName)}` : ''}</small></div>
    </div>
  `).join('');
}

function invoiceMarkDirty() {
  invoiceState.dirty = true;
  invoiceState.changeVersion += 1;
  clearTimeout(invoiceState.saveTimer);
  invoiceState.saveTimer = setTimeout(
    () => invoiceSavePlan({ silent: true }), 700
  );
  const state = document.getElementById('invoiceSaveState');
  if (state) state.textContent = invoiceState.remoteUpdatePending
    ? 'Unsaved changes · newer changes received'
    : 'Unsaved changes';
}

function invoiceUpdatePlanField(key, value) {
  if (!invoiceState.current) return;
  invoiceState.current.plan[key] = value;
  invoiceMarkDirty();
}

function invoiceUpdateDetail(field, value, clearSalespersonLink = false) {
  const details = invoicePlanDetails();
  if (!details) return;
  details[field] = value;
  if (clearSalespersonLink) details.salespersonUsername = '';
  invoiceMarkDirty();
}

function invoiceUpdateClientField(field, value) {
  const details = invoicePlanDetails();
  if (!details) return;
  details.client[field] = value;
  invoiceMarkDirty();
}

function invoiceSetClientAddress(value) {
  const details = invoicePlanDetails();
  if (!details) return;
  Object.assign(details.client, {
    address1: value,
    address2: '',
    address3: '',
    postalCode: ''
  });
  invoiceMarkDirty();
}

function invoiceSetClientSalutation(value, menuId) {
  document.getElementById(menuId)?.classList.remove('open');
  invoiceUpdateClientField('salutation', value || '');
  invoiceRenderEditor();
}

function invoiceStartNewClient() {
  const details = invoicePlanDetails();
  if (!details) return;
  details.client = {
    salutation: '', name: '', company: '', phone: '', email: '',
    contactPerson: '', taxNumber: '', address1: '', address2: '',
    address3: '', postalCode: ''
  };
  details.clientRecordName = '';
  invoiceMarkDirty();
  invoiceRenderEditor();
  setTimeout(() => document.getElementById('invoiceClientName')?.focus(), 0);
}

function invoiceEnsureClientPicker() {
  if (document.getElementById('invoiceClientPickerModal')) return;
  const modal = document.createElement('div');
  modal.id = 'invoiceClientPickerModal';
  modal.className = 'modal';
  modal.innerHTML = `
    <div class="modal-content finance-picker-modal">
      <div class="modal-header"><h3 class="modal-title">Select known client</h3><button type="button" class="close-btn" onclick="closeModal('invoiceClientPickerModal')">&times;</button></div>
      <input id="invoiceClientPickerSearch" class="finance-input" placeholder="Search clients..." autocomplete="off" oninput="invoiceRenderClientPickerResults(this.value)">
      <div id="invoiceClientPickerResults" class="finance-picker-results"></div>
      <div class="modal-actions finance-picker-actions"><button type="button" class="btn btn-secondary" onclick="closeModal('invoiceClientPickerModal')">Cancel</button></div>
    </div>
  `;
  document.body.appendChild(modal);
}

function invoiceRenderClientPickerResults(query = '') {
  const root = document.getElementById('invoiceClientPickerResults');
  if (!root) return;
  const needle = String(query || '').trim().toLowerCase();
  const matches = invoiceState.clients
    .map((client, index) => ({ client, index }))
    .filter(({ client }) => !needle || [
      client.name, client.company, client.email, client.phone
    ].some(value => String(value || '').toLowerCase().includes(needle)));
  root.innerHTML = matches.map(({ client, index }) => `
    <button type="button" class="finance-picker-option" onclick="invoiceApplyKnownClient(${index})">
      <strong>${invoiceEscape(invoiceClientDisplay(client) || 'Unnamed client')}</strong>
      <span>${invoiceEscape([client.company, client.email, client.phone].filter(Boolean).join(' - '))}</span>
    </button>
  `).join('') || '<div class="finance-suggestion-empty">No matching clients.</div>';
}

async function invoiceOpenClientPicker() {
  invoiceEnsureClientPicker();
  const search = document.getElementById('invoiceClientPickerSearch');
  const results = document.getElementById('invoiceClientPickerResults');
  if (search) search.value = '';
  if (results) results.innerHTML = '<div class="invoice-inline-empty">Loading clients...</div>';
  openModal('invoiceClientPickerModal');
  try {
    const response = await apiCall('/api/clients');
    invoiceState.clients = Array.isArray(response.data) ? response.data : [];
    invoiceRenderClientPickerResults('');
    search?.focus();
  } catch (error) {
    if (results) results.innerHTML = `<div class="finance-suggestion-empty">${invoiceEscape(error.message || 'Unable to load clients')}</div>`;
  }
}

function invoiceApplyKnownClient(index) {
  const client = invoiceState.clients[Number(index)];
  const details = invoicePlanDetails();
  if (!client || !details) return;
  details.client = { ...client };
  details.clientRecordName = client.name || '';
  invoiceMarkDirty();
  closeModal('invoiceClientPickerModal');
  invoiceRenderEditor();
}

function invoiceUpdateDiscount(key, value) {
  const current = invoiceState.current;
  if (!current || (current.plan.installments || []).some(invoiceInstallmentIsFrozen)) return;
  current.plan[key] = key === 'invoiceDiscountValue' ? Math.max(0, Number(value || 0)) : value;
  invoiceMarkDirty();
  if (key === 'invoiceDiscountMode') invoiceRenderEditor();
  else invoiceRefreshCalculatedValues();
}

function invoiceUpdateInstallment(index, key, value) {
  const row = invoiceState.current?.plan?.installments?.[index];
  const issuedDetailsLocked = row?.invoiceId && (
    String(row.status || 'draft').toLowerCase() !== 'draft' || row.invoiceFrozen
  );
  if (
    !row
    || row.invoiceId && ['mode', 'value'].includes(key)
    || issuedDetailsLocked && ['label', 'dueDate'].includes(key)
  ) return;
  row[key] = key === 'value' ? Number(value || 0) : value;
  if (key === 'dueDate') {
    const countdown = document.getElementById(`invoiceDueCountdown-${row.id}`);
    if (countdown) countdown.textContent = invoiceDueCountdown(value);
  }
  if (key === 'mode' && row.mode === 'percentage') {
    const total = Number(invoiceState.current.quotation?.totals?.total || 0);
    row.value = total ? Math.round(Number(row.amount || 0) / total * 10000) / 100 : 0;
  } else if (key === 'mode') {
    row.value = Number(row.amount || 0);
  }
  invoiceMarkDirty();
  if (key === 'mode') invoiceRenderEditor();
  else invoiceRefreshCalculatedValues();
}

function invoiceRefreshCalculatedValues() {
  const current = invoiceState.current;
  if (!current) return;
  const summary = invoiceLocalSummary(current.plan, current.quotation);
  current.plan.summary = summary;
  document.querySelectorAll('.invoice-installment-amount strong').forEach((node, index) => {
    node.textContent = invoiceMoney(current.plan.installments[index]?.amount || 0);
  });
  const balance = document.querySelector('.invoice-plan-balance');
  if (balance) {
    balance.classList.toggle('balanced', Math.abs(summary.unplanned) < 0.01);
    balance.querySelector('span').textContent = Math.abs(summary.unplanned) < 0.01 ? 'Plan covers the quotation total' : 'Still to allocate';
    balance.querySelector('strong').textContent = invoiceMoney(summary.unplanned);
  }
  const metrics = document.querySelector('.invoice-metrics');
  if (metrics) metrics.outerHTML = `<div class="invoice-metrics">${invoiceMetric('Quotation total', summary.quotationTotal, summary.invoiceDiscountAmount ? `${invoiceMoney(summary.adjustedTotal)} after discount` : '')}${invoiceMetric('Invoiced', summary.invoiced, `${invoiceMoney(summary.notInvoiced)} not invoiced`)}${invoiceMetric('Paid', summary.paid, `${invoiceMoney(summary.invoiceBalance)} issued balance`, 'positive')}${invoiceMetric('Amount due', summary.due, summary.due ? 'Remaining on quotation' : 'Fully paid', summary.due ? 'due' : 'positive')}</div>`;
  const discountAmount = document.getElementById('invoiceDiscountAmount');
  if (discountAmount) discountAmount.textContent = `-${invoiceMoney(summary.invoiceDiscountAmount)}`;
}

function invoiceAddInstallment() {
  const rows = invoiceState.current?.plan?.installments;
  if (!rows) return;
  const summary = invoiceLocalSummary(invoiceState.current.plan, invoiceState.current.quotation);
  const quotationStatus = String(invoiceState.current.quotation?.status || '').toLowerCase();
  if (
    quotationStatus === 'accepted'
    && summary.invoiced > 0.005
    && summary.notInvoiced <= 0.005
  ) {
    showNotification('info', 'This quotation has already been invoiced in full.');
    return;
  }
  rows.push({ id: invoiceUid('installment'), label: `Installment ${rows.length + 1}`, mode: 'amount', value: 0, amount: 0, dueDate: invoiceDateFromToday(30), notes: '', status: 'planned', invoiceId: '', invoiceNumber: '' });
  invoiceState.current.plan.strategy = 'custom';
  invoiceState.current.plan.strategyLabel = 'Custom installment plan';
  invoiceMarkDirty();
  invoiceRenderEditor();
}

async function invoiceRemoveInstallment(index) {
  const row = invoiceState.current?.plan?.installments?.[index];
  if (!row || row.invoiceId) return;
  invoiceState.current.plan.installments.splice(index, 1);
  invoiceMarkDirty();
  invoiceRenderEditor();
}

function invoiceAddPayment() {
  const rows = invoiceState.current?.plan?.payments;
  if (!rows) return;
  rows.unshift({ id: invoiceUid('payment'), date: invoiceToday(), label: 'Payment received', amount: 0, createdAt: new Date().toISOString() });
  invoiceMarkDirty();
  invoiceRenderEditor();
}

function invoiceUpdatePayment(index, key, value) {
  const row = invoiceState.current?.plan?.payments?.[index];
  if (!row) return;
  row[key] = key === 'amount' ? Number(value || 0) : value;
  invoiceMarkDirty();
  invoiceRefreshCalculatedValues();
}

async function invoiceExportPaymentReceipt(index) {
  const current = invoiceState.current;
  const payment = current?.plan?.payments?.[index];
  if (!current || !payment) return;
  if (Number(payment.amount || 0) <= 0) {
    showNotification('warning', 'Enter a payment amount before exporting a receipt');
    return;
  }
  const receiptWindow = window.open('', '_blank');
  const quotationId = current.quotation.id;
  const paymentId = payment.id;
  const saved = await invoiceSavePlan({ silent: true });
  if (!saved) {
    receiptWindow?.close();
    return;
  }
  const url = `/api/invoice-plans/${encodeURIComponent(quotationId)}/payments/${encodeURIComponent(paymentId)}/receipt`;
  if (receiptWindow) receiptWindow.location.href = url;
  else window.location.href = url;
}

async function invoiceRemovePayment(index) {
  const row = invoiceState.current?.plan?.payments?.[index];
  if (!row) return;
  const confirmed = typeof showAppConfirm === 'function' ? await showAppConfirm({
    title: 'Remove payment record?', message: `${row.label || 'This payment'} for ${invoiceMoney(row.amount)} will be removed from the invoice history.`,
    confirmText: 'Remove payment', cancelText: 'Keep payment', variant: 'danger'
  }) : window.confirm('Remove this payment record?');
  if (!confirmed) return;
  invoiceState.current.plan.payments.splice(index, 1);
  invoiceMarkDirty();
  invoiceRenderEditor();
}

async function invoiceSavePlan(options = {}) {
  const current = invoiceState.current;
  if (!current) return null;
  if (invoiceState.activeSave) {
    await Promise.allSettled([invoiceState.activeSave]);
    if (!invoiceState.current || invoiceState.current.quotation.id !== current.quotation.id) return null;
    if (!invoiceState.dirty) return invoiceState.current;
  }
  clearTimeout(invoiceState.saveTimer);
  invoiceState.saveTimer = null;
  invoiceState.saving = true;
  const version = invoiceState.changeVersion;
  const localPlan = invoiceClone(current.plan);
  const basePlan = invoiceClone(invoiceState.basePlan || current.plan);
  if (!options.silent) invoiceRenderEditor();
  try {
    const requestPromise = apiCall(
      `/api/invoice-plans/${encodeURIComponent(current.quotation.id)}`,
      'PUT',
      { ...localPlan, _baseDocument: basePlan }
    );
    invoiceState.activeSave = requestPromise;
    const response = await requestPromise;
    if (invoiceState.current?.quotation?.id === current.quotation.id) {
      if (invoiceState.changeVersion === version) {
        invoiceState.current = response.data;
        invoiceState.basePlan = invoiceClone(response.data.plan);
        invoiceState.dirty = false;
        invoiceState.remoteUpdatePending = false;
      } else {
        invoiceState.current.plan = invoiceMergePlan(
          localPlan, invoiceState.current.plan, response.data.plan
        );
        invoiceState.basePlan = invoiceClone(response.data.plan);
        invoiceState.dirty = true;
        invoiceState.saveTimer = setTimeout(
          () => invoiceSavePlan({ silent: true }), 250
        );
      }
    }
    if (!options.silent) {
      showNotification('success', 'Invoice plan saved');
      invoiceRenderEditor();
    }
    return response.data;
  } catch (error) {
    if (error.payload?.code === 'document_version_conflict' && error.payload?.data) {
      const latest = error.payload.data;
      const newestLocal = invoiceState.changeVersion === version
        ? localPlan
        : invoiceClone(invoiceState.current?.plan);
      const merged = invoiceMergePlan(basePlan, newestLocal, latest.plan);
      const decision = await showAppConfirm({
        title: 'Invoice plan changed elsewhere',
        message: 'Another user changed the same invoice-plan detail. Keep your changes, use the latest saved version, or review before deciding.',
        confirmText: 'Keep My Changes',
        confirmValue: 'keep-local',
        alternateText: 'Use Latest',
        alternateValue: 'use-latest',
        cancelText: 'Review First'
      });
      if (decision === 'keep-local') {
        merged.documentVersion = latest.plan.documentVersion;
        invoiceState.current = { ...latest, plan: merged };
        invoiceState.basePlan = invoiceClone(latest.plan);
        invoiceState.dirty = true;
        invoiceState.changeVersion += 1;
        return invoiceSavePlan(options);
      }
      if (decision === 'use-latest') {
        invoiceState.current = latest;
        invoiceState.basePlan = invoiceClone(latest.plan);
        invoiceState.dirty = false;
        invoiceState.remoteUpdatePending = false;
        invoiceRenderEditor();
        return latest;
      }
      invoiceState.current = { ...latest, plan: merged };
      invoiceState.basePlan = invoiceClone(latest.plan);
      invoiceState.dirty = true;
      invoiceState.remoteUpdatePending = true;
      invoiceRenderEditor();
      return null;
    }
    showNotification('error', error.message || 'Unable to save invoice plan');
    return null;
  } finally {
    invoiceState.activeSave = null;
    invoiceState.saving = false;
  }
}

async function invoiceFlushPendingSave() {
  clearTimeout(invoiceState.saveTimer);
  invoiceState.saveTimer = null;
  if (!invoiceState.current || !invoiceState.dirty) return true;
  const saved = await invoiceSavePlan({ silent: true });
  return Boolean(saved) && !invoiceState.dirty;
}

async function invoiceIssueInstallment(index) {
  const current = invoiceState.current;
  const row = current?.plan?.installments?.[index];
  if (!current || !row || row.invoiceId) return;
  if (Number(row.amount || 0) <= 0) {
    showNotification('error', 'Enter an installment amount before issuing the invoice.');
    return;
  }
  const summary = invoiceLocalSummary(current.plan, current.quotation);
  const quotationStatus = String(current.quotation?.status || '').toLowerCase();
  if (
    quotationStatus === 'accepted'
    && Number(row.amount || 0) > Number(summary.notInvoiced || 0) + 0.005
  ) {
    showNotification('error', 'This invoice would exceed the remaining quotation amount.');
    return;
  }
  const saved = await invoiceSavePlan({ silent: true });
  if (!saved) return;
  const issueDetails = typeof showAppForm === 'function' ? await showAppForm({
    title: 'Issue invoice',
    message: `${row.label} will be issued for ${invoiceMoney(row.amount)}. Confirm or change the invoice number below.`,
    confirmText: 'Issue invoice',
    cancelText: 'Cancel',
    fields: [{
      name: 'invoiceNumber',
      label: 'Invoice number',
      defaultValue: current.nextInvoiceNumber || '',
      placeholder: 'INV-2026-0001',
      required: true,
      maxLength: 80
    }]
  }) : (window.confirm('Issue this invoice?') ? { invoiceNumber: current.nextInvoiceNumber || '' } : null);
  const invoiceNumber = String(issueDetails?.invoiceNumber || '').trim();
  if (!invoiceNumber) { invoiceRenderEditor(); return; }
  try {
    const response = await apiCall(`/api/invoice-plans/${encodeURIComponent(current.quotation.id)}/installments/${encodeURIComponent(row.id)}/issue`, 'POST', {
      invoiceDate: invoiceToday(), dueDate: row.dueDate, status: 'draft', number: invoiceNumber
    });
    invoiceState.current = response.plan;
    showNotification('success', `${response.data.number} created`);
    invoiceRenderEditor();
  } catch (error) {
    showNotification('error', error.message || 'Unable to issue invoice');
  }
}

function invoiceEnsurePaidModal() {
  if (document.getElementById('invoicePaidModal')) return;
  const modal = document.createElement('div');
  modal.id = 'invoicePaidModal';
  modal.className = 'modal';
  modal.innerHTML = `
    <div class="modal-content invoice-paid-modal">
      <div class="modal-header"><h3 class="modal-title">Mark invoice as paid</h3><button type="button" class="close-btn" onclick="closeModal('invoicePaidModal')">&times;</button></div>
      <p>Confirm when the payment was received. The amount due for this invoice will be recorded automatically.</p>
      <label><span>Payment received date</span><input id="invoicePaidReceivedDate" type="date"></label>
      <div class="invoice-paid-amount"><span>Payment to record</span><strong id="invoicePaidAmount">$0.00</strong></div>
      <div class="modal-actions"><button type="button" class="btn btn-secondary" onclick="closeModal('invoicePaidModal')">Cancel</button><button type="button" class="btn invoice-paid-confirm" onclick="invoiceConfirmPaid()">Mark as paid</button></div>
    </div>
  `;
  document.body.appendChild(modal);
}

function invoiceEnsureSentModal() {
  if (document.getElementById('invoiceSentModal')) return;
  const modal = document.createElement('div');
  modal.id = 'invoiceSentModal';
  modal.className = 'modal';
  modal.innerHTML = `
    <div class="modal-content invoice-paid-modal invoice-sent-modal">
      <div class="modal-header"><h3 class="modal-title">Mark invoice as sent</h3><button type="button" class="close-btn" onclick="closeModal('invoiceSentModal')">&times;</button></div>
      <p>Confirm when the invoice was sent and how many days the client has to pay.</p>
      <div class="invoice-sent-fields">
        <label><span>Date sent</span><input id="invoiceSentDate" type="date" oninput="invoiceRefreshSentDueDate()"></label>
        <label><span>Due in days</span><input id="invoiceSentDueDays" type="number" min="0" max="3650" step="1" oninput="invoiceRefreshSentDueDate()"></label>
      </div>
      <div class="invoice-paid-amount"><span>Payment due date</span><strong id="invoiceSentDueDate">-</strong></div>
      <div class="modal-actions"><button type="button" class="btn btn-secondary" onclick="closeModal('invoiceSentModal')">Cancel</button><button type="button" class="btn invoice-paid-confirm" onclick="invoiceConfirmSent()">Mark as sent</button></div>
    </div>
  `;
  document.body.appendChild(modal);
}

function invoiceRefreshSentDueDate() {
  const sentDate = document.getElementById('invoiceSentDate')?.value;
  const dueDays = Number(document.getElementById('invoiceSentDueDays')?.value || 0);
  const output = document.getElementById('invoiceSentDueDate');
  if (!output || !sentDate || !Number.isFinite(dueDays)) return;
  const due = new Date(`${sentDate}T00:00:00`);
  due.setDate(due.getDate() + Math.max(0, dueDays));
  output.textContent = invoiceDateLabel(
    new Date(due.getTime() - due.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
  );
}

async function invoiceDefaultPaymentDays() {
  if (invoiceState.defaultPaymentTermDays != null) {
    return invoiceState.defaultPaymentTermDays;
  }
  try {
    const response = await apiCall('/api/pdf-settings');
    invoiceState.defaultPaymentTermDays = invoicePaymentTermDays(
      response.data?.defaultPaymentTerms, 30
    );
  } catch (_error) {
    invoiceState.defaultPaymentTermDays = 30;
  }
  return invoiceState.defaultPaymentTermDays;
}

async function invoiceOpenSentModal(invoiceId, index, origin) {
  const invoice = invoiceFindDocument(invoiceId);
  invoiceState.sentTarget = {
    invoiceId, index, origin, documentVersion: invoice?.documentVersion
  };
  invoiceEnsureSentModal();
  const sentDate = document.getElementById('invoiceSentDate');
  const dueDays = document.getElementById('invoiceSentDueDays');
  if (sentDate) sentDate.value = invoiceToday();
  if (dueDays) dueDays.value = String(await invoiceDefaultPaymentDays());
  invoiceRefreshSentDueDate();
  openModal('invoiceSentModal');
}

function invoiceFindDocument(invoiceId) {
  const directoryInvoice = invoiceState.issuedInvoices.find(row => row.id === invoiceId);
  if (directoryInvoice) return directoryInvoice;
  const installment = invoiceState.current?.plan?.installments?.find(row => row.invoiceId === invoiceId);
  if (!installment) return null;
  return {
    id: invoiceId,
    number: installment.invoiceNumber,
    status: installment.status,
    documentVersion: installment.invoiceDocumentVersion,
    invoiceAmount: installment.amount,
    paymentTermDays: installment.paymentTermDays,
    paymentDueDate: installment.paymentDueDate,
    dueDate: installment.dueDate,
    invoicePlanPayments: invoiceState.current?.plan?.payments || []
  };
}

async function invoiceReloadCurrentPlan() {
  const quotationId = invoiceState.current?.quotation?.id;
  if (!quotationId) return;
  const response = await apiCall(
    `/api/invoice-plans/${encodeURIComponent(quotationId)}`
  );
  invoiceState.current = response.data;
  invoiceState.basePlan = invoiceClone(response.data.plan);
  invoiceState.dirty = false;
  invoiceState.remoteUpdatePending = false;
  invoiceRenderEditor();
}

async function invoiceRequestDocumentStatus(invoiceId, index, status, origin = 'editor') {
  if (!invoiceId) return;
  invoiceCloseStatusMenus();
  if (origin === 'editor' && invoiceHasPendingChanges()) {
    const saved = await invoiceFlushPendingSave();
    if (!saved) {
      showNotification('error', 'Save the invoice plan before changing its status');
      return;
    }
  }
  const currentInvoice = invoiceFindDocument(invoiceId);
  if (String(currentInvoice?.status || '').toLowerCase() === String(status || '').toLowerCase()) return;
  if (status === 'paid') {
    const invoice = currentInvoice;
    invoiceState.paidTarget = { invoiceId, index, origin };
    invoiceEnsurePaidModal();
    const receivedDate = document.getElementById('invoicePaidReceivedDate');
    const amount = document.getElementById('invoicePaidAmount');
    if (receivedDate) receivedDate.value = invoiceToday();
    if (amount) amount.textContent = invoiceMoney(invoiceIssuedAmountDue(invoice || {}));
    openModal('invoicePaidModal');
    return;
  }
  if (status === 'sent') {
    await invoiceOpenSentModal(invoiceId, index, origin);
    return;
  }
  try {
    const response = await apiCall(`/api/invoices/${encodeURIComponent(invoiceId)}`, 'PUT', {
      status,
      ...(currentInvoice?.documentVersion ? { documentVersion: currentInvoice.documentVersion } : {})
    });
    if (origin === 'directory') {
      await loadInvoices(invoiceState.query);
    } else {
      await invoiceReloadCurrentPlan();
    }
  } catch (error) {
    showNotification('error', error.message || 'Unable to update invoice status');
  }
}

async function invoiceConfirmSent() {
  const target = invoiceState.sentTarget;
  const invoiceSentDate = document.getElementById('invoiceSentDate')?.value;
  const paymentTermDays = Number(document.getElementById('invoiceSentDueDays')?.value);
  if (!target?.invoiceId) return;
  if (!invoiceSentDate || !Number.isInteger(paymentTermDays) || paymentTermDays < 0 || paymentTermDays > 3650) {
    showNotification('error', 'Enter a valid sent date and due-in-days value');
    return;
  }
  closeModal('invoiceSentModal');
  try {
    await apiCall(`/api/invoices/${encodeURIComponent(target.invoiceId)}`, 'PUT', {
      status: 'sent', invoiceSentDate, paymentTermDays,
      ...(target.documentVersion ? { documentVersion: target.documentVersion } : {})
    });
    showNotification('success', 'Invoice marked as sent');
    if (target.origin === 'directory') await loadInvoices(invoiceState.query);
    else await invoiceReloadCurrentPlan();
  } catch (error) {
    showNotification('error', error.message || 'Unable to mark invoice as sent');
  } finally {
    invoiceState.sentTarget = null;
  }
}

async function invoiceConfirmPaid() {
  const target = invoiceState.paidTarget;
  const receivedDate = document.getElementById('invoicePaidReceivedDate')?.value || invoiceToday();
  if (!target?.invoiceId) return;
  closeModal('invoicePaidModal');
  try {
    const response = await apiCall(
      `/api/invoices/${encodeURIComponent(target.invoiceId)}/mark-paid`,
      'POST',
      { receivedDate }
    );
    showNotification(
      'success',
      `Invoice marked paid and ${invoiceMoney(response.paymentAmount || 0)} recorded`
    );
    if (target.origin === 'directory') {
      await loadInvoices(invoiceState.query);
    } else {
      invoiceState.current = response.plan;
      invoiceRenderEditor();
    }
  } catch (error) {
    showNotification('error', error.message || 'Unable to mark invoice as paid');
  } finally {
    invoiceState.paidTarget = null;
  }
}

async function invoiceOpenPdf(invoiceId, installmentIndex = -1) {
  if (!invoiceId) return;
  const row = invoiceState.current?.plan?.installments?.[installmentIndex];
  let previewWindow = null;
  if (
    row?.invoiceId === invoiceId
    && String(row.status || 'draft').toLowerCase() === 'draft'
    && invoiceState.dirty
  ) {
    previewWindow = window.open('', '_blank');
    const saved = await invoiceSavePlan({ silent: true });
    if (!saved) {
      previewWindow?.close();
      return;
    }
  }
  const pdfUrl = `/api/invoices/${encodeURIComponent(invoiceId)}/pdf`;
  if (previewWindow) previewWindow.location.href = pdfUrl;
  else window.open(pdfUrl, '_blank', 'noopener');
}

function invoiceOpenQuotation(quotationId) {
  showSection('quotations', { loadDetail: false });
  financeOpenDocument(quotationId);
}

document.addEventListener('click', event => {
  if (event.target.closest('.invoice-status-control')) return;
  invoiceCloseStatusMenus();
});
