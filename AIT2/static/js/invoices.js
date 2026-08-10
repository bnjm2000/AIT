const INVOICE_PLAN_STATUSES = ['draft', 'sent', 'partially-paid', 'paid', 'overdue', 'cancelled'];
const INVOICE_DOCUMENT_STATUSES = ['draft', 'sent', 'partially-paid', 'paid', 'overdue', 'void'];

const invoiceState = {
  rows: [],
  issuedInvoices: [],
  view: 'plans',
  current: null,
  query: '',
  statuses: [],
  searchTimer: null,
  saving: false,
  dirty: false,
  paidTarget: null
};

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

function invoiceClientLabel(quotation) {
  const client = quotation?.client || {};
  return client.company || client.name || 'No client';
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
  const installments = plan?.installments || [];
  const payments = plan?.payments || [];
  const amountFor = row => row.mode === 'percentage'
    ? Math.round(total * Number(row.value || 0)) / 100
    : Number(row.value || 0);
  installments.forEach(row => { row.amount = Math.round(amountFor(row) * 100) / 100; });
  const active = installments.filter(row => !['cancelled', 'void'].includes(row.status));
  const planned = active.reduce((sum, row) => sum + Number(row.amount || 0), 0);
  const invoiced = active.filter(row => row.invoiceId).reduce((sum, row) => sum + Number(row.amount || 0), 0);
  const paid = payments.reduce((sum, row) => sum + Number(row.amount || 0), 0);
  return {
    quotationTotal: total,
    planned,
    unplanned: Math.max(0, total - planned),
    invoiced,
    notInvoiced: Math.max(0, total - invoiced),
    paid,
    due: Math.max(0, total - paid),
    invoiceBalance: Math.max(0, invoiced - paid)
  };
}

async function loadInvoices(query = '') {
  const root = invoiceRoot();
  if (!root) return;
  invoiceState.current = null;
  invoiceState.query = String(query || '').trim();
  root.innerHTML = `<div class="invoice-loading"><span></span>${invoiceState.view === 'issued' ? 'Loading issued invoices...' : 'Loading invoice-ready quotations...'}</div>`;
  try {
    const params = new URLSearchParams();
    if (invoiceState.query) params.set('query', invoiceState.query);
    if (invoiceState.view === 'issued') {
      const response = await apiCall('/api/invoices');
      invoiceState.issuedInvoices = (response.data || [])
        .filter(row => !invoiceState.query || [
          row.number, row.sourceQuotationNumber, row.projectName,
          row.client?.name, row.client?.company
        ].some(value => String(value || '').toLowerCase().includes(invoiceState.query.toLowerCase())))
        .sort((a, b) => invoiceNumberSortValue(b.number).localeCompare(
          invoiceNumberSortValue(a.number), undefined, { numeric: true }
        ));
    } else {
      const response = await apiCall(`/api/invoice-plans${params.size ? `?${params}` : ''}`);
      invoiceState.rows = response.data || [];
    }
    invoiceRenderList();
  } catch (error) {
    root.innerHTML = `<div class="invoice-empty"><strong>Invoices could not be loaded</strong><span>${invoiceEscape(error.message)}</span></div>`;
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

function invoiceToggleFilter(status) {
  if (status === 'all') {
    invoiceState.statuses = [];
  } else if ([...INVOICE_PLAN_STATUSES, ...INVOICE_DOCUMENT_STATUSES].includes(status)) {
    invoiceState.statuses = invoiceState.statuses.includes(status)
      ? invoiceState.statuses.filter(item => item !== status)
      : [...invoiceState.statuses, status];
  }
  invoiceRenderList();
}

function invoiceFilterMarkup() {
  const source = invoiceState.view === 'issued' ? invoiceState.issuedInvoices : invoiceState.rows;
  const statuses = invoiceState.view === 'issued' ? INVOICE_DOCUMENT_STATUSES : INVOICE_PLAN_STATUSES;
  const counts = Object.fromEntries(statuses.map(status => [
    status,
    source.filter(row => (
      invoiceState.view === 'issued' ? row.status : row.plan?.status
    ) === status).length
  ]));
  return `
    <div class="invoice-filter-row" aria-label="Filter invoice statuses">
      <button type="button" class="invoice-filter ${invoiceState.statuses.length ? '' : 'active'}" onclick="invoiceToggleFilter('all')">All <span>${source.length}</span></button>
      ${statuses.filter(status => counts[status]).map(status => `
        <button type="button" data-status="${status}" class="invoice-filter ${invoiceState.statuses.includes(status) ? 'active' : ''}" onclick="invoiceToggleFilter('${status}')">
          ${invoiceStatusLabel(status)} <span>${counts[status]}</span>
        </button>
      `).join('')}
    </div>
  `;
}

function invoiceRenderList() {
  const root = invoiceRoot();
  if (!root) return;
  const source = invoiceState.view === 'issued' ? invoiceState.issuedInvoices : invoiceState.rows;
  const visible = invoiceState.statuses.length
    ? source.filter(row => invoiceState.statuses.includes(
        invoiceState.view === 'issued' ? row.status : row.plan?.status || 'draft'
      ))
    : source;
  root.innerHTML = `
    <header class="invoice-list-header">
      <div>
        <h2>Invoices</h2>
        <p>${invoiceState.view === 'issued' ? 'Review every issued invoice by invoice number and project.' : 'Build installment plans, issue invoices and track every payment.'}</p>
      </div>
      <div class="invoice-list-actions">
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
    ${invoiceFilterMarkup()}
    <section class="invoice-list-shell">
      ${visible.length ? `
        <div class="invoice-list-scroll">
          ${invoiceState.view === 'issued' ? invoiceIssuedTableMarkup(visible) : `
            <table class="invoice-list-table">
              <thead><tr><th>Quotation</th><th>Client / Project</th><th>Strategy</th><th>Status</th><th>Invoiced</th><th>Paid</th><th>Due</th><th></th></tr></thead>
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
  `;
}

function invoiceListRowMarkup(row) {
  const quotation = row.quotation || {};
  const plan = row.plan || {};
  const summary = plan.summary || {};
  const installmentCount = (plan.installments || []).length;
  return `
    <tr onclick="invoiceOpenPlan('${invoiceAttr(quotation.id)}')">
      <td><strong>${invoiceEscape(quotation.number)}</strong><small>${invoiceDateLabel(quotation.acceptedAt || quotation.updatedAt)}</small></td>
      <td><strong>${invoiceEscape(quotation.projectName || 'Untitled project')}</strong><small>${invoiceEscape(invoiceClientLabel(quotation))}</small></td>
      <td><strong>${invoiceEscape(plan.strategyLabel || 'Not configured')}</strong><small>${installmentCount} installment${installmentCount === 1 ? '' : 's'}</small></td>
      <td>${invoiceStatusControlMarkup(plan.status, `list-${quotation.id}`, `invoiceSetListStatus('${invoiceAttr(quotation.id)}',STATUS_VALUE)`)}</td>
      <td><strong>${invoiceMoney(summary.invoiced)}</strong><small>of ${invoiceMoney(summary.quotationTotal)}</small></td>
      <td><strong class="invoice-positive">${invoiceMoney(summary.paid)}</strong></td>
      <td><strong class="${Number(summary.due || 0) > 0 ? 'invoice-due' : 'invoice-positive'}">${invoiceMoney(summary.due)}</strong></td>
      <td><button type="button" class="invoice-row-open" title="Open invoice plan" onclick="event.stopPropagation();invoiceOpenPlan('${invoiceAttr(quotation.id)}')"><svg viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"></path></svg></button></td>
    </tr>
  `;
}

function invoiceIssuedTableMarkup(rows) {
  return `
    <table class="invoice-list-table invoice-issued-table">
      <thead><tr><th>Invoice ID</th><th>Quotation</th><th>Project / Client</th><th>Label</th><th>Status</th><th>Invoice amount</th><th>Amount due</th><th>Actions</th></tr></thead>
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
  return `
    <tr onclick="invoiceOpenPdf('${invoiceAttr(invoice.id)}')">
      <td><strong>${invoiceEscape(invoice.number || 'Unnumbered invoice')}</strong><small>${invoiceDateLabel(invoice.invoiceDate || invoice.createdAt)}</small></td>
      <td><strong>${invoiceEscape(invoice.sourceQuotationNumber || 'Not linked')}</strong></td>
      <td><strong>${invoiceEscape(invoice.projectName || 'Untitled project')}</strong><small>${invoiceEscape(invoiceClientLabel(invoice))}</small></td>
      <td><strong>${invoiceEscape(invoice.invoiceLabel || 'Full payment')}</strong></td>
      <td>${invoiceStatusControlMarkup(invoice.status || 'draft', `issued-status-${invoice.id}`, `invoiceRequestDocumentStatus('${invoiceAttr(invoice.id)}',-1,STATUS_VALUE,'directory')`, INVOICE_DOCUMENT_STATUSES)}</td>
      <td><strong>${invoiceMoney(invoice.invoiceAmount || invoice.totals?.total)}</strong></td>
      <td><strong class="${due > 0 ? 'invoice-due' : 'invoice-positive'}">${invoiceMoney(due)}</strong></td>
      <td><div class="invoice-directory-actions">
        <button type="button" title="Preview invoice" onclick="event.stopPropagation();invoiceOpenPdf('${invoiceAttr(invoice.id)}')"><svg viewBox="0 0 24 24"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"></path><circle cx="12" cy="12" r="2.5"></circle></svg></button>
        <button type="button" title="Renumber invoice" onclick="event.stopPropagation();invoiceRenumber('${invoiceAttr(invoice.id)}')"><svg viewBox="0 0 24 24"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg></button>
        <button type="button" class="danger" title="Delete invoice" onclick="event.stopPropagation();invoiceDeleteIssued('${invoiceAttr(invoice.id)}')"><svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13"></path></svg></button>
      </div></td>
    </tr>
  `;
}

async function invoiceRenumber(invoiceId) {
  const invoice = invoiceState.issuedInvoices.find(row => row.id === invoiceId);
  if (!invoice) return;
  const number = await showAppPrompt({
    title: 'Renumber invoice',
    message: 'Enter the invoice ID exactly as it should appear on the PDF.',
    label: 'Invoice ID',
    value: invoice.number || '',
    placeholder: 'INV-2026-0001',
    confirmText: 'Update invoice ID',
    cancelText: 'Cancel'
  });
  if (number === null || number === false) return;
  const clean = String(number || '').trim();
  if (!clean || clean === invoice.number) return;
  try {
    await apiCall(`/api/invoices/${encodeURIComponent(invoiceId)}`, 'PUT', { number: clean });
    showNotification('success', `Invoice ID changed to ${clean}`);
    await loadInvoices(invoiceState.query);
  } catch (error) {
    showNotification('error', error.message || 'Unable to renumber invoice');
  }
}

async function invoiceDeleteIssued(invoiceId) {
  const invoice = invoiceState.issuedInvoices.find(row => row.id === invoiceId);
  if (!invoice) return;
  const confirmed = await showAppConfirm({
    title: 'Delete invoice?',
    message: `${invoice.number || 'This invoice'} will be removed. Its installment will return to a planned state and can be issued again. Payment records are retained.`,
    confirmText: 'Delete invoice',
    cancelText: 'Keep invoice',
    variant: 'danger'
  });
  if (!confirmed) return;
  try {
    await apiCall(`/api/invoices/${encodeURIComponent(invoiceId)}`, 'DELETE');
    showNotification('success', `${invoice.number || 'Invoice'} deleted`);
    await loadInvoices(invoiceState.query);
  } catch (error) {
    showNotification('error', error.message || 'Unable to delete invoice');
  }
}

function invoiceStatusControlMarkup(status, id, actionTemplate, statuses = INVOICE_PLAN_STATUSES) {
  const action = statusValue => actionTemplate.replace('STATUS_VALUE', `'${statusValue}'`);
  return `
    <div class="invoice-status-control" onclick="event.stopPropagation()">
      <button type="button" class="invoice-status" data-status="${invoiceAttr(status)}" onclick="invoiceToggleStatusMenu('${invoiceAttr(id)}',event)">
        <span></span>${invoiceStatusLabel(status)}<svg viewBox="0 0 24 24"><path d="m7 10 5 5 5-5"></path></svg>
      </button>
      <div id="${invoiceAttr(id)}" class="invoice-status-menu">
        ${statuses.map(item => `<button type="button" data-status="${item}" onclick="${action(item)}"><span></span>${invoiceStatusLabel(item)}</button>`).join('')}
      </div>
    </div>
  `;
}

function invoiceToggleStatusMenu(id, event) {
  event?.stopPropagation();
  document.querySelectorAll('.invoice-status-menu.open').forEach(menu => {
    if (menu.id !== id) menu.classList.remove('open');
  });
  const menu = document.getElementById(id);
  if (!menu) return;
  const shouldOpen = !menu.classList.contains('open');
  menu.classList.toggle('open', shouldOpen);
  menu.classList.remove('viewport-menu');
  menu.style.removeProperty('top');
  menu.style.removeProperty('bottom');
  menu.style.removeProperty('left');
  if (!shouldOpen || !menu.closest('.invoice-list-scroll')) return;
  const trigger = event?.currentTarget || menu.previousElementSibling;
  const rect = trigger?.getBoundingClientRect();
  if (!rect) return;
  menu.classList.add('viewport-menu');
  const estimatedHeight = Math.min(280, 12 + menu.children.length * 34);
  const openAbove = rect.bottom + estimatedHeight > window.innerHeight - 12;
  menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 180))}px`;
  menu.style.top = `${openAbove ? Math.max(8, rect.top - estimatedHeight - 5) : rect.bottom + 5}px`;
}

async function invoiceSetListStatus(quotationId, status) {
  const row = invoiceState.rows.find(item => item.quotation?.id === quotationId);
  if (!row) return;
  document.querySelectorAll('.invoice-status-menu.open').forEach(menu => menu.classList.remove('open'));
  try {
    const response = await apiCall(`/api/invoice-plans/${encodeURIComponent(quotationId)}`, 'PUT', { ...row.plan, status });
    Object.assign(row, response.data);
    invoiceRenderList();
  } catch (error) {
    showNotification('error', error.message || 'Unable to update invoice status');
  }
}

async function invoiceOpenPlan(quotationId, options = {}) {
  const root = invoiceRoot();
  if (!root) return;
  root.innerHTML = '<div class="invoice-loading"><span></span>Opening billing plan...</div>';
  try {
    const response = await apiCall(`/api/invoice-plans/${encodeURIComponent(quotationId)}`);
    invoiceState.current = response.data;
    const plan = invoiceState.current.plan;
    if (!(plan.installments || []).length) invoiceApplyPreset('full', false);
    invoiceState.dirty = false;
    invoiceRenderEditor();
    if (options.updateHistory !== false && typeof updateAppDetailHistory === 'function') {
      updateAppDetailHistory(`/invoices/${encodeURIComponent(quotationId)}`);
    }
  } catch (error) {
    root.innerHTML = `<div class="invoice-empty"><strong>Billing plan unavailable</strong><span>${invoiceEscape(error.message)}</span><button class="btn btn-secondary" onclick="loadInvoices()">Back to invoices</button></div>`;
  }
}

function invoiceBackToList() {
  invoiceState.current = null;
  if (typeof updateAppSectionHistory === 'function') updateAppSectionHistory('invoices');
  loadInvoices(invoiceState.query);
}

function invoiceApplyPreset(preset, rerender = true) {
  const current = invoiceState.current;
  if (!current) return;
  const total = Number(current.quotation?.totals?.total || 0);
  const today = invoiceToday();
  const row = (label, mode, value) => ({
    id: invoiceUid('installment'), label, mode, value, amount: mode === 'percentage' ? total * value / 100 : value,
    dueDate: today, notes: '', status: 'planned', invoiceId: '', invoiceNumber: ''
  });
  if (preset === 'full') {
    current.plan.strategy = 'full';
    current.plan.strategyLabel = 'Full amount';
    current.plan.installments = [row('Full payment', 'percentage', 100)];
  } else if (preset === 'deposit') {
    current.plan.strategy = 'deposit';
    current.plan.strategyLabel = '50% deposit / 50% balance';
    current.plan.installments = [
      row('50% deposit', 'percentage', 50),
      row('Balance after show', 'percentage', 50)
    ];
  } else {
    current.plan.strategy = 'custom';
    current.plan.strategyLabel = 'Custom installment plan';
    if (!(current.plan.installments || []).length) current.plan.installments = [row('Installment 1', 'amount', total)];
  }
  invoiceMarkDirty();
  if (rerender) invoiceRenderEditor();
}

function invoiceRenderEditor() {
  const root = invoiceRoot();
  const current = invoiceState.current;
  if (!root || !current) return;
  const quotation = current.quotation || {};
  const plan = current.plan || {};
  const summary = invoiceLocalSummary(plan, quotation);
  plan.summary = summary;
  root.innerHTML = `
    <header class="invoice-editor-header">
      <div class="invoice-editor-title">
        <button type="button" class="invoice-back" onclick="invoiceBackToList()"><svg viewBox="0 0 24 24"><path d="m15 18-6-6 6-6"></path></svg>Invoices</button>
        <div><span>${invoiceEscape(quotation.number)}</span><h2>${invoiceEscape(quotation.projectName || 'Untitled project')}</h2><p>${invoiceEscape(invoiceClientLabel(quotation))}</p></div>
      </div>
      <div class="invoice-editor-actions">
        ${invoiceStatusControlMarkup(plan.status || 'draft', `editor-status-${quotation.id}`, 'invoiceSetPlanStatus(STATUS_VALUE)')}
        <button type="button" class="btn invoice-save" onclick="invoiceSavePlan()" ${invoiceState.saving ? 'disabled' : ''}>
          ${invoiceState.saving ? '<span class="invoice-button-spinner"></span>Saving' : 'Save plan'}
        </button>
      </div>
    </header>
    <div class="invoice-metrics">
      ${invoiceMetric('Quotation total', summary.quotationTotal, '')}
      ${invoiceMetric('Invoiced', summary.invoiced, `${invoiceMoney(summary.notInvoiced)} not invoiced`)}
      ${invoiceMetric('Paid', summary.paid, `${invoiceMoney(summary.invoiceBalance)} issued balance`, 'positive')}
      ${invoiceMetric('Amount due', summary.due, summary.due ? 'Remaining on quotation' : 'Fully paid', summary.due ? 'due' : 'positive')}
    </div>
    <div class="invoice-editor-grid">
      <main class="invoice-editor-main">
        <section class="invoice-panel">
          <div class="invoice-panel-heading"><div><h3>Invoicing strategy</h3><p>Choose a starting point, then adjust any installment.</p></div></div>
          <div class="invoice-presets">
            <button type="button" class="${plan.strategy === 'full' ? 'active' : ''}" onclick="invoiceApplyPreset('full')"><strong>Full amount</strong><span>One invoice for 100%</span></button>
            <button type="button" class="${plan.strategy === 'deposit' ? 'active' : ''}" onclick="invoiceApplyPreset('deposit')"><strong>50 / 50</strong><span>Deposit and final balance</span></button>
            <button type="button" class="${plan.strategy === 'custom' ? 'active' : ''}" onclick="invoiceApplyPreset('custom')"><strong>Custom</strong><span>Any installment plan</span></button>
          </div>
          <label class="invoice-strategy-name"><span>Plan label</span><input value="${invoiceAttr(plan.strategyLabel || '')}" oninput="invoiceUpdatePlanField('strategyLabel',this.value)"></label>
        </section>
        <section class="invoice-panel invoice-installments-panel">
          <div class="invoice-panel-heading"><div><h3>Installments</h3><p>${invoiceMoney(summary.planned)} planned of ${invoiceMoney(summary.quotationTotal)}</p></div><button type="button" class="invoice-icon-text" onclick="invoiceAddInstallment()"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"></path></svg>Add installment</button></div>
          <div class="invoice-installment-list">${(plan.installments || []).map((row, index) => invoiceInstallmentMarkup(row, index)).join('')}</div>
          <div class="invoice-plan-balance ${Math.abs(summary.unplanned) < 0.01 ? 'balanced' : ''}"><span>${Math.abs(summary.unplanned) < 0.01 ? 'Plan covers the quotation total' : 'Still to allocate'}</span><strong>${invoiceMoney(summary.unplanned)}</strong></div>
        </section>
        <section class="invoice-panel">
          <div class="invoice-panel-heading"><div><h3>Payments received</h3><p>These entries appear on issued invoice PDFs.</p></div><button type="button" class="invoice-icon-text" onclick="invoiceAddPayment()"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"></path></svg>Add payment</button></div>
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
  return `
    <article class="invoice-installment ${issued ? 'issued' : ''}">
      <div class="invoice-installment-index">${String(index + 1).padStart(2, '0')}</div>
      <label><span>Label</span><input value="${invoiceAttr(row.label || '')}" oninput="invoiceUpdateInstallment(${index},'label',this.value)" ${issued ? 'disabled' : ''}></label>
      <div class="invoice-mode-field"><span>Calculate by</span><div><button type="button" class="${row.mode === 'percentage' ? 'active' : ''}" onclick="invoiceUpdateInstallment(${index},'mode','percentage')" ${issued ? 'disabled' : ''}>%</button><button type="button" class="${row.mode === 'amount' ? 'active' : ''}" onclick="invoiceUpdateInstallment(${index},'mode','amount')" ${issued ? 'disabled' : ''}>$</button></div></div>
      <label><span>${row.mode === 'percentage' ? 'Percentage' : 'Amount'}</span><div class="invoice-value-input"><b>${row.mode === 'percentage' ? '%' : '$'}</b><input type="number" min="0" step="0.01" value="${Number(row.value || 0)}" oninput="invoiceUpdateInstallment(${index},'value',this.value)" ${issued ? 'disabled' : ''}></div></label>
      <label><span>Due date</span><input type="date" value="${invoiceAttr(row.dueDate || '')}" oninput="invoiceUpdateInstallment(${index},'dueDate',this.value)"></label>
      <div class="invoice-installment-amount"><span>Invoice amount</span><strong>${invoiceMoney(row.amount)}</strong></div>
      <div class="invoice-installment-actions">
        ${issued ? `
          ${invoiceStatusControlMarkup(row.status || 'draft', `installment-status-${row.id}`, `invoiceRequestDocumentStatus('${invoiceAttr(row.invoiceId)}',${index},STATUS_VALUE,'editor')`, INVOICE_DOCUMENT_STATUSES)}
          <button type="button" class="invoice-pdf-button" onclick="invoiceOpenPdf('${invoiceAttr(row.invoiceId)}')"><svg viewBox="0 0 24 24"><path d="M7 3h7l4 4v14H7z"></path><path d="M14 3v5h4M9 13h6M9 17h4"></path></svg>${invoiceEscape(row.invoiceNumber || 'Export PDF')}</button>
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
      <label class="invoice-payment-label"><span>Label shown on invoice</span><input value="${invoiceAttr(row.label || '')}" oninput="invoiceUpdatePayment(${index},'label',this.value)" placeholder="Deposit received"></label>
      <label><span>Amount</span><div class="invoice-value-input"><b>$</b><input type="number" min="0" step="0.01" value="${Number(row.amount || 0)}" oninput="invoiceUpdatePayment(${index},'amount',this.value)"></div></label>
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

function invoiceMarkDirty() { invoiceState.dirty = true; }

function invoiceUpdatePlanField(key, value) {
  if (!invoiceState.current) return;
  invoiceState.current.plan[key] = value;
  invoiceMarkDirty();
}

function invoiceSetPlanStatus(status) {
  if (!invoiceState.current) return;
  invoiceState.current.plan.status = status;
  document.querySelectorAll('.invoice-status-menu.open').forEach(menu => menu.classList.remove('open'));
  invoiceMarkDirty();
  invoiceSavePlan();
}

function invoiceUpdateInstallment(index, key, value) {
  const row = invoiceState.current?.plan?.installments?.[index];
  if (!row || row.invoiceId && ['mode', 'value', 'label'].includes(key)) return;
  row[key] = key === 'value' ? Number(value || 0) : value;
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
  if (metrics) metrics.outerHTML = `<div class="invoice-metrics">${invoiceMetric('Quotation total', summary.quotationTotal, '')}${invoiceMetric('Invoiced', summary.invoiced, `${invoiceMoney(summary.notInvoiced)} not invoiced`)}${invoiceMetric('Paid', summary.paid, `${invoiceMoney(summary.invoiceBalance)} issued balance`, 'positive')}${invoiceMetric('Amount due', summary.due, summary.due ? 'Remaining on quotation' : 'Fully paid', summary.due ? 'due' : 'positive')}</div>`;
}

function invoiceAddInstallment() {
  const rows = invoiceState.current?.plan?.installments;
  if (!rows) return;
  rows.push({ id: invoiceUid('installment'), label: `Installment ${rows.length + 1}`, mode: 'amount', value: 0, amount: 0, dueDate: invoiceToday(), notes: '', status: 'planned', invoiceId: '', invoiceNumber: '' });
  invoiceState.current.plan.strategy = 'custom';
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
  if (!current || invoiceState.saving) return null;
  invoiceState.saving = true;
  if (!options.silent) invoiceRenderEditor();
  try {
    const response = await apiCall(`/api/invoice-plans/${encodeURIComponent(current.quotation.id)}`, 'PUT', current.plan);
    invoiceState.current = response.data;
    invoiceState.dirty = false;
    if (!options.silent) {
      showNotification('success', 'Invoice plan saved');
      invoiceRenderEditor();
    }
    return response.data;
  } catch (error) {
    showNotification('error', error.message || 'Unable to save invoice plan');
    return null;
  } finally {
    invoiceState.saving = false;
  }
}

async function invoiceIssueInstallment(index) {
  const current = invoiceState.current;
  const row = current?.plan?.installments?.[index];
  if (!current || !row || row.invoiceId) return;
  if (Number(row.amount || 0) <= 0) {
    showNotification('error', 'Enter an installment amount before issuing the invoice.');
    return;
  }
  const saved = await invoiceSavePlan({ silent: true });
  if (!saved) return;
  const confirmed = typeof showAppConfirm === 'function' ? await showAppConfirm({
    title: 'Issue invoice?',
    message: `${row.label} will be issued for ${invoiceMoney(row.amount)}. The invoice number and amount will then be fixed.`,
    confirmText: 'Issue invoice', cancelText: 'Cancel'
  }) : window.confirm('Issue this invoice?');
  if (!confirmed) { invoiceRenderEditor(); return; }
  try {
    const response = await apiCall(`/api/invoice-plans/${encodeURIComponent(current.quotation.id)}/installments/${encodeURIComponent(row.id)}/issue`, 'POST', {
      invoiceDate: invoiceToday(), dueDate: row.dueDate, status: 'draft'
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
      <div class="modal-actions"><button type="button" class="btn btn-secondary" onclick="closeModal('invoicePaidModal')">Cancel</button><button type="button" class="btn invoice-save" onclick="invoiceConfirmPaid()">Mark as paid</button></div>
    </div>
  `;
  document.body.appendChild(modal);
}

function invoiceFindDocument(invoiceId) {
  const directoryInvoice = invoiceState.issuedInvoices.find(row => row.id === invoiceId);
  if (directoryInvoice) return directoryInvoice;
  const installment = invoiceState.current?.plan?.installments?.find(row => row.invoiceId === invoiceId);
  if (!installment) return null;
  return {
    id: invoiceId,
    number: installment.invoiceNumber,
    invoiceAmount: installment.amount,
    invoicePlanPayments: invoiceState.current?.plan?.payments || []
  };
}

async function invoiceRequestDocumentStatus(invoiceId, index, status, origin = 'editor') {
  if (!invoiceId) return;
  document.querySelectorAll('.invoice-status-menu.open').forEach(menu => menu.classList.remove('open'));
  if (status === 'paid') {
    const invoice = invoiceFindDocument(invoiceId);
    invoiceState.paidTarget = { invoiceId, index, origin };
    invoiceEnsurePaidModal();
    const receivedDate = document.getElementById('invoicePaidReceivedDate');
    const amount = document.getElementById('invoicePaidAmount');
    if (receivedDate) receivedDate.value = invoiceToday();
    if (amount) amount.textContent = invoiceMoney(invoiceIssuedAmountDue(invoice || {}));
    openModal('invoicePaidModal');
    return;
  }
  try {
    const response = await apiCall(`/api/invoices/${encodeURIComponent(invoiceId)}`, 'PUT', { status });
    if (origin === 'directory') {
      await loadInvoices(invoiceState.query);
    } else {
      const row = invoiceState.current?.plan?.installments?.[index];
      if (row) row.status = response.data.status;
      await invoiceSavePlan({ silent: true });
      invoiceRenderEditor();
    }
  } catch (error) {
    showNotification('error', error.message || 'Unable to update invoice status');
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

function invoiceOpenPdf(invoiceId) {
  if (!invoiceId) return;
  window.open(`/api/invoices/${encodeURIComponent(invoiceId)}/pdf`, '_blank', 'noopener');
}

function invoiceOpenQuotation(quotationId) {
  showSection('quotations', { loadDetail: false });
  financeOpenDocument(quotationId);
}

document.addEventListener('click', event => {
  if (event.target.closest('.invoice-status-control')) return;
  document.querySelectorAll('.invoice-status-menu.open').forEach(menu => menu.classList.remove('open'));
});
